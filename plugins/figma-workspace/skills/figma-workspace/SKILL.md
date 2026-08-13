---
name: figma-workspace
description: Route Figma, FigJam, Slides, design-system, token, component, Plugin API lookup, OAuth, creation, editing, inspection, capture, validation, and mutation recovery through stateless public figma:* leaf commands.
---

# Figma Workspace

Use the bundled Node CLI for Figma work. It has no agent-facing local MCP server; the official remote MCP is internal transport only. Each invocation is independent: provide a Figma target again when the selected command or live upstream schema requires one. Targetless lookup commands do not inherit a prior target.

## Start And Discover

1. Resolve `<plugin-root>` as `<skill-dir>/../..` and run commands there with `npm --silent`.
2. Run `npm --silent run figma:help` for the public leaf-command inventory. Use the selected leaf command's `--help` before first use; generated help owns exact input schemas, limits, result fields, and exit behavior.
3. Read stdout as Restricted Markdown; never parse it as JSON. Keep the default inline-result threshold for normal agent calls. If stdout provides `outputFiles.cliResultFile`, treat that complete JSON sidecar as the machine-readable result: inspect its keys, paths, types, and structure, extract the necessary fields, then expand further only as needed. Do not raise the inline threshold merely to avoid sidecar handling; consider raising it only when the user needs the complete result rendered inline for direct reading or visual presentation.

Use `figma:docs:help`, `figma:api:help`, or `figma:upstream:help` only to browse the corresponding fixed command family; they do not establish target context.

Use only the public commands below. Do not expose transport names, internal identifiers, MCP tools, resource URIs, or corpus files.

## Address Figma When Required

- File-scoped work takes `--file <Figma-file-URL|fileKey>`.
- Node-scoped work takes a full node URL through `--target <URL>`, or the explicit pair `--file <URL|fileKey> --node <nodeId>`.
- A URL `node-id=230-2` normalizes to Plugin API node ID `230:2`; the slug and `t` query parameter are not identity. A bare node ID is never sufficient.
- A Figma URL determines the Design, FigJam, or Slides surface. With a raw fileKey, provide `--surface` whenever the selected command requires a surface.
- Do not derive a target from a local selection, page shortcut, prior invocation, or persisted context. Conflicting explicit file and node URL values fail before dispatch.
- `figma:upstream:list` and `figma:upstream:read` take no Figma target. For `figma:upstream:call`, read the selected live schema and provide only the target fields it requires.

## Route The Intent

- For an obvious read-only request, select its direct command below.
- For non-trivial, generated, or unclear work, use `figma:docs:catalog`, then narrow with `figma:docs:search` using concise English task terms as recommended search seeds and the known surface. Read exact returned `project:` or `canonical:` IDs through `figma:docs:read`.
- Use `figma:api:search` for native Plugin API declarations. It accepts bare, qualified, and call-shaped queries such as `createFrame`, `figma.createFrame()`, and `ComponentNode.createInstance`. When a compact result is insufficient, read its exact returned `apiId` through `figma:api:read`.
- Use `figma:doctor` only to diagnose packaged docs, corpus, TypeScript, or Plugin API index faults. It is local-only and requires no Figma target.
- Read the selected leaf help for numeric ranges. Catalog/search display limits clamp safe out-of-range integers and report `parameterAdjustments`; traversal depth, pagination offset, capture dimensions, and remote inline-result bytes are strict usage boundaries.
- If routing remains unclear, use the Search Query Recipes and catalog rather than guessing. Docs and API lookup are local-only and need no Figma target.

Read [guidance and lookup](references/figma-workspace-guidance-and-lookup.md) for the static topic-to-query map.

## Search Query Recipes

Prefer these English keyword patterns as search seeds. Add the known surface and task family as hard filters when available; English is recommended for relevance, not required by the input layer.

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

| Intent | Public commands | Target rule |
| --- | --- | --- |
| Find workflow docs | `figma:docs:help`, `figma:docs:list`, `figma:docs:catalog`, `figma:docs:search`, `figma:docs:read` | No Figma target. |
| Find Plugin API | `figma:api:help`, `figma:api:search`, `figma:api:read` | No Figma target. |
| Diagnose installed runtime assets | `figma:doctor` | No Figma target. |
| Understand a file | `figma:metadata`, `figma:inspect` | File for metadata; node URL or file-plus-node for inspect. |
| Read implementation context | `figma:design-context`, `figma:motion-context` | Explicit node target. |
| Read design systems | `figma:variables`, `figma:design-system`, `figma:libraries` | Explicit file or node target as required by help. |
| Execute Plugin API | `figma:run` | Explicit file plus a local `.figma.ts` script or stdin source. |
| Move assets | `figma:assets:apply`, `figma:assets:download` | Every manifest or operation target is explicit. |
| Verify visually | `figma:capture` | Explicit node target; inspect the saved PNG with `view_image`. |
| Use an uncovered official capability | `figma:upstream:help`, `figma:upstream:list`, `figma:upstream:read`, `figma:upstream:call` | `list`/`read` are targetless. Read the selected live schema before `call`; provide only required target fields and obtain explicit confirmation for marked destructive, external, credit/cost, or asset-upload actions. |

## Implement And Verify

1. Start with a full Figma URL whenever available. Use `figma:metadata` for broad discovery, then use targeted `figma:inspect` and the first-class context commands only as required.
2. Create `.figma.ts` files in the shell or project working directory. For a file script, run:

   ```text
   npm --silent run figma:run -- --file <URL|fileKey> --surface <design|figjam|slides> --script <path/to/change.figma.ts>
   ```

   To provide source on stdin, use `--source -` instead of `--script`. The two source modes are mutually exclusive.
3. Use native Figma Plugin API for edits, `figma:api:search` for uncertain symbols, and `figma:api:read` for the complete declaration behind a returned `apiId`. Keep scripts repairable, return compact changed-node IDs and validation notes, and repair fatal preflight diagnostics before dispatch.
4. Capture visible results through queued `$.capture` or standalone `figma:capture`, then inspect every generated or edited PNG with `view_image` before reporting visual success.
5. Prefer first-class commands. Use `figma:upstream:list`, `figma:upstream:read`, and `figma:upstream:call` only for an uncovered official capability. Before calling, follow the selected live description and schema, including its confirmation requirements.

Read [workflow](references/figma-workspace-workflow.md) for `.figma.ts`, capture, local artifacts, and mutation recovery details.

## Local Artifacts And Mutation Results

- Pure inline reads do not create a persistent workspace record. When an invocation must write a sidecar, diagnostic, capture, or download and no explicit output path is supplied, the CLI returns an absolute path beneath its invocation-specific OS temp directory.
- Treat `outputFiles.cliResultFile` as the machine-readable result. Discover its structure and extract only relevant content before expanding large values; do not treat the Restricted Markdown envelope as JSON.
- Use explicit `--output-dir`, `--image-file`, or download output options when the caller needs a durable local location. Managed paths reject links and reparse points and publish atomically.
- The temporary fileKey lock covers `figma:run`, `figma:assets:apply`, and `figma:upstream:call` only when that call resolves a fileKey. This is coordination only, not distributed durability.
- `figma:run` reports `executionOutcome`: `not_started`, `failed_atomic`, `succeeded`, or `outcome_unknown`. `failed_atomic` is a direct returned `use_figma` script error: Figma confirmed no file changes, so repair and retry safely.
- Repair and rerun `not_started` only because dispatch did not occur. Treat `succeeded` as confirmed remote execution even if later local output processing fails.
- For `failed_atomic`, stdout directly provides a compact remote error code/message and `Status: failed atomically`; repair the script and retry safely. `outcome_unknown` means completion was not confirmed, including response loss or truncation: follow `retryGuidance`, inspect, read back, or tag-reconcile before deciding whether any retry is safe. Never blindly replay a mutation when its outcome is unknown.
- If capture processing fails after `succeeded`, use standalone `figma:capture`. `Status: failed after execution` is only for a named local stage that failed after confirmed execution; repair it and preserve the confirmed mutation result.

## OAuth

If a result reports `FIGMA_UPSTREAM_AUTH_REQUIRED` or `FIGMA_UPSTREAM_OAUTH_*`, ask the user before opening browser authorization. After approval, run `npm run login:figma-http` from `<plugin-root>`. Use `--force` only when fresh authorization is needed. Treat rate limiting, 5xx responses, and network refresh faults as transient; they retain the cached credential. Do not install or register a persistent local MCP entry.

## Reference Routing

- Read [overview](references/figma-workspace-overview.md) for command-family selection.
- Read [guidance and lookup](references/figma-workspace-guidance-and-lookup.md) for static topic keywords, docs navigation, `canonical:` links, and API lookup.
- Read [workflow](references/figma-workspace-workflow.md) for execution, capture, local artifacts, and mutation recovery.
- Read [safety](references/figma-workspace-safety.md) for hard runtime boundaries and timeout semantics.
- Read [local artifacts](references/figma-workspace-artifacts.md) for output, sidecar, and same-machine lock behavior.
- Read [diagnostics](references/figma-workspace-diagnostics.md) only to choose a failure repair.
- Read [upstream tools](references/figma-workspace-upstream-tools.md) before an official fallback call.
