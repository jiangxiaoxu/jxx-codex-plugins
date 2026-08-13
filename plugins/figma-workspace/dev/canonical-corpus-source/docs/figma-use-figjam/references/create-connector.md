# Connectors in FigJam

Use a connector to express a relationship or flow between existing FigJam nodes. Prefer attached endpoints over manually drawn floating lines: attached connectors stay meaningful when the nodes move. Use floating endpoints only when the line intentionally has no owner.

## Script-first workflow

Create or update connectors in a local `.figma.ts` file, then execute it using `figma:run` with an explicit FigJam file target, `--surface figjam`, and the script path. TypeScript preflight is always enabled. Keep the returned IDs for inspection and later edits.

Keep a mutating script to one board page and one narrow transaction. For cross-page work, fan out separate read-only calls after explicit page discovery, then run separate per-page mutations; the runtime serializes applicable same-machine calls by `fileKey`.

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
connector.name = 'Approves connector'
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

Run it with `npm --silent run figma:run -- --file <figjam-file-url-or-key> --surface figjam --script <path/to/script.figma.ts>` after saving the reviewed script.

## API choices

- Attached endpoints use `{ endpointNodeId, magnet }`; common magnets are `AUTO`, `TOP`, `BOTTOM`, `LEFT`, `RIGHT`, `CENTER`, and `NONE`. `AUTO` is the safe default.
- A floating endpoint uses `{ position: { x, y } }`. An attached endpoint may instead specify a relative `{ position: { x, y } }` from 0 to 1.
- `connectorLineType` accepts `ELBOWED`, `STRAIGHT`, or `CURVED`. Endpoint caps include `NONE`, `ARROW_LINES`, `ARROW_EQUILATERAL`, `TRIANGLE_FILLED`, `DIAMOND_FILLED`, and `CIRCLE_FILLED`.
- Visible label text is `connector.text.characters`, never `connector.name`. A newly created connector has no usable text font: load a known font, assign `connector.text.fontName`, then assign characters.
- Set line color through `strokes`, and use `strokeWeight` or `dashPattern` for emphasis. Changing `strokes` does not recolor the label.

## Verify and recover

Return the connector and endpoint IDs. A read-only follow-up script can check `type`, `connectorStart`, `connectorEnd`, caps, and `text.characters`; use `attachedConnectors` on either endpoint when auditing an existing flow. Capture the affected region when route direction or label placement matters, then inspect that image locally.

Return the connector and endpoint IDs and give the connector its deterministic operation-specific name immediately after creation. Missing runtime endpoint references, unloaded fonts, and invalid runtime property values occur inside the host script after dispatch; use the returned outcome and documented failure presentation, never label them `not_started`. Do not load `connector.text.fontName` from a new connector, because it is not usable until assigned. For an `outcome_unknown` result, follow `retryGuidance`, inspect returned IDs first, then narrowly read back the named connector, endpoint IDs, and expected relationship; set a known font or `magnet: 'AUTO'` only when readback confirms that work is missing. Shared PluginData is only an optional, host-verified supplement. A fatal TypeScript preflight diagnostic reports `not_started`; fix that file and rerun rather than issuing a cleanup mutation.
