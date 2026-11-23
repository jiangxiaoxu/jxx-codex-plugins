import base64
import io
import sys
import unittest
import warnings
from pathlib import Path
from tempfile import TemporaryDirectory
from unittest.mock import patch

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

from rollout_recovery_images import (
    describe_image,
    export_images,
    export_local_images,
    image_parts,
)


@unittest.skipIf(Image is None, "Pillow is required to test image export")
class RolloutImageExportTest(unittest.TestCase):
    def test_large_image_warning_does_not_abort_batch_or_disable_hard_limit(self):
        with TemporaryDirectory() as directory:
            root = Path(directory)
            images = []
            for size in (16, 10):
                source = root / f"{size}.png"
                with Image.new("RGB", (size, 10)) as image:
                    image.save(source)
                images.append({"_source_file": source})

            with patch.object(Image, "MAX_IMAGE_PIXELS", 64), warnings.catch_warnings():
                warnings.simplefilter("error", Image.DecompressionBombWarning)
                export_local_images(images, root / "output", 0.5)

            self.assertIn("export_error", images[0])
            self.assertNotIn("thumbnail_file", images[0])
            self.assertTrue(Path(images[1]["thumbnail_file"]).is_file())

    def test_local_export_preserves_source_and_continues_after_bad_paths(self):
        with TemporaryDirectory() as directory:
            root = Path(directory).resolve()
            source = root / "source.png"
            with Image.new("RGBA", (12, 8), (19, 22, 26, 0)) as image:
                image.save(source)
            corrupt = root / "corrupt.png"
            corrupt.write_bytes(b"not a PNG")
            local_image = {"path": "source.png", "_source_file": source}
            output = root / "output"
            previous = local_image.copy()
            export_local_images([previous], output, 0.5)
            existing = Path(previous["thumbnail_file"])
            existing_bytes = existing.read_bytes()
            candidates = [
                {"path": "missing.png", "_source_file": root / "missing.png"},
                {"path": "corrupt.png", "_source_file": corrupt},
                {"path": "relative.png", "_source_file": None},
                local_image,
            ]
            with Image.new("RGBA", (12, 8), (50, 10, 30, 100)) as image:
                image.save(source)
            source_bytes = source.read_bytes()

            export_local_images(candidates, output, 0.5)

            for item in candidates[:3]:
                self.assertIn("export_error", item)
                self.assertNotIn("thumbnail_file", item)
            result = candidates[3]
            self.assertEqual(result["path"], "source.png")
            self.assertEqual(source.read_bytes(), source_bytes)
            self.assertEqual(existing.read_bytes(), existing_bytes)
            preview = Path(result["thumbnail_file"])
            self.assertNotEqual(preview, existing)
            self.assertEqual(set(output.iterdir()), {existing, preview})
            with Image.open(preview) as thumbnail:
                self.assertEqual(thumbnail.size, (6, 4))
                self.assertEqual(thumbnail.format, "WEBP")
                self.assertEqual(thumbnail.getpixel((0, 0))[-1], 100)

    def test_inline_export_continues_after_invalid_image_in_same_batch(self):
        with TemporaryDirectory() as directory, io.BytesIO() as buffer:
            root = Path(directory).resolve()
            with Image.new("RGB", (9, 6), "orange") as image:
                image.save(buffer, format="PNG")
            original_bytes = buffer.getvalue()
            url = "data:image/png;base64," + base64.b64encode(original_bytes).decode()
            parts = [
                {"type": "input_image", "image_url": "data:image/png;base64,!"},
                {"type": "input_image", "image_url": url},
            ]
            images = [describe_image(part, index) for index, part in enumerate(parts)]
            source = root / "rollout.jsonl"
            row = {"payload": {"type": "message", "content": parts}}

            export_images(
                [{"_source": source, "line": 1, "images": images}],
                root / "output",
                0.5,
                lambda source, lines: [(1, row)],
            )

            self.assertIn("export_error", images[0])
            self.assertEqual(
                Path(images[1]["embedded_file"]).read_bytes(), original_bytes
            )
            with Image.open(images[1]["thumbnail_file"]) as thumbnail:
                self.assertEqual(thumbnail.size, (4, 3))

    def test_local_resolution_limit_uses_oriented_size_and_never_enlarges(self):
        with TemporaryDirectory() as directory:
            root = Path(directory).resolve()
            portrait = root / "portrait.jpg"
            small = root / "small.png"
            orientation = Image.Exif()
            orientation[274] = 6
            with Image.new("RGB", (1200, 900), "blue") as image:
                image.save(portrait, exif=orientation)
            with Image.new("RGB", (16, 8), "red") as image:
                image.save(small)
            images = [
                {"path": file.name, "_source_file": file} for file in (portrait, small)
            ]

            export_local_images(images, root / "output", 1.0, max_resolution=512)

            for item, dimensions in zip(images, ((384, 512), (16, 8))):
                with Image.open(item["thumbnail_file"]) as thumbnail:
                    self.assertEqual(thumbnail.size, dimensions)
            scaled = {"path": portrait.name, "_source_file": portrait}
            export_local_images([scaled], root / "output", 0.25, max_resolution=512)
            with Image.open(scaled["thumbnail_file"]) as thumbnail:
                self.assertEqual(thumbnail.size, (225, 300))

            uncapped = {"path": small.name, "_source_file": small}
            export_local_images(
                [uncapped], root / "output", 0.5, max_resolution=10**400
            )
            self.assertEqual(
                (uncapped["thumbnail_width"], uncapped["thumbnail_height"]), (8, 4)
            )

    def test_export_image_generation_completion_from_raw_base64(self):
        with TemporaryDirectory() as directory, io.BytesIO() as buffer:
            root = Path(directory).resolve()
            with Image.new("RGB", (1600, 900), "orange") as image:
                image.save(buffer, format="PNG")
            original_bytes = buffer.getvalue()
            extension = {
                "type": "Extension",
                "kind": "image_gen.generation",
                "result": base64.b64encode(original_bytes).decode(),
            }
            payload = {"type": "item_completed", "item": extension}
            images = [
                describe_image(part, index)
                for index, part in enumerate(image_parts(payload))
            ]
            row = {"type": "event_msg", "payload": payload}
            self.assertEqual(len(images), 1)

            export_images(
                [{"_source": root / "rollout.jsonl", "line": 1, "images": images}],
                root / "output",
                0.5,
                lambda source, lines: [(1, row)],
                max_resolution=512,
            )

            self.assertEqual(
                Path(images[0]["embedded_file"]).read_bytes(), original_bytes
            )
            with Image.open(images[0]["thumbnail_file"]) as thumbnail:
                self.assertEqual(thumbnail.size, (512, 288))

    def test_image_generation_file_id_takes_precedence_over_result(self):
        parts = image_parts(
            {
                "type": "item_completed",
                "item": {
                    "type": "Extension",
                    "kind": "image_gen.generation",
                    "fileId": "file-example",
                    "result": "aW1hZ2U=",
                },
            }
        )

        self.assertEqual(describe_image(parts[0], 0)["reference"], "file-example")
