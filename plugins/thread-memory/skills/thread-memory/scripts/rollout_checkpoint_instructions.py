"""Read bounded instruction excerpts from one recorded compaction checkpoint."""

from __future__ import annotations

import re
from collections.abc import Collection, Iterator
from itertools import islice

from rollout_refs import RolloutRow, projected_reference, row_cursor
from rollout_text import TEXT_PARTS, omit_data_urls

_ROLES = frozenset({"system", "developer"})
_CURSOR = re.compile(r"ci1:([a-f0-9]{24}):(0|[1-9][0-9]{0,18})")


def _messages(
    location: RolloutRow, roles: Collection[str], item: int | None, *, after: int = -1
) -> Iterator[tuple[int, str, str]]:
    _, _, row = location
    payload = row.get("payload")
    if row.get("type") != "compacted" or not isinstance(payload, dict):
        return
    history = payload.get("replacement_history")
    if not isinstance(history, list):
        return
    if item is not None:
        if not after < item < len(history):
            return
        messages = ((item, history[item]),)
    else:
        messages = islice(enumerate(history), after + 1, None)
    for index, message in messages:
        if not isinstance(message, dict) or message.get("type") != "message":
            continue
        role = message.get("role")
        if not isinstance(role, str) or role not in roles:
            continue
        content = message.get("content")
        if not isinstance(content, list):
            continue
        parts = (
            omit_data_urls(part["text"])
            for part in content
            if isinstance(part, dict)
            and isinstance(part.get("type"), str)
            and part["type"] in TEXT_PARTS
            and isinstance(part.get("text"), str)
            and part["text"]
        )
        text = "\n".join(parts)
        if text.strip():
            yield index, role, text


def checkpoint_instructions(
    location: RolloutRow,
    *,
    window: int,
    roles: Collection[str] | None = None,
    item: int | None = None,
    chars: tuple[int, int] | None = None,
    limit: int = 20,
    max_chars: int = 1000,
    budget_chars: int = 4000,
    cursor: str | None = None,
) -> dict:
    """Read one excerpt per message, with original item indices for expansion."""
    path, line, row = location
    selected_roles = _ROLES if roles is None else _ROLES.intersection(roles)
    identity = (
        "checkpoint-instructions",
        row_cursor(path, line),
        window,
        sorted(selected_roles),
        item,
        chars,
    )

    def cursor_digest() -> str:
        return projected_reference(
            location,
            "record",
            (
                value
                for index, role, text in _messages(location, selected_roles, item)
                for value in (str(index), role, text)
            ),
            identity=identity,
        ).digest

    after = -1
    digest = None
    if cursor is not None:
        match = _CURSOR.fullmatch(cursor)
        if match is None:
            raise ValueError("invalid checkpoint instruction cursor; use next_cursor")
        digest, index = match.groups()
        if digest != cursor_digest():
            raise ValueError(
                "checkpoint or instruction filters changed; start a new page"
            )
        after = int(index)

    items = []
    next_cursor = None
    remaining = budget_chars
    for index, role, text in _messages(location, selected_roles, item, after=after):
        start, end = chars or (0, len(text))
        end = min(end, len(text))
        if end <= start:
            continue
        if len(items) >= limit or remaining == 0:
            next_cursor = (
                f"ci1:{digest or cursor_digest()}:{items[-1]['checkpoint_item']}"
            )
            break
        stop = min(end, start + max_chars, start + remaining)
        items.append(
            {
                "role": role,
                "kind": row["type"],
                "path": str(path),
                "line": line,
                "window": window,
                "checkpoint_item": index,
                "text": text[start:stop],
                "text_offset": start,
                "text_total_chars": len(text),
                "text_truncated": stop < end,
            }
        )
        remaining -= stop - start
    return {"window": window, "items": items, "next_cursor": next_cursor}
