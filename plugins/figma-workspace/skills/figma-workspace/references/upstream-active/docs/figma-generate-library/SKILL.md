# Design System Builder

Build professional-grade design systems in Figma that match code. Use the multi-phase workflow below with the Figma Workspace CLI.

Write Plugin API work as local `.figma.ts` files and execute it with `figma:script:run`. Use `figma:eval` only for small, focused Plugin API transactions. JavaScript under this source skill's `scripts/` directory is preserved as non-executable reference material: do not run it directly or route it as a tool.

---

## 1. The One Rule That Matters Most

For every phase, follow this communication contract.

Before starting a phase:
- Post a user-facing checklist titled `Phase N Checklist`.
- Include every task/subtask that will be attempted in that phase.
- Include the phase exit criteria.
- Do not begin mutating work for the phase until this checklist has been posted.
- If the phase requires explicit approval, ask for approval after the checklist and wait.

During execution:
- Before each major subsection, post a short update naming the exact section being worked on, using this format:
  `Working on Phase N.X: <section name>`
- Keep updates concise, but make the current work visible.
- When a subsection completes, mark it as completed in the running checklist if the interface supports checklist/status updates; otherwise mention completion in the next progress update.

At the end of each phase:
- Post a `Phase N Summary` with:
  - Completed tasks
  - Created or changed Figma objects
  - Validations performed
  - Decisions or conflicts resolved
  - Remaining risks or follow-ups
- Then show the required phase artifact for that phase and continue automatically.
- Only ask for explicit approval after Phase 0 or if a genuine decision fork arises (see [Section 6](#6-decision-forks)). For Phases 1–4, the default is to continue automatically after the summary.

### Stable Task IDs

Use one task ID format everywhere: `P{phase}.{step}`.

Rules:
- Use lettered step IDs only: `P0.a`, `P0.b`, `P1.a`, `P3.d`.
- Do not use plain bullet points for task lists.
- Every phase checklist, progress update, validation note, and phase summary MUST reference the same task IDs

**No setup exception:** Creating a new Figma file, importing a library, creating pages, variables, collections, styles, or components all count as creation/mutation. Do not treat any of them as harmless setup.

**This is not a one-shot task.** Break design-system work into small, repairable `.figma.ts` runs, validate each meaningful change, and keep the user informed.

---

## 2. Phased Workflow

Work through the phases in order. Do not move to the next phase until the current phase's required actions and acceptance checks are complete. If a phase cannot pass, stop and report the blocker. Do not approximate, skip, or defer a failed phase unless the user explicitly approves the limitation. No best-effort substitutions. No quiet approximations. No handoff with missing source truth, missing visual truth, fake assets, approximate typography, broken interactions, or unverified states.

### Phase 0: DISCOVERY (before writes)

- [ ] 0a. Analyze codebase → extract tokens, components, naming conventions
- [ ] 0b. Inspect Figma file → pages, variables, components, styles, existing conventions
- [ ] 0c. Search subscribed libraries with `figma:design-system` for reusable assets
- [ ] 0d. Lock v1 scope → exact token set + component list recorded before any creation
- [ ] 0e. Map code → Figma → every conflict (code disagrees with Figma) resolved and recorded
- [ ] 0f. Print a **gap analysis** to chat: what exists in code but not Figma, what exists in Figma but not code, and every conflict from 0e with its resolution

### Phase 1: FOUNDATIONS (tokens first — always before components)

- [ ] 1a. Create variable collections and modes
- [ ] 1b. Create primitive variables (raw values, 1 mode)
- [ ] 1c. Create semantic variables (aliased to primitives, mode-aware)
- [ ] 1d. Set scopes on ALL variables (never `ALL_SCOPES`)
- [ ] 1e. Set code syntax on ALL variables
- [ ] 1f. Create effect styles (shadows) and text styles (typography)
- [ ] 1g. Print a **variable summary** to chat: N collections, M variables, K modes, broken down by collection
- [ ] 1h. Print the **style list** to chat: every effect style and text style created, with names
- [ ] Exit criteria met: every token from the agreed plan exists, all scopes set, all code syntax set

### Phase 2: FILE STRUCTURE (before components)

- [ ] 2a. Create page skeleton: Cover → Getting Started → Foundations → --- → Components → --- → Utilities
- [ ] 2b. Create foundations documentation pages (color swatches, type specimens, spacing bars)
- [ ] 2c. Capture every foundations page with `figma:capture`, inspect each image with `view_image`, and print the **page list** alongside the results
- [ ] Exit criteria met: all planned pages exist, foundations docs are navigable

### Phase 3: COMPONENTS (one at a time — never batch)

For EACH component (in dependency order: atoms before molecules), run the checklist below. Finish the current component before starting the next.

- [ ] 3a. Create dedicated page
- [ ] 3b. Build base component with auto-layout + full variable bindings
- [ ] 3c. Create all variant combinations (`combineAsVariants` + grid layout)
- [ ] 3d. Add component properties (TEXT, BOOLEAN, INSTANCE_SWAP)
- [ ] 3e. Link properties to child nodes
- [ ] 3f. Add page documentation (title, description, usage notes)
- [ ] 3g. Validate with `figma:metadata` (structure) and `figma:capture` followed by `view_image` (visual)
- [ ] 3h. Optional: lightweight Code Connect mapping while context is fresh
- [ ] Exit criteria met: variant count correct, all bindings verified, screenshot looks right

### Phase 4: INTEGRATION + QA (final pass)

- [ ] 4a. Finalize all Code Connect mappings
- [ ] 4b. Accessibility audit (contrast, min touch targets, focus visibility)
- [ ] 4c. Naming audit (no duplicates, no unnamed nodes, consistent casing)
- [ ] 4d. Unresolved bindings audit (no hardcoded fills/strokes remaining)
- [ ] 4e. Final review screenshots of every page

---

## 3. Critical Rules

**Plugin API basics**:
- Use `return` to send data back (auto-serialized). Do NOT wrap in IIFE or call closePlugin.
- Return ALL created/mutated node IDs in every return value
- Set the current page at most once per `.figma.ts` script. Keep each mutating run focused on one component or documentation page; do not loop through pages and switch context during a mutation.
- `figma.notify()` throws — never use it
- Colors are 0–1 range, not 0–255
- Font MUST be loaded before any text write: `await figma.loadFontAsync({family, style})`. Use `await figma.listAvailableFontsAsync()` to discover available fonts and verify exact style strings — if a load fails, query available fonts to find the correct name or a fallback.

**Design system rules**:
1. **Variables BEFORE components** — components bind to variables. No token = no component.
2. **Inspect before creating** — use `figma:metadata`, `figma:variables`, `figma:design-system`, and `figma:libraries` to discover existing conventions. Match them.
3. **One page per component** *(default)* — exception: tightly related families (e.g., Input + helpers) may share a page with clear section separation.
4. **Bind visual properties to variables** *(default)* — fills, strokes, padding, radius, gap. Exceptions: intentionally fixed geometry (icon pixel-grid sizes, static dividers).
5. **Scopes on every variable** — NEVER leave as `ALL_SCOPES`. Background: `FRAME_FILL, SHAPE_FILL`. Text: `TEXT_FILL`. Border: `STROKE_COLOR`. Spacing: `GAP`. Radii: `CORNER_RADIUS`. Primitives: `[]` (hidden).
6. **Code syntax on every variable** — WEB syntax MUST use the `var()` wrapper: `var(--color-bg-primary)`, not `--color-bg-primary`. Use the actual CSS variable name from the codebase. ANDROID/iOS do NOT use a wrapper.
7. **Alias semantics to primitives** — `{ type: 'VARIABLE_ALIAS', id: primitiveVar.id }`. Never duplicate raw values in semantic layer.
8. **Position variants after combineAsVariants** — they stack at (0,0). Manually grid-layout + resize.
9. **INSTANCE_SWAP for icons** — never create a variant per icon. Cap variant matrices: if Size × Style × State > 30 combinations, split into sub-component.
10. **Deterministic naming** — use consistent, unique node names for idempotent cleanup and resumability. Track created node IDs via return values and the state ledger.
11. **No destructive cleanup** — cleanup scripts identify nodes by name convention or returned IDs, not by guessing.
12. **Validate before proceeding** — never build on unvalidated work. Use `figma:metadata` after every create and `figma:capture` plus `view_image` after each component.
13. **Keep mutations sequential** — do not execute concurrent Figma write runs.
14. **Never hallucinate Node IDs** — always read IDs from the state ledger returned by previous calls. Never reconstruct or guess an ID from memory.
15. **Use local `.figma.ts` scripts** — keep reusable Plugin API logic in a checked script rather than a large inline transaction. The bundled `scripts/` files are non-executable examples only.

---

## 4. State Management (Required for Long Workflows)

> Use `getSharedPluginData()` / `setSharedPluginData()` or name-based lookups and the state ledger (returned IDs) for durable node markers.

| Entity type | Idempotency key | How to check existence |
|-------------|----------------|----------------------|
| Scene nodes (pages, frames, components) | `setSharedPluginData('dsb', 'key', value)` or unique name | `node.getSharedPluginData('dsb', 'key')` or `page.findOne(n => n.name === 'Button')` |
| Variables | Name within collection | `(await figma.variables.getLocalVariablesAsync()).find(v => v.name === name && v.variableCollectionId === collId)` |
| Styles | Name | `getLocalTextStyles().find(s => s.name === name)` |

Tag every created **scene node** immediately after creation:
```javascript
node.setSharedPluginData('dsb', 'run_id', RUN_ID);        // identifies this build run
node.setSharedPluginData('dsb', 'phase', 'phase3');        // which phase created it
node.setSharedPluginData('dsb', 'key', 'component/button');// unique logical key
```

**State persistence**: Do NOT rely solely on conversation context for the state ledger. Write it to disk:
```
/tmp/dsb-state-{RUN_ID}.json
```
Re-read this file at the start of every turn. In long workflows, conversation context will be truncated — the file is the source of truth.

Maintain a state ledger tracking:
```json
{
  "runId": "ds-build-2024-001",
  "phase": "phase3",
  "step": "component-button",
  "entities": {
    "collections": { "primitives": "id:...", "color": "id:..." },
    "variables": { "color/bg/primary": "id:...", "spacing/sm": "id:..." },
    "pages": { "Cover": "id:...", "Button": "id:..." },
    "components": { "Button": "id:..." }
  },
  "pendingValidations": ["Button:screenshot"],
  "completedSteps": ["phase0", "phase1", "phase2", "component-avatar"]
}
```

**Idempotency check** before every create: query by name + state ledger ID. If exists, skip or update — never duplicate.

**Resume protocol**: at session start or after context truncation, use `figma:metadata`, `figma:variables`, and `figma:design-system` to reconstruct the `{key → id}` map, then re-read the state file if available.

**Continuation note** (give this to the user when resuming in a new chat):
> "I'm continuing a design system build. Run ID: {RUN_ID}. Resume from the last completed step using the saved ledger and Figma Workspace CLI state."

---

## 5. Library Discovery and `figma:design-system` — Reuse Decision Matrix

Search FIRST in Phase 0, then again immediately before each component creation.

**Start with `figma:libraries`** to understand what libraries are available before searching blindly. Then use `figma:design-system` to search components, variables, and styles with the selected workspace and optional repeated `--library` filters.

```
// Discover all libraries accessible to the file
npm --silent run figma:libraries -- --workspace <absolute-workspace> --state-file <absolute-path>
```

Use returned library identifiers as repeatable `--library` filters for `figma:design-system`. This avoids noisy results when many libraries are available.

Run the selected command with `--help` before first use; its typed arguments and result fields are the contract.

**Reuse if** all of these are true:
- Component property API matches your needs (same variant axes, compatible types)
- Token binding model is compatible (uses same or aliasable variables)
- Naming conventions match the target file
- Component is editable (not locked in a remote library you don't own)

**Rebuild if** any of these:
- API incompatibility (different property names, wrong variant model)
- Token model incompatible (hardcoded values, different variable schema)
- Ownership issue (can't modify the library)

**Wrap if** visual match but API incompatible:
- Import the library component as a nested instance inside a new wrapper component
- Expose a clean API on the wrapper

**Priority order**: local existing → subscribed library import → available UI kit (especially icons) → create new.

---

## 6. Decision Forks

Ask the user when paths fork — when two or more reasonable answers exist and no clear winner comes from the codebase, the Figma file, or the locked plan. Don't silently default. Present each option with its tradeoff and your recommendation; pick only after the user steers.

**When NOT to ask:** if exactly one path is clearly correct from the source of truth (code, Figma file, agreed plan), take it. This section is for genuine ambiguity, not for offloading every decision.

| Fork situation | What to surface | Example ask |
|---|---|---|
| Code ≠ Figma on a token, component, or value | Both versions side by side, with provenance (file/line vs node) | "Code says `--color-bg-primary = #FFFFFF`, Figma has `color/bg/primary = #FAFAFA`. Which wins?" |
| Subscribed library has a close-but-not-exact match | Library component summary + gap list | "Library has `Button` with no `loading` state. Reuse + wrap locally, or rebuild from scratch?" |
| Scope ambiguity at plan-lock (0d) | What's clearly in, what's clearly out, what's ambiguous | "Spec lists `Button` and `Input`; `Field` is referenced but not defined. In or out of v1?" |

**If the user rejects an option you already built on:** fix before moving on. Never build on rejected work.

---

## 7. Naming Conventions

Match existing file conventions. If starting fresh:

**Variables** (slash-separated):
```
color/bg/primary     color/text/secondary    color/border/default
spacing/xs  spacing/sm  spacing/md  spacing/lg  spacing/xl  spacing/2xl
radius/none  radius/sm  radius/md  radius/lg  radius/full
typography/body/font-size    typography/heading/line-height
```

**Primitives**: `blue/50` → `blue/900`, `gray/50` → `gray/900`

**Component names**: `Button`, `Input`, `Card`, `Avatar`, `Badge`, `Checkbox`, `Toggle`

**Variant names**: `Property=Value, Property=Value` — e.g., `Size=Medium, Style=Primary, State=Default`

**Page separators**: `---` (most common) or `——— COMPONENTS ———`

> Full naming reference: [naming-conventions.md](references/naming-conventions.md)

---

## 8. Token Architecture

| Complexity | Pattern |
|-----------|---------|
| < 50 tokens | Single collection, 2 modes (Light/Dark) |
| 50–200 tokens | **Standard**: Primitives (1 mode) + Color semantic (Light/Dark) + Spacing (1 mode) + Typography (1 mode) |
| 200+ tokens | **Advanced**: Multiple semantic collections, 4–8 modes (Light/Dark × Contrast × Brand). See M3 pattern in [token-creation.md](references/token-creation.md) |

Standard pattern (recommended starting point):
```
Collection: "Primitives"    modes: ["Value"]
  blue/500 = #3B82F6, gray/900 = #111827, ...

Collection: "Color"         modes: ["Light", "Dark"]
  color/bg/primary → Light: alias Primitives/white, Dark: alias Primitives/gray-900
  color/text/primary → Light: alias Primitives/gray-900, Dark: alias Primitives/white

Collection: "Spacing"       modes: ["Value"]
  spacing/xs = 4, spacing/sm = 8, spacing/md = 16, ...
```

---

## 9. Per-Phase Anti-Patterns

**Phase 0 anti-patterns:**
- ❌ Starting to create anything before scope is locked with user
- ❌ Ignoring existing file conventions and imposing new ones
- ❌ Skipping `figma:design-system` before planning component creation

**Phase 1 anti-patterns:**
- ❌ Using `ALL_SCOPES` on any variable
- ❌ Duplicating raw values in semantic layer instead of aliasing
- ❌ Not setting code syntax (breaks Dev Mode and round-tripping)
- ❌ Creating component tokens before agreeing on token taxonomy

**Phase 2 anti-patterns:**
- ❌ Skipping the cover page or foundations docs
- ❌ Putting multiple unrelated components on one page

**Phase 3 anti-patterns:**
- ❌ Creating components before foundations exist
- ❌ Hardcoding any fill/stroke/spacing/radius value in a component
- ❌ Creating a variant per icon (use INSTANCE_SWAP instead)
- ❌ Not positioning variants after combineAsVariants (they all stack at 0,0)
- ❌ Building variant matrix > 30 without splitting (variant explosion)
- ❌ Importing remote components then immediately detaching them

**General anti-patterns:**
- ❌ Retrying a failed script without understanding the error first
- ❌ Using name-prefix matching for cleanup (deletes user-owned nodes)
- ❌ Building on unvalidated work from the previous step
- ❌ Running concurrent Figma write operations
- ❌ Guessing/hallucinating node IDs from memory (always read from state ledger)
- ❌ Writing massive inline scripts instead of using the provided helper scripts
- ❌ Starting Phase 3 because the user said "build the button" without completing Phases 0-2

---

## 10. Reference Docs

Load on demand — each reference is authoritative for its phase:

Use your file reading tool to read these docs when needed. Do not assume their contents from the filename.

| Doc | Phase | Use when |
|-----|-------|---------------------|-----------|
| [discovery-phase.md](references/discovery-phase.md) | 0 | Starting a build — codebase analysis and Figma inspection |
| [token-creation.md](references/token-creation.md) | 1 | Creating variables, collections, modes, or styles |
| [documentation-creation.md](references/documentation-creation.md) | 2 | Creating cover pages, foundations docs, or swatches |
| [component-creation.md](references/component-creation.md) | 3 | Creating a component or variant |
| [code-connect-setup.md](references/code-connect-setup.md) | 3–4 | Setting Code Connect or variable code syntax |
| [naming-conventions.md](references/naming-conventions.md) | Any | Naming variables, pages, variants, or styles |
| [error-recovery.md](references/error-recovery.md) | Any | Recovering from a script failure or incomplete workflow |

---

## 11. JavaScript Examples

The source batch's nine JavaScript files have no Markdown mirror and are not executable instructions. Do not modify or execute them. Use first-class read commands and local `.figma.ts` scripts instead.
