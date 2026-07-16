# Sections in FigJam

Use a FigJam section to make a named board area: a workshop phase, a flowchart boundary, or a review zone. A section provides visible organization; it is not a Design-frame substitute and it should not be created merely to group one item.

## Local `.figma.ts` workflow

Prepare a task workspace, make the change in its local `.figma.ts` file, and execute it with `figma:script:run`. The run JSON supplies the persisted `sessionId`, `inputFile`, and `surface: "figjam"`; the command always receives an absolute `--state-file`, and TypeScript preflight is always enabled. A tiny, one-off API transaction may use `figma:eval`, but a section and its content normally belong in the repairable script.

```ts
// discovery-section.figma.ts
const existing = [...figma.currentPage.children]
const rightEdge = existing.length === 0
  ? 0
  : Math.max(...existing.map((node) => node.x + node.width))

const section = figma.createSection()
section.name = 'Discovery'
section.resizeWithoutConstraints(900, 620)
section.x = rightEdge + 160
section.y = 120

const sticky = figma.createSticky()
const stickyFont = sticky.text.fontName
if (stickyFont === figma.mixed) throw new Error('Sticky text has mixed fonts')
await figma.loadFontAsync(stickyFont)
sticky.text.characters = 'Collect assumptions before the next review'
section.appendChild(sticky)
sticky.x = 48
sticky.y = 88

return {
  createdNodeIds: [section.id, sticky.id],
  section: { id: section.id, name: section.name, x: section.x, y: section.y, width: section.width, height: section.height },
}
```

Run `npm --silent run figma:script:run -- --input <run-json> --state-file <absolute-path>` after saving the file.

## Plugin API rules

- `figma.createSection()` creates a FigJam `SECTION` on the current page. Name it with the board concept rather than a generic value such as "Section 1".
- Size the section deliberately with `resizeWithoutConstraints(width, height)`. Its `width` and `height` are read-only properties, not assignment targets.
- When a child belongs in the section, append it before setting its local `x` and `y`. Those coordinates are relative to the section after reparenting.
- Existing sections can be found with `findAllWithCriteria({ types: ['SECTION'] })`, then narrowed by ID or name. Prefer IDs returned from earlier scripts for mutation.

## Validation and common failures

Return the section ID and each child ID. A read-only follow-up script should confirm the node type, name, dimensions, child parent IDs, and that child bounds lie within the intended section. Capture the section when it is part of a finished board and inspect the output locally.

If content lands in an unexpected location, it was positioned before `appendChild` or its coordinates were calculated in page space. Reparent first, then position locally. If the section is too small after adding material, enlarge the existing section rather than recreate it. If TypeScript preflight fails, correct the local source and rerun; the failed script has not partially changed the board.
