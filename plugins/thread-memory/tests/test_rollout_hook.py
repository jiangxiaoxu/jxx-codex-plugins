import json
import os
import re
import subprocess
import sys
import tempfile
import unittest
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
from pathlib import Path
from uuid import uuid4

PLUGIN = Path(__file__).resolve().parents[1]
SCRIPT = PLUGIN / "skills" / "thread-memory" / "scripts" / "rollout.py"
sys.path.insert(0, str(SCRIPT.parent))

from rollout_handoff_snapshot import snapshot


HISTORY = "private historical chat to exclude from hook guidance"
MAINTENANCE_GUIDANCE = (
    "<thread_memory_maintenance>\n"
    "Proactively maintain this thread's note with $thread-memory. "
    "Update it when important decisions, constraints, progress, or next steps change.\n"
    "</thread_memory_maintenance>"
)


class RolloutHookTest(unittest.TestCase):
    def setUp(self):
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        self.codex_home = Path(directory.name)
        self.env = os.environ.copy()
        self.env.pop("THREAD_MEMORY_ASYNC_START_TOKENS", None)
        self.env.pop("THREAD_MEMORY_HANDOFF_LEAD_TOKENS", None)
        sessions = self.codex_home / "sessions"
        sessions.mkdir()
        self.session_id = str(uuid4())
        self.transcript = sessions / f"rollout-2026-01-01T00-00-00-{self.session_id}.jsonl"
        self.request = {
            "hook_event_name": "SessionStart",
            "source": "compact",
            "session_id": self.session_id,
            "transcript_path": str(self.transcript),
        }
        self.header = {
            "id": self.session_id,
            "session_id": self.session_id,
            "source": "vscode",
            "thread_source": "user",
        }

    def write_rollout(self, header):
        rows = (
            {"type": "session_meta", "payload": header},
            {
                "type": "response_item",
                "payload": {
                    "type": "message",
                    "role": "user",
                    "content": [{"type": "input_text", "text": HISTORY}],
                },
            },
            {"type": "compacted", "payload": {"replacement_history": []}},
        )
        with self.transcript.open("w", encoding="utf-8") as stream:
            for row in rows:
                stream.write(json.dumps(row) + "\n")

    def invoke(self, request, *, check=False):
        payload = (
            request if isinstance(request, bytes) else json.dumps(request).encode()
        )
        return subprocess.run(
            [
                sys.executable,
                "-B",
                str(SCRIPT),
                "hook",
                "--codex-home",
                str(self.codex_home),
            ],
            input=payload,
            capture_output=True,
            check=check,
            env=self.env,
        )

    def diagnostics(self, thread_id):
        result = subprocess.run(
            [
                sys.executable,
                "-B",
                str(SCRIPT),
                "diagnostics",
                "--thread",
                thread_id,
                "--codex-home",
                str(self.codex_home),
            ],
            capture_output=True,
            check=True,
        )
        return json.loads(result.stdout)["items"]

    def test_plugin_registers_handoff_hooks(self):
        hooks = json.loads((PLUGIN / "hooks" / "hooks.json").read_bytes())["hooks"]
        self.assertEqual(
            set(hooks), {"SessionStart", "SubagentStart", "PostCompact", "PostToolUse"}
        )
        (registration,) = hooks["SessionStart"]
        for source in ("startup", "compact", "fork"):
            self.assertIsNotNone(re.search(registration["matcher"], source))
        self.assertIsNone(re.search(registration["matcher"], "resume"))
        self.assertIsNone(re.search(registration["matcher"], "clear"))
        self.assertIsNone(re.search(registration["matcher"], "not-compact"))
        (handler,) = registration["hooks"]
        self.assertEqual(handler["type"], "command")
        self.assertIs(handler["async"], True)
        entry = '"${PLUGIN_ROOT}/skills/thread-memory/scripts/rollout.py" hook'
        self.assertEqual(handler["command"], f"python3 -B {entry}")
        self.assertEqual(handler["commandWindows"], f"python -B {entry}")
        for event in ("SubagentStart", "PostCompact"):
            (registration,) = hooks[event]
            (handler,) = registration["hooks"]
            self.assertIs(handler["async"], True)
            self.assertEqual(handler["command"], f"python3 -B {entry}")
            self.assertEqual(handler["commandWindows"], f"python -B {entry}")
        (registration,) = hooks["PostToolUse"]
        self.assertIsNotNone(re.search(registration["matcher"], "exec_command"))
        (handler,) = registration["hooks"]
        self.assertIs(handler["async"], True)
        self.assertEqual(handler["command"], f"python3 -B {entry}")
        self.assertEqual(handler["commandWindows"], f"python -B {entry}")

    def test_startup_offers_memory_maintenance_only_to_root_threads(self):
        child_id = str(uuid4())
        child_header = {
            **self.header,
            "source": {"subagent": {"thread_spawn": {"parent_thread_id": child_id, "depth": 1}}},
            "thread_source": "subagent",
        }
        self.write_rollout(self.header)
        request = {**self.request, "source": "startup"}
        result = self.invoke(request, check=True)
        output = json.loads(result.stdout)["hookSpecificOutput"]
        self.assertEqual(output["hookEventName"], "SessionStart")
        context = output["additionalContext"]
        self.assertEqual(context, MAINTENANCE_GUIDANCE)
        self.assertNotIn(HISTORY, context)

        result = self.invoke({**request, "agent_id": child_id}, check=True)
        self.assertEqual(result.stdout, b"")

        self.write_rollout(child_header)
        self.assertEqual(self.invoke(request, check=True).stdout, b"")
        self.assertEqual(
            [item["event"] for item in self.diagnostics(self.session_id)],
            ["startup_context_prepared"],
        )

    def test_main_forks_copy_notes_silently_and_forked_subagents_start_empty(self):
        self.write_rollout(self.header)
        summary = "A private parent note"
        saved = self.handoff("write", stdin=summary)
        self.assertEqual(saved.returncode, 0, saved.stderr)
        forked_at = datetime.now(timezone.utc).isoformat()

        for event in ("SessionStart", "SubagentStart"):
            with self.subTest(event=event):
                child_id = str(uuid4())
                self.transcript = self.transcript.with_name(f"rollout-2026-01-01T00-00-01-{child_id}.jsonl")
                header = {**self.header, "id": child_id, "forked_from_id": self.session_id, "timestamp": forked_at}
                request = {"hook_event_name": event, "transcript_path": str(self.transcript)}
                if event == "SessionStart":
                    header.update(session_id=child_id)
                    request.update(session_id=child_id, source="fork")
                else:
                    header.update(
                        source={"subagent": {"thread_spawn": {"parent_thread_id": self.session_id, "depth": 1}}},
                        thread_source="subagent",
                        parent_thread_id=self.session_id,
                        subagent_history_start_ordinal=3,
                    )
                    request.update(session_id=self.session_id, agent_id=child_id, agent_type="worker")
                self.write_rollout(header)
                memory_read = [
                    sys.executable, "-B", str(SCRIPT), "memory", "read",
                    "--thread", child_id, "--codex-home", str(self.codex_home),
                ]
                if event == "SubagentStart":
                    before = subprocess.run(memory_read, capture_output=True, env=self.env)
                    self.assertEqual(before.returncode, 0, before.stderr)
                    self.assertIsNone(json.loads(before.stdout)["summary"])
                result = self.invoke(request, check=True)
                (diagnostic,) = self.diagnostics(child_id)
                note = subprocess.run(memory_read, capture_output=True, env=self.env)
                if event == "SessionStart":
                    self.assertEqual(result.stdout, b"")
                    self.assertEqual(diagnostic["event"], "fork_note_checked")
                    self.assertEqual(diagnostic["details"], {"note_status": "available"})
                    self.assertEqual(note.returncode, 0, note.stderr)
                    self.assertEqual(json.loads(note.stdout)["summary"], summary)
                else:
                    output = json.loads(result.stdout)["hookSpecificOutput"]
                    self.assertEqual(output["hookEventName"], event)
                    self.assertEqual(output["additionalContext"], MAINTENANCE_GUIDANCE)
                    self.assertEqual(diagnostic["event"], "subagent_start_context_prepared")
                    self.assertEqual(diagnostic["details"], {"note_status": "not_checked"})
                    self.assertEqual(note.returncode, 0, note.stderr)
                    self.assertIsNone(json.loads(note.stdout)["summary"])

    def test_ineligible_hooks_produce_no_output(self):
        parent_id = str(uuid4())
        child_id = str(uuid4())
        cases = (
            ("wrong event", self.header, {"hook_event_name": "UserPromptSubmit"}),
            (
                "subagent start",
                self.header,
                {"hook_event_name": "SubagentStart", "agent_id": child_id},
            ),
            ("resume", self.header, {"source": "resume"}),
            ("wrong source", self.header, {"source": "clear"}),
            ("missing transcript path", self.header, {"transcript_path": None}),
            ("attached session", {**self.header, "attached_thread": True}, {}),
            (
                "child rollout with parent session id",
                {**self.header, "id": child_id},
                {},
            ),
            (
                "subagent with matching session id",
                {
                    **self.header,
                    "source": {
                        "subagent": {
                            "thread_spawn": {"parent_thread_id": parent_id, "depth": 1}
                        }
                    },
                    "thread_source": "subagent",
                },
                {},
            ),
            (
                "internal with matching session id",
                {**self.header, "source": {"internal": "guardian"}},
                {},
            ),
            (
                "unavailable transcript",
                self.header,
                {"transcript_path": str(self.transcript.with_name("missing.jsonl"))},
            ),
            ("malformed header", b'{"type":\n', {}),
        )
        for case, header, request in cases:
            with self.subTest(case=case):
                if isinstance(header, bytes):
                    self.transcript.write_bytes(header)
                else:
                    self.write_rollout(header)
                result = self.invoke({**self.request, **request}, check=True)
                self.assertEqual(result.stdout, b"")
                self.assertEqual(result.stderr, b"")

    def test_malformed_hook_input_reports_structured_error(self):
        for payload in (b"{", b"[]"):
            with self.subTest(payload=payload):
                result = self.invoke(payload)
                self.assertEqual(result.returncode, 1)
                self.assertEqual(result.stdout, b"")
                self.assertEqual(
                    json.loads(result.stderr)["error"]["code"], "invalid_input"
                )

    def test_subagent_compaction_guidance_is_delivered_only_once_to_its_owner(self):
        self.write_rollout(self.header)
        requests = []
        for _ in range(2):
            child = str(uuid4())
            path = self.transcript.with_name(f"rollout-2026-01-01T00-00-01-{child}.jsonl")
            header = {
                **self.header,
                "id": child,
                "thread_source": "subagent",
                "source": {
                    "subagent": {"thread_spawn": {"parent_thread_id": self.session_id, "depth": 1}}
                },
            }
            path.write_text(
                json.dumps({"type": "session_meta", "payload": header}) + "\n", encoding="utf-8"
            )
            requests.append(
                {"agent_id": child, "agent_type": "worker", "transcript_path": str(path)}
            )
        child, sibling = requests
        root = {
            "session_id": self.session_id,
            "transcript_path": str(self.transcript),
            "cwd": str(self.codex_home),
            "model": "gpt-6.2-astra",
            "turn_id": str(uuid4()),
        }
        child_event = {**root, **child}
        start = {**child_event, "hook_event_name": "SubagentStart", "permission_mode": "default"}
        output = json.loads(self.invoke(start, check=True).stdout)["hookSpecificOutput"]
        self.assertEqual(output["hookEventName"], "SubagentStart")
        self.assertEqual(output["additionalContext"], MAINTENANCE_GUIDANCE)
        child_session_start = {
            **root,
            "transcript_path": child["transcript_path"],
            "hook_event_name": "SessionStart",
            "source": "compact",
        }
        self.assertEqual(self.invoke(child_session_start, check=True).stdout, b"")

        post_tool = {
            "hook_event_name": "PostToolUse",
            "permission_mode": "default",
            "tool_name": "exec_command",
            "tool_use_id": "call_after_compact",
            "tool_input": {},
            "tool_response": {},
        }
        request = {**child_event, **post_tool}
        self.assertEqual(self.invoke(request, check=True).stdout, b"")
        with Path(child["transcript_path"]).open("a", encoding="utf-8") as stream:
            checkpoint = {"type": "compacted", "payload": {"replacement_history": []}}
            stream.write(json.dumps(checkpoint) + "\n")
        post_compact = {"hook_event_name": "PostCompact", "trigger": "auto"}
        self.assertEqual(self.invoke({**root, **post_compact}, check=True).stdout, b"")
        wrong_agent = {**child_event, "agent_id": sibling["agent_id"]}
        self.assertEqual(self.invoke({**wrong_agent, **post_compact}, check=True).stdout, b"")
        self.assertEqual(self.invoke(request, check=True).stdout, b"")
        self.assertEqual(self.invoke({**child_event, **post_compact}, check=True).stdout, b"")
        self.assertEqual(
            [item["event"] for item in self.diagnostics(child["agent_id"])],
            ["subagent_compaction_pending", "subagent_start_context_prepared"],
        )

        for recipient in (root, {**root, **sibling}, wrong_agent):
            self.assertEqual(self.invoke({**recipient, **post_tool}, check=True).stdout, b"")
        with ThreadPoolExecutor(max_workers=2) as executor:
            outputs = list(
                executor.map(lambda _: self.invoke(request, check=True).stdout, range(2))
            )
        prompts = [output for output in outputs if output]
        self.assertEqual(len(prompts), 1, outputs)
        output = json.loads(prompts[0])["hookSpecificOutput"]
        self.assertEqual(output["hookEventName"], "PostToolUse")
        context = self.recovery_context(output["additionalContext"])
        self.assertIn("Context was compacted", context)
        self.assertIn("memory read", context)
        self.assertIn("Search the rollout", context)
        self.assertEqual(self.invoke(request, check=True).stdout, b"")

    def test_usage_stays_silent_until_the_first_compaction_reminder(self):
        self.env["THREAD_MEMORY_ASYNC_START_TOKENS"] = "500000"
        request = self.start_reminder_window()
        for tokens in (100_000, 200_000, 300_000, 400_000, 454_999):
            with self.subTest(tokens=tokens):
                self.append_usage(tokens)
                self.assertEqual(self.invoke(request, check=True).stdout, b"")

        self.append_usage(455_000)
        self.reminder_context(self.invoke(request, check=True).stdout, "0")

    @unittest.skipIf(sys.version_info < (3, 11), "automatic threshold needs tomllib")
    def test_subagent_checks_each_reminder_tier_for_delivery(self):
        request = self.start_reminder_window(child=True)
        self.append_usage(355_000, capacity=499_999)
        self.assertEqual(self.invoke(request, check=True).stdout, b"")

        self.append_usage(279_999)
        self.assertEqual(self.invoke(request, check=True).stdout, b"")
        self.append_usage(280_000)
        first = self.reminder_context(self.invoke(request, check=True).stdout, "65")
        self.assertIn("may be compressed soon", first)
        receipt_offset = self.transcript.stat().st_size
        self.record_reminder(first)
        self.append_usage(290_000)
        self.assertEqual(self.invoke(request, check=True).stdout, b"")
        # Keep the window key and remove the already observed receipt from the fixture.
        with self.transcript.open("r+b") as stream:
            stream.truncate(receipt_offset)
        for tokens in (300_000, 354_999):
            self.append_usage(tokens)
            self.assertEqual(self.invoke(request, check=True).stdout, b"")

        self.append_usage(355_000)
        self.reminder_context(self.invoke(request, check=True).stdout, "80")
        self.append_usage(365_000)
        follow_up = self.reminder_context(self.invoke(request, check=True).stdout, "80")
        self.record_reminder(follow_up)
        self.append_usage(375_000)
        self.assertEqual(self.invoke(request, check=True).stdout, b"")
        diagnostics = self.diagnostics(request["agent_id"])
        self.assertEqual(len({item["window"] for item in diagnostics}), 1)
        self.assertEqual(
            [(item["event"], item["details"]) for item in diagnostics],
            [
                ("reminder_receipt_observed", {"used": 375_000, "capacity": 500_000, "stages": [[80, 3]]}),
                ("reminder_context_prepared", {"used": 365_000, "capacity": 500_000, "stages": [[80, 1]]}),
                ("reminder_context_prepared", {"used": 355_000, "capacity": 500_000, "stages": [[80, 0]]}),
                ("reminder_receipt_observed", {"used": 290_000, "capacity": 500_000, "stages": [[65, 3]]}),
                ("reminder_context_prepared", {"used": 280_000, "capacity": 500_000, "stages": [[65, 0]]}),
            ],
        )

    @unittest.skipIf(sys.version_info < (3, 11), "automatic threshold needs tomllib")
    def test_main_thread_retries_missing_prompt_only_at_checkpoints(self):
        request = self.start_reminder_window()
        self.append_usage(280_000)
        first = self.reminder_context(self.invoke(request, check=True).stdout, "65")
        follow_up_notice = "This may be a duplicate reminder."
        self.assertNotIn(follow_up_notice, first)
        self.append_records(
            ("response_item", {
                "type": "message", "role": "user",
                "content": [{"type": "input_text", "text": first}],
            }),
            ("response_item", {
                "type": "function_call_output", "call_id": "call_echo", "output": first,
            }),
        )
        self.append_usage(289_999)
        self.assertEqual(self.invoke(request, check=True).stdout, b"")

        self.append_usage(290_000)
        with ThreadPoolExecutor(max_workers=2) as executor:
            outputs = list(executor.map(
                lambda index: self.invoke(
                    {**request, "tool_use_id": f"call_parallel_{index}"}, check=True
                ).stdout,
                range(2),
            ))
        prompts = [output for output in outputs if output]
        self.assertEqual(len(prompts), 1, outputs)
        retry = self.reminder_context(prompts[0], "65")
        self.assertIn(follow_up_notice, retry)

        self.append_usage(299_999)
        self.assertEqual(self.invoke(request, check=True).stdout, b"")
        self.append_usage(300_000)
        final = self.reminder_context(self.invoke(request, check=True).stdout, "65")
        self.assertIn(follow_up_notice, final)
        self.assertEqual(self.invoke(request, check=True).stdout, b"")

    @unittest.skipIf(sys.version_info < (3, 11), "automatic threshold needs tomllib")
    def test_reminder_coalesces_crossed_tiers_and_checks_only_current_window(self):
        request = self.start_reminder_window()
        self.append_usage(355_000)
        prompt = self.reminder_context(self.invoke(request, check=True).stdout, "65,80")
        self.assertEqual(self.invoke(request, check=True).stdout, b"")
        self.record_reminder(prompt)
        for tokens in (365_000, 375_000):
            self.append_usage(tokens)
            self.assertEqual(self.invoke(request, check=True).stdout, b"")

        self.append_records(("compacted", {"replacement_history": []}))
        self.append_usage(280_000)
        self.reminder_context(self.invoke(request, check=True).stdout, "65")
        self.record_reminder(prompt)
        self.append_usage(290_000)
        self.reminder_context(self.invoke(request, check=True).stdout, "65")

    def start_reminder_window(self, *, child=False):
        (self.codex_home / "config.toml").write_text(
            "model_context_window = 500000\n[features.async_compaction]\nenabled = true\n",
            encoding="utf-8",
        )
        turn = str(uuid4())
        model = "gpt-6.2-astra"
        self.write_model_cache(model)
        header = self.header
        agent = {}
        if child:
            child_id = str(uuid4())
            self.transcript = self.transcript.with_name(f"rollout-2026-01-01T00-00-01-{child_id}.jsonl")
            header = {
                **self.header,
                "id": child_id,
                "source": {
                    "subagent": {"thread_spawn": {"parent_thread_id": self.session_id, "depth": 1}}
                },
                "thread_source": "subagent",
            }
            agent.update(agent_id=child_id, agent_type="worker")
        self.append_records(
            ("session_meta", header),
            (
                "event_msg",
                {"type": "task_started", "turn_id": turn, "model_context_window": 500_000},
            ),
            ("turn_context", {"turn_id": turn, "model": model}),
        )
        return {
            "hook_event_name": "PostToolUse",
            "session_id": self.session_id,
            "transcript_path": str(self.transcript),
            "cwd": str(self.codex_home),
            "turn_id": turn,
            "model": model,
            "permission_mode": "default",
            "tool_name": "exec_command",
            "tool_use_id": "call_threshold",
            "tool_input": {},
            "tool_response": {},
            **agent,
        }

    def recovery_context(self, context):
        recovery, _, maintenance = context.partition("\n\n")
        self.assertTrue(recovery.startswith("<thread_memory_recovery>\n"), context)
        self.assertTrue(recovery.endswith("\n</thread_memory_recovery>"), context)
        self.assertEqual(maintenance, MAINTENANCE_GUIDANCE)
        self.assertNotIn(MAINTENANCE_GUIDANCE, recovery)
        return recovery

    def reminder_context(self, stdout, levels):
        self.assertTrue(stdout, "No warning at the configured usage threshold")
        output = json.loads(stdout)["hookSpecificOutput"]
        self.assertEqual(output["hookEventName"], "PostToolUse")
        context = output["additionalContext"]
        self.assertTrue(context.startswith("<thread_memory_reminder>\n"), context)
        self.assertIn("$thread-memory", context)
        self.assertNotIn("--window", context)
        self.assertRegex(
            context, rf"\nNotify ID: \[{levels}:[A-Za-z0-9_-]{{8}}\]\n</thread_memory_reminder>\Z"
        )
        return context

    def record_reminder(self, context):
        self.append_records(("response_item", {
            "type": "message",
            "role": "developer",
            "content": [
                {"type": "input_text", "text": "A different hook response."},
                {"type": "input_text", "text": context},
            ],
            "internal_chat_message_metadata_passthrough": {
                "content_item_kinds": ["hooks.additional_context", "hooks.additional_context"],
                "content_item_metadata": [
                    {"provenance": {"type": "harness", "hook": True}},
                    {"provenance": {"type": "harness", "hook": True}},
                ],
            },
        }))

    def write_model_cache(self, *models):
        entries = [
            {"slug": model, "context_window": 500_000, "effective_context_window_percent": 100}
            for model in models
        ]
        (self.codex_home / "models_cache.json").write_text(
            json.dumps({"models": entries}), encoding="utf-8"
        )

    def append_records(self, *records):
        with self.transcript.open("a", encoding="utf-8") as stream:
            for kind, payload in records:
                stream.write(json.dumps({"type": kind, "payload": payload}) + "\n")

    def append_usage(self, tokens, *, capacity=500_000):
        self.append_records(
            (
                "event_msg",
                {
                    "type": "token_count",
                    "info": {
                        "last_token_usage": {"total_tokens": tokens},
                        "model_context_window": capacity,
                    },
                },
            ),
        )

    def handoff(self, action, window=None, stdin=None, *, current=False):
        command = [
            sys.executable,
            "-B",
            str(SCRIPT),
            "handoff",
            action,
            "--codex-home",
            str(self.codex_home),
        ]
        if window is not None:
            command.extend(("--window", window))
        if current:
            command.append("--current")
        return subprocess.run(
            command,
            input=stdin.encode("utf-8") if stdin is not None else b"",
            env={**self.env, "CODEX_THREAD_ID": self.session_id},
            capture_output=True,
        )

    def test_manual_compaction_recovers_handoff_written_without_a_window_hint(self):
        self.append_records(("session_meta", self.header))
        summary = "Continue the manual handoff from this saved note."
        saved = self.handoff("write", stdin=summary)
        self.assertEqual(saved.returncode, 0, saved.stderr)
        receipt = json.loads(saved.stdout)
        self.assertEqual(receipt["thread_id"], self.session_id)
        window = receipt["window"]

        active_window = self.handoff("read")
        self.assertEqual(active_window.returncode, 1, active_window.stderr)
        self.assertEqual(json.loads(active_window.stderr)["error"]["code"], "not_found")

        self.append_records(("compacted", {"replacement_history": []}))
        outcome = json.loads(self.invoke(self.request, check=True).stdout)
        context = self.recovery_context(outcome["hookSpecificOutput"]["additionalContext"])
        self.assertIn("memory read", context)
        (diagnostic,) = self.diagnostics(self.session_id)
        self.assertEqual(diagnostic["event"], "compact_context_prepared")
        self.assertEqual(diagnostic["details"], {"note_status": "available"})

        result = self.handoff("read")
        self.assertEqual(result.returncode, 0, result.stderr)
        restored = json.loads(result.stdout)
        self.assertEqual(restored["window"], window)
        self.assertEqual(restored["summary"], summary)

        self.append_records(("compacted", {"replacement_history": []}))
        missing_note = self.handoff("read")
        self.assertEqual(missing_note.returncode, 1, missing_note.stderr)
        self.assertEqual(json.loads(missing_note.stderr)["error"]["code"], "not_found")

    def test_main_compaction_without_a_note_renews_memory_maintenance(self):
        self.write_rollout(self.header)
        outcome = json.loads(self.invoke(self.request, check=True).stdout)
        context = self.recovery_context(outcome["hookSpecificOutput"]["additionalContext"])
        self.assertIn("Context was compacted", context)
        self.assertIn("earlier context", context)
        (diagnostic,) = self.diagnostics(self.session_id)
        self.assertEqual(diagnostic["details"], {"note_status": "missing"})

    def test_handoff_caps_saved_utf8_bytes_and_marks_truncation(self):
        self.append_records(("session_meta", self.header))
        exact = "x" * 8192
        # The next character straddles the 8171-byte allowance before the marker.
        prefix = "x" * 8167 + "\u76ee"
        cases = (
            ("exact limit", "\ufeff" + exact + "\r\n", exact, False),
            (
                "oversized",
                prefix + "\u6807" + "y" * 70_000 + "\r\n",
                prefix + "\n\n[Summary truncated]",
                True,
            ),
            ("oversized blank prefix", " " * 8192 + "Earlier decisions", "[Summary truncated]", True),
        )
        for label, submitted, expected, truncated in cases:
            with self.subTest(label=label):
                result = self.handoff("write", stdin=submitted)
                self.assertEqual(result.returncode, 0, result.stderr)
                receipt = json.loads(result.stdout)
                self.assertIs(receipt["truncated"], truncated)
                self.assertEqual(receipt["bytes"], len(expected.encode("utf-8")))
                self.assertLessEqual(receipt["bytes"], 8192)

                self.append_records(("compacted", {"replacement_history": [], "message": label}))
                saved = self.handoff("read")
                self.assertEqual(saved.returncode, 0, saved.stderr)
                self.assertEqual(json.loads(saved.stdout)["summary"], expected)

    def test_handoff_patches_current_and_previous_notes_without_partial_writes(self):
        self.append_records(("session_meta", self.header))
        original = "Goal\nOld task\nKeep heading\nNext steps\n" + "x" * 7000
        result = self.handoff("write", stdin=original)
        self.assertEqual(result.returncode, 0, result.stderr)
        window = json.loads(result.stdout)["window"]
        result = self.handoff("read", current=True)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(json.loads(result.stdout)["summary"], original)

        headers = "--- a/handoff\n+++ b/handoff\n"
        patch = headers + "@@ -1,3 +1,3 @@\n Goal\n-Old task\n+Current task\n Keep heading\n"
        result = self.handoff("patch", window, patch, current=True)
        self.assertEqual(result.returncode, 0, result.stderr)

        self.append_records(("compacted", {"replacement_history": []}))
        patch = headers + "@@ -2,3 +2,3 @@\n Current task\n Keep heading\n-Next steps\n+Review results\n"
        result = self.handoff("patch", stdin=patch)
        self.assertEqual(result.returncode, 0, result.stderr)
        expected = original.replace("Old task", "Current task").replace(
            "Next steps", "Review results"
        )
        result = self.handoff("read")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(json.loads(result.stdout)["summary"], expected)

        invalid_patches = (
            headers + "@@ -2 +2 @@\n-Current task\n+Partial edit\n"
            "@@ -4 +4 @@\n-Wrong original text\n+Invalid edit\n",
            headers + "@@ -3 +3 @@\n-Keep heading\n+" + "z" * 2000 + "\n",
        )
        for patch in invalid_patches:
            result = self.handoff("patch", stdin=patch)
            self.assertNotEqual(result.returncode, 0)
            result = self.handoff("read")
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertEqual(json.loads(result.stdout)["summary"], expected)

    @unittest.skipIf(sys.version_info < (3, 11), "automatic threshold needs tomllib")
    def test_handoff_is_written_once_and_reopened_only_for_the_next_checkpoint(self):
        (self.codex_home / "config.toml").write_text(
            "model_context_window = 500000\n"
            "[features.async_compaction]\n"
            "enabled = true\n"
            "model_async_compact_threshold_percent = 65\n",
            encoding="utf-8",
        )
        self.append_records(("session_meta", self.header))
        previous_turn_id = str(uuid4())
        turn_id = str(uuid4())
        model = "gpt-6.2-astra"
        self.write_model_cache(model, "gpt-6.2-sol")
        self.append_records(
            ("turn_context", {"turn_id": previous_turn_id, "model": "gpt-6.2-sol"}),
            (
                "token_usage_record",
                {"turn_id": previous_turn_id, "usage": {"total_tokens": 320_000}},
            ),
            (
                "event_msg",
                {
                    "type": "task_started",
                    "turn_id": turn_id,
                    "model_context_window": 500_000,
                },
            ),
            ("turn_context", {"turn_id": turn_id, "model": model}),
        )
        request = {
            key: value for key, value in self.request.items() if key != "source"
        }
        request.update(
            hook_event_name="PostToolUse",
            cwd=str(self.codex_home),
            model=model,
            permission_mode="default",
            tool_name="exec_command",
            tool_use_id="call_fixture",
            tool_input={},
            tool_response={},
            turn_id=turn_id,
        )
        self.assertEqual(self.invoke(request, check=True).stdout, b"")
        self.append_usage(279_999)
        self.assertEqual(self.invoke(request, check=True).stdout, b"")
        self.append_records(
            (
                "token_usage_record",
                {"turn_id": turn_id, "usage": {"total_tokens": 280_000}},
            )
        )
        self.assertEqual(
            self.invoke({**request, "turn_id": previous_turn_id}, check=True).stdout,
            b"",
        )
        self.assertEqual(
            self.invoke({**request, "model": "gpt-6.2-sol"}, check=True).stdout,
            b"",
        )
        self.assertEqual(
            self.invoke({**request, "agent_id": str(uuid4())}, check=True).stdout, b""
        )
        with ThreadPoolExecutor(max_workers=2) as executor:
            outputs = list(
                executor.map(lambda _: self.invoke(request, check=True).stdout, range(2))
            )
        prompts = [output for output in outputs if output]
        self.assertEqual(len(prompts), 1, outputs)
        self.reminder_context(prompts[0], "65")
        window = snapshot(self.transcript, include_previous=False).current

        summary = "Next: review the saved result for \u76ee\u6807."
        # A crash can leave a partial checkpoint ending in the nested item's braces.
        partial_checkpoint = json.dumps(
            {
                "type": "compacted",
                "payload": {"replacement_history": [{"content": {"text": "x" * (300 * 1024)}}]},
            }
        ).encode("ascii")[:-3]
        with self.transcript.open("ab") as stream:
            original_size = stream.tell()
            stream.write(partial_checkpoint)
        result = self.handoff("write", window, summary)
        self.assertEqual(result.returncode, 0, result.stderr)
        with self.transcript.open("r+b") as stream:
            stream.truncate(original_size)
        database = (
            self.codex_home / "state" / "plugins" / "thread-memory" / "handoff.sqlite3"
        )
        self.assertEqual(database.read_bytes()[:16], b"SQLite format 3\x00")

        self.append_records(("compacted", {"replacement_history": [], "message": "first"}))
        output = json.loads(self.invoke(self.request, check=True).stdout)["hookSpecificOutput"]
        context = output["additionalContext"]
        self.assertIn("memory read", context)
        self.assertNotIn(summary, context)
        self.assertNotEqual(self.handoff("write", window, "Late replacement").returncode, 0)
        result = self.handoff("read", window)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(json.loads(result.stdout)["summary"], summary)
        self.assertEqual(self.invoke(request, check=True).stdout, b"")

        self.append_records(("compacted", {"replacement_history": [], "message": "second"}))
        output = json.loads(self.invoke(self.request, check=True).stdout)["hookSpecificOutput"]
        self.assertIn("memory read", output["additionalContext"])
        result = self.handoff("read", window)
        self.assertEqual(result.returncode, 1, result.stderr)
        self.assertEqual(json.loads(result.stderr)["error"]["code"], "not_found")


if __name__ == "__main__":
    unittest.main()
