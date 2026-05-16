# Node REPL runtime

This directory contains the launcher and runtime files for the `node-repl` Codex plugin.

The runtime binary is vendored here:

- `bin/node_repl.exe`

`runtime/bin/node_repl.exe` is currently synced from the Codex App Windows unpacked build:

- build: `26.513.31313`
- codexBuildNumber: `2872`
- SHA256: `D6C79EBF83312A449D36C8FC8EFAF1EB009FBF4876F6C9125863B21F9AD8B82B`

Codex starts the MCP server through `node-repl-mcp.ps1`, which runs `node.exe` from `PATH` with `node_repl_mcp.mjs`. The launcher then starts the vendored MCP binary from `runtime/bin/node_repl.exe`.

The launcher sets `NODE_REPL_TRUST_ALL_CODE=1` by default, so trusted module capabilities are not limited to a fixed `browser-client.mjs` hash allowlist.

The launcher also defaults `NODE_REPL_DISABLE_SANDBOX=1`, so `node_repl.exe` starts with `--disable-sandbox` unless the environment explicitly sets `NODE_REPL_DISABLE_SANDBOX=0`.

The startup path requires `node.exe` to be available on `PATH`.
