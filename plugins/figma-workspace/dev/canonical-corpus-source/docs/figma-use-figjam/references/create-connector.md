# Connectors in FigJam

Use a connector to express a relationship or flow between existing FigJam nodes. Prefer attached endpoints over manually drawn floating lines: attached connectors stay meaningful when the nodes move. Use floating endpoints only when the line intentionally has no owner.

## Script-first workflow

Create or update connectors in a local `.figma.ts` file, then execute it using `figma:run` with an explicit FigJam file target, `--surface figjam`, and the script path. TypeScript preflight is always enabled. Keep the returned IDs for inspection and later edits.

```ts
// flow-connector.figma.ts
// Replace this literal with a fresh UUID before dispatch and retain it for reconciliation.
const runId = 'figjam-<fresh-uuid>'
const startId = '<source-node-id>'
const endId = '<target-node-id>'
const start = await figma.getNodeByIdAsync(startId)
const end = await figma.getNodeByIdAsync(endId)
if (!start || !end) throw new Error('Both connector endpoints must exist')

const font: FontName = { family: 'Inter', style: 'Medium' }
await figma.loadFontAsync(font)

const connector = figma.createConnector()
connector.setSharedPluginData('figma_workspace', 'run_id', runId)
connector.connectorStart = { endpointNodeId: start.id, magnet: 'RIGHT' }
connector.connectorEnd = { endpointNodeId: end.id, magnet: 'LEFT' }
connector.connectorLineType = 'ELBOWED'
connector.connectorStartStrokeCap = 'NONE'
connector.connectorEndStrokeCap = 'ARROW_LINES'
connector.strokes = [{ type: 'SOLID', color: { r: 0x3d / 255, g: 0xad / 255, b: 0xff / 255 } }]
connector.text.fontName = font
connector.text.characters = 'approves'

return { runId, createdNodeIds: [connector.id], connector: { id: connector.id, start: start.id, end: end.id } }
```

Run it with `npm --silent run figma:run -- --file <figjam-file-url-or-key> --surface figjam --script <path/to/script.figma.ts>` after saving the reviewed script.

## API choices

- Attached endpoints use `{ endpointNodeId, magnet }`; common magnets are `AUTO`, `TOP`, `BOTTOM`, `LEFT`, `RIGHT`, `CENTER`, and `NONE`. `AUTO` is the safe default.
- A floating endpoint uses `{ position: { x, y } }`. An attached endpoint may instead specify a relative `{ position: { x, y } }` from 0 to 1.
- `connectorLineType` accepts `ELBOWED`, `STRAIGHT`, or `CURVED`. Endpoint caps include `NONE`, `ARROW_LINES`, `ARROW_EQUILATERAL`, `TRIANGLE_FILLED`, `DIAMOND_FILLED`, and `CIRCLE_FILLED`.
- Visible label text is `connector.text.characters`, never `connector.name`. A newly created connector has no usable text font: load a known font, assign `connector.text.fontName`, then assign characters.
- Set line color through `strokes`, and use `strokeWeight` or `dashPattern` for emphasis. Changing `strokes` does not recolor the label.

## Verify and recover

Return the connector and endpoint IDs. A read-only follow-up script can check `type`, `connectorStart`, `connectorEnd`, caps, and `text.characters`; use `attachedConnectors` on either endpoint when auditing an existing flow. Capture the affected region when route direction or label placement matters, then inspect that image locally.

Generate and retain a unique `runId` before dispatch; immediately after `createConnector()` tag it with shared PluginData namespace `figma_workspace` and key `run_id`, before endpoint or text setters can throw, and return the same `runId`, connector ID, and endpoint IDs. An unloaded-font error occurs during dispatched runtime execution and therefore reports `outcome_unknown`; do not load `connector.text.fontName` from a new connector, because it is not usable until assigned. Follow `retryGuidance`, query the exact retained run tag, and reconcile the connector and endpoints; set a known font or `magnet: 'AUTO'` only when readback confirms that work is missing. A fatal TypeScript preflight diagnostic reports `not_started`; fix that file and rerun rather than issuing a cleanup mutation.
