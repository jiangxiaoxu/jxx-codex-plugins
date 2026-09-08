# Context Window Usage Reminder

`context-window-usage-reminder` installs a synchronous `PostToolUse` command hook. It reads the
Codex rollout transcript supplied on standard input and emits one `additionalContext` message when
the current context usage crosses a new boundary.

The hook has three reminder thresholds per context window: 250,000, 350,000, and 450,000 tokens.
Each message reports actual usage in whole thousands and includes the applicable rollover action:

| Usage | Action |
| --- | --- |
| 250K to below 350K | Find a suitable work boundary, prepare a checkpoint, and roll over. |
| 350K to below 450K | Wind down current work and roll over as soon as the checkpoint is ready. |
| 450K and above | Stop starting new work, finish only necessary cleanup, save the checkpoint, and roll over immediately. |

The message starts with:

```text
[Context window rollover reminder] Context Window Usage: 250K tokens.
```

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
            "command": "python \"$env:PLUGIN_ROOT/scripts/context_window_usage_hook.py\"",
            "timeout": 10,
            "statusMessage": "Context-window-usage-reminder plugin"
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

The script preserves the original hook's state location and deduplication keys. By default it
stores state in `%CODEX_HOME%\state\context-usage-hook.sqlite3`; when `%CODEX_HOME%` is unset,
the script falls back to `%USERPROFILE%\.codex\state\context-usage-hook.sqlite3`. `--state-db` can
override that path for tests or an explicitly managed installation. The database is created on first
use and is runtime state, not a plugin artifact.

State is keyed by the transcript thread ID. A compacted transcript resets the highest reported
threshold, so a fresh context window can report the same threshold again once fresh usage is available.
Concurrent invocations use SQLite transaction locking so one threshold crossing produces only one message. Old thread entries are
evicted after the existing 10,000-entry limit.

The hook writes a compact JSON hook result to standard output only when a new threshold is reached.
If usage skips thresholds, it emits only the highest applicable stage, without replaying earlier
stages. Once the 450K stage has been reported, no further reminders are emitted in that window.
`PostToolUse` samples usage after tool calls, so delivery may occur above a threshold.

On upgrade, the state migration replaces the legacy `highest_bucket` column with
`highest_threshold` and resets its values to zero, preserving thread identities, compaction markers,
and eviction timestamps. The next invocation emits the current applicable stage once, even if the
old plugin already reported usage in that window. Migration and reminder deduplication occur in the
same SQLite transaction.

Malformed requests, transcripts, identity mismatches, and state failures produce categorized
diagnostics on standard error and retain the existing exit codes.

## Development and maintenance

Run the focused tests from the repository root:

```text
python -m unittest discover -s plugins/context-window-usage-reminder/tests -p "test_*.py"
```

Validate the plugin manifest with the installed plugin-creator validator:

```text
python <plugin-creator>/scripts/validate_plugin.py plugins/context-window-usage-reminder
```

When changing hook logic, keep the fixed thresholds, stage selection, state migration, transcript
parsing rules, and exit-code contract aligned with the tests. Keep
`hooks/hooks.json` synchronous unless the hook's output and state semantics are redesigned
together. Do not add the separate context-usage probe or commit generated SQLite state to the
plugin.
