# AI Agent Development Guide

This document is for AI agents maintaining `figma-workspace`. It is not the user-facing workflow. For user tasks, follow `skills/figma-workspace/SKILL.md` and the built CLI help.

## Current Direction

- The canonical agent-facing command CLI is `npm --silent run figma -- <command>`. Every public `figma:<command>` npm script is an independent executable entrypoint for the same command. Direct commands cover queries and reads; JSON commands cover complex operations. Keep `--silent` in every agent invocation so npm lifecycle banners cannot contaminate Restricted Markdown stdout, including after the plugin is packed and installed.
- The plugin does not register or expose a local MCP server. Do not route agents through deferred tool discovery, legacy underscore-named workspace tools, or MCP resource URIs.
- The official Figma remote MCP is an internal transport behind the CLI. It is not the agent-facing contract.
- The release-0.3.0 agent-facing surface is public `figma:*` npm commands only. The package does not expose or support a typed runtime facade for consumer imports.
- Every executing optimized command requires an explicit fully qualified absolute `--state-file`; its parent owns result sidecars. The raw transport CLI requires either a fully qualified absolute `--session-file` or a fully qualified absolute `FIGMA_WORKSPACE_SESSION_FILE` and has no current-directory default.
- Local `.figma.ts` files, native Figma Plugin API, the two compact `$` helpers, workspace files, asset manifests, capture output, canonical project Markdown, guidance, and compact docs/API lookup remain the supported workflow. `figma:eval` and `figma:script:run` expose the required `executionOutcome` result field, not legacy execution booleans.
- Keep state and workspace files in a Git-ignored project-local `.figma-workspace/` or an explicitly selected Figma task-artifact directory. State uses the strict `{ "schemaVersion": 1, "sessions": [...] }` envelope; old unwrapped arrays fail closed and require a new state-file path. Do not infer that an injected writable workspace root is generic task storage; capability-specific output roots remain exclusive to their capability.
- Managed workspace roots, existing ancestors, and final targets reject symbolic links, Windows junctions, and other reparse points. State persists canonical workspace inputs only; derived task, script, capture, and result paths are recomputed and never trusted from state.
- The normal OAuth cache resolution is `FIGMA_WORKSPACE_OAUTH_CACHE_PATH`, then `CODEX_HOME`, then `USERPROFILE/.codex/.figma-workspace-oauth.json`. Terminal credential failures may require browser authorization; rate limits, 5xx responses, and network refresh faults retain credentials and remain transient failures.
- Runtime workflow lookup reads only the plugin-owned `skills/figma-workspace/references/canonical-corpus/`, which contains the manifest, route catalog, and current content-addressed JSONL. Its v2 manifest validates 87 records: 46 `active`, 20 `conditional`, 12 `router`, and 9 non-executable `examples`. Every record publishes task family, surfaces, mapping profile, title, and summary. Adapted authoring mirrors and policy live under `dev/canonical-corpus-source/`, outside the recursively discovered `skills/` tree and outside the package. Neither the complete upstream source snapshot nor upstream source text is packaged or read at runtime.
- `figma:api:search` reads the v2 plugin-owned symbol index generated during build from bundled `@figma/plugin-typings`; it records declaration symbols, direct owners, kinds, and qualified aliases and is independent of the development snapshot.
- DSL, `$.ops`, `compileFigmaWorkspaceOps`, and related operation types are not public runtime contracts.

## Canonical Agent Contract

Use `npm --silent` in every shell. Put npm's `--` before arguments passed to an independent entrypoint, and run a selected command with `-h` or `--help` before first use.

```text
npm --silent run figma -- api:search createFrame --state-file C:/work/project/.figma-workspace/state.json
npm --silent run figma:api:search -- createFrame --state-file C:/work/project/.figma-workspace/state.json
```

```text
npm --silent run figma:guidance -- "text font loadFontAsync" --surface design --state-file C:/work/project/.figma-workspace/state.json
npm --silent run figma:task:prepare -- --input <json-file|-> --state-file <absolute-path>
```

Family entrypoints are `figma:docs`, `figma:api`, `figma:sessions`, and `figma:upstream`.

The 18 direct query/read commands are `figma:guidance`, `figma:docs:list`, `figma:docs:catalog`, `figma:docs:read`, `figma:docs:search`, `figma:api:search`, `figma:doctor`, `figma:sessions:list`, `figma:sessions:read`, `figma:upstream:list`, `figma:upstream:read`, `figma:inspect`, `figma:metadata`, `figma:design-context`, `figma:motion-context`, `figma:variables`, `figma:design-system`, and `figma:libraries`.

JSON commands are `figma:open`, `figma:eval`, `figma:script:run`, `figma:assets:apply`, `figma:assets:download`, `figma:capture`, `figma:task:prepare`, and `figma:upstream:call`. They expose only `--input <json-file|->`, `--state-file <path>`, `--max-inline-bytes <bytes>`, and help. Their public help contains the complete input schema. The 21 transport-level JSON commands are available only through `figma:raw` for explicit debugging; raw names are not agent-facing IDs.

The optimized command option families are intentional:

- All 18 direct commands and all 8 JSON commands require an explicit fully qualified absolute `--state-file` when executing. Its parent owns `results/` sidecars.
- Guidance, docs, API, doctor, and upstream list/read need no existing Figma file context, but still require `--state-file`. Direct file-context commands also expose `--session-id`.
- Every executing command exposes `--max-inline-bytes`.
- JSON objects reject unknown fields, so a spelling mistake is a usage failure instead of an ignored default. `figma:design-context`, `figma:motion-context`, and `figma:variables` require exactly one node source: a positional target or `--file` with a Figma URL containing `node-id`.
- Docs/API search expose `--limit` and `--snippet-lines`; `figma:docs:search` exposes `--scope auto|active|conditional|router|examples|all`, defaults to `auto`, and accepts hard `--surface` and `--task-family` filters. Guidance exposes `--card-limit`, hard `--surface`, and validated `--workflow` filtering.
- File-binding commands expose `--workspace`; design-system exposes repeatable `--library`; sessions read exposes `--with-history`. Inspect supports only inspection and style reads.
- `figma:open` has no handle input. `figma:eval` has no `mode`, `allowDangerousOperations`, or `handleUpdates` input. `figma:script:run` has no `allowDangerousOperations` input. `figma:inspect` has no validate mode or `--handle`. Node-scoped commands accept raw node IDs, node URLs, or structured `{ fileKey, nodeId }` targets where supported; `$handle` strings and `{ handle }` targets are rejected.
- `figma:script:run` has no `strict` input; TypeScript and bundled Plugin API checking are always enabled. `figma:guidance` has no mode option and always returns its unified compact DTO.
- `--input -` reads stdin through both the canonical `figma` entrypoint and independent `figma:<command>` npm scripts. A second input source is a usage error.
- A node URL or structured `{ fileKey, nodeId }` target contributes request-scoped file context. It can address another file without rebinding session file context. Conflicts with an explicit file fail closed; raw node IDs, `$selection`, and `$currentPage` remain session-scoped.

The raw transport runtime behind `figma:raw` consists of 21 commands. Keep its exact internal directory in the typed registry and explicit raw debug help, not in agent workflow documentation.

Pin these facts when changing the CLI surface:

- `--input` accepts a JSON file or `-` for stdin.
- Optimized help is generated from typed command metadata. Every positional and option declares required, default, or unset behavior; options also declare repeatability and applicable integer range or enum values.
- Direct parsing recognizes only the exact `--` token as the positional separator. Every token after it is positional, including `-h` and `--help`; JSON commands and `figma:raw` remain option-only surfaces.
- Command `--state-file` must be fully qualified absolute and identifies the persisted workspace state store and its parent `results/` directory. At the transport layer, a fully qualified absolute explicit `--session-file` takes precedence over fully qualified absolute `FIGMA_WORKSPACE_SESSION_FILE`; one is required, there is no current-directory default, and relative or current-drive-rooted paths are rejected.
- Typed commands emit Restricted Markdown on stdout with a command title, `Input`, explicit status, and expanded business fields. Complex nested values may use fenced `json` blocks.
- Presentation classification does not rewrite backend results. Inline Markdown retains the backend fields, and oversized sidecars contain the complete original backend result. Only an unhealthy `doctor` result renders `Status: observed unhealthy` and exits 0; every other top-level `ok: false` result renders failure and exits 1. If remote execution is confirmed but local state, sidecar, or lock post-processing fails, render `Status: failed after execution`, preserve `executionOutcome: "succeeded"`, list stage status, and exit 1.
- Usage failures exit 2. Input parsing, transport, and thrown or unexpected errors are text on stderr and normally exit 1. Typed interrupts identified by `AbortError`, `ABORT_ERR`, or `ERR_CANCELED` exit 130.
- Stdout is not JSON and must not be passed to `JSON.parse`.
- CLI output defaults to a 4096-byte inline result limit, capped at 10000. Command `--max-inline-bytes` maps to transport `--inline-result-limit`; 0 forces the complete JSON result to the selected state file's sibling `results/`. Oversized Markdown exposes `outputFiles.cliResultFile` and omitted-byte metadata only. Backend and CLI defaults must remain 4096.
- Long input values are summarized in the Markdown `Input` line rather than echoed.
- Command argument and runtime result shapes come from runtime schemas and CLI help. Markdown files are secondary summaries.
- Existing runtime semantics remain available through rendered fields: status, optional diagnostics, upstream result or text, generated output-file pointers, and capture `imageFile`.
- `figma:eval` and `figma:script:run` always include `executionOutcome`: `not_started` before request dispatch, `succeeded` after confirmed script completion, and `outcome_unknown` when dispatch occurred but completion cannot be confirmed. `outcome_unknown` must include recovery guidance that instructs inspect/readback/reconcile before retrying; no mutation request is automatically replayed. A queued-capture failure retains `succeeded` and reports `captureProcessingSucceeded: false`.
- Agents must inspect a generated or edited image with `view_image`, including PNG output from `figma:capture`.

Breaking changes are allowed by default when they simplify this active contract. Update CLI parsing/help, runtime schemas, tests, generated `dist`, skill metadata, and concise README summaries together.

## Source Ownership Map

- `scripts/commands/*.mjs`: one independent executable per public npm command; each delegates to the shared built runtime without duplicating business logic.
- `mcp-server/src/cli/figma-command-runtime.ts`: shared typed command parsing, optimized option mapping, help, and forwarding to the transport runtime.
- `mcp-server/src/cli/figma-workspace-cli.ts`: transport CLI parsing, command dispatch, complete JSON-schema help, JSON stdin/file handling, Restricted Markdown result rendering, stderr behavior, and session-file integration.
- `mcp-server/src/mcp/workspace-mcp-server.ts`: workspace operation implementation and typed client surface retained behind the CLI.
- `mcp-server/src/upstream/remote-mcp-client.ts`: official remote Figma MCP transport.
- `mcp-server/src/upstream/node-upstream-client.ts`: Node client and upstream debug entrypoint.
- `mcp-server/src/auth/*.ts`: browser, config, OAuth callback/provider/state, and auth constants.
- `mcp-server/src/auth/credential-store.ts`: canonical OAuth cache read, atomic write, per-cache refresh coordination, and terminal-versus-transient refresh classification; the bridge consumes its built internal bundle instead of carrying a second credential implementation.
- `mcp-server/src/runtime/workspace-runtime.ts`: bundled shared runtime.
- `mcp-server/src/runtime/script-runner.ts`: `.figma.ts` checking, compilation, helper bootstrap, and diagnostics.
- `mcp-server/src/runtime/workspace-files.ts`: workspace, script output, capture output, and session workspace helpers.
- `mcp-server/src/runtime/managed-files.ts`: containment validation, reparse-point rejection, atomic writes, and exclusive publication shared by managed state/workspace outputs.
- `mcp-server/src/runtime/guidance-catalog.ts`: API cards, task buckets, query anchors, and guidance helpers.
- `mcp-server/src/runtime/doc-search.ts`: corpus resolution, chunking, ranking, and lookup shaping.
- `scripts/update-upstream-corpus.mjs`: maintenance command implementation. `update-upstream-snapshot` refreshes only `dev/upstream-snapshot/` and `dev/upstream-changes/`; `build-canonical-corpus` publishes only the plugin-owned canonical corpus.
- `scripts/lib/canonical-corpus.mjs`: builds the self-contained 87-record runtime corpus from the separate `dev/canonical-corpus-source/` authoring root into the runtime publish root. Stable record IDs remain relative to the logical `docs/` mirror paths. A source-identical record is review information, not a mechanical publication blocker.
- `mcp-server/scripts/build.mjs`: stages the canonical corpus and project docs, bundles the required TypeScript declarations, generates the plugin-owned Figma Plugin API symbol index from bundled `@figma/plugin-typings`, and emits only the CLI/runtime artifacts required by package scripts and upstream maintenance.
- `mcp-server/src/contract/tool-args.ts`: operation argument types and parsers.
- `mcp-server/src/contract/tool-metadata.ts`: operation descriptions and schemas reused by CLI help/dispatch where applicable.
- `mcp-server/src/contract/tool-registry.ts`: internal operation names and public-command mappings.
- `skills/figma-workspace/SKILL.md`: lightweight user-task router, not the canonical schema source.
- `skills/figma-workspace/agents/openai.yaml`: thin metadata pointing agents to `$figma-workspace`.

Generated output under `mcp-server/dist/` is checked in and must remain synchronized with source.

## Workflow Invariants

- `figma:task:prepare` receives an absolute `workspaceDir` and creates a repairable `.figma.ts` task under `<workspaceDir>/<fileKey-or-fileSlug>/`.
- `figma:script:run` always performs TypeScript and bundled Plugin API preflight before upstream execution. Diagnostics should identify source lines and block fatal payloads.
- Eval and script results use `executionOutcome`, never legacy execution booleans. Preflight, validation, connection, and auth failures before dispatch are `not_started`; confirmed script completion is `succeeded`; a script error, timeout, cancel, or transport loss after dispatch is `outcome_unknown`. An unknown outcome must carry inspect/readback/reconcile guidance and must not be automatically retried.
- Native Figma Plugin API is the primary scripting surface. `$` is a frozen, non-callable namespace with exactly `$.text` and `$.capture`. `$.text({ target?, parent?, text, font? })` accepts real nodes or raw node IDs, enforces mutually exclusive `target`/`parent`, creates a TextNode without a target, loads an explicit font before applying text, and rejects a mixed-font target without an explicit font. `$.capture` records at most 8 compact node requests in the script envelope; after successful execution the host reuses the `figma:capture` implementation, saves PNG files, and returns their paths in `captures[]` without sending image bytes through script JSON.
- Inline eval and `.figma.ts` use the same fixed helper bootstrap. There is no helper AST selection, dependency expansion, dynamic helper-access diagnostic, `injectedHelpers`, or `helperApiVersion` response field.
- TypeScript parse/type errors and bundled Plugin API typings block script execution. The runtime does not add semantic AST policy or diagnostics for valid Plugin API operations, including destructive edits, `eval`, `fetch`, dynamic import, root scans, PluginData, image creation, direct selection mutation, or page switches.
- Keep hard runtime boundaries: a wrapped script over 50,000 UTF-8 bytes fails closed; public JSON files/stdin and asset manifest files are at most 256 KiB; an asset manifest has at most 64 items; each upload, download, or capture is at most 16 MiB; cumulative command I/O is at most 64 MiB; request total time is at most 5 minutes; no-data idle time is at most 60 seconds. State/session, input, workspace, and output paths are validated; managed paths reject links/reparse points; queued capture validates its compact envelope and PNG output; inline results use a 4,096-byte default and 10,000-byte cap with complete atomic sidecars; state writes use local locking and atomic rename. The separate OAuth bridge retains its 512 KiB MCP request-body limit and 64 MiB response limit; neither changes the public CLI file limit.
- `get-metadata` precedes targeted `inspect` when broad structure discovery is needed.
- First-class commands remain preferred for design context, motion, design-system search, libraries, variables, assets, downloads, and capture.
- `figma:upstream:call` is reserved for raw or uncovered official capabilities such as Code Connect writes, shader reads, and `export_video`.
- `figma:docs:list` returns complete project Markdown IDs in the `project:` namespace. `figma:docs:catalog` publishes 12 task-family summaries or filterable canonical records in the `canonical:` namespace. `figma:docs:read` accepts only those IDs and reads complete content after v2 manifest/hash validation. `figma:guidance` and `figma:docs:search --scope auto` share the same English-only route resolver; auto routing uses the resolved family and compatible active, conditional, and router records, never examples. `--surface` and `--task-family` are hard filters, and explicit scopes are strict. Guidance emits a compact DTO with typed public `figma:*` next actions; it must not expose corpus text, hashes, source paths, raw transport names, or internal operation IDs. `figma:api:search` reads the separately generated v2 Plugin API symbol index and supports qualified aliases. Internal corpus and index files are not documentation.
- Visual QA uses a local capture path followed by `view_image` inspection.

## Change Rules

- Do not add `.mcp.json`, a plugin MCP registration, deferred MCP tool discovery instructions, or agent-facing resource URIs.
- Keep the 21 raw transport operations aligned with runtime dispatch, but confine their names to source and explicit raw debug help. Keep public `figma:*` command IDs and independent npm entrypoints aligned with the typed command runtime. Renames are breaking changes and must update help, tests, skill, and docs together.
- Validate command state-file and transport session-file reads and writes explicitly. Do not duplicate path validation across unrelated modules.
- Keep stdout within the Restricted Markdown result grammar: title, `Input`, status, expanded fields, and fenced `json` only for complex nested values. Send usage and thrown failures to stderr.
- Keep sidecar writes atomic. Test the default threshold, CLI override precedence, zero-force behavior, maximum validation, complete JSON recovery through `outputFiles.cliResultFile`, and a post-execution persistence failure that retains the confirmed business outcome.
- Write state and result sidecars through randomized sibling temporary files created exclusively, synced where supported, then atomically renamed. Use the same primitive for state, sidecars, workspace JSON, capture, and downloads. On failure, remove temporary files and retain any prior target; `overwrite=false` must use atomic exclusive publication rather than check-then-write. Sidecars may contain sensitive Figma content; retain them by default for recovery, never remove them automatically, and leave manual cleanup to the user or owning workflow.
- Treat the session lock as a same-machine, local-filesystem coordination mechanism based on process identity, PID liveness, and filesystem operations. A confirmed dead PID is reclaimed atomically; a live owner fails closed. It does not provide distributed locking or safety across hosts, network filesystems, shared volumes, or power loss.
- Do not introduce a JSON stdout compatibility mode or document `JSON.parse(stdout)` as supported.
- Do not restore any packed typed facade, facade import test, or agent-facing typed runtime import. Package validation must assert that no facade remains and execute only public npm command entrypoints.
- Keep help concise and generated from canonical command metadata where practical.
- Lightweight references under `skills/figma-workspace/references/` may contain static workflow and safety notes, but must not become a second schema contract.
- When changing plugin version numbers, update `.codex-plugin/plugin.json` in the same release change.

## Development Workflow

1. Inspect git status before changing files; this repository often has staged and unstaged changes together.
2. For runtime behavior, update source first, then tests, then generated `dist`.
3. For CLI wording and command shape, update canonical CLI/runtime metadata and plugin-root package scripts before the skill and README summaries.
4. Keep OAuth cache and workspace state files outside committed source.
5. For live Design verification only, create the ignored `<plugin-root>/.figma-workspace/live-test.json` with exactly `schemaVersion: 1`, `designFileUrl`, absolute `stateFile`, absolute `workspaceDir`, and `allowMutationCleanup: true`. Never put a token or secret in it. `npm run test:live` is explicit and not part of ordinary `npm test`; it creates unique PluginData-tagged nodes, reads them back, captures them, and removes only matching tagged nodes. If creation is unknown, reconcile by tag before cleanup rather than rerunning creation.
6. Refresh the complete development source snapshot and drift report with `npm run update:upstream-snapshot -- --ref <git-ref>`. This maintenance command updates only `dev/upstream-snapshot/` and `dev/upstream-changes/`; neither directory enters the npm package or `mcp-server/dist/`, and the command never publishes canonical runtime content. Review the resolved commit and drift report manually.
7. Publish runtime workflow lookup content separately with `npm run build:canonical-corpus`. It reads plugin-owned mirrors and policy from `dev/canonical-corpus-source/`, reads the shared route catalog from `skills/figma-workspace/references/canonical-corpus/`, and publishes only the self-contained v2 manifest and 87-record JSONL into that runtime directory. Treat any source-identical marker as a review warning rather than a mechanical failure.
8. Prefer a project-local `.figma-workspace/` only after confirming Git ignores it; otherwise use an explicitly selected Figma task-artifact directory.
9. Do not install or register a persistent local MCP server during development.
10. Do not update the locally installed Codex plugin cache from an agent session; leave reload/reinstall to the user or a fresh app session.

## Validation

From `plugins/figma-workspace/mcp-server`:

```bash
npm run typecheck
npm test
```

`tests/workspace-mcp-server.test.mjs` exercises the typed-client runtime behind the CLI. `tests/build-output.test.mjs` exercises the built CLI, including public help with complete schemas, all 21 transport mappings, project-doc staging, JSON file/stdin input through both npm entrypoint forms, Restricted Markdown stdout, doctor observation classification, domain failure and interrupt exits, stderr failures, atomic state/sidecar writes, and cross-process persistence.

Transport session-path tests should cover fully qualified absolute `FIGMA_WORKSPACE_SESSION_FILE`, fully qualified absolute explicit `--session-file`, explicit-option precedence, missing-path rejection, relative-path rejection, current-drive-rooted rejection, strict versioned state validation, old-array rejection, and dead/live local lock recovery. Command runtime tests should pin the required fully qualified absolute optimized `--state-file`, its mapping to transport `--session-file`, `--session-id`, `--max-inline-bytes`, query limits, strict unknown JSON fields, conditional node target/file inputs, workspace/library filters, session history expansion, removed script/guidance/orchestration inputs, and request-scoped cross-file targets that leave the session unchanged. Routing tests must cover all 12 English task families, non-English/OOV ambiguity, hard surface filtering, strict explicit scopes, catalog-to-read closure, compact payload limits, and qualified API aliases. Runtime tests should cover the fixed two-helper bootstrap, text and capture contracts, all three execution outcomes, post-execution persistence failures, removed handle/guardrail inputs, 256 KiB (262144/262145-byte)/64-item/16 MiB/64 MiB/time boundaries, link/reparse containment, atomic collision/rename failures, OAuth transient-versus-terminal refresh behavior, and representative `.figma.ts`, asset, guidance, lookup, and upstream delegation flows. Bridge tests separately pin the retained 512 KiB request-body and 64 MiB response boundaries. Live upstream checks remain separate from deterministic offline tests; `npm run test:live` covers the explicitly configured Design fixture only.

Also run repository validators for the skill and plugin plus `git diff --check` when those surfaces change.

The development snapshot updater requires Git and network access for the selected ref. Its snapshot and drift report are maintenance evidence only and are never runtime inputs. Runtime lookup validates the independently published canonical corpus and generated Plugin API index. Content-addressed publication fsyncs the output directory where the platform supports directory handles; Node on Windows rejects directory fsync, so Windows retains file-level fsync plus rename ordering rather than claiming power-loss durability.

`npm run check:dist` builds and then compares checked-in `dist`. Run it only in a clean checkout or CI job because unrelated or pre-existing `dist` edits make its cleanliness assertion ambiguous.

## Release Checklist

- Review staged and unstaged changes without altering the user's staging state.
- Confirm CLI source, generated `dist`, package scripts, tests, skill, and README summaries describe the same invocation contract.
- Confirm no local MCP registration or agent-facing MCP routing remains.
- Run `npm test` from `mcp-server`.
- Run plugin-root `npm run test:live` only when the ignored local Design configuration and normal OAuth cache are intentionally available; it is a release verification gate, not a replacement for deterministic tests.
- Check whether plugin version metadata needs a bump.
- Update marketplace and root inventory only when a plugin is added, renamed, or removed.
