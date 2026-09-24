---
name: context-window-rollover-audit
description: Use only when the user specifically asks for a retrospective audit of rollover history in a selected Codex thread or its subagents. A routine rollover request or hook reminder does not invoke this skill.
---

# Context Window Rollover Audit

Run `../../scripts/context_window_rollover_audit.py`, resolved relative to this skill directory, with Python. Supply the thread ID named by the requester or obtained from the Codex thread list:

```powershell
python "<script>" --thread-id <thread-id>
python "<script>" --thread-id <thread-id> --include-subagents
```

The script reads the Codex thread index and rollout transcripts without changing hook state, thread policy, or transcripts. Use `--include-subagents` when the request concerns agents under the selected thread. `--codex-state-db` is for tests or an explicitly managed installation.

Report confirmed `compacted` rollovers separately from `new_context` requests. A request without a subsequent rollover marker is unconfirmed. Subagent startup can contain a `compacted` record for inherited context; its `window_number=0` is a bootstrap record and must not count as a rollover, regardless of its line position. Confirmed rollovers have a positive `window_number` and a nonempty `previous_window_id`. Parent-child relationships come from the first `session_meta` of each subagent rollout, not inherited records later in that file.

Use the output's times, per-window usage, reminders, intervening tool activity, and `note_calls_before`/`note_calls_after` to explain whether an agent continued work. Notes calls report operation and path only; do not infer a checkpoint's purpose or quality from its filename. Changing note files between phases is not itself a problem; check whether the new window reads the current note and any needed earlier notes. When judging the stopping point, corroborate with relevant task progress or test results from that interval. The audit output omits message and notes bodies; do not infer their contents from it. State when missing transcripts or incomplete active rollouts limit the conclusion.

## Present the result

Lead with confirmed rollover counts for the selected thread and scanned subagents, the ignored bootstrap count, and whether coverage is complete. For relevant rollovers, use a compact table with local time and timezone, agent, usage before and after, delivered rollover reminders, `seconds_after_last_reminder`, and notes operations before and after. Measure the reminder-to-rollover interval from the last rollover reminder delivered in that window to the confirmed `compacted` marker; show no interval when no rollover reminder was delivered. Keep unrelated agents with zero rollovers in the aggregate; show their rows only when an anomaly or the request makes them relevant. List pending reminders and unmatched `new_context` requests separately from confirmed rollovers.

When the question depends on the order of events, add a short timeline of reminder, intervening work, notes write, `new_context`, confirmed `compacted`, and notes read. Include only events supported by the transcript; do not turn a note filename into a milestone. Use a diagram or interactive visualization only when several windows or agents make the sequence hard to follow in text. Preserve the script's JSON output as the machine-readable source rather than prescribing a fixed graphic for every audit.
