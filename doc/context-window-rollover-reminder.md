# Context Window Rollover Reminder

`context-window-rollover-reminder` installs a synchronous `PostToolUse` command hook. It reads the
active model and transcript path from standard input, checks usage in the Codex rollout transcript,
and emits `additionalContext` when either a higher reminder stage or a new periodic usage threshold
applies.

Without a thread override, the hook selects three reminder thresholds from the active model slug supplied in hook input:

| Model | Stage 1 | Stage 2 | Stage 3 |
| --- | --- | --- | --- |
| `gpt-5.6-sol`, `gpt-6-astra`, `gpt-6-sol` | 300,000 tokens | 350,000 tokens | 400,000 tokens |
| `gpt-5.6-luna`, `gpt-6-luna` | 400,000 tokens | 450,000 tokens | 500,000 tokens |
| All other model slugs | 350,000 tokens | 400,000 tokens | 450,000 tokens |

Model matching is exact and case-sensitive. The `model` input must be a nonempty string; missing
or invalid values fail with a request diagnostic. No aliases or context-capacity scaling are used.
Version 0.1.17 sets the Luna defaults to 400K/450K/500K and includes the `luna` group in policy output.
Version 0.1.18 adds periodic usage snapshots beginning at 100K and then every 25K.
Version 0.1.19 clarifies that thread policy overrides affect only rollover stages and are not
inherited by subagents or forked threads.
Version 0.1.20 adds `gpt-6-sol` to the strict group and `gpt-6-luna` to the Luna group.
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

### User-requested thread policy

Version 0.1.12 adds manual thread policies while retaining the existing v2 state database.

Version 0.1.13 enables `policy.allow_implicit_invocation: true` in `agents/openai.yaml`.
Invoke `$context-window-policy` or ask in natural language to inspect, configure, or reset the
current thread's reminder policy. A parent agent can also explicitly instruct a subagent to
load the skill and configure that subagent's own policy. The description limits selection to
these user or delegated requests;
high context usage or a hook reminder alone is not a reason to activate it. The skill requires
an explicit user or parent-agent request before `set` or `reset`, and inspection, explanation,
or ordinary work delegation does not authorize a write. The receiving subagent executes the
script with its own `CODEX_THREAD_ID`, asks its parent for missing parameters, and reports its
thread ID and thresholds back. The parent does not impersonate the subagent's identity.
Version 0.1.14 keeps model defaults and stage summaries in the skill entrypoint and moves exact
stage messages into its on-demand `references/reminder-text.md`. The skill shows all model groups
when the active model slug is unknown rather than guessing which default applies.
It offers a starting threshold and a stage interval, both positive whole K tokens (1K = 1,000 tokens).
Examples:

| Start | Interval | Stage thresholds |
| --- | --- | --- |
| 150K | 50K | 150K / 200K / 250K |
| 150K | 100K | 150K / 250K / 350K |

The skill asks for missing values and supports custom whole K values, inspecting the policy,
and restoring model defaults. Its companion script is `scripts/context_window_policy.py`:

```powershell
python "<plugin-root>/scripts/context_window_policy.py" show
python "<plugin-root>/scripts/context_window_policy.py" usage
python "<plugin-root>/scripts/context_window_policy.py" set --start-k 150 --interval-k 50
python "<plugin-root>/scripts/context_window_policy.py" reset
```

The script requires `CODEX_THREAD_ID` from the current Codex execution environment. Missing or
invalid identity fails explicitly; it does not infer identity from recent transcripts or use
`CODEX_SESSION_ID` as a fallback. The hook continues to obtain and validate thread identity from
its request and transcript. The script returns JSON with `thread_id`, `mode`, `start_k`,
`interval_k`, and `thresholds`. Custom `thresholds` are three token counts (not K values).
In `model_default` mode, the K fields are null and `thresholds` lists the `strict`, `luna`, and
`default` model thresholds; it does not infer the active model. The script accepts `--state-db`
for tests or explicitly managed installations.

The three custom thresholds are `start`, `start + interval`, and `start + 2 * interval`.
They override model-specific rollover defaults, including after model changes, but do not change
the fixed 100K/25K periodic usage schedule. Policies apply only to the selected thread, are not
inherited by subagents or forked threads, and persist across context rollover, compaction, and
process restarts until manually reset. Setting or resetting a policy does not clear the current
window's reported stages. The next hook invocation uses the new thresholds and emits only a stage
higher than the one already reported. Normal compaction still resets reminder history.

Policies live in a separate `thread_policies` table in the hook's existing SQLite database.
Creating this table does not alter existing `session_state` rows. Policy records are not removed
by reminder-history eviction; only an explicit reset removes the selected thread's override.
The CLI writes and the hook reads policies under SQLite transaction locking. Invalid stored
policies or table schemas fail with a state diagnostic rather than silently reverting to defaults.

### Context usage query

Version 0.1.15 adds the read-only `usage` command to the policy script. It returns JSON containing
`thread_id`, `used_tokens`, `model_context_window`, `effective_window_tokens`, `used_percent`, and
`display`. For example, 73,000 tokens used with an 800,000-token model window produces
`73K/680K (9% used)`.

Version 0.1.16 includes the finalized missing-capacity test fixtures; runtime behavior is unchanged.

The reminder denominator is `model_context_window * 17 // 20`, where the recorded
`model_context_window` is Codex's usable model window. For percentage calculations it follows the
CLI status formula against that reminder window: subtract a 12,000-token baseline from both the
window and usage, clamp adjusted usage and remaining values at zero, round remaining percentage to
the nearest integer with halves rounded up, then report `100 - remaining_percent` as used percentage.
A reminder window no larger than the baseline reports 100% used. Displayed K counts are rounded down,
and absolute remaining tokens are `max(reminder_window_tokens - used_tokens, 0)`. The hook reuses this
calculation for periodic usage reminders; it does not change the three rollover stage thresholds.

The command uses `CODEX_THREAD_ID` to read `threads.rollout_path` from
`%CODEX_HOME%/state_5.sqlite` (or `~/.codex/state_5.sqlite` when unset), opened read-only.
This is a Codex internal schema dependency; a missing database, incompatible schema, missing row,
or invalid path produces a diagnostic. The command does not search other databases or guess the
latest transcript. `usage --codex-state-db <path>` supports tests or explicitly managed
installations. The policy database option `--state-db` is not applicable to usage queries.

Both `CODEX_THREAD_ID` and `CODEX_SESSION_ID` are required to validate the located transcript.
The reported values come from its latest usage record and that record's corresponding turn
capacity, not a live count including the query itself. A compacted window with no fresh usage,
missing capacity, or mismatched identity fails explicitly. Querying usage does not create or
modify the plugin policy database or Codex index.

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

Version 0.1.21 adds the audit skill and CLI without changing hook or policy behavior.

The separate `context-window-rollover-audit` skill uses
`scripts/context_window_rollover_audit.py` for a read-only, retrospective check. It accepts an
explicit local thread ID (including a subagent ID) and can include its descendant subagents:

```powershell
python plugins/context-window-rollover-reminder/scripts/context_window_rollover_audit.py --thread-id <thread-id>
python plugins/context-window-rollover-reminder/scripts/context_window_rollover_audit.py --thread-id <thread-id> --include-subagents
```

The command locates transcripts and descendant edges through the Codex `state_5.sqlite` thread
index. It reads the first `session_meta` of each rollout to verify a subagent's direct parent;
inherited parent metadata later in a subagent rollout must not create extra parent-child edges. It counts a
`compacted` record with positive `window_number` and nonempty `previous_window_id` as a
confirmed rollover. A subagent's startup `compacted` with `window_number=0` records inherited context and is excluded from rollover
counts even when other records appear before it. Parent reminders inherited in a subagent's
startup history are not attributed to that subagent's own work. A `new_context` call without a
following confirmed marker remains an unconfirmed request.

The JSON report provides rollout timing, usage around each window boundary, delivered reminder
events (including reminders pending in an active window), notes read/write operations with paths,
and activity between reminder and rollover. `seconds_after_last_reminder` measures from the last
rollover reminder delivered in that window to the confirmed `compacted` marker; it is null when
there was no rollover reminder. Each rollover has `note_calls_before` and `note_calls_after` for
the adjacent windows. The script does not classify notes as checkpoints by filename or emit
message bodies, note contents, or tool arguments. Historical reminder events are taken
from the transcript; applying the currently installed threshold table to an older window can
misstate what the agent actually received after a plugin update. Transcript and index schemas
are Codex internals, so missing or incompatible data must be reported as a diagnostic rather
than interpreted as zero rollovers. `--codex-state-db` supports tests and explicitly managed
installations. This audit does not invoke the hook or change policy, state, or transcripts.

## Development and maintenance

Run the focused tests from the repository root:

```text
python -m unittest discover -s plugins/context-window-rollover-reminder/tests -p "test_*.py"
```

Validate both skills with the installed skill-creator validator:

```text
python <skill-creator>/scripts/quick_validate.py plugins/context-window-rollover-reminder/skills/context-window-policy
python <skill-creator>/scripts/quick_validate.py plugins/context-window-rollover-reminder/skills/context-window-rollover-audit
```

Validate the plugin manifest with the installed plugin-creator validator:

```text
python <plugin-creator>/scripts/validate_plugin.py plugins/context-window-rollover-reminder
```

When changing hook logic, keep the model-specific defaults, thread policy thresholds, stage selection, state schema, transcript
parsing rules, and exit-code contract aligned with the tests. Keep
`hooks/hooks.json` synchronous unless the hook's output and state semantics are redesigned
together. Do not add the separate context-usage probe or commit generated SQLite state to the
plugin.
