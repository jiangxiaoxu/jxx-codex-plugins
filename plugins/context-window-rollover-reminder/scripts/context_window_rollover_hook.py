"""Emit periodic usage snapshots and staged PostToolUse rollover reminders."""

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

STRICT_MODELS = frozenset({"gpt-5.6-sol", "gpt-6-astra", "gpt-6-sol"})
STRICT_THRESHOLDS = (300_000, 350_000, 400_000)
LUNA_MODELS = frozenset({"gpt-5.6-luna", "gpt-6-luna"})
LUNA_THRESHOLDS = (400_000, 450_000, 500_000)
DEFAULT_THRESHOLDS = (350_000, 400_000, 450_000)
SQLITE_TIMEOUT_SECONDS = 5.0
MAX_THREADS = 10_000
SQLITE_MAX_INTEGER = 2**63 - 1
TOKENS_PER_K = 1_000
MAX_THRESHOLD_K = SQLITE_MAX_INTEGER // TOKENS_PER_K
BASELINE_TOKENS = 12_000
REMINDER_WINDOW_NUMERATOR = 17
REMINDER_WINDOW_DENOMINATOR = 20
USAGE_REMINDER_START = 100_000
USAGE_REMINDER_INTERVAL = 25_000
SCHEMA = """
CREATE TABLE IF NOT EXISTS session_state (
    session_id TEXT PRIMARY KEY,
    compacted_marker TEXT NOT NULL,
    highest_stage INTEGER NOT NULL CHECK (highest_stage >= 0 AND highest_stage <= 3),
    last_seen_at REAL NOT NULL
)
"""
POLICY_SCHEMA = """
CREATE TABLE IF NOT EXISTS thread_policies (
    thread_id TEXT PRIMARY KEY,
    start_k INTEGER NOT NULL CHECK (start_k > 0),
    interval_k INTEGER NOT NULL CHECK (interval_k > 0),
    updated_at REAL NOT NULL
)
"""
USAGE_REMINDER_SCHEMA = """
CREATE TABLE IF NOT EXISTS usage_reminder_state (
    session_id TEXT PRIMARY KEY,
    compacted_marker TEXT NOT NULL,
    highest_threshold INTEGER NOT NULL CHECK (highest_threshold >= 0)
)
"""
REQUIRED_STATE_COLUMNS = frozenset(
    {"session_id", "compacted_marker", "highest_stage", "last_seen_at"}
)
REQUIRED_POLICY_COLUMNS = frozenset(
    {"thread_id", "start_k", "interval_k", "updated_at"}
)
REQUIRED_USAGE_REMINDER_COLUMNS = frozenset(
    {"session_id", "compacted_marker", "highest_threshold"}
)

COMMON_INSTRUCTIONS = (
    "This reminder supersedes earlier rollover reminders in the current context window."
)

STAGE_INSTRUCTIONS = {
    1: (
        "Continue the current unit of work to a meaningful milestone, then save a "
        "checkpoint and call new_context. Receiving this reminder or finishing a "
        "tool call alone is not a stopping point."
    ),
    2: (
        "Bring the current work to a resumable stopping point with minimal additional "
        "work, then save a checkpoint and call new_context. Record unfinished work "
        "in the checkpoint; do not delay rollover to complete a milestone."
    ),
    3: (
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


def read_request() -> tuple[str, str | None, str, Path]:
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
    model = request.get("model")
    if not isinstance(model, str) or not model.strip():
        raise RequestError("hook input has no valid model")
    if not isinstance(transcript_path, str) or not transcript_path:
        raise RequestError("hook input has no transcript_path")
    return session_id, agent_id, model, Path(transcript_path)


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
    return codex_home / "state" / "context-window-rollover-reminder-v2.sqlite3"


def stage_for_usage(used: int, thresholds: tuple[int, int, int]) -> int:
    return next(
        (
            stage
            for stage, threshold in reversed(tuple(enumerate(thresholds, start=1)))
            if used >= threshold
        ),
        0,
    )


def round_percent_half_up(tokens: int, window: int) -> int:
    """Round a non-negative percentage to the nearest integer, half up."""

    return (tokens * 100 * 2 + window) // (window * 2)


def context_usage(used_tokens: int, model_context_window: int) -> dict[str, int | str]:
    """Calculate the shared effective-window usage values and display string."""

    reminder_window_tokens = (
        model_context_window * REMINDER_WINDOW_NUMERATOR
    ) // REMINDER_WINDOW_DENOMINATOR
    effective_for_percent = max(reminder_window_tokens - BASELINE_TOKENS, 0)
    if reminder_window_tokens <= BASELINE_TOKENS:
        used_percent = 100
    else:
        adjusted_used = max(used_tokens - BASELINE_TOKENS, 0)
        remaining_for_percent = max(effective_for_percent - adjusted_used, 0)
        remaining_percent = round_percent_half_up(
            remaining_for_percent, effective_for_percent
        )
        used_percent = 100 - remaining_percent
    used_k = used_tokens // TOKENS_PER_K
    window_k = reminder_window_tokens // TOKENS_PER_K
    remaining_k = max(reminder_window_tokens - used_tokens, 0) // TOKENS_PER_K
    return {
        "effective_window_tokens": reminder_window_tokens,
        "used_percent": used_percent,
        "used_k": used_k,
        "window_k": window_k,
        "remaining_k": remaining_k,
        "display": f"{used_k}K/{window_k}K ({used_percent}% used)",
    }


def usage_threshold_for(used: int) -> int:
    if used < USAGE_REMINDER_START:
        return 0
    return USAGE_REMINDER_START + (
        (used - USAGE_REMINDER_START) // USAGE_REMINDER_INTERVAL
    ) * USAGE_REMINDER_INTERVAL


def usage_fragment(usage: dict[str, int | str]) -> str:
    return (
        "<context_window_usage_reminder>Context Window Usage: "
        f"{usage['display']}. {usage['remaining_k']}K tokens remaining."
        "</context_window_usage_reminder>"
    )


def rollover_fragment(used: int, stage: int, include_usage: bool) -> str:
    action = STAGE_INSTRUCTIONS[stage]
    usage = (
        f"Context Window Usage: {used // TOKENS_PER_K}K tokens. "
        if include_usage
        else ""
    )
    return (
        f"<context_window_rollover_reminder>{usage}{action} {COMMON_INSTRUCTIONS}"
        "</context_window_rollover_reminder>"
    )


def output_for(fragments: list[str]) -> str:
    return json.dumps(
        {
            "hookSpecificOutput": {
                "hookEventName": "PostToolUse",
                "additionalContext": "\n".join(fragments),
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
    connection.executemany(
        "DELETE FROM usage_reminder_state WHERE session_id = ?", victims
    )


def ensure_state_schema(connection: sqlite3.Connection) -> None:
    columns = {
        row[1]
        for row in connection.execute("PRAGMA table_info(session_state)").fetchall()
    }
    if not columns:
        connection.execute(SCHEMA)
    else:
        missing = REQUIRED_STATE_COLUMNS - columns
        if missing:
            missing_names = ", ".join(sorted(missing))
            raise StateError(
                f"state database schema is missing required columns: {missing_names}"
            )

    usage_info = connection.execute(
        "PRAGMA table_info(usage_reminder_state)"
    ).fetchall()
    if usage_info:
        usage_columns = {row[1] for row in usage_info}
        missing = REQUIRED_USAGE_REMINDER_COLUMNS - usage_columns
        if missing:
            missing_names = ", ".join(sorted(missing))
            raise StateError(
                "usage reminder database schema is missing required columns: "
                f"{missing_names}"
            )

    policy_info = connection.execute("PRAGMA table_info(thread_policies)").fetchall()
    if not policy_info:
        if not usage_info:
            connection.execute(USAGE_REMINDER_SCHEMA)
        connection.execute(POLICY_SCHEMA)
        return
    policy_columns = {row[1] for row in policy_info}
    missing = REQUIRED_POLICY_COLUMNS - policy_columns
    if missing:
        missing_names = ", ".join(sorted(missing))
        raise StateError(
            f"policy database schema is missing required columns: {missing_names}"
        )
    by_name = {row[1]: row for row in policy_info}
    if by_name["thread_id"][5] != 1 or any(
        row[5] > 0 and row[1] != "thread_id" for row in policy_info
    ):
        raise StateError("policy database schema requires thread_id as the primary key")
    expected_types = {
        "thread_id": "TEXT",
        "start_k": "INTEGER",
        "interval_k": "INTEGER",
        "updated_at": "REAL",
    }
    for name, expected_type in expected_types.items():
        if str(by_name[name][2]).upper() != expected_type:
            raise StateError(
                f"policy database schema requires {name} to use {expected_type}"
            )
    for name in ("start_k", "interval_k", "updated_at"):
        if by_name[name][3] != 1:
            raise StateError(
                f"policy database schema requires {name} to be NOT NULL"
            )
    if not usage_info:
        connection.execute(USAGE_REMINDER_SCHEMA)


def validate_policy_values(start_k: object, interval_k: object) -> tuple[int, int]:
    """Validate K-valued policy fields and their token threshold range."""

    if type(start_k) is not int or start_k <= 0:
        raise ValueError("start_k must be a positive integer")
    if type(interval_k) is not int or interval_k <= 0:
        raise ValueError("interval_k must be a positive integer")
    if start_k + 2 * interval_k > MAX_THRESHOLD_K:
        raise ValueError(
            "the three thresholds exceed SQLite's signed 64-bit integer range"
        )
    return start_k, interval_k


def policy_thresholds(start_k: int, interval_k: int) -> tuple[int, int, int]:
    """Return custom thresholds in the token unit consumed by stage_for_usage."""

    validate_policy_values(start_k, interval_k)
    return tuple(
        value * TOKENS_PER_K
        for value in (start_k, start_k + interval_k, start_k + 2 * interval_k)
    )


def read_thread_policy(
    connection: sqlite3.Connection, thread_id: str
) -> tuple[int, int] | None:
    """Read and validate one thread policy; malformed persisted values fail closed."""

    row = connection.execute(
        "SELECT start_k, interval_k FROM thread_policies WHERE thread_id = ?",
        (thread_id,),
    ).fetchone()
    if row is None:
        return None
    try:
        return validate_policy_values(row[0], row[1])
    except ValueError as error:
        raise StateError(
            f"state database contains invalid thread policy for {thread_id}: {error}"
        ) from error


def run(state_db: Path) -> str:
    session_id, agent_id, model, transcript_path = read_request()
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
            ensure_state_schema(connection)
            connection.commit()
            connection.execute("BEGIN IMMEDIATE")
            thread_id, compacted_marker, used, capacity = read_rollout(
                transcript_path, session_id, agent_id
            )
            row = connection.execute(
                "SELECT compacted_marker, highest_stage FROM session_state WHERE session_id = ?",
                (thread_id,),
            ).fetchone()
            if row is None:
                stored_marker, highest_stage = "", 0
            else:
                stored_marker, highest_stage = row
                if (
                    not isinstance(stored_marker, str)
                    or type(highest_stage) is not int
                    or highest_stage < 0
                    or highest_stage > 3
                ):
                    raise StateError("state database contains invalid session state")

            if compacted_marker != stored_marker:
                stored_marker = compacted_marker
                highest_stage = 0

            usage_row = connection.execute(
                "SELECT compacted_marker, highest_threshold FROM usage_reminder_state WHERE session_id = ?",
                (thread_id,),
            ).fetchone()
            if usage_row is None:
                usage_marker, highest_usage_threshold = "", 0
            else:
                usage_marker, highest_usage_threshold = usage_row
                if (
                    not isinstance(usage_marker, str)
                    or type(highest_usage_threshold) is not int
                    or highest_usage_threshold < 0
                ):
                    raise StateError("state database contains invalid usage reminder state")
            if compacted_marker != usage_marker:
                usage_marker = compacted_marker
                highest_usage_threshold = 0

            policy = read_thread_policy(connection, thread_id)
            fragments = []
            if used is not None:
                if policy is None:
                    thresholds = (
                        STRICT_THRESHOLDS
                        if model in STRICT_MODELS
                        else LUNA_THRESHOLDS
                        if model in LUNA_MODELS
                        else DEFAULT_THRESHOLDS
                    )
                else:
                    thresholds = policy_thresholds(*policy)
                stage = stage_for_usage(used, thresholds)
                stage_due = stage > highest_stage
                current_usage_threshold = usage_threshold_for(used)
                usage_due = (
                    capacity is not None
                    and current_usage_threshold > highest_usage_threshold
                )
                if capacity is not None and (usage_due or stage_due):
                    fragments.append(usage_fragment(context_usage(used, capacity)))
                    highest_usage_threshold = max(
                        highest_usage_threshold, current_usage_threshold
                    )
                if stage_due:
                    fragments.append(
                        rollover_fragment(
                            used, stage, include_usage=capacity is None
                        )
                    )
                    highest_stage = stage

            connection.execute(
                """
                INSERT INTO session_state(
                    session_id, compacted_marker, highest_stage, last_seen_at
                )
                VALUES (?, ?, ?, ?)
                ON CONFLICT(session_id) DO UPDATE SET
                    compacted_marker = excluded.compacted_marker,
                    highest_stage = excluded.highest_stage,
                    last_seen_at = excluded.last_seen_at
                """,
                (thread_id, stored_marker, highest_stage, time.time()),
            )
            connection.execute(
                """
                INSERT INTO usage_reminder_state(
                    session_id, compacted_marker, highest_threshold
                )
                VALUES (?, ?, ?)
                ON CONFLICT(session_id) DO UPDATE SET
                    compacted_marker = excluded.compacted_marker,
                    highest_threshold = excluded.highest_threshold
                """,
                (thread_id, usage_marker, highest_usage_threshold),
            )
            evict_old_threads(connection, thread_id)
            connection.commit()
            return output_for(fragments) if fragments else ""
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
