"""Describe and export image attachments from Codex rollout records."""

from __future__ import annotations

import base64
import hashlib
import io
import re
import warnings
from collections import defaultdict
from collections.abc import Callable, Iterable
from itertools import count
from pathlib import Path

IMAGE_DATA_HEADER = re.compile(
    r"data:(image/[a-z0-9.+-]+);base64,", re.IGNORECASE | re.ASCII
)


def image_parts(item: dict) -> list[dict]:
    kind = item.get("type")
    if kind == "message":
        parts = item.get("content")
    elif kind in ("function_call_output", "custom_tool_call_output"):
        parts = item.get("output")
    elif kind == "item_completed":
        extension = item.get("item")
        if (
            not isinstance(extension, dict)
            or extension.get("type") != "Extension"
            or extension.get("kind") != "image_gen.generation"
        ):
            return []
        file_id = extension.get("fileId")
        if isinstance(file_id, str) and file_id:
            return [{"type": "input_image", "file_id": file_id}]
        result = extension.get("result")
        if not isinstance(result, str) or not result:
            return []
        if result[:5].lower() != "data:":
            result = f"data:image/unknown;base64,{result}"
        return [{"type": "input_image", "image_url": result}]
    else:
        return []
    return parts if isinstance(parts, list) else []


def inline_media_digest(raw: str, media_type: str) -> str:
    """Hash inline media as a data URI using bounded UTF-8 chunks."""
    digest = hashlib.sha256()
    if raw[:5].lower() != "data:":
        digest.update(f"data:{media_type};base64,".encode("ascii"))
    chunk_size = 64 * 1024
    for start in range(0, len(raw), chunk_size):
        digest.update(raw[start : start + chunk_size].encode("utf-8", "surrogatepass"))
    return digest.hexdigest()


def describe_image(part: dict, index: int) -> dict:
    url = part.get("image_url")
    if isinstance(url, str) and url[:5].lower() == "data:":
        header = IMAGE_DATA_HEADER.match(url)
        media_type = header.group(1).lower() if header else "application/octet-stream"
        return {
            "part": index,
            "media_type": media_type,
            "data_url_sha256": inline_media_digest(url, media_type),
        }
    return {"part": index, "reference": url or part.get("file_id")}


def _write_new_file(path: Path, contents: bytes) -> str:
    candidate = path
    for index in count(1):
        try:
            with candidate.open("xb") as output:
                output.write(contents)
        except FileExistsError:
            candidate = path.with_stem(f"{path.stem}-{index}")
        else:
            return str(candidate)


def _export_thumbnail(
    source: Path | io.BytesIO,
    name: str,
    output_dir: Path,
    scale: float,
    max_resolution: int | None,
) -> tuple[str, dict[str, str | int]]:
    try:
        from PIL import Image, ImageOps
        from PIL.Image import Resampling
    except ImportError as error:
        raise ValueError("Exporting thumbnails requires Pillow 9.1 or newer") from error

    try:
        with warnings.catch_warnings():
            # Pillow's hard pixel limit still rejects images with an export error.
            warnings.simplefilter("ignore", Image.DecompressionBombWarning)
            with Image.open(source) as image:
                suffix = image.format.lower()
                with ImageOps.exif_transpose(image) as oriented:
                    longest_edge = max(oriented.size)
                    if max_resolution is not None and max_resolution < longest_edge:
                        scale = min(scale, max_resolution / longest_edge)
                    width = max(1, round(oriented.width * scale))
                    height = max(1, round(oriented.height * scale))
                    alpha = (
                        "A" in oriented.getbands() or "transparency" in oriented.info
                    )
                    with oriented.convert("RGBA" if alpha else "RGB") as converted:
                        preview = converted.resize((width, height), Resampling.LANCZOS)
                    with preview, io.BytesIO() as encoded:
                        preview.save(encoded, format="WEBP", quality=75)
                        thumbnail = _write_new_file(
                            output_dir / f"{name}-{width}x{height}.webp",
                            encoded.getvalue(),
                        )
    except (Image.DecompressionBombError, OSError, SyntaxError, ValueError) as error:
        raise ValueError(f"Could not create an image thumbnail: {error}") from error
    return suffix, {
        "thumbnail_file": thumbnail,
        "thumbnail_width": width,
        "thumbnail_height": height,
    }


def export_inline_image(
    url: str, digest: str, output_dir: Path, scale: float, max_resolution: int | None
) -> dict[str, str | int]:
    header = IMAGE_DATA_HEADER.match(url)
    if header is None:
        raise ValueError("Invalid Base64 image data URI")
    try:
        raw_image = base64.b64decode(url[header.end() :], validate=True)
    except ValueError as error:
        raise ValueError("Invalid Base64 image payload") from error

    with io.BytesIO(raw_image) as source:
        suffix, thumbnail = _export_thumbnail(
            source, digest, output_dir, scale, max_resolution
        )
    original = _write_new_file(output_dir / f"{digest}.{suffix}", raw_image)
    return {"embedded_file": original, **thumbnail}


def validate_image_size(scale: float, max_resolution: int | None) -> None:
    if not 0 < scale <= 1:
        raise ValueError("Image scale must be greater than 0 and at most 1")
    if max_resolution is not None and max_resolution < 1:
        raise ValueError("Maximum image resolution must be at least 1 pixel")


def export_local_images(
    images: list[dict],
    output_dir: Path,
    scale: float,
    *,
    max_resolution: int | None = None,
) -> None:
    """Create previews of existing local images, preserving their recorded paths."""
    validate_image_size(scale, max_resolution)
    if not images:
        return

    output_dir = output_dir.resolve()
    output_dir.mkdir(parents=True, exist_ok=True)
    files: dict[Path, dict[str, str | int]] = {}
    for image in images:
        source = image.get("_source_file")
        if source is None:
            image["export_error"] = "No absolute local path for the recorded image"
            continue
        try:
            if source not in files:
                digest = hashlib.sha256(str(source).encode("utf-8")).hexdigest()
                _, files[source] = _export_thumbnail(
                    source, f"local-{digest}", output_dir, scale, max_resolution
                )
            image.update(files[source])
        except ValueError as error:
            image["export_error"] = str(error)


def export_images(
    messages: list[dict],
    output_dir: Path,
    scale: float,
    rows: Callable[[Path, set[int]], Iterable[tuple[int, dict]]],
    *,
    max_resolution: int | None = None,
) -> None:
    """Export selected inline images and annotate their entries with absolute paths."""
    validate_image_size(scale, max_resolution)

    selected: dict[Path, dict[int, list[tuple[dict, dict]]]] = defaultdict(
        lambda: defaultdict(list)
    )
    for message in messages:
        for image in message.get("images", []):
            if "data_url_sha256" in image:
                selected[message["_source"]][message["line"]].append((message, image))
    if not selected:
        return
    output_dir = output_dir.resolve()
    output_dir.mkdir(parents=True, exist_ok=True)
    files: dict[str, dict[str, str | int]] = {}
    for source, by_line in selected.items():
        read_error = None
        try:
            for line, row in rows(source, set(by_line)):
                for message, image in by_line.pop(line, []):
                    try:
                        payload = row["payload"]
                        checkpoint_item = message.get("_checkpoint_item")
                        if checkpoint_item is not None:
                            payload = payload["replacement_history"][checkpoint_item]
                        index = image["part"]
                        part = image_parts(payload)[index]
                        digest = image["data_url_sha256"]
                        if describe_image(part, index).get("data_url_sha256") != digest:
                            raise ValueError("Image changed")
                        if digest not in files:
                            files[digest] = export_inline_image(
                                part["image_url"],
                                digest,
                                output_dir,
                                scale,
                                max_resolution,
                            )
                        image.update(files[digest])
                    except (AttributeError, IndexError, KeyError, TypeError):
                        image["export_error"] = (
                            f"Missing image in {source.name} at line {line}"
                        )
                    except (OSError, ValueError) as error:
                        image["export_error"] = f"{source.name}:{line}: {error}"
        except (OSError, ValueError) as error:
            read_error = error
        for line, entries in by_line.items():
            for _, image in entries:
                image["export_error"] = (
                    f"Missing image record in {source.name} at line {line}"
                    if read_error is None
                    else f"Could not read {source.name} at line {line}: {read_error}"
                )
