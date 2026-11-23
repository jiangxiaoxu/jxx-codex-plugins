import importlib
import json
import sys
import tempfile
import unittest
from pathlib import Path

SCRIPTS = (
    Path(__file__).resolve().parents[1] / "skills" / "thread-memory" / "scripts"
)
sys.path.insert(0, str(SCRIPTS))

from rollout_recover import recover
from rollout_scope import annotate_rows
from rollout_source import (
    RolloutDataError,
    ScanDiagnostics,
    Segment,
    metadata,
    records,
    resolve_segments,
    selected_rows,
)


def encoded(ordinal, kind, payload, **fields):
    row = {
        "timestamp": "2026-11-21T07:44:02.806Z",
        "ordinal": ordinal,
        "type": kind,
        "payload": payload,
        **fields,
    }
    return (json.dumps(row, separators=(",", ":"), ensure_ascii=False) + "\n").encode(
        "utf-8"
    )


class RolloutSourceTest(unittest.TestCase):
    def test_salvage_skips_corrupt_records_and_preserves_physical_locations(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "rollout.jsonl"
            first = encoded(10, "session_meta", {"id": "thread"})
            damaged = (
                b'{"timestamp":"2026-11-21T07:44:02.806Z","ordinal":11,'
                b'"type":"world_state","payload":{"broken":"\xff"}}\n'
            )
            wrong_shape = b'{"type":"world_state","payload":[]}\n'
            last = encoded(13, "world_state", {"state": "valid"})
            last_offset = len(first + damaged + wrong_shape)
            path.write_bytes(first + damaged + wrong_shape + last)
            with self.assertRaises(RolloutDataError) as caught:
                list(records(Segment(path, {})))
            self.assertEqual((caught.exception.path, caught.exception.line), (path, 2))
            self.assertIn("invalid JSONL", caught.exception.message)

            diagnostics = ScanDiagnostics(salvage=True)
            segments, _ = resolve_segments(
                path, None, Path(directory), [], diagnostics=diagnostics
            )
            rows = list(records(segments[0], keep_payload=set()))
            self.assertEqual([line for _, line, _ in rows], [1, 4])
            self.assertEqual(rows[-1][2]["_rollout_offset"], last_offset)
            self.assertTrue(rows[-1][2]["_rollout_gap"])
            self.assertEqual(
                diagnostics.issues,
                {
                    (path, 2): {
                        "path": str(path),
                        "line": 2,
                        "byte_offset": len(first),
                        "reason": "invalid_json",
                    },
                    (path, 3): {
                        "path": str(path),
                        "line": 3,
                        "byte_offset": len(first + damaged),
                        "reason": "invalid_record",
                    },
                },
            )

            offsets = {2: len(first), 4: last_offset}
            self.assertEqual(
                list(
                    selected_rows(
                        path, {2, 4}, offsets=offsets, diagnostics=diagnostics
                    )
                ),
                [(4, json.loads(last))],
            )
            self.assertEqual(len(diagnostics.issues), 2)

    def test_malformed_record_reports_physical_location(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "rollout.jsonl"
            header = encoded(1, "session_meta", {"id": "thread"})
            for damaged, reason in (
                (b"null\n", "record structure"),
                (b'{"type":"world_state","payload":[]}\n', "record structure"),
                (
                    b'{"type":"event_msg","payload":{"type":"item_completed","item":5}}\n',
                    "record structure",
                ),
                (b"[" * 20000 + b"]" * 20000 + b"\n", "nesting is too deep"),
            ):
                with self.subTest(reason=reason):
                    path.write_bytes(header + damaged)
                    with self.assertRaises(RolloutDataError) as caught:
                        list(records(Segment(path, {})))
                    error = caught.exception
                    self.assertEqual((error.path, error.line), (path, 2))
                    self.assertIn(reason, error.message)

    def test_bad_history_base_identifies_owning_header(self):
        with tempfile.TemporaryDirectory() as directory:
            home = Path(directory)
            path = home / "rollout.jsonl"
            path.write_bytes(
                encoded(1, "session_meta", {"id": "thread", "history_base": {}})
            )
            with self.assertRaises(RolloutDataError) as caught:
                resolve_segments(path, None, home, [])
            error = caught.exception
            self.assertEqual((error.path, error.line), (path, 1))
            self.assertIn("history_base.thread_id", error.message)

    def test_zstandard_decoder_failure_identifies_archive(self):
        try:
            zstd = importlib.import_module("zstandard")
        except ImportError:
            self.skipTest("zstandard package not installed")
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "rollout.jsonl.zst"
            payload = {"id": "thread"}
            path.write_bytes(zstd.compress(encoded(1, "session_meta", payload)))
            self.assertEqual(metadata(path), payload)
            self.assertEqual([line for _, line, _ in records(Segment(path, {}))], [1])

            path.write_bytes(b"not a zstandard archive\x00")
            with self.assertRaises(RolloutDataError) as caught:
                metadata(path)
            self.assertEqual(caught.exception.path, path)
            self.assertIn(
                "cannot decompress Zstandard rollout", caught.exception.message
            )

    def test_active_tail_is_reported_and_complete_tail_is_readable(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "rollout.jsonl"
            first = encoded(10, "world_state", {"state": "valid"})
            final = encoded(11, "world_state", {"state": "last"}).rstrip(b"\n")
            path.write_bytes(first + final[:-1])
            diagnostics = ScanDiagnostics()
            segment = Segment(path, {}, diagnostics=diagnostics)
            self.assertEqual([line for _, line, _ in records(segment)], [1])
            self.assertEqual(diagnostics.issues[(path, 2)]["reason"], "partial_tail")
            self.assertEqual(diagnostics.issues[(path, 2)]["byte_offset"], len(first))

            path.write_bytes(first + final)
            diagnostics = ScanDiagnostics(salvage=True)
            segment = Segment(path, {}, diagnostics=diagnostics)
            rows = list(records(segment))
            self.assertEqual([line for _, line, _ in rows], [1, 2])
            self.assertIsNone(rows[-1][2]["_rollout_next_offset"])
            self.assertFalse(diagnostics.issues)

    def test_salvage_skips_incomplete_chat_payloads(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "rollout.jsonl"
            path.write_bytes(
                encoded(1, "response_item", {"type": "message", "role": "user"})
                + encoded(
                    2,
                    "response_item",
                    {"type": "message", "role": "user", "content": [None]},
                )
                + encoded(
                    3,
                    "response_item",
                    {
                        "type": "message",
                        "role": "user",
                        "content": [{"type": "input_text"}],
                    },
                )
                + encoded(4, "event_msg", {"type": "item_completed"})
                + encoded(
                    5,
                    "event_msg",
                    {
                        "type": "item_completed",
                        "item": {"type": "AgentMessage", "delivery": "async"},
                    },
                )
                + encoded(
                    6, "event_msg", {"type": "agent_message", "delivery": "async"}
                )
                + encoded(
                    7,
                    "response_item",
                    {
                        "type": "message",
                        "role": "assistant",
                        "content": [{"type": "output_text", "text": "valid"}],
                    },
                )
            )
            diagnostics = ScanDiagnostics(salvage=True)
            rows = list(records(Segment(path, {}, diagnostics=diagnostics)))
            self.assertEqual([line for _, line, _ in rows], [7])
            self.assertTrue(rows[0][2]["_rollout_gap"])
            self.assertEqual(
                [
                    (line, issue["reason"])
                    for (_, line), issue in diagnostics.issues.items()
                ],
                [(line, "invalid_record") for line in range(1, 7)],
            )

    def test_salvage_requires_intact_ancestor_cutoff_and_ignores_outside_damage(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "rollout.jsonl"
            first = encoded(10, "world_state", {"state": "valid"})
            damaged = b'{"timestamp":\n'
            last = encoded(12, "world_state", {"state": "boundary"})
            path.write_bytes(first + damaged + last + damaged)
            diagnostics = ScanDiagnostics(salvage=True)
            segment = Segment(
                path,
                {},
                end_ordinal=13,
                end_offset=len(first + damaged + last),
                diagnostics=diagnostics,
            )
            self.assertEqual([line for _, line, _ in records(segment)], [1, 3])
            self.assertEqual(list(diagnostics.issues), [(path, 2)])

            segment = Segment(
                path,
                {},
                end_ordinal=11,
                end_offset=len(first + damaged),
                diagnostics=diagnostics,
            )
            with self.assertRaisesRegex(ValueError, "history_base cutoff"):
                list(records(segment))

    def test_recovery_salvages_after_damaged_nested_records(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "rollout.jsonl"
            header = {"id": "thread"}
            message = {
                "type": "message",
                "role": "user",
                "content": [{"type": "input_text", "text": "evidence after damage"}],
            }
            damaged = [
                ("compacted", {"replacement_history": [None]}),
                (
                    "compacted",
                    {"replacement_history": [{**message, "content": [None]}]},
                ),
                (
                    "compacted",
                    {
                        "replacement_history": [message],
                        "replacement_history_metadata": ["invalid"],
                    },
                ),
                ("event_msg", {"type": "thread_rolled_back", "num_turns": "1"}),
                (
                    "response_item",
                    {
                        **message,
                        "internal_chat_message_metadata_passthrough": "invalid",
                    },
                ),
                (
                    "response_item",
                    {
                        **message,
                        "internal_chat_message_metadata_passthrough": {
                            "content_item_kinds": [None],
                        },
                    },
                ),
                ("response_item", {"type": "function_call_output", "output": [None]}),
                (
                    "response_item",
                    {
                        **message,
                        "content": [{"type": "input_image", "image_url": ["bad"]}],
                    },
                ),
                (
                    "event_msg",
                    {
                        "type": "item_completed",
                        "item": {"type": "UserMessage", "content": [None]},
                    },
                ),
                ("turn_context", {"cwd": []}),
            ]
            retained = {
                **message,
                "content": [{"type": "input_text", "text": "retained evidence"}],
                "internal_chat_message_metadata_passthrough": {
                    "content_item_kinds": ["user.text"],
                },
            }
            records_to_encode = [
                ("session_meta", header),
                (
                    "response_item",
                    {
                        **message,
                        "content": [{"type": "input_text", "text": "before damage"}],
                    },
                ),
                *damaged,
                ("response_item", message),
                ("response_item", retained),
                (
                    "compacted",
                    {
                        "window_number": 7,
                        "replacement_history": [retained],
                        "replacement_history_metadata": [{"client_authored": True}],
                    },
                ),
            ]
            path.write_bytes(
                b"".join(
                    encoded(ordinal, kind, payload)
                    for ordinal, (kind, payload) in enumerate(records_to_encode, 1)
                )
            )
            diagnostics = ScanDiagnostics(salvage=True)
            segment = Segment(path, header, diagnostics=diagnostics)
            rows = list(annotate_rows(segment, "thread"))
            report = recover(rows, path, max_images=0)
            message_line = 3 + len(damaged)
            self.assertEqual((report["status"], report["window_number"]), ("ok", 7))
            self.assertEqual(
                [(item["line"], item["text"]) for item in report["messages"]],
                [(message_line, "evidence after damage")],
            )
            self.assertEqual(
                report["history_ignored_through_gap"],
                {"rollout": path.name, "next_valid_line": message_line},
            )
            self.assertEqual(
                [
                    (issue["line"], issue["reason"])
                    for issue in diagnostics.issues.values()
                ],
                [(line, "invalid_record") for line in range(3, message_line)],
            )

    def test_projection_keeps_requested_payloads_and_legacy_origin(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "rollout.jsonl"
            inherited = {"inherited_user_message": True}
            path.write_bytes(
                encoded(10, "event_msg", {"type": "item_completed", "item": "data"})
                + encoded(11, "event_msg", {"type": "task_started", "turn_id": "turn"})
                + encoded(
                    12,
                    "response_item",
                    {"type": "message", "content": ["copied"]},
                    metadata=inherited,
                )
                + encoded(13, "world_state", {"state": "requested by line"})
                + b'{"type":"world_state","payload":{"state":"legacy layout"}}\n'
            )
            filters = {
                "keep_payload": set(),
                "event_types": {"task_started"},
                "response_types": {"compaction"},
                "full_lines": {4},
            }

            rows = [row for _, _, row in records(Segment(path, {}), **filters)]
            self.assertEqual(rows[0]["payload"], {"type": "item_completed"})
            self.assertEqual(rows[1]["payload"]["turn_id"], "turn")
            self.assertEqual(rows[2]["payload"], {"type": "message"})
            self.assertEqual(rows[3]["payload"]["state"], "requested by line")
            self.assertEqual(rows[4]["payload"]["state"], "legacy layout")

            legacy = Segment(path, {"forked_from_id": "parent"})
            rows = [row for _, _, row in records(legacy, **filters)]
            self.assertEqual(rows[2]["metadata"], inherited)

    def test_projection_rejects_truncated_nested_record_with_linefeed(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "rollout.jsonl"
            complete = encoded(
                10,
                "event_msg",
                {
                    "type": "item_completed",
                    "item": {"nested": {"text": 'escaped: \\"}}[]\\'}},
                },
            )
            path.write_bytes(complete)
            _, _, row = next(records(Segment(path, {}), event_types=set()))
            self.assertEqual(row["payload"], {"type": "item_completed"})

            # Keep the inner braces and simulate the recorder appending LF.
            path.write_bytes(complete[:-3] + b"\n")
            with self.assertRaises(ValueError):
                list(records(Segment(path, {}), event_types=set()))

    def test_byte_cursor_and_image_reread_respect_physical_lines_and_cutoff(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "rollout.jsonl"
            first = encoded(10, "world_state", {"state": "窗口"}).replace(
                b"\n", b"\r\n"
            )
            second = encoded(11, "response_item", {"type": "message", "content": []})
            cutoff = len(first) + 1 + len(second)
            path.write_bytes(first + b"\n" + second + b'{"timestamp":')
            segment = Segment(path, {}, end_ordinal=12, end_offset=cutoff)
            rows = list(records(segment, keep_payload=set()))
            _, first_line, first_row = rows[0]
            suffix = list(
                records(segment, start=(first_line, first_row["_rollout_next_offset"]))
            )
            _, line, row = suffix[0]
            self.assertEqual(line, 3)
            self.assertEqual(row["_rollout_offset"], len(first) + 1)
            self.assertEqual(row["_rollout_next_offset"], cutoff)
            self.assertEqual(
                list(
                    selected_rows(path, {line}, offsets={line: row["_rollout_offset"]})
                ),
                [(3, json.loads(second))],
            )
            self.assertEqual(list(records(segment, start=(line, cutoff))), [])
            self.assertEqual(
                len(list(records(Segment(path, {}), keep_payload=set()))), 2
            )

            # A complete record without LF is readable, but its next-line cursor
            # cannot be reused while the writer may still append the terminator.
            path.write_bytes(second.rstrip(b"\n"))
            _, _, tail = next(records(Segment(path, {}), keep_payload=set()))
            self.assertIsNone(tail["_rollout_next_offset"])


if __name__ == "__main__":
    unittest.main()
