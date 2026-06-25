# Figma MCP Bridge

Local bridge and plugin bundle for using the official Figma MCP server from Codex.

The plugin provides:

- an HTTP OAuth bridge for initial login and standalone debugging;
- `figma_repl_mcp`, the preferred agent-facing facade for file-based Figma Plugin API work;
- optional Node/CLI plumbing for a transparent upstream bridge when debugging official MCP behavior.

## OAuth Cache

The bridge caches OAuth client registration and token responses so later stdio or REPL frontends can connect without repeating browser OAuth.

Cache path priority:

```text
FIGMA_MCP_OAUTH_CACHE_PATH
CODEX_HOME/.figma-mcp-bridge-oauth.json
USERPROFILE/.codex/.figma-mcp-bridge-oauth.json
```

To print the resolved path for scripts or debugging:

```powershell
npm run oauth-cache:path
python scripts/resolve-oauth-cache-path.py --json
```

The cache may contain `client_id`, `client_secret`, `access_token`, and `refresh_token`. Treat it as a sensitive local login file. It is ignored by git.

## Login

Run the transient login helper from this plugin root:

```powershell
npm run login:figma-http
```

The helper adds a temporary `figma-http` Codex MCP entry, runs browser OAuth through `http://127.0.0.1:18766/mcp`, then removes that temporary entry. Do not install `figma-http` as a persistent MCP server; the persistent plugin server is `figma_repl_mcp`.

## Bundled MCP Servers

The plugin's `.mcp.json` installs:

```json
{
  "mcpServers": {
    "figma_repl_mcp": {
      "command": "node",
      "cwd": ".",
      "args": ["./stdio-mcp/dist/repl-stdio-cli.js"]
    }
  }
}
```

`figma_repl_mcp` is the primary agent workflow after OAuth registration. It supports local `.figma.js` script execution, workspace file pairs, output files, compact docs/API lookup, generated-asset manifests, metadata XML-to-JSON conversion, design-system discovery wrappers, screenshot/capture output, task plans, process-local handles, and explicit delegated upstream official tools for uncovered capabilities.

Upgrade note: the persistent MCP server id changed from `figma-repl-mcp` to `figma_repl_mcp`. Reload or reinstall the plugin, or restart the MCP server, so old cached `figma-repl-mcp` tool schemas are not exposed.

Local `figma_repl_*` tools return a fixed structured shape. Top-level `ok` reports local wrapper/tool completion; upstream-backed single-call tools store effective upstream success in `upstream.ok`, parsed JSON in `upstream.result`, and non-JSON output in `upstream.text`. Top-level upstream/business `ok` fields are consumed into `upstream.ok` and removed from `upstream.result`; false results include `upstream.result.source` as `business` when a JSON result supplied `ok:false`, or `call` for call failures without a consumed result status. `figma_repl_get_metadata` calls official `get_metadata`, converts it to a compact JSON node tree, returns small `metadata.json` results inline, and writes oversized trees to `outputFiles.metadataFile`. `figma_repl_search_design_system`, `figma_repl_get_libraries`, and `figma_repl_get_variable_defs` are thin wrappers over official upstream tools and preserve the same generic `upstream` envelope. Asset manifests keep compact inline asset entries and write failure details only to generated debug files. Diagnostics are arrays, ordinary tool session summaries contain only `id`, `fileKey`, `surface`, optional `sessionDir`, and `handleChanges`; `figma-repl://sessions` resources provide compact file/workspace context, `{id}` includes handles, and `{id}/handles` remains the narrow handle-only resource. JSON debug/result files point to `outputFiles.debugFile` entries shaped as `{ path, bytes, lineCount }`.

`figma-stdio` is not installed as a persistent plugin server by default. Keep using `figma_repl_mcp` for agent work; use `figma-stdio` only through the package CLI or Node API for parity checks and raw official MCP debugging.

## Agent Workflow

Agents should use `figma_repl_mcp` first:

1. read `figma-repl://capabilities`
2. `figma_repl_prepare_task({ file, taskName, surface })`
3. edit local `.figma.js`
4. `figma_repl_run_script_file({ sessionId, inputFile, dryRun: true, strict: true, surface })`
5. `figma_repl_run_script_file({ sessionId, inputFile })`
6. `figma_repl_search_design_system`, `figma_repl_get_libraries`, or `figma_repl_get_variable_defs` when official design-system context is needed
7. `figma_repl_apply_asset_manifest({ sessionId, manifestPath })`, `figma_repl_capture_node({ sessionId, target, imageFile })`, or `figma_repl_run_task_plan({ sessionId, planPath })` when needed

In workspace workflows, prefer `taskName`, `inputFile`, `manifestPath`, `target`, `imageFile`, and `planPath`. `taskName` is a slug-style workspace/task name such as `settings-panel-polish`. `title` is optional display-only MCP call metadata for Codex/UI; the runtime validates it as a string when supplied but does not store it, default it, pass it upstream, or use it for task/file naming. Inline assets/steps, custom upstream templates, `scriptPath`, upstream overrides, and `refresh` are advanced/debug escape hatches; JSON debug files are generated on demand and reported at `outputFiles.debugFile`. `inlineResultLimit` applies only to payload-size control. `figma-repl://capabilities.toolArgumentGuidance` is the canonical argument guide.

Asset manifests validate target IMAGE fills after upload when upstream eval is available. Successful submitUrl POSTs expose compact `assets[].upload` evidence such as `imageHash` and `placedOnNodeId` without returning raw submit URLs. If default validation cannot confirm every target record, `figma_repl_apply_asset_manifest` fails the workflow and writes details to `outputFiles.debugFile`; use `validateTargets: false` only when validation is intentionally skipped.

For API guidance, use `figma_repl_guidance` and `figma_repl_lookup` with `kind: "docs"` or `kind: "api"`. Bundled reference files are internal lookup corpus and are not an agent-facing documentation path.

The MCP resource surface is intentionally small: `figma-repl://capabilities`, `figma-repl://sessions`, session detail resources, session handle-map resources, `figma-repl://upstream-tools`, and upstream tool detail resources. Static workflow, guidance, and safety notes live in the `figma-router` skill references; common task routing should use `figma_repl_guidance` and exact snippets should use `figma_repl_lookup`.

Programmatic Node usage with an explicit OAuth cache is for local package scripts and debugging. Use `figma_repl_mcp` for normal live Figma agent work:

```js
const { createFigmaReplClient } = await import("./stdio-mcp/dist/repl-server.js");

const figma = createFigmaReplClient({
  oauthCachePath: "C:/Users/you/.codex/.figma-mcp-bridge-oauth.json",
});
await figma.open({
  file: "https://www.figma.com/design/<fileKey>/<fileName>?node-id=<nodeId>",
});
await figma.runScriptFile({
  sessionId: "ui-work",
  inputFile: "edit-panel.figma.js",
  dryRun: true,
  strict: true,
  surface: "design",
});
const run = await figma.runScriptFile({
  sessionId: "ui-work",
  inputFile: "edit-panel.figma.js",
});
const payload = run.upstream?.result;
const capture = await figma.captureNode({
  sessionId: "ui-work",
  target: "$target",
  imageFile: "qa.png",
});
if (!run.ok) console.log(run.outputFiles?.debugFile?.path);
await figma.close();
```

`oauthCachePath` must be an absolute path to the existing bridge OAuth cache JSON file.

For direct upstream debugging from Node, use `createRemoteMcpClient` explicitly. The `./node-repl` `createFigmaReplClient()` default is local-only unless a custom upstream `client` is supplied:

```js
const { createRemoteMcpClient } = await import("./stdio-mcp/dist/node-repl.js");

const upstream = createRemoteMcpClient({
  statePath: "C:/Users/you/.codex/.figma-mcp-bridge-oauth.json",
});
await upstream.connect();
const tools = await upstream.listTools();
await upstream.close();
```

When testing through Codex `node_repl`, do not rely on the embedded no-client SDK remote path for live Figma connectivity. Use hosted `figma_repl_mcp` for normal design work, or inject a custom upstream client. For an end-to-end Node-level smoke test, launch `stdio-mcp/dist/repl-stdio-cli.js` as a child stdio MCP process from Node and call the exposed `figma_repl_*` tools through that explicit client; reserve `createRemoteMcpClient()` for raw SDK transport debugging.

## Local Development

```bash
npm start
cd stdio-mcp
npm install
npm run build
npm test
```

The HTTP bridge defaults to:

```text
listen:  http://127.0.0.1:18766/mcp
target:  https://mcp.figma.com/mcp
```

Useful environment variables:

```text
FIGMA_MCP_BRIDGE_HOST=127.0.0.1
FIGMA_MCP_BRIDGE_PORT=18766
FIGMA_MCP_BRIDGE_PATH=/mcp
FIGMA_MCP_BRIDGE_TARGET=https://mcp.figma.com/mcp
FIGMA_MCP_BRIDGE_LOG=1
FIGMA_MCP_BRIDGE_OAUTH_CACHE=0
FIGMA_MCP_OAUTH_CACHE_PATH=C:/Users/jxx73/.codex/.figma-mcp-bridge-oauth.json
CODEX_HOME=C:/Users/jxx73/.codex
```
