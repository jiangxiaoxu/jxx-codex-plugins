"""Describe thread ownership and logical fork ancestry from rollout headers."""

from __future__ import annotations

from pathlib import Path
from uuid import UUID

from rollout_source import Segment, find_rollout, metadata, rollout_id


def spawn_parent(header: dict) -> str | None:
    if parent := header.get("parent_thread_id"):
        return parent
    source = header.get("source")
    subagent = source.get("subagent") if isinstance(source, dict) else None
    spawn = subagent.get("thread_spawn") if isinstance(subagent, dict) else None
    return spawn.get("parent_thread_id") if isinstance(spawn, dict) else None


def is_subagent(header: dict) -> bool:
    if (
        spawn_parent(header) is not None
        or header.get("thread_source") == "subagent"
        or header.get("subagent_history_start_ordinal") is not None
    ):
        return True
    source = header.get("source")
    if isinstance(source, str):
        source = source.lower()
        return source == "subagent" or source.startswith("subagent_")
    return isinstance(source, dict) and "subagent" in source


def copied_origin(segment: Segment, line: int, row: dict) -> str:
    """Classify a record within its physical rollout before comparing thread owners."""
    if line == 1 and row.get("type") == "session_meta":
        return "owned"
    header = segment.metadata
    boundary = header.get("subagent_history_start_ordinal")
    if type(boundary) is int and boundary > 0:
        ordinal = row.get("ordinal")
        if type(ordinal) is not int:
            return "unknown"
        return "copied" if ordinal < boundary else "owned"
    if header.get("forked_from_id") and not header.get("history_base"):
        if (row.get("metadata") or {}).get("inherited_user_message"):
            return "copied"
        return "unknown"
    return "owned"


def segment_info(segment: Segment, primary: Segment) -> dict:
    thread_id = segment.metadata.get("id")
    if segment.path == primary.path:
        relation = "current_rollout"
    elif thread_id is not None and thread_id == primary.metadata.get("id"):
        relation = "same_thread_history"
    else:
        relation = "inherited_thread_history"
    return {
        "path": str(segment.path),
        "thread_id": thread_id,
        "rollout_id": rollout_id(segment.path),
        "relation": relation,
        "size_bytes": segment.path.stat().st_size,
        "end_ordinal_exclusive": segment.end_ordinal,
        "end_byte_offset": segment.end_offset,
        "subagent_history_start_ordinal": segment.metadata.get(
            "subagent_history_start_ordinal"
        ),
        "forked_from_id": segment.metadata.get("forked_from_id"),
        "spawned_by": spawn_parent(segment.metadata),
    }


def fork_boundary(segment: Segment, parent_id: str | None) -> int | None:
    if not parent_id:
        return None
    header = segment.metadata
    boundary = header.get("forked_from_ordinal_exclusive")
    base = header.get("history_base")
    if (
        boundary is None
        and isinstance(base, dict)
        and (
            base.get("thread_id") == parent_id
            or rollout_id(segment.path) == header.get("id")
        )
    ):
        # Older headers omit the logical boundary. A revert's physical base
        # is only usable here when it directly names the logical parent.
        boundary = base.get("end_ordinal_exclusive")
    return boundary


def describe_lineage(segments: list[Segment], home: Path) -> dict:
    primary = current = segments[-1]
    # Prefer the closest pinned ancestor shard over the parent's current
    # rollout, which may have been reverted since this thread was forked.
    pinned = {segment.metadata.get("id"): segment for segment in segments}
    chain = []
    seen = set()
    while True:
        header = current.metadata
        thread_id = header.get("id")
        parent_id = header.get("forked_from_id")
        seen.add(thread_id)
        chain.append(
            {
                "thread_id": thread_id,
                "rollout_id": rollout_id(current.path),
                "path": str(current.path),
                "timestamp": header.get("timestamp"),
                "forked_from_id": parent_id,
                "forked_from_ordinal_exclusive": fork_boundary(current, parent_id),
                "spawned_by": spawn_parent(header),
                "subagent_history_start_ordinal": header.get(
                    "subagent_history_start_ordinal"
                ),
            }
        )
        if not parent_id:
            end = {"status": "root"}
            break
        if parent_id in seen:
            end = {"status": "cycle", "thread_id": parent_id}
            break
        if parent_id in pinned:
            current = pinned[parent_id]
            continue
        try:
            path = find_rollout(home, str(UUID(parent_id)), thread=True)
            if path is None:
                end = {"status": "missing", "thread_id": parent_id}
                break
            header = metadata(path)
            if header.get("id") != parent_id:
                raise ValueError("thread identity does not match the rollout header")
        except (OSError, ValueError) as error:
            end = {"status": "unreadable", "thread_id": parent_id, "error": str(error)}
            break
        current = Segment(path, header)

    return {
        "thread_id": primary.metadata.get("id"),
        "root_session_id": primary.metadata.get("session_id"),
        "rollout_id": rollout_id(primary.path),
        "segments": [segment_info(segment, primary) for segment in segments],
        "fork_chain": chain,
        "fork_chain_end": end,
    }
