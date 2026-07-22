# Figma Workspace Sessions

Use this reference when file context, persisted state, or cross-process continuity matters. Public command help and runtime schemas are authoritative.

## State And Context

- Select one fully qualified absolute `--state-file` for all commands that share a task. Its parent owns `results/` sidecars.
- The state file is exactly `{ "schemaVersion": 1, "sessions": [...] }`. The CLI validates every session, history, workspace, and persisted path field; old arrays and malformed files fail closed rather than migrating.
- Use `figma:sessions:list` for summaries and `figma:sessions:read -- <session-id>` for detail. Do not parse state JSON as an agent contract.
- Use `figma:open` to create or update a session. Commands that receive raw node IDs use selected session context, and `--session-id` chooses the logical session where supported.
- A node URL or structured `{ fileKey, nodeId }` target can supply request-scoped file context. It never rebinds saved session context; a conflicting explicit file fails closed.

## Recovery And Local Outputs

- Preserve a rejected legacy or malformed state file for diagnosis, then create a new task-specific state file with `figma:open` or `figma:task:prepare`.
- Persisted state contains canonical workspace inputs, not agent-managed handles or trusted derived paths. The CLI recomputes session directories and script, output, capture, and result paths.
- Result sidecars anchored by `--state-file`, captures, and task files are local artifacts, not session state. They can contain sensitive Figma data; retain them for recovery until the user or owning workflow removes them.
- Session locks are same-machine, local-filesystem coordination only. A confirmed dead PID is reclaimed atomically; a live owner fails closed. They do not provide distributed, network-share, shared-volume, or power-loss durability.
- If state, sidecar, or lock post-processing fails after a confirmed remote mutation, stdout reports `Status: failed after execution`. Preserve the result and repair the local stage instead of rerunning the mutation.
