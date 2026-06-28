# Figma Workspace Guidance And Lookup Reference

Use this reference to choose between `figma_workspace_guidance` and `figma_workspace_lookup`. Runtime MCP resources and tool schemas remain the source of truth for public contracts.

## Guidance First

- Before writing `.figma.js`, call `figma_workspace_guidance({ query })` with compact BM25-style keywords, not natural-language task prose.
- Use its `recommendedCards`, `queryHints`, `apiSymbols`, `guardrails`, and `referenceContext` fields to choose the next tool or API symbols.
- Use `helperProfiles` when returned for `$` helper category choice, static-reference patterns, avoid notes, lookup hints, and compact examples.
- Use `wrapperProfiles` and `workflowGraph` when returned to sequence first-class design-context, motion, video, or shader wrappers.
- Wrapper outputs may include `guidanceRef`; pass its compact `query` to `figma_workspace_guidance` when full wrapper profile details are needed.
- Common anchors are text/font, auto layout, variables/tokens, styles, components/variants, instances/properties, images/fills, selection, capture/QA, and FigJam/Slides.
- Treat `guardrails` as task-specific risk notes before modifying a file.
- `$` helper references must be static: use `$.helper(...)`, `$["helper"](...)`, or explicit destructuring. Avoid dynamic `$[name]`, aliasing `$`, object rest destructuring, and local `$` declarations.
- For implementation from Figma, visual parity review, motion, or Code Connect tasks, use the dedicated guidance cards. They route covered official context through first-class wrappers such as `figma_workspace_get_design_context` and `figma_workspace_get_motion_context`, keep uncovered official capabilities behind `figma_workspace_call_upstream_tool`, use `figma_workspace_capture_node` for local screenshot QA, and keep project-side work in local files instead of upstream agent markdown.

## Lookup When Exact Context Is Needed

- Use `figma_workspace_lookup({ kind: "docs", query })` for compact BM25-ranked workflow snippets and bridge-owned explanations for `guidanceRef`, wrapper profiles, helper profiles, and workflow graph routing.
- Use `figma_workspace_lookup({ kind: "api", symbol })` for exact Figma Plugin API symbols.
- Lookup output is capped and confidence-labeled.
- `figma-workspace://lookup-index` exposes compact helper categories, wrapper profiles, and workflow graph nodes; use them instead of reading internal corpus files for sequencing.
- Bundled `upstream-corpus/manifest.json` and `upstream-corpus/corpus.jsonl` files are internal lookup data and should not be routed to agents as documents.

## API Cards

- API cards are curated by the runtime guidance catalog.
- Use cards for common intent mapping, then narrow with `queryHints` or exact `apiSymbols`.
- Do not read or duplicate full declaration files; use lookup snippets for exact symbols.
