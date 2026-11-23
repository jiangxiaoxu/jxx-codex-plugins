import base64
import io
import json
import sys
import unittest
from copy import deepcopy
from pathlib import Path
from tempfile import TemporaryDirectory

try:
    from PIL import Image
except ImportError:
    Image = None

sys.path.insert(
    0,
    str(
        Path(__file__).resolve().parents[1] / "skills" / "thread-memory" / "scripts"
    ),
)

from rollout_media import (
    attachment_catalog,
    audio_target_lines,
    catalog,
    export_audio,
    export_selected,
    image_target_lines,
)
from rollout_refs import parse_ref
from rollout_search import reference_image_scope
from rollout_transcript import transcript


class RolloutMediaTest(unittest.TestCase):
    @unittest.skipIf(Image is None, "Pillow is required to test image export")
    def test_chat_ref_lists_only_visible_attachments_with_exportable_ids(self):
        with TemporaryDirectory() as directory, io.BytesIO() as buffer:
            root = Path(directory)
            with Image.new("RGB", (2, 1), "orange") as original:
                original.save(buffer, format="PNG")
            data = base64.b64encode(buffer.getvalue()).decode("ascii")
            row = (
                root / "rollout.jsonl",
                4,
                {
                    "type": "response_item",
                    "payload": {
                        "type": "message",
                        "role": "user",
                        "internal_chat_message_metadata_passthrough": {
                            "content_item_kinds": ["internal.image", "user.image"],
                        },
                        "content": [
                            {
                                "type": "input_image",
                                "image_url": "data:image/png;base64,aW50ZXJuYWw=",
                            },
                            {
                                "type": "input_image",
                                "image_url": f"data:image/png;base64,{data}",
                            },
                        ],
                    },
                },
            )
            message = transcript([row])["messages"][0]
            scoped = reference_image_scope(row, parse_ref(message["ref"]))
            visible = catalog([scoped])["images"]
            self.assertEqual(visible, catalog([row])["images"][1:])
            [image] = visible
            self.assertEqual(image["part"], 1)

            exported = export_selected([row], [image["image_id"]], output_dir=root)
            self.assertEqual(exported["unknown_ids"], [])
            [saved] = exported["images"]
            self.assertEqual(
                Path(saved["embedded_file"]).read_bytes(), buffer.getvalue()
            )

    def test_catalog_pages_keep_checkpoints_and_sources_distinct(self):
        prefix = "data:image/png;base64,"
        inline = prefix + "aW1hZ2U="
        image_part = {"type": "input_image", "image_url": inline}
        checkpoint = {
            "type": "compacted",
            "timestamp": "2026-11-22T01:00:00Z",
            "_rollout_turn_id": "compact-turn",
            "_rollout_provenance": {"thread_id": "child-thread", "origin": "current"},
            "payload": {
                "replacement_history": [
                    {"type": "message", "content": [image_part, image_part]},
                    {"type": "function_call_output", "output": [image_part]},
                ]
            },
        }
        legacy = {
            "type": "event_msg",
            "payload": {"type": "user_message", "images": [inline]},
        }
        left = Path("left/same.jsonl")
        right = Path("right/same.jsonl")
        rows = [(left, 4, checkpoint), (right, 4, legacy)]

        first = catalog(rows, kind="inline", limit=2)
        second = catalog(rows, cursor=first["next_cursor"], kind="inline", limit=2)
        images = first["images"] + second["images"]
        self.assertEqual(
            [image.get("checkpoint_item") for image in images], [0, 0, 1, None]
        )
        self.assertEqual(images[2]["timestamp"], checkpoint["timestamp"])
        self.assertEqual(images[2]["turn_id"], "compact-turn")
        self.assertEqual(images[2]["thread_id"], "child-thread")
        self.assertEqual(images[2]["origin"], "current")
        self.assertEqual(len({image["image_id"] for image in images}), 4)
        self.assertEqual(images, catalog(rows)["images"])
        self.assertEqual(
            image_target_lines([left, right], [images[-1]["image_id"]]), {right: {4}}
        )
        self.assertNotIn(prefix, json.dumps(images))
        self.assertIsNone(second["next_cursor"])

    @unittest.skipIf(Image is None, "Pillow is required to test image export")
    def test_dynamic_tool_images_can_be_exported_from_role_filtered_catalog(self):
        with TemporaryDirectory() as directory, io.BytesIO() as buffer:
            root = Path(directory)
            with Image.new("RGB", (3, 2), "orange") as original:
                original.save(buffer, format="PNG")
            data = base64.b64encode(buffer.getvalue()).decode("ascii")
            source = root / "rollout.jsonl"
            rows = [
                (
                    source,
                    2,
                    {
                        "type": "event_msg",
                        "payload": {
                            "type": "item_completed",
                            "item": {
                                "type": "DynamicToolCall",
                                "content_items": [
                                    {"type": "inputText", "text": "caption"},
                                    {
                                        "type": "inputImage",
                                        "imageUrl": f"data:image/png;base64,{data}",
                                    },
                                ],
                            },
                        },
                    },
                ),
                (
                    source,
                    3,
                    {
                        "type": "event_msg",
                        "payload": {
                            "type": "user_message",
                            "images": ["data:image/png;base64,eA=="],
                        },
                    },
                ),
            ]
            page = catalog(rows, limit=1, roles=["tool"])
            self.assertIsNone(page["next_cursor"])
            [image] = page["images"]
            self.assertEqual((image["role"], image["part"]), ("tool", 1))
            [attachment] = attachment_catalog(rows, roles=["tool"])["attachments"]
            identifier = image["image_id"]
            self.assertEqual(attachment["attachment_id"], identifier)
            report = export_selected(rows, [identifier], output_dir=root)
            [saved] = report["images"]
            self.assertEqual(
                Path(saved["embedded_file"]).read_bytes(), buffer.getvalue()
            )

    def test_audio_catalog_pages_preserve_roles_and_do_not_expand_media(self):
        source = Path("mixed.jsonl")
        cwd = Path.cwd()
        audio = "data:audio/wav;base64,c2hvcnQ="
        rows = [
            (
                source,
                2,
                {
                    "type": "event_msg",
                    "_rollout_cwd": str(cwd),
                    "payload": {
                        "type": "user_message",
                        "audio": [audio],
                        "audio_references": [{"file_id": "file-audio"}],
                        "audio_order": ["file", "inline"],
                        "local_audio": ["voice.wav"],
                    },
                },
            ),
            (
                source,
                3,
                {
                    "type": "response_item",
                    "payload": {
                        "type": "message",
                        "role": "user",
                        "content": [
                            {"type": "input_audio", "audio_url": audio},
                        ],
                    },
                },
            ),
            (
                source,
                4,
                {
                    "type": "event_msg",
                    "payload": {
                        "type": "item_completed",
                        "item": {
                            "type": "DynamicToolCall",
                            "content_items": [
                                {"type": "inputAudio", "audioUrl": audio},
                            ],
                        },
                    },
                },
            ),
        ]
        first = attachment_catalog(rows, media="audio", roles=["user"], limit=2)
        second = attachment_catalog(
            rows, media="audio", roles=["user"], limit=2, cursor=first["next_cursor"]
        )
        items = first["attachments"] + second["attachments"]
        self.assertEqual([item["line"] for item in items], [2, 2, 2, 3])
        self.assertEqual(
            [item["availability"] for item in items],
            ["reference", "embedded", "local", "embedded"],
        )
        self.assertEqual(items[0]["reference"], "file-audio")
        self.assertEqual(items[1]["media_type"], "audio/wav")
        self.assertEqual(Path(items[2]["resolved_path"]), cwd / "voice.wav")
        self.assertEqual(len({item["attachment_id"] for item in items}), len(items))
        self.assertNotIn(audio, json.dumps(items))
        self.assertIsNone(second["next_cursor"])
        [tool_audio] = attachment_catalog(rows, media="audio", roles=["tool"])[
            "attachments"
        ]
        self.assertEqual(
            (tool_audio["line"], tool_audio["media_type"]), (4, "audio/wav")
        )
        self.assertEqual(catalog(rows)["images"], [])

    def test_completed_function_outputs_include_both_media_types(self):
        row = (
            Path("call.jsonl"),
            12,
            {
                "type": "event_msg",
                "payload": {
                    "type": "item_completed",
                    "item": {
                        "type": "FunctionCallOutput",
                        "output": [
                            {"type": "input_text", "text": "caption"},
                            {"type": "input_audio", "file_id": "audio-file"},
                            {"type": "input_image", "file_id": "image-file"},
                        ],
                    },
                },
            },
        )
        attachments = attachment_catalog([row], roles=["tool"])["attachments"]
        self.assertEqual(
            [(item["media"], item["part"]) for item in attachments],
            [("audio", 1), ("image", 2)],
        )
        [image] = catalog([row], roles=["tool"])["images"]
        self.assertEqual(image["image_id"], attachments[-1]["attachment_id"])

    def test_audio_export_checks_ids_and_writes_only_valid_inline_payloads(self):
        with TemporaryDirectory() as directory:
            root = Path(directory).resolve()
            source = root / "rollout.jsonl"
            original = root / "original.wav"
            original.write_bytes(b"audio at source")
            content = bytes(range(256)) * 205
            encoded = base64.b64encode(content).decode("ascii")
            rows = [
                (
                    source,
                    4,
                    {
                        "type": "event_msg",
                        "_rollout_cwd": str(root),
                        "payload": {
                            "type": "item_completed",
                            "item": {
                                "type": "UserMessage",
                                "content": [
                                    {
                                        "type": "audio",
                                        "audio_url": f"data:audio/wav;base64,{encoded}",
                                    },
                                    {
                                        "type": "audio",
                                        "audio_url": f"data:audio/wav;base64,{encoded}#",
                                    },
                                    {"type": "audio", "file_id": "audio-file-opaque"},
                                    {"type": "local_audio", "path": original.name},
                                ],
                            },
                        },
                    },
                )
            ]
            page = attachment_catalog(rows, media="audio")
            ids = [item["attachment_id"] for item in page["attachments"]]
            self.assertEqual(audio_target_lines([source], ids), {source: {4}})
            report = export_audio(
                rows,
                [ids[1], ids[3], ids[0], ids[2], "unknown"],
                output_dir=root / "out",
            )
            invalid, local, embedded, opaque = report["attachments"]
            self.assertIn("export_error", invalid)
            self.assertIn("export_error", opaque)
            self.assertEqual(report["unknown_ids"], ["unknown"])
            self.assertEqual(Path(local["audio_file"]), original)
            embedded_path = Path(embedded["audio_file"])
            self.assertEqual(embedded_path.read_bytes(), content)
            self.assertEqual(list((root / "out").iterdir()), [embedded_path])
            self.assertNotIn(encoded, json.dumps(report))

    def test_rewritten_locators_never_export_a_different_image(self):
        with TemporaryDirectory() as directory:
            root = Path(directory)
            path = root / "rollout.jsonl"
            payload = {
                "type": "user_message",
                "message": "Original text",
                "images": ["data:image/png;base64,b2xk"],
                "local_images": ["reference.png"],
                "file_ids": ["file-original"],
            }
            recorded = {
                "type": "event_msg",
                "_rollout_cwd": str(root / "old"),
                "payload": payload,
            }
            original = catalog([(path, 4, recorded)])["images"]
            ids = [image["image_id"] for image in original]
            payload["message"] = "Rewritten text"
            self.assertEqual(catalog([(path, 4, recorded)])["images"], original)

            rewritten = deepcopy(recorded)
            rewritten["payload"]["images"] = ["data:image/png;base64,bmV3"]
            rewritten["payload"]["file_ids"] = ["file-replacement"]
            rewritten["_rollout_cwd"] = str(root / "new")
            legacy_id = ids[0].rsplit(":", 1)[0]
            report = export_selected(
                [(path, 4, rewritten)], [*ids, legacy_id], output_dir=root / "out"
            )

            self.assertEqual(report, {"images": [], "unknown_ids": [*ids, legacy_id]})
            self.assertFalse((root / "out").exists())

    @unittest.skipIf(Image is None, "Pillow is required to test image export")
    def test_export_uses_only_the_requested_sources_and_parts(self):
        with TemporaryDirectory() as directory, io.BytesIO() as buffer:
            root = Path(directory).resolve()
            with Image.new("RGB", (800, 400), "orange") as original:
                original.save(buffer, format="PNG")
                original.save(root / "available.png")
            png = buffer.getvalue()
            data = base64.b64encode(png).decode("ascii")
            call = {
                "type": "event_msg",
                "payload": {
                    "type": "mcp_tool_call_end",
                    "result": {
                        "Ok": {
                            "content": [
                                {"type": "image", "data": "!", "mimeType": "image/png"},
                                {
                                    "type": "image",
                                    "data": data,
                                    "mimeType": "image/png",
                                },
                            ]
                        }
                    },
                },
            }
            attachments = {
                "type": "event_msg",
                "_rollout_cwd": str(root),
                "payload": {
                    "type": "user_message",
                    "local_images": ["missing.png", "available.png"],
                    "file_ids": ["file-opaque"],
                },
            }
            rows = [(root / "a.jsonl", 12, call), (root / "b.jsonl", 12, attachments)]
            images = catalog(rows)["images"]
            ids = [image["image_id"] for image in images]
            request = [ids[4], ids[1], ids[2], "unknown-id"]
            report = export_selected(rows, request, output_dir=root / "out")

            self.assertEqual(report["unknown_ids"], [request[-1]])
            self.assertEqual(
                [image["image_id"] for image in report["images"]], request[:3]
            )
            local, inline, opaque = report["images"]
            self.assertEqual(Path(local["resolved_path"]), root / "available.png")
            self.assertEqual(Path(inline["embedded_file"]).read_bytes(), png)
            self.assertIn("export_error", opaque)
            self.assertNotIn("thumbnail_width", opaque)
            self.assertNotIn("thumbnail_height", opaque)
            for result in (local, inline):
                with Image.open(result["thumbnail_file"]) as thumbnail:
                    self.assertEqual(thumbnail.size, (512, 256))
                    self.assertEqual(
                        (result["thumbnail_width"], result["thumbnail_height"]),
                        thumbnail.size,
                    )
            self.assertEqual(len(list((root / "out").iterdir())), 3)
            self.assertNotIn(data, json.dumps(report))
