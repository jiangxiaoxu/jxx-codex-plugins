# Figma Workspace Workflow Reference

Use this reference for an end-to-end Figma task. Command-specific help and runtime schemas define each public input contract.

## Prepare, Edit, Verify

1. Choose an absolute `--state-file`. For a non-trivial edit, convert the request to concise English keywords, use `figma:guidance` with the known surface, and follow the catalog/search/read fallback when routing is uncertain.
2. Establish file context with `figma:open` or an explicit target. Run `figma:metadata` for broad discovery before targeted `figma:inspect` when the structure is unfamiliar.
3. Run `figma:task:prepare` to create a repairable `.figma.ts` workspace, then edit the generated file.
4. Use native Figma Plugin API for editing, traversal, selection, layout, assets, cloning, and advanced work. `$` is frozen and non-callable, with only `$.text` and `$.capture`. Use `figma:api:search` for uncertain symbols.
5. Run `figma:script:run` after repairing fatal TypeScript or Plugin API diagnostics. Return compact changed-node IDs and validation notes from the script.
6. Use first-class design, motion, library, variable, asset, and capture commands before the `figma:upstream:list` to `figma:upstream:read` to `figma:upstream:call` fallback.
7. Capture visible changes and inspect the saved PNG with `view_image` before reporting visual success.

## Script Helpers

- `await $.text({ target?, parent?, text, font? })` creates or updates font-safe text. `target` and `parent` are mutually exclusive; missing `target` creates a TextNode; mixed-font targets need an explicit font.
- `await $.capture(target, options?)` queues a host-side PNG capture for a node created or resolved inside the script. The final CLI result provides local paths under `captures[]`; use standalone `figma:capture` when the node ID is already known.
- Use native `exportAsync()` only for script-local export data. Do not return large raw export data in script JSON.

## Recover The Result

- `not_started` means validation, preflight, connection, or auth stopped execution before dispatch. Repair that cause, then rerun.
- `succeeded` confirms remote script execution. If queued capture processing failed, use standalone `figma:capture`; do not rerun the mutation script.
- `outcome_unknown` means dispatch occurred but completion cannot be confirmed. Inspect, read back, or reconcile the intended effect before deciding whether a retry is safe.
- `Status: failed after execution` means local state, sidecar, or lock handling failed after a confirmed remote operation. Repair the reported local stage and preserve the remote result.
