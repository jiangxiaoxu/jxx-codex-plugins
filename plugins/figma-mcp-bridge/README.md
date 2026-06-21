# Figma MCP Bridge

Local bridge and plugin bundle for using the official Figma MCP server from Codex.

The plugin provides:

- an HTTP OAuth bridge for initial login and standalone debugging;
- `figma-repl-mcp`, the preferred agent-facing facade for file-based Figma Plugin API work;
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

The helper adds a temporary `figma-http` Codex MCP entry, runs browser OAuth through `http://127.0.0.1:18766/mcp`, then removes that temporary entry. Do not install `figma-http` as a persistent MCP server; the persistent plugin server is `figma-repl-mcp`.

## Bundled MCP Servers

The plugin's `.mcp.json` installs:

```json
{
  "mcpServers": {
    "figma-repl-mcp": {
      "command": "node",
      "cwd": ".",
      "args": ["./stdio-mcp/dist/repl-stdio-cli.js"]
    }
  }
}
```

`figma-repl-mcp` is the primary agent workflow after OAuth registration. It supports local `.figma.js` script execution, workspace file pairs, output files, compact docs/API lookup, generated-asset manifests, screenshot/capture output, task plans, process-local handles, and explicit delegated upstream official tools for uncovered capabilities.

`figma-stdio` is not installed as a persistent plugin server by default. Keep using `figma-repl-mcp` for agent work; use `figma-stdio` only through the package CLI or Node API for parity checks and raw official MCP debugging.

## Agent Workflow

Agents should use `figma-repl-mcp` first:

1. `figma_repl_capabilities`
2. `figma_repl_init_workspace`
3. `figma_repl_prepare_task`
4. edit local `.figma.js`
5. `figma_repl_run_script_file({ dryRun: true, strict: true })`
6. `figma_repl_run_script_file`
7. `figma_repl_apply_asset_manifest`, `figma_repl_capture_node`, or `figma_repl_run_task_plan` when needed

For API guidance, use `figma_repl_guidance`, `figma_repl_docs_search`, and `figma_repl_api_lookup`. Bundled reference files are internal lookup corpus and are not an agent-facing documentation path.

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
