# Figma REPL Guidance And Lookup Reference

Use this reference to choose between `figma_repl_guidance` and `figma_repl_lookup`. Runtime MCP resources and tool schemas remain the source of truth for public contracts.

## Guidance First

- Before writing `.figma.js`, call `figma_repl_guidance({ query })` with compact BM25-style keywords, not natural-language task prose.
- Use its `recommendedCards`, `queryHints`, `apiSymbols`, `guardrails`, and `referenceContext` fields to choose the next tool or API symbols.
- Use `wrapperProfiles` and `workflowGraph` when returned to sequence first-class design-context, motion, video, or shader wrappers.
- Common anchors are text/font, auto layout, variables/tokens, styles, components/variants, instances/properties, images/fills, selection, capture/QA, and FigJam/Slides.
- Treat `guardrails` as task-specific risk notes before modifying a file.
- For implementation from Figma, visual parity review, motion, or Code Connect tasks, use the dedicated guidance cards. They route covered official context through first-class wrappers such as `figma_repl_get_design_context` and `figma_repl_get_motion_context`, keep uncovered official capabilities behind `figma_repl_call_upstream_tool`, use `figma_repl_capture_node` for local screenshot QA, and keep project-side work in local files instead of upstream agent markdown.

## Lookup When Exact Context Is Needed

- Use `figma_repl_lookup({ kind: "docs", query })` for compact BM25-ranked workflow snippets.
- Use `figma_repl_lookup({ kind: "api", symbol })` for exact Figma Plugin API symbols.
- Lookup output is capped and confidence-labeled.
- `figma-repl://lookup-index` exposes compact wrapper profiles and workflow graph nodes; use them instead of reading internal corpus files for wrapper sequencing.
- Bundled `upstream-corpus/manifest.json` and `upstream-corpus/corpus.jsonl` files are internal lookup data and should not be routed to agents as documents.

## API Cards

- API cards are curated by the runtime guidance catalog.
- Use cards for common intent mapping, then narrow with `queryHints` or exact `apiSymbols`.
- Do not read or duplicate full declaration files; use lookup snippets for exact symbols.
