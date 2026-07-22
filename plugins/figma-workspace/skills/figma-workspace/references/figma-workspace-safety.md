# Figma Workspace Safety Reference

Use this reference for non-bypassable runtime boundaries. Runtime schemas and public command help remain the source of truth.

## Hard Boundaries

- Read the selected command's help before execution. Do not infer raw transport options or approximate strict JSON input.
- TypeScript parse/type errors and bundled Figma Plugin API typing errors block `.figma.ts` execution. Repair their source locations before dispatch.
- Validate state, workspace, output, and capture paths through the CLI. Managed roots, existing ancestors, and final targets reject symbolic links, Windows junctions, and other reparse points even when they resolve inside the root.
- Wrapped script payloads are capped at 50,000 UTF-8 bytes. Public JSON files, stdin, and asset manifests are capped at 256 KiB; manifests have at most 64 items; each upload, download, or capture is capped at 16 MiB; and cumulative command I/O is capped at 64 MiB.
- Every upstream or bridge network request has a 5-minute total deadline. The 60-second idle deadline applies only where activity is observable, such as HTTP/body streams, the OAuth bridge, or subprocesses. Remote MCP requests enforce only the total deadline.
- Capture validates requested nodes, safe output paths, dimensions, booleans, content type, and PNG signature. It never returns image bytes through script JSON; inspect saved PNGs with `view_image`.
- State, sidecar, workspace, capture, and download publication uses exclusive sibling temporary files and atomic rename. A failed write must not replace an existing target or publish a partial target.

## Execution Guardrails

- `executionOutcome: "outcome_unknown"` is not permission to retry. Inspect or read back the intended Figma state and reconcile it before another mutation.
- A queued capture failure after `executionOutcome: "succeeded"` requires a standalone capture retry, not a mutation replay. A `Status: failed after execution` result requires repair of the reported local stage while preserving the confirmed remote result.
- Valid native Figma Plugin API operations are not subject to semantic AST policy. Keep mutations intentional, use the API appropriate to the surface, and verify visible changes with capture.
