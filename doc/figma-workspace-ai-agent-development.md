# AI Agent Development Guide

This document is for AI agents maintaining `figma-workspace`. It is not the user-facing workflow. For user tasks, follow `skills/figma-workspace/SKILL.md` and the built CLI help.

## Current Direction

- The canonical agent-facing command CLI is `npm --silent run figma -- <command>`. Every public `figma:<command>` npm script is an independent executable entrypoint for the same command. Direct commands cover queries and reads; JSON commands cover complex operations. Keep `--silent` in every agent invocation so npm lifecycle banners cannot contaminate Restricted Markdown stdout, including after the plugin is packed and installed.
- The plugin does not register or expose a local MCP server. Do not route agents through deferred tool discovery, legacy underscore-named workspace tools, or MCP resource URIs.
- The official Figma remote MCP is an internal transport behind the CLI. It is not the agent-facing contract.
- Every executing optimized command requires an explicit fully qualified absolute `--state-file`; its parent owns result sidecars. The raw transport CLI requires either a fully qualified absolute `--session-file` or a fully qualified absolute `FIGMA_WORKSPACE_SESSION_FILE` and has no current-directory default.
- Local `.figma.ts` files, native Figma Plugin API, compact `$` helpers, workspace files, asset manifests, capture output, task plans, canonical project Markdown, guidance, and compact docs/API lookup remain the supported workflow.
- Keep state and workspace files in a Git-ignored project-local `.figma-workspace/` or an explicitly selected Figma task-artifact directory. Do not infer that an injected writable workspace root is generic task storage; capability-specific output roots remain exclusive to their capability.
- Bundled upstream skill content has a pinned 88-record raw JSONL snapshot under `skills/figma-workspace/references/upstream-corpus/` and a derived `upstream-active/` index. Raw data and provenance are not default retrieval surfaces. The active index defaults to its 46 `active` records; its 20 `conditional` records require an explicit docs scope, its 12 `router` records appear only in `all`, its 9 `examples` records appear only in `examples` or `all` and are `nonExecutable`, and its one TypeScript API record is available only through `api:search`. Do not route agents to read either JSONL corpus directly.
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

The 17 direct query/read commands are `figma:guidance`, `figma:docs:list`, `figma:docs:read`, `figma:docs:search`, `figma:api:search`, `figma:doctor`, `figma:sessions:list`, `figma:sessions:read`, `figma:upstream:list`, `figma:upstream:read`, `figma:inspect`, `figma:metadata`, `figma:design-context`, `figma:motion-context`, `figma:variables`, `figma:design-system`, and `figma:libraries`.

JSON commands are `figma:open`, `figma:eval`, `figma:script:run`, `figma:assets:apply`, `figma:assets:download`, `figma:capture`, `figma:task:run`, `figma:task:prepare`, and `figma:upstream:call`. They expose only `--input <json-file|->`, `--state-file <path>`, `--max-inline-bytes <bytes>`, and help. The 22 transport-level JSON commands are available only through `figma:raw`; run `npm --silent run figma:raw -- <transport-command> --help` for a complete schema.

The optimized command option families are intentional:

- All 17 direct commands and all 9 JSON commands require an explicit fully qualified absolute `--state-file` when executing. Its parent owns `results/` sidecars.
- Guidance, docs, API, doctor, and upstream list/read need no existing Figma file context, but still require `--state-file`. Direct file-context commands also expose `--session-id`.
- Every executing command exposes `--max-inline-bytes`.
- Docs/API search expose `--limit` and `--snippet-lines`; `figma:docs:search` also exposes `--scope active|conditional|examples|all` and defaults to `active`. Guidance exposes `--card-limit` and is fixed to the active scope.
- File-binding commands expose `--workspace`; design-system exposes repeatable `--library`; sessions read exposes `--with-handles` and `--with-history`. Inspect intentionally reuses context already bound to the selected session, omits `--workspace` and `--file`, and exposes repeatable `--handle`.

The raw transport runtime behind `figma:raw` consists of these 22 commands:

| CLI command | Purpose |
| --- | --- |
| `open` | Create or reopen a persisted workspace session. |
| `eval` | Run a small native Plugin API transaction. |
| `run-script-file` | Preflight and execute a local `.figma.ts` file. |
| `apply-asset-manifest` | Apply a prepared asset manifest. |
| `download-assets` | Download workspace assets. |
| `capture-node` | Capture a node to a local image file. |
| `run-task-plan` | Execute a prepared task plan. |
| `prepare-task` | Create a repairable task workspace. |
| `guidance` | Get task-oriented workflow guidance. |
| `inspect` | Inspect style, structure, or handle validity. |
| `get-metadata` | Fetch and stage file metadata. |
| `get-design-context` | Fetch design implementation context. |
| `get-motion-context` | Fetch motion context. |
| `search-design-system` | Search the design system. |
| `get-libraries` | List available libraries. |
| `get-variable-defs` | Fetch variable definitions. |
| `call-upstream-tool` | Invoke an uncovered official upstream capability. |
| `lookup` | Search compact local API and workflow references. |
| `docs` | List or read canonical project Markdown topics. |
| `doctor` | Diagnose the raw snapshot, derived active index and pending/retired records, project docs, and TypeScript runtime assets. |
| `sessions` | Read persisted session summaries, handles, and history. |
| `upstream-tools` | List or describe the live official upstream tool schema. |

Pin these facts when changing the CLI surface:

- `--input` accepts a JSON file or `-` for stdin.
- Optimized help is generated from typed command metadata. Every positional and option declares required, default, or unset behavior; options also declare repeatability and applicable integer range or enum values.
- Direct parsing recognizes only the exact `--` token as the positional separator. Every token after it is positional, including `-h` and `--help`; JSON commands and `figma:raw` remain option-only surfaces.
- Command `--state-file` must be fully qualified absolute and identifies the persisted workspace state store and its parent `results/` directory. At the transport layer, a fully qualified absolute explicit `--session-file` takes precedence over fully qualified absolute `FIGMA_WORKSPACE_SESSION_FILE`; one is required, there is no current-directory default, and relative or current-drive-rooted paths are rejected.
- Typed commands emit Restricted Markdown on stdout with a command title, `Input`, explicit status, and expanded business fields. Complex nested values may use fenced `json` blocks.
- Presentation classification does not rewrite backend results. Inline Markdown retains the backend fields, and oversized sidecars contain the complete original backend result. Only an unhealthy `doctor` result renders `Status: observed unhealthy` and exits 0; every other top-level `ok: false` result renders failure and exits 1.
- Usage failures exit 2. Input parsing, transport, and thrown or unexpected errors are text on stderr and normally exit 1. Typed interrupts identified by `AbortError`, `ABORT_ERR`, or `ERR_CANCELED` exit 130.
- Stdout is not JSON and must not be passed to `JSON.parse`.
- CLI output defaults to a 4096-byte inline result limit, capped at 10000. Command `--max-inline-bytes` maps to transport `--inline-result-limit`; 0 forces the complete JSON result to the selected state file's sibling `results/`. Oversized Markdown exposes `outputFiles.cliResultFile` and omitted-byte metadata only.
- Long input values are summarized in the Markdown `Input` line rather than echoed.
- Command argument and runtime result shapes come from runtime schemas and CLI help. Markdown files are secondary summaries.
- Existing runtime semantics remain available through rendered fields: status, optional diagnostics, upstream result or text, generated output-file pointers, and capture `imageFile`.
- Agents must inspect a generated or edited image with `view_image`, including PNG output from `capture-node`.

Breaking changes are allowed by default when they simplify this active contract. Update CLI parsing/help, runtime schemas, tests, generated `dist`, skill metadata, and concise README summaries together.

## Source Ownership Map

- `scripts/commands/*.mjs`: one independent executable per public npm command; each delegates to the shared built runtime without duplicating business logic.
- `mcp-server/src/cli/figma-command-runtime.ts`: shared typed command parsing, optimized option mapping, help, and forwarding to the transport runtime.
- `mcp-server/src/cli/figma-workspace-cli.ts`: transport CLI parsing, command dispatch, complete JSON-schema help, JSON stdin/file handling, Restricted Markdown result rendering, stderr behavior, and session-file integration.
- `mcp-server/src/mcp/workspace-mcp-server.ts`: workspace operation implementation and typed client surface retained behind the CLI.
- `mcp-server/src/upstream/remote-mcp-client.ts`: official remote Figma MCP transport.
- `mcp-server/src/upstream/node-upstream-client.ts`: Node client and upstream debug entrypoint.
- `mcp-server/src/auth/*.ts`: browser, config, OAuth callback/provider/state, and auth constants.
- `mcp-server/src/runtime/workspace-runtime.ts`: bundled shared runtime.
- `mcp-server/src/runtime/script-runner.ts`: `.figma.ts` checking, compilation, helper bootstrap, and diagnostics.
- `mcp-server/src/runtime/workspace-files.ts`: workspace, script output, capture output, plan, and session workspace helpers.
- `mcp-server/src/runtime/guidance-catalog.ts`: API cards, task buckets, query anchors, and guidance helpers.
- `mcp-server/src/runtime/doc-search.ts`: corpus resolution, chunking, ranking, and lookup shaping.
- `scripts/update-upstream-corpus.mjs`: GitHub-only upstream skill acquisition, Git ref resolution, raw snapshot provenance and integrity hashes, deterministic active-index derivation, and publication.
- `mcp-server/src/contract/tool-args.ts`: operation argument types and parsers.
- `mcp-server/src/contract/tool-metadata.ts`: operation descriptions and schemas reused by CLI help/dispatch where applicable.
- `mcp-server/src/contract/tool-registry.ts`: operation names and task-plan aliases.
- `skills/figma-workspace/SKILL.md`: lightweight user-task router, not the canonical schema source.
- `skills/figma-workspace/agents/openai.yaml`: thin metadata pointing agents to `$figma-workspace`.

Generated output under `mcp-server/dist/` is checked in and must remain synchronized with source.

## Workflow Invariants

- `prepare-task` receives an absolute `workspaceDir` and creates a repairable `.figma.ts` task under `<workspaceDir>/<fileKey-or-fileSlug>/`.
- `run-script-file` performs strict TypeScript preflight before upstream execution. Diagnostics should identify source lines and block fatal payloads.
- Native Figma Plugin API is the primary scripting surface; `$` helpers maintain stable workflow semantics for handles, text, checkpoints, inspection, assets, placement, replacement, and cloning.
- `get-metadata` precedes targeted `inspect` when broad structure discovery is needed.
- First-class commands remain preferred for design context, motion, design-system search, libraries, variables, assets, downloads, and capture.
- `call-upstream-tool` is reserved for raw or uncovered official capabilities such as Code Connect writes, shader reads, and `export_video`.
- `figma:docs:list` and `figma:docs:read` own complete canonical project Markdown. `figma:guidance` is fixed to the derived active scope; `figma:docs:search --scope` selects active by default, conditional explicitly, examples explicitly, or all including router records. `figma:api:search` is the only route to the single API record. Internal JSONL corpus files are not documentation.
- Visual QA uses a local capture path followed by `view_image` inspection.

## Change Rules

- Do not add `.mcp.json`, a plugin MCP registration, deferred MCP tool discovery instructions, or agent-facing resource URIs.
- Keep the 22 raw transport names aligned with runtime operation dispatch. Keep the canonical command names and independent npm entrypoints aligned with the typed command runtime. Renames are breaking changes and must update help, tests, skill, and docs together.
- Validate command state-file and transport session-file reads and writes explicitly. Do not duplicate path validation across unrelated modules.
- Keep stdout within the Restricted Markdown result grammar: title, `Input`, status, expanded fields, and fenced `json` only for complex nested values. Send usage and thrown failures to stderr.
- Keep sidecar writes atomic. Test the default threshold, CLI override precedence, zero-force behavior, maximum validation, and complete JSON recovery through `outputFiles.cliResultFile`.
- Write state and result sidecars through sibling temporary files followed by atomic rename. Sidecars may contain sensitive Figma content; retain them by default for recovery, never remove them automatically, and leave manual cleanup to the user or owning workflow.
- Treat the session lock as a same-machine, local-filesystem coordination mechanism based on process identity, PID liveness, and filesystem operations. It does not provide distributed locking or safety across hosts, network filesystems, or shared volumes.
- Do not introduce a JSON stdout compatibility mode or document `JSON.parse(stdout)` as supported.
- Keep help concise and generated from canonical command metadata where practical.
- Lightweight references under `skills/figma-workspace/references/` may contain static workflow and safety notes, but must not become a second schema contract.
- When changing plugin version numbers, update `.codex-plugin/plugin.json` in the same release change.

## Development Workflow

1. Inspect git status before changing files; this repository often has staged and unstaged changes together.
2. For runtime behavior, update source first, then tests, then generated `dist`.
3. For CLI wording and command shape, update canonical CLI/runtime metadata and plugin-root package scripts before the skill and README summaries.
4. Keep OAuth cache and workspace state files outside committed source.
5. Regenerate the internal upstream snapshot and derived active index from the Figma-maintained GitHub repository with `npm run update:upstream-corpus -- --ref <git-ref>`. The GitHub-only updater resolves the ref to an immutable commit, ingests every supported text file under `skills/`, records standalone `workflow-skills/` as out of scope, writes per-record and whole-corpus SHA-256 metadata, then derives and publishes the active index from the raw snapshot. Corpus files are content-addressed and manifests are switched last; older generations remain available for concurrent readers and require an explicit later garbage-collection decision. Review the resolved commit, pending/retired index records, and generated diff before building.
6. Prefer a project-local `.figma-workspace/` only after confirming Git ignores it; otherwise use an explicitly selected Figma task-artifact directory.
7. Do not install or register a persistent local MCP server during development.
8. Do not update the locally installed Codex plugin cache from an agent session; leave reload/reinstall to the user or a fresh app session.

## Validation

From `plugins/figma-workspace/mcp-server`:

```bash
npm run typecheck
npm test
```

`tests/workspace-mcp-server.test.mjs` now exercises the typed-client runtime behind the CLI. `tests/build-output.test.mjs` exercises the built CLI, including help, all 22 command mappings, project-doc staging, JSON file/stdin input, Restricted Markdown stdout, doctor observation classification, domain failure and interrupt exits, stderr failures, atomic state/sidecar writes, and cross-process persistence.

Transport session-path tests should cover fully qualified absolute `FIGMA_WORKSPACE_SESSION_FILE`, fully qualified absolute explicit `--session-file`, explicit-option precedence, missing-path rejection, relative-path rejection, and current-drive-rooted rejection. Command runtime tests should pin the required fully qualified absolute optimized `--state-file`, its mapping to transport `--session-file`, `--session-id`, `--max-inline-bytes`, query limits, workspace/library filters, sessions expansions, and repeated handles. Runtime tests should continue covering structured failures and representative `.figma.ts`, asset, capture, guidance, lookup, and upstream delegation flows. Live upstream checks remain separate from deterministic offline tests.

Also run repository validators for the skill and plugin plus `git diff --check` when those surfaces change.

The upstream corpus updater requires Git and network access for the selected ref. Its committed manifest is the reproducible boundary: `upstream.resolvedCommit` identifies the exact Figma source tree, while the corpus and record hashes detect incomplete or altered generated assets. Runtime lookup validates those hashes before using the corpus. Publication fsyncs the output directory where the platform supports directory handles; Node on Windows rejects directory fsync, so Windows retains file-level fsync plus rename ordering rather than claiming power-loss durability.

`npm run check:dist` builds and then compares checked-in `dist`. Run it only in a clean checkout or CI job because unrelated or pre-existing `dist` edits make its cleanliness assertion ambiguous.

## Release Checklist

- Review staged and unstaged changes without altering the user's staging state.
- Confirm CLI source, generated `dist`, package scripts, tests, skill, and README summaries describe the same invocation contract.
- Confirm no local MCP registration or agent-facing MCP routing remains.
- Run `npm test` from `mcp-server`.
- Check whether plugin version metadata needs a bump.
- Update marketplace and root inventory only when a plugin is added, renamed, or removed.
