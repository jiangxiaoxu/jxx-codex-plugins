"""Recover missing tool names from compatible prior wire records."""

from __future__ import annotations

from rollout_lineage import copied_origin
from rollout_source import Segment
from rollout_tool_outputs import METADATA_LABEL, NAMES

CALL_FAMILIES = {
    "function_call": "function_call",
    "local_shell_call": "function_call",
    "custom_tool_call": "custom_tool_call",
}
CALL_TYPES = set(CALL_FAMILIES)
RETURN_TYPES = {
    "function_call_output": "function_call",
    "custom_tool_call_output": "custom_tool_call",
}
TURN_BOUNDARIES = {
    "task_started",
    "turn_started",
    "task_complete",
    "turn_complete",
    "turn_aborted",
    "thread_rolled_back",
}


class ToolNameResolver:
    """Track prior call names within a single physical, unambiguous history."""

    def __init__(self, segment: Segment) -> None:
        self.segment = segment
        self.scope: tuple[str, str | None] | None = None
        self.calls: dict[tuple[str, str], tuple[str, str | None] | None] = {}

    def name_for(self, line: int, row: dict) -> str | None:
        kind = row["type"]
        item = row["payload"]
        item_type = item.get("type")
        if (
            row.get("_rollout_gap")
            or kind == "compacted"
            or (
                kind == "event_msg"
                and isinstance(item_type, str)
                and item_type in TURN_BOUNDARIES
            )
        ):
            self.calls.clear()
        if kind != "response_item" or not isinstance(item_type, str):
            return None
        if item_type not in CALL_TYPES and item_type not in RETURN_TYPES:
            return None

        origin = copied_origin(self.segment, line, row)
        scope = origin, row.get("_rollout_turn_id")
        if scope != self.scope:
            self.scope = scope
            self.calls.clear()
        if origin == "unknown":
            return None

        call_id = item.get("call_id")
        if not isinstance(call_id, str) or not METADATA_LABEL.fullmatch(call_id):
            return None
        namespace = item.get("namespace")
        if item_type in CALL_TYPES:
            key = CALL_FAMILIES[item_type], call_id
            name = item.get("name") or NAMES.get(item_type)
            # An unknown name or a repeated call makes the association ambiguous,
            # even if the known names agree. Only a unique compatible call counts.
            self.calls[key] = (
                (name, namespace)
                if key not in self.calls
                and isinstance(name, str)
                and METADATA_LABEL.fullmatch(name)
                and (namespace is None or isinstance(namespace, str))
                else None
            )
            return None

        if item.get("name") or item.get("tool"):
            return None
        candidate = self.calls.get((RETURN_TYPES[item_type], call_id))
        if candidate is None:
            return None
        name, call_namespace = candidate
        return name if namespace is None or namespace == call_namespace else None
