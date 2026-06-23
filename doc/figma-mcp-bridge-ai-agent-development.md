# AI Agent Development Guide

This document is for AI agents maintaining `figma-mcp-bridge`. It is not the user-facing Figma workflow. For user tasks, follow `skills/figma-router/SKILL.md` and the runtime MCP guidance first.

## Current Direction

- `figma_repl_mcp` is the primary agent-facing Figma workflow after OAuth.
- `figma-stdio` stays as a transparent upstream bridge for parity checks and raw official MCP debugging.
- Local `.figma.js` files, native Figma Plugin API, compact `$` helpers, workspace files, asset manifests, capture output, task plans, and compact docs/API lookup are the supported REPL path.
- DSL, `$.ops`, `figma_repl_apply_ops`, `compileFigmaReplOps`, `FigmaReplOp`, and `FigmaReplApplyOpsArguments` are not part of the public or runtime contract.
- Official files under `skills/figma-router/references/official-figma-skills/**` are internal corpus for lookup tools. Do not route agents to read them directly.

## Canonical Contracts

Runtime payloads are canonical for the agent-facing router contract:

- `figma-repl://capabilities`
- static resources under `figma-repl://*`
- tool metadata from `stdio-mcp/src/repl-tool-metadata.ts`
- task/API guidance from `stdio-mcp/src/repl-guidance-catalog.ts`
- docs/API snippets from `stdio-mcp/src/repl-doc-search.ts`

`SKILL.md`, `openai.yaml`, and README files are secondary summaries. Keep them short and aligned with the runtime-owned contract. Prefer narrow parity tests over generated markdown or large copied prose.

Pin these facts when changing the router surface:

- agents start by reading `figma-repl://capabilities`;
- `figma_repl_mcp` is the primary agent-facing entrypoint;
- exposed resources include the `figma-repl://capabilities`, `guide`, `file-workflow`, `workflow-tools`, `scripts`, `patterns`, `api-cards`, `intents`, `docs`, `api`, `safety`, `upstream-tools`, and `sessions` family;
- `figma_repl_guidance` returns business guidance fields such as `workflow`, `steps`, `recommendedTools`, `suggestedCards`, `cards`, `catalogSize`, `guidance`, `recommendedCards`, `queryHints`, `apiSymbols`, `avoid`, and `suggestions`; it does not return a duplicate output `mode`;
- `figma_repl_lookup` returns only `ok`, `results`, and `guidance` in structured output; request selectors and cap fields such as `kind`, `query`, `symbol`, `maxResults`, and `maxSnippetLines` stay input-only;
- public `figma_repl_*` tools are exactly `figma_repl_open`, `figma_repl_eval`, `figma_repl_run_script_file`, `figma_repl_apply_asset_manifest`, `figma_repl_capture_node`, `figma_repl_run_task_plan`, `figma_repl_prepare_task`, `figma_repl_guidance`, `figma_repl_inspect`, `figma_repl_call_upstream_tool`, and `figma_repl_lookup`;
- every public `figma_repl_*` tool uses a fixed structured response shape: public session without `history`, diagnostics arrays present, JSON debug/result file pointers under `outputFiles.debugFile` as `{ path, bytes, lineCount }` only when a tool writes on-demand debug files, upstream-backed single-call tools expose parsed JSON in `upstream.payload` or non-JSON output in `upstream.text`, paired `outputFiles.upstreamFile` sidecars hold full upstream for eval/script/upstream-tool debug outputs, `figma_repl_run_script_file` output files are limited to `debugFile`, `upstreamFile`, and failure-only `compiledScriptFile`, `figma_repl_capture_node` uses `imageFile` for PNG paths, and fixed official wrappers keep inline results business-focused with failures in `upstreamError`;
- Codex cannot visually read MCP image `content` items when a tool result also uses `structuredContent`. Visual QA and capture flows should return local file paths in `structuredContent`; agents should inspect those files with local image-reading tools instead of expecting inline MCP media rendering.
- public tool schemas and docs expose the fixed response shape only. Public JSON result `outputFile` inputs are removed; legacy JSON result `outputFile`/`resultFile` inputs hard-reject because debug files are generated on demand. Legacy `figma_repl_run_script_file` `outputDir`/`diagnosticsFile`/`summaryFile` inputs also hard-reject because debug files are generated on demand and diagnostics are included in `outputFiles.debugFile`; do not remove `figma_repl_download_assets.outputDir`. Upstream-backed execution/debug tools may expose compact upstream envelopes inline, fixed official wrappers keep generic upstream details out of normal inline results, eval/script/upstream-tool/asset/download clean success does not write JSON result files, `figma_repl_prepare_task` does not create or return pending result stubs, result JSON files are minimal debug/audit envelopes without full `session`, `outputFiles`, paired sidecar paths, or copied success business arrays, public result pointers use `outputFiles.debugFile`, eval/script/upstream-tool result files never contain `upstream`, and `figma_repl_run_task_plan` is the only normal-path tool that still automatically writes a plan-level result/debug file while omitting the input-only `stopOnFailure` from inline/result-file output;
- `figma-repl://capabilities.toolArgumentGuidance` is the canonical normal-path vs alias/advanced/debug argument guide for public `figma_repl_*` tools;
- bundled corpus files are internal lookup data, not agent-facing docs;
- `figma_repl_call_upstream_tool` is only for explicit uncovered upstream capabilities.

## Source Ownership Map

- `stdio-mcp/src/repl-server.ts`: MCP server composition, handler wiring, sessions, capability/resource payload assembly, and typed client surface.
- `stdio-mcp/src/repl-script-runner.ts`: `.figma.js` compilation, helper bootstrap, helper profiles, preflight diagnostics, context diagnostics, and payload-size diagnostics.
- `stdio-mcp/src/repl-workspace-files.ts`: workspace/path/script-output/capture-output/task-plan file helpers and `FigmaReplSessionWorkspace`.
- `stdio-mcp/src/repl-tool-args.ts`: tool argument interfaces, default title helper, and explicit low-risk runtime parsers.
- `stdio-mcp/src/repl-tool-metadata.ts`: canonical local tool descriptions and input schemas.
- `stdio-mcp/src/repl-tool-registry.ts`: local tool names and task-plan step aliases.
- `stdio-mcp/src/repl-guidance-catalog.ts`: API cards, task buckets, query anchors, and pure guidance helpers.
- `stdio-mcp/src/repl-doc-search.ts`: corpus allowlists, reference-root resolution, chunking, ranking, opaque `sourceId`, and lookup shaping.
- `skills/figma-router/SKILL.md`: lightweight user-task router, not the canonical schema source.
- `skills/figma-router/agents/openai.yaml`: thin metadata that points agents at `$figma-router`; do not expand it into a second contract.

## Change Rules

- Breaking changes to public tool names, resource URIs, result shapes, session semantics, and typed client signatures are allowed by default when they simplify the active contract; update runtime schemas, capabilities, docs, tests, and generated output in the same change.
- Runtime parsers may reject removed or ambiguous public arguments. Keep parser behavior explicit, and do not duplicate path/workspace validation outside `repl-workspace-files.ts`.
- Keep generated `dist` outputs in sync when `npm run build` changes them.
- Do not reintroduce wrapper reference docs under `skills/figma-router/references/`; keep only `official-figma-skills/**` there.
- Do not make docs canonical by copying large runtime payloads into markdown. Add or adjust narrow tests instead.
- When changing plugin version numbers, update `plugins/figma-mcp-bridge/.codex-plugin/plugin.json` as part of the same release change.
- When adding, renaming, or removing plugins under `plugins/*`, update `.agents/plugins/marketplace.json` and the root plugin list in `README.md`.

## Development Workflow

1. Inspect current git status before changing files. This repo often has staged and unstaged work in the same plugin.
2. For runtime behavior, update source first, then tests, then generated `dist`.
3. For router wording, update runtime payload/tests first. Touch `SKILL.md` or README only for concise summary alignment.
4. Keep changes reviewable. Separate broad guidance/runtime refactors from validation hardening and docs parity work when possible.
5. Do not stage or commit `task-memory/` unless the user explicitly asks.
6. Do not try to update or reinstall the locally installed Codex plugin cache from an agent session. In particular, do not run `codex plugin add` for `figma-mcp-bridge` as part of normal development or validation. Existing MCP server processes can hold cache files open; leave installed-cache refresh/reload to the user or a fresh Codex app session.

## Validation

From `plugins/figma-mcp-bridge/stdio-mcp`:

```bash
npm run typecheck
npm test
```

`npm test` runs the build and the Node test suite. Use it before committing runtime, parser, generated output, or docs parity changes. The test suite must include a real SDK stdio startup probe for `dist/repl-stdio-cli.js`: start the CLI with `StdioClientTransport`, complete MCP `initialize`, and call `listTools`. This guards against startup-only failures such as top-level native dependency imports that close the connection before the initialize response.

Useful test areas:

- `tests/build-output.test.mjs`: package export and generated output contract.
- `tests/repl-server.test.mjs`: MCP tools, typed client, resource payloads, parser validation, workspace flow, docs/API lookup, task plans, stdio initialize/listTools startup probe, and parity smoke checks.

## Release Checklist

- Review staged vs unstaged files and keep the release unit coherent.
- Confirm `task-memory/` is not staged unless explicitly requested.
- Run `npm test` in `stdio-mcp`.
- Check whether plugin version metadata needs a bump.
- Check marketplace/root README updates only when plugin entries are added, renamed, or removed.
