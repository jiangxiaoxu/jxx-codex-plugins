# Figma MCP Stdio Frontend

Stdio MCP frontend for the official Figma remote MCP endpoint:

```text
https://mcp.figma.com/mcp
```

This package reuses the OAuth cache created by `figma-mcp-bridge` and exposes Figma's remote MCP tools over stdio. It is useful for MCP clients that support stdio servers but do not need the local HTTP OAuth bridge running after the cache has been created.

## Install

```bash
npm install
npm run build
```

## Codex Stdio MCP Config

```json
{
  "mcpServers": {
    "figma-stdio": {
      "command": "node",
      "args": [
        "G:/Project/jxx-codex-plugins/plugins/figma-mcp-bridge/stdio-mcp/dist/stdio-cli.js"
      ]
    }
  }
}
```

The stdio server defaults to:

```text
endpoint: https://mcp.figma.com/mcp
cache:    FIGMA_MCP_OAUTH_CACHE_PATH when set,
          otherwise CODEX_HOME/.figma-mcp-bridge-oauth.json when CODEX_HOME is set,
          otherwise USERPROFILE/.codex/.figma-mcp-bridge-oauth.json
browser:  disabled
```

`FIGMA_MCP_OAUTH_CACHE_PATH`, `CODEX_HOME`, and `USERPROFILE` are environment variables. In PowerShell, set explicit values with `$env:FIGMA_MCP_OAUTH_CACHE_PATH` or `$env:CODEX_HOME`.

The shared cache must already contain valid `clientInformation`, `access_token`, and `refresh_token`. The HTTP bridge can create that cache through Codex's OAuth flow. After that, this stdio frontend can refresh and update the same JSON file.

## Package API

```ts
import {
  createFigmaStdioMcpServer,
  startFigmaStdioMcpServer
} from "@jxx-codex-plugins/figma-mcp-stdio";
```

Low-level exports remain available for embedding: `RemoteMcpClient`, `PersistentOAuthProvider`, `OAuthStateStore`, and config helpers.

## Validation

```bash
npm run typecheck
npm test
```
