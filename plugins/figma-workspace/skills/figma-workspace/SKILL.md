---
name: figma-workspace
description: Route Figma work through the exact MCP server figma_workspace_mcp and its figma_workspace_ tool family. Use for Figma design, FigJam, Slides, design systems, tokens, components, use_figma, Plugin API lookup, or Figma MCP auth repair. When selected, first expose deferred tools with tool_search query "figma_workspace_mcp figma_workspace_ figma".
---

# Figma Router

Use this skill as the lightweight router for Figma MCP work. After OAuth registration, use `figma_workspace_mcp` as the agent-facing entrypoint. Bundled JSONL upstream corpus files are internal lookup data; do not read or route agents to them directly.

## Default Route

1. If the user asks for login, auth setup, credential refresh, or auth repair, run the Figma MCP Login flow below.
2. Before any Figma MCP action, expose deferred Figma tools through `tool_search` with a query such as `figma_workspace_mcp figma_workspace_ figma`.
3. After Figma tools are available, read `figma-workspace://capabilities`, then `figma-workspace://guide` when workflow sequencing is needed.
4. If direct `figma_workspace_*` tools are not installed in the active Codex environment, do not use the `./node-upstream-client` no-client default for live Figma work; use `figma_workspace_mcp` after plugin reload, or use package-local `createFigmaWorkspaceClient` only with an explicit custom upstream `client`.
5. Read `figma-workspace://diagnostics` only when developing/debugging `figma_workspace_mcp` or identifying MCP runtime-resource, reload, lookup-corpus, or installed-cache faults; do not read it for normal Figma work or script preflight repair.
6. For non-trivial canvas work, initialize a workspace once, create or edit a local `.figma.ts` script, then run it with automatic strict TypeScript preflight and write results to local files.
7. Use `figma_workspace_guidance` and `figma_workspace_lookup` for guidance. Treat lookup snippets as the exposed documentation surface.
8. Local `figma_workspace_*` tools return structured results; use each tool schema and `figma-workspace://guide` for response details.
9. Use local first-class wrappers for official upstream capabilities they already cover, including metadata, design context, motion context, and design-system reads. Use the Upstream Tool Discovery section for official capabilities that are hidden behind upstream resources instead of exposed as local tools.
10. `createFigmaWorkspaceClient` mirrors the same result shape in Node: read `result.upstream.result`, compact asset entries, generated debug files, and capture `imageFile` on success.

## Node Tool Route

Use `node_repl` for Figma Workspace investigation only when the user explicitly asks for Node-level verification, local package smoke tests, or response-shape debugging. Normal live Figma design work should stay on the hosted `figma_workspace_mcp` stdio MCP tools.

- Do not call the `./node-upstream-client` no-client `createFigmaWorkspaceClient()` path for live Figma connectivity. That default is local-only and intentionally fails fast for upstream calls.
- For live Figma checks from `node_repl`, create or inject an explicit custom upstream client. The most reliable Codex pattern is to launch the package `dist/mcp/workspace-mcp-stdio-bin.js` as a child stdio MCP process and call its `figma_workspace_*` tools from Node.
- For local response-shape tests, use `createFigmaWorkspaceClient({ client: fakeOrCustomClient })` and assert the same compact result fields used by MCP tools, especially `upstream.ok`, `upstream.result`, `outputFiles.debugFile`, `outputFiles.metadataFile`, and `imageFile`.
- Use `createRemoteMcpClient()` only for raw upstream SDK debugging, not as the default route for Figma canvas work inside Codex `node_repl`.

Recommended `node_repl` debugging sequence:

1. Use `figma_workspace_mcp` directly first when only live Figma work is needed.
2. Use `node_repl` only when comparing package-local behavior, installed-cache behavior, or response-shape parsing.
3. From `node_repl`, start a child MCP process for `dist/mcp/workspace-mcp-stdio-bin.js`, connect with an explicit stdio client, then call `figma_workspace_open`, `figma_workspace_eval`, `figma_workspace_run_script_file`, or `figma_workspace_apply_asset_manifest` through that custom client.
4. Before tool calls, use the same stdio client to call `listResources()` and `readResource({ uri: "figma-workspace://capabilities" })`; read `figma-workspace://guide` for workflow sequencing and `figma-workspace://upstream-tools` only when an explicit upstream-only debug task depends on it.
5. If `figma-workspace://capabilities` cannot be read from the child MCP process, treat the `node_repl` debug environment as incomplete and fix the stdio client/session wiring before drawing conclusions from tool output.
6. For parser-only tests, skip live Figma and inject a fake/custom client into `createFigmaWorkspaceClient({ client })`; provide fake `listResources()` / `readResource()` responses when the code under test needs resource-guided behavior.
7. Capture the structured JSON returned by the tool call and compare only public contract fields; do not rely on private `__figmaRepl` metadata or raw upstream submit URLs.

## Lazy Tool Loading

Figma MCP tools may be deferred and unavailable until discovered. Do not assume `figma_workspace_prepare_task`, `figma_workspace_run_script_file`, or related tools are already visible. Before any Figma MCP action, call `tool_search` with an exact-prefix query containing `figma_workspace_mcp` and `figma_workspace_`; Figma tool names intentionally include this prefix, so it should expose the relevant tool family. Use a broader query such as `figma MCP use_figma get node selection` only if the first search does not expose the needed tools.

## Primary File Workflow

- Prepare a repairable workspace and task file: `figma_workspace_prepare_task({ file, taskName, workspaceDir, surface })`. Use slug-style `taskName` values such as `settings-panel-polish`. The `file` value accepts a Figma URL or raw file key; `workspaceDir` is a required absolute local directory chosen by the agent inside the current project, worktree, or task artifacts, such as `<project>/figma-workspace` or `<project>/task-memory/<task-id>/artifacts/figma-workspace`.
- Edit the generated `<task>.figma.ts`; use native Figma Plugin API plus the injected `$` helpers.
- Execute: `figma_workspace_run_script_file({ sessionId, inputFile, strict: true, surface })`; diagnostics and compiled payload preflight run before upstream execution.
- For generated image assets, create target rectangles in the script, then call `figma_workspace_apply_asset_manifest({ sessionId, manifestPath })`. Read `assets[].upload.response.imageHash` / `placedOnNodeId` for upload POST evidence, and read `validation` for canvas-side IMAGE fill confirmation. Default target validation checks IMAGE fills when upstream eval is available; incomplete validation records fail the workflow and point to `outputFiles.debugFile`.
- For broad layer-tree discovery, call `figma_workspace_get_metadata({ sessionId, target })` before targeted `figma_workspace_inspect` style/fill/text checks.
- For targeted inspect/style/handle validation, call `figma_workspace_inspect({ sessionId, target })` only after the session has file context from `open` or `prepare_task`; `target` is string-only and does not accept `{ fileKey, nodeId }`.
- For implementation context or motion, call `figma_workspace_get_design_context({ sessionId, target })` and `figma_workspace_get_motion_context({ sessionId, target, recursive: true })`; pass curated upstream optionals such as client hints, design-context Code Connect toggles, or export-video render controls only when the task needs them. Node-scoped wrappers also accept node URLs and `{ fileKey, nodeId }` targets when no session file context is available.
- For visual QA, call `figma_workspace_capture_node({ sessionId, target, imageFile })` and inspect the local image file; optional `maxDimension` and `contentsOnly` tune upstream capture. Node URL or `target:{ fileKey, nodeId }` can supply file context directly.
- For visible audit markers or temporary verification labels, place them outside the inspected frame or in a confirmed free slot so they do not cover primary controls, text, or content being captured.
- For repeatable multi-step workflows, use `figma_workspace_run_task_plan({ sessionId, planPath })`.

Workspace files live under `<workspaceDir>/<fileKey-or-fileSlug>/`. `workspaceDir` is used as supplied; the MCP server does not append another `figma-workspace` segment. The workspace folder is temporary local Figma work; do not commit it to the git repository by default. Calls should use simple `file`, `taskName`, `inputFile`, `manifestPath`, `target`, `imageFile`, and `planPath` defaults after workspace initialization. `title` is optional display-only MCP call metadata for Codex/UI; the runtime validates it as a string when supplied but does not store it, default it, pass it upstream, or use it for task/file naming. Inline assets/steps, custom upstream templates, absolute `scriptPath`, and upstream overrides are advanced/debug escape hatches; JSON debug files are generated on demand and reported at `outputFiles.debugFile`. `inlineResultLimit` applies only to payload-size control. Use tool input schemas for argument details.

## Script Contract

- Write an ordinary async TypeScript script body in `.figma.ts`: native Figma Plugin API for advanced work, injected `$` helpers for common agent tasks.
- Keep each transaction small and repairable. If preflight diagnostics fail, fix diagnostics by file line and rerun the same script.
- Return compact JSON with changed node ids, handles, and validation notes. Use generated `outputFiles.debugFile` pointers for failure or omitted-payload debug JSON instead of relying on inline MCP output.
- Read parsed upstream JSON from `upstream.result`; if upstream output is not JSON, read `upstream.text`. Debug file pointers are reported in `outputFiles.debugFile`.
- Ordinary tool responses return only a minimal `session` summary with `handleChanges` and optional `session.sessionDir`; read `figma-workspace://sessions` for the compact list, `figma-workspace://sessions/{id}` for compact detail with handle counts/previews, and `figma-workspace://sessions/{id}/handles` when the full remembered handle map is needed.
- Common helpers: `$.text`, `$.select`, `$.checkpoint`, `$.remember`, `$.forget`, `$.inspect`, `$.imageAsset`, `$.screenshot`, `$.cloneNodeTree`, `$.findFreeSlot`, `$.placeNode`, and `$.replaceGeneratedFrame`. Use native Figma Plugin API for node creation, querying, and auto layout.
- Prefer `$.select` over direct selection mutation. Use `figma_workspace_inspect({ mode: "validate" })` before reusing old handles.
- For generated assets, use `$.imageAsset` only for small inline PNG/JPEG data; for larger local assets, create target rectangles and use `figma_workspace_apply_asset_manifest`.
- Use `figma_workspace_capture_node` for final visual QA and `figma_workspace_run_task_plan` for repeatable script, asset, capture, and upstream-tool sequences.
- Use `figma_workspace_get_metadata` before broad structure analysis; follow with `figma_workspace_inspect(mode=style)` only when fills, text, and visual tokens are needed.

## Lookup Order

- Use `figma-workspace://capabilities` as the short routing manifest.
- Use `figma-workspace://diagnostics` only for MCP development/debugging and MCP fault identification, such as runtime-resource, reload, lookup-corpus, or installed-cache failures.
- Use `figma-workspace://guide` for continuous workflow sequencing.
- Use `figma-workspace://lookup-index` to choose between `figma_workspace_guidance` and `figma_workspace_lookup`.
- Use `figma_workspace_guidance` for BM25-style query-to-helper routing and curated short cards.
- Use `figma_workspace_lookup({ kind: "docs" })` for BM25-ranked workflow snippets.
- Use `figma_workspace_lookup({ kind: "api" })` for exact Plugin API symbols. It returns capped snippets and never returns a full declaration file.
- For deeper static workflow, lookup, or safety notes, read `references/figma-workspace-workflow.md`, `references/figma-workspace-guidance-and-lookup.md`, or `references/figma-workspace-safety.md`.

Prefer first-class wrappers for metadata, design context, motion context, and design-system reads. Use `figma_workspace_call_upstream_tool` when raw upstream behavior or an uncovered official capability is needed, including official shader effect/fill reads and official `export_video`. Read `figma-workspace://upstream-tools` first for upstream escape-hatch calls. Keep local workspace handles/session metadata for agent state; do not use PluginData for agent bookkeeping.

## Upstream Tool Discovery

Most local `figma_workspace_*` tools are visible through tool descriptions. This section names official upstream capabilities that are useful but otherwise hidden behind resources.

For any listed tool below, read `figma-workspace://upstream-tools/{name}` directly to get its full description and `inputSchema`. Read `figma-workspace://upstream-tools` only when discovering available upstream tools. Call the selected tool with `figma_workspace_call_upstream_tool({ toolName: "<name>", arguments: { ... } })`.

| Capability | Upstream tool names | Use when |
|---|---|---|
| Account/auth check | `whoami` | The user asks which Figma account/session is authenticated. |
| New file creation | `create_new_file` | The task needs a new blank Figma file before canvas work starts. |
| Design generation/import | `generate_figma_design` | The user asks to import/generate design content from URL or HTML into an existing design file. |
| FigJam diagram generation | `generate_diagram` | The user explicitly wants a FigJam diagram from Mermaid-style input. |
| FigJam context | `get_figjam` | The task targets FigJam content and no local workflow wrapper covers the needed read. |
| Code Connect reads/suggestions | `get_code_connect_map`, `get_context_for_code_connect`, `get_code_connect_suggestions` | The user asks to inspect or prepare component-to-code mappings. |
| Code Connect writes | `add_code_connect_map`, `send_code_connect_mappings` | The user explicitly asks to create, update, or publish mappings. |
| Shader library reads | `list_shader_effects`, `get_shader_effect`, `list_shader_fills`, `get_shader_fill` | The task explicitly needs shader effect/fill library entries or source manifests. |

Prefer local tools for Plugin API execution, screenshots/capture, metadata, asset upload/download workflows, design context, motion context, library search, libraries, and variable definitions. Use `figma_workspace_call_upstream_tool` when you need the raw official upstream contract or an uncovered capability such as official `export_video`.

## Query Strategy

- For planning/search, call `figma_workspace_guidance({ query })` first with compact keyword queries such as `text font loadFontAsync` or `components variants properties`, then use its `recommendedCards`, `queryHints`, `apiSymbols`, `guardrails`, and `suggestions.referenceContext` fields before writing `.figma.ts`.
- Use `figma_workspace_guidance` for compact patterns, then use `apiSymbols` with `figma_workspace_lookup({ kind: "api" })` only when exact Plugin API details are still missing.
- Treat `guardrails` as task-specific risk notes, especially for font loading, variable binding, instance properties, image upload paths, FigJam, and Slides surface mismatches.
- For typography from 96 DPI game UI systems such as UE5/UMG/Slate, read `references/figma-workspace-safety.md` for the 72 DPI Figma conversion guardrail.
- Prefer these anchors when narrowing a query: text/font, auto layout, variables/tokens, styles, components/variants, instances/properties, images/fills, selection, capture/QA, FigJam/Slides.

## Figma MCP Login

When a Figma Workspace MCP call or resource read returns an `upstreamError.code` of `FIGMA_UPSTREAM_AUTH_REQUIRED` or a code starting with `FIGMA_UPSTREAM_OAUTH_`, ask the user whether to start browser authorization before running the login helper. If the user agrees, run the helper below, wait for completion, then verify connectivity with `figma_workspace_call_upstream_tool({ toolName: "whoami", arguments: {} })`. If the user declines, do not run the login helper; report that Figma upstream access remains unavailable until OAuth is completed.

Run the login helper from the plugin root, which is two directories above this `SKILL.md`:

```text
workdir: <plugin-root>
command: npm run login:figma-http
```

The helper starts the local HTTP bridge, temporarily logs in through `figma-http`, then removes that temporary MCP entry. Repeated runs ensure the OAuth cache is usable and report whether this run changed the cache; use `npm run login:figma-http -- --force` only when a fresh browser authorization is required. After browser OAuth, use the resolver below when a script or programmatic client needs the shared cache path.

Do not add persistent `figma-http`; the plugin's persistent MCP server is `figma_workspace_mcp`.

To resolve the shared OAuth cache path for scripts or programmatic clients, run this from the plugin root:

```text
workdir: <plugin-root>
command: npm run oauth-cache:path
```

## Bundled Servers

- `figma_workspace_mcp`: primary agent-facing facade after OAuth registration. It runs local `.figma.ts` files, writes local output files, exposes compact docs/API lookup, stores process-local handles, captures screenshots, applies generated assets, provides selected first-class wrappers for covered official upstream tools, and delegates only uncovered official capabilities.
- `figma_workspace_upstream_stdio`: optional transparent bridge CLI/server for upstream debugging and parity checks. It is not installed as a persistent plugin MCP server by default; use the package CLI or Node API `createRemoteMcpClient` when raw official MCP access is required.
