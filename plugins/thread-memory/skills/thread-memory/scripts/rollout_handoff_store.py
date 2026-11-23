"""Store hook diagnostics, reminder claims, and versioned thread notes."""

import json
import sqlite3
import time
from collections.abc import Iterable
from contextlib import closing
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from pathlib import Path


_TIMEOUT_SECONDS = 1.0
MAX_HOOK_DIAGNOSTICS = 2_048
_HOOK_DIAGNOSTIC_DETAILS_LIMIT = 512
_SCHEMA_VERSION = 1
_SCHEMA_V1 = (
    """
    CREATE TABLE handoffs (
        thread_id TEXT NOT NULL,
        window TEXT NOT NULL,
        summary TEXT,
        saved_at TEXT,
        PRIMARY KEY (thread_id, window)
    )
    """,
    """
    CREATE TABLE handoff_history (
        revision INTEGER PRIMARY KEY,
        thread_id TEXT NOT NULL,
        window TEXT NOT NULL,
        summary TEXT NOT NULL,
        saved_at TEXT NOT NULL
    )
    """,
    "CREATE INDEX handoff_history_thread ON handoff_history (thread_id)",
    """
    CREATE TRIGGER archive_handoff
    BEFORE UPDATE OF summary ON handoffs
    WHEN OLD.summary IS NOT NULL AND OLD.summary <> '' AND OLD.saved_at IS NOT NULL
    BEGIN
        INSERT INTO handoff_history (thread_id, window, summary, saved_at)
        VALUES (OLD.thread_id, OLD.window, OLD.summary, OLD.saved_at);
    END
    """,
    """
    CREATE TABLE memory_revisions (
        revision INTEGER PRIMARY KEY AUTOINCREMENT,
        thread_id TEXT NOT NULL,
        summary TEXT,
        updated_us INTEGER NOT NULL,
        effective_us INTEGER NOT NULL
    )
    """,
    "CREATE INDEX memory_revisions_thread_time ON memory_revisions (thread_id, effective_us, revision)",
    """
    CREATE TABLE child_compactions (
        thread_id TEXT PRIMARY KEY NOT NULL
    )
    """,
    """
    CREATE TABLE reminder_claims (
        thread_id TEXT NOT NULL,
        window TEXT NOT NULL,
        level INTEGER NOT NULL,
        stage INTEGER NOT NULL CHECK (stage BETWEEN 0 AND 3),
        PRIMARY KEY (thread_id, window, level)
    )
    """,
    """
    CREATE TABLE rollout_scan_checkpoints (
        thread_id TEXT NOT NULL,
        rollout_path TEXT NOT NULL,
        checkpoint TEXT NOT NULL,
        PRIMARY KEY (thread_id, rollout_path)
    )
    """,
    """
    CREATE TABLE hook_diagnostics (
        id INTEGER PRIMARY KEY,
        thread_id TEXT NOT NULL CHECK (length(thread_id) = 36),
        timestamp_us INTEGER NOT NULL,
        event TEXT NOT NULL CHECK (length(event) BETWEEN 1 AND 64),
        window TEXT CHECK (length(window) <= 64),
        details TEXT
    )
    """,
    "CREATE INDEX hook_diagnostics_thread ON hook_diagnostics (thread_id, id)",
)
_STORED_STATE_TABLES = (
    "handoffs",
    "handoff_history",
    "memory_revisions",
    "child_compactions",
    "reminder_claims",
    "rollout_scan_checkpoints",
    "hook_diagnostics",
)
_EPOCH = datetime(1970, 1, 1, tzinfo=timezone.utc)
_MICROSECOND = timedelta(microseconds=1)


@dataclass(frozen=True)
class MemoryRevision:
    revision: int
    summary: str | None
    updated_us: int
    effective_us: int


def _database(home: Path) -> Path:
    return home / "state" / "plugins" / "thread-memory" / "handoff.sqlite3"


def _schema_version(connection: sqlite3.Connection) -> int:
    (version,) = connection.execute("PRAGMA user_version").fetchone()
    if version not in (0, _SCHEMA_VERSION):
        raise sqlite3.DatabaseError(
            f"Unsupported Thread Memory database schema version {version}. "
            f"This plugin supports version {_SCHEMA_VERSION}."
        )
    return version


def _open_writable(home: Path, *, timeout: float = _TIMEOUT_SECONDS) -> sqlite3.Connection:
    database = _database(home)
    database.parent.mkdir(parents=True, exist_ok=True)
    connection = sqlite3.connect(database, timeout=timeout)
    try:
        if _schema_version(connection) == 0:
            with connection:
                connection.execute("BEGIN IMMEDIATE")
                if _schema_version(connection) == 0:
                    for statement in _SCHEMA_V1:
                        connection.execute(statement)
                    connection.execute(f"PRAGMA user_version = {_SCHEMA_VERSION}")
    except BaseException:
        connection.close()
        raise
    return connection


def _open_existing(home: Path, *, writable: bool = False) -> sqlite3.Connection | None:
    database = _database(home)
    try:
        database.stat()
    except FileNotFoundError:
        return None
    mode = "rw" if writable else "ro"
    connection = sqlite3.connect(
        f"{database.absolute().as_uri()}?mode={mode}",
        uri=True,
        timeout=_TIMEOUT_SECONDS,
    )
    try:
        if _schema_version(connection) == _SCHEMA_VERSION:
            return connection
    except BaseException:
        connection.close()
        raise
    connection.close()
    return None


def _memory_revision(
    connection: sqlite3.Connection, thread_id: str, at_us: int | None = None
) -> MemoryRevision | None:
    scope = "thread_id = ?"
    params = (thread_id,)
    if at_us is not None:
        scope += " AND effective_us <= ?"
        params += (at_us,)
    row = connection.execute(
        f"""
        SELECT revision, summary, updated_us, effective_us FROM memory_revisions
        WHERE {scope}
        ORDER BY effective_us DESC, revision DESC LIMIT 1
        """,
        params,
    ).fetchone()
    return MemoryRevision(*row) if row is not None else None


def memory_revision(home: Path, thread_id: str, at_us: int | None = None) -> MemoryRevision | None:
    connection = _open_existing(home)
    if connection is None:
        return None
    with closing(connection):
        return _memory_revision(connection, thread_id, at_us)


def memory_timestamp(timestamp_us: int) -> str:
    timestamp = _EPOCH + timedelta(microseconds=timestamp_us)
    return timestamp.isoformat(timespec="microseconds").replace("+00:00", "Z")


def record_hook_diagnostic(
    home: Path, thread_id: str, event: str, *, window: str | None = None, **details: object,
) -> None:
    """Record curated hook metadata without waiting for the database write lock."""
    try:
        encoded = json.dumps(details, separators=(",", ":"), allow_nan=False) if details else None
        if encoded is not None and len(encoded) > _HOOK_DIAGNOSTIC_DETAILS_LIMIT:
            encoded = None
        with closing(_open_writable(home, timeout=0.0)) as connection, connection:
            connection.execute(
                """
                INSERT INTO hook_diagnostics (thread_id, timestamp_us, event, window, details)
                VALUES (?, ?, ?, ?, ?)
                """,
                (thread_id, time.time_ns() // 1_000, event, window, encoded),
            )
            connection.execute(
                """
                DELETE FROM hook_diagnostics WHERE id <= (
                    SELECT id FROM hook_diagnostics ORDER BY id DESC LIMIT 1 OFFSET ?
                )
                """,
                (MAX_HOOK_DIAGNOSTICS,),
            )
    except (OSError, sqlite3.Error, TypeError, ValueError):
        pass  # Diagnostic failures must not change hook behavior.


def read_hook_diagnostics(home: Path, thread_id: str, *, limit: int) -> list[dict]:
    """Return the most recently recorded diagnostics for one thread."""
    connection = _open_existing(home)
    if connection is None:
        return []
    with closing(connection):
        rows = connection.execute(
            """
            SELECT timestamp_us, event, window, details FROM hook_diagnostics
            WHERE thread_id = ? ORDER BY id DESC LIMIT ?
            """,
            (thread_id, limit),
        )
        items = []
        for timestamp_us, event, window, encoded in rows:
            item = {"timestamp": memory_timestamp(timestamp_us), "event": event}
            if window is not None:
                item["window"] = window
            if encoded is not None:
                item["details"] = json.loads(encoded)
            items.append(item)
        return items


def memory_history(
    home: Path, thread_id: str, *, at_us: int | None = None, limit: int = 10
) -> list[dict]:
    """List maintained versions without loading their contents."""
    connection = _open_existing(home)
    if connection is None:
        return []
    with closing(connection):
        scope = "thread_id = ? AND summary IS NOT NULL"
        params = (thread_id,)
        if at_us is not None:
            scope += " AND effective_us <= ?"
            params += (at_us,)
        return [
            {
                "updated_at": memory_timestamp(updated_us),
                "effective_at": memory_timestamp(effective_us),
                "bytes": size,
            }
            for updated_us, effective_us, size in connection.execute(
                f"""
                SELECT updated_us, effective_us, length(CAST(summary AS BLOB))
                FROM memory_revisions
                WHERE {scope}
                ORDER BY effective_us DESC, revision DESC LIMIT ?
                """,
                (*params, limit),
            )
        ]


_LEGACY_TIME_SORT_KEY = """
    CASE LENGTH(saved_at)
        WHEN 20 THEN SUBSTR(saved_at, 1, 19) || '.000000Z'
        WHEN 24 THEN SUBSTR(saved_at, 1, 23) || '000Z'
        ELSE saved_at
    END
"""
_LEGACY_REVISIONS = f"""
    WITH versions AS (
        SELECT summary, saved_at, window, 1 AS is_current, 0 AS revision FROM handoffs WHERE thread_id = ?
        UNION ALL
        SELECT summary, saved_at, window, 0, revision FROM handoff_history WHERE thread_id = ?
    ), timed AS (
        SELECT *, {_LEGACY_TIME_SORT_KEY} AS at
        FROM versions WHERE summary <> '' AND saved_at IS NOT NULL
    )
    SELECT summary, saved_at FROM timed
"""
_INSERT_MEMORY_REVISION = """
    INSERT INTO memory_revisions (thread_id, summary, updated_us, effective_us)
    VALUES (?, ?, ?, ?)
"""


def _legacy_timestamp_us(saved_at: str) -> int:
    timestamp = datetime.fromisoformat(saved_at.replace("Z", "+00:00"))
    return (timestamp - _EPOCH) // _MICROSECOND


def legacy_memory(home: Path, thread_id: str, at_us: int | None = None) -> tuple[str, int] | None:
    """Resolve an older window note for a thread without a durable timeline."""
    connection = _open_existing(home)
    if connection is None:
        return None
    with closing(connection):
        cutoff = memory_timestamp(at_us) if at_us is not None else None
        row = connection.execute(
            f"""
            {_LEGACY_REVISIONS}
            WHERE NOT EXISTS (SELECT 1 FROM memory_revisions WHERE thread_id = ?)
              AND (? IS NULL OR at <= ?)
            ORDER BY at DESC, window DESC, is_current DESC, revision DESC LIMIT 1
            """,
            (thread_id, thread_id, thread_id, cutoff, cutoff),
        ).fetchone()
        if row is None:
            return None
        summary, saved_at = row
        return summary, _legacy_timestamp_us(saved_at)


def _copy_legacy_revisions(
    connection: sqlite3.Connection, thread_id: str, floor_us: int | None = None,
) -> None:
    versions = connection.execute(
        f"{_LEGACY_REVISIONS} ORDER BY at, window, is_current, revision",
        (thread_id, thread_id),
    )
    for summary, saved_at in versions:
        updated_us = _legacy_timestamp_us(saved_at)
        effective_us = max(updated_us, floor_us) if floor_us is not None else updated_us
        connection.execute(_INSERT_MEMORY_REVISION, (thread_id, summary, updated_us, effective_us))


def initialize_memory(
    home: Path,
    thread_id: str,
    summary: str | None = None,
    updated_us: int = 0,
    effective_us: int | None = None,
) -> MemoryRevision | None:
    """Copy the fork baseline and pre-initialization window history once."""
    with closing(_open_writable(home)) as connection, connection:
        connection.execute("BEGIN IMMEDIATE")
        if (current := _memory_revision(connection, thread_id)) is not None:
            return current
        if effective_us is not None:
            connection.execute(_INSERT_MEMORY_REVISION, (thread_id, summary, updated_us, effective_us))
        _copy_legacy_revisions(connection, thread_id, effective_us)
        return _memory_revision(connection, thread_id)


def save_memory(
    home: Path, thread_id: str, summary: str, *, expected_revision: int | None = None
) -> MemoryRevision | None:
    """Append an edit. None permits any revision, and 0 requires no current revision."""
    with closing(_open_writable(home)) as connection, connection:
        # An edit blocked behind a writer must not appear in an earlier fork snapshot.
        connection.execute("BEGIN IMMEDIATE")
        current = _memory_revision(connection, thread_id)
        revision = current.revision if current is not None else 0
        if expected_revision is not None and expected_revision != revision:
            return None
        if current is None:
            # An explicit write can start the timeline when ancestry is unavailable.
            _copy_legacy_revisions(connection, thread_id)
            current = _memory_revision(connection, thread_id)
        updated_us = time.time_ns() // 1_000
        effective_us = max(updated_us, current.effective_us) if current is not None else updated_us
        result = connection.execute(
            _INSERT_MEMORY_REVISION, (thread_id, summary, updated_us, effective_us),
        )
        return MemoryRevision(result.lastrowid, summary, updated_us, effective_us)


def claim_reminder(
    home: Path, thread_id: str, window: str, phases: Iterable[tuple[int, int]]
) -> tuple[int, ...]:
    """Advance each reminder level to its highest supplied stage in one transaction."""
    stages: dict[int, int] = {}
    for level, stage in phases:
        stages[level] = max(stages.get(level, stage), stage)
    if not stages:
        return ()
    advanced = []
    with closing(_open_writable(home)) as connection, connection:
        for level, stage in stages.items():
            result = connection.execute(
                """
                INSERT INTO reminder_claims (thread_id, window, level, stage) VALUES (?, ?, ?, ?)
                ON CONFLICT (thread_id, window, level) DO UPDATE SET stage = excluded.stage
                WHERE excluded.stage > reminder_claims.stage
                """,
                (thread_id, window, level, stage),
            )
            if result.rowcount == 1:
                advanced.append(level)
    return tuple(advanced)


def load_rollout_checkpoint(home: Path, thread_id: str, rollout_path: str) -> str | None:
    """Read the latest scan checkpoint for this thread and rollout file."""
    connection = _open_existing(home)
    if connection is None:
        return None
    with closing(connection):
        row = connection.execute(
            "SELECT checkpoint FROM rollout_scan_checkpoints WHERE thread_id = ? AND rollout_path = ?",
            (thread_id, rollout_path),
        ).fetchone()
    return row[0] if row is not None else None


def save_rollout_checkpoint(
    home: Path, thread_id: str, rollout_path: str, previous: str | None, checkpoint: str
) -> bool:
    """Advance the cache only if no other scan replaced the caller's checkpoint."""
    if previous == checkpoint:
        return False
    connection = _open_writable(home) if previous is None else _open_existing(home, writable=True)
    if connection is None:
        return False
    with closing(connection), connection:
        if previous is None:
            result = connection.execute(
                """
                INSERT INTO rollout_scan_checkpoints (thread_id, rollout_path, checkpoint) VALUES (?, ?, ?)
                ON CONFLICT (thread_id, rollout_path) DO NOTHING
                """,
                (thread_id, rollout_path, checkpoint),
            )
        else:
            result = connection.execute(
                """
                UPDATE rollout_scan_checkpoints SET checkpoint = ?
                WHERE thread_id = ? AND rollout_path = ? AND checkpoint = ?
                """,
                (checkpoint, thread_id, rollout_path, previous),
            )
        return result.rowcount == 1


def mark_child_compaction(home: Path, thread_id: str) -> None:
    """Queue a notice, coalescing repeated compactions before delivery."""
    with closing(_open_writable(home)) as connection, connection:
        connection.execute("INSERT OR IGNORE INTO child_compactions (thread_id) VALUES (?)", (thread_id,))


def take_child_compaction(home: Path, thread_id: str) -> bool:
    """Consume a notice exactly once across concurrent tool hooks."""
    connection = _open_existing(home)
    if connection is None:
        return False
    with closing(connection):
        pending = connection.execute(
            "SELECT 1 FROM child_compactions WHERE thread_id = ?", (thread_id,)
        ).fetchone()
        if pending is None:
            return False
    connection = _open_existing(home, writable=True)
    if connection is None:
        return False
    with closing(connection), connection:
        return connection.execute(
            "DELETE FROM child_compactions WHERE thread_id = ?", (thread_id,)
        ).rowcount == 1


def _begin_handoff_edit(connection: sqlite3.Connection) -> str:
    # Timestamp the new version after obtaining the write lock, as for canonical notes.
    connection.execute("BEGIN IMMEDIATE")
    return memory_timestamp(time.time_ns() // 1_000)


def save_handoff(home: Path, thread_id: str, window: str, summary: str) -> dict:
    with closing(_open_writable(home)) as connection, connection:
        saved_at = _begin_handoff_edit(connection)
        connection.execute(
            """
            INSERT INTO handoffs (thread_id, window, summary, saved_at)
            VALUES (?, ?, ?, ?)
            ON CONFLICT (thread_id, window) DO UPDATE SET
                summary = excluded.summary,
                saved_at = excluded.saved_at
            """,
            (thread_id, window, summary, saved_at),
        )
    return {
        "saved": True,
        "thread_id": thread_id,
        "window": window,
        "bytes": len(summary.encode("utf-8")),
    }


def load_handoff(home: Path, thread_id: str, window: str) -> str | None:
    connection = _open_existing(home)
    if connection is None:
        return None
    with closing(connection):
        row = connection.execute(
            "SELECT summary FROM handoffs WHERE thread_id = ? AND window = ?",
            (thread_id, window),
        ).fetchone()
    return row[0] if row is not None else None


def replace_handoff(home: Path, thread_id: str, window: str, original: str, summary: str) -> bool:
    connection = _open_existing(home, writable=True)
    if connection is None:
        return False
    with closing(connection), connection:
        saved_at = _begin_handoff_edit(connection)
        changed = connection.execute(
            """
            UPDATE handoffs SET summary = ?, saved_at = ?
            WHERE thread_id = ? AND window = ? AND summary = ?
            """,
            (summary, saved_at, thread_id, window, original),
        )
        return changed.rowcount == 1


def list_saved_threads(home: Path) -> list[dict]:
    """List thread-level summary metadata without returning note text."""
    connection = _open_existing(home)
    if connection is None:
        return []
    with closing(connection):
        return [
            {"thread_id": thread_id, "latest_at": latest_at, "count": count}
            for thread_id, latest_at, count in connection.execute(
                """
                SELECT thread_id, MAX(saved_at) AS latest_at, COUNT(*)
                FROM handoffs
                WHERE summary IS NOT NULL
                GROUP BY thread_id
                ORDER BY latest_at DESC, thread_id
                """
            )
        ]


_PANEL_NOTE_JOINS = f"""
    LEFT JOIN memory_revisions AS memory ON memory.revision = (
        SELECT revision FROM memory_revisions
        WHERE thread_id = threads.thread_id AND summary <> ''
        ORDER BY effective_us DESC, revision DESC LIMIT 1
    )
    LEFT JOIN handoffs AS handoff ON memory.revision IS NULL
        AND handoff.thread_id = threads.thread_id AND handoff.window = (
            SELECT window FROM handoffs
            WHERE thread_id = threads.thread_id AND summary <> '' AND saved_at IS NOT NULL
            ORDER BY {_LEGACY_TIME_SORT_KEY} DESC, window LIMIT 1
        )
"""


def list_noted_threads(home: Path) -> list[dict]:
    """List each thread's current note timestamp without returning note bodies."""
    connection = _open_existing(home)
    if connection is None:
        return []
    with closing(connection):
        return [
            {"thread_id": thread_id, "latest_at": memory_timestamp(updated_us) if updated_us is not None else saved_at}
            for thread_id, updated_us, saved_at in connection.execute(
                f"""
                WITH threads AS (SELECT thread_id FROM memory_revisions UNION SELECT thread_id FROM handoffs)
                SELECT threads.thread_id, memory.updated_us, handoff.saved_at
                FROM threads {_PANEL_NOTE_JOINS}
                WHERE memory.revision IS NOT NULL OR handoff.window IS NOT NULL
                """
            )
        ]


def read_current_note(home: Path, thread_id: str) -> tuple[str | None, str | None]:
    """Read the note shown in the panel and its maintenance timestamp."""
    connection = _open_existing(home)
    if connection is None:
        return None, None
    with closing(connection):
        summary, updated_us, saved_at = connection.execute(
            f"""
            WITH threads AS (SELECT ? AS thread_id)
            SELECT COALESCE(memory.summary, handoff.summary), memory.updated_us, handoff.saved_at
            FROM threads {_PANEL_NOTE_JOINS}
            """,
            (thread_id,),
        ).fetchone()
    return summary, memory_timestamp(updated_us) if updated_us is not None else saved_at


def initialized_memory_threads(home: Path) -> set[str]:
    """Return thread IDs with independent memory state, including empty fork markers."""
    connection = _open_existing(home)
    if connection is None:
        return set()
    with closing(connection):
        return {
            thread_id for (thread_id,) in connection.execute("SELECT DISTINCT thread_id FROM memory_revisions")
        }


def stored_threads(home: Path) -> set[str]:
    """List thread IDs with any stored state for cleanup."""
    connection = _open_existing(home)
    if connection is None:
        return set()
    with closing(connection):
        return {
            thread_id
            for table in _STORED_STATE_TABLES
            for (thread_id,) in connection.execute(f"SELECT DISTINCT thread_id FROM {table}")
        }


def delete_handoff_threads(home: Path, thread_ids: Iterable[str]) -> int:
    """Delete all state for the exact thread IDs already verified by the caller."""
    ids = set(thread_ids)
    if not ids:
        return 0
    connection = _open_existing(home, writable=True)
    if connection is None:
        return 0
    with closing(connection), connection:
        return sum(
            connection.executemany(
                f"DELETE FROM {table} WHERE thread_id = ?",
                ((thread_id,) for thread_id in ids),
            ).rowcount
            for table in _STORED_STATE_TABLES
        )
