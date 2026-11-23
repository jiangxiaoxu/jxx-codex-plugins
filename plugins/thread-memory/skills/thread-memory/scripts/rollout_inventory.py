"""Count the kinds of records present in a selected rollout scope."""

from __future__ import annotations

import hashlib
import json
import re
from collections.abc import Iterable

from rollout_refs import RolloutRow
from rollout_search import _projection, _tool_metadata, read

_CURSOR = re.compile(r"inv1:[a-f0-9]{24}")
_ROLES = {"user", "assistant", "system", "developer", "tool", "function"}


def _name(value: object) -> str:
    return value if isinstance(value, str) else ""


def _cursor(key: tuple[str, ...]) -> str:
    value = json.dumps(key, separators=(",", ":")).encode("ascii")
    return f"inv1:{hashlib.sha256(value).hexdigest()[:24]}"


def inventory(
    rows: Iterable[RolloutRow],
    *,
    kinds: Iterable[str] | None = None,
    roles: Iterable[str] | None = None,
    limit: int = 20,
    cursor: str | None = None,
) -> dict:
    """Count records in one pass and return a page of metadata-only groups."""
    if limit < 1:
        raise ValueError("limit must be positive")
    if cursor is not None and not _CURSOR.fullmatch(cursor):
        raise ValueError(
            "invalid inventory cursor; use next_cursor from the previous page"
        )
    kinds, roles = set(kinds or ()), set(roles or ())
    groups = {}
    record_count = 0
    for location in rows:
        source, line, row = location
        kind = _name(row.get("type"))
        payload = row["payload"]
        item_type = _name(payload.get("type"))
        item = payload
        event_type = ""
        nested_item = payload.get("item")
        if (
            kind == "event_msg"
            and isinstance(nested_item, dict)
            and (nested_type := _name(nested_item.get("type")))
        ):
            item = nested_item
            event_type, item_type = item_type, nested_type
        extension = _name(item.get("kind")) if item_type == "Extension" else ""
        _, projected_type, role, _ = _projection(row, _tool_metadata(source, line, row))
        if kinds and not kinds.intersection(
            (kind, item_type, event_type, extension, projected_type)
        ):
            continue
        role = _name(role)
        if role not in _ROLES:
            role = ""
        if roles and role not in roles:
            continue
        key = (kind, item_type, event_type, extension, role)
        record_count += 1
        if key in groups:
            groups[key]["count"] += 1
            continue
        representative = read([location], metadata_only=True)["records"][0]
        example = {
            "rollout": source.name,
            "path": str(source),
            "line": line,
            "timestamp": row.get("timestamp"),
            "ref": representative["ref"],
            "read_type": projected_type,
            "body_available": representative["body_available"],
            **row.get("_rollout_provenance", {}),
        }
        groups[key] = {
            "kind": kind,
            "item_type": item_type or None,
            "event_type": event_type or None,
            "extension": extension or None,
            "role": role or None,
            "count": 1,
            "example": example,
        }
    keys = sorted(groups)
    start = 0
    if cursor is not None:
        for index, key in enumerate(keys, start=1):
            if _cursor(key) == cursor:
                start = index
                break
        else:
            raise ValueError(
                "inventory cursor is not within the selected rollout scope"
            )
    end = min(start + limit, len(keys))
    truncated = end < len(keys)
    return {
        "items": [groups[key] for key in keys[start:end]],
        "truncated": truncated,
        "next_cursor": _cursor(keys[end - 1]) if truncated else None,
        "group_count": len(keys),
        "record_count": record_count,
    }
