import json
import sys
import unittest
from pathlib import Path

sys.path.insert(
    0, str(Path(__file__).parents[1] / "skills" / "thread-memory" / "scripts")
)

from rollout_refs import parse_ref, reference_target
from rollout_search import read, read_reference, search

FIRST = Path("first.jsonl")
SECOND = Path("second.jsonl")


def row(line, kind, payload, source=FIRST):
    return source, line, {"type": kind, "payload": payload}


def message(line, text, source=FIRST, role="user"):
    return row(
        line,
        "response_item",
        {
            "type": "message",
            "role": role,
            "content": [{"type": "input_text", "text": text}],
        },
        source,
    )


class SearchTests(unittest.TestCase):
    def test_metadata_only_catalogs_unknown_records_and_refs_expand_only_known_fields(
        self,
    ):
        unknown = row(
            1,
            "event_msg",
            {
                "type": "item_started",
                "item": {"type": "FutureItem", "body": "unreviewed secret"},
            },
        )
        chat = message(2, "known searchable message")
        first = read([unknown, chat], metadata_only=True, limit=1)
        second = read([unknown, chat], metadata_only=True, cursor=first["next_cursor"])
        self.assertEqual(first["records"][0]["item_type"], "FutureItem")
        self.assertEqual(first["records"][0]["event_type"], "item_started")
        self.assertEqual(
            len(
                read([unknown, chat], kinds=["item_started"], metadata_only=True)[
                    "records"
                ]
            ),
            1,
        )
        self.assertFalse(first["records"][0]["body_available"])
        self.assertTrue(second["records"][0]["body_available"])
        for location, page, expected in (
            (unknown, first, []),
            (chat, second, ["known searchable message"]),
        ):
            self.assertEqual(page["records"][0]["fields"], [])
            expanded = read_reference(location, parse_ref(page["records"][0]["ref"]))
            self.assertEqual([field["text"] for field in expanded["fields"]], expected)
        self.assertRaises(ValueError, read, [chat], metadata_only=True, field_index=0)

    def test_saved_task_events_expose_only_reviewed_fields_and_bounded_metadata(self):
        events = [
            row(
                1,
                "retained_context",
                {
                    "type": "verified_answer",
                    "call_id": "ask-1",
                    "turn_id": "t1",
                    "questions": [
                        {
                            "question": "Publish?",
                            "answer": "Only privately.",
                            "credential": "secret",
                        }
                    ],
                },
            ),
            row(
                2,
                "event_msg",
                {
                    "type": "task_complete",
                    "turn_id": "t1",
                    "last_agent_message": "Turn result",
                    "error": {"message": "Failed to connect", "misalignment": "secret"},
                },
            ),
            row(
                3,
                "event_msg",
                {
                    "type": "thread_goal_updated",
                    "threadId": "owning-thread",
                    "goal": {
                        "objective": "Finish deployment",
                        "status": "active",
                        "tokensUsed": 7,
                    },
                },
            ),
            row(
                4,
                "event_msg",
                {
                    "type": "thread_settings_applied",
                    "thread_settings": {
                        "model": "model-example",
                        "collaboration_mode": {
                            "mode": "plan",
                            "settings": {"developer_instructions": "secret"},
                        },
                    },
                },
            ),
            row(
                5,
                "event_msg",
                {
                    "type": "item_completed",
                    "item": {
                        "type": "SubAgentActivity",
                        "kind": "completed",
                        "agent_path": "/root/worker",
                    },
                },
            ),
            row(
                6,
                "inter_agent_communication",
                {
                    "author": "/root/worker",
                    "recipient": "/root",
                    "other_recipients": ["/root/reviewer"],
                    "content": "Done",
                    "encrypted_content": "secret",
                    "trigger_turn": True,
                },
            ),
            row(
                7,
                "event_msg",
                {
                    "type": "agent_message",
                    "delivery": "async",
                    "message": "Choose a target",
                    "questions": [
                        {"title": "Where?", "options": ["Staging", "Production"]}
                    ],
                },
            ),
            row(
                8,
                "retained_context",
                {
                    "type": "delivered_assistant_message",
                    "turn_id": "t1",
                    "message_id": "m1",
                    "text": "Delivered final message",
                    "complete": True,
                    "retained_source": "secret",
                },
            ),
        ]
        records = read(events)["records"]
        self.assertEqual([record["line"] for record in records], list(range(1, 9)))
        self.assertEqual(records[0]["role"], "user")
        self.assertEqual(
            {field["field"]: field["text"] for field in records[0]["fields"]},
            {
                "questions[0].question": "Publish?",
                "questions[0].answer": "Only privately.",
            },
        )
        self.assertEqual(
            [
                record["line"]
                for record in search(
                    events, "Failed to connect", kinds=["task_complete"]
                )["matches"]
            ],
            [2],
        )
        self.assertEqual(records[2]["details"]["tokensUsed"], 7)
        self.assertEqual(records[3]["details"]["collaboration_mode"], "plan")
        self.assertEqual(records[4]["details"]["agent_path"], "/root/worker")
        self.assertEqual(records[5]["details"]["other_recipients"], ["/root/reviewer"])
        self.assertEqual(records[6]["fields"][-1]["text"], "Production")
        self.assertEqual(records[1]["fields"][-1]["field"], "last_agent_message")
        delivered = search(
            events,
            "Delivered final",
            roles=["assistant"],
            kinds=["delivered_assistant_message"],
        )["matches"][0]
        self.assertEqual(delivered["text"], "Delivered final message")
        self.assertEqual(delivered["details"]["message_id"], "m1")
        self.assertNotIn("secret", json.dumps(records))

    def test_instruction_roles_include_stored_base_and_collaboration_settings(self):
        base = row(1, "session_meta", {"base_instructions": {"text": "base needle"}})
        rows = [
            base,
            message(2, "recorded system message", role="system"),
            row(
                3,
                "turn_context",
                {
                    "collaboration_mode": {
                        "settings": {"developer_instructions": "mode needle"}
                    }
                },
            ),
            row(
                4,
                "turn_context",
                {"collaboration_mode": {"developer_instructions": "legacy mode"}},
            ),
            message(5, "recorded developer message", role="developer"),
            message(6, "ordinary chat"),
        ]
        system = read(rows, roles=["system"])["records"]
        self.assertEqual([item["line"] for item in system], [1, 2])
        self.assertEqual(system[0]["fields"][0]["field"], "base_instructions.text")
        developer = read(rows, roles=["developer"])["records"]
        self.assertEqual([item["line"] for item in developer], [3, 4, 5])
        self.assertEqual(developer[0]["item_type"], "developer_instructions")
        self.assertEqual(developer[1]["fields"][0]["text"], "legacy mode")

        hit = search(rows, "needle", roles=["system"])["matches"][0]
        expanded = read_reference(base, parse_ref(hit["ref"]))
        self.assertEqual(expanded["fields"][0]["text"], "base needle")

    def test_field_reference_keeps_selected_field_and_character_range(self):
        exact = message(9, "unrelated first field")
        exact[2]["payload"]["content"].append(
            {"type": "input_text", "text": "x" * 800 + "continued thought"}
        )
        for selector in ({"field_index": 1}, {"field": "content[1].text"}):
            item = read([exact], chars=(800, 809), **selector)["records"][0]
            opened = read_reference(exact, parse_ref(item["ref"]))
            self.assertEqual(opened["fields"], item["fields"])
            self.assertEqual(opened["fields"][0]["text"], "continued")

    def test_character_slice_skips_short_fields_and_remains_in_budget(self):
        exact = message(5, "short")
        short_part = exact[2]["payload"]["content"][0]
        exact[2]["payload"]["content"] = [short_part] * 2000 + [
            {"type": "input_text", "text": "x" * 100 + "OK"}
        ]
        projected = read([exact], chars=(100, 120), max_chars=2)["records"][0]
        self.assertEqual(len(projected["fields"]), 1)
        self.assertEqual(projected["fields"][0]["text"], "OK")

    def test_hit_reference_expands_late_second_field_and_rejects_rewritten_text(self):
        exact = message(7, "an unrelated first field")
        content = exact[2]["payload"]["content"]
        content.append({"type": "input_text", "text": "x" * 800 + "needle" + "y" * 40})
        ref = parse_ref(search([exact], "needle")["matches"][0]["ref"])
        self.assertEqual(reference_target([SECOND, FIRST], ref), (FIRST, 7))
        self.assertIsNone(reference_target([SECOND], ref))
        expanded = read_reference(exact, ref, max_chars=6)
        self.assertEqual(expanded["match_start"], 800)
        self.assertEqual(
            expanded["fields"],
            [
                {
                    "field": "content[1].text",
                    "field_index": 1,
                    "text": "needle",
                    "text_offset": 800,
                    "text_total_chars": 846,
                }
            ],
        )
        explicit = read_reference(exact, ref, chars=(806, 811))
        self.assertEqual(explicit["fields"][0]["text"], "yyyyy")
        moved = exact[0], exact[1], {**exact[2], "_rollout_cwd": "another-directory"}
        with self.assertRaisesRegex(ValueError, "stale"):
            read_reference(moved, ref)
        content[1]["text"] = "z" + content[1]["text"][1:]
        with self.assertRaisesRegex(ValueError, "stale"):
            read_reference(exact, ref)

    def test_literal_and_regex_clip_around_match_instead_of_dropping_long_tail(self):
        rows = [message(7, "prefix\n" + "x" * 2_000 + "\nFIND[42]\nsuffix")]
        literal = search(iter(rows), "find[42]", ignore_case=True, max_chars=16)[
            "matches"
        ][0]
        regex = search(iter(rows), r"^FIND\[\d+\]$", regex=True, max_chars=16)[
            "matches"
        ][0]
        self.assertEqual(literal, regex)
        self.assertEqual(literal["line"], 7)
        self.assertEqual(literal["field"], "content[0].text")
        self.assertLessEqual(len(literal["text"]), 16)
        self.assertEqual(
            literal["text"][
                literal["match_start"] - literal["text_offset"] : literal["match_end"]
                - literal["text_offset"]
            ],
            "FIND[42]",
        )

    def test_user_paths_and_tool_names_are_searchable_with_kind_and_role_filters(self):
        path = r"D:\images\output image.png"
        rows = [
            row(
                2,
                "event_msg",
                {"type": "user_message", "message": "inspect", "local_images": [path]},
            ),
            row(
                3,
                "response_item",
                {
                    "type": "function_call",
                    "name": "view_image",
                    "arguments": json.dumps({"path": path}),
                },
            ),
        ]
        result = search(
            iter(rows), "view_image", kinds=["function_call"], roles=["tool"]
        )
        self.assertEqual(
            [(hit["line"], hit["field"], hit["text"]) for hit in result["matches"]],
            [(3, "tool_name", "view_image")],
        )
        self.assertTrue(result["matches"][0]["input_id"])
        self.assertEqual(search(iter(rows), path, roles=["tool"])["matches"], [])
        result = search(iter(rows), path, kinds=["event_msg"], roles=["user"])
        self.assertEqual(
            [(hit["line"], hit["field"]) for hit in result["matches"]],
            [(2, "local_images[0]")],
        )

    def test_tool_calls_without_arguments_can_still_be_found_by_name(self):
        source = row(
            1,
            "response_item",
            {"type": "web_search_call", "id": "web-search-1", "action": None},
        )
        (hit,) = search([source], "web_search", roles=["tool"])["matches"]
        self.assertEqual((hit["item_id"], hit["field"]), ("web-search-1", "tool_name"))

    def test_context_uses_physical_lines_and_stays_within_source(self):
        rows = [
            message(1, "before"),
            message(3, "find one"),
            message(4, "shared", role="assistant"),
            message(5, "find two"),
            message(6, "after"),
            message(10, "find omitted"),
            message(11, "outside the included context"),
            message(1, "other file", SECOND),
        ]
        result = search(iter(rows), "find", before=1, after=1, roles=["user"], limit=2)
        self.assertEqual([hit["line"] for hit in result["matches"]], [3, 5])
        self.assertEqual([entry["line"] for entry in result["context"]], [4, 6])
        self.assertTrue(result["truncated"])
        boundary = search(
            iter([message(1, "find at end"), message(2, "other file", SECOND)]),
            "find",
            after=2,
        )
        self.assertEqual(boundary["context"], [])
        self.assertFalse(boundary["truncated"])

    def test_search_preserves_matches_when_page_budget_limits_context(self):
        source = Path("长目录" * 20) / FIRST
        rows = [
            message(1, "before", source),
            message(2, "find one", source),
            message(3, "find two", source),
            message(4, "after", source),
            message(1, "find three", SECOND),
        ]
        options = {"before": 1, "after": 1, "budget_chars": 18}
        first = search(iter(rows), "find", **options)
        self.assertEqual([hit["line"] for hit in first["matches"]], [2, 3])
        self.assertEqual(first["context"][0]["fields"][0]["text"], "be")
        self.assertTrue(first["context_truncated"])
        self.assertLessEqual(len(first["next_cursor"]), 24)

        second = search(iter(rows), "find", cursor=first["next_cursor"], **options)
        self.assertEqual(
            [(hit["rollout"], hit["line"]) for hit in second["matches"]],
            [(SECOND.name, 1)],
        )
        self.assertEqual(second["context"], [])
        self.assertIsNone(second["next_cursor"])

    def test_read_pages_defer_a_record_that_cannot_fit_in_the_remaining_budget(self):
        rows = [
            message(1, "abc"),
            message(2, "123456789"),
            message(1, "xyz", SECOND),
        ]
        cursor = None
        previews = []
        for _ in rows:
            page = read(iter(rows), budget_chars=5, cursor=cursor)
            self.assertEqual(len(page["records"]), 1)
            record = page["records"][0]
            previews.append(
                (record["rollout"], record["line"], record["fields"][0]["text"])
            )
            cursor = page["next_cursor"]
        self.assertEqual(
            previews,
            [(FIRST.name, 1, "abc"), (FIRST.name, 2, "12345"), (SECOND.name, 1, "xyz")],
        )
        self.assertIsNone(cursor)

    def test_read_and_search_reject_a_cursor_outside_the_scope(self):
        rows = [message(1, "find", SECOND), message(2, "find", SECOND)]
        cursor = read([message(1, "find"), *rows], limit=1)["next_cursor"]
        with self.assertRaisesRegex(ValueError, "not within"):
            read(iter(rows), cursor=cursor)
        with self.assertRaisesRegex(ValueError, "not within"):
            search(iter(rows), "find", cursor=cursor)
        with self.assertRaisesRegex(ValueError, "invalid row cursor"):
            read(iter(rows), cursor=f"{SECOND.absolute()}:1")

    def test_search_hit_can_be_reassembled_with_field_and_character_ranges(self):
        content = "前\U0001f50e 关键词"
        rows = [
            row(
                1,
                "response_item",
                {
                    "type": "message",
                    "role": "assistant",
                    "content": [
                        {"type": "output_text", "text": "another field"},
                        {"type": "output_text", "text": content},
                    ],
                },
            )
        ]
        hit = search(iter(rows), "关键词", max_chars=3)["matches"][0]
        self.assertEqual(hit["text_total_chars"], len(content))
        chunks = []
        for start in range(0, hit["text_total_chars"], 2):
            page = read(
                iter(rows),
                field=hit["field"],
                chars=(start, hit["text_total_chars"]),
                budget_chars=2,
            )
            (part,) = page["records"][0]["fields"]
            self.assertEqual(part["text_offset"], start)
            chunks.append(part["text"])
        self.assertEqual("".join(chunks), content)

    def test_assistant_json_example_remains_directly_readable(self):
        example = json.dumps({"a.b": "another value", "a": {"b": "needle"}})
        rows = [message(4, example, role="assistant")]
        (hit,) = search(rows, "needle", roles=["assistant"])["matches"]
        (record,) = read(rows, field_index=hit["field_index"])["records"]
        (selected,) = record["fields"]
        self.assertEqual(selected["text"], example)

    def test_direct_read_can_distinguish_metadata_only_rows_from_absent_lines(self):
        rows = [row(2, "event_msg", {"type": "task_started"})]
        self.assertEqual(read(iter(rows))["records"], [])
        (record,) = read(iter(rows), include_empty=True)["records"]
        self.assertEqual(
            (record["line"], record["item_type"], record["fields"]),
            (2, "task_started", []),
        )

    def test_read_and_search_exclude_media_encrypted_and_checkpoint_blobs(self):
        encoded = "QWxhZGRpbjpvcGVuIHNlc2FtZQ=="
        rows = [
            row(
                1,
                "response_item",
                {
                    "type": "reasoning",
                    "summary": [
                        {"type": "summary_text", "text": "visible summary"},
                    ],
                    "encrypted_content": "opaque reasoning",
                },
            ),
            message(2, f"text data:image/png;base64,{encoded} tail"),
            row(
                3,
                "compacted",
                {
                    "message": "",
                    "replacement_history": [
                        message(1, "duplicate checkpoint content")[2]["payload"],
                    ],
                },
            ),
        ]
        self.assertEqual(search(iter(rows), encoded)["matches"], [])
        self.assertEqual(search(iter(rows), "opaque reasoning")["matches"], [])
        result = read(iter(rows), max_chars=15)
        self.assertEqual([entry["line"] for entry in result["records"]], [1, 2])
        self.assertEqual(result["records"][1]["fields"][0]["text"], "text [data URL ")
        self.assertTrue(result["records"][1]["text_truncated"])
        result = read(iter(rows), limit=1)
        self.assertEqual(len(result["records"]), 1)
        self.assertTrue(result["truncated"])

    def test_tool_output_body_is_hidden_in_search_reads_and_context(self):
        body = "private-tool-result " + "x" * 10_000
        outputs = [
            (
                "response_item",
                {"type": "function_call_output", "output": body},
                "output",
            ),
            (
                "response_item",
                {
                    "type": "custom_tool_call_output",
                    "output": [{"type": "input_text", "text": body}],
                },
                "output[0].text",
            ),
            (
                "event_msg",
                {
                    "type": "mcp_tool_call_end",
                    "invocation": {"server": "mcp", "tool": "example"},
                    "result": {"Err": body},
                },
                "result.error",
            ),
            (
                "event_msg",
                {"type": "exec_command_end", "stdout": body},
                "stdout",
            ),
            (
                "event_msg",
                {"type": "patch_apply_end", "stderr": body},
                "stderr",
            ),
            (
                "event_msg",
                {
                    "type": "item_completed",
                    "item": {"type": "CommandExecution", "aggregated_output": body},
                },
                "aggregated_output",
            ),
            (
                "event_msg",
                {
                    "type": "item_completed",
                    "item": {"type": "FileChange", "stdout": body},
                },
                "stdout",
            ),
            *(
                (
                    "response_item",
                    {
                        "type": "message",
                        "role": role,
                        "content": [{"type": "output_text", "text": body}],
                    },
                    "content[0].text",
                )
                for role in ("tool", "function")
            ),
            (
                "event_msg",
                {
                    "type": "item_completed",
                    "item": {
                        "type": "Extension",
                        "kind": "image_gen.generation",
                        "revisedPrompt": body,
                    },
                },
                "revisedPrompt",
            ),
        ]
        for kind, payload, hidden_field in outputs:
            with self.subTest(payload_type=payload["type"], field=hidden_field):
                identifier = "native-call-42"
                if "item" in payload:
                    payload["item"]["id"] = identifier
                    id_field = "item_id"
                else:
                    payload["call_id"] = identifier
                    id_field = "call_id"
                output = row(2, kind, payload)
                (record,) = read([output])["records"]
                self.assertTrue(record["output_id"])
                self.assertEqual(record["role"], "tool")
                self.assertNotIn("private-tool-result", json.dumps(record))
                self.assertEqual(read([output], field=hidden_field)["records"], [])
                self.assertNotIn(
                    "private-tool-result",
                    json.dumps(read([output], field_index=0, chars=(0, 50_000))),
                )
                self.assertEqual(search([output], "private-tool-result")["matches"], [])
                (hit,) = search([output], identifier)["matches"]
                self.assertEqual(
                    (hit["output_id"], hit["field"], hit[id_field]),
                    (record["output_id"], id_field, identifier),
                )
                for before, after, nearby in ((1, 0, 3), (0, 1, 1)):
                    context = search(
                        sorted([output, message(nearby, "needle")], key=lambda r: r[1]),
                        "needle",
                        before=before,
                        after=after,
                    )["context"]
                self.assertEqual(
                    context, [{k: v for k, v in record.items() if k != "ref"}]
                )

    def test_tool_input_body_is_hidden_in_search_reads_and_context(self):
        secret = "private-tool-input"
        body = "x" * 10_000 + secret
        inputs = [
            (
                "response_item",
                {
                    "type": "function_call",
                    "name": "example",
                    "arguments": json.dumps({"doc": body}),
                },
                "arguments.doc",
            ),
            (
                "response_item",
                {"type": "custom_tool_call", "name": "example", "input": body},
                "input",
            ),
            (
                "response_item",
                {
                    "type": "local_shell_call",
                    "action": {"type": "exec", "command": [body]},
                },
                "action.command[0]",
            ),
            (
                "event_msg",
                {"type": "exec_command_begin", "command": [body]},
                "command[0]",
            ),
            (
                "event_msg",
                {"type": "view_image_tool_call", "path": body},
                "path",
            ),
            (
                "event_msg",
                {"type": "patch_apply_updated", "changes": {"file": {"diff": body}}},
                "changes.file.diff",
            ),
        ]
        for kind, payload, hidden_field in inputs:
            with self.subTest(item_type=payload["type"]):
                payload["call_id"] = "native-call-64"
                source = row(2, kind, payload)
                (record,) = read([source], max_chars=50_000, budget_chars=50_000)[
                    "records"
                ]
                self.assertNotIn(secret, json.dumps(record))
                self.assertEqual(read([source], field=hidden_field)["records"], [])
                self.assertNotIn(
                    secret,
                    json.dumps(read([source], field_index=0, chars=(0, 50_000))),
                )
                self.assertEqual(search([source], secret)["matches"], [])
                (hit,) = search([source], "native-call-64", roles=["tool"])["matches"]
                self.assertEqual(
                    (hit["input_id"], hit["field"]), (record["input_id"], "call_id")
                )
                for lines, counts in (
                    ([source, message(3, "needle")], {"before": 1}),
                    ([message(1, "needle"), source], {"after": 1}),
                ):
                    self.assertEqual(
                        search(lines, "needle", **counts)["context"],
                        [{k: v for k, v in record.items() if k != "ref"}],
                    )

    def test_mixed_tool_record_exposes_both_ids_and_searchable_metadata(self):
        source = row(
            1,
            "event_msg",
            {
                "type": "item_completed",
                "item": {
                    "type": "McpToolCall",
                    "id": "native-mcp-id",
                    "server": "my-server",
                    "tool": "example",
                    "arguments": {"value": "invocation-input"},
                    "result": {"structuredContent": {"value": "returned-content"}},
                },
            },
        )
        (hit,) = search([source], "my-server", roles=["tool"])["matches"]
        self.assertEqual(
            (hit["field"], hit["item_id"]), ("tool_server", "native-mcp-id")
        )
        self.assertTrue(hit["input_id"])
        self.assertTrue(hit["output_id"])
        for hidden in ("invocation-input", "returned-content"):
            self.assertEqual(search([source], hidden)["matches"], [])

    def test_tool_result_without_a_native_id_keeps_an_output_locator(self):
        output = row(
            1, "response_item", {"type": "function_call_output", "output": "hidden"}
        )
        (record,) = read([output])["records"]
        self.assertTrue(record["output_id"])
        self.assertEqual(record["fields"], [])
        self.assertEqual(search([output], "hidden", regex=True)["matches"], [])

    def test_user_shell_invocation_keeps_the_other_parts_of_a_message_searchable(self):
        def envelope(text, command="echo"):
            return (
                f"<user_shell_command>\n<command>\n{command}\n</command>\n<result>\n"
                f"Exit code: 0\nDuration: 1.0000 seconds\nOutput:\n{text}\n"
                "</result>\n</user_shell_command>"
            )

        inspected = row(
            1,
            "response_item",
            {
                "type": "message",
                "role": "user",
                "content": [
                    {"type": "input_text", "text": "written directly"},
                    {"type": "input_text", "text": "annotated shell output"},
                    {"type": "input_text", "text": envelope("quoted by user")},
                    {
                        "type": "input_text",
                        "text": envelope(
                            "legacy shell output", "private shell command"
                        ),
                    },
                ],
                "internal_chat_message_metadata_passthrough": {
                    "content_item_kinds": [
                        "user.text",
                        "shell.user_command",
                        "user.text",
                        "unknown",
                    ]
                },
            },
        )
        (record,) = read([inspected], roles=["user"])["records"]
        self.assertTrue(record["input_id"])
        self.assertTrue(record["output_id"])
        self.assertEqual(
            [field["field"] for field in record["fields"]],
            ["tool_name", "content[0].text", "content[2].text"],
        )
        self.assertEqual(search([inspected], "shell output")["matches"], [])
        self.assertEqual(search([inspected], "private shell command")["matches"], [])
        (hit,) = search([inspected], "quoted by user", roles=["user"])["matches"]
        self.assertEqual((hit["role"], hit["field"]), ("user", "content[2].text"))
        shell_only = message(2, envelope("legacy shell output"))
        (record,) = read([shell_only], roles=["tool"])["records"]
        self.assertTrue(record["output_id"])
        self.assertNotIn("legacy shell output", json.dumps(record))
        self.assertEqual(read([shell_only], roles=["user"])["records"], [])


if __name__ == "__main__":
    unittest.main()
