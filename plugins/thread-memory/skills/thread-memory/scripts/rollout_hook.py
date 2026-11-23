"""Guide Codex threads through maintaining memory across compaction."""

import sqlite3
from pathlib import Path
from uuid import UUID

from rollout_handoff_diff import apply_handoff_diff
from rollout_handoff_snapshot import (
    REMINDER_CLOSE,
    REMINDER_MARKER_PREFIX,
    REMINDER_OPEN,
    reminder_snapshot,
    reminder_window_id,
    snapshot,
)
from rollout_handoff_store import (
    claim_reminder,
    load_handoff,
    load_rollout_checkpoint,
    mark_child_compaction,
    memory_history,
    memory_revision,
    memory_timestamp,
    record_hook_diagnostic,
    replace_handoff,
    save_handoff,
    save_memory,
    save_rollout_checkpoint,
    take_child_compaction,
)
from rollout_handoff_threshold import ReminderStage, reminder_plan
from rollout_source import find_rollout, metadata
from rollout_thread_memory import MemoryInheritanceUnavailable, initialize_thread_memory

_MAINTENANCE_HINT = (
    "<thread_memory_maintenance>\n"
    "Proactively maintain this thread's note with $thread-memory. "
    "Update it when important decisions, constraints, progress, or next steps change.\n"
    "</thread_memory_maintenance>"
)
_RECOVERY_TEMPLATE = "<thread_memory_recovery>\n{}\n</thread_memory_recovery>\n\n" + _MAINTENANCE_HINT
_RECOVERY_HINT = _RECOVERY_TEMPLATE.format(
    "Context was compacted. Search the rollout for earlier context as needed."
)
_RECOVERY_WITH_NOTE_HINT = _RECOVERY_TEMPLATE.format(
    "Context was compacted. Use `memory read` to recover the thread note. "
    "Search the rollout for missing details as needed."
)
_SUBAGENT_RECOVERY_HINT = _RECOVERY_TEMPLATE.format(
    "Context was compacted in this subagent. Use `memory read` to recover your thread note. "
    "Search the rollout for missing details as needed."
)
MAX_SUMMARY_BYTES = 8_192


def _thread_id(value: object) -> UUID | None:
    if isinstance(value, str):
        try:
            return UUID(value)
        except ValueError:
            pass
    return None


def _is_root(path: Path, session_id: UUID) -> bool:
    try:
        header = metadata(path)
    except (OSError, ValueError):
        return False

    if _thread_id(header.get("id")) != session_id or (
        "session_id" in header and _thread_id(header["session_id"]) != session_id
    ):
        return False
    if (
        header.get("attached_thread", False) is not False
        or header.get("parent_thread_id") is not None
        or header.get("subagent_history_start_ordinal") is not None
    ):
        return False

    source = header.get("source", "vscode")
    if isinstance(source, str):
        source = source.lower()
        if source in {"subagent", "internal"} or source.startswith(
            ("subagent_", "internal_")
        ):
            return False
    elif not (
        isinstance(source, dict)
        and source.keys() == {"custom"}
        and isinstance(source["custom"], str)
    ):
        return False
    thread_source = header.get("thread_source")
    if thread_source is not None and (
        not isinstance(thread_source, str)
        or thread_source in {"subagent", "guardian_review", "memory_consolidation"}
    ):
        return False
    return True


def _hook_note_status(home: Path, thread_id: str) -> str:
    try:
        note = initialize_thread_memory(home, thread_id)
        return "available" if note and note.summary else "missing"
    except MemoryInheritanceUnavailable:
        return "inheritance_unavailable"
    except OSError:
        return "io_error"
    except ValueError:
        return "invalid_data"
    except sqlite3.Error:
        return "sqlite_error"


def _subagent_instructions(
    request: dict, home: Path, path: Path, session_id: UUID, agent_id: UUID,
) -> str | None:
    try:
        header = metadata(path)
        if (
            agent_id == session_id or _thread_id(header.get("id")) != agent_id
            or ("session_id" in header and _thread_id(header["session_id"]) != session_id)
            or header.get("attached_thread", False) is not False
        ):
            return None
        source = header.get("source")
        subagent = source.get("subagent") if isinstance(source, dict) else None
        if not (isinstance(subagent, dict) and isinstance(subagent.get("thread_spawn"), dict)):
            return None
    except (OSError, ValueError):
        return None

    event = request["hook_event_name"]
    thread_id = str(agent_id)
    if event == "SubagentStart":
        record_hook_diagnostic(
            home, thread_id, "subagent_start_context_prepared", note_status="not_checked"
        )
        return _MAINTENANCE_HINT
    try:
        if event == "PostCompact":
            mark_child_compaction(home, thread_id)
            record_hook_diagnostic(home, thread_id, "subagent_compaction_pending")
        else:
            if take_child_compaction(home, thread_id):
                record_hook_diagnostic(home, thread_id, "subagent_recovery_context_prepared")
                return _SUBAGENT_RECOVERY_HINT
            return _compaction_reminder(request, home, path, thread_id)
    except (OSError, ValueError, sqlite3.Error):
        pass
    return None


def _compaction_reminder(request: dict, home: Path, path: Path, thread_id: str) -> str | None:
    model = request.get("model")
    turn = request.get("turn_id")
    plan = reminder_plan(home, model)
    if plan is None:
        return None
    rollout_path = str(path.absolute())
    try:
        checkpoint = load_rollout_checkpoint(home, thread_id, rollout_path)
    except (OSError, sqlite3.Error):
        checkpoint = None
    state, next_checkpoint = reminder_snapshot(
        path, checkpoint, minimum_used=plan.levels[0][1],
        expected_turn=turn if isinstance(turn, str) else None,
        expected_model=model if isinstance(model, str) else None,
    )
    if state is None:
        return None
    if next_checkpoint is not None and next_checkpoint != checkpoint:
        try:
            save_rollout_checkpoint(home, thread_id, rollout_path, checkpoint, next_checkpoint)
        except (OSError, sqlite3.Error):
            pass  # Cache persistence is optional after verifying the rollout.
    if state.used is None or (
        state.capacity is not None and plan.usable_window is not None
        and state.capacity != plan.usable_window
    ):
        return None
    phases = [
        (level, ReminderStage.RECORDED if level in state.received_reminder_levels else stage)
        for level, stage in plan.reached(state.used)
    ]
    claimed = claim_reminder(home, thread_id, state.current, phases)
    if not claimed:
        return None
    confirmations = [
        [level, int(stage)] for level, stage in phases
        if level in claimed and stage == ReminderStage.RECORDED
    ]
    notices = [
        (level, stage) for level, stage in phases
        if level in claimed and stage != ReminderStage.RECORDED
    ]
    usage = {"used": state.used, "capacity": state.capacity}
    if confirmations:
        record_hook_diagnostic(
            home, thread_id, "reminder_receipt_observed", window=state.current,
            stages=confirmations, **usage,
        )
    if not notices:
        return None
    context = (
        "The current context window may be compressed soon. Use $thread-memory to update "
        "the current thread note."
    )
    if any(stage != ReminderStage.FIRST for _, stage in notices):
        context = (
            f"This may be a duplicate reminder. {context} "
            "If no update is needed, ignore this reminder."
        )
    else:
        context += " Preserve useful details from the existing note, then continue the task."
    levels = ",".join(str(level) for level, _ in notices)
    record_hook_diagnostic(
        home, thread_id, "reminder_context_prepared", window=state.current,
        stages=[[level, int(stage)] for level, stage in notices], **usage,
    )
    receipt = f"{REMINDER_MARKER_PREFIX}{levels}:{reminder_window_id(state.current)}]"
    return f"{REMINDER_OPEN}{context}\n{receipt}{REMINDER_CLOSE}"


def hook_instructions(request: dict, home: Path) -> str | None:
    event = request.get("hook_event_name")
    source = request.get("source") if event == "SessionStart" else None
    agent = request.get("agent_id")
    if agent is not None:
        agent_id = _thread_id(agent)
        if agent_id is None or event not in ("SubagentStart", "PostCompact", "PostToolUse"):
            return None
    elif source not in ("startup", "compact", "fork") and event != "PostToolUse":
        return None
    session_id = _thread_id(request.get("session_id"))
    transcript_path = request.get("transcript_path")
    if session_id is None or not isinstance(transcript_path, str) or not transcript_path:
        return None
    path = Path(transcript_path)
    if agent is not None:
        return _subagent_instructions(request, home, path, session_id, agent_id)
    if not _is_root(path, session_id):
        return None
    thread_id = str(session_id)
    if source == "startup":
        record_hook_diagnostic(home, thread_id, "startup_context_prepared")
        return _MAINTENANCE_HINT
    if source in ("compact", "fork"):
        note_status = _hook_note_status(home, thread_id)
        if source == "fork":
            record_hook_diagnostic(home, thread_id, "fork_note_checked", note_status=note_status)
            return None
        record_hook_diagnostic(
            home, thread_id, "compact_context_prepared", note_status=note_status
        )
        return _RECOVERY_WITH_NOTE_HINT if note_status == "available" else _RECOVERY_HINT
    try:
        return _compaction_reminder(request, home, path, thread_id)
    except (OSError, ValueError, sqlite3.Error):
        return None


def handoff(
    home: Path, thread: str | None, window: str | None, summary: str | None,
    *, current: bool = False, patch: str | None = None,
) -> dict:
    session_id = _thread_id(thread)
    if session_id is None:
        raise ValueError("handoff requires --thread or CODEX_THREAD_ID with a thread UUID")
    thread_id = str(session_id)
    path = find_rollout(home, thread_id, thread=True)
    if path is None or not _is_root(path, session_id):
        raise FileNotFoundError("root rollout is unavailable for this thread")
    active = summary is not None or current
    state = snapshot(path, include_previous=not active)
    scope = "active" if active else "preceding"
    target = None
    if state is not None:
        target = state.current if active else state.previous
    if target is None:
        raise FileNotFoundError(f"could not identify the {scope} handoff window")
    if window is not None and window != target:
        message = (
            "handoff window is no longer active" if active
            else "handoff does not belong to the preceding window"
        )
        raise FileNotFoundError(message)
    if summary is not None:
        return save_handoff(home, thread_id, target, summary)
    saved = load_handoff(home, thread_id, target)
    if saved is None:
        raise FileNotFoundError(f"no handoff was saved for the {scope} window")
    if patch is None:
        return {"thread_id": thread_id, "window": target, "summary": saved}

    edited = patch_note(saved, patch)
    if not replace_handoff(home, thread_id, target, saved, edited):
        raise ValueError("handoff changed while applying the patch; read it again")
    return {"saved": True, "thread_id": thread_id, "window": target, "bytes": len(edited.encode("utf-8"))}


def patch_note(summary: str, patch: str) -> str:
    edited = apply_handoff_diff(summary, patch)
    if not edited.strip():
        raise ValueError("patch would leave an empty note")
    if len(edited.encode("utf-8")) > MAX_SUMMARY_BYTES:
        raise ValueError(f"patched note would exceed {MAX_SUMMARY_BYTES} UTF-8 bytes")
    return edited


def memory(
    home: Path, thread: str | None, action: str, *,
    summary: str | None, patch: str | None, at_us: int | None, limit: int,
) -> dict:
    session_id = _thread_id(thread)
    if session_id is None:
        raise ValueError("memory requires --thread or CODEX_THREAD_ID with a thread UUID")
    thread_id = str(session_id)
    inheritance_error = None
    try:
        current = initialize_thread_memory(home, thread_id)
    except MemoryInheritanceUnavailable as error:
        if action != "write":
            raise
        current = None
        inheritance_error = str(error)
    if action == "history":
        return {"thread_id": thread_id, "items": memory_history(home, thread_id, at_us=at_us, limit=limit)}
    if action == "read":
        note = current if at_us is None else memory_revision(home, thread_id, at_us=at_us)
        if note is None or note.summary is None:
            return {"thread_id": thread_id, "summary": None, "updated_at": None, "effective_at": None}
        return {
            "thread_id": thread_id, "summary": note.summary,
            "updated_at": memory_timestamp(note.updated_us),
            "effective_at": memory_timestamp(note.effective_us),
        }

    if patch is not None:
        if current is None or current.summary is None:
            raise FileNotFoundError("no thread note was saved to patch")
        summary = patch_note(current.summary, patch)
    assert summary is not None
    expected = current.revision if current is not None else 0
    note = save_memory(home, thread_id, summary, expected_revision=expected)
    if note is None:
        if patch is not None:
            raise ValueError("thread note changed while applying the patch; read it again")
        raise ValueError("thread note changed before saving. Read the thread note again.")
    result = {
        "saved": True, "thread_id": thread_id,
        "updated_at": memory_timestamp(note.updated_us), "bytes": len(summary.encode("utf-8")),
    }
    if inheritance_error is not None:
        result["inheritance_unavailable"] = inheritance_error
    return result
