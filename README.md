# jxx-codex-plugins

Codex plugin marketplace repository. See [Repository Guide](doc/jxx-codex-plugins-repository-guide.md) for the source map, plugin-specific documentation, and validation entrypoints.

## Plugins

| Plugin | Purpose |
| --- | --- |
| `chatgpt-research-prompt` | Generates copy-ready research prompts for ChatGPT web research. |
| `task-memory` | Maintains durable task state and compact handoff reports for long-running Codex work. |
| `figma-workspace` | Provides the `figma_workspace_mcp` frontend, local OAuth bridge, and Figma workspace tooling. |

## Repository Layout

```text
.agents/plugins/marketplace.json  Marketplace inventory and ordering
plugins/                          Plugin source directories
doc/                              Repository and plugin maintenance documentation
AGENTS.md                         AI execution instructions
```

There is no repository-wide build or test runner. Use the validation commands documented for the plugin being changed.
