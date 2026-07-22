# Using design-system variables

Use a variable because it expresses the intended meaning at the point of use, not merely because its current value looks similar. A correct binding preserves future theme, density, locale, and brand changes.

## Establish the available choices

Start with reads, using the same fully qualified `--state-file` for the task:

```text
npm --silent run figma:variables -- --file <figma-url-or-file-key> --state-file C:/work/project/.figma-workspace/state.json
npm --silent run figma:design-system -- "primary button" --file <figma-url-or-file-key> --library <library-key> --state-file C:/work/project/.figma-workspace/state.json
npm --silent run figma:libraries -- --file <figma-url-or-file-key> --state-file C:/work/project/.figma-workspace/state.json
```

Use `figma:variables` to inspect collections, modes, variable scopes, aliases, and current values. Use `figma:design-system` to identify the component and semantic convention that owns the choice; use `figma:libraries` to distinguish local tokens from reusable library sources. When broad file discovery is needed, use `figma:metadata`, then use `figma:inspect` for the specific raw node ID. Use `figma:api:search` only if the exact Plugin API binding method or property type is uncertain.

## Select the right layer and mode

Prefer the most specific stable semantic layer:

- Bind `button/background/primary` instead of a primitive blue when the component token exists.
- Bind `color/text/primary` instead of a raw color when the target is general body text.
- Bind a primitive only when the design intentionally has no semantic abstraction or the primitive itself is the specified contract.

Value equality is insufficient. Check the requested mode and collection: the default mode may not be the light, dark, density, or locale mode expected by the request. Check scopes too. A variable that is not scoped for the target property is a system-quality signal, not an invitation to force a mismatch.

Spacing and padding need the same care as color. Infer their role from the component's layout and naming, then prefer a semantic layout token where one exists over a numerically equal gap.

## Bind through a repairable script

Do writes in a local `.figma.ts` file and execute it through `figma:script:run`; do not make an untracked one-off mutation. A focused script can resolve a local variable, load a target node, bind it, and return evidence for review.

```ts
const variable = figma.variables
  .getLocalVariables("COLOR")
  .find((item) => item.name === "button/background/primary");
if (!variable) throw new Error("Missing expected button/background/primary variable");

const node = figma.getNodeById("42:7");
if (!node || node.type !== "RECTANGLE") throw new Error("Expected a rectangle target");

const basePaint: SolidPaint = {
  type: "SOLID",
  color: { r: 0, g: 0, b: 0 },
  opacity: 1,
};
node.fills = [figma.variables.setBoundVariableForPaint(basePaint, "color", variable)];

return { nodeId: node.id, boundVariable: variable.name };
```

Run the prepared script with the persisted session id in its JSON input. TypeScript preflight is always enabled:

```text
npm --silent run figma:script:run -- --input bind-token.json --state-file C:/work/project/.figma-workspace/state.json
```

For a target whose node type or property support is unclear, search the exact API first:

```text
npm --silent run figma:api:search -- "setBoundVariable" --state-file C:/work/project/.figma-workspace/state.json
```

## Verify and stop safely

- Re-read with `figma:inspect` or `figma:variables` after the script, and verify the bound variable id, semantic name, and relevant mode.
- When changing a reusable component, inspect representative variants rather than assuming one instance proves every state.
- Use a capture followed by `view_image` when the binding affects visible output and visual correctness matters.
- Stop for clarification when no appropriate variable exists, a requested variable is from an unavailable library, scopes reject the binding, or a requested mode conflicts with the active component contract.
- Fatal TypeScript preflight diagnostics report `executionOutcome: "not_started"`, confirming no request was dispatched. Repair and rerun the `.figma.ts` source; preserve it as the reviewable mutation record. For `outcome_unknown`, inspect and reconcile targeted variables before any write.
