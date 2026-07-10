# JXX Codex Plugins Repository Guide

## Purpose

This repository is a local Codex plugin marketplace. It contains three tracked plugins and no root-level package or test runner. Work from the plugin-specific source and validation entrypoints below.

## Source Map

| Path | Role |
| --- | --- |
| `.agents/plugins/marketplace.json` | Marketplace inventory, ordering, availability, authentication policy, and source paths. |
| `plugins/<plugin>/.codex-plugin/plugin.json` | Plugin identity, numeric version, capabilities, and UI metadata. |
| `plugins/<plugin>/skills/` | Skill routing and agent instructions shipped by a plugin. |
| `plugins/<plugin>/scripts/` | Plugin-owned runtime or maintenance helpers. |
| `doc/` | Repository and plugin maintenance documentation. |
| `README.md` | Short public plugin inventory and repository entrypoint. |

The plugin directory, manifest, and marketplace entry should describe the same installed unit. Check all three when inventory or packaging looks inconsistent.

## Plugin Inventory

### `chatgpt-research-prompt`

- Type: Skill-only productivity plugin.
- Manifest: `plugins/chatgpt-research-prompt/.codex-plugin/plugin.json`.
- Main source: `plugins/chatgpt-research-prompt/skills/chatgpt-research-prompt/SKILL.md`.
- UI metadata: `plugins/chatgpt-research-prompt/skills/chatgpt-research-prompt/agents/openai.yaml`.
- Tests: No plugin-owned automated test suite.

### `task-memory`

- Type: Skill plus Python helper.
- Manifest: `plugins/task-memory/.codex-plugin/plugin.json`.
- Main source: `plugins/task-memory/skills/task-memory/SKILL.md`.
- Helper: `plugins/task-memory/skills/task-memory/scripts/task_memory.py`.
- UI metadata: `plugins/task-memory/skills/task-memory/agents/openai.yaml`.
- Runtime task data: `<workspace>/task-memory/<task-id>/`; this is task output, not plugin source.
- Tests: No plugin-owned automated test suite; validate the skill and exercise helper commands in a temporary workspace.

### `figma-workspace`

- Type: Skill, MCP server, OAuth bridge, Node packages, generated runtime, and tests.
- Manifest: `plugins/figma-workspace/.codex-plugin/plugin.json`.
- MCP registration: `plugins/figma-workspace/.mcp.json`.
- Skill router: `plugins/figma-workspace/skills/figma-workspace/SKILL.md`.
- OAuth bridge: `plugins/figma-workspace/scripts/server.mjs`.
- MCP source: `plugins/figma-workspace/mcp-server/src/`.
- Generated package output: `plugins/figma-workspace/mcp-server/dist/`; keep it synchronized with source changes through the package build.
- Primary maintenance guide: [Figma Workspace AI Agent Development](figma-workspace-ai-agent-development.md).
- Output cleanup backlog: [Figma Workspace Output Simplification TODO](figma-workspace-output-simplification-todo.md).
- User-facing plugin guide: `plugins/figma-workspace/README.md`.
- Package guide: `plugins/figma-workspace/mcp-server/README.md`.

## Change Routing

| Change | Inspect first |
| --- | --- |
| Skill trigger or workflow | Plugin manifest, `SKILL.md`, and `agents/openai.yaml`. |
| Plugin identity or UI metadata | `.codex-plugin/plugin.json` and the marketplace entry. |
| Marketplace inventory | Plugin directories, manifests, marketplace JSON, and root README. |
| `task-memory` behavior | `SKILL.md` and `scripts/task_memory.py`. |
| Figma agent workflow | Figma maintenance guide, skill router, MCP resources/tools, and focused tests. |
| Figma runtime or public contract | `mcp-server/src/`, tests, package scripts, and generated `dist/`. |
| Figma OAuth/login | Plugin README, bridge scripts, auth source, and auth tests. |

## Validation Map

Always run `git diff --check` and the checks owned by the changed plugin. Use the installed `skill-creator` and `plugin-creator` validators through their actual skill locations rather than hard-coding a user-specific path.

### Skills and manifests

```text
python <skill-creator>/scripts/quick_validate.py <plugin-skill-directory>
python <plugin-creator>/scripts/validate_plugin.py <plugin-directory>
```

### `task-memory`

```text
python plugins/task-memory/skills/task-memory/scripts/task_memory.py --help
```

Use a temporary workspace for `init`, `status`, `create-report`, and `delete-report` integration checks. The helper manages only its canonical report filenames.

### `figma-workspace`

From `plugins/figma-workspace`:

```text
npm test
```

From `plugins/figma-workspace/mcp-server`:

```text
npm run typecheck
npm test
```

The MCP package build regenerates `dist/`; review generated changes with the source diff.

## Generated And Local State

- `plugins/figma-workspace/mcp-server/dist/` is checked-in generated output.
- `plugins/figma-workspace/skills/figma-workspace/references/upstream-corpus/` is generated lookup data, not the primary agent documentation surface.
- Figma OAuth cache files live outside the repository and may contain secrets.
- Workspace `task-memory/` directories are runtime task state and should not be treated as repository documentation or plugin source.
