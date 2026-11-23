"""Search and read selected human-readable fields from Codex rollout rows."""

from __future__ import annotations

import re
import warnings
from collections import deque
from collections.abc import Iterable, Iterator
from itertools import chain, tee
from pathlib import Path

from rollout_refs import (
    Reference,
    RolloutRow,
    parse_row_cursor,
    projected_reference,
    row_cursor,
    row_cursor_source,
)
from rollout_text import (
    TextField,
    _parts,
    _text_fields,
    _values,
    omit_data_urls,
    user_shell_parts,
)
from rollout_tokens import encrypted_record
from rollout_tool_outputs import tool_record_metadata
from rollout_transcript import read_transcript_reference, verify_transcript_reference

IndexedTextField = tuple[int, TextField]

IMAGE_RESULT_REFERENCES = {
    "image_generation_end": ("saved_path",),
    "ImageGeneration": ("saved_path",),
    "image_gen.generation": ("savedPath", "fileId"),
}
ACTIVITY_TYPES = {"SubAgentActivity", "sub_agent_activity"}
ACTIVITY_LABELS = (
    "id",
    "event_id",
    "agent_thread_id",
    "agent_path",
    "kind",
    "model",
    "reasoning_effort",
)
COMPLETION_TYPES = {"task_complete", "turn_complete"}
SETTINGS_LABELS = (
    "model",
    "model_provider_id",
    "service_tier",
    "reasoning_effort",
    "reasoning_summary",
    "personality",
)


def _object(value: object) -> dict:
    return value if isinstance(value, dict) else {}


def _string_fields(
    item: dict, keys: tuple[str, ...], prefix: str = ""
) -> Iterator[TextField]:
    for key in keys:
        if isinstance(value := item.get(key), str):
            yield prefix + key, value


def _questions(payload: dict, fields: tuple[str, ...]) -> Iterator[TextField]:
    questions = payload.get("questions")
    if isinstance(questions, list):
        for index, question in enumerate(questions):
            if isinstance(question, dict):
                prefix = f"questions[{index}]."
                yield from _string_fields(question, fields, prefix)
                if "title" in fields and isinstance(
                    options := question.get("options"), list
                ):
                    for option_index, option in enumerate(options):
                        if isinstance(option, str):
                            yield f"{prefix}options[{option_index}]", option


def _error_fields(error: dict, prefix: str = "") -> Iterator[TextField]:
    yield from _string_fields(error, ("message",), prefix)
    if isinstance(info := error.get("codex_error_info"), str):
        yield f"{prefix}codex_error_info", info
    elif isinstance(info, dict) and len(info) == 1:
        error_type, data = next(iter(info.items()))
        if re.fullmatch(r"[a-zA-Z][a-zA-Z0-9_]{0,63}", error_type):
            yield f"{prefix}codex_error_info", error_type
            details = _object(data)
            if type(status := details.get("http_status_code")) is int:
                yield f"{prefix}codex_error_info.http_status_code", str(status)
            yield from _string_fields(
                details, ("turn_kind",), f"{prefix}codex_error_info."
            )


def _event_fields(item_type: str, payload: dict) -> Iterator[TextField]:
    if item_type in COMPLETION_TYPES:
        yield from _error_fields(_object(payload.get("error")), "error.")
        yield from _string_fields(payload, ("last_agent_message",))
    elif item_type == "error":
        yield from _error_fields(payload)
    elif item_type == "warning":
        yield from _string_fields(payload, ("message",))
    elif item_type == "thread_goal_updated":
        yield from _string_fields(
            _object(payload.get("goal")), ("objective", "status"), "goal."
        )
    elif item_type == "thread_settings_applied":
        settings = _object(payload.get("thread_settings"))
        yield from _string_fields(settings, SETTINGS_LABELS, "thread_settings.")
        yield from _string_fields(
            _object(settings.get("collaboration_mode")),
            ("mode",),
            "thread_settings.collaboration_mode.",
        )
    elif item_type in ACTIVITY_TYPES:
        yield from _string_fields(payload, ACTIVITY_LABELS)


def _inter_agent_fields(payload: dict) -> Iterator[TextField]:
    yield from _string_fields(payload, ("content", "author", "recipient"))
    if isinstance(recipients := payload.get("other_recipients"), list):
        for index, recipient in enumerate(recipients):
            if isinstance(recipient, str):
                yield f"other_recipients[{index}]", recipient


def _metadata_fields(row: dict, kind: str, item_type: str | None) -> dict:
    payload = _object(row.get("payload"))
    labels = ()
    numbers = ()
    flags = ()
    details = {}
    if kind == "inter_agent_communication":
        labels = ("id", "author", "recipient")
        flags = ("trigger_turn",)
        if isinstance(recipients := payload.get("other_recipients"), list):
            details["other_recipients"] = [
                omit_data_urls(value)
                for value in recipients[:8]
                if isinstance(value, str) and len(value) <= 128
            ]
            details["other_recipient_count"] = len(recipients)
    elif kind == "retained_context" and item_type == "verified_answer":
        labels = ("call_id", "turn_id")
    elif kind == "retained_context" and item_type == "delivered_assistant_message":
        labels = ("message_id", "turn_id", "phase")
        flags = ("complete",)
    elif item_type in ACTIVITY_TYPES and kind == "event_msg":
        if payload.get("type") in {"item_started", "item_completed"}:
            payload = _object(payload.get("item"))
        labels = ACTIVITY_LABELS
        numbers = ("occurred_at_ms",)
    elif kind == "event_msg" and item_type in COMPLETION_TYPES:
        labels = ("turn_id", "root_turn_id")
        numbers = (
            "started_at",
            "completed_at",
            "duration_ms",
            "time_to_first_token_ms",
        )
        details["has_error"] = isinstance(payload.get("error"), dict)
    elif kind == "event_msg" and item_type == "thread_goal_updated":
        labels = ("threadId", "turnId")
        goal = _object(payload.get("goal"))
        details.update(_string_fields(goal, ("status",)))
        for key in (
            "tokenBudget",
            "tokensUsed",
            "timeUsedSeconds",
            "createdAt",
            "updatedAt",
        ):
            if type(value := goal.get(key)) is int:
                details[key] = value
    elif kind == "event_msg" and item_type == "thread_settings_applied":
        labels = ("thread_id",)
        settings = _object(payload.get("thread_settings"))
        details.update(_string_fields(settings, SETTINGS_LABELS))
        if isinstance(
            mode := _object(settings.get("collaboration_mode")).get("mode"), str
        ):
            details["collaboration_mode"] = mode
    elif item_type in {"agent_message", "AgentMessage"} and kind == "event_msg":
        if item_type == "AgentMessage":
            payload = _object(payload.get("item"))
        labels = ("delivery", "phase")
        if isinstance(questions := payload.get("questions"), list):
            details["question_count"] = len(questions)
    details.update(_string_fields(payload, labels))
    for key in numbers:
        if type(value := payload.get(key)) is int:
            details[key] = value
    for key in flags:
        if type(value := payload.get(key)) is bool:
            details[key] = value
    return {
        key: omit_data_urls(value) if isinstance(value, str) else value
        for key, value in details.items()
        if not isinstance(value, str) or len(value) <= 256
    }


def _response_fields(
    item_type: str | None,
    item: dict,
    tool: dict,
    shell_parts: set[int],
) -> Iterator[TextField]:
    for field in ("call_id", "item_id", "tool_name", "tool_server", "tool_namespace"):
        if value := tool.get(field):
            yield field, value

    user_message = item_type in {"message", "Message"} and item.get("role") == "user"
    if user_message or (
        not tool
        and item_type
        in {"message", "Message", "agent_message", "UserMessage", "AgentMessage"}
    ):
        parts = item.get("content")
        if shell_parts:
            parts = [
                None if index in shell_parts else part
                for index, part in enumerate(parts)
            ]
        yield from _parts(parts, "content")
    elif item_type == "reasoning":
        yield from _parts(item.get("summary"), "summary")
    elif item_type == "Reasoning":
        yield from _values(item.get("summary_text"), "summary_text")
    elif item_type == "Plan":
        yield from _values(item.get("text"), "text")
    if item_type == "AgentMessage":
        yield from _questions(item, ("title",))
    if item_type in ACTIVITY_TYPES:
        yield from _event_fields(item_type, item)
    for field in IMAGE_RESULT_REFERENCES.get(item_type, ()):
        if isinstance(value := item.get(field), str):
            yield field, value


def _projection(
    row: dict, tool: dict
) -> tuple[str, str | None, str | None, Iterable[TextField]]:
    kind = row.get("type", "")
    payload = _object(row.get("payload"))
    item_type = payload.get("type")
    if not isinstance(item_type, str):
        item_type = None
    if kind == "session_meta":
        base = payload.get("base_instructions")
        if isinstance(base, dict) and isinstance(text := base.get("text"), str):
            return (
                kind,
                "base_instructions",
                "system",
                (("base_instructions.text", text),),
            )
    if kind == "turn_context":
        mode = payload.get("collaboration_mode")
        if isinstance(mode, dict):
            settings = mode.get("settings")
            field = "collaboration_mode.developer_instructions"
            if isinstance(settings, dict):
                mode = settings
                field = "collaboration_mode.settings.developer_instructions"
            if isinstance(text := mode.get("developer_instructions"), str):
                return kind, "developer_instructions", "developer", ((field, text),)
    if encrypted_record(row) is not None:
        if item_type == "item_completed":
            item_type = "Reasoning"
        return kind, item_type, "assistant", ()
    if kind == "retained_context" and item_type == "verified_answer":
        return kind, item_type, "user", _questions(payload, ("question", "answer"))
    if kind == "retained_context" and item_type == "delivered_assistant_message":
        return kind, item_type, "assistant", _string_fields(payload, ("text",))
    if kind == "event_msg":
        if item_type in {"user_message", "agent_message", "agent_reasoning"}:
            message = _values(payload.get("message") or payload.get("text"), "message")
            if item_type == "user_message":
                return kind, item_type, "user", _user_event_fields(message, payload)
            if item_type == "agent_message":
                message = chain(message, _questions(payload, ("title",)))
            return kind, item_type, "assistant", message
        if item_type in {"item_completed", "item_started"}:
            payload = _object(payload.get("item"))
            nested_type = payload.get("type")
            if not isinstance(nested_type, str):
                return kind, item_type, None, ()
            if (
                item_type == "item_started"
                and not tool
                and nested_type not in ACTIVITY_TYPES
            ):
                return kind, nested_type, None, ()
            item_type = nested_type
            if item_type == "Extension" and payload.get("kind") in (
                "image_gen.generation",
                "web.search",
            ):
                item_type = payload["kind"]
        elif not tool and item_type not in IMAGE_RESULT_REFERENCES:
            return kind, item_type, None, _event_fields(item_type, payload)
    elif kind == "compacted":
        return kind, None, "assistant", _values(payload.get("message"), "message")
    elif kind == "inter_agent_communication":
        return kind, None, "assistant", _inter_agent_fields(payload)
    elif kind != "response_item":
        return kind, item_type, None, ()

    shell_parts = set()
    if item_type in {"message", "Message"} and payload.get("role") == "user":
        shell_parts = {index for index, _ in user_shell_parts(payload)}
        role = (
            "tool"
            if shell_parts and len(shell_parts) == len(payload["content"])
            else "user"
        )
    elif tool or item_type in IMAGE_RESULT_REFERENCES:
        role = "tool"
    elif item_type in {"message", "Message"}:
        role = payload.get("role")
    elif item_type == "UserMessage":
        role = "user"
    elif item_type in {
        "agent_message",
        "AgentMessage",
        "reasoning",
        "Reasoning",
        "Plan",
    }:
        role = "assistant"
    else:
        role = None
    return (
        kind,
        item_type,
        role,
        _response_fields(item_type, payload, tool, shell_parts),
    )


def _tool_metadata(source: Path, line: int, row: dict) -> dict:
    return {
        **(tool_record_metadata(source, line, row, direction="input") or {}),
        **(tool_record_metadata(source, line, row, direction="output") or {}),
    }


def _user_event_fields(
    message: Iterator[TextField], payload: dict
) -> Iterator[TextField]:
    yield from message
    yield from _values(payload.get("local_images"), "local_images")
    yield from _values(payload.get("local_audio"), "local_audio")


def _locator(
    source: Path,
    line: int,
    kind: str,
    item_type: str | None,
    role: str | None,
    row: dict,
    tool: dict,
) -> dict:
    inferred_tool = row.get("_rollout_tool_name")
    details = _metadata_fields(row, kind, item_type)
    event_type = (
        _object(row.get("payload")).get("type") if kind == "event_msg" else None
    )
    return {
        "rollout": source.name,
        "path": str(source),
        "line": line,
        "kind": kind,
        "item_type": item_type,
        **(
            {"event_type": event_type}
            if isinstance(event_type, str) and event_type != item_type
            else {}
        ),
        "role": role,
        "timestamp": row.get("timestamp"),
        **row.get("_rollout_provenance", {}),
        **({"turn_id": turn} if (turn := row.get("_rollout_turn_id")) else {}),
        **({"tool_name": inferred_tool} if inferred_tool else {}),
        **({"details": details} if details else {}),
        **tool,
    }


def _preview(
    locator: dict,
    fields: Iterable[IndexedTextField],
    max_chars: int,
    row: dict,
    *,
    chars: tuple[int, int] | None = None,
    offsets: bool = False,
) -> dict:
    if counts := encrypted_record(row):
        return {
            **locator,
            "encrypted_tokens": counts,
            "fields": [],
            "text_truncated": False,
        }
    result, truncated = _bounded_fields(fields, max_chars, chars=chars, offsets=offsets)
    return {**locator, "fields": result, "text_truncated": truncated}


def _bounded_fields(
    fields: Iterable[IndexedTextField],
    max_chars: int,
    *,
    chars: tuple[int, int] | None = None,
    offsets: bool = False,
) -> tuple[list[dict], bool]:
    result = []
    remaining = max_chars
    truncated = False
    for index, (field, value) in fields:
        start, end = chars or (0, len(value))
        start, end = min(start, len(value)), min(end, len(value))
        size = end - start
        if not size:
            continue
        if not remaining:
            truncated = True
            break
        preview = {
            "field": field,
            "field_index": index,
            "text": value[start : min(end, start + remaining)],
        }
        if offsets or chars is not None:
            preview.update(text_offset=start, text_total_chars=len(value))
        result.append(preview)
        if size > remaining:
            truncated = True
            break
        remaining -= size
    return result, truncated


def _hit_offset(length: int, start: int, end: int, max_chars: int) -> int:
    spare = max(0, max_chars - (end - start))
    return max(0, min(start - spare // 2, length - max_chars))


def _hit_preview(
    locator: dict,
    index: int,
    entry: TextField,
    start: int,
    end: int,
    max_chars: int,
) -> dict:
    field, value = entry
    offset = _hit_offset(len(value), start, end, max_chars)
    return {
        **locator,
        "field": field,
        "field_index": index,
        "text": value[offset : offset + max_chars],
        "text_offset": offset,
        "text_total_chars": len(value),
        "match_start": start,
        "match_end": end,
        "text_truncated": len(value) > max_chars,
    }


def _record_reference(
    location: RolloutRow,
    identity: tuple,
    fields: Iterable[TextField],
) -> Reference:
    return projected_reference(
        location, "record", chain.from_iterable(fields), identity=identity
    )


def _reference_identity(
    row: dict, item_type: str | None, role: str | None, tool: dict
) -> tuple:
    # Inferred tool names do not affect reference identity. The working directory
    # does, since relative attachments resolve against it.
    return (
        item_type,
        role,
        tuple(tool.items()),
        encrypted_record(row),
        row.get("_rollout_cwd"),
    )


def _hit(
    location: RolloutRow,
    locator: dict,
    identity: tuple,
    fields: Iterable[IndexedTextField],
    pattern: re.Pattern,
    max_chars: int,
) -> dict | None:
    for index, entry in fields:
        if match := pattern.search(entry[1]):
            anchor = (index, match.start(), match.end())
            ref = projected_reference(
                location, "hit", entry, identity=identity, anchor=anchor
            )
            return {
                **_hit_preview(locator, index, entry, *match.span(), max_chars),
                "ref": str(ref),
            }
    return None


def _project_reference(
    location: RolloutRow, ref: Reference
) -> tuple[dict, Iterable[IndexedTextField]]:
    source, line, row = location
    tool = _tool_metadata(source, line, row)
    kind, item_type, role, fields = _projection(row, tool)
    identity = _reference_identity(row, item_type, role, tool)
    indexed = enumerate(_text_fields(fields))
    if ref.anchor is not None:
        index, _, end = ref.anchor
        entry = next((entry for i, entry in indexed if i == index), None)
        if entry is None or end > len(entry[1]):
            raise ValueError(
                "rollout reference is stale or no longer matches the selected view"
            )
        actual = projected_reference(
            location, ref.view, entry, identity=identity, anchor=ref.anchor
        )
        selected = [(index, entry)]
    else:
        selected, digest_fields = tee(indexed)
        actual = _record_reference(
            location, identity, (entry for _, entry in digest_fields)
        )
    if actual != ref:
        raise ValueError(
            "rollout reference is stale or no longer matches the selected view"
        )
    return {
        **_locator(source, line, kind, item_type, role, row, tool),
        "ref": str(ref),
    }, selected


def read_reference(
    location: RolloutRow,
    ref: Reference,
    *,
    max_chars: int = 400,
    chars: tuple[int, int] | None = None,
) -> dict:
    """Expand one bounded view of a row without falling back to its raw payload."""
    if max_chars < 1 or (chars is not None and not 0 <= chars[0] < chars[1]):
        raise ValueError(
            "reference read requires a positive budget and 0 <= START < END"
        )
    if ref.view == "chat":
        return read_transcript_reference(
            location, ref, max_chars=max_chars, chars=chars
        )
    locator, fields = _project_reference(location, ref)
    if ref.anchor is not None:
        _, start, end = ref.anchor
        if ref.view == "hit":
            locator.update(match_start=start, match_end=end)
            if chars is None:
                _, (_, text) = next(iter(fields))
                length = len(text)
                chars = (_hit_offset(length, start, end, max_chars), length)
        elif chars is None:
            chars = (start, end)
    return _preview(locator, fields, max_chars, location[2], chars=chars, offsets=True)


def reference_image_scope(location: RolloutRow, ref: Reference) -> RolloutRow:
    """Validate the view and retain original media positions for visible chat attachments."""
    if ref.view != "chat":
        _project_reference(location, ref)
        return location
    _, images = verify_transcript_reference(location, ref)
    path, line, row = location
    payload = row["payload"]
    if images:
        selected = set(images)
        parts = [
            part if i in selected else None for i, part in enumerate(payload["content"])
        ]
        return path, line, {**row, "payload": {**payload, "content": parts}}
    return path, line, {**row, "payload": {}}


def _matches_filters(
    locator: dict,
    kinds: set[str],
    roles: set[str],
) -> bool:
    return (
        not kinds
        or any(locator.get(key) in kinds for key in ("kind", "item_type", "event_type"))
    ) and (not roles or locator["role"] in roles)


def _resume_rows(
    rows: Iterable[RolloutRow], cursor: str | None, *, before: int = 0
) -> Iterator[tuple[RolloutRow, bool]]:
    if cursor is None:
        for row in rows:
            yield row, True
        return

    source, target = parse_row_cursor(cursor)
    context_start = target - max(before - 1, 0)
    found = False
    for row in rows:
        if found:
            yield row, True
        elif context_start <= row[1] <= target and row_cursor_source(row[0]) == source:
            if before:
                yield row, False
            if row[1] == target:
                found = True
    if not found:
        raise ValueError("cursor is not within the selected rollout scope")


def _next_cursor(records: list[dict], truncated: bool) -> str | None:
    if not truncated:
        return None
    last = records[-1]
    return row_cursor(Path(last["path"]), last["line"])


def _selected_fields(
    fields: Iterable[TextField], field: str | None, field_index: int | None
) -> Iterator[IndexedTextField]:
    for index, entry in enumerate(_text_fields(fields)):
        if field_index is not None and index > field_index:
            break
        if (field is None or entry[0] == field) and (
            field_index is None or index == field_index
        ):
            yield index, entry


def _read_selection_reference(
    location: RolloutRow,
    identity: tuple,
    tool: dict,
    field: str | None,
    field_index: int | None,
    chars: tuple[int, int] | None,
) -> Reference:
    row = location[2]
    _, _, _, fields = _projection(row, tool)
    if field is not None or field_index is not None:
        targeted = _selected_fields(fields, field, field_index)
        selected = next(targeted, None)
        if selected is not None and (
            field_index is not None or next(targeted, None) is None
        ):
            index, entry = selected
            length = len(entry[1])
            start, end = chars or (0, length)
            return projected_reference(
                location,
                "field",
                entry,
                identity=identity,
                anchor=(index, min(start, length), min(end, length)),
            )
        _, _, _, fields = _projection(row, tool)
    return _record_reference(location, identity, _text_fields(fields))


def read(
    rows: Iterable[RolloutRow],
    *,
    kinds=None,
    roles=None,
    tools: Iterable[str] | None = None,
    limit=40,
    max_chars=400,
    budget_chars: int = 4000,
    cursor: str | None = None,
    field: str | None = None,
    field_index: int | None = None,
    chars: tuple[int, int] | None = None,
    include_empty: bool = False,
    metadata_only: bool = False,
) -> dict:
    """Return bounded previews in physical order, optionally including metadata-only rows."""
    if limit < 1 or max_chars < 1 or budget_chars < 1:
        raise ValueError("limit, max_chars, and budget_chars must be positive")
    if chars is not None and not 0 <= chars[0] < chars[1]:
        raise ValueError("chars requires 0 <= START < END")
    if field_index is not None and field_index < 0:
        raise ValueError("field_index must be nonnegative")
    if metadata_only and (
        field is not None or field_index is not None or chars is not None
    ):
        raise ValueError("metadata-only read cannot select a field or character range")
    kinds, roles, tools = set(kinds or ()), set(roles or ()), set(tools or ())
    records = []
    truncated = False
    remaining = budget_chars
    for (source, line, row), _ in _resume_rows(rows, cursor):
        tool = _tool_metadata(source, line, row)
        kind, item_type, role, fields = _projection(row, tool)
        locator = _locator(source, line, kind, item_type, role, row, tool)
        if not _matches_filters(locator, kinds, roles):
            continue
        if (
            tools
            and (tool.get("tool_name") or row.get("_rollout_tool_name")) not in tools
        ):
            continue
        preview = _preview(
            locator,
            () if metadata_only else _selected_fields(fields, field, field_index),
            min(max_chars, budget_chars),
            row,
            chars=chars,
        )
        if metadata_only:
            preview["body_available"] = next(_text_fields(fields), None) is not None
        if preview["fields"] or (
            field is None
            and field_index is None
            and (
                include_empty
                or metadata_only
                or "encrypted_tokens" in preview
                or tool
                or (item_type in kinds and "details" in preview)
            )
        ):
            size = sum(len(entry["text"]) for entry in preview["fields"])
            if len(records) == limit or size > remaining:
                truncated = True
                break
            identity = _reference_identity(row, item_type, role, tool)
            preview["ref"] = str(
                _read_selection_reference(
                    (source, line, row), identity, tool, field, field_index, chars
                )
            )
            records.append(preview)
            remaining -= size
    return {
        "records": records,
        "truncated": truncated,
        "next_cursor": _next_cursor(records, truncated),
    }


def search(
    rows: Iterable[RolloutRow],
    pattern: str,
    *,
    regex=False,
    ignore_case=False,
    kinds=None,
    roles=None,
    tools: Iterable[str] | None = None,
    limit=40,
    max_chars=400,
    before=0,
    after=0,
    budget_chars: int = 4000,
    cursor: str | None = None,
) -> dict:
    """Return one match per rollout row and deduplicated neighboring previews."""
    if not pattern or min(limit, max_chars, budget_chars) < 1 or min(before, after) < 0:
        raise ValueError(
            "search requires a pattern, positive limits, and nonnegative context counts"
        )
    flags = re.MULTILINE | (re.IGNORECASE if ignore_case else 0)
    try:
        with warnings.catch_warnings():
            warnings.simplefilter("ignore", FutureWarning)
            matcher = re.compile(pattern if regex else re.escape(pattern), flags)
    except (re.error, OverflowError, RecursionError) as error:
        raise ValueError(f"invalid regular expression: {error}") from error

    kinds, roles, tools = set(kinds or ()), set(roles or ()), set(tools or ())
    matches = []
    context = {}
    preceding = deque(maxlen=before)
    after_line = 0
    truncated = False
    previous_source = None
    max_chars = min(max_chars, budget_chars)
    remaining = budget_chars
    for (source, line, row), eligible in _resume_rows(rows, cursor, before=before):
        if source != previous_source:
            preceding.clear()
            after_line = 0
            previous_source = source
        if truncated and line > after_line:
            break

        tool = _tool_metadata(source, line, row)
        kind, item_type, role, fields = _projection(row, tool)
        locator = _locator(source, line, kind, item_type, role, row, tool)
        matches_allowed = (
            eligible
            and not truncated
            and _matches_filters(locator, kinds, roles)
            and (not tools or locator.get("tool_name") in tools)
        )
        if matches_allowed and (
            hit := _hit(
                (source, line, row),
                locator,
                _reference_identity(row, item_type, role, tool),
                enumerate(_text_fields(fields)),
                matcher,
                max_chars,
            )
        ):
            size = len(hit["text"])
            if len(matches) < limit and size <= remaining:
                matches.append(hit)
                remaining -= size
                after_line = line + after
                for prior_line, preview in preceding:
                    if prior_line >= line - before:
                        context[(source, prior_line)] = preview
                continue
            truncated = True

        if line <= after_line or (before and not truncated):
            # Reproject only when a preview is needed because matching consumes its fields.
            if matches_allowed:
                _, _, _, fields = _projection(row, tool)
            preview = _preview(locator, enumerate(_text_fields(fields)), max_chars, row)
            if preview["fields"] or "encrypted_tokens" in preview or tool:
                if line <= after_line:
                    context[(source, line)] = preview
                if before and not truncated:
                    preceding.append((line, preview))

    included_context = []
    context_truncated = False
    for preview in context.values():
        fields = preview["fields"]
        size = sum(len(field["text"]) for field in fields)
        if size > remaining:
            context_truncated = True
            if remaining == 0:
                continue
            clipped, _ = _bounded_fields(
                (
                    (field["field_index"], (field["field"], field["text"]))
                    for field in fields
                ),
                remaining,
            )
            preview = {**preview, "fields": clipped, "text_truncated": True}
        included_context.append(preview)
        remaining -= min(size, remaining)

    return {
        "matches": matches,
        "context": included_context,
        "context_truncated": context_truncated,
        "truncated": truncated,
        "next_cursor": _next_cursor(matches, truncated),
    }
