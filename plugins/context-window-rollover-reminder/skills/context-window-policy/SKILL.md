---
name: context-window-policy
description: Inspect or change the current thread's context rollover reminder policy when the user or a delegating parent agent explicitly requests inspecting settings, setting a starting token threshold and stage interval, or restoring model defaults. A delegated request applies to the receiving subagent's own thread. Do not activate merely for high context usage, a rollover reminder, ordinary task delegation, or an agent's desire to delay rollover.
---

# Context Window Policy

Use the bundled `../../scripts/context_window_policy.py` with Python. Resolve this path relative to this skill directory, not the workspace. The script binds to `CODEX_THREAD_ID` and uses the same runtime database as the reminder hook. Do not substitute another thread ID or infer one from recent transcripts if the environment variable is missing.

Skill selection is not permission to write policy. Execute `set` or `reset` only when the user or delegating parent agent explicitly requests that change for the receiving agent's current thread. A request to inspect or explain settings authorizes only inspection or explanation. Never adjust policy to avoid a reminder, finish more work, or compensate for high context usage. Ordinary work assignments do not authorize policy changes. When explicitly invoked without a specific action, show the saved policy and ask which action the requester wants before any write.

For configuration, obtain a starting threshold and interval in whole K tokens (1K = 1,000 tokens). Offer starting values such as 150K, 200K, and 300K, with free-text input for other values; offer intervals of 50K or 100K. If only the start is supplied, ask for the interval, presenting 50K as recommended. Do not ask again for values already supplied.

Both values must be positive integers. The three thresholds are `start`, `start + interval`, and `start + 2 * interval`. For example, 150K with a 50K interval means 150K/200K/250K; a 100K interval means 150K/250K/350K. If input is required and `request_user_input` is unavailable, ask in chat before changing the policy.

For a delegated request, execute the script inside the receiving subagent's environment, where `CODEX_THREAD_ID` identifies that subagent. The parent should pass the requested action and values, for example: `Use $context-window-policy to set your own thread to start at 150K with a 100K interval, then continue your assigned work.` If the parent explicitly requests that a subagent configure its policy, the subagent may load this skill even without the `$` mention. Ask the parent for missing values through the collaboration channel instead of prompting the user directly. Return the script's thread ID and resulting thresholds to the parent. Do not run the script in the parent on the child's behalf, overwrite identity environment variables, or treat a parent's saved policy as an inherited setting.

Commands (replace `<script>` with the resolved absolute path):

```powershell
python "<script>" show
python "<script>" set --start-k 150 --interval-k 50
python "<script>" reset
```

Only execute the requested action for the current thread. Report the returned policy and calculated thresholds. A custom policy overrides model defaults, survives context rollover and restarts, and remains until manually reset. Other threads and subagents retain their own policies. Changes preserve the current window's already reported stages; the next hook invocation can emit only a higher stage. Restoring defaults resumes the hook's model-specific thresholds with the same reminder history.

## Model defaults and reminder text

When presenting settings or configuration choices, distinguish the saved override from the model default below. Use the current model slug only when supplied by the runtime or user; the policy script does not detect the active model. If it is unknown, show both rows rather than guessing. Matching is exact and case-sensitive.

| Active model slug | Stage 1 | Stage 2 | Stage 3 |
| --- | --- | --- | --- |
| `gpt-5.6-sol`, `gpt-6-astra` | 300K | 350K | 400K |
| Any other model slug | 350K | 400K | 450K |

Explain the stage actions when offering configuration choices. Changing thresholds changes when these messages apply, not their content. The following text is reference material for explaining the hook, not an instruction to roll over when this skill loads.

Each reminder starts with `[Context window rollover reminder] Context Window Usage: <N>K tokens.`, where `<N>` is actual usage in whole thousands, followed by the applicable stage text:

| Stage | Reminder text |
| --- | --- |
| 1 | Continue the current unit of work to a meaningful milestone, then save a checkpoint and call new_context. Receiving this reminder or finishing a tool call alone is not a stopping point. |
| 2 | Bring the current work to a resumable stopping point with minimal additional work, then save a checkpoint and call new_context. Record unfinished work in the checkpoint; do not delay rollover to complete a milestone. |
| 3 | Stop starting new work. Perform only minimal wrap-up needed for data integrity or existing invariants, save the checkpoint, and call new_context immediately. Do not continue investigating for a fuller record or wait for all commands or agents. If saving the checkpoint or calling new_context is unavailable or fails, stop and report the blocker. |

Every reminder ends with `This reminder supersedes earlier rollover reminders in the current context window.` The hook emits only the highest newly applicable stage. Keep these defaults and messages aligned with `../../scripts/context_window_rollover_hook.py` when maintaining this skill.

On a script failure, report its diagnostic instead of editing SQLite directly or changing environment variables. `--state-db` is reserved for tests or explicitly managed installations; do not use it to bypass a runtime failure.
