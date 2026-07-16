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

- Type: Skill plus Node.js npm CLI.
- Manifest: `plugins/task-memory/.codex-plugin/plugin.json`.
- Main source: `plugins/task-memory/skills/task-memory/SKILL.md`.
- Public commands: `plugins/task-memory/package.json`.
- Shared runtime: `plugins/task-memory/src/task-memory-cli.mjs`.
- Command entrypoints: `plugins/task-memory/scripts/commands/*.mjs`.
- UI metadata: `plugins/task-memory/skills/task-memory/agents/openai.yaml`.
- Runtime task data: `<workspace>/task-memory/<task-id>/` contains `task_state.md` and `artifacts/`; this is task output, not plugin source.
- Tests: `plugins/task-memory/tests/task-memory-cli.test.mjs` exercises CLI behavior in temporary workspaces and a packed plugin.

### `figma-workspace`

- Type: Skill, stateful Node CLI, OAuth bridge, private Node package, generated runtime, and tests.
- Manifest: `plugins/figma-workspace/.codex-plugin/plugin.json`.
- Skill router: `plugins/figma-workspace/skills/figma-workspace/SKILL.md`.
- Agent CLI source: `plugins/figma-workspace/mcp-server/src/cli/figma-workspace-cli.ts`.
- Agent invocation: use the canonical `npm --silent run figma -- <command>` CLI or the corresponding independent public `figma:<command>` npm executable. The contract has 18 direct commands, 8 JSON commands, and 21 raw transport commands available only through `figma:raw` and `figma:raw:help`. Public command help contains the complete input schema, and JSON commands accept `--input -` through both npm entrypoint forms. `figma:docs:list`, `figma:docs:catalog`, `figma:docs:read`, `figma:docs:search`, and `figma:api:search` are the documentation contract. `.figma.ts` and eval inject a frozen, non-callable `$` namespace with only `$.text` and `$.capture`; all other scripting uses native Figma Plugin API. Use `npm --silent` in every shell to preserve Restricted Markdown stdout after packaging. Put npm's `--` before arguments passed to an independent npm executable.
- Agent result surface: Restricted Markdown on stdout for typed results; usage and thrown failures use stderr.
- Project docs: `plugins/figma-workspace/skills/figma-workspace/references/*.md`; `docs:list` returns `project:` IDs, `docs:catalog` returns canonical records, and `docs:read` reads either namespace. `guidance` and `docs:search --scope auto` share English-only task routing with hard surface filters. The lightweight workflow references describe hard boundaries only; TypeScript and bundled Plugin API typings preflight scripts, while valid Plugin API operations are not subject to semantic AST policy.
- OAuth bridge: `plugins/figma-workspace/scripts/server.mjs`.
- Node runtime source: `plugins/figma-workspace/mcp-server/src/`; the directory name is legacy, not a local MCP registration.
- Generated package output: `plugins/figma-workspace/mcp-server/dist/`; keep it synchronized with source changes through the package build.
- Primary maintenance guide: [Figma Workspace AI Agent Development](figma-workspace-ai-agent-development.md).
- Cross-repository CLI guide: [Reusable npm CLI Implementation Guide](figma-workspace-reusable-npm-cli-implementation-guide.md).
- User-facing plugin guide: `plugins/figma-workspace/README.md`.
- Package guide: `plugins/figma-workspace/mcp-server/README.md`.

## Change Routing

| Change | Inspect first |
| --- | --- |
| Skill trigger or workflow | Plugin manifest, `SKILL.md`, and `agents/openai.yaml`. |
| Plugin identity or UI metadata | `.codex-plugin/plugin.json` and the marketplace entry. |
| Marketplace inventory | Plugin directories, manifests, marketplace JSON, and root README. |
| `task-memory` behavior | `SKILL.md`, plugin-root `package.json`, shared CLI runtime, and tests. |
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

From `plugins/task-memory`:

```text
npm test
npm pack --dry-run --json
```

The integration suite covers both independent npm entrypoints, `init`, `status`, help and output contracts, concurrent allocation, managed-path safety, malformed task structures, and packed-artifact execution.

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
- `plugins/figma-workspace/skills/figma-workspace/references/canonical-corpus/` is the only bundled workflow corpus read at runtime. It contains only the v2 manifest, shared English route catalog, and current content-addressed JSONL. The manifest validates 87 records: 46 `active`, 20 `conditional`, 12 `router`, and 9 `examples`. Each record publishes task family, surfaces, mapping profile, title, and summary. Examples are plugin-owned non-executable TypeScript-in-Markdown templates. Upstream source text is not packaged or read at runtime.
- `plugins/figma-workspace/dev/canonical-corpus-source/` owns the 87 adapted Markdown mirrors and 12 policy fragments used to build the runtime JSONL. Keeping these authoring inputs outside `skills/` prevents nested upstream `SKILL.md` mirrors from being discovered as plugin skills. `plugins/figma-workspace/dev/upstream-snapshot/` is the complete development source snapshot, and `plugins/figma-workspace/dev/upstream-changes/` is its drift report. All three directories are maintenance inputs outside the npm package and `mcp-server/dist/`. `npm run update:upstream-snapshot -- --ref <git-ref>` updates only the snapshot and drift report. `npm run build:canonical-corpus` reads the adapted mirrors and policy from the canonical source root and publishes only the self-contained runtime corpus; source-identical content may be reported for human review but is not a mechanical publication failure.
- `figma:api:search` reads a v2 plugin-owned symbol index generated during the package build from bundled `@figma/plugin-typings`; it supports bare, qualified, and call-shaped API queries and does not read the development snapshot. `figma:doctor` diagnoses the canonical corpus, generated API index, project docs, and TypeScript runtime assets. Upstream drift belongs to the maintenance updater, not `doctor`.
- Figma OAuth cache files live outside the repository and may contain secrets.
- Figma CLI state files are local runtime state and should not be committed by default. Every executing optimized command requires an explicit fully qualified absolute `--state-file`; its parent directory owns result sidecars. Prefer a Git-ignored project-local `.figma-workspace/`; otherwise use an explicitly selected Figma task-artifact directory. Do not reuse capability-specific output roots as generic task storage. The raw transport requires a fully qualified absolute `--session-file` or fully qualified absolute `FIGMA_WORKSPACE_SESSION_FILE` and has no current-directory default.
- Workspace `task-memory/` directories are runtime task state and should not be treated as repository documentation or plugin source.
