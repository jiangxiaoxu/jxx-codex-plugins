# Figma Workspace

Figma Workspace 0.5.3 is a stateless fixed-leaf Node CLI and plugin bundle for repairable Figma automation. The official Figma remote MCP is internal transport only: agents use public `figma:*` npm commands, not a local MCP server.

## Quick Start

Run commands from this plugin directory. Use `npm --silent` so npm banners do not contaminate Restricted Markdown stdout. Run `figma:help` to discover the complete agent-facing leaf catalog, then run the selected command's help before first use.

```text
npm --silent run figma:help
npm --silent run figma:docs:help
npm --silent run figma:docs:catalog -- --task-family design-editing --surface design
npm --silent run figma:api:help
npm --silent run figma:api:search -- "figma.createFrame()"
npm --silent run figma:api:read -- "<api-id-from-search>"
npm --silent run figma:metadata -- --file "https://www.figma.com/design/FILE_KEY/File"
npm --silent run figma:inspect -- --file FILE_KEY --node 230:2 --surface design
npm --silent run figma:run -- --file "https://www.figma.com/design/FILE_KEY/File" --script C:/work/project/change.figma.ts
```

Use generated `--help` for each exact input schema, option, limit, and JSON stdin/file contract. Typed results are Restricted Markdown, not JSON; if a result names `outputFiles.cliResultFile`, read that complete JSON sidecar instead of parsing stdout.

Every command that requires a Figma file or node target supplies it in that invocation. `figma:upstream:list` and `figma:upstream:read` are targetless; `figma:upstream:call` follows the selected live schema instead of inheriting a target. Use a full file or node URL whenever possible. A node URL's `node-id=230-2` converts to Plugin API ID `230:2`; a bare node ID is invalid without an explicit file. URLs infer Design, FigJam, or Slides; a raw fileKey needs `--surface` when the selected command needs a surface.

For a normal edit, use docs/API lookup to choose the flow, create a local `.figma.ts` script in the shell, run `figma:run`, then capture and inspect visible output with `view_image`. Use `figma:metadata` before targeted `figma:inspect` when broad structure discovery is needed. Prefer first-class context, asset, and capture commands before `figma:upstream:call`. Before an upstream fallback call, read its live description and schema; obtain explicit user confirmation when they mark the action as destructive, external, credit/cost-bearing, or an asset upload.

## Mutation Recovery

`figma:run` reports `executionOutcome`:

- `not_started`: validation, preflight, connection, or auth stopped the request before dispatch. Repair that cause, then rerun.
- `failed_atomic`: Figma returned a `use_figma` script error and confirmed the script made no file changes. Repair the script, then retry safely.
- `succeeded`: Figma confirmed script execution.
- `outcome_unknown`: the request was dispatched but completion cannot be confirmed, such as a timeout, response loss, or truncated response.

For `failed_atomic`, stdout directly shows a compact remote error code/message and reports `Status: failed atomically`; the sidecar retains complete upstream diagnostics. Repair and retry the script safely. Never blindly replay an `outcome_unknown` mutation: read back and reconcile the intended Figma state first. A queued capture failure preserves `executionOutcome: "succeeded"` with `captureProcessingSucceeded: false`; capture the affected node separately. `Status: failed after execution` is reserved for a local artifact or lock failure after confirmed `succeeded`; repair that local stage and do not rerun the confirmed mutation.

## Local Artifacts And Login

The CLI does not create a persistent workspace record. Shells own `.figma.ts` creation and repeat a Figma target only for operations that require one. Pure inline reads do not create local files. When a command needs to write an oversized result, diagnostic, capture, or download and no explicit path is supplied, it returns an absolute path under an invocation-specific OS temp directory. Use `--output-dir`, `--image-file`, or a download output option when a later shell step needs a durable location.

The OS-temp fileKey lock covers `figma:run`, `figma:assets:apply`, and `figma:upstream:call` only when that call resolves a fileKey; it does not serialize every mutation. Managed outputs reject links and reparse points and are written atomically. The lock is not distributed durability.

When a result reports `FIGMA_UPSTREAM_AUTH_REQUIRED` or `FIGMA_UPSTREAM_OAUTH_*`, ask the user before browser authorization. After approval, run:

```text
npm run login:figma-http
```

Use `--force` only for genuinely fresh authorization. Rate limiting, 5xx responses, and network refresh errors are transient and preserve the cached credential.

Upstream and bridge network requests have a 5-minute total deadline. The 60-second idle deadline applies only to observable HTTP/body streams, the OAuth bridge, or subprocesses; remote MCP requests have only the total deadline. See command help and [the safety reference](skills/figma-workspace/references/figma-workspace-safety.md) for exact hard limits and path protections.

## Documentation And API Lookup

Prefer concise English terms as documentation-search seeds; this is a relevance recommendation, not an input-language restriction. For a non-trivial or ambiguous request, select a query from the skill's Search Query Recipes and use the known surface. If routing is uncertain, use `figma:docs:catalog`, narrow `figma:docs:search` with the selected task family and surface, and use `figma:docs:read` for returned `project:` or `canonical:` IDs. Use `figma:api:search` for bare, qualified, or call-shaped Plugin API symbols, then use `figma:api:read` with a returned `apiId` when the complete declaration is needed. Catalog and search display limits are clamped to the ranges shown by command help and reported in `parameterAdjustments`; traversal, pagination, capture sizing, and remote inline-result boundaries remain strict. Search has no per-snippet byte cap; one 12000-byte UTF-8 budget applies across returned snippets, with any truncation reported in `snippetBudget`. The bundled [skill router](skills/figma-workspace/SKILL.md) and its references provide the complete static intent-to-command and topic-to-query maps without duplicating generated CLI schemas.

Use `figma:doctor` for local packaged-doc, corpus, TypeScript, or Plugin API index diagnosis. It is a public local-only leaf command and never needs a Figma target.

## Live Design Verification

`npm run test:live` is an explicit Design-only smoke test and is separate from `npm test`. It reads only the Git-ignored `.figma-workspace/live-test.json` in this plugin root. The schema is version `2` and contains `designFileUrl`, optional `outputDir`, and `allowMutationCleanup`; it contains no OAuth token or secret.

The smoke test creates unique tagged nodes, reads them back, captures them, and deletes only matching tagged nodes. If creation has an unknown outcome, it reconciles the tag before cleanup and never reruns creation. Missing local config is a usage error rather than a skipped test.
