---
name: figma-router
description: Unified routing entry for Figma MCP login, figma_repl_mcp file workflows, and compact Figma Plugin API lookup. Use for Figma design, FigJam, Slides, design systems, tokens, components, use_figma, figma_repl_run_script_file, Plugin API lookup, or Figma MCP auth repair. When selected, first expose deferred Figma tools with tool_search using a query that includes figma and figma_repl.
---

# Figma Router

Use this skill as the lightweight router for Figma MCP work. After OAuth registration, use `figma_repl_mcp` as the agent-facing entrypoint. Bundled reference files are internal lookup corpus; do not read or route agents to them directly.

## Default Route

1. If the user asks for login, auth setup, credential refresh, or auth repair, run the Figma MCP Login flow below.
2. Before any Figma MCP action, expose deferred Figma tools through `tool_search` with a query such as `figma_repl_mcp figma_repl figma`.
3. After Figma tools are available, read `figma-repl://capabilities`, then use the file workflow.
4. If direct `figma_repl_*` tools are not installed in the active Codex environment, use the package-local Node API `createFigmaReplClient` against the same OAuth cache.
5. For non-trivial canvas work, initialize a workspace once, create or edit a local `.figma.js` script, dry-run it, execute it, and write results to local files.
6. Use `figma_repl_guidance` and `figma_repl_lookup` for guidance. Treat lookup snippets as the exposed documentation surface.
7. Local `figma_repl_*` responses use a fixed structured shape; read large or raw upstream payloads from `outputFiles`, using `rawBytes` on file metadata to decide whether to inspect a result file.

## Lazy Tool Loading

Figma MCP tools may be deferred and unavailable until discovered. Do not assume `figma_repl_prepare_task`, `figma_repl_run_script_file`, or related tools are already visible. Before any Figma MCP action, call `tool_search` with a query containing `figma` and `figma_repl`; Figma tool names intentionally include `figma`, so this should expose the relevant tool family. Use a broader query such as `figma MCP use_figma get node selection` only if the first search does not expose the needed tools.

## Primary File Workflow

- Prepare a repairable workspace and intent file: `figma_repl_prepare_task({ cwd, fileUrl|fileKey, intent|title|goal })`.
- Edit the generated `<intent>.figma.js`; use native Figma Plugin API plus the injected `$` helpers.
- Dry-run: `figma_repl_run_script_file({ sessionId, inputFile, dryRun: true, strict: true, expectedSurface })`.
- Execute: `figma_repl_run_script_file({ sessionId, inputFile, outputFile })`.
- For generated image assets, create target rectangles in the script, then call `figma_repl_apply_asset_manifest`.
- For visual QA, call `figma_repl_capture_node` and inspect the local image/result files.
- For repeatable multi-step workflows, use `figma_repl_run_task_plan`.

Workspace files live under `<cwd>/figma-mcp/<fileKey-or-fileSlug>/`. Calls can use simple `inputFile` and `outputFile` names after workspace initialization. Absolute paths remain escape hatches.

## Script Contract

- Write ordinary async JavaScript in `.figma.js`: native Figma Plugin API for advanced work, injected `$` helpers for common agent tasks.
- Keep each transaction small and repairable. Use `dryRun: true`, then fix diagnostics by file line before executing.
- Return compact JSON with changed node ids, handles, and validation notes. Write large results to the paired `outputFile` instead of relying on inline MCP output.
- Read parsed upstream JSON from `result`; if upstream output is not JSON, read `text`. File pointers are reported in `outputFiles`.
- Common helpers: `$.find`, `$.findAll`, `$.create`, `$.text`, `$.layout`, `$.select`, `$.checkpoint`, `$.remember`, `$.forget`, `$.inspect`, `$.imageAsset`, `$.screenshot`, and `$.cloneNodeTree`.
- Prefer `$.select` over direct selection mutation. Use `figma_repl_inspect({ mode: "validate" })` before reusing old handles.
- For generated assets, use `$.imageAsset` only for small inline PNG/JPEG data; for larger local assets, create target rectangles and use `figma_repl_apply_asset_manifest`.
- Use `figma_repl_capture_node` for final visual QA and `figma_repl_run_task_plan` for repeatable script, asset, capture, and upstream-tool sequences.

## Lookup Order

- Use `figma-repl://capabilities` for aggregate self-explaining guidance, or narrower resources such as `figma-repl://guide`, `figma-repl://patterns`, `figma-repl://scripts`, `figma-repl://file-workflow`, `figma-repl://workflow-tools`, `figma-repl://api-cards`, `figma-repl://intents`, `figma-repl://safety`, `figma-repl://docs`, `figma-repl://api`, and `figma-repl://upstream-tools`.
- Use `figma_repl_guidance` for task-to-helper routing and curated short cards.
- Use `figma_repl_lookup({ kind: "docs" })` for BM25-ranked workflow snippets.
- Use `figma_repl_lookup({ kind: "api" })` for exact Plugin API symbols. It returns capped snippets and never returns a full declaration file.

Use `figma_repl_call_upstream_tool` only when a required official capability is explicitly not covered by the file workflow. Keep local REPL handles/session metadata for agent state; do not use PluginData for agent bookkeeping.

## Query Strategy

- For natural-language tasks, call `figma_repl_guidance` first and use its `recommendedCards`, `queryHints`, `apiSymbols`, `avoid`, and `referenceContext` fields before writing `.figma.js`.
- Use `figma_repl_guidance` for compact patterns, then use `apiSymbols` with `figma_repl_lookup({ kind: "api" })` only when exact Plugin API details are still missing.
- Treat `avoid` as task-specific guardrails, especially for font loading, variable binding, instance properties, image upload paths, FigJam, and Slides surface mismatches.
- Prefer these anchors when narrowing a query: text/font, auto layout, variables/tokens, styles, components/variants, instances/properties, images/fills, selection, capture/QA, FigJam/Slides.

## Figma MCP Login

Run the login helper from the plugin root, which is two directories above this `SKILL.md`:

```text
workdir: <plugin-root>
command: npm run login:figma-http
```

The helper starts the local HTTP bridge, temporarily logs in through `figma-http`, then removes that temporary MCP entry. After browser OAuth, use the resolver below when a script or programmatic client needs the shared cache path.

Do not add persistent `figma-http`; the plugin's persistent MCP server is `figma_repl_mcp`.

To resolve the shared OAuth cache path for scripts or programmatic clients, run this from the plugin root:

```text
workdir: <plugin-root>
command: npm run oauth-cache:path
```

## Bundled Servers

- `figma_repl_mcp`: primary agent-facing facade after OAuth registration. It runs local `.figma.js` files, writes local output files, exposes compact docs/API lookup, stores process-local handles, can capture screenshots, applies generated assets, and delegates uncovered official capabilities.
- `figma-stdio`: optional transparent bridge for upstream debugging and parity checks. It is not installed as a persistent plugin MCP server by default; use the package CLI or Node API `createRemoteMcpClient` when raw official MCP access is required.
