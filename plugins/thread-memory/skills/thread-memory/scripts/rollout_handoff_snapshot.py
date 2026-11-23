"""Read bounded context-window markers and usage snapshots from an active rollout."""

from __future__ import annotations

from base64 import urlsafe_b64encode
from collections.abc import Iterator
from dataclasses import dataclass, field
from hashlib import blake2s
from itertools import chain
import json
import os
from pathlib import Path
import re
from typing import BinaryIO

from rollout_handoff_cursor import ReminderCheckpoint, TurnCoverage, read_checkpoint, write_checkpoint


BLOCK_BYTES = 1024 * 1024
SCAN_BYTES = 512 * BLOCK_BYTES
RECORD_BYTES = 256 * 1024
PREFIX_BYTES = 512

# These envelope fields precede the potentially large payload in Codex JSONL.
HEADER = re.compile(
    rb'\s*\{\s*(?:"timestamp"\s*:\s*"[^"\\]{0,64}"\s*,\s*)?'
    rb'(?:"ordinal"\s*:\s*([0-9]{1,20})\s*,\s*)?'
    rb'"type"\s*:\s*"([a-z_]+)"\s*,\s*"payload"\s*:\s*\{\s*'
)
SUBTYPE = re.compile(rb'"type"\s*:\s*"([a-z_]+)"\s*[,}]')
REMINDER_TAG = "thread_memory_reminder"
REMINDER_OPEN = f"<{REMINDER_TAG}>\n"
REMINDER_CLOSE = f"\n</{REMINDER_TAG}>"
REMINDER_TAG_PREFIX = re.compile(rf"</?{REMINDER_TAG}")
REMINDER_MARKER_PREFIX = "Notify ID: ["
REMINDER_LEVEL = r"(?:100|[1-9][0-9]?|0)"
REMINDER_LEVELS = rf"{REMINDER_LEVEL}(?:,{REMINDER_LEVEL}){{0,100}}"
REMINDER_MARKER = re.compile(
    rf"\n{re.escape(REMINDER_MARKER_PREFIX)}({REMINDER_LEVELS}):([A-Za-z0-9_-]{{8}})\]\Z"
)
LEGACY_REMINDER_MARKER = re.compile(rf"\n\[thread-memory:({REMINDER_LEVELS})\]\Z")
LEGACY_REMINDER_WINDOW = re.compile(
    r"`memory write --window ([0-9a-f]{24}:(?:start|[0-9]{1,20}:[0-9a-f]{16}))`"
)
USAGE_KINDS = {"token_usage_record", "turn_context"}
TURN_START_EVENTS = {"task_started", "turn_started"}
REPLAY_EVENTS = TURN_START_EVENTS | {"token_count", "thread_settings_applied"}
EVENT_KINDS = REPLAY_EVENTS | {"thread_rolled_back"}


@dataclass(frozen=True)
class WindowSnapshot:
    current: str
    previous: str | None
    used: int | None
    capacity: int | None
    received_reminder_levels: frozenset[int] = frozenset()


@dataclass
class _Usage:
    used: int
    capacity: int | None
    turn: str | None = None
    model: str | None = None


@dataclass(frozen=True)
class _WindowHeader:
    end: int
    first_owned: int | None
    segment: str
    thread_id: object


@dataclass
class _CheckpointCapture:
    boundary: int | None = None
    signals: list[dict] = field(default_factory=list)
    turn_coverage: TurnCoverage = field(default_factory=TurnCoverage)


def _reverse_lines(
    stream: BinaryIO, size: int, lower: int, known_line_start: bool
) -> Iterator[tuple[int, bytes, bytes, bool]]:
    """Yield byte offsets, capped record heads, trailers, and clipping flags."""
    cursor = line_end = size
    prefix = trailer = b""
    while cursor > lower:
        start = max(lower, cursor - BLOCK_BYTES)
        stream.seek(start)
        data = stream.read(cursor - start)
        if len(data) != cursor - start:
            raise ValueError("rollout changed during the snapshot read")
        cursor = start
        end = len(data)
        while True:
            newline = data.rfind(b"\n", 0, end)
            part = data[newline + 1 : end]
            offset = start + newline + 1
            clipped = line_end - offset > RECORD_BYTES
            trailer = (part[-8:] + trailer)[-8:]
            prefix = (part[:PREFIX_BYTES] + prefix)[:PREFIX_BYTES] if clipped else part + prefix
            if newline < 0:
                break
            # The recorder terminates every committed record with LF.
            if line_end != size:
                yield offset, prefix, trailer, clipped
            end = newline
            line_end = start + end
            prefix = trailer = b""
    if known_line_start and lower < line_end < size:
        yield lower, prefix, trailer, line_end - lower > RECORD_BYTES


def _positive(value: object) -> int | None:
    return value if type(value) is int and value > 0 else None


def _record(raw: bytes, trailer: bytes, clipped: bool) -> tuple[str, dict, int | None]:
    if header := HEADER.match(raw):
        ordinal = int(header[1]) if header[1] is not None else None
        kind = header[2].decode("ascii")
        if kind == "compacted" and clipped and trailer.rstrip().endswith(b"}}"):
            return kind, {}, ordinal
        if kind == "event_msg":
            subtype = SUBTYPE.match(raw, header.end())
            if subtype and subtype[1].decode("ascii") not in EVENT_KINDS:
                return kind, {}, ordinal
        elif kind not in USAGE_KINDS and kind not in {"compacted", "session_meta"}:
            return kind, {}, ordinal
    if clipped:
        raise ValueError("cannot classify a large rollout record")
    row = json.loads(raw)
    if not isinstance(row, dict) or not isinstance(row.get("type"), str):
        raise ValueError("invalid rollout record")
    payload = row.get("payload")
    if not isinstance(payload, dict):
        raise ValueError("invalid rollout payload")
    ordinal = row.get("ordinal")
    return row["type"], payload, ordinal if type(ordinal) is int and ordinal >= 0 else None


def _sample(kind: str, payload: dict) -> _Usage | None:
    if kind == "token_usage_record":
        usage = payload.get("usage")
        turn = payload.get("turn_id")
        capacity = _positive(payload.get("model_context_window"))
    else:
        info = payload.get("info")
        if not isinstance(info, dict):
            return None
        usage = info.get("last_token_usage")
        turn = None
        capacity = _positive(info.get("model_context_window"))
    used = usage.get("total_tokens") if isinstance(usage, dict) else None
    if type(used) is not int or used < 0:
        return None
    return _Usage(used, capacity, turn if isinstance(turn, str) else None)


def _usable_sample(
    usage: _Usage, model: str | None, capacity: int | None
) -> bool:
    return (usage.model is None or usage.model == model) and (
        usage.capacity is None or capacity is None or usage.capacity == capacity
    )


def reminder_window_id(window: str) -> str:
    """Encode the 48-bit window fingerprint used in a thread-local reminder receipt."""
    digest = blake2s(window.encode("ascii"), digest_size=6).digest()
    return urlsafe_b64encode(digest).decode("ascii")


def _collect_reminder_receipts(payload: object, receipts: dict[str, set[int]]) -> None:
    if not isinstance(payload, dict) or (
        payload.get("type") != "message" or payload.get("role") != "developer"
    ):
        return
    annotations = payload.get("internal_chat_message_metadata_passthrough")
    parts = payload.get("content")
    if not isinstance(annotations, dict) or not isinstance(parts, list):
        return
    kinds = annotations.get("content_item_kinds")
    metadata = annotations.get("content_item_metadata")
    if not isinstance(kinds, list) or not isinstance(metadata, list):
        return
    for part, kind, source in zip(parts, kinds, metadata):
        if kind != "hooks.additional_context" or not isinstance(source, dict):
            continue
        provenance = source.get("provenance")
        if not isinstance(provenance, dict) or (
            provenance.get("type") != "harness" or provenance.get("hook") is not True
        ):
            continue
        if not isinstance(part, dict) or part.get("type") != "input_text":
            continue
        text = part.get("text")
        if isinstance(text, str) and (receipt := _reminder_receipt(text)):
            receipt_id, levels = receipt
            receipts.setdefault(receipt_id, set()).update(levels)


def _reminder_receipt(text: str) -> tuple[str, set[int]] | None:
    wrapped = text.startswith(REMINDER_OPEN) and text.endswith(REMINDER_CLOSE)
    if wrapped:
        start, end = len(REMINDER_OPEN), len(text) - len(REMINDER_CLOSE)
    else:
        start, end = 0, len(text)
    if REMINDER_TAG_PREFIX.search(text, start, end):
        return None
    marker = REMINDER_MARKER.search(text, start, end)
    if marker is not None:
        if not wrapped:
            return None
        tiers, receipt_id = marker.groups()
    else:
        # Previously recorded reminders carried the complete window in the command.
        marker = LEGACY_REMINDER_MARKER.search(text, start, end)
        if marker is None:
            return None
        window = LEGACY_REMINDER_WINDOW.search(text, start, marker.start())
        if window is None:
            return None
        tiers = marker[1]
        receipt_id = reminder_window_id(window[1])
    raw_levels = tiers.split(",")
    levels = {int(level) for level in raw_levels}
    if len(levels) != len(raw_levels):
        return None
    return receipt_id, levels


def snapshot(
    path: Path,
    *,
    include_previous: bool = True,
    minimum_used: int | None = None,
    expected_turn: str | None = None,
    expected_model: str | None = None,
    collect_reminder_receipts: bool = False,
) -> WindowSnapshot | None:
    """Probe the active segment only. Missing or ambiguous state fails closed."""
    if path.suffix == ".zst":
        return None
    try:
        with path.open("rb") as stream:
            header = _read_header(path, stream)
            if header is None:
                return None
            return _snapshot(
                stream, header, stream.seek(0, os.SEEK_END),
                include_previous=include_previous, minimum_used=minimum_used,
                expected_turn=expected_turn, expected_model=expected_model,
                collect_reminder_receipts=collect_reminder_receipts,
            )
    except (OSError, ValueError, RecursionError):
        return None


def _read_header(path: Path, stream: BinaryIO) -> _WindowHeader | None:
    header_raw = stream.readline(RECORD_BYTES + 1)
    if not header_raw.endswith(b"\n"):
        return None
    kind, header, _ = _record(header_raw, b"", False)
    first_owned = _positive(header.get("subagent_history_start_ordinal"))
    if kind != "session_meta" or (
        first_owned is None and header.get("forked_from_id") and not header.get("history_base")
    ):
        return None
    segment = blake2s(os.fsencode(path.name) + b"\0" + header_raw, digest_size=12).hexdigest()
    return _WindowHeader(len(header_raw), first_owned, segment, header.get("id"))


def reminder_snapshot(
    path: Path,
    checkpoint: str | None,
    *,
    minimum_used: int,
    expected_turn: str | None = None,
    expected_model: str | None = None,
) -> tuple[WindowSnapshot | None, str | None]:
    """Reuse a verified rollout prefix for asynchronous reminder checks."""
    if path.suffix == ".zst":
        return None, None
    try:
        with path.open("rb") as stream:
            stat = os.fstat(stream.fileno())
            header = _read_header(path, stream)
            if header is None or header.end > stat.st_size:
                return None, None
            previous = read_checkpoint(
                path, stream, stat, header.segment, header.end, checkpoint, SCAN_BYTES,
            )
            capture = _CheckpointCapture()
            options = {
                "include_previous": False, "minimum_used": minimum_used,
                "expected_turn": expected_turn, "expected_model": expected_model,
                "collect_reminder_receipts": True, "capture": capture,
            }
            if previous is not None:
                try:
                    state = _snapshot(stream, header, stat.st_size, checkpoint=previous, **options)
                except (ValueError, OSError, RecursionError):
                    previous = None
            if previous is None:
                state = _snapshot(stream, header, stat.st_size, **options)
            after = os.fstat(stream.fileno())
            if after.st_size < stat.st_size or (
                after.st_size == stat.st_size and after.st_mtime_ns != stat.st_mtime_ns
            ):
                return None, None
            retained = checkpoint if previous is not None else None
            if (
                state is None or capture.boundary is None
                or (previous is not None and previous.offset == stat.st_size)
            ):
                return state, retained
            encoded = write_checkpoint(
                path, stream, stat, header.segment, capture.boundary, state.current,
                state.received_reminder_levels, capture.signals, capture.turn_coverage,
            )
            return state, encoded if encoded is not None else retained
    except (OSError, ValueError, RecursionError):
        return None, None


def _snapshot(
    stream: BinaryIO,
    header: _WindowHeader,
    size: int,
    *,
    include_previous: bool,
    minimum_used: int | None,
    expected_turn: str | None,
    expected_model: str | None,
    collect_reminder_receipts: bool,
    checkpoint: ReminderCheckpoint | None = None,
    capture: _CheckpointCapture | None = None,
) -> WindowSnapshot | None:
    lower = checkpoint.offset if checkpoint is not None else max(header.end, size - SCAN_BYTES)
    at_start = lower == header.end
    segment = header.segment
    start_key = f"{segment}:start"
    current = previous = None
    compacted = False
    native = response = None
    latest_capacity = latest_model = None
    latest_turn = effective_model = None
    turn_capacities: dict[str, tuple[int, int]] = {}
    receipts: dict[str, set[int]] = {}
    replay_start = None
    boundary = header.end if at_start else None
    signals: dict[int, dict] = {}
    coverage = TurnCoverage()
    has_turnless_model = has_settings_model = False
    latest_turn_model_at = None
    omitted_turn_models = False
    lines = _reverse_lines(stream, size, lower, at_start or checkpoint is not None)
    if checkpoint is not None:
        # Reuse sparse records only when the physical suffix has no newer boundary.
        # A final empty replay entry also marks completion when there were no signals.
        lines = chain(
            lines, ((None, raw, b"", False) for raw in checkpoint.signals),
            ((None, b"", b"", False),),
        )
    for order, (offset, raw, trailer, clipped) in enumerate(lines):
        if offset is None:
            if replay_start is None and checkpoint is not None:
                replay_start = order
                coverage = checkpoint.turn_coverage
                # A new suffix can refer to any turn, including one whose metadata
                # was pruned. Verify those lookups against the bounded physical scan.
                if (
                    latest_turn is not None and effective_model is None
                    and coverage.may_hide_model(latest_turn)
                    or response is not None and response.turn is not None and (
                        response.model is None and coverage.may_hide_model(response.turn)
                        or response.capacity is None and response.turn not in turn_capacities
                        and coverage.may_hide_capacity(response.turn)
                    )
                ):
                    raise ValueError("checkpoint lacks turn evidence for the appended records")
            if not raw:
                break
        if not raw.strip():
            continue
        kind, payload, ordinal = _record(raw, trailer, clipped)
        first_owned_record = False
        first_owned = header.first_owned
        if offset is not None and first_owned is not None:
            if ordinal is None:
                return None
            if ordinal < first_owned:
                at_start = True
                if current is None:
                    boundary = offset
                break
            first_owned_record = ordinal == first_owned
            at_start = at_start or first_owned_record
            if first_owned_record and current is None:
                boundary = offset
        event = payload.get("type") if kind == "event_msg" else None
        if event is not None and not isinstance(event, str):
            raise ValueError("invalid rollout event")
        if offset is None and kind not in USAGE_KINDS and event not in REPLAY_EVENTS:
            raise ValueError("invalid checkpoint signal")
        if kind == "compacted" or event == "thread_rolled_back":
            fingerprint = blake2s(raw + trailer, digest_size=8).hexdigest()
            key = f"{segment}:{offset}:{fingerprint}"
            if current is not None:
                previous = key
                break
            current = key
            boundary = offset
            compacted = kind == "compacted"
            if not compacted or not include_previous:
                break
        if current is not None:
            if first_owned_record:
                break
            continue
        if (
            collect_reminder_receipts and kind == "response_item" and not clipped
            and b'"developer"' in raw[:PREFIX_BYTES]
            and b'"hooks.additional_context"' in raw
            and (REMINDER_MARKER_PREFIX.encode("ascii") in raw or b"[thread-memory:" in raw)
        ):
            try:
                candidate = payload or json.loads(raw)["payload"]
            except (ValueError, RecursionError):
                pass
            else:
                _collect_reminder_receipts(candidate, receipts)
        signal = None
        if kind == "token_usage_record" and response is None and native is None:
            response = _sample(kind, payload)
            if capture is not None and response is not None:
                signal = {
                    "usage": {"total_tokens": response.used},
                    "turn_id": response.turn, "model_context_window": response.capacity,
                }
        elif event == "token_count" and native is None:
            native = _sample(kind, payload)
            if (
                native is not None
                and minimum_used is not None
                and native.used < minimum_used
                and (response is None or response.used < minimum_used)
            ):
                return None
            if capture is not None and native is not None:
                signal = {"type": event, "info": {
                    "last_token_usage": {"total_tokens": native.used},
                    "model_context_window": native.capacity,
                }}
        elif event in TURN_START_EVENTS:
            capacity = _positive(payload.get("model_context_window"))
            turn = payload.get("turn_id")
            keep = capacity is not None and latest_capacity is None
            latest_capacity = latest_capacity or capacity
            if native is not None and native.capacity is None and capacity is not None:
                native.capacity = capacity
                keep = True
            if isinstance(turn, str) and turn:
                if latest_turn is None:
                    latest_turn = turn
                    keep = True
                if capacity is not None:
                    turn_capacities.setdefault(turn, (capacity, order))
            if capture is not None and keep:
                signal = {
                    "type": event, "turn_id": turn if isinstance(turn, str) else None,
                    "model_context_window": capacity,
                }
        elif kind == "turn_context":
            turn = payload.get("turn_id")
            keep = isinstance(turn, str) and bool(turn) and latest_turn is None
            if keep:
                latest_turn = turn
            model = payload.get("model")
            if isinstance(model, str) and model:
                keep = keep or latest_model is None
                latest_model = latest_model or model
                if turn is None or turn == latest_turn:
                    keep = keep or effective_model is None
                    effective_model = effective_model or model
                if turn is None and not has_turnless_model:
                    keep = has_turnless_model = True
                elif isinstance(turn, str) and turn != latest_turn:
                    omitted_turn_models = True
                elif isinstance(turn, str) and latest_turn_model_at is None:
                    keep = True
                    latest_turn_model_at = order
                for usage in (native, response):
                    if usage is not None and usage.model is None and (
                        usage.turn is None or usage.turn == turn
                    ):
                        usage.model = model
                        keep = True
            if capture is not None and keep:
                # A malformed non-string turn never identifies the active turn.
                signal = {
                    "turn_id": turn if turn is None or isinstance(turn, str) else False,
                    "model": model if isinstance(model, str) else None,
                }
        elif event == "thread_settings_applied":
            settings = payload.get("thread_settings")
            if isinstance(settings, dict) and payload.get("thread_id") in (None, header.thread_id):
                model = settings.get("model")
                if isinstance(model, str) and model:
                    keep = not has_settings_model or effective_model is None
                    has_settings_model = True
                    effective_model = effective_model or model
                    for usage in (native, response):
                        if usage is not None and usage.model is None:
                            usage.model = model
                            keep = True
                    if capture is not None and keep:
                        signal = {"type": event, "thread_settings": {"model": model}}
        if signal is not None:
            signals[order] = {"type": kind, "payload": signal}
        if first_owned_record:
            break
    marked_turn = latest_turn
    latest_turn = latest_turn or (response.turn if response is not None else None)
    if (
        expected_turn and latest_turn and expected_turn != latest_turn
        or expected_model and effective_model and expected_model != effective_model
    ):
        return None

    if current is None:
        if replay_start is not None and checkpoint is not None:
            current = checkpoint.window
            boundary = checkpoint.boundary
            receipts.setdefault(reminder_window_id(current), set()).update(checkpoint.receipts)
        elif at_start:
            current = start_key
        else:
            # A bounded tail cannot prove a boundary in the omitted prefix.
            return None
    elif compacted and include_previous and previous is None and at_start:
        previous = start_key

    if capture is not None:
        # Replay witnesses in their original order. Keep one more turn-start
        # witness for each current or selected response's capacity lookup.
        response_turn = response.turn if response is not None else None
        for turn in (marked_turn, response_turn):
            if turn is not None and turn in turn_capacities:
                capacity, order = turn_capacities[turn]
                signals.setdefault(order, {"type": "event_msg", "payload": {
                    "type": "task_started", "turn_id": turn, "model_context_window": capacity,
                }})
        capacity_at = turn_capacities.get(marked_turn, (None, None))[1] if marked_turn else None
        model_is_known = marked_turn is not None and (
            not coverage.may_hide_model(marked_turn)
            or latest_turn_model_at is not None and replay_start is not None and latest_turn_model_at < replay_start
        )
        capacity_is_known = marked_turn is not None and (
            not coverage.may_hide_capacity(marked_turn)
            or capacity_at is not None and replay_start is not None and capacity_at < replay_start
        )
        capture.boundary = boundary
        capture.signals = [signals[order] for order in sorted(signals)]
        capture.turn_coverage = TurnCoverage(
            model_turn=marked_turn if model_is_known else None,
            capacity_turn=marked_turn if capacity_is_known else None,
            omitted_models=coverage.omitted_models or omitted_turn_models,
            omitted_capacities=coverage.omitted_capacities or any(turn != marked_turn for turn in turn_capacities),
        )
    received = frozenset(receipts.get(reminder_window_id(current), ()))
    # A per-response record can land before PostToolUse runs. The native event
    # for the same response can land later, after in-flight tools finish.
    for usage in (response, native):
        if usage is None:
            continue
        if usage.capacity is None and usage.turn is not None:
            capacity = turn_capacities.get(usage.turn)
            if capacity is not None:
                usage.capacity = capacity[0]
        if _usable_sample(usage, effective_model or latest_model, latest_capacity):
            if minimum_used is not None and usage.used < minimum_used:
                return None
            return WindowSnapshot(current, previous, usage.used, usage.capacity, received)
    return WindowSnapshot(current, previous, None, None, received)
