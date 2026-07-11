# jxx-codex-plugins

Codex plugin marketplace repository. See [Repository Guide](doc/jxx-codex-plugins-repository-guide.md) for the source map, plugin-specific documentation, and validation entrypoints.

## Plugins

| Plugin | Purpose |
| --- | --- |
| `chatgpt-research-prompt` | Generates copy-ready research prompts for ChatGPT web research. |
| `task-memory` | Maintains durable task state and compact handoff reports for long-running Codex work. |
| `figma-workspace` | Provides a stateful Node CLI with CLI-readable project docs, Restricted Markdown results, a transient OAuth login bridge, and file-based Figma workspace tooling. |

## Repository Layout

```text
.agents/plugins/marketplace.json  Marketplace inventory and ordering
plugins/                          Plugin source directories
doc/                              Repository and plugin maintenance documentation
AGENTS.md                         AI execution instructions
```

There is no repository-wide build or test runner. Use the validation commands documented for the plugin being changed.
