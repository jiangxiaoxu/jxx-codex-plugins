---
name: context-window-policy
description: Manually configure the current thread's context rollover reminder thresholds using a starting token count and stage interval, inspect its policy, or restore model defaults. Use only when explicitly invoked.
---

# Context Window Policy

Use the bundled `../../scripts/context_window_policy.py` with Python. Resolve this path relative to this skill directory, not the workspace. The script binds to `CODEX_THREAD_ID` and uses the same runtime database as the reminder hook. Do not substitute another thread ID or infer one from recent transcripts if the environment variable is missing.

When invoked without a specific action, show the saved policy, then use `request_user_input` to offer configuring a policy or restoring model defaults. For configuration, obtain a starting threshold and interval in whole K tokens (1K = 1,000 tokens). Offer starting values such as 150K, 200K, and 300K, with free-text input for other values; offer intervals of 50K or 100K. If only the start is supplied, ask for the interval, presenting 50K as recommended. Do not ask again for values already supplied.

Both values must be positive integers. The three thresholds are `start`, `start + interval`, and `start + 2 * interval`. For example, 150K with a 50K interval means 150K/200K/250K; a 100K interval means 150K/250K/350K. If input is required and `request_user_input` is unavailable, ask in chat before changing the policy.

Commands (replace `<script>` with the resolved absolute path):

```powershell
python "<script>" show
python "<script>" set --start-k 150 --interval-k 50
python "<script>" reset
```

Only execute the requested action for the current thread. Report the returned policy and calculated thresholds. A custom policy overrides model defaults, survives context rollover and restarts, and remains until manually reset. Other threads and subagents retain their own policies. Changes preserve the current window's already reported stages; the next hook invocation can emit only a higher stage. Restoring defaults resumes the hook's model-specific thresholds with the same reminder history.

On a script failure, report its diagnostic instead of editing SQLite directly or changing environment variables. `--state-db` is reserved for tests or explicitly managed installations; do not use it to bypass a runtime failure.
