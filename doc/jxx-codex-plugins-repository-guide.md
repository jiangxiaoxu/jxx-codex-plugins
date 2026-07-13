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
- Tests: `plugins/task-memory/tests/test_task_memory.py` exercises helper behavior in temporary workspaces.

### `figma-workspace`

- Type: Skill, stateful Node CLI, OAuth bridge, private Node package, generated runtime, and tests.
- Manifest: `plugins/figma-workspace/.codex-plugin/plugin.json`.
- Skill router: `plugins/figma-workspace/skills/figma-workspace/SKILL.md`.
- Agent CLI source: `plugins/figma-workspace/mcp-server/src/cli/figma-workspace-cli.ts`.
- Agent invocation: use the canonical `npm --silent run figma -- <command>` CLI or the corresponding independent `figma:<command>` npm executable. Direct commands use task-shaped arguments; JSON commands use optimized input, state, and output options. All entrypoints share the typechecked command runtime. The 22 transport JSON commands and their complete schemas are available only through `figma:raw` and `figma:raw:help`. In Windows PowerShell use `npm.cmd --silent`; other shells use `npm --silent`; `--silent` preserves Restricted Markdown stdout after packaging. Put npm's `--` before arguments passed to an independent npm executable.
- Agent result surface: Restricted Markdown on stdout for typed results; usage and thrown failures use stderr.
- Project docs: `plugins/figma-workspace/skills/figma-workspace/references/*.md`; `docs` reads complete topics while `guidance` and `lookup` search them.
- OAuth bridge: `plugins/figma-workspace/scripts/server.mjs`.
- Node runtime source: `plugins/figma-workspace/mcp-server/src/`; the directory name is legacy, not a local MCP registration.
- Generated package output: `plugins/figma-workspace/mcp-server/dist/`; keep it synchronized with source changes through the package build.
- Primary maintenance guide: [Figma Workspace AI Agent Development](figma-workspace-ai-agent-development.md).
- Cross-repository CLI guide: [Reusable npm CLI Implementation Guide](figma-workspace-reusable-npm-cli-implementation-guide.md).
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
| Figma agent workflow | Figma maintenance guide, skill router, CLI command contract, and focused tests. |
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
python -m unittest plugins/task-memory/tests/test_task_memory.py
```

The integration suite covers `init`, `status`, `create-report`, `delete-report`, managed-path safety, and malformed task structures. The helper manages only its canonical report filenames.

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

The CLI package build regenerates `dist/`; review generated changes with the source diff.

## Generated And Local State

- `plugins/figma-workspace/mcp-server/dist/` is checked-in generated output.
- `plugins/figma-workspace/skills/figma-workspace/references/upstream-corpus/` is generated lookup data, not the primary agent documentation surface.
- Figma OAuth cache files live outside the repository and may contain secrets.
- Figma CLI state files are local runtime state and should not be committed by default. Their parent directory also owns result sidecars; stateless commands use the plugin-root default `.figma-workspace/results/` location.
- Workspace `task-memory/` directories are runtime task state and should not be treated as repository documentation or plugin source.
