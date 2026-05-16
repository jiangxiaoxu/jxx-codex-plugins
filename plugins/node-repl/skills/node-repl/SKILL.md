---
name: Node REPL
description: "Use when the user mentions @node-repl or asks to run JavaScript in the local Node REPL MCP server."
---

Use this skill when the user mentions `@node-repl`, `@node repl`, or asks to run JavaScript through the local Node REPL MCP server.

Use `mcp__node_repl__js` as the JavaScript execution tool. It runs code in a persistent Node-backed kernel with top-level `await`.
Use `mcp__node_repl__js_reset` only to clear kernel state and bindings.
Use `mcp__node_repl__js_add_node_module_dir` to add an absolute `node_modules` directory as a package resolution root.

Bindings persist across `mcp__node_repl__js` calls until reset. If a declaration conflicts, reuse or rename it instead of assuming a fresh scope.
Use dynamic imports such as `await import("node:fs/promises")` or `await import("pkg")`; top-level static `import` is not supported.

Use `nodeRepl.write(...)` for precise text output and `await nodeRepl.emitImage(...)` to return images.
Use `nodeRepl.requestMeta` to inspect request metadata and `nodeRepl.setResponseMeta(...)` to attach response metadata.
The Node REPL MCP server also exposes `nodeRepl.cwd`, `nodeRepl.homeDir`, and `nodeRepl.tmpDir`.

This plugin launcher defaults `NODE_REPL_TRUST_ALL_CODE=1` and `NODE_REPL_DISABLE_SANDBOX=1`.
Imported modules may receive trusted module capabilities such as `import.meta.__codexNativePipe` and `import.meta.privilegedNodeRepl`.
Treat those as integration/runtime capabilities; prefer the public `nodeRepl.*` helpers for ordinary REPL work.

Do not rely on global `process` or `node:process`; this MCP environment blocks them.
