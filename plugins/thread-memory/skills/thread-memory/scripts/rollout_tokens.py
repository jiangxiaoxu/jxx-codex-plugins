"""Report provider-observed token counts without exposing encrypted payloads."""

from __future__ import annotations

from collections.abc import Iterable
from itertools import islice
from pathlib import Path

from rollout_refs import parse_row_cursor, row_cursor

SUMMARY_TYPES = {"compaction", "compaction_summary", "context_compaction"}
USAGE_FIELDS = (
    "input_tokens",
    "cached_input_tokens",
    "cache_write_input_tokens",
    "output_tokens",
    "reasoning_output_tokens",
    "total_tokens",
)
SUMMARY_FIELD = "encrypted_summary_output_tokens"


def token_count(value: object) -> int | None:
    return value if type(value) is int and value >= 0 else None


def encrypted_record(row: dict) -> dict | None:
    """Return count-only metadata for opaque reasoning or compaction records."""
    payload = row.get("payload") or {}
    item_type = payload.get("type")
    if row["type"] == "response_item":
        if item_type == "reasoning" and payload.get("encrypted_content"):
            return {"kind": "encrypted_reasoning", "tokens": None}
        if item_type in SUMMARY_TYPES and payload.get("encrypted_content"):
            return {"kind": "encrypted_summary", "tokens": None}
    if row["type"] == "event_msg":
        item = payload.get("item") or {}
        if item_type in ("agent_reasoning", "agent_reasoning_raw_content") or (
            item_type == "item_completed" and item.get("type") == "Reasoning"
        ):
            return {
                "kind": "reasoning",
                "tokens": token_count(payload.get("content_token_count")),
            }
    if row["type"] == "compacted" and any(
        item.get("type") in SUMMARY_TYPES and item.get("encrypted_content")
        for item in payload.get("replacement_history") or []
    ):
        usage = payload.get("latest_token_usage_record") or {}
        count = None
        if payload.get("compaction_response_id") and payload[
            "compaction_response_id"
        ] == usage.get("response_id"):
            count = token_count((usage.get("usage") or {}).get("output_tokens"))
        return {
            "kind": "encrypted_summary",
            "tokens": count,
            "scope": "compaction_response",
        }
    return None


class TokenUsage:
    """Aggregate observed provider counts and attribute encrypted compaction output."""

    def __init__(self) -> None:
        self.responses: dict[str, dict] = {}
        self.summaries: list[tuple[str | None, dict]] = []

    def add(self, path: Path, line: int, row: dict) -> None:
        payload = row.get("payload") or {}
        if row["type"] == "token_usage_record":
            response_id = payload.get("response_id")
            if (
                isinstance(response_id, str)
                and response_id
                and isinstance(payload.get("usage"), dict)
            ):
                usage = {
                    field: token_count(payload["usage"].get(field))
                    for field in USAGE_FIELDS
                }
                self.responses[response_id] = {
                    "response_id": response_id,
                    "turn_id": payload.get("turn_id"),
                    "path": str(path),
                    "line": line,
                    "timestamp": row.get("timestamp"),
                    **row.get("_rollout_provenance", {}),
                    "usage": usage,
                }
        elif (
            row["type"] == "compacted"
            or (row["type"] == "response_item" and payload.get("type") in SUMMARY_TYPES)
        ) and (summary := encrypted_record(row)):
            info = {
                "path": str(path),
                "line": line,
                "timestamp": row.get("timestamp"),
                "window": token_count(payload.get("window_number"))
                if row["type"] == "compacted"
                else None,
                **row.get("_rollout_provenance", {}),
                **summary,
            }
            self.summaries.append((payload.get("compaction_response_id"), info))

    def report(self) -> dict:
        sums = dict.fromkeys(USAGE_FIELDS, 0)
        coverage = dict.fromkeys(USAGE_FIELDS, 0)
        for response in self.responses.values():
            for field, count in response["usage"].items():
                if count is not None:
                    sums[field] += count
                    coverage[field] += 1

        summaries = []
        summary_counts = {}
        for response_id, summary in self.summaries:
            response = self.responses.get(response_id)
            count = response["usage"]["output_tokens"] if response is not None else None
            if count is None:
                count = summary["tokens"]
            if response_id and count is not None:
                summary_counts[response_id] = count
            summaries.append({**summary, "response_id": response_id, "tokens": count})
        sums[SUMMARY_FIELD] = sum(summary_counts.values())
        coverage[SUMMARY_FIELD] = len(summary_counts)
        return {
            "totals": {
                field: count if coverage[field] else None
                for field, count in sums.items()
            },
            "response_count": len(self.responses),
            "responses_with_usage": coverage,
            "encrypted_summaries": summaries,
        }


def usage_for(
    rows: Iterable[tuple[Path, int, dict]],
    *,
    by_response: bool = False,
    by_summary: bool = False,
    limit: int = 20,
    cursor: str | None = None,
) -> dict:
    if by_response and by_summary:
        raise ValueError("Choose either response or encrypted summary details")
    if cursor is not None and not (by_response or by_summary):
        raise ValueError("A token usage cursor requires a detail mode")
    if by_summary and cursor is not None:
        parse_row_cursor(cursor)
    if (by_response or by_summary) and limit < 1:
        raise ValueError("Token usage page limit must be positive")
    usage = TokenUsage()
    for path, line, row in rows:
        usage.add(path, line, row)
    result = usage.report()
    summaries = result.pop("encrypted_summaries")
    result["encrypted_summary_count"] = len(summaries)
    if by_response:
        field = "responses"
        details = iter(usage.responses.items())
    elif by_summary:
        field = "encrypted_summaries"
        details = (
            (row_cursor(Path(summary["path"]), summary["line"]), summary)
            for summary in summaries
        )
    else:
        return result

    if cursor is not None:
        for key, _ in details:
            if key == cursor:
                break
        else:
            raise ValueError(f"Unknown {field} cursor in the selected scope: {cursor}")
    page = list(islice(details, limit))
    result[field] = [entry for _, entry in page]
    result["next_cursor"] = page[-1][0] if next(details, None) else None
    return result
