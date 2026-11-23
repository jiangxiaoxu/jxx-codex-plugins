"""Locate tool inputs and outputs by ID and read bounded pages of their text."""

from __future__ import annotations

import base64
import hashlib
import json
import math
import os
import re
import sys
from collections.abc import Iterable, Iterator
from dataclasses import dataclass
from functools import lru_cache
from pathlib import Path

from rollout_text import (
    BINARY_KEYS,
    BINARY_PARTS,
    LOCAL_REFERENCE,
    PATH_PARTS,
    TEXT_PARTS,
    USER_SHELL_PREFIX,
    USER_SHELL_RESULT,
    USER_SHELL_SUFFIX,
    TextField,
    _parts,
    _text_fields,
    _tool_values,
    _values,
    user_shell_parts,
)

RESPONSE_INPUT_FIELDS = {
    "function_call": ("arguments",),
    "custom_tool_call": ("input",),
    "tool_search_call": ("arguments",),
    "local_shell_call": ("action",),
    "web_search_call": ("action",),
    "image_generation_call": (),
}
COMMAND_INPUT_FIELDS = (
    "command",
    "cwd",
    "interaction_input",
    "parsed_cmd",
    "script_path",
)
EVENT_INPUT_FIELDS = {
    "exec_command_begin": COMMAND_INPUT_FIELDS,
    "exec_command_end": COMMAND_INPUT_FIELDS,
    "view_image_tool_call": ("path",),
    "patch_apply_begin": ("changes",),
    "patch_apply_updated": ("changes",),
    "patch_apply_end": ("changes",),
    "mcp_tool_call_begin": ("invocation.arguments", "arguments"),
    "mcp_tool_call_end": ("invocation.arguments", "arguments"),
    "dynamic_tool_call_request": ("arguments",),
    "dynamic_tool_call_response": ("arguments",),
    "web_search_begin": (),
    "web_search_end": ("query", "action"),
    "image_generation_begin": (),
    "image_generation_end": ("input_images", "transparent_background"),
    "collab_agent_spawn_begin": ("prompt", "model", "reasoning_effort"),
    "collab_agent_spawn_end": ("prompt", "model", "reasoning_effort"),
    "collab_agent_interaction_begin": ("receiver_thread_id", "prompt"),
    "collab_agent_interaction_end": ("receiver_thread_id", "prompt"),
}
ITEM_INPUT_FIELDS = {
    "CommandExecution": COMMAND_INPUT_FIELDS,
    "ImageView": ("path",),
    "FileChange": ("changes",),
    "McpToolCall": ("arguments",),
    "DynamicToolCall": ("arguments",),
    "WebSearch": ("query", "action"),
    "CollabAgentToolCall": (
        "prompt",
        "model",
        "reasoning_effort",
        "receiver_thread_ids",
    ),
    "ImageGeneration": (),
}
EXTENSION_INPUT_FIELDS = {
    "image_gen.generation": ("inputImages", "transparentBackground"),
    "web.search": ("query", "action"),
}
RESPONSE_OUTPUT_FIELDS = {
    "function_call_output": ("output",),
    "custom_tool_call_output": ("output",),
    "tool_search_output": ("tools",),
    "FunctionCallOutput": ("output",),
    "image_generation_call": ("revised_prompt",),
    "message": ("content",),
    "Message": ("content",),
}
EVENT_OUTPUT_FIELDS = {
    "exec_command_end": ("stdout", "stderr", "aggregated_output"),
    "patch_apply_end": ("stdout", "stderr"),
    "mcp_tool_call_end": ("result", "error"),
    "dynamic_tool_call_response": ("content_items", "error"),
    "web_search_end": ("results",),
    "image_generation_end": ("revised_prompt",),
}
ITEM_OUTPUT_FIELDS = {
    "CommandExecution": EVENT_OUTPUT_FIELDS["exec_command_end"],
    "FileChange": EVENT_OUTPUT_FIELDS["patch_apply_end"],
    "McpToolCall": EVENT_OUTPUT_FIELDS["mcp_tool_call_end"],
    "DynamicToolCall": EVENT_OUTPUT_FIELDS["dynamic_tool_call_response"],
    "WebSearch": ("results",),
    "FunctionCallOutput": ("output",),
    "CollabAgentToolCall": ("agents_states",),
    "ImageGeneration": ("revised_prompt",),
    "message": ("content",),
    "Message": ("content",),
}
EXTENSION_OUTPUT_FIELDS = {
    "image_gen.generation": ("revisedPrompt",),
    "web.search": ("results",),
}
MCP_OUTPUTS = {"mcp_tool_call_end", "McpToolCall"}
NAMES = {
    "tool_search_call": "tool_search",
    "tool_search_output": "tool_search",
    "CommandExecution": "exec_command",
    "exec_command_begin": "exec_command",
    "exec_command_end": "exec_command",
    "local_shell_call": "exec_command",
    "view_image_tool_call": "view_image",
    "ImageView": "view_image",
    "FileChange": "apply_patch",
    "patch_apply_begin": "apply_patch",
    "patch_apply_updated": "apply_patch",
    "patch_apply_end": "apply_patch",
    "WebSearch": "web_search",
    "web_search_call": "web_search",
    "web_search_begin": "web_search",
    "web_search_end": "web_search",
    "image_generation_call": "image_gen",
    "image_generation_begin": "image_gen",
    "image_generation_end": "image_gen",
    "ImageGeneration": "image_gen",
    "image_gen.generation": "image_gen",
    "web.search": "web_search",
    "user_shell_command": "exec_command",
    "collab_agent_spawn_begin": "spawn_agent",
    "collab_agent_spawn_end": "spawn_agent",
}
ID_PREFIX = {"input": "in", "output": "out"}
RECORD_ID = re.compile(r"(in|out):([a-f0-9]{24}):([1-9][0-9]{0,18}):([a-f0-9]{24})")
TOOL_CURSOR_VERSION = 0x10
TOOL_CURSOR_PREFIX = "t."
CURSOR_OUTPUT = 0x01
CURSOR_RANGE = 0x02
CURSOR_FIXED_BYTES = 1 + 12 + 12 + 16  # Header, source ID, item ID, row revision.
CURSOR_MAX_INTS = 6
CURSOR_CHARS = re.compile(r"[A-Za-z0-9_-]+")
METADATA_LABEL = re.compile(r"[a-zA-Z0-9_.:/+@-]{1,256}", re.ASCII)
_MISSING = object()
POINTER_ESCAPE = re.compile(r"~(?![01])")
POINTER_INDEX = re.compile(r"0|[1-9][0-9]*")
POINTER_DATA_URL = re.compile(
    r"""(?<![a-z0-9_+.-])data:[^\s"'<>;,]*(?:;[^\s"'<>;,]+)*,[^\s"'<>]*""",
    re.IGNORECASE | re.ASCII,
)


def _append_uint(target: bytearray, value: int) -> None:
    while value >= 128:
        target.append((value & 127) | 128)
        value >>= 7
    target.append(value)


def _cursor_uints(raw: bytes) -> Iterator[int]:
    value = shift = 0
    for byte in raw[CURSOR_FIXED_BYTES:]:
        if shift == 63 and byte > 1:
            raise ValueError("tool cursor contains an oversized integer")
        value |= (byte & 127) << shift
        if byte & 128:
            shift += 7
        else:
            if shift and not byte:
                raise ValueError("tool cursor contains a non-canonical integer")
            yield value
            value = shift = 0
    if shift:
        raise ValueError("tool cursor ends inside an integer")


@dataclass(frozen=True)
class ToolCursor:
    identifier: str
    budget_chars: int
    lines: int
    line_range: tuple[int, int] | None
    position: tuple[int, int]
    revision: str

    def encode(self) -> str:
        kind, source, line, identity = self.identifier.split(":")
        header = TOOL_CURSOR_VERSION
        if kind == ID_PREFIX["output"]:
            header |= CURSOR_OUTPUT
        if self.line_range is not None:
            header |= CURSOR_RANGE
        raw = bytearray([header])
        raw.extend(bytes.fromhex(source + identity + self.revision))
        _append_uint(raw, int(line))
        # A page cannot contain more lines or characters than Python can address.
        selections = self.line_range or (self.lines,)
        for value in (*selections, self.budget_chars):
            _append_uint(raw, min(value, sys.maxsize))
        for value in self.position:
            _append_uint(raw, value)
        return TOOL_CURSOR_PREFIX + base64.urlsafe_b64encode(raw).rstrip(b"=").decode(
            "ascii"
        )


def parse_tool_cursor(token: str, *, direction: str) -> ToolCursor:
    max_chars = (4 * (CURSOR_FIXED_BYTES + 10 * CURSOR_MAX_INTS) + 2) // 3
    encoded = token.removeprefix(TOOL_CURSOR_PREFIX)
    if (
        encoded == token
        or len(encoded) > max_chars
        or len(encoded) % 4 == 1
        or not CURSOR_CHARS.fullmatch(encoded)
    ):
        raise ValueError(f"expected next_cursor from tool-{direction}")
    raw = base64.b64decode(
        encoded + "=" * (-len(encoded) % 4), altchars=b"-_", validate=True
    )
    if (
        len(raw) < CURSOR_FIXED_BYTES + 5
        or raw[0] & ~(CURSOR_OUTPUT | CURSOR_RANGE) != TOOL_CURSOR_VERSION
        or base64.urlsafe_b64encode(raw).rstrip(b"=").decode("ascii") != encoded
    ):
        raise ValueError(f"expected next_cursor from tool-{direction}")
    values = tuple(_cursor_uints(raw))
    has_range = bool(raw[0] & CURSOR_RANGE)
    if len(values) != 5 + has_range:
        raise ValueError(f"expected next_cursor from tool-{direction}")
    line, first, *selection, budget, field, offset = values
    prefix = ID_PREFIX["output" if raw[0] & CURSOR_OUTPUT else "input"]
    identifier = f"{prefix}:{raw[1:13].hex()}:{line}:{raw[13:25].hex()}"
    _parse_id(identifier, direction)
    if not first or not budget or (selection and selection[0] < first):
        raise ValueError(
            f"expected next_cursor from tool-{direction} with valid limits"
        )
    return ToolCursor(
        identifier,
        budget,
        20 if selection else first,
        (first, selection[0]) if selection else None,
        (field, offset),
        raw[25:CURSOR_FIXED_BYTES].hex(),
    )


@lru_cache(maxsize=32)
def _source_id(source: Path) -> str:
    canonical = os.path.normcase(os.path.abspath(source)).removesuffix(".zst")
    return hashlib.sha256(os.fsencode(canonical)).hexdigest()[:24]


def _input_value(item: dict, field: str, default: object = None) -> object:
    if field == "invocation.arguments":
        invocation = item.get("invocation")
        return (
            invocation.get("arguments", default)
            if isinstance(invocation, dict)
            else default
        )
    return item.get(field, default)


def _tool_record(row: dict, direction: str) -> tuple[str, dict, tuple[str, ...]] | None:
    kind = row.get("type")
    item = row.get("payload")
    if not isinstance(item, dict):
        return None
    is_input = direction == "input"
    if kind == "response_item":
        allowed = RESPONSE_INPUT_FIELDS if is_input else RESPONSE_OUTPUT_FIELDS
    elif kind == "event_msg" and (
        item.get("type") == "item_completed"
        or (is_input and item.get("type") == "item_started")
    ):
        item = item.get("item")
        allowed = ITEM_INPUT_FIELDS if is_input else ITEM_OUTPUT_FIELDS
    elif kind == "event_msg":
        allowed = EVENT_INPUT_FIELDS if is_input else EVENT_OUTPUT_FIELDS
    else:
        return None
    if not isinstance(item, dict) or not isinstance(item_type := item.get("type"), str):
        return None
    if item_type in {"message", "Message"}:
        role = item.get("role")
        if role == "user":
            if any(
                not is_input or _shell_boundary(body) is not None
                for _, body in user_shell_parts(item)
            ):
                return "user_shell_command", item, ("content",)
            return None
        if role not in ("tool", "function"):
            return None
    if item_type == "Extension" and (
        allowed is ITEM_INPUT_FIELDS or allowed is ITEM_OUTPUT_FIELDS
    ):
        item_type = item.get("kind")
        if not isinstance(item_type, str):
            return None
        allowed = EXTENSION_INPUT_FIELDS if is_input else EXTENSION_OUTPUT_FIELDS
    if item_type in allowed:
        fields = allowed[item_type]
        if any(_input_value(item, field, _MISSING) is not _MISSING for field in fields):
            return item_type, item, fields
        if is_input:
            return item_type, item, ()
    return None


def _metadata(
    source: Path,
    line: int,
    row: dict,
    item_type: str,
    item: dict,
    direction: str,
    *,
    has_body: bool,
) -> dict:
    native_id = item.get("id")
    call_id = item.get("call_id")
    invocation = item.get("invocation")
    tool = invocation if isinstance(invocation, dict) else item
    metadata = {}
    for key, value in (
        ("call_id", call_id),
        ("item_id", native_id),
        ("tool_name", tool.get("tool") or tool.get("name") or NAMES.get(item_type)),
        ("tool_server", tool.get("server")),
        ("tool_namespace", tool.get("namespace")),
        ("tool_status", item.get("status")),
    ):
        if isinstance(value, str) and METADATA_LABEL.fullmatch(value):
            metadata[key] = value
    for key, value_type in (("success", bool), ("exit_code", int)):
        if type(value := item.get(key)) is value_type:
            metadata[key] = value
    if not has_body:
        return metadata
    identity = [
        row.get("type"),
        item_type,
        row.get("timestamp"),
        row.get("ordinal"),
        native_id if isinstance(native_id, str) else None,
        call_id if isinstance(call_id, str) else None,
    ]
    fingerprint = hashlib.sha256(json.dumps(identity).encode("ascii")).hexdigest()[:24]
    prefix = ID_PREFIX[direction]
    return {
        f"{direction}_id": f"{prefix}:{_source_id(source)}:{line}:{fingerprint}",
        **metadata,
    }


def tool_record_metadata(
    source: Path, line: int, row: dict, *, direction: str
) -> dict | None:
    """Return identifying metadata without exposing the tool payload."""
    record = _tool_record(row, direction)
    if record is not None:
        item_type, item, fields = record
        return _metadata(
            source, line, row, item_type, item, direction, has_body=bool(fields)
        )


def _parse_id(identifier: str, direction: str) -> tuple[str, int]:
    match = RECORD_ID.fullmatch(identifier)
    if match is None or match[1] != ID_PREFIX[direction]:
        raise ValueError(f"expected a tool {direction} ID from rollout search or read")
    return match[2], int(match[3])


def tool_record_target(
    sources: Iterable[Path], identifier: str, *, direction: str
) -> tuple[Path, int] | None:
    """Resolve the physical line of an ID before opening or decoding that record."""
    source_id, line = _parse_id(identifier, direction)
    for source in sources:
        if _source_id(source) == source_id:
            return source, line
    return None


def _mcp_result(result: object, field: str) -> Iterator[TextField]:
    if not isinstance(result, dict):
        return
    if "Err" in result:
        yield from _tool_values(result["Err"], f"{field}.error")
    else:
        result = result.get("Ok", result)
        if isinstance(result, dict):
            yield from _parts(
                result.get("content"), f"{field}.content", tool_output=True
            )
            yield from _values(
                result.get("structuredContent"), f"{field}.structuredContent"
            )


def _shell_boundary(text: str) -> re.Match[str] | None:
    if text.startswith(USER_SHELL_PREFIX) and text.endswith(USER_SHELL_SUFFIX):
        return USER_SHELL_RESULT.search(text, len(USER_SHELL_PREFIX))
    return None


def _record_fields(
    item_type: str, item: dict, fields: tuple[str, ...], direction: str
) -> Iterator[TextField]:
    if item_type == "user_shell_command":
        for index, body in user_shell_parts(item):
            boundary = _shell_boundary(body)
            location = f"content[{index}]"
            if direction == "input":
                if boundary is not None:
                    yield (
                        f"{location}.command",
                        body[len(USER_SHELL_PREFIX) : boundary.start()],
                    )
            elif boundary is None:
                yield f"{location}.text", body
            else:
                result_start = boundary.start() + len("\n</command>\n<result>\n")
                yield f"{location}.result", body[result_start : -len(USER_SHELL_SUFFIX)]
    elif direction == "input":
        for field in fields:
            project = _tool_values if field.endswith("arguments") else _values
            yield from project(_input_value(item, field), field)
    else:
        yield from _output_fields(item_type, item, fields)


def _output_fields(
    item_type: str, item: dict, fields: tuple[str, ...]
) -> Iterator[TextField]:
    if item_type in MCP_OUTPUTS:
        yield from _mcp_result(item.get("result"), "result")
        error = item.get("error")
        if isinstance(error, dict):
            yield from _values(error.get("message"), "error.message")
            yield from _mcp_result(error.get("result"), "error.result")
        else:
            yield from _values(error, "error")
        return
    for field in fields:
        value = item.get(field)
        if field in {"output", "content_items", "content"} and isinstance(value, list):
            yield from _parts(value, field, tool_output=True)
        elif field in {"output", "content"}:
            yield from _tool_values(value, field)
        else:
            yield from _values(value, field)


def _selected_tool_record(
    rows: Iterable[tuple[Path, int, dict]], identifier: str, direction: str
) -> tuple[str, dict, tuple[str, ...], str | None, dict]:
    source_id, line_number = _parse_id(identifier, direction)
    for source, line, row in rows:
        if line != line_number or _source_id(source) != source_id:
            continue
        record = _tool_record(row, direction)
        if record is None:
            break
        item_type, item, fields = record
        if not fields:
            break
        metadata = _metadata(
            source, line, row, item_type, item, direction, has_body=True
        )
        if metadata[f"{direction}_id"] != identifier:
            break
        context = {
            "rollout": source.name,
            "path": str(source),
            "line": line,
            "kind": row.get("type"),
            "item_type": item_type,
            "role": "tool",
            "timestamp": row.get("timestamp"),
            **row.get("_rollout_provenance", {}),
            **({"turn_id": turn} if (turn := row.get("_rollout_turn_id")) else {}),
            **metadata,
        }
        return item_type, item, fields, row.get("_rollout_revision"), context
    raise ValueError(
        f"tool {direction} ID is stale or outside the selected rollout scope"
    )


@dataclass(frozen=True)
class _ToolContent:
    """Keep block indexing stable while projecting only readable protocol fields."""

    blocks: list

    def at(self, index: int) -> object:
        block = self.blocks[index]
        if not isinstance(block, dict):
            return _MISSING
        kind = block.get("type")
        if not isinstance(kind, str):
            return _MISSING
        if kind in TEXT_PARTS:
            part = {"type": kind, **_present(block, ("text",))}
            if "text" in part:
                part["text"] = _embedded_tool_json(part["text"])
            return part
        if kind in PATH_PARTS:
            return {"type": kind, **_present(block, ("path",))}
        if kind in {"image", "input_image", "inputImage"}:
            reference = (
                block.get("image_url") or block.get("imageUrl") or block.get("url")
            )
            if isinstance(reference, str) and LOCAL_REFERENCE.match(reference):
                return {"path": reference}
        if kind == "resource" and isinstance(resource := block.get("resource"), dict):
            return {
                "type": kind,
                "resource": _present(resource, ("uri", "mimeType", "text")),
            }
        if kind == "resource_link":
            return {
                "type": kind,
                **_present(
                    block, ("uri", "name", "title", "description", "mimeType", "size")
                ),
            }
        return _MISSING


def _present(value: dict, keys: tuple[str, ...]) -> dict:
    return {key: value[key] for key in keys if key in value}


def _embedded_tool_json(value: object, *, parse_scalar: bool = False) -> object:
    if isinstance(value, str) and (
        parse_scalar or value.lstrip().startswith(("{", "["))
    ):
        try:
            return json.loads(value)
        except (ValueError, RecursionError):
            pass
    return value


def _mcp_json(value: object) -> object:
    if not isinstance(value, dict):
        return value
    if "Err" in value:
        return {"error": value["Err"]}
    value = value.get("Ok", value)
    if not isinstance(value, dict):
        return value
    result = _present(value, ("structuredContent", "content"))
    if isinstance(is_error := value.get("isError"), bool):
        result["isError"] = is_error
    if isinstance(content := result.get("content"), list):
        result["content"] = _ToolContent(content)
    return result


def _tool_json_root(
    item_type: str, item: dict, fields: tuple[str, ...], direction: str
) -> dict:
    if item_type == "user_shell_command":
        raise ValueError(
            "manual shell records have no structured value; use the line view"
        )
    root = {}
    for field in fields:
        value = _input_value(item, field, _MISSING)
        if value is _MISSING:
            continue
        key = field.removeprefix("invocation.")
        if key in root:
            continue
        if direction == "output" and item_type in MCP_OUTPUTS:
            if field == "result":
                value = _mcp_json(value)
            elif isinstance(value, dict):
                value = _present(value, ("message", "result"))
                if "result" in value:
                    value["result"] = _mcp_json(value["result"])
        elif (
            direction == "output"
            and field in {"output", "content_items", "content"}
            and isinstance(value, list)
        ):
            value = _ToolContent(value)
        elif item_type == "function_call" and key == "arguments":
            value = _embedded_tool_json(value, parse_scalar=True)
        elif direction == "output" and field in {"output", "content"}:
            value = _embedded_tool_json(value)
        root[key] = value
    return root


def _hidden_tool_key(key: str) -> bool:
    lower = key.lower()
    return (
        lower in BINARY_KEYS
        or lower == "internal_chat_message_metadata_passthrough"
        or lower.startswith(("_rollout_", "encrypted"))
        or lower.endswith("base64")
        or POINTER_DATA_URL.search(key) is not None
    )


def _hidden_tool_value(value: object) -> bool:
    if value is _MISSING:
        return True
    if isinstance(value, dict):
        kind = value.get("type")
        return isinstance(kind, str) and (
            kind in BINARY_PARTS or kind.lower().startswith("encrypted")
        )
    return False


def _pointer_value(root: dict, pointer: str) -> object:
    if not pointer:
        return root
    if not pointer.startswith("/") or POINTER_ESCAPE.search(pointer):
        raise ValueError(
            "invalid JSON Pointer; start with / and escape ~ as ~0 and / as ~1"
        )
    value: object = root
    for token in pointer[1:].split("/"):
        key = token.replace("~1", "/").replace("~0", "~")
        if isinstance(value, dict) and not _hidden_tool_key(key):
            value = value.get(key, _MISSING)
        elif isinstance(value, (list, _ToolContent)) and POINTER_INDEX.fullmatch(key):
            size = len(value if isinstance(value, list) else value.blocks)
            if len(key) > len(str(size)) or (index := int(key)) >= size:
                value = _MISSING
            elif isinstance(value, list):
                value = value[index]
            else:
                value = value.at(index)
        else:
            value = _MISSING
        if _hidden_tool_value(value):
            raise ValueError("JSON Pointer does not select a visible tool value")
    return value


def _bounded_tool_value(value: object, budget_chars: int) -> object:
    def spend(size: int) -> None:
        nonlocal budget_chars
        budget_chars -= size
        if budget_chars < 0:
            raise ValueError(
                "tool value exceeds --budget-chars; select a narrower JSON Pointer "
                "or increase --budget-chars"
            )

    def scalar(node: object) -> object:
        if isinstance(node, str):
            node = POINTER_DATA_URL.sub("[data URL omitted]", node)
            if len(node) > budget_chars:
                spend(len(node))
        elif isinstance(node, float) and not math.isfinite(node):
            node = None
        spend(len(json.dumps(node, ensure_ascii=False)))
        return node

    def clean(node: object) -> object:
        if isinstance(node, dict):
            spend(2)
            result = {}
            for key, child in node.items():
                if _hidden_tool_key(key) or _hidden_tool_value(child):
                    continue
                spend(1 + bool(result))
                scalar(key)
                result[key] = clean(child)
            return result
        if isinstance(node, (list, _ToolContent)):
            spend(2)
            children = (
                node
                if isinstance(node, list)
                else (node.at(i) for i in range(len(node.blocks)))
            )
            result = []
            for child in children:
                spend(bool(result))
                result.append(clean(None if _hidden_tool_value(child) else child))
            return result
        return scalar(node)

    try:
        return clean(value)
    except RecursionError as error:
        raise ValueError(
            "tool value is deeply nested; select a narrower JSON Pointer"
        ) from error


def read_tool_value(
    rows: Iterable[tuple[Path, int, dict]],
    identifier: str,
    *,
    direction: str,
    pointer: str,
    budget_chars: int = 4000,
) -> dict:
    """Read one typed, bounded value from an exact tool record."""
    if budget_chars < 1:
        raise ValueError("budget_chars must be positive")
    item_type, item, fields, _, context = _selected_tool_record(
        rows, identifier, direction
    )
    root = _tool_json_root(item_type, item, fields, direction)
    return {
        **context,
        "pointer": pointer,
        "value": _bounded_tool_value(_pointer_value(root, pointer), budget_chars),
    }


def read_tool_record(
    rows: Iterable[tuple[Path, int, dict]],
    identifier: str,
    *,
    direction: str,
    budget_chars: int = 4000,
    lines: int = 20,
    line_range: tuple[int, int] | None = None,
    cursor: ToolCursor | None = None,
) -> dict:
    """Read one exact tool payload, continuing within a field when needed."""
    if cursor is not None:
        if cursor.identifier != identifier:
            raise ValueError(f"cursor does not match the requested tool {direction} ID")
        budget_chars = cursor.budget_chars
        lines = cursor.lines
        line_range = cursor.line_range
    if min(budget_chars, lines) < 1:
        raise ValueError("budget_chars and lines must be positive")
    if line_range is not None:
        first_line, last_line = line_range
        if first_line < 1 or last_line < first_line:
            raise ValueError("line_range must be a positive inclusive range")

    item_type, item, fields, revision, context = _selected_tool_record(
        rows, identifier, direction
    )
    if cursor is not None and cursor.revision != revision:
        raise ValueError(f"tool {direction} cursor is stale: rollout record changed")
    text_fields = _text_fields(
        _record_fields(item_type, item, fields, direction), keep_whitespace=True
    )
    page, next_position = _field_page(
        text_fields,
        budget_chars,
        lines,
        cursor.position if cursor is not None else None,
        line_range,
    )
    next_cursor = None
    if cursor is not None and not page:
        raise ValueError("cursor is outside the requested tool record scope")
    if next_position is not None:
        if revision is None:
            raise ValueError(f"tool {direction} record is missing its rollout revision")
        next_cursor = ToolCursor(
            identifier,
            budget_chars,
            lines,
            line_range,
            next_position,
            revision,
        ).encode()
    return {
        **context,
        "fields": page,
        "truncated": next_cursor is not None,
        "next_cursor": next_cursor,
    }


def _skip_text_lines(text: str, count: int) -> tuple[int, int]:
    offset = 0
    while count and offset < len(text):
        separator = text.find("\n", offset)
        offset = separator + 1 if separator >= 0 else len(text)
        count -= 1
    return offset, count


def _field_page(
    fields: Iterable[TextField],
    remaining_chars: int,
    remaining_lines: int,
    position: tuple[int, int] | None,
    line_range: tuple[int, int] | None,
) -> tuple[list[dict], tuple[int, int] | None]:
    first_field, offset = position or (0, 0)
    skip_lines = 0
    if line_range is not None:
        first_line, last_line = line_range
        remaining_lines = last_line - first_line + 1
        skip_lines = first_line - 1
    page = []
    for index, (field, text) in enumerate(fields):
        start = 0
        if skip_lines:
            start, skip_lines = _skip_text_lines(text, skip_lines)
            if start == len(text):
                continue
        if index < first_field:
            if line_range is not None:
                remaining_lines -= text.count("\n", start) + (not text.endswith("\n"))
                if remaining_lines <= 0:
                    break
            continue
        if position is not None and not page:
            if index != first_field or not start <= offset < len(text):
                break
            if line_range is not None:
                remaining_lines -= text.count("\n", start, offset)
                if remaining_lines <= 0:
                    break
            start = offset
        bound = min(start + remaining_chars, len(text))
        end = start
        while remaining_lines and end < bound:
            separator = text.find("\n", end, bound)
            if separator != -1:
                end = separator + 1
            elif bound == len(text):
                end = bound
            else:
                # Only split a line if it cannot fit on an empty page.
                if not page and end == start:
                    end = bound
                break
            remaining_lines -= 1
        if end > start:
            page.append(
                {
                    "field": field,
                    "field_index": index,
                    "text": text[start:end],
                    "text_offset": start,
                    "text_total_chars": len(text),
                }
            )
        if line_range is not None and not remaining_lines:
            break
        if end < len(text):
            return page, (index, end)
        remaining_chars -= end - start
    return page, None
