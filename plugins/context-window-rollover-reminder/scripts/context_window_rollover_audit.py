"""Read-only, metadata-only audit of context window rollovers in Codex rollouts."""

from __future__ import annotations

import argparse
from contextlib import closing
from datetime import datetime
import json
import os
from pathlib import Path
import re
import sqlite3
import sys


REMINDER_TAG = "<context_window_rollover_reminder>"
USAGE_TAG = re.compile(r"Context Window Usage:\s*(\d+)K/(\d+)K")
NOTE_CALLS = {"write_file": "write", "append_to_file": "append", "read_file": "read"}


def default_codex_state_db() -> Path:
    return Path(os.environ.get("CODEX_HOME", Path.home() / ".codex")) / "state_5.sqlite"


def indexed_threads(database: Path, thread_id: str, include_subagents: bool) -> list[dict]:
    """Use the Codex index for paths and spawn edges; never write to it."""
    uri = f"{database.resolve().as_uri()}?mode=ro"
    with closing(sqlite3.connect(uri, uri=True)) as connection:
        connection.row_factory = sqlite3.Row
        if include_subagents:
            rows = connection.execute(
                """
                WITH RECURSIVE descendants(id) AS (
                    SELECT ?
                    UNION
                    SELECT e.child_thread_id
                    FROM thread_spawn_edges AS e
                    JOIN descendants ON e.parent_thread_id = descendants.id
                )
                SELECT descendants.id, threads.rollout_path, threads.thread_source,
                       edge.parent_thread_id AS indexed_parent
                FROM descendants
                LEFT JOIN threads ON threads.id = descendants.id
                LEFT JOIN thread_spawn_edges AS edge ON edge.child_thread_id = descendants.id
                """,
                (thread_id,),
            ).fetchall()
        else:
            rows = connection.execute(
                "SELECT id, rollout_path, thread_source, NULL AS indexed_parent "
                "FROM threads WHERE id = ?",
                (thread_id,),
            ).fetchall()
    if not rows:
        return [{"id": thread_id, "depth": 0, "rollout_path": None, "thread_source": None, "indexed_parent": None, "index_record_missing": True}]
    nodes = {row["id"]: dict(row) for row in rows}
    children: dict[str, list[str]] = {}
    for row in rows:
        parent = row["indexed_parent"]
        if parent is not None:
            children.setdefault(parent, []).append(row["id"])
    ordered = []
    frontier = [(thread_id, 0)]
    visited = set()
    while frontier:
        agent_id, depth = frontier.pop(0)
        if agent_id in visited or agent_id not in nodes:
            continue
        visited.add(agent_id)
        node = nodes[agent_id]
        node["depth"] = depth
        ordered.append(node)
        frontier.extend((child, depth + 1) for child in sorted(children.get(agent_id, [])))
    return ordered


def timestamp_seconds(timestamp: str | None) -> float | None:
    if not isinstance(timestamp, str):
        return None
    try:
        return datetime.fromisoformat(timestamp.replace("Z", "+00:00")).timestamp()
    except ValueError:
        return None


def duration(start: str | None, end: str | None) -> float | None:
    first, last = timestamp_seconds(start), timestamp_seconds(end)
    return round(last - first, 3) if first is not None and last is not None else None


def positive_token_count(value: object) -> int | None:
    return value if type(value) is int and value >= 0 else None


def first_meta_parent(meta: dict) -> str | None:
    source = meta.get("source")
    if not isinstance(source, dict):
        return None
    subagent = source.get("subagent")
    if not isinstance(subagent, dict):
        return None
    spawn = subagent.get("thread_spawn")
    if not isinstance(spawn, dict):
        return None
    parent = spawn.get("parent_thread_id")
    return parent if isinstance(parent, str) and parent else None


def marker_kind(payload: dict) -> str:
    number = payload.get("window_number")
    if type(number) is int and number == 0:
        return "bootstrap"
    previous = payload.get("previous_window_id")
    current = payload.get("window_id")
    if (
        type(number) is int
        and number > 0
        and isinstance(previous, str)
        and bool(previous)
        and isinstance(current, str)
        and bool(current)
        and previous != current
    ):
        return "rollover"
    return "unclassified"


def reminder_metadata(payload: dict) -> dict | None:
    if payload.get("type") != "message" or payload.get("role") != "developer":
        return None
    content = payload.get("content")
    if not isinstance(content, list):
        return None
    for part in content:
        if not isinstance(part, dict) or part.get("type") != "input_text":
            continue
        message = part.get("text")
        if not isinstance(message, str) or REMINDER_TAG not in message:
            continue
        usage = USAGE_TAG.search(message)
        return {
            "usage_k": int(usage.group(1)) if usage else None,
            "capacity_k": int(usage.group(2)) if usage else None,
        }
    return None


def note_call_metadata(payload: dict) -> dict | None:
    """Extract only a notes call's operation and path, never its body."""
    operation = NOTE_CALLS.get(payload.get("name"))
    if payload.get("type") != "function_call" or operation is None:
        return None
    arguments = payload.get("arguments")
    if not isinstance(arguments, str):
        return None
    try:
        path = json.loads(arguments).get("path")
    except (ValueError, AttributeError):
        return None
    if not isinstance(path, str):
        return None
    return {"operation": operation, "path": path}


def discard_inherited_events(result: dict) -> None:
    """A child bootstrap proves every earlier apparent event was inherited."""
    result["real_rollovers"] = 0
    result["rollovers"].clear()
    result["unclassified_compacted"] = 0
    result["unmatched_new_context_requests"].clear()
    result["note_calls"].clear()


def parse_rollout(path: Path, expected_id: str, is_subagent: bool) -> tuple[dict, dict]:
    """Return the first session identity and a redacted event summary."""
    first_meta: dict | None = None
    result = {
        "real_rollovers": 0,
        "bootstrap_compacted_ignored": 0,
        "unclassified_compacted": 0,
        "rollovers": [],
        "unmatched_new_context_requests": [],
        "note_calls": [],
        "pending_reminders": [],
        "pending_tool_calls_after_first_reminder": 0,
        "pending_work_tool_calls_after_first_reminder": 0,
    }
    reminders: list[dict] = []
    requests: list[dict] = []
    window_note_calls: list[dict] = []
    latest_rollover: dict | None = None
    current_window_number = 0
    tool_calls_after_reminder = 0
    work_tool_calls_after_reminder = 0
    latest_usage: int | None = None
    awaiting_post_usage: dict | None = None
    waiting_local_start = False
    inherited_meta_seen = False

    with path.open("r", encoding="utf-8") as stream:
        for line_number, line in enumerate(stream, 1):
            try:
                item = json.loads(line)
            except (json.JSONDecodeError, UnicodeDecodeError):
                # A live rollout can end with an unfinished JSON line.
                if not line.endswith("\n"):
                    break
                raise ValueError(f"invalid JSON at line {line_number}") from None
            if not isinstance(item, dict):
                raise ValueError(f"non-object record at line {line_number}")
            kind = item.get("type")
            payload = item.get("payload")
            if not isinstance(payload, dict):
                payload = {}
            timestamp = item.get("timestamp")
            if not isinstance(timestamp, str):
                timestamp = None

            if kind == "session_meta":
                if first_meta is None:
                    # Inherited history can contain later parent session_meta rows.
                    first_meta = payload
                elif is_subagent and not inherited_meta_seen:
                    # A second session_meta marks inherited parent history. The
                    # child's first local turn starts after thread_settings_applied.
                    waiting_local_start = True
                    inherited_meta_seen = True
                    discard_inherited_events(result)
                    reminders.clear()
                    requests.clear()
                    window_note_calls.clear()
                    latest_rollover = None
                    current_window_number = 0
                    tool_calls_after_reminder = 0
                    work_tool_calls_after_reminder = 0
                    latest_usage = None
                continue
            if waiting_local_start:
                if kind == "compacted" and marker_kind(payload) == "bootstrap":
                    discard_inherited_events(result)
                    result["bootstrap_compacted_ignored"] += 1
                if kind == "event_msg" and payload.get("type") == "thread_settings_applied":
                    waiting_local_start = False
                continue
            if kind == "token_usage_record":
                usage = payload.get("usage")
                tokens = positive_token_count(usage.get("total_tokens")) if isinstance(usage, dict) else None
                if tokens is not None:
                    latest_usage = tokens
                    if awaiting_post_usage is not None:
                        awaiting_post_usage["usage_after_tokens"] = tokens
                        awaiting_post_usage = None
                continue
            if kind == "response_item":
                reminder = reminder_metadata(payload)
                if reminder is not None:
                    reminder.update({"timestamp": timestamp, "line": line_number})
                    reminders.append(reminder)
                if payload.get("type") in {"function_call", "custom_tool_call"}:
                    if reminders:
                        tool_calls_after_reminder += 1
                        if payload.get("name") not in {*NOTE_CALLS, "new_context"}:
                            work_tool_calls_after_reminder += 1
                    if payload.get("type") == "function_call" and payload.get("name") == "new_context":
                        requests.append({
                            "timestamp": timestamp,
                            "line": line_number,
                            "latest_usage_before_request_tokens": latest_usage,
                        })
                    note_metadata = note_call_metadata(payload)
                    if note_metadata is not None:
                        note_call = {
                            **note_metadata,
                            "timestamp": timestamp,
                            "line": line_number,
                            "window_number": current_window_number,
                        }
                        window_note_calls.append(note_call)
                        result["note_calls"].append(note_call)
                        if latest_rollover is not None:
                            latest_rollover["note_calls_after"].append(note_call)
                continue
            if kind != "compacted":
                continue

            classification = marker_kind(payload)
            if classification == "bootstrap":
                discard_inherited_events(result)
                result["bootstrap_compacted_ignored"] += 1
                # Everything before a bootstrap marker belongs to inherited context.
                reminders.clear()
                requests.clear()
                window_note_calls.clear()
                latest_rollover = None
                current_window_number = 0
                tool_calls_after_reminder = 0
                work_tool_calls_after_reminder = 0
                latest_usage = None
                awaiting_post_usage = None
                continue
            if classification == "unclassified":
                result["unclassified_compacted"] += 1
                continue

            embedded_record = payload.get("latest_token_usage_record")
            embedded_usage = embedded_record.get("usage") if isinstance(embedded_record, dict) else None
            embedded_tokens = positive_token_count(embedded_usage.get("total_tokens")) if isinstance(embedded_usage, dict) else None
            before = embedded_tokens if embedded_tokens is not None else latest_usage
            request = requests.pop() if requests else None
            for leftover in requests:
                result["unmatched_new_context_requests"].append(leftover)
            last_reminder = reminders[-1] if reminders else None
            rollover = {
                "timestamp": timestamp,
                "line": line_number,
                "window_number": payload["window_number"],
                "previous_window_id": payload["previous_window_id"],
                "window_id": payload["window_id"],
                "trigger": "explicit_new_context" if request else "unknown",
                "new_context_request": request,
                "usage_before_tokens": before,
                "usage_after_tokens": None,
                "reminders": reminders.copy(),
                "seconds_after_last_reminder": duration(last_reminder["timestamp"], timestamp) if last_reminder else None,
                "seconds_after_new_context_request": duration(request["timestamp"], timestamp) if request else None,
                "tool_calls_after_first_reminder": tool_calls_after_reminder,
                "work_tool_calls_after_first_reminder": work_tool_calls_after_reminder,
                "note_calls_before": window_note_calls.copy(),
                "note_calls_after": [],
            }
            result["rollovers"].append(rollover)
            result["real_rollovers"] += 1
            awaiting_post_usage = rollover
            latest_rollover = rollover
            current_window_number = payload["window_number"]
            reminders.clear()
            requests.clear()
            window_note_calls.clear()
            tool_calls_after_reminder = 0
            work_tool_calls_after_reminder = 0
            latest_usage = None

    result["unmatched_new_context_requests"].extend(requests)
    result["pending_reminders"] = reminders
    result["pending_tool_calls_after_first_reminder"] = tool_calls_after_reminder
    result["pending_work_tool_calls_after_first_reminder"] = work_tool_calls_after_reminder
    if first_meta is None:
        raise ValueError("no session_meta")
    if first_meta.get("id") != expected_id:
        raise ValueError("first session_meta ID does not match index")
    result["inheritance_boundary_uncertain"] = waiting_local_start
    return first_meta, result


def audit(thread_id: str, database: Path, include_subagents: bool) -> dict:
    indexed = indexed_threads(database, thread_id, include_subagents)
    agents = []
    scanned = 0
    for row in indexed:
        agent_id = row["id"]
        agent = {
            "thread_id": agent_id,
            "depth": row["depth"],
            "indexed": not row.get("index_record_missing", False),
            "is_subagent": row.get("thread_source") == "subagent",
            "parent_thread_id": None,
            "coverage": "ok",
            "real_rollovers": None,
            "bootstrap_compacted_ignored": None,
            "unclassified_compacted": None,
            "rollovers": [],
            "unmatched_new_context_requests": [],
            "note_calls": [],
            "pending_reminders": [],
            "pending_tool_calls_after_first_reminder": 0,
            "pending_work_tool_calls_after_first_reminder": 0,
            "inheritance_boundary_uncertain": False,
        }
        path = row.get("rollout_path")
        if row.get("index_record_missing"):
            agent["coverage"] = "missing_index_record"
        elif not isinstance(path, str) or not path:
            agent["coverage"] = "missing_rollout_path"
        elif row["depth"] > 0 and row.get("thread_source") != "subagent":
            agent["coverage"] = "not_subagent"
        else:
            try:
                meta, parsed = parse_rollout(Path(path), agent_id, agent["is_subagent"])
            except OSError:
                agent["coverage"] = "unreadable_rollout"
            except ValueError as error:
                agent["coverage"] = "identity_mismatch" if "ID does not match" in str(error) else "malformed_rollout"
            else:
                parent = first_meta_parent(meta)
                agent["parent_thread_id"] = parent
                if row["depth"] > 0 and parent != row["indexed_parent"]:
                    agent["coverage"] = "parent_mismatch"
                else:
                    agent.update(parsed)
                    if parsed["inheritance_boundary_uncertain"]:
                        agent["coverage"] = "uncertain_inherited_prefix"
                        agent["real_rollovers"] = None
                        agent["unclassified_compacted"] = None
                    else:
                        scanned += 1
        agents.append(agent)
    summary = {
        "agents_indexed": sum(a["indexed"] for a in agents),
        "agents_scanned": scanned,
        "subagents_scanned": sum(a["coverage"] == "ok" and a["is_subagent"] for a in agents),
        "real_rollovers": sum(a["real_rollovers"] or 0 for a in agents),
        "subagent_real_rollovers": sum(a["real_rollovers"] or 0 for a in agents if a["is_subagent"]),
        "bootstrap_compacted_ignored": sum(a["bootstrap_compacted_ignored"] or 0 for a in agents),
        "subagent_bootstrap_compacted_ignored": sum(a["bootstrap_compacted_ignored"] or 0 for a in agents if a["is_subagent"]),
        "unclassified_compacted": sum(a["unclassified_compacted"] or 0 for a in agents),
        "unmatched_new_context_requests": sum(len(a["unmatched_new_context_requests"]) for a in agents),
        "coverage_incomplete": any(a["coverage"] != "ok" or (a["unclassified_compacted"] or 0) > 0 for a in agents),
    }
    return {
        "thread_id": thread_id,
        "include_subagents": include_subagents,
        "summary": summary,
        "agents": agents,
    }


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--thread-id", required=True, help="Explicit Codex thread ID")
    parser.add_argument("--include-subagents", action="store_true", help="Audit indexed descendants recursively")
    parser.add_argument("--codex-state-db", type=Path, default=default_codex_state_db())
    options = parser.parse_args(argv)
    try:
        output = audit(options.thread_id, options.codex_state_db, options.include_subagents)
    except (OSError, sqlite3.Error, ValueError) as error:
        print(json.dumps({
            "thread_id": options.thread_id,
            "coverage": "unreadable_index",
            "error": "cannot_read_codex_index",
            "detail": type(error).__name__,
        }), file=sys.stderr)
        return 2
    print(json.dumps(output, ensure_ascii=True, separators=(",", ":")))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
