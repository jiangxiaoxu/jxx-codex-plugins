"""Initialize thread notes and materialize ordinary forks' memory snapshots."""

from datetime import datetime, timezone
from pathlib import Path
from uuid import UUID

from rollout_handoff_store import (
    MemoryRevision,
    initialize_memory,
    legacy_memory,
    memory_revision,
)
from rollout_lineage import is_subagent
from rollout_source import find_rollout, metadata


_EPOCH = datetime(1970, 1, 1, tzinfo=timezone.utc)


class MemoryInheritanceUnavailable(ValueError):
    """A verified local fork cannot resolve its inherited note."""


def _verified_header(path: Path, thread_id: str) -> dict:
    header = metadata(path)
    if header.get("id") != thread_id:
        raise ValueError(f"rollout header does not identify thread {thread_id}")
    return header


def _fork_time_us(timestamp: object, thread_id: str) -> int:
    if not isinstance(timestamp, str) or "T" not in timestamp:
        raise ValueError(f"fork creation timestamp is unavailable for thread {thread_id}")
    try:
        when = datetime.fromisoformat(
            timestamp.removesuffix("Z") + "+00:00" if timestamp.endswith("Z") else timestamp
        )
    except ValueError as error:
        raise ValueError(f"invalid fork creation timestamp for thread {thread_id}") from error
    if when.utcoffset() is None:
        raise ValueError(f"fork creation timestamp has no UTC offset for thread {thread_id}")
    delta = when - _EPOCH
    return ((delta.days * 86_400 + delta.seconds) * 1_000_000) + delta.microseconds


def _memory_at(
    home: Path, thread_id: str, cutoff_us: int, visiting: set[str]
) -> tuple[str | None, int]:
    if thread_id in visiting:
        raise ValueError(f"cycle in rollout fork ancestry at thread {thread_id}")
    revision = memory_revision(home, thread_id, at_us=cutoff_us)
    if revision is None:
        if (legacy := legacy_memory(home, thread_id, at_us=cutoff_us)) is not None:
            return legacy
        # A never-accessed parent can itself inherit a note at its own fork time.
        _initialize(home, thread_id, visiting)
        revision = memory_revision(home, thread_id, at_us=cutoff_us)
    if revision is None or revision.summary is None:
        return None, cutoff_us
    return revision.summary, revision.updated_us


def _initialize(home: Path, thread_id: str, visiting: set[str]) -> MemoryRevision | None:
    if (own := memory_revision(home, thread_id)) is not None:
        return own

    original = find_rollout(home, thread_id)
    path = original if original is not None else find_rollout(home, thread_id, thread=True)
    if path is None:
        raise FileNotFoundError(f"no local rollout found for thread {thread_id}")
    header = _verified_header(path, thread_id)
    parent = header.get("forked_from_id")
    if parent is None or is_subagent(header):
        if legacy_memory(home, thread_id) is None:
            return memory_revision(home, thread_id)
        return initialize_memory(home, thread_id)

    try:
        if original is None:
            raise ValueError(f"original rollout required for fork creation time of thread {thread_id}")
        if not isinstance(parent, str):
            raise ValueError(f"invalid fork parent for thread {thread_id}")
        try:
            parent_id = str(UUID(parent))
        except ValueError as error:
            raise ValueError(f"invalid fork parent for thread {thread_id}") from error
        fork_us = _fork_time_us(header.get("timestamp"), thread_id)

        visiting.add(thread_id)
        try:
            summary, updated_us = _memory_at(home, parent_id, fork_us, visiting)
        finally:
            visiting.remove(thread_id)
    except MemoryInheritanceUnavailable:
        raise
    except (OSError, ValueError) as error:
        raise MemoryInheritanceUnavailable(f"cannot inherit thread note: {error}") from error

    return initialize_memory(home, thread_id, summary, updated_us, fork_us)


def initialize_thread_memory(home: Path, thread_id: str) -> MemoryRevision | None:
    """Return the thread's latest revision, initializing an ordinary fork once."""
    return _initialize(home, str(UUID(thread_id)), set())
