# Figma MCP Stdio Frontend

Node package for two Figma MCP frontends:

- `figma-repl-mcp`: agent-friendly facade for local `.figma.js` workflows, output files, compact lookup, asset manifests, capture, and task plans;
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

Node REPL usage with an explicit OAuth cache:

```js
const { createFigmaReplClient } = await import("./dist/repl-server.js");

const figma = createFigmaReplClient({
  oauthCachePath: "C:/Users/you/.codex/.figma-mcp-bridge-oauth.json",
});
await figma.open({
  fileUrl: "https://www.figma.com/design/<fileKey>/<fileName>?node-id=<nodeId>",
  expectedSurface: "design",
});
await figma.close();
```

`oauthCachePath` must be absolute. CLI/MCP usage can select the same file with `FIGMA_MCP_OAUTH_CACHE_PATH`.

For direct raw upstream access from Node or `node_repl`, prefer `createRemoteMcpClient` instead of installing `figma-stdio` as a persistent MCP server:

```js
const { createRemoteMcpClient } = await import("./dist/node-repl.js");

const upstream = createRemoteMcpClient({
  oauthCachePath: "C:/Users/you/.codex/.figma-mcp-bridge-oauth.json",
});
await upstream.connect();
const tools = await upstream.listTools();
await upstream.close();
```

## REPL File Workflow

`figma_repl_run_script_file` is the primary path for non-trivial Plugin API work. Prefer initializing one workspace per Figma file, then use file names instead of absolute paths:

```js
await figma.initWorkspace({
  sessionId: "settings workspace",
  fileUrl: "https://www.figma.com/design/ExampleFigmaFileKey012/UI",
  intent: "settings panel polish",
  cwd: "G:/Project/my-app",
});
await figma.prepareTask({
  sessionId: "settings workspace",
  intent: "settings panel polish",
  goal: "Update the settings panel",
  overwrite: true,
});
await figma.runScriptFile({
  sessionId: "settings workspace",
  inputFile: "settings-panel-polish.figma.js",
  outputFile: "settings-panel-polish.result.json",
  dryRun: true,
  strict: true,
});
```

`figma_repl_init_workspace` creates `<cwd>/figma-mcp/<fileKey-or-fileSlug>/`. A task normally uses `<intentSlug>.figma.js` and `<intentSlug>.result.json` in that folder. Absolute `scriptPath`, `outputDir`, and `resultFile` remain escape hatches.

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

Common helpers include `$.find`, `$.findAll`, `$.create`, `$.text`, `$.layout`, `$.select`, `$.checkpoint`, `$.remember`, `$.forget`, `$.inspect`, `$.imageAsset`, `$.screenshot`, and `$.cloneNodeTree`. `helperProfile` defaults to `auto`; use `helperProfile: "full"` only for debugging compatibility.

## Assets, Capture, and Plans

- `figma_repl_apply_asset_manifest`: apply generated image assets to target nodes. In an initialized workspace, `manifestPath`, asset paths, `resultFile`, and `outputFile` can be simple file names. The tool validates image fills when upstream eval is available.
- `figma_repl_capture_node`: call a screenshot/capture upstream tool, write image bytes or downloaded URL payloads to a local file, and return compact QA metadata.
- `figma_repl_run_task_plan`: run sequential `script-file`, `asset-manifest`, `screenshot-capture`, and `upstream-tool` steps. Missing workspace step outputs default to `<step-id>.result.json`, `<step-id>.assets.result.json`, `<step-id>.png`, and `<step-id>.capture.result.json`.

Keep `.figma.js` transactions small enough for upstream `use_figma` payload limits. Split dense work into skeleton, asset targets, upload fills, and visual fixes when payload diagnostics appear.

## Guidance and Lookup

The REPL facade exposes compact self-explaining resources and tools:

- workflow: `figma_repl_capabilities`, `figma_repl_plan_task`, `figma_repl_guidance`;
- execution: `figma_repl_open`, `figma_repl_init_workspace`, `figma_repl_prepare_task`, `figma_repl_run_script_file`, `figma_repl_run_task_plan`;
- assets and QA: `figma_repl_apply_asset_manifest`, `figma_repl_capture_node`;
- state: `figma_repl_inspect`, `figma_repl_cache_get`, `figma_repl_validate_handles`;
- upstream bridge: `figma_repl_list_upstream_tools`, `figma_repl_call_upstream_tool`;
- references: `figma_repl_docs_search`, `figma_repl_api_lookup`.

Use `figma_repl_guidance` first for common intents and curated compact API cards. Use `figma_repl_docs_search` for BM25-ranked workflow snippets and `figma_repl_api_lookup` for exact Plugin API symbols. Use `figma_repl_call_upstream_tool` only for an explicit uncovered upstream capability. Lookup output is capped and confidence-labeled; bundled corpus files are internal and are not an agent-facing documentation path.

## Diagnostics

Diagnostics use `{ code, severity, message, suggestion, docsHint }`. Script-file diagnostics may include `{ source: { scriptPath, line, column } }`. Fatal diagnostics block upstream execution; warnings return with the result.

`allowDangerousOperations` bypasses destructive/dynamic-code guards only. It does not bypass Plugin API contract, read-mode, or Design/FigJam/Slides surface guards.

## Validation

```bash
npm run typecheck
npm test
```
