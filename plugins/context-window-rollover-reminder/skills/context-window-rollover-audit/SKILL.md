---
name: context-window-rollover-audit
description: Audit a selected Codex thread's rollover history and descendant subagents only when the user explicitly requests it. Routine rollover requests and hook reminders do not invoke this skill.
---

# Context Window Rollover Audit

Resolve `<script>` to `../../scripts/context_window_rollover_audit.py` relative to this skill directory. Use a supplied thread ID directly, or extract `<id>` from a `codex://threads/<id>` link, excluding any query or fragment. Resolve a chat name through the Codex thread list only when no ID or thread link is supplied. Always include descendant subagents:

```powershell
python "<script>" --thread-id <thread-id> --include-subagents
```

Present the table unchanged. Add `--format json` when boundary lines, timestamps, or structured details are needed. For agents with confirmed rollovers, locate their rollout through read-only `threads.rollout_path` lookups in the script's Codex `state_5.sqlite` index. Read relevant boundary intervals to explain work before rollover and recovery afterward; do not scan unrelated threads or directories.

Follow recorded reminders, work, checkpoint writes, `new_context`, `compacted`, notes reads, and subsequent actions. Distinguish evidence from inference: events may be absent, notes writes are not necessarily checkpoints, and filenames alone do not prove content, checkpoint quality, or recovery.

Use the script's confirmed rollover classification; unconfirmed requests and inherited startup context are excluded. Report incomplete coverage or errors without guessing missing events or searching fallback databases/transcripts. `--codex-state-db` is reserved for tests or explicitly managed installations.
