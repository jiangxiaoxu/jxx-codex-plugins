---
name: figma-router
description: Route Figma work through the exact MCP server figma_repl_mcp and its figma_repl_ tool family. Use for Figma design, FigJam, Slides, design systems, tokens, components, use_figma, Plugin API lookup, or Figma MCP auth repair. When selected, first expose deferred tools with tool_search query "figma_repl_mcp figma_repl_ figma".
---

# Figma Router

Use this skill as the lightweight router for Figma MCP work. After OAuth registration, use `figma_repl_mcp` as the agent-facing entrypoint. Bundled JSONL upstream corpus files are internal lookup data; do not read or route agents to them directly.

## Default Route

1. If the user asks for login, auth setup, credential refresh, or auth repair, run the Figma MCP Login flow below.
2. Before any Figma MCP action, expose deferred Figma tools through `tool_search` with a query such as `figma_repl_mcp figma_repl_ figma`.
3. After Figma tools are available, read `figma-repl://capabilities`, then `figma-repl://guide` when workflow sequencing is needed.
4. If direct `figma_repl_*` tools are not installed in the active Codex environment, do not use the `./node-repl` no-client default for live Figma work; use `figma_repl_mcp` after plugin reload, or use package-local `createFigmaReplClient` only with an explicit custom upstream `client`.
5. For non-trivial canvas work, initialize a workspace once, create or edit a local `.figma.js` script, then run it with automatic preflight and write results to local files.
6. Use `figma_repl_guidance` and `figma_repl_lookup` for guidance. Treat lookup snippets as the exposed documentation surface.
7. Local `figma_repl_*` responses use a fixed structured shape; for upstream-backed single-call tools, read upstream JSON from `upstream.result` or text from `upstream.text`, and use `outputFiles.debugFile` for generated JSON debug/result files. Use `figma_repl_get_metadata` for broad layer-tree discovery; it converts upstream XML to compact JSON, returns small trees inline, and writes oversized trees to `outputFiles.metadataFile`. Use `figma_repl_get_design_context`, `figma_repl_get_motion_context`, `figma_repl_export_video`, design-system wrappers, and shader wrappers for their covered official upstream tools.
8. `createFigmaReplClient` mirrors the same result shape in Node: read `result.upstream.result`, compact asset entries, generated debug files, and capture `imageFile` on success.

## Node REPL Route

Use `node_repl` for Figma REPL investigation only when the user explicitly asks for Node-level verification, local package smoke tests, or response-shape debugging. Normal live Figma design work should stay on the hosted `figma_repl_mcp` stdio MCP tools.

- Do not call the `./node-repl` no-client `createFigmaReplClient()` path for live Figma connectivity. That default is local-only and intentionally fails fast for upstream calls.
- For live Figma checks from `node_repl`, create or inject an explicit custom upstream client. The most reliable Codex pattern is to launch the package `dist/repl-stdio-cli.js` as a child stdio MCP process and call its `figma_repl_*` tools from Node.
- For local response-shape tests, use `createFigmaReplClient({ client: fakeOrCustomClient })` and assert the same compact result fields used by MCP tools, especially `upstream.ok`, `upstream.result`, `outputFiles.debugFile`, `outputFiles.metadataFile`, and `imageFile`.
- Use `createRemoteMcpClient()` only for raw upstream SDK debugging, not as the default route for Figma canvas work inside Codex `node_repl`.

Recommended `node_repl` debugging sequence:

1. Use `figma_repl_mcp` directly first when only live Figma work is needed.
2. Use `node_repl` only when comparing package-local behavior, installed-cache behavior, or response-shape parsing.
3. From `node_repl`, start a child MCP process for `dist/repl-stdio-cli.js`, connect with an explicit stdio client, then call `figma_repl_open`, `figma_repl_eval`, `figma_repl_run_script_file`, or `figma_repl_apply_asset_manifest` through that custom client.
4. Before tool calls, use the same stdio client to call `listResources()` and `readResource({ uri: "figma-repl://capabilities" })`; read `figma-repl://guide` for workflow sequencing and `figma-repl://upstream-tools` only when an explicit upstream-only debug task depends on it.
5. If `figma-repl://capabilities` cannot be read from the child MCP process, treat the `node_repl` debug environment as incomplete and fix the stdio client/session wiring before drawing conclusions from tool output.
6. For parser-only tests, skip live Figma and inject a fake/custom client into `createFigmaReplClient({ client })`; provide fake `listResources()` / `readResource()` responses when the code under test needs resource-guided behavior.
7. Capture the structured JSON returned by the tool call and compare only public contract fields; do not rely on private `__figmaRepl` metadata or raw upstream submit URLs.

## Lazy Tool Loading

Figma MCP tools may be deferred and unavailable until discovered. Do not assume `figma_repl_prepare_task`, `figma_repl_run_script_file`, or related tools are already visible. Before any Figma MCP action, call `tool_search` with an exact-prefix query containing `figma_repl_mcp` and `figma_repl_`; Figma tool names intentionally include this prefix, so it should expose the relevant tool family. Use a broader query such as `figma MCP use_figma get node selection` only if the first search does not expose the needed tools.

## Primary File Workflow

- Prepare a repairable workspace and task file: `figma_repl_prepare_task({ file, taskName, surface })`. Use slug-style `taskName` values such as `settings-panel-polish`. The `file` value accepts a Figma URL or raw file key; `cwd` is optional and defaults to the MCP server process cwd.
- Edit the generated `<task>.figma.js`; use native Figma Plugin API plus the injected `$` helpers.
- Execute: `figma_repl_run_script_file({ sessionId, inputFile, strict: true, surface })`; diagnostics and compiled payload preflight run before upstream execution.
- For generated image assets, create target rectangles in the script, then call `figma_repl_apply_asset_manifest({ sessionId, manifestPath })`. Read `assets[].upload.response.imageHash` / `placedOnNodeId` for upload POST evidence, and read `validation` for canvas-side IMAGE fill confirmation. Default target validation checks IMAGE fills when upstream eval is available; incomplete validation records fail the workflow and point to `outputFiles.debugFile`.
- For broad layer-tree discovery, call `figma_repl_get_metadata({ sessionId, target })` before targeted `figma_repl_inspect` style/fill/text checks.
- For implementation context or motion, call `figma_repl_get_design_context({ sessionId, target })` and `figma_repl_get_motion_context({ sessionId, target, recursive: true })`; use `figma_repl_export_video` only when official video frame sampling is worth the render cost.
- For visual QA, call `figma_repl_capture_node({ sessionId, target, imageFile })` and inspect the local image file.
- For repeatable multi-step workflows, use `figma_repl_run_task_plan({ sessionId, planPath })`.

Workspace files live under `<cwd>/figma-mcp/<fileKey-or-fileSlug>/`. Calls should use simple `file`, `taskName`, `inputFile`, `manifestPath`, `target`, `imageFile`, and `planPath` defaults after workspace initialization. `title` is optional display-only MCP call metadata for Codex/UI; the runtime validates it as a string when supplied but does not store it, default it, pass it upstream, or use it for task/file naming. Inline assets/steps, custom upstream templates, absolute `scriptPath`, and upstream overrides are advanced/debug escape hatches; JSON debug files are generated on demand and reported at `outputFiles.debugFile`. `inlineResultLimit` applies only to payload-size control. Use tool input schemas for argument details.

## Script Contract

- Write ordinary async JavaScript in `.figma.js`: native Figma Plugin API for advanced work, injected `$` helpers for common agent tasks.
- Keep each transaction small and repairable. If preflight diagnostics fail, fix diagnostics by file line and rerun the same script.
- Return compact JSON with changed node ids, handles, and validation notes. Use generated `outputFiles.debugFile` pointers for failure or omitted-payload debug JSON instead of relying on inline MCP output.
- Read parsed upstream JSON from `upstream.result`; if upstream output is not JSON, read `upstream.text`. Debug file pointers are reported in `outputFiles.debugFile`.
- Ordinary tool responses return only a minimal session summary with `handleChanges` and optional top-level `sessionDir`; read `figma-repl://sessions` for the compact list, `figma-repl://sessions/{id}` for compact detail with handles, and `figma-repl://sessions/{id}/handles` when only the remembered handle map is needed.
- Common helpers: `$.find`, `$.findAll`, `$.create`, `$.text`, `$.layout`, `$.select`, `$.checkpoint`, `$.remember`, `$.forget`, `$.inspect`, `$.imageAsset`, `$.screenshot`, and `$.cloneNodeTree`.
- Prefer `$.select` over direct selection mutation. Use `figma_repl_inspect({ mode: "validate" })` before reusing old handles.
- For generated assets, use `$.imageAsset` only for small inline PNG/JPEG data; for larger local assets, create target rectangles and use `figma_repl_apply_asset_manifest`.
- Use `figma_repl_capture_node` for final visual QA and `figma_repl_run_task_plan` for repeatable script, asset, capture, and upstream-tool sequences.
- Use `figma_repl_get_metadata` before broad structure analysis; follow with `figma_repl_inspect(mode=style)` only when fills, text, and visual tokens are needed.

## Lookup Order

- Use `figma-repl://capabilities` as the short routing manifest.
- Use `figma-repl://guide` for continuous workflow sequencing.
- Use `figma-repl://lookup-index` to choose between `figma_repl_guidance` and `figma_repl_lookup`.
- Use `figma_repl_guidance` for BM25-style query-to-helper routing and curated short cards.
- Use `figma_repl_lookup({ kind: "docs" })` for BM25-ranked workflow snippets.
- Use `figma_repl_lookup({ kind: "api" })` for exact Plugin API symbols. It returns capped snippets and never returns a full declaration file.
- For deeper static workflow, lookup, or safety notes, read `references/figma-repl-workflow.md`, `references/figma-repl-guidance-and-lookup.md`, or `references/figma-repl-safety.md`.

Use `figma_repl_call_upstream_tool` only when a required official capability is explicitly not covered by the file workflow or dedicated wrappers. Read `figma-repl://upstream-tools` first when an uncovered upstream-only debug task depends on it. Prefer first-class wrappers for metadata, design context, motion context, video export, design-system reads, and shader effect/fill reads. Keep local REPL handles/session metadata for agent state; do not use PluginData for agent bookkeeping.

## Query Strategy

- For planning/search, call `figma_repl_guidance({ query })` first with compact keyword queries such as `text font loadFontAsync` or `components variants properties`, then use its `recommendedCards`, `queryHints`, `apiSymbols`, `guardrails`, and `referenceContext` fields before writing `.figma.js`.
- Use `figma_repl_guidance` for compact patterns, then use `apiSymbols` with `figma_repl_lookup({ kind: "api" })` only when exact Plugin API details are still missing.
- Treat `guardrails` as task-specific risk notes, especially for font loading, variable binding, instance properties, image upload paths, FigJam, and Slides surface mismatches.
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

- `figma_repl_mcp`: primary agent-facing facade after OAuth registration. It runs local `.figma.js` files, writes local output files, exposes compact docs/API lookup, stores process-local handles, captures screenshots, applies generated assets, provides thin first-class wrappers for covered official upstream tools, and delegates only uncovered official capabilities.
- `figma-stdio`: optional transparent bridge for upstream debugging and parity checks. It is not installed as a persistent plugin MCP server by default; use the package CLI or Node API `createRemoteMcpClient` when raw official MCP access is required.
