---
name: figma-login
description: Trigger the Figma MCP OAuth login bootstrap for this plugin. Use when the user asks to log in to Figma, refresh Figma MCP OAuth credentials, authorize the Figma MCP bridge, run Figma OAuth setup, or fix missing/expired Figma MCP authentication before using the bundled figma-stdio MCP server.
---

# Figma Login

Use this skill to start the plugin's Figma MCP OAuth bootstrap flow.

## Workflow

1. Resolve the plugin root as two directories above this `SKILL.md`.
2. Run the login script with the working directory set to the plugin root. This is required because the npm script and bridge paths are relative to the plugin package.

```text
workdir: <plugin-root>
command: npm run login:figma-http
```

If the execution environment cannot set `workdir` directly, use one continuous shell command instead:

```powershell
cd <plugin-root> && npm run login:figma-http
```

The npm script launches `scripts/login-figma-http.ps1`, which opens an independent PowerShell window, starts the local HTTP bridge, temporarily registers `figma-http` with Codex, runs `codex mcp login figma-http`, and removes the temporary MCP entry afterward.

## Expected Result

After the browser OAuth flow completes, the shared OAuth cache should be available at the first matching path:

```text
FIGMA_MCP_OAUTH_CACHE_PATH
CODEX_HOME/.figma-mcp-bridge-oauth.json
USERPROFILE/.codex/.figma-mcp-bridge-oauth.json
```

Do not add a persistent `figma-http` MCP entry to the plugin. The plugin's persistent MCP server is `figma-stdio`; the HTTP bridge is only for OAuth bootstrap and debugging.
