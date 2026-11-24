"""Python reference CLI for parity and cross-runtime storage tests."""

from __future__ import annotations

import argparse
import codecs
import errno
import json
import math
import os
import re
import stat
import sys
from collections import deque
from collections.abc import Iterator
from contextlib import ExitStack
from datetime import datetime
from pathlib import Path
from typing import BinaryIO
from uuid import UUID

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "skills" / "thread-memory" / "scripts"))

from rollout_checkpoint_instructions import checkpoint_instructions
from rollout_handoff_store import MAX_HOOK_DIAGNOSTICS, read_hook_diagnostics, read_reminder_telemetry
from rollout_hook import MAX_NOTE_BYTES, hook_instructions, memory
from rollout_inventory import inventory
from rollout_lineage import describe_lineage, segment_info
from rollout_media import (
    attachment_catalog,
    audio_target_lines,
    catalog,
    export_audio,
    export_selected,
    image_target_lines,
)
from rollout_recover import recover
from rollout_refs import parse_ref, parse_row_cursor, reference_target, row_cursor
from rollout_scope import (
    annotate_rows,
    instant,
    scoped_rows,
    timeline,
    window_bounds,
    window_overlaps,
)
from rollout_search import read, read_reference, reference_image_scope, search
from rollout_source import (
    RolloutDataError,
    ScanDiagnostics,
    Segment,
    resolve_segments,
    rollout_id,
    selected_rows,
)
from rollout_tokens import SUMMARY_TYPES, usage_for
from rollout_tool_outputs import (
    parse_tool_cursor,
    read_tool_record,
    read_tool_value,
    tool_record_target,
)
from rollout_transcript import transcript

NOTE_TRUNCATION = "\n\n[Summary truncated]"
MAX_NOTE_PATCH_BYTES = 128 * 1024

PAGE_ITEMS = {
    "windows": "windows",
    "search": "matches",
    "read": "records",
    "transcript": "messages",
    "images": "images",
    "attachments": "attachments",
    "tool-input": "fields",
    "tool-output": "fields",
}


class RolloutArgumentParser(argparse.ArgumentParser):
    def error(self, message: str) -> None:
        report_error(
            "invalid_arguments",
            message,
            hint=f"Run python {self.prog} --help for valid options.",
        )
        raise SystemExit(2)

    def print_help(self, file=None) -> None:
        if file is not None and file is not sys.stdout:
            super().print_help(file)
            return
        status = write_stdout(self.format_help().encode("utf-8"))
        if status:
            raise SystemExit(status)


def row_range(value: str) -> tuple[int, int]:
    start, separator, end = value.partition(":")
    if (
        not separator
        or not (start.isdecimal() and end.isdecimal())
        or not 1 <= int(start) <= int(end)
    ):
        raise argparse.ArgumentTypeError("expected inclusive 1-based START:END")
    return int(start), int(end)


def character_range(value: str) -> tuple[int, int]:
    start, separator, end = value.partition(":")
    if (
        not separator
        or not (start.isdecimal() and end.isdecimal())
        or not 0 <= int(start) < int(end)
    ):
        raise argparse.ArgumentTypeError(
            "expected a 0-based range START:END, excluding END"
        )
    return int(start), int(end)


def positive(value: str) -> int:
    count = int(value)
    if count <= 0:
        raise argparse.ArgumentTypeError("expected a positive integer")
    return count


def tool_lines(value: str) -> int | tuple[int, int]:
    return row_range(value) if ":" in value else positive(value)


def context_size(value: str) -> int:
    count = int(value)
    if not 0 <= count <= 20:
        raise argparse.ArgumentTypeError("expected 0 to 20 context rows")
    return count


def search_window(value: str) -> int | str:
    return value if value == "current" else nonnegative(value)


def nonnegative(value: str) -> int:
    number = int(value)
    if number < 0:
        raise argparse.ArgumentTypeError("expected a nonnegative integer")
    return number


def scale_value(value: str) -> float:
    scale = float(value)
    if not math.isfinite(scale) or not 0 < scale <= 1:
        raise argparse.ArgumentTypeError(
            "expected a ratio greater than 0 and at most 1"
        )
    return scale


def date_value(value: str) -> datetime:
    try:
        return instant(value)
    except ValueError as error:
        raise argparse.ArgumentTypeError(
            "expected ISO 8601 with Z or an explicit UTC offset"
        ) from error


def add_source_options(parser: argparse.ArgumentParser) -> None:
    group = parser.add_mutually_exclusive_group()
    group.add_argument(
        "--thread",
        metavar="UUID",
        help="local Codex thread ID (defaults to CODEX_THREAD_ID)",
    )
    group.add_argument("--rollout", type=Path, help="explicit JSONL or JSONL.zst file")
    parser.add_argument(
        "--output",
        type=Path,
        help="write this page to a new file and print its location",
    )
    parser.add_argument(
        "--salvage",
        action="store_true",
        help="skip and report damaged JSONL records",
    )
    parser.add_argument(
        "--codex-home",
        type=Path,
        default=Path(os.getenv("CODEX_HOME", Path.home() / ".codex")),
    )
    parser.add_argument(
        "--previous",
        type=Path,
        action="append",
        default=[],
        help="override a referenced earlier rollout (repeatable)",
    )


def add_scope_options(parser: argparse.ArgumentParser) -> None:
    parser.add_argument(
        "--window",
        type=search_window,
        metavar="N|current",
        help="rows through checkpoint N, or after the latest checkpoint",
    )
    parser.add_argument("--segment", help="rollout basename or rollout ID")
    parser.add_argument(
        "--lines",
        type=row_range,
        metavar="START:END",
        help="inclusive physical line range in each selected segment",
    )
    parser.add_argument("--turn", metavar="ID", help="Codex turn ID")
    add_origin_option(parser)
    add_time_options(parser)


def add_origin_option(parser: argparse.ArgumentParser) -> None:
    parser.add_argument(
        "--origin",
        choices=("all", "current", "inherited", "unknown"),
        default="all",
        help="limit to the current thread or its inherited history",
    )


def add_time_options(parser: argparse.ArgumentParser) -> None:
    parser.add_argument(
        "--since",
        type=date_value,
        metavar="TIME",
        help="inclusive ISO 8601 timestamp with offset",
    )
    parser.add_argument(
        "--until",
        type=date_value,
        metavar="TIME",
        help="exclusive ISO 8601 timestamp with offset",
    )


def add_record_filters(parser: argparse.ArgumentParser) -> None:
    parser.add_argument(
        "--type",
        dest="kinds",
        action="append",
        help="rollout record or item type (repeatable)",
    )
    parser.add_argument(
        "--role",
        dest="roles",
        action="append",
        choices=("user", "assistant", "developer", "system", "tool"),
    )


def add_search_options(parser: argparse.ArgumentParser) -> None:
    add_scope_options(parser)
    add_record_filters(parser)
    parser.add_argument("--tool", metavar="NAME", help="filter by exact tool name")
    add_text_page_options(parser, max_chars=400)


def add_page_options(parser: argparse.ArgumentParser) -> None:
    parser.add_argument(
        "--limit", type=positive, default=20, help="maximum results per page"
    )
    parser.add_argument(
        "--cursor",
        help="resume with next_cursor in the same scope (use - to read it from stdin)",
    )


def add_text_page_options(parser: argparse.ArgumentParser, *, max_chars: int) -> None:
    add_page_options(parser)
    parser.add_argument(
        "--max-chars",
        type=positive,
        default=max_chars,
        help="maximum text characters per record",
    )
    parser.add_argument(
        "--budget-chars",
        type=positive,
        default=4000,
        help="maximum text characters across this page",
    )


def parse_args() -> argparse.Namespace:
    parser = RolloutArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest="command", required=True)
    inspect_cmd = commands.add_parser(
        "inspect", help="list physical segments and compaction checkpoints"
    )
    add_source_options(inspect_cmd)
    lineage_cmd = commands.add_parser(
        "lineage",
        help="show the current thread, fork parents, and physical rollout segments",
    )
    add_source_options(lineage_cmd)
    windows_cmd = commands.add_parser(
        "windows", help="list checkpoint times and recorded window periods"
    )
    add_source_options(windows_cmd)
    add_time_options(windows_cmd)
    add_origin_option(windows_cmd)
    add_page_options(windows_cmd)
    windows_cmd.add_argument("--window", type=search_window, metavar="N|current")
    windows_cmd.add_argument(
        "--with-tokens",
        action="store_true",
        help="include recorded token usage for each window",
    )
    tokens_cmd = commands.add_parser(
        "tokens", help="report all recorded token usage categories"
    )
    add_source_options(tokens_cmd)
    add_scope_options(tokens_cmd)
    add_page_options(tokens_cmd)
    token_details = tokens_cmd.add_mutually_exclusive_group()
    token_details.add_argument(
        "--by-response",
        action="store_true",
        help="include a page of individual responses in the selected scope",
    )
    token_details.add_argument(
        "--by-summary",
        action="store_true",
        help="include a page of encrypted compaction summaries",
    )
    inventory_cmd = commands.add_parser(
        "inventory", help="count recorded types and locate examples"
    )
    add_source_options(inventory_cmd)
    add_scope_options(inventory_cmd)
    add_record_filters(inventory_cmd)
    add_page_options(inventory_cmd)
    grep = commands.add_parser("search", help="search readable history fields")
    add_source_options(grep)
    add_search_options(grep)
    grep.add_argument("pattern")
    grep.add_argument(
        "--regex",
        action="store_true",
        help="interpret the pattern as a Python regular expression",
    )
    grep.add_argument("-i", "--ignore-case", action="store_true")
    grep.add_argument("-B", "--before", type=context_size, default=0)
    grep.add_argument("-A", "--after", type=context_size, default=0)
    read_cmd = commands.add_parser(
        "read", help="read a small range of readable records"
    )
    add_source_options(read_cmd)
    add_search_options(read_cmd)
    read_cmd.add_argument(
        "--ref", help="ref from search, read or transcript (use - for stdin)"
    )
    field_selector = read_cmd.add_mutually_exclusive_group()
    field_selector.add_argument(
        "--metadata-only",
        action="store_true",
        help="list record locations without text excerpts",
    )
    field_selector.add_argument(
        "--field", help="read fields matching the name reported by search"
    )
    field_selector.add_argument(
        "--field-index",
        type=nonnegative,
        metavar="N",
        help="read the exact 0-based field reported by search",
    )
    read_cmd.add_argument(
        "--chars",
        type=character_range,
        metavar="START:END",
        help="0-based character slice in each field, excluding END",
    )
    for direction in ("input", "output"):
        detail_cmd = commands.add_parser(
            f"tool-{direction}", help=f"read one tool {direction} by ID"
        )
        add_source_options(detail_cmd)
        selectors = detail_cmd.add_mutually_exclusive_group(required=True)
        selectors.add_argument(
            "--id",
            help=f"{direction}_id from search or read (use - to read it from stdin)",
        )
        selection = detail_cmd.add_mutually_exclusive_group()
        selection.add_argument(
            "--lines",
            type=tool_lines,
            metavar="N|START:END",
            help="maximum lines (default: 20), or an inclusive 1-based text range",
        )
        selection.add_argument(
            "--pointer",
            metavar="JSON_POINTER",
            help="read a typed JSON value from the selected tool record",
        )
        detail_cmd.add_argument(
            "--budget-chars",
            type=positive,
            help="maximum text characters per page (default: 4000)",
        )
        selectors.add_argument(
            "--cursor",
            help="resume next_cursor with the previous selection and budget (use - for stdin)",
        )
    instructions_cmd = commands.add_parser(
        "instructions",
        help="read system and developer messages in a compaction checkpoint",
    )
    add_source_options(instructions_cmd)
    instructions_cmd.add_argument(
        "--window", type=nonnegative, required=True, help="compaction checkpoint number"
    )
    instructions_cmd.add_argument(
        "--role", dest="roles", action="append", choices=("system", "developer")
    )
    instructions_cmd.add_argument(
        "--item", type=nonnegative, help="read one zero-based checkpoint_item"
    )
    instructions_cmd.add_argument(
        "--chars",
        type=character_range,
        metavar="START:END",
        help="zero-based text slice",
    )
    add_text_page_options(instructions_cmd, max_chars=1000)
    transcript_cmd = commands.add_parser(
        "transcript", help="extract user and assistant messages from a scope"
    )
    add_source_options(transcript_cmd)
    add_scope_options(transcript_cmd)
    transcript_cmd.add_argument(
        "--role", dest="roles", action="append", choices=("user", "assistant")
    )
    transcript_cmd.add_argument(
        "--last",
        type=positive,
        metavar="N",
        help="read up to N latest messages in order",
    )
    transcript_cmd.add_argument(
        "--phase",
        choices=("final", "commentary", "partial"),
        help="select a recorded assistant response phase",
    )
    add_text_page_options(transcript_cmd, max_chars=1000)
    transcript_cmd.add_argument(
        "--format", choices=("json", "markdown"), default="json"
    )
    images_cmd = commands.add_parser(
        "images", help="list image IDs and metadata without exporting files"
    )
    add_source_options(images_cmd)
    add_scope_options(images_cmd)
    images_cmd.add_argument(
        "--ref", help="ref from search, read or transcript (use - for stdin)"
    )
    images_cmd.add_argument("--kind", choices=("inline", "local", "reference"))
    images_cmd.add_argument(
        "--role",
        dest="roles",
        action="append",
        choices=("user", "assistant", "tool", "developer", "system"),
    )
    add_page_options(images_cmd)
    attachments_cmd = commands.add_parser(
        "attachments", help="list image and audio attachment references"
    )
    add_source_options(attachments_cmd)
    add_scope_options(attachments_cmd)
    attachments_cmd.add_argument(
        "--ref", help="ref from search, read or transcript (use - for stdin)"
    )
    attachments_cmd.add_argument("--media", choices=("image", "audio"))
    attachments_cmd.add_argument("--kind", choices=("inline", "local", "reference"))
    attachments_cmd.add_argument(
        "--role",
        dest="roles",
        action="append",
        choices=("user", "assistant", "tool", "developer", "system"),
    )
    add_page_options(attachments_cmd)
    for medium in ("image", "audio"):
        export_cmd = commands.add_parser(
            f"export-{medium}", help=f"export locally available {medium} selected by ID"
        )
        add_source_options(export_cmd)
        export_cmd.add_argument(
            "--id",
            dest="ids",
            action="append",
            required=True,
            help="attachment ID (repeatable; use - once for newline-delimited IDs on stdin)",
        )
        export_cmd.add_argument(
            "--output-dir",
            type=Path,
            help="destination (defaults to a new temporary directory)",
        )
        if medium == "image":
            export_cmd.add_argument("--scale", type=scale_value, default=1.0)
            export_cmd.add_argument(
                "--max-resolution", type=positive, default=512, metavar="PIXELS"
            )
    recover_cmd = commands.add_parser(
        "recover", help="compare history with a compaction checkpoint"
    )
    add_source_options(recover_cmd)
    recover_cmd.add_argument("--window", type=nonnegative)
    recover_cmd.add_argument(
        "--max-images",
        type=nonnegative,
        default=8,
        help="maximum images (0 omits them)",
    )
    recover_cmd.add_argument(
        "--export-images",
        nargs="?",
        const=True,
        type=Path,
        metavar="DIR",
        help="export images into DIR or a new temporary directory",
    )
    recover_cmd.add_argument(
        "--scale",
        type=scale_value,
        help="thumbnail width and height ratio (default: 0.25 without a resolution limit)",
    )
    recover_cmd.add_argument(
        "--max-resolution",
        type=positive,
        metavar="PIXELS",
        help="cap the thumbnail's longest edge without enlarging smaller images",
    )
    recover_cmd.add_argument("--max-messages", type=nonnegative, default=8)
    recover_cmd.add_argument("--max-chars", type=nonnegative, default=2400)
    hook_cmd = commands.add_parser(
        "hook", help="handle a Codex usage or compaction hook on stdin"
    )
    memory_cmd = commands.add_parser("memory", help="maintain one durable note per thread")
    memory_cmd.add_argument("action", choices=("read", "write", "patch"))
    memory_cmd.add_argument("--thread", help="thread UUID (defaults to CODEX_THREAD_ID)")
    diagnostics_cmd = commands.add_parser("diagnostics", help="read recent Thread Memory hook decisions")
    diagnostics_source = diagnostics_cmd.add_mutually_exclusive_group()
    diagnostics_source.add_argument("--thread", help="thread UUID (defaults to CODEX_THREAD_ID)")
    diagnostics_source.add_argument("--summary", action="store_true", help="aggregate reminder metrics across threads")
    diagnostics_cmd.add_argument("--limit", type=positive, help="maximum number of thread events (default: 20)")
    for command in (hook_cmd, memory_cmd, diagnostics_cmd):
        command.add_argument(
            "--codex-home", type=Path,
            default=Path(os.getenv("CODEX_HOME", Path.home() / ".codex")),
        )
    args = parser.parse_args()
    if args.command == "diagnostics":
        if args.summary and args.limit is not None:
            parser.error("diagnostics --limit applies to thread events")
        if args.limit is not None and args.limit > MAX_HOOK_DIAGNOSTICS:
            parser.error(f"diagnostics --limit must be from 1 to {MAX_HOOK_DIAGNOSTICS}")
        if not args.summary:
            args.limit = args.limit or 20
            try:
                args.thread = str(UUID(args.thread or os.getenv("CODEX_THREAD_ID") or ""))
            except ValueError:
                parser.error("diagnostics requires --thread UUID or CODEX_THREAD_ID")
    if (
        getattr(args, "since", None) is not None
        and args.until is not None
        and args.since >= args.until
    ):
        parser.error("--since must be earlier than --until")
    if (
        args.command == "tokens"
        and args.cursor
        and not (args.by_response or args.by_summary)
    ):
        parser.error("tokens --cursor requires --by-response or --by-summary")
    if args.command in {"tool-input", "tool-output"} and args.cursor is not None:
        if args.pointer is not None:
            parser.error("--pointer requires --id")
        if args.lines is not None or args.budget_chars is not None:
            parser.error("--cursor already contains --lines and --budget-chars")
    if (
        args.command == "transcript"
        and args.last is not None
        and args.cursor is not None
    ):
        parser.error("--last cannot be combined with --cursor")
    if (
        args.command == "read"
        and args.metadata_only
        and (args.chars is not None or args.ref is not None)
    ):
        parser.error("--metadata-only cannot be combined with --chars or --ref")
    if getattr(args, "ref", None) is not None:
        scope_options = (
            args.segment,
            args.lines,
            args.turn,
            args.window,
            args.since,
            args.until,
        )
        if args.origin != "all" or any(value is not None for value in scope_options):
            parser.error("--ref selects a record in place of the history filters")
        if args.command == "read" and any(
            value is not None
            for value in (
                args.roles,
                args.kinds,
                args.tool,
                args.field,
                args.field_index,
                args.cursor,
            )
        ):
            parser.error("--ref already selects the record and text projection")
    return args


def located_rows(
    segments: list[Segment],
    targets: dict[Path, set[int]],
    *,
    revision: bool = False,
    defer_revision: bool = False,
) -> Iterator[tuple[Path, int, dict]]:
    owner = segments[-1].metadata.get("id")
    for segment in segments:
        if lines := targets.get(segment.path):
            end = max(lines)
            for path, line, row in annotate_rows(
                segment,
                owner,
                keep_payload=set(),
                full_lines=lines,
                revision_lines=lines if revision else None,
                defer_revision=defer_revision,
            ):
                if line in lines:
                    yield path, line, row
                if line >= end:
                    break


def search_rows(
    segments: list[Segment], args: argparse.Namespace, fallback: Iterator[tuple[Path, int, dict]],
    resources: ExitStack,
) -> Iterator[tuple[Path, int, dict]]:
    build_index = args.window is not None or args.since is not None or args.until is not None
    if (
        len(segments) == 1 and args.tool is None and not args.salvage
        and (build_index or args.lines or args.cursor is not None)
    ):
        segment = segments[0]
        if (
            segment.path.suffix != ".zst"
            and segment.end_offset is None
            and segment.end_ordinal is None
            and (args.segment is None or args.segment in (segment.path.name, rollout_id(segment.path)))
        ):
            from rollout_query_index import open_rollout_index
            from rollout_scope import indexed_scoped_rows

            index = resources.enter_context(open_rollout_index(args.codex_home, segment, build=build_index))
            if index is not None:
                yield from indexed_scoped_rows(segment, args, index)
                return
    yield from fallback


def markdown_transcript(result: dict) -> str:
    chunks = ["# Codex rollout transcript"]
    for message in result["messages"]:
        timestamp = message.get("timestamp") or "Time unavailable"
        source = f"{message['path']}:{message['line']}"
        if origin := message.get("origin"):
            source += f" ({origin}"
            if message.get("timestamp_origin") == "copied_at":
                source += ", copied at the displayed time"
            source += ")"
        chunk = f"## {timestamp} - {message['role']}\n\n{source}\n\n{message['text']}"
        if images := message.get("image_count"):
            chunk += f"\n\n[Image attachments: {images}]"
        if omitted := message.get("omitted_chars"):
            chunk += f"\n\n[Excerpt omitted {omitted} characters.]"
        chunks.append(chunk)
    if cursor := result.get("next_cursor"):
        chunks.append(f"Next cursor: {cursor}")
    if gaps := result.get("missing_base_rollouts"):
        chunks.append(f"Missing rollout segments: {', '.join(gaps)}")
    if report := result.get("damaged_records"):
        issues = [
            f"- {row['path']}:{row['line']}, byte {row['byte_offset']} ({row['reason']})"
            for row in report["items"]
        ]
        chunks.append(
            f"Damaged records observed: {report['count']}\n\n" + "\n".join(issues)
        )
    return "\n\n".join(chunks) + "\n"


def window_page(segments: list[Segment], args: argparse.Namespace) -> dict:
    windows = []
    next_cursor = None
    waiting = args.cursor
    if waiting is not None:
        parse_row_cursor(waiting)
    last_cursor = None
    for info, _, _ in timeline(segments, with_tokens=args.with_tokens):
        if (
            (args.window is not None and args.window != info["window"])
            or (args.origin != "all" and args.origin != info["origin"])
            or not window_overlaps(info, args.since, args.until)
        ):
            continue
        key = (
            None
            if info["window"] == "current"
            else row_cursor(Path(info["path"]), info["line"])
        )
        if waiting is not None:
            if key == waiting:
                waiting = None
            continue
        if len(windows) == args.limit:
            next_cursor = last_cursor
            break
        windows.append(info)
        last_cursor = key
    if waiting is not None:
        raise ValueError("window cursor is outside the selected scope")
    return {
        "thread_id": segments[-1].metadata.get("id"),
        "windows": windows,
        "next_cursor": next_cursor,
    }


def resolve_stdin_selectors(args: argparse.Namespace) -> None:
    selectors = [
        name for name in ("cursor", "id", "ref") if getattr(args, name, None) == "-"
    ]
    image_ids_from_stdin = (getattr(args, "ids", None) or []).count("-")
    readers = len(selectors) + image_ids_from_stdin
    if not readers:
        return
    if readers > 1:
        raise ValueError("use - only once across --id, --ref and --cursor")

    option = "--id" if image_ids_from_stdin else f"--{selectors[0]}"
    raw = sys.stdin.buffer.read()
    try:
        values = [line.decode("utf-8") for line in raw.splitlines()]
    except UnicodeDecodeError as error:
        raise ValueError(
            f"{option} - requires UTF-8 input; use jq -r or jq -er"
        ) from error
    if not values or any(not value.strip() for value in values):
        raise ValueError(f"{option} - requires nonempty UTF-8 input lines")
    if image_ids_from_stdin:
        index = args.ids.index("-")
        args.ids[index : index + 1] = values
    elif len(values) != 1:
        raise ValueError(f"{option} - requires exactly one input line")
    else:
        setattr(args, selectors[0], values[0])


def json_bytes(result: dict) -> bytes:
    output = json.dumps(result, ensure_ascii=False, separators=(",", ":")) + "\n"
    try:
        return output.encode("utf-8")
    except UnicodeEncodeError:
        # Legacy JSONL may contain lone surrogate escapes that jq rejects.
        return re.sub(r"[\ud800-\udfff]", "\ufffd", output).encode("utf-8")


def report_error(
    code: str,
    message: str,
    *,
    hint: str | None = None,
    path: Path | None = None,
    line: int | None = None,
) -> int:
    excerpt = " ".join(message[:400].split())
    if len(message) > 400:
        excerpt += "..."
    error: dict[str, str | int] = {"code": code, "message": excerpt or code}
    if hint is not None:
        error["hint"] = hint
    if path is not None:
        error["path"] = str(path)[:512]
    if line is not None:
        error["line"] = line
    try:
        os.write(sys.stderr.fileno(), json_bytes({"error": error}))
    except OSError:
        pass  # No diagnostic channel remains if stderr is closed.
    return 1


def write_stdout(data: bytes) -> int:
    try:
        sys.stdout.buffer.write(data)
        sys.stdout.buffer.flush()
    except OSError as error:
        windows_pipe_closed = os.name == "nt" and (
            getattr(error, "winerror", None) in {109, 232}
            or (
                error.errno == errno.EINVAL
                and stat.S_ISFIFO(os.fstat(sys.stdout.fileno()).st_mode)
            )
        )
        if error.errno != errno.EPIPE and not windows_pipe_closed:
            raise
        # Prevent a second write from printing an error during interpreter shutdown.
        with open(os.devnull, "wb") as sink:
            os.dup2(sink.fileno(), sys.stdout.fileno())
        return 141
    return 0


def read_note(stream: BinaryIO) -> tuple[str, bool]:
    raw = stream.read(MAX_NOTE_BYTES + len(codecs.BOM_UTF8) + 1)
    raw = raw.removeprefix(codecs.BOM_UTF8)
    prefix, overflow = raw[:MAX_NOTE_BYTES], raw[MAX_NOTE_BYTES:]
    truncated = bool(overflow.strip(b"\r\n"))
    if overflow:
        # Drain the producer with bounded memory so a long pipe still completes.
        while chunk := stream.read(65536):
            truncated = truncated or bool(chunk.strip(b"\r\n"))

    if truncated:
        limit = MAX_NOTE_BYTES - len(NOTE_TRUNCATION.encode("utf-8"))
        decoder = codecs.getincrementaldecoder("utf-8")()
        summary = decoder.decode(prefix[:limit], final=False)
    else:
        summary = prefix.decode("utf-8")
    summary = summary.rstrip("\r\n")
    if truncated:
        summary = summary + NOTE_TRUNCATION if summary.strip() else NOTE_TRUNCATION.lstrip()
    elif not summary.strip():
        raise ValueError("memory write requires a nonempty UTF-8 note on stdin")
    return summary, truncated


def main() -> int:
    try:
        args = parse_args()
        if args.command == "hook":
            try:
                request = json.load(sys.stdin.buffer)
            except (ValueError, RecursionError) as error:
                raise ValueError(f"invalid hook JSON from stdin: {error}") from error
            if not isinstance(request, dict):
                raise ValueError("hook stdin must contain a JSON object")
            context = hook_instructions(request, args.codex_home)
            if context is None:
                return 0
            return write_stdout(
                json_bytes(
                    {
                        "hookSpecificOutput": {
                            "hookEventName": request["hook_event_name"],
                            "additionalContext": context,
                        }
                    }
                )
            )
        if args.command == "memory":
            summary, truncated = (
                read_note(sys.stdin.buffer) if args.action == "write" else (None, False)
            )
            patch = None
            if args.action == "patch":
                raw = sys.stdin.buffer.read(MAX_NOTE_PATCH_BYTES + 1)
                if len(raw) > MAX_NOTE_PATCH_BYTES:
                    raise ValueError(f"memory patch input is limited to {MAX_NOTE_PATCH_BYTES} UTF-8 bytes")
                patch = raw.decode("utf-8-sig")
            thread = args.thread or os.getenv("CODEX_THREAD_ID")
            result = memory(args.codex_home, thread, args.action, summary=summary, patch=patch)
            if args.action == "write":
                result["truncated"] = truncated
            return write_stdout(json_bytes(result))
        if args.command == "diagnostics":
            if args.summary:
                return write_stdout(json_bytes({"items": read_reminder_telemetry(args.codex_home)}))
            items = read_hook_diagnostics(args.codex_home, args.thread, limit=args.limit)
            return write_stdout(json_bytes({"thread_id": args.thread, "items": items}))
        if args.output is not None and args.output.exists():
            raise FileExistsError(f"output path already exists: {args.output}")
        resolve_stdin_selectors(args)
        diagnostics = ScanDiagnostics(salvage=args.salvage)
        segments, gaps = resolve_segments(
            args.rollout,
            args.thread,
            args.codex_home,
            args.previous,
            diagnostics=diagnostics,
        )
        primary = segments[-1]
        if getattr(args, "ref", None) is not None:
            ref = parse_ref(args.ref)
            target = reference_target((segment.path for segment in segments), ref)
            if target is None:
                raise ValueError("reference is outside the selected rollout lineage")
            path, line = target
            row = next(
                located_rows(segments, {path: {line}}, defer_revision=True), None
            )
            if row is None:
                raise ValueError(
                    "reference is stale or outside the selected rollout lineage"
                )
            if args.command == "read":
                item = read_reference(
                    row,
                    ref,
                    max_chars=min(args.max_chars, args.budget_chars),
                    chars=args.chars,
                )
                result = {"records": [item], "next_cursor": None}
            else:
                rows = [reference_image_scope(row, ref)]
                options = {
                    "limit": args.limit,
                    "kind": args.kind,
                    "cursor": args.cursor,
                    "roles": args.roles or (),
                }
                if args.command == "attachments":
                    result = attachment_catalog(rows, media=args.media, **options)
                else:
                    result = catalog(rows, **options)
        elif args.command == "inspect":
            checkpoints = deque(maxlen=5)
            checkpoint_count = 0
            for info, _, end in timeline(segments, with_tokens=False):
                if end is not None:
                    checkpoints.append(info)
                    checkpoint_count += 1
            result = {
                "thread_id": primary.metadata.get("id"),
                "segments": [segment_info(segment, primary) for segment in segments],
                "checkpoints": list(checkpoints),
                "checkpoint_count": checkpoint_count,
            }
        elif args.command == "lineage":
            result = describe_lineage(segments, args.codex_home)
        elif args.command == "windows":
            result = window_page(segments, args)
        elif args.command == "inventory":
            result = inventory(
                scoped_rows(segments, args, defer_revision=True),
                kinds=args.kinds,
                roles=args.roles,
                limit=args.limit,
                cursor=args.cursor,
            )
        elif args.command == "instructions":
            _, checkpoint = window_bounds(segments, args.window)
            if checkpoint is None:
                raise ValueError(f"no compaction checkpoint for window {args.window}")
            segment_index, line = checkpoint
            path = segments[segment_index].path
            row = next(located_rows(segments, {path: {line}}, revision=True), None)
            if row is None:
                raise ValueError(f"cannot read the checkpoint for window {args.window}")
            result = checkpoint_instructions(
                row,
                window=args.window,
                roles=args.roles,
                item=args.item,
                chars=args.chars,
                limit=args.limit,
                max_chars=args.max_chars,
                budget_chars=args.budget_chars,
                cursor=args.cursor,
            )
        elif args.command == "tokens":
            result = usage_for(
                scoped_rows(
                    segments,
                    args,
                    keep_payload={"compacted", "response_item", "token_usage_record"},
                    response_types=SUMMARY_TYPES,
                ),
                by_response=args.by_response,
                by_summary=args.by_summary,
                limit=args.limit,
                cursor=args.cursor,
            )
        elif args.command in ("search", "read"):
            rows = scoped_rows(
                segments, args, resolve_tool_names=bool(args.tool), defer_revision=True
            )
            options = {
                "kinds": args.kinds,
                "roles": args.roles,
                "tools": (args.tool,) if args.tool is not None else (),
                "limit": args.limit,
                "max_chars": args.max_chars,
                "budget_chars": args.budget_chars,
                "cursor": args.cursor,
            }
            if args.command == "search":
                from rollout_query_index import RolloutIndexUnavailable

                options.update(
                    regex=args.regex, ignore_case=args.ignore_case,
                    before=args.before, after=args.after,
                )
                try:
                    with ExitStack() as resources:
                        indexed_rows = search_rows(segments, args, rows, resources)
                        result = search(indexed_rows, args.pattern, **options)
                except RolloutIndexUnavailable:
                    result = search(rows, args.pattern, **options)
            else:
                result = read(
                    rows,
                    field=args.field,
                    field_index=args.field_index,
                    chars=args.chars,
                    metadata_only=args.metadata_only,
                    include_empty=bool(
                        args.lines
                        and args.lines[0] == args.lines[1]
                        and args.field is None
                        and args.field_index is None
                        and args.chars is None
                    ),
                    **options,
                )
        elif args.command == "transcript":
            result = transcript(
                scoped_rows(
                    segments,
                    args,
                    keep_payload={"response_item"},
                    event_types={"item_completed", "agent_message"},
                    response_types={"message"},
                    defer_revision=True,
                ),
                roles=args.roles,
                limit=args.limit,
                max_chars=args.max_chars,
                budget_chars=args.budget_chars,
                cursor=args.cursor,
                last=args.last,
                phase=args.phase,
            )
        elif args.command == "images":
            result = catalog(
                scoped_rows(segments, args),
                limit=args.limit,
                kind=args.kind,
                cursor=args.cursor,
                roles=args.roles or (),
            )
        elif args.command == "attachments":
            result = attachment_catalog(
                scoped_rows(segments, args),
                limit=args.limit,
                media=args.media,
                kind=args.kind,
                cursor=args.cursor,
                roles=args.roles or (),
            )
        elif args.command == "export-image":
            targets = image_target_lines(
                (segment.path for segment in segments), args.ids
            )
            result = export_selected(
                located_rows(segments, targets),
                args.ids,
                output_dir=args.output_dir,
                scale=args.scale,
                max_resolution=args.max_resolution,
            )
        elif args.command == "export-audio":
            targets = audio_target_lines(
                (segment.path for segment in segments), args.ids
            )
            result = export_audio(
                located_rows(segments, targets), args.ids, output_dir=args.output_dir
            )
        elif args.command in ("tool-input", "tool-output"):
            direction = args.command.removeprefix("tool-")
            cursor = (
                parse_tool_cursor(args.cursor, direction=direction)
                if args.cursor is not None
                else None
            )
            identifier = cursor.identifier if cursor is not None else args.id
            target = tool_record_target(
                (segment.path for segment in segments), identifier, direction=direction
            )
            if target is None:
                raise ValueError(
                    f"tool {direction} ID is outside the selected rollout lineage"
                )
            path, line = target
            rows = located_rows(segments, {path: {line}}, revision=args.pointer is None)
            if args.pointer is not None:
                result = read_tool_value(
                    rows,
                    identifier,
                    direction=direction,
                    pointer=args.pointer,
                    budget_chars=args.budget_chars or 4000,
                )
            else:
                line_options = (
                    {"line_range": args.lines}
                    if isinstance(args.lines, tuple)
                    else {"lines": args.lines or 20}
                )
                result = read_tool_record(
                    rows,
                    identifier,
                    direction=direction,
                    budget_chars=args.budget_chars or 4000,
                    cursor=cursor,
                    **line_options,
                )
        else:
            owner = primary.metadata.get("id")
            max_resolution = args.max_resolution
            scale = args.scale
            export_dir = args.export_images
            offsets: dict[Path, dict[int, int]] = {}

            def recovery_rows() -> Iterator[tuple[Path, int, dict]]:
                for segment in segments:
                    index = (
                        offsets.setdefault(segment.path, {})
                        if export_dir is not None and segment.path.suffix != ".zst"
                        else None
                    )
                    for path, line, row in annotate_rows(segment, owner):
                        if index is not None and row["type"] in (
                            "response_item",
                            "event_msg",
                            "compacted",
                        ):
                            index[line] = row["_rollout_offset"]
                        yield path, line, row

            def recovery_images(
                path: Path, lines: set[int]
            ) -> Iterator[tuple[int, dict]]:
                return selected_rows(
                    path, lines, offsets=offsets.get(path), diagnostics=diagnostics
                )

            result = recover(
                recovery_rows(),
                primary.path,
                window=args.window,
                max_messages=args.max_messages,
                max_chars=args.max_chars,
                max_images=args.max_images,
                export_dir=export_dir,
                scale=scale if scale is not None else (1.0 if max_resolution else 0.25),
                max_resolution=max_resolution,
                read_selected_rows=recovery_images,
            )
        if gaps:
            result["missing_base_rollouts"] = gaps
        if diagnostics.issues:
            issues = list(diagnostics.issues.values())
            items = issues if args.output is not None else issues[:20]
            result["damaged_records"] = {
                "count": len(issues),
                "items": items,
                "truncated": len(items) < len(issues),
            }
        if args.command == "transcript" and args.format == "markdown":
            data = markdown_transcript(result).encode(
                "utf-8", errors="backslashreplace"
            )
        else:
            if "next_cursor" in result and "items" not in result:
                if args.command == "tokens":
                    key = "responses" if args.by_response else "encrypted_summaries"
                else:
                    key = PAGE_ITEMS[args.command]
                result["items"] = result.pop(key)
            data = json_bytes(result)
        if args.output is not None:
            with args.output.open("xb") as file:
                file.write(data)
            pointer = {"output": str(args.output.resolve()), "bytes": len(data)}
            if "next_cursor" in result:
                pointer["next_cursor"] = result["next_cursor"]
            if diagnostics.issues:
                pointer["damaged_record_count"] = len(diagnostics.issues)
            if gaps:
                pointer["missing_base_rollout_count"] = len(gaps)
            data = json_bytes(pointer)
        return write_stdout(data)
    except RolloutDataError as error:
        hint = None
        if args.command != "hook" and error.message.startswith("invalid JSONL"):
            hint = "Retry with --salvage to skip damaged records."
        return report_error(
            "invalid_rollout",
            error.message,
            hint=hint,
            path=error.path,
            line=error.line,
        )
    except FileExistsError as error:
        return report_error(
            "output_exists", str(error), hint="Choose a new output path."
        )
    except FileNotFoundError as error:
        return report_error("not_found", str(error))
    except PermissionError as error:
        return report_error("permission_denied", str(error))
    except OSError as error:
        return report_error("io_error", str(error))
    except (ValueError, OverflowError, RecursionError, re.error) as error:
        return report_error("invalid_input", str(error))
    except KeyboardInterrupt:
        report_error("interrupted", "Interrupted by user.")
        return 130
    except Exception as error:  # noqa: BLE001
        # The executable boundary keeps even unexpected failures machine-readable.
        return report_error("runtime_error", f"{type(error).__name__}: {error}")


if __name__ == "__main__":
    sys.exit(main())
