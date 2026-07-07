# Figma Workspace Output Simplification TODO

## Summary

This document tracks output-shape cleanup candidates for `plugins/figma-workspace`. The goal is to keep `figma_workspace_*` tool responses focused on actionable agent data, while moving internal process details to diagnostics, resources, or debug files.

The current direction is intentionally breaking-change friendly: remove duplicated, derivable, or process-only fields from public structured responses when the same information is already available through a narrower source.

## Current Baseline

- `figma_workspace_get_metadata` no longer returns public `metadata.enrichment`. Native readback still runs internally, enriched lock/layout fields are merged into `metadata.json`, and enrichment failures are reported through `diagnostics`.
- `figma_workspace_call_upstream_tool` allows covered upstream tools for raw upstream behavior checks, but local `figma_workspace_*` tool names remain hard errors.
- Session resources are already split: `figma-workspace://sessions/{id}` returns compact detail, and `figma-workspace://sessions/{id}/handles` is the full handle-map entrypoint.

## TODO 1: Compact `figma_workspace_inspect`

### Current

- `mode: "inspect"` and `mode: "style"` can return a full `handles` map.
- Full handle state is already available from `figma-workspace://sessions/{id}/handles`.
- `mode: "style"` can also return a large `summary.children` tree even though the primary result is `style`.
- `mode: "inspect"` currently omits a `mode` field while `style` and `validate` include mode-specific fields, so the response shape is not fully uniform.
- `style.caps` reports internal per-category top-N caps. Because adaptive batching already handles read completeness, public output should not expose caps/limits as routine metadata.

### Expected Handling

- Stop returning full `handles` from all inspect modes: `inspect`, `style`, and `validate`.
- Stop returning `session.handleChanges` from all inspect modes. `figma_workspace_inspect` is read-only and should not report empty handle mutation state.
- Keep handle validation in `mode: "validate"` under `validations`; do not duplicate full handle cache.
- Return `mode` consistently for every inspect response. Default `mode: "inspect"` should be explicit in output.
- For `mode: "style"`, replace `summary` with a compact `targetSummary` identity object. Do not return `summary.children`.
- `targetSummary` should contain only target identity and bounds: `id`, `type`, `name`, `visible`, `x`, `y`, `width`, `height`.
- Remove `style.caps` entirely.
- Do not replace it with routine `limits`; caps/limits are implementation detail.
- Return truncation metadata only when the inline style summary is actually clipped:
  - `truncated`: object keyed by clipped category and omitted count, for example `{ textStyles: 31, strokes: 96 }`
  - do not return a separate `omittedCounts` object
- Compute omitted counts from full scanned category counts minus returned summary counts. Do not add extra upstream reads just to compute omitted counts.

### Expected After

- `inspect` response focuses on `target`, `mode: "inspect"`, and `summary`.
- `style` response focuses on `target`, `mode`, `targetSummary`, `nodeCount`, `scannedNodeCount`, `offset`, and `style`.
- `validate` response focuses on `mode` and `validations`.
- `style` does not contain `caps` or `limits`; `truncated` appears only when summary entries are clipped and its values are omitted counts.
- Full handles are read from `figma-workspace://sessions/{id}/handles`, not from inspect output.
- Handle mutations are reported by mutating tools such as `open`, `eval`, and `run_script_file`, not by `inspect`.

### Tests

- Update inspect tests to assert `handles === undefined` for `inspect`, `style`, and `validate`.
- Update inspect tests to assert `session.handleChanges === undefined` for `inspect`, `style`, and `validate`.
- Update inspect tests to assert empty `diagnostics` is omitted for clean `inspect`, `style`, and `validate` responses.
- Update inspect tests to assert `mode` is returned for all modes, including default `inspect`.
- Add or adjust a resource test proving full handles remain available through `sessions/{id}/handles`.
- For style mode, assert `style` content remains unchanged, `summary === undefined`, `targetSummary` is present, and child summaries are omitted.
- For style mode, assert `style.caps === undefined`, `style.limits === undefined`, and `style.truncated` appears only when a category is clipped with count values.

## TODO 2: Remove `validatedNodeIds`

### Current

- `figma_workspace_inspect({ mode: "validate" })` returns both `validations` and `validatedNodeIds`.
- `validatedNodeIds` is derivable from `validations.filter(item => item.status === "valid").map(item => item.id)`.

### Expected Handling

- Remove public `validatedNodeIds`.
- Keep `validations` as the single source of truth.
- Internal batching can still use `validatedNodeIds` while composing the final validation result, but it should not leak into structured output.

### Expected After

- Validate responses include `validations` only.
- Callers derive valid ids from `validations`.

### Tests

- Update validation tests to assert `validatedNodeIds === undefined`.
- Assert valid entries still contain enough data to derive valid node ids.
- Keep large-batch validation coverage to ensure internal batching still works.

## TODO 3: Trim `run_script_file.script` On Success

### Current

- `figma_workspace_run_script_file` returns `script.scriptPath`, `script.expectedSurface`, and `script.compiledScriptBytes`.
- On successful execution these fields are mostly process metadata and add absolute-path noise.
- On preflight and execution failures, `scriptPath` and compile size can still help repair.

### Expected Handling

- Keep `script` details for `phase: "preflight"` and failure/debug cases.
- On clean successful `phase: "execute"` responses, keep only `script.inputFile` when the caller used `inputFile`; do not return absolute `scriptPath`, `expectedSurface`, or `compiledScriptBytes`.
- Keep output file pointers for failures and inline omissions unchanged.

### Expected After

- Clean success returns `ok`, `phase`, `executed`, `session`, optional `script: { inputFile }`, `diagnostics`, `upstream`, and optional `inlineResultLimit` / `outputFiles`.
- Preflight failures still return `script` with line-aware source paths and compile details.

### Tests

- Update clean run-script success tests to assert only `script.inputFile` remains when using `inputFile`, and absolute paths / compile details are omitted.
- Keep preflight diagnostics tests asserting `script.scriptPath` is present.
- Keep output debug file tests for failure and inline omission cases.

## TODO 4: Return `repairPlan` Only When Actionable

### Current

- `figma_workspace_eval` and `figma_workspace_run_script_file` can return `repairPlan: { status: "ok", steps: [] }` on clean success.
- This is not actionable and repeats the empty diagnostics state.

### Expected Handling

- Return `repairPlan` only when diagnostics are non-empty, when execution is blocked, or when parse/type/guardrail repair is needed.
- Clean success should omit `repairPlan`.

### Expected After

- Clean success has no `repairPlan`.
- Preflight blocked, parse error, and diagnostic cases keep the full repair plan.

### Tests

- Update clean eval/script success tests to assert `repairPlan === undefined`.
- Keep all blocked/preflight tests asserting repair plan status, steps, and occurrences.

## TODO 5: Omit Empty `diagnostics` Outside Inspect

### Current

- Many tools return `diagnostics: []` on clean success.
- Some wrappers already omit diagnostics when there are no warnings.
- The mixed behavior adds response noise and makes success payloads larger.

### Expected Handling

- Defer global diagnostics cleanup.
- For the inspect compaction batch only, omit empty `diagnostics` from `figma_workspace_inspect` clean success responses.
- Keep other tools' current diagnostics behavior until a dedicated global pass.

### Expected After

- Inspect clean success omits `diagnostics`.
- Other tools keep their current behavior for now.
- Any warning/fatal inspect result includes `diagnostics`.

### Tests

- Update inspect clean success tests to assert `diagnostics === undefined`.
- Keep inspect warning/failure tests asserting exact diagnostic codes.
- Leave global tool output schema wording unchanged until the dedicated global pass.

## TODO 6: Omit Empty `session.handleChanges` Outside Inspect

### Current

- Read-only calls often return `session.handleChanges: { updated: [], removed: [] }`.
- Empty handle changes are process-state noise.

### Expected Handling

- Defer global empty `handleChanges` cleanup.
- For the inspect compaction batch only, omit `session.handleChanges` from all `figma_workspace_inspect` responses.
- For other tools, keep current `handleChanges` behavior until a dedicated global pass.
- When the global pass is implemented, omit `handleChanges` only when both arrays are empty and keep it when handles are updated or removed.
- Keep session id/file/surface/sessionDir behavior unchanged.

### Expected After

- Inspect responses have compact `session`.
- Other tools keep current `session.handleChanges` behavior for now.
- Eval/script calls that remember or remove handles continue to report changed handles.

### Tests

- Update inspect tests to assert `session.handleChanges === undefined`.
- Keep eval/script handle persistence tests asserting non-empty `handleChanges`.
- Ensure session resource handle maps remain unchanged.

## TODO 7: Revisit Routine `guidanceRef`

### Current

- `figma_workspace_get_design_context` and `figma_workspace_get_motion_context` return `guidanceRef` on normal success.
- `guidanceRef` is static routing metadata and repeats information available from `capabilities`, `lookup-index`, and `figma_workspace_guidance`.

### Expected Handling

- Defer removing `guidanceRef`.
- Keep current `guidanceRef` behavior for now because it is small and useful routing metadata.
- Revisit only after higher-noise fields have been compacted.

### Expected After

- No behavior change in the current simplification pass.
- Design/motion wrappers continue returning `guidanceRef` on clean success.

### Tests

- Keep existing design/motion wrapper success tests for `guidanceRef`.
- Keep resource tests ensuring wrapper profiles and workflow graph hints remain discoverable.

## TODO 8: Compact `inlineResultLimit`

### Current

- `inlineResultLimit` includes duplicate machine and human-readable fields:
  - `limit`, `limitBytes`, `limitHuman`
  - `omitted[].bytes`, `omitted[].bytesHuman`, `omitted[].limit`, `omitted[].limitHuman`
- Human-readable fields are useful for logs but noisy in structured responses.

### Expected Handling

- Use a compact machine-first shape:
  - `limitBytes`
  - `omitted: [{ field, bytes }]`
  - optional short `guidance` if still useful for agents
- Drop `limit`, `limitHuman`, `omitted[].limit`, and `omitted[].*Human`.

### Expected After

- Inline omission metadata is small and deterministic.
- UI or callers can format human-readable byte strings if needed.

### Tests

- Update all inline-limit tests for eval, script, metadata, wrappers, and call-upstream.
- Keep sidecar/debug output assertions unchanged.

## TODO 9: Compact `run_task_plan` Step Output

### Current

- `figma_workspace_run_task_plan` returns step timestamps and can duplicate output references at both step and top level.
- Detailed timeline data is more useful in the plan debug file than in the inline response.

### Expected Handling

- Inline step output should keep `id`, `index`, `type`, `status`, `ok`, `summary`, and `outputReferences`.
- Move `startedAt` / `finishedAt` to the debug file only.
- Keep per-step `outputReferences` only; remove top-level aggregate `outputReferences` from inline output.

### Expected After

- Task plan inline output reads as a compact execution summary.
- Full audit detail remains available in `outputFiles.debugFile`.

### Tests

- Update task plan tests to assert timestamps are omitted inline.
- Keep debug file tests asserting detailed audit output is still written.
- Verify output references are available only from the owning step inline.

## Rollout Notes

- These changes are public output-shape breaking changes and should be implemented in small batches.
- After each batch, update:
  - runtime handlers,
  - `LOCAL_WORKSPACE_TOOL_OUTPUT_SCHEMAS`,
  - resource guidance if response-shape wording changes,
  - tests in `workspace-mcp-server.test.mjs`,
  - generated `dist/runtime/workspace-runtime.js`.
- Run from `plugins/figma-workspace/mcp-server`:
  - `npm run build`
  - `node --test tests/workspace-mcp-server.test.mjs`

## Suggested Order

1. `inspect` handle/style/mode/truncation metadata compaction.
2. Remove `validatedNodeIds`.
3. Trim `run_script_file.script` on success.
4. Omit successful `repairPlan`.
5. Omit empty inspect `diagnostics`; defer global diagnostics cleanup.
6. Omit empty inspect `session.handleChanges`; defer global handleChanges cleanup.
7. Keep routine `guidanceRef` for now; revisit later.
8. Compact `inlineResultLimit`.
9. Compact `run_task_plan` step output.
