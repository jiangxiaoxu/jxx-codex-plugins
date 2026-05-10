# jxx-codex-plugins

Codex plugin marketplace repository.

The first bundled plugin is `node-repl`. The repository does not commit the Windows runtime binaries. The runtime is built from the latest Microsoft Store Codex x64 MSIX and published as a public GitHub Release asset. The plugin bootstraps the release asset on first use.

The manual runtime workflow publishes only when the extracted `node.exe` or `node_repl.exe` hash changes. When a runtime update is published, the workflow bumps the plugin patch version independently and records the Codex package version in `runtime/latest.json`.

## Layout

- `.agents/plugins/marketplace.json`: marketplace index.
- `plugins/node-repl/.codex-plugin/plugin.json`: Codex plugin manifest.
- `plugins/node-repl/.mcp.json`: MCP server registration.
- `plugins/node-repl/runtime/`: launcher, bootstrapper, and runtime metadata.
- `scripts/package-runtime.js`: extracts `app/resources/node.exe` and `node_repl.exe` from an MSIX and packages the runtime tarball.
- `scripts/fetch-msstore.js`: resolves and optionally downloads Microsoft Store MSIX packages.
- `.github/workflows/release-runtime.yml`: manual release workflow.

## Local validation

```powershell
npm ci
npm run validate:plugin
node scripts/package-runtime.js --msix G:\Project\Codex-App\downloads\OpenAI.Codex_26.506.3741.0_x64__2p2nqsd0c76g0.msix
```

Runtime binaries are intentionally ignored under `plugins/node-repl/runtime/bin/`.
