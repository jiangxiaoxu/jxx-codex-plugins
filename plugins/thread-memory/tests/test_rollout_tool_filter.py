import json
import sys
import tempfile
import unittest
from argparse import Namespace
from pathlib import Path

SCRIPTS = Path(__file__).parents[1] / "skills" / "thread-memory" / "scripts"
sys.path.insert(0, str(SCRIPTS))

from rollout_scope import instant, scoped_rows
from rollout_source import ScanDiagnostics, Segment


def response(item_type, call_id, **payload):
    return "response_item", {"type": item_type, "call_id": call_id, **payload}


def event(item_type, **payload):
    return "event_msg", {"type": item_type, **payload}


class ToolNameScopeTests(unittest.TestCase):
    def scan(self, records, *, metadata=None, salvage=False, **scope):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "rollout.jsonl"
            with path.open("w", encoding="utf-8", newline="\n") as stream:
                for number, record in enumerate(records, 1):
                    if record is None:
                        stream.write("{broken\n")
                        continue
                    kind, payload = record
                    row = {
                        "timestamp": f"2025-01-01T00:00:{number:02d}Z",
                        "ordinal": number,
                        "type": kind,
                        "payload": payload,
                    }
                    stream.write(json.dumps(row, separators=(",", ":")) + "\n")
            config = {
                "origin": "all",
                "segment": None,
                "window": None,
                "lines": None,
                "since": None,
                "until": None,
                "turn": None,
                **scope,
            }
            segment = Segment(
                path,
                {"id": "thread", **(metadata or {})},
                diagnostics=ScanDiagnostics(salvage=salvage),
            )
            return {
                line: row.get("_rollout_tool_name")
                for _, line, row in scoped_rows(
                    [segment],
                    Namespace(**config),
                    resolve_tool_names=True,
                )
            }

    def test_prior_calls_are_visible_for_name_resolution_outside_query_scope(self):
        names = self.scan(
            [
                response("function_call", "shared", name="exec", arguments="secret"),
                response("custom_tool_call", "shared", name="patch", input="abc"),
                response("function_call_output", "shared", output="hidden body"),
                response("custom_tool_call_output", "unknown", output="hidden body"),
                response("custom_tool_call_output", "shared", output="hidden body"),
            ],
            lines=(3, 5),
            since=instant("2025-01-01T00:00:03Z"),
        )
        self.assertEqual(names, {3: "exec", 4: None, 5: "patch"})

    def test_ambiguous_or_incompatible_calls_do_not_resolve(self):
        names = self.scan(
            [
                response("function_call", "repeated", name="exec"),
                response("function_call", "repeated", name="exec"),
                response("function_call_output", "repeated", output="first"),
                response("function_call", "other", name="exec", namespace="help"),
                response(
                    "function_call_output", "other", namespace="mcp", output="second"
                ),
                response("custom_tool_call_output", "other", output="third"),
                response(
                    "function_call_output", "other", name="native", output="fourth"
                ),
            ],
            lines=(3, 7),
        )
        self.assertEqual(names, {3: None, 4: None, 5: None, 6: None, 7: None})

    def test_fork_provenance_never_associates_copied_and_owned_records(self):
        records = [
            response("function_call", "splice", name="exec"),
            response("function_call_output", "splice", output="copied"),
            response("function_call_output", "splice", output="owned"),
        ]
        self.assertEqual(
            self.scan(
                records,
                metadata={
                    "forked_from_id": "parent",
                    "subagent_history_start_ordinal": 3,
                },
            ),
            {1: None, 2: "exec", 3: None},
        )
        self.assertEqual(
            self.scan(records, metadata={"forked_from_id": "parent"}),
            {1: None, 2: None, 3: None},
        )

    def test_local_shell_calls_share_the_function_call_output_family(self):
        names = self.scan(
            [
                response("local_shell_call", "shell", action={"command": ["run"]}),
                response("local_shell_call", "collision", action={"command": ["run"]}),
                response("function_call", "collision", name="decoy"),
                response("function_call_output", "shell", output="first"),
                response("function_call_output", "collision", output="second"),
            ],
            lines=(4, 5),
        )
        self.assertEqual(names, {4: "exec_command", 5: None})

    def test_name_inference_resets_at_history_barriers(self):
        for boundary in (
            event("thread_rolled_back"),
            event("task_started", turn_id="new-turn"),
            ("compacted", {}),
            None,
        ):
            with self.subTest(boundary=boundary):
                names = self.scan(
                    [
                        response("function_call", "stale", name="exec"),
                        boundary,
                        response("function_call_output", "stale", output="after"),
                    ],
                    lines=(3, 3),
                    salvage=boundary is None,
                )
                self.assertEqual(names, {3: None})


if __name__ == "__main__":
    unittest.main()
