# Node REPL runtime

This directory contains the launcher and bootstrap files for the `node-repl` Codex plugin.

The runtime binaries are not committed:

- `bin/node.exe`
- `bin/node_repl.exe`

On first launch, `node-repl-mcp.cmd` runs `bootstrap.mjs` with a system `node` executable. The bootstrapper downloads the private GitHub Release asset, verifies its SHA-256 hash, and extracts it into this directory.

## Environment overrides

- `CODEX_NODE_REPL_PATH`: absolute path to a `node_repl` executable.
- `NODE_REPL_NODE_PATH`: absolute path to a Node executable.
- `NODE_REPL_RUNTIME_REFRESH=1`: force runtime refresh before launch.
- `NODE_REPL_RUNTIME_REPO`: GitHub repository for runtime releases. Defaults to `jiangxiaoxu/jxx-codex-plugins`.

The default bootstrap path requires `gh`, `node`, and `tar` to be available on `PATH`.
