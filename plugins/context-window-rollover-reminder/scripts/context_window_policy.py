"""Manage a manually selected context rollover policy for the current thread."""

from __future__ import annotations

import argparse
import json
import os
from pathlib import Path
import sqlite3
import sys
import time

from context_window_rollover_hook import (
    DEFAULT_THRESHOLDS,
    EXIT_REQUEST_ERROR,
    HookError,
    RequestError,
    SQLITE_TIMEOUT_SECONDS,
    STRICT_THRESHOLDS,
    StateError,
    TranscriptError,
    ensure_state_schema,
    policy_thresholds,
    read_thread_policy,
    read_rollout,
    validate_policy_values,
    default_state_db,
)


EFFECTIVE_WINDOW_NUMERATOR = 85
EFFECTIVE_WINDOW_DENOMINATOR = 100
DEFAULT_CODEX_STATE_DB_NAME = "state_5.sqlite"


def require_thread_id() -> str:
    """Return the explicitly supplied current thread identity."""

    thread_id = os.environ.get("CODEX_THREAD_ID")
    if not isinstance(thread_id, str) or not thread_id.strip():
        raise RequestError("CODEX_THREAD_ID is required; thread identity cannot be inferred")
    return thread_id


def require_session_id() -> str:
    """Return the session identity required to validate the located transcript."""

    session_id = os.environ.get("CODEX_SESSION_ID")
    if not isinstance(session_id, str) or not session_id.strip():
        raise RequestError(
            "CODEX_SESSION_ID is required for usage; session identity cannot be inferred"
        )
    return session_id


def default_codex_state_db() -> Path:
    codex_home = Path(os.environ.get("CODEX_HOME", Path.home() / ".codex"))
    return codex_home / DEFAULT_CODEX_STATE_DB_NAME


def locate_rollout_path(codex_state_db: Path, thread_id: str) -> Path:
    """Locate exactly one thread transcript through the Codex index, read-only."""

    try:
        readonly_uri = f"{codex_state_db.resolve().as_uri()}?mode=ro"
        connection = sqlite3.connect(
            readonly_uri, uri=True, timeout=SQLITE_TIMEOUT_SECONDS
        )
    except (OSError, ValueError, sqlite3.Error) as error:
        raise StateError(
            f"cannot open Codex state database read-only: {error}"
        ) from error
    try:
        try:
            row = connection.execute(
                "SELECT rollout_path FROM threads WHERE id = ?", (thread_id,)
            ).fetchone()
        except sqlite3.Error as error:
            raise StateError(
                f"Codex state database has no usable threads index: {error}"
            ) from error
    finally:
        connection.close()
    if row is None:
        raise StateError(
            f"Codex state database has no thread record for CODEX_THREAD_ID {thread_id}"
        )
    rollout_path = row[0]
    if not isinstance(rollout_path, str) or not rollout_path.strip():
        raise StateError(f"thread {thread_id} has no valid rollout_path")
    return Path(rollout_path)


def round_percent_half_up(used_tokens: int, effective_window_tokens: int) -> int:
    """Round a non-negative percentage to the nearest integer, half up."""

    return (
        used_tokens * 100 * 2 + effective_window_tokens
    ) // (effective_window_tokens * 2)


def usage_output(
    thread_id: str,
    used_tokens: int,
    model_context_window: int,
) -> dict[str, object]:
    effective_window_tokens = (
        model_context_window * EFFECTIVE_WINDOW_NUMERATOR
    ) // EFFECTIVE_WINDOW_DENOMINATOR
    if effective_window_tokens <= 0:
        raise TranscriptError(
            "transcript has a model context window with a non-positive effective usage window"
        )
    used_percent = round_percent_half_up(used_tokens, effective_window_tokens)
    used_k = used_tokens // 1_000
    effective_k = effective_window_tokens // 1_000
    return {
        "thread_id": thread_id,
        "used_tokens": used_tokens,
        "model_context_window": model_context_window,
        "effective_window_tokens": effective_window_tokens,
        "used_percent": used_percent,
        "display": f"{used_k}K/{effective_k}K ({used_percent}% used)",
    }


def execute_usage(
    codex_state_db: Path, thread_id: str, session_id: str
) -> dict[str, object]:
    """Read current usage from the Codex index and transcript without writes."""

    transcript_path = locate_rollout_path(codex_state_db, thread_id)
    found_thread_id, _compacted_marker, used_tokens, model_context_window = read_rollout(
        transcript_path, session_id, thread_id
    )
    if used_tokens is None:
        raise TranscriptError("transcript has no current token usage after the latest compaction")
    if model_context_window is None:
        raise TranscriptError(
            "transcript has no model context window for the latest token usage"
        )
    return usage_output(found_thread_id, used_tokens, model_context_window)


def policy_output(thread_id: str, policy: tuple[int, int] | None) -> dict[str, object]:
    """Build the stable JSON result returned by every command."""

    if policy is None:
        return {
            "thread_id": thread_id,
            "mode": "model_default",
            "start_k": None,
            "interval_k": None,
            "thresholds": {
                "strict": list(STRICT_THRESHOLDS),
                "default": list(DEFAULT_THRESHOLDS),
            },
        }
    start_k, interval_k = policy
    return {
        "thread_id": thread_id,
        "mode": "custom",
        "start_k": start_k,
        "interval_k": interval_k,
        "thresholds": list(policy_thresholds(start_k, interval_k)),
    }


def execute(
    command: str,
    state_db: Path,
    thread_id: str,
    start_k: int | None = None,
    interval_k: int | None = None,
) -> dict[str, object]:
    """Execute one policy operation under the hook database transaction."""

    if command == "set":
        try:
            policy = validate_policy_values(start_k, interval_k)
        except ValueError as error:
            raise RequestError(str(error)) from error
    else:
        policy = None

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
            # Validate both the existing v2 history table and the independent policy
            # table before any command mutates the database.
            ensure_state_schema(connection)
            connection.commit()
            connection.execute("BEGIN IMMEDIATE")
            if command == "set":
                assert policy is not None
                connection.execute(
                    """
                    INSERT INTO thread_policies(thread_id, start_k, interval_k, updated_at)
                    VALUES (?, ?, ?, ?)
                    ON CONFLICT(thread_id) DO UPDATE SET
                        start_k = excluded.start_k,
                        interval_k = excluded.interval_k,
                        updated_at = excluded.updated_at
                    """,
                    (thread_id, policy[0], policy[1], time.time()),
                )
                result_policy = read_thread_policy(connection, thread_id)
            elif command == "reset":
                connection.execute(
                    "DELETE FROM thread_policies WHERE thread_id = ?", (thread_id,)
                )
                result_policy = None
            elif command == "show":
                result_policy = read_thread_policy(connection, thread_id)
            else:
                raise RequestError(f"unknown policy command: {command}")
            result = policy_output(thread_id, result_policy)
            connection.commit()
            return result
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


class PolicyArgumentParser(argparse.ArgumentParser):
    def error(self, message: str) -> None:
        self.print_usage(sys.stderr)
        self.exit(
            EXIT_REQUEST_ERROR,
            f"context-window-policy: {RequestError.category} (exit {EXIT_REQUEST_ERROR}): {message}\n",
        )


def build_parser() -> argparse.ArgumentParser:
    parser = PolicyArgumentParser(description=__doc__)
    parser.add_argument("--state-db", type=Path, default=None)
    parser.add_argument("--codex-state-db", type=Path, default=None)
    commands = parser.add_subparsers(dest="command")
    for name in ("show", "reset"):
        command = commands.add_parser(name, help=f"{name} the current thread policy")
        # Accept --state-db after the subcommand as well as before it.  SUPPRESS
        # keeps a value supplied before the subcommand intact.
        command.add_argument("--state-db", type=Path, default=argparse.SUPPRESS)
    set_command = commands.add_parser("set", help="set the current thread policy")
    set_command.add_argument("--start-k", type=int, required=True)
    set_command.add_argument("--interval-k", type=int, required=True)
    set_command.add_argument("--state-db", type=Path, default=argparse.SUPPRESS)
    usage_command = commands.add_parser(
        "usage", help="show current token usage for the current thread"
    )
    usage_command.add_argument("--state-db", type=Path, default=argparse.SUPPRESS)
    usage_command.add_argument(
        "--codex-state-db", type=Path, default=argparse.SUPPRESS
    )
    return parser


def report_error(error: HookError) -> None:
    print(
        f"context-window-policy: {error.category} (exit {error.exit_code}): {error}",
        file=sys.stderr,
    )


def main(argv: list[str] | None = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)
    try:
        if args.command is None:
            raise RequestError("a command is required: show, set, reset, or usage")
        if args.command == "usage":
            if args.state_db is not None:
                raise RequestError(
                    "usage reads the Codex index; --state-db is only for policy state"
                )
            thread_id = require_thread_id()
            session_id = require_session_id()
            codex_state_db = args.codex_state_db or default_codex_state_db()
            result = execute_usage(codex_state_db, thread_id, session_id)
        else:
            if args.codex_state_db is not None:
                raise RequestError("--codex-state-db is only valid with usage")
            thread_id = require_thread_id()
            state_db = args.state_db or default_state_db()
            result = execute(
                args.command,
                state_db,
                thread_id,
                getattr(args, "start_k", None),
                getattr(args, "interval_k", None),
            )
    except HookError as error:
        report_error(error)
        return error.exit_code
    print(json.dumps(result, ensure_ascii=True, separators=(",", ":")))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
