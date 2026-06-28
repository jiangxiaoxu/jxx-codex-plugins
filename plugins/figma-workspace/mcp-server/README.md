# Figma MCP Stdio Frontend

Node package for two Figma MCP frontends:

- `figma_workspace_mcp`: agent-friendly facade for local `.figma.js` workflows, output files, compact lookup, asset manifests, capture, and task plans;
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

Every local `figma_workspace_*` tool returns a fixed structured shape. Ordinary tool `session` summaries contain only `id`, `fileKey`, `surface`, optional `sessionDir`, and `handleChanges`; read `figma-workspace://sessions` for the compact list, `figma-workspace://sessions/{id}` for compact detail with handles, and `figma-workspace://sessions/{id}/handles` when only the full handle map is needed. `diagnostics` is always an array, and JSON debug/result file pointers are under `outputFiles.debugFile` as `{ path, bytes, lineCount }`. Upstream-backed single-call tools return effective upstream success as `upstream.ok`, public upstream JSON as `upstream.result`, and non-JSON upstream output as `upstream.text`; eval/script payloads containing bridge-internal `__figmaRepl` metadata are unwrapped to their business result, while raw official JSON without top-level `ok` remains unchanged as `upstream.result`. `figma_workspace_get_metadata` is the metadata-first wrapper for official `get_metadata`: upstream XML is converted to compact JSON, small `metadata.json` trees are returned inline, and oversized trees are written to `outputFiles.metadataFile`. `figma_workspace_get_design_context`, `figma_workspace_get_motion_context`, `figma_workspace_export_video`, `figma_workspace_search_design_system`, `figma_workspace_get_libraries`, and `figma_workspace_get_variable_defs` are first-class thin wrappers over official upstream tools; node-scoped `target` inputs accept raw node ids, node URLs, and local handles. Design-context, motion, and video wrappers return compact `guidanceRef` pointers to `figma_workspace_guidance` for full wrapper profiles and workflow graph hints without interpreting `upstream.result`. Official shader effect/fill tools are available through `figma-workspace://upstream-tools/{name}` and `figma_workspace_call_upstream_tool`. Asset manifests keep compact inline asset entries and write full per-asset upstream details only to generated debug files.

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
  overwrite: true,
});
await figma.runScriptFile({
  sessionId: "settings workspace",
  inputFile: "settings-panel-polish.figma.js",
  strict: true,
});
```

`figma_workspace_prepare_task` creates `<cwd>/figma-workspace/<fileKey-or-fileSlug>/` when `file` is supplied. `cwd` is optional and defaults to the MCP server process cwd. A task normally uses slug-style `taskName` such as `settings-panel-polish` and `<taskName>.figma.js` in that folder, then calls `runScriptFile` with `inputFile`. `runScriptFile` always runs diagnostics and compiled payload preflight before upstream execution; preflight failures return structured diagnostics without calling upstream Figma. JSON debug/result files are generated on demand and returned through `outputFiles.debugFile`; script upstream sidecars use `outputFiles.upstreamFile`, and failure-only compiled wrappers use `outputFiles.compiledScriptFile`. Absolute `scriptPath`, upstream overrides, and `run_script_file` `inlineResultLimit` remain advanced/debug escape hatches.

Write ordinary async JavaScript in `.figma.js` files. Use native Figma Plugin API calls for advanced work and injected `$` helpers for common agent tasks:

```js
await $.create({
  type: "FRAME",
  as: "$section",
  name: "Settings section",
  size: { width: 360, height: 160 },
  layout: { layoutMode: "VERTICAL", itemSpacing: 12 },
  appearance: { fills: "#FFFFFF", cornerRadius: 12 },
});
await $.text({
  parent: "$section",
  as: "$sectionTitle",
  text: "Settings",
  font: { family: "Inter", style: "Bold", size: 20 },
});
return await $.checkpoint("section-created", ["$section"], { depth: 1 });
```

Common helpers include `$.find`, `$.findAll`, `$.create`, `$.text`, `$.layout`, `$.select`, `$.checkpoint`, `$.remember`, `$.forget`, `$.inspect`, `$.imageAsset`, `$.screenshot`, and `$.cloneNodeTree`. Script files and eval wrapper calls are parsed with AST analysis, and the runner injects only referenced `$` helpers plus required dependencies. Use static references such as `$.text(...)`, `$["text"](...)`, or `const { text } = $`; dynamic `$[name]`, `$` aliasing, object rest destructuring, and local `$` declarations are rejected. Read `figma-workspace://guide` for compact helper categories and hard rules, then call `figma_workspace_guidance({ query })` for on-demand `helperProfiles` with allowed patterns, avoid notes, lookup hints, and examples.

## Assets, Capture, and Plans

- `figma_workspace_apply_asset_manifest`: recommended call is `{ sessionId, manifestPath }`; inline assets are advanced/debug fields.
- `figma_workspace_capture_node`: recommended call is `{ sessionId, target, imageFile }`; `imageFile` is the PNG path and no `outputFiles` are returned.
- `figma_workspace_run_task_plan`: recommended call is `{ sessionId, planPath }`; inline `steps` are advanced fields and each step must be `{ type, args }`.

Keep `.figma.js` transactions small enough for upstream `use_figma` payload limits. Split dense work into skeleton, asset targets, upload fills, and visual fixes when payload diagnostics appear.

## Guidance and Lookup

The workspace facade keeps MCP resources limited to runtime state and dynamic discovery:

- routing manifest: `figma-workspace://capabilities`;
- workflow guide: `figma-workspace://guide`;
- lookup index: `figma-workspace://lookup-index`;
- workflow tools: `figma_workspace_prepare_task`, `figma_workspace_guidance`, `figma_workspace_get_metadata`, `figma_workspace_get_design_context`, `figma_workspace_get_motion_context`, `figma_workspace_export_video`, `figma_workspace_search_design_system`, `figma_workspace_get_libraries`, and `figma_workspace_get_variable_defs`;
- execution: `figma_workspace_open`, `figma_workspace_eval`, `figma_workspace_run_script_file`, `figma_workspace_run_task_plan`;
- assets and QA: `figma_workspace_apply_asset_manifest`, `figma_workspace_capture_node`;
- state resources: `figma-workspace://sessions` for compact session list, `figma-workspace://sessions/{id}` for compact detail with handles and minimal workspace context, and `figma-workspace://sessions/{id}/handles` for handle-only reads;
- upstream discovery/resource bridge: `figma-workspace://upstream-tools`, `figma_workspace_call_upstream_tool`;
- references: `figma_workspace_lookup` with `kind: "docs"` or `kind: "api"`, plus lightweight `figma-workspace-router` skill reference files for static workflow, lookup, and safety notes.

Use `figma_workspace_guidance` first for common intents, `mode: "plan"` workflow planning, curated compact API cards, and wrapper profile suggestions. Use `figma_workspace_get_metadata` for broad layer-tree discovery before targeted `figma_workspace_inspect` style/fill/text checks. Use `figma_workspace_get_design_context` for official implementation context, `figma_workspace_get_motion_context` for animation data, `figma_workspace_export_video` for start/poll video renders, and `figma_workspace_search_design_system`, `figma_workspace_get_libraries`, and `figma_workspace_get_variable_defs` when official design-system context is needed. `figma-workspace://lookup-index` exposes compact wrapper profiles and workflow graph nodes for design implementation context and motion implementation. Use `figma_workspace_lookup({ kind: "docs" })` for BM25-ranked workflow snippets plus compact bridge-owned explanations for `guidanceRef`, wrapper profiles, helper profiles, and workflow graph routing; use `figma_workspace_lookup({ kind: "api" })` for exact Plugin API symbols. Use `figma_workspace_call_upstream_tool` for an explicit uncovered upstream capability, including official shader effect/fill reads, after reading `figma-workspace://upstream-tools`. Lookup output is capped and confidence-labeled; bundled JSONL corpus files are internal and are not an agent-facing documentation path.

Implementation, motion, design parity review, and Code Connect work have curated guidance cards. They use first-class context wrappers where available, keep uncovered Code Connect suggestions behind `figma_workspace_call_upstream_tool`, capture local visual evidence through `figma_workspace_capture_node`, and require produced code/templates to follow the current project rather than copied upstream agent prompts.

## Diagnostics

Diagnostics use `{ code, severity, message, suggestion, docsHint }`. Script-file diagnostics may include `{ source: { scriptPath, line, column } }`. Fatal diagnostics block upstream execution; warnings return with the result.

`allowDangerousOperations` bypasses destructive/dynamic-code guards only. It does not bypass Plugin API contract, read-mode, or Design/FigJam/Slides surface guards.

## Validation

```bash
npm run typecheck
npm test
```
