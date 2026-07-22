---
name: figma-workspace
description: Route Figma, FigJam, Slides, design-system, token, component, Plugin API lookup, and Figma OAuth work through independent plugin-root npm command entrypoints backed by the bundled stateful Node CLI.
---

# Figma Workspace

Use the bundled Node CLI for Figma work. It has no agent-facing local MCP server; the official remote MCP is internal transport only.

## Start

- Resolve `<plugin-root>` as `<skill-dir>/../..`. Use `npm --silent`; put npm's `--` before arguments for an independent `figma:<command>` script.
- Choose one fully qualified absolute `--state-file` before executing a command, reuse it for the task, and prefer a Git-ignored `<project>/.figma-workspace/state.json`.
- Run the selected public `figma:*` command with `--help` before first use. Generated help is the only complete input schema and limit contract.
- Read typed stdout as Restricted Markdown. If it gives `outputFiles.cliResultFile`, read that JSON sidecar; never parse stdout as JSON.
- Use only public `figma:*` npm command IDs. Do not expose raw transport names, internal identifiers, MCP tools, resource URIs, or corpus files.

## Minimal Workflow

1. For non-trivial work, run `figma:guidance` with concise English keywords and an explicit known surface, then follow returned public next actions.
2. Use `figma:docs:list`, `figma:docs:catalog`, `figma:docs:search`, and `figma:docs:read` for workflow material; use `figma:api:search` for Plugin API declarations.
3. Open or prepare the task, edit the generated `.figma.ts` with native Figma Plugin API, and run `figma:script:run` after repairing fatal preflight diagnostics.
4. Use first-class context, metadata, inspect, asset, and capture commands before `figma:upstream:call`.
5. Inspect every generated or edited image, including capture PNGs, with `view_image` before reporting visual success.

Use `figma:metadata` for broad layer-tree discovery before targeted `figma:inspect`. Use `figma:sessions:list` or `figma:sessions:read` when resuming unfamiliar state.

## Mutation Results

- `figma:eval` and `figma:script:run` report `executionOutcome`: `not_started`, `succeeded`, or `outcome_unknown`.
- Repair a `not_started` preflight or validation failure, then rerun only after the request was not dispatched.
- Treat `succeeded` as confirmed remote execution, even if later local persistence fails.
- For `outcome_unknown`, follow `retryGuidance`: inspect, read back, or reconcile the intended Figma effect before deciding whether a retry is safe. Never blindly replay a mutation.
- If queued capture processing fails after `succeeded`, use standalone `figma:capture` for the affected node. If stdout says `Status: failed after execution`, repair the named local stage and preserve the confirmed mutation result.

## OAuth

If a result reports `FIGMA_UPSTREAM_AUTH_REQUIRED` or `FIGMA_UPSTREAM_OAUTH_*`, ask the user before opening browser authorization. After approval, run from `<plugin-root>`:

```text
npm run login:figma-http
```

Use `--force` only when fresh authorization is actually needed. Treat rate limiting, 5xx responses, and network refresh faults as transient; they retain the cached credential. Do not add a persistent local MCP entry.

## References

- Read [overview](references/figma-workspace-overview.md) to select a command family.
- Read [workflow](references/figma-workspace-workflow.md) for `.figma.ts`, capture, and mutation recovery.
- Read [guidance and lookup](references/figma-workspace-guidance-and-lookup.md) for documentation routing, `canonical:` links, and API lookup.
- Read [safety](references/figma-workspace-safety.md) for hard runtime boundaries and timeout semantics.
- Read [sessions](references/figma-workspace-sessions.md) for state, sidecars, and local locks.
- Read [diagnostics](references/figma-workspace-diagnostics.md) only to choose a failure repair.
- Read [upstream tools](references/figma-workspace-upstream-tools.md) before an official escape-hatch call.
