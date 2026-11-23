"""Rebuildable metadata for seeking scoped records in plain rollouts."""

from __future__ import annotations

import os
import sqlite3
from collections.abc import Collection, Iterator
from contextlib import ExitStack, closing, contextmanager
from dataclasses import dataclass, replace
from datetime import datetime, timedelta, timezone
from hashlib import blake2b
from pathlib import Path
from typing import BinaryIO
from uuid import UUID

from rollout_scope import AnnotationState, annotate_rows, instant
from rollout_source import Segment, _decoded_record, rollout_id


_VERSION = 1
_ANCHOR_BYTES = 4096
_BATCH_ROWS = 1000
_EPOCH = datetime(1970, 1, 1, tzinfo=timezone.utc)
_MICROSECOND = timedelta(microseconds=1)
_SCHEMA = (
    """
    CREATE TABLE rollout_files (
        id INTEGER PRIMARY KEY,
        path TEXT NOT NULL UNIQUE,
        owner_thread_id TEXT NOT NULL,
        device TEXT NOT NULL,
        inode TEXT NOT NULL,
        size INTEGER NOT NULL,
        mtime_ns TEXT NOT NULL,
        prefix BLOB NOT NULL,
        tail BLOB NOT NULL,
        last_line INTEGER NOT NULL,
        state_line INTEGER NOT NULL
    )
    """,
    """
    CREATE INDEX rollout_files_owner ON rollout_files (owner_thread_id)
    """,
    """
    CREATE TABLE annotation_states (
        rollout INTEGER NOT NULL REFERENCES rollout_files (id) ON DELETE CASCADE,
        line INTEGER NOT NULL,
        cwd TEXT,
        active_turn TEXT,
        in_prefix INTEGER NOT NULL,
        PRIMARY KEY (rollout, line)
    ) WITHOUT ROWID
    """,
    """
    CREATE TABLE record_locations (
        rollout INTEGER NOT NULL REFERENCES rollout_files (id) ON DELETE CASCADE,
        line INTEGER NOT NULL,
        offset INTEGER NOT NULL,
        length INTEGER NOT NULL,
        timestamp_us INTEGER,
        is_checkpoint INTEGER NOT NULL,
        window_number TEXT,
        state_line INTEGER NOT NULL,
        PRIMARY KEY (rollout, line)
    ) WITHOUT ROWID
    """,
    """
    CREATE INDEX locations_time ON record_locations (rollout, timestamp_us, line)
    WHERE timestamp_us IS NOT NULL
    """,
    """
    CREATE INDEX locations_checkpoints ON record_locations (rollout, line)
    WHERE is_checkpoint = 1
    """,
)
_UNAVAILABLE = (
    OSError, sqlite3.Error, ValueError, TypeError, AttributeError, OverflowError,
    RecursionError,
)


class RolloutIndexUnavailable(RuntimeError):
    """The optional index cannot safely provide the current query."""


@dataclass(frozen=True)
class _FileSeal:
    device: str
    inode: str
    size: int
    mtime_ns: str
    prefix: bytes
    tail: bytes


@dataclass(frozen=True)
class _IndexPosition:
    key: int
    seal: _FileSeal
    last_line: int
    state_line: int
    state: AnnotationState


def _timestamp_us(timestamp: object) -> int | None:
    if isinstance(timestamp, str):
        try:
            return (instant(timestamp) - _EPOCH) // _MICROSECOND
        except ValueError:
            pass
    return None


def _file_stat(path: Path, stream: BinaryIO) -> os.stat_result:
    status = os.fstat(stream.fileno())
    if not status.st_ino or not os.path.samestat(status, path.stat()):
        raise RolloutIndexUnavailable("rollout file was replaced")
    return status


def _read_at(stream: BinaryIO, offset: int, size: int) -> bytes:
    stream.seek(offset)
    raw = stream.read(size)
    if len(raw) != size:
        raise RolloutIndexUnavailable("rollout file was shortened")
    return raw


def _anchors(stream: BinaryIO, size: int) -> tuple[bytes, bytes] | None:
    if size <= 0:
        return None
    # The reader may still hold bytes from before an in-place file change.
    stream.seek(0, os.SEEK_END)
    width = min(size, _ANCHOR_BYTES)
    tail = _read_at(stream, size - width, width)
    if not tail.endswith(b"\n"):
        return None
    prefix = tail if size == width else _read_at(stream, 0, width)
    return blake2b(prefix, digest_size=16).digest(), blake2b(tail, digest_size=16).digest()


def _file_seal(segment: Segment, stream: BinaryIO) -> _FileSeal:
    status = _file_stat(segment.path, stream)
    anchors = _anchors(stream, status.st_size)
    if anchors is None:
        raise RolloutIndexUnavailable("rollout ends with an unterminated record")
    prefix, tail = anchors
    stream.seek(0)
    header = _decoded_record(stream.readline(status.st_size))
    if (
        header is None
        or header["type"] != "session_meta"
        or header["payload"] != segment.metadata
    ):
        raise RolloutIndexUnavailable("rollout session metadata changed")
    return _FileSeal(
        str(status.st_dev), str(status.st_ino), status.st_size,
        str(status.st_mtime_ns), prefix, tail,
    )


def _matches_prefix(path: Path, stream: BinaryIO, seal: _FileSeal) -> bool:
    status = _file_stat(path, stream)
    if (
        (str(status.st_dev), str(status.st_ino)) != (seal.device, seal.inode)
        or status.st_size < seal.size
        or (status.st_size == seal.size and str(status.st_mtime_ns) != seal.mtime_ns)
    ):
        return False
    return _anchors(stream, seal.size) == (seal.prefix, seal.tail)


def _read_position(connection: sqlite3.Connection, path: Path) -> _IndexPosition | None:
    row = connection.execute(
        """
        SELECT f.id, f.device, f.inode, f.size, f.mtime_ns, f.prefix, f.tail,
            f.last_line, f.state_line, s.cwd, s.active_turn, s.in_prefix
        FROM rollout_files AS f
        JOIN annotation_states AS s ON s.rollout = f.id AND s.line = f.state_line
        WHERE f.path = ?
        """,
        (str(path),),
    ).fetchone()
    if row is None:
        return None
    key, device, inode, size, mtime, prefix, tail, line, state_line, cwd, turn, copied = row
    return _IndexPosition(
        key, _FileSeal(device, inode, size, mtime, prefix, tail), line, state_line,
        AnnotationState(cwd, turn, bool(copied)),
    )


def _trailing_blank_lines(stream: BinaryIO, offset: int, stop: int) -> int:
    count = 0
    while offset < stop:
        raw = _read_at(stream, offset, min(stop - offset, 64 * 1024))
        if not raw.isspace():
            raise RolloutIndexUnavailable("rollout changed during indexing")
        count += raw.count(b"\n")
        offset += len(raw)
    return count


def _record_state(
    connection: sqlite3.Connection, key: int, line: int, state: AnnotationState
) -> None:
    if any(value is not None and not isinstance(value, str) for value in (
        state.cwd, state.active_turn,
    )):
        raise RolloutIndexUnavailable("rollout has invalid annotation state")
    connection.execute(
        "INSERT INTO annotation_states VALUES (?, ?, ?, ?, ?)",
        (key, line, state.cwd, state.active_turn, state.in_prefix),
    )


def _verified_owner(segment: Segment) -> str | None:
    # Reverted files keep the owning thread UUID before the physical rollout UUID.
    owner = segment.path.stem[28:].split("_", 1)[0]
    if segment.metadata.get("id") == owner and rollout_id(segment.path) is not None:
        try:
            return str(UUID(owner))
        except ValueError:
            pass
    return None


def _refresh(
    connection: sqlite3.Connection, segment: Segment, stream: BinaryIO,
    seal: _FileSeal, previous: _IndexPosition | None, *, owner: str,
) -> None:
    if previous is not None and not _matches_prefix(segment.path, stream, previous.seal):
        connection.execute("DELETE FROM rollout_files WHERE id = ?", (previous.key,))
        previous = None
    if previous is None:
        key = connection.execute(
            """
            INSERT INTO rollout_files (path, owner_thread_id, device, inode, size, mtime_ns,
                prefix, tail, last_line, state_line)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, 0)
            """,
            (str(segment.path), owner, seal.device, seal.inode,
             seal.size, seal.mtime_ns, seal.prefix, seal.tail),
        ).lastrowid
        line = offset = state_line = 0
        state = AnnotationState(segment.metadata.get("cwd"))
        _record_state(connection, key, state_line, state)
    else:
        key, line, offset, state_line = (
            previous.key, previous.last_line, previous.seal.size, previous.state_line,
        )
        state = replace(previous.state)

    batch = []
    before = replace(state)
    insert = "INSERT INTO record_locations VALUES (?, ?, ?, ?, ?, ?, ?, ?)"
    for _, line, row in annotate_rows(
        replace(segment, end_offset=seal.size), segment.metadata.get("id"),
        start=(line, offset), state=state,
    ):
        start, offset = row["_rollout_offset"], row["_rollout_next_offset"]
        if offset is None:
            raise RolloutIndexUnavailable("rollout changed during indexing")
        checkpoint = row["type"] == "compacted"
        explicit = row["payload"].get("window_number") if checkpoint else None
        number = str(explicit) if type(explicit) is int and explicit >= 0 else None
        batch.append((
            key, line, start, offset - start, _timestamp_us(row.get("timestamp")),
            checkpoint, number, state_line,
        ))
        if state != before:
            state_line = line
            _record_state(connection, key, state_line, state)
            before = replace(state)
        if len(batch) == _BATCH_ROWS:
            connection.executemany(insert, batch)
            batch.clear()
    connection.executemany(insert, batch)
    line += _trailing_blank_lines(stream, offset, seal.size)
    if not _matches_prefix(segment.path, stream, seal):
        raise RolloutIndexUnavailable("rollout changed during indexing")
    connection.execute(
        """
        UPDATE rollout_files SET size = ?, mtime_ns = ?, prefix = ?, tail = ?,
            last_line = ?, state_line = ? WHERE id = ?
        """,
        (seal.size, seal.mtime_ns, seal.prefix, seal.tail, line, state_line, key),
    )


class RolloutIndex:
    def __init__(
        self, connection: sqlite3.Connection, stream: BinaryIO,
        segment: Segment, position: _IndexPosition,
    ) -> None:
        self._connection = connection
        self._stream = stream
        self._path = segment.path
        self._position = position

    def _verify(self) -> None:
        if not _matches_prefix(self._path, self._stream, self._position.seal):
            raise RolloutIndexUnavailable("rollout changed during indexed search")

    def checkpoints(self) -> Iterator[tuple[int, int | None]]:
        try:
            for line, number in self._connection.execute(
                """
                SELECT line, window_number FROM record_locations
                WHERE rollout = ? AND is_checkpoint = 1 ORDER BY line
                """,
                (self._position.key,),
            ):
                yield line, int(number) if number is not None else None
        except _UNAVAILABLE as error:
            raise RolloutIndexUnavailable("cannot read indexed checkpoints") from error

    def rows(
        self, first_line: int, last_line: int | None,
        since: datetime | None, until: datetime | None,
    ) -> Iterator[tuple[int, dict, AnnotationState]]:
        last = self._position.last_line
        if last_line is not None:
            last = min(last_line, last)
        if first_line > last:
            return
        first_line = max(first_line, 1)
        scope = ["r.rollout = ?", "r.line BETWEEN ? AND ?"]
        values = [self._position.key, first_line, last]
        if since is not None:
            scope.append("r.timestamp_us >= ?")
            values.append((since - _EPOCH) // _MICROSECOND)
        if until is not None:
            scope.append("r.timestamp_us < ?")
            values.append((until - _EPOCH) // _MICROSECOND)
        table = "record_locations AS r"
        if len(scope) > 2 and first_line == 1 and last == self._position.last_line:
            # A time-only query should seek its time range before sorting by line.
            table += " INDEXED BY locations_time"
        try:
            for line, offset, length, timestamp, cwd, turn, copied in self._connection.execute(
                f"""
                SELECT r.line, r.offset, r.length, r.timestamp_us,
                    s.cwd, s.active_turn, s.in_prefix
                FROM {table}
                JOIN annotation_states AS s ON s.rollout = r.rollout AND s.line = r.state_line
                WHERE {' AND '.join(scope)} ORDER BY r.line
                """,
                values,
            ):
                if offset < 0 or not 0 < length <= self._position.seal.size - offset:
                    raise RolloutIndexUnavailable("invalid indexed record location")
                raw = _read_at(self._stream, offset, length)
                row = _decoded_record(raw)
                if (
                    row is None
                    or not raw.endswith(b"\n")
                    or raw.count(b"\n") != 1
                    or _timestamp_us(row.get("timestamp")) != timestamp
                ):
                    raise RolloutIndexUnavailable("rollout record disagrees with its index")
                row["_rollout_offset"] = offset
                row["_rollout_next_offset"] = offset + length
                row["_rollout_revision_source"] = raw
                yield line, row, AnnotationState(cwd, turn, bool(copied))
        except _UNAVAILABLE as error:
            raise RolloutIndexUnavailable("cannot read indexed rollout records") from error


def _initialize_schema(connection: sqlite3.Connection, *, build: bool) -> None:
    version = connection.execute("PRAGMA user_version").fetchone()[0]
    if version == 0 and build:
        connection.execute("PRAGMA journal_mode = WAL")
        with connection:
            connection.execute("BEGIN IMMEDIATE")
            version = connection.execute("PRAGMA user_version").fetchone()[0]
            if version == 0:
                for statement in _SCHEMA:
                    connection.execute(statement)
                version = _VERSION
                connection.execute(f"PRAGMA user_version = {version}")
    if version != _VERSION:
        raise RolloutIndexUnavailable("unsupported rollout index schema")


@contextmanager
def _open_database(home: Path, *, mode: str) -> Iterator[sqlite3.Connection | None]:
    database = home / "state" / "plugins" / "thread-memory" / "rollout-index.sqlite3"
    if mode == "rwc":
        database.parent.mkdir(parents=True, exist_ok=True)
    else:
        try:
            database.stat()
        except FileNotFoundError:
            yield None
            return
    with closing(sqlite3.connect(
        f"{database.absolute().as_uri()}?mode={mode}", uri=True, timeout=0.25,
    )) as connection:
        connection.execute("PRAGMA foreign_keys = ON")
        _initialize_schema(connection, build=mode == "rwc")
        yield connection


def indexed_rollout_threads(home: Path) -> set[str]:
    with _open_database(home, mode="ro") as connection:
        if connection is None:
            return set()
        return {owner for (owner,) in connection.execute(
            "SELECT DISTINCT owner_thread_id FROM rollout_files"
        )}


def delete_indexed_rollouts(home: Path, thread_ids: Collection[str]) -> int:
    """Forget cached locations for owners whose deletion the caller verified."""
    if not thread_ids:
        return 0
    with _open_database(home, mode="rw") as connection:
        if connection is None:
            return 0
        with connection:
            return connection.executemany(
                "DELETE FROM rollout_files WHERE owner_thread_id = ?",
                ((thread_id,) for thread_id in thread_ids),
            ).rowcount


@contextmanager
def open_rollout_index(
    home: Path, segment: Segment, *, build: bool = True,
) -> Iterator[RolloutIndex | None]:
    """Open a stable metadata view, or let the caller stream the original file."""
    if (
        segment.path.suffix != ".jsonl"
        or segment.end_offset is not None
        or segment.end_ordinal is not None
        or (segment.diagnostics is not None and segment.diagnostics.salvage)
    ):
        yield None
        return
    with ExitStack() as resources:
        try:
            source = segment.path.resolve()
            if not any(source.is_relative_to((home / directory).resolve()) for directory in (
                "sessions", "archived_sessions",
            )):
                raise RolloutIndexUnavailable("rollout is outside the Codex session directories")
            owner = _verified_owner(segment)
            if owner is None:
                raise RolloutIndexUnavailable("cannot verify which thread owns the rollout")
            stream = resources.enter_context(segment.path.open("rb"))
            seal = _file_seal(segment, stream)
            connection = resources.enter_context(_open_database(home, mode="rwc" if build else "ro"))
            if connection is None:
                raise RolloutIndexUnavailable("rollout has no index")
            connection.execute("BEGIN")
            position = _read_position(connection, segment.path)
            if position is None or position.seal != seal:
                if not build:
                    raise RolloutIndexUnavailable("rollout index does not cover the file")
                connection.rollback()
                with connection:
                    connection.execute("BEGIN IMMEDIATE")
                    seal = _file_seal(segment, stream)
                    position = _read_position(connection, segment.path)
                    if position is None or position.seal != seal:
                        _refresh(connection, segment, stream, seal, position, owner=owner)
                connection.execute("BEGIN")
                position = _read_position(connection, segment.path)
            if position is None:
                raise RolloutIndexUnavailable("rollout has no index")
            index = RolloutIndex(connection, stream, segment, position)
            index._verify()
        except (*_UNAVAILABLE, RolloutIndexUnavailable):
            resources.close()
            yield None
            return
        yield index
        try:
            index._verify()
        except _UNAVAILABLE as error:
            raise RolloutIndexUnavailable("cannot verify indexed rollout") from error
