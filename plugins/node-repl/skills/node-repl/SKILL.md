---
name: Node REPL
description: "Use when the user mentions @node-repl or asks to run JavaScript in the local Node REPL MCP server."
---

Use this skill when the user mentions `@node-repl`, `@node repl`, or asks to run JavaScript through the local Node REPL MCP server.

Use the `mcp__node_repl__js` tool to execute JavaScript in the persistent Node-backed kernel.
Use `nodeRepl.write(...)` for precise text output.
Use `mcp__node_repl__js_reset` when a clean kernel is required.

The Node REPL MCP server exposes `nodeRepl.cwd`, `nodeRepl.homeDir`, `nodeRepl.tmpDir`, and `nodeRepl.requestMeta`.
Prefer dynamic imports such as `await import("node:fs/promises")` and top-level `await`.
Do not rely on global `process` or `node:process`; this MCP environment blocks them.
