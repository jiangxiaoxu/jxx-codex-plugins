---
name: figma-workspace
description: Route Figma, FigJam, Slides, design-system, token, component, Plugin API lookup, and Figma OAuth work through independent plugin-root npm command entrypoints backed by the bundled stateful Node CLI.
---

# Figma Workspace Router

Use the bundled Node CLI for every Figma Workspace operation. The plugin does not register or expose a local MCP server. The official Figma remote MCP is an internal transport, not an agent-facing tool surface.

## Start Here

- Resolve `<plugin-root>` as `<skill-dir>/../..`. Use `npm --silent` in every shell and place npm's `--` before arguments passed to an independent `figma:<command>` script.
- Before executing any optimized command, choose one fully qualified absolute `--state-file` and reuse it. Its parent owns `results/` sidecars. Prefer a Git-ignored `<project>/.figma-workspace/state.json`.
- Before first use of a command, run its `--help`. CLI help and its typed result schema are authoritative.
- Read stdout as Restricted Markdown. If it names `outputFiles.cliResultFile`, read that JSON sidecar for the complete result. Never call `JSON.parse` on stdout.
- Use only public `figma:*` npm script IDs in plans, next steps, and agent-visible output. Do not use internal `figma_workspace_*` identifiers, raw transport names, MCP tools, or resource URIs.
- Use `figma:doctor` only for installed canonical corpus, generated Plugin API index, project-doc, or TypeScript asset faults. It is not an upstream-drift diagnostic.

## NPM Command Contract

```text
npm --silent run figma:guidance -- "text font loadFontAsync" --surface design --state-file C:/work/project/.figma-workspace/state.json
npm --silent run figma:docs:catalog -- --task-family design-editing --surface design --state-file C:/work/project/.figma-workspace/state.json
npm --silent run figma:api:search -- "figma.createFrame()" --state-file C:/work/project/.figma-workspace/state.json
```

- Family entrypoints: `figma:docs`, `figma:api`, `figma:sessions`, and `figma:upstream`.
- The 18 direct query/read commands are `figma:guidance`, `figma:docs:list`, `figma:docs:catalog`, `figma:docs:read`, `figma:docs:search`, `figma:api:search`, `figma:doctor`, `figma:sessions:list`, `figma:sessions:read`, `figma:upstream:list`, `figma:upstream:read`, `figma:inspect`, `figma:metadata`, `figma:design-context`, `figma:motion-context`, `figma:variables`, `figma:design-system`, and `figma:libraries`.
- The 9 JSON commands are `figma:open`, `figma:eval`, `figma:script:run`, `figma:assets:apply`, `figma:assets:download`, `figma:capture`, `figma:task:run`, `figma:task:prepare`, and `figma:upstream:call`.
- The 22 raw transport JSON commands are available only through `figma:raw` and `figma:raw:help`. They are not agent-facing command IDs.
- Every executing optimized command requires `--state-file` and supports `--max-inline-bytes`. Direct file-context commands also expose `--session-id`; JSON commands expose only `--input`, `--state-file`, `--max-inline-bytes`, and help.
- Usage failures exit 2. Typed interrupts exit 130. Other typed failures render Restricted Markdown and exit 1, except an unhealthy `figma:doctor` observation exits 0.

## Agent Documentation Routing

Compress the task into concise English canonical keywords before calling `figma:guidance` or `figma:docs:search`. The router has English aliases only and does not translate Chinese or other non-English intent. For non-English, out-of-vocabulary, generic, or ambiguous input, expect low or no confidence; use the returned catalog action, then select an English task family or query explicitly.

The stable task families are `code-connect`, `create-file`, `design-to-code`, `design-generation`, `diagram`, `library-generation`, `motion-implementation`, `swiftui`, `figjam`, `motion`, `slides`, and `design-editing`.

1. Run `figma:guidance -- <english-keywords> --surface <design|figjam|slides> --state-file <absolute-path>` before non-trivial work. The returned compact DTO contains `route`, cards, query hints, Plugin API references, helper/wrapper/workflow summaries, reference context, and typed `nextActions`. Follow its public `commandId` values.
2. Run `figma:docs:list` for project documents. It returns stable `project:<topic>` IDs. Read them only with `figma:docs:read -- project:<topic>`.
3. Run `figma:docs:catalog` to browse the 12 task-family summaries. Add `--task-family`, `--surface`, or `--classification active|conditional|router|examples` to obtain canonical records. Read a returned `canonical:<record-id>` with `figma:docs:read`.
4. Run `figma:docs:search -- <english-keywords>` with its default `--scope auto`. Auto routing searches only project/bridge docs and compatible active, conditional, and router records from the resolved family. It never includes examples automatically. If examples are needed, explicitly pass `--scope examples`.
5. Treat `--surface` and `--task-family` as hard filters. Explicit `--scope active|conditional|router|examples|all` is also strict; it does not expand a surface or family filter. Do not omit a known FigJam or Slides surface.
6. Run `figma:api:search -- <symbol>` for Plugin API declarations. It accepts bare, qualified, and call-shaped queries such as `createFrame`, `figma.createFrame`, `figma.createFrame()`, `PluginAPI.createFrame`, `ComponentNode.createInstance`, and `figma.variables.createVariableCollection`.

Canonical corpus records and API search results are compact public metadata and snippets. Do not read corpus JSONL, hashes, source paths, chunks, or generated declaration files directly. `figma:docs:read` is the only complete-document path and writes a sidecar rather than truncating a large document. Example records are non-executable reference material.

## Default Workflow

1. Choose one absolute `--state-file`; use `figma:sessions:list` or `figma:sessions:read` if resuming unknown state.
2. Follow Agent Documentation Routing before writing a non-trivial script.
3. For login, credential refresh, or auth repair, follow Figma Login below.
4. Call `figma:task:prepare` once with JSON containing a Figma URL or key, slug-style `taskName`, absolute `workspaceDir`, and surface when needed.
5. Edit the generated `.figma.ts`, then call `figma:script:run` with `strict: true`. Repair every fatal preflight diagnostic before rerunning.
6. Use `figma:assets:apply`, `figma:assets:download`, `figma:capture`, or `figma:task:run` for assets, visual QA, and repeatable workflows.
7. Inspect every generated or edited image, including a capture PNG, with `view_image` before reporting visual success.

Use `figma:metadata` for broad layer-tree discovery before `figma:inspect`. Prefer first-class context, motion, library, variable, and design-system commands. Use `figma:upstream:list` or `figma:upstream:read` before the `figma:upstream:call` escape hatch.

## Script And Workspace Contract

- Write an ordinary async TypeScript body in `.figma.ts`. Use native Figma Plugin API for node creation, querying, layout, and advanced behavior.
- `$` is a frozen, non-callable namespace with exactly two helpers: `$.text` and `$.capture`. Use native Figma Plugin API for node creation, querying, layout, selection, assets, cloning, and all advanced behavior.
- `$.text({ target?, parent?, text, font? })` accepts a real node or raw node ID, creates a TextNode when `target` is omitted, and loads an explicit font before applying text. `target` and `parent` are mutually exclusive. Mixed fonts without an explicit font fail closed.
- Keep each transaction small and repairable. Return compact JSON with changed node IDs and validation notes.
- For large generated assets, create target rectangles in the script and use `figma:assets:apply`.
- For visual QA, use `await $.capture(target, options?)` when the target is created or resolved inside the script. It queues a host-side `figma:capture` operation after the script succeeds; read the local PNG path from the final command result's `captures[]`, then inspect it with `view_image`. Use standalone `figma:capture` when the node id is already known.
- If queued capture post-processing fails, `scriptExecutionSucceeded: true`, `captureProcessingSucceeded: false`, and `retryGuidance` mean the script already ran and may have mutated Figma. Do not rerun the creation/edit script; retry the affected node with standalone `figma:capture`.
- Use native `exportAsync()` only when a `.figma.ts` script genuinely needs PNG, JPG, SVG, PDF, or other exported bytes/string. It is not a CLI visual-QA path, and raw export data must not be returned as a large JSON array.
- Script preflight enforces TypeScript and the bundled Plugin API typings. It does not impose semantic AST policy on valid Plugin API operations such as selection changes, page switches, PluginData, root searches, image creation, or destructive edits. Keep mutations intentional and verify visible changes with capture.

## Reference Topics

- Read [overview](references/figma-workspace-overview.md) for capability and command selection.
- Read [workflow](references/figma-workspace-workflow.md) for `.figma.ts`, assets, inspection, and response semantics.
- Read [guidance and lookup](references/figma-workspace-guidance-and-lookup.md) for the routing contract and exact lookup examples.
- Read [safety](references/figma-workspace-safety.md) for non-bypassable TypeScript, payload, path, capture, and output boundaries.
- Read [diagnostics](references/figma-workspace-diagnostics.md) for corpus, API-index, and installed-asset repairs.
- Read [sessions](references/figma-workspace-sessions.md) for persisted state and recovery.
- Read [upstream tools](references/figma-workspace-upstream-tools.md) before official escape-hatch discovery and invocation.

## Figma Login

When a CLI Markdown result reports `FIGMA_UPSTREAM_AUTH_REQUIRED` or a code beginning with `FIGMA_UPSTREAM_OAUTH_`, ask the user whether to start browser authorization. If approved, run from `<plugin-root>`:

```text
npm run login:figma-http
```

Use `npm run login:figma-http -- --force` only when fresh browser authorization is required. Then verify with `figma:upstream:call` using `toolName: "whoami"` and the same absolute state file. The helper is temporary; do not add a persistent local MCP entry.
