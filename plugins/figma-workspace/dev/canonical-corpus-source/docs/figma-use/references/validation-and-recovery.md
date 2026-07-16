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

**`.figma.ts` script is atomic — failed scripts do not execute.** If a script errors, no changes are made to the file. The file remains in exactly the same state as before the call. There are no partial nodes, no orphaned elements, and retrying after a fix is safe.

**Recovery steps when `.figma.ts` script returns an error:**
1. **STOP — do NOT immediately fix the code and retry.** Read the error message carefully first.
2. **Understand the error.** Most errors are caused by wrong API usage, missing font loads, invalid property values, or referencing nodes that don't exist.
3. **If the error is unclear**, call `figma:metadata` or `figma:capture` to understand the current file state and confirm nothing has changed.
4. **Fix the script** based on the error message.
5. **Retry** the corrected script.

## Recommended Workflow

```
1. `.figma.ts` script  →  Create/modify nodes
2. figma:metadata     →  Verify structure, counts, names, positions (fast, cheap)
3. `.figma.ts` script  →  Fix any structural issues found
4. figma:metadata     →  Re-verify fixes
5. ... repeat as needed ...
6. figma:capture   →  Visual check after each major milestone

⚠️ ON ERROR at any step:
   a. Read the error message carefully
   b. figma:metadata / figma:capture  →  If the error is unclear, inspect file state
   c. Fix the script based on the error
   d. Retry the corrected script (safe — failed scripts don't modify the file)
```
