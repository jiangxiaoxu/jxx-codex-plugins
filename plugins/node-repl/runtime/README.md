# Node REPL runtime

This directory contains the launcher and runtime files for the `node-repl` Codex plugin.

The runtime binaries are not committed:

- `bin/node.exe`
- `bin/node_repl.exe`

On MCP startup, `node_repl_mcp.mjs` calls `bootstrap.mjs` to ensure the vendored runtime matches `latest.json`. The bootstrapper downloads the public GitHub Release asset, verifies SHA-256 hashes, and extracts it into this directory. Concurrent starts are serialized with `.runtime-update.lock`, so only one process downloads and extracts the runtime.

## Environment overrides

- `CODEX_NODE_REPL_PATH`: absolute path to a `node_repl` executable.
- `NODE_REPL_NODE_PATH`: absolute path to a Node executable.
- `NODE_REPL_RUNTIME_REFRESH=1`: force runtime refresh before launch.
- `NODE_REPL_RUNTIME_REPO`: GitHub repository for runtime releases. Defaults to `jiangxiaoxu/jxx-codex-plugins`.
- `NODE_REPL_RUNTIME_LOCK_TIMEOUT_MS`: max time to wait for another updater. Defaults to `120000`.
- `NODE_REPL_RUNTIME_LOCK_STALE_MS`: stale updater heartbeat threshold. Defaults to `600000`.

The default startup path requires `node` and `tar` to be available on `PATH`. If only the vendored `bin/node.exe` is available, MCP can start only when the runtime already matches `latest.json`; updating `bin/node.exe` requires an external Node executable because Windows locks the running executable.
