import sys
import unittest
from pathlib import Path

sys.path.insert(
    0, str(Path(__file__).parents[1] / "skills" / "thread-memory" / "scripts")
)

from rollout_refs import parse_ref
from rollout_search import read_reference
from rollout_transcript import transcript, verify_transcript_reference

FIRST = Path("first.jsonl")
SECOND = Path("second.jsonl")
TIMESTAMP = "2026-11-21T16:00:00.251Z"


def row(line, kind, payload, *, source=FIRST, metadata=None):
    return (
        source,
        line,
        {
            "type": kind,
            "payload": payload,
            "timestamp": TIMESTAMP,
            "metadata": metadata,
            "_rollout_turn_id": "turn-1",
        },
    )


def message(
    line, *content, source=FIRST, role="user", metadata=None, kinds=None, phase=None
):
    payload = {
        "type": "message",
        "role": role,
        "content": [
            part
            if isinstance(part, dict)
            else {
                "type": "input_text" if role == "user" else "output_text",
                "text": part,
            }
            for part in content
        ],
    }
    if kinds is not None:
        payload["internal_chat_message_metadata_passthrough"] = {
            "content_item_kinds": kinds,
        }
    if phase is not None:
        payload["phase"] = phase
    return row(line, "response_item", payload, source=source, metadata=metadata)


class TranscriptTests(unittest.TestCase):
    def test_chat_reference_expands_the_same_visible_message_with_bounded_text(self):
        exact = message(
            17,
            "Internal wrapper",
            "你好",
            "answer here",
            kinds=["extension.internal", "user.text", "user.text"],
        )
        ref = parse_ref(transcript([exact], max_chars=2)["messages"][0]["ref"])
        expanded = read_reference(exact, ref, max_chars=6, chars=(3, 20))
        self.assertEqual(expanded["text"], "answer")
        self.assertEqual(expanded["text_offset"], 3)
        self.assertEqual(expanded["text_total_chars"], len("你好\nanswer here"))
        exact[2]["payload"]["content"][2]["text"] = "rewritten answer"
        with self.assertRaisesRegex(ValueError, "stale"):
            read_reference(exact, ref)

    def test_chat_filters_compaction_internal_content_and_duplicate_events(self):
        user_text = "查看压缩前记录\n保留换行"
        rows = [
            message(1, "developer policy", role="developer"),
            message(2, "<goal_context>Internal goal</goal_context>"),
            message(3, '<hook_prompt hook_run_id="hook-1">internal</hook_prompt>'),
            row(4, "event_msg", {"type": "user_message", "message": user_text}),
            message(
                5,
                "hidden extension content",
                {"type": "input_image", "image_url": "data:image/png;base64,AAAA"},
                user_text,
                kinds=["extension.internal", "user.image", "user.text"],
            ),
            message(6, "assistant answer", role="assistant"),
            row(
                7, "event_msg", {"type": "agent_message", "message": "assistant answer"}
            ),
            message(8, "copied history", metadata={"inherited_user_message": True}),
            message(
                9, "summary", role="assistant", metadata={"compaction_output": True}
            ),
            row(10, "compacted", {"replacement_history": ["assistant answer"]}),
            message(11, "<skill>example quoted as source</skill>", kinds=["user.text"]),
        ]
        result = transcript(iter(rows))
        self.assertEqual(
            [(hit["line"], hit["role"], hit["text"]) for hit in result["messages"]],
            [
                (5, "user", user_text),
                (6, "assistant", "assistant answer"),
                (11, "user", "<skill>example quoted as source</skill>"),
            ],
        )
        self.assertEqual(result["messages"][0]["image_count"], 1)
        self.assertEqual(result["messages"][0]["timestamp"], TIMESTAMP)
        self.assertEqual(result["messages"][0]["turn_id"], "turn-1")

    def test_explicit_user_text_wins_over_legacy_context_heuristics(self):
        quotes = (
            "# AGENTS.md instructions\n  Review this heading.",
            "<environment_context>Example syntax</environment_context>",
            "Another language model started to solve this problem. Is this a summary?",
        )
        rows = [
            message(1, *quotes),
            message(2, *quotes, kinds=["unknown"] * len(quotes)),
            message(3, *quotes, kinds=["user.text"] * len(quotes)),
        ]
        self.assertEqual(
            [(hit["line"], hit["text"]) for hit in transcript(rows)["messages"]],
            [(3, "\n".join(quotes))],
        )

    def test_async_chat_events_are_included_without_ordinary_event_mirrors(self):
        question = "选择一个选项\n- 继续\n- 结束"
        item = {
            "type": "AgentMessage",
            "content": [{"type": "Text", "text": question}],
            "phase": "final_answer",
        }
        async_item = {**item, "delivery": "async"}
        rows = [
            row(1, "event_msg", {"type": "item_started", "item": async_item}),
            row(2, "event_msg", {"type": "item_completed", "item": async_item}),
            row(3, "event_msg", {"type": "item_completed", "item": item}),
            row(
                4,
                "event_msg",
                {"type": "agent_message", "message": "通知", "delivery": "async"},
            ),
        ]
        result = transcript(rows, roles=["assistant"])
        self.assertEqual(
            [(hit["line"], hit["text"], hit["delivery"]) for hit in result["messages"]],
            [(2, question, "async"), (4, "通知", "async")],
        )
        self.assertEqual(transcript(rows, roles=["user"])["messages"], [])

    def test_audio_only_chat_keeps_visible_reference_positions(self):
        visible_audio = {
            "type": "input_audio",
            "audio_url": "data:audio/wav;base64,QQ==",
        }
        exact = message(
            2,
            {"type": "input_image", "image_url": "internal.png"},
            visible_audio,
            kinds=["extension.internal", "user.audio"],
        )
        preview = transcript([exact])["messages"][0]
        self.assertEqual(preview["text"], "")
        self.assertEqual(preview["audio_count"], 1)
        self.assertNotIn("image_count", preview)
        ref = parse_ref(preview["ref"])
        self.assertEqual(verify_transcript_reference(exact, ref)[1], (1,))
        visible_audio["audio_url"] = "data:audio/wav;base64,Qg=="
        with self.assertRaisesRegex(ValueError, "stale"):
            verify_transcript_reference(exact, ref)

    def test_latest_final_replies_stay_ordered_and_respect_character_budget(self):
        rows = [
            message(3, "initial final", role="assistant", phase="final_answer"),
            message(4, "mid-turn", role="assistant", phase="commentary"),
            message(5, "user request"),
            message(6, "partial body", role="assistant", phase="partial_answer"),
            message(7, "abcd", role="assistant", phase="final_answer"),
            message(2, "ef", source=SECOND, role="assistant", phase="final_answer"),
            message(3, "legacy unknown", source=SECOND, role="assistant"),
        ]
        result = transcript(iter(rows), phase="final", last=3, budget_chars=6)
        messages = result["messages"]
        self.assertEqual(
            [(hit["path"], hit["line"], hit["text"]) for hit in messages],
            [(str(FIRST), 7, "abcd"), (str(SECOND), 2, "ef")],
        )
        self.assertIsNone(result["next_cursor"])
        ref = parse_ref(messages[0]["ref"])
        self.assertEqual(read_reference(rows[4], ref)["text"], "abcd")
        self.assertEqual(
            [
                hit["line"]
                for hit in transcript(rows, last=2, roles=["assistant"])["messages"]
            ],
            [2, 3],
        )

    def test_phase_applies_before_forward_page_limits(self):
        rows = [
            message(1, "unknown", role="assistant"),
            message(2, "partial", role="assistant", phase="partial_answer"),
            message(3, "first update", role="assistant", phase="commentary"),
            message(4, "user request"),
            message(5, "second update", role="assistant", phase="commentary"),
        ]
        first = transcript(rows, phase="commentary", limit=1)
        self.assertEqual([hit["line"] for hit in first["messages"]], [3])
        second = transcript(
            rows, phase="commentary", limit=1, cursor=first["next_cursor"]
        )
        self.assertEqual([hit["line"] for hit in second["messages"]], [5])
        self.assertIsNone(second["next_cursor"])

    def test_cursor_resumes_exclusively_across_segments_and_role_filter(self):
        rows = [
            message(9, "前缀\n超长文字"),
            message(10, "filtered", role="assistant"),
            message(
                2, {"type": "input_image", "image_url": "local.png"}, source=SECOND
            ),
        ]
        page = transcript(iter(rows), roles=["user"], limit=1, max_chars=3)
        self.assertEqual(page["messages"][0]["text"], "前缀\n")
        self.assertEqual(page["messages"][0]["omitted_chars"], 4)
        self.assertLessEqual(len(page["next_cursor"]), 24)

        next_page = transcript(
            iter(rows), roles=["user"], limit=1, cursor=page["next_cursor"]
        )
        self.assertEqual(
            [
                (hit["path"], hit["line"], hit["text"], hit["image_count"])
                for hit in next_page["messages"]
            ],
            [(str(SECOND), 2, "", 1)],
        )
        self.assertIsNone(next_page["next_cursor"])
        with self.assertRaises(ValueError):
            transcript(iter(rows[1:]), cursor=page["next_cursor"])

    def test_character_budget_defers_the_next_message_and_caps_long_previews(self):
        rows = [
            message(2, "四个字符"),
            message(3, "下一个预览"),
            message(4, "长度大于整页预算"),
            message(5, "最后"),
        ]
        cursor = None
        pages = []
        for _ in rows:
            page = transcript(rows, budget_chars=7, cursor=cursor)
            pages.append(page["messages"])
            cursor = page["next_cursor"]
            self.assertLessEqual(sum(len(message["text"]) for message in pages[-1]), 7)
        self.assertEqual(
            [[(hit["line"], hit["text"]) for hit in page] for page in pages],
            [
                [(2, "四个字符")],
                [(3, "下一个预览")],
                [(4, "长度大于整页预")],
                [(5, "最后")],
            ],
        )
        self.assertEqual(pages[2][0]["omitted_chars"], 1)
        self.assertIsNone(cursor)


if __name__ == "__main__":
    unittest.main()
