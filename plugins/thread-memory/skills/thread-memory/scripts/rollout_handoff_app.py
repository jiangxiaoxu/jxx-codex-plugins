"""Serve the local Thread Memory app over MCP stdio."""

import json
import os
import re
import sqlite3
import sys
from base64 import b64encode, urlsafe_b64decode, urlsafe_b64encode
from bisect import bisect_right
from collections.abc import Iterator
from contextlib import closing
from datetime import datetime, timedelta, timezone
from pathlib import Path
from struct import Struct
from uuid import UUID

from rollout_dependencies import dependency_status, install_dependencies
from rollout_handoff_store import (
    delete_handoff_threads,
    initialized_memory_threads,
    list_noted_threads,
    list_saved_threads,
    read_current_note,
    stored_threads,
)
from rollout_lineage import is_subagent
from rollout_query_index import (
    RolloutIndexUnavailable,
    delete_indexed_rollouts,
    indexed_rollout_threads,
)
from rollout_source import active_state_database, open_rollout, rollout_id
from rollout_thread_memory import initialize_thread_memory


RESOURCE = {
    "uri": "ui://thread-memory/notes",
    "name": "Thread Memory",
    "mimeType": "text/html;profile=mcp-app",
    "_meta": {"ui": {"permissions": {"clipboardWrite": {}}}},
}
ASSET = Path(__file__).resolve().parent.parent / "assets" / "handoffs.html"
ENTRYPOINT_ICON = ASSET.with_name("thread-memory-entrypoint.png")
THREAD = {"type": "string", "format": "uuid"}
QUERY = {"type": "string", "maxLength": 256}
ARCHIVE_STATUS = {"type": "string", "enum": ["all", "active", "archived"], "default": "all"}
LIST_SORT = {"type": "string", "enum": ["note_updated", "thread_updated"], "default": "note_updated"}
PAGE_LIMIT = {"type": "integer", "minimum": 1, "maximum": 100}
LIST_CURSOR_LENGTH = 32
LIST_ANCHOR = Struct(">q16s")
UTC_EPOCH = datetime(1970, 1, 1, tzinfo=timezone.utc)
MICROSECOND = timedelta(microseconds=1)
INDEX_QUERY_BATCH = 200
MAX_ROLLOUT_HEADER = 1024 * 1024
TOOLS = {
    "handoff_manager": ("Thread Memory", "Browse current notes by main thread.", {}, ()),
    "handoff_list": (
        "List main threads with notes", "Search main threads with notes, filter by archive status, and sort by update time.",
        {"query": QUERY, "archive_status": ARCHIVE_STATUS, "sort_by": LIST_SORT, "limit": PAGE_LIMIT,
         "cursor": {"type": "string", "minLength": LIST_CURSOR_LENGTH, "maxLength": LIST_CURSOR_LENGTH}}, (),
    ),
    "handoff_read": (
        "Read current thread note", "Read the thread's current saved note.",
        {"thread_id": THREAD}, ("thread_id",),
    ),
    "handoff_cleanup": (
        "Clean up deleted thread data", "Preview deleted local threads and remove their saved notes and indexes on confirmation.",
        {"thread_ids": {"type": "array", "items": THREAD}}, (),
    ),
    "dependency_status": (
        "Check Python dependencies", "Check optional dependencies in the current Python installation.", {}, (),
    ),
    "install_dependencies": (
        "Install Python dependencies", "Install missing rollout dependencies into the current Python installation.",
        {}, (),
    ),
}


def tool_descriptors() -> list[dict]:
    descriptors = []
    for name, (title, description, properties, required) in TOOLS.items():
        meta = {"ui": {"visibility": ["app"]}}
        destructive = name == "handoff_cleanup"
        installs = name == "install_dependencies"
        descriptor = {
            "name": name,
            "title": title,
            "description": description,
            "inputSchema": {"type": "object", "properties": properties,
                            "required": required, "additionalProperties": False},
            "annotations": {"readOnlyHint": not (destructive or installs),
                            "destructiveHint": destructive or installs,
                            "idempotentHint": destructive, "openWorldHint": installs},
            "_meta": meta,
        }
        if name == "handoff_manager":
            meta["ui"]["resourceUri"] = RESOURCE["uri"]
            meta["openai/ui"] = {"entrypoints": [{"type": "global"}]}
            try:
                encoded = b64encode(ENTRYPOINT_ICON.read_bytes()).decode("ascii")
            except OSError:
                pass
            else:
                descriptor["icons"] = [{
                    "src": f"data:image/png;base64,{encoded}",
                    "mimeType": "image/png",
                    "sizes": ["64x64"],
                }]
        descriptors.append(descriptor)
    return descriptors


def thread_uuid(value: object) -> str:
    if not isinstance(value, str) or len(value) != 36:
        raise ValueError("Expected a thread UUID.")
    return str(UUID(value))


def page_limit(args: dict) -> int:
    limit = args.get("limit", 30)
    if type(limit) is not int or not PAGE_LIMIT["minimum"] <= limit <= PAGE_LIMIT["maximum"]:
        raise ValueError("Limit must be an integer between 1 and 100.")
    return limit


def indexed_thread_updated_at(row: dict) -> datetime | None:
    for column, multiplier in (("updated_at_ms", 1), ("updated_at", 1000)):
        value = row.get(column)
        if type(value) is int:
            try:
                return UTC_EPOCH + timedelta(milliseconds=value * multiplier)
            except OverflowError:
                continue
    return None


def thread_page(home: Path, args: dict) -> dict:
    limit = page_limit(args)
    anchor = None
    if "cursor" in args:
        cursor = args["cursor"]
        if not isinstance(cursor, str) or not re.fullmatch(rf"[A-Za-z0-9_-]{{{LIST_CURSOR_LENGTH}}}", cursor):
            raise ValueError("Invalid thread list cursor. Start with the first page.")
        order_us, uuid_bytes = LIST_ANCHOR.unpack(urlsafe_b64decode(cursor))
        anchor = order_us, str(UUID(bytes=uuid_bytes))
    query = args.get("query", "")
    if not isinstance(query, str) or len(query) > QUERY["maxLength"]:
        raise ValueError("Expected a handoff search query of at most 256 characters.")
    query = " ".join(query.split()).casefold()
    archive_status = args.get("archive_status", ARCHIVE_STATUS["default"])
    if not isinstance(archive_status, str) or archive_status not in ARCHIVE_STATUS["enum"]:
        raise ValueError("Archive status must be all, active, or archived.")
    sort_by = args.get("sort_by", LIST_SORT["default"])
    if not isinstance(sort_by, str) or sort_by not in LIST_SORT["enum"]:
        raise ValueError("Sort by must be note_updated or thread_updated.")
    rows = list_noted_threads(home)
    ids = {row["thread_id"] for row in rows}
    title_columns = ("name", "title")
    identity_columns = ("source", "thread_source", "agent_role", "agent_nickname", "attached_thread_parent_id", "archived")
    indexed = thread_metadata(home, ids, identity_columns + ("updated_at_ms", "updated_at"), with_spawn_edge=True)
    main_threads = main_thread_archives(home, ids, indexed)
    if archive_status != "all":
        archived_only = archive_status == "archived"
        main_threads = {thread: archived for thread, archived in main_threads.items() if archived == archived_only}
    rows = [row for row in rows if row["thread_id"] in main_threads]
    if query:
        main_ids = set(main_threads)
        titles = thread_titles(home, main_ids, thread_metadata(home, main_ids, title_columns))
        rows = [row for row in rows if query in row["thread_id"].casefold()
                or query in titles.get(row["thread_id"], "").casefold()]

    def sort_key(row: dict) -> tuple[int, str]:
        thread = row["thread_id"]
        updated_at = indexed_thread_updated_at(indexed.get(thread, {})) if sort_by == "thread_updated" else None
        if updated_at is None:
            updated_at = datetime.fromisoformat(row["latest_at"].replace("Z", "+00:00"))
        return -((updated_at - UTC_EPOCH) // MICROSECOND), thread

    rows.sort(key=sort_key)
    offset = bisect_right(rows, anchor, key=sort_key) if anchor else 0
    end = offset + limit
    page = rows[offset:end]
    page_ids = {row["thread_id"] for row in page}
    preview_columns = ("preview", "first_user_message")
    details = thread_metadata(home, page_ids, preview_columns + (() if query else title_columns))
    if not query:
        titles = thread_titles(home, page_ids, details)
    for row in page:
        thread = row["thread_id"]
        row["title"] = titles.get(thread, "")[:160] or None
        row["preview"] = thread_preview(details.get(thread, {}))
        row["archived"] = main_threads[thread]
        updated_at = indexed_thread_updated_at(indexed.get(thread, {}))
        row["thread_updated_at"] = updated_at.isoformat(timespec="milliseconds").replace("+00:00", "Z") if updated_at else None
    next_cursor = None
    if end < len(rows):
        order_us, thread = sort_key(page[-1])
        next_cursor = urlsafe_b64encode(LIST_ANCHOR.pack(order_us, UUID(thread).bytes)).decode("ascii")
    return {"items": page, "next_cursor": next_cursor, "total": len(rows)}


def thread_metadata(
    home: Path, thread_ids: set[str], columns: tuple[str, ...], *, with_spawn_edge: bool = False,
) -> dict[str, dict]:
    """Keep the active index lookup scoped to IDs and fields the caller needs."""
    if not thread_ids:
        return {}
    metadata = {}
    try:
        database = active_state_database(home)
        with closing(sqlite3.connect(f"{database.absolute().as_uri()}?mode=ro",
                                     uri=True, timeout=0.2)) as connection:
            connection.row_factory = sqlite3.Row
            schema = {column[1] for column in connection.execute("PRAGMA table_info(threads)")}
            if "id" not in schema:
                return {}
            projection = ["id"]
            projection.extend(
                f"substr({column}, 1, 512) AS {column}"
                if column in ("preview", "first_user_message") else column
                for column in columns if column in schema
            )
            if with_spawn_edge and any(
                column[1] == "child_thread_id" for column in connection.execute("PRAGMA table_info(thread_spawn_edges)")
            ):
                projection.append("EXISTS (SELECT 1 FROM thread_spawn_edges WHERE child_thread_id = threads.id) AS spawned")
            select = ", ".join(projection)
            ids = sorted(thread_ids)
            for start in range(0, len(ids), INDEX_QUERY_BATCH):
                batch = ids[start:start + INDEX_QUERY_BATCH]
                placeholders = ",".join("?" for _ in batch)
                for row in connection.execute(f"SELECT {select} FROM threads WHERE id IN ({placeholders})", batch):
                    metadata[row["id"]] = dict(row)
    except (OSError, sqlite3.Error, ValueError):
        return {}
    return metadata


def main_thread_source(source: object, thread_source: object) -> bool | None:
    if thread_source in ("subagent", "guardian_review", "memory_consolidation"):
        return False
    if isinstance(source, str) and source.startswith("{"):
        try:
            source = json.loads(source)
        except (ValueError, RecursionError):
            return None
    if isinstance(source, dict):
        if "subagent" in source or "internal" in source:
            return False
        if source.keys() == {"custom"} and isinstance(source["custom"], str):
            return True
    if isinstance(source, str):
        if source in ("subagent", "internal") or source.startswith(("subagent_", "internal_")):
            return False
        if source in ("cli", "vscode", "exec", "mcp"):
            return True
    return True if thread_source == "user" else None


def main_thread_archives(home: Path, ids: set[str], indexed: dict[str, dict]) -> dict[str, bool]:
    main = {}
    unknown = ids - indexed.keys()
    for thread, row in indexed.items():
        if row.get("attached_thread_parent_id") or row.get("agent_role") or row.get("agent_nickname") or row.get("spawned"):
            continue
        kind = main_thread_source(row.get("source"), row.get("thread_source"))
        if kind is True:
            main[thread] = row.get("archived") == 1
        elif kind is None:
            unknown.add(thread)
    if not unknown:
        return main

    # An owned header can identify a thread missing from a lagging index.
    try:
        for path, owner, _ in local_rollouts(home):
            if owner not in unknown:
                continue
            try:
                header = local_rollout_header(path, owner)
                if (
                    thread_uuid(header.get("session_id", owner)) != owner
                    or header.get("attached_thread", False) is not False
                    or header.get("parent_thread_id") is not None
                    or header.get("subagent_history_start_ordinal") is not None
                    or header.get("agent_role")
                    or header.get("agent_nickname")
                ):
                    continue
                if main_thread_source(header.get("source"), header.get("thread_source")) is True:
                    main[owner] = (home / "archived_sessions" in path.parents
                                   or indexed.get(owner, {}).get("archived") == 1)
                    unknown.remove(owner)
                    if not unknown:
                        break
            except (OSError, ValueError, RecursionError):
                continue
    except (OSError, ValueError):
        pass
    return main


def thread_titles(home: Path, ids: set[str], metadata: dict[str, dict]) -> dict[str, str]:
    titles = {}
    for thread in ids:
        name = metadata.get(thread, {}).get("name")
        if isinstance(name, str) and name.strip():
            titles[thread] = " ".join(name.split())
    unnamed = ids - titles.keys()
    if unnamed:
        # The last session-index entry can carry an explicit rename on older threads.
        try:
            with (home / "session_index.jsonl").open(encoding="utf-8", errors="replace") as index:
                for line in index:
                    try:
                        entry = json.loads(line)
                    except (ValueError, RecursionError):
                        continue
                    if not isinstance(entry, dict):
                        continue
                    thread, title = entry.get("id"), entry.get("thread_name")
                    if isinstance(thread, str) and thread in unnamed and isinstance(title, str) and title.strip():
                        titles[thread] = " ".join(title.split())
        except OSError:
            pass
    for thread in ids - titles.keys():
        title = metadata.get(thread, {}).get("title")
        if isinstance(title, str) and title.strip():
            titles[thread] = " ".join(title.split())
    return titles


def thread_preview(metadata: dict) -> str | None:
    for field in ("preview", "first_user_message"):
        value = metadata.get(field)
        if isinstance(value, str) and value.strip():
            text = " ".join(value.split())
            if len(text) > 200:
                prefix = text[:197]
                boundary = prefix.rfind(" ")
                return (prefix[:boundary] if boundary >= 160 else prefix) + "..."
            return text
    return None


def checked_walk_error(error: OSError) -> None:
    raise error


def local_rollouts(home: Path) -> Iterator[tuple[Path, str, str]]:
    for directory in (home / "sessions", home / "archived_sessions"):
        try:
            directory.stat()
        except FileNotFoundError:
            continue
        for parent, _, files in os.walk(directory, onerror=checked_walk_error):
            for file in files:
                if not file.endswith((".jsonl", ".jsonl.zst")):
                    continue
                path = Path(parent) / file
                if identifier := rollout_id(path):
                    owner = file.removesuffix(".zst").removesuffix(".jsonl")[28:].split("_", 1)[0]
                    yield path, thread_uuid(owner), identifier


def unindexed_threads(home: Path, candidates: set[str]) -> set[str]:
    remaining = set(candidates)
    if not remaining:
        return remaining
    database = active_state_database(home)
    try:
        database.stat()
    except FileNotFoundError as error:
        raise ValueError(f"The active Codex thread database is unavailable: {database}") from error
    with closing(sqlite3.connect(f"{database.absolute().as_uri()}?mode=ro",
                                 uri=True, timeout=1.0)) as connection:
        connection.execute("BEGIN")
        backfill = connection.execute("SELECT status FROM backfill_state WHERE id = 1").fetchone()
        if backfill != ("complete",):
            raise ValueError("The local Codex thread index has not finished backfilling.")
        lookups = [("threads", "id"), ("thread_spawn_edges", "child_thread_id"),
                   ("thread_spawn_edges", "parent_thread_id")]
        if any(column[1] == "attached_thread_parent_id" for column in connection.execute("PRAGMA table_info(threads)")):
            lookups.append(("threads", "attached_thread_parent_id"))
        ids = sorted(candidates)
        for start in range(0, len(ids), INDEX_QUERY_BATCH):
            batch = ids[start:start + INDEX_QUERY_BATCH]
            params = ", ".join("?" for _ in batch)
            query = " UNION ALL ".join(
                f"SELECT {column} FROM {table} WHERE {column} IN ({params})" for table, column in lookups
            )
            for (identifier,) in connection.execute(query, batch * len(lookups)):
                remaining.discard(identifier)
    return remaining


def missing_threads(home: Path, candidates: set[str]) -> set[str]:
    remaining = unindexed_threads(home, candidates)
    if not remaining:
        return remaining

    try:
        index = (home / "session_index.jsonl").open(encoding="utf-8")
    except FileNotFoundError:
        pass  # Codex creates this optional index when it first saves a thread name.
    else:
        with index:
            for line in index:
                entry = json.loads(line)
                if not isinstance(entry, dict) or "id" not in entry:
                    raise ValueError("The Codex session index has an unreadable record.")
                remaining.discard(thread_uuid(entry["id"]))

    return remaining


def local_rollout_header(path: Path, owner: str) -> dict:
    with open_rollout(path) as stream:
        raw = stream.readline(MAX_ROLLOUT_HEADER + 1)
    if len(raw) > MAX_ROLLOUT_HEADER:
        raise ValueError("rollout header exceeds the cleanup scan limit")
    row = json.loads(raw)
    if not isinstance(row, dict) or row.get("type") != "session_meta":
        raise ValueError("rollout header is missing a session_meta record")
    header = row.get("payload")
    if not isinstance(header, dict) or thread_uuid(header.get("id")) != owner:
        raise ValueError("rollout header does not match its owning thread")
    return header


def rollout_parent(path: Path, owner: str) -> tuple[str | None, bool]:
    """Return a parent whose note or attachment may need protection."""
    header = local_rollout_header(path, owner)
    parent = header.get("forked_from_id")
    attached = header.get("attached_thread") is True
    if parent is not None:
        parent_id = thread_uuid(parent)
        if not attached and is_subagent(header):
            return None, False
        return parent_id, attached
    base = header.get("history_base")
    if attached or (base is not None and (not isinstance(base, dict) or thread_uuid(base.get("thread_id")) != owner)):
        raise ValueError("rollout has an unverified fork parent")
    return None, False


def preserve_fork_sources(
    home: Path, sources: set[str], rollouts: list[tuple[Path, str, str]]
) -> tuple[set[str], str]:
    if not sources:
        return set(), ""
    initialized = initialized_memory_threads(home)
    legacy = {item["thread_id"] for item in list_saved_threads(home)}
    note_sources = sources.intersection(initialized | legacy)
    owners = {}
    for path, owner, identifier in rollouts:
        owners.setdefault(owner, []).append((path, identifier == owner))
    uncertain = set()
    protected = set()
    attached_sources = set()
    scan_error = ""
    snapshot_error = ""
    for owner, paths in owners.items():
        # Reverts retain the relationship when the original header cannot be read.
        options = sorted(paths, key=lambda item: (not item[1], item[0].suffix == ".zst"))
        for path, _ in options:
            try:
                parent, attached = rollout_parent(path, owner)
                break
            except (OSError, ValueError, RecursionError) as error:
                last_error = str(error)
        else:
            uncertain.add(owner)
            scan_error = scan_error or last_error
            continue
        if parent not in sources:
            continue
        if attached:
            attached_sources.add(parent)
            continue
        if parent not in note_sources or owner in initialized:
            continue
        try:
            if initialize_thread_memory(home, owner) is None:
                raise ValueError(f"No owned fork note could be initialized for {owner}.")
        except (OSError, sqlite3.Error, ValueError, RecursionError) as error:
            protected.add(parent)
            snapshot_error = snapshot_error or str(error)
    reasons = []
    if uncertain and note_sources:
        protected.update(note_sources)
        reasons.append(f"Cannot verify fork lineage for {len(uncertain)} local thread(s). {scan_error}")
    elif protected:
        reasons.append(f"Could not preserve the fork-time note for {len(protected)} source thread(s). {snapshot_error}")
    if attached_sources:
        reasons.append(f"Surviving attached threads still reference {len(attached_sources)} source thread(s).")
    return protected | attached_sources, " ".join(reasons)


def cleanup(home: Path, args: dict) -> dict:
    requested = args.get("thread_ids")
    confirm = "thread_ids" in args
    if confirm and not isinstance(requested, list):
        raise ValueError("Expected a list of confirmed thread UUIDs.")
    kept, reason, index_warning = set(), "", ""
    try:
        candidates = set(map(thread_uuid, requested if confirm else stored_threads(home)))
        if not confirm:
            try:
                candidates.update({thread_uuid(owner) for owner in indexed_rollout_threads(home)})
            except (OSError, sqlite3.Error, ValueError, RolloutIndexUnavailable) as error:
                index_warning = f"Could not read the rollout search index. Retry cleanup later. {error}"
        remaining = missing_threads(home, candidates)
        rollouts = list(local_rollouts(home)) if remaining else []
        for _, owner, identifier in rollouts:
            remaining.discard(owner)
            remaining.discard(identifier)
        missing = sorted(remaining)
        if confirm and missing:
            kept, reason = preserve_fork_sources(home, set(missing), rollouts)
            # Unarchive can move a rollout behind the directory scan after repairing its index row.
            missing = sorted(unindexed_threads(home, set(missing) - kept))
    except (OSError, sqlite3.Error, ValueError, RecursionError) as error:
        return {"status": "unavailable", "thread_ids": [], "reason": str(error)}
    result = {"status": "ok", "thread_ids": missing}
    if confirm:
        if kept:
            result["kept_thread_ids"] = sorted(kept)
            result["reason"] = reason
        result["deleted"] = delete_handoff_threads(home, missing)
        try:
            result["deleted"] += delete_indexed_rollouts(home, missing)
        except (OSError, sqlite3.Error, RolloutIndexUnavailable) as error:
            index_warning = f"Could not clear the rollout search index. Retry cleanup later. {error}"
    if index_warning:
        result["index_warning"] = index_warning
    return result


def call_tool(home: Path, params: dict) -> dict:
    name = params.get("name")
    arguments = params.get("arguments", {})
    try:
        if not isinstance(name, str) or name not in TOOLS:
            raise ValueError("Unknown handoff tool.")
        _, _, properties, required = TOOLS[name]
        if (not isinstance(arguments, dict) or arguments.keys() - properties.keys()
                or not arguments.keys() >= set(required)):
            raise ValueError("Invalid handoff tool arguments.")
        if name == "handoff_list":
            result = thread_page(home, arguments)
        elif name == "handoff_read":
            thread = thread_uuid(arguments["thread_id"])
            summary, updated_at = read_current_note(home, thread)
            result = {"thread_id": thread, "summary": summary, "updated_at": updated_at}
        elif name == "handoff_cleanup":
            result = cleanup(home, arguments)
        elif name == "dependency_status":
            result = dependency_status()
        elif name == "install_dependencies":
            result = install_dependencies()
        else:
            result = {}
    except (ValueError, OSError, sqlite3.Error) as error:
        return {"content": [{"type": "text", "text": str(error)}], "isError": True}
    return {"content": [], "structuredContent": result}


def dispatch(home: Path, method: str, params: dict) -> dict:
    if method == "initialize":
        published = ("2024-11-05", "2025-03-26", "2025-06-18", "2025-11-25", "2026-07-28")
        version = params.get("protocolVersion")
        return {"protocolVersion": version if version in published else "2025-11-25",
                "capabilities": {"tools": {}, "resources": {}},
                "serverInfo": {"name": "thread-memory", "version": "1"}}
    if method == "ping":
        return {}
    if method == "tools/list":
        return {"tools": tool_descriptors()}
    if method == "tools/call":
        return call_tool(home, params)
    if method == "resources/list":
        return {"resources": [RESOURCE]}
    if method == "resources/templates/list":
        return {"resourceTemplates": []}
    if method == "resources/read":
        if params.get("uri") != RESOURCE["uri"]:
            raise ValueError("Unknown UI resource.")
        return {"contents": [{**RESOURCE, "text": ASSET.read_text(encoding="utf-8")}]}
    raise LookupError("Method not found.")


def respond(home: Path, raw: bytes) -> dict | None:
    reply = {"jsonrpc": "2.0", "id": None}
    try:
        request = json.loads(raw)
    except (UnicodeDecodeError, ValueError, RecursionError):
        return {**reply, "error": {"code": -32700, "message": "Parse error."}}
    if (not isinstance(request, dict) or request.get("jsonrpc") != "2.0"
            or not isinstance(request.get("method"), str)):
        return {**reply, "error": {"code": -32600, "message": "Invalid request."}}
    if "id" not in request:
        return None
    reply["id"] = request["id"]
    params = request.get("params", {})
    try:
        if not isinstance(params, dict):
            raise ValueError("Expected a parameter object.")
        reply["result"] = dispatch(home, request["method"], params)
    except LookupError as error:
        reply["error"] = {"code": -32601, "message": str(error)}
    except ValueError as error:
        reply["error"] = {"code": -32602, "message": str(error)}
    except OSError as error:
        reply["error"] = {"code": -32603, "message": str(error)}
    return reply


if __name__ == "__main__":
    home = Path(os.getenv("CODEX_HOME") or Path.home() / ".codex")
    for raw_line in sys.stdin.buffer:
        if response := respond(home, raw_line):
            sys.stdout.buffer.write(json.dumps(response, separators=(",", ":")).encode("ascii") + b"\n")
            sys.stdout.buffer.flush()
