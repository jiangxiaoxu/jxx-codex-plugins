# Validation Workflow & Error Recovery

> Reference for local `.figma.ts` workflows using the Figma Plugin API. How to debug, validate, and recover from errors.

## Contents

- `figma:metadata` vs `figma:capture`
- Error Recovery After Failed `.figma.ts` script
- Recommended Workflow


## `figma:metadata` vs `figma:capture`

After each `.figma.ts` script run, validate results using the right tool for the job. Do NOT capture every intermediate state; reserve PNG rendering for meaningful visual checks.

### `figma:metadata` — Use for intermediate validation (preferred)

`figma:metadata` returns an XML tree of node IDs, types, names, positions, and sizes. Use it to confirm:

- **Structure & hierarchy**: correct parent-child relationships, component nesting, section contents
- **Node counts**: expected number of variants created, children present
- **Naming**: variant property names follow the `property=value` convention
- **Positioning & alignment**: x/y coordinates, width/height values match expectations
- **Layout properties**: auto-layout direction, sizing mode, padding, spacing
- **Component set membership**: all expected variants are inside the ComponentSet

```
Example: After creating a ComponentSet with 120 variants, call figma:metadata on the
ComponentSet node to verify all 120 children exist with correct names, sizes, and positions
— without waiting for a full render.
```

**When to use `figma:metadata`:**
- After creating/modifying nodes — to verify structure, counts, and names
- After layout operations — to verify positions and dimensions
- After combining variants — to confirm all components are in the ComponentSet
- After binding variables — to verify node properties (use `.figma.ts` script to read bound variables if needed)
- Between multi-step workflows — to confirm step N succeeded before starting step N+1

### `figma:capture` and `$.capture` — Use after each major creation milestone

The capture workflow renders a pixel-accurate local PNG. It is the only way to verify visual correctness (colors, typography rendering, effects, variable mode resolution). It is slower than structural reads, so do not capture after every small operation; capture each major milestone instead.

Use standalone `figma:capture` when the node id is already known. If a script creates or resolves the target, call `await $.capture(target, options?)`; the helper queues host-side capture work after the script succeeds and the CLI returns completed local paths under `captures[]`. Queue at most 8 captures per execution, never return image bytes/base64 in the script result, and inspect every saved PNG.

**When to use `figma:capture`:**
- **After creating a component set** — verify variants look correct, grid is readable, nothing is collapsed or overlapping
- **After composing a layout** — verify overall structure and spacing
- **After binding variables/modes** — verify colors and tokens resolved correctly
- **After any fix or recovery** — verify the fix didn't introduce new visual issues
- **Before reporting results to the user** — final visual proof

**What to look for in screenshots** — these are the most commonly missed issues:
- **Cropped/clipped text** — line heights or frame sizing cutting off descenders, ascenders, or entire lines
- **Overlapping content** — elements stacking on top of each other due to incorrect sizing or missing auto-layout
- **Placeholder text** still showing ("Title", "Heading", "Button") instead of actual content

## Error Recovery After Failed `.figma.ts` script

Classify every result by its required `executionOutcome` before taking another write action:

- `not_started`: local input or target validation, TypeScript preflight, auth, or connection stopped the request before dispatch. Repair the cause, then resubmit the corrected script.
- `succeeded`: Figma confirmed the script completed. If capture or local persistence failed afterward, keep the confirmed result and do not rerun the mutation.
- `outcome_unknown`: dispatch occurred but completion cannot be confirmed. Follow the runtime's documented failure presentation and `retryGuidance`, inspect or read back the intended targets, and reconcile them before deciding whether any mutation remains.

**Recovery steps when `.figma.ts` script returns an error:**
1. **STOP — do not immediately rerun the mutation.** Read `executionOutcome`, diagnostics, `retryGuidance`, and the runtime's documented failure presentation first.
2. **Understand the error.** `not_started` applies only to local validation, TypeScript preflight, auth, or connection failures before dispatch. Font loading, invalid runtime property values, and missing runtime node references occur inside the host script after dispatch; use the returned outcome and failure presentation for recovery, never label them `not_started`.
3. For `outcome_unknown`, use `figma:metadata`, `figma:inspect`, or a narrow read-only query by returned ID or stable name to reconcile structural state. Use `figma:capture` followed by `view_image` when visual evidence is needed.
4. **Fix the script** based on the error and reconciled state.
5. Retry only work confirmed not to have run. Direct retry is valid for a corrected `not_started` request, not for an un-reconciled `outcome_unknown` mutation.

## Recommended Workflow

```
1. `.figma.ts` script  →  Create/modify nodes
2. figma:metadata     →  Verify structure, counts, names, positions (fast, cheap)
3. `.figma.ts` script  →  Fix any structural issues found
4. figma:metadata     →  Re-verify fixes
5. ... repeat as needed ...
6. figma:capture   →  Visual check after each major milestone

ON ERROR at any step:
   a. Read executionOutcome, retryGuidance, diagnostics, and the runtime's documented failure presentation
   b. For outcome_unknown, inspect/read back and reconcile the intended targets
   c. Fix the script based on the error and current state
   d. Retry only work confirmed not to have run
```
