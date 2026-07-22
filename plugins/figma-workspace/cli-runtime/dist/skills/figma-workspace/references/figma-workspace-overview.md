# Figma Workspace Overview

Use this reference to choose a command family. Public command help and typed result schemas are authoritative.

## Select A Workflow

- Use `figma:guidance` first for non-trivial Design, FigJam, or Slides work. It routes concise English intent to public next actions; use `figma:docs:search` or `figma:docs:catalog` when the route needs more material.
- Use `figma:open` to establish existing-file context. Use `figma:task:prepare` and `figma:script:run` for repairable `.figma.ts` work; reserve `figma:eval` for a small native Plugin API transaction.
- Use `figma:metadata` for broad discovery, then `figma:inspect` for targeted validation. Prefer first-class context, motion, design-system, library, and variable commands over a raw upstream call.
- Use `figma:assets:apply` for prepared local assets, `figma:assets:download` for official downloads, and `figma:capture` or queued `$.capture` for visual QA.
- Use `figma:sessions:list` and `figma:sessions:read` to resume state. Use `figma:doctor` only for installed runtime assets, project docs, corpus, or Plugin API index faults.
- Use `figma:upstream:list` and `figma:upstream:read` before `figma:upstream:call` when no first-class command covers an official capability.

## Shared Rules

- Reuse one fully qualified absolute `--state-file` for a task. Read typed stdout as Restricted Markdown and follow any `outputFiles.cliResultFile` sidecar pointer.
- Run `--help` for the chosen public `figma:*` command instead of inferring JSON fields, options, limits, or transport behavior.
- Read [guidance and lookup](figma-workspace-guidance-and-lookup.md) for document navigation, [workflow](figma-workspace-workflow.md) for execution, and [safety](figma-workspace-safety.md) for non-bypassable boundaries.
