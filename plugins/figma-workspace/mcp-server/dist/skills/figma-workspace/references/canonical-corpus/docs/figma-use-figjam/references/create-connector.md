# Connectors in FigJam

Use a connector to express a relationship or flow between existing FigJam nodes. Prefer attached endpoints over manually drawn floating lines: attached connectors stay meaningful when the nodes move. Use floating endpoints only when the line intentionally has no owner.

## Script-first workflow

Create or update connectors in a local `.figma.ts` task file, then execute it using `figma:script:run` with `strict: true`, a persisted session ID, `surface: "figjam"`, and an absolute `--state-file`. Keep the returned IDs for inspection and later edits. `figma:eval` is appropriate only for a single, bounded transaction.

```ts
// flow-connector.figma.ts
const startId = '<source-node-id>'
const endId = '<target-node-id>'
const start = await figma.getNodeByIdAsync(startId)
const end = await figma.getNodeByIdAsync(endId)
if (!start || !end) throw new Error('Both connector endpoints must exist')

const font: FontName = { family: 'Inter', style: 'Medium' }
await figma.loadFontAsync(font)

const connector = figma.createConnector()
connector.connectorStart = { endpointNodeId: start.id, magnet: 'RIGHT' }
connector.connectorEnd = { endpointNodeId: end.id, magnet: 'LEFT' }
connector.connectorLineType = 'ELBOWED'
connector.connectorStartStrokeCap = 'NONE'
connector.connectorEndStrokeCap = 'ARROW_LINES'
connector.strokes = [{ type: 'SOLID', color: { r: 0x3d / 255, g: 0xad / 255, b: 0xff / 255 } }]
connector.text.fontName = font
connector.text.characters = 'approves'

return { createdNodeIds: [connector.id], connector: { id: connector.id, start: start.id, end: end.id } }
```

Run it with `npm --silent run figma:script:run -- --input <run-json> --state-file <absolute-path>`. The input JSON contains `sessionId`, `inputFile`, `strict: true`, and `surface: "figjam"`.

## API choices

- Attached endpoints use `{ endpointNodeId, magnet }`; common magnets are `AUTO`, `TOP`, `BOTTOM`, `LEFT`, `RIGHT`, `CENTER`, and `NONE`. `AUTO` is the safe default.
- A floating endpoint uses `{ position: { x, y } }`. An attached endpoint may instead specify a relative `{ position: { x, y } }` from 0 to 1.
- `connectorLineType` accepts `ELBOWED`, `STRAIGHT`, or `CURVED`. Endpoint caps include `NONE`, `ARROW_LINES`, `ARROW_EQUILATERAL`, `TRIANGLE_FILLED`, `DIAMOND_FILLED`, and `CIRCLE_FILLED`.
- Visible label text is `connector.text.characters`, never `connector.name`. A newly created connector has no usable text font: load a known font, assign `connector.text.fontName`, then assign characters.
- Set line color through `strokes`, and use `strokeWeight` or `dashPattern` for emphasis. Changing `strokes` does not recolor the label.

## Verify and recover

Return the connector and endpoint IDs. A read-only follow-up script can check `type`, `connectorStart`, `connectorEnd`, caps, and `text.characters`; use `attachedConnectors` on either endpoint when auditing an existing flow. Capture the affected region when route direction or label placement matters, then inspect that image locally.

If a label write says a font is unloaded, do not load `connector.text.fontName` from a new connector; explicitly load and assign a known `FontName` first. If endpoint attachment fails, confirm the IDs resolve in the active page and retry with `magnet: 'AUTO'`. If strict preflight rejects the script, fix that file and rerun rather than issuing a cleanup mutation.
