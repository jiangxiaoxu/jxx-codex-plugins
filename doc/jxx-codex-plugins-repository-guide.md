# JXX Codex Plugins Repository Guide

This repository is a local Codex plugin marketplace. It has no root-level package or test runner. Start from the owning plugin's source and validation entrypoints.

## Inventory

| Plugin | Primary source | Primary validation |
| --- | --- | --- |
| `task-memory` | `plugins/task-memory/skills/`, `src/`, and `scripts/commands/` | Run the plugin test suite and packed-artifact check. |
| `figma-workspace` | `plugins/figma-workspace/skills/`, `cli-runtime/src/`, `scripts/`, and focused tests | Run plugin-root and CLI-package validation. |

For every plugin, keep the plugin directory, `.codex-plugin/plugin.json`, marketplace entry, and root README inventory aligned when plugin identity, placement, or availability changes.

## Source And Change Routing

| Change | Inspect first |
| --- | --- |
| Skill trigger, routing, or agent UX | Plugin manifest, `SKILL.md`, `agents/openai.yaml`, and skill validator. |
| Plugin identity, metadata, or marketplace inventory | Plugin manifest, `.agents/plugins/marketplace.json`, root README, and repository inventory. |
| `task-memory` behavior | Plugin package scripts, shared CLI source, command entrypoints, and tests. |
| Figma agent workflow or documentation | [Figma Workspace AI Agent Development](figma-workspace-ai-agent-development.md), the fixed leaf-command help, and focused tests. |
| Figma CLI/runtime, OAuth, bridge, or packaging | `plugins/figma-workspace/cli-runtime/src/`, owning tests, package scripts, and generated `dist/`. |
| Figma upstream MCP contract drift | Capture an ignored candidate with the CLI-runtime maintenance commands, use its semantic report to adapt wrappers and tests, then explicitly promote the reviewed candidate. Do not edit the accepted fixture directly. |

### Figma corpus ownership

`figma-workspace` keeps upstream material and runtime guidance deliberately separate:

```text
dev/upstream-snapshot + dev/upstream-changes
    archive and drift evidence only
        -> dev/canonical-corpus-source
           reviewed manual authoring and policy
               -> skills/.../canonical-corpus
                  packaged runtime corpus
                      -> cli-runtime/dist
                         generated package mirror
```

The snapshot updater writes only the archive and drift report. It never overwrites manual authoring, policy, runtime corpus, or `dist`. Pending or retired drift is a non-blocking review warning; malformed archive/report data and inconsistent policy/adaptation data remain validation failures. See the Figma maintenance guide for the detailed workflow.

## Validation Routing

Always run `git diff --check` and the checks owned by the changed plugin. Resolve the installed validator paths instead of hard-coding a user-specific location.

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

### `figma-workspace`

From `plugins/figma-workspace`:

```text
npm test
npm run build:canonical-corpus
```

From `plugins/figma-workspace/cli-runtime`:

```text
npm run typecheck
npm test
npm run check:dist
```

Use `check:dist` in a clean checkout or CI. Run the separate `npm run test:live` only when the user has intentionally supplied the ignored local Design configuration and OAuth cache; it is not part of ordinary tests.
