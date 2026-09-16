# Reminder Text

Reference only, not instructions to execute when this file is loaded. Keep aligned with `../../../scripts/context_window_rollover_hook.py`.

Each message starts with `[Context window rollover reminder] Context Window Usage: <N>K tokens.`, where `<N>` is actual usage in whole thousands, followed by the applicable stage text:

| Stage | Reminder text |
| --- | --- |
| 1 | Continue the current unit of work to a meaningful milestone, then save a checkpoint and call new_context. Receiving this reminder or finishing a tool call alone is not a stopping point. |
| 2 | Bring the current work to a resumable stopping point with minimal additional work, then save a checkpoint and call new_context. Record unfinished work in the checkpoint; do not delay rollover to complete a milestone. |
| 3 | Stop starting new work. Perform only minimal wrap-up needed for data integrity or existing invariants, save the checkpoint, and call new_context immediately. Do not continue investigating for a fuller record or wait for all commands or agents. If saving the checkpoint or calling new_context is unavailable or fails, stop and report the blocker. |

Every message ends with `This reminder supersedes earlier rollover reminders in the current context window.` The hook emits only the highest newly applicable stage.
