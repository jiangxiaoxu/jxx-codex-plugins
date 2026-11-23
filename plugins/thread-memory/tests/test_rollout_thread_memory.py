import json
import os
import sqlite3
import subprocess
import sys
import tempfile
import unittest
from contextlib import closing
from datetime import datetime
from pathlib import Path
from unittest.mock import patch
from uuid import uuid4

from native_hook_fixture import run_native_hook

SCRIPT = (
    Path(__file__).resolve().parents[1] / "skills" / "thread-memory" / "scripts" / "rollout.py"
)
sys.path.insert(0, str(SCRIPT.parent))

import rollout_hook
from rollout_handoff_diff import apply_handoff_diff
from rollout_handoff_snapshot import reminder_window_id, snapshot
from rollout_handoff_store import memory_timestamp, save_handoff


class ThreadMemoryDiffTest(unittest.TestCase):
    def test_git_diff_accepts_blank_context_without_a_prefix(self):
        diff = (
            "diff --git a/note b/note\n"
            "--- a/note\n"
            "+++ b/note\n"
            "@@ -1,3 +1,3 @@\n"
            " Heading\n"
            "\n"
            "-Before\n"
            "+After\n"
        )
        self.assertEqual(apply_handoff_diff("Heading\n\nBefore", diff), "Heading\n\nAfter")
        with self.assertRaises(ValueError):
            apply_handoff_diff("Heading\nUnexpected\nBefore", diff)


class ThreadMemoryTest(unittest.TestCase):
    def setUp(self):
        temp = tempfile.TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        self.home = Path(temp.name)
        self.sessions = self.home / "sessions"
        self.sessions.mkdir()
        self.env = {**os.environ, "CODEX_HOME": str(self.home)}

    def rollout(self, thread, *, forked_from=None, timestamp="2026-01-01T00:00:00Z"):
        path = self.sessions / f"rollout-2026-01-01T00-00-00-{thread}.jsonl"
        header = {"id": thread, "session_id": thread, "source": "vscode", "timestamp": timestamp}
        if forked_from is not None:
            header["forked_from_id"] = forked_from
        path.write_text(
            json.dumps({"type": "session_meta", "payload": header}) + "\n", encoding="utf-8"
        )
        return path

    def run_command(self, *args, stdin="", thread=None):
        return subprocess.run(
            [sys.executable, "-B", str(SCRIPT), *args, "--codex-home", str(self.home)],
            input=stdin.encode("utf-8"),
            env={**self.env, "CODEX_THREAD_ID": thread or ""},
            capture_output=True,
        )

    def memory(self, thread, action, stdin=""):
        result = self.run_command("memory", action, stdin=stdin, thread=thread)
        self.assertEqual(result.returncode, 0, result.stderr)
        return json.loads(result.stdout)

    def assert_no_memory(self, thread):
        self.assertEqual(self.memory(thread, "read"), {
            "thread_id": thread, "summary": None, "updated_at": None,
        })

    def append(self, path, kind, payload):
        with path.open("a", encoding="utf-8") as stream:
            stream.write(json.dumps({"type": kind, "payload": payload}) + "\n")

    def append_reminder(self, path, window):
        context = (
            "<thread_memory_reminder>\n"
            "The current context window may be compressed soon. Use $thread-memory to update the thread note.\n"
            f"Notify ID: [65:{reminder_window_id(window)}]\n"
            "</thread_memory_reminder>"
        )
        self.append(path, "response_item", {
            "type": "message",
            "role": "developer",
            "content": [{"type": "input_text", "text": context}],
            "internal_chat_message_metadata_passthrough": {
                "content_item_kinds": ["hooks.additional_context"],
                "content_item_metadata": [{"provenance": {"type": "harness", "hook": True}}],
            },
        })

    def test_note_edits_continue_after_compaction_and_late_reminders(self):
        thread = str(uuid4())
        path = self.rollout(thread)
        previous = snapshot(path).current
        self.append_reminder(path, previous)
        self.memory(thread, "write", "Original note")

        self.append(path, "compacted", {"replacement_history": []})
        self.memory(thread, "write", "Updated after compaction")

        self.append_reminder(path, previous)
        diff = "--- a/note\n+++ b/note\n@@ -1 +1 @@\n-Updated after compaction\n+Edited note\n"
        self.memory(thread, "patch", diff)
        self.assertEqual(self.memory(thread, "read")["summary"], "Edited note")

    def test_saved_note_can_be_written_when_indexed_rollout_is_missing(self):
        thread = str(uuid4())
        self.env["CODEX_SQLITE_HOME"] = str(self.home)
        self.rollout(thread)
        self.memory(thread, "write", "Original note")
        with closing(sqlite3.connect(self.home / "state_5.sqlite")) as connection, connection:
            connection.execute("CREATE TABLE threads (id TEXT, rollout_path TEXT, history_mode TEXT)")
            connection.execute(
                "INSERT INTO threads VALUES (?, ?, 'paginated')",
                (thread, str(self.sessions / "missing.jsonl")),
            )
        self.memory(thread, "write", "Updated note")
        self.assertEqual(self.memory(thread, "read")["summary"], "Updated note")

    def test_source_errors_and_patching_an_empty_note_still_fail(self):
        unknown, damaged, empty = (str(uuid4()) for _ in range(3))
        self.rollout(damaged).write_text("{", encoding="utf-8")
        self.rollout(empty)
        diff = "--- a/note\n+++ b/note\n@@ -0,0 +1 @@\n+First line\n"
        for thread, action, stdin, code in (
            (unknown, "read", "", "not_found"),
            (damaged, "read", "", "invalid_rollout"),
            (empty, "patch", diff, "not_found"),
        ):
            with self.subTest(action=action, code=code):
                result = self.run_command("memory", action, stdin=stdin, thread=thread)
                self.assertEqual(result.returncode, 1, result.stderr)
                self.assertEqual(result.stdout, b"")
                self.assertEqual(json.loads(result.stderr)["error"]["code"], code)

    def test_retired_note_history_commands_return_a_single_json_error(self):
        thread = str(uuid4())
        self.rollout(thread)
        for args in (
            ("memory", "history"),
            ("memory", "read", "--at", "2026-01-01T00:00:00Z"),
            ("memory", "read", "--limit", "1"),
            ("handoff", "read"),
        ):
            with self.subTest(args=args):
                result = self.run_command(*args, thread=thread)
                self.assertEqual(result.returncode, 2, result.stderr)
                self.assertEqual(result.stdout, b"")
                self.assertEqual(json.loads(result.stderr)["error"]["code"], "invalid_arguments")

    def test_memory_write_does_not_replace_a_concurrent_edit(self):
        save = rollout_hook.save_memory
        for existing in (None, "Original note"):
            with self.subTest(existing=existing):
                thread = str(uuid4())
                self.rollout(thread)
                if existing is not None:
                    save(self.home, thread, existing)

                def write_before_save(home, thread_id, summary, **kwargs):
                    save(home, thread_id, "Concurrent note")
                    return save(home, thread_id, summary, **kwargs)

                with patch.object(rollout_hook, "save_memory", write_before_save):
                    with self.assertRaises(ValueError):
                        rollout_hook.memory(
                            self.home, thread, "write", summary="Overlapping update", patch=None,
                        )

                self.assertEqual(self.memory(thread, "read")["summary"], "Concurrent note")

    def test_new_note_store_rejects_a_newer_schema_without_modifying_the_note(self):
        thread = str(uuid4())
        self.rollout(thread)
        database = self.home / "state" / "plugins" / "thread-memory" / "handoff.sqlite3"
        self.assert_no_memory(thread)
        self.assertFalse(database.exists())

        self.memory(thread, "write", "Keep this note")
        with closing(sqlite3.connect(database)) as connection:
            (version,) = connection.execute("PRAGMA user_version").fetchone()
            self.assertGreater(version, 0)
            connection.execute(f"PRAGMA user_version = {version + 1}")
        before = database.read_bytes()

        result = self.run_command("memory", "write", stdin="Do not replace it", thread=thread)
        self.assertEqual(result.returncode, 1, result.stderr)
        self.assertIn("database schema version", json.loads(result.stderr)["error"]["message"])
        self.assertEqual(database.read_bytes(), before)

    def test_lazy_nested_forks_copy_the_note_at_birth(self):
        parent, child, grandchild = (str(uuid4()) for _ in range(3))
        self.rollout(parent)
        original = "Goal\nParent at fork\nNext"
        first = self.memory(parent, "write", original)
        child_path = self.rollout(child, forked_from=parent, timestamp=first["updated_at"])
        self.rollout(grandchild, forked_from=child, timestamp=first["updated_at"])

        parent_edit = "Goal\nParent after fork\nNext"
        later = self.memory(parent, "write", parent_edit)
        self.assertGreater(
            datetime.fromisoformat(later["updated_at"].replace("Z", "+00:00")),
            datetime.fromisoformat(first["updated_at"].replace("Z", "+00:00")),
        )
        self.assertEqual(self.memory(grandchild, "read")["summary"], original)
        inherited = self.memory(child, "read")
        self.assertEqual(inherited, {
            "thread_id": child, "summary": original, "updated_at": first["updated_at"],
        })

        patch = "--- a/memory\n+++ b/memory\n@@ -2 +2 @@\n-Parent at fork\n+Child edits\n"
        updated = self.memory(child, "patch", patch)
        self.assertNotEqual(updated["updated_at"], inherited["updated_at"])
        for response in (first, updated):
            self.assertNotIn("revision", response)
        event = {
            "hook_event_name": "SessionStart",
            "source": "fork",
            "session_id": child,
            "transcript_path": str(child_path),
        }
        result = run_native_hook(event, env=self.env)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(self.memory(child, "read")["summary"], "Goal\nChild edits\nNext")
        self.assertEqual(self.memory(parent, "read")["summary"], parent_edit)
        self.assertEqual(self.memory(grandchild, "read")["summary"], original)

    def test_fork_with_no_memory_never_adopts_a_later_parent_note(self):
        parent, child = str(uuid4()), str(uuid4())
        self.rollout(parent)
        self.rollout(child, forked_from=parent)
        self.assert_no_memory(child)
        self.memory(parent, "write", "Parent note after child was created")
        self.assert_no_memory(child)
        self.memory(child, "write", "Independent child note")
        self.assertEqual(self.memory(child, "read")["summary"], "Independent child note")

    def test_fork_deduplicates_one_junction_rollout_but_rejects_a_distinct_copy(self):
        parent = str(uuid4())
        self.rollout(parent)
        summary = "Inherit through one physical file"
        note = self.memory(parent, "write", summary)
        junction = subprocess.run(
            ["cmd.exe", "/d", "/c", "mklink", "/J", "archived_sessions", "sessions"],
            cwd=self.home, capture_output=True, creationflags=subprocess.CREATE_NO_WINDOW,
        )
        self.assertEqual(junction.returncode, 0, (junction.stdout, junction.stderr))

        for distinct_copy in (False, True):
            with self.subTest(distinct_copy=distinct_copy):
                child = str(uuid4())
                path = self.rollout(child, forked_from=parent, timestamp=note["updated_at"])
                if distinct_copy:
                    other = self.sessions / "duplicate"
                    other.mkdir()
                    (other / path.name).write_bytes(path.read_bytes())
                result = run_native_hook({
                    "hook_event_name": "SessionStart", "source": "fork", "session_id": child,
                    "transcript_path": str(self.home / "archived_sessions" / path.name),
                }, env=self.env)
                self.assertEqual(result.returncode, 0, result.stderr)
                self.assertEqual(result.stdout, b"")
                diagnostics = self.run_command("diagnostics", "--limit", "1", thread=child)
                self.assertEqual(diagnostics.returncode, 0, diagnostics.stderr)
                (event,) = json.loads(diagnostics.stdout)["items"]
                self.assertEqual(event["event"], "fork_note_checked")
                self.assertEqual(event["details"]["note_status"], "invalid_data" if distinct_copy else "available")
                if not distinct_copy:
                    self.assertEqual(self.memory(child, "read")["summary"], summary)

    def test_nested_forks_preserve_preinitialization_handoff_edits(self):
        parent, child, first, second, third = (str(uuid4()) for _ in range(5))
        start = 1_767_225_600_000_000
        self.rollout(parent)
        with patch("rollout_handoff_store.time.time_ns", return_value=start * 1_000):
            rollout_hook.save_memory(self.home, parent, "Original inherited note")
        self.rollout(child, forked_from=parent, timestamp=memory_timestamp(start + 1))
        with patch("rollout_handoff_store.time.time_ns", return_value=(start + 2) * 1_000):
            save_handoff(self.home, child, "initial", "Handoff at fork")
        fork_time = memory_timestamp(start + 3)
        self.rollout(first, forked_from=child, timestamp=fork_time)
        self.rollout(second, forked_from=child, timestamp=fork_time)
        with patch("rollout_handoff_store.time.time_ns", return_value=(start + 4) * 1_000):
            save_handoff(self.home, child, "initial", "Later handoff")

        before = self.memory(first, "read")
        current = self.memory(child, "read")
        after = self.memory(second, "read")
        self.assertEqual(current["summary"], "Later handoff")
        for inherited in (before, after):
            self.assertEqual(inherited["summary"], "Handoff at fork")
            self.assertEqual(inherited["updated_at"], memory_timestamp(start + 2))

        with patch("rollout_handoff_store.time.time_ns", return_value=(start + 5) * 1_000):
            save_handoff(self.home, child, "initial", "Handoff after initialization")
        self.rollout(third, forked_from=child, timestamp=memory_timestamp(start + 6))
        self.assertEqual(self.memory(third, "read")["summary"], "Later handoff")

    def test_verified_fork_can_start_an_independent_note_when_its_parent_is_unavailable(self):
        parent, child, grandchild = (str(uuid4()) for _ in range(3))
        self.rollout(child, forked_from=parent)
        before_write = 1_767_225_600_000_001
        earlier = "The child's own handoff before initialization"
        with patch("rollout_handoff_store.time.time_ns", return_value=before_write * 1_000):
            save_handoff(self.home, child, "initial", earlier)
        fork_time = memory_timestamp(before_write)
        self.rollout(grandchild, forked_from=child, timestamp=fork_time)

        result = self.run_command("memory", "read", thread=child)
        self.assertEqual(result.returncode, 1, result.stderr)
        self.assertEqual(result.stdout, b"")
        self.assertEqual(json.loads(result.stderr)["error"]["code"], "invalid_input")

        summary = "Independent note for the verified child"
        saved = self.memory(child, "write", summary)
        self.assertTrue(saved["inheritance_unavailable"])
        restored = self.memory(child, "read")
        self.assertEqual(restored["thread_id"], child)
        self.assertEqual(restored["summary"], summary)
        self.assertEqual(self.memory(grandchild, "read")["summary"], earlier)

    def test_lazy_fork_inherits_legacy_note_before_parent_memory_patch(self):
        parent, child = str(uuid4()), str(uuid4())
        self.rollout(parent)
        original = "Goal\nLegacy note at fork\nNext"
        saved_us = 1_767_225_600_000_000
        saved_at = memory_timestamp(saved_us)
        with patch("rollout_handoff_store.time.time_ns", return_value=saved_us * 1_000):
            save_handoff(self.home, parent, "initial", original)
        self.rollout(child, forked_from=parent, timestamp=saved_at)

        diff = "--- a/note\n+++ b/note\n@@ -2 +2 @@\n-Legacy note at fork\n+Patched later\n"
        self.memory(parent, "patch", diff)
        inherited = self.memory(child, "read")
        self.assertEqual(inherited["summary"], original)
        self.assertEqual(inherited["updated_at"], saved_at)
        self.assertEqual(self.memory(parent, "read")["summary"], "Goal\nPatched later\nNext")

    def test_legacy_note_becomes_stable_thread_memory_across_compactions(self):
        thread = str(uuid4())
        rollout = self.rollout(thread)
        summary = "Legacy handoff for this thread"
        saved_us = 1_767_225_600_000_000
        with patch("rollout_handoff_store.time.time_ns", return_value=saved_us * 1_000):
            save_handoff(self.home, thread, "initial", summary)

        event = {
            "hook_event_name": "SessionStart",
            "source": "compact",
            "session_id": thread,
            "transcript_path": str(rollout),
        }
        for checkpoint in ("first", "second"):
            with rollout.open("a", encoding="utf-8") as stream:
                row = {"type": "compacted", "payload": {"replacement_history": [], "message": checkpoint}}
                stream.write(json.dumps(row) + "\n")
            result = run_native_hook(event, env=self.env)
            self.assertEqual(result.returncode, 0, result.stderr)
            context = json.loads(result.stdout)["hookSpecificOutput"]["additionalContext"]
            self.assertIn("memory read", context)
            self.assertNotIn(summary, context)
            self.assertEqual(self.memory(thread, "read"), {
                "thread_id": thread, "summary": summary, "updated_at": memory_timestamp(saved_us),
            })


if __name__ == "__main__":
    unittest.main()
