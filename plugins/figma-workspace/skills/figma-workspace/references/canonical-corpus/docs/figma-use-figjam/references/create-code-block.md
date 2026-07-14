# Code blocks in FigJam

Use a code block when the board needs a readable, syntax-highlighted snippet: an API contract, a query, a short configuration example, or a discussion point for a technical workshop. A code block is a FigJam-only `CODE_BLOCK` node, not a `TEXT` node with a monospace font. Use ordinary text for prose around the snippet.

## Prepare a repairable script

For board edits, prepare a task workspace, edit the generated local `.figma.ts` file, and run it through `figma:script:run`. The script body supports top-level `await` and must `return` useful node IDs; `console.log()` is not a result channel.

```ts
// <workspace>/figjam-code/figjam-code.figma.ts
const existing = [...figma.currentPage.children]
const right = existing.length === 0
  ? 0
  : Math.max(...existing.map((node) => node.x + node.width))

const block = figma.createCodeBlock()
block.codeLanguage = 'TYPESCRIPT'
block.code = `type Ticket = { id: string; status: "open" | "closed" }`
block.x = right + 120
block.y = 120
block.name = 'Ticket type example'

return {
  createdNodeIds: [block.id],
  codeBlock: { id: block.id, language: block.codeLanguage, x: block.x, y: block.y },
}
```

Run the prepared file with JSON that names the persisted session, input file, FigJam surface, and strict preflight:

```powershell
npm --silent run figma:script:run -- --input .figma-workspace/run-code.json --state-file G:/work/project/.figma-workspace/state.json
```

```json
{"sessionId":"<persisted-session-id>","inputFile":"G:/work/project/.figma-workspace/figjam-code/figjam-code.figma.ts","strict":true,"surface":"figjam"}
```

`figma:eval` is only an exception for a small, one-off Plugin API transaction that does not merit a checked `.figma.ts` file.

## Plugin API facts

- Create the node with `figma.createCodeBlock()`. It is automatically attached to the current page.
- Set `code` and an uppercase `codeLanguage`. Supported values are `TYPESCRIPT`, `JAVASCRIPT`, `PYTHON`, `GO`, `RUST`, `RUBY`, `CSS`, `HTML`, `JSON`, `GRAPHQL`, `SQL`, `SWIFT`, `KOTLIN`, `CPP`, `BASH`, and `PLAINTEXT`.
- Use `PLAINTEXT` when the requested language is not on that list. FigJam owns the code block theme; there is no color or font-theme API to recreate it.
- To place a block in a `SECTION`, find the intended `SECTION`, call `section.appendChild(block)`, then use coordinates in that parent's coordinate space.

## Verify before continuing

Return the node ID, language, and final position. In a follow-up read-only script, confirm `node.type === 'CODE_BLOCK'`, `node.code`, and `node.codeLanguage`; capture the relevant board area when visual wrapping or placement matters. Check the capture locally before declaring visual success.

## Common failures

- `createCodeBlock` fails: the bound file is not a FigJam board. Use a FigJam session; this API is unavailable in Design files.
- Highlighting is absent: use one of the exact uppercase language values, otherwise deliberately choose `PLAINTEXT`.
- The block obscures existing work: calculate a clear page-level anchor before creation, or append to the destination section before setting coordinates.
- A script preflight error occurs: repair the same local `.figma.ts` file and rerun. Failed script runs are atomic, so do not create a compensating cleanup script.
