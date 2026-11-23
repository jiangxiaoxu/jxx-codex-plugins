import sys
import unittest
from pathlib import Path

sys.path.insert(
    0, str(Path(__file__).parents[1] / "skills" / "thread-memory" / "scripts")
)

from rollout_tokens import usage_for


class TokenUsageTests(unittest.TestCase):
    def test_response_pages_keep_scope_totals_and_resume_after_distinct_response(self):
        rows = [
            (
                Path("rollout.jsonl"),
                line,
                {
                    "type": "token_usage_record",
                    "payload": {
                        "response_id": response_id,
                        "usage": {"total_tokens": total},
                    },
                },
            )
            for line, (response_id, total) in enumerate(
                (("resp-a", 5), ("resp-b", 10), ("resp-a", 15), ("resp-c", 20)), 1
            )
        ]

        totals = usage_for(rows)
        self.assertEqual(totals["totals"]["total_tokens"], 45)
        self.assertNotIn("responses", totals)
        self.assertNotIn("next_cursor", totals)

        first = usage_for(rows, by_response=True, limit=2)
        self.assertEqual(
            [entry["response_id"] for entry in first["responses"]], ["resp-a", "resp-b"]
        )
        second = usage_for(rows, by_response=True, limit=2, cursor=first["next_cursor"])
        self.assertEqual(
            [entry["response_id"] for entry in second["responses"]], ["resp-c"]
        )
        self.assertIsNone(second["next_cursor"])
        self.assertEqual(first["totals"], totals["totals"])
        self.assertEqual(second["totals"], totals["totals"])

        with self.assertRaises(ValueError):
            usage_for(rows, by_response=True, cursor="missing")

    def test_summary_counts_are_always_visible_and_details_are_opt_in(self):
        path = Path("rollout.jsonl")
        encrypted = {"type": "compaction", "encrypted_content": "opaque"}
        rows = [
            (path, 1, {"type": "response_item", "payload": encrypted}),
            (
                path,
                2,
                {
                    "type": "compacted",
                    "payload": {
                        "replacement_history": [encrypted],
                        "compaction_response_id": "resp-a",
                        "latest_token_usage_record": {
                            "response_id": "resp-a",
                            "usage": {"output_tokens": 7},
                        },
                    },
                },
            ),
        ]

        for report in (usage_for(rows), usage_for(rows, by_response=True)):
            self.assertEqual(report["encrypted_summary_count"], 2)
            self.assertEqual(report["totals"]["encrypted_summary_output_tokens"], 7)
            self.assertNotIn("encrypted_summaries", report)

        first = usage_for(rows, by_summary=True, limit=1)
        self.assertEqual(
            [entry["tokens"] for entry in first["encrypted_summaries"]], [None]
        )
        second = usage_for(rows, by_summary=True, limit=1, cursor=first["next_cursor"])
        self.assertEqual(
            [entry["tokens"] for entry in second["encrypted_summaries"]], [7]
        )
        self.assertEqual(second["encrypted_summary_count"], 2)
        self.assertEqual(second["totals"], first["totals"])
        self.assertNotIn("responses", second)
        self.assertIsNone(second["next_cursor"])
