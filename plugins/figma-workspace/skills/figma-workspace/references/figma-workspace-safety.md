# Figma Workspace Safety Reference

Use this reference for non-bypassable runtime boundaries. Runtime schemas and actual command help remain the source of truth.

Before executing a command, read its help and use only the optimized flags it exposes. Do not infer transport CLI options on a command; use `npm --silent run figma:raw -- <transport-command> --help` only when the complete transport JSON schema is required.

## Hard Boundaries

- `.figma.ts` execution is blocked by TypeScript parse/type errors and the bundled Figma Plugin API typings. Source-line diagnostics identify failures for repair.
- The runtime validates script input, workspace paths, state files, session IDs, and capture envelopes. Workspace and image output paths must remain inside their permitted roots.
- Wrapped script payloads over 50,000 UTF-8 bytes fail closed. CLI output uses the inline-result budget and writes complete oversized results to atomic sidecars.
- Queued capture accepts at most 8 requests and validates request order, node IDs, safe output paths, dimensions, booleans, PNG content type, and PNG signature. It never returns image bytes through script JSON.
- A script can succeed while queued capture post-processing fails. The result then preserves `scriptExecutionSucceeded: true`, `captureProcessingSucceeded: false`, and retry guidance; do not rerun a mutation script only to recover an image.
- State and sidecar writes use local locking and atomic rename. They are same-machine filesystem coordination only.

## No Semantic AST Policy

- The runtime does not block or warn on valid Plugin API operations because of semantic source analysis. This includes destructive edits, `eval`, `fetch`, dynamic import, root searches, PluginData, image creation, direct selection mutation, and page switches.
- Use the native Plugin API that matches the intended edit. This is not a claim that every operation is available on every Figma surface; TypeScript typings and the Figma runtime remain authoritative.
- Treat visible changes as needing visual QA: use standalone `figma:capture` or queued `$.capture`, then inspect the saved PNG with `view_image`.
