import base64
import json
import os
import struct
import subprocess
import tempfile
import unittest
import zlib
from pathlib import Path

from test_native_memory_cli import NATIVE_CLI, PYTHON_CLI


THREAD = "00000000-0000-4000-8000-000000000026"
START = "2026-01-01T00:00:00Z"


def row(kind, payload, timestamp=START):
    return json.dumps({"type": kind, "timestamp": timestamp, "payload": payload},
                      ensure_ascii=False).encode("utf-8") + b"\n"


def message(role, text, timestamp=START, *, parts=(), **metadata):
    part_type = "input_text" if role == "user" else "output_text"
    return row("response_item", {
        "type": "message", "role": role, **metadata,
        "content": [{"type": part_type, "text": text}, *parts],
    }, timestamp)


def png(width, height):
    def chunk(kind, data):
        return (struct.pack(">I", len(data)) + kind + data
                + struct.pack(">I", zlib.crc32(kind + data)))

    return (b"\x89PNG\r\n\x1a\n"
            + chunk(b"IHDR", struct.pack(">IIBBBBB", width, height, 8, 2, 0, 0, 0))
            + chunk(b"IDAT", zlib.compress((b"\0" + b"\xff\x99\0" * width) * height))
            + chunk(b"IEND", b""))


class NativeRolloutCLITest(unittest.TestCase):
    def setUp(self):
        temp = tempfile.TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        self.home = Path(temp.name)
        self.rollout = self.home / "sessions" / f"rollout-2026-01-01T00-00-00-{THREAD}.jsonl"
        self.rollout.parent.mkdir()
        self.header = row("session_meta", {"id": THREAD, "cwd": str(self.home)})
        self.env = {**os.environ, "CODEX_HOME": str(self.home), "CODEX_SQLITE_HOME": str(self.home),
                    "CODEX_THREAD_ID": THREAD}

    def seed(self, *rows):
        self.rollout.write_bytes(self.header + b"".join(rows))

    def run_cli(self, command, *options, stdin="", cli=None):
        cli = NATIVE_CLI if cli is None else cli
        return subprocess.run(
            [*cli, command, "--rollout", str(self.rollout), *options],
            input=stdin.encode("utf-8"), capture_output=True, env=self.env, timeout=15,
        )

    def query(self, command, *options, stdin="", cli=None):
        result = self.run_cli(command, *options, stdin=stdin, cli=cli)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(result.stderr, b"")
        return json.loads(result.stdout.decode("utf-8"))

    def test_scoped_search_ref_and_explicit_tool_selectors(self):
        self.seed(
            row("response_item", {"type": "function_call", "name": "exec_command",
                                  "call_id": "call-old", "arguments": "{}"}),
            row("response_item", {"type": "function_call_output", "call_id": "call-old",
                                  "output": "result from the previous window"}),
            row("compacted", {"window_number": 1, "replacement_history": []},
                "2026-01-01T00:01:00Z"),
            row("response_item", {
                "type": "function_call", "name": "exec_command", "call_id": "call-new",
                "arguments": '{"cmd":"private-argument","nested":[true,"\u6821\u9a8c",3],"\\ud800":"legacy key"}',
            }, "2026-01-01T00:02:00Z"),
            b"\n",
            row("event_msg", {"type": "token_count", "turn_id": "other-turn"},
                "2026-01-01T00:02:00Z"),
            row("response_item", {
                "type": "function_call_output", "call_id": "call-new",
                "output": "private-result\n\u8f93\u51fa \U0001f680\nlast line",
            }, "2026-01-01T00:02:01Z"),
        )
        scope = ("call-new", "--tool", "exec_command", "--window", "current",
                 "--since", "2026-01-01T08:02:00+08:00", "--until", "2026-01-01T00:03:00Z")
        for cli in (PYTHON_CLI, NATIVE_CLI):
            with self.subTest(cli=cli[0]):
                page = self.query("search", *scope, cli=cli)
                call, result = page["items"]
                self.assertEqual([item["line"] for item in (call, result)], [5, 8])
                for item, key, secret in (
                    (call, "input_id", "private-argument"),
                    (result, "output_id", "private-result"),
                ):
                    self.assertNotIn(secret, json.dumps(item))
                    (detail,) = self.query("read", "--ref", "-", cli=cli,
                                           stdin=item["ref"] + "\r\n")["items"]
                    self.assertEqual(detail[key], item[key])
                    self.assertNotIn(secret, json.dumps(detail))

                value = self.query("tool-input", "--id", "-", "--pointer", "/arguments/nested",
                                   cli=cli, stdin=call["input_id"] + "\n")
                self.assertEqual(value["value"], [True, "\u6821\u9a8c", 3])
                root = self.query("tool-input", "--id", call["input_id"], "--pointer", "", cli=cli)
                self.assertEqual(root["value"]["arguments"]["\ufffd"], "legacy key")
                output = self.query("tool-output", "--id", "-", "--lines", "2:2", cli=cli,
                                    stdin=result["output_id"] + "\n")
                self.assertEqual([item["text"] for item in output["items"]], ["\u8f93\u51fa \U0001f680\n"])
                self.assertIsNone(output["next_cursor"])

    def test_transcript_pages_after_damage_and_reports_exact_physical_lines(self):
        first = message("user", "\u95ee\u9898")
        broken = b'{"type":"response_item","payload":{\n'
        answer = message("assistant", "\u56de\u7b54 \U0001f680", phase="final_answer")
        self.seed(first, broken, message("assistant", "progress", phase="commentary"),
                  answer, b'{"type":')

        strict = self.run_cli("transcript")
        self.assertEqual(strict.returncode, 1, strict.stderr)
        self.assertEqual(strict.stdout, b"")
        diagnostic = json.loads(strict.stderr.decode("utf-8"))["error"]
        self.assertEqual((diagnostic["code"], diagnostic["line"]), ("invalid_rollout", 3))

        first_page = self.query("transcript", "--salvage", "--limit", "2")
        self.assertTrue(first_page["next_cursor"])
        second_page = self.query("transcript", "--salvage", "--limit", "2", "--cursor", "-",
                                 stdin=first_page["next_cursor"] + "\n")
        self.assertIsNone(second_page["next_cursor"])
        actual = [(item["line"], item["role"], item["text"])
                  for item in first_page["items"] + second_page["items"]]
        self.assertEqual(actual, [(2, "user", "\u95ee\u9898"), (4, "assistant", "progress"),
                                  (5, "assistant", "\u56de\u7b54 \U0001f680")])
        self.assertEqual([(entry["line"], entry["reason"])
                          for entry in second_page["damaged_records"]["items"]],
                         [(3, "invalid_json"), (6, "partial_tail")])
        self.assertEqual(second_page["damaged_records"]["items"][0]["byte_offset"],
                         len(self.header) + len(first))

        last = self.query("transcript", "--salvage", "--last", "1", "--phase", "final")
        (message_item,) = last["items"]
        self.assertEqual((message_item["line"], message_item["text"]), (5, actual[-1][2]))
        (record,) = self.query("read", "--salvage", "--ref", "-",
                               stdin=message_item["ref"] + "\n")["items"]
        self.assertEqual(record["fields"][0]["text"], actual[-1][2])

    def test_selected_inline_and_local_images_and_audio_export(self):
        original = png(12, 6)
        source = self.home / "local.png"
        source.write_bytes(original)
        image_data = base64.b64encode(original).decode("ascii")
        audio = b"captured sound"
        audio_data = base64.b64encode(audio).decode("ascii")
        self.seed(
            message("user", "attachments", parts=(
                {"type": "input_image", "image_url": f"data:image/png;base64,{image_data}"},
                {"type": "input_audio", "audio_url": f"data:audio/wav;base64,{audio_data}"},
            )),
            row("event_msg", {"type": "user_message", "local_images": [source.name]}),
        )
        (chat,) = self.query("transcript")["items"]
        selected = self.query("attachments", "--ref", "-", stdin=chat["ref"] + "\n")
        self.assertNotIn(image_data, json.dumps(selected))
        self.assertNotIn(audio_data, json.dumps(selected))
        inline, audio_item = selected["items"]
        self.assertEqual((inline["media"], audio_item["media"]), ("image", "audio"))
        (local,) = self.query("images", "--kind", "local")["items"]
        destination = self.home / "exports"
        exported = self.query("export-image", "--id", "-", "--max-resolution", "4",
                              "--output-dir", str(destination),
                              stdin=f"{local['image_id']}\n{inline['image_id']}\n")
        self.assertEqual(exported["unknown_ids"], [])
        local_file, inline_file = exported["images"]
        self.assertEqual(Path(local_file["resolved_path"]), source)
        self.assertEqual(Path(inline_file["embedded_file"]).read_bytes(), original)
        for item in (local_file, inline_file):
            self.assertEqual((item["thumbnail_width"], item["thumbnail_height"]), (4, 2))
            self.assertTrue(Path(item["thumbnail_file"]).is_file())

        result = self.query("export-audio", "--id", "-", "--output-dir", str(destination),
                            stdin=audio_item["attachment_id"] + "\n")
        self.assertEqual(result["unknown_ids"], [])
        (saved,) = result["attachments"]
        self.assertEqual(Path(saved["audio_file"]).read_bytes(), audio)

        image_id = inline["image_id"]
        pieces = image_id.split(":")
        pieces[1] = "0" * len(pieces[1])
        stale_id = ":".join(pieces)
        pieces[1] = image_data
        malformed_id = ":".join(pieces)
        result = self.query("export-image", "--original", "--id", "-", "--output-dir", str(destination),
                            stdin=f"{image_id}\n{stale_id}\ndata:image/png;base64,{image_data}\n{malformed_id}\n")
        (saved,) = result["images"]
        self.assertEqual(saved["image_id"], image_id)
        self.assertEqual(result["unknown_ids"], [stale_id])
        self.assertEqual(result["invalid_id_count"], 2)
        self.assertNotIn(image_data, json.dumps(result))

        misplaced = self.run_cli("export-image", "--id", image_id, image_data)
        self.assertEqual(misplaced.returncode, 2)
        self.assertEqual(json.loads(misplaced.stderr)["error"]["code"], "invalid_arguments")
        self.assertNotIn(image_data.encode(), misplaced.stdout + misplaced.stderr)

        data_url = f"data:image/png;base64,{image_data}"
        for command in (
            ("export-image", "--id", image_id, "--rollout", data_url),
            ("export-image", "--id", image_id, "--output-dir", data_url),
            ("attachments", "--segment", data_url),
            ("attachments", data_url),
        ):
            with self.subTest(command=command[0], argument=command[-2]):
                misplaced = self.run_cli(*command)
                self.assertEqual(misplaced.returncode, 2)
                self.assertEqual(json.loads(misplaced.stderr)["error"]["code"], "invalid_arguments")
                self.assertNotIn(image_data.encode(), misplaced.stdout + misplaced.stderr)

    def test_original_image_export_returns_bytes_and_local_path_without_thumbnail(self):
        inline = b'<svg xmlns="http://www.w3.org/2000/svg" width="2" height="2"/>'
        local_path = self.home / "original.png"
        local_path.write_bytes(png(2048, 16))
        encoded = base64.b64encode(inline).decode("ascii")
        self.seed(
            message("user", "original attachments", parts=(
                {"type": "input_image", "image_url": "https://example.test/remote.png"},
                {"type": "input_image", "image_url": "data:image/png;base64," + ("AAAA" * 16384) + "%%%%"},
                {"type": "input_image", "image_url": f"data:image/svg+xml;base64,{encoded}"},
            )),
            row("event_msg", {
                "type": "image_generation_end",
                "status": "completed",
                "input_images": [{"path": str(local_path)}],
            }),
            row("compacted", {"window_number": 1, "replacement_history": []}),
        )
        listed = self.query("images")["items"]
        recovery = self.query("recover", "--max-messages", "0")
        (recovered,) = [
            image for record in recovery["image_records"] for image in record["images"]
            if image.get("media_type") == "image/svg+xml"
        ]
        self.assertEqual(recovered["image_id"], listed[2]["image_id"])
        destination = self.home / "originals"
        result = self.query("export-image", "--original", "--id", "-", "--output-dir", str(destination),
                            stdin="\n".join(item["image_id"] for item in listed) + "\n")
        remote, invalid, embedded, local = result["images"]
        self.assertEqual(result["unknown_ids"], [])
        self.assertTrue(remote["export_error"])
        self.assertTrue(invalid["export_error"])
        exported_path = Path(embedded["original_file"])
        self.assertEqual(exported_path.suffix, ".svg")
        self.assertEqual(exported_path.read_bytes(), inline)
        self.assertEqual(Path(local["original_file"]), local_path)
        self.assertEqual(list(destination.iterdir()), [exported_path])
        preview = self.query("export-image", "--id", listed[-1]["image_id"],
                             "--output-dir", str(self.home / "previews"))["images"][0]
        self.assertEqual((preview["thumbnail_width"], preview["thumbnail_height"]), (1024, 8))

    def test_tool_resource_blobs_are_discoverable_only_as_attachments(self):
        image = png(2, 1)
        audio = b"stored audio clip"
        image_blob = base64.b64encode(image).decode("ascii")
        audio_blob = base64.b64encode(audio).decode("ascii")
        self.seed(row("event_msg", {
            "type": "item_completed",
            "item": {
                "type": "McpToolCall", "id": "tool-resource", "server": "files", "tool": "read",
                "status": "completed", "arguments": {},
                "result": {"content": [
                    {"type": "resource", "resource": {
                        "uri": "file:///fixture.png", "mimeType": "image/png", "blob": image_blob,
                    }},
                    {"type": "resource", "resource": {
                        "uri": "file:///fixture.wav", "mimeType": "audio/wav", "blob": audio_blob,
                    }},
                ]},
            },
        }))
        item, = self.query("read", "--lines", "2:2")["items"]
        result = self.query("tool-output", "--id", item["output_id"], "--pointer", "")
        self.assertNotIn(image_blob, json.dumps(result))
        self.assertNotIn(audio_blob, json.dumps(result))

        image_item, audio_item = self.query("attachments")["items"]
        destination = self.home / "resources"
        original, = self.query("export-image", "--id", image_item["image_id"], "--original",
                               "--output-dir", str(destination))["images"]
        self.assertEqual(Path(original["original_file"]).read_bytes(), image)
        exported, = self.query("export-audio", "--id", audio_item["attachment_id"],
                               "--output-dir", str(destination))["attachments"]
        self.assertEqual(Path(exported["audio_file"]).read_bytes(), audio)

    def test_realtime_transcripts_are_searchable_and_can_be_reopened(self):
        self.seed(
            row("realtime_item", {
                "id": "voice-user", "realtime_session_id": "voice",
                "type": "frame", "channels": {"voice_transcript": {
                    "role": "user", "text": "voice question",
                }},
            }),
            row("realtime_item", {
                "id": "voice-assistant", "realtime_session_id": "voice",
                "type": "transcript_segment", "role": "assistant", "text": "voice answer",
            }),
            row("realtime_item", {
                "id": "wrapped", "realtime_session_id": "voice",
                "type": "session_input_saved", "reason": "chunk",
                "source_event_ids": ["voice-user"], "input_item_id": "input", "input": "voice handoff",
            }),
        )
        self.assertEqual([item["role"] for item in self.query("transcript")["items"]], ["user", "assistant"])
        matches = self.query("search", "voice", "--since", START)["items"]
        self.assertEqual([item["text"] for item in matches], ["voice question", "voice answer"])
        recent = self.query("transcript", "--last", "1")["items"]
        self.assertEqual(recent[0]["text"], "voice answer")
        reopened, = self.query("read", "--ref", "-", stdin=recent[0]["ref"] + "\n")["items"]
        self.assertEqual(reopened["fields"][0]["text"], "voice answer")
        self.assertEqual(self.query("transcript", "--phase", "final")["items"], [])


if __name__ == "__main__":
    unittest.main()
