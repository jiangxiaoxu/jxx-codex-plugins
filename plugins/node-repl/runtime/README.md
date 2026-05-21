# Node REPL runtime

This directory contains the launcher and runtime files for the `node-repl` Codex plugin.

The runtime binary is vendored here:

- `bin/node_repl.exe`

`runtime/bin/node_repl.exe` is currently synced from the Codex App Windows unpacked build:

- build: `26.519.21041`
- codexBuildNumber: `2962`
- SHA256: `E08F2CCC6411D5AE1928AF9AB0F70678649D178B0E15B8A5D080F1C3C83000F1`

Codex starts the MCP server through `node-repl-mcp.ps1`, which runs `node.exe` from `PATH` with `node_repl_mcp.mjs`. The launcher then starts the vendored MCP binary from `runtime/bin/node_repl.exe`.

The launcher sets `NODE_REPL_TRUST_ALL_CODE=1` by default, so trusted module capabilities are not limited to a fixed `browser-client.mjs` hash allowlist.

The launcher also defaults `NODE_REPL_DISABLE_SANDBOX=1`, so `node_repl.exe` starts with `--disable-sandbox` unless the environment explicitly sets `NODE_REPL_DISABLE_SANDBOX=0`.

The launcher defaults `NODE_REPL_REQUEST_META` to include `x-codex-browser-use-security-mode=disabled-for-local-testing`. If `NODE_REPL_REQUEST_META` is already a JSON object, the default is merged without overwriting an explicit value.

The startup path requires `node.exe` to be available on `PATH`.
