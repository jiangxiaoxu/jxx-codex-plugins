# jxx-codex-plugins

Codex plugin marketplace repository. See [Repository Guide](doc/jxx-codex-plugins-repository-guide.md) for the source map, plugin-specific documentation, and validation entrypoints.

## Plugins

| Plugin | Purpose |
| --- | --- |
| `task-memory` | Manually invoked with `$task-memory` to maintain resumable task state and task-local artifacts through a plugin-root npm CLI. |
| `figma-workspace` | Provides a stateless fixed-leaf Node CLI for Figma work, CLI-readable project docs, Restricted Markdown results, and a transient OAuth login bridge. |
| `context-window-rollover-reminder` | Reports context usage starting at 200K and every 50K thereafter. Guides context rollover on Windows through PostToolUse reminders at 400K/500K/600K for model slugs starting with `gpt-6.1-` with an expanded context window of roughly 1M, and 300K/350K/400K for all other models. The audit skill reviews actual rollovers for a selected thread and its subagents. |

## Repository Layout

```text
.agents/plugins/marketplace.json  Marketplace inventory and ordering
plugins/                          Plugin source directories
doc/                              Repository and plugin maintenance documentation
AGENTS.md                         AI execution instructions
```

There is no repository-wide build or test runner. Use the validation commands documented for the plugin being changed.
