# AI Agent Development Guide

This document is for maintainers of `figma-workspace`. It defines repository ownership and release workflow. For an agent-facing task, use `skills/figma-workspace/SKILL.md` and the selected command's generated `--help`; neither this guide nor a README is a second CLI schema.

## Architecture

### Public and internal boundaries

- The supported agent surface is the plugin-root stateless fixed-leaf `figma:*` npm CLI. Keep `npm --silent` in agent invocations so npm output cannot contaminate Restricted Markdown stdout.
- `figma:help` is the complete described agent-facing inventory and must stay synchronized with typed command metadata. Unknown or newly discovered official tools default to the schema-first `figma:upstream:list` -> `figma:upstream:read` -> `figma:upstream:call` escape hatch. Local `coverage` can identify a typed alternative but must not block a covered direct call. Do not add a typed first-class wrapper or promote a contract candidate solely because a capability appears upstream; that requires a separate public-contract decision.
- `figma:doctor` is a public local-only diagnostic leaf command for packaged docs, corpus, TypeScript, and Plugin API index faults. It takes no Figma target.
- The maintenance entrypoints are `maintenance:raw` and `maintenance:raw:help`. Keep them out of the `figma:*` registry, agent help, skill, plugin metadata, and user documentation.
- The official Figma remote MCP is an internal transport behind that CLI. Do not add a local MCP registration, deferred tool discovery, agent-facing resource URI, or typed runtime facade.
- Public command metadata, runtime schemas, and generated help own command names, arguments, defaults, result fields, and exit behavior. Documentation summarizes stable workflow and recovery rules only.
- Code Connect is a first-class four-step workflow: `figma:code-connect:inspect`, `figma:code-connect:plan`, `figma:code-connect:apply --confirm-plan`, and `figma:code-connect:verify`. It is Design-only and supports explicit simple mappings; it does not expose one-to-one wrappers for upstream tools or Code Connect template artifacts.
- `figma:run`, direct `figma:upstream:call`, and Code Connect apply report `executionOutcome`: `not_started`, `failed_atomic`, `succeeded`, or `outcome_unknown` for mutations. A directly returned `use_figma` script error is `failed_atomic`: Figma confirmed no file changes, so repair and retry safely. Code Connect apply validates its immutable plan digest and live mapping snapshot before dispatch; failures there are `not_started`. A post-dispatch error from another direct official tool or Code Connect bulk write is `outcome_unknown`, as are timeout, response loss, truncation, and unparseable response. A confirmed operation followed by local post-processing or Code Connect readback failure remains `succeeded` and must not be replayed blindly; run Code Connect verify to reconcile.
- Each command that requires a Figma file or node target resolves it explicitly. `figma:upstream:list` and `figma:upstream:read` are targetless; `figma:upstream:call` follows the selected live schema. Do not restore hidden persistent context, selected pages, task directories, history, or target fallbacks.
- A direct upstream call within the response budget writes a sanitized visible-protocol sidecar. It retains `content`, `structuredContent`, `isError`, and standard ContentBlock `annotations`; it omits protocol `_meta` and never exposes tool-definition annotations. An ordinary `_meta` nested inside `structuredContent` business data remains unchanged. An over-budget response does not persist its payload and returns a bounded resource-limit diagnostic, with a diagnostic-only sidecar when emitted. Typed commands write their upstream-response sidecar only for a remote error, inline truncation, or unrendered non-text content. Local artifacts, capture, download, temporary sidecars, and same-machine locks are invocation-local operational data. Keep them out of Git and preserve the runtime's managed-path and atomic-write boundaries. The fileKey lock only serializes `figma:run`, `figma:assets:apply`, `figma:code-connect:apply`, and `figma:upstream:call` when it resolves a fileKey.

### Time and resource boundaries

- Every upstream or bridge network request has a monotonic total deadline. The current Figma runtime uses a five-minute total network boundary.
- A 60-second idle deadline is valid only for work whose activity is observable, such as HTTP/body streams or subprocess I/O. Remote MCP calls expose no reliable progress signal, so they use the total deadline only; do not treat a quiet remote MCP call as an idle timeout.
- `tools/list`, `resources/list`, and `resources/templates/list` follow cursors under the same deadline. Aggregate at most 100 pages; deduplicate exact identity/content duplicates and fail closed on conflicting identity, a cursor cycle, page limit, or page failure. Runtime discovery and contract capture share this implementation.
- Limits, target schema, OAuth behavior, sidecar format, and JSON input shape belong to code, generated help, and contract tests. Do not duplicate their exact values here.

### Corpus publication flow

The workflow corpus has three intentionally separate layers:

1. `dev/upstream-snapshot/` and `dev/upstream-changes/` are an upstream archive and drift evidence. They are not packaged or read at runtime.
2. `dev/canonical-corpus-source/` is manual, CLI-native authoring plus policy. Maintainers absorb upstream changes here after review; it is not published directly.
3. `skills/figma-workspace/references/canonical-corpus/` is the packaged runtime corpus. `cli-runtime/dist/` contains the generated package mirror.

`npm run update:upstream-snapshot -- --ref <git-ref>` updates only the archive and drift report. It must never overwrite manual authoring, policy, runtime corpus, or `dist`. Pending or retired upstream drift is a review warning and does not block canonical publication. Malformed snapshot/report data, duplicate policy ownership, or inconsistent adaptation data still fail closed.

`npm run build:canonical-corpus` publishes the runtime corpus from manual authoring and policy. When an upstream change is intentionally absorbed, update the relevant mirror and policy provenance together. A local adaptation that does not change the upstream source content must not rewrite that record's `sourceContentSha256`.

## Source Ownership

| Area | Canonical owner | Maintenance rule |
| --- | --- | --- |
| Public CLI contract | `cli-runtime/src/cli/`, `cli-runtime/src/contract/`, generated help | Change schema and help before concise user-facing summaries. |
| Runtime operations | `cli-runtime/src/mcp/`, `cli-runtime/src/runtime/` | Keep the CLI as the only agent-facing integration boundary. |
| Upstream transport and OAuth | `cli-runtime/src/upstream/`, `cli-runtime/src/auth/`, `scripts/server.mjs` | Reuse the canonical credential implementation; do not create a second cache format or bridge behavior. |
| Upstream contract adaptation | `cli-runtime/src/upstream/upstream-contract-candidate.ts`, maintenance scripts, and the accepted test fixture | Capture live state as an ignored candidate, review semantic drift, adapt the CLI, then promote the reviewed candidate. Never treat capture as acceptance. |
| Managed files and local artifacts | `cli-runtime/src/runtime/managed-files.ts` and related runtime modules | Reuse containment, link rejection, atomic publication, temporary output, and lock primitives. |
| Public and maintenance wrappers | `scripts/commands/` and plugin-root `package.json` | Keep public wrappers aligned with generated help; keep maintenance entrypoints outside the agent-facing inventory. |
| Code Connect workflow | `cli-runtime/src/contract/`, `cli-runtime/src/runtime/`, plugin skill, and canonical Code Connect docs | Keep manifest validation, immutable plan/digest, stale-snapshot checks, conflict policy, single bulk write, and readback recovery semantics synchronized. `apply` is the only write; use generic `figma:upstream:*` for uncovered capabilities. |
| Corpus archive | `dev/upstream-snapshot/`, `dev/upstream-changes/` | Preserve as upstream evidence; never edit it to make local guidance correct. |
| Corpus authoring | `dev/canonical-corpus-source/` | Make reviewed CLI-native edits here and keep stable record IDs. |
| Runtime corpus | `skills/figma-workspace/references/canonical-corpus/`, generated `dist/` | Generate it from reviewed canonical authoring; do not hand-edit generated files. |
| Plugin API index | Bundled `@figma/plugin-typings`, `cli-runtime/scripts/build.mjs`, generated `dist/` | Generate it during the package build; do not treat corpus authoring as its source. |
| User routing | `skills/figma-workspace/SKILL.md` and its references | Keep it concise and route detailed usage to public help and docs commands. |
| Maintenance documentation | `doc/`, plugin README, package README | Assign one owner per fact and link rather than copy contract details. |

## Change Workflow

1. Inspect the dirty-worktree baseline. Preserve unrelated staged and unstaged changes.
2. Classify the change as public CLI, runtime, OAuth/bridge, corpus authoring, archive drift, packaging, or documentation. Read the owner and focused tests before editing.
3. For public CLI changes, update typed schema/help, runtime behavior, and contract tests first. Then update the skill and README summaries. Breaking changes are preferred when they simplify the active contract; do not retain hidden aliases, target fallbacks, or legacy result fields.
4. For corpus work, use the archive only to understand upstream drift. Make semantic corrections in manual authoring, update policy/provenance when upstream content changed, validate links and records, then rebuild the runtime corpus. Do not refresh the upstream ref merely to publish a local correction.
5. For filesystem, sidecar, capture, download, or OAuth changes, reuse the shared primitives and retain known operation outcomes through local failures. Test retries, concurrent access, partial-output cleanup, and terminal versus transient authentication behavior at the owning layer.
6. Rebuild checked-in `cli-runtime/dist/` only from source. Keep package allowlists, generated artifacts, wrappers, and source synchronized; never restore an importable typed facade.
7. Keep user docs as routing and recovery summaries. Exact command syntax, limits, result shapes, and generated corpus internals stay in help, schemas, and tests.

### Upstream contract adaptation

The committed upstream contract fixture is the last reviewed baseline, not runtime truth. Promotion atomically replaces only that local fixture with a reviewed candidate, so its content and SHA-256 change by design. It does not modify the remote MCP, the GitHub upstream guide archive, canonical corpus, or agent-facing help and skill. The fixture may retain upstream annotations and protocol `_meta` as drift evidence, but runtime discovery, result output, and sidecars must not expose tool-definition annotations or protocol `_meta` to an agent. Runtime wrappers continue to discover the live official schema and fail or filter according to their typed contract.

From `plugins/figma-workspace/cli-runtime`, use `upstream:contract:capture` to write an ignored candidate, then `upstream:contract:report` to review semantic drift by stable tool and resource identity. Adapt the owning CLI contracts, runtime behavior, help, generated output, and tests before promotion, and record an explicit disposition for every reported change before asking a maintainer to accept the exact candidate. Only `upstream:contract:promote` may replace the committed fixture, and only after its integrity, baseline, disposition, and wrapper-coverage gates pass. Promotion records reviewed interface evidence; it neither generates agent documentation nor exposes a new public command. It does not attest repository test execution; validation evidence remains part of maintainer review. `upstream:contract:check` remains the live-versus-accepted drift gate.

The repo-local maintainer workflow is defined by `plugins/figma-workspace/dev/skills/figma-upstream-contract-maintenance/`. Keep it outside the packaged public skill and plugin inventory. Do not hand-edit a candidate, promote merely to make drift checks pass, or expose a newly discovered official capability without an explicit public-contract decision.

For Design live verification, use only the ignored plugin-local `live-test.json` configuration and normal OAuth cache resolution. It contains no secret, runs separately from deterministic tests, tags its own nodes, reconciles an unknown creation before cleanup, and removes only nodes proven to belong to that run.

## Validation

Run focused tests for every changed owner, then use the release-level checks below.

From `plugins/figma-workspace`:

```text
npm run build:canonical-corpus
npm test
```

From `plugins/figma-workspace/cli-runtime`:

```text
npm run typecheck
npm test
npm run check:dist
```

Run `check:dist` only in a clean checkout or CI because it intentionally asserts generated-output cleanliness. When a skill or manifest changes, run the installed skill and plugin validators through their actual locations. Always finish with `git diff --check`.

Focused coverage must match the changed boundary. In particular, contract changes need parser/help/result tests; corpus changes need archive-versus-authoring isolation, policy/provenance, link, manifest, and runtime-read tests; bridge changes need total-deadline and observable-idle behavior; and packaging changes need a packed-artifact smoke test.

## Release

- Review source, generated output, package metadata, wrappers, tests, skill, and concise documentation together.
- Track deferred Figma Workspace maintenance work in [Figma Workspace TODO](figma-workspace-todo.md). A TODO item is not release authorization.
- When incrementing a plugin version, update the plugin manifest and every package/version lockfile owner required by the release. The Code Connect workflow is part of the 0.6.2 public contract. Do not change `agents/openai.yaml` or SKILL frontmatter solely for a numeric package release.
- Run `npm run test:live` only when the user intentionally provides the ignored local Design configuration and usable OAuth cache. It is a release verification gate, not a substitute for deterministic tests.
- Do not stage, commit, publish, install, or register anything unless the user explicitly requests that action.
