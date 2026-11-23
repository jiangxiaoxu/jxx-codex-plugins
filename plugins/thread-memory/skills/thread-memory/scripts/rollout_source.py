"""Locate local Codex rollouts and stream their recorded lineage."""

from __future__ import annotations

import hashlib
import io
import json
import os
import re
import sqlite3
from collections.abc import Collection, Iterator
from contextlib import closing, contextmanager
from dataclasses import dataclass, field
from pathlib import Path
from typing import BinaryIO
from uuid import UUID


@dataclass
class ScanDiagnostics:
    salvage: bool = False
    issues: dict[tuple[Path, int], dict] = field(default_factory=dict)

    def note(self, path: Path, line: int, offset: int, reason: str) -> None:
        self.issues[(path, line)] = {
            "path": str(path),
            "line": line,
            "byte_offset": offset,
            "reason": reason,
        }


@dataclass(frozen=True)
class Segment:
    path: Path
    metadata: dict
    end_ordinal: int | None = None
    end_offset: int | None = None
    diagnostics: ScanDiagnostics | None = None


class RolloutDataError(ValueError):
    def __init__(self, message: str, path: Path, line: int | None = None) -> None:
        self.message = message
        self.path = path
        self.line = line
        location = str(path) if line is None else f"{path}:{line}"
        super().__init__(f"{message} at {location}")


def _invalid_json(
    path: Path, line: int, error: Exception, *, message: str = "invalid JSONL"
) -> RolloutDataError:
    if isinstance(error, json.JSONDecodeError):
        message += f" (column {error.colno}: {error.msg})"
    elif isinstance(error, UnicodeDecodeError):
        message += " (invalid Unicode encoding)"
    elif isinstance(error, RecursionError):
        message += " (nesting is too deep)"
    return RolloutDataError(message, path, line)


def checkpoint_window(previous: int, payload: dict) -> int:
    value = payload.get("window_number")
    return value if type(value) is int and value >= 0 else previous + 1


class _ZstdRolloutReader(io.RawIOBase):
    """Stream concatenated frames and distinguish a truncated frame from EOF."""

    def __init__(self, source: BinaryIO, decompressor) -> None:
        super().__init__()
        self._source = source
        self._decompressor = decompressor
        self._frame = None
        self._unused = b""
        self._output = memoryview(b"")

    def readable(self) -> bool:
        return True

    def readinto(self, destination) -> int:
        if not destination:
            return 0
        while not self._output:
            # decompress() returns all output for this input. Small reads bound
            # memory when even a few bytes can encode a 128 KiB RLE block.
            data = self._unused or self._source.read(1024)
            if not data:
                if self._frame is not None:
                    raise EOFError("truncated Zstandard frame")
                return 0
            if self._frame is None:
                self._frame = self._decompressor.decompressobj()
            self._output = memoryview(self._frame.decompress(data))
            self._unused = self._frame.unused_data
            if self._frame.eof:
                self._frame = None
        size = min(len(destination), len(self._output))
        destination[:size] = self._output[:size]
        self._output = self._output[size:]
        return size


@contextmanager
def open_rollout(path: Path) -> Iterator[BinaryIO]:
    if path.suffix != ".zst":
        with path.open("rb") as stream:
            yield stream
        return
    try:
        import zstandard
    except ImportError as error:
        raise ValueError("reading .jsonl.zst requires the zstandard package") from error
    try:
        with path.open("rb") as source:
            reader = _ZstdRolloutReader(source, zstandard.ZstdDecompressor())
            with io.BufferedReader(reader) as stream:
                yield stream
    except (zstandard.ZstdError, EOFError) as error:
        raise RolloutDataError(
            f"cannot decompress Zstandard rollout ({error})", path
        ) from error


def available_path(path: Path) -> Path | None:
    plain = path.with_suffix("") if path.suffix == ".zst" else path
    for candidate in (plain, Path(f"{plain}.zst")):
        if candidate.is_file():
            return candidate.resolve()
    return None


def rollout_id(path: Path) -> str | None:
    name = path.name.removesuffix(".zst").removesuffix(".jsonl")
    if not name.startswith("rollout-"):
        return None
    try:
        return str(UUID(name[-36:]))
    except ValueError:
        return None


def active_state_database(home: Path) -> Path:
    """Resolve the native local state index from persisted home settings."""
    try:
        with (home / "config.toml").open("rb") as config_file:
            try:
                import tomllib
            except ModuleNotFoundError:
                try:
                    import tomli as tomllib
                except ModuleNotFoundError as error:
                    raise ValueError("Reading Codex configuration on Python 3.10 requires tomli.") from error
            config = tomllib.load(config_file)
    except FileNotFoundError:
        config = {}

    store = config.get("experimental_thread_store", {"type": "local"})
    if not isinstance(store, dict) or store.get("type") != "local":
        raise ValueError("The Codex thread store is not local.")
    configured = config.get("sqlite_home")
    if configured is not None:
        if not isinstance(configured, str) or not configured:
            raise ValueError("The configured Codex SQLite path is invalid.")
        path = Path(configured)
        root = home / (path.expanduser() if path.parts[:1] == ("~",) else path)
    elif configured := os.environ.get("CODEX_SQLITE_HOME", "").strip():
        path = Path(configured)
        root = path.expanduser() if path.parts[:1] == ("~",) else path
        if not root.is_absolute():
            raise ValueError("CODEX_SQLITE_HOME needs an absolute path to locate the Codex index.")
    else:
        root = home
    return root / "state_5.sqlite"


def indexed_path(home: Path, thread: str) -> Path | None:
    try:
        database = active_state_database(home)
        with closing(sqlite3.connect(f"{database.absolute().as_uri()}?mode=ro", uri=True, timeout=0.2)) as conn:
            columns = {column[1] for column in conn.execute("PRAGMA table_info(threads)")}
            mode_column = "history_mode" if "history_mode" in columns else "'legacy'"
            row = conn.execute(
                f"SELECT rollout_path, {mode_column} FROM threads WHERE id = ?", (thread,)
            ).fetchone()
    except (OSError, ValueError, sqlite3.Error):
        return None
    if row is None:
        return None

    indexed, mode = row
    authoritative = mode == "paginated"
    if not isinstance(indexed, str) or not indexed:
        if authoritative:
            raise RolloutDataError(f"invalid indexed rollout path for paginated thread {thread}", database)
        return None

    recorded = Path(indexed)
    try:
        path = available_path(recorded)
        if path is None:
            raise RolloutDataError("indexed rollout is missing", recorded)
        if metadata(path).get("id") != thread:
            raise RolloutDataError("indexed rollout belongs to a different thread", path, 1)
    except RolloutDataError:
        if authoritative:
            raise
        return None
    except (OSError, ValueError) as error:
        if authoritative:
            raise RolloutDataError(f"cannot open indexed rollout ({error})", recorded) from error
        return None
    return path


def find_rollout(home: Path, identifier: str, *, thread: bool = False) -> Path | None:
    if thread and (path := indexed_path(home, identifier)):
        return path
    matches = set()
    for directory in (home / "sessions", home / "archived_sessions"):
        patterns = (f"rollout-*{identifier}.jsonl*",)
        if thread:
            patterns += (f"rollout-*-{identifier}_*.jsonl*",)
        for pattern in patterns:
            for candidate in directory.rglob(pattern):
                if not candidate.name.endswith((".jsonl", ".jsonl.zst")):
                    continue
                candidate_id = rollout_id(candidate)
                if candidate_id is None:
                    continue
                plain = candidate.name.removesuffix(".zst").removesuffix(".jsonl")
                owner = plain[28:].split("_", 1)[0]  # Skip the prefix and timestamp.
                matches_id = (
                    owner == identifier if thread else candidate_id == identifier
                )
                if matches_id and (path := available_path(candidate)):
                    matches.add(path)
    if thread and matches:
        # A revert keeps the owning thread ID and assigns a new rollout ID.
        return max(
            matches,
            key=lambda path: (path.name[8:27], rollout_id(path) or "", str(path)),
        )
    if len(matches) > 1:
        raise ValueError(
            f"multiple local rollouts match {identifier}; specify --rollout or --previous"
        )
    return next(iter(matches), None)


def metadata(path: Path) -> dict:
    with open_rollout(path) as stream:
        raw = stream.readline()
    try:
        row = json.loads(raw)
    except (ValueError, RecursionError) as error:
        raise _invalid_json(
            path, 1, error, message="invalid session_meta JSON"
        ) from error
    if not _valid_envelope(row) or row["type"] != "session_meta":
        raise RolloutDataError("expected a session_meta record", path, 1)
    header = row["payload"]
    for name in ("id", "session_id", "forked_from_id"):
        value = header.get(name)
        if value is not None and not isinstance(value, str):
            raise RolloutDataError(f"session_meta {name} must be a string", path, 1)
    return header


def resolve_segments(
    path: Path | None,
    thread: str | None,
    home: Path,
    previous: list[Path],
    *,
    diagnostics: ScanDiagnostics | None = None,
) -> tuple[list[Segment], list[str]]:
    by_thread = path is None
    if by_thread:
        identifier = thread or os.environ.get("CODEX_THREAD_ID")
        if not identifier:
            raise ValueError("provide --thread or --rollout outside a Codex thread")
        try:
            identifier = str(UUID(identifier))
        except ValueError as error:
            option = "--thread" if thread is not None else "CODEX_THREAD_ID"
            raise ValueError(f"{option} must be a thread UUID") from error
        path = find_rollout(home, identifier, thread=True)
        if path is None:
            raise FileNotFoundError(f"no local rollout found for thread {identifier}")
        thread = identifier
    else:
        candidate = path.resolve() if path.is_file() else available_path(path)
        if candidate is None:
            raise FileNotFoundError(path)
        path = candidate

    overrides = {}
    for candidate in previous:
        identifier = rollout_id(candidate)
        if not identifier or identifier in overrides:
            raise ValueError(
                f"expected a distinct Codex rollout filename for --previous: {candidate}"
            )
        existing = (
            candidate.resolve() if candidate.is_file() else available_path(candidate)
        )
        if existing is None:
            raise FileNotFoundError(candidate)
        overrides[identifier] = existing

    header = metadata(path)
    if (
        thread is not None
        and thread != header.get("id")
        and (by_thread or thread != header.get("session_id"))
    ):
        raise ValueError("thread identity does not match the rollout header")
    segments = [Segment(path, header, diagnostics=diagnostics)]
    visited = {path}
    gaps = []
    while (base := header.get("history_base")) is not None:
        if not isinstance(base, dict):
            raise RolloutDataError("history_base must be an object", path, 1)
        base_thread = base.get("thread_id")
        try:
            identifier = str(UUID(base_thread if isinstance(base_thread, str) else ""))
        except ValueError as error:
            raise RolloutDataError(
                "history_base.thread_id must be a UUID", path, 1
            ) from error
        ordinal, offset = base.get("end_ordinal_exclusive"), base.get("end_byte_offset")
        if (
            type(ordinal) is not int
            or type(offset) is not int
            or min(ordinal, offset) <= 0
        ):
            raise RolloutDataError(
                "history_base cutoff requires positive end_ordinal_exclusive and end_byte_offset",
                path,
                1,
            )
        path = overrides.pop(identifier, None) or find_rollout(home, identifier)
        if path is None:
            gaps.append(identifier)
            break
        if path in visited:
            raise RolloutDataError("rollout lineage cycle", path, 1)
        visited.add(path)
        header = metadata(path)
        segments.append(Segment(path, header, ordinal, offset, diagnostics))
    if overrides:
        raise ValueError(
            "unreferenced --previous rollout(s): "
            + ", ".join(path.name for path in overrides.values())
        )
    segments.reverse()
    return segments, gaps


CANONICAL_HEADER = re.compile(
    rb'\{"timestamp":"([0-9TZ:+.\-]{1,40})"'
    rb'(?:,"ordinal":(0|[1-9][0-9]{0,19}))?,'
    rb'"type":"([a-z0-9_]{1,64})","payload":\{'
)
CANONICAL_SUBTYPE = re.compile(rb'"type":"([a-z0-9_]{1,64})"[,}]')
JSON_DELIMITER = re.compile(rb'["{}\[\]]')
CANONICAL_TYPES = frozenset(
    {
        b"session_meta",
        b"dynamic_tools_updated",
        b"response_item",
        b"inter_agent_communication",
        b"inter_agent_communication_metadata",
        b"compacted",
        b"turn_context",
        b"token_usage_record",
        b"world_state",
        b"security_risk_score",
        b"retained_context",
        b"event_msg",
        b"realtime_item",
    }
)


def _closes_envelope(raw: bytes, start: int) -> bool:
    """Check that the recognized payload and envelope reach their own closing braces."""
    end = len(raw) - (2 if raw.endswith(b"\r\n") else 1)
    closing = [ord("}"), ord("}")]
    while delimiter := JSON_DELIMITER.search(raw, start, end):
        position = delimiter.start()
        symbol = raw[position]
        start = position + 1
        if symbol == ord('"'):
            # An unescaped quote ends the string. Jump over long strings without
            # repeatedly examining the bytes of a Base64 image.
            while (quote := raw.find(b'"', start, end)) != -1:
                start = quote + 1
                preceding = quote - 1
                while raw[preceding] == ord("\\"):
                    preceding -= 1
                if (quote - preceding) % 2 == 1:
                    break
            else:
                return False
        elif symbol == ord("{"):
            closing.append(ord("}"))
        elif symbol == ord("["):
            closing.append(ord("]"))
        elif symbol != closing.pop():
            return False
        elif not closing:
            return start == end
    return False


def _projected_record(
    raw: bytes,
    keep_payload: set[str] | None,
    payload_types: dict[bytes, set[str]],
    preserve_response_metadata: bool,
) -> dict | None:
    # Codex serializes these envelope fields before the payload. Keep the full
    # decoder for legacy layouts and unterminated records.
    header = CANONICAL_HEADER.match(raw)
    if header is None or not raw.endswith((b"}}\n", b"}}\r\n")):
        return _decoded_record(raw)
    timestamp, ordinal, kind = header.groups()
    if kind not in CANONICAL_TYPES or (
        preserve_response_metadata and kind == b"response_item"
    ):
        return _decoded_record(raw)
    record_type = kind.decode("ascii")
    payload = {}
    types = payload_types.get(kind)
    if types is not None:
        subtype = CANONICAL_SUBTYPE.match(raw, header.end())
        if subtype is None:
            return _decoded_record(raw)
        payload_type = subtype[1].decode("ascii")
        if payload_type in types:
            return _decoded_record(raw)
        payload["type"] = payload_type
    elif keep_payload is None or record_type in keep_payload:
        return _decoded_record(raw)
    if not _closes_envelope(raw, header.end()):
        return _decoded_record(raw)

    row = {
        "timestamp": timestamp.decode("ascii"),
        "type": record_type,
        "payload": payload,
    }
    if ordinal is not None:
        row["ordinal"] = int(ordinal)
    return row


def _reject_json_constant(value: str) -> None:
    raise ValueError(f"invalid JSON constant {value}")


def _valid_envelope(row: object) -> bool:
    return (
        isinstance(row, dict)
        and isinstance(row.get("type"), str)
        and bool(row["type"])
        and isinstance(row.get("payload"), dict)
        and isinstance(row.get("timestamp", ""), str)
        and (row.get("metadata") is None or isinstance(row["metadata"], dict))
    )


def _valid_record(row: object) -> bool:
    if not _valid_envelope(row):
        return False
    payload = row["payload"]
    kind = payload.get("type")
    if row["type"] in ("event_msg", "response_item") and not (
        kind is None or isinstance(kind, str)
    ):
        return False
    if row["type"] == "event_msg" and kind == "item_completed":
        item = payload.get("item")
        if not isinstance(item, dict):
            return False
        if item.get("type") is not None and not isinstance(item["type"], str):
            return False
    return True


def _decoded_record(raw: bytes) -> dict | None:
    row = json.loads(raw)
    return row if _valid_record(row) else None


def _valid_chat_annotations(payload: dict) -> bool:
    annotations = payload.get("internal_chat_message_metadata_passthrough")
    if annotations is None:
        return True
    if not isinstance(annotations, dict):
        return False
    kinds = annotations.get("content_item_kinds")
    return kinds is None or (
        isinstance(kinds, list) and all(isinstance(kind, str) for kind in kinds)
    )


def _valid_response_item(item: object) -> bool:
    if not isinstance(item, dict) or not _valid_chat_annotations(item):
        return False
    kind = item.get("type")
    if kind == "message":
        parts = item.get("content")
        if not isinstance(item.get("role"), str) or not isinstance(parts, list):
            return False
    elif kind in ("function_call_output", "custom_tool_call_output"):
        parts = item.get("output")
        if not isinstance(parts, list):
            return True
    else:
        return kind is None or isinstance(kind, str)

    for part in parts:
        if not isinstance(part, dict):
            return False
        part_type = part.get("type")
        if part_type in ("input_text", "output_text") and not isinstance(
            part.get("text"), str
        ):
            return False
        if part_type == "input_image" and any(
            part.get(key) is not None and not isinstance(part[key], str)
            for key in ("image_url", "file_id")
        ):
            return False
    return True


def _valid_salvage_record(row: object) -> bool:
    if not _valid_record(row):
        return False
    kind = row["type"]
    payload = row["payload"]
    if kind == "response_item":
        return _valid_response_item(payload)
    if not _valid_chat_annotations(payload):
        return False
    if kind == "compacted":
        history = payload.get("replacement_history")
        if history is not None and not (
            isinstance(history, list)
            and all(_valid_response_item(item) for item in history)
        ):
            return False
        metadata = payload.get("replacement_history_metadata")
        return metadata is None or (
            isinstance(metadata, list)
            and all(entry is None or isinstance(entry, dict) for entry in metadata)
        )
    if kind in ("session_meta", "turn_context"):
        cwd = payload.get("cwd")
        return cwd is None or isinstance(cwd, str)
    if kind == "event_msg":
        event = payload.get("type")
        if event == "thread_rolled_back":
            count = payload.get("num_turns")
            return type(count) is int and count >= 0
        if event == "user_message":
            return isinstance(payload.get("local_images", []), list)
        if event == "item_completed":
            item = payload["item"]
            if item.get("type") == "UserMessage":
                content = item.get("content", [])
                return isinstance(content, list) and all(
                    isinstance(part, dict) for part in content
                )
            if (
                item.get("type") == "Extension"
                and item.get("kind") == "image_gen.generation"
            ):
                references = item.get("inputImages")
                return references is None or isinstance(references, list)
            if item.get("type") == "AgentMessage" and item.get("delivery") == "async":
                content = item.get("content")
                return isinstance(content, list) and all(
                    isinstance(part, dict)
                    and (
                        part.get("type") != "Text" or isinstance(part.get("text"), str)
                    )
                    for part in content
                )
        if event == "agent_message" and payload.get("delivery") == "async":
            return isinstance(payload.get("message"), str)
    return True


def _salvaged_record(
    raw: bytes,
    path: Path,
    line: int,
    offset: int,
    diagnostics: ScanDiagnostics,
    *,
    allow_partial_tail: bool,
) -> dict | None:
    try:
        row = json.loads(raw.decode("utf-8-sig"), parse_constant=_reject_json_constant)
    except (ValueError, RecursionError):
        reason = (
            "partial_tail"
            if allow_partial_tail and not raw.endswith(b"\n")
            else "invalid_json"
        )
    else:
        if _valid_salvage_record(row):
            return row
        reason = "invalid_record"
    diagnostics.note(path, line, offset, reason)
    return None


def record_revision(raw: bytes) -> str:
    """Fingerprint one wire record regardless of its JSONL line ending."""
    end = len(raw)
    if raw.endswith(b"\n"):
        end -= 1
    if end and raw[end - 1] == 13:
        end -= 1
    return hashlib.blake2b(
        memoryview(raw)[:end], digest_size=16, person=b"rollout-row-v1"
    ).hexdigest()


def records(
    segment: Segment,
    *,
    keep_payload: set[str] | None = None,
    event_types: set[str] | None = None,
    response_types: set[str] | None = None,
    full_lines: Collection[int] | None = None,
    revision_lines: Collection[int] | None = None,
    defer_revision: bool = False,
    start: tuple[int, int] | None = None,
) -> Iterator[tuple[Path, int, dict]]:
    """Read physical records from an optional cursor found by an earlier scan.

    With a payload filter, decode only the requested canonical payloads.
    Legacy layouts and explicitly requested physical lines are decoded in full.
    Only revision_lines receive a wire record fingerprint. Other records can
    carry their raw bytes for a downstream reader to fingerprint on demand.
    """
    line, offset = start if start is not None else (0, 0)
    if offset and segment.path.suffix == ".zst":
        raise ValueError("record cursors require an uncompressed rollout")
    remaining = None if segment.end_offset is None else segment.end_offset - offset
    if start is not None and remaining is not None:
        if remaining == 0:
            return
        if remaining < 0:
            raise ValueError(
                f"record cursor is beyond history_base cutoff in {segment.path.name}"
            )

    payload_types = {}
    if event_types is not None:
        payload_types[b"event_msg"] = event_types
    if response_types is not None:
        payload_types[b"response_item"] = response_types
    projected = keep_payload is not None or bool(payload_types)
    diagnostics = segment.diagnostics
    salvage = diagnostics is not None and diagnostics.salvage
    provenance_boundary = segment.metadata.get("subagent_history_start_ordinal")
    preserve_response_metadata = (
        bool(segment.metadata.get("forked_from_id"))
        and not segment.metadata.get("history_base")
        and not (type(provenance_boundary) is int and provenance_boundary > 0)
    )
    last_ordinal = None
    gap = False
    with open_rollout(segment.path) as stream:
        if offset:
            stream.seek(offset)
        while remaining is None or remaining > 0:
            raw = stream.readline() if remaining is None else stream.readline(remaining)
            if not raw:
                break
            line += 1
            row_offset = offset
            offset += len(raw)
            if remaining is not None:
                remaining -= len(raw)
            if raw.isspace():
                continue
            with_revision = revision_lines is not None and line in revision_lines
            if salvage:
                row = _salvaged_record(
                    raw,
                    segment.path,
                    line,
                    row_offset,
                    diagnostics,
                    allow_partial_tail=remaining is None,
                )
                if row is None:
                    gap = True
                    continue
            else:
                try:
                    if (
                        projected
                        and not with_revision
                        and (full_lines is None or line not in full_lines)
                    ):
                        row = _projected_record(
                            raw, keep_payload, payload_types, preserve_response_metadata
                        )
                    else:
                        row = _decoded_record(raw)
                except (ValueError, RecursionError) as error:
                    if remaining is None and not raw.endswith(b"\n"):
                        if diagnostics is not None:
                            diagnostics.note(
                                segment.path, line, row_offset, "partial_tail"
                            )
                        break  # A live rollout may still be appending its last record.
                    raise _invalid_json(segment.path, line, error) from error
                if row is None:
                    raise RolloutDataError(
                        "invalid JSONL record structure", segment.path, line
                    )
            if segment.end_ordinal is not None:
                last_ordinal = row.get("ordinal")
                if (
                    not raw.endswith(b"\n")
                    or type(last_ordinal) is not int
                    or last_ordinal >= segment.end_ordinal
                ):
                    raise RolloutDataError(
                        "history_base cutoff crosses a record", segment.path, line
                    )
            row["_rollout_offset"] = row_offset
            row["_rollout_next_offset"] = offset if raw.endswith(b"\n") else None
            if with_revision:
                row["_rollout_revision"] = record_revision(raw)
            elif defer_revision:
                row["_rollout_revision_source"] = raw
            if gap:
                row["_rollout_gap"] = True
                gap = False
            yield segment.path, line, row
    if segment.end_ordinal is not None and (
        gap or remaining != 0 or last_ordinal != segment.end_ordinal - 1
    ):
        raise RolloutDataError(
            "history_base cutoff does not match the rollout", segment.path
        )


def selected_rows(
    path: Path,
    lines: set[int],
    *,
    offsets: dict[int, int] | None = None,
    diagnostics: ScanDiagnostics | None = None,
) -> Iterator[tuple[int, dict]]:
    if not lines:
        return
    end = max(lines)

    def decode(raw: bytes, line: int, offset: int) -> dict | None:
        if diagnostics is not None and diagnostics.salvage:
            return _salvaged_record(
                raw, path, line, offset, diagnostics, allow_partial_tail=True
            )
        try:
            row = _decoded_record(raw)
        except (ValueError, RecursionError) as error:
            raise _invalid_json(path, line, error) from error
        if row is None:
            raise RolloutDataError("invalid JSONL record structure", path, line)
        return row

    with open_rollout(path) as stream:
        if path.suffix != ".zst" and offsets is not None and lines <= offsets.keys():
            for line in sorted(lines):
                stream.seek(offsets[line])
                row = decode(stream.readline(), line, offsets[line])
                if row is not None:
                    yield line, row
            return
        offset = 0
        for line, raw in enumerate(stream, 1):
            if line in lines:
                row = decode(raw, line, offset)
                if row is not None:
                    yield line, row
            if line >= end:
                break
            offset += len(raw)
