# Figma MCP Bridge

Transparent Node.js HTTP bridge for the official Figma remote MCP server.

```text
Codex HTTP MCP client
  -> http://127.0.0.1:18766/mcp
  -> https://mcp.figma.com/mcp
```

The bridge forwards OAuth challenges, authorization headers, MCP session headers, request bodies, and streaming responses so Codex can remain the primary OAuth owner.

By default the bridge also caches OAuth client registration data and token responses observed through the proxied OAuth endpoints. That lets later HTTP or stdio frontends call this local bridge without repeating browser OAuth, as long as the cached refresh token remains valid.

For OAuth discovery, the bridge serves:

```text
http://127.0.0.1:18766/.well-known/oauth-protected-resource
http://127.0.0.1:18766/.well-known/oauth-authorization-server
http://127.0.0.1:18766/oauth/authorize
http://127.0.0.1:18766/oauth/token
http://127.0.0.1:18766/oauth/register
```

It proxies Figma's OAuth metadata and rewrites the MCP `resource`, authorization server, authorization endpoint, token endpoint, and dynamic registration endpoint to the local bridge origin. The bridge then forwards those OAuth requests to Figma. This lets Codex see a complete OAuth-capable local MCP endpoint while Figma still performs the real authorization.

## Start

```bash
cd plugins/figma-mcp-bridge
npm start
```

Defaults:

```text
listen:  http://127.0.0.1:18766/mcp
target:  https://mcp.figma.com/mcp
```

Environment overrides:

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

OAuth cache defaults:

```text
enabled: yes
path:    FIGMA_MCP_OAUTH_CACHE_PATH when set,
         otherwise CODEX_HOME/.figma-mcp-bridge-oauth.json when CODEX_HOME is set,
         otherwise USERPROFILE/.codex/.figma-mcp-bridge-oauth.json
```

`FIGMA_MCP_OAUTH_CACHE_PATH`, `CODEX_HOME`, and `USERPROFILE` are environment variables. In PowerShell, set explicit values with `$env:FIGMA_MCP_OAUTH_CACHE_PATH` or `$env:CODEX_HOME`.

The cache can contain `client_id`, `client_secret`, `access_token`, and `refresh_token`. Treat it as a sensitive local login file. It is ignored by git.

## OAuth Login Helper

The plugin includes a PowerShell helper that opens an independent PowerShell window and runs the transient Codex MCP login flow:

```powershell
cd plugins/figma-mcp-bridge
npm run login:figma-http
```

The helper runs:

```powershell
codex mcp add figma-http --url http://127.0.0.1:18766/mcp
codex mcp login figma-http
codex mcp remove figma-http
```

The first `remove` is also attempted before `add` so a stale temporary entry does not block the flow. The script is intentionally parameter-free and always removes the temporary Codex MCP entry after login.

## Bundled MCP Servers

The plugin bundles two MCP server entries in `.mcp.json`:

```json
{
  "mcpServers": {
    "figma-stdio": {
      "command": "node",
      "cwd": ".",
      "args": ["./stdio-mcp/dist/stdio-cli.js"]
    },
    "figma-repl-mcp": {
      "command": "node",
      "cwd": ".",
      "args": ["./stdio-mcp/dist/repl-stdio-cli.js"]
    }
  }
}
```

- `figma-stdio`: starts the bundled stdio frontend from the plugin root and connects directly to `https://mcp.figma.com/mcp` using the shared OAuth cache. The `cwd` value is intentionally relative; Codex resolves plugin MCP `cwd` values beneath the installed plugin directory, so the CLI path in `args` stays relative to the bundle.
- `figma-repl-mcp`: starts the future single Figma-facing MCP facade for agents after OAuth registration. It runs file-based JavaScript scripts through upstream `use_figma`, stores local node-id handles in the running MCP process, can call other official upstream Figma MCP tools, and exposes compact docs/API lookup so agents rarely need to read the large bundled reference tree directly.

The HTTP bridge remains available for Figma MCP login and standalone debugging, but it is not installed as a persistent plugin MCP server.

## Stdio MCP Frontend

This plugin also includes a stdio MCP frontend under `stdio-mcp/`. It reuses the bridge OAuth cache and connects directly to the official Figma MCP endpoint without keeping the local HTTP bridge process running.

```bash
cd plugins/figma-mcp-bridge/stdio-mcp
npm install
npm run build
```

The stdio server defaults to the shared bridge cache:

```text
FIGMA_MCP_OAUTH_CACHE_PATH when set,
otherwise CODEX_HOME/.figma-mcp-bridge-oauth.json when CODEX_HOME is set,
otherwise USERPROFILE/.codex/.figma-mcp-bridge-oauth.json
```

## Figma REPL MCP Frontend

`figma-repl-mcp` is intended as the primary Figma-facing MCP entrypoint for agents after OAuth registration. It supports file-based Figma Plugin API scripts, compact local reference lookup, and delegated official upstream tool calls. It exposes:

- `figma_repl_capabilities`
- `figma_repl_open`
- `figma_repl_eval`
- `figma_repl_run_script_file`
- `figma_repl_apply_asset_manifest`
- `figma_repl_capture_node`
- `figma_repl_run_task_plan`
- `figma_repl_init_workspace`
- `figma_repl_prepare_task`
- `figma_repl_plan_task`
- `figma_repl_api_card`
- `figma_repl_suggest_api`
- `figma_repl_inspect`
- `figma_repl_cache_get`
- `figma_repl_validate_handles`
- `figma_repl_list_upstream_tools`
- `figma_repl_call_upstream_tool`
- `figma_repl_docs_search`
- `figma_repl_api_lookup`

It also exposes self-explaining resources: `figma-repl://guide`, `figma-repl://patterns`, `figma-repl://scripts`, `figma-repl://file-workflow`, `figma-repl://workflow-tools`, `figma-repl://api-cards`, `figma-repl://intents`, `figma-repl://safety`, `figma-repl://docs`, `figma-repl://api`, and `figma-repl://sessions`.

Raw eval and script files return structured diagnostics shaped as `{ code, severity, message, suggestion, docsHint }`; script-file diagnostics include source path and line/column when locatable. Fatal diagnostics block execution; warnings return with the result. `figma_repl_run_script_file` returns `{ ok:false, upstreamError, primaryFix }` where feasible when upstream Figma execution fails or returns `ok:false`. `allowDangerousOperations: true` can bypass only destructive or dynamic-code guards, not Plugin API contract guards, read-mode write guards, or Design/FigJam/Slides surface guards.

Prefer `figma_repl_init_workspace` + `figma_repl_run_script_file` with local `.figma.js` files for non-trivial Plugin API work. Initialize once with an absolute `cwd` plus `fileUrl` or `fileKey`; workspaces use `<cwd>/figma-mcp/<fileKey-or-fileSlug>/` and intent file pairs such as `<intentSlug>.figma.js` plus `<intentSlug>.result.json`. Later calls can pass only `inputFile` and optionally `outputFile`. Absolute `scriptPath` and output paths remain available as escape hatches. Use `figma_repl_prepare_task` to create task files, `figma_repl_api_card`/`figma_repl_suggest_api` for compact guidance, `$.imageAsset({ base64, parent, size, position, as })` for small generated PNG/JPEG assets, target rectangles plus `figma_repl_apply_asset_manifest` for large local generated assets with target validation, `figma_repl_capture_node` for final visual QA saved to a local file, including upstream screenshot URL payloads and compact QA metadata, `figma_repl_run_task_plan` for sequential script/asset/capture/upstream workflows with default step output files, `$.screenshot(target)` or `node.screenshot()` for opportunistic inline checks, `$.select` instead of direct `figma.currentPage.selection`, `$.cloneNodeTree` for copy-to-side workflows that preserve instance subtrees, `$` helpers plus native Figma Plugin API calls for edits, and `figma_repl_validate_handles` before relying on old cached handles.

When this plugin is not installed into the active Codex environment, direct `figma_repl_*` MCP tools will not appear in tool discovery. In that case, use the local Node client fallback (`createFigmaReplClient`) from this package against the same OAuth cache.

Keep individual `.figma.js` transactions below upstream `use_figma` code payload limits; split dense work into skeleton, asset-target, upload-fill, and visual-fix scripts when `FIGMA_REPL_SCRIPT_PAYLOAD_TOO_LARGE` appears.

Facade routing/delegation boundaries: keep agents on `figma-repl-mcp` first. Use `.figma.js` files for primary Plugin API execution, compact guidance tools/resources before broad reference reads, and `figma_repl_call_upstream_tool` for official capabilities not covered by the file workflow. Use local REPL handles instead of PluginData for agent state.

Node REPL usage with an explicit OAuth cache file:

```js
const { createFigmaReplClient } = await import("./stdio-mcp/dist/repl-server.js");
const figma = createFigmaReplClient({
  oauthCachePath: "C:/Users/you/.codex/.figma-mcp-bridge-oauth.json",
});
await figma.open({
  fileUrl: "https://www.figma.com/design/<fileKey>/<fileName>?node-id=<nodeId>",
});
await figma.eval({
  mode: "read",
  code: "return { page: figma.currentPage.name, selection: figma.currentPage.selection.map(summarizeNode) };",
});
await figma.runScriptFile({
  scriptPath: "C:/work/figma-scripts/edit-card.js",
  dryRun: true,
  strict: true,
  expectedSurface: "design",
});
await figma.close();
```

`oauthCachePath` must be an absolute path to the existing figma-mcp-bridge OAuth cache JSON file. The same file can also be selected for CLI/MCP usage with `FIGMA_MCP_OAUTH_CACHE_PATH`.

## Standalone HTTP MCP Config

For Figma MCP login or debugging outside the bundled `figma-router` login workflow, you can point Codex at the local HTTP bridge manually:

```json
{
  "mcpServers": {
    "figma-http": {
      "url": "http://127.0.0.1:18766/mcp"
    }
  }
}
```

## Scope

Phase 1 is full pass-through:

- No tool filtering.
- No tool description rewrite.
- No JSON-RPC body rewrite.
- No OAuth client registration.
- OAuth metadata, authorization redirect, token exchange, and dynamic client registration are proxied through the local bridge origin.
- Dynamic client registration and OAuth token responses are cached locally by default.

This means Codex should see the official Figma MCP tool list and own the entire OAuth flow. A later phase can add `tools/list` rewriting once pass-through auth is verified.

## Validation

```bash
npm test
```
