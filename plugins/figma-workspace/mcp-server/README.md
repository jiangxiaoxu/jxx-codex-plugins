# Figma MCP Stdio Frontend

Node package for two Figma MCP frontends:

- `figma_workspace_mcp`: agent-friendly facade for local `.figma.ts` workflows, output files, compact lookup, asset manifests, capture, and task plans;
- `figma_workspace_upstream_stdio`: optional transparent bridge CLI/server name for `https://mcp.figma.com/mcp` parity checks and Node/node_repl debugging.

Both reuse the OAuth cache created by `figma-workspace`.

## Install

```bash
npm install
npm run build
```

Cache path priority:

```text
FIGMA_WORKSPACE_OAUTH_CACHE_PATH
CODEX_HOME/.figma-workspace-oauth.json
USERPROFILE/.codex/.figma-workspace-oauth.json
```

The shared cache must already contain valid OAuth state. Use the bridge login helper before starting stdio tools.

If upgrading from old hyphenated persistent server ids, reload or reinstall the plugin, or restart the MCP server, before schema checks. Otherwise the old cached server id can still expose stale tool schemas.

Build output keeps public entry paths as thin wrappers and places the bundled runtime in `dist/runtime/workspace-runtime.js`, so large dependencies such as the TypeScript compiler are not repeated across each CLI/API entry.

## Package API

```ts
import {
  createFigmaWorkspaceUpstreamStdioServer,
  createRemoteMcpClient,
} from "@jxx-codex-plugins/figma-workspace-stdio";
import {
  createFigmaWorkspaceClient,
  diagnoseFigmaWorkspaceCode,
} from "@jxx-codex-plugins/figma-workspace-stdio/workspace";
```

Node workspace usage with an explicit custom upstream client:

```js
const { createFigmaWorkspaceClient } = await import("./dist/upstream/node-upstream-client.js");

const figma = createFigmaWorkspaceClient({
  client: customUpstreamClient,
});
await figma.open({
  file: "https://www.figma.com/design/<fileKey>/<fileName>?node-id=<nodeId>",
  surface: "design",
});
const evalResult = await figma.eval({
  code: "return { page: figma.currentPage.name };",
  mode: "read",
});
const payload = evalResult.upstream.result;
const capture = await figma.captureNode({
  target: "$target",
  imageFile: "qa.png",
});
if (!capture.ok) console.log(capture.upstreamError);
await figma.close();
```

Without an explicit `client`, `./node-upstream-client` creates a local-only workspace client: session setup, workspace preparation, diagnostics, and `connect: false` opens work, but live upstream calls fail with a message directing callers to use `figma_workspace_mcp` or inject a custom client. Use the hosted `figma_workspace_mcp` stdio MCP server for normal live Figma work.

In Codex `node_repl`, the recommended live-Figma verification path is an explicit stdio MCP client pointed at this package's `dist/mcp/workspace-mcp-stdio-bin.js`, then calling `figma_workspace_open`, `figma_workspace_get_metadata`, `figma_workspace_run_script_file`, and related tools through that child process. This exercises the same public MCP contract while avoiding the embedded no-client SDK remote transport. Use fake/custom clients for response-shape unit smoke tests.

The `./node-upstream-client` entrypoint still installs Web Streams globals before loading SDK-backed modules, so explicit `createRemoteMcpClient()` use does not require callers to predefine `ReadableStream`, `TransformStream`, or `WritableStream`.

For explicit raw upstream access from Node, use the same entrypoint and call `createRemoteMcpClient` directly:

```js
const { createRemoteMcpClient } = await import("./dist/upstream/node-upstream-client.js");

const upstream = createRemoteMcpClient({
  statePath: "C:/Users/you/.codex/.figma-workspace-oauth.json",
});
await upstream.connect();
const tools = await upstream.listTools();
await upstream.close();
```

`statePath` must be absolute. CLI/MCP usage can select the same file with `FIGMA_WORKSPACE_OAUTH_CACHE_PATH`.

## Workspace Response Shape

Every local `figma_workspace_*` tool returns a fixed structured shape. Ordinary tool `session` summaries contain only `id`, `fileKey`, `surface`, optional `sessionDir`, and `handleChanges`; read `figma-workspace://sessions` for the compact list, `figma-workspace://sessions/{id}` for compact detail with handle counts/previews, and `figma-workspace://sessions/{id}/handles` when the full handle map is needed. `diagnostics` is always an array, and JSON debug/result file pointers are under `outputFiles.debugFile` as `{ path, bytes, lineCount }`. Upstream-backed single-call tools return effective upstream success as `upstream.ok`, public upstream JSON as `upstream.result`, and non-JSON upstream output as `upstream.text`; eval/script payloads containing bridge-internal `__figmaRepl` metadata are unwrapped to their business result, while raw official JSON without top-level `ok` remains unchanged as `upstream.result`. `figma_workspace_get_metadata` is the metadata-first wrapper for official `get_metadata`: upstream XML is converted to compact JSON, small `metadata.json` trees are returned inline, and oversized trees are written to `outputFiles.metadataFile`. `figma_workspace_get_design_context`, `figma_workspace_get_motion_context`, `figma_workspace_search_design_system`, `figma_workspace_get_libraries`, and `figma_workspace_get_variable_defs` are first-class thin wrappers over official upstream tools; node-scoped `target` inputs accept raw node ids, node URLs, and local handles. Curated upstream optionals are first-class only where intentionally exposed: design context has client hints plus `forceCode`, `disableCodeConnect`, and `excludeScreenshot`; motion context has `recursive` plus client hints; capture has `maxDimension` and `contentsOnly`; variable defs no longer accepts client hints. Use `figma_workspace_call_upstream_tool` for official `export_video`. Design-context and motion wrappers return compact `guidanceRef` pointers to `figma_workspace_guidance` for full wrapper profiles and workflow graph hints without interpreting `upstream.result`. Official shader effect/fill tools are available through `figma-workspace://upstream-tools/{name}` and `figma_workspace_call_upstream_tool`. Asset manifests keep compact inline asset entries and write full per-asset upstream details only to generated debug files.

`figma_workspace_apply_asset_manifest` validates target IMAGE fills after upload when upstream eval is available. Successful submitUrl POSTs expose compact `assets[].upload` evidence such as `imageHash` and `placedOnNodeId` without returning raw submit URLs. If validation runs but cannot confirm every target record, the tool returns `ok:false` with `validation.reason` and writes `outputFiles.debugFile`; `validateTargets:false` remains the explicit skip.

Status fields are separate. Top-level `ok` reports local wrapper/tool completion. `upstream.ok` reports effective upstream success: false for upstream call failures and false when the shaped business result has top-level `ok:false`; `upstream.result` removes that consumed `ok` and adds `source: "business"` when JSON supplied `ok:false`, or `source: "call"` for call failures without a consumed result status.

Executed `figma_workspace_run_script_file` result files use the same `upstream` envelope and do not duplicate upstream JSON into `raw`.

## Workspace File Workflow

`figma_workspace_run_script_file` is the primary path for non-trivial Plugin API work. Prefer preparing one workspace per Figma file, then use file names instead of absolute paths:

```js
await figma.prepareTask({
  sessionId: "settings workspace",
  file: "https://www.figma.com/design/ExampleFigmaFileKey012/UI",
  taskName: "settings-panel-polish",
  workspaceDir: "C:/path/to/project/figma-workspace",
  overwrite: true,
});
await figma.runScriptFile({
  sessionId: "settings workspace",
  inputFile: "settings-panel-polish.figma.ts",
  strict: true,
});
```

`figma_workspace_prepare_task` requires an absolute `workspaceDir` chosen by the agent inside the current project, worktree, or task artifacts, for example `<project>/figma-workspace` or `<project>/task-memory/<task-id>/artifacts/figma-workspace`. When `file` is supplied, it creates `<workspaceDir>/<fileKey-or-fileSlug>/`; the MCP server uses `workspaceDir` as supplied and does not append another `figma-workspace` segment. A task normally uses slug-style `taskName` such as `settings-panel-polish` and `<taskName>.figma.ts` in that folder, then calls `runScriptFile` with `inputFile`. `runScriptFile` strict-checks TypeScript with Figma Plugin API typings, compiles the upstream payload internally, and runs diagnostics before upstream execution; preflight failures return structured diagnostics without calling upstream Figma. JSON debug/result files are generated on demand and returned through `outputFiles.debugFile`; script upstream sidecars use `outputFiles.upstreamFile`, and failure-only compiled payload files use `outputFiles.compiledScriptFile`. Absolute `scriptPath`, upstream overrides, and `run_script_file` `inlineResultLimit` remain advanced/debug escape hatches.

Write ordinary async TypeScript script bodies in `.figma.ts` files. Use native Figma Plugin API calls for creation, querying, and layout; injected `$` helpers are a small workflow layer for handles, text/font loading, checkpoints, inspection, assets, placement, guarded replacement, and cloning:

```ts
const section: FrameNode = figma.createFrame();
section.name = "Settings section";
section.resize(360, 160);
section.layoutMode = "VERTICAL";
section.itemSpacing = 12;
section.fills = [{ type: "SOLID", color: { r: 1, g: 1, b: 1 } }];
section.cornerRadius = 12;
figma.currentPage.appendChild(section);
$.remember("$section", section);

await $.text({
  parent: "$section",
  as: "$sectionTitle",
  text: "Settings",
  font: { family: "Inter", style: "Bold", size: 20 },
});
return await $.checkpoint("section-created", ["$section"], { depth: 1 });
```

Common helpers include `$`, `$.handles`, `$.remember`, `$.forget`, `$.resolveId`, `$.node`, `$.select`, `$.text`, `$.checkpoint`, `$.inspect`, `$.imageAsset`, `$.screenshot`, `$.findFreeSlot`, `$.placeNode`, `$.replaceGeneratedFrame`, and `$.cloneNodeTree`. Script files and eval wrapper calls are parsed with AST analysis, and the runner injects only referenced `$` helpers plus required dependencies. Use static references such as `$.text(...)`, `$["text"](...)`, or `const { text } = $`; dynamic `$[name]`, `$` aliasing, object rest destructuring, and local `$` declarations are rejected. Read `figma-workspace://guide` for compact helper categories and hard rules, then call `figma_workspace_guidance({ query })` for on-demand `helperProfiles` with allowed patterns, avoid notes, lookup hints, and examples.

## Assets, Capture, and Plans

- `figma_workspace_apply_asset_manifest`: recommended call is `{ sessionId, manifestPath }`; inline assets are advanced/debug fields.
- `figma_workspace_capture_node`: recommended call is `{ sessionId, target, imageFile }`; optional `maxDimension` and `contentsOnly` pass through to upstream screenshots; `imageFile` is the PNG path and no `outputFiles` are returned.
- `figma_workspace_run_task_plan`: recommended call is `{ sessionId, planPath }`; inline `steps` are advanced fields and each step must be `{ type, args }`.

Keep `.figma.ts` transactions small enough for upstream `use_figma` payload limits. Split dense work into skeleton, asset targets, upload fills, and visual fixes when payload diagnostics appear.

## Guidance and Lookup

The workspace facade keeps MCP resources limited to compact routing, workflow, session state, dynamic discovery, and MCP-debug fault identification:

- routing manifest: `figma-workspace://capabilities`;
- MCP development/debugging fault identification: `figma-workspace://diagnostics`;
- workflow guide: `figma-workspace://guide`;
- lookup index: `figma-workspace://lookup-index`;
- workflow tools: `figma_workspace_prepare_task`, `figma_workspace_guidance`, `figma_workspace_get_metadata`, `figma_workspace_get_design_context`, `figma_workspace_get_motion_context`, `figma_workspace_search_design_system`, `figma_workspace_get_libraries`, and `figma_workspace_get_variable_defs`;
- execution: `figma_workspace_open`, `figma_workspace_eval`, `figma_workspace_run_script_file`, `figma_workspace_run_task_plan`;
- assets and QA: `figma_workspace_apply_asset_manifest`, `figma_workspace_capture_node`;
- state resources: `figma-workspace://sessions` for compact session list, `figma-workspace://sessions/{id}` for compact detail with handle counts/previews and minimal workspace context, and `figma-workspace://sessions/{id}/handles` for full handle-map reads;
- upstream discovery/resource bridge: `figma-workspace://upstream-tools`, `figma_workspace_call_upstream_tool`;
- references: `figma_workspace_lookup` with `kind: "docs"` or `kind: "api"`, plus lightweight `figma-workspace` skill reference files for static workflow, lookup, and safety notes.

Use `figma_workspace_guidance` first for common intents, `mode: "plan"` workflow planning, curated compact API cards, and wrapper profile suggestions. Use `figma_workspace_get_metadata` for broad layer-tree discovery before targeted `figma_workspace_inspect` style/fill/text checks. Use `figma_workspace_get_design_context` for official implementation context, `figma_workspace_get_motion_context` for animation data for start/poll video renders, and `figma_workspace_search_design_system`, `figma_workspace_get_libraries`, and `figma_workspace_get_variable_defs` when official design-system context is needed. `figma-workspace://lookup-index` exposes compact wrapper profiles and workflow graph nodes for design implementation context and motion implementation. Use `figma_workspace_lookup({ kind: "docs" })` for BM25-ranked workflow snippets plus compact bridge-owned explanations for `guidanceRef`, wrapper profiles, helper profiles, and workflow graph routing; use `figma_workspace_lookup({ kind: "api" })` for exact Plugin API symbols. Prefer first-class wrappers when available; use `figma_workspace_call_upstream_tool` for raw upstream behavior or uncovered capabilities, including official shader effect/fill reads, after reading `figma-workspace://upstream-tools`. Lookup output is capped and confidence-labeled; bundled JSONL corpus files are internal and are not an agent-facing documentation path.

Implementation, motion, design parity review, and Code Connect work have curated guidance cards. They use first-class context wrappers where available, keep uncovered Code Connect suggestions behind `figma_workspace_call_upstream_tool`, capture local visual evidence through `figma_workspace_capture_node`, and require produced code/templates to follow the current project rather than copied upstream agent prompts.

## Diagnostics

Diagnostics use `{ code, severity, message, suggestion, docsHint }`. Script-file diagnostics may include `{ source: { scriptPath, line, column } }`. Fatal diagnostics block upstream execution; warnings return with the result.

`allowDangerousOperations` bypasses destructive/dynamic-code guards only. It does not bypass Plugin API contract, read-mode, or Design/FigJam/Slides surface guards.

## Validation

```bash
npm run typecheck
npm test
```

`npm test` is offline and deterministic; it checks wrapper parity against the pinned upstream contract fixture in `tests/fixtures/upstream-contract-snapshot.json`. Use the live contract commands only when intentionally checking or refreshing official upstream drift:

```bash
npm run upstream:contract:check
npm run upstream:contract:refresh
```

Both live commands use the official Figma remote MCP through the existing OAuth/http client and may require `npm run login:figma-http`, network access, and upstream availability.
