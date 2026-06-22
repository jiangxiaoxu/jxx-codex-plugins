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

`figma_repl_mcp` is the primary agent workflow after OAuth registration. It supports local `.figma.js` script execution, workspace file pairs, output files, compact docs/API lookup, generated-asset manifests, screenshot/capture output, task plans, process-local handles, and explicit delegated upstream official tools for uncovered capabilities.

Upgrade note: the persistent MCP server id changed from `figma-repl-mcp` to `figma_repl_mcp`. Reload or reinstall the plugin, or restart the MCP server, so old cached `figma-repl-mcp` tool schemas are not exposed.

Local `figma_repl_*` tools return a fixed structured shape. Upstream-backed single-call tools store parsed JSON in `upstream.payload` and non-JSON output in `upstream.text`; asset manifests keep compact inline asset entries and write full per-asset upstream details only to explicit result files. Diagnostics are arrays, session payloads omit history, and large data points to `outputFiles` entries shaped as `{ path, bytes, lineCount }`.

`figma-stdio` is not installed as a persistent plugin server by default. Keep using `figma_repl_mcp` for agent work; use `figma-stdio` only through the package CLI or Node API for parity checks and raw official MCP debugging.

## Agent Workflow

Agents should use `figma_repl_mcp` first:

1. read `figma-repl://capabilities`
2. `figma_repl_prepare_task({ title, cwd, fileUrl|fileKey, intent, expectedSurface })`
3. edit local `.figma.js`
4. `figma_repl_run_script_file({ title, sessionId, inputFile, dryRun: true, strict: true, expectedSurface })`
5. `figma_repl_run_script_file({ title, sessionId, inputFile, outputFile })`
6. `figma_repl_apply_asset_manifest({ title, sessionId, manifestPath, outputFile })`, `figma_repl_capture_node({ title, sessionId, nodeId, outputFile })`, or `figma_repl_run_task_plan({ title, sessionId, planPath, outputFile })` when needed

In workspace workflows, prefer `intent`, `inputFile`, `outputFile`, `manifestPath`, `nodeId`, and `planPath`. Alias fields, inline assets/steps, custom upstream templates, `resultFile`, `scriptPath`, split output files, upstream overrides, and `refresh` are advanced/debug/compat escape hatches; `inlineResultLimit` applies only to `figma_repl_run_script_file` payload-size control. `figma-repl://capabilities.toolArgumentGuidance` is the canonical argument guide.

For API guidance, use `figma_repl_guidance` and `figma_repl_lookup` with `kind: "docs"` or `kind: "api"`. Bundled reference files are internal lookup corpus and are not an agent-facing documentation path.

Programmatic Node usage with an explicit OAuth cache:

```js
const { createFigmaReplClient } = await import("./stdio-mcp/dist/repl-server.js");

const figma = createFigmaReplClient({
  oauthCachePath: "C:/Users/you/.codex/.figma-mcp-bridge-oauth.json",
});
await figma.open({
  fileUrl: "https://www.figma.com/design/<fileKey>/<fileName>?node-id=<nodeId>",
});
await figma.runScriptFile({
  sessionId: "ui-work",
  inputFile: "edit-panel.figma.js",
  dryRun: true,
  strict: true,
  expectedSurface: "design",
});
await figma.close();
```

`oauthCachePath` must be an absolute path to the existing bridge OAuth cache JSON file.

For direct upstream debugging from Node or `node_repl`, use `createRemoteMcpClient`:

```js
const { createRemoteMcpClient } = await import("./stdio-mcp/dist/node-repl.js");

const upstream = createRemoteMcpClient({
  oauthCachePath: "C:/Users/you/.codex/.figma-mcp-bridge-oauth.json",
});
await upstream.connect();
const tools = await upstream.listTools();
await upstream.close();
```

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
