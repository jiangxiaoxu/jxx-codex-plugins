# Figma Workspace Guidance And Lookup Reference

Use this reference to choose between `figma:guidance`, `figma:docs:catalog`, `figma:docs:search`, `figma:docs:read`, and `figma:api:search`. CLI help and runtime schemas define the public contract.

## English Intent Routing

- Compress user intent to concise English canonical keywords before guidance or automatic docs search. The route catalog contains English aliases only; it does not translate Chinese or other non-English queries.
- The stable families are `code-connect`, `create-file`, `design-to-code`, `design-generation`, `diagram`, `library-generation`, `motion-implementation`, `swiftui`, `figjam`, `motion`, `slides`, and `design-editing`.
- Pass a known `--surface design|figjam|slides`. Surface is a hard filter: a FigJam or Slides request does not fall back to Design-only material.
- A matched exact alias can be high confidence; a unique multi-token match is medium; generic, ambiguous, surface-less, non-English, and out-of-vocabulary input is low or none. Ambiguity returns candidate families, router context, and a catalog next action instead of broadening to all docs.

## Guidance First

```text
npm --silent run figma:guidance -- "text font loadFontAsync" --surface design --state-file C:/work/project/.figma-workspace/state.json
```

- Guidance returns a compact typed DTO: `route`, cards, `queryHints`, Plugin API references, helper/wrapper/workflow summaries, up to two reference contexts, and typed `nextActions`.
- Each next action has a public npm `commandId`, validated arguments, a reason, and a priority. Do not use or repeat internal operation names or raw transport commands.
- API references use `displayExpression`, `lookupQuery`, optional `ownerHint`, and `symbolKind`. Send `lookupQuery` directly to `figma:api:search`.
- Use `--workflow <id>` only with an ID returned by guidance. Unknown IDs are usage errors.
- Guidance may identify the two injected helpers, `$.text` and `$.capture`. `$` is a frozen, non-callable namespace, and no helper-selection analysis is required.
- Treat generated help as the input contract for every action returned by guidance. JSON commands reject unknown fields, and direct commands reject unknown options with usage exit 2 rather than silently accepting an approximate invocation.

## Docs Catalog, Search, And Read

```text
npm --silent run figma:docs:list -- --state-file C:/work/project/.figma-workspace/state.json
npm --silent run figma:docs:catalog -- --task-family slides --surface slides --state-file C:/work/project/.figma-workspace/state.json
npm --silent run figma:docs:read -- canonical:<record-id> --state-file C:/work/project/.figma-workspace/state.json
npm --silent run figma:docs:search -- "slide layout content" --surface slides --state-file C:/work/project/.figma-workspace/state.json
```

- `figma:docs:list` returns only project-doc IDs in the `project:<topic>` namespace.
- `figma:docs:catalog` without `--task-family` returns 12 task-family summaries. With a family it returns canonical records, optionally filtered by surface, classification, and limit. Catalog record IDs use `canonical:<record-id>`.
- `figma:docs:read` accepts only IDs returned by list or catalog. It rejects bare topics, file paths, traversal, chunk IDs, old source IDs, and case mistakes. It reads complete project, active, conditional, router, or examples documents; examples are marked non-executable. Large documents use a sidecar instead of truncation.
- `figma:docs:search` defaults to `--scope auto`. With a matched route it searches project/bridge docs plus compatible active, conditional, and router records in that family. With no route it searches only surface-compatible active records at low confidence. Examples never enter auto; request `--scope examples` explicitly when examples are required.
- Explicit `--scope active|conditional|router|examples|all` is strict. `--surface` and `--task-family` remain hard filters for every scope.
- Search payloads contain compact public document metadata, line range, match type, confidence, and a byte-limited snippet. They never expose corpus text, hashes, source paths, or chunk data.

## Plugin API Lookup

```text
npm --silent run figma:api:search -- createFrame --state-file C:/work/project/.figma-workspace/state.json
npm --silent run figma:api:search -- figma.createFrame() --state-file C:/work/project/.figma-workspace/state.json
npm --silent run figma:api:search -- figma.variables.createVariableCollection --state-file C:/work/project/.figma-workspace/state.json
```

- The generated v2 API index records the declaration symbol, owner symbol, declaration kind, and deterministic qualified aliases.
- Exact lookup is case-sensitive. Direct qualified aliases and direct owners win. A known API-type qualifier may fall back to a bare exact symbol with `ownerMatch: false`; an unknown qualifier is not blindly stripped.
- API search results are compact declaration metadata and snippets, not full typings or internal index records.
