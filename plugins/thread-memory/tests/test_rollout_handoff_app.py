import json
import os
import sqlite3
import subprocess
import sys
import tempfile
import unittest
from base64 import b64decode
from contextlib import closing
from pathlib import Path
from unittest.mock import patch
from uuid import UUID, uuid4


SCRIPTS = Path(__file__).resolve().parents[1] / "skills" / "thread-memory" / "scripts"
sys.path.insert(0, str(SCRIPTS))

from rollout_handoff_app import cleanup, dispatch
from rollout_handoff_store import (
    claim_reminder,
    initialize_memory,
    memory_revision,
    memory_timestamp,
    read_hook_diagnostics,
    record_hook_diagnostic,
    save_handoff,
    save_memory,
    save_rollout_checkpoint,
    stored_threads,
)


class HandoffAppTest(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.home = Path(temporary.name)
        self.index = self.home / "state_5.sqlite"
        self.search_index = self.home / "state" / "plugins" / "thread-memory" / "rollout-index.sqlite3"
        self.env = {**os.environ, "CODEX_HOME": str(self.home)}
        self.env.pop("CODEX_SQLITE_HOME", None)

    def test_tools_list_advertises_a_sidebar_entrypoint_icon(self):
        encoded = (
            "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8"
            "/x8AAwMCAO+Xv1sAAAAASUVORK5CYII="
        )
        icon_path = self.home / "thread-memory-entrypoint.png"
        with patch("rollout_handoff_app.ENTRYPOINT_ICON", icon_path):
            tools = dispatch(self.home, "tools/list", {})["tools"]
            manager = next(tool for tool in tools if tool["name"] == "handoff_manager")
            self.assertEqual(manager["_meta"]["openai/ui"]["entrypoints"], [{"type": "global"}])
            self.assertNotIn("icons", manager)

            icon_path.write_bytes(b64decode(encoded))
            tools = dispatch(self.home, "tools/list", {})["tools"]

        self.assertEqual({tool["name"]: tool["icons"] for tool in tools if "icons" in tool}, {
            "handoff_manager": [{
                "src": f"data:image/png;base64,{encoded}",
                "mimeType": "image/png",
                "sizes": ["64x64"],
            }],
        })

    def call_tool(self, name, arguments=None):
        request = {
            "jsonrpc": "2.0",
            "id": 1,
            "method": "tools/call",
            "params": {"name": name, "arguments": arguments or {}},
        }
        result = subprocess.run(
            [sys.executable, "-B", str(SCRIPTS / "rollout_handoff_app.py")],
            input=(json.dumps(request) + "\n").encode("utf-8"),
            capture_output=True,
            env=self.env,
        )
        self.assertEqual(result.returncode, 0, result.stderr)
        response = json.loads(result.stdout)
        self.assertFalse(response.get("error"), response)
        self.assertFalse(response["result"].get("isError"), response)
        return response["result"]["structuredContent"]

    def create_index(self, *rows, backfill="complete"):
        with closing(sqlite3.connect(self.index)) as connection, connection:
            connection.execute(
                "CREATE TABLE threads (id TEXT PRIMARY KEY, name TEXT, title TEXT, "
                "preview TEXT, first_user_message TEXT, source TEXT NOT NULL DEFAULT 'vscode', "
                "thread_source TEXT, archived INTEGER NOT NULL DEFAULT 0, attached_thread_parent_id TEXT)"
            )
            connection.execute("CREATE TABLE backfill_state (id INTEGER PRIMARY KEY, status TEXT)")
            connection.execute("INSERT INTO backfill_state VALUES (1, ?)", (backfill,))
            connection.execute(
                "CREATE TABLE thread_spawn_edges "
                "(parent_thread_id TEXT NOT NULL, child_thread_id TEXT PRIMARY KEY, status TEXT NOT NULL)"
            )
            connection.executemany(
                "INSERT INTO threads (id, name, title, preview, first_user_message) "
                "VALUES (?, ?, ?, ?, ?)",
                rows,
            )

    def save_note(self, thread_id, window, summary, saved_at):
        save_handoff(self.home, thread_id, window, summary)
        database = self.home / "state" / "plugins" / "thread-memory" / "handoff.sqlite3"
        with closing(sqlite3.connect(database)) as connection, connection:
            connection.execute(
                "UPDATE handoffs SET saved_at = ? WHERE thread_id = ? AND window = ?",
                (saved_at, thread_id, window),
            )

    def archive_rollout(
        self, thread_id, *, parent=None, original=False,
        timestamp="2099-01-01T00:00:00Z", source="vscode", attached=False, archived=True,
    ):
        directory = self.home / ("archived_sessions" if archived else "sessions")
        directory.mkdir(exist_ok=True)
        identifier = thread_id if original else f"{thread_id}_{uuid4()}"
        path = directory / f"rollout-2026-01-01T00-00-00-{identifier}.jsonl"
        header = {"type": "session_meta", "payload": {"id": thread_id, "timestamp": timestamp, "source": source}}
        if parent is not None:
            header["payload"]["forked_from_id"] = parent
        if attached:
            header["payload"]["attached_thread"] = True
        path.write_text(json.dumps(header) + "\n", encoding="utf-8")
        return path

    def cache_rollout(self, path):
        stamp = "2026-01-01T12:00:00Z"
        item = {
            "type": "response_item", "timestamp": stamp, "payload": {
                "type": "message", "role": "user",
                "content": [{"type": "input_text", "text": "Cached fixture"}],
            },
        }
        with path.open("a", encoding="utf-8") as stream:
            stream.write(json.dumps(item) + "\n")
        result = subprocess.run(
            [sys.executable, "-B", str(SCRIPTS / "rollout.py"), "search",
             "--rollout", str(path), "--codex-home", str(self.home), "--since", stamp, "Cached fixture"],
            capture_output=True, env=self.env,
        )
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(len(json.loads(result.stdout)["items"]), 1)
        self.assertTrue(self.search_index.is_file())

    def remaining_threads(self):
        return stored_threads(self.home)

    def test_cleanup_previews_and_revalidates_before_removing_only_missing_state(self):
        missing, reappeared, indexed, archived, diagnostics_only = (str(uuid4()) for _ in range(5))
        thread_ids = [missing, reappeared, indexed, archived, diagnostics_only]
        for thread_id in (missing, reappeared, indexed, archived):
            save_handoff(self.home, thread_id, "initial", f"Handoff for {thread_id}")
        claim_reminder(self.home, missing, "next-window", [(1, 0)])
        for thread_id in (diagnostics_only, archived):
            record_hook_diagnostic(self.home, thread_id, "startup_context_prepared")
        self.create_index((indexed, None, None, None, None))
        (self.home / "state_7.sqlite").write_bytes(b"stale corrupt database")
        archived_path = self.archive_rollout(archived)
        archived_bytes = archived_path.read_bytes()
        index_bytes = self.index.read_bytes()

        preview = self.call_tool("handoff_cleanup")
        self.assertEqual(preview["status"], "ok")
        self.assertCountEqual(preview["thread_ids"], [missing, reappeared, diagnostics_only])
        self.assertEqual(self.remaining_threads(), set(thread_ids))

        reappeared_path = self.archive_rollout(reappeared)
        reappeared_bytes = reappeared_path.read_bytes()
        result = self.call_tool("handoff_cleanup", {"thread_ids": thread_ids})
        self.assertEqual(result, {
            "status": "ok", "thread_ids": sorted((missing, diagnostics_only)), "deleted": 3,
        })
        self.assertEqual(self.remaining_threads(), {reappeared, indexed, archived})
        self.assertEqual(read_hook_diagnostics(self.home, diagnostics_only, limit=1), [])
        self.assertEqual(read_hook_diagnostics(self.home, archived, limit=1)[0]["event"], "startup_context_prepared")
        self.assertEqual(self.index.read_bytes(), index_bytes)
        self.assertEqual(archived_path.read_bytes(), archived_bytes)
        self.assertEqual(reappeared_path.read_bytes(), reappeared_bytes)

    def test_cleanup_requires_a_readable_and_complete_index(self):
        thread_id = str(uuid4())
        save_handoff(self.home, thread_id, "initial", "Keep this handoff")
        request = {"thread_ids": [thread_id]}

        for condition in ("missing", "backfilling", "corrupt"):
            with self.subTest(condition=condition):
                if condition == "backfilling":
                    self.create_index(backfill="running")
                elif condition == "corrupt":
                    self.index.write_bytes(b"corrupt active database")
                result = self.call_tool("handoff_cleanup", request)
                self.assertEqual(result["status"], "unavailable")
                self.assertEqual(result["thread_ids"], [])
                self.assertEqual(self.remaining_threads(), {thread_id})

    def test_cleanup_removes_deleted_spawn_tree_and_keeps_archived_threads(self):
        root, child, nested, archived_main, archived_child = (str(uuid4()) for _ in range(5))
        deleted = {root, child, nested}
        archived = {archived_main, archived_child}
        all_threads = deleted | archived
        for thread in all_threads:
            save_memory(self.home, thread, f"note for {thread}")
        self.create_index((archived_main, None, None, None, None))
        self.archive_rollout(archived_child, original=True, source={
            "subagent": {"thread_spawn": {"parent_thread_id": root, "depth": 1}}
        })

        with closing(sqlite3.connect(self.index)) as connection, connection:
            connection.execute("UPDATE threads SET archived = 1 WHERE id = ?", (archived_main,))
            connection.executemany(
                "INSERT INTO thread_spawn_edges VALUES (?, ?, 'closed')",
                [(root, child), (child, nested)],
            )
        self.assertEqual(self.call_tool("handoff_cleanup")["thread_ids"], [])
        with closing(sqlite3.connect(self.index)) as connection, connection:
            connection.execute("DELETE FROM thread_spawn_edges")

        self.assertCountEqual(self.call_tool("handoff_cleanup")["thread_ids"], deleted)
        result = self.call_tool("handoff_cleanup", {"thread_ids": list(all_threads)})
        self.assertCountEqual(result["thread_ids"], deleted)
        self.assertEqual(result["deleted"], len(deleted))
        self.assertEqual(self.remaining_threads(), archived)

    def test_cleanup_clears_owned_rollout_indexes_only_for_verified_missing_threads(self):
        noted, child, search_only, indexed, archived, restored = (str(uuid4()) for _ in range(6))
        self.create_index((indexed, None, None, None, None))
        save_memory(self.home, noted, "Root note")
        save_memory(self.home, child, "Subagent note")
        paths = {thread: self.archive_rollout(thread, original=False, archived=False) for thread in (
            noted, search_only, indexed, archived, restored,
        )}
        paths[child] = self.archive_rollout(child, archived=False, source={
            "subagent": {"thread_spawn": {"parent_thread_id": noted, "depth": 1}},
        })
        for path in paths.values():
            self.cache_rollout(path)
        original = self.archive_rollout(search_only, original=True, archived=False)
        self.cache_rollout(original)
        original.unlink()
        (self.home / "archived_sessions").mkdir()
        archived_path = paths[archived].rename(self.home / "archived_sessions" / paths[archived].name)
        for thread in (noted, child, search_only, indexed, restored):
            paths[thread].unlink()

        preview = self.call_tool("handoff_cleanup")
        self.assertEqual(preview["status"], "ok")
        self.assertCountEqual(preview["thread_ids"], {noted, child, search_only, restored})

        self.archive_rollout(restored, original=True)
        result = self.call_tool("handoff_cleanup", {"thread_ids": list(paths)})
        self.assertEqual(result, {
            "status": "ok", "thread_ids": sorted((noted, child, search_only)), "deleted": 6,
        })
        self.assertEqual(self.remaining_threads(), set())
        self.assertTrue(archived_path.is_file())
        with closing(sqlite3.connect(self.search_index)) as connection:
            owners = {owner for (owner,) in connection.execute("SELECT owner_thread_id FROM rollout_files")}
            self.assertEqual(owners, {indexed, archived, restored})
            self.assertEqual(connection.execute("PRAGMA foreign_key_check").fetchall(), [])
            for table in ("record_locations", "annotation_states"):
                count = connection.execute(f"SELECT COUNT(DISTINCT rollout) FROM {table}").fetchone()[0]
                self.assertEqual(count, 3)
        self.assertEqual(self.call_tool("handoff_cleanup")["thread_ids"], [])

    def test_cleanup_keeps_a_busy_search_index_retryable_after_deleting_notes(self):
        thread = str(uuid4())
        self.create_index()
        save_memory(self.home, thread, "Saved note")
        path = self.archive_rollout(thread, original=True)
        self.cache_rollout(path)
        path.unlink()

        request = {"thread_ids": [thread]}
        with closing(sqlite3.connect(self.search_index)) as connection:
            connection.execute("BEGIN IMMEDIATE")
            result = self.call_tool("handoff_cleanup", request)
        self.assertEqual(result["status"], "ok")
        self.assertEqual(result["deleted"], 1)
        self.assertIn("rollout search index", result["index_warning"])
        self.assertEqual(self.remaining_threads(), set())
        self.assertEqual(self.call_tool("handoff_cleanup")["thread_ids"], [thread])
        self.assertEqual(self.call_tool("handoff_cleanup", request), {
            "status": "ok", "thread_ids": [thread], "deleted": 1,
        })

    def test_cleanup_keeps_a_thread_unarchived_during_the_confirmation_scan(self):
        thread = str(uuid4())
        self.create_index()
        save_memory(self.home, thread, "Still present after unarchiving")
        archived = self.archive_rollout(thread, original=True)
        active = self.home / "sessions" / archived.name
        active.parent.mkdir()
        walk = os.walk

        def walk_during_restore(root, **kwargs):
            if root == archived.parent:
                with closing(sqlite3.connect(self.index)) as connection, connection:
                    connection.execute("INSERT INTO threads (id) VALUES (?)", (thread,))
                archived.rename(active)
            return walk(root, **kwargs)

        with (patch.dict(os.environ, {"CODEX_SQLITE_HOME": ""}),
              patch("rollout_handoff_app.os.walk", side_effect=walk_during_restore)):
            result = cleanup(self.home, {"thread_ids": [thread]})

        self.assertEqual(result, {"status": "ok", "thread_ids": [], "deleted": 0})
        self.assertEqual(self.remaining_threads(), {thread})

    def test_cleanup_materializes_a_surviving_fork_before_deleting_its_source(self):
        parent, child = (str(uuid4()) for _ in range(2))
        self.create_index()
        revision = save_memory(self.home, parent, "Fork-time snapshot")
        child_path = self.archive_rollout(child, parent=parent, original=True)
        child_bytes = child_path.read_bytes()
        self.assertEqual(self.call_tool("handoff_cleanup")["thread_ids"], [parent])
        read = {"thread_id": child}
        self.assertEqual(self.call_tool("handoff_read", read), {**read, "summary": None, "updated_at": None})
        self.assertEqual(self.remaining_threads(), {parent})

        result = self.call_tool("handoff_cleanup", {"thread_ids": [parent]})
        self.assertEqual(result, {"status": "ok", "thread_ids": [parent], "deleted": 1})
        saved = self.call_tool("handoff_read", read)
        self.assertEqual(saved["summary"], "Fork-time snapshot")
        self.assertEqual(saved["updated_at"], memory_timestamp(revision.updated_us))
        self.assertEqual(child_path.read_bytes(), child_bytes)

    def test_cleanup_skips_inheriting_a_surviving_subagent_note(self):
        parent, child = (str(uuid4()) for _ in range(2))
        self.create_index()
        save_memory(self.home, parent, "Parent note")
        source = {"subagent": {"thread_spawn": {"parent_thread_id": parent, "depth": 1}}}
        self.archive_rollout(child, parent=parent, original=True, source=source)

        preview = self.call_tool("handoff_cleanup")
        self.assertEqual(preview["thread_ids"], [parent])
        result = self.call_tool("handoff_cleanup", {"thread_ids": preview["thread_ids"]})
        self.assertEqual(result, {"status": "ok", "thread_ids": [parent], "deleted": 1})
        self.assertEqual(self.remaining_threads(), set())

    def test_cleanup_preserves_an_empty_inherited_baseline(self):
        parent, child = (str(uuid4()) for _ in range(2))
        self.create_index()
        initialize_memory(self.home, parent, None, 0, 0)
        self.archive_rollout(child, parent=parent, original=True)

        result = self.call_tool("handoff_cleanup", {"thread_ids": [parent]})
        self.assertEqual(result["thread_ids"], [parent])
        self.assertIsNone(memory_revision(self.home, parent))
        self.assertIsNone(memory_revision(self.home, child).summary)

    def test_cleanup_requires_the_active_database_when_sqlite_home_is_configured(self):
        thread_id = str(uuid4())
        save_handoff(self.home, thread_id, "initial", "Keep the indexed thread")
        self.create_index()
        custom = self.home / "custom-sqlite"
        custom.mkdir()
        self.env["CODEX_SQLITE_HOME"] = str(custom)
        request = {"thread_ids": [thread_id]}
        result = self.call_tool("handoff_cleanup", request)
        self.assertEqual(result["status"], "unavailable")

        self.index = custom / "state_5.sqlite"
        self.create_index((thread_id, None, None, None, None))
        result = self.call_tool("handoff_cleanup", request)
        self.assertEqual(result, {"status": "ok", "thread_ids": [], "deleted": 0})
        self.assertEqual(self.remaining_threads(), {thread_id})

    def test_cleanup_keeps_source_when_a_surviving_rollout_header_cannot_be_verified(self):
        parent, child = (str(uuid4()) for _ in range(2))
        self.create_index()
        save_memory(self.home, parent, "Keep the source for unresolved forks")
        path = self.archive_rollout(child, original=True)
        path.write_bytes(b"corrupt rollout header")
        result = self.call_tool("handoff_cleanup", {"thread_ids": [parent]})
        self.assertEqual(result["thread_ids"], [])
        self.assertEqual(result["kept_thread_ids"], [parent])
        self.assertEqual(result["deleted"], 0)
        self.assertIn("Cannot verify fork lineage", result["reason"])
        self.assertEqual(self.remaining_threads(), {parent})

    def test_cleanup_reaches_eligible_candidates_after_protected_notes(self):
        self.create_index()
        protected = {str(UUID(int=number)) for number in range(1, 201)}
        for thread in protected:
            save_memory(self.home, thread, "May be needed by a surviving fork")
        reminder_only = str(UUID(int=201))
        claim_reminder(self.home, reminder_only, "window", [(65, 0)])
        checkpoint_only = str(UUID(int=202))
        save_rollout_checkpoint(self.home, checkpoint_only, "previous.jsonl", None, '{"offset":12}')
        save_rollout_checkpoint(self.home, checkpoint_only, "current.jsonl", None, '{"offset":34}')
        damaged = self.archive_rollout(str(uuid4()), original=True)
        damaged.write_bytes(b"unreadable rollout header")

        preview = self.call_tool("handoff_cleanup")
        self.assertCountEqual(preview["thread_ids"], protected | {reminder_only, checkpoint_only})
        result = self.call_tool("handoff_cleanup", {"thread_ids": preview["thread_ids"]})
        self.assertEqual(result["thread_ids"], [reminder_only, checkpoint_only])
        self.assertCountEqual(result["kept_thread_ids"], protected)
        self.assertEqual(self.remaining_threads(), protected)

    def test_cleanup_keeps_sources_of_surviving_attached_threads(self):
        indexed_parent, indexed_child, archived_parent, archived_child, deleted = (str(uuid4()) for _ in range(5))
        self.create_index(
            (indexed_child, None, None, None, None),
            (archived_child, None, None, None, None),
        )
        with closing(sqlite3.connect(self.index)) as connection, connection:
            connection.execute(
                "UPDATE threads SET archived = 1, attached_thread_parent_id = ? WHERE id = ?",
                (indexed_parent, indexed_child),
            )
        self.archive_rollout(archived_child, parent=archived_parent, original=True, attached=True)
        for thread in (indexed_parent, archived_parent, archived_child, deleted):
            save_memory(self.home, thread, "Stored note")

        preview = self.call_tool("handoff_cleanup")
        self.assertCountEqual(preview["thread_ids"], [archived_parent, deleted])
        result = self.call_tool("handoff_cleanup", {"thread_ids": [indexed_parent, *preview["thread_ids"]]})
        self.assertEqual(result["thread_ids"], [deleted])
        self.assertEqual(result["kept_thread_ids"], [archived_parent])
        self.assertEqual(self.remaining_threads(), {indexed_parent, archived_parent, archived_child})

    def test_cleanup_keeps_search_only_source_of_an_archived_attachment(self):
        parent, child, deleted = (str(uuid4()) for _ in range(3))
        self.create_index((child, None, None, None, None))
        original = self.archive_rollout(child, parent=parent, original=True, attached=True)
        original.write_bytes(b"unreadable original attachment header")
        self.archive_rollout(child, parent=parent, attached=True)
        unreadable = self.archive_rollout(str(uuid4()), original=True)
        unreadable.write_bytes(b"unreadable unrelated rollout header")
        for thread in (parent, deleted):
            path = self.archive_rollout(thread, original=True)
            self.cache_rollout(path)
            path.unlink()

        preview = self.call_tool("handoff_cleanup")
        self.assertCountEqual(preview["thread_ids"], [parent, deleted])
        result = self.call_tool("handoff_cleanup", {"thread_ids": preview["thread_ids"]})
        self.assertEqual(result["thread_ids"], [deleted])
        self.assertEqual(result["kept_thread_ids"], [parent])
        self.assertEqual(result["deleted"], 1)
        self.assertEqual(self.call_tool("handoff_cleanup")["thread_ids"], [parent])

    def test_thread_search_is_grouped_recent_first_and_paginates_all_titles(self):
        first, second, third, reminder = (
            f"00000000-0000-4000-8000-00000000abc{index}" for index in (2, 1, 3, 4)
        )
        self.create_index(
            (first, None, "Needle \u5386\u53f2", None, "First message preview"),
            (second, None, "Legacy title before rename", None, None),
            (third, "\u5f53\u524d title", "Older title", "\u9884\u89c8" * 120, "Unused preview"),
        )
        (self.home / "session_index.jsonl").write_text(
            "\n".join(json.dumps(row) for row in (
                {"id": second, "thread_name": "Earlier title"},
                {"id": second, "thread_name": "Needle \u6458\u8981"},
                {"id": third, "thread_name": "Title from index"},
            )) + "\n",
            encoding="utf-8",
        )
        for thread_id, window, day in (
            (first, "previous", 1),
            (first, "latest", 2),
            (second, "initial", 2),
            (third, "initial", 4),
        ):
            self.save_note(thread_id, window, "Private fixture body", f"2026-01-0{day}T00:00:00Z")
        claim_reminder(self.home, first, "open", [(1, 0)])
        claim_reminder(self.home, reminder, "initial", [(1, 0)])

        page = self.call_tool("handoff_list", {"limit": 2})
        self.assertEqual(page["total"], 3)
        self.assertEqual([row["thread_id"] for row in page["items"]], [third, second])
        self.assertEqual(
            [row["title"] for row in page["items"]],
            ["\u5f53\u524d title", "Needle \u6458\u8981"],
        )
        self.assertTrue(page["items"][0]["preview"].startswith("\u9884\u89c8"))
        self.assertLessEqual(len(page["items"][0]["preview"]), 200)
        self.assertNotIn("Private fixture body", json.dumps(page))
        self.assertTrue(page["next_cursor"])
        final = self.call_tool("handoff_list", {"limit": 2, "cursor": page["next_cursor"]})
        self.assertEqual(final["items"], [{
            "thread_id": first,
            "title": "Needle \u5386\u53f2",
            "preview": "First message preview",
            "archived": False,
            "latest_at": "2026-01-02T00:00:00Z",
            "thread_updated_at": None,
        }])
        self.assertIsNone(final["next_cursor"])

        search = {"query": "NEEDLE", "limit": 1}
        page = self.call_tool("handoff_list", search)
        self.assertEqual(page["total"], 2)
        self.assertEqual([row["thread_id"] for row in page["items"]], [second])
        final = self.call_tool("handoff_list", {**search, "cursor": page["next_cursor"]})
        self.assertEqual([row["thread_id"] for row in final["items"]], [first])
        by_id = self.call_tool("handoff_list", {"query": first.upper()})
        self.assertEqual([row["thread_id"] for row in by_id["items"]], [first])

    def test_listing_filters_auxiliary_threads_before_paging_and_keeps_archived_main_forks(self):
        main, fork, unindexed, spawned, indexed_edge, attached, internal, unindexed_child = (
            str(uuid4()) for _ in range(8)
        )
        self.create_index(*(
            (thread_id, "Needle thread", None, "Preview", None)
            for thread_id in (main, fork, spawned, indexed_edge, attached, internal)
        ))
        with closing(sqlite3.connect(self.index)) as connection, connection:
            connection.execute("ALTER TABLE threads ADD COLUMN forked_from_id TEXT")
            connection.execute("UPDATE threads SET archived = 1, forked_from_id = ? WHERE id = ?", (main, fork))
            connection.execute("UPDATE threads SET source = ? WHERE id = ?", ('{"subagent":"review"}', spawned))
            connection.execute("INSERT INTO thread_spawn_edges VALUES (?, ?, 'closed')", (main, indexed_edge))
            connection.execute("UPDATE threads SET attached_thread_parent_id = ? WHERE id = ?", (main, attached))
            connection.execute("UPDATE threads SET thread_source = 'memory_consolidation' WHERE id = ?", (internal,))
        self.archive_rollout(unindexed, parent=main)
        self.archive_rollout(unindexed_child, source={"subagent": "compact"})
        ordered = (unindexed, main, fork, spawned, indexed_edge, attached, internal, unindexed_child)
        for day, thread_id in enumerate(ordered, 1):
            self.save_note(thread_id, "initial", "A fixture note", f"2026-01-{day:02}T00:00:00Z")

        listed = self.call_tool("handoff_list", {"limit": 2})
        self.assertEqual(listed["total"], 3)
        self.assertEqual([(item["thread_id"], item["archived"]) for item in listed["items"]],
                         [(fork, True), (main, False)])
        last = self.call_tool("handoff_list", {"limit": 2, "cursor": listed["next_cursor"]})
        self.assertEqual([(item["thread_id"], item["archived"]) for item in last["items"]], [(unindexed, True)])
        search = self.call_tool("handoff_list", {"query": "needle", "archive_status": "all"})
        self.assertEqual([item["thread_id"] for item in search["items"]], [fork, main])

        archived = {"archive_status": "archived", "limit": 1}
        page = self.call_tool("handoff_list", archived)
        self.assertEqual(page["total"], 2)
        self.assertEqual([item["thread_id"] for item in page["items"]], [fork])
        last = self.call_tool("handoff_list", {**archived, "cursor": page["next_cursor"]})
        self.assertEqual(last["total"], 2)
        self.assertEqual([item["thread_id"] for item in last["items"]], [unindexed])
        self.assertIsNone(last["next_cursor"])

        for status, expected in (("active", main), ("archived", fork)):
            with self.subTest(archive_status=status):
                page = self.call_tool("handoff_list", {"query": "needle", "archive_status": status, "limit": 1})
                self.assertEqual(page["total"], 1)
                self.assertEqual([item["thread_id"] for item in page["items"]], [expected])
                self.assertIsNone(page["next_cursor"])

    def test_thread_listing_rejects_invalid_filter_and_sort_options(self):
        for key, values in (
            ("archive_status", ("all ", "deleted", None, ["active"])),
            ("sort_by", ("updated_at", None, ["note_updated"])),
        ):
            for value in values:
                with self.subTest(option=key, value=value):
                    result = dispatch(self.home, "tools/call", {
                        "name": "handoff_list", "arguments": {key: value},
                    })
                    self.assertTrue(result["isError"])

    def test_thread_sort_uses_index_activity_and_paginates_with_missing_values(self):
        first, second, legacy, fallback = (
            f"00000000-0000-4000-8000-00000000abc{number}" for number in range(4)
        )
        self.create_index(*(
            (thread, "Needle thread", None, None, None) for thread in (first, second, legacy, fallback)
        ))
        for day, thread in enumerate((first, second, legacy, fallback), 1):
            self.save_note(thread, "initial", "Saved note", f"2026-01-0{day}T00:00:00Z")
        with closing(sqlite3.connect(self.index)) as connection, connection:
            connection.execute("ALTER TABLE threads ADD COLUMN updated_at INTEGER")
            connection.execute("UPDATE threads SET archived = 1")
            connection.executemany("UPDATE threads SET updated_at = ? WHERE id = ?", (
                (0, first), (1767744000, legacy), (2**62, fallback),
            ))

        filters = {"query": "needle", "archive_status": "archived", "limit": 2}
        by_note = self.call_tool("handoff_list", filters)
        self.assertEqual([item["thread_id"] for item in by_note["items"]], [fallback, legacy])
        by_thread = {**filters, "sort_by": "thread_updated"}
        legacy_page = self.call_tool("handoff_list", by_thread)
        self.assertEqual(
            [(item["thread_id"], item["thread_updated_at"]) for item in legacy_page["items"]],
            [(legacy, "2026-01-07T00:00:00.000Z"), (fallback, None)],
        )

        with closing(sqlite3.connect(self.index)) as connection, connection:
            connection.execute("ALTER TABLE threads ADD COLUMN updated_at_ms INTEGER")
            connection.execute("UPDATE threads SET updated_at_ms = ? WHERE id IN (?, ?)",
                               (1767657600456, first, second))

        page = self.call_tool("handoff_list", by_thread)
        self.assertEqual(page["total"], 4)
        self.assertEqual(
            [(item["thread_id"], item["thread_updated_at"]) for item in page["items"]],
            [(legacy, "2026-01-07T00:00:00.000Z"), (first, "2026-01-06T00:00:00.456Z")],
        )
        self.assertEqual(page["items"][1]["latest_at"], "2026-01-01T00:00:00Z")
        continuation = self.call_tool("handoff_list", {**by_thread, "cursor": page["next_cursor"]})
        self.assertEqual([item["thread_id"] for item in continuation["items"]], [second, fallback])
        self.assertIsNone(continuation["next_cursor"])

    def test_thread_listing_continues_after_visible_boundary_when_another_note_moves(self):
        first, updated, last = (str(uuid4()) for _ in range(3))
        self.create_index(*((thread, None, None, None, None) for thread in (first, updated, last)))
        for day, thread in enumerate((last, updated, first), 1):
            self.save_note(thread, "initial", "Saved note", f"2026-01-0{day}T00:00:00Z")
        before = self.call_tool("handoff_list", {"limit": 1})
        self.assertEqual([item["thread_id"] for item in before["items"]], [first])

        self.save_note(updated, "second", "New note", "2026-01-04T00:00:00Z")
        after = self.call_tool("handoff_list", {"limit": 1, "cursor": before["next_cursor"]})
        self.assertEqual([item["thread_id"] for item in after["items"]], [last])
        self.assertIsNone(after["next_cursor"])
        self.assertEqual(after["total"], 3)
        refreshed = self.call_tool("handoff_list", {"limit": 1})
        self.assertEqual([item["thread_id"] for item in refreshed["items"]], [updated])

    def test_current_note_falls_back_to_latest_saved_legacy_window(self):
        legacy, empty = (str(uuid4()) for _ in range(2))
        self.create_index(*((thread, None, None, None, None) for thread in (legacy, empty)))
        initialize_memory(self.home, empty, None, 0, 0)
        recent, recent_at = "\u6700\u65b0 handoff", "2026-01-02T00:00:00.123000Z"
        empty_at = "2026-01-01T00:00:00Z"
        self.save_note(legacy, "aaa-older", "First note", "2026-01-02T00:00:00Z")
        self.save_note(legacy, "zzz-recent-b", "Another note", "2026-01-02T00:00:00.123Z")
        self.save_note(legacy, "zzz-recent-a", recent, recent_at)
        self.save_note(empty, "initial", "A note after the empty baseline", empty_at)

        page = self.call_tool("handoff_list")
        self.assertEqual([(row["thread_id"], row["latest_at"]) for row in page["items"]],
                         [(legacy, recent_at), (empty, empty_at)])
        for thread, expected_summary, expected_time in (
            (legacy, recent, recent_at), (empty, "A note after the empty baseline", empty_at),
        ):
            with self.subTest(thread=thread):
                self.assertEqual(self.call_tool("handoff_read", {"thread_id": thread}), {
                    "thread_id": thread, "summary": expected_summary, "updated_at": expected_time,
                })

    def test_current_memory_controls_the_note_and_its_directory_position(self):
        thread_id, newer = (str(uuid4()) for _ in range(2))
        self.create_index(*((thread, None, None, None, None) for thread in (thread_id, newer)))
        current, legacy = "Current private thread note", "Legacy private handoff"
        save_memory(self.home, thread_id, "Previous private thread note")
        revision = save_memory(self.home, thread_id, current)
        maintained_at = memory_timestamp(revision.updated_us)
        newer_at = memory_timestamp(revision.updated_us + 1_000_000)
        legacy_at = memory_timestamp(revision.updated_us + 2_000_000)
        self.save_note(thread_id, "legacy-window", legacy, legacy_at)
        self.save_note(newer, "initial", "Another private note", newer_at)

        page = self.call_tool("handoff_list")
        self.assertEqual([(row["thread_id"], row["latest_at"]) for row in page["items"]],
                         [(newer, newer_at), (thread_id, maintained_at)])
        self.assertNotIn(current, json.dumps(page))
        self.assertNotIn(legacy, json.dumps(page))

        self.assertEqual(self.call_tool("handoff_read", {"thread_id": thread_id}), {
            "thread_id": thread_id, "summary": current, "updated_at": maintained_at,
        })


if __name__ == "__main__":
    unittest.main()
