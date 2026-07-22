# Figma Workspace

Figma Workspace is a stateful Node CLI and plugin bundle for repairable Figma automation. The official Figma remote MCP is internal transport only: agents use public `figma:*` npm commands, not a local MCP server.

## Quick Start

Run commands from this plugin directory. Use `npm --silent` so npm banners do not contaminate Restricted Markdown stdout. Select one fully qualified absolute state file for the task, use `figma:help` to discover the complete agent-facing command catalog, and run the selected command's help before first use.

```text
npm --silent run figma:help
npm --silent run figma -- guidance "text font loadFontAsync" --surface design --state-file C:/work/project/.figma-workspace/state.json
npm --silent run figma:docs:catalog -- --task-family design-editing --surface design --state-file C:/work/project/.figma-workspace/state.json
npm --silent run figma:api:search -- "figma.createFrame()" --state-file C:/work/project/.figma-workspace/state.json
npm --silent run figma:task:prepare -- --input task.json --state-file C:/work/project/.figma-workspace/state.json
```

Use generated `--help` for each exact input schema, option, limit, and JSON stdin/file contract. Typed results are Restricted Markdown, not JSON; if a result names `outputFiles.cliResultFile`, read that complete JSON sidecar instead of parsing stdout.

For a normal workspace edit, use guidance and lookup to choose the flow, prepare a `.figma.ts` task, edit it with native Figma Plugin API, run `figma:script:run`, then capture and inspect visible output with `view_image`. Use `figma:metadata` before targeted `figma:inspect` when broad structure discovery is needed. Prefer first-class context, asset, and capture commands before `figma:upstream:call`.

## Mutation Recovery

`figma:eval` and `figma:script:run` report `executionOutcome`:

- `not_started`: validation, preflight, connection, or auth stopped the request before dispatch. Repair that cause, then rerun.
- `succeeded`: Figma confirmed script execution.
- `outcome_unknown`: the request was dispatched but completion cannot be confirmed.

For `outcome_unknown`, follow `retryGuidance`, inspect or read back the intended Figma state, and reconcile before deciding whether a retry is safe. Never blindly replay a mutation. A queued capture failure preserves `executionOutcome: "succeeded"` with `captureProcessingSucceeded: false`; capture the affected node separately. If stdout reports `Status: failed after execution`, repair the reported local state, sidecar, or lock stage and do not rerun the confirmed mutation.

## State And Login

Keep state files and sidecars in a Git-ignored `.figma-workspace/` directory. State uses the strict `{ "schemaVersion": 1, "sessions": [...] }` envelope; legacy arrays are rejected. Use `figma:sessions:list` and `figma:sessions:read` instead of parsing state directly. Locks coordinate only same-machine local filesystem users.

When a result reports `FIGMA_UPSTREAM_AUTH_REQUIRED` or `FIGMA_UPSTREAM_OAUTH_*`, ask the user before browser authorization. After approval, run:

```text
npm run login:figma-http
```

Use `--force` only for genuinely fresh authorization. Rate limiting, 5xx responses, and network refresh errors are transient and preserve the cached credential.

Upstream and bridge network requests have a 5-minute total deadline. The 60-second idle deadline applies only to observable HTTP/body streams, the OAuth bridge, or subprocesses; remote MCP requests have only the total deadline. See command help and [the safety reference](skills/figma-workspace/references/figma-workspace-safety.md) for exact hard limits and path protections.

## Documentation And API Lookup

For a non-trivial or ambiguous request, translate the intent to concise English keywords and use `figma:guidance` with the known surface. If routing is uncertain, use `figma:docs:catalog`, narrow `figma:docs:search` with the selected task family and surface, and use `figma:docs:read` for returned `project:` or `canonical:` IDs. Use `figma:api:search` for bare, qualified, or call-shaped Plugin API symbols. The bundled [skill router](skills/figma-workspace/SKILL.md) and its references provide the complete intent-to-command and topic-to-query maps without duplicating generated CLI schemas.

## Live Design Verification

`npm run test:live` is an explicit Design-only smoke test and is separate from `npm test`. It reads only the Git-ignored `.figma-workspace/live-test.json` in this plugin root. The config contains the fixture URL plus fully qualified `stateFile` and `workspaceDir` paths, and no OAuth token or secret.

The smoke test creates unique tagged nodes, reads them back, captures them, and deletes only matching tagged nodes. If creation has an unknown outcome, it reconciles the tag before cleanup and never reruns creation. Missing local config is a usage error rather than a skipped test.
