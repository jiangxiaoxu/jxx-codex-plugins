# Figma Workspace Guidance And Lookup Reference

Use this reference to route task documentation and Plugin API questions. Public help and returned IDs define the exact CLI contract.

## Route Intent

- Compress the request to concise English canonical keywords before `figma:guidance` or automatic docs search. The route catalog has English aliases only; non-English, generic, ambiguous, or out-of-vocabulary input can return low confidence and a catalog action.
- Pass a known `--surface design|figjam|slides`. Surface and `--task-family` are hard filters; do not use a Design fallback for a known FigJam or Slides task.
- Run `figma:guidance` for route, workflow, helper, wrapper, and public next-action suggestions. Use only returned public `figma:*` command IDs and run their help before invoking them.

## Read Documentation

- Use `figma:docs:list` for project documents, `figma:docs:catalog` for task-family summaries and canonical records, and `figma:docs:search` to find compatible material.
- Read only returned `project:<topic>` or `canonical:<record-id>` IDs with `figma:docs:read`. A large document can be written to a sidecar instead of inline stdout.
- `figma:docs:search` defaults to `--scope auto`; automatic search excludes examples. Use explicit `--scope examples` only when examples are needed, and treat every explicit scope as strict.
- A Markdown link shaped `[label](canonical:<record-id>)` is a logical cross-record pointer, not a local path or web URL. Read `canonical:<record-id>` with `figma:docs:read` before following its guidance.
- Do not read corpus JSONL, hashes, source paths, chunks, generated declarations, raw transport names, or internal operation names directly.

## Look Up Plugin API

- Run `figma:api:search -- <symbol>` for generated Plugin API declarations. It accepts bare, qualified, and call-shaped queries such as `createFrame`, `figma.createFrame()`, and `ComponentNode.createInstance`.
- Use its returned lookup metadata and snippets; do not substitute a guessed typings file path or full internal index for the public lookup.
