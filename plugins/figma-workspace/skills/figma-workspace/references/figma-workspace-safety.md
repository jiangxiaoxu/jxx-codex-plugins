# Figma Workspace Safety Reference

Use this reference for non-bypassable runtime boundaries. Runtime schemas and public command help remain the source of truth.

## Hard Boundaries

- Read the selected command's help before execution. Do not infer raw transport options or approximate strict JSON input.
- A remote action that requires a Figma file or node target must receive it explicitly. `figma:upstream:list` and `figma:upstream:read` are targetless; `figma:upstream:call` follows the selected live schema. The runtime rejects bare node IDs and conflicts between explicit target sources.
- TypeScript parse/type errors and bundled Figma Plugin API typing errors block `.figma.ts` execution. Repair their source locations before dispatch.
- Validate output and capture paths through the CLI. Managed roots, existing ancestors, and final targets reject symbolic links, Windows junctions, and other reparse points even when they resolve inside the root.
- Wrapped script payloads are capped at 50,000 UTF-8 bytes. Public JSON files, stdin, and asset manifests are capped at 256 KiB; manifests have at most 64 items; each asset upload is capped at 10,000,000 bytes, while each asset download or capture is capped at 16 MiB; cumulative command I/O is capped at 64 MiB.
- Every upstream or bridge network request has a 5-minute total deadline. The 60-second idle deadline applies only where activity is observable, such as HTTP/body streams, the OAuth bridge, or subprocesses. Remote MCP requests enforce only the total deadline.
- Upstream directory discovery follows cursor pages under that shared deadline. It stops after 100 pages and fails closed on a cursor cycle, conflicting duplicate identity, page limit, or page fetch failure; it never returns a partial directory.
- Capture validates requested nodes, safe output paths, dimensions, booleans, content type, and PNG signature. It never returns image bytes through script JSON; inspect saved PNGs with `view_image`.
- Artifact, capture, and download publication uses exclusive sibling temporary files and atomic rename. A failed write must not replace an existing target or publish a partial target.

## Execution Guardrails

- `executionOutcome: "outcome_unknown"` is not permission to retry. Inspect or read back the intended Figma state and reconcile it before another mutation.
- `executionOutcome: "failed_atomic"` means Figma directly returned a `use_figma` script error and confirmed no file changes. This holds for typed `figma:run` and direct `figma:upstream:call`; repair and retry safely.
- A direct official-tool error after dispatch is `outcome_unknown` unless it is the confirmed `use_figma` atomic failure. Do not infer retry safety from a protocol error alone.
- A queued capture failure after `executionOutcome: "succeeded"` requires a standalone capture retry, not a mutation replay. A `Status: failed after execution` result requires repair of the reported local stage while preserving the confirmed remote result.
- `.figma.ts` preflight rejects private `getPluginData` and `setPluginData` calls for Figma host compatibility. Apart from parse/type checks and that narrow exception, it has no generic semantic AST policy, including no general `INSTANCE` geometry or layout preflight. Keep mutations intentional, use the API appropriate to the surface, and verify visible changes with capture.
- Direct upstream calls use the selected live schema and do not receive `.figma.ts` preflight, private PluginData checks, or typed argument validation. Within the response budget, their sanitized sidecar omits protocol `_meta` and tool annotations while preserving business data, including a business `_meta` nested in `structuredContent`. An over-budget response does not persist its payload and returns a bounded resource-limit diagnostic with the existing `executionOutcome`.
