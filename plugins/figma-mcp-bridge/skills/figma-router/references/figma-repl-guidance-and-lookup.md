# Figma REPL Guidance And Lookup Reference

Use this reference to choose between `figma_repl_guidance` and `figma_repl_lookup`. Runtime MCP resources and tool schemas remain the source of truth for public contracts.

## Guidance First

- For natural-language tasks, call `figma_repl_guidance` before writing `.figma.js`.
- Use its `recommendedCards`, `queryHints`, `apiSymbols`, `avoid`, and `referenceContext` fields to choose the next tool or API symbols.
- Common anchors are text/font, auto layout, variables/tokens, styles, components/variants, instances/properties, images/fills, selection, capture/QA, and FigJam/Slides.
- Treat `avoid` as task-specific guardrails before modifying a file.

## Lookup When Exact Context Is Needed

- Use `figma_repl_lookup({ kind: "docs", query })` for compact BM25-ranked workflow snippets.
- Use `figma_repl_lookup({ kind: "api", symbol })` for exact Figma Plugin API symbols.
- Lookup output is capped and confidence-labeled.
- Bundled corpus files are internal lookup data and should not be routed to agents as documents.

## API Cards

- API cards are curated by the runtime guidance catalog.
- Use cards for common intent mapping, then narrow with `queryHints` or exact `apiSymbols`.
- Do not read or duplicate full declaration files; use lookup snippets for exact symbols.
