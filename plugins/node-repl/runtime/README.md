# Node REPL runtime

This directory contains the launcher and runtime files for the `node-repl` Codex plugin.

The runtime binary is vendored here:

- `bin/node_repl.exe`

Codex starts the MCP server through `node-repl-mcp.ps1`, which runs `node.exe` from `PATH` with `node_repl_mcp.mjs`.

The startup path requires `node.exe` to be available on `PATH`.
