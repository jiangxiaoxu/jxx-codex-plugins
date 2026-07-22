# Figma Workspace CLI Package

This private Node package is the typechecked runtime behind the Figma Workspace plugin-root npm commands. It keeps official Figma remote MCP access behind the CLI transport and does not expose a local MCP server.

## Build And Validate

```bash
npm install
npm run build
npm run typecheck
npm test
```

The build stages project documentation and the canonical corpus into checked-in `dist/`, then generates the Plugin API symbol index. The package ships CLI/runtime artifacts only; it has no supported typed module facade. Run `npm run check:dist` only from a clean checkout or CI because it asserts generated-output cleanliness.

## Public Command Contract

Agents invoke the plugin-root scripts, not this package directly. The public contract has 18 direct query/read commands, 8 JSON commands, and 21 raw transport commands behind `figma:raw`.

- Direct commands include `figma:guidance`, `figma:docs:list`, `figma:docs:catalog`, `figma:docs:read`, `figma:docs:search`, and `figma:api:search`.
- JSON commands use only `--input <json-file|->`, `--state-file <absolute-path>`, `--max-inline-bytes <bytes>`, and help. Input objects reject unknown fields.
- Public command help includes the complete input schema. `--input -` reads stdin through both the canonical and independent npm entrypoints.
- Every optimized command requires a fully qualified absolute `--state-file`; its parent owns the `results/` sidecar directory.
- `figma:design-context`, `figma:motion-context`, and `figma:variables` require exactly one node source: a positional target or `--file` with a Figma URL containing `node-id`.
- Typed results render Restricted Markdown. They are not JSON. Oversized complete results use `outputFiles.cliResultFile`; their shared default inline budget is 4096 UTF-8 bytes.

`figma:eval` and `figma:script:run` expose a frozen, non-callable `$` namespace with two helpers only. `await $.text({ target?, parent?, text, font? })` creates or updates text after loading an explicit font, or rejects mixed-font text without one. `await $.capture(target, options?)` queues at most 8 compact requests; after successful script execution the host reuses the `figma:capture` implementation, writes local PNG files, and returns compact results under `captures[]`. Capture tickets never return image bytes or a local path inside the running script.

The script runtime uses TypeScript and bundled Plugin API typings as preflight, without semantic AST policy for valid Plugin API calls. `figma:eval` and `figma:script:run` return required `executionOutcome`: `not_started` before dispatch, `succeeded` after confirmed script completion, or `outcome_unknown` after dispatched work whose completion cannot be confirmed. Callers must inspect/readback/reconcile an unknown outcome before retrying a mutation. Queued capture processing can fail after `succeeded`; retry only the capture.

The runtime enforces the 50,000-byte wrapped payload limit, 256 KiB public JSON file/stdin and asset-manifest-file limit, 64-manifest-item limit, 16 MiB per upload/download/capture limit, 64 MiB aggregate command I/O limit, 5-minute total deadline, 60-second idle deadline, state/session and workspace validation, capture envelope/PNG validation, inline-result/sidecar limits, and atomic local writes. Managed workspace paths reject symbolic links, junctions, and reparse-point traversal. State is the strict `{ "schemaVersion": 1, "sessions": [...] }` envelope; old array state files fail closed.

The separate OAuth bridge accepts a 512 KiB MCP request body and a 64 MiB bridge response. Those bridge transport limits do not widen the public CLI JSON or manifest-file limit.

When a confirmed remote operation later fails local state, sidecar, or lock post-processing, the CLI retains `executionOutcome: "succeeded"`, emits `Status: failed after execution`, and exits 1. Its result identifies the failed stage and says not to rerun the confirmed mutation. Locks cover only same-machine local filesystems, not network or distributed coordination.

Use `npm --silent` and a command's generated `--help` as the public usage source. Agent-facing values must use public `figma:*` command IDs, never internal operation IDs or raw transport command names.

Node URLs and structured `{ fileKey, nodeId }` targets carry request-scoped file context. Cross-file requests use the target file only for that call and do not rebind persisted session file context. Conflicting explicit and target file keys fail closed; raw node IDs and fixed session selectors remain session-scoped.

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

Canonical authoring files under `../dev/canonical-corpus-source/` and development snapshot files under `../dev/upstream-snapshot/` and `../dev/upstream-changes/` are not runtime or package inputs. The authoring root stays outside the recursively discovered plugin skill tree. `figma:doctor` diagnoses the staged corpus, generated API index, project docs, and TypeScript assets.

## Live Verification

The plugin-root `npm run test:live` is a separately invoked Design-only smoke test. It uses the ignored `../.figma-workspace/live-test.json` configuration, normal OAuth cache resolution, uniquely tagged nodes, readback, capture, and tag-scoped cleanup. It is excluded from offline `npm test`; missing configuration is a usage error. The local config contains no OAuth secret and must provide schema version 1, a Design file URL, absolute state/workspace paths, and explicit cleanup permission.
