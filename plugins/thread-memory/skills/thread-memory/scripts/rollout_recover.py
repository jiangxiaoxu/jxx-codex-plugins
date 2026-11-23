"""Recover conversation excerpts and image references from a compaction checkpoint."""

from __future__ import annotations

import tempfile
from collections.abc import Callable, Iterable
from pathlib import Path
from urllib.parse import urlsplit

from rollout_recovery_images import (
    describe_image,
    export_images,
    export_local_images,
    image_parts,
)
from rollout_source import checkpoint_window
from rollout_text import is_user_shell_part, omit_data_urls


def local_path(name: str, cwd: Path | None = None) -> Path | None:
    if name[:5].lower() == "file:":
        from urllib.request import url2pathname

        try:
            uri = urlsplit(name)
            if uri.netloc.lower() not in ("", "localhost") or uri.query or uri.fragment:
                return None
            path = Path(url2pathname(uri.path))
        except (ValueError, OSError):
            return None
        return path if path.is_absolute() else None
    path = Path(name)
    if not path.is_absolute() and cwd is not None:
        path = cwd / path
    return path if path.is_absolute() else None


def describe_recovery_image(part: dict, index: int) -> dict:
    image = describe_image(part, index)
    url = part.get("image_url")
    if (
        "data_url_sha256" not in image
        and isinstance(url, str)
        and (path := local_path(url))
    ):
        image.update(path=url, resolved_path=str(path), _source_file=path)
    return image


def image_key(image: dict) -> str | Path | None:
    return (
        image.get("data_url_sha256")
        or image.get("_source_file")
        or image.get("reference")
    )


def message_from(
    item: dict,
    metadata: dict | None,
    source: Path,
    line: int,
    checkpoint_item: int | None = None,
) -> dict | None:
    role = item.get("role")
    if (
        item.get("type") != "message"
        or role not in ("user", "assistant")
        or (metadata or {}).get("compaction_output")
    ):
        return None
    parts = item["content"]
    annotations = item.get("internal_chat_message_metadata_passthrough") or {}
    kinds = annotations.get("content_item_kinds") or []
    text_parts = []
    images = []
    for index, part in enumerate(parts):
        part_type = part.get("type")
        if part_type == "input_image":
            images.append(describe_recovery_image(part, index))
        if part_type not in ("input_text", "output_text"):
            continue
        kind = kinds[index] if index < len(kinds) else ""
        if (
            role == "user"
            and kind not in ("", "unknown")
            and not kind.startswith("user.")
        ):
            continue
        value = part["text"]
        if role == "user" and is_user_shell_part(value, kind):
            continue
        if role == "user" and value.lstrip().startswith(
            (
                "# AGENTS.md instructions",
                "<environment_context>",
                "Another language model started to solve this problem",
            )
        ):
            continue
        if value.strip():
            text_parts.append(value)
    if not text_parts and not images:
        return None
    return {
        "rollout": source.name,
        "line": line,
        "role": role,
        "text": "\n".join(text_parts),
        **({"images": images} if images else {}),
        "_source": source,
        "_checkpoint_item": checkpoint_item,
    }


def message_key(message: dict) -> tuple:
    images = tuple(image_key(image) for image in message.get("images", []))
    return message["role"], message["text"].strip(), images


def image_record(
    item: dict, source: Path, line: int, checkpoint_item: int | None = None
) -> dict | None:
    if item.get("type") not in (
        "custom_tool_call_output",
        "function_call_output",
        "item_completed",
    ):
        return None
    images = [
        describe_recovery_image(part, index)
        for index, part in enumerate(image_parts(item))
        if part.get("type") == "input_image"
    ]
    if not images:
        return None
    return {
        "rollout": source.name,
        "line": line,
        "item_type": item["type"],
        "images": images,
        "_source": source,
        "_checkpoint_item": checkpoint_item,
    }


def missing_image_records(history: list[dict], retained: list[dict]) -> list[dict]:
    seen = {image_key(image) for record in retained for image in record["images"]}
    missing = []
    for record in reversed(history):
        images = []
        for image in reversed(record["images"]):
            key = image_key(image)
            if key is None or key not in seen:
                images.append(image)
                seen.add(key)
        if images:
            missing.append({**record, "images": list(reversed(images))})
    return list(reversed(missing))


def limit_messages(
    messages: list[dict], max_messages: int, max_chars: int
) -> list[dict]:
    if max_messages == 0 or max_chars == 0:
        return []
    selected = []
    remaining = max_chars
    for message in reversed(messages[-max_messages:]):
        text = omit_data_urls(message["text"])
        if len(text) > remaining:
            selected.append({**message, "text": text[:remaining], "truncated": True})
            break
        selected.append({**message, "text": text})
        remaining -= len(text)
        if remaining == 0:
            break
    return list(reversed(selected))


def public_record(record: dict) -> dict:
    result = {key: value for key, value in record.items() if not key.startswith("_")}
    if record.get("_checkpoint_item") is not None:
        result["checkpoint_item"] = record["_checkpoint_item"]
    return result


def public_message(message: dict) -> dict:
    result = public_record(message)
    if images := result.pop("images", None):
        result["image_count"] = len(images)
    return result


def local_image_records(
    payload: dict, source: Path, line: int, cwd: Path | None
) -> Iterable[dict]:
    item = (
        (payload.get("item") or {})
        if payload.get("type") == "item_completed"
        else payload
    )
    event_type = item.get("type")
    attachments = event_type in ("user_message", "UserMessage")
    if event_type == "user_message":
        names = item.get("local_images", [])
    elif event_type == "UserMessage":
        names = [
            part.get("path")
            for part in item.get("content", [])
            if part.get("type") == "local_image"
        ]
    elif event_type in ("view_image_tool_call", "ImageView"):
        names = [item.get("path")]
    elif event_type in ("image_generation_end", "ImageGeneration"):
        names = [item.get("saved_path")]
    elif event_type == "Extension" and item.get("kind") == "image_gen.generation":
        names = [item.get("savedPath")]
        names.extend(
            reference.get("path")
            for reference in item.get("inputImages") or []
            if isinstance(reference, dict)
        )
    else:
        return
    for name in names:
        if not isinstance(name, str) or not name:
            continue
        absolute = local_path(name, cwd if attachments else None)
        if absolute is None and not attachments:
            continue
        yield {
            "rollout": source.name,
            "line": line,
            "path": name,
            **({"resolved_path": str(absolute)} if absolute else {}),
            "_source_file": absolute,
        }


def split_image_records(
    missing: list[dict], retained: list[dict], event_images: dict
) -> tuple[list[dict], dict]:
    retained_paths = {
        image["_source_file"]
        for record in retained
        for image in record["images"]
        if "_source_file" in image
    }
    local_images = {
        key: image for key, image in event_images.items() if key not in retained_paths
    }
    image_records = []
    for record in missing:
        inline_or_reference = []
        for image in record["images"]:
            if path := image.get("_source_file"):
                local_images.pop(path, None)
                local_images[path] = {
                    **image,
                    "rollout": record["rollout"],
                    "line": record["line"],
                    "item_type": record["item_type"],
                    "_checkpoint_item": record["_checkpoint_item"],
                }
            else:
                inline_or_reference.append(image)
        if inline_or_reference:
            image_records.append({**record, "images": inline_or_reference})
    return image_records, local_images


def report_images(
    result: dict,
    limit: int,
    export_dir: Path | bool | None,
    scale: float,
    read_selected_rows: Callable[[Path, set[int]], Iterable[tuple[int, dict]]] | None,
    *,
    max_resolution: int | None = None,
) -> None:
    image_records = result.get("image_records", [])
    local_images = list(result.get("local_images", {}).values())
    inline = []
    references = []
    for index, record in enumerate(image_records):
        for image in record["images"]:
            group = inline if "data_url_sha256" in image else references
            group.append((index, image))
    result["image_candidate_count"] = len(inline) + len(references)
    result["local_image_candidate_count"] = len(local_images)
    # Reserve one slot for a path when both formats are present and the limit permits it.
    inline_budget = limit - 1 if limit > 1 and local_images else limit
    inline_count = min(inline_budget, len(inline))
    local_count = min(limit - inline_count, len(local_images))
    reference_count = min(limit - inline_count - local_count, len(references))
    chosen_inline = inline[len(inline) - inline_count :]
    chosen_references = references[len(references) - reference_count :]
    grouped = {}
    for index, image in chosen_inline + chosen_references:
        grouped.setdefault(index, []).append(image)
    selected = [
        {
            **image_records[index],
            "images": sorted(grouped[index], key=lambda image: image["part"]),
        }
        for index in sorted(grouped)
    ]
    local_images = local_images[len(local_images) - local_count :]
    if inline_count and export_dir and read_selected_rows is None:
        raise ValueError("Exporting inline images requires a rollout row reader")
    if export_dir and (inline_count or local_images):
        output_dir = (
            Path(tempfile.mkdtemp(prefix="codex-rollout-images-"))
            if export_dir is True
            else export_dir
        )
        if inline_count and read_selected_rows is not None:
            export_images(
                selected,
                output_dir,
                scale,
                read_selected_rows,
                max_resolution=max_resolution,
            )
        if local_images:
            export_local_images(
                local_images, output_dir, scale, max_resolution=max_resolution
            )
        result["image_export_dir"] = str(output_dir.resolve())
    result["image_records"] = [
        public_record({key: value for key, value in record.items() if key != "text"})
        for record in selected
    ]
    result["local_images"] = [public_record(image) for image in local_images]


def recover(
    rows: Iterable[tuple[Path, int, dict]],
    primary: Path,
    *,
    window: int | None = None,
    max_messages: int = 8,
    max_chars: int = 2400,
    max_images: int = 8,
    export_dir: Path | bool | None = None,
    scale: float = 0.25,
    max_resolution: int | None = None,
    read_selected_rows: Callable[[Path, set[int]], Iterable[tuple[int, dict]]]
    | None = None,
) -> dict:
    """Compare recorded history against one replacement, keeping the rollout read-only."""
    history = []
    image_history = []
    checkpoints = []
    local_images = {}
    result = {
        "status": "no_compaction" if window is None else "window_not_found",
        "messages": [],
    }
    last_rollback = None
    last_gap = None
    selected_source = None
    cwd = None
    number = 0
    for source, line, record in rows:
        if record.get("_rollout_gap"):
            history.clear()
            image_history.clear()
            local_images.clear()
            last_gap = {"rollout": source.name, "next_valid_line": line}
            if window is None and selected_source is not None:
                selected_source = None
                result = {"status": "gap_after_checkpoint", "messages": []}
        kind = record["type"]
        payload = record["payload"]
        ownership = record.get("_rollout_provenance", {})
        if "_rollout_cwd" in record:
            recorded_cwd = (
                Path(record["_rollout_cwd"]) if record["_rollout_cwd"] else None
            )
            cwd = recorded_cwd if recorded_cwd and recorded_cwd.is_absolute() else None
        elif kind in ("session_meta", "turn_context"):
            if kind == "session_meta":
                cwd = None
            if payload.get("cwd"):
                recorded_cwd = Path(payload["cwd"])
                cwd = recorded_cwd if recorded_cwd.is_absolute() else None
        if kind == "response_item":
            message = message_from(payload, record.get("metadata"), source, line)
            if message:
                message.update(ownership)
                history.append(message)
                if message.get("images"):
                    image_history.append({**message, "item_type": "message"})
            elif images := image_record(payload, source, line):
                images.update(ownership)
                image_history.append(images)
        elif kind == "compacted":
            replacement = payload.get("replacement_history")
            number = checkpoint_window(number, payload)
            checkpoint_info = {
                "rollout": source.name,
                "compaction_line": line,
                "window_number": number,
                **ownership,
            }
            checkpoints.append(checkpoint_info)
            selected = (
                (source == primary and ownership.get("origin", "current") == "current")
                if window is None
                else number == window
            )
            if selected:
                selected_source = source
                result = {
                    "status": "no_replacement_history",
                    **checkpoint_info,
                    "messages": [],
                    "local_images": local_images,
                }
                if last_rollback:
                    result["history_ignored_through_rollback"] = last_rollback
                if last_gap:
                    result["history_ignored_through_gap"] = last_gap
            local_images = {}
            if replacement is None:
                history = []
                image_history = []
                continue
            annotations = payload.get("replacement_history_metadata") or []
            retained = []
            retained_images = []
            for index, item in enumerate(replacement):
                metadata = annotations[index] if index < len(annotations) else None
                if message := message_from(item, metadata, source, line, index):
                    message.update(ownership)
                    retained.append(message)
                    if message.get("images"):
                        retained_images.append({**message, "item_type": "message"})
                elif images := image_record(item, source, line, index):
                    images.update(ownership)
                    retained_images.append(images)
            if selected:
                seen = {message_key(message) for message in retained}
                missing = []
                for message in reversed(history):
                    key = message_key(message)
                    if key not in seen:
                        missing.append(message)
                        seen.add(key)
                missing_images, missing_paths = split_image_records(
                    missing_image_records(image_history, retained_images),
                    retained_images,
                    result["local_images"],
                )
                result.update(
                    status="ok",
                    messages=list(reversed(missing)),
                    image_records=missing_images,
                    local_images=missing_paths,
                )
            history = retained
            image_history = retained_images
        elif kind == "event_msg":
            if (
                payload.get("type") == "thread_rolled_back"
                and payload.get("num_turns", 0) > 0
            ):
                # Earlier records may belong to turns removed by the rollback.
                history = []
                image_history = []
                local_images = {}
                last_rollback = {"rollout": source.name, "line": line}
                if window is None and selected_source is not None:
                    selected_source = None
                    result = {"status": "rollback_after_checkpoint", "messages": []}
            else:
                if images := image_record(payload, source, line):
                    images.update(ownership)
                    image_history.append(images)
                for image in local_image_records(payload, source, line, cwd):
                    image.update(ownership)
                    key = image["_source_file"] or (source, image["path"])
                    local_images.pop(key, None)
                    local_images[key] = image

    if last_rollback and selected_source is None:
        result["history_ignored_through_rollback"] = last_rollback
    if last_gap and selected_source is None:
        result["history_ignored_through_gap"] = last_gap
    result["checkpoints"] = checkpoints
    messages = result["messages"]
    result["candidate_count"] = len(messages)
    if max_images == 0:
        messages = [message for message in messages if message["text"]]
    result["messages"] = [
        public_message(message)
        for message in limit_messages(messages, max_messages, max_chars)
    ]
    report_images(
        result,
        max_images,
        export_dir,
        scale,
        read_selected_rows,
        max_resolution=max_resolution,
    )
    return result
