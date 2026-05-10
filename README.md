# jxx-codex-plugins

Codex plugin marketplace repository.

The first bundled plugin is `node-repl`. Its Windows runtime is vendored from the Microsoft Store Codex x64 MSIX as `plugins/node-repl/runtime/bin/node_repl.exe`.

## Layout

- `.agents/plugins/marketplace.json`: marketplace index.
- `plugins/node-repl/.codex-plugin/plugin.json`: Codex plugin manifest.
- `plugins/node-repl/.mcp.json`: MCP server registration.
- `plugins/node-repl/runtime/`: MCP launcher files and vendored runtime location.

## Local setup

```powershell
npm ci
```
