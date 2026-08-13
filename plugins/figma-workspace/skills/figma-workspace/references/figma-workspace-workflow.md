# Figma Workspace Workflow Reference

Use this reference for an end-to-end Figma task. Command-specific help and runtime schemas define each public input contract.

## Prepare, Edit, Verify

1. Start with a full Figma file or node URL. Use `figma:docs:catalog`, `figma:docs:search`, and `figma:docs:read` only when the workflow is not already clear.
2. Run `figma:metadata -- --file <URL|fileKey>` for broad discovery before targeted `figma:inspect -- --file <URL|fileKey> --node <nodeId>` when the structure is unfamiliar.
3. Create a local `.figma.ts` file in the shell. Do not expect the CLI to scaffold or remember a task directory.
4. Use native Figma Plugin API for editing, traversal, layout, assets, cloning, and advanced work. `$` is frozen and non-callable, with only `$.text` and `$.capture`. Use `figma:api:search` for uncertain symbols and `figma:api:read` when the returned snippet does not contain the complete declaration.
5. Run `figma:run -- --file <URL|fileKey> --surface <design|figjam|slides> --script <path/to/change.figma.ts>` after repairing fatal TypeScript or Plugin API diagnostics. For stdin source, replace `--script` with `--source -`. Return compact changed-node IDs and validation notes.
6. Prefer first-class design, motion, library, variable, asset, and capture commands for typed safeguards. Use `figma:upstream:list` to `figma:upstream:read` to `figma:upstream:call` when the live official schema is required; local `coverage` guidance does not block the direct path.
7. Capture visible changes and inspect the saved PNG with `view_image` before reporting visual success.

## Script Helpers

- `await $.text({ target?, parent?, text, font? })` creates or updates font-safe text. `target` and `parent` are mutually exclusive; missing `target` creates a TextNode; mixed-font targets need an explicit font.
- `await $.capture(target, options?)` queues a host-side PNG capture for a node created or resolved inside the script. The final CLI result provides local paths under `captures[]`; use standalone `figma:capture` when the node ID is already known.
- Use native `exportAsync()` only for script-local export data. Do not return large raw export data in script JSON.

## Recover The Result

- `not_started` means validation, preflight, connection, or auth stopped execution before dispatch. Repair that cause, then rerun.
- `failed_atomic` means Figma directly returned a `use_figma` script error. Figma confirmed the script made no file changes, so repair it and retry safely. This applies to the direct `figma:upstream:call` path as well as `figma:run`.
- `succeeded` confirms remote script execution. If queued capture processing failed, use standalone `figma:capture`; do not rerun the mutation script.
- `outcome_unknown` means dispatch occurred but completion cannot be confirmed, for example after a timeout, response loss, or truncation. A post-dispatch error from a direct official tool other than `use_figma` is also `outcome_unknown`. Inspect, read back, or reconcile before deciding whether a retry is safe.
- `Status: failed after execution` means a local artifact or lock stage failed after a confirmed remote operation. Repair the reported local stage and preserve the remote result.
