# Figma Workspace

Figma Workspace is a stateful Node CLI and plugin bundle for file-based Figma automation. It uses the official Figma remote MCP only as an internal transport; it does not install a local MCP server or expose MCP tools to agents.

It provides independent plugin-root npm command entrypoints for `.figma.ts` workflows, assets, captures, sessions, guidance, routed documentation, Plugin API lookup, and official Figma operations.

## NPM Commands

Run from this plugin directory. Use `npm --silent` so lifecycle banners cannot contaminate Restricted Markdown stdout. Put npm's `--` before arguments passed to an independent `figma:<command>` executable.

```text
npm --silent run figma -- guidance "text font loadFontAsync" --surface design --state-file C:/work/project/.figma-workspace/state.json
npm --silent run figma:docs:catalog -- --task-family design-editing --surface design --state-file C:/work/project/.figma-workspace/state.json
npm --silent run figma:api:search -- "figma.createFrame()" --state-file C:/work/project/.figma-workspace/state.json
```

- 18 direct query/read commands: `figma:guidance`, `figma:docs:list`, `figma:docs:catalog`, `figma:docs:read`, `figma:docs:search`, `figma:api:search`, `figma:doctor`, `figma:sessions:list`, `figma:sessions:read`, `figma:upstream:list`, `figma:upstream:read`, `figma:inspect`, `figma:metadata`, `figma:design-context`, `figma:motion-context`, `figma:variables`, `figma:design-system`, and `figma:libraries`.
- 9 JSON commands: `figma:open`, `figma:eval`, `figma:script:run`, `figma:assets:apply`, `figma:assets:download`, `figma:capture`, `figma:task:run`, `figma:task:prepare`, and `figma:upstream:call`.
- 22 raw transport JSON commands are isolated behind `figma:raw` and `figma:raw:help`. They are not agent-facing command IDs.

Every executing optimized command requires a fully qualified absolute `--state-file`; its parent owns `results/` sidecars. All support `--max-inline-bytes`. JSON commands expose only `--input`, `--state-file`, `--max-inline-bytes`, and help. Run the selected command with `--help` before first use.

Typed results are Restricted Markdown, not JSON. Read `outputFiles.cliResultFile` for any complete oversized result. Usage errors exit 2; typed interrupts exit 130; other typed failures exit 1, except an unhealthy `figma:doctor` observation exits 0.

## Agent Documentation Routing

Use concise English canonical keywords for `figma:guidance` and `figma:docs:search`. The shared route catalog has English aliases only; it does not translate Chinese or other non-English intent. Non-English, generic, out-of-vocabulary, or ambiguous queries return low or no confidence plus a catalog action rather than unrelated high-confidence guidance.

The 12 stable task families are `code-connect`, `create-file`, `design-to-code`, `design-generation`, `diagram`, `library-generation`, `motion-implementation`, `swiftui`, `figjam`, `motion`, `slides`, and `design-editing`.

- `figma:guidance` returns a compact DTO with route status/confidence, cards, query hints, API references, helper/wrapper/workflow summaries, reference context, and typed `nextActions`. Agent-visible command IDs are always public `figma:*` npm scripts.
- `figma:docs:list` returns stable `project:<topic>` IDs for project Markdown. `figma:docs:catalog` lists the 12 family summaries or filtered canonical records with `canonical:<record-id>` IDs. `figma:docs:read` accepts only those namespaces and returns complete content, using a sidecar for large documents.
- `figma:docs:search` defaults to `--scope auto`. A matched route searches only project/bridge docs and surface-compatible active, conditional, and router records in the resolved family. Examples never enter automatic search; request `--scope examples` explicitly.
- `--surface design|figjam|slides` and `--task-family` are hard filters. Explicit `--scope active|conditional|router|examples|all` is strict.
- `figma:api:search` uses a generated v2 Plugin API index and accepts bare, qualified, and call-shaped queries such as `createFrame`, `figma.createFrame()`, `PluginAPI.createFrame`, `ComponentNode.createInstance`, and `figma.variables.createVariableCollection`.

Search and guidance payloads expose compact public metadata and byte-limited snippets only. Internal corpus text, hashes, source paths, chunks, raw transport names, and implementation operation names are not public documentation.

## Workspace Workflow

1. Choose an absolute `--state-file` and reuse it for the task.
2. Use guidance, catalog, docs search/read, and API lookup to establish the right surface and workflow.
3. Use `figma:task:prepare` to create a repairable `.figma.ts` workspace.
4. Edit the script using native Figma Plugin API and injected `$` helpers, then run `figma:script:run` with `strict: true`. Use `await $.capture(target, options?)` to queue up to 8 local PNG captures for nodes created or resolved inside the script; completed paths are returned under `captures[]` after successful script execution.
5. Repair fatal preflight diagnostics before execution. Use first-class context, metadata, inspect, asset, and capture commands as needed.
6. Inspect every generated or edited image, including standalone `figma:capture` and queued `$.capture` PNG output, with `view_image`.

Use `figma:upstream:list` or `figma:upstream:read` before `figma:upstream:call` for capabilities with no first-class wrapper.

## Script Helpers And Boundaries

`$` is a frozen, non-callable namespace with exactly two helpers:

- `await $.text({ target?, parent?, text, font? })` creates or updates text with font loading. `target` and `parent` accept a real node or raw node ID and are mutually exclusive. When a target is omitted, it creates a TextNode. Mixed-font targets require an explicit font.
- `await $.capture(target, { imageFile?, maxDimension?, contentsOnly? })` queues up to eight host-side PNG captures and returns an in-script ticket. The final CLI result, not the ticket, provides local image paths under `captures[]`.

Use native Figma Plugin API for all other operations, including node traversal, selection, layout, asset construction, cloning, PluginData, page switching, and destructive edits. Script preflight enforces TypeScript and bundled Plugin API typings, but does not impose semantic AST policy on valid Plugin API calls. The runtime still enforces payload size, state/session and workspace path containment, capture validation, and atomic sidecar output boundaries.

## Canonical Corpus And API Index

The runtime reads only the plugin-owned canonical corpus staged from `skills/figma-workspace/references/canonical-corpus/`. Its v2 manifest validates 87 records and their content-addressed hashes, classification, surface, task-family, title, summary, and route catalog. The runtime does not read or package the complete upstream source snapshot.

The v2 Figma Plugin API index is generated during the package build from bundled `@figma/plugin-typings`. It is independent of the development snapshot. `figma:doctor` diagnoses the canonical corpus, generated API index, project docs, and TypeScript runtime assets.

The complete development source snapshot and drift report live under `dev/upstream-snapshot/` and `dev/upstream-changes/`. They are maintenance inputs only and do not enter the npm package or `mcp-server/dist/`.

## Login And State

State files and sidecars can contain sensitive workspace data. Prefer a Git-ignored project-local `.figma-workspace/`; do not commit state or sidecars. Use `figma:sessions:list` and `figma:sessions:read` rather than parsing state JSON.

When a result reports `FIGMA_UPSTREAM_AUTH_REQUIRED` or `FIGMA_UPSTREAM_OAUTH_*`, ask the user before browser authorization. If approved, run:

```text
npm run login:figma-http
```

The helper is temporary and removes its local bridge registration after login. Do not add a persistent local MCP entry.
