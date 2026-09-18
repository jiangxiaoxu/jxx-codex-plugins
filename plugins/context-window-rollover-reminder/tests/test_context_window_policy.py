import json
import os
from pathlib import Path
import sqlite3
import subprocess
import sys
import tempfile
import unittest


PLUGIN_ROOT = Path(__file__).parents[1]
HOOK_SCRIPT = PLUGIN_ROOT / "scripts" / "context_window_rollover_hook.py"
POLICY_SCRIPT = PLUGIN_ROOT / "scripts" / "context_window_policy.py"


def record(kind, ordinal, payload):
    return {"ordinal": ordinal, "type": kind, "payload": payload}


def write_rollout(
    path,
    session_id,
    thread_id,
    usage=None,
    compacted=None,
    capacity=500_000,
):
    rows = [record("session_meta", 0, {"id": thread_id, "session_id": session_id})]
    ordinal = 1
    if capacity is not None:
        rows.append(
            record(
                "event_msg",
                ordinal,
                {
                    "type": "task_started",
                    "turn_id": "turn-1",
                    "model_context_window": capacity,
                },
            )
        )
        ordinal += 1
    if compacted is not None:
        rows.append(record("compacted", ordinal, {}))
        ordinal += 1
    if usage is not None:
        rows.append(
            record(
                "token_usage_record",
                ordinal,
                {"turn_id": "turn-1", "usage": {"total_tokens": usage}},
            )
        )
    path.write_text(
        "\n".join(json.dumps(row) for row in rows) + "\n", encoding="utf-8"
    )


def append_usage(path, ordinal, usage):
    with path.open("a", encoding="utf-8") as stream:
        stream.write(
            json.dumps(
                record(
                    "token_usage_record",
                    ordinal,
                    {"turn_id": "turn-1", "usage": {"total_tokens": usage}},
                )
            )
            + "\n"
        )


def append_record(path, row):
    with path.open("a", encoding="utf-8") as stream:
        stream.write(json.dumps(row) + "\n")


def write_codex_index(path, rows=None, create_table=True):
    connection = sqlite3.connect(path)
    if create_table:
        connection.execute(
            "CREATE TABLE threads (id TEXT PRIMARY KEY, rollout_path TEXT)"
        )
        if rows:
            connection.executemany("INSERT INTO threads VALUES (?, ?)", rows)
    connection.commit()
    connection.close()


class ContextWindowPolicyTests(unittest.TestCase):
    def invoke_policy(self, state, command, thread_id="thread-a", extra_env=None):
        environment = os.environ.copy()
        environment.pop("CODEX_THREAD_ID", None)
        environment.pop("CODEX_SESSION_ID", None)
        if thread_id is not None:
            environment["CODEX_THREAD_ID"] = thread_id
        if extra_env:
            environment.update(extra_env)
        return subprocess.run(
            [sys.executable, str(POLICY_SCRIPT), "--state-db", str(state), *command],
            text=True,
            capture_output=True,
            env=environment,
            check=False,
        )

    def invoke_hook(self, transcript, state, session_id="session-a", model="gpt-5.6-sol"):
        request = {
            "session_id": session_id,
            "transcript_path": str(transcript),
            "hook_event_name": "PostToolUse",
            "model": model,
        }
        return subprocess.run(
            [sys.executable, str(HOOK_SCRIPT), "--state-db", str(state)],
            input=json.dumps(request),
            text=True,
            capture_output=True,
            check=False,
        )

    def invoke_usage(
        self,
        codex_state,
        thread_id="thread-a",
        session_id="session-a",
        extra_args=None,
        codex_home=None,
    ):
        environment = os.environ.copy()
        environment.pop("CODEX_THREAD_ID", None)
        environment.pop("CODEX_SESSION_ID", None)
        if thread_id is not None:
            environment["CODEX_THREAD_ID"] = thread_id
        if session_id is not None:
            environment["CODEX_SESSION_ID"] = session_id
        if codex_home is not None:
            environment["CODEX_HOME"] = str(codex_home)
        command = [
            sys.executable,
            str(POLICY_SCRIPT),
            "usage",
            "--codex-state-db",
            str(codex_state),
        ]
        if extra_args:
            command.extend(extra_args)
        return subprocess.run(
            command,
            text=True,
            capture_output=True,
            env=environment,
            check=False,
        )

    def test_missing_identity_and_invalid_values_fail_explicitly(self):
        with tempfile.TemporaryDirectory() as directory:
            state = Path(directory) / "state.sqlite3"
            missing = self.invoke_policy(state, ["show"], thread_id=None)
            self.assertEqual(missing.returncode, 3)
            self.assertIn("request-error", missing.stderr)
            self.assertIn("CODEX_THREAD_ID", missing.stderr)

            for values in (("0", "50"), ("150", "0"), ("150", "-1")):
                invalid = self.invoke_policy(
                    state,
                    ["set", "--start-k", values[0], "--interval-k", values[1]],
                )
                self.assertEqual(invalid.returncode, 3, invalid.stderr)
                self.assertIn("request-error", invalid.stderr)

            too_large = self.invoke_policy(
                state,
                [
                    "set",
                    "--start-k",
                    "9223372036854775",
                    "--interval-k",
                    "1",
                ],
            )
            self.assertEqual(too_large.returncode, 3)
            self.assertIn("SQLite", too_large.stderr)

    def test_set_show_reset_preserve_existing_v2_history(self):
        with tempfile.TemporaryDirectory() as directory:
            state = Path(directory) / "state.sqlite3"
            connection = sqlite3.connect(state)
            connection.execute(
                """
                CREATE TABLE session_state (
                    session_id TEXT PRIMARY KEY,
                    compacted_marker TEXT NOT NULL,
                    highest_stage INTEGER NOT NULL CHECK (highest_stage >= 0 AND highest_stage <= 3),
                    last_seen_at REAL NOT NULL
                )
                """
            )
            connection.execute(
                "INSERT INTO session_state VALUES (?, ?, ?, ?)",
                ("thread-a", "", 2, 10.0),
            )
            connection.commit()
            connection.close()

            configured = self.invoke_policy(
                state,
                ["set", "--start-k", "150", "--interval-k", "50"],
            )
            self.assertEqual(configured.returncode, 0, configured.stderr)
            self.assertEqual(
                json.loads(configured.stdout),
                {
                    "thread_id": "thread-a",
                    "mode": "custom",
                    "start_k": 150,
                    "interval_k": 50,
                    "thresholds": [150_000, 200_000, 250_000],
                },
            )

            shown = self.invoke_policy(state, ["show"])
            self.assertEqual(shown.returncode, 0, shown.stderr)
            self.assertEqual(json.loads(shown.stdout)["mode"], "custom")

            reset = self.invoke_policy(state, ["reset"])
            self.assertEqual(reset.returncode, 0, reset.stderr)
            reset_payload = json.loads(reset.stdout)
            self.assertEqual(reset_payload["mode"], "model_default")
            self.assertEqual(
                reset_payload["thresholds"],
                {
                    "strict": [300_000, 350_000, 400_000],
                    "luna": [400_000, 450_000, 500_000],
                    "default": [350_000, 400_000, 450_000],
                },
            )

            connection = sqlite3.connect(state)
            history = connection.execute(
                "SELECT highest_stage FROM session_state WHERE session_id = ?",
                ("thread-a",),
            ).fetchone()
            policy = connection.execute(
                "SELECT COUNT(*) FROM thread_policies WHERE thread_id = ?",
                ("thread-a",),
            ).fetchone()
            connection.close()
            self.assertEqual(history, (2,))
            self.assertEqual(policy, (0,))

    def test_custom_policy_overrides_model_and_isolated_by_thread(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            state = root / "state.sqlite3"
            thread_a = root / "thread-a.jsonl"
            thread_b = root / "thread-b.jsonl"
            write_rollout(thread_a, "session-a", "thread-a", usage=150_000)
            write_rollout(thread_b, "session-b", "thread-b", usage=200_000)
            configured = self.invoke_policy(
                state,
                ["set", "--start-k", "150", "--interval-k", "50"],
                thread_id="thread-a",
            )
            self.assertEqual(configured.returncode, 0, configured.stderr)

            custom = self.invoke_hook(thread_a, state)
            self.assertEqual(custom.returncode, 0, custom.stderr)
            self.assertIn("Context Window Usage: 150K", custom.stdout)

            default = self.invoke_hook(thread_b, state, session_id="session-b")
            self.assertEqual(default.returncode, 0, default.stderr)
            self.assertEqual(default.stdout, "")

            # A later custom stage and a model switch cannot replay an already
            # reported stage, while the sibling thread remains independent.
            append_usage(thread_a, 3, 200_000)
            stage_two = self.invoke_hook(thread_a, state)
            self.assertEqual(stage_two.returncode, 0, stage_two.stderr)
            self.assertIn("resumable stopping point", stage_two.stdout)
            repeat = self.invoke_hook(thread_a, state, model="gpt-5.6-luna")
            self.assertEqual(repeat.returncode, 0, repeat.stderr)
            self.assertEqual(repeat.stdout, "")

    def test_policy_survives_compaction_and_reset_keeps_highest_stage(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            state = root / "state.sqlite3"
            transcript = root / "rollout.jsonl"
            write_rollout(transcript, "session-a", "thread-a", usage=150_000)
            configured = self.invoke_policy(
                state,
                ["set", "--start-k", "150", "--interval-k", "50"],
            )
            self.assertEqual(configured.returncode, 0, configured.stderr)
            first = self.invoke_hook(transcript, state)
            self.assertIn("Context Window Usage: 150K", first.stdout)

            append_usage(transcript, 3, 200_000)
            second = self.invoke_hook(transcript, state)
            self.assertIn("resumable stopping point", second.stdout)
            reset = self.invoke_policy(state, ["reset"])
            self.assertEqual(reset.returncode, 0, reset.stderr)

            # Reset changes only policy selection; the already reported stage 2
            # remains in session_state and therefore the default model emits none.
            default_after_reset = self.invoke_hook(transcript, state)
            self.assertEqual(default_after_reset.returncode, 0, default_after_reset.stderr)
            self.assertEqual(default_after_reset.stdout, "")

            # Re-enable a custom policy before compaction.  The policy row itself
            # must survive the marker change; no CLI write occurs after compaction.
            configured_again = self.invoke_policy(
                state,
                ["set", "--start-k", "150", "--interval-k", "50"],
            )
            self.assertEqual(configured_again.returncode, 0, configured_again.stderr)
            write_rollout(
                transcript,
                "session-a",
                "thread-a",
                usage=150_000,
                compacted="marker-1",
            )
            after_compaction = self.invoke_hook(transcript, state)
            self.assertEqual(after_compaction.returncode, 0, after_compaction.stderr)
            self.assertIn("Context Window Usage: 150K", after_compaction.stdout)
            persisted = self.invoke_policy(state, ["show"])
            self.assertEqual(json.loads(persisted.stdout)["mode"], "custom")

    def test_usage_reports_effective_window_without_policy_or_index_writes(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            transcript = root / "rollout.jsonl"
            codex_state = root / "state_5.sqlite"
            codex_home = root / "codex-home"
            write_rollout(
                transcript,
                "session-a",
                "thread-a",
                usage=73_000,
                capacity=800_000,
            )
            write_codex_index(codex_state, [("thread-a", str(transcript))])
            before = codex_state.read_bytes()

            result = self.invoke_usage(
                codex_state,
                codex_home=codex_home,
            )
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertEqual(
                json.loads(result.stdout),
                {
                    "thread_id": "thread-a",
                    "used_tokens": 73_000,
                    "model_context_window": 800_000,
                    "effective_window_tokens": 680_000,
                    "used_percent": 11,
                    "display": "73K/680K (11% used)",
                },
            )
            self.assertEqual(codex_state.read_bytes(), before)
            self.assertFalse(
                (codex_home / "state" / "context-window-rollover-reminder-v2.sqlite3").exists()
            )

            # Percentages remain above 100 rather than being clamped.
            write_rollout(
                transcript,
                "session-a",
                "thread-a",
                usage=900_000,
                capacity=800_000,
            )
            over_window = self.invoke_usage(codex_state, codex_home=codex_home)
            self.assertEqual(over_window.returncode, 0, over_window.stderr)
            self.assertEqual(json.loads(over_window.stdout)["used_percent"], 132)
            self.assertEqual(
                json.loads(over_window.stdout)["display"], "900K/680K (132% used)"
            )

    def test_usage_requires_both_identities_and_rejects_policy_state_db(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            codex_state = root / "state_5.sqlite"
            missing_thread = self.invoke_usage(codex_state, thread_id=None)
            self.assertEqual(missing_thread.returncode, 3)
            self.assertIn("CODEX_THREAD_ID", missing_thread.stderr)
            missing_session = self.invoke_usage(codex_state, session_id=None)
            self.assertEqual(missing_session.returncode, 3)
            self.assertIn("CODEX_SESSION_ID", missing_session.stderr)

            policy_state = root / "policy.sqlite3"
            rejected = self.invoke_usage(
                codex_state,
                extra_args=["--state-db", str(policy_state)],
            )
            self.assertEqual(rejected.returncode, 3)
            self.assertIn("only for policy state", rejected.stderr)
            self.assertFalse(policy_state.exists())

    def test_usage_identity_compaction_and_capacity_failures_are_explicit(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            transcript = root / "rollout.jsonl"
            codex_state = root / "state_5.sqlite"
            write_rollout(
                transcript,
                "session-a",
                "thread-a",
                usage=73_000,
                capacity=800_000,
            )
            write_codex_index(codex_state, [("thread-a", str(transcript))])

            wrong_session = self.invoke_usage(codex_state, session_id="session-b")
            self.assertEqual(wrong_session.returncode, 6)
            self.assertIn("identity-error", wrong_session.stderr)
            wrong_thread = self.invoke_usage(codex_state, thread_id="thread-b")
            self.assertEqual(wrong_thread.returncode, 7)
            self.assertIn("state-error", wrong_thread.stderr)

            append_record(transcript, record("compacted", 3, {}))
            stale = self.invoke_usage(codex_state)
            self.assertEqual(stale.returncode, 5)
            self.assertIn("transcript-error", stale.stderr)
            self.assertIn("no current token usage", stale.stderr)

            no_capacity = root / "no-capacity.jsonl"
            write_rollout(
                no_capacity,
                "session-a",
                "thread-a",
                usage=73_000,
                capacity=None,
            )
            connection = sqlite3.connect(codex_state)
            connection.execute(
                "UPDATE threads SET rollout_path = ? WHERE id = ?",
                (str(no_capacity), "thread-a"),
            )
            connection.commit()
            connection.close()
            missing_capacity = self.invoke_usage(codex_state)
            self.assertEqual(missing_capacity.returncode, 5)
            self.assertIn("model context window", missing_capacity.stderr)

    def test_usage_locator_requires_readable_index_table_row_and_path(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            no_table = root / "no-table.sqlite"
            write_codex_index(no_table, create_table=False)
            missing_table = self.invoke_usage(no_table)
            self.assertEqual(missing_table.returncode, 7)
            self.assertIn("threads index", missing_table.stderr)

            no_row = root / "no-row.sqlite"
            write_codex_index(no_row, [])
            missing_row = self.invoke_usage(no_row)
            self.assertEqual(missing_row.returncode, 7)
            self.assertIn("no thread record", missing_row.stderr)

            no_path = root / "no-path.sqlite"
            write_codex_index(no_path, [("thread-a", None)])
            missing_path = self.invoke_usage(no_path)
            self.assertEqual(missing_path.returncode, 7)
            self.assertIn("rollout_path", missing_path.stderr)

    def test_malformed_schema_and_invalid_policy_fail_without_fallback(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            missing_column = root / "missing.sqlite3"
            connection = sqlite3.connect(missing_column)
            connection.execute(
                "CREATE TABLE session_state (session_id TEXT PRIMARY KEY, compacted_marker TEXT NOT NULL, highest_stage INTEGER NOT NULL, last_seen_at REAL NOT NULL)"
            )
            connection.execute(
                "CREATE TABLE thread_policies (thread_id TEXT PRIMARY KEY, start_k INTEGER NOT NULL)"
            )
            connection.commit()
            connection.close()
            before = missing_column.read_bytes()
            malformed = self.invoke_policy(missing_column, ["show"])
            self.assertEqual(malformed.returncode, 7)
            self.assertIn("state-error", malformed.stderr)
            self.assertEqual(missing_column.read_bytes(), before)

            invalid_row = root / "invalid.sqlite3"
            connection = sqlite3.connect(invalid_row)
            connection.execute(
                "CREATE TABLE session_state (session_id TEXT PRIMARY KEY, compacted_marker TEXT NOT NULL, highest_stage INTEGER NOT NULL, last_seen_at REAL NOT NULL)"
            )
            connection.execute(
                "CREATE TABLE thread_policies (thread_id TEXT PRIMARY KEY, start_k INTEGER NOT NULL, interval_k INTEGER NOT NULL, updated_at REAL NOT NULL)"
            )
            connection.execute(
                "INSERT INTO thread_policies VALUES (?, ?, ?, ?)",
                ("thread-a", 0, 50, 1.0),
            )
            connection.commit()
            connection.close()
            invalid = self.invoke_policy(invalid_row, ["show"])
            self.assertEqual(invalid.returncode, 7)
            self.assertIn("invalid thread policy", invalid.stderr)

            transcript = root / "no-usage.jsonl"
            write_rollout(transcript, "session-a", "thread-a", usage=None)
            hook_invalid = self.invoke_hook(transcript, invalid_row)
            self.assertEqual(hook_invalid.returncode, 7)
            self.assertIn("state-error", hook_invalid.stderr)

    def test_composite_policy_key_is_rejected(self):
        with tempfile.TemporaryDirectory() as directory:
            state = Path(directory) / "composite.sqlite3"
            connection = sqlite3.connect(state)
            connection.execute(
                "CREATE TABLE session_state (session_id TEXT PRIMARY KEY, compacted_marker TEXT NOT NULL, highest_stage INTEGER NOT NULL, last_seen_at REAL NOT NULL)"
            )
            connection.execute(
                "CREATE TABLE thread_policies (thread_id TEXT, other TEXT, start_k INTEGER NOT NULL, interval_k INTEGER NOT NULL, updated_at REAL NOT NULL, PRIMARY KEY(thread_id, other))"
            )
            connection.commit()
            connection.close()
            result = self.invoke_policy(state, ["show"])
            self.assertEqual(result.returncode, 7)
            self.assertIn("primary key", result.stderr)


if __name__ == "__main__":
    unittest.main()
