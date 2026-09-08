import json
from concurrent.futures import ThreadPoolExecutor
import os
from pathlib import Path
import shutil
import subprocess
import sqlite3
import sys
import tempfile
import unittest


SCRIPT = Path(__file__).parents[1] / "scripts" / "context_window_usage_hook.py"
HOOKS = Path(__file__).parents[1] / "hooks" / "hooks.json"


def record(kind, ordinal, payload):
    return {"ordinal": ordinal, "type": kind, "payload": payload}


def rollout(
    path,
    session_id,
    usage=None,
    capacity=None,
    turn_id="turn-1",
    thread_id=None,
):
    thread_id = thread_id or session_id
    rows = [record("session_meta", 0, {"id": thread_id, "session_id": session_id})]
    if capacity is not None:
        rows.append(
            record(
                "event_msg",
                1,
                {
                    "type": "task_started",
                    "turn_id": turn_id,
                    "model_context_window": capacity,
                },
            )
        )
    if usage is not None:
        rows.append(
            record(
                "token_usage_record",
                2,
                {
                    "turn_id": turn_id,
                    "usage": {"total_tokens": usage},
                },
            )
        )
    path.write_text("\n".join(json.dumps(row) for row in rows) + "\n", encoding="utf-8")


def append_record(path, row):
    with path.open("a", encoding="utf-8") as stream:
        stream.write(json.dumps(row) + "\n")


def context_text(result):
    return json.loads(result.stdout)["hookSpecificOutput"]["additionalContext"]


class ContextUsageHookTests(unittest.TestCase):
    def invoke(self, transcript, state, session_id="session-1", agent_id=None):
        request = {
            "session_id": session_id,
            "transcript_path": str(transcript),
            "hook_event_name": "PostToolUse",
        }
        if agent_id is not None:
            request["agent_id"] = agent_id
        return subprocess.run(
            [sys.executable, str(SCRIPT), "--state-db", str(state)],
            input=json.dumps(request),
            text=True,
            capture_output=True,
            check=False,
        )

    def assert_context(self, result, expected_used_k=None):
        context = context_text(result)
        self.assertTrue(context)
        if expected_used_k is not None:
            self.assertEqual(
                f"[Context window usage reminder] Current context window usage is {expected_used_k} K tokens.",
                context,
            )

    def invoke_raw(self, request, state, *extra_args):
        return subprocess.run(
            [sys.executable, str(SCRIPT), "--state-db", str(state), *extra_args],
            input=request,
            text=True,
            capture_output=True,
            check=False,
        )

    def test_request_and_cli_errors_return_three_and_help_succeeds(self):
        with tempfile.TemporaryDirectory() as directory:
            state = Path(directory) / "state.sqlite3"

            invalid_json = self.invoke_raw("{", state)
            self.assertEqual(invalid_json.returncode, 3)
            self.assertEqual(invalid_json.stdout, "")
            self.assertIn("request-error", invalid_json.stderr)

            missing_fields = self.invoke_raw("{}", state)
            self.assertEqual(missing_fields.returncode, 3)
            self.assertIn("request-error", missing_fields.stderr)

            invalid_cli = subprocess.run(
                [sys.executable, str(SCRIPT), "--unknown"],
                input="{}",
                text=True,
                capture_output=True,
                check=False,
            )
            self.assertEqual(invalid_cli.returncode, 3)
            self.assertIn("request-error", invalid_cli.stderr)

            help_result = subprocess.run(
                [sys.executable, str(SCRIPT), "--help"],
                text=True,
                capture_output=True,
                check=False,
            )
            self.assertEqual(help_result.returncode, 0)

    def test_discovered_command_runs_through_powershell(self):
        hooks = json.loads(HOOKS.read_text(encoding="utf-8"))
        command = hooks["hooks"]["PostToolUse"][0]["hooks"][0]["command"]
        with tempfile.TemporaryDirectory(prefix="context hook shell ") as directory:
            root = Path(directory)
            plugin_root = root / "plugin root with spaces"
            script_dir = plugin_root / "scripts"
            script_dir.mkdir(parents=True)
            shutil.copy2(SCRIPT, script_dir / SCRIPT.name)
            transcript = root / "transcript data" / "rollout.jsonl"
            transcript.parent.mkdir()
            rollout(transcript, "session-1", usage=250_000, capacity=500_000)
            request = json.dumps(
                {
                    "session_id": "session-1",
                    "transcript_path": str(transcript),
                    "hook_event_name": "PostToolUse",
                }
            )
            environment = os.environ.copy()
            environment["PLUGIN_ROOT"] = str(plugin_root)
            environment["CODEX_HOME"] = str(root / "state with spaces")
            result = subprocess.run(
                ["pwsh", "-NoProfile", "-Command", command],
                input=request,
                text=True,
                capture_output=True,
                env=environment,
                check=False,
            )
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assert_context(result, expected_used_k=250)

    def test_unreadable_transcript_returns_four(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            result = self.invoke(root / "missing.jsonl", root / "state.sqlite3")

            self.assertEqual(result.returncode, 4)
            self.assertEqual(result.stdout, "")
            self.assertIn("transcript-io-error", result.stderr)

    def test_invalid_transcript_returns_five(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            transcript = root / "rollout.jsonl"
            transcript.write_text("{not valid JSON\n", encoding="utf-8")

            result = self.invoke(transcript, root / "state.sqlite3")

            self.assertEqual(result.returncode, 5)
            self.assertEqual(result.stdout, "")
            self.assertIn("transcript-error", result.stderr)

    def test_unterminated_invalid_utf8_tail_is_ignored_after_valid_prefix(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            transcript = root / "rollout.jsonl"
            state = root / "state.sqlite3"
            rollout(transcript, "session-1", usage=250_000, capacity=500_000)
            with transcript.open("ab") as stream:
                stream.write(b'{"type":"event_msg","payload":{"text":"\xe4\xb8')

            result = self.invoke(transcript, state)

            self.assertEqual(result.returncode, 0, result.stderr)
            self.assert_context(result)

    def test_unterminated_valid_final_record_is_processed(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            transcript = root / "rollout.jsonl"
            state = root / "state.sqlite3"
            rollout(transcript, "session-1", usage=250_000, capacity=500_000)
            transcript.write_bytes(transcript.read_bytes().rstrip(b"\n"))

            result = self.invoke(transcript, state)

            self.assertEqual(result.returncode, 0, result.stderr)
            self.assert_context(result)

    def test_middle_or_terminated_invalid_line_returns_five(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            middle = root / "middle.jsonl"
            terminated = root / "terminated.jsonl"
            middle_state = root / "middle.sqlite3"
            terminated_state = root / "terminated.sqlite3"
            session = json.dumps(
                record(
                    "session_meta", 0, {"id": "session-1", "session_id": "session-1"}
                )
            ).encode()
            usage = json.dumps(
                record(
                    "token_usage_record",
                    2,
                    {"turn_id": "turn-1", "usage": {"total_tokens": 250_000}},
                )
            ).encode()
            middle.write_bytes(session + b"\n{not valid JSON\n" + usage + b"\n")
            terminated.write_bytes(session + b"\n" + usage + b"\n{not valid JSON\n")

            middle_result = self.invoke(middle, middle_state)
            terminated_result = self.invoke(terminated, terminated_state)

            for result in (middle_result, terminated_result):
                self.assertEqual(result.returncode, 5)
                self.assertEqual(result.stdout, "")
                self.assertIn("transcript-error", result.stderr)

    def test_missing_session_meta_returns_five(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            transcript = root / "rollout.jsonl"
            transcript.write_text("", encoding="utf-8")

            result = self.invoke(transcript, root / "state.sqlite3")

            self.assertEqual(result.returncode, 5)
            self.assertEqual(result.stdout, "")
            self.assertIn("transcript-error", result.stderr)
            self.assertIn("no session_meta", result.stderr)

    def test_missing_session_meta_with_unterminated_tail_returns_five(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            transcript = root / "rollout.jsonl"
            transcript.write_bytes(b'{"type":"session_meta"')

            result = self.invoke(transcript, root / "state.sqlite3")

            self.assertEqual(result.returncode, 5)
            self.assertEqual(result.stdout, "")
            self.assertIn("transcript-error", result.stderr)
            self.assertIn("no session_meta", result.stderr)

    def test_unhashable_transcript_fields_return_five(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            transcript = root / "rollout.jsonl"
            state = root / "state.sqlite3"
            transcript.write_text(
                json.dumps({"type": [], "payload": {}}) + "\n", encoding="utf-8"
            )

            invalid_type = self.invoke(transcript, state)
            self.assertEqual(invalid_type.returncode, 5)
            self.assertIn("transcript-error", invalid_type.stderr)

            rollout(transcript, "session-1", usage=200_000, capacity=500_000)
            append_record(
                transcript,
                record(
                    "token_usage_record",
                    3,
                    {"turn_id": ["bad"], "usage": {"total_tokens": 200_000}},
                ),
            )
            invalid_turn = self.invoke(transcript, state)
            self.assertEqual(invalid_turn.returncode, 5)
            self.assertIn("transcript-error", invalid_turn.stderr)

    def test_invalid_state_returns_seven(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            transcript = root / "rollout.jsonl"
            state = root / "state.sqlite3"
            rollout(transcript, "session-1", usage=250_000, capacity=500_000)
            state.mkdir()

            result = self.invoke(transcript, state)

            self.assertEqual(result.returncode, 7)
            self.assertEqual(result.stdout, "")
            self.assertIn("state-error", result.stderr)

    def test_crossing_is_announced_once(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            transcript = root / "rollout.jsonl"
            state = root / "state.sqlite3"
            rollout(transcript, "session-1", usage=250_000, capacity=500_000)

            first = self.invoke(transcript, state)
            second = self.invoke(transcript, state)

            self.assertEqual(first.returncode, 0, first.stderr)
            self.assert_context(first)
            self.assertEqual(second.returncode, 0, second.stderr)
            self.assertEqual(second.stdout, "")

    def test_concurrent_crossing_emits_one_message(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            transcript = root / "rollout.jsonl"
            state = root / "state.sqlite3"
            rollout(transcript, "session-1", usage=250_000, capacity=500_000)
            request = json.dumps(
                {"session_id": "session-1", "transcript_path": str(transcript)}
            )
            processes = [
                subprocess.Popen(
                    [sys.executable, str(SCRIPT), "--state-db", str(state)],
                    stdin=subprocess.PIPE,
                    stdout=subprocess.PIPE,
                    stderr=subprocess.PIPE,
                    text=True,
                )
                for _ in range(2)
            ]
            with ThreadPoolExecutor(max_workers=2) as executor:
                futures = [executor.submit(process.communicate, request) for process in processes]
                results = []
                for process, future in zip(processes, futures):
                    output, error = future.result()
                    results.append((process.returncode, output, error))

            self.assertTrue(all(code == 0 for code, _, error in results), results)
            self.assertEqual(sum(bool(output) for _, output, _ in results), 1)

    def test_compaction_waits_for_fresh_usage(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            transcript = root / "rollout.jsonl"
            state = root / "state.sqlite3"
            rollout(transcript, "session-1", usage=250_000, capacity=500_000)
            self.assertTrue(self.invoke(transcript, state).stdout)

            append_record(transcript, record("compacted", 3, {"message": ""}))
            waiting = self.invoke(transcript, state)
            self.assertEqual(waiting.returncode, 0, waiting.stderr)
            self.assertEqual(waiting.stdout, "")

            append_record(
                transcript,
                record(
                    "event_msg",
                    4,
                    {
                        "type": "task_started",
                        "turn_id": "turn-2",
                        "model_context_window": 500_000,
                    },
                ),
            )
            append_record(
                transcript,
                record(
                    "token_usage_record",
                    5,
                    {"turn_id": "turn-2", "usage": {"total_tokens": 210_000}},
                ),
            )
            fresh = self.invoke(transcript, state)
            self.assertEqual(fresh.returncode, 0, fresh.stderr)
            self.assert_context(fresh, expected_used_k=210)

    def test_new_window_reannounces_same_bucket(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            transcript = root / "rollout.jsonl"
            state = root / "state.sqlite3"
            rollout(transcript, "session-1", usage=250_000, capacity=500_000)
            first = self.invoke(transcript, state)
            append_record(transcript, record("compacted", 3, {}))
            append_record(
                transcript,
                record(
                    "token_usage_record",
                    4,
                    {"turn_id": "turn-1", "usage": {"total_tokens": 250_000}},
                ),
            )
            second = self.invoke(transcript, state)

            self.assertEqual(first.returncode, 0, first.stderr)
            self.assertEqual(second.returncode, 0, second.stderr)
            self.assert_context(first)
            self.assert_context(second)

    def test_unknown_capacity_is_not_reported_as_zero(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            transcript = root / "rollout.jsonl"
            state = root / "state.sqlite3"
            rollout(transcript, "session-1", usage=210_000)

            result = self.invoke(transcript, state)

            self.assertEqual(result.returncode, 0, result.stderr)
            self.assert_context(result, expected_used_k=210)

    def test_below_first_threshold_is_silent_and_each_step_is_reported(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            transcript = root / "rollout.jsonl"
            state = root / "state.sqlite3"
            rollout(transcript, "session-1", usage=200_000, capacity=500_000)

            cases = [
                (200_000, None),
                (209_999, None),
                (210_000, 210),
                (210_000, None),
                (250_000, None),
                (259_999, None),
                (260_000, 260),
                (300_000, None),
                (309_999, None),
                (310_000, 310),
            ]
            for ordinal, (used, expected_used_k) in enumerate(cases, start=3):
                with self.subTest(used=used, expected_used_k=expected_used_k):
                    append_record(
                        transcript,
                        record(
                            "token_usage_record",
                            ordinal,
                            {"turn_id": "turn-1", "usage": {"total_tokens": used}},
                        ),
                    )
                    result = self.invoke(transcript, state)
                    self.assertEqual(result.returncode, 0, result.stderr)
                    if expected_used_k is None:
                        self.assertEqual(result.stdout, "")
                    else:
                        self.assert_context(result, expected_used_k=expected_used_k)

    def test_thread_keys_isolate_parent_and_sibling_agents(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            state = root / "state.sqlite3"
            parent = root / "parent.jsonl"
            child_a = root / "child-a.jsonl"
            child_b = root / "child-b.jsonl"
            rollout(parent, "shared-session", usage=250_000, capacity=500_000, thread_id="parent-thread")
            rollout(child_a, "shared-session", usage=250_000, capacity=500_000, thread_id="child-a")
            rollout(child_b, "shared-session", usage=250_000, capacity=500_000, thread_id="child-b")

            parent_result = self.invoke(parent, state, session_id="shared-session")
            child_a_result = self.invoke(
                child_a, state, session_id="shared-session", agent_id="child-a"
            )
            child_a_repeat = self.invoke(
                child_a, state, session_id="shared-session", agent_id="child-a"
            )
            child_b_result = self.invoke(
                child_b, state, session_id="shared-session", agent_id="child-b"
            )

            self.assert_context(parent_result)
            self.assert_context(child_a_result)
            self.assertEqual(child_a_repeat.returncode, 0, child_a_repeat.stderr)
            self.assertEqual(child_a_repeat.stdout, "")
            self.assert_context(child_b_result)

    def test_first_session_meta_is_canonical_for_inherited_history(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            transcript = root / "child.jsonl"
            state = root / "state.sqlite3"
            rollout(
                transcript,
                "shared-session",
                usage=250_000,
                capacity=500_000,
                thread_id="child-thread",
            )
            append_record(
                transcript,
                record(
                    "session_meta",
                    3,
                    {"id": "parent-thread", "session_id": "shared-session"},
                ),
            )

            result = self.invoke(
                transcript,
                state,
                session_id="shared-session",
                agent_id="child-thread",
            )

            self.assertEqual(result.returncode, 0, result.stderr)
            self.assert_context(result, expected_used_k=250)
            connection = sqlite3.connect(state)
            keys = {
                row[0] for row in connection.execute("SELECT session_id FROM session_state")
            }
            connection.close()
            self.assertEqual(keys, {"child-thread"})

    def test_matching_later_session_meta_cannot_mask_first_identity_mismatch(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            transcript = root / "rollout.jsonl"
            state = root / "state.sqlite3"
            rollout(
                transcript,
                "wrong-session",
                usage=250_000,
                capacity=500_000,
                thread_id="wrong-thread",
            )
            append_record(
                transcript,
                record(
                    "session_meta",
                    3,
                    {"id": "child-thread", "session_id": "shared-session"},
                ),
            )

            result = self.invoke(
                transcript,
                state,
                session_id="shared-session",
                agent_id="child-thread",
            )

            self.assertEqual(result.returncode, 6)
            self.assertEqual(result.stdout, "")
            self.assertIn("identity-error", result.stderr)

    def test_matching_later_session_meta_cannot_mask_invalid_first_meta(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            transcript = root / "rollout.jsonl"
            state = root / "state.sqlite3"
            rows = [
                record("session_meta", 0, {"session_id": "shared-session"}),
                record(
                    "session_meta",
                    1,
                    {"id": "child-thread", "session_id": "shared-session"},
                ),
                record(
                    "token_usage_record",
                    2,
                    {"turn_id": "turn-1", "usage": {"total_tokens": 250_000}},
                ),
            ]
            transcript.write_text(
                "\n".join(json.dumps(row) for row in rows) + "\n", encoding="utf-8"
            )

            result = self.invoke(
                transcript,
                state,
                session_id="shared-session",
                agent_id="child-thread",
            )

            self.assertEqual(result.returncode, 5)
            self.assertEqual(result.stdout, "")
            self.assertIn("transcript-error", result.stderr)

    def test_session_id_mismatch_fails(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            transcript = root / "rollout.jsonl"
            state = root / "state.sqlite3"
            rollout(transcript, "rollout-session", usage=250_000, capacity=500_000, thread_id="thread")

            result = self.invoke(transcript, state, session_id="hook-session")

            self.assertEqual(result.returncode, 6)
            self.assertEqual(result.stdout, "")
            self.assertIn("identity-error", result.stderr)
            self.assertIn("session ID does not match", result.stderr)

    def test_agent_id_mismatch_fails(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            transcript = root / "rollout.jsonl"
            state = root / "state.sqlite3"
            rollout(transcript, "shared-session", usage=250_000, capacity=500_000, thread_id="child-a")

            result = self.invoke(
                transcript, state, session_id="shared-session", agent_id="child-b"
            )

            self.assertEqual(result.returncode, 6)
            self.assertEqual(result.stdout, "")
            self.assertIn("identity-error", result.stderr)
            self.assertIn("thread ID does not match hook agent_id", result.stderr)

    def test_migrates_legacy_state_and_preserves_bucket(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            transcript = root / "rollout.jsonl"
            state = root / "state.sqlite3"
            rollout(
                transcript,
                "session-1",
                usage=210_000,
                capacity=500_000,
                thread_id="session-1",
            )
            append_record(transcript, record("compacted", 7, {}))
            append_record(
                transcript,
                record(
                    "token_usage_record",
                    8,
                    {"turn_id": "turn-1", "usage": {"total_tokens": 210_000}},
                ),
            )
            connection = sqlite3.connect(state)
            connection.execute(
                """
                CREATE TABLE session_state (
                    session_id TEXT PRIMARY KEY,
                    compacted_marker TEXT NOT NULL,
                    highest_bucket INTEGER NOT NULL CHECK (highest_bucket >= 0)
                )
                """
            )
            connection.execute(
                "INSERT INTO session_state VALUES (?, ?, ?)",
                ("session-1", "ordinal:7", 1),
            )
            connection.commit()
            connection.close()

            result = self.invoke(transcript, state)

            self.assertEqual(result.returncode, 0, result.stderr)
            self.assert_context(result, expected_used_k=210)
            repeat = self.invoke(transcript, state)
            self.assertEqual(repeat.returncode, 0, repeat.stderr)
            self.assertEqual(repeat.stdout, "")
            append_record(
                transcript,
                record(
                    "token_usage_record",
                    9,
                    {"turn_id": "turn-1", "usage": {"total_tokens": 260_000}},
                ),
            )
            next_bucket = self.invoke(transcript, state)
            self.assertEqual(next_bucket.returncode, 0, next_bucket.stderr)
            self.assert_context(next_bucket, expected_used_k=260)
            connection = sqlite3.connect(state)
            columns = {row[1] for row in connection.execute("PRAGMA table_info(session_state)")}
            row = connection.execute(
                "SELECT compacted_marker, highest_bucket, last_seen_at FROM session_state"
            ).fetchone()
            connection.close()
            self.assertIn("last_seen_at", columns)
            self.assertEqual(row[:2], ("ordinal:7", 3))
            self.assertIsNotNone(row[2])

    def test_eviction_keeps_recent_threads_and_allows_reannouncement(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            state = root / "state.sqlite3"
            new_transcript = root / "new.jsonl"
            second_new_transcript = root / "new-2.jsonl"
            recent_transcript = root / "recent.jsonl"
            evicted_transcript = root / "evicted.jsonl"
            rollout(
                new_transcript,
                "session-1",
                usage=250_000,
                capacity=500_000,
                thread_id="new-thread",
            )
            rollout(
                second_new_transcript,
                "session-1",
                usage=250_000,
                capacity=500_000,
                thread_id="new-thread-2",
            )
            rollout(
                recent_transcript,
                "session-1",
                usage=250_000,
                capacity=500_000,
                thread_id="recent-thread",
            )
            rollout(
                evicted_transcript,
                "session-1",
                usage=250_000,
                capacity=500_000,
                thread_id="old-thread",
            )
            connection = sqlite3.connect(state)
            connection.execute(
                """
                CREATE TABLE session_state (
                    session_id TEXT PRIMARY KEY,
                    compacted_marker TEXT NOT NULL,
                    highest_bucket INTEGER NOT NULL CHECK (highest_bucket >= 0),
                    last_seen_at REAL
                )
                """
            )
            rows = [("old-thread", "", 3, None), ("recent-thread", "", 3, 1.0)]
            rows.extend((f"filler-{index:05}", "", 3, 50.0) for index in range(9_998))
            connection.executemany("INSERT INTO session_state VALUES (?, ?, ?, ?)", rows)
            connection.commit()
            connection.close()

            recent_touch = self.invoke(recent_transcript, state)
            first = self.invoke(new_transcript, state)

            self.assertEqual(recent_touch.returncode, 0, recent_touch.stderr)
            self.assertEqual(recent_touch.stdout, "")
            self.assertEqual(first.returncode, 0, first.stderr)
            self.assert_context(first)
            second = self.invoke(second_new_transcript, state)
            self.assertEqual(second.returncode, 0, second.stderr)
            self.assert_context(second)
            connection = sqlite3.connect(state)
            count = connection.execute("SELECT COUNT(*) FROM session_state").fetchone()[0]
            keys = {
                row[0]
                for row in connection.execute("SELECT session_id FROM session_state")
            }
            connection.close()
            self.assertEqual(count, 10_000)
            self.assertIn("new-thread", keys)
            self.assertIn("new-thread-2", keys)
            self.assertIn("recent-thread", keys)
            self.assertNotIn("old-thread", keys)
            self.assertNotIn("filler-00000", keys)

            reannounced = self.invoke(evicted_transcript, state)

            self.assertEqual(reannounced.returncode, 0, reannounced.stderr)
            self.assert_context(reannounced)

    def test_invalid_usage_fails_instead_of_reusing_old_record(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            transcript = root / "rollout.jsonl"
            state = root / "state.sqlite3"
            rollout(transcript, "session-1", usage=250_000, capacity=500_000)
            first = self.invoke(transcript, state)
            append_record(
                transcript,
                record("token_usage_record", 3, {"turn_id": "turn-1", "usage": {}}),
            )

            failed = self.invoke(transcript, state)

            self.assertEqual(first.returncode, 0, first.stderr)
            self.assertEqual(failed.returncode, 5)
            self.assertEqual(failed.stdout, "")
            self.assertIn("transcript-error", failed.stderr)
            self.assertIn("valid usage.total_tokens", failed.stderr)

if __name__ == "__main__":
    unittest.main()
