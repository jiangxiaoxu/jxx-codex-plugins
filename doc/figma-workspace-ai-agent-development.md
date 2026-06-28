# AI Agent Development Guide

This document is for AI agents maintaining `figma-workspace`. It is not the user-facing Figma workflow. For user tasks, follow `skills/figma-workspace/SKILL.md` and the runtime MCP guidance first.

## Current Direction

- `figma_workspace_mcp` is the primary agent-facing Figma workflow after OAuth.
- `figma_workspace_upstream_stdio` is the transparent upstream bridge CLI/server name for parity checks and raw official MCP debugging.
- Codex `node_repl` is not the normal live-Figma route. For Node-level live verification, inject a custom upstream client, preferably a child stdio MCP client launched from `mcp-server/dist/mcp/workspace-mcp-stdio-bin.js`; keep the `./node-upstream-client` no-client `createFigmaWorkspaceClient()` path local-only.
- Local `.figma.js` files, native Figma Plugin API, compact `$` helpers, workspace files, asset manifests, capture output, task plans, and compact docs/API lookup are the supported workspace path.
- DSL, `$.ops`, `figma_workspace_apply_ops`, `compileFigmaWorkspaceOps`, `FigmaWorkspaceOp`, and `FigmaWorkspaceApplyOpsArguments` are not part of the public or runtime contract.
- Official upstream skill content is stored as internal JSONL corpus under `skills/figma-workspace/references/upstream-corpus/`. Do not route agents to read it directly.

## Canonical Contracts

Runtime payloads are canonical for the agent-facing router contract:

- `figma-workspace://capabilities`
- static resources under `figma-workspace://*`
- tool metadata from `mcp-server/src/contract/tool-metadata.ts`
- task/API guidance from `mcp-server/src/runtime/guidance-catalog.ts`
- docs/API snippets from `mcp-server/src/runtime/doc-search.ts`

`SKILL.md`, `openai.yaml`, and README files are secondary summaries. Keep them short and aligned with the runtime-owned contract. Prefer narrow parity tests over generated markdown or large copied prose.

Pin these facts when changing the router surface:

- agents start by reading `figma-workspace://capabilities`, then `figma-workspace://guide` only when workflow sequencing is needed;
- `figma_workspace_mcp` is the primary agent-facing entrypoint;
- `node_repl` investigations must not use the embedded no-client SDK remote path for live Figma work; use hosted `figma_workspace_mcp`, or an explicit custom client such as a child `dist/mcp/workspace-mcp-stdio-bin.js` stdio MCP process;
- exposed resources include only `figma-workspace://capabilities`, `figma-workspace://guide`, `figma-workspace://lookup-index`, `figma-workspace://upstream-tools`, `figma-workspace://upstream-tools/{name}`, `figma-workspace://sessions`, `figma-workspace://sessions/{id}`, and `figma-workspace://sessions/{id}/handles`;
- `figma-workspace://sessions` is a compact list with `id`, `fileKey`, `surface`, and optional `sessionDir`; `figma-workspace://sessions/{id}` is compact detail with `handles`, optional page state, and optional inline workspace `{ sessionDir }`; `figma-workspace://sessions/{id}/handles` is the narrow handle-only resource;
- `figma_workspace_guidance` returns business guidance fields such as `workflow`, `steps`, `recommendedTools`, `suggestedCards`, `cards`, `catalogSize`, `guidance`, `recommendedCards`, `queryHints`, `apiSymbols`, `guardrails`, and `suggestions`; it does not return a duplicate output `mode`;
- `figma_workspace_lookup` returns only `ok`, `results`, and `guidance` in structured output; request selectors and cap fields such as `kind`, `query`, `symbol`, `maxResults`, and `maxSnippetLines` stay input-only;
- public `figma_workspace_*` tools are exactly `figma_workspace_open`, `figma_workspace_eval`, `figma_workspace_run_script_file`, `figma_workspace_apply_asset_manifest`, `figma_workspace_download_assets`, `figma_workspace_capture_node`, `figma_workspace_run_task_plan`, `figma_workspace_prepare_task`, `figma_workspace_guidance`, `figma_workspace_inspect`, `figma_workspace_get_metadata`, `figma_workspace_get_design_context`, `figma_workspace_get_motion_context`, `figma_workspace_export_video`, `figma_workspace_search_design_system`, `figma_workspace_get_libraries`, `figma_workspace_get_variable_defs`, `figma_workspace_call_upstream_tool`, and `figma_workspace_lookup`;
- every public `figma_workspace_*` tool uses a fixed structured response shape: ordinary tool `session` summaries contain only `id`, `fileKey`, `surface`, `handleChanges`, and `workspace.workspaceRef`, diagnostics arrays are present, JSON debug/result file pointers under `outputFiles.debugFile` are `{ path, bytes, lineCount }` only when a tool writes on-demand debug files, upstream-backed single-call tools expose parsed JSON in `upstream.result` or non-JSON output in `upstream.text`, paired `outputFiles.upstreamFile` sidecars hold full upstream for eval/script/upstream-tool debug outputs, `figma_workspace_run_script_file` output files are limited to `debugFile`, `upstreamFile`, and failure-only `compiledScriptFile`, `figma_workspace_capture_node` uses `imageFile` for PNG paths, `figma_workspace_get_metadata` inlines small converted JSON trees and writes only oversized converted trees to `outputFiles.metadataFile`, and fixed official wrappers keep inline results business-focused with failures in `upstreamError`;
- Codex cannot visually read MCP image `content` items when a tool result also uses `structuredContent`. Visual QA and capture flows should return local file paths in `structuredContent`; agents should inspect those files with local image-reading tools instead of expecting inline MCP media rendering.
- public tool schemas and docs expose the fixed response shape only. Public JSON result `outputFile` inputs are removed; legacy JSON result `outputFile`/`resultFile` inputs hard-reject because debug files are generated on demand. Legacy `figma_workspace_run_script_file` `outputDir`/`diagnosticsFile`/`summaryFile` inputs also hard-reject because debug files are generated on demand and diagnostics are included in `outputFiles.debugFile`; do not remove `figma_workspace_download_assets.outputDir`. Upstream-backed execution/debug tools may expose compact upstream envelopes inline, fixed official wrappers keep generic upstream details out of normal inline results, eval/script/upstream-tool/asset/download clean success does not write JSON result files, `figma_workspace_prepare_task` does not create or return pending result stubs, result JSON files are minimal debug/audit envelopes without full `session`, `outputFiles`, paired sidecar paths, or copied success business arrays, public result pointers use `outputFiles.debugFile`, eval/script/upstream-tool result files never contain `upstream`, and `figma_workspace_run_task_plan` is the only normal-path tool that still automatically writes a plan-level result/debug file while omitting the input-only `stopOnFailure` from inline/result-file output;
- `figma-workspace://capabilities` is a short routing manifest, `figma-workspace://guide` is the workflow guide, `figma-workspace://lookup-index` is the search/index entrypoint, and public tool schemas carry argument details;
- bundled JSONL corpus files are internal lookup data, not agent-facing docs;
- `figma_workspace_call_upstream_tool` is only for explicit uncovered upstream capabilities, including official shader effect/fill reads; prefer first-class wrappers for metadata, screenshot/asset/download workflows, design context, motion context, video export, and design-system reads.

## Source Ownership Map

- `mcp-server/src/mcp/workspace-mcp-server.ts`: MCP server composition, handler wiring, sessions, capability/resource payload assembly, and typed client surface.
- `mcp-server/src/mcp/workspace-mcp-stdio-bin.ts`: primary `figma_workspace_mcp` stdio entrypoint.
- `mcp-server/src/upstream/upstream-stdio-server.ts`: optional transparent upstream bridge server for raw official MCP debugging.
- `mcp-server/src/upstream/upstream-stdio-bin.ts`: optional `figma_workspace_upstream_stdio` stdio entrypoint.
- `mcp-server/src/upstream/remote-mcp-client.ts`: remote official Figma MCP client.
- `mcp-server/src/upstream/node-upstream-client.ts`: Node smoke/debug entrypoint with Web Streams guards.
- `mcp-server/src/auth/*.ts`: browser, config, OAuth callback/provider/state, and auth constants.
- `mcp-server/src/runtime/script-runner.ts`: `.figma.js` compilation, helper bootstrap, helper profiles, preflight diagnostics, context diagnostics, and payload-size diagnostics.
- `mcp-server/src/runtime/workspace-files.ts`: workspace/path/script-output/capture-output/task-plan file helpers and `FigmaWorkspaceSessionWorkspace`.
- `mcp-server/src/runtime/guidance-catalog.ts`: API cards, task buckets, query anchors, and pure guidance helpers.
- `mcp-server/src/runtime/doc-search.ts`: corpus allowlists, reference-root resolution, chunking, ranking, opaque `sourceId`, and lookup shaping.
- `mcp-server/src/contract/tool-args.ts`: tool argument interfaces, optional display-only title validation, and explicit low-risk runtime parsers.
- `mcp-server/src/contract/tool-metadata.ts`: canonical local tool descriptions and input schemas.
- `mcp-server/src/contract/tool-registry.ts`: local tool names and task-plan step aliases.
- `skills/figma-workspace/SKILL.md`: lightweight user-task router, not the canonical schema source.
- `skills/figma-workspace/agents/openai.yaml`: thin metadata that points agents at `$figma-workspace`; do not expand it into a second contract.

## Change Rules

- Breaking changes to public tool names, resource URIs, result shapes, session semantics, and typed client signatures are allowed by default when they simplify the active contract; update runtime schemas, capabilities, docs, tests, and generated output in the same change.
- Runtime parsers may reject removed or ambiguous public arguments. Keep parser behavior explicit, and do not duplicate path/workspace validation outside `workspace-files.ts`.
- Keep generated `dist` outputs in sync when `npm run build` changes them.
- Lightweight router references under `skills/figma-workspace/references/` are allowed for static workflow, lookup, and safety notes. Do not copy large runtime payloads there, and do not make those references a second canonical contract. Keep official upstream content in `upstream-corpus/manifest.json` and `upstream-corpus/corpus.jsonl`.
- Do not make docs canonical by copying large runtime payloads into markdown. Add or adjust narrow tests instead.
- When changing plugin version numbers, update `plugins/figma-workspace/.codex-plugin/plugin.json` as part of the same release change.
- When adding, renaming, or removing plugins under `plugins/*`, update `.agents/plugins/marketplace.json` and the root plugin list in `README.md`.

## Development Workflow

1. Inspect current git status before changing files. This repo often has staged and unstaged work in the same plugin.
2. For runtime behavior, update source first, then tests, then generated `dist`.
3. For router wording, update runtime payload/tests first. Touch `SKILL.md` or README only for concise summary alignment.
4. Keep changes reviewable. Separate broad guidance/runtime refactors from validation hardening and docs parity work when possible.
5. Do not stage or commit `task-memory/` unless the user explicitly asks.
6. Do not try to update or reinstall the locally installed Codex plugin cache from an agent session. In particular, do not run `codex plugin add` for `figma-workspace` as part of normal development or validation. Existing MCP server processes can hold cache files open; leave installed-cache refresh/reload to the user or a fresh Codex app session.

## Validation

From `plugins/figma-workspace/mcp-server`:

```bash
npm run typecheck
npm test
```

`npm test` runs the build and the Node test suite. Use it before committing runtime, parser, generated output, or docs parity changes. The test suite must include a real SDK stdio startup probe for `dist/mcp/workspace-mcp-stdio-bin.js`: start the CLI with `StdioClientTransport`, complete MCP `initialize`, and call `listTools`. This guards against startup-only failures such as top-level native dependency imports that close the connection before the initialize response.

Useful test areas:

- `tests/build-output.test.mjs`: package export and generated output contract.
- `tests/workspace-mcp-server.test.mjs`: MCP tools, typed client, resource payloads, parser validation, workspace flow, docs/API lookup, task plans, stdio initialize/listTools startup probe, and parity smoke checks.

## Release Checklist

- Review staged vs unstaged files and keep the release unit coherent.
- Confirm `task-memory/` is not staged unless explicitly requested.
- Run `npm test` in `mcp-server`.
- Check whether plugin version metadata needs a bump.
- Check marketplace/root README updates only when plugin entries are added, renamed, or removed.
