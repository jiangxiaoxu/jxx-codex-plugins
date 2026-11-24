import json
import os
import subprocess
import tempfile
import unittest
from pathlib import Path


from native_hook_fixture import CLI_EXE


def row(kind, timestamp, payload):
    envelope = {} if timestamp is None else {"timestamp": timestamp}
    envelope.update(type=kind, payload=payload)
    return json.dumps(envelope).encode("utf-8") + b"\n"


def message(timestamp, role, text):
    return row("response_item", timestamp, {
        "type": "message",
        "role": role,
        "content": [{"type": "input_text" if role == "user" else "output_text", "text": text}],
    })


class RolloutQueryIndexTest(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.home = Path(temporary.name)
        self.rollout = self.home / "sessions" / "rollout-2026-01-01T00-00-00-00000000-0000-4000-8000-000000000001.jsonl"
        self.index = self.home / "state" / "plugins" / "thread-memory" / "rollout-index.sqlite3"
        self.header = row("session_meta", "2026-01-01T00:00:00Z", {
            "id": "00000000-0000-4000-8000-000000000001",
        })
        self.rollout.parent.mkdir()
        self.rollout.write_bytes(self.header)

    def append(self, *rows):
        with self.rollout.open("ab") as stream:
            for raw in rows:
                stream.write(raw)

    def query(self, command, *options):
        result = subprocess.run(
            [
                str(CLI_EXE), command,
                "--rollout", str(self.rollout), "--codex-home", str(self.home), *options,
            ],
            capture_output=True,
        )
        self.assertEqual(result.returncode, 0, result.stderr)
        return json.loads(result.stdout)

    def compare_search(self, *options):
        indexed = self.query("search", *options)
        sequential = self.query("search", *options, "--salvage")
        self.assertEqual(indexed, sequential)
        return indexed

    def test_time_search_keeps_physical_order_context_cursor_and_refs(self):
        sentinel = "UNIQUE_SYNTHETIC_INDEX_PAYLOAD_BODY"
        self.append(
            message("2026-01-01T10:00:00Z", "assistant", f"Before alpha {sentinel}"),
            message("2026-01-01T18:00:00+08:00", "user", "needle alpha"),
            message("2026-01-01T10:01:00Z", "assistant", "needle assistant context"),
            message("2026-01-01T18:03:00+08:00", "user", "needle at exclusive end"),
            message("2026-01-01T10:02:00Z", "assistant", "Before beta"),
            message("2026-01-01T05:01:00-05:00", "user", "needle beta"),
            message("2026-01-01T10:02:00Z", "assistant", "After beta"),
            message(None, "user", "needle without timestamp"),
        )
        scope = (
            "needle", "--since", "2026-01-01T10:00:00Z", "--until", "2026-01-01T18:03:00+08:00",
            "--role", "user", "-B", "1", "-A", "1", "--limit", "1",
        )
        first = self.compare_search(*scope)
        self.assertTrue(self.index.is_file())
        self.assertTrue(first["next_cursor"])
        second = self.compare_search(*scope, "--cursor", first["next_cursor"])
        self.assertEqual([first["items"][0]["line"], second["items"][0]["line"]], [3, 7])
        self.assertEqual([entry["line"] for entry in first["context"]], [2, 4])
        self.assertEqual([entry["line"] for entry in second["context"]], [6, 8])
        self.assertIsNone(second["next_cursor"])

        detail = self.query("read", "--ref", second["items"][0]["ref"])
        self.assertEqual(detail["items"][0]["fields"][0]["text"], "needle beta")
        by_line = self.compare_search("needle", "--lines", "6:8", "--role", "user")
        self.assertEqual([entry["line"] for entry in by_line["items"]], [7])
        for artifact in self.index.parent.glob(f"{self.index.name}*"):
            self.assertNotIn(sentinel.encode("utf-8"), artifact.read_bytes())

    def test_duplicate_window_uses_last_checkpoint_and_includes_its_end_line(self):
        archive = self.home / "archived_sessions"
        archive.mkdir()
        self.rollout = self.rollout.rename(archive / self.rollout.name)
        self.append(
            message("2026-01-01T10:00:00Z", "user", "needle first window"),
            row("compacted", "2026-01-01T10:01:00Z", {
                "window_number": 1, "message": "needle old checkpoint", "replacement_history": [],
            }),
            message("2026-01-01T10:02:00Z", "user", "needle chosen window"),
            row("compacted", "2026-01-01T10:03:00Z", {
                "window_number": 1, "message": "needle chosen checkpoint", "replacement_history": [],
            }),
            message("2026-01-01T10:04:00Z", "user", "needle current window"),
        )
        window = self.compare_search("needle", "--window", "1")
        self.assertTrue(self.index.is_file())
        self.assertEqual([entry["line"] for entry in window["items"]], [4, 5])
        current = self.compare_search("needle", "--window", "current")
        self.assertEqual([entry["line"] for entry in current["items"]], [6])

    def test_index_tracks_valid_unterminated_append_and_same_size_replacement(self):
        stamp = "2026-01-01T10:00:00Z"
        self.append(message(stamp, "user", "needle original"))
        options = ("needle", "--since", stamp)
        self.assertEqual([hit["text"] for hit in self.compare_search(*options)["items"]], ["needle original"])
        self.assertTrue(self.index.is_file())

        trailing = message(stamp, "user", "needle appended").removesuffix(b"\n")
        self.append(trailing)
        appended = self.compare_search(*options)
        self.assertEqual(
            [hit["text"] for hit in appended["items"]], ["needle original", "needle appended"],
        )
        self.append(b"\n")
        self.assertEqual(self.compare_search(*options)["items"], appended["items"])

        replacement = self.rollout.with_suffix(".replacement")
        replacement.write_bytes(self.header + message(stamp, "user", "needle replaced") + trailing + b"\n")
        self.assertEqual(replacement.stat().st_size, self.rollout.stat().st_size)
        os.replace(replacement, self.rollout)
        replaced = self.compare_search(*options)
        self.assertEqual(
            [hit["text"] for hit in replaced["items"]], ["needle replaced", "needle appended"],
        )

    def test_explicit_backup_search_streams_without_creating_an_index(self):
        backup = self.home / "backup"
        backup.mkdir()
        self.rollout = self.rollout.rename(backup / self.rollout.name)
        stamp = "2026-01-01T10:00:00Z"
        self.append(message(stamp, "user", "needle from a backup"))

        result = self.query("search", "needle", "--since", stamp)
        self.assertEqual([hit["text"] for hit in result["items"]], ["needle from a backup"])
        self.assertFalse(self.index.exists())

    def test_search_streams_when_session_filename_has_a_different_owner(self):
        self.rollout = self.rollout.rename(self.rollout.with_name(
            "rollout-2026-01-01T00-00-00-00000000-0000-4000-8000-000000000002.jsonl"
        ))
        stamp = "2026-01-01T10:00:00Z"
        self.append(message(stamp, "user", "needle from a renamed file"))

        result = self.query("search", "needle", "--since", stamp)
        self.assertEqual([hit["text"] for hit in result["items"]], ["needle from a renamed file"])
        self.assertFalse(self.index.exists())

    def test_reference_survives_append_and_recent_chat_includes_the_new_row(self):
        stamp = "2026-01-01T10:00:00Z"
        self.rollout.write_bytes(row("session_meta", stamp, {
            "id": "00000000-0000-4000-8000-000000000001",
            "base_instructions": {"text": "x" * (4 * 1024 * 1024)},
        }))
        self.append(message(stamp, "user", "needle before append"))
        hit, = self.query("search", "needle", "--since", stamp)["items"]
        self.assertTrue(self.index.is_file())
        self.append(message(stamp, "assistant", "new reply"))

        selected, = self.query("read", "--ref", hit["ref"])["items"]
        self.assertEqual(selected["fields"][0]["text"], "needle before append")
        recent = self.query("transcript", "--last", "2")["items"]
        self.assertEqual([item["text"] for item in recent], ["needle before append", "new reply"])


if __name__ == "__main__":
    unittest.main()
