"""Guide Codex threads through maintaining memory across compaction."""

import sqlite3
from pathlib import Path
from uuid import UUID

from rollout_handoff_diff import apply_handoff_diff
from rollout_handoff_snapshot import (
    BLOCK_BYTES,
    REMINDER_CLOSE,
    REMINDER_MARKER_PREFIX,
    REMINDER_OPEN,
    SCAN_BYTES,
    ReminderObservations,
    WindowSnapshot,
    reminder_snapshot,
    reminder_window_id,
)
from rollout_handoff_store import (
    claim_reminder,
    load_rollout_checkpoint,
    mark_child_compaction,
    memory_timestamp,
    record_hook_diagnostic,
    record_reminder_telemetry,
    save_memory,
    save_rollout_checkpoint,
    take_child_compaction,
)
from rollout_handoff_threshold import (
    CHECK_LEAD_TOKENS,
    FINAL_CHECK_LEAD_TOKENS,
    ReminderStage,
    reminder_plan,
)
from rollout_source import find_rollout, metadata
from rollout_thread_memory import MemoryInheritanceUnavailable, initialize_thread_memory

_COMPACTION_DIAGNOSTIC_SCAN_BYTES = 4 * BLOCK_BYTES

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
MAX_NOTE_BYTES = 12_288


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
            _probe_reminder_window(home, path, thread_id)
            record_hook_diagnostic(home, thread_id, "subagent_compaction_pending")
        else:
            if take_child_compaction(home, thread_id):
                _probe_reminder_window(home, path, thread_id)
                record_hook_diagnostic(home, thread_id, "subagent_recovery_context_prepared")
                return _SUBAGENT_RECOVERY_HINT
            return _compaction_reminder(request, home, path, thread_id)
    except (OSError, ValueError, sqlite3.Error):
        pass
    return None


def _probe_reminder_window(
    home: Path, path: Path, thread_id: str, *, minimum_used: int = 0,
    turn: str | None = None, model: str | None = None,
    scan_bytes: int = _COMPACTION_DIAGNOSTIC_SCAN_BYTES,
) -> WindowSnapshot | None:
    rollout_path = str(path.absolute())
    checkpoint = None

    def load_checkpoint(canonical_path: Path) -> str | None:
        nonlocal rollout_path, checkpoint
        try:
            canonical_key = str(canonical_path)
            checkpoint = load_rollout_checkpoint(home, thread_id, canonical_key)
            if checkpoint is not None:
                rollout_path = canonical_key
            elif canonical_key != rollout_path:
                checkpoint = load_rollout_checkpoint(home, thread_id, rollout_path)
        except (OSError, sqlite3.Error):
            pass
        return checkpoint

    observations = ReminderObservations()
    state, next_checkpoint = reminder_snapshot(
        path, load_checkpoint, minimum_used=minimum_used,
        expected_turn=turn, expected_model=model, observations=observations, scan_bytes=scan_bytes,
    )
    if (observations.receipts or observations.compactions) and not record_reminder_telemetry(
        home, thread_id, receipts=tuple(observations.receipts),
        compactions=tuple(observations.compactions),
    ):
        return state  # Retry the evidence on the next scan of this prefix.
    if next_checkpoint is not None and next_checkpoint != checkpoint:
        try:
            save_rollout_checkpoint(home, thread_id, rollout_path, checkpoint, next_checkpoint)
        except (OSError, sqlite3.Error):
            pass  # Cache persistence is optional after verifying the rollout.
    return state


def _compaction_reminder(request: dict, home: Path, path: Path, thread_id: str) -> str | None:
    model = request.get("model")
    turn = request.get("turn_id")
    plan = reminder_plan(home, model)
    if plan is None:
        return None
    state = _probe_reminder_window(
        home, path, thread_id, minimum_used=plan.levels[0][1],
        turn=turn if isinstance(turn, str) else None,
        model=model if isinstance(model, str) else None,
        scan_bytes=SCAN_BYTES,
    )
    if state is None or state.used is None or (
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
    marker = reminder_window_id(state.current)
    leads = (
        plan.lead_tokens,
        CHECK_LEAD_TOKENS if plan.lead_tokens > CHECK_LEAD_TOKENS else 0,
        FINAL_CHECK_LEAD_TOKENS if plan.lead_tokens > FINAL_CHECK_LEAD_TOKENS else 0,
    )
    startups = {level: first + plan.lead_tokens for level, first in plan.levels}
    record_reminder_telemetry(
        home, thread_id, window=state.current, notify_id=marker, leads=leads, used=state.used,
        decisions=tuple((level, int(stage), startups[level]) for level, stage in phases if level in claimed),
    )
    confirmations = [
        [level, int(stage)] for level, stage in phases
        if level in claimed and stage == ReminderStage.RECORDED
    ]
    notices = [
        (level, stage) for level, stage in phases
        if level in claimed and stage != ReminderStage.RECORDED
    ]
    usage = {
        "used": state.used, "capacity": state.capacity, "notify_id": marker,
        "leads": leads, "estimated_startups": [[level, tokens] for level, tokens in startups.items()],
    }
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
    receipt = f"{REMINDER_MARKER_PREFIX}{levels}:{marker}]"
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
        _probe_reminder_window(home, path, thread_id)
        record_hook_diagnostic(
            home, thread_id, "compact_context_prepared", note_status=note_status
        )
        return _RECOVERY_WITH_NOTE_HINT if note_status == "available" else _RECOVERY_HINT
    try:
        return _compaction_reminder(request, home, path, thread_id)
    except (OSError, ValueError, sqlite3.Error):
        return None


def patch_note(summary: str, patch: str) -> str:
    edited = apply_handoff_diff(summary, patch)
    if not edited.strip():
        raise ValueError("patch would leave an empty note")
    if len(edited.encode("utf-8")) > MAX_NOTE_BYTES:
        raise ValueError(f"patched note would exceed {MAX_NOTE_BYTES} UTF-8 bytes")
    return edited


def memory(
    home: Path, thread: str | None, action: str, *,
    summary: str | None, patch: str | None,
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
    if action == "read":
        if current is None or current.summary is None:
            return {"thread_id": thread_id, "summary": None, "updated_at": None}
        return {
            "thread_id": thread_id, "summary": current.summary,
            "updated_at": memory_timestamp(current.updated_us),
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
