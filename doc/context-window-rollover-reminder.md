# Context Window Rollover Reminder

`context-window-rollover-reminder` installs a synchronous `PostToolUse` command hook. It reads the
active model and transcript path from standard input, checks usage in the Codex rollout transcript,
and emits `additionalContext` when either a higher reminder stage or a new periodic usage threshold
applies.

The hook selects three reminder thresholds from the active model slug supplied in hook input:

| Model | Stage 1 | Stage 2 | Stage 3 |
| --- | --- | --- | --- |
| `gpt-5.6-sol`, `gpt-6-astra`, `gpt-6-sol`, `gpt-6.1-sol`, `gpt-6.1-astra` (reserved) | 300,000 tokens | 350,000 tokens | 400,000 tokens |
| `gpt-5.6-luna`, `gpt-6-luna` | 400,000 tokens | 450,000 tokens | 500,000 tokens |
| All other model slugs | 350,000 tokens | 400,000 tokens | 450,000 tokens |

Model matching is exact and case-sensitive. The `model` input must be a nonempty string; missing
or invalid values fail with a request diagnostic. No aliases or context-capacity scaling are used.
Version 0.1.17 sets the Luna defaults to 400K/450K/500K.
Version 0.1.18 adds periodic usage snapshots beginning at 100K and then every 25K.
Version 0.1.20 adds `gpt-6-sol` to the strict group and `gpt-6-luna` to the Luna group.
Version 0.1.24 adds `gpt-6.1-sol` and the reserved `gpt-6.1-astra` slug to the strict group.
The reserved slug anticipates a future model name; it does not indicate model availability.
Version 0.1.25 removes the policy skill and its manual usage query and threshold commands.
The hook always uses model defaults and ignores any existing `thread_policies` table.
Existing reminder history is retained; no runtime database cleanup is required.
The audit skill always includes descendant subagents and runs the script directly for supplied
thread IDs. It then reads focused rollout intervals for confirmed boundaries to explain work
and recovery before and after rollover.
Each message reports actual usage in whole thousands and includes the applicable rollover action:

| Stage | Action |
| --- | --- |
| 1 | Continue the current unit of work to a meaningful milestone, then save a checkpoint and roll over. The reminder or a tool call finishing alone is not a stopping point. |
| 2 | Reach a resumable stopping point with minimal additional work, then save a checkpoint and roll over. Record unfinished work without waiting to complete a milestone. |
| 3 | Stop starting new work, finish only necessary cleanup, save the checkpoint, and roll over immediately. |

With capacity available, a stage delivery starts with a usage snapshot and then the rollover
instruction:

```text
<context_window_usage_reminder>Context Window Usage: 350K/500K (69% used). 150K tokens remaining.</context_window_usage_reminder>
<context_window_rollover_reminder>Continue the current unit of work ... This reminder supersedes earlier rollover reminders in the current context window.</context_window_rollover_reminder>
```

The usage snapshot has no `supersedes` sentence. When capacity is unavailable, periodic usage
snapshots are skipped, but a stage delivery still emits a rollover fragment containing actual usage,
for example `<context_window_rollover_reminder>Context Window Usage: 350K tokens. ...</context_window_rollover_reminder>`.

Rollover actions and window-local trigger rules are delivered by the hook. Checkpoint content and
notes path requirements remain in the applicable `AGENTS.md` as general context-management guidance.
These instructions apply to every project and agent using the plugin. They request agent actions;
the hook itself does not save checkpoints or invoke `new_context`, and does not replace Codex's
built-in context exhaustion or compaction handling.

The plugin supports Windows PowerShell and requires Python 3.10 or newer on `PATH`. Python's
standard library is sufficient; no third-party package, probe script, or packaged database is
required.

## Configuration

The plugin uses the default component discovery path `hooks/hooks.json`; the manifest deliberately
does not declare a `hooks` field. The discovered configuration registers one synchronous
`PostToolUse` command:

```json
{
  "hooks": {
    "PostToolUse": [
      {
        "matcher": ".*",
        "hooks": [
          {
            "type": "command",
            "command": "python \"$env:PLUGIN_ROOT/scripts/context_window_rollover_hook.py\"",
            "timeout": 10,
            "statusMessage": "Context-window-rollover-reminder plugin"
          }
        ]
      }
    ]
  }
}
```

The command uses Windows PowerShell and `python`. The hook runner provides `PLUGIN_ROOT` as an
environment variable; PowerShell reads it with `$env:PLUGIN_ROOT`, and the quoted path remains valid
when the plugin path contains spaces. The command is intended for a PowerShell hook runner; CMD
variable expansion is not supported by this configuration.
The hook has a 10-second timeout. Its status message describes each invocation in the UI,
independently of the three reminder thresholds.

## Runtime state and behavior

### Automatic usage calculation

The reminder denominator is `model_context_window * 17 // 20`, where the recorded
`model_context_window` is Codex's usable model window. For percentage calculations it follows the
CLI status formula against that reminder window: subtract a 12,000-token baseline from both the
window and usage, clamp adjusted usage and remaining values at zero, round remaining percentage to
the nearest integer with halves rounded up, then report `100 - remaining_percent` as used percentage.
A reminder window no larger than the baseline reports 100% used. Displayed K counts are rounded down,
and absolute remaining tokens are `max(reminder_window_tokens - used_tokens, 0)`. The hook reuses this
calculation for periodic usage reminders; it does not change the three rollover stage thresholds.

### Reminder history

By default the script stores state in `%CODEX_HOME%\state\context-window-rollover-reminder-v2.sqlite3`; when `%CODEX_HOME%` is unset,
the script falls back to `%USERPROFILE%\.codex\state\context-window-rollover-reminder-v2.sqlite3`. `--state-db` can
override that path for tests or an explicitly managed installation. The database is created on first
use and is runtime state, not a plugin artifact. Version 0.1.11 uses a new default state file because
historical token thresholds do not reliably identify reminder stages. It does not discover, read,
migrate, or delete previous default files. Its first applicable invocation reports the current stage
once, even if an earlier version already reported it.

State is keyed by the transcript thread ID. A compacted transcript resets the highest reported
stage, so a fresh context window can report the same stage again once fresh usage is available.
The stored `highest_stage` is an integer from 0 through 3, where 0 means no reminder has been reported.
Changing models preserves that history; a reminder is emitted only when the current applicable stage
exceeds the stored stage. For example, after stage 1 at 350K on a default model, switching to
`gpt-5.6-sol` at the same usage emits stage 2. Switching back does not repeat stage 1, and switching
between stricter models does not repeat an already reported stage.
Concurrent invocations use SQLite transaction locking so one stage crossing produces only one message. Old thread entries are
evicted after the existing 10,000-entry limit.

Periodic usage history lives in a separate `usage_reminder_state` table. Starting at 100,000 used
tokens, the hook reports the highest newly crossed 25,000-token threshold. If one inference skips
multiple thresholds, only one snapshot with the latest actual usage is emitted. The threshold state
resets after compaction and is deleted together with an evicted `session_state` row. Missing capacity
does not advance periodic usage state. A stage crossing with capacity always carries a fresh usage
snapshot, even if the periodic threshold was already reported; if both are due, both fragments are
returned in one `additionalContext`, with usage first.

The hook writes a compact JSON hook result to standard output only when a higher stage or periodic
usage threshold applies.
If usage skips thresholds, it emits only the highest applicable stage, without replaying earlier
stages. Once stage 3 has been reported, no further rollover reminders are emitted in that window,
even after switching models; periodic usage snapshots may still report newly crossed usage
thresholds until compaction.
`PostToolUse` samples usage after tool calls, so delivery may occur above a threshold.

A database passed through `--state-db` must provide the required state columns, including
`highest_stage`. Older schemas containing only `highest_threshold`, schemas missing required
columns, and invalid stage values fail with a state diagnostic; no schema migration or repair is performed.

Malformed requests, transcripts, identity mismatches, and state failures produce categorized
diagnostics on standard error and retain the existing exit codes.

## Historical rollover audit

Version 0.1.26 shortens the audit skill, adds thread-link ID extraction and OpenAI interface
metadata, and keeps activation limited to user-requested audits. Hook behavior is unchanged.
Version 0.1.21 adds the audit skill and CLI without changing hook behavior.
Version 0.1.23 makes the audit CLI print a per-agent rollover table by default. It omits agents
without confirmed rollovers, shows subagent paths and roles, lists distinct notes files on both
sides of each rollover, and displays token usage in whole K. `--format json` keeps exact token
counts but includes only agents with confirmed rollovers.

The separate `context-window-rollover-audit` skill uses
`scripts/context_window_rollover_audit.py` for a read-only, retrospective check. It accepts an
explicit local thread ID (including a subagent ID). The skill also extracts the ID from
`codex://threads/<id>` links, excluding any query or fragment, before invoking the script.
The skill always passes `--include-subagents`
to cover the target and its descendant subagents. For a supplied thread ID, it runs the script
first without separate thread listing or directory traversal. Only a chat name requires ID
resolution through the Codex thread list. After presenting the table, it uses JSON boundary
locations and read-only `threads.rollout_path` lookups for reported IDs to read focused rollout
intervals, explaining work and recovery around confirmed rollovers for the target and subagents.
It does not scan unrelated threads or rollout directories. The CLI flag remains explicit:

```powershell
python plugins/context-window-rollover-reminder/scripts/context_window_rollover_audit.py --thread-id <thread-id> --include-subagents
python plugins/context-window-rollover-reminder/scripts/context_window_rollover_audit.py --thread-id <thread-id> --include-subagents --format json
```

The command locates transcripts and descendant edges through the Codex `state_5.sqlite` thread
index. It reads the first `session_meta` of each rollout to verify a subagent's direct parent;
inherited parent metadata later in a subagent rollout must not create extra parent-child edges. It counts a
`compacted` record with positive `window_number` and nonempty `previous_window_id` as a
confirmed rollover. A subagent's startup `compacted` with `window_number=0` records inherited context and is excluded from rollover
counts even when other records appear before it. Parent reminders inherited in a subagent's
startup history are not attributed to that subagent's own work. A `new_context` call without a
following confirmed marker remains an unconfirmed request.

Default output groups confirmed rollovers by agent. Each agent with a rollover has its own
`线程` and `确认换窗` count followed by a compact Markdown table with local time, token usage
before and after as integer K (whole thousands, truncated), elapsed time since the last reminder,
and notes operations. A subagent section also shows `子代理名称` from `agent_path` and
`agent_role`, using `?` when either value is absent;
`agent_nickname` is not used as a name fallback. The notes column lists each distinct file path
written or appended before the rollover and read in the adjacent new window. Agents with no
confirmed rollover do not appear. `--format json` returns structured detail with raw token counts
for agents with confirmed rollovers. Its `summary` still covers every indexed agent.
There is no all-agent dump mode: a delegated thread can have many zero-rollover descendants, and
serializing their empty records would make the report grow with delegation instead of rollovers.

The JSON report provides rollout timing, usage around each window boundary, delivered reminder
events for included agents, notes read/write operations with paths,
and activity between reminder and rollover. `seconds_after_last_reminder` measures from the last
rollover reminder delivered in that window to the confirmed `compacted` marker; it is null when
there was no rollover reminder. Each rollover has `note_calls_before` and `note_calls_after` for
the adjacent windows. The script does not classify notes as checkpoints by filename or emit
message bodies, note contents, or tool arguments. The notes lists cover the adjacent windows,
not only the immediate rollover boundary; file operations alone do not establish checkpoint
quality or successful task recovery. Historical reminder events are taken
from the transcript; applying the currently installed threshold table to an older window can
misstate what the agent actually received after a plugin update. Transcript and index schemas
are Codex internals, so missing or incompatible data must be reported as a diagnostic rather
than interpreted as zero rollovers. `--codex-state-db` supports tests and explicitly managed
installations. This audit does not invoke the hook or change state or transcripts.

## Development and maintenance

Run the focused tests from the repository root:

```text
python -m unittest discover -s plugins/context-window-rollover-reminder/tests -p "test_*.py"
```

Validate the audit skill with the installed skill-creator validator:

```text
python <skill-creator>/scripts/quick_validate.py plugins/context-window-rollover-reminder/skills/context-window-rollover-audit
```

Validate the plugin manifest with the installed plugin-creator validator:

```text
python <plugin-creator>/scripts/validate_plugin.py plugins/context-window-rollover-reminder
```

When changing hook logic, keep the model-specific defaults, stage selection, state schema, transcript
parsing rules, and exit-code contract aligned with the tests. Keep
`hooks/hooks.json` synchronous unless the hook's output and state semantics are redesigned
together. Do not add the separate context-usage probe or commit generated SQLite state to the
plugin.
