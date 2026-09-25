---
name: context-window-rollover-audit
description: Use only when the user specifically asks for a retrospective audit of rollover history in a selected Codex thread or its subagents. A routine rollover request or hook reminder does not invoke this skill.
---

# Context Window Rollover Audit

Run `../../scripts/context_window_rollover_audit.py`, resolved relative to this skill directory, with Python. Supply the thread ID named by the requester or obtained from the Codex thread list:

```powershell
python "<script>" --thread-id <thread-id>
python "<script>" --thread-id <thread-id> --include-subagents
python "<script>" --thread-id <thread-id> --include-subagents --format json
```

The script reads the Codex thread index and rollout transcripts without changing hook state, thread policy, or transcripts. Use `--include-subagents` when the request concerns agents under the selected thread. `--codex-state-db` is for tests or an explicitly managed installation.
The default output groups confirmed rollovers by agent. Each agent with a rollover has its own `线程` and `确认换窗` count followed by a compact Markdown table with local time, integer K token usage before and after (whole thousands, truncated), time since the last reminder, and note operations. A subagent section also shows `子代理名称` from `agent_path` and `agent_role`, using `?` for missing values; `agent_nickname` is not a name fallback. The notes column lists each distinct file path written or appended before the rollover and read in the adjacent new window. Agents with no confirmed rollover do not appear. Use `--format json` for structured data with raw token counts: its `summary` covers every indexed agent, while `agents` includes only agents with confirmed rollovers.

Report confirmed `compacted` rollovers separately from `new_context` requests. A request without a subsequent rollover marker is unconfirmed. Subagent startup can contain a `compacted` record for inherited context; its `window_number=0` is a bootstrap record and must not count as a rollover, regardless of its line position. Confirmed rollovers have a positive `window_number` and a nonempty `previous_window_id`. Parent-child relationships come from the first `session_meta` of each subagent rollout, not inherited records later in that file.

Use the default table as the rollover summary. For questions about work continuity or event order, inspect the relevant transcript intervals and request `--format json` only for confirmed rollover details that the table omits. Notes calls report operation and path only; do not infer a checkpoint's purpose or quality from its filename. Corroborate stopping points with task progress or test results. The audit omits message and notes bodies; do not infer their contents from it. State when aggregate coverage is incomplete; the compact output does not identify omitted agents with missing transcripts.

## Present the result

Report the script's table directly, with a brief explanation only where the user needs one. Do not list agents with zero confirmed rollovers or reconstruct the table from JSON. The interval is measured from the last rollover reminder in that window to the confirmed `compacted` marker; `-` means no reminder was delivered. Mention bootstrap records only when explaining a disputed count. If coverage is incomplete, state that the count may be understated.

When the question depends on event order, add a short transcript-backed timeline of reminder, intervening work, notes write, `new_context`, confirmed `compacted`, and notes read. Do not turn a note filename into a milestone. Use a diagram or interactive visualization only when several windows or agents make the sequence hard to follow in text.
