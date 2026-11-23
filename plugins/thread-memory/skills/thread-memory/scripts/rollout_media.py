"""Browse and selectively export attachments from local rollouts."""

from __future__ import annotations

import base64
import hashlib
import json
import os
import re
import tempfile
from collections import defaultdict
from collections.abc import Iterable, Iterator
from itertools import chain
from pathlib import Path

from rollout_recover import local_image_records, local_path
from rollout_recovery_images import (
    IMAGE_DATA_HEADER,
    export_inline_image,
    export_local_images,
    image_parts,
    inline_media_digest,
    validate_image_size,
)
from rollout_search import RolloutRow
from rollout_source import rollout_id
from rollout_text import omit_data_urls

IMAGE_MIME = re.compile(r"image/[a-z0-9.+-]+", re.IGNORECASE | re.ASCII)
AUDIO_DATA_HEADER = re.compile(
    r"data:(audio/[a-z0-9.+-]+);base64,", re.IGNORECASE | re.ASCII
)
AUDIO_MIME = re.compile(r"audio/[a-z0-9.+-]+", re.IGNORECASE | re.ASCII)
AUDIO_SUFFIXES = {
    "audio/aac": ".aac",
    "audio/flac": ".flac",
    "audio/mp4": ".m4a",
    "audio/mpeg": ".mp3",
    "audio/ogg": ".ogg",
    "audio/wav": ".wav",
    "audio/wave": ".wav",
    "audio/webm": ".webm",
    "audio/x-wav": ".wav",
}
URI_SCHEME = re.compile(r"^[a-z][a-z0-9+.-]*:", re.IGNORECASE | re.ASCII)
IMAGE_SUFFIXES = {
    ".png",
    ".jpg",
    ".jpeg",
    ".webp",
    ".gif",
    ".bmp",
    ".tif",
    ".tiff",
    ".avif",
}


def _source_id(path: Path) -> str:
    identifier = rollout_id(path)
    if identifier:
        return identifier
    normalized = os.path.normcase(os.path.abspath(path)).removesuffix(".zst")
    return hashlib.sha256(os.fsencode(normalized)).hexdigest()[:24]


def _target_lines(ids: Iterable[str], prefix: str) -> dict[str, set[int]]:
    result: dict[str, set[int]] = defaultdict(set)
    for identifier in ids:
        fields = identifier.split(":", 5)
        if len(fields) != 6 or fields[0] != prefix:
            continue
        _, source_id, line, _, _, fingerprint = fields
        if re.fullmatch(r"[1-9][0-9]{0,18}", line) and re.fullmatch(
            r"[a-f0-9]{24}", fingerprint
        ):
            result[source_id].add(int(line))
    return dict(result)


def image_target_lines(
    sources: Iterable[Path], ids: Iterable[str]
) -> dict[Path, set[int]]:
    """Resolve the physical lines named by the requested image IDs."""
    targets = _target_lines(ids, "img")
    return {
        path: targets[identifier]
        for path in sources
        if (identifier := _source_id(path)) in targets
    }


def audio_target_lines(
    sources: Iterable[Path], ids: Iterable[str]
) -> dict[Path, set[int]]:
    """Resolve the physical lines named by the requested audio IDs."""
    targets = _target_lines(ids, "aud")
    return {
        path: targets[identifier]
        for path in sources
        if (identifier := _source_id(path)) in targets
    }


def _array(value: object) -> list:
    return value if isinstance(value, list) else []


def _items(row: dict) -> Iterator[tuple[str, int | None, dict]]:
    payload = row.get("payload")
    if not isinstance(payload, dict):
        return
    if row.get("type") == "compacted":
        for index, item in enumerate(_array(payload.get("replacement_history"))):
            if isinstance(item, dict):
                yield f"c{index}", index, item
    elif row.get("type") in ("response_item", "event_msg"):
        yield "r", None, payload


def _parts(item: dict) -> Iterable[dict]:
    """Read media-bearing parts, preserving their native positions."""
    kind = item.get("type")
    if kind == "UserMessage":
        return _array(item.get("content"))
    if kind == "FunctionCallOutput":
        return _array(item.get("output"))
    if kind == "user_message":
        return [
            {"type": "image", "image_url": url} for url in _array(item.get("images"))
        ] + [
            {"type": "image", "file_id": file_id}
            for file_id in _array(item.get("file_ids"))
        ]
    if kind in ("image_generation_call", "ImageGeneration", "image_generation_end"):
        return [
            {
                "type": "image",
                "file_id": item.get("fileId") or item.get("file_id"),
                "data": item.get("result"),
            }
        ]
    if kind in ("McpToolCall", "mcp_tool_call_end"):
        result = item.get("result")
        if isinstance(result, dict):
            result = result.get("Ok", result)
            if isinstance(result, dict):
                return _array(result.get("content"))
        return []
    if kind in ("DynamicToolCall", "dynamic_tool_call_response"):
        return _array(item.get("content_items"))
    return image_parts(item)


def _part_source(part: dict, cwd: Path | None) -> tuple[dict, str | Path | None]:
    url = part.get("imageUrl" if part.get("type") == "inputImage" else "image_url")
    file_id = part.get("file_id")
    if isinstance(file_id, str) and file_id:
        return {"kind": "reference", "reference": omit_data_urls(file_id)}, file_id
    if isinstance(url, str) and url[:5].lower() == "data:":
        header = IMAGE_DATA_HEADER.match(url)
        media_type = header.group(1).lower() if header else "application/octet-stream"
        return {"kind": "inline", "media_type": media_type}, url
    data = part.get("data")
    if isinstance(data, str) and data:
        mime = part.get("mimeType")
        media_type = (
            mime.lower()
            if isinstance(mime, str) and IMAGE_MIME.fullmatch(mime)
            else "image/unknown"
        )
        if data[:5].lower() == "data:" and (header := IMAGE_DATA_HEADER.match(data)):
            media_type = header.group(1).lower()
        return {"kind": "inline", "media_type": media_type}, data
    if isinstance(url, str) and url:
        path = local_path(url)
        if (
            path is None
            and not URI_SCHEME.match(url)
            and (cwd is not None or Path(url).suffix.lower() in IMAGE_SUFFIXES)
        ):
            return {"kind": "local", "path": url}, local_path(url, cwd)
        if path is not None:
            return {"kind": "local", "path": url}, path
        return {"kind": "reference", "reference": omit_data_urls(url)}, url
    return {}, None


def _media_digest(image: dict, raw: str | Path | None) -> str:
    kind = image["kind"]
    if kind == "inline":
        assert isinstance(raw, str)
        return inline_media_digest(raw, image["media_type"])
    value = (
        [image["path"], str(raw) if raw is not None else None]
        if kind == "local"
        else raw
    )
    return hashlib.sha256(f"{kind}:{json.dumps(value)}".encode("ascii")).hexdigest()


def _audio_source(part: dict, cwd: Path | None) -> tuple[dict, str | Path | None]:
    kind = part.get("type")
    if kind == "local_audio":
        name = part.get("path")
        if isinstance(name, str) and name and name[:5].lower() != "data:":
            return {"kind": "local", "path": name}, local_path(name, cwd)
        return {}, None
    if kind not in ("audio", "input_audio", "inputAudio"):
        return {}, None
    if isinstance(file_id := part.get("file_id"), str) and file_id:
        return {"kind": "reference", "reference": omit_data_urls(file_id)}, file_id
    url = part.get("audioUrl" if kind == "inputAudio" else "audio_url")
    if isinstance(url, str) and url:
        if url[:5].lower() == "data:":
            header = AUDIO_DATA_HEADER.match(url)
            media_type = header.group(1).lower() if header else "audio/unknown"
            return {"kind": "inline", "media_type": media_type}, url
        if path := local_path(url):
            return {"kind": "local", "path": url}, path
        return {"kind": "reference", "reference": omit_data_urls(url)}, url
    if kind == "audio" and isinstance(data := part.get("data"), str) and data:
        mime = part.get("mimeType")
        media_type = (
            mime.lower()
            if isinstance(mime, str) and AUDIO_MIME.fullmatch(mime)
            else "audio/unknown"
        )
        return {"kind": "inline", "media_type": media_type}, data
    return {}, None


def _legacy_audio_parts(item: dict) -> Iterator[dict]:
    # Older events can carry the full ordered reference list alongside legacy URLs.
    references = _array(item.get("audio_references"))
    inline = _array(item.get("audio"))
    order = _array(item.get("audio_order"))
    urls = iter(inline)
    files = iter(references)
    if (
        order
        and len(order) == len(inline) + len(references)
        and order.count("inline") == len(inline)
        and order.count("file") == len(references)
        and all(isinstance(ref, dict) and "file_id" in ref for ref in references)
    ):
        for kind in order:
            if kind == "inline":
                yield {"type": "input_audio", "audio_url": next(urls)}
            else:
                yield {**next(files), "type": "input_audio"}
    elif isinstance(item.get("audio_references"), list):
        for reference in files:
            yield (
                {**reference, "type": "input_audio"}
                if isinstance(reference, dict)
                else {}
            )
    else:
        for url in urls:
            yield {"type": "input_audio", "audio_url": url}
    for path in _array(item.get("local_audio")):
        yield {"type": "local_audio", "path": path}


def _row_media(
    source: Path, source_id: str, line: int, row: dict, media: str | None
) -> Iterator[tuple[str, dict, str | Path | None]]:
    cwd = Path(value) if isinstance(value := row.get("_rollout_cwd"), str) else None
    for slot, checkpoint_item, payload in _items(row):
        event_type = payload.get("type")
        item = payload.get("item") if event_type == "item_completed" else payload
        if not isinstance(item, dict):
            continue
        item_type = item.get("type")
        role = item.get("role")
        if item_type in ("UserMessage", "user_message"):
            role = "user"
        elif item_type not in ("message", "Message") or role == "function":
            role = "tool"
        locator = {
            "rollout": source.name,
            "line": line,
            "record_type": row["type"],
            **row.get("_rollout_provenance", {}),
        }
        for key, value in (
            ("timestamp", row.get("timestamp")),
            ("turn_id", payload.get("turn_id") or row.get("_rollout_turn_id")),
            ("item_type", item_type),
            ("item_id", item.get("id") or item.get("call_id")),
            ("role", role),
        ):
            if isinstance(value, str) and value:
                locator[key] = omit_data_urls(value)
        if checkpoint_item is not None:
            locator["checkpoint_item"] = checkpoint_item
        # The extension completion adapter reads fileId/result from its wrapper.
        parts_owner = payload if item_type == "Extension" else item
        parts = enumerate(_parts(parts_owner))
        if item_type == "user_message" and media != "image":
            audio_parts = enumerate(_legacy_audio_parts(item))
            parts = audio_parts if media == "audio" else chain(parts, audio_parts)
        for index, part in parts:
            if not isinstance(part, dict):
                continue
            part_type = part.get("type")
            if part_type in ("image", "input_image", "inputImage") and media != "audio":
                description, raw = _part_source(part, cwd)
                prefix = "img"
            elif media != "image":
                description, raw = _audio_source(part, cwd)
                prefix = "aud"
            else:
                continue
            if description:
                if isinstance(raw, Path):
                    description["resolved_path"] = str(raw)
                yield (
                    f"{prefix}:{source_id}:{line}:{slot}:{index}",
                    {**locator, **description, "part": index},
                    raw,
                )
        if media == "audio":
            continue
        for index, image in enumerate(local_image_records(payload, source, line, cwd)):
            description = {
                key: value
                for key, value in image.items()
                if key in ("path", "resolved_path")
            }
            yield (
                f"img:{source_id}:{line}:{slot}l:{index}",
                {
                    **locator,
                    **description,
                    "kind": "local",
                    "part": index,
                },
                image["_source_file"],
            )


def _public_media(image: dict, identifier: str, *, attachments: bool = False) -> dict:
    for key in ("path", "resolved_path"):
        if key in image:
            image[key] = omit_data_urls(image[key])
    is_image = identifier.startswith("img:")
    if is_image:
        image["image_id"] = identifier
    if attachments:
        kind = image["kind"]
        image.update(
            attachment_id=identifier,
            media="image" if is_image else "audio",
            availability={
                "inline": "embedded",
                "local": "local",
                "reference": "reference",
            }[kind],
        )
        if kind == "local" and "resolved_path" not in image:
            image["availability"] = "unresolved"
    return image


def catalog(
    rows: Iterable[RolloutRow],
    *,
    limit: int = 20,
    kind: str | None = None,
    cursor: str | None = None,
    roles: Iterable[str] = (),
) -> dict:
    """Return a bounded page of physical image occurrences without loading images."""
    return _catalog(
        rows,
        limit=limit,
        kind=kind,
        cursor=cursor,
        roles=roles,
        media="image",
        attachments=False,
    )


def attachment_catalog(
    rows: Iterable[RolloutRow],
    *,
    limit: int = 20,
    kind: str | None = None,
    cursor: str | None = None,
    roles: Iterable[str] = (),
    media: str | None = None,
) -> dict:
    """Return one metadata-only page of images and audio, with physical IDs."""
    return _catalog(
        rows,
        limit=limit,
        kind=kind,
        cursor=cursor,
        roles=roles,
        media=media,
        attachments=True,
    )


def _catalog(
    rows: Iterable[RolloutRow],
    *,
    limit: int,
    kind: str | None,
    cursor: str | None,
    roles: Iterable[str],
    media: str | None,
    attachments: bool,
) -> dict:
    catalog_key = "attachments" if attachments else "images"
    if limit < 1:
        raise ValueError(f"{catalog_key.capitalize()} catalog limit must be at least 1")
    items = []
    last_id = None
    roles = set(roles)
    source_ids = {}
    for source, line, row in rows:
        if source not in source_ids:
            source_ids[source] = _source_id(source)
        for position, image, raw in _row_media(
            source, source_ids[source], line, row, media
        ):
            if (kind is not None and image["kind"] != kind) or (
                roles and image.get("role") not in roles
            ):
                continue
            if cursor is not None:
                if cursor.startswith(position + ":"):
                    digest = _media_digest(image, raw)
                    if f"{position}:{digest[:24]}" == cursor:
                        cursor = None
                continue
            if len(items) == limit:
                return {catalog_key: items, "next_cursor": last_id}
            digest = _media_digest(image, raw)
            last_id = f"{position}:{digest[:24]}"
            items.append(_public_media(image, last_id, attachments=attachments))
    if cursor is not None:
        raise ValueError(
            f"{catalog_key.capitalize()} cursor is outside the selected rollout scope"
        )
    return {catalog_key: items, "next_cursor": None}


def _selected_media(
    rows: Iterable[RolloutRow],
    ids: list[str],
    media: str,
) -> Iterator[tuple[str, str, dict, str | Path | None]]:
    pending = set(ids)
    targets = _target_lines(ids, "img" if media == "image" else "aud")
    if not targets:
        return
    positions = {identifier.rpartition(":")[0] for identifier in ids}
    source_ids = {}
    for source, line, row in rows:
        if source not in source_ids:
            source_ids[source] = _source_id(source)
        source_id = source_ids[source]
        if line not in targets.get(source_id, ()):
            continue
        for position, description, raw in _row_media(
            source, source_id, line, row, media
        ):
            if position not in positions:
                continue
            digest = _media_digest(description, raw)
            identifier = f"{position}:{digest[:24]}"
            if identifier not in pending:
                continue
            pending.remove(identifier)
            yield identifier, digest, description, raw
        if not pending:
            break


def export_selected(
    rows: Iterable[RolloutRow],
    ids: Iterable[str],
    *,
    output_dir: Path | None = None,
    scale: float = 1.0,
    max_resolution: int | None = 512,
) -> dict:
    """Export the requested physical occurrences in input ID order."""
    validate_image_size(scale, max_resolution)
    requested = list(dict.fromkeys(ids))
    found = {}
    destinations: dict[tuple[str, str | Path], dict] = {}
    directory = None
    for image_id, digest, image, raw in _selected_media(rows, requested, "image"):
        image = found[image_id] = _public_media(image, image_id)
        if raw is None or image["kind"] == "reference":
            image["export_error"] = (
                "The rollout contains an opaque file ID or remote image reference"
                if image["kind"] == "reference"
                else "No absolute local path for the recorded image"
            )
            continue
        if directory is None:
            directory = (
                Path(tempfile.mkdtemp(prefix="codex-rollout-images-"))
                if output_dir is None
                else output_dir.resolve()
            )
        if isinstance(raw, Path):
            key = ("local", raw)
            if key not in destinations:
                local = {"_source_file": raw}
                try:
                    export_local_images(
                        [local], directory, scale, max_resolution=max_resolution
                    )
                except OSError as error:
                    local["export_error"] = str(error)
                local.pop("_source_file")
                destinations[key] = local
        else:
            url = (
                raw
                if raw[:5].lower() == "data:"
                else (f"data:{image['media_type']};base64,{raw}")
            )
            key = ("inline", digest)
            if key not in destinations:
                try:
                    directory.mkdir(parents=True, exist_ok=True)
                    destinations[key] = export_inline_image(
                        url, digest, directory, scale, max_resolution
                    )
                except (OSError, ValueError) as error:
                    destinations[key] = {"export_error": str(error)}
        image.update(destinations[key])
    report = {
        "images": [found[image_id] for image_id in requested if image_id in found],
        "unknown_ids": [image_id for image_id in requested if image_id not in found],
    }
    if directory is not None:
        report["image_output_dir"] = str(directory)
    return report


def _save_inline_audio(raw: str, media_type: str, digest: str, directory: Path) -> str:
    start = 0
    if raw[:5].lower() == "data:":
        header = AUDIO_DATA_HEADER.match(raw)
        if header is None:
            raise ValueError("Unsupported audio data URL")
        start = header.end()
    if start == len(raw):
        raise ValueError("Inline audio payload is empty")
    directory.mkdir(parents=True, exist_ok=True)
    filename = None
    try:
        with tempfile.NamedTemporaryFile(
            dir=directory,
            prefix=f"audio-{digest[:24]}-",
            suffix=AUDIO_SUFFIXES.get(media_type, ".audio"),
            delete=False,
        ) as stream:
            filename = Path(stream.name)
            for offset in range(start, len(raw), 64 * 1024):
                encoded = raw[offset : offset + 64 * 1024]
                if offset + len(encoded) < len(raw) and "=" in encoded:
                    raise ValueError("Invalid Base64 audio payload")
                try:
                    stream.write(base64.b64decode(encoded, validate=True))
                except ValueError as error:
                    raise ValueError("Invalid Base64 audio payload") from error
    except BaseException:
        if filename is not None:
            filename.unlink(missing_ok=True)
        raise
    return str(filename)


def export_audio(
    rows: Iterable[RolloutRow],
    ids: Iterable[str],
    *,
    output_dir: Path | None = None,
) -> dict:
    """Return existing local paths or write selected embedded audio to files."""
    requested = list(dict.fromkeys(ids))
    found = {}
    directory = None
    inline_files: dict[str, str] = {}
    for identifier, digest, audio, raw in _selected_media(rows, requested, "audio"):
        audio = found[identifier] = _public_media(audio, identifier, attachments=True)
        try:
            if audio["kind"] == "reference":
                raise ValueError(
                    "The rollout contains an opaque file ID or remote audio reference"
                )
            if raw is None:
                raise ValueError("No absolute local path for the recorded audio")
            if isinstance(raw, Path):
                if not raw.is_file():
                    raise ValueError("The recorded audio file is unavailable")
                audio["audio_file"] = str(raw)
                continue
            if directory is None:
                directory = (
                    Path(tempfile.mkdtemp(prefix="codex-rollout-audio-"))
                    if output_dir is None
                    else output_dir.resolve()
                )
            if digest not in inline_files:
                inline_files[digest] = _save_inline_audio(
                    raw, audio["media_type"], digest, directory
                )
            audio["audio_file"] = inline_files[digest]
        except (OSError, ValueError) as error:
            audio["export_error"] = str(error)
    return {
        "attachments": [
            found[identifier] for identifier in requested if identifier in found
        ],
        "unknown_ids": [
            identifier for identifier in requested if identifier not in found
        ],
        **({"audio_output_dir": str(directory)} if directory is not None else {}),
    }
