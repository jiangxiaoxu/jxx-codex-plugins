# Circular callout labels in FigJam

Use a label for a one- or two-character step marker such as `1`, `A`, or `10`. It is a fixed-size `SHAPE_WITH_TEXT` ellipse, suitable for a numbered diagram or a legend anchor. For a phrase, status, or any variable-length message, create a normal shape-with-text instead.

## Prepare and run a local script

Place the operation in a local `.figma.ts` file and execute it with `figma:run`, using an explicit FigJam file target, `--surface figjam`, and the script path. TypeScript preflight is always enabled. Return every created ID.

```ts
// callout-label.figma.ts
// Replace this literal with a fresh UUID before dispatch and retain it for reconciliation.
const runId = 'figjam-<fresh-uuid>'
const labelText = '1'
if (labelText.length === 0 || labelText.length > 2) throw new Error('A label holds one or two characters')

const label = figma.createShapeWithText()
label.setSharedPluginData('figma_workspace', 'run_id', runId)
label.shapeType = 'ELLIPSE'
const labelFont = label.text.fontName
if (labelFont === figma.mixed) throw new Error('Label text has mixed fonts')
await figma.loadFontAsync(labelFont)
label.text.characters = labelText

const size = labelText.length === 1 ? 48 : 64
label.resize(size, size)
label.text.fontSize = 20
label.fills = [{ type: 'SOLID', color: { r: 0x3d / 255, g: 0xad / 255, b: 0xff / 255 } }]
label.strokes = [{ type: 'SOLID', color: { r: 0 / 255, g: 0x7a / 255, b: 0xd2 / 255 } }]
label.text.fills = [{ type: 'SOLID', color: { r: 1, g: 1, b: 1 } }]
label.x = 120
label.y = 120
label.name = `Callout ${labelText}`

return { runId, createdNodeIds: [label.id], label: { id: label.id, text: label.text.characters, size } }
```

Execute `npm --silent run figma:run -- --file <figjam-file-url-or-key> --surface figjam --script <path/to/script.figma.ts>` after saving the reviewed script.

## Plugin API rules

- Labels use `figma.createShapeWithText()` followed by `shapeType = 'ELLIPSE'`.
- Load `label.text.fontName` before changing `label.text.characters` or text styling. Shape text commonly defaults to Inter Medium; do not substitute an assumed family/style when editing existing labels.
- Keep width and height equal. Use 48 by 48 for one character and 64 by 64 for two characters; fixed dimensions preserve the circular marker.
- Assign fill, stroke, and text fills together. Colors are normalized 0-1 values, so use `hex / 255` for palette-exact values.

## Verify and troubleshoot

Return the ID, text, dimensions, and position. In a read-only script, verify `type === 'SHAPE_WITH_TEXT'`, `shapeType === 'ELLIPSE'`, the text, and `width === height`; capture the diagram area when alignment with its target matters and inspect the image locally.

Generate and retain a unique `runId` before dispatch. Immediately after `createShapeWithText()`, tag the label with shared PluginData namespace `figma_workspace` and key `run_id`, before reading fonts, awaiting, or applying later properties, and return the same `runId` and ID. A fatal TypeScript preflight diagnostic reports `not_started` and can be repaired before rerunning. A text-write or unloaded-font failure occurs after dispatch and reports `outcome_unknown`; follow `retryGuidance`, query the exact retained run tag, and reconcile the label before any write. If the result is oval, one dimension was changed independently; call `resize(size, size)`. If the content exceeds two characters, use a standard shape-with-text rather than shrinking unreadable label text.
