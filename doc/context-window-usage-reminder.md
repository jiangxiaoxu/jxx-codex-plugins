# Context Window Usage Reminder

`context-window-usage-reminder` installs a synchronous `PostToolUse` command hook. It reads the
Codex rollout transcript supplied on standard input and emits one `additionalContext` message when
the current context usage crosses a new boundary.

The hook starts at 210,000 tokens and then reports every additional 50,000 tokens. The message uses
whole thousands and has this form:

```text
[Context window usage reminder] Current context window usage is 210 K tokens.
```

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
independently of the 210K reminder threshold.

## Runtime state and behavior

The script preserves the original hook's state location and deduplication keys. By default it
stores state in `%CODEX_HOME%\state\context-usage-hook.sqlite3`; when `%CODEX_HOME%` is unset,
the script falls back to `%USERPROFILE%\.codex\state\context-usage-hook.sqlite3`. `--state-db` can
override that path for tests or an explicitly managed installation. The database is created on first
use and is runtime state, not a plugin artifact.

State is keyed by the transcript thread ID. A compacted transcript resets the bucket counter, so a
fresh context window can report the same threshold again. Concurrent invocations use SQLite
transaction locking so one threshold crossing produces only one message. Old thread entries are
evicted after the existing 10,000-entry limit.

The hook writes a compact JSON hook result to standard output only when a new boundary is crossed.
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

When changing hook logic, keep the threshold constants, output text, state path, persisted bucket
numbering, transcript parsing rules, and exit-code contract aligned with the tests. Keep
`hooks/hooks.json` synchronous unless the hook's output and state semantics are redesigned
together. Do not add the separate context-usage probe or commit generated SQLite state to the
plugin.
