import json
import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from uuid import uuid4


from native_hook_fixture import CLI_EXE, REFERENCE_CLI


NATIVE_CLI = (str(CLI_EXE),)
PYTHON_CLI = (sys.executable, "-B", str(REFERENCE_CLI))


class NativeMemoryCLITest(unittest.TestCase):
    def setUp(self):
        temp = tempfile.TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        self.home = Path(temp.name)
        self.sessions = self.home / "sessions"
        self.sessions.mkdir()
        self.env = {**os.environ, "CODEX_HOME": str(self.home), "CODEX_SQLITE_HOME": str(self.home)}

    def rollout(self, thread, **metadata):
        header = {
            "id": thread, "session_id": thread, "source": "vscode",
            "timestamp": "2026-01-01T00:00:00Z", **metadata,
        }
        path = self.sessions / f"rollout-2026-01-01T00-00-00-{thread}.jsonl"
        path.write_text(
            json.dumps({"type": "session_meta", "payload": header}) + "\n",
            encoding="utf-8",
        )

    def run_memory(self, cli, thread, *args, stdin=""):
        return subprocess.run(
            [*cli, "memory", *args],
            input=stdin.encode("utf-8"),
            env={**self.env, "CODEX_THREAD_ID": thread},
            capture_output=True,
            timeout=15,
        )

    def memory(self, cli, thread, *args, stdin=""):
        result = self.run_memory(cli, thread, *args, stdin=stdin)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(result.stderr, b"")
        return json.loads(result.stdout.decode("utf-8"))

    def test_native_and_python_share_fork_history_and_note_edits(self):
        parent, child = str(uuid4()), str(uuid4())
        self.rollout(parent)
        original = "Goal\n\u76ee\u6807 \U0001f3af\nNext"
        first = self.memory(NATIVE_CLI, parent, "write", stdin=f"\ufeff{original}\r\n")
        self.assertEqual(first, {
            "saved": True, "thread_id": parent, "bytes": len(original.encode("utf-8")),
            "truncated": False, "updated_at": first["updated_at"],
        })
        self.assertEqual(self.memory(PYTHON_CLI, parent, "read"), {
            "thread_id": parent, "summary": original, "updated_at": first["updated_at"],
        })

        self.rollout(child, forked_from_id=parent, timestamp=first["updated_at"])
        newer = "Goal\nParent after fork\nNext"
        parent_edit = self.memory(PYTHON_CLI, parent, "write", stdin=newer)
        self.assertEqual(self.memory(NATIVE_CLI, parent, "--thread", child, "read"), {
            "thread_id": child, "summary": original, "updated_at": first["updated_at"],
        })

        new_line = "\u5b50\u7ebf\u7a0b \U0001f680"
        diff = f"--- a/note\r\n+++ b/note\r\n@@ -2 +2 @@\r\n-\u76ee\u6807 \U0001f3af\r\n+{new_line}\r\n"
        edited = self.memory(NATIVE_CLI, child, "patch", stdin=diff)
        self.assertEqual(self.memory(PYTHON_CLI, child, "read"), {
            "thread_id": child, "summary": f"Goal\n{new_line}\nNext",
            "updated_at": edited["updated_at"],
        })
        self.assertEqual(self.memory(NATIVE_CLI, parent, "read"), {
            "thread_id": parent, "summary": newer, "updated_at": parent_edit["updated_at"],
        })

    def test_native_truncation_and_failed_patches_preserve_the_saved_note(self):
        thread = str(uuid4())
        self.rollout(thread)
        limit = 12_288
        marker = "\n\n[Summary truncated]"
        prefix = "Goal\n" + "x" * (limit - len(marker) - len("Goal\n") - 1)
        submitted = f"{prefix}\u754c" + "x" * 70_000
        receipt = self.memory(NATIVE_CLI, thread, "write", stdin=submitted)
        self.assertTrue(receipt["truncated"])
        self.assertEqual(receipt["bytes"], limit - 1)
        expected = {
            "thread_id": thread, "summary": prefix + marker, "updated_at": receipt["updated_at"],
        }
        self.assertEqual(self.memory(PYTHON_CLI, thread, "read"), expected)

        headers = "--- a/note\n+++ b/note\n"
        invalid_patches = (
            headers + "@@ -1 +1 @@\n-Goal\n+Edit\n"
            "@@ -4 +4 @@\n-Wrong old line\n+Ignored\n",
            headers + "@@ -1 +1 @@\n-Goal\n+Goal \u754c\n",
        )
        for diff in invalid_patches:
            with self.subTest(diff=diff):
                result = self.run_memory(NATIVE_CLI, thread, "patch", stdin=diff)
                self.assertEqual(result.returncode, 1, result.stderr)
                self.assertEqual(result.stdout, b"")
                diagnostic = result.stderr.decode("utf-8")
                self.assertEqual(len(diagnostic.splitlines()), 1)
                self.assertEqual(json.loads(diagnostic)["error"]["code"], "invalid_input")
                self.assertEqual(self.memory(PYTHON_CLI, thread, "read"), expected)

    def test_closed_stdout_exits_quietly(self):
        thread = str(uuid4())
        self.rollout(thread)
        self.memory(PYTHON_CLI, thread, "write", stdin="Saved note")

        read_fd, write_fd = os.pipe()
        os.close(read_fd)
        try:
            result = subprocess.run(
                [*NATIVE_CLI, "memory", "read"],
                stdin=subprocess.DEVNULL,
                stdout=write_fd,
                stderr=subprocess.PIPE,
                env={**self.env, "CODEX_THREAD_ID": thread},
                timeout=15,
            )
        finally:
            os.close(write_fd)
        self.assertEqual(result.returncode, 141, result.stderr)
        self.assertEqual(result.stderr, b"")


if __name__ == "__main__":
    unittest.main()
