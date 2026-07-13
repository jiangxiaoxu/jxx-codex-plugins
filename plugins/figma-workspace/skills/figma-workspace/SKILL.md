---
name: figma-workspace
description: Route Figma, FigJam, Slides, design-system, token, component, Plugin API lookup, and Figma OAuth work through independent plugin-root npm command entrypoints backed by the bundled stateful Node CLI.
---

# Figma Workspace Router

Use the bundled Node CLI for every Figma Workspace operation. The plugin does not register or expose a local MCP server. The official Figma remote MCP is an internal transport used by the CLI, not an agent-facing tool surface.

## Start Here

- Do not search for MCP tools or resource URIs. The CLI, its command help, and its project Markdown docs are the complete agent-facing surface.
- Resolve `<plugin-root>`. Before executing any optimized command, choose and pass one fully qualified absolute command-level `--state-file`; reuse it across related calls. Prefer a Git-ignored `<project>/.figma-workspace/state.json`; otherwise use an explicitly selected Figma task-artifact directory. Do not treat every injected writable workspace root as generic task artifacts; capability-specific output roots belong only to that capability.
- Before first use of a specific command in a task, run that command with `-h` or `--help`; use its help as the source of truth for arguments and options.
- Read stdout as Restricted Markdown. If Markdown points to `outputFiles.cliResultFile`, read that JSON sidecar for the complete result. Never parse stdout itself as JSON.
- Treat `run-script-file` phase `preflight` as not executed. Repair every fatal diagnostic before rerunning; enable dangerous operations only after the user explicitly authorizes them.
- Prefer first-class commands. Before `figma:upstream:call`, use `figma:upstream:list` or `figma:upstream:read` to read the live official schema.
- Use `figma:sessions:list` and `figma:sessions:read` to inspect persisted state and handles; do not treat the state JSON layout as an agent contract.
- Use `figma:doctor` only for installed runtime, corpus, or TypeScript asset faults. OAuth errors follow the approval-gated login flow below.

## NPM Command Contract

Resolve `<plugin-root>` as `<skill-dir>/../..`, where `<skill-dir>` contains this `SKILL.md`, and use it as the working directory. Use `npm --silent` in every shell. `--silent` is required so npm lifecycle banners do not contaminate Restricted Markdown stdout. Always put npm's `--` separator before command arguments or forwarded CLI options. The canonical command CLI is `npm --silent run figma -- <command> ...`; each `figma:<command>` script is an independent npm executable entrypoint for the same command. Before first use, run the selected entrypoint with `-h` or `--help`.

```text
npm --silent run figma:guidance -- --help
npm --silent run figma:guidance -- "text font loadFontAsync" --surface design --state-file C:/work/project/.figma-workspace/state.json
npm --silent run figma -- api:search createFrame --state-file C:/work/project/.figma-workspace/state.json
npm --silent run figma:api:search -- createFrame --state-file C:/work/project/.figma-workspace/state.json
```

- Family entrypoints: `figma:docs`, `figma:api`, `figma:sessions`, and `figma:upstream`.
- The 17 direct query/read commands are `figma:guidance`, `figma:docs:list`, `figma:docs:read`, `figma:docs:search`, `figma:api:search`, `figma:doctor`, `figma:sessions:list`, `figma:sessions:read`, `figma:upstream:list`, `figma:upstream:read`, `figma:inspect`, `figma:metadata`, `figma:design-context`, `figma:motion-context`, `figma:variables`, `figma:design-system`, and `figma:libraries`. These accept positional arguments and optimized options instead of JSON input.
- JSON commands: `figma:open`, `figma:eval`, `figma:script:run`, `figma:assets:apply`, `figma:assets:download`, `figma:capture`, `figma:task:run`, `figma:task:prepare`, and `figma:upstream:call`. Their optimized surface exposes only `--input <json-file|->`, `--state-file <path>`, `--max-inline-bytes <bytes>`, and help.
- The 22 transport-level kebab-case JSON commands are available only through `figma:raw` and `figma:raw:help`. Run `npm --silent run figma:raw -- <transport-command> --help` for a complete transport schema.
- `--input` accepts a JSON file path or `-` for JSON on stdin. Prefer a file for large or reusable payloads and stdin for small calls.
- Every executing optimized command, including all 17 direct commands and all 9 JSON commands, requires an explicit fully qualified absolute `--state-file`. It selects the persisted workspace state store, and its parent directory owns the `results/` sidecar directory. Reuse one path across related commands.
- `figma:guidance`, docs, API, doctor, and upstream list/read do not require existing Figma file context, but they still require `--state-file` for execution and sidecar ownership.
- Direct file-context commands also expose `--session-id` for the logical workspace session.
- Every executing command exposes `--max-inline-bytes`. Search commands use `--limit` and `--snippet-lines`; guidance uses `--card-limit`. File-binding commands use `--workspace`, design-system uses repeatable `--library`, and sessions read uses `--with-handles` and `--with-history`. `figma:inspect` is the exception: it reuses context already bound to the selected session, omits `--workspace` and `--file`, and supports repeatable `--handle`; run `figma:open` or a file-binding read command first when the session has no file context.
- Typed command results use Restricted Markdown on stdout. Each result has a command title, an `Input` section, an explicit status, and expanded business fields; complex nested values may appear in fenced `json` blocks.
- CLI presentation classification does not rewrite backend results or complete sidecars. An unhealthy `figma:doctor` result uses `Status: observed unhealthy` and exits 0; every other top-level `ok: false` result uses the same Restricted Markdown shape and exits 1. Usage errors exit 2, typed interrupts exit 130, and input, transport, I/O, or unexpected execution failures use stderr and a non-zero exit.
- Optimized help declares required/default/unset behavior, repeatability, and applicable ranges or enum values. Direct commands accept exact `--` as a positional separator; JSON commands and `figma:raw` remain option-only.
- Never pass CLI stdout to `JSON.parse`. Read the Markdown headings, status, fields, and any nested JSON code fences instead.
- Result size defaults to 4096 bytes and is capped at 10000. `--max-inline-bytes` maps to the transport runtime result limit; `0` always writes the complete JSON result under the selected state file's sibling `results/`. When a result exceeds the limit, Markdown returns only `outputFiles.cliResultFile` plus the omitted-byte summary; read that JSON file for the complete payload.
- The Markdown `Input` line summarizes long code, base64, objects, and arrays instead of echoing the full input.
- Use `npm --silent run figma:help` for the command directory. Use the selected command's `-h` or `--help` before first use. Use `npm --silent run figma:raw -- <transport-command> --help` only when the complete transport JSON schema is needed.

The state file is temporary local state and should not be committed by default.

## Default Workflow

1. Choose and reuse one fully qualified absolute `--state-file` for every executing optimized command. Use the sessions commands when resuming unknown state.
2. Use `figma:docs:list -- --state-file <absolute-path>` to list canonical project docs and `figma:docs:read -- <topic> --state-file <absolute-path>` to read one when this skill's startup rules are insufficient.
3. For login, credential refresh, or auth repair, follow Figma Login below.
4. Call `figma:guidance -- <keywords> --state-file <absolute-path>` with compact task keywords before non-trivial work. Use `figma:docs:search` for project/upstream workflow snippets and `figma:api:search` for exact Plugin API symbols, always with the same state file.
5. Call `figma:task:prepare -- --input <json-file|-> --state-file <absolute-path>` once with a Figma URL or file key, slug-style `taskName`, absolute `workspaceDir`, and surface when needed.
6. Edit the generated `<taskName>.figma.ts`, then call `figma:script:run -- --input <json-file|-> --state-file <absolute-path>` with the persisted session id, `inputFile`, `strict: true`, and surface. Fix line-level preflight diagnostics and rerun the same script.
7. Use `figma:assets:apply`, `figma:assets:download`, `figma:capture`, or `figma:task:run` with JSON input for assets, exports, visual QA, and repeatable workflows.
8. After generating or editing an image, including a `capture-node` PNG, inspect the local file with `view_image` before reporting visual success.

Use `figma:metadata` for broad layer-tree discovery before targeted `figma:inspect` checks. Use `figma:design-context`, `figma:motion-context`, `figma:design-system`, `figma:libraries`, and `figma:variables` for their first-class read workflows. Use `figma:upstream:list` or `figma:upstream:read` to discover the current official schema, then use `figma:upstream:call` only for uncovered capabilities such as `whoami`, file creation, Code Connect operations, shader reads, or `export_video`.

## Script And Workspace Contract

- Write an ordinary async TypeScript script body in `.figma.ts`. Use native Figma Plugin API for node creation, querying, layout, and advanced behavior.
- Common helpers include `$.text`, `$.select`, `$.checkpoint`, `$.remember`, `$.forget`, `$.inspect`, `$.imageAsset`, `$.screenshot`, `$.cloneNodeTree`, `$.findFreeSlot`, `$.placeNode`, and `$.replaceGeneratedFrame`.
- Keep each transaction small and repairable. Return compact JSON containing changed node ids, handles, and validation notes.
- Prefer `$.select` over direct selection mutation. Validate stale handles with `figma:inspect` before reuse.
- For large local generated assets, create target rectangles in the script and use `figma:assets:apply`; reserve `$.imageAsset` for small inline PNG/JPEG data.
- Put temporary audit labels outside the inspected frame or in confirmed free space so they do not cover the content being captured.
- Workspace files live under `<workspaceDir>/<fileKey-or-fileSlug>/`. The supplied `workspaceDir` is not given another implicit `figma-workspace` segment.

The CLI renders the workspace runtime result as Restricted Markdown. Read expanded upstream result/text, diagnostics and output-file fields under their Markdown headings; complex nested runtime values may be preserved in fenced `json` blocks. Capture output identifies `imageFile`. The command-level `--state-file` is the canonical cross-process workspace state store and locates the results sidecar directory; do not depend on process-local state or legacy MCP session resources.

## Guidance And Lookup

- Use `figma:docs:list -- --state-file <absolute-path>` to list canonical topics and `figma:docs:read -- <topic> --state-file <absolute-path>` for `overview`, `workflow`, `guidance-and-lookup`, `safety`, `diagnostics`, `sessions`, or `upstream-tools`.
- Start with `figma:guidance -- <query> --state-file <absolute-path>` using compact queries such as `text font loadFontAsync`, `components variants properties`, or `capture visual QA`.
- Use returned cards, query hints, API symbols, guardrails, helper profiles, and workflow graph hints before writing a script.
- Use `figma:api:search -- <symbol> --state-file <absolute-path>` for exact Plugin API details and `figma:docs:search -- <query> --state-file <absolute-path>` for workflow documentation; snippets are capped rather than full declaration files.
- Project Markdown is indexed alongside the upstream corpus for `guidance` and `lookup kind=docs`; the upstream corpus remains available for exact API and official workflow snippets.
- Bundled JSONL upstream corpus files are internal lookup data. Do not read or route agents to them directly.

## Reference Topics

- Read [overview](references/figma-workspace-overview.md) for the full capability and command-selection matrix.
- Read [workflow](references/figma-workspace-workflow.md) for `.figma.ts`, eval, assets, inspection, and response semantics.
- Read [guidance and lookup](references/figma-workspace-guidance-and-lookup.md) for query strategy, wrapper/helper profiles, and corpus ownership.
- Read [safety](references/figma-workspace-safety.md) for destructive operations, fonts, surfaces, and visual QA guardrails.
- Read [diagnostics](references/figma-workspace-diagnostics.md) when `figma:doctor`, lookup, TypeScript runtime, or installed assets fail.
- Read [sessions](references/figma-workspace-sessions.md) for persisted state, handles, history, and recovery.
- Read [upstream tools](references/figma-workspace-upstream-tools.md) before official escape-hatch discovery and invocation.

## Figma Login

When a CLI Markdown result reports `FIGMA_UPSTREAM_AUTH_REQUIRED` or a code beginning with `FIGMA_UPSTREAM_OAUTH_`, ask the user whether to start browser authorization. If approved, run from `<plugin-root>`:

```text
npm run login:figma-http
```

Use `npm run login:figma-http -- --force` only when fresh browser authorization is required. Then verify with `figma:upstream:call -- --input <json-file|-> --state-file <absolute-path>` using `toolName: "whoami"` and the same absolute state file. If the user declines, report that upstream access remains unavailable.

The helper temporarily registers `figma-http`, completes OAuth, and removes the temporary entry. Do not add a persistent local MCP entry. To print the shared OAuth cache path for debugging, run `npm run oauth-cache:path` from the plugin root.
