import json
import os
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).parents[1] / "skills" / "thread-memory" / "scripts"))

from rollout_handoff_snapshot import reminder_snapshot, reminder_window_id, snapshot
from rollout_handoff_store import load_rollout_checkpoint
from rollout_hook import hook_instructions


def record(kind, payload, *, ordinal=None):
    row = {} if ordinal is None else {"ordinal": ordinal}
    row.update(type=kind, payload=payload)
    return json.dumps(row, separators=(",", ":")).encode("utf-8") + b"\n"


def usage(tokens, *, ordinal=None):
    return record(
        "event_msg",
        {
            "type": "token_count",
            "info": {
                "last_token_usage": {"total_tokens": tokens},
                "model_context_window": 500_000,
            },
        },
        ordinal=ordinal,
    )


def receipt(
    window, level, *, ordinal=None,
    wrapper="<thread_memory_reminder>\n{}\n</thread_memory_reminder>",
    context_kind="hooks.additional_context", provenance_type="harness",
):
    text = wrapper.format(
        f"Use $thread-memory to update the current note.\nNotify ID: [{level}:{reminder_window_id(window)}]"
    )
    return record(
        "response_item",
        {
            "type": "message",
            "role": "developer",
            "content": [{
                "type": "input_text",
                "text": text,
            }],
            "internal_chat_message_metadata_passthrough": {
                "content_item_kinds": [context_kind],
                "content_item_metadata": [{"provenance": {"type": provenance_type, "hook": True}}],
            },
        },
        ordinal=ordinal,
    )


class CountedFile:
    def __init__(self, stream, count):
        self.stream = stream
        self.count = count

    def __enter__(self):
        self.stream.__enter__()
        return self

    def __exit__(self, *args):
        return self.stream.__exit__(*args)

    def __getattr__(self, name):
        return getattr(self.stream, name)

    def read(self, size=-1):
        data = self.stream.read(size)
        self.count(len(data))
        return data

    def readline(self, size=-1):
        data = self.stream.readline(size)
        self.count(len(data))
        return data


class IncrementalRolloutScanTest(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.path = Path(temporary.name) / "rollout.jsonl"
        self.header = record("session_meta", {"id": "fixture-thread"})
        self.path.write_bytes(self.header)

    def append(self, *records):
        with self.path.open("ab") as stream:
            for row in records:
                stream.write(row)

    def compare_scan(self, checkpoint=None, **expected):
        cold = snapshot(
            self.path, include_previous=False, minimum_used=1, collect_reminder_receipts=True,
            **expected,
        )
        actual, updated = reminder_snapshot(self.path, checkpoint, minimum_used=1, **expected)
        self.assertEqual(actual, cold)
        return actual, updated if updated is not None else checkpoint

    def test_append_preserves_receipts_and_resets_them_at_window_boundaries(self):
        self.append(usage(310_000))
        start, checkpoint = self.compare_scan()
        self.assertTrue(checkpoint)
        self.append(receipt(start.current, 65), usage(385_000), receipt(start.current, 80))
        state, checkpoint = self.compare_scan(checkpoint)
        self.assertEqual(state.used, 385_000)
        self.assertEqual(state.received_reminder_levels, {65, 80})

        boundaries = (
            record("compacted", {"replacement_history": []}),
            record("event_msg", {"type": "thread_rolled_back", "num_turns": 1}),
        )
        for boundary in boundaries:
            self.append(boundary, receipt(state.current, 80))
            advanced, checkpoint = self.compare_scan(checkpoint)
            self.assertNotEqual(advanced.current, state.current)
            self.assertIsNone(advanced.used)
            self.assertFalse(advanced.received_reminder_levels)
            self.append(usage(310_000), receipt(advanced.current, 65))
            state, checkpoint = self.compare_scan(checkpoint)
            self.assertEqual(state.used, 310_000)
            self.assertEqual(state.received_reminder_levels, {65})

    def test_receipt_requires_a_complete_trusted_reminder_block(self):
        self.append(usage(315_000))
        start, checkpoint = self.compare_scan()
        self.assertTrue(checkpoint)

        malformed = (
            "<thread_memory_reminder>\n{}",
            "<thread_memory_reminder\n{}",
            "<thread_memory_reminder>\n<thread_memory_reminder>\n{}\n</thread_memory_reminder>",
            "<thread_memory_reminder>\n</thread_memory_reminder>\n{}\n</thread_memory_reminder>",
        )
        for wrapper in malformed:
            with self.subTest(wrapper=wrapper):
                self.append(receipt(start.current, 65, wrapper=wrapper))
                incomplete, checkpoint = self.compare_scan(checkpoint)
                self.assertFalse(incomplete.received_reminder_levels)

        self.append(
            receipt(start.current, 65, context_kind="developer.instructions"),
            receipt(start.current, 65, provenance_type="user"),
            receipt(start.current, 80),
        )
        complete, _ = self.compare_scan(checkpoint)
        self.assertEqual(complete.received_reminder_levels, {80})

    def test_unterminated_tail_is_processed_once_completed(self):
        self.append(usage(310_000))
        before, checkpoint = self.compare_scan()
        added = usage(385_000)
        split = len(added) // 2
        self.append(added[:split])
        incomplete, checkpoint = self.compare_scan(checkpoint)
        self.assertEqual(incomplete, before)
        self.append(added[split:])
        complete, _ = self.compare_scan(checkpoint)
        self.assertEqual(complete.used, 385_000)

    def test_incremental_scan_requires_window_boundary_within_cold_scan_limit(self):
        checkpoint_row = record("compacted", {"replacement_history": []})
        unrelated = record("response_item", {"type": "message", "role": "user", "text": "x" * 512})
        with patch("rollout_handoff_snapshot.SCAN_BYTES", 4096):
            self.append(checkpoint_row, usage(310_000))
            before, checkpoint = self.compare_scan()
            self.assertTrue(checkpoint)

            self.append(*([unrelated] * 5), usage(310_000))
            still_current, checkpoint = self.compare_scan(checkpoint)
            self.assertEqual(still_current.current, before.current)

            self.append(*([unrelated] * 4), usage(385_000))
            unknown, checkpoint = self.compare_scan(checkpoint)
            self.assertIsNone(unknown)

            self.append(checkpoint_row, usage(385_000))
            current, _ = self.compare_scan(checkpoint)
            self.assertNotEqual(current.current, before.current)
            self.assertEqual(current.used, 385_000)
            verified = snapshot(self.path, include_previous=False)
            self.assertEqual(current.current, verified.current)

    def test_replacement_with_same_header_and_size_invalidates_cached_usage(self):
        self.append(usage(310_000))
        before, checkpoint = self.compare_scan()
        replacement = self.path.with_suffix(".replacement")
        replacement.write_bytes(self.header + usage(385_000))
        self.assertEqual(replacement.stat().st_size, self.path.stat().st_size)
        os.replace(replacement, self.path)
        changed, _ = self.compare_scan(checkpoint)
        self.assertEqual(changed.current, before.current)
        self.assertEqual(changed.used, 385_000)

    def test_copied_prefix_does_not_seed_inherited_usage(self):
        self.path.write_bytes(record("session_meta", {
            "id": "fixture-child", "forked_from_id": "fixture-parent",
            "subagent_history_start_ordinal": 10,
        }, ordinal=0))
        self.append(record("compacted", {"replacement_history": []}, ordinal=4), usage(900_000, ordinal=5))
        inherited, checkpoint = self.compare_scan()
        self.assertIsNone(inherited.used)
        self.append(usage(310_000, ordinal=10))
        owned, checkpoint = self.compare_scan(checkpoint)
        self.assertEqual(owned.current, inherited.current)
        self.assertEqual(owned.used, 310_000)
        self.append(usage(385_000, ordinal=11))
        current, _ = self.compare_scan(checkpoint)
        self.assertEqual(current.used, 385_000)

    def test_hook_reloads_sqlite_checkpoint_without_rereading_large_active_window(self):
        thread = "00000000-0000-4000-8000-000000000001"
        self.path.write_bytes(record("session_meta", {"id": thread, "source": "vscode"}))
        large_message = record("response_item", {"type": "message", "role": "user", "text": "x" * 200_000})
        model = "fixture-model"
        for index in range(160):
            turn = f"turn-{index}"
            self.append(
                record("event_msg", {"type": "task_started", "turn_id": turn, "model_context_window": 500_000}),
                record("turn_context", {"turn_id": turn, "model": model}),
            )
            if index % 5 == 0:
                self.append(large_message)
        self.append(usage(310_000))
        home = self.path.parent
        request = {
            "hook_event_name": "PostToolUse",
            "session_id": thread,
            "transcript_path": str(self.path),
            "turn_id": turn,
            "model": model,
        }
        settings = {
            "THREAD_MEMORY_ASYNC_START_TOKENS": "355000",
            "THREAD_MEMORY_HANDOFF_LEAD_TOKENS": "45000",
        }
        total = 0
        open_path = Path.open

        def count(size):
            nonlocal total
            total += size

        def measured_open(path, *args, **kwargs):
            return CountedFile(open_path(path, *args, **kwargs), count)

        def response_usage(tokens):
            return record("token_usage_record", {"turn_id": turn, "usage": {"total_tokens": tokens}})

        with patch.dict(os.environ, settings):
            self.assertIsNotNone(hook_instructions(request, home))
            path = str(self.path.absolute())
            checkpoint = load_rollout_checkpoint(home, thread, path)
            self.assertTrue(checkpoint)
            before = snapshot(self.path, include_previous=False)
            self.append(response_usage(315_000))

            with patch.object(Path, "open", measured_open):
                cold = snapshot(
                    self.path, include_previous=False, minimum_used=310_000,
                    collect_reminder_receipts=True,
                )
                cold_bytes, total = total, 0
                self.assertIn("follow-up reminder", hook_instructions(request, home) or "")
                self.append(receipt(before.current, 0), response_usage(385_000))
                self.assertIsNone(hook_instructions(request, home))
            advanced = load_rollout_checkpoint(home, thread, path)
            self.assertTrue(advanced)
            self.assertNotEqual(advanced, checkpoint)
        self.assertEqual(cold.used, 315_000)
        self.assertEqual(cold.capacity, 500_000)
        self.assertLess(total, cold_bytes // 3)

    def test_appended_sample_can_still_lookup_an_older_turn(self):
        for old_model, old_capacity in (("current-model", 400_000), ("old-model", 500_000)):
            with self.subTest(old_model=old_model, old_capacity=old_capacity):
                self.path.write_bytes(self.header)
                self.append(
                    record("event_msg", {"type": "task_started", "turn_id": "old",
                                         "model_context_window": old_capacity}),
                    record("turn_context", {"turn_id": "old", "model": old_model}),
                    record("event_msg", {"type": "task_started", "turn_id": "new",
                                         "model_context_window": 500_000}),
                    record("turn_context", {"turn_id": "new", "model": "current-model"}),
                    usage(320_000),
                )
                before, checkpoint = self.compare_scan(expected_turn="new", expected_model="current-model")
                self.assertTrue(checkpoint)

                self.append(record("token_usage_record", {"turn_id": "old", "usage": {"total_tokens": 350_000}}))
                state, _ = self.compare_scan(checkpoint, expected_turn="new", expected_model="current-model")
                self.assertEqual(state, before)


if __name__ == "__main__":
    unittest.main()
