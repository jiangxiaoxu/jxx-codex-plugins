"""Emit staged PostToolUse context rollover reminders at fixed usage thresholds."""

from __future__ import annotations

import argparse
import json
import os
from pathlib import Path
import sqlite3
import sys
import time


EXIT_SUCCESS = 0
EXIT_UNEXPECTED = 1
EXIT_REQUEST_ERROR = 3
EXIT_TRANSCRIPT_IO_ERROR = 4
EXIT_TRANSCRIPT_ERROR = 5
EXIT_IDENTITY_ERROR = 6
EXIT_STATE_ERROR = 7

REMINDER_THRESHOLDS = (250_000, 350_000, 450_000)
MESSAGE_PREFIX = "[Context window rollover reminder] "
SQLITE_TIMEOUT_SECONDS = 5.0
MAX_THREADS = 10_000
SCHEMA = """
CREATE TABLE IF NOT EXISTS session_state (
    session_id TEXT PRIMARY KEY,
    compacted_marker TEXT NOT NULL,
    highest_threshold INTEGER NOT NULL CHECK (highest_threshold >= 0),
    last_seen_at REAL NOT NULL
)
"""

COMMON_INSTRUCTIONS = (
    "This reminder supersedes earlier rollover reminders in the current context window."
)

STAGE_INSTRUCTIONS = {
    250_000: (
        "Continue the current unit of work to a meaningful milestone, then save a "
        "checkpoint and call new_context. Receiving this reminder or finishing a "
        "tool call alone is not a stopping point."
    ),
    350_000: (
        "Bring the current work to a resumable stopping point with minimal additional "
        "work, then save a checkpoint and call new_context. Record unfinished work "
        "in the checkpoint; do not delay rollover to complete a milestone."
    ),
    450_000: (
        "Stop starting new work. Perform only minimal wrap-up "
        "needed for data integrity or existing invariants, save a checkpoint, and "
        "call new_context immediately. Do not continue investigating for a fuller "
        "record or wait for all commands or agents. If saving the checkpoint or "
        "calling new_context is unavailable or fails, stop and report the blocker."
    ),
}


class HookError(RuntimeError):
    """A known hook failure with a stable exit code and stderr category."""

    exit_code = EXIT_UNEXPECTED
    category = "unexpected-error"


class RequestError(HookError):
    """The hook request or command-line arguments are invalid."""

    exit_code = EXIT_REQUEST_ERROR
    category = "request-error"


class TranscriptIOError(HookError):
    """The transcript could not be read."""

    exit_code = EXIT_TRANSCRIPT_IO_ERROR
    category = "transcript-io-error"


class TranscriptError(HookError):
    """The transcript JSON, structure, or usage record is invalid."""

    exit_code = EXIT_TRANSCRIPT_ERROR
    category = "transcript-error"


class IdentityError(HookError):
    """The transcript identity does not match the hook request."""

    exit_code = EXIT_IDENTITY_ERROR
    category = "identity-error"


class StateError(HookError):
    """The state directory, SQLite database, or stored state is invalid."""

    exit_code = EXIT_STATE_ERROR
    category = "state-error"


def read_request() -> tuple[str, str | None, Path]:
    try:
        request = json.load(sys.stdin)
    except (json.JSONDecodeError, UnicodeDecodeError) as error:
        raise RequestError(f"invalid hook input JSON: {error}") from error
    if not isinstance(request, dict):
        raise RequestError("hook input must be a JSON object")
    session_id = request.get("session_id")
    transcript_path = request.get("transcript_path")
    if not isinstance(session_id, str) or not session_id:
        raise RequestError("hook input has no session_id")
    agent_id = request.get("agent_id")
    if agent_id is not None and (not isinstance(agent_id, str) or not agent_id):
        raise RequestError("hook input has an invalid agent_id")
    if not isinstance(transcript_path, str) or not transcript_path:
        raise RequestError("hook input has no transcript_path")
    return session_id, agent_id, Path(transcript_path)


def record_marker(item: dict, line_number: int) -> str:
    ordinal = item.get("ordinal")
    if type(ordinal) is int:
        return f"ordinal:{ordinal}"
    return f"line:{line_number}"


def read_rollout(
    path: Path, expected_session_id: str, expected_agent_id: str | None
) -> tuple[str, str, int | None, int | None]:
    try:
        lines = path.read_bytes().splitlines(keepends=True)
    except (OSError, ValueError) as error:
        raise TranscriptIOError(f"cannot read transcript: {error}") from error

    found_thread_id = None
    found_session_id = None
    compacted_marker = ""
    latest_usage: tuple[int, str | None] | None = None
    capacities: dict[str, int] = {}

    for line_number, raw_line in enumerate(lines, 1):
        try:
            item = json.loads(raw_line)
        except (json.JSONDecodeError, UnicodeDecodeError) as error:
            if (
                line_number == len(lines)
                and not raw_line.endswith((b"\n", b"\r"))
            ):
                break
            raise TranscriptError(
                f"invalid transcript JSON at line {line_number}: {error}"
            ) from error
        if not isinstance(item, dict):
            raise TranscriptError(f"transcript line {line_number} is not an object")
        kind = item.get("type")
        if kind is not None and not isinstance(kind, str):
            raise TranscriptError(f"transcript line {line_number} has an invalid type")
        payload = item.get("payload")
        if kind in {"session_meta", "compacted", "event_msg", "token_usage_record"} and not isinstance(payload, dict):
            raise TranscriptError(
                f"transcript line {line_number} has a non-object payload"
            )
        if not isinstance(payload, dict):
            payload = {}

        if kind == "session_meta":
            if found_thread_id is not None:
                continue
            thread_id = payload.get("id")
            session_id = payload.get("session_id")
            if not isinstance(thread_id, str) or not thread_id:
                raise TranscriptError("session_meta has no thread ID")
            if not isinstance(session_id, str) or not session_id:
                raise TranscriptError("session_meta has no session ID")
            found_thread_id = thread_id
            found_session_id = session_id
        elif kind == "compacted":
            compacted_marker = record_marker(item, line_number)
            latest_usage = None
        elif kind == "event_msg" and payload.get("type") == "task_started":
            turn_id = payload.get("turn_id") or item.get("turn_id")
            capacity = payload.get("model_context_window")
            if isinstance(turn_id, str) and type(capacity) is int and capacity > 0:
                capacities[turn_id] = capacity
        elif kind == "token_usage_record":
            usage = payload.get("usage")
            total_tokens = usage.get("total_tokens") if isinstance(usage, dict) else None
            if type(total_tokens) is not int or total_tokens < 0:
                raise TranscriptError(
                    f"transcript line {line_number} lacks valid usage.total_tokens"
                )
            turn_id = payload.get("turn_id") or item.get("turn_id")
            if turn_id is not None and not isinstance(turn_id, str):
                raise TranscriptError(f"transcript line {line_number} has an invalid turn ID")
            latest_usage = (total_tokens, turn_id)

    if found_thread_id is None:
        raise TranscriptError("transcript has no session_meta thread ID")
    if found_session_id != expected_session_id:
        raise IdentityError("transcript session ID does not match hook session_id")
    if expected_agent_id is not None and found_thread_id != expected_agent_id:
        raise IdentityError("transcript thread ID does not match hook agent_id")
    if latest_usage is None:
        return found_thread_id, compacted_marker, None, None
    used, turn_id = latest_usage
    capacity = capacities.get(turn_id) if turn_id is not None else None
    return found_thread_id, compacted_marker, used, capacity


def default_state_db() -> Path:
    codex_home = Path(os.environ.get("CODEX_HOME", Path.home() / ".codex"))
    return codex_home / "state" / "context-window-rollover-reminder.sqlite3"


def output_for(used: int, threshold: int) -> str:
    action = STAGE_INSTRUCTIONS[threshold]
    return json.dumps(
        {
            "hookSpecificOutput": {
                "hookEventName": "PostToolUse",
                "additionalContext": (
                    f"{MESSAGE_PREFIX}Context Window Usage: {used // 1_000}K tokens. "
                    f"{action} {COMMON_INSTRUCTIONS}"
                ),
            }
        },
        ensure_ascii=True,
        separators=(",", ":"),
    )


def evict_old_threads(connection: sqlite3.Connection, current_thread_id: str) -> None:
    total = connection.execute("SELECT COUNT(*) FROM session_state").fetchone()[0]
    excess = total - MAX_THREADS
    if excess <= 0:
        return
    victims = connection.execute(
        """
        SELECT session_id
        FROM session_state
        WHERE session_id <> ?
        ORDER BY
            last_seen_at ASC,
            session_id ASC
        LIMIT ?
        """,
        (current_thread_id, excess),
    ).fetchall()
    connection.executemany(
        "DELETE FROM session_state WHERE session_id = ?", victims
    )


def run(state_db: Path) -> str:
    session_id, agent_id, transcript_path = read_request()
    try:
        state_db.parent.mkdir(parents=True, exist_ok=True)
    except (OSError, ValueError) as error:
        raise StateError(f"cannot create state directory: {error}") from error
    try:
        connection = sqlite3.connect(state_db, timeout=SQLITE_TIMEOUT_SECONDS)
    except (OSError, ValueError, sqlite3.Error) as error:
        raise StateError(f"cannot open state database: {error}") from error
    try:
        try:
            connection.execute(SCHEMA)
            connection.commit()
            connection.execute("BEGIN IMMEDIATE")
            thread_id, compacted_marker, used, _capacity = read_rollout(
                transcript_path, session_id, agent_id
            )
            row = connection.execute(
                "SELECT compacted_marker, highest_threshold FROM session_state WHERE session_id = ?",
                (thread_id,),
            ).fetchone()
            if row is None:
                stored_marker, highest_threshold = "", 0
            else:
                stored_marker, highest_threshold = row
                if (
                    not isinstance(stored_marker, str)
                    or type(highest_threshold) is not int
                    or highest_threshold not in (0, *REMINDER_THRESHOLDS)
                ):
                    raise StateError("state database contains invalid session state")

            if compacted_marker != stored_marker:
                stored_marker = compacted_marker
                highest_threshold = 0

            message = ""
            if used is not None:
                threshold = next(
                    (
                        candidate
                        for candidate in reversed(REMINDER_THRESHOLDS)
                        if used >= candidate
                    ),
                    0,
                )
                if threshold > highest_threshold:
                    message = output_for(used, threshold)
                    highest_threshold = threshold

            connection.execute(
                """
                INSERT INTO session_state(
                    session_id, compacted_marker, highest_threshold, last_seen_at
                )
                VALUES (?, ?, ?, ?)
                ON CONFLICT(session_id) DO UPDATE SET
                    compacted_marker = excluded.compacted_marker,
                    highest_threshold = excluded.highest_threshold,
                    last_seen_at = excluded.last_seen_at
                """,
                (thread_id, stored_marker, highest_threshold, time.time()),
            )
            evict_old_threads(connection, thread_id)
            connection.commit()
            return message
        except sqlite3.Error as error:
            try:
                connection.rollback()
            except sqlite3.Error:
                pass
            raise StateError(f"state database error: {error}") from error
        except HookError:
            try:
                connection.rollback()
            except sqlite3.Error:
                pass
            raise
        except Exception:
            try:
                connection.rollback()
            except sqlite3.Error:
                pass
            raise
    finally:
        connection.close()


class HookArgumentParser(argparse.ArgumentParser):
    def error(self, message: str) -> None:
        self.print_usage(sys.stderr)
        self.exit(
            EXIT_REQUEST_ERROR,
            f"context-window-rollover-hook: {RequestError.category} (exit {EXIT_REQUEST_ERROR}): {message}\n",
        )


def report_error(error: HookError) -> None:
    print(
        f"context-window-rollover-hook: {error.category} (exit {error.exit_code}): {error}",
        file=sys.stderr,
    )


def main() -> int:
    parser = HookArgumentParser(description=__doc__)
    parser.add_argument("--state-db", type=Path, default=default_state_db())
    args = parser.parse_args()
    try:
        output = run(args.state_db)
    except HookError as error:
        report_error(error)
        return error.exit_code
    if output:
        print(output)
    return EXIT_SUCCESS


if __name__ == "__main__":
    raise SystemExit(main())
