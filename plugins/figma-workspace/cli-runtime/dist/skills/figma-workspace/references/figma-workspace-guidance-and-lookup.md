# Figma Workspace Route And Lookup Reference

Use this static reference to route task documentation and Plugin API questions. Public help and returned IDs define the exact CLI contract.

## Route Intent

- Documentation search accepts concise English keywords. Use the main skill's Search Query Recipes and the topic map below instead of guessing from a generic request.
- Pass a known `--surface design|figjam|slides` to docs search. Surface and `--task-family` are hard filters; do not use a Design fallback for a known FigJam or Slides task.
- For non-trivial edits, generation, or uncertain routing, run `figma:docs:catalog`, select the compatible family, then narrow `figma:docs:search` with the family and known surface.
- If the topic is still ambiguous, read the most specific returned record with `figma:docs:read` before selecting a remote command.

## Topic Map

| Task family | Surface | English query | Use for | Typical next commands |
| --- | --- | --- | --- | --- |
| `code-connect` | Design | `component code mapping` | Code Connect mapping, metadata, and component-to-code workflows | `figma:docs:search`, `figma:design-context`, then an explicitly discovered official capability if needed |
| `create-file` | Design, FigJam, Slides | `new Figma file` | New file creation and surface selection | `figma:docs:search`, then `figma:upstream:list`, `figma:upstream:read`, `figma:upstream:call` when required |
| `design-editing` | Design | `text editing` | Text, layout, components, variables, and general edits | `figma:api:search`, shell-created `.figma.ts`, `figma:run` |
| `design-generation` | Design | `create interface design` | Generate interfaces, screens, mockups, or structured design content | shell-created `.figma.ts`, `figma:run`, `figma:capture` |
| `design-to-code` | Design | `implement from Figma` | Inspect a design and obtain implementation context | `figma:metadata`, `figma:design-context`, `figma:inspect`, `figma:capture` |
| `diagram` | FigJam | `flowchart` | Flowcharts, sequence diagrams, architecture diagrams, and ER diagrams | `figma:api:search`, shell-created `.figma.ts`, `figma:run` |
| `figjam` | FigJam | `sticky notes` | Boards, sticky notes, connectors, sections, and tables | `figma:api:search`, shell-created `.figma.ts`, `figma:run` |
| `library-generation` | Design | `create component library` | Component libraries, tokens, variables, and styles | `figma:libraries`, `figma:design-system`, `figma:variables`, `figma:run` |
| `motion` | Design | `motion easing` | Motion inventory, timing, easing, and animation patterns | `figma:motion-context`, `figma:capture`, `figma:docs:read` |
| `motion-implementation` | Design | `implement animation` | Translate motion context into implementation behavior | `figma:motion-context`, `figma:design-context`, `figma:docs:read` |
| `slides` | Slides | `slide deck` | Slide lifecycle, deck creation, presentation editing, and validation | `figma:metadata`, shell-created `.figma.ts`, `figma:run`, `figma:capture` |
| `swiftui` | Design | `swiftui code to design` | SwiftUI design-to-code or code-to-design workflows | `figma:design-context`, `figma:docs:search`, `figma:docs:read` |

## Read Documentation

- Use `figma:docs:list` for project documents, `figma:docs:catalog` for task-family summaries and canonical records, and `figma:docs:search` to find compatible material.
- Read only returned `project:<topic>` or `canonical:<record-id>` IDs with `figma:docs:read`. A large document can be written to a sidecar instead of inline stdout.
- `figma:docs:search` defaults to `--scope auto`; automatic search excludes examples. Use explicit `--scope examples` only when examples are needed, and treat every explicit scope as strict.
- A Markdown link shaped `[label](canonical:<record-id>)` is a logical cross-record pointer, not a local path or web URL. Read it with `figma:docs:read` before following its guidance.
- Do not read corpus JSONL, hashes, source paths, chunks, generated declarations, transport names, or internal operation names directly.

## Look Up Plugin API

- Run `figma:api:search -- <symbol>` for generated Plugin API declarations. It accepts bare, qualified, and call-shaped queries such as `createFrame`, `figma.createFrame()`, and `ComponentNode.createInstance`.
- Search results return stable `apiId` values. Search has no per-snippet byte cap; one 12000-byte UTF-8 budget applies across returned snippets, with any truncation reported in `snippetBudget`. Run `figma:api:read -- <api-id>` when the full declaration record is needed.
- Do not substitute a guessed typings file path or full internal index for the public search/read loop.
