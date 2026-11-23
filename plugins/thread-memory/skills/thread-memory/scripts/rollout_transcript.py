"""Extract original chat messages from scoped physical rollout records."""

from __future__ import annotations

import re
from collections import deque
from collections.abc import Iterable, Iterator
from pathlib import Path

from rollout_refs import (
    Reference,
    RolloutRow,
    parse_row_cursor,
    projected_reference,
    row_cursor,
    row_cursor_source,
)
from rollout_text import omit_data_urls

# Legacy context may use the user role without a content kind annotation.
CONTEXT_BLOCK = re.compile(
    r"<(?P<tag>agent_message_board_notification|codex_internal_context|"
    r"environment_context|external_[a-zA-Z0-9_-]+|goal_context|hook_prompt|"
    r"recommended_plugins|skill|subagent_notification|turn_aborted|"
    r"user_instructions|user_shell_command)(?:\s+[^>]+)?>.*</(?P=tag)>",
    re.DOTALL,
)
CONTEXT_PREFIXES = (
    "# AGENTS.md instructions",
    "<environment_context>",
    "Another language model started to solve this problem",
)
ASSISTANT_PHASES = {
    "commentary": "commentary",
    "partial": "partial_answer",
    "final": "final_answer",
}


def _response_content(
    item: dict, kinds: list[str]
) -> tuple[str, tuple[int, ...], dict[str, int]]:
    role = item["role"]
    text_parts = []
    attachments = []
    counts: dict[str, int] = {}
    for index, part in enumerate(item["content"]):
        if not isinstance(part, dict):
            continue
        kind = kinds[index] if index < len(kinds) else ""
        unclassified = kind in ("", "unknown")
        if role == "user" and not (unclassified or kind.startswith("user.")):
            continue
        part_type = part.get("type")
        if part_type in ("input_image", "input_audio"):
            attachments.append(index)
            counter = f"{part_type.removeprefix('input_')}_count"
            counts[counter] = counts.get(counter, 0) + 1
            continue
        if part_type not in ("input_text", "output_text"):
            continue
        value = part["text"]
        trimmed = value.strip()
        if (
            role == "user"
            and unclassified
            and (
                trimmed.startswith(CONTEXT_PREFIXES) or CONTEXT_BLOCK.fullmatch(trimmed)
            )
        ):
            continue
        if trimmed:
            text_parts.append(value)
    return "\n".join(text_parts), tuple(attachments), counts


def _chat_message(
    path: Path, line: int, row: dict, roles: set[str], phase: str | None = None
) -> tuple[dict, tuple[int, ...]] | None:
    payload = row["payload"]
    delivery = None
    attachments = ()
    counts = {}
    if row["type"] == "response_item" and payload.get("type") == "message":
        item = payload
        role = item.get("role")
        metadata = row.get("metadata") or {}
        if (
            role not in roles
            or (phase is not None and item.get("phase") != phase)
            or metadata.get("compaction_output")
            or (
                metadata.get("inherited_user_message")
                and row.get("_rollout_provenance", {}).get("origin") != "inherited"
            )
        ):
            return None
        annotations = item.get("internal_chat_message_metadata_passthrough") or {}
        body, attachments, counts = _response_content(
            item, annotations.get("content_item_kinds") or []
        )
        turn_id = annotations.get("turn_id")
    elif row["type"] == "event_msg" and "assistant" in roles:
        # Async user-facing tools emit a chat item without a matching response item.
        role = "assistant"
        event = payload.get("type")
        item = payload["item"] if event == "item_completed" else payload
        if item.get("delivery") != "async" or (
            phase is not None and item.get("phase") != phase
        ):
            return None
        if event == "item_completed" and item.get("type") == "AgentMessage":
            body = "\n".join(
                part["text"] for part in item["content"] if part.get("type") == "Text"
            )
        elif event == "agent_message":
            body = item["message"]
        else:
            return None
        delivery = "async"
        turn_id = payload.get("turn_id")
    else:
        return None

    if not body and not attachments:
        return None
    return {
        "timestamp": row.get("timestamp"),
        "role": role,
        "text": omit_data_urls(body),
        "turn_id": row.get("_rollout_turn_id") or turn_id,
        "path": str(path),
        "line": line,
        **row.get("_rollout_provenance", {}),
        **({"phase": item["phase"]} if item.get("phase") else {}),
        **({"delivery": delivery} if delivery else {}),
        **counts,
    }, attachments


def _chat_values(
    text: str, content: list[dict], attachments: tuple[int, ...]
) -> Iterator[str]:
    yield text
    for index in attachments:
        part = content[index]
        url_field = "audio_url" if part.get("type") == "input_audio" else "image_url"
        for field in (url_field, "file_id", "data", "mimeType"):
            value = part.get(field)
            yield value if isinstance(value, str) else ""


def _chat_reference(
    location: RolloutRow, message: dict, attachments: tuple[int, ...]
) -> Reference:
    row = location[2]
    return projected_reference(
        location,
        "chat",
        _chat_values(message["text"], row["payload"].get("content", []), attachments),
        identity=(
            message["role"],
            message.get("phase"),
            message.get("delivery"),
            attachments,
            row.get("_rollout_cwd") if attachments else None,
        ),
    )


def verify_transcript_reference(
    location: RolloutRow, ref: Reference
) -> tuple[dict, tuple[int, ...]]:
    projected = _chat_message(*location, {"user", "assistant"})
    if projected is None or _chat_reference(location, *projected) != ref:
        raise ValueError(
            "rollout reference is stale or no longer matches the selected view"
        )
    return projected


def read_transcript_reference(
    location: RolloutRow,
    ref: Reference,
    *,
    max_chars: int,
    chars: tuple[int, int] | None,
) -> dict:
    message, _ = verify_transcript_reference(location, ref)
    body = message["text"]
    start, end = chars or (0, len(body))
    start = min(start, len(body))
    stop = min(end, len(body), start + max_chars)
    excerpt = {
        **message,
        "ref": str(ref),
        "text": body[start:stop],
        "text_offset": start,
        "text_total_chars": len(body),
    }
    if stop - start < len(body):
        excerpt["omitted_chars"] = len(body) - (stop - start)
    return excerpt


def transcript(
    rows: Iterable[RolloutRow],
    *,
    roles: Iterable[str] | None = None,
    limit: int = 20,
    max_chars: int = 1000,
    budget_chars: int = 4000,
    cursor: str | None = None,
    last: int | None = None,
    phase: str | None = None,
) -> dict:
    """Return a forward page or the latest bounded suffix in rollout order.

    Async chat messages are recorded as events. Ordinary chat uses response
    items so their mirrored events do not duplicate messages.
    """
    if limit <= 0 or max_chars <= 0 or budget_chars <= 0:
        raise ValueError("transcript limits must be positive")
    if last is not None and (last <= 0 or cursor is not None):
        raise ValueError("last must be positive and cannot be combined with a cursor")
    if phase is not None and phase not in ASSISTANT_PHASES:
        raise ValueError("transcript phase must be commentary, partial or final")
    recorded_phase = ASSISTANT_PHASES.get(phase)
    selected_roles = {"user", "assistant"}
    if roles is not None:
        selected_roles.intersection_update(roles)
    if recorded_phase is not None:
        selected_roles.intersection_update({"assistant"})
    messages: deque[dict] = deque()
    preview_limit = min(max_chars, budget_chars)
    remaining = budget_chars
    waiting = parse_row_cursor(cursor) if cursor is not None else None
    for path, line, row in rows:
        if waiting is not None:
            if line == waiting[1] and row_cursor_source(path) == waiting[0]:
                waiting = None
            continue
        projected = _chat_message(path, line, row, selected_roles, recorded_phase)
        if projected is None:
            continue
        message, attachments = projected
        text_chars = len(message["text"])
        preview_chars = min(text_chars, preview_limit)
        if last is not None:
            while len(messages) == last or preview_chars > remaining:
                remaining += len(messages.popleft()["text"])
        elif len(messages) == limit or preview_chars > remaining:
            previous = messages[-1]
            return {
                "messages": list(messages),
                "next_cursor": row_cursor(Path(previous["path"]), previous["line"]),
            }
        message["ref"] = str(_chat_reference((path, line, row), message, attachments))
        if text_chars > preview_chars:
            message["omitted_chars"] = text_chars - preview_chars
            message["text"] = message["text"][:preview_chars]
        messages.append(message)
        remaining -= preview_chars
    if waiting is not None:
        raise ValueError("transcript cursor is outside the selected rollout range")
    return {"messages": list(messages), "next_cursor": None}
