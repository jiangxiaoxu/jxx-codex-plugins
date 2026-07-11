# Figma Workspace Sessions

Use this reference when file context, handles, or cross-process continuity matters. CLI help and runtime schemas remain authoritative for arguments.

## State File Selection

- Command `--state-file` selects the persisted workspace state store. Use the same absolute path across CLI calls that must share context.
- The state file's parent directory also owns `results/` sidecars. Without an explicit state file, the plugin-root default is `.figma-workspace/session.json` with sidecars under `.figma-workspace/results/`.
- The raw transport CLI names the same state option `--session-file`; its environment/default resolution remains part of `figma:raw` help, not the optimized command surface.

## Opening And Reusing Context

- Use `figma:sessions:list -- --state-file <path>` for compact persisted summaries. Use `figma:sessions:read -- <session-id> --state-file <path>` with `--with-handles` or `--with-history` only when needed.
- Run `figma:open` with JSON containing the intended Figma file or URL to create or update a session.
- Commands that accept a raw node id or `$handle` need state-file context to determine the file and accept `--session-id` to select the logical workspace session.
- A node URL or structured `{ fileKey, nodeId }` target can provide file context directly where the command supports that target form.
- Keep separate state files for unrelated files or concurrent tasks to avoid accidental context changes.

## Handles And Recovery

- Handles persist agent-friendly node references in local session state; they are not PluginData stored in the Figma document.
- Validate a handle with `figma:inspect -- <target> --mode validate` before relying on it after structural changes or a later process.
- Use `$.remember` and `$.forget` deliberately, and return changed node ids or handles from repairable scripts.
- If a state file is malformed or points at the wrong file, stop the mutation, preserve the file for diagnosis, and reopen with an explicit, task-specific state path.
- Do not parse the session JSON directly as an agent contract; use the read-only session commands so schema and locking stay owned by the CLI.

## Local Outputs

- Result sidecars, captures, and task files are local workspace artifacts, not session state.
- Command `--max-inline-bytes` can cause complete JSON to be written under the state file's sibling `results/` directory. Follow the returned output-file pointer.
