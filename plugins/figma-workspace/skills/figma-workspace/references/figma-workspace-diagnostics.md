# Figma Workspace Diagnostics

Use this reference to interpret failures and choose the narrowest repair. Runtime diagnostics and command results remain authoritative.

## Diagnostic Shape

- Diagnostics may include `code`, `severity`, `message`, `suggestion`, and `docsHint`.
- Fatal preflight diagnostics prevent upstream execution; warnings can accompany an otherwise usable result.
- Script diagnostics can include source locations. Repair the same `.figma.ts` file and rerun it instead of replacing the workflow with an ad hoc transaction.

## Common Repairs

- Run `figma:doctor -- --state-file <absolute-path>` first when the installed canonical corpus, generated Plugin API index, project docs, or TypeScript runtime assets cannot be loaded. It requires no existing Figma file context. Use `--max-inline-bytes` if its output must be bounded, and follow any sidecar pointer under the selected state file's sibling `results/` directory. Upstream snapshot drift is outside `doctor` and belongs to the maintenance updater.
- For TypeScript or Plugin API errors, follow the source location and use `figma:api:search -- <symbol> --state-file <absolute-path>` for the exact symbol.
- For a stale `$handle`, run `figma:inspect -- <target> --mode validate --state-file <absolute-path>`, then refresh or forget the handle as appropriate.
- For missing file context, use `figma:open` with the same command `--state-file`, or provide a node URL or structured target that contains file context.
- For surface mismatches, pass the correct design, figjam, or slides surface and replace APIs that belong to another surface.
- For asset or capture path failures, use absolute workspace-owned paths and verify that the expected file was actually written.

## Result And Transport Failures

- An unhealthy doctor result is a completed observation: it uses `Status: observed unhealthy` on Restricted Markdown stdout and exits 0. Other top-level `ok: false` results exit 1; usage exits 2 and typed interrupts exit 130.
- Usage, JSON input parsing, transport, and unexpected failures are text on stderr with a non-zero exit code.
- Oversized typed results expose an `outputFiles.cliResultFile`; read that complete JSON sidecar rather than parsing stdout.
- If docs or API lookup reports missing runtime assets, rebuild the package so canonical Markdown docs and the canonical corpus are copied into `dist` and the Plugin API symbol index is regenerated from bundled `@figma/plugin-typings`.
