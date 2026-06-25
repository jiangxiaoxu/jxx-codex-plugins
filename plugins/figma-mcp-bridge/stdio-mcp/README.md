# Figma MCP Stdio Frontend

Node package for two Figma MCP frontends:

- `figma_repl_mcp`: agent-friendly facade for local `.figma.js` workflows, output files, compact lookup, asset manifests, capture, and task plans;
- `figma-stdio`: optional transparent bridge to `https://mcp.figma.com/mcp` for CLI, parity checks, and Node/node_repl debugging.

Both reuse the OAuth cache created by `figma-mcp-bridge`.

## Install

```bash
npm install
npm run build
```

Cache path priority:

```text
FIGMA_MCP_OAUTH_CACHE_PATH
CODEX_HOME/.figma-mcp-bridge-oauth.json
USERPROFILE/.codex/.figma-mcp-bridge-oauth.json
```

The shared cache must already contain valid OAuth state. Use the bridge login helper before starting stdio tools.

If upgrading from the old persistent server id `figma-repl-mcp`, reload or reinstall the plugin, or restart the MCP server, before schema checks. Otherwise the old cached server id can still expose stale tool schemas.

## Package API

```ts
import {
  createFigmaStdioMcpServer,
  createRemoteMcpClient,
} from "@jxx-codex-plugins/figma-mcp-stdio";
import {
  createFigmaReplClient,
  diagnoseFigmaReplCode,
} from "@jxx-codex-plugins/figma-mcp-stdio/repl";
```

Node REPL usage with an explicit custom upstream client:

```js
const { createFigmaReplClient } = await import("./dist/node-repl.js");

const figma = createFigmaReplClient({
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

Without an explicit `client`, `./node-repl` creates a local-only REPL client: session setup, workspace preparation, diagnostics, and `connect: false` opens work, but live upstream calls fail with a message directing callers to use `figma_repl_mcp` or inject a custom client. Use the hosted `figma_repl_mcp` stdio MCP server for normal live Figma work.

In Codex `node_repl`, the recommended live-Figma verification path is an explicit stdio MCP client pointed at this package's `dist/repl-stdio-cli.js`, then calling `figma_repl_open`, `figma_repl_get_metadata`, `figma_repl_run_script_file`, and related tools through that child process. This exercises the same public MCP contract while avoiding the embedded no-client SDK remote transport. Use fake/custom clients for response-shape unit smoke tests.

The `./node-repl` entrypoint still installs Web Streams globals before loading SDK-backed modules, so explicit `createRemoteMcpClient()` use does not require callers to predefine `ReadableStream`, `TransformStream`, or `WritableStream`.

For explicit raw upstream access from Node, use the same entrypoint and call `createRemoteMcpClient` directly:

```js
const { createRemoteMcpClient } = await import("./dist/node-repl.js");

const upstream = createRemoteMcpClient({
  statePath: "C:/Users/you/.codex/.figma-mcp-bridge-oauth.json",
});
await upstream.connect();
const tools = await upstream.listTools();
await upstream.close();
```

`statePath` must be absolute. CLI/MCP usage can select the same file with `FIGMA_MCP_OAUTH_CACHE_PATH`.

## REPL Response Shape

Every local `figma_repl_*` tool returns a fixed structured shape. `session` uses public metadata without `history`, `diagnostics` is always an array, and JSON debug/result file pointers are under `outputFiles.debugFile` as `{ path, bytes, lineCount }`. Upstream-backed single-call tools return effective upstream success as `upstream.ok`, public upstream JSON as `upstream.result`, and non-JSON upstream output as `upstream.text`; eval/script payloads containing bridge-internal `__figmaRepl` metadata are unwrapped to their business result, while raw official JSON without top-level `ok` remains unchanged as `upstream.result`. `figma_repl_get_metadata` is the metadata-first wrapper for official `get_metadata`: upstream XML is converted to compact JSON, small `metadata.json` trees are returned inline, and oversized trees are written to `outputFiles.metadataFile`. Asset manifests keep compact inline asset entries and write full per-asset upstream details only to generated debug files.

`figma_repl_apply_asset_manifest` validates target IMAGE fills after upload when upstream eval is available. Successful submitUrl POSTs expose compact `assets[].upload` evidence such as `imageHash` and `placedOnNodeId` without returning raw submit URLs. If validation runs but cannot confirm every target record, the tool returns `ok:false` with `validation.reason` and writes `outputFiles.debugFile`; `validateTargets:false` remains the explicit skip.

Status fields are separate. Top-level `ok` reports local wrapper/tool completion. `upstream.ok` reports effective upstream success: false for upstream call failures and false when the shaped business result has top-level `ok:false`; `upstream.result` removes that consumed `ok` and adds `source: "business"` when JSON supplied `ok:false`, or `source: "call"` for call failures without a consumed result status.

Executed `figma_repl_run_script_file` result files use the same `upstream` envelope and do not duplicate upstream JSON into `raw`.

## REPL File Workflow

`figma_repl_run_script_file` is the primary path for non-trivial Plugin API work. Prefer preparing one workspace per Figma file, then use file names instead of absolute paths:

```js
await figma.prepareTask({
  sessionId: "settings workspace",
  file: "https://www.figma.com/design/ExampleFigmaFileKey012/UI",
  task: "settings panel polish",
  overwrite: true,
});
await figma.runScriptFile({
  sessionId: "settings workspace",
  inputFile: "settings-panel-polish.figma.js",
  dryRun: true,
  strict: true,
});
await figma.runScriptFile({
  sessionId: "settings workspace",
  inputFile: "settings-panel-polish.figma.js",
});
```

`figma_repl_prepare_task` creates `<cwd>/figma-mcp/<fileKey-or-fileSlug>/` when `file` is supplied. `cwd` is optional and defaults to the MCP server process cwd. A task normally uses `task` and `<taskSlug>.figma.js` in that folder, then calls `runScriptFile` with `inputFile`. JSON debug/result files are generated on demand and returned through `outputFiles.debugFile`; script upstream sidecars use `outputFiles.upstreamFile`, and failure-only compiled wrappers use `outputFiles.compiledScriptFile`. Absolute `scriptPath`, upstream overrides, and `run_script_file` `inlineResultLimit` remain advanced/debug escape hatches.

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

Common helpers include `$.find`, `$.findAll`, `$.create`, `$.text`, `$.layout`, `$.select`, `$.checkpoint`, `$.remember`, `$.forget`, `$.inspect`, `$.imageAsset`, `$.screenshot`, and `$.cloneNodeTree`. Script files and eval wrapper calls are parsed with AST analysis, and the runner injects only referenced `$` helpers plus required dependencies. Read `figma-repl://capabilities` for helper syntax rules.

## Assets, Capture, and Plans

- `figma_repl_apply_asset_manifest`: recommended call is `{ title, sessionId, manifestPath }`; inline assets are advanced/debug fields.
- `figma_repl_capture_node`: recommended call is `{ title, sessionId, target, imageFile }`; `imageFile` is the PNG path and no `outputFiles` are returned.
- `figma_repl_run_task_plan`: recommended call is `{ title, sessionId, planPath }`; inline `steps` are advanced fields and each step must be `{ type, args }`.

Keep `.figma.js` transactions small enough for upstream `use_figma` payload limits. Split dense work into skeleton, asset targets, upload fills, and visual fixes when payload diagnostics appear.

## Guidance and Lookup

The REPL facade exposes compact self-explaining resources and tools:

- workflow resources: `figma-repl://capabilities`, `figma-repl://guide`, `figma-repl://file-workflow`, `figma-repl://workflow-tools`;
- workflow tools: `figma_repl_prepare_task`, `figma_repl_guidance`, `figma_repl_get_metadata`;
- execution: `figma_repl_open`, `figma_repl_eval`, `figma_repl_run_script_file`, `figma_repl_run_task_plan`;
- assets and QA: `figma_repl_apply_asset_manifest`, `figma_repl_capture_node`;
- state resources: `figma-repl://sessions`, `figma-repl://sessions/{id}`;
- upstream discovery/resource bridge: `figma-repl://upstream-tools`, `figma_repl_call_upstream_tool`;
- references: `figma_repl_lookup` with `kind: "docs"` or `kind: "api"`.

Use `figma_repl_guidance` first for common intents, `mode: "plan"` workflow planning, and curated compact API cards. Use `figma_repl_get_metadata` for broad layer-tree discovery before targeted `figma_repl_inspect` style/fill/text checks. Use `figma_repl_lookup({ kind: "docs" })` for BM25-ranked workflow snippets and `figma_repl_lookup({ kind: "api" })` for exact Plugin API symbols. Use `figma_repl_call_upstream_tool` only for an explicit uncovered upstream capability. Lookup output is capped and confidence-labeled; bundled corpus files are internal and are not an agent-facing documentation path.

## Diagnostics

Diagnostics use `{ code, severity, message, suggestion, docsHint }`. Script-file diagnostics may include `{ source: { scriptPath, line, column } }`. Fatal diagnostics block upstream execution; warnings return with the result.

`allowDangerousOperations` bypasses destructive/dynamic-code guards only. It does not bypass Plugin API contract, read-mode, or Design/FigJam/Slides surface guards.

## Validation

```bash
npm run typecheck
npm test
```
