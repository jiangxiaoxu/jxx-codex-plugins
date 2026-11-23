import importlib
import json
import random
import sys
import tempfile
import unittest
from pathlib import Path

SCRIPTS = (
    Path(__file__).resolve().parents[1] / "skills" / "thread-memory" / "scripts"
)
sys.path.insert(0, str(SCRIPTS))

from rollout_source import RolloutDataError, Segment, metadata, records


class RolloutZstandardTest(unittest.TestCase):
    def test_complete_scan_checks_each_frame_end(self):
        try:
            zstd = importlib.import_module("zstandard")
        except ImportError:
            self.skipTest("zstandard package not installed")

        header = b'{"type":"session_meta","payload":{"id":"thread"}}\n'
        payload = {"state": random.Random(0).randbytes(8192).hex()}
        row = json.dumps({"type": "world_state", "payload": payload}).encode() + b"\n"
        compressor = zstd.ZstdCompressor(write_checksum=True)
        first_frame = compressor.compress(header + row[:20])
        second_frame = compressor.compress(row[20:])

        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "rollout.jsonl.zst"
            segment = Segment(path, {})
            path.write_bytes(first_frame + second_frame)
            self.assertEqual(
                [(line, item["payload"]) for _, line, item in records(segment)],
                [(1, {"id": "thread"}), (2, payload)],
            )

            for boundary, content in (
                ("first frame header", first_frame[:2]),
                (
                    "second frame body",
                    first_frame + second_frame[: len(second_frame) // 2],
                ),
                ("second frame checksum", first_frame + second_frame[:-1]),
            ):
                with self.subTest(boundary=boundary):
                    path.write_bytes(content)
                    with self.assertRaisesRegex(
                        RolloutDataError, "truncated Zstandard frame"
                    ) as caught:
                        list(records(segment))
                    self.assertEqual(caught.exception.path, path)

            self.assertEqual(metadata(path), {"id": "thread"})
