import json
import os
import sqlite3
import subprocess
import sys
import tempfile
import unittest
from contextlib import closing
from pathlib import Path
from uuid import uuid4

CLI = (
    Path(__file__).resolve().parents[1]
    / "skills"
    / "thread-memory"
    / "scripts"
    / "rollout.py"
)


def encoded(*rows):
    return b"".join((json.dumps(row) + "\n").encode() for row in rows)


def response(ordinal, message):
    return {
        "ordinal": ordinal,
        "type": "response_item",
        "payload": {
            "type": "message",
            "role": "user",
            "content": [{"type": "input_text", "text": message}],
        },
    }


class RolloutCLITest(unittest.TestCase):
    def test_fatal_errors_emit_one_json_diagnostic(self):
        cli = [sys.executable, "-B", str(CLI)]
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "fixture.jsonl"
            path.write_bytes(
                encoded({"type": "session_meta", "payload": {"id": "fixture"}})
            )
            cases = (
                ("unknown option", ["inspect", "-x"], None, 2, "invalid_arguments"),
                (
                    "invalid diagnostics thread",
                    ["diagnostics", "--thread", "invalid-id"],
                    None,
                    2,
                    "invalid_arguments",
                ),
                (
                    "oversized option",
                    ["inspect", "--" + "x" * 6000],
                    None,
                    2,
                    "invalid_arguments",
                ),
                (
                    "invalid UTF-8 selector",
                    ["tool-output", "--id", "-"],
                    b"\xff\n",
                    1,
                    "invalid_input",
                ),
                (
                    "oversized regex repeat",
                    [
                        "search",
                        "--rollout",
                        str(path),
                        "--regex",
                        "x{" + "9" * 21 + "}",
                    ],
                    None,
                    1,
                    "invalid_input",
                ),
                (
                    "regex with both a warning and a syntax error",
                    ["search", "--rollout", str(path), "--regex", "[[a"],
                    None,
                    1,
                    "invalid_input",
                ),
            )
            for case, arguments, stdin, exit_code, error_code in cases:
                with self.subTest(case=case):
                    result = subprocess.run(
                        cli + arguments, input=stdin, check=False, capture_output=True
                    )
                    self.assertEqual(result.returncode, exit_code)
                    self.assertEqual(result.stdout, b"")
                    self.assertLess(len(result.stderr), 1024)
                    diagnostic = result.stderr.decode("utf-8")
                    self.assertEqual(len(diagnostic.splitlines()), 1)
                    self.assertNotIn("Traceback", diagnostic)
                    error = json.loads(diagnostic)["error"]
                    self.assertEqual(error["code"], error_code)
                    self.assertTrue(error["message"])

    def test_closed_stdout_exits_quietly(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "fixture.jsonl"
            path.write_bytes(
                encoded({"type": "session_meta", "payload": {"id": "fixture"}})
            )
            for arguments in (["inspect", "--rollout", str(path)], ["--help"]):
                with self.subTest(arguments=arguments):
                    read_fd, write_fd = os.pipe()
                    os.close(read_fd)
                    try:
                        result = subprocess.run(
                            [sys.executable, "-B", str(CLI), *arguments],
                            stdout=write_fd,
                            stderr=subprocess.PIPE,
                            check=False,
                        )
                    finally:
                        os.close(write_fd)
                    self.assertEqual(result.returncode, 141)
                    self.assertEqual(result.stderr, b"")

    def test_recover_can_request_only_text_or_only_images(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "recovery.jsonl"
            message = response(1, "missing message")
            message["payload"]["content"].append(
                {"type": "input_image", "image_url": "data:image/png;base64,AA=="}
            )
            image_only = response(2, "")
            image_only["payload"]["content"] = [message["payload"]["content"][-1]]
            path.write_bytes(
                encoded(
                    {"type": "session_meta", "payload": {"id": "fixture"}},
                    message,
                    image_only,
                    {
                        "type": "compacted",
                        "payload": {"window_number": 1, "replacement_history": []},
                    },
                )
            )
            command = [
                sys.executable,
                "-B",
                str(CLI),
                "recover",
                "--rollout",
                str(path),
            ]
            text_only = json.loads(
                subprocess.check_output(
                    [*command, "--max-images", "0", "--max-messages", "1"]
                )
            )
            self.assertEqual(text_only["messages"][0]["text"], "missing message")
            self.assertEqual(text_only["candidate_count"], 2)
            self.assertEqual(text_only["image_records"], [])
            self.assertEqual(text_only["image_candidate_count"], 1)

            images_only = json.loads(
                subprocess.check_output([*command, "--max-messages", "0"])
            )
            self.assertEqual(images_only["messages"], [])
            self.assertEqual(len(images_only["image_records"][0]["images"]), 1)

    def test_tool_input_and_output_require_ids_while_chat_remains_directly_readable(
        self,
    ):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "fixture.jsonl"
            path.write_bytes(
                encoded(
                    {"type": "session_meta", "payload": {"id": "fixture"}},
                    response(1, "ordinary-chat user"),
                    {
                        "type": "response_item",
                        "payload": {
                            "type": "message",
                            "role": "assistant",
                            "content": [
                                {
                                    "type": "output_text",
                                    "text": "ordinary-chat assistant",
                                }
                            ],
                        },
                    },
                    {
                        "type": "response_item",
                        "payload": {
                            "type": "custom_tool_call",
                            "call_id": "call-other",
                            "name": "not_apply_patch",
                            "input": "unselected-tool-input",
                        },
                    },
                    {
                        "type": "response_item",
                        "payload": {
                            "type": "custom_tool_call",
                            "id": "call-record",
                            "call_id": "call-fixture",
                            "name": "apply_patch",
                            "input": "tool-argument-secret\n" + "x" * 10000,
                        },
                    },
                    {
                        "type": "response_item",
                        "payload": {
                            "type": "custom_tool_call_output",
                            "id": "other-output",
                            "call_id": "call-other",
                            "output": "unselected-tool-return",
                        },
                    },
                    {
                        "type": "response_item",
                        "payload": {
                            "type": "custom_tool_call_output",
                            "id": "selected-output",
                            "call_id": "call-fixture",
                            "output": "tool-return-secret\nselected line\nlast line",
                        },
                    },
                )
            )

            def run(command, *options, stdin=None, check=True):
                return subprocess.run(
                    [
                        sys.executable,
                        "-B",
                        str(CLI),
                        command,
                        "--rollout",
                        str(path),
                        *options,
                    ],
                    input=stdin,
                    check=check,
                    capture_output=True,
                )

            preview = run("read", "--lines", "2:7").stdout
            self.assertIn(b"ordinary-chat user", preview)
            self.assertIn(b"ordinary-chat assistant", preview)
            self.assertNotIn(b"tool-return-secret", preview)
            self.assertNotIn(b"tool-argument-secret", preview)
            self.assertNotIn(
                b"tool-return-secret",
                run("read", "--lines", "7:7", "--field", "output").stdout,
            )
            self.assertEqual(
                json.loads(run("search", "tool-return-secret").stdout)["items"], []
            )
            self.assertEqual(
                json.loads(run("search", "tool-argument-secret").stdout)["items"], []
            )
            self.assertEqual(
                len(json.loads(run("search", "ordinary-chat").stdout)["items"]), 2
            )
            self.assertEqual(len(json.loads(run("transcript").stdout)["items"]), 2)

            scope = ("--lines", "6:7", "--tool", "apply_patch", "--limit", "1")
            (output,) = json.loads(run("read", *scope).stdout)["items"]
            self.assertEqual(output["call_id"], "call-fixture")
            (hit,) = json.loads(run("search", "call-", *scope).stdout)["items"]
            self.assertEqual(hit["output_id"], output["output_id"])
            detail = run("tool-output", "--id", output["output_id"]).stdout
            self.assertIn(b"tool-return-secret", detail)
            self.assertNotIn(b"unselected-tool-return", detail)
            selected = json.loads(
                run(
                    "tool-output",
                    "--id",
                    "-",
                    "--lines",
                    "2:2",
                    stdin=(output["output_id"] + "\r\n").encode("utf-8"),
                ).stdout
            )
            self.assertEqual(selected["items"][0]["text"], "selected line\n")
            self.assertIsNone(selected["next_cursor"])
            argument = next(
                record
                for record in json.loads(preview)["items"]
                if record.get("item_id") == "call-record"
            )
            input_page = json.loads(
                run(
                    "tool-input",
                    "--id",
                    argument["input_id"],
                    "--lines",
                    "1",
                    "--budget-chars",
                    "40",
                ).stdout
            )
            self.assertEqual(input_page["items"][0]["text"], "tool-argument-secret\n")
            cursor = (input_page["next_cursor"] + "\n").encode("utf-8")
            continued = json.loads(
                run("tool-input", "--cursor", "-", stdin=cursor).stdout
            )
            self.assertEqual(continued["items"][0]["text"], "x" * 40)
            self.assertIsNotNone(continued["next_cursor"])
            failure = run(
                "tool-input", "--cursor", "-", "--lines", "1", stdin=cursor, check=False
            )
            self.assertNotEqual(failure.returncode, 0)
            self.assertEqual(failure.stdout, b"")

            output_id = output["output_id"]
            for options, stdin in (
                (("--id", "-", "--cursor", "-"), (output_id + "\n").encode("utf-8")),
                (("--id", "-"), ((output_id + "\n") * 2).encode("utf-8")),
            ):
                with self.subTest(options=options):
                    failure = run("tool-output", *options, stdin=stdin, check=False)
                    self.assertNotEqual(failure.returncode, 0)
                    self.assertEqual(failure.stdout, b"")

    def test_record_refs_and_image_ids_chain_through_stdin(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "image-references.jsonl"
            unrelated = response(1, "other message")
            unrelated["payload"]["content"].append(
                {"type": "input_image", "image_url": "https://example.test/decoy.png"}
            )
            message = response(2, "image references")
            message["payload"]["content"].append(
                {"type": "input_text", "text": "padding " * 70 + "needle near the end"}
            )
            message["payload"]["content"].extend(
                {
                    "type": "input_image",
                    "image_url": f"https://example.test/image-{index}.png",
                }
                for index in range(3)
            )
            path.write_bytes(
                encoded(
                    {"type": "session_meta", "payload": {"id": "fixture"}},
                    unrelated,
                    message,
                )
            )
            cli = [sys.executable, "-B", str(CLI)]
            source = ["--rollout", str(path)]
            search = json.loads(
                subprocess.check_output(
                    [*cli, "search", *source, "needle", "--max-chars", "24"]
                )
            )
            (hit,) = search["items"]
            hit_stdin = (hit["ref"] + "\n").encode("utf-8")
            detail = json.loads(
                subprocess.check_output(
                    [*cli, "read", *source, "--ref", "-", "--max-chars", "64"],
                    input=hit_stdin,
                )
            )
            (record,) = detail["items"]
            (field,) = record["fields"]
            self.assertEqual(field["field_index"], hit["field_index"])
            self.assertIn("needle", field["text"])
            self.assertTrue(record["ref"])

            transcript = json.loads(
                subprocess.check_output([*cli, "transcript", *source, "--lines", "3:3"])
            )
            (chat,) = transcript["items"]
            chat_detail = json.loads(
                subprocess.check_output([*cli, "read", *source, "--ref", chat["ref"]])
            )
            (expanded_chat,) = chat_detail["items"]
            self.assertTrue(expanded_chat["text"].startswith("image references"))
            images = json.loads(
                subprocess.check_output(
                    [*cli, "images", *source, "--ref", "-"],
                    input=(chat["ref"] + "\n").encode("utf-8"),
                )
            )
            self.assertIsNone(images["next_cursor"])
            ids = [image["image_id"] for image in images["items"]]
            self.assertEqual(len(ids), 3)
            stdin = ("\n".join(ids[1:]) + "\n").encode("utf-8")
            exported = json.loads(
                subprocess.check_output(
                    [*cli, "export-image", *source, "--id", "-", "--id", ids[0]],
                    input=stdin,
                )
            )
            self.assertEqual(
                [image["image_id"] for image in exported["images"]],
                [*ids[1:], ids[0]],
            )
            self.assertEqual(exported["unknown_ids"], [])

            failure = subprocess.run(
                [*cli, "export-image", *source, "--id", "-", "--id", "-"],
                input=stdin,
                capture_output=True,
                check=False,
            )
            self.assertNotEqual(failure.returncode, 0)
            self.assertEqual(failure.stdout, b"")

            search_images = [*cli, "images", *source, "--ref", "-"]
            before = json.loads(subprocess.check_output(search_images, input=hit_stdin))
            self.assertEqual([image["image_id"] for image in before["items"]], ids)
            path.write_bytes(
                path.read_bytes().replace(b"/image-0.png", b"/image-x.png", 1)
            )
            stale = subprocess.run(
                search_images, input=hit_stdin, capture_output=True, check=False
            )
            self.assertNotEqual(stale.returncode, 0)
            self.assertEqual(stale.stdout, b"")

    def test_inventory_locates_unknown_records_without_exposing_payload(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "future-record.jsonl"
            path.write_bytes(
                encoded(
                    {"type": "session_meta", "payload": {"id": "fixture"}},
                    {
                        "type": "event_msg",
                        "payload": {
                            "type": "item_completed",
                            "item": {
                                "type": "FutureWidget",
                                "text": "private-future-body",
                            },
                        },
                    },
                    {
                        "type": "event_msg",
                        "payload": {
                            "type": "thread_goal_updated",
                            "turnId": "goal-turn",
                            "goal": {
                                "objective": "finish the fixture",
                                "status": "active",
                            },
                        },
                    },
                )
            )
            cli = [sys.executable, "-B", str(CLI)]
            source = ["--rollout", str(path)]
            raw = subprocess.check_output(
                [*cli, "inventory", *source, "--type", "FutureWidget"]
            )
            self.assertNotIn(b"private-future-body", raw)
            (group,) = json.loads(raw)["items"]
            self.assertEqual((group["item_type"], group["count"]), ("FutureWidget", 1))
            example = group["example"]
            self.assertEqual(example["line"], 2)
            raw = subprocess.check_output(
                [
                    *cli,
                    "read",
                    *source,
                    "--metadata-only",
                    "--lines",
                    f"{example['line']}:{example['line']}",
                ]
            )
            self.assertNotIn(b"private-future-body", raw)
            (record,) = json.loads(raw)["items"]
            self.assertEqual(record["fields"], [])
            self.assertEqual(record["ref"], example["ref"])
            goal = json.loads(
                subprocess.check_output(
                    [
                        *cli,
                        "inventory",
                        *source,
                        "--type",
                        "thread_goal_updated",
                        "--turn",
                        "goal-turn",
                    ]
                )
            )
            self.assertEqual(goal["record_count"], 1)

    def test_tool_input_pointer_reads_typed_value_from_piped_id(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "typed-input.jsonl"
            selected = [True, None, 23]
            path.write_bytes(
                encoded(
                    {"type": "session_meta", "payload": {"id": "fixture"}},
                    {
                        "type": "response_item",
                        "payload": {
                            "type": "function_call",
                            "name": "typed-tool",
                            "call_id": "typed-call",
                            "arguments": json.dumps(
                                {"a.b": selected, "a": {"b": "unselected-sibling"}}
                            ),
                        },
                    },
                )
            )
            cli = [sys.executable, "-B", str(CLI)]
            source = ["--rollout", str(path)]
            page = json.loads(
                subprocess.check_output([*cli, "read", *source, "--role", "tool"])
            )
            (record,) = page["items"]
            raw = subprocess.check_output(
                [
                    *cli,
                    "tool-input",
                    *source,
                    "--id",
                    "-",
                    "--pointer",
                    "/arguments/a.b",
                ],
                input=(record["input_id"] + "\r\n").encode("utf-8"),
            )
            self.assertNotIn(b"unselected-sibling", raw)
            value = json.loads(raw)["value"]
            self.assertEqual(value, selected)
            self.assertIs(value[0], True)

    def test_salvage_reports_physical_damage_and_clears_uncertain_turn(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "damaged.jsonl"
            prefix = encoded(
                {"type": "session_meta", "payload": {"id": "fixture"}},
                {
                    "type": "event_msg",
                    "payload": {"type": "task_started", "turn_id": "known"},
                },
                response(2, "needle before gap"),
            )
            path.write_bytes(
                prefix
                + b'{"type":"event_msg","payload":{\n'
                + encoded(response(4, "needle after gap"))
                + b'{"type":'
            )
            command = [
                sys.executable,
                "-B",
                str(CLI),
                "search",
                "needle",
                "--rollout",
                str(path),
            ]
            strict = subprocess.run(command, check=False, capture_output=True)
            self.assertEqual(strict.returncode, 1)
            self.assertEqual(strict.stdout, b"")
            diagnostic = json.loads(strict.stderr)["error"]
            self.assertEqual(diagnostic["code"], "invalid_rollout")
            self.assertIn("invalid JSONL", diagnostic["message"])

            salvaged = json.loads(
                subprocess.check_output([*command, "--salvage", "--limit", "1"])
            )
            resumed = json.loads(
                subprocess.check_output(
                    [
                        *command,
                        "--salvage",
                        "--limit",
                        "1",
                        "--cursor",
                        salvaged["next_cursor"],
                    ]
                )
            )
            self.assertEqual(
                [row["line"] for row in salvaged["items"] + resumed["items"]],
                [3, 5],
            )
            self.assertNotIn("turn_id", resumed["items"][0])
            self.assertEqual(
                [
                    (row["line"], row["reason"])
                    for row in resumed["damaged_records"]["items"]
                ],
                [(4, "invalid_json"), (6, "partial_tail")],
            )
            self.assertEqual(
                resumed["damaged_records"]["items"][0]["byte_offset"], len(prefix)
            )

            output_path = Path(directory) / "saved.json"
            pointer = json.loads(
                subprocess.check_output(
                    [*command, "--salvage", "--output", str(output_path)]
                )
            )
            self.assertEqual(pointer["output"], str(output_path.resolve()))
            self.assertEqual(pointer["damaged_record_count"], 2)
            self.assertNotIn("items", pointer)
            self.assertIsNone(pointer["next_cursor"])
            self.assertEqual(len(json.loads(output_path.read_bytes())["items"]), 2)

    def test_subagent_default_and_copied_prefix_scope(self):
        with tempfile.TemporaryDirectory() as directory:
            home = Path(directory)
            sessions = home / "sessions"
            sessions.mkdir()
            parent_id, child_id = str(uuid4()), str(uuid4())
            parent = sessions / f"rollout-2026-01-01T00-00-00-{parent_id}.jsonl"
            child = sessions / f"rollout-2026-01-02T00-00-00-{child_id}.jsonl"
            parent_header = {
                "ordinal": 0,
                "type": "session_meta",
                "payload": {"id": parent_id},
            }
            parent.write_bytes(encoded(parent_header, response(1, "parent-only")))
            child.write_bytes(
                encoded(
                    {
                        "ordinal": 0,
                        "type": "session_meta",
                        "payload": {
                            "id": child_id,
                            "session_id": parent_id,
                            "forked_from_id": parent_id,
                            "subagent_history_start_ordinal": 4,
                        },
                    },
                    {**parent_header, "ordinal": 1},
                    {
                        **response(2, "copied conversation"),
                        "metadata": {"inherited_user_message": True},
                        "timestamp": "2026-01-02T00:00:00Z",
                    },
                    {
                        "ordinal": 3,
                        "type": "compacted",
                        "payload": {"window_number": 0, "replacement_history": []},
                    },
                    response(4, "child conversation"),
                )
            )

            def run(command, *args):
                return json.loads(
                    subprocess.check_output(
                        [
                            sys.executable,
                            "-B",
                            str(CLI),
                            command,
                            "--codex-home",
                            str(home),
                            *args,
                        ],
                        env={
                            **os.environ,
                            "CODEX_THREAD_ID": child_id,
                            "CODEX_SESSION_ID": parent_id,
                        },
                    )
                )

            inherited = run("transcript", "--origin", "inherited")["items"]
            self.assertEqual(
                [
                    (row["text"], row["timestamp_origin"], row["forked_from_thread_id"])
                    for row in inherited
                ],
                [("copied conversation", "copied_at", parent_id)],
            )
            self.assertEqual(
                [
                    row["text"]
                    for row in run("transcript", "--origin", "current")["items"]
                ],
                ["child conversation"],
            )
            self.assertEqual(
                run("windows", "--window", "0")["items"][0]["origin"], "inherited"
            )
            self.assertEqual(run("recover")["status"], "no_compaction")
            self.assertEqual(
                [row["thread_id"] for row in run("lineage")["fork_chain"]],
                [child_id, parent_id],
            )

    def test_opaque_items_report_only_attributable_tokens(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "opaque.jsonl"
            usage = {
                "response_id": "response-for-summary",
                "usage": {
                    "input_tokens": 100,
                    "cached_input_tokens": 12,
                    "cache_write_input_tokens": 0,
                    "reasoning_output_tokens": 17,
                    "output_tokens": 60,
                    "total_tokens": 160,
                },
            }
            reasoning = {
                "type": "response_item",
                "payload": {
                    "type": "reasoning",
                    "encrypted_content": "private-blob",
                    "summary": [{"type": "summary_text", "text": "mirror-text"}],
                },
            }
            mirror = {
                "type": "event_msg",
                "payload": {
                    "type": "item_completed",
                    "item": {"type": "Reasoning", "summary_text": ["mirror-text"]},
                },
            }
            summary = {
                "type": "compacted",
                "payload": {
                    "window_number": 0,
                    "compaction_response_id": "response-for-summary",
                    "message": "mirror-text",
                    "replacement_history": [
                        {"type": "compaction", "encrypted_content": "private-blob"}
                    ],
                },
            }
            unmatched = {
                "type": "compacted",
                "payload": {
                    **summary["payload"],
                    "window_number": True,
                    "compaction_response_id": "missing-response",
                    "latest_token_usage_record": usage,
                },
            }
            path.write_bytes(
                encoded(
                    {"type": "session_meta", "payload": {"id": "opaque"}},
                    reasoning,
                    mirror,
                    {"type": "token_usage_record", "payload": usage},
                    {"type": "token_usage_record", "payload": usage},
                    {
                        "type": "token_usage_record",
                        "payload": {
                            "response_id": "chat",
                            "usage": {
                                "input_tokens": 20,
                                "output_tokens": 7,
                                "total_tokens": 27,
                            },
                        },
                    },
                    summary,
                    unmatched,
                    {
                        "type": "response_item",
                        "payload": {
                            "type": "compaction",
                            "encrypted_content": "private-blob",
                            "window_number": 3,
                        },
                    },
                )
            )

            def run(command, *args):
                output = subprocess.check_output(
                    [
                        sys.executable,
                        "-B",
                        str(CLI),
                        command,
                        "--rollout",
                        str(path),
                        *args,
                    ]
                )
                self.assertNotIn(b"private-blob", output)
                self.assertNotIn(b"mirror-text", output)
                return json.loads(output)

            reports = run("tokens", "--by-response")
            self.assertEqual(reports["response_count"], 2)
            self.assertEqual(
                reports["totals"],
                {
                    "input_tokens": 120,
                    "cached_input_tokens": 12,
                    "cache_write_input_tokens": 0,
                    "reasoning_output_tokens": 17,
                    "output_tokens": 67,
                    "total_tokens": 187,
                    "encrypted_summary_output_tokens": 60,
                },
            )
            self.assertEqual(
                reports["responses_with_usage"]["reasoning_output_tokens"], 1
            )
            self.assertEqual(
                [r["response_id"] for r in reports["items"]],
                ["response-for-summary", "chat"],
            )
            summaries = run("tokens", "--by-summary")
            windows = run("windows", "--with-tokens")["items"]
            self.assertEqual(
                [(row["window"], row["tokens"]) for row in summaries["items"]],
                [(windows[0]["window"], 60), (None, None), (None, None)],
            )
            self.assertEqual(windows[0]["token_usage"]["totals"], reports["totals"])
            self.assertIsNone(
                windows[1]["token_usage"]["totals"]["encrypted_summary_output_tokens"]
            )
            self.assertEqual(run("search", "mirror-text")["items"], [])
            self.assertTrue(
                all("encrypted_tokens" in row for row in run("read")["items"])
            )

    def test_instructions_reads_developer_items_from_selected_checkpoint(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "instruction-checkpoint.jsonl"
            text = "Developer guidance stored only in this checkpoint."
            path.write_bytes(
                encoded(
                    {"type": "session_meta", "payload": {"id": "fixture"}},
                    response(1, "physical user message"),
                    {
                        "type": "compacted",
                        "payload": {
                            "window_number": 3,
                            "replacement_history": [
                                response(1, "checkpoint user message")["payload"],
                                {
                                    "type": "compaction",
                                    "encrypted_content": "opaque-checkpoint-ciphertext",
                                },
                                {**response(2, text)["payload"], "role": "developer"},
                                {
                                    **response(3, "checkpoint system guidance")[
                                        "payload"
                                    ],
                                    "role": "system",
                                },
                            ],
                        },
                    },
                )
            )
            cli = [sys.executable, "-B", str(CLI)]
            source = ["--rollout", str(path)]
            raw = subprocess.check_output(
                [*cli, "instructions", *source, "--window", "3", "--role", "developer"]
            )
            self.assertNotIn(b"opaque-checkpoint-ciphertext", raw)
            (item,) = json.loads(raw)["items"]
            self.assertEqual(
                (item["role"], item["line"], item["checkpoint_item"], item["text"]),
                ("developer", 3, 2, text),
            )
            exact = json.loads(
                subprocess.check_output(
                    [
                        *cli,
                        "instructions",
                        *source,
                        "--window",
                        "3",
                        "--item",
                        str(item["checkpoint_item"]),
                        "--chars",
                        "0:18",
                    ]
                )
            )
            self.assertEqual([item["text"] for item in exact["items"]], [text[:18]])
            chat = json.loads(subprocess.check_output([*cli, "transcript", *source]))
            self.assertEqual(
                [item["text"] for item in chat["items"]], ["physical user message"]
            )

    def test_utf8_transcript_with_non_unicode_stdio_defaults(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "对话.jsonl"
            output = Path(directory) / "摘录.md"
            rows = [
                {"type": "session_meta", "payload": {"id": "utf8"}},
                response(1, "窗口压缩😀"),
            ]
            path.write_bytes(
                "".join(
                    json.dumps(row, ensure_ascii=False) + "\n" for row in rows
                ).encode("utf-8")
                + encoded(response(2, "unpaired \ud800 surrogate"))
            )
            command = [
                sys.executable,
                "-B",
                str(CLI),
                "transcript",
                "--rollout",
                str(path),
            ]
            env = {**os.environ, "PYTHONUTF8": "0", "PYTHONIOENCODING": "ascii"}
            raw = subprocess.check_output(command, env=env).decode("utf-8")
            self.assertEqual(len(raw.splitlines()), 1)
            self.assertEqual(
                [item["text"] for item in json.loads(raw)["items"]],
                ["窗口压缩😀", "unpaired \ufffd surrogate"],
            )
            subprocess.run(
                [*command, "--format", "markdown", "--output", str(output)],
                env=env,
                check=True,
                capture_output=True,
            )
            self.assertIn("窗口压缩😀", output.read_text(encoding="utf-8"))

    def test_window_times_drive_paginated_transcript_and_exclusive_end(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "timed.jsonl"
            path.write_bytes(
                encoded(
                    {
                        "type": "session_meta",
                        "payload": {"id": "timed"},
                        "timestamp": "2026-11-21T16:00:00Z",
                    },
                    {**response(1, "first"), "timestamp": "2026-11-21T16:05:00Z"},
                    {**response(2, "second"), "timestamp": "2026-11-21T16:06:00Z"},
                    {
                        "type": "compacted",
                        "payload": {"window_number": 1, "replacement_history": []},
                        "timestamp": "2026-11-21T16:10:00Z",
                    },
                    {**response(4, "outside"), "timestamp": "2026-11-21T16:11:00Z"},
                )
            )

            def run(command, *options, stdin=None, check=True):
                return subprocess.run(
                    [
                        sys.executable,
                        "-B",
                        str(CLI),
                        command,
                        "--rollout",
                        str(path),
                        *options,
                    ],
                    input=stdin,
                    check=check,
                    capture_output=True,
                )

            period = [
                "--since",
                "2026-11-22T00:05:00+08:00",
                "--until",
                "2026-11-21T16:11:00Z",
            ]
            windows = json.loads(run("windows", *period).stdout)["items"]
            self.assertEqual(
                [(window["window"], window["compacted_at"]) for window in windows],
                [(1, "2026-11-21T16:10:00Z")],
            )
            first = json.loads(run("transcript", *period, "--limit", "1").stdout)
            self.assertRegex(first["next_cursor"], r"\A[0-9a-f]{16}:2\Z")
            cursor = (first["next_cursor"] + "\n").encode("utf-8")
            second = json.loads(
                run("transcript", *period, "--cursor", "-", stdin=cursor).stdout
            )
            self.assertEqual(
                [row["text"] for row in first["items"] + second["items"]],
                ["first", "second"],
            )
            self.assertIsNone(second["next_cursor"])
            failure = run(
                "transcript", *period, "--cursor", "-", stdin=cursor * 2, check=False
            )
            self.assertNotEqual(failure.returncode, 0)
            self.assertEqual(failure.stdout, b"")
            output = Path(directory) / "excerpt.md"
            report = [
                *period,
                "--window",
                "1",
                "--format",
                "markdown",
                "--output",
                str(output),
            ]
            run("transcript", *report)
            self.assertIn("second", output.read_text(encoding="utf-8"))
            self.assertNotEqual(run("transcript", *report, check=False).returncode, 0)

    def test_search_scope_across_inherited_and_current_segments(self):
        with tempfile.TemporaryDirectory() as directory:
            home = Path(directory)
            sessions = home / "sessions"
            sessions.mkdir()
            parent_id, thread_id = str(uuid4()), str(uuid4())
            reverted_id = str(uuid4())
            parent = sessions / f"rollout-2026-01-01T00-00-00-{parent_id}.jsonl"
            child = (
                sessions
                / f"rollout-2026-01-02T00-00-00-{thread_id}_{reverted_id}.jsonl"
            )
            (sessions / f"rollout-2026-01-01T00-00-00-{thread_id}.jsonl").write_bytes(
                encoded(
                    {
                        "ordinal": 0,
                        "type": "session_meta",
                        "payload": {"id": thread_id},
                    },
                    response(1, "needle superseded rollout"),
                )
            )
            prefix = encoded(
                {
                    "ordinal": 0,
                    "type": "session_meta",
                    "payload": {"id": parent_id, "session_id": thread_id},
                },
                response(1, "needle inherited"),
            )
            parent.write_bytes(
                prefix + encoded(response(2, "needle excluded parent tail"))
            )
            with closing(sqlite3.connect(home / "state_5.sqlite")) as index:
                index.execute("CREATE TABLE threads (id TEXT, rollout_path TEXT)")
                index.execute(
                    "INSERT INTO threads VALUES (?, ?)", (thread_id, str(parent))
                )
                index.commit()
            child.write_bytes(
                encoded(
                    {
                        "ordinal": 0,
                        "type": "session_meta",
                        "payload": {
                            "id": thread_id,
                            "history_base": {
                                "thread_id": parent_id,
                                "end_ordinal_exclusive": 2,
                                "end_byte_offset": len(prefix),
                            },
                        },
                    },
                    {
                        "ordinal": 3,
                        "type": "event_msg",
                        "payload": {"type": "task_started", "turn_id": "one"},
                    },
                    response(4, "needle before checkpoint"),
                    {
                        "ordinal": 5,
                        "type": "compacted",
                        "payload": {"replacement_history": []},
                    },
                    response(6, "needle resumed turn"),
                    {
                        "ordinal": 7,
                        "type": "event_msg",
                        "payload": {"type": "task_complete", "turn_id": "one"},
                    },
                    response(8, "needle current"),
                )
            )
            command = [
                sys.executable,
                "-B",
                str(CLI),
                "search",
                "needle",
                "--thread",
                thread_id,
                "--codex-home",
                str(home),
            ]
            cases = (
                (["--window", "1"], [(parent.name, 2), (child.name, 3)]),
                (["--window", "current"], [(child.name, 5), (child.name, 7)]),
                (["--window", "current", "--turn", "one"], [(child.name, 5)]),
                (["--window", "1", "--origin", "inherited"], [(parent.name, 2)]),
                (
                    ["--origin", "current"],
                    [(child.name, 3), (child.name, 5), (child.name, 7)],
                ),
                (
                    ["--turn", "one", "--segment", reverted_id, "--lines", "2:3"],
                    [(child.name, 3)],
                ),
            )
            for options, expected in cases:
                with self.subTest(options=options):
                    ran = subprocess.run(
                        command + options, check=True, capture_output=True
                    )
                    matches = json.loads(ran.stdout)["items"]
                    self.assertEqual(
                        [(item["rollout"], item["line"]) for item in matches], expected
                    )

            parent.write_bytes(prefix[:-2] + b"!\n")
            own = json.loads(subprocess.check_output([*command, "--origin", "current"]))
            self.assertEqual(
                [(item["rollout"], item["line"]) for item in own["items"]],
                [(child.name, 3), (child.name, 5), (child.name, 7)],
            )


if __name__ == "__main__":
    unittest.main()
