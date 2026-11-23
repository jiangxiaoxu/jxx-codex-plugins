import sys
import tempfile
import unittest
from pathlib import Path
from uuid import uuid4


SCRIPTS = Path(__file__).resolve().parents[1] / "skills" / "thread-memory" / "scripts"
sys.path.insert(0, str(SCRIPTS))

from rollout_handoff_store import (
    delete_handoff_threads,
    memory_revision,
    memory_timestamp,
    read_hook_diagnostics,
    read_reminder_telemetry,
    record_reminder_telemetry,
    save_memory,
    stored_threads,
)


class ReminderTelemetryStoreTest(unittest.TestCase):
    def test_cleanup_removes_thread_evidence_and_keeps_grouped_observations(self):
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        home = Path(directory.name)
        thread_id = str(uuid4())
        first_note = save_memory(home, thread_id, "Before compaction")
        compacted_at = memory_timestamp(first_note.updated_us)
        latest_note = save_memory(home, thread_id, "After compaction")
        self.assertEqual(read_reminder_telemetry(home), [])

        first_leads = (45_000, 35_000, 25_000)
        new_leads = (50_000, 35_000, 25_000)
        for leads, used, stage in ((first_leads, 106_000, 0), (new_leads, 151_000, 2)):
            self.assertTrue(record_reminder_telemetry(
                home, thread_id, window="previous", notify_id="oldnotify",
                leads=leads, used=used, decisions=((65, stage, 150_000),),
            ))
        receipts = (
            ("oldnotify", 65, "different-line-1", "2026-11-20T13:50:50Z"),
            ("oldnotify", 65, "different-line-2", "2026-11-20T13:50:52Z"),
        )
        for _ in range(2):
            self.assertTrue(record_reminder_telemetry(
                home, thread_id, receipts=receipts,
                compactions=(("current", compacted_at, "previous"),),
            ))
        totals = read_reminder_telemetry(home)
        self.assertEqual(
            {(tuple(row["leads"]), row["metric"], row["remaining_tokens_bucket"]): row["count"] for row in totals},
            {
                (first_leads, "first", 40_000): 1,
                (new_leads, "followup_2", -5_000): 1,
                (first_leads, "delivery_observed", None): 2,
                (first_leads, "duplicate_observed", None): 1,
            },
        )
        checkpoint, repeat, first = read_hook_diagnostics(home, thread_id, limit=20)
        self.assertEqual(checkpoint["details"], {
            "compacted_at": compacted_at, "previous_window": "previous", "note_updated_at": compacted_at,
        })
        self.assertEqual(
            [(item["details"]["recorded_at"], item["details"]["duplicate"]) for item in (first, repeat)],
            [(receipts[0][3], False), (receipts[1][3], True)],
        )
        self.assertEqual(memory_revision(home, thread_id), latest_note)
        self.assertIn(thread_id, stored_threads(home))

        self.assertGreater(delete_handoff_threads(home, [thread_id]), 0)
        self.assertNotIn(thread_id, stored_threads(home))
        self.assertEqual(read_hook_diagnostics(home, thread_id, limit=20), [])
        self.assertEqual(read_reminder_telemetry(home), totals)
