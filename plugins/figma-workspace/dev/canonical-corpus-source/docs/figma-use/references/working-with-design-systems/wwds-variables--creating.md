# Creating design-system variables

Create variables only after establishing the existing system and the intended source of truth. Variables are excellent for single values such as colors, numbers, strings, and booleans; they do not replace composite effect styles or text styles.

## Discover before changing

Use the Figma Workspace CLI with an explicit file target on every remote call:

```text
npm --silent run figma:variables -- --help
npm --silent run figma:variables -- --file <figma-url-or-file-key> --node <node-id>
npm --silent run figma:libraries -- --file <figma-url-or-file-key>
npm --silent run figma:design-system -- "button background color" --file <figma-url-or-file-key>
```

- Use `figma:variables` to inventory local collections, modes, names, values, aliases, and scopes before proposing a change.
- Use `figma:libraries` when a suitable published library may already own the token. Do not recreate an imported-library token locally without an explicit reason.
- Use `figma:design-system` to find the component or semantic-token convention the new value must support. Pass `--library` when the task identifies a particular library.
- Use `figma:metadata` first if the request is anchored to an unfamiliar file or page structure. Use `figma:api:search` for exact Plugin API symbols or shapes, not for system discovery.

If the requested source is CSS, JSON, or an existing theme, preserve its semantic relationships rather than its punctuation. Confirm whether the source is authoritative, whether code syntax needs to be recorded, and whether the file is an experiment or a maintained library.

## Choose a token model deliberately

Use the smallest model that matches the product:

- A simple, flat palette can be one collection with direct values.
- A system with primitives and meanings should use aliases: `color/blue/500` -> `color/text/primary` -> `button/background/primary` where a component layer is needed.
- Add modes only for independently changing dimensions, for example light/dark color, density spacing, or locale-specific strings. Do not use modes merely to group unrelated values.
- Put brand overrides in a separate or extended collection only when the override boundary is stable and understandable to users.

Name variables with slash-delimited groups that communicate purpose. Apply narrow scopes: a text-color variable should not appear in every property picker, and a spacing variable should be scoped to layout uses. Treat `ALL_SCOPES` as an exception for genuinely cross-property values.

## Make the write repairable

All mutations belong in a local `.figma.ts` file created by the shell and run through `figma:run` with an explicit target:

```text
npm --silent run figma:run -- --file <figma-file-url-or-key> --surface design --script <path/to/script.figma.ts>
```

The command receives the file target, surface, and `.figma.ts` path directly. TypeScript preflight is always enabled. Consult each command's `--help` before first use.

Use an idempotent script: find collections and variables by a stable name before creating anything, then return the created or reused ids. This prevents silent duplicate names and gives `outcome_unknown` reconciliation a stable readback key; inspect first and run only confirmed missing work.

```ts
const collection = figma.variables
  .getLocalVariableCollections()
  .find((item) => item.name === "Color");

if (!collection) throw new Error("Expected local Color collection");

const modeId = collection.defaultModeId;
const existing = figma.variables
  .getLocalVariables()
  .find((item) => item.variableCollectionId === collection.id && item.name === "color/blue/500");
const blue500 = existing ?? figma.variables.createVariable("color/blue/500", collection, "COLOR");

blue500.scopes = ["FRAME_FILL", "SHAPE_FILL", "TEXT_FILL", "STROKE_COLOR"];
blue500.setValueForMode(modeId, { r: 0.13, g: 0.39, b: 0.93 });

return { variableId: blue500.id, name: blue500.name, modeId };
```

Create primitive targets before aliases. An alias value must use the exact target id and must refer to a variable available in the same file:

The next line is an insertion fragment for the preceding script after `semantic`, `modeId`, and `blue500` have been resolved. It is not a standalone `.figma.ts` transaction.

```ts
semantic.setValueForMode(modeId, { type: "VARIABLE_ALIAS", id: blue500.id });
```

## Creation checklist and stop conditions

- Record the collection, mode, scope, naming, code-syntax, and alias decisions in the script result or task notes.
- Check every mode, not only the default mode, before declaring a collection complete.
- Keep text hierarchy in text styles and shadows or blur in effect styles; bind their individual supported values to variables when useful.
- Stop and ask for direction when the source conflicts with an existing semantic layer, the mode mapping is ambiguous, a library token cannot be imported, or the task would rename/delete shared variables.
- Treat `figma:run` preflight diagnostics as a non-execution result. Fix fatal TypeScript diagnostics, then rerun with an explicit `--file` target and exactly one of `--script <path.figma.ts>` or `--source -`; do not switch to ad-hoc write calls to bypass preflight.
