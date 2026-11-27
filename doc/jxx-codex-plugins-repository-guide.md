# JXX Codex Plugins Repository Guide

This repository is a local Codex plugin marketplace. It has no root-level package or test runner. Start from the owning plugin's source and validation entrypoints.

## Inventory

| Plugin | Primary source | Primary validation |
| --- | --- | --- |
| `task-memory` | `plugins/task-memory/skills/`, `src/`, and `scripts/commands/` | Run the plugin test suite and packed-artifact check. |
| `context-window-rollover-reminder` | `plugins/context-window-rollover-reminder/hooks/`, `skills/`, `scripts/`, and `tests/` | Run Python unittest discovery, the audit skill validator, and the plugin manifest validator. |
| `subagent-reasoning-cap` | `plugins/subagent-reasoning-cap/src/` and `hooks/` | Build the Windows x64 Native AOT executable, verify hook stdin/stdout, and validate the plugin manifest. |
| `thread-memory` | `plugins/thread-memory/src/`, `cli/`, `imaging/`, `panel/`, `hooks/`, and `skills/thread-memory/` | Package the Windows x64 Native AOT binaries, run the C# verification scripts, and validate the skill and plugin manifest. |

For every plugin, keep the plugin directory, `.codex-plugin/plugin.json`, marketplace entry, and root README inventory aligned when plugin identity, placement, or availability changes.

## Source And Change Routing

| Change | Inspect first |
| --- | --- |
| Skill trigger, routing, or agent UX | Plugin manifest, `SKILL.md`, `agents/openai.yaml`, and skill validator. |
| Plugin identity, metadata, or marketplace inventory | Plugin manifest, `.agents/plugins/marketplace.json`, root README, and repository inventory. |
| Codex Desktop MCP App views, entrypoints, or icons | [Codex MCP Apps](codex-mcp-apps.md) and the owning plugin's maintenance documentation. |
| `task-memory` behavior | Plugin package scripts, shared CLI source, command entrypoints, and tests. |
| Thread Memory hook lifecycle, reminder checks, and diagnostics | `plugins/thread-memory/src/` and `hooks/hooks.json`. |
| Thread note edits and fork copies | Native note commands in `plugins/thread-memory/cli/` use `src/ThreadMemory.cs`, shared with the hook. |
| Thread Memory panel and cleanup | `plugins/thread-memory/panel/`, the packaged panel HTML, and `mcp.json`. |
| Rollout inspection, search, recovery, and attachment export | `plugins/thread-memory/cli/`, the Thread Memory skill and references, and plugin tests. |
| Thread Memory thumbnail decoding and encoding | `plugins/thread-memory/imaging/`, the CLI's `ThumbnailNative.cs`, and `tests/verify-media.cs`. |

## Validation Routing

For context rollover hook behavior, configuration, and maintenance, see [Context Window Rollover Reminder](context-window-rollover-reminder.md).

For the reasoning cap hook, see [Subagent Reasoning Cap](subagent-reasoning-cap.md).

For thread notes and local rollout queries, see [Thread Memory](thread-memory.md).

Always run `git diff --check` and the checks owned by the changed plugin. Resolve the installed validator paths instead of hard-coding a user-specific location.

### Skills and manifests

```text
python <skill-creator>/scripts/quick_validate.py <plugin-skill-directory>
python <plugin-creator>/scripts/validate_plugin.py <plugin-directory>
```

### `context-window-rollover-reminder`

From the repository root on Windows:

```text
python -m unittest discover -s plugins/context-window-rollover-reminder/tests -p "test_*.py"
python <skill-creator>/scripts/quick_validate.py plugins/context-window-rollover-reminder/skills/context-window-rollover-audit
python <plugin-creator>/scripts/validate_plugin.py plugins/context-window-rollover-reminder
```

### `task-memory`

From `plugins/task-memory`:

```text
npm test
npm pack --dry-run --json
```

### `thread-memory`

From the repository root on Windows x64, first [build and bundle the native binaries](thread-memory.md#build-and-validate). The file-based .NET 10 checks exercise the packaged CLI, Imaging DLL, Hook, and MCP panel with isolated Codex homes.

```text
dotnet run --file plugins/thread-memory/tests/verify-rollout.cs
dotnet run --file plugins/thread-memory/tests/verify-media.cs
dotnet run --file plugins/thread-memory/tests/verify-memory.cs
dotnet run --file plugins/thread-memory/tests/verify-hook.cs
dotnet run --file plugins/thread-memory/tests/verify-panel.cs
dotnet run --file plugins/thread-memory/tests/verify-panel-ui.cs
python <skill-creator>/scripts/quick_validate.py plugins/thread-memory/skills/thread-memory
python <plugin-creator>/scripts/validate_plugin.py plugins/thread-memory
```
