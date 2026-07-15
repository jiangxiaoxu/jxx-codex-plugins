# Figma Workspace CLI Package

This private Node package is the typechecked runtime behind the Figma Workspace plugin-root npm commands. It keeps official Figma remote MCP access behind the CLI transport and does not expose a local MCP server.

## Build And Validate

```bash
npm install
npm run build
npm run typecheck
npm test
```

The build stages project documentation and the canonical corpus into checked-in `dist/`, then generates the Plugin API symbol index. Run `npm run check:dist` only from a clean checkout or CI because it asserts generated-output cleanliness.

## Public Command Contract

Agents invoke the plugin-root scripts, not this package directly. The public contract has 18 direct query/read commands, 9 JSON commands, and 22 raw transport commands behind `figma:raw`.

- Direct commands include `figma:guidance`, `figma:docs:list`, `figma:docs:catalog`, `figma:docs:read`, `figma:docs:search`, and `figma:api:search`.
- JSON commands use only `--input <json-file|->`, `--state-file <absolute-path>`, `--max-inline-bytes <bytes>`, and help.
- Every optimized command requires a fully qualified absolute `--state-file`; its parent owns the `results/` sidecar directory.
- Typed results render Restricted Markdown. They are not JSON. Oversized complete results use `outputFiles.cliResultFile`.

`figma:eval` and `figma:script:run` expose a frozen, non-callable `$` namespace with two helpers only. `await $.text({ target?, parent?, text, font? })` creates or updates text after loading an explicit font, or rejects mixed-font text without one. `await $.capture(target, options?)` queues at most 8 compact requests; after successful script execution the host reuses the `figma:capture` implementation, writes local PNG files, and returns compact results under `captures[]`. Capture tickets never return image bytes or a local path inside the running script.

The script runtime uses TypeScript and bundled Plugin API typings as preflight, without semantic AST policy for valid Plugin API calls. It continues to enforce the 50,000-byte wrapped payload limit, state/session and workspace path validation, capture envelope and PNG validation, inline-result/sidecar limits, and atomic local writes.

Use `npm --silent` and a command's generated `--help` as the public usage source. Agent-facing values must use public `figma:*` command IDs, never internal `figma_workspace_*` operation IDs or raw transport command names.

## Document And Guidance Routing

`guidance` and `docs:search --scope auto` share the strict route catalog. The catalog has 12 English-only task families: `code-connect`, `create-file`, `design-to-code`, `design-generation`, `diagram`, `library-generation`, `motion-implementation`, `swiftui`, `figjam`, `motion`, `slides`, and `design-editing`.

Callers should use concise English canonical keywords. Non-English, generic, ambiguous, and out-of-vocabulary queries receive low or no confidence; routing does not translate them or select unrelated high-confidence cards. Surface is a hard filter and is never silently broadened from FigJam or Slides to Design.

- `docs:list` emits `project:<topic>` IDs.
- `docs:catalog` emits task-family summaries or canonical `canonical:<record-id>` records and accepts family, surface, classification, and limit filters.
- `docs:read` accepts only `project:` and `canonical:` IDs returned by the two listing commands. It reads full content after manifest/hash validation and sends large content to a sidecar.
- `docs:search` defaults to `auto`. A resolved route searches only project/bridge docs and compatible active, conditional, and router records in the family. Examples are never automatic; request `--scope examples` explicitly. Explicit scopes and surface/family options remain strict hard filters.
- Public guidance and search results use compact metadata, snippets, route data, and typed next actions. They do not leak canonical-record text, hashes, source paths, JSONL fields, or raw transport names.

## Canonical Corpus And Plugin API Index

The staged canonical-corpus v2 manifest contains the current content-addressed records and route catalog. Records publish classification, surfaces, task family, mapping profile, title, summary, provenance, hash, and content fields. Invalid schema, metadata, routes, or hashes fail closed. The 87-record corpus has 46 active, 20 conditional, 12 router, and 9 non-executable example records.

The generated Plugin API index v2 is built from bundled `@figma/plugin-typings`. It records a declaration symbol, direct owner symbol, declaration kind, and deterministic qualified aliases. `api:search` accepts bare, qualified, and call-shaped symbols; exact match is case-sensitive, and unknown qualifiers are not blindly stripped.

Development snapshot files under `../dev/upstream-snapshot/` and `../dev/upstream-changes/` are not runtime or package inputs. `figma:doctor` diagnoses the staged corpus, generated API index, project docs, and TypeScript assets.
