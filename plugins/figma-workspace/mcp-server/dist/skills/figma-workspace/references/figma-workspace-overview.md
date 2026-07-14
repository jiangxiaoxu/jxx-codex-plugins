# Figma Workspace Overview

Use this reference to choose a CLI capability before opening command-specific help. CLI help and runtime schemas remain the source of truth for inputs and results.

## Command Surface

- Every executing optimized command, including all 17 direct commands and all 9 JSON commands, requires an explicit absolute `--state-file`. It persists workspace state, and its parent owns `results/` sidecars.
- Guidance, docs, API, doctor, and upstream list/read require no existing Figma file context, but still require `--state-file`. File-context commands also accept `--session-id`.
- All executing commands accept `--max-inline-bytes`. JSON commands expose only `--input`, `--state-file`, `--max-inline-bytes`, and help; use `npm --silent run figma:raw -- <transport-command> --help` for the complete transport JSON schema.
- File-binding commands accept `--workspace`; `figma:inspect` instead reuses context already bound to its session and intentionally omits `--workspace` and `--file`.

## Core Workflow

- Use `figma:open` to create or reopen persisted file context.
- Use `figma:task:prepare` and `figma:script:run` for non-trivial, repairable `.figma.ts` changes.
- Use `figma:eval` only for small native Plugin API transactions that do not benefit from a task file.
- Use `figma:task:run` for a prepared, repeatable sequence of script, asset, download, capture, or upstream-tool steps.

## Context And Inspection

- Use `figma:metadata` for broad structure discovery.
- Use `figma:inspect` for targeted style, structure, or handle validation after file context is known.
- Use `figma:design-context` and `figma:motion-context` for official implementation context.
- Use `figma:design-system`, `figma:libraries`, and `figma:variables` for official design-system information.

## Assets And Visual QA

- Use `figma:assets:apply` for prepared local image assets and `figma:assets:download` for official asset downloads.
- Use `figma:capture` to write a local PNG after meaningful visual changes, then inspect that PNG with `view_image`.
- Keep capture targets and visible audit markers from obscuring the content under review.

## Planning And Reference

- Use `figma:docs:list` and `figma:docs:read` for canonical project Markdown topics.
- Use `figma:guidance` for task-oriented cards, helper profiles, wrapper profiles, and workflow sequencing.
- Use `figma:docs:search` for project workflow documentation plus the plugin-owned canonical corpus. Its scope is `active|conditional|examples|all`; the 9 examples are plugin-owned TypeScript-in-Markdown templates.
- Use `figma:api:search` for exact Plugin API symbols from the generated bundled `@figma/plugin-typings` index, independently of any development snapshot.
- Use `figma:sessions:list` and `figma:sessions:read` to inspect persisted state without reading session JSON directly.
- Use `figma:doctor` for local lookup, project-doc, and TypeScript runtime asset faults.
- Use `figma:upstream:list` and `figma:upstream:read` for the live official schema, then use `figma:upstream:call` only when an official capability has no first-class CLI wrapper.
