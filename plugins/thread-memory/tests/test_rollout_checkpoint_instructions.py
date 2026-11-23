import sys
import unittest
from pathlib import Path

sys.path.insert(
    0, str(Path(__file__).parents[1] / "skills" / "thread-memory" / "scripts")
)

from rollout_checkpoint_instructions import checkpoint_instructions


def text_part(text):
    return {"type": "input_text", "text": text}


def message(role, *content):
    return {"type": "message", "role": role, "content": list(content)}


def checkpoint(*history, revision="a" * 32):
    return (
        Path("rollout.jsonl"),
        40,
        {
            "type": "compacted",
            "payload": {
                "message": "handoff text",
                "replacement_history": list(history),
            },
            "_rollout_revision": revision,
        },
    )


class CheckpointInstructionsTests(unittest.TestCase):
    def test_reads_only_typed_plain_instruction_text_with_physical_index(self):
        location = checkpoint(
            message("user", text_part("previous chat")),
            message("system", text_part("system rule")),
            {"type": "function_call_output", "role": "developer", "output": "tool"},
            {
                **message(
                    "developer",
                    text_part("first paragraph"),
                    {"type": "input_image", "image_url": "file:/image.png"},
                    {"type": "encrypted_content", "text": "ciphertext"},
                    text_part({"value": "invalid nested text"}),
                    text_part("second: data:image/png;base64,YWFh"),
                ),
                "encrypted_content": "protected",
            },
            message("assistant", text_part("assistant history")),
        )
        items = checkpoint_instructions(location, window=2)["items"]
        self.assertEqual(
            [(item["checkpoint_item"], item["role"], item["text"]) for item in items],
            [
                (1, "system", "system rule"),
                (3, "developer", "first paragraph\nsecond: [data URL omitted]"),
            ],
        )
        selected = checkpoint_instructions(
            location, window=2, roles={"developer"}, item=3
        )
        self.assertEqual(selected["items"], [items[1]])
        self.assertEqual((items[1]["line"], items[1]["window"]), (40, 2))

    def test_bounded_excerpts_and_exact_checkpoint_cursor(self):
        history = (
            message("developer", text_part("abcdefgh")),
            message("assistant", text_part("chat")),
            message("system", text_part("zyxwvuts")),
        )
        location = checkpoint(*history)
        first = checkpoint_instructions(location, window=1, budget_chars=3)
        self.assertEqual(first["items"][0]["text"], "abc")
        self.assertTrue(first["items"][0]["text_truncated"])
        next_cursor = first["next_cursor"]
        second = checkpoint_instructions(location, window=1, cursor=next_cursor)
        self.assertEqual(second["items"][0]["checkpoint_item"], 2)
        self.assertIsNone(second["next_cursor"])
        sliced = checkpoint_instructions(location, window=1, item=0, chars=(3, 6))[
            "items"
        ][0]
        self.assertEqual(
            (sliced["text"], sliced["text_offset"], sliced["text_total_chars"]),
            ("def", 3, 8),
        )
        for changed, kwargs in (
            (checkpoint(*history, revision="b" * 32), {}),
            (location, {"roles": {"system"}}),
        ):
            with self.assertRaises(ValueError):
                checkpoint_instructions(changed, window=1, cursor=next_cursor, **kwargs)

    def test_empty_replacement_history_has_empty_page(self):
        result = checkpoint_instructions(checkpoint(), window=3)
        self.assertEqual(result, {"window": 3, "items": [], "next_cursor": None})
