"""Validate and encode the private reminder checkpoint for an append-only rollout."""

from dataclasses import asdict, dataclass
from hashlib import blake2s
import json
import os
from pathlib import Path
import re
from typing import BinaryIO


MAX_CHECKPOINT_CHARS = 65_536
ANCHOR_BYTES = 4_096
_WINDOW = re.compile(r"[0-9a-f]{24}:(?:start|([0-9]{1,20}):[0-9a-f]{16})\Z")


@dataclass(frozen=True)
class TurnCoverage:
    """Which turn-specific lookups are still exact after projecting old events."""

    model_turn: str | None = None
    capacity_turn: str | None = None
    omitted_models: bool = False
    omitted_capacities: bool = False

    def may_hide_model(self, turn: str) -> bool:
        return self.omitted_models and self.model_turn != turn

    def may_hide_capacity(self, turn: str) -> bool:
        return self.omitted_capacities and self.capacity_turn != turn


@dataclass(frozen=True)
class ReminderCheckpoint:
    offset: int
    boundary: int
    window: str
    receipts: frozenset[int]
    signals: tuple[bytes, ...]
    turn_coverage: TurnCoverage


def _identity(path: Path, stat: os.stat_result, segment: str) -> list[str]:
    return [os.path.abspath(path), str(stat.st_dev), str(stat.st_ino), segment]


def _anchor(stream: BinaryIO, offset: int) -> str | None:
    width = min(offset, ANCHOR_BYTES)
    stream.seek(offset - width)
    tail = stream.read(width)
    if len(tail) == width and tail.endswith(b"\n"):
        return blake2s(tail, digest_size=16).hexdigest()
    return None


def read_checkpoint(
    path: Path, stream: BinaryIO, stat: os.stat_result, segment: str,
    header_end: int, raw: str | None, max_append: int,
) -> ReminderCheckpoint | None:
    if not isinstance(raw, str) or not raw or len(raw) > MAX_CHECKPOINT_CHARS or not stat.st_ino:
        return None
    try:
        data = json.loads(raw)
        if not isinstance(data, dict) or data.get("version") != 2:
            return None
        if data.get("file") != _identity(path, stat, segment):
            return None
        offset = data.get("offset")
        boundary = data.get("boundary")
        mtime = data.get("mtime_ns")
        if (
            type(offset) is not int or not header_end <= offset <= stat.st_size
            or type(boundary) is not int or not header_end <= boundary <= offset
            or (stat.st_size - max_append > header_end and boundary <= stat.st_size - max_append)
            or type(mtime) is not int
            or (offset == stat.st_size and mtime != stat.st_mtime_ns)
        ):
            return None
        window = data.get("window")
        if not isinstance(window, str) or not window.startswith(f"{segment}:"):
            return None
        match = _WINDOW.fullmatch(window)
        if match is None or (match[1] is not None and (int(match[1]) != boundary or boundary == offset)):
            return None
        receipts = data.get("receipts")
        signals = data.get("signals")
        coverage = data.get("turn_coverage")
        if (
            not isinstance(receipts, list) or len(receipts) > 101
            or any(type(level) is not int or not 0 <= level <= 100 for level in receipts)
            or not isinstance(signals, list)
            or any(not isinstance(signal, dict) for signal in signals)
            or not isinstance(coverage, dict)
            or coverage.keys() != {"model_turn", "capacity_turn", "omitted_models", "omitted_capacities"}
            or any(coverage[key] is not None and not isinstance(coverage[key], str)
                   for key in ("model_turn", "capacity_turn"))
            or any(type(coverage[key]) is not bool for key in ("omitted_models", "omitted_capacities"))
        ):
            return None
        anchor = _anchor(stream, offset)
        if anchor is None or anchor != data.get("anchor"):
            return None
        encoded = tuple(json.dumps(signal, separators=(",", ":")).encode() for signal in signals)
        return ReminderCheckpoint(offset, boundary, window, frozenset(receipts), encoded, TurnCoverage(**coverage))
    except (ValueError, OSError, RecursionError):
        return None


def write_checkpoint(
    path: Path, stream: BinaryIO, stat: os.stat_result, segment: str,
    boundary: int, window: str, receipts: frozenset[int], signals: list[dict], turn_coverage: TurnCoverage,
) -> str | None:
    if not stat.st_ino:
        return None
    anchor = _anchor(stream, stat.st_size)
    if anchor is None:
        return None
    after = os.fstat(stream.fileno())
    if (after.st_size, after.st_mtime_ns) != (stat.st_size, stat.st_mtime_ns):
        return None
    raw = json.dumps({
        "version": 2,
        "file": _identity(path, stat, segment),
        "offset": stat.st_size,
        "boundary": boundary,
        "mtime_ns": stat.st_mtime_ns,
        "anchor": anchor,
        "window": window,
        "receipts": sorted(receipts),
        "signals": signals,
        "turn_coverage": asdict(turn_coverage),
    }, separators=(",", ":"))
    return raw if len(raw) <= MAX_CHECKPOINT_CHARS else None
