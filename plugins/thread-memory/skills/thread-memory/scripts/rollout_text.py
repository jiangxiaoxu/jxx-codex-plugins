"""Project human-readable fields without expanding inline media or encrypted data."""

from __future__ import annotations

import json
import re
from collections.abc import Iterable, Iterator

TextField = tuple[str, str]

DATA_URL = re.compile(
    r"data:[^\s\"'<>;,]*(?:;[^\s\"'<>;,]+)*;base64,[a-z0-9+/=_-]*",
    re.IGNORECASE | re.ASCII,
)
LOCAL_REFERENCE = re.compile(r"^(?:file:|[a-z]:[/\\]|[/\\])", re.IGNORECASE)
BINARY_KEYS = {
    "base64",
    "b64_json",
    "image_url",
    "imageurl",
    "audio_url",
    "audiourl",
    "raw_content",
    "_meta",
    "blob",
}
BINARY_PARTS = {
    "image",
    "audio",
    "input_image",
    "inputImage",
    "input_audio",
    "inputAudio",
    "encrypted_content",
}
TEXT_PARTS = {"input_text", "inputText", "output_text", "text", "Text", "summary_text"}
PATH_PARTS = {"local_image", "local_audio"}
USER_SHELL_PREFIX = "<user_shell_command>\n<command>\n"
USER_SHELL_SUFFIX = "\n</result>\n</user_shell_command>"
USER_SHELL_RESULT = re.compile(
    r"\n</command>\n<result>\nExit code: -?[0-9]+\n"
    r"Duration: [0-9]+(?:\.[0-9]+)? seconds\nOutput:\n"
)


def is_user_shell_part(text: object, kind: object = None) -> bool:
    """Recognize an annotated shell fragment or its complete legacy envelope."""
    if not isinstance(text, str):
        return False
    if kind == "shell.user_command":
        return True
    if isinstance(kind, str) and kind not in ("", "unknown"):
        return False
    return (
        text.startswith(USER_SHELL_PREFIX)
        and text.endswith(USER_SHELL_SUFFIX)
        and USER_SHELL_RESULT.search(text, len(USER_SHELL_PREFIX)) is not None
    )


def user_shell_parts(item: dict) -> Iterator[tuple[int, str]]:
    """Yield shell text at its original content index without copying other parts."""
    content = item.get("content")
    if not isinstance(content, list):
        return
    metadata = item.get("internal_chat_message_metadata_passthrough")
    kinds = metadata.get("content_item_kinds") if isinstance(metadata, dict) else None
    for index, part in enumerate(content):
        if not isinstance(part, dict) or part.get("type") != "input_text":
            continue
        kind = kinds[index] if isinstance(kinds, list) and index < len(kinds) else None
        text = part.get("text")
        if is_user_shell_part(text, kind):
            yield index, text


def omit_data_urls(text: str) -> str:
    return DATA_URL.sub("[data URL omitted]", text)


def _values(value: object, field: str) -> Iterator[TextField]:
    if isinstance(value, str):
        if value:
            yield field, value
    elif isinstance(value, list):
        for index, part in enumerate(value):
            yield from _values(part, f"{field}[{index}]")
    elif isinstance(value, dict):
        kind = value.get("type")
        if isinstance(kind, str) and kind in BINARY_PARTS:
            return
        for key, part in value.items():
            key_lower = key.lower()
            if (
                key_lower in BINARY_KEYS
                or key_lower.startswith("encrypted")
                or key_lower.endswith("base64")
            ):
                continue
            # Keep large or encoded user-provided keys out of result field names.
            name = key if len(key) <= 80 and not DATA_URL.search(key) else "[key]"
            yield from _values(part, f"{field}.{name}")
    elif isinstance(value, (bool, int, float)):
        yield field, json.dumps(value)


def _tool_values(value: object, field: str) -> Iterator[TextField]:
    if isinstance(value, str) and value.lstrip().startswith(("{", "[")):
        try:
            value = json.loads(value)
        except (ValueError, RecursionError):
            pass
    yield from _values(value, field)


def _parts(
    parts: object, field: str, *, tool_output: bool = False
) -> Iterator[TextField]:
    if not isinstance(parts, list):
        return
    for index, part in enumerate(parts):
        if not isinstance(part, dict):
            continue
        kind = part.get("type")
        if not isinstance(kind, str):
            continue
        location = f"{field}[{index}]"
        if kind in TEXT_PARTS:
            project_text = _tool_values if tool_output else _values
            yield from project_text(part.get("text"), f"{location}.text")
        elif kind in PATH_PARTS:
            yield from _values(part.get("path"), f"{location}.path")
        elif kind in {"image", "input_image", "inputImage"}:
            reference = part.get("image_url") or part.get("imageUrl") or part.get("url")
            if isinstance(reference, str) and LOCAL_REFERENCE.match(reference):
                yield f"{location}.image_url", reference
        elif tool_output and kind == "resource":
            resource = part.get("resource")
            if isinstance(resource, dict):
                for key in ("uri", "mimeType", "text"):
                    yield from _values(resource.get(key), f"{location}.resource.{key}")
        elif tool_output and kind == "resource_link":
            for key in ("uri", "name", "title", "description", "mimeType", "size"):
                yield from _values(part.get(key), f"{location}.{key}")


def _text_fields(
    fields: Iterable[TextField], *, keep_whitespace: bool = False
) -> Iterator[TextField]:
    for field, value in fields:
        # Undecoded media in free-form tool text can coexist with readable text.
        text = omit_data_urls(value)
        if text and (keep_whitespace or text.strip()):
            yield field[:256], text
