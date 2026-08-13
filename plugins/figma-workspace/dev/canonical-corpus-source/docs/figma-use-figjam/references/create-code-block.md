# Code blocks in FigJam

Use a code block when the board needs a readable, syntax-highlighted snippet: an API contract, a query, a short configuration example, or a discussion point for a technical workshop. A code block is a FigJam-only `CODE_BLOCK` node, not a `TEXT` node with a monospace font. Use ordinary text for prose around the snippet.

## Prepare a repairable script

For board edits, create a local `.figma.ts` file in the shell and run it through `figma:run` with an explicit FigJam target. The script body supports top-level `await` and must `return` useful node IDs; `console.log()` is not a result channel.

```ts
// <local-script-dir>/figjam-code.figma.ts
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

Run the prepared file with its explicit FigJam file target, `--surface figjam`, and script path. TypeScript preflight is always enabled:

```powershell
npm --silent run figma:run -- --file <figjam-file-url-or-key> --surface figjam --script <path/to/script.figma.ts>
```

```text
npm --silent run figma:run -- --file <figjam-file-url-or-key> --surface figjam --script <path/to/script.figma.ts>
```

Use the same command for this reviewed script.figma.ts` file.

## Plugin API facts

- Create the node with `figma.createCodeBlock()`. It is automatically attached to the current page.
- Set `code` and an uppercase `codeLanguage`. Supported values are `TYPESCRIPT`, `JAVASCRIPT`, `PYTHON`, `GO`, `RUST`, `RUBY`, `CSS`, `HTML`, `JSON`, `GRAPHQL`, `SQL`, `SWIFT`, `KOTLIN`, `CPP`, `BASH`, and `PLAINTEXT`.
- Use `PLAINTEXT` when the requested language is not on that list. FigJam owns the code block theme; there is no color or font-theme API to recreate it.
- To place a block in a `SECTION`, find the intended `SECTION`, call `section.appendChild(block)`, then use coordinates in that parent's coordinate space.

## Verify before continuing

Return the node ID, language, and final position. In a follow-up read-only script, confirm `node.type === 'CODE_BLOCK'`, `node.code`, and `node.codeLanguage`; capture the relevant board area when visual wrapping or placement matters. Check the capture locally before declaring visual success.

## Common failures

- `createCodeBlock` fails: the explicit target is not a FigJam board. This API is unavailable in Design files.
- Highlighting is absent: use one of the exact uppercase language values, otherwise deliberately choose `PLAINTEXT`.
- The block obscures existing work: calculate a clear page-level anchor before creation, or append to the destination section before setting coordinates.
- Give the code block a deterministic operation-specific name and return its ID. A fatal TypeScript preflight diagnostic reports `executionOutcome: "not_started"`; repair the same local `.figma.ts` file and rerun. For `failed_atomic`, retain the direct host/script diagnostics, repair the script, and retry safely because Figma confirmed no file changes. For any `outcome_unknown`, follow `retryGuidance`, inspect returned IDs first, then narrowly read back the expected code block name, language, parent, and bounds before any retry or cleanup. Shared PluginData is only an optional, host-verified supplement.
