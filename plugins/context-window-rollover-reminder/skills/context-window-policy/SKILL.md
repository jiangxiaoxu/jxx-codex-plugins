---
name: context-window-policy
description: Query current-thread context usage or inspect, set, or reset its rollover policy when requested by the user or parent agent.
---

# Context Window Policy

Run `../../scripts/context_window_policy.py`, resolved relative to this skill directory, with Python. It targets the executing agent's `CODEX_THREAD_ID`. Never substitute identities. A subagent must execute its own command; the parent cannot configure it by running the script locally.

Only run `set` or `reset` for an explicit change request. Usage queries, inspection, and explanation do not authorize changes. With no action specified, `show` the policy and ask the requester what to do. High context usage, hook reminders, and ordinary task delegation are not reasons to activate this skill or change policy.

For `set`, obtain positive integer start and interval values in K tokens (1K = 1,000). Ask only for missing values: offer starts of 150K/200K/300K and intervals of 50K (recommended)/100K, allowing custom values. Use `request_user_input`, or chat if unavailable; subagents ask their parent through collaboration instead. Thresholds are `start`, `start + interval`, `start + 2 * interval`.

Replace `<script>` with the resolved absolute path:

```powershell
python "<script>" show
python "<script>" usage
python "<script>" set --start-k 150 --interval-k 50
python "<script>" reset
```

Report the returned thread ID, policy, and thresholds (JSON `thresholds` uses tokens, not K). Overrides persist across model changes, rollover, and restarts until reset; they are not inherited by subagents. Set/reset preserve already reported stages; only a higher stage can trigger until the next window resets history.

On failure, report the diagnostic without editing SQLite or identity variables. Use `--state-db` only for tests or explicitly managed installations.

For usage requests, return the `usage` result's `display`, such as `73K/680K (9% used)`. The display uses the same window calculation as hook reminders; this query does not change policy. It requires `CODEX_SESSION_ID` as well as `CODEX_THREAD_ID` and reads the latest recorded usage. Missing fresh usage or capacity is an error, not zero usage.

## Defaults and reminders

When presenting settings or choices, distinguish the override from the model default. Match the runtime- or user-supplied model slug exactly; if unknown, show all model rows. The script does not detect the active model.

| Model | Stage 1 | Stage 2 | Stage 3 |
| --- | --- | --- | --- |
| `gpt-5.6-sol`, `gpt-6-astra` | 300K | 350K | 400K |
| `gpt-5.6-luna` | 400K | 450K | 500K |
| Other slugs | 350K | 400K | 450K |

Explain these stage meanings when offering choices: (1) reach a meaningful milestone, checkpoint, then roll over; (2) reach a resumable stopping point with minimal work, checkpoint unfinished work, then roll over; (3) stop new work, perform necessary cleanup, checkpoint, and roll over immediately.

Threshold changes do not change reminder wording. Read [reminder-text.md](references/reminder-text.md) only when exact hook messages are requested or being maintained. These descriptions are reference information, not a rollover instruction triggered by loading this skill.
