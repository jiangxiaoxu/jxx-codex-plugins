import importlib.util
import json
import os
import sqlite3
import sys
import tempfile
import unittest
from contextlib import closing
from pathlib import Path
from unittest.mock import patch
from uuid import uuid4

SCRIPTS = (
    Path(__file__).resolve().parents[1] / "skills" / "thread-memory" / "scripts"
)
sys.path.insert(0, str(SCRIPTS))

from rollout_lineage import describe_lineage
from rollout_source import RolloutDataError, find_rollout, resolve_segments


def write_rollout(directory, day, thread_id, *, rollout_id=None, **fields):
    suffix = f"_{rollout_id}" if rollout_id is not None else ""
    path = directory / f"rollout-2026-11-{day:02d}T00-00-00-{thread_id}{suffix}.jsonl"
    path.parent.mkdir(parents=True, exist_ok=True)
    header = {
        "type": "session_meta",
        "ordinal": 0,
        "payload": {"id": thread_id, **fields},
    }
    path.write_bytes((json.dumps(header) + "\n").encode("utf-8"))
    return path


def history_base(rollout_id, path):
    return {
        "thread_id": rollout_id,
        "end_ordinal_exclusive": 1,
        "end_byte_offset": path.stat().st_size,
    }


class RolloutLineageTest(unittest.TestCase):
    def test_thread_lookup_uses_the_active_native_index_then_falls_back_to_rollouts(self):
        with tempfile.TemporaryDirectory() as directory:
            home = Path(directory)
            thread = str(uuid4())
            old = write_rollout(home / "other", 1, thread)
            current = write_rollout(home / "other", 2, thread)
            in_environment = write_rollout(home / "other", 3, thread)
            in_config = write_rollout(home / "other", 4, thread)
            fallback = write_rollout(home / "archived_sessions", 5, thread)

            def index(database, path):
                database.parent.mkdir(parents=True, exist_ok=True)
                with closing(sqlite3.connect(database)) as connection, connection:
                    connection.execute("CREATE TABLE threads (id TEXT, rollout_path TEXT)")
                    connection.execute("INSERT INTO threads VALUES (?, ?)", (thread, str(path)))

            index(home / "state_4.sqlite", old)
            index(home / "state_5.sqlite", current)
            os.utime(home / "state_4.sqlite", (200, 200))
            os.utime(home / "state_5.sqlite", (100, 100))
            with patch.dict("os.environ", {"CODEX_SQLITE_HOME": ""}):
                self.assertEqual(find_rollout(home, thread, thread=True), current.resolve())

            env_home = home / "from-env"
            index(env_home / "state_5.sqlite", in_environment)
            with patch.dict("os.environ", {"CODEX_SQLITE_HOME": str(home / "missing")}):
                self.assertEqual(find_rollout(home, thread, thread=True), fallback.resolve())
            with patch.dict("os.environ", {"CODEX_SQLITE_HOME": str(env_home)}):
                self.assertEqual(find_rollout(home, thread, thread=True), in_environment.resolve())
                with self.subTest(configured_home=True):
                    if sys.version_info < (3, 11) and importlib.util.find_spec("tomli") is None:
                        self.skipTest("reading config.toml requires a TOML parser")
                    config = home / "config.toml"
                    config.write_text('sqlite_home = "from-config"\n', encoding="utf-8")
                    index(home / "from-config" / "state_5.sqlite", in_config)
                    self.assertEqual(find_rollout(home, thread, thread=True), in_config.resolve())
                    config.write_text('sqlite_home = "missing"\n', encoding="utf-8")
                    self.assertEqual(find_rollout(home, thread, thread=True), fallback.resolve())

    def test_paginated_threads_do_not_fall_back_to_a_superseded_rollout(self):
        with tempfile.TemporaryDirectory() as directory, patch.dict("os.environ", {"CODEX_SQLITE_HOME": ""}):
            home = Path(directory)
            thread, other, replacement = (str(uuid4()) for _ in range(3))
            original = write_rollout(home / "sessions", 1, thread)
            current = home / "sessions" / f"rollout-2026-11-02T00-00-00-{thread}_{replacement}.jsonl"
            database = home / "state_5.sqlite"
            with closing(sqlite3.connect(database)) as connection, connection:
                connection.execute("CREATE TABLE threads (id TEXT, rollout_path TEXT, history_mode TEXT)")
                connection.execute("INSERT INTO threads VALUES (?, ?, 'paginated')", (thread, str(current)))

            with self.assertRaisesRegex(RolloutDataError, "indexed rollout is missing") as missing:
                find_rollout(home, thread, thread=True)
            self.assertEqual(missing.exception.path, current)
            current.write_text("{\n", encoding="utf-8")
            with self.assertRaisesRegex(RolloutDataError, "invalid session_meta JSON"):
                find_rollout(home, thread, thread=True)
            current.write_text(json.dumps({"type": "session_meta", "payload": {"id": other}}), encoding="utf-8")
            with self.assertRaisesRegex(RolloutDataError, "belongs to a different thread"):
                find_rollout(home, thread, thread=True)

            # A caller can still explicitly request the historical file.
            self.assertEqual(resolve_segments(original, None, home, [])[0][-1].path, original.resolve())
            write_rollout(home / "sessions", 2, thread, rollout_id=replacement)
            self.assertEqual(find_rollout(home, thread, thread=True), current.resolve())

    def test_revert_uses_pinned_parent_and_keeps_same_thread_shards(self):
        with tempfile.TemporaryDirectory() as directory:
            home = Path(directory)
            sessions = home / "sessions"
            thread, replacement, parent, parent_replacement, spawner = (
                str(uuid4()) for _ in range(5)
            )
            inherited = write_rollout(sessions, 1, parent)
            previous = write_rollout(
                sessions,
                2,
                thread,
                history_base=history_base(parent, inherited),
                forked_from_id=parent,
            )
            current = write_rollout(
                sessions,
                3,
                thread,
                rollout_id=replacement,
                history_base=history_base(thread, previous),
                forked_from_id=parent,
                forked_from_ordinal_exclusive=1,
                parent_thread_id=spawner,
            )
            write_rollout(sessions, 4, parent, rollout_id=parent_replacement)

            segments, gaps = resolve_segments(None, thread, home, [])
            result = describe_lineage(segments, home)
            self.assertEqual(gaps, [])
            self.assertEqual(result["thread_id"], thread)
            self.assertEqual(result["rollout_id"], replacement)
            self.assertEqual(
                [(item["thread_id"], item["relation"]) for item in result["segments"]],
                [
                    (parent, "inherited_thread_history"),
                    (thread, "same_thread_history"),
                    (thread, "current_rollout"),
                ],
            )
            self.assertEqual(
                [(item["thread_id"], item["path"]) for item in result["fork_chain"]],
                [(thread, str(current.resolve())), (parent, str(inherited.resolve()))],
            )
            self.assertEqual(result["fork_chain"][0]["spawned_by"], spawner)
            self.assertEqual(
                result["fork_chain"][0]["forked_from_ordinal_exclusive"], 1
            )
            self.assertEqual(result["fork_chain_end"], {"status": "root"})

    def test_local_parent_lookup_preserves_chain_at_missing_or_repeated_ancestor(self):
        with tempfile.TemporaryDirectory() as directory:
            home = Path(directory)
            thread, parent, absent = (str(uuid4()) for _ in range(3))
            child = write_rollout(home, 2, thread, forked_from_id=parent)
            segments, gaps = resolve_segments(child, None, home, [])
            self.assertEqual(gaps, [])

            for next_parent, status in ((absent, "missing"), (thread, "cycle")):
                with self.subTest(status=status):
                    write_rollout(
                        home / "archived_sessions",
                        1,
                        parent,
                        forked_from_id=next_parent,
                    )
                    result = describe_lineage(segments, home)
                    self.assertEqual(
                        [item["thread_id"] for item in result["fork_chain"]],
                        [thread, parent],
                    )
                    self.assertEqual(len(result["segments"]), 1)
                    self.assertEqual(
                        result["fork_chain_end"],
                        {"status": status, "thread_id": next_parent},
                    )


if __name__ == "__main__":
    unittest.main()
