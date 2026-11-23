"""Opaque locators for physical rollout rows and bounded views."""

from __future__ import annotations

import hashlib
import json
import os
import re
from collections.abc import Iterable
from dataclasses import dataclass
from functools import lru_cache
from pathlib import Path

from rollout_source import record_revision

RolloutRow = tuple[Path, int, dict]
_REF = re.compile(
    r"ref1:([a-f0-9]{24}):([1-9][0-9]{0,18}):(record|hit|field|chat):([a-f0-9]{24})"
    r"(?::(0|[1-9][0-9]{0,18}):(0|[1-9][0-9]{0,18}):(0|[1-9][0-9]{0,18}))?"
)
_ROW_CURSOR = re.compile(r"([a-f0-9]{16}):([1-9][0-9]{0,18})")


@dataclass(frozen=True)
class Reference:
    source: str
    line: int
    view: str
    digest: str
    anchor: tuple[int, int, int] | None

    def __str__(self) -> str:
        base = f"ref1:{self.source}:{self.line}:{self.view}:{self.digest}"
        if self.anchor is None:
            return base
        index, start, end = self.anchor
        return f"{base}:{index}:{start}:{end}"


def parse_ref(value: str) -> Reference:
    match = _REF.fullmatch(value)
    if match is None:
        raise ValueError(
            "expected a reference from rollout search, read, or transcript"
        )
    source, line, view, digest, index, start, end = match.groups()
    anchor = None if index is None else (int(index), int(start), int(end))
    if (view in {"hit", "field"}) != (anchor is not None) or (
        anchor is not None and anchor[1] > anchor[2]
    ):
        raise ValueError("invalid rollout reference anchor")
    return Reference(source, int(line), view, digest, anchor)


@lru_cache(maxsize=32)
def _source_id(path: Path, *, physical: bool = False) -> str:
    canonical = os.path.normcase(os.path.abspath(path))
    if not physical:
        canonical = canonical.removesuffix(".zst")
    return hashlib.sha256(os.fsencode(canonical)).hexdigest()[:24]


def row_cursor_source(path: Path) -> str:
    return _source_id(path, physical=True)[:16]


def row_cursor(path: Path, line: int) -> str:
    return f"{row_cursor_source(path)}:{line}"


def parse_row_cursor(value: str) -> tuple[str, int]:
    match = _ROW_CURSOR.fullmatch(value)
    if match is None:
        raise ValueError("invalid row cursor; use next_cursor from the previous page")
    source, line = match.groups()
    return source, int(line)


def reference_target(
    sources: Iterable[Path], ref: Reference
) -> tuple[Path, int] | None:
    """Resolve a ref only against paths in the caller's selected lineage."""
    for source in sources:
        if _source_id(source) == ref.source:
            return source, ref.line
    return None


def projected_reference(
    location: RolloutRow,
    view: str,
    values: Iterable[str],
    *,
    identity: tuple = (),
    anchor: tuple[int, int, int] | None = None,
) -> Reference:
    """Bind a view to its exact wire record and keep the payload out of the ref."""
    path, line, row = location
    digest = hashlib.sha256(
        json.dumps(
            (
                row.get("type"),
                row.get("timestamp"),
                row.get("ordinal"),
                view,
                identity,
                anchor,
            ),
            ensure_ascii=True,
            separators=(",", ":"),
        ).encode("ascii")
    )
    raw = row.get("_rollout_revision_source")
    revision = (
        record_revision(raw) if isinstance(raw, bytes) else row.get("_rollout_revision")
    )
    if isinstance(revision, str):
        digest.update(b"wire:")
        digest.update(revision.encode("ascii"))
    else:
        # In-memory records have no wire representation. Bind their selected projection.
        for value in values:
            digest.update(len(value).to_bytes(8, "big"))
            for offset in range(0, len(value), 65536):
                digest.update(
                    value[offset : offset + 65536].encode("utf-8", "surrogatepass")
                )
    return Reference(_source_id(path), line, view, digest.hexdigest()[:24], anchor)
