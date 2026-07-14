# Design-system variables

Figma variables are typed, mode-aware values for colors, numbers, strings, and booleans. In a design system they usually play the role of tokens, while retaining Figma-specific behavior such as property scopes, aliases, and prototype or localized-content use cases.

Use variables for individual values. Use [effect styles](wwds-effect-styles.md) for composite shadow or blur definitions and [text styles](wwds-text-styles.md) for type ramps. A style can still reference variables where its underlying properties support them.

## System model

### Collections and modes

A collection groups related variables and has one or more modes. `Color` might have Light and Dark modes; `Content` might have locale modes; `Spacing` might have Compact and Comfortable modes. Model a mode as an independently switchable dimension, not as a substitute for folders.

### Alias layers

Aliases point one variable at another. The common progression is:

```text
primitive color/blue/500
  -> semantic color/text/primary
  -> component button/background/primary
```

Not every system needs all three layers. Flat source data should remain flat unless an explicit semantic boundary is needed. More layers are justified only when they provide stable intent, not when they simply repeat names.

### Naming, code syntax, and scopes

Use slash-delimited names for visible grouping, for example `spacing/layout/section`. Code syntax can document a platform-facing name such as `var(--color-text-primary)` without forcing Figma's display name to mimic CSS punctuation.

Scopes constrain where a variable appears and can be bound. Use precise fill, stroke, text-content, typography, layout, corner-radius, or opacity scopes. Broad `ALL_SCOPES` is appropriate only when a value is genuinely cross-property; otherwise it makes token pickers noisy and conceals intent.

## Command selection

The Figma Workspace CLI is the read surface for design-system investigation. Pass an absolute `--state-file` to every command and run the selected command's `--help` before first use.

| Need | Command | Why |
| --- | --- | --- |
| Inventory local collections, modes, aliases, values, or scopes | `figma:variables` | Establishes what can be reused before a write. |
| Find system conventions or candidate components/tokens | `figma:design-system` | Connects a request to its semantic owner. |
| Determine available published sources | `figma:libraries` | Prevents accidental local duplication. |
| Discover an unfamiliar file or target structure | `figma:metadata`, then `figma:inspect` | Narrows the edit to known nodes. |
| Confirm an exact Plugin API symbol or binding shape | `figma:api:search` | Resolves API details without using documentation as a mutation path. |

Example read sequence:

```text
npm --silent run figma:variables -- --file <figma-url-or-file-key> --state-file C:/work/project/.figma-workspace/state.json
npm --silent run figma:design-system -- "surface color" --file <figma-url-or-file-key> --state-file C:/work/project/.figma-workspace/state.json
npm --silent run figma:api:search -- "VariableScope" --state-file C:/work/project/.figma-workspace/state.json
```

## Creation and binding boundary

Reads identify the model; writes belong in a local `.figma.ts` script. Create a task workspace with `figma:task:prepare`, edit the generated script, and execute it through `figma:script:run` using JSON input that names the persisted session, script file, strict preflight, and surface. Keep scripts small, idempotent, and explicit about ids and names they create or bind.

```ts
const semantic = figma.variables
  .getLocalVariables("COLOR")
  .find((item) => item.name === "color/text/primary");
if (!semantic) throw new Error("Expected color/text/primary");

const text = figma.getNodeById("19:3");
if (!text || text.type !== "TEXT") throw new Error("Expected text target");

const basePaint: SolidPaint = {
  type: "SOLID",
  color: { r: 0, g: 0, b: 0 },
  opacity: 1,
};
text.fills = [figma.variables.setBoundVariableForPaint(basePaint, "color", semantic)];

return { targetId: text.id, variableId: semantic.id, variableName: semantic.name };
```

Strict preflight failures mean the script did not execute. Fix source-line diagnostics, then rerun the same `.figma.ts`; do not turn a failed planned write into an unreviewable ad-hoc operation.

## Working rules

- Inspect all relevant modes before adding or changing a variable; the default mode is not necessarily the intended result.
- Create primitive values before alias targets, and use exact same-file variable ids in alias values.
- Prefer the most specific semantic or component token at a binding point, even when a primitive has the same current value.
- Re-read the target after mutation and confirm the id, name, scope, and mode assumptions. For visible changes, capture and inspect the image with `view_image`.
- Pause for a user decision if source code and Figma semantics conflict, no appropriate library token is available, mode behavior is unspecified, or a change would rename, delete, or repoint shared variables.

For detailed task guidance, see [creating variables](wwds-variables--creating.md) and [using variables](wwds-variables--using.md).
