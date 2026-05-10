# jxx-codex-plugins

Codex plugin marketplace repository.

The first bundled plugin is `node-repl`. Its Windows runtime is vendored from the Microsoft Store Codex x64 MSIX as `plugins/node-repl/runtime/bin/node_repl.exe`.

## Layout

- `.agents/plugins/marketplace.json`: marketplace index.
- `plugins/node-repl/.codex-plugin/plugin.json`: Codex plugin manifest.
- `plugins/node-repl/.mcp.json`: MCP server registration.
- `plugins/node-repl/runtime/`: MCP launcher files and vendored runtime location.
- `scripts/package-runtime.js`: refreshes `plugins/node-repl/runtime/bin/node_repl.exe` from an MSIX or the latest Microsoft Store package.
- `scripts/fetch-msstore.js`: resolves and optionally downloads Microsoft Store MSIX packages.

## Local validation

```powershell
npm ci
npm run validate:plugin
node scripts/package-runtime.js --msix G:\Project\Codex-App\downloads\OpenAI.Codex_26.506.3741.0_x64__2p2nqsd0c76g0.msix
```

After refreshing the runtime, review and commit the changed vendored binary together with any plugin manifest changes needed for that plugin version.
