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
    ensure_state_schema,
    policy_thresholds,
    read_thread_policy,
    validate_policy_values,
    default_state_db,
)


def require_thread_id() -> str:
    """Return the explicitly supplied current thread identity."""

    thread_id = os.environ.get("CODEX_THREAD_ID")
    if not isinstance(thread_id, str) or not thread_id.strip():
        raise RequestError("CODEX_THREAD_ID is required; thread identity cannot be inferred")
    return thread_id


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
            raise RequestError("a command is required: show, set, or reset")
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
