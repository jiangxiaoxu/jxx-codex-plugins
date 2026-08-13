# Shapes with text in FigJam

Use `SHAPE_WITH_TEXT` nodes for diagram steps, decisions, named concepts, and brief annotations whose meaning belongs inside the shape. Choose a sticky for participant-style ideas, a label for a short callout marker, and a connector for relationships between nodes.

## Build in a task file

For a board change, edit a local `.figma.ts` file and run it with `figma:run`, passing an explicit FigJam file target, `--surface figjam`, and the script path. TypeScript preflight is always enabled. Return all changed node IDs.

Keep a mutating script to one board page and one narrow transaction. For cross-page work, fan out separate read-only calls after explicit page discovery, then run separate per-page mutations; the runtime serializes applicable same-machine calls by `fileKey`.

```ts
// review-decision.figma.ts
const font: FontName = { family: 'Inter', style: 'Medium' }
await figma.loadFontAsync(font)

const text = 'Review request'
const shape = figma.createShapeWithText()
shape.name = text
shape.shapeType = 'DIAMOND'
shape.text.fontName = font
shape.text.characters = text
shape.resize(280, 180)
shape.fills = [{ type: 'SOLID', color: { r: 0xff / 255, g: 0xec / 255, b: 0xbd / 255 } }]
shape.strokes = [{ type: 'SOLID', color: { r: 0xff / 255, g: 0xc9 / 255, b: 0x43 / 255 } }]
shape.text.fills = [{ type: 'SOLID', color: { r: 0x1e / 255, g: 0x1e / 255, b: 0x1e / 255 } }]
shape.x = 240
shape.y = 160
return { createdNodeIds: [shape.id], shape: { id: shape.id, type: shape.shapeType, text } }
```

Execute it with `npm --silent run figma:run -- --file <figjam-file-url-or-key> --surface figjam --script <path/to/script.figma.ts>`.

## API and layout guidance

- Create with `figma.createShapeWithText()` and set `shapeType` after creation. Useful values include `ROUNDED_RECTANGLE`, `SQUARE`, `ELLIPSE`, `DIAMOND`, `TRIANGLE_UP`, `TRIANGLE_DOWN`, `HEXAGON`, `OCTAGON`, `STAR`, and `PENTAGON`.
- Edit visible content through `shape.text.characters`; `shape.name` is only the layer name. Load the current text font and await it before text mutations.
- Use `resize(width, height)`; direct width/height assignment is unavailable. Give longer text a measured, generous text area, especially in non-rectangular shapes where the usable interior is smaller.
- Coordinate fill, stroke, and text fills. Figma RGB values are 0-1, so preserve exact palette values with `hex / 255`.
- Do not rotate a shape for decoration. Rotate only when the board meaning explicitly calls for it.

## Verify and repair

Return the ID, type, text, dimensions, and location. A read-only script should confirm the node's `type`, `shapeType`, `text.characters`, and bounds; capture it if wrapping, clipping, or its relationship to connectors is important, then inspect that image locally.

An unloaded-font or invalid runtime property error occurs inside the host script after dispatch; use the returned outcome and documented failure presentation, never label it `not_started`. Clipped copy means the chosen dimensions do not fit the actual text; enlarge the existing shape after measuring rather than replace its content with an abbreviation. If a shape appears at the origin or overlaps board content, compute a clear anchor before creation. Give the shape its deterministic operation-specific name immediately after creation and return its ID. A fatal TypeScript preflight diagnostic reports `not_started`. For an `outcome_unknown` result, follow `retryGuidance`, inspect returned IDs first, then narrowly read back the expected shape name, text, parent, and bounds before any retry. Shared PluginData is only an optional, host-verified supplement.
