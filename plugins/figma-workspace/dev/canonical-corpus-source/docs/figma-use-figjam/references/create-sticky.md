# Sticky notes in FigJam

Use a sticky for a single idea, response, observation, or piece of workshop input. Do not turn prompts, instructions, or fixed board navigation into stickies: those are structural text or shapes. One sticky should express one thought.

## Create through a repairable script

Put the operation in a local `.figma.ts` task file, then invoke `figma:script:run` with a JSON input containing `sessionId`, `inputFile`, and `surface: "figjam"`; provide an absolute `--state-file`. TypeScript preflight is always enabled. Return the sticky IDs and the dimensions observed after writing text. `figma:eval` is only a small-transaction exception.

```ts
// research-note.figma.ts
// Replace this literal with a fresh UUID before dispatch and retain it for reconciliation.
const runId = 'figjam-<fresh-uuid>'
const sticky = figma.createSticky()
sticky.setSharedPluginData('figma_workspace', 'run_id', runId)
const stickyFont = sticky.text.fontName
if (stickyFont === figma.mixed) throw new Error('Sticky text has mixed fonts')
await figma.loadFontAsync(stickyFont)
sticky.text.characters = 'Interview participants want a visible progress indicator.'
sticky.fills = [{ type: 'SOLID', color: { r: 0xff / 255, g: 0xe2 / 255, b: 0x99 / 255 } }]
sticky.x = 160
sticky.y = 140
sticky.name = 'Research insight'

return {
  runId,
  createdNodeIds: [sticky.id],
  sticky: { id: sticky.id, text: sticky.text.characters, width: sticky.width, height: sticky.height, wide: sticky.isWideWidth },
}
```

Run `npm --silent run figma:script:run -- --input <run-json> --state-file <absolute-path>` after saving the file.

## Plugin API facts

- `figma.createSticky()` creates a FigJam `STICKY`; load `sticky.text.fontName` and await it before changing `sticky.text.characters`.
- Apply a palette fill through `fills`. Color components are normalized, so write exact palette values as `hex / 255`, for example yellow `#FFE299` is `0xff / 255`, `0xe2 / 255`, `0x99 / 255`.
- Stickies cannot use `resize()`. Their width is selected by `isWideWidth`: square is normally 240 by 240, wide is normally 416 by 240. Text can grow their actual height, so read the height after assigning content.
- Keep `authorVisible` enabled unless the request specifically asks to hide the author label.

## Batch layout example

For multiple notes, create and populate all stickies first, then position them from their actual dimensions. This prevents overlap when one note grows taller.

```ts
// Replace this literal with a fresh UUID before dispatch and retain it for reconciliation.
const runId = 'figjam-<fresh-uuid>'
const ideas = ['Clarify onboarding', 'Test progress cue', 'Measure drop-off']
const notes: StickyNode[] = []
for (const idea of ideas) {
  const note = figma.createSticky()
  note.setSharedPluginData('figma_workspace', 'run_id', runId)
  const noteFont = note.text.fontName
  if (noteFont === figma.mixed) throw new Error('Sticky text has mixed fonts')
  await figma.loadFontAsync(noteFont)
  note.text.characters = idea
  notes.push(note)
}
let x = 120
for (const note of notes) {
  note.x = x
  note.y = 420
  x += note.width + 64
}
return { runId, createdNodeIds: notes.map((note) => note.id), heights: notes.map((note) => note.height) }
```

## Verify and common failures

Use a read-only script to verify `type === 'STICKY'`, text, fill, `isWideWidth`, and final dimensions. Capture a completed cluster or section and inspect the local image when spacing and visual hierarchy matter.

Generate and retain a unique `runId` before dispatch. Every created sticky must immediately call `setSharedPluginData('figma_workspace', 'run_id', runId)` before reading fonts, awaiting, or applying other properties, and the result must return the same `runId` and IDs. A fatal TypeScript diagnostic is preflight and reports `not_started`. An unloaded-font error occurs during dispatched runtime execution and therefore reports `outcome_unknown`; follow `retryGuidance`, query shared PluginData namespace `figma_workspace` and key `run_id` for the exact retained value, and reconcile partial or complete board edits before deciding whether work remains. If batch notes overlap, their positions were based on assumed 240px heights or set before every note was populated; perform the two passes. If the content is instructional rather than an idea, replace the sticky with board text or a shape.
