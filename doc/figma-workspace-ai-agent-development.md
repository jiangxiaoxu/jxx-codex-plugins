# AI Agent Development Guide

This document is for maintainers of `figma-workspace`. It defines repository ownership and release workflow. For an agent-facing task, use `skills/figma-workspace/SKILL.md` and the selected command's generated `--help`; neither this guide nor a README is a second CLI schema.

## Architecture

### Public and internal boundaries

- The supported agent surface is the plugin-root stateless fixed-leaf `figma:*` npm CLI. Keep `npm --silent` in agent invocations so npm output cannot contaminate Restricted Markdown stdout.
- `figma:help` is the complete described agent-facing inventory and must stay synchronized with typed command metadata. The public fallback for uncovered official capabilities is `figma:upstream:list`, `figma:upstream:read`, then `figma:upstream:call`.
- `figma:doctor` is a public local-only diagnostic leaf command for packaged docs, corpus, TypeScript, and Plugin API index faults. It takes no Figma target.
- The maintenance entrypoints are `maintenance:raw` and `maintenance:raw:help`. Keep them out of the `figma:*` registry, agent help, skill, plugin metadata, and user documentation.
- The official Figma remote MCP is an internal transport behind that CLI. Do not add a local MCP registration, deferred tool discovery, agent-facing resource URI, or typed runtime facade.
- Public command metadata, runtime schemas, and generated help own command names, arguments, defaults, result fields, and exit behavior. Documentation summarizes stable workflow and recovery rules only.
- `figma:run` reports `executionOutcome`. A dispatched mutation with `outcome_unknown` must be inspected, read back, and reconciled before any retry. A confirmed operation followed by local post-processing failure remains confirmed and must not be replayed blindly.
- Each remote invocation resolves an explicit stable Figma target. Do not restore hidden persistent context, selected pages, task directories, history, or target fallbacks.
- Local artifacts, capture, download, temporary sidecars, and same-machine locks are invocation-local operational data. Keep them out of Git and preserve the runtime's managed-path, atomic-write, and fileKey lock boundaries.

### Time and resource boundaries

- Every upstream or bridge network request has a monotonic total deadline. The current Figma runtime uses a five-minute total network boundary.
- A 60-second idle deadline is valid only for work whose activity is observable, such as HTTP/body streams or subprocess I/O. Remote MCP calls expose no reliable progress signal, so they use the total deadline only; do not treat a quiet remote MCP call as an idle timeout.
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
| Managed files and local artifacts | `cli-runtime/src/runtime/managed-files.ts` and related runtime modules | Reuse containment, link rejection, atomic publication, temporary output, and lock primitives. |
| Public and maintenance wrappers | `scripts/commands/` and plugin-root `package.json` | Keep public wrappers aligned with generated help; keep maintenance entrypoints outside the agent-facing inventory. |
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
- When incrementing a plugin version, update the plugin manifest and every package/version lockfile owner required by the release. Do not change `agents/openai.yaml` or SKILL frontmatter solely for a numeric package release.
- Run `npm run test:live` only when the user intentionally provides the ignored local Design configuration and usable OAuth cache. It is a release verification gate, not a substitute for deterministic tests.
- Do not stage, commit, publish, install, or register anything unless the user explicitly requests that action.
