import json
import sys
import unittest
from collections import defaultdict
from pathlib import Path
from tempfile import TemporaryDirectory

sys.path.insert(
    0, str(Path(__file__).parents[1] / "skills" / "thread-memory" / "scripts")
)

from rollout_source import Segment, record_revision, records
from rollout_tool_outputs import (
    parse_tool_cursor,
    read_tool_record,
    read_tool_value,
    tool_record_metadata,
    tool_record_target,
)

SOURCE = Path("sample.jsonl")


def response(line, item_type, **payload):
    row = {
        "type": "response_item",
        "timestamp": "2026-11-21T20:00:00Z",
        "payload": {"type": item_type, **payload},
    }
    row["_rollout_revision"] = record_revision(json.dumps(row).encode("utf-8"))
    return SOURCE, line, row


def event(line, event_type, **payload):
    row = {
        "type": "event_msg",
        "payload": {"type": event_type, **payload},
    }
    row["_rollout_revision"] = record_revision(json.dumps(row).encode("utf-8"))
    return SOURCE, line, row


class ToolOutputTests(unittest.TestCase):
    def test_json_pointer_preserves_keys_and_types_in_tool_arguments(self):
        entry = response(
            11,
            "function_call",
            arguments=json.dumps(
                {
                    "a.b": 0,
                    "a": {"b": False},
                    "a/b~c": [None, {}, [], ""],
                    "": "empty key",
                    "_tag": "ordinary key",
                    "inner": '{"keep":"as a string"}',
                }
            ),
        )
        identifier = tool_record_metadata(*entry, direction="input")["input_id"]
        for pointer, expected in (
            ("/arguments/a.b", 0),
            ("/arguments/a/b", False),
            ("/arguments/a~1b~0c", [None, {}, [], ""]),
            ("/arguments/a~1b~0c/0", None),
            ("/arguments/", "empty key"),
            ("/arguments/_tag", "ordinary key"),
            ("/arguments/inner", '{"keep":"as a string"}'),
        ):
            with self.subTest(pointer=pointer):
                result = read_tool_value(
                    [entry], identifier, direction="input", pointer=pointer
                )
                self.assertEqual(result["value"], expected)
                self.assertIs(type(result["value"]), type(expected))
        for pointer in (
            "arguments",
            "/arguments/a~2b",
            "/arguments/a~1b~0c/01",
            "/output",
        ):
            with self.subTest(pointer=pointer), self.assertRaises(ValueError):
                read_tool_value([entry], identifier, direction="input", pointer=pointer)

        explicit_null = response(12, "function_call_output", output=None)
        output_id = tool_record_metadata(*explicit_null, direction="output")[
            "output_id"
        ]
        self.assertIsNone(
            read_tool_value(
                [explicit_null], output_id, direction="output", pointer="/output"
            )["value"]
        )

    def test_json_pointer_preserves_strings_from_native_json_arguments(self):
        for entry, expected in (
            (response(11, "tool_search_call", arguments="null"), "null"),
            (event(12, "dynamic_tool_call_request", arguments="false"), "false"),
            (event(13, "mcp_tool_call_begin", invocation={"arguments": "{}"}), "{}"),
        ):
            _, _, row = entry
            with self.subTest(item_type=row["payload"]["type"]):
                identifier = tool_record_metadata(*entry, direction="input")["input_id"]
                value = read_tool_value(
                    [entry], identifier, direction="input", pointer="/arguments"
                )["value"]
                self.assertEqual(value, expected)

    def test_json_pointer_does_not_reveal_other_directions_or_opaque_payloads(self):
        entry = event(
            13,
            "mcp_tool_call_end",
            invocation={"arguments": {"secret_input": "private"}},
            result={
                "Ok": {
                    "isError": False,
                    "content": [
                        {
                            "type": "image",
                            "data": "secret_image",
                            "mimeType": "image/png",
                        },
                        {
                            "type": "text",
                            "text": '{"answer":true,"blob":"secret_blob"}',
                            "opaque": "secret_opaque",
                        },
                    ],
                    "structuredContent": {
                        "label": "metadata:x,y data:text/plain,secret_url data:image/png;base64,AAAA",
                        "_meta": {"opaque": "secret_meta"},
                        "encrypted_hash": "secret_encrypted",
                    },
                    "opaque": "secret_result",
                }
            },
        )
        identifier = tool_record_metadata(*entry, direction="output")["output_id"]
        result = read_tool_value([entry], identifier, direction="output", pointer="")
        input_id = tool_record_metadata(*entry, direction="input")["input_id"]
        self.assertEqual(
            read_tool_value(
                [entry], input_id, direction="input", pointer="/arguments/secret_input"
            )["value"],
            "private",
        )
        self.assertEqual(
            result["value"],
            {
                "result": {
                    "isError": False,
                    "content": [None, {"type": "text", "text": {"answer": True}}],
                    "structuredContent": {
                        "label": "metadata:x,y [data URL omitted] [data URL omitted]"
                    },
                }
            },
        )
        for pointer in (
            "/arguments",
            "/result/content/0",
            "/result/content/1/text/blob",
            "/result/structuredContent/_meta",
            "/result/structuredContent/encrypted_hash",
        ):
            with self.subTest(pointer=pointer), self.assertRaises(ValueError):
                read_tool_value(
                    [entry], identifier, direction="output", pointer=pointer
                )

    def test_json_pointer_bounds_the_serialized_selected_value(self):
        entry = response(
            14,
            "function_call_output",
            output='{"label":"\\n","large":"' + "x" * 10000 + '"}',
        )
        identifier = tool_record_metadata(*entry, direction="output")["output_id"]
        with self.assertRaisesRegex(ValueError, "narrower JSON Pointer"):
            read_tool_value([entry], identifier, direction="output", pointer="/output")
        self.assertEqual(
            read_tool_value(
                [entry],
                identifier,
                direction="output",
                pointer="/output/label",
                budget_chars=4,
            )["value"],
            "\n",
        )
        with self.assertRaisesRegex(ValueError, "narrower JSON Pointer"):
            read_tool_value(
                [entry],
                identifier,
                direction="output",
                pointer="/output/label",
                budget_chars=3,
            )

    def test_output_id_selects_one_physical_occurrence_and_rejects_stale_identity(self):
        first = response(9, "function_call_output", call_id="call_test", output="first")
        second = event(
            10, "exec_command_end", call_id="call_test", aggregated_output="second"
        )
        output = tool_record_metadata(*first, direction="output")
        self.assertEqual(output["call_id"], "call_test")
        self.assertNotIn("first", json.dumps(output))
        self.assertEqual(
            tool_record_target(
                [Path("other.jsonl"), SOURCE], output["output_id"], direction="output"
            ),
            (SOURCE, 9),
        )
        self.assertIsNone(
            tool_record_target(
                [Path("other.jsonl")], output["output_id"], direction="output"
            )
        )
        result = read_tool_record(
            [second, first], output["output_id"], direction="output"
        )
        self.assertEqual([field["text"] for field in result["fields"]], ["first"])
        replacement = response(
            9, "function_call_output", call_id="call_replaced", output="new"
        )
        for rows in ([replacement], [second]):
            with self.assertRaisesRegex(ValueError, "stale or outside"):
                read_tool_record(rows, output["output_id"], direction="output")

    def test_pages_resume_within_fields_without_exposing_mcp_media(self):
        entry = event(
            21,
            "item_completed",
            item={
                "type": "McpToolCall",
                "id": "tool_21",
                "server": "service",
                "tool": "example",
                "status": "completed",
                "result": {
                    "content": [
                        {"type": "image", "data": "MEDIA"},
                        {
                            "type": "text",
                            "text": "LOG data:image/png;base64,SE9OREU= tail",
                        },
                        {
                            "type": "resource",
                            "resource": {"text": "a resource", "blob": "MEDIA"},
                        },
                    ],
                    "structuredContent": {
                        "plain": "a long second field",
                        "encrypted_content": "CIPHERTEXT",
                        "embedded": {"type": "inputImage", "imageUrl": "MEDIA"},
                    },
                },
            },
        )
        meta = tool_record_metadata(*entry, direction="output")
        self.assertEqual(meta["item_id"], "tool_21")
        self.assertNotIn("call_id", meta)
        self.assertEqual(meta["tool_name"], "example")
        self.assertEqual(meta["tool_status"], "completed")
        observed = defaultdict(str)
        cursor = None
        while True:
            result = read_tool_record(
                [entry],
                meta["output_id"],
                direction="output",
                budget_chars=3,
                cursor=cursor,
            )
            self.assertEqual(result["line"], 21)
            self.assertLessEqual(
                sum(len(field["text"]) for field in result["fields"]), 3
            )
            for field in result["fields"]:
                name = field["field"]
                self.assertEqual(field["text_offset"], len(observed[name]))
                observed[name] += field["text"]
            token = result["next_cursor"]
            if token is None:
                break
            cursor = parse_tool_cursor(token, direction="output")
        self.assertEqual(
            dict(observed),
            {
                "result.content[1].text": "LOG [data URL omitted] tail",
                "result.content[2].resource.text": "a resource",
                "result.structuredContent.plain": "a long second field",
            },
        )
        other = response(22, "function_call_output", id="fco_test", output="another")
        other_id = tool_record_metadata(*other, direction="output")["output_id"]
        with self.assertRaisesRegex(ValueError, "cursor does not match"):
            read_tool_record([other], other_id, direction="output", cursor=cursor)

    def test_protocol_outputs_expose_results_only_for_the_selected_id(self):
        fixtures = [
            (
                response(
                    1,
                    "tool_search_output",
                    call_id="tool_search_1",
                    tools=[{"name": "available_tool"}],
                ),
                "available_tool",
            ),
            (
                event(
                    2,
                    "patch_apply_end",
                    stdout="",
                    stderr="patch failed",
                    success=False,
                ),
                "patch failed",
            ),
            (
                event(3, "mcp_tool_call_end", result={"Err": "MCP failed"}),
                "MCP failed",
            ),
            (
                event(
                    4,
                    "item_completed",
                    item={
                        "type": "DynamicToolCall",
                        "content_items": [
                            {"type": "inputText", "text": "dynamic result"}
                        ],
                    },
                ),
                "dynamic result",
            ),
        ]
        for entry, expected in fixtures:
            with self.subTest(entry=entry):
                metadata = tool_record_metadata(*entry, direction="output")
                self.assertNotIn(expected, json.dumps(metadata))
                report = read_tool_record(
                    [entry], metadata["output_id"], direction="output"
                )
                self.assertEqual(
                    [field["text"] for field in report["fields"]], [expected]
                )

    def test_page_counts_lf_crlf_and_blank_lines_across_fields(self):
        first_twenty = "x\n" * 18 + "alpha\r\n\r\n"
        entry = event(
            10,
            "exec_command_end",
            stdout=first_twenty + "last\n",
            stderr="\r\n",
            aggregated_output="tail",
        )
        output_id = tool_record_metadata(*entry, direction="output")["output_id"]
        first = read_tool_record([entry], output_id, direction="output")
        cursor = parse_tool_cursor(first["next_cursor"], direction="output")
        second = read_tool_record([entry], output_id, direction="output", cursor=cursor)
        self.assertEqual([field["text"] for field in first["fields"]], [first_twenty])
        self.assertEqual(
            [(field["text"], field["text_offset"]) for field in second["fields"]],
            [("last\n", len(first_twenty)), ("\r\n", 0), ("tail", 0)],
        )
        self.assertIsNone(second["next_cursor"])

    def test_character_budget_defers_complete_lines_and_resumes_long_ones(self):
        entry = response(11, "custom_tool_call", input="0\n1234\nverylong\nend")
        input_id = tool_record_metadata(*entry, direction="input")["input_id"]
        cursor = None
        for offset, expected in (
            (0, "0\n"),
            (2, "1234\n"),
            (7, "verylo"),
            (13, "ng\nend"),
        ):
            if cursor is None:
                page = read_tool_record(
                    [entry], input_id, direction="input", budget_chars=6
                )
            else:
                page = read_tool_record(
                    [entry], input_id, direction="input", cursor=cursor
                )
            self.assertEqual(
                [(part["text_offset"], part["text"]) for part in page["fields"]],
                [(offset, expected)],
            )
            token = page["next_cursor"]
            cursor = parse_tool_cursor(token, direction="input") if token else None
        self.assertIsNone(cursor)

    def test_compact_cursor_keeps_large_effective_limits_and_rejects_malformed_tokens(
        self,
    ):
        entry = response(1200, "custom_tool_call", input="line\n" * 400)
        input_id = tool_record_metadata(*entry, direction="input")["input_id"]
        page = read_tool_record(
            [entry], input_id, direction="input", budget_chars=1 << 256, lines=129
        )
        token = page["next_cursor"]
        self.assertRegex(token, r"^[A-Za-z0-9._-]+$")
        self.assertLess(len(token), 80)
        for malformed in (token[:-2], token + "=", "x" + token, token + "."):
            with self.subTest(malformed=malformed), self.assertRaises(ValueError):
                parse_tool_cursor(malformed, direction="input")
        resumed = read_tool_record(
            [entry],
            input_id,
            direction="input",
            cursor=parse_tool_cursor(token, direction="input"),
        )
        self.assertEqual(resumed["fields"][0]["text"], "line\n" * 129)
        self.assertEqual(resumed["fields"][0]["text_offset"], 645)

    def test_inclusive_line_range_pages_across_fields_with_cursor_alone(self):
        entry = event(12, "exec_command_end", stdout="A\r\n\r\nB\n", stderr="C\nD")
        record_id = tool_record_metadata(*entry, direction="output")["output_id"]
        cursor = None
        for index, offset, text in ((0, 3, "\r\n"), (0, 5, "B\n"), (1, 0, "C\n")):
            if cursor is None:
                result = read_tool_record(
                    [entry],
                    record_id,
                    direction="output",
                    budget_chars=3,
                    line_range=(2, 4),
                )
            else:
                result = read_tool_record(
                    [entry], record_id, direction="output", cursor=cursor
                )
            self.assertEqual(
                [
                    (part["field_index"], part["text_offset"], part["text"])
                    for part in result["fields"]
                ],
                [(index, offset, text)],
            )
            token = result["next_cursor"]
            cursor = parse_tool_cursor(token, direction="output") if token else None
        self.assertIsNone(cursor)

    def test_cursor_rejects_rewritten_record_with_the_same_record_id(self):
        original = event(12, "exec_command_end", stdout="first\nnext\n", stderr="tail")
        record_id = tool_record_metadata(*original, direction="output")["output_id"]
        page = read_tool_record([original], record_id, direction="output", lines=1)
        cursor = parse_tool_cursor(page["next_cursor"], direction="output")
        resumed = read_tool_record(
            [original], record_id, direction="output", cursor=cursor
        )
        self.assertEqual([part["text"] for part in resumed["fields"]], ["next\n"])
        self.assertIsNotNone(resumed["next_cursor"])
        for rewritten in (
            event(12, "exec_command_end", stdout="first\nnext\n", stderr="changed"),
            event(12, "exec_command_end", stdout="short"),
            event(
                12,
                "exec_command_end",
                stdout="first\nnext\n",
                stderr="tail",
                cwd="/other",
            ),
        ):
            with self.subTest(rewritten=rewritten):
                self.assertEqual(
                    tool_record_metadata(*rewritten, direction="output")["output_id"],
                    record_id,
                )
                with self.assertRaisesRegex(ValueError, "cursor is stale"):
                    read_tool_record(
                        [rewritten], record_id, direction="output", cursor=cursor
                    )

    def test_cursor_survives_appending_a_line_ending_and_new_records(self):
        with TemporaryDirectory() as directory:
            source = Path(directory) / "live.jsonl"
            raw = (
                b'{"type":"response_item","payload":'
                b'{"type":"function_call_output","output":"first\\nnext"}}'
            )
            source.write_bytes(raw)
            segment = Segment(source, {})
            initial = list(records(segment, revision_lines={1}))
            record_id = tool_record_metadata(*initial[0], direction="output")[
                "output_id"
            ]
            first = read_tool_record(initial, record_id, direction="output", lines=1)
            with source.open("ab") as stream:
                stream.write(b"\r\n" + raw + b"\r\n")
            cursor = parse_tool_cursor(first["next_cursor"], direction="output")
            resumed = read_tool_record(
                records(segment, revision_lines={1}),
                record_id,
                direction="output",
                cursor=cursor,
            )
            self.assertEqual([part["text"] for part in resumed["fields"]], ["next"])
            self.assertIsNone(resumed["next_cursor"])

    def test_line_range_ignores_page_line_limit_and_stops_at_the_actual_end(self):
        body = "line\n" * 40
        entry = response(13, "custom_tool_call", input=body)
        record_id = tool_record_metadata(*entry, direction="input")["input_id"]
        for line_range, expected in (((15, 99), [body[70:]]), ((41, 99), [])):
            with self.subTest(line_range=line_range):
                result = read_tool_record(
                    [entry], record_id, direction="input", line_range=line_range
                )
                self.assertEqual([part["text"] for part in result["fields"]], expected)
                self.assertIsNone(result["next_cursor"])

    def test_user_shell_reads_keep_input_output_and_chat_separate(self):
        old_shell = (
            "<user_shell_command>\n<command>\necho legacy\n</command>\n<result>\n"
            "Exit code: 0\nDuration: 0.0001 seconds\nOutput:\nlegacy\n"
            "</result>\n</user_shell_command>"
        )
        entry = response(
            22,
            "message",
            role="user",
            content=[
                {"type": "input_text", "text": old_shell.replace("legacy", "quoted")},
                {"type": "input_text", "text": "annotated shell body without markers"},
                {"type": "input_text", "text": old_shell},
                {"type": "input_text", "text": "<user_shell_command>literal tags"},
            ],
            internal_chat_message_metadata_passthrough={
                "content_item_kinds": ["user.text", "shell.user_command", "unknown"],
            },
        )
        inputs = tool_record_metadata(*entry, direction="input")
        outputs = tool_record_metadata(*entry, direction="output")
        self.assertEqual(inputs["tool_name"], "exec_command")
        self.assertEqual(outputs["tool_name"], "exec_command")
        result = read_tool_record([entry], outputs["output_id"], direction="output")
        self.assertEqual(result["item_type"], "user_shell_command")
        self.assertEqual(
            [(field["field"], field["text"]) for field in result["fields"]],
            [
                ("content[1].text", "annotated shell body without markers"),
                (
                    "content[2].result",
                    "Exit code: 0\nDuration: 0.0001 seconds\nOutput:\nlegacy",
                ),
            ],
        )
        command = read_tool_record([entry], inputs["input_id"], direction="input")
        self.assertEqual(
            [(field["field"], field["text"]) for field in command["fields"]],
            [("content[2].command", "echo legacy")],
        )

    def test_standalone_web_search_results_are_readable_by_output_id(self):
        entry = event(
            25,
            "item_completed",
            item={
                "type": "Extension",
                "kind": "web.search",
                "id": "web-25",
                "query": "search input",
                "results": [{"title": "returned title"}],
            },
        )
        metadata = tool_record_metadata(*entry, direction="output")
        result = read_tool_record([entry], metadata["output_id"], direction="output")
        self.assertEqual(result["item_type"], "web.search")
        self.assertEqual(
            [(field["field"], field["text"]) for field in result["fields"]],
            [("results[0].title", "returned title")],
        )

    def test_input_id_on_completed_mcp_call_pages_arguments_without_result(self):
        entry = event(
            26,
            "mcp_tool_call_end",
            call_id="call_mcp",
            invocation={
                "server": "local_mcp",
                "tool": "query",
                "arguments": {"query": "a" * 4010, "encrypted_content": "ciphertext"},
            },
            result={"Ok": {"content": [{"type": "text", "text": "RESULT"}]}},
        )
        metadata = tool_record_metadata(*entry, direction="input")
        output_id = tool_record_metadata(*entry, direction="output")["output_id"]
        input_id = metadata["input_id"]
        self.assertTrue(input_id.startswith("in:"))
        self.assertEqual(metadata["call_id"], "call_mcp")
        self.assertEqual(metadata["tool_name"], "query")
        self.assertEqual(metadata["tool_server"], "local_mcp")
        self.assertNotIn("a" * 20, json.dumps(metadata))
        self.assertEqual(
            tool_record_target([SOURCE], input_id, direction="input"), (SOURCE, 26)
        )
        with self.assertRaisesRegex(ValueError, "expected a tool input ID"):
            tool_record_target([SOURCE], output_id, direction="input")

        first = read_tool_record([entry], input_id, direction="input")
        cursor = parse_tool_cursor(first["next_cursor"], direction="input")
        second = read_tool_record([entry], input_id, direction="input", cursor=cursor)
        self.assertEqual(
            [
                (part["field"], len(part["text"]), part["text_offset"])
                for part in first["fields"] + second["fields"]
            ],
            [
                ("invocation.arguments.query", 4000, 0),
                ("invocation.arguments.query", 10, 4000),
            ],
        )
        self.assertIsNone(second["next_cursor"])
        with self.assertRaisesRegex(ValueError, "expected a tool output ID"):
            parse_tool_cursor(first["next_cursor"], direction="output")

    def test_legacy_patch_diff_requires_input_id(self):
        entry = event(
            27,
            "patch_apply_end",
            call_id="call_patch",
            changes={"update.txt": {"type": "update", "unified_diff": "+new text"}},
            stdout="Patched update.txt",
        )
        for direction, expected in (
            ("input", ["update", "+new text"]),
            ("output", ["Patched update.txt"]),
        ):
            with self.subTest(direction=direction):
                metadata = tool_record_metadata(*entry, direction=direction)
                result = read_tool_record(
                    [entry], metadata[f"{direction}_id"], direction=direction
                )
                self.assertEqual([part["text"] for part in result["fields"]], expected)


if __name__ == "__main__":
    unittest.main()
