---
name: context-window-rollover-audit
description: Use only when the user specifically asks for a retrospective audit of rollover history in a selected Codex thread or its subagents. A routine rollover request or hook reminder does not invoke this skill.
---

# Context Window Rollover Audit

Resolve `../../scripts/context_window_rollover_audit.py` relative to this skill directory and run it with Python.

When the requester supplies a thread ID, use it directly. Do not list threads or traverse rollout directories before running the script. If only a chat name is supplied, use the Codex thread list to resolve its ID.

Always include `--include-subagents` so the audit covers the target thread and its descendant subagents. Run the default table command first. Use `--format json` for exact boundary lines, timestamps, and structured detail needed for the analysis. `--codex-state-db` is for tests or an explicitly managed installation.

```powershell
python "<script>" --thread-id <thread-id> --include-subagents
python "<script>" --thread-id <thread-id> --include-subagents --format json
```

Report the script's table directly. Then read the relevant rollout intervals for the target and descendant agents with confirmed rollovers to explain what happened before and after each rollover. Locate only the reported thread IDs through a read-only lookup of `threads.rollout_path` in the same Codex `state_5.sqlite` index used by the script. Use the reported boundary lines and timestamps to read focused intervals, expanding only as needed to understand the work and its resumption. Do not enumerate unrelated threads, scan rollout directories, or reconstruct the table from JSON. On script failure, report the diagnostic without searching for fallback transcripts or databases.

Summarize the recorded events for each relevant agent: reminder, intervening work, checkpoint writes, `new_context` request, confirmed `compacted` boundary, notes reads, and subsequent work. These events may be absent; do not invent missing steps or classify every notes write as a checkpoint. Distinguish observed events from inferred task continuity. Notes operations and filenames alone do not establish checkpoint quality or successful recovery; ground that assessment in the corresponding rollout content and subsequent actions. Do not infer note contents that the rollout does not expose.

Confirmed rollovers are `compacted` markers; an unconfirmed `new_context` request or inherited subagent startup is not a confirmed rollover. The script makes this distinction. Do not add agents with zero confirmed rollovers to the table. The reminder interval is `-` when no reminder was delivered. If coverage or the relevant rollout content is incomplete, state the limit instead of inferring missing events.
