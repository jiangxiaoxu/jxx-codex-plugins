# Figma Workspace Safety Reference

Use this reference for non-bypassable runtime boundaries. Runtime schemas and actual command help remain the source of truth.

Before executing a command, read its public help and use only the optimized flags it exposes. Public help includes the complete input schema; do not infer transport CLI options or raw operation names.

## Hard Boundaries

- `.figma.ts` execution is blocked by TypeScript parse/type errors and the bundled Figma Plugin API typings. Source-line diagnostics identify failures for repair.
- The runtime validates script input, workspace paths, state files, session IDs, and capture envelopes. Workspace and image output paths must remain inside their permitted roots. Managed roots, ancestors, and final targets reject symbolic links, Windows junctions, and other reparse points, even when a link appears to resolve inside the root.
- State is a strict versioned envelope with `schemaVersion: 1` and `sessions`; unwrapped legacy arrays and malformed persisted path data fail closed. State retains canonical workspace inputs only, and the CLI recomputes derived local paths.
- Wrapped script payloads over 50,000 UTF-8 bytes fail closed. Public JSON files, stdin, and asset manifest files are limited to 256 KiB; a manifest has at most 64 items; an upload/download/capture is at most 16 MiB; and total command input/output is at most 64 MiB. Requests have a 5-minute total deadline and a 60-second no-data idle deadline.
- CLI output uses the 4096-byte default inline-result budget and writes complete oversized results to atomic sidecars. Local state, sidecar, workspace, capture, and download output uses sibling temporary files, sync where supported, and atomic publication; failed output must not replace a prior target or leave a published partial target.
- Queued capture accepts at most 8 requests and validates request order, node IDs, safe output paths, dimensions, booleans, PNG content type, and PNG signature. It never returns image bytes through script JSON.
- A script can succeed while queued capture post-processing fails. The result then preserves `executionOutcome: "succeeded"`, reports `captureProcessingSucceeded: false`, and provides retry guidance; do not rerun a mutation script only to recover an image.
- `executionOutcome: "outcome_unknown"` means dispatch occurred but completion cannot be confirmed. Read the relevant Figma state and reconcile the intended effect before deciding whether any retry is safe.
- State and sidecar writes use ownership-safe local locking and atomic rename. A confirmed dead local PID can be reclaimed; a live owner fails closed. This is same-machine local-filesystem coordination only, not distributed, network-filesystem, shared-volume, or power-loss durability.

## No Semantic AST Policy

- The runtime does not block or warn on valid Plugin API operations because of semantic source analysis. This includes destructive edits, `eval`, `fetch`, dynamic import, root searches, PluginData, image creation, direct selection mutation, and page switches.
- Use the native Plugin API that matches the intended edit. This is not a claim that every operation is available on every Figma surface; TypeScript typings and the Figma runtime remain authoritative.
- Treat visible changes as needing visual QA: use standalone `figma:capture` or queued `$.capture`, then inspect the saved PNG with `view_image`.
