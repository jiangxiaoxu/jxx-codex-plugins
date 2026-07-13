# Figma Workspace Guidance And Lookup Reference

Use this reference to choose between `figma:guidance`, `figma:docs:search`, and `figma:api:search`. Command help and runtime schemas are the source of truth for public contracts.

## Guidance First

- Before writing `.figma.ts`, call `figma:guidance -- <query>` using compact BM25-style keywords, not natural-language task prose. Use `--card-limit` to bound returned cards.
- Use its `recommendedCards`, `queryHints`, `apiSymbols`, `guardrails`, and `suggestions.referenceContext` fields to choose the next tool or API symbols.
- Use `helperProfiles` when returned for `$` helper category choice, static-reference patterns, avoid notes, lookup hints, and compact examples.
- Use `wrapperProfiles` and `workflowGraph` when returned to sequence first-class design-context, motion, or video wrappers.
- Wrapper outputs may include `guidanceRef`; pass its compact `query` to `figma:guidance` when full wrapper profile details are needed.
- Common anchors are text/font, auto layout, variables/tokens, styles, components/variants, instances/properties, images/fills, selection, capture/QA, and FigJam/Slides.
- Treat `guardrails` as task-specific risk notes before modifying a file.
- `$` helper references must be static: use `$.helper(...)`, `$["helper"](...)`, or explicit destructuring. Avoid dynamic `$[name]`, aliasing `$`, object rest destructuring, and local `$` declarations.
- For visible audit markers or temporary verification labels, use guidance/lookup plus metadata or inspect results to place them outside the reviewed frame or in a confirmed free slot before capture.
- For implementation from Figma, visual parity review, motion, or Code Connect tasks, use the dedicated guidance cards. They route covered official context through `figma:design-context` and `figma:motion-context`, keep uncovered official capabilities behind `figma:upstream:call`, use `figma:capture` for local screenshot QA, and keep project-side work in local files.

## Lookup When Exact Context Is Needed

- Use `figma:docs:search -- <query>` for compact BM25-ranked project documentation and upstream workflow snippets, including runtime-owned explanations for `guidanceRef`, wrapper profiles, helper profiles, and workflow graph routing.
- Use `figma:api:search -- <symbol>` for exact Figma Plugin API symbols. Both search commands accept `--limit` and `--snippet-lines`.
- Lookup output is capped and confidence-labeled.
- Project documentation topics cover overview, workflow, guidance and lookup, safety, diagnostics, sessions, and upstream tools.
- `figma:guidance` exposes compact helper categories, wrapper profiles, and workflow graph nodes; use it instead of reading internal corpus files for sequencing.
- Bundled `upstream-corpus/manifest.json` and `upstream-corpus/corpus.jsonl` files are internal lookup data and should not be routed to agents as documents.

## Reading Results

- The guidance and search commands emit Restricted Markdown on stdout with a command title, `Input`, explicit status, and expanded fields.
- These stateless commands intentionally omit `--state-file`. Use `--max-inline-bytes` to control inline output; any sidecar uses the default `<plugin-root>/.figma-workspace/results/` directory.
- Cards, hints, symbols, snippets, and other complex nested values may appear in fenced `json` blocks inside the Markdown result.
- Typed failures still emit Markdown and normally exit 1; an unhealthy doctor observation is the exit-0 exception. Usage exits 2, typed interrupts exit 130, and thrown failures are text on stderr.
- Do not use `JSON.parse(stdout)`. Read the Markdown result and parse only a specific fenced `json` block when necessary.

## API Cards

- API cards are curated by the runtime guidance catalog.
- Use cards for common intent mapping, then narrow with `queryHints` or exact `apiSymbols`.
- Do not read or duplicate full declaration files; use lookup snippets for exact symbols.
