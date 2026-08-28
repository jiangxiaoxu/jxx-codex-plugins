# Figma Workspace Overview

Use this reference to choose a public command family. Generated help and typed result schemas are authoritative.

## Select A Workflow

- Run `figma:help` to discover the fixed public leaf-command catalog. Each invocation is independent: commands that require a Figma file or node target receive it in that invocation, while targetless upstream lookup does not inherit one.
- For non-trivial, generated, or ambiguous Design, FigJam, or Slides work, use `figma:docs:catalog`, narrow with `figma:docs:search`, and read exact IDs with `figma:docs:read`. Use `figma:api:search` for exact Plugin API symbols and `figma:api:read` for a returned declaration ID.
- Use `figma:doctor` only to diagnose packaged docs, corpus, TypeScript, or Plugin API index faults. It is local-only and does not take a Figma target.
- Use `figma:metadata` for broad Design-file discovery only, then `figma:inspect` for targeted validation. For FigJam or Slides, run a read-only `.figma.ts` script with `figma:run` for broad discovery, then use `figma:inspect --surface figjam|slides` for targeted validation. Use `figma:design-context`, `figma:motion-context`, `figma:variables`, `figma:design-system`, and `figma:libraries` for their named first-class reads.
- Use `figma:run` for every native Plugin API script, whether it is a small inspection or a repairable mutation. The shell owns local `.figma.ts` creation.
- Use `figma:assets:apply` for prepared local assets, `figma:assets:download` for official downloads, and `figma:capture` or queued `$.capture` for visual QA.
- Prefer a first-class command when its typed safeguards apply. Use `figma:upstream:list` and `figma:upstream:read` before `figma:upstream:call` whenever the live official schema is required; local `coverage` indicates a first-class alternative but never blocks the direct call. Obtain explicit user confirmation for any action whose selected description marks destructive, external, credit/cost-bearing, or an asset upload.
- For simple Code Connect mappings, use `figma:code-connect:inspect` -> `figma:code-connect:plan` -> `figma:code-connect:apply --confirm-plan` -> `figma:code-connect:verify`. This workflow is Design-only, manifest-driven, and rejects template artifacts; keep its immutable plan and digest for recovery.

## Shared Rules

- File-scoped commands take `--file <Figma-file-URL|fileKey>`. Node-scoped commands take a full node URL through `--target`, or `--file` plus `--node <nodeId>`; bare node IDs are rejected.
- A URL determines the surface. A raw fileKey needs `--surface` whenever the command requires one.
- Run `--help` for the chosen public leaf command instead of inferring fields, options, limits, or transport behavior.
- Read typed stdout as Restricted Markdown and follow any `outputFiles.cliResultFile` sidecar pointer.
- Read [guidance and lookup](figma-workspace-guidance-and-lookup.md) for static route selection, [workflow](figma-workspace-workflow.md) for execution, and [safety](figma-workspace-safety.md) for non-bypassable boundaries.
