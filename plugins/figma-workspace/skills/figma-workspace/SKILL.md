---
name: figma-workspace
description: Route Figma, FigJam, Slides, design-system, token, component, Plugin API lookup, OAuth, creation, editing, inspection, capture, validation, and mutation recovery through the public figma:* npm CLI.
---

# Figma Workspace

Use the bundled Node CLI for Figma work. It has no agent-facing local MCP server; the official remote MCP is internal transport only.

## Start And Discover

1. Resolve `<plugin-root>` as `<skill-dir>/../..` and run commands there with `npm --silent`.
2. Choose one fully qualified absolute `--state-file`, reuse it for the task, and prefer a Git-ignored `<project>/.figma-workspace/state.json`.
3. For a first or unfamiliar task, run `npm --silent run figma:help`. The `figma`, `figma:docs`, `figma:api`, `figma:sessions`, and `figma:upstream` scripts are umbrella or family discovery entrypoints.
4. Select a concrete public command, then run `npm --silent run figma:<command> -- --help` before first use. Generated help is the complete input schema and limit contract.
5. Read stdout as Restricted Markdown. If it gives `outputFiles.cliResultFile`, read that complete JSON sidecar; never parse stdout as JSON.

Use only the public commands below. Do not expose transport names, internal identifiers, MCP tools, resource URIs, or corpus files.

## Route The Intent

- For an obvious read-only request, select its direct command from the map below.
- For non-trivial edits, generation, or unclear intent, run `figma:guidance` with concise English keywords and `--surface design|figjam|slides` when known.
- If guidance is missing, ambiguous, or low confidence, run `figma:docs:catalog` to choose a task family, then `figma:docs:search` with explicit `--surface` and `--task-family`, and finally `figma:docs:read` with an exact returned `project:` or `canonical:` ID.
- Treat `[label](canonical:<record-id>)` as another `figma:docs:read` call. Use `figma:docs:list` for the small project-document inventory.
- Use `figma:api:search` for native Plugin API declarations. It accepts bare, qualified, and call-shaped queries such as `createFrame`, `figma.createFrame()`, and `ComponentNode.createInstance`.
- Guidance and documentation lookup support concise English keywords only and have no fuzzy spelling correction. Use the recipes and canonical terms below, then fall back to catalog instead of guessing.

Read [guidance and lookup](references/figma-workspace-guidance-and-lookup.md) for the complete topic-to-query map.

## Search Query Recipes

Use these English keyword patterns as search seeds. Add the known surface and task family as hard filters when available.

| Intent | English keywords |
| --- | --- |
| Text and fonts | `text font loadFontAsync mixed fonts` |
| Auto Layout | `auto layout sizing fill hug spacing` |
| Components and variants | `component variant component properties` |
| Variables and tokens | `variable collections modes scopes code syntax` |
| Library audit | `available libraries components variables styles` |
| Design to code | `implementation context layout assets` |
| Code Connect | `code connect component code mapping` |
| New Figma file | `new Figma file surface setup` |
| Design generation | `create interface design frames components layout` |
| Diagram generation | `flowchart sequence architecture diagram` |
| Library generation | `create component library variants variables styles` |
| FigJam journey | `user journey sticky notes connectors` |
| Slides structure | `slide lifecycle grid row structure` |
| Motion | `motion easing keyframes transitions` |
| Motion implementation | `implement animation motion path transitions` |
| SwiftUI | `swiftui design to code code to design` |
| Image and assets | `image fill asset upload download export` |
| Mutation recovery | `outcome_unknown readback reconcile mutation` |

## Public Command Map

| Intent | Public commands | Selection rule |
| --- | --- | --- |
| Plan and route | `figma:guidance` | Use before non-trivial, generated, or ambiguous work. |
| Find workflow docs | `figma:docs:list`, `figma:docs:catalog`, `figma:docs:search`, `figma:docs:read` | List project docs, choose a family, search narrowly, then read exact IDs. |
| Find Plugin API | `figma:api:search` | Look up exact native symbols instead of guessing typings. |
| Diagnose installed assets | `figma:doctor` | Check bundled docs, corpus, TypeScript, and Plugin API index faults. |
| Establish or resume context | `figma:open`, `figma:sessions:list`, `figma:sessions:read` | Open a file/session or inspect persisted session summaries and history. |
| Understand a file | `figma:metadata`, `figma:inspect` | Discover the broad layer tree first, then inspect or style-audit a target. |
| Read implementation context | `figma:design-context`, `figma:motion-context` | Read official design/code or motion context for a node-scoped target. |
| Read design systems | `figma:variables`, `figma:design-system`, `figma:libraries` | Read target variables, search components/variables/styles, or enumerate libraries. |
| Implement a repairable edit | `figma:task:prepare`, `figma:script:run` | Prepare and edit `.figma.ts`, repair preflight diagnostics, then execute. |
| Run a bounded edit | `figma:eval` | Use only for a small, clear native Plugin API transaction. |
| Move assets | `figma:assets:apply`, `figma:assets:download` | Apply a prepared local manifest or download official assets. |
| Verify visually | `figma:capture` | Save a node PNG, then inspect it with `view_image`. |
| Use an uncovered official capability | `figma:upstream:list`, `figma:upstream:read`, `figma:upstream:call` | Discover, read the exact official schema, then call only when no first-class command fits. |

## Implement And Verify

1. Use `figma:open` or an explicit URL/target to establish file context. When resuming unfamiliar state, inspect `figma:sessions:list` or `figma:sessions:read` first.
2. Use `figma:metadata` for broad discovery before targeted `figma:inspect`. Read design, motion, variable, library, or design-system context only as required.
3. For repairable work, run `figma:task:prepare`, edit the generated `.figma.ts` with native Figma Plugin API, look up uncertain symbols with `figma:api:search`, and run `figma:script:run` after repairing fatal preflight diagnostics.
4. Return compact changed-node IDs and validation notes. Capture visible results with queued `$.capture` or standalone `figma:capture`, then inspect every generated or edited image with `view_image` before reporting visual success.
5. Prefer first-class commands. Use `figma:upstream:list`, `figma:upstream:read`, and `figma:upstream:call` only for an uncovered official capability.

Read [workflow](references/figma-workspace-workflow.md) for `.figma.ts`, capture, and recovery details.

## Mutation Results

- `figma:eval` and `figma:script:run` report `executionOutcome`: `not_started`, `succeeded`, or `outcome_unknown`.
- Repair and rerun `not_started` only because dispatch did not occur.
- Treat `succeeded` as confirmed remote execution even if later local persistence fails.
- For `outcome_unknown`, follow `retryGuidance` and inspect, read back, or tag-reconcile the intended effect before deciding whether a retry is safe. Never blindly replay a mutation.
- If capture processing fails after `succeeded`, use standalone `figma:capture`. If stdout says `Status: failed after execution`, repair the named local stage and preserve the confirmed mutation result.

## OAuth

If a result reports `FIGMA_UPSTREAM_AUTH_REQUIRED` or `FIGMA_UPSTREAM_OAUTH_*`, ask the user before opening browser authorization. After approval, run `npm run login:figma-http` from `<plugin-root>`. Use `--force` only when fresh authorization is needed. Treat rate limiting, 5xx responses, and network refresh faults as transient; they retain the cached credential. Do not install or register a persistent local MCP entry.

## Reference Routing

- Read [overview](references/figma-workspace-overview.md) for command-family selection.
- Read [guidance and lookup](references/figma-workspace-guidance-and-lookup.md) for topic keywords, docs navigation, `canonical:` links, and API lookup.
- Read [workflow](references/figma-workspace-workflow.md) for execution, capture, and mutation recovery.
- Read [safety](references/figma-workspace-safety.md) for hard runtime boundaries and timeout semantics.
- Read [sessions](references/figma-workspace-sessions.md) for state, sidecars, and local locks.
- Read [diagnostics](references/figma-workspace-diagnostics.md) only to choose a failure repair.
- Read [upstream tools](references/figma-workspace-upstream-tools.md) before an official fallback call.
