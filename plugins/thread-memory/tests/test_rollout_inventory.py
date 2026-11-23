import json
import sys
import unittest
from pathlib import Path

sys.path.insert(
    0, str(Path(__file__).parents[1] / "skills" / "thread-memory" / "scripts")
)

from rollout_inventory import inventory
from rollout_refs import parse_ref
from rollout_search import read_reference

SOURCE = Path("fixture.jsonl")


def row(line, kind, payload):
    return SOURCE, line, {"type": kind, "payload": payload}


class InventoryTests(unittest.TestCase):
    def test_counts_unknown_nested_types_and_keeps_examples_metadata_only(self):
        first = row(
            2,
            "event_msg",
            {
                "type": "item_completed",
                "item": {"type": "FutureItem", "body": "hidden payload"},
            },
        )
        rows = [
            first,
            row(3, "event_msg", first[2]["payload"]),
            row(
                4,
                "event_msg",
                {"type": "item_started", "item": {"type": "FutureItem"}},
            ),
            row(5, "future_record", {"body": "hidden payload"}),
            row(
                6,
                "response_item",
                {
                    "type": "message",
                    "role": "user",
                    "content": [{"type": "input_text", "text": "hidden chat"}],
                },
            ),
        ]

        page = inventory(iter(rows), limit=2)
        self.assertEqual(page["record_count"], 5)
        self.assertEqual(page["group_count"], 4)
        completed, started = page["items"]
        self.assertEqual(
            (completed["item_type"], completed["event_type"], completed["count"]),
            ("FutureItem", "item_completed", 2),
        )
        self.assertEqual((started["event_type"], started["count"]), ("item_started", 1))
        self.assertEqual(completed["example"]["line"], 2)
        self.assertFalse(completed["example"]["body_available"])
        self.assertFalse(
            read_reference(first, parse_ref(completed["example"]["ref"]))["fields"]
        )
        self.assertNotIn("hidden", json.dumps(page))

        tail = inventory(iter(rows), limit=2, cursor=page["next_cursor"])
        self.assertEqual(
            [entry["kind"] for entry in tail["items"]],
            ["future_record", "response_item"],
        )
        self.assertIsNone(tail["next_cursor"])
        self.assertNotIn("hidden", json.dumps(tail))

        filtered = inventory(iter(rows), kinds=["message"], roles=["user"])
        self.assertEqual(filtered["record_count"], 1)
        self.assertTrue(filtered["items"][0]["example"]["body_available"])
        ref = parse_ref(filtered["items"][0]["example"]["ref"])
        self.assertEqual(
            read_reference(rows[4], ref)["fields"][0]["text"], "hidden chat"
        )
