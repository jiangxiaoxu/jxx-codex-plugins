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

The plugin bundles one MCP server entry in `.mcp.json`:

```json
{
  "mcpServers": {
    "figma-stdio": {
      "command": "node",
      "args": ["./stdio-mcp/dist/stdio-cli.js"]
    }
  }
}
```

- `figma-stdio`: starts the bundled stdio frontend and connects directly to `https://mcp.figma.com/mcp` using the shared OAuth cache.

The HTTP bridge remains available for OAuth bootstrap and standalone debugging, but it is not installed as a persistent plugin MCP server.

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

## Standalone HTTP MCP Config

For OAuth bootstrap or debugging outside the bundled `figma-login` skill, you can point Codex at the local HTTP bridge manually:

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
