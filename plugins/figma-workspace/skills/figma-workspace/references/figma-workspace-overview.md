# Figma Workspace Overview

Use this reference to choose a public `figma:*` command before opening its CLI help. Help and typed result schemas are authoritative.

## Command Surface

- The plugin has 18 direct query/read commands, 9 JSON commands, and 22 raw transport commands. Agents use only the public `figma:*` npm scripts; raw transport names and internal runtime operation names are not agent-facing contracts.
- Every optimized command requires an absolute `--state-file`. Its parent owns `results/` sidecars. Guidance, docs, API, doctor, and upstream list/read do not require existing file context.
- All optimized commands accept `--max-inline-bytes`. JSON commands expose only `--input`, `--state-file`, `--max-inline-bytes`, and help. File-context commands use `--session-id` and, where applicable, `--workspace`.
- Read Restricted Markdown on stdout. If it returns `outputFiles.cliResultFile`, read that JSON sidecar rather than parsing stdout.

## Core Workflow

- Use `figma:open` to create or reopen persisted file context.
- Use `figma:task:prepare` and `figma:script:run` for non-trivial, repairable `.figma.ts` changes.
- Use `figma:eval` only for small native Plugin API transactions.
- Use `figma:task:run` for prepared repeatable script, asset, download, capture, or upstream-tool steps.

## Context And Inspection

- Use `figma:metadata` for broad structure discovery and `figma:inspect` for targeted validation.
- Use `figma:design-context`, `figma:motion-context`, `figma:design-system`, `figma:libraries`, and `figma:variables` for first-class official reads.
- Use `figma:assets:apply` for prepared local image assets and `figma:assets:download` for official asset downloads. Use standalone `figma:capture` when the node id is known, or queued `$.capture` when a script creates or resolves the target; inspect every saved PNG with `view_image`.

## Planning And Reference

- Use `figma:guidance` with concise English canonical keywords and an explicit known surface. Its compact result has route status/confidence, cards, API references, guardrails, summaries, reference context, and typed public `nextActions`.
- Use `figma:docs:list` for project documents. Read returned `project:<topic>` IDs with `figma:docs:read`.
- Use `figma:docs:catalog` to discover canonical task families and records. Read returned `canonical:<record-id>` IDs with `figma:docs:read`.
- Use `figma:docs:search` with default `--scope auto`. Its `--surface` and `--task-family` options are hard filters; explicit scopes are `active|conditional|router|examples|all`. Auto routing never includes examples.
- Use `figma:api:search` for generated Figma Plugin API declarations. It accepts bare, qualified, and call-shaped lookups such as `createFrame`, `figma.createFrame()`, and `ComponentNode.createInstance`.
- Use `figma:sessions:list` and `figma:sessions:read` to inspect persisted state without reading session JSON directly.
- Use `figma:doctor` for installed canonical-corpus, API-index, project-doc, and TypeScript-runtime faults.
- Use `figma:upstream:list` and `figma:upstream:read` before `figma:upstream:call` when no first-class command covers the official capability.
