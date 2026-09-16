---
name: figma-workspace
description: Route Figma, FigJam, Slides, design-system, token, component, Plugin API lookup, OAuth, creation, editing, inspection, capture, validation, and mutation recovery through stateless public figma:* leaf commands.
---

# Figma Workspace

Use the bundled Node CLI for Figma work. It has no agent-facing local MCP server; the official remote MCP is internal transport only. Each invocation is independent: provide a Figma target again when the selected command or live upstream schema requires one. Targetless lookup commands do not inherit a prior target.

## Start And Discover

1. Resolve `<plugin-root>` as `<skill-dir>/../..` and run commands there with `npm --silent`.
2. Run `npm --silent run figma:help` for the public leaf-command inventory. Use the selected leaf command's `--help` before first use; generated help owns exact input schemas, limits, result fields, and exit behavior.
3. Read stdout as Restricted Markdown; never parse it as JSON. Keep the default inline-result threshold for normal agent calls. If stdout provides `outputFiles.resultFile`, treat that complete JSON receipt as the machine-readable result. Use the receipt's `jq.full`, `jq.status`, or `jq.data` filters to read the receipt, status, or business data, then expand only the fields needed. Do not raise the inline threshold merely to avoid the result file; consider raising it only when the user needs the complete result rendered inline for direct reading or visual presentation.

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
- Use `figma:api:search <selector>` for native Plugin API declarations. It accepts one bare, qualified, or call-shaped selector such as `createFrame`, `figma.createFrame()`, or `ComponentNode.createInstance`. The output is human-readable. If a bare selector is ambiguous, search prints qualified selectors such as `BaseNonResizableTextMixin.fontName`; pass one to `figma:api:read <selector>`. Overloads for the selected owner are read together. API lookup does not require or expose declaration-file paths, source line numbers, or opaque IDs.
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
| Understand a Design file | `figma:metadata`, `figma:inspect` | Design URL or fileKey plus `--surface design` for metadata; node URL or file-plus-node for inspect. |
| Understand a FigJam board or Slides deck | Read-only `figma:run`, `figma:capture` | `figma:metadata` is Design-only. |
| Read implementation context | `figma:design-context`, `figma:motion-context` | Explicit node target. |
| Read design systems | `figma:variables`, `figma:design-system`, `figma:libraries` | Explicit file or node target as required by help. |
| Execute Plugin API | `figma:run` | Explicit file plus a local `.figma.ts` script or stdin source. |
| Move assets | `figma:assets:apply --input <json-file|->`, `figma:assets:download (--target <node-url> or --file <url|key> --node <node-id>)` | Uploads use an `assets` array in the input document; downloads address one explicit node. Relative upload paths use the JSON file directory, or invocation cwd for stdin. |
| Verify visually | `figma:capture` | Explicit node target; inspect the saved PNG with `view_image`. |
| Connect code components | `figma:code-connect:inspect`, `figma:code-connect:plan`, `figma:code-connect:apply`, `figma:code-connect:verify` | Design file only; use the same explicit `--file` for all four steps. |
| Use an official capability through its live schema | `figma:upstream:help`, `figma:upstream:list`, `figma:upstream:read`, `figma:upstream:call` | `list`/`read` are targetless. `coverage` can point to a first-class command but never blocks `call`. Read the selected live schema; provide only required target fields and obtain explicit confirmation for marked destructive, external, credit/cost, or asset-upload actions. |

## Implement And Verify

1. Start with a full Figma URL whenever available. Use `figma:metadata` only for broad Design-file discovery; use a read-only `figma:run` script for FigJam or Slides structure, then use targeted `figma:inspect` and applicable context commands.
   For a large tree, keep `figma:inspect` to one remote read per invocation and request pages explicitly with `--cursor`. Use `--fields` to omit verbose properties such as `characters` when they are not needed. The result includes `nodes`, `hasMore`, and an opaque `nextCursor`; pass the cursor to the next invocation with the same file and node. Pages are live reads and do not form a snapshot, so edits between pages can cause duplicates or omissions.
2. Create `.figma.ts` files in the shell or project working directory. For a file script, run:

   ```text
   npm --silent run figma:run -- --file <URL|fileKey> --surface <design|figjam|slides> --script <path/to/change.figma.ts>
   ```

   To provide source on stdin, use `--source -` instead of `--script`. The two source modes are mutually exclusive.
3. Use native Figma Plugin API for edits, `figma:api:search` for uncertain symbols, and `figma:api:read` for the complete declaration selected by a readable selector. Keep scripts repairable, return compact changed-node IDs and validation notes, and repair fatal preflight diagnostics before dispatch.
4. Capture visible results through queued `$.capture` or standalone `figma:capture`, then inspect every generated or edited PNG with `view_image` before reporting visual success.
5. Prefer first-class commands for their typed safeguards. `figma:upstream:list` and `figma:upstream:read` show live schema plus local `coverage`; `figma:upstream:call` remains available for every official tool when the live schema is the required contract. Before calling, follow the selected description and schema, including its confirmation requirements.

### Code Connect

Use the Design-only Code Connect workflow for simple mappings between published Figma components and existing code UI components:

1. `figma:code-connect:inspect --file <Design URL|fileKey>` discovers components available for mapping.
2. `figma:code-connect:plan --file <Design URL|fileKey> --input <manifest.json|->` validates an explicit manifest and writes an immutable plan with a `planDigest`.
3. `figma:code-connect:apply --file <Design URL|fileKey> --plan <path> --confirm-plan <planDigest>` is the only write command. Missing or mismatched confirmation, an invalid target/artifact, stale snapshots, and unapproved conflicts return `not_started` before dispatch; otherwise it bulk-writes and verifies.
4. `figma:code-connect:verify --file <Design URL|fileKey> --plan <path>` safely reports `matched`, `missing`, `mismatch`, or `unavailable`.

Manifest mappings use simple node IDs plus `componentName`, `source`, and the live `label`; there are 1 to 64 unique `(nodeId, label)` entries. `conflictPolicy` defaults to `fail`; use `replace` only intentionally. `template` and `templateDataJson` are rejected, and the CLI does not scan or validate source files. Keep the plan and digest unchanged. After `outcome_unknown`, run `verify` before any retry. Use the generic `figma:upstream:*` path for uncovered capabilities; do not create Code Connect template files or pass them to `figma:run`.

Read [workflow](references/figma-workspace-workflow.md) for `.figma.ts`, capture, local artifacts, and mutation recovery details.

## Local Artifacts And Mutation Results

- Pure inline reads do not create a persistent workspace record. When an invocation must write a result receipt, diagnostic, capture, or download, pass an explicit absolute output path inside the current user workspace. Do not use the plugin directory as the workspace output root. The CLI still falls back to an invocation-specific OS temp directory when an option is omitted, but agents must not rely on that default.
- Every command whose leaf help exposes `--output-dir` must receive that option with an absolute directory inside the current user workspace. For commands with file-only options, such as `--image-file` or `--output-plan`, pass an absolute path inside the same workspace and pass `--output-dir` when the command also supports it. Pure docs/help and commands without an artifact option do not need an output path.
- Treat `outputFiles.resultFile` as the machine-readable result. Stdout identifies its path once; read the receipt file directly and use its advertised `jq` filters instead of parsing the Restricted Markdown envelope. Error summaries remain inline; full diagnostics and pagination data remain in the receipt when the compact envelope does not expose them.
- When the receipt shape is unknown, use `jq` to inspect top-level keys and the target branch before querying only needed fields, counts, or bounded samples. Do not load the full receipt into context; when the shape is known, query it directly without repeating discovery.
- A complete invocation result is published once through `outputFiles.resultFile` when inline output is omitted. The receipt has `kind: "figma-cli-result"`, `schemaVersion: 1`, `tool`, `invocation`, and `result`; direct and typed protocol calls additionally expose sanitized `upstream`. Its `jq.full`, `jq.status`, and `jq.data` filters are the supported machine-readable entry points. Protocol `_meta` and tool-definition annotations are omitted, while an ordinary business `_meta` inside `structuredContent` is preserved. Over-budget direct responses return a bounded resource-limit diagnostic without persisting the payload.
- Managed paths reject links and reparse points and publish atomically.
- The temporary fileKey lock covers `figma:run`, `figma:assets:apply`, `figma:code-connect:apply`, and `figma:upstream:call` only when that call resolves a fileKey. This is coordination only, not distributed durability.
- `figma:run` and `figma:upstream:call` report `executionOutcome`: `not_started`, `failed_atomic`, `succeeded`, or `outcome_unknown` when they dispatch a mutation. A direct returned `use_figma` script error is `failed_atomic`: Figma confirmed no file changes, so repair and retry safely. A post-dispatch error from another direct official tool remains `outcome_unknown` unless completion is independently confirmed.
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
- Read [local artifacts](references/figma-workspace-artifacts.md) for output receipt and same-machine lock behavior.
- Read [diagnostics](references/figma-workspace-diagnostics.md) only to choose a failure repair.
- Read [upstream tools](references/figma-workspace-upstream-tools.md) before an official fallback call.
