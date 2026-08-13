> Part of the [figma-generate-library skill](canonical:figma-generate-library/SKILL.md).

# Token Creation Reference

Create local variable collections, primitive variables, semantic aliases, scopes, code syntax, and styles in small verified runs. Adapt examples into a local `.figma.ts` file and execute them through `figma:run`; examples are not directly executable.

## 1. State and identity

Keep a caller-owned external ledger for the explicit file target. Record a collection ID, its mode IDs, every variable ID, and each style ID only after read-back. Do not store run markers or recovery data on Figma objects.

Use deterministic names as a recovery aid, never as a deletion selector:

- resolve a collection by its exact ledger ID first;
- if the ID is missing, inspect local collections and require exactly one exact name match;
- restrict a variable lookup to the confirmed collection ID, then require exact name and resolved type;
- if zero or multiple results match, stop for review rather than creating or removing anything.

An external ledger entry can be as small as:

```json
{
  "fileKey": "explicit-file-key",
  "collections": {
    "color": {
      "id": "VariableCollectionId:123:4",
      "modes": { "Light": "1:0", "Dark": "1:1" }
    }
  },
  "variables": {
    "color/bg/primary": {
      "id": "VariableID:123:9",
      "collectionId": "VariableCollectionId:123:4",
      "resolvedType": "COLOR"
    }
  }
}
```

## 2. Collection architecture

Choose the smallest collection model that matches the approved token plan.

| Scale | Recommended model |
| --- | --- |
| Small | One collection with approved modes. |
| Normal | One single-mode primitive collection; semantic color collection with Light/Dark modes; separate spacing and typography collections as needed. |
| Advanced | Multiple semantic collections only when the approved plan needs independent mode axes. |

Primitive variables contain raw values and normally have empty scopes. Semantic variables alias primitives and use narrowly targeted scopes. Do not use `ALL_SCOPES`.

## 3. Create one collection safely

Inspect local collections first. The script refuses to proceed when a deterministic collection name already exists; a later run must reconcile that exact object with the external ledger rather than create a duplicate.

```typescript
const collectionName = "Color";
const modeNames = ["Light", "Dark"] as const;

if (modeNames.length === 0) throw new Error("At least one mode is required.");

const localCollections = await figma.variables.getLocalVariableCollectionsAsync();
const duplicates = localCollections.filter((collection) => collection.name === collectionName);
if (duplicates.length !== 0) {
  throw new Error(`Expected no local collection named ${collectionName}; reconcile its exact ID first.`);
}

const collection = figma.variables.createVariableCollection(collectionName);
const firstMode = collection.modes[0];
collection.renameMode(firstMode.modeId, modeNames[0]);

const modeIds: Record<string, string> = { [modeNames[0]]: firstMode.modeId };
for (const modeName of modeNames.slice(1)) {
  modeIds[modeName] = collection.addMode(modeName);
}

return { collectionId: collection.id, collectionName: collection.name, modeIds };
```

Record the returned IDs in the external ledger, then use `figma:variables` or a narrow local read-back before the next write. Mode availability depends on the Figma plan; treat an `addMode` error as a user decision point, not a reason to silently reduce the token model.

## 4. Resolve a known collection and primitives

Pass ledger IDs into a focused script. The exact-ID path is primary; deterministic name recovery is only allowed when it is constrained to a single expected collection.

```typescript
const collectionId = "VariableCollectionId:COLOR_COLLECTION";
const expectedName = "Color Primitives";

const collection = await figma.variables.getVariableCollectionByIdAsync(collectionId);
if (!collection || collection.name !== expectedName) {
  throw new Error(`Ledger collection ${collectionId} is missing or no longer named ${expectedName}.`);
}

const mode = collection.modes.find(({ name }) => name === "Value");
if (!mode) throw new Error("Expected Value mode in Color Primitives.");

const localVariables = await figma.variables.getLocalVariablesAsync();
const existing = localVariables.filter((variable) =>
  variable.variableCollectionId === collection.id && variable.name === "blue/500",
);
if (existing.length > 1) throw new Error("blue/500 is ambiguous in Color Primitives.");
if (existing.length === 1) throw new Error("blue/500 already exists; reconcile its ledger entry first.");

const primitive = figma.variables.createVariable("blue/500", collection, "COLOR");
primitive.setValueForMode(mode.modeId, { r: 0.231, g: 0.51, b: 0.965 });
primitive.scopes = [];
primitive.setVariableCodeSyntax("WEB", "var(--color-blue-500)");

return {
  collectionId: collection.id,
  created: [{ id: primitive.id, name: primitive.name, resolvedType: primitive.resolvedType }],
};
```

## 5. Create semantic aliases

Alias each semantic token to a same-type primitive in every approved mode. Do not copy raw values into the semantic layer.

```typescript
const colorCollectionId = "VariableCollectionId:COLOR";
const colorCollectionName = "Color";
const primitiveIds = {
  light: "VariableID:BLUE_500",
  dark: "VariableID:BLUE_300",
} as const;

const collection = await figma.variables.getVariableCollectionByIdAsync(colorCollectionId);
if (!collection || collection.name !== colorCollectionName) {
  throw new Error("Color collection ledger entry no longer matches live Figma state.");
}
const lightMode = collection.modes.find((mode) => mode.name === "Light");
const darkMode = collection.modes.find((mode) => mode.name === "Dark");
if (!lightMode || !darkMode) throw new Error("Expected Light and Dark modes.");

const [lightPrimitive, darkPrimitive] = await Promise.all([
  figma.variables.getVariableByIdAsync(primitiveIds.light),
  figma.variables.getVariableByIdAsync(primitiveIds.dark),
]);
if (!lightPrimitive || !darkPrimitive || lightPrimitive.resolvedType !== "COLOR" || darkPrimitive.resolvedType !== "COLOR") {
  throw new Error("The recorded primitive IDs must resolve to COLOR variables.");
}

const existing = (await figma.variables.getLocalVariablesAsync()).filter((variable) =>
  variable.variableCollectionId === collection.id && variable.name === "color/bg/primary",
);
if (existing.length !== 0) throw new Error("color/bg/primary already exists or is ambiguous; reconcile it first.");

const semantic = figma.variables.createVariable("color/bg/primary", collection, "COLOR");
semantic.setValueForMode(lightMode.modeId, figma.variables.createVariableAlias(lightPrimitive));
semantic.setValueForMode(darkMode.modeId, figma.variables.createVariableAlias(darkPrimitive));
semantic.scopes = ["FRAME_FILL", "SHAPE_FILL"];
semantic.setVariableCodeSyntax("WEB", "var(--color-bg-primary)");

return { collectionId: collection.id, created: [{ id: semantic.id, name: semantic.name }] };
```

## 6. Scope and code syntax

| Semantic role | Scope |
| --- | --- |
| Frame or shape fill | `FRAME_FILL`, `SHAPE_FILL` |
| Text color | `TEXT_FILL` |
| Stroke | `STROKE_COLOR` |
| Gap | `GAP` |
| Corner radius | `CORNER_RADIUS` |
| Font size | `FONT_SIZE` |
| Font family/style | `FONT_FAMILY` / `FONT_STYLE` |
| Primitive | `[]`, except an approved specialized use such as `EFFECT_COLOR` |

Use the exact code token from the codebase. For a CSS custom property, Web code syntax includes the wrapper: `var(--color-bg-primary)`. Android and iOS syntax follow their own codebase conventions.

## 7. Effects and text styles

Create or update a style only after resolving its exact ledger ID or a single exact local name/type match. Return the new or verified style ID. Do not alter a same-named style found in another family, and do not use a broad name-prefix scan.

For text styles, load each required font before writing any text or assigning a font to a style. For effect styles, return the full intended effect list so the caller can compare it to the approved token plan.

## 8. Validation and recovery

After every creation script:

1. Record the returned IDs in the external ledger.
2. Read back those exact IDs and verify collection, mode, name, type, aliases, scopes, and code syntax.
3. If `executionOutcome` is `failed_atomic`, retain the direct host/script diagnostics, repair the script, and retry safely because Figma confirmed no file changes. If it is `outcome_unknown`, assume partial effects are possible: inspect exact intended names within their known collection and reconcile the ledger before another write.
4. Remove an object only through the [explicit-ID cleanup example](canonical:figma-generate-library/examples/cleanup-orphans.md), after dry-run review. Never clean up an entire collection or name family because a run was interrupted.
