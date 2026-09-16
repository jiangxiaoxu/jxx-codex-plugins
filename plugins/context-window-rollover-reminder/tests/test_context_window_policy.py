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


def write_rollout(path, session_id, thread_id, usage=None, compacted=None):
    rows = [
        record("session_meta", 0, {"id": thread_id, "session_id": session_id}),
        record(
            "event_msg",
            1,
            {
                "type": "task_started",
                "turn_id": "turn-1",
                "model_context_window": 500_000,
            },
        ),
    ]
    ordinal = 2
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
            self.assertEqual(reset_payload["thresholds"]["default"], [350_000, 400_000, 450_000])

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
