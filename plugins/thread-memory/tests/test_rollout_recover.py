import json
import subprocess
import sys
import unittest
from pathlib import Path
from tempfile import TemporaryDirectory

SCRIPTS = Path(__file__).resolve().parents[1] / "skills" / "thread-memory" / "scripts"
sys.path.insert(0, str(SCRIPTS))
from rollout_recover import recover


def row(source, line, kind, payload, **record_fields):
    return source, line, {"type": kind, "payload": payload, **record_fields}


def message(text, *, role="user", images=()):
    return {
        "type": "message",
        "role": role,
        "content": [{"type": "input_text", "text": text}, *images],
    }


class RecoveryTests(unittest.TestCase):
    def test_salvage_recovers_candidates_with_an_invalid_inline_image(self):
        invalid_image = {
            "type": "input_image",
            "image_url": "data:image/png;base64,Y\ud800Q==",
        }
        records = [
            {"type": "session_meta", "payload": {"id": "fixture"}},
            {
                "type": "response_item",
                "payload": message("earlier", images=[invalid_image]),
            },
            {"type": "compacted", "payload": {"replacement_history": []}},
        ]
        with TemporaryDirectory() as directory:
            source = Path(directory) / "rollout.jsonl"
            source.write_text(
                "".join(json.dumps(record) + "\n" for record in records),
                encoding="utf-8",
            )
            process = subprocess.run(
                [
                    sys.executable,
                    "-B",
                    str(SCRIPTS / "rollout.py"),
                    "recover",
                    "--rollout",
                    str(source),
                    "--salvage",
                    "--export-images",
                    str(Path(directory) / "images"),
                ],
                capture_output=True,
                check=False,
            )
        self.assertEqual(process.returncode, 0, process.stderr.decode("utf-8"))
        report = json.loads(process.stdout)
        self.assertEqual(report["messages"][0]["text"], "earlier")
        self.assertEqual(report["image_candidate_count"], 1)
        image = report["image_records"][0]["images"][0]
        self.assertIn("Invalid Base64 image payload", image["export_error"])

    def test_replacement_excerpts_across_segments(self):
        ancestor = Path("base.jsonl")
        source = Path("live.jsonl")
        preserved = message("kept")
        rows = [
            row(ancestor, 1, "session_meta", {}),
            row(ancestor, 2, "response_item", message("history")),
            row(source, 1, "session_meta", {}),
            row(source, 2, "response_item", preserved),
            row(
                source, 3, "response_item", message("# AGENTS.md instructions\nignored")
            ),
            row(
                source,
                4,
                "compacted",
                {"window_number": 1, "replacement_history": [preserved]},
            ),
            row(source, 5, "response_item", message("second checkpoint")),
            row(
                source,
                6,
                "compacted",
                {"replacement_history": [preserved]},
            ),
        ]

        report = recover(rows, source, window=1)
        self.assertEqual(
            [entry["window_number"] for entry in report["checkpoints"]], [1, 2]
        )
        self.assertEqual(
            report["messages"],
            [{"rollout": ancestor.name, "line": 2, "role": "user", "text": "history"}],
        )
        self.assertEqual(
            recover(rows, source, window=2)["messages"][0]["text"], "second checkpoint"
        )

    def test_rollback_invalidates_default_recovery_checkpoint(self):
        source = Path("live.jsonl")
        rows = [
            row(source, 1, "session_meta", {}),
            row(source, 2, "response_item", message("original")),
            row(
                source, 3, "compacted", {"window_number": 1, "replacement_history": []}
            ),
        ]
        rows.append(
            row(source, 5, "event_msg", {"type": "thread_rolled_back", "num_turns": 1})
        )
        invalidated = recover(rows, source)
        self.assertEqual(invalidated["status"], "rollback_after_checkpoint")
        self.assertEqual(invalidated["messages"], [])

    def test_redacts_text_data_url_without_collapsing_distinct_history(self):
        source = Path("live.jsonl")
        first = "preview data:image/png;name=sample.png;base64,YQ== finished"
        second = "preview data:image/png;name=sample.png;base64,Yg== finished"
        rows = [
            row(source, 1, "response_item", message(first)),
            row(source, 2, "compacted", {"replacement_history": [message(second)]}),
        ]
        report = recover(rows, source)
        self.assertEqual(
            report["messages"][0]["text"], "preview [data URL omitted] finished"
        )

    def test_structured_image_paths_deduplicate_and_respect_retained_images(self):
        source = Path("live.jsonl")
        with TemporaryDirectory() as directory:
            root = Path(directory)
            viewed = root / "viewed image.png"
            viewed_only = root / "viewed only.png"
            retained = root / "kept.png"
            generated = root / "generated.png"
            rows = [
                row(
                    source,
                    1,
                    "event_msg",
                    {"type": "view_image_tool_call", "path": viewed.as_uri()},
                ),
                row(
                    source,
                    2,
                    "event_msg",
                    {"type": "view_image_tool_call", "path": retained.as_uri()},
                ),
                row(
                    source,
                    3,
                    "event_msg",
                    {
                        "type": "item_completed",
                        "item": {
                            "type": "ImageGeneration",
                            "saved_path": str(generated),
                        },
                    },
                ),
                row(
                    source,
                    4,
                    "event_msg",
                    {
                        "type": "item_completed",
                        "item": {
                            "type": "ImageView",
                            "path": viewed_only.as_uri(),
                        },
                    },
                ),
                row(
                    source,
                    5,
                    "response_item",
                    message(
                        "seen",
                        images=[
                            {"type": "input_image", "image_url": str(viewed)},
                            {"type": "input_image", "image_url": str(retained)},
                            {
                                "type": "input_image",
                                "image_url": "https://example.com/image.png",
                            },
                        ],
                    ),
                ),
                row(
                    source,
                    6,
                    "compacted",
                    {
                        "replacement_history": [
                            message(
                                "kept",
                                images=[
                                    {
                                        "type": "input_image",
                                        "image_url": retained.as_uri(),
                                    },
                                ],
                            )
                        ]
                    },
                ),
            ]
            report = recover(rows, source, max_images=4)
            self.assertEqual(report["local_image_candidate_count"], 3)
            self.assertEqual(
                {record["resolved_path"] for record in report["local_images"]},
                {str(viewed), str(viewed_only), str(generated)},
            )
            self.assertEqual(
                report["image_records"][0]["images"],
                [
                    {"part": 3, "reference": "https://example.com/image.png"},
                ],
            )
            json.dumps(report)

    def test_paginated_generation_recovers_inline_and_referenced_images(self):
        source = Path("live.jsonl")
        encoded = (
            "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8"
            "/x8AAwMCAO+Xv1sAAAAASUVORK5CYII="
        )
        with TemporaryDirectory() as directory:
            root = Path(directory)
            saved = root / "generated.png"
            reference = root / "source.png"
            generation = {
                "type": "Extension",
                "kind": "image_gen.generation",
                "status": "completed",
                "result": encoded,
                "savedPath": str(saved),
                "inputImages": [{"path": reference.as_uri()}],
            }
            rows = [
                row(
                    source,
                    1,
                    "event_msg",
                    {"type": "item_completed", "item": generation},
                ),
                row(
                    source,
                    2,
                    "event_msg",
                    {
                        "type": "item_completed",
                        "item": {
                            **generation,
                            "kind": "another.extension",
                            "savedPath": str(root / "ignored.png"),
                        },
                    },
                ),
                row(source, 3, "compacted", {"replacement_history": []}),
            ]
            report = recover(rows, source, max_images=3)
            self.assertEqual(report["image_candidate_count"], 1)
            self.assertEqual(report["image_records"][0]["line"], 1)
            self.assertIn("data_url_sha256", report["image_records"][0]["images"][0])
            self.assertEqual(
                {record["resolved_path"] for record in report["local_images"]},
                {str(saved), str(reference)},
            )
            self.assertNotIn(encoded, json.dumps(report))

    def test_mixed_images_share_limit_without_returning_base64(self):
        source = Path("live.jsonl")
        images = [
            {"type": "input_image", "image_url": f"data:image/png;base64,{encoded}"}
            for encoded in ("YQ==", "Yg==")
        ]
        images.append({"type": "input_image", "file_id": "file-opaque"})
        with TemporaryDirectory() as directory:
            cwd = Path(directory)
            rows = [
                row(source, 1, "session_meta", {"cwd": str(cwd)}),
                row(source, 2, "response_item", message("images", images=images)),
                row(
                    source,
                    3,
                    "event_msg",
                    {"type": "user_message", "local_images": ["photo.png"]},
                ),
                row(
                    source,
                    4,
                    "event_msg",
                    {
                        "type": "item_completed",
                        "item": {
                            "type": "UserMessage",
                            "content": [
                                {"type": "local_image", "path": str(cwd / "photo.png")}
                            ],
                        },
                    },
                ),
                row(
                    source,
                    5,
                    "compacted",
                    {"window_number": 1, "replacement_history": []},
                ),
            ]

            report = recover(rows, source, max_images=2)
            self.assertEqual(report["image_candidate_count"], 3)
            self.assertEqual(report["local_image_candidate_count"], 1)
            self.assertEqual(len(report["image_records"][0]["images"]), 1)
            self.assertIn("data_url_sha256", report["image_records"][0]["images"][0])
            self.assertEqual(
                report["local_images"],
                [
                    {
                        "rollout": source.name,
                        "line": 4,
                        "path": str(cwd / "photo.png"),
                        "resolved_path": str(cwd / "photo.png"),
                    }
                ],
            )
            self.assertNotIn("data:image/", json.dumps(report))


if __name__ == "__main__":
    unittest.main()
