"""Resolve the handoff reminder line from the Codex home configuration."""

from __future__ import annotations

import json
import os
from dataclasses import dataclass
from enum import IntEnum
from pathlib import Path

try:
    import tomllib
except ModuleNotFoundError:
    try:
        import tomli as tomllib
    except ModuleNotFoundError:
        tomllib = None


COMPATIBLE_ASYNC_PERCENTS = (65, 80)
DEFAULT_LEAD_TOKENS = 45_000
CHECK_LEAD_TOKENS = 35_000
FINAL_CHECK_LEAD_TOKENS = 25_000
START_TOKENS_ENV = "THREAD_MEMORY_ASYNC_START_TOKENS"
LEAD_TOKENS_ENV = "THREAD_MEMORY_HANDOFF_LEAD_TOKENS"
MAX_TOKENS = (1 << 63) - 1


class ReminderStage(IntEnum):
    FIRST = 0
    CHECK = 1
    FINAL_CHECK = 2
    RECORDED = 3


@dataclass(frozen=True)
class ReminderPlan:
    levels: tuple[tuple[int, int], ...]
    usable_window: int | None
    lead_tokens: int = DEFAULT_LEAD_TOKENS

    def reached(self, used: int) -> tuple[tuple[int, ReminderStage], ...]:
        """Return the last crossed trigger for each startup line."""
        reached = []
        for level, first_at in self.levels:
            if used < first_at:
                continue
            startup = first_at + self.lead_tokens
            if self.lead_tokens > FINAL_CHECK_LEAD_TOKENS and used >= startup - FINAL_CHECK_LEAD_TOKENS:
                stage = ReminderStage.FINAL_CHECK
            elif self.lead_tokens > CHECK_LEAD_TOKENS and used >= startup - CHECK_LEAD_TOKENS:
                stage = ReminderStage.CHECK
            else:
                stage = ReminderStage.FIRST
            reached.append((level, stage))
        return tuple(reached)


def _positive_int(value: object) -> int | None:
    if type(value) is int and 0 < value <= MAX_TOKENS:
        return value
    return None


def _env_tokens(name: str, default: int | None = None) -> int | None:
    value = os.environ.get(name)
    if value is None:
        return default
    value = value.strip()
    if not value.isascii() or not value.isdecimal():
        return None
    return _positive_int(int(value))


def _matching_model(path: Path, model: object) -> dict | None:
    catalog = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(catalog, dict) or not isinstance(catalog.get("models"), list):
        raise ValueError("invalid model catalog")
    for entry in catalog["models"]:
        if isinstance(entry, dict) and entry.get("slug") == model:
            return entry
    return None


def _resolved_window(home: Path, config: dict, model: object) -> tuple[int, int] | None:
    override = _positive_int(config.get("model_context_window"))
    if "model_context_window" in config and override is None:
        return None

    catalog_path = config.get("model_catalog_json")
    if catalog_path is not None and (
        not isinstance(catalog_path, str) or not catalog_path.strip()
    ):
        return None

    entry = None
    if isinstance(model, str) and model:
        if catalog_path is not None:
            # Relative paths are resolved from the directory of config.toml.
            path = Path(catalog_path)
            if path.parts[:1] == ("~",):
                path = Path(os.path.expanduser("~")).joinpath(*path.parts[1:])
            entry = _matching_model(home / path, model)
        if entry is None and catalog_path is None:
            try:
                entry = _matching_model(home / "models_cache.json", model)
            except FileNotFoundError:
                pass

    if entry is None:
        return None
    max_window = _positive_int(entry.get("max_context_window"))
    if entry.get("max_context_window") is not None and max_window is None:
        return None
    if override is not None:
        raw = override if max_window is None else min(override, max_window)
    else:
        window = entry.get("context_window")
        raw = max_window if window is None else _positive_int(window)
    usable_percent = _positive_int(entry.get("effective_context_window_percent", 95))
    if raw is None or usable_percent is None or usable_percent > 100:
        return None
    return raw, raw * usable_percent // 100


def _configured_plan(home: Path, model: object, lead: int) -> ReminderPlan | None:
    if tomllib is None:
        return None

    with (home / "config.toml").open("rb") as config_file:
        config = tomllib.load(config_file)
    features = config.get("features", {})
    if not isinstance(features, dict):
        return None
    token_budget = features.get("token_budget", False)
    if isinstance(token_budget, dict):
        token_budget = token_budget.get("enabled", False)
    if token_budget is not False:
        return None

    async_compaction = features.get("async_compaction", False)
    percents = set(COMPATIBLE_ASYNC_PERCENTS)
    if isinstance(async_compaction, dict):
        if "model_async_compact_threshold_percent" in async_compaction:
            percent = async_compaction["model_async_compact_threshold_percent"]
            if type(percent) is not int or not 1 <= percent <= 100:
                return None
            percents.add(percent)
        async_compaction = async_compaction.get("enabled", False)
    if async_compaction is not True:
        return None
    window = _resolved_window(home, config, model)
    if window is None:
        return None
    raw, usable = window
    # Codex starts once active_tokens * 100 >= resolved_window * percent.
    levels = tuple(
        (percent, threshold)
        for percent in sorted(percents)
        if (threshold := (raw * percent + 99) // 100 - lead) > 0
    )
    return ReminderPlan(levels, usable, lead) if levels else None


def reminder_plan(home: Path, model: object) -> ReminderPlan | None:
    """Resolve reminder levels, keeping an explicit startup-token override authoritative."""
    try:
        lead = _env_tokens(LEAD_TOKENS_ENV, DEFAULT_LEAD_TOKENS)
        if lead is None:
            return None
        if START_TOKENS_ENV in os.environ:
            startup = _env_tokens(START_TOKENS_ENV)
            if startup is None or startup <= lead:
                return None
            return ReminderPlan(((0, startup - lead),), None, lead)
        return _configured_plan(home, model, lead)
    except (OSError, ValueError, RecursionError):
        # Configuration is optional and can change independently of the hook.
        pass
    return None
