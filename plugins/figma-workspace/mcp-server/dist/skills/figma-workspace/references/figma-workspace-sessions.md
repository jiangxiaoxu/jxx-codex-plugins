# Figma Workspace Sessions

Use this reference when file context or cross-process continuity matters. CLI help and runtime schemas remain authoritative for arguments.

## State File Selection

- Command `--state-file` selects the persisted workspace state store. Use the same absolute path across CLI calls that must share context.
- Every executing optimized command requires this explicit absolute option. The state file's parent directory also owns `results/` sidecars.
- The raw transport CLI names the same state option `--session-file`. Pass it as a fully qualified absolute path or set fully qualified absolute `FIGMA_WORKSPACE_SESSION_FILE`; there is no current-directory default, and relative or current-drive-rooted paths are rejected.

## Opening And Reusing Context

- Use `figma:sessions:list -- --state-file <absolute-path>` for compact persisted summaries. Use `figma:sessions:read -- <session-id> --state-file <absolute-path>` with `--with-history` only when needed.
- Run `figma:open` with JSON containing the intended Figma file or URL to create or update a session.
- Commands that accept a raw node id need state-file context to determine the file and accept `--session-id` to select the logical workspace session.
- A node URL or structured `{ fileKey, nodeId }` target can provide file context directly where the command supports that target form.
- Keep separate state files for unrelated files or concurrent tasks to avoid accidental context changes.

## Recovery

- Persisted state holds file context and session history, not agent-managed node handles. Pass raw node IDs, node URLs, or structured `{ fileKey, nodeId }` targets where a command supports them.
- A legacy state file containing handle fields is rejected. Preserve it for diagnosis, then reopen with a new explicit, task-specific state path.
- If a state file is malformed or points at the wrong file, stop the mutation, preserve the file for diagnosis, and reopen with an explicit, task-specific state path.
- Do not parse the session JSON directly as an agent contract; use the read-only session commands so schema and locking stay owned by the CLI.

## Local Outputs

- Result sidecars, captures, and task files are local workspace artifacts, not session state.
- Command `--max-inline-bytes` can cause complete JSON to be written under the state file's sibling `results/` directory. Follow the returned output-file pointer.
- State and sidecar writes use sibling temporary files followed by atomic rename. Sidecars may contain sensitive Figma content and remain available for recovery until the user or owning workflow removes them manually.
- Session locks coordinate same-machine processes on a local filesystem. They do not provide distributed locking or safety across hosts, network filesystems, or shared volumes.
