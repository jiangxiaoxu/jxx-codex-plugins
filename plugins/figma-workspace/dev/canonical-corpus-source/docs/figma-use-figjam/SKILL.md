# FigJam Plugin API Reference

Use this reference with the Figma Workspace CLI. Put a native Plugin API async script body in a local `.figma.ts` file and execute it with `figma:run -- --file <figjam-file-url-or-key> --surface figjam --script <path/to/script.figma.ts>`. For uncertain routing, use `figma:docs:catalog`, `figma:docs:search -- --surface figjam`, or `figma:api:search`.

> **FigJam URL is `figma.com/board/...`.** Do NOT call `figma.createPage()` in FigJam — it throws `TypeError: figma.createPage no such property 'createPage' on the figma global object`. `createPage()` is a Design-file API only (`figma.com/design/...`). FigJam files have a single implicit page; organize content with sections instead (see [create-section](canonical:figma-use-figjam/references/create-section.md)).

## Inspecting FigJam Files

Use `figma:metadata` for broad file structure, then `figma:inspect` for targeted nodes. They provide the raw node IDs needed by later scripts.

- Inspect existing board structure before writing a script that targets current nodes.
- Return raw node IDs and validation notes from each script; `console.log` is not an agent result channel.
- For visual checks, use `figma:capture` with a valid node reference and inspect the resulting image.
- If an earlier script did not return an ID, repeat `figma:metadata` and `figma:inspect` rather than guessing or scanning a broad tree in a mutation script.

## Loading Reference Docs Efficiently

Load only the references your task needs — but when you do need to load multiple, **issue all reads in a single parallel tool-call batch**, not sequentially across turns. For a typical board-creation task, that means a single message containing reads for `plan-board-content` plus the 3-4 specific node-type references you'll use.

## Command Selection

Run the selected `figma:<command>` with `--help` before first use. Pass an explicit FigJam URL or fileKey to `figma:metadata` and `figma:inspect` for reads, use `figma:run` for local `.figma.ts` work, and use `figma:capture` for visual QA. Every remote command receives its target in that invocation.

## Text Mutations — Canonical Recipe

Every FigJam text mutation (sticky/shape/label/table cell/connector text, standalone text nodes) follows the same recipe: load font → `await` → mutate → return affected IDs. Skipping the load throws `Cannot write to node with unloaded font "<family> <style>"`. FigJam-specific note: sublayer defaults vary (sticky → `Inter Medium`, shape → `Inter Medium`, connector → invalid until set), so always load from `node.text.fontName` rather than hardcoding `{ family: 'Inter', style: 'Regular' }`.

## Adding Images to a FigJam Board

Use `figma:assets:apply` for prepared local image assets and `figma:assets:download` for downloads. Do not call `figma.createImageAsync(src)`: this host rejects it. A native `figma.createImage(data)` path is permitted only after the current host has verified it for already-local bytes; otherwise use the asset workflow. Validate the result with `figma:capture`.

## Reference Docs

- [plan-board-content](canonical:figma-use-figjam/references/plan-board-content.md) - Read this for any board content request — board template, retro, brainstorm, ice breaker, meeting board, scaffold
  - Covers planning of generated board content, including sequential outline, sections, intents, and hierarchical text
  - Delegates to other references for specific API details
- [create-section](canonical:figma-use-figjam/references/create-section.md) — Create and configure FigJam sections (sizing, naming, colors, content visibility, organizing nodes, column layouts)
- [create-sticky](canonical:figma-use-figjam/references/create-sticky.md) — Create and configure FigJam sticky notes (colors, sizing, text, author visibility, batch creation)
- [create-connector](canonical:figma-use-figjam/references/create-connector.md) — Create and configure FigJam connectors (endpoints, arrows, line types, labels, colors, diagram wiring)
- [create-text](canonical:figma-use-figjam/references/create-text.md) — Create and configure FigJam text nodes (font loading, preset fonts and colors, sizing, lists, mind map operations)
- [position-figjam-nodes](canonical:figma-use-figjam/references/position-figjam-nodes.md) — Position, size, and reparent nodes on the canvas (including within sections)
- [create-shape-with-text](canonical:figma-use-figjam/references/create-shape-with-text.md) — Create and configure FigJam shapes with embedded text (shape types, color presets, sizing to fit text, diagram layouts)
- [create-code-block](canonical:figma-use-figjam/references/create-code-block.md) — Create and configure FigJam code block nodes (languages, syntax highlighting, positioning, embedding in sections)
- [create-table](canonical:figma-use-figjam/references/create-table.md) — Create and configure FigJam tables (rows, columns, cell text, color presets, resizing)
- [edit-text](canonical:figma-use-figjam/references/edit-text.md) — Edit existing text nodes (font loading, styled ranges, find/replace, FigJam Charcoal default color)
- [create-label](canonical:figma-use-figjam/references/create-label.md) — Create and configure FigJam label nodes (small numbered/lettered circle callout markers, sequences, positioning)
- [batch-modify](canonical:figma-use-figjam/references/batch-modify.md) — Patterns for modifying many existing nodes at once (bulk style changes, repositioning, property updates)
- [figjam-colors](canonical:figma-use-figjam/references/figjam-colors.md) — Canonical FigJam color palettes for every node type (sticky, section, connector, shape, label) plus the `hex/255` notation rule and the `h()` helper
