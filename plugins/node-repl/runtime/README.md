# Node REPL runtime

This directory contains the launcher and runtime files for the `node-repl` Codex plugin.

The runtime binary is vendored here:

- `bin/node_repl.exe`

Refresh it manually from a provided MSIX or the latest Microsoft Store package:

```powershell
node scripts/package-runtime.js --msix <path-to-codex.msix>
node scripts/package-runtime.js --latest-msstore
```

## Environment overrides

- `CODEX_NODE_REPL_PATH`: absolute path to a `node_repl` executable.
- `NODE_REPL_NODE_PATH`: absolute path to a Node executable.

The default startup path requires `node` to be available on `PATH`.
