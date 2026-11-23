"""Physical rollout scopes and checkpoint timelines."""

from __future__ import annotations

import argparse
from collections.abc import Collection, Iterator
from dataclasses import dataclass, replace
from datetime import datetime
from pathlib import Path
from typing import TYPE_CHECKING

from rollout_lineage import copied_origin
from rollout_refs import parse_row_cursor, row_cursor_source
from rollout_source import Segment, checkpoint_window, records, rollout_id
from rollout_tokens import SUMMARY_TYPES, TokenUsage
from rollout_tool_filter import CALL_TYPES, ToolNameResolver

if TYPE_CHECKING:
    from rollout_query_index import RolloutIndex

Location = tuple[int, int]
CONTEXT_PAYLOADS = {"session_meta", "turn_context"}
TURN_START_EVENTS = {"task_started", "turn_started"}
TURN_END_EVENTS = {"task_complete", "turn_complete", "turn_aborted"}
CONTEXT_EVENTS = TURN_START_EVENTS | TURN_END_EVENTS
TOKEN_RECORDS = {"compacted", "token_usage_record"}


@dataclass
class AnnotationState:
    cwd: str | None
    active_turn: str | None = None
    in_prefix: bool = False


@dataclass
class WindowStart:
    location: Location
    next_offset: int | None
    state: AnnotationState


def instant(value: str) -> datetime:
    if "T" not in value:
        raise ValueError("expected an ISO 8601 timestamp with a UTC offset")
    when = datetime.fromisoformat(
        value.removesuffix("Z") + "+00:00" if value.endswith("Z") else value
    )
    if when.utcoffset() is None:
        raise ValueError("expected an ISO 8601 timestamp with a UTC offset")
    return when


def in_period(
    timestamp: str | None, since: datetime | None, until: datetime | None
) -> bool:
    if since is None and until is None:
        return True
    if not isinstance(timestamp, str):
        return False
    try:
        when = instant(timestamp)
    except ValueError:
        return False
    return (since is None or since <= when) and (until is None or when < until)


def window_overlaps(
    window: dict, since: datetime | None, until: datetime | None
) -> bool:
    if since is None and until is None:
        return True
    first, last = window.get("first_at"), window.get("last_at")
    return bool(
        first
        and last
        and (since is None or since <= instant(last))
        and (until is None or instant(first) < until)
    )


def provenance(segment: Segment, owner: str | None, line: int, row: dict) -> dict:
    thread_id = segment.metadata.get("id")
    copied = copied_origin(segment, line, row)
    if copied == "copied":
        return {
            "thread_id": thread_id,
            "origin": "inherited",
            "forked_from_thread_id": segment.metadata.get("forked_from_id"),
            "timestamp_origin": "copied_at",
        }
    origin = (
        "inherited"
        if thread_id != owner
        else ("unknown" if copied == "unknown" else "current")
    )
    return {"thread_id": thread_id, "origin": origin}


def timeline(
    segments: list[Segment],
    *,
    with_tokens: bool = True,
) -> Iterator[tuple[dict, Location, Location | None]]:
    number = 0
    start = (0, 0)
    first = None
    last = None
    period_start = period_end = None
    count = 0
    usage = TokenUsage() if with_tokens else None
    owner = segments[-1].metadata.get("id")
    for idx, segment in enumerate(segments):
        for path, line, row in records(
            segment,
            keep_payload=TOKEN_RECORDS if with_tokens else {"compacted"},
            response_types=SUMMARY_TYPES if with_tokens else None,
        ):
            ownership = provenance(segment, owner, line, row)
            location = {
                "path": str(path),
                "line": line,
                "timestamp": row.get("timestamp"),
                **ownership,
            }
            if first is None:
                first = location
            last = location
            count += 1
            if usage is not None and (
                row["type"] in TOKEN_RECORDS
                or (
                    row["type"] == "response_item"
                    and row["payload"].get("type") in SUMMARY_TYPES
                )
            ):
                usage.add(path, line, {**row, "_rollout_provenance": ownership})
            timestamp = location["timestamp"]
            if isinstance(timestamp, str):
                try:
                    stamped = instant(timestamp), timestamp
                except ValueError:
                    pass
                else:
                    period_start = (
                        stamped if period_start is None else min(period_start, stamped)
                    )
                    period_end = (
                        stamped if period_end is None else max(period_end, stamped)
                    )
            if row["type"] != "compacted":
                continue
            payload = row["payload"]
            number = checkpoint_window(number, payload)
            end = (idx, line)
            yield (
                {
                    **location,
                    "ordinal": row.get("ordinal"),
                    "window": number,
                    "window_inferred": number != payload.get("window_number"),
                    "start": first,
                    "compacted_at": location["timestamp"],
                    "first_at": period_start[1] if period_start else None,
                    "last_at": period_end[1] if period_end else None,
                    "records": count,
                    **({"token_usage": usage.report()} if usage is not None else {}),
                },
                start,
                end,
            )
            start = end
            first = last = None
            period_start = period_end = None
            count = 0
            if usage is not None:
                usage = TokenUsage()
    yield (
        {
            "window": "current",
            "start": first,
            "last": last,
            "compacted_at": None,
            "first_at": period_start[1] if period_start else None,
            "last_at": period_end[1] if period_end else None,
            "records": count,
            "thread_id": owner,
            "origin": "current",
            **({"token_usage": usage.report()} if usage is not None else {}),
        },
        start,
        None,
    )


def annotate_record(
    segment: Segment, owner: str | None, line: int, row: dict, state: AnnotationState
) -> dict:
    row.pop("_rollout_tool_name", None)
    ownership = provenance(segment, owner, line, row)
    copied = ownership.get("timestamp_origin") == "copied_at"
    if copied != state.in_prefix:
        state.cwd = None if copied else segment.metadata.get("cwd")
        state.active_turn = None
        state.in_prefix = copied
    if row.get("_rollout_gap"):
        state.cwd = None
        state.active_turn = None
    kind = row["type"]
    payload = row["payload"]
    event = payload.get("type") if kind == "event_msg" else None
    if kind in CONTEXT_PAYLOADS and payload.get("cwd"):
        state.cwd = payload["cwd"]
    if event in TURN_START_EVENTS:
        state.active_turn = payload.get("turn_id")
    annotations = payload.get("internal_chat_message_metadata_passthrough") or {}
    turn = payload.get("turn_id")
    if event == "thread_goal_updated" and turn is None:
        turn = payload.get("turnId")
    turn = turn or annotations.get("turn_id") or state.active_turn
    if event in TURN_END_EVENTS and turn == state.active_turn:
        state.active_turn = None
    return {
        **row,
        "_rollout_turn_id": turn,
        "_rollout_cwd": state.cwd,
        "_rollout_provenance": ownership,
    }


def annotate_rows(
    segment: Segment,
    owner: str | None,
    *,
    keep_payload: set[str] | None = None,
    event_types: set[str] | None = None,
    response_types: set[str] | None = None,
    full_lines: Collection[int] | None = None,
    revision_lines: Collection[int] | None = None,
    defer_revision: bool = False,
    start: tuple[int, int] | None = None,
    state: AnnotationState | None = None,
) -> Iterator[tuple[Path, int, dict]]:
    if state is None:
        state = AnnotationState(segment.metadata.get("cwd"))
    if event_types is not None or (
        keep_payload is not None and "event_msg" not in keep_payload
    ):
        event_types = CONTEXT_EVENTS | (event_types or set())
    if keep_payload is not None:
        keep_payload = keep_payload | CONTEXT_PAYLOADS
    for path, line, row in records(
        segment,
        keep_payload=keep_payload,
        event_types=event_types,
        response_types=response_types,
        full_lines=full_lines,
        revision_lines=revision_lines,
        defer_revision=defer_revision,
        start=start,
    ):
        yield path, line, annotate_record(segment, owner, line, row, state)


def window_bounds(
    segments: list[Segment], window: int | str
) -> tuple[WindowStart | None, Location | None]:
    previous = None
    bounds = None
    number = 0
    owner = segments[-1].metadata.get("id")
    for idx, segment in enumerate(segments):
        state = AnnotationState(segment.metadata.get("cwd"))
        rows = annotate_rows(segment, owner, keep_payload={"compacted"}, state=state)
        for _, line, row in rows:
            if row["type"] != "compacted":
                continue
            number = checkpoint_window(number, row["payload"])
            if number == window:
                bounds = previous, (idx, line)
            previous = WindowStart(
                (idx, line), row["_rollout_next_offset"], replace(state)
            )
    if window == "current":
        return previous, None
    if bounds is None:
        raise ValueError(f"no compaction checkpoint for window {window}")
    return bounds


def scoped_rows(
    segments: list[Segment],
    args: argparse.Namespace,
    *,
    keep_payload: set[str] | None = None,
    event_types: set[str] | None = None,
    response_types: set[str] | None = None,
    resolve_tool_names: bool = False,
    defer_revision: bool = False,
) -> Iterator[tuple[Path, int, dict]]:
    chosen = set()
    if args.segment is not None:
        chosen = {
            segment.path
            for segment in segments
            if args.segment in (segment.path.name, rollout_id(segment.path))
        }
        if not chosen:
            raise ValueError(f"segment is not in the rollout lineage: {args.segment}")
    cursor, end = (
        window_bounds(segments, args.window)
        if args.window is not None
        else (None, None)
    )
    start = cursor.location if cursor is not None else (0, 0)
    owner = segments[-1].metadata.get("id")
    retain_all_payloads = (
        keep_payload is None and event_types is None and response_types is None
    )
    for idx, segment in enumerate(segments):
        if end is not None and idx > end[0]:
            break
        if idx < start[0] or (chosen and segment.path not in chosen):
            continue
        if args.origin == "current" and segment.metadata.get("id") != owner:
            continue
        first_line, last_line = args.lines or (1, None)
        if idx == start[0]:
            first_line = max(first_line, start[1] + 1)
        if end is not None and idx == end[0]:
            last_line = end[1] if last_line is None else min(last_line, end[1])
        if last_line is not None and first_line > last_line:
            continue
        position = None
        state = None
        if (
            cursor is not None
            and cursor.next_offset is not None
            and idx == start[0]
            and segment.path.suffix != ".zst"
        ):
            position = start[1], cursor.next_offset
            state = cursor.state
        payloads = keep_payload
        responses = response_types
        full_lines = None
        first_unread_line = 1 if position is None else position[0] + 1
        if (
            retain_all_payloads
            and last_line is not None
            and first_line > first_unread_line
        ):
            payloads = set()
            full_lines = range(first_line, last_line + 1)
            if resolve_tool_names:
                responses = CALL_TYPES
        tool_names = ToolNameResolver(segment) if resolve_tool_names else None
        for path, line, row in annotate_rows(
            segment,
            owner,
            keep_payload=payloads,
            event_types=event_types,
            response_types=responses,
            full_lines=full_lines,
            defer_revision=defer_revision,
            start=position,
            state=state,
        ):
            if last_line is not None and line > last_line:
                break
            if tool_names is not None and (name := tool_names.name_for(line, row)):
                row["_rollout_tool_name"] = name
            if (
                line >= first_line
                and (not args.turn or row["_rollout_turn_id"] == args.turn)
                and (
                    args.origin == "all"
                    or row["_rollout_provenance"]["origin"] == args.origin
                )
                and in_period(row.get("timestamp"), args.since, args.until)
            ):
                yield path, line, row
            if line == last_line:
                break


def indexed_scoped_rows(
    segment: Segment, args: argparse.Namespace, index: RolloutIndex
) -> Iterator[tuple[Path, int, dict]]:
    """Read indexed candidates within the same physical scope as a full scan."""
    path = segment.path
    if args.segment is not None and args.segment not in (path.name, rollout_id(path)):
        raise ValueError(f"segment is not in the rollout lineage: {args.segment}")
    first_line, last_line = args.lines or (1, None)
    if args.window is not None:
        previous = number = 0
        bounds = None
        for line, explicit_window in index.checkpoints():
            number = checkpoint_window(number, {"window_number": explicit_window})
            if number == args.window:
                bounds = previous + 1, line
            previous = line
        if args.window == "current":
            first_line = max(first_line, previous + 1)
        elif bounds is None:
            raise ValueError(f"no compaction checkpoint for window {args.window}")
        else:
            start, end = bounds
            first_line = max(first_line, start)
            last_line = end if last_line is None else min(last_line, end)
    if args.cursor is not None:
        source, target = parse_row_cursor(args.cursor)
        if source != row_cursor_source(path) or target < first_line or (
            last_line is not None and target > last_line
        ):
            return  # The search reader reports a cursor outside the selected scope.
        first_line = max(first_line, target - max(args.before - 1, 0))
    if last_line is not None and first_line > last_line:
        return
    owner = segment.metadata.get("id")
    for line, row, state in index.rows(first_line, last_line, args.since, args.until):
        annotated = annotate_record(segment, owner, line, row, state)
        if (
            (not args.turn or annotated["_rollout_turn_id"] == args.turn)
            and (
                args.origin == "all"
                or annotated["_rollout_provenance"]["origin"] == args.origin
            )
            and in_period(annotated.get("timestamp"), args.since, args.until)
        ):
            yield path, line, annotated
