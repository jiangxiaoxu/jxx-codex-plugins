import json
from contextlib import closing
from pathlib import Path
import sqlite3
import subprocess
import sys
import tempfile
import unittest


SCRIPT = Path(__file__).parents[1] / "scripts" / "context_window_rollover_audit.py"


def row(kind, payload, timestamp="2026-09-23T00:00:00Z"):
    return {"timestamp": timestamp, "type": kind, "payload": payload}


def meta(thread_id, parent=None, *, agent_path=None, agent_role=None, agent_nickname=None):
    if parent:
        spawn = {"parent_thread_id": parent}
        if agent_path is not None:
            spawn["agent_path"] = agent_path
        if agent_role is not None:
            spawn["agent_role"] = agent_role
        if agent_nickname is not None:
            spawn["agent_nickname"] = agent_nickname
        source = {"subagent": {"thread_spawn": spawn}}
    else:
        source = "vscode"
    return row("session_meta", {"id": thread_id, "session_id": "shared-session", "source": source})


def usage(tokens, timestamp):
    return row("token_usage_record", {"usage": {"total_tokens": tokens}}, timestamp)


def reminder(timestamp, threshold=300):
    return row(
        "response_item",
        {
            "type": "message",
            "role": "developer",
            "content": [{"type": "input_text", "text": (
                f"<context_window_usage_reminder>Context Window Usage: {threshold}K/704K</context_window_usage_reminder>"
                "<context_window_rollover_reminder>Continue work.</context_window_rollover_reminder>"
            )}],
        },
        timestamp,
    )


def call(name, timestamp, arguments="{}"):
    return row("response_item", {"type": "function_call", "name": name, "arguments": arguments}, timestamp)


def compacted(number, timestamp):
    return row("compacted", {
        "window_number": number,
        "previous_window_id": f"window-{number - 1}" if number else None,
        "window_id": f"window-{number}",
    }, timestamp)


def write_rollout(path, rows):
    path.write_text("\n".join(json.dumps(value) for value in rows) + "\n", encoding="utf-8")


def write_index(path, entries, edges):
    with closing(sqlite3.connect(path)) as connection:
        connection.execute("CREATE TABLE threads (id TEXT PRIMARY KEY, rollout_path TEXT, thread_source TEXT)")
        connection.execute(
            "CREATE TABLE thread_spawn_edges (parent_thread_id TEXT, child_thread_id TEXT PRIMARY KEY, status TEXT)"
        )
        connection.executemany("INSERT INTO threads VALUES (?, ?, ?)", entries)
        connection.executemany("INSERT INTO thread_spawn_edges VALUES (?, ?, 'open')", edges)
        connection.commit()


def invoke(database, thread_id="root", *extra):
    return subprocess.run(
        [sys.executable, str(SCRIPT), "--thread-id", thread_id, "--codex-state-db", str(database), *extra],
        capture_output=True,
        text=True,
    )


class ContextWindowRolloverAuditTests(unittest.TestCase):
    def test_recursive_subagents_ignore_bootstrap_and_inherited_history(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            database = root / "state_5.sqlite"
            root_rollout = root / "root.jsonl"
            child_rollout = root / "child.jsonl"
            grandchild_rollout = root / "grandchild.jsonl"
            fork_rollout = root / "fork.jsonl"
            secret = "PRIVATE_CHECKPOINT_BODY_123"
            write_rollout(root_rollout, [
                meta("root"),
                usage(100_000, "2026-09-23T00:00:00Z"),
                reminder("2026-09-23T00:00:00Z"),
                call("new_context", "2026-09-23T00:00:01Z"),
            ])
            write_rollout(child_rollout, [
                meta("child", "root", agent_nickname="AliasOnly"),
                meta("root"),  # Parent session_meta inherited after the child identity.
                reminder("2026-09-23T00:00:01Z"),
                call("new_context", "2026-09-23T00:00:02Z"),
                usage(300_000, "2026-09-23T00:00:03Z"),
                compacted(0, "2026-09-23T00:00:04Z"),  # Bootstrap is not first or adjacent to session_meta.
                row("event_msg", {"type": "thread_settings_applied"}, "2026-09-23T00:00:04Z"),
                usage(310_000, "2026-09-23T00:00:05Z"),
                reminder("2026-09-23T00:00:06Z", threshold=310),
                call("exec_command", "2026-09-23T00:00:07Z"),
                call("write_file", "2026-09-23T00:00:08Z", json.dumps({
                    "path": "phase-120.md", "text": secret,
                })),
                call("append_to_file", "2026-09-23T00:00:08Z", json.dumps({
                    "path": "phase-121.md", "text": secret,
                })),
                reminder("2026-09-23T00:00:08Z", threshold=320),
                call("new_context", "2026-09-23T00:00:09Z"),
                usage(320_000, "2026-09-23T00:00:10Z"),
                compacted(1, "2026-09-23T00:00:11Z"),
                call("read_file", "2026-09-23T00:00:12Z", json.dumps({"path": "phase-120.md"})),
                call("read_file", "2026-09-23T00:00:12Z", json.dumps({"path": "phase-121.md"})),
                call("read_file", "2026-09-23T00:00:12Z", json.dumps({"path": "phase-120.md"})),
                usage(30_000, "2026-09-23T00:00:13Z"),
            ])
            write_rollout(grandchild_rollout, [
                meta("grandchild", "child"),
                meta("child", "root"),
                compacted(0, "2026-09-23T00:00:01Z"),
                row("event_msg", {"type": "thread_settings_applied"}, "2026-09-23T00:00:02Z"),
            ])
            write_rollout(fork_rollout, [
                row("session_meta", {"id": "fork", "session_id": "shared-session", "source": "vscode", "forked_from_id": "root"}),
                compacted(1, "2026-09-23T00:00:10Z"),
            ])
            write_index(database, [
                ("root", str(root_rollout), "vscode"),
                ("child", str(child_rollout), "subagent"),
                ("grandchild", str(grandchild_rollout), "subagent"),
                ("fork", str(fork_rollout), "fork"),
            ], [("root", "child"), ("child", "grandchild"), ("root", "fork")])

            process = invoke(database, "root", "--include-subagents", "--format", "json")
            self.assertEqual(process.returncode, 0, process.stderr)
            self.assertNotIn(secret, process.stdout)
            result = json.loads(process.stdout)
            self.assertEqual(result["summary"]["agents_scanned"], 3)
            self.assertEqual(result["summary"]["subagents_scanned"], 2)
            self.assertEqual(result["summary"]["real_rollovers"], 1)
            self.assertEqual(result["summary"]["subagent_real_rollovers"], 1)
            self.assertEqual(result["summary"]["subagent_bootstrap_compacted_ignored"], 2)
            self.assertTrue(result["summary"]["coverage_incomplete"])
            agents = {agent["thread_id"]: agent for agent in result["agents"]}
            self.assertEqual(set(agents), {"child"})
            child = agents["child"]
            self.assertEqual(child["parent_thread_id"], "root")
            self.assertEqual(child["bootstrap_compacted_ignored"], 1)
            self.assertEqual(child["unmatched_new_context_requests"], [])
            rollover = child["rollovers"][0]
            self.assertEqual(rollover["trigger"], "explicit_new_context")
            self.assertEqual(rollover["usage_before_tokens"], 320_000)
            self.assertEqual(rollover["usage_after_tokens"], 30_000)
            self.assertEqual(rollover["seconds_after_last_reminder"], 3)
            self.assertEqual(rollover["tool_calls_after_first_reminder"], 4)
            self.assertEqual(rollover["work_tool_calls_after_first_reminder"], 1)
            self.assertEqual([item["usage_k"] for item in rollover["reminders"]], [310, 320])
            self.assertEqual([event["operation"] for event in rollover["note_calls_before"]], ["write", "append"])
            self.assertEqual([event["operation"] for event in rollover["note_calls_after"]], ["read", "read", "read"])
            self.assertEqual([event["path"] for event in child["note_calls"]], ["phase-120.md", "phase-121.md", "phase-120.md", "phase-121.md", "phase-120.md"])
            self.assertEqual([event["window_number"] for event in child["note_calls"]], [0, 0, 1, 1, 1])

            table_process = invoke(database, "root", "--include-subagents")
            self.assertEqual(table_process.returncode, 0, table_process.stderr)
            self.assertIn("|", table_process.stdout)
            self.assertIn("child", table_process.stdout)
            self.assertIn("子代理名称: ?", table_process.stdout)
            self.assertIn("agent_role: ?", table_process.stdout)
            self.assertNotIn("AliasOnly", table_process.stdout)
            self.assertIn("320K / 30K", table_process.stdout)
            self.assertIn("3秒", table_process.stdout)
            self.assertIn("写入: phase-120.md, phase-121.md", table_process.stdout)
            self.assertIn("读取: phase-120.md, phase-121.md", table_process.stdout)
            self.assertEqual(table_process.stdout.count("phase-120.md"), 2)
            self.assertEqual(table_process.stdout.count("phase-121.md"), 2)
            self.assertNotIn("grandchild", table_process.stdout)
            self.assertNotIn("fork", table_process.stdout)
            self.assertNotIn("PARENT_SECRET", table_process.stdout)

            root_only = invoke(database, "root", "--format", "json")
            self.assertEqual(root_only.returncode, 0, root_only.stderr)
            self.assertEqual(json.loads(root_only.stdout)["summary"]["agents_indexed"], 1)

            selected_child = invoke(database, "child", "--format", "json")
            self.assertEqual(selected_child.returncode, 0, selected_child.stderr)
            selected = json.loads(selected_child.stdout)
            self.assertEqual(selected["summary"]["subagents_scanned"], 1)
            self.assertEqual(selected["summary"]["real_rollovers"], 1)
            self.assertEqual([item["usage_k"] for item in selected["agents"][0]["rollovers"][0]["reminders"]], [310, 320])

    def test_unreadable_child_is_uncovered_and_unknown_trigger_is_not_assumed(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            database = root / "state_5.sqlite"
            rollout = root / "root.jsonl"
            write_rollout(rollout, [meta("root"), usage(200, "2026-09-23T00:00:00Z"), compacted(1, "2026-09-23T00:00:01Z")])
            write_index(database, [
                ("root", str(rollout), "vscode"),
                ("child", str(root / "missing.jsonl"), "subagent"),
            ], [("root", "child"), ("child", "root")])
            process = invoke(database, "root", "--include-subagents", "--format", "json")
            self.assertEqual(process.returncode, 0, process.stderr)
            result = json.loads(process.stdout)
            self.assertTrue(result["summary"]["coverage_incomplete"])
            self.assertEqual(result["summary"]["agents_scanned"], 1)
            self.assertEqual(result["agents"][0]["rollovers"][0]["trigger"], "unknown")
            self.assertIsNone(result["agents"][0]["rollovers"][0]["seconds_after_last_reminder"])

            missing_root = invoke(database, "not-indexed", "--format", "json")
            self.assertEqual(missing_root.returncode, 0, missing_root.stderr)
            missing = json.loads(missing_root.stdout)
            self.assertTrue(missing["summary"]["coverage_incomplete"])
            self.assertEqual(missing["summary"]["agents_indexed"], 0)
            self.assertEqual(missing["agents"], [])

    def test_table_groups_confirmed_rollovers_by_agent(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            database = root / "state_5.sqlite"
            root_rollout = root / "root.jsonl"
            child_rollout = root / "child.jsonl"
            quiet_rollout = root / "quiet.jsonl"
            write_rollout(root_rollout, [
                meta("root"),
                usage(100_999, "2026-09-23T00:00:00Z"),
                reminder("2026-09-23T00:00:01Z"),
                call("new_context", "2026-09-23T00:00:02Z"),
                compacted(1, "2026-09-23T00:00:03Z"),
                usage(10_999, "2026-09-23T00:00:04Z"),
            ])
            write_rollout(child_rollout, [
                meta("child", "root", agent_path="/root/worker_child", agent_role="worker", agent_nickname="OtherAlias"),
                compacted(0, "2026-09-23T00:00:00Z"),
                row("event_msg", {"type": "thread_settings_applied"}, "2026-09-23T00:00:01Z"),
                usage(200_000, "2026-09-23T00:00:05Z"),
                call("new_context", "2026-09-23T00:00:06Z"),
                compacted(1, "2026-09-23T00:00:07Z"),
                usage(20_000, "2026-09-23T00:00:08Z"),
                usage(210_000, "2026-09-23T00:00:09Z"),
                call("new_context", "2026-09-23T00:00:10Z"),
                compacted(2, "2026-09-23T00:00:11Z"),
                usage(30_000, "2026-09-23T00:00:12Z"),
            ])
            write_rollout(quiet_rollout, [
                meta("quiet", "root"),
                compacted(0, "2026-09-23T00:00:00Z"),
                row("event_msg", {"type": "thread_settings_applied"}, "2026-09-23T00:00:01Z"),
            ])
            write_index(database, [
                ("root", str(root_rollout), "vscode"),
                ("child", str(child_rollout), "subagent"),
                ("quiet", str(quiet_rollout), "subagent"),
            ], [("root", "child"), ("root", "quiet")])

            process = invoke(database, "root", "--include-subagents")
            self.assertEqual(process.returncode, 0, process.stderr)
            self.assertNotIn("quiet", process.stdout)
            self.assertEqual(process.stdout.count("线程: root"), 1)
            self.assertEqual(process.stdout.count("线程: child"), 1)
            self.assertIn("子代理名称: /root/worker_child", process.stdout)
            self.assertIn("agent_role: worker", process.stdout)
            self.assertNotIn("OtherAlias", process.stdout)
            root_section, child_section = process.stdout.split("线程: child")
            self.assertIn("确认换窗: 1", root_section)
            self.assertIn("100K / 10K", root_section)
            self.assertNotIn("200K / 20K", root_section)
            self.assertIn("确认换窗: 2", child_section)
            self.assertIn("200K / 20K", child_section)
            self.assertIn("210K / 30K", child_section)
            self.assertNotIn("100K / 10K", child_section)

            structured = invoke(database, "root", "--include-subagents", "--format", "json")
            self.assertEqual(structured.returncode, 0, structured.stderr)
            report = json.loads(structured.stdout)
            self.assertEqual(report["summary"]["real_rollovers"], 3)
            self.assertEqual({agent["thread_id"] for agent in report["agents"]}, {"root", "child"})
            root_rollover = next(agent for agent in report["agents"] if agent["thread_id"] == "root")["rollovers"][0]
            self.assertEqual(root_rollover["usage_before_tokens"], 100_999)
            self.assertEqual(root_rollover["usage_after_tokens"], 10_999)

    def test_bootstrap_discards_apparent_parent_rollover_before_it(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            database = root / "state_5.sqlite"
            root_rollout = root / "root.jsonl"
            child_rollout = root / "child.jsonl"
            write_rollout(root_rollout, [meta("root")])
            write_rollout(child_rollout, [
                meta("child", "root"),
                reminder("2026-09-23T00:00:00Z"),
                call("write_file", "2026-09-23T00:00:01Z", json.dumps({"path": "checkpoint.md", "text": "PARENT_SECRET"})),
                call("new_context", "2026-09-23T00:00:02Z"),
                compacted(1, "2026-09-23T00:00:03Z"),
                compacted(0, "2026-09-23T00:00:04Z"),
                usage(10_000, "2026-09-23T00:00:05Z"),
            ])
            write_index(database, [
                ("root", str(root_rollout), "vscode"),
                ("child", str(child_rollout), "subagent"),
            ], [("root", "child")])

            process = invoke(database, "child", "--format", "json")
            self.assertEqual(process.returncode, 0, process.stderr)
            self.assertNotIn("PARENT_SECRET", process.stdout)
            result = json.loads(process.stdout)
            self.assertEqual(result["summary"]["bootstrap_compacted_ignored"], 1)
            self.assertEqual(result["summary"]["real_rollovers"], 0)
            self.assertEqual(result["agents"], [])


if __name__ == "__main__":
    unittest.main()
