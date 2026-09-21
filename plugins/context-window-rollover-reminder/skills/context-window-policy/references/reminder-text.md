# Reminder Text

Reference only, not instructions to execute when this file is loaded. Keep aligned with `../../../scripts/context_window_rollover_hook.py`.

With capacity available, a stage delivery contains these fragments in order:

```text
<context_window_usage_reminder>Context Window Usage: <USED>K/<WINDOW>K (<PERCENT>% used). <REMAINING>K tokens remaining.</context_window_usage_reminder>
<context_window_rollover_reminder><STAGE_TEXT> This reminder supersedes earlier rollover reminders in the current context window.</context_window_rollover_reminder>
```

The reminder window is `recorded_usable_window * 17 // 20`. Percentage follows
the CLI status calculation against that reminder window: subtract a 12K baseline from both window and
usage, calculate and round remaining percentage half up, then report its complement as used
percentage. Absolute remaining is the reminder window minus usage, clamped at zero. Whole-K values
are rounded down.
Periodic usage snapshots begin at 100K and advance in 25K thresholds. They do not include a
`supersedes` sentence.

Without capacity, a stage delivery uses
`<context_window_rollover_reminder>Context Window Usage: <N>K tokens. <STAGE_TEXT> ...</context_window_rollover_reminder>`,
where `<N>` is actual usage in whole thousands.

| Stage | Reminder text |
| --- | --- |
| 1 | Continue the current unit of work to a meaningful milestone, then save a checkpoint and call new_context. Receiving this reminder or finishing a tool call alone is not a stopping point. |
| 2 | Bring the current work to a resumable stopping point with minimal additional work, then save a checkpoint and call new_context. Record unfinished work in the checkpoint; do not delay rollover to complete a milestone. |
| 3 | Stop starting new work. Perform only minimal wrap-up needed for data integrity or existing invariants, save the checkpoint, and call new_context immediately. Do not continue investigating for a fuller record or wait for all commands or agents. If saving the checkpoint or calling new_context is unavailable or fails, stop and report the blocker. |

Every rollover fragment ends with `This reminder supersedes earlier rollover reminders in the current context window.` The hook emits only the highest newly applicable stage.
