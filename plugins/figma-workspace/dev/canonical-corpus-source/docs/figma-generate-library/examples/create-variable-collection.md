# Create a variable collection

Create one local Figma variable collection, rename its required default mode, and add the approved additional modes. The return value provides the collection and mode IDs needed by later token-creation scripts.

## Prerequisites and inputs

- Inspect local collections first. Replace each `TODO` placeholder with the approved collection name and ordered mode names.
- A collection always begins with one mode. This example renames that mode instead of adding a duplicate first mode.
- Save the script locally as `C:/work/project/figma-scripts/create-variable-collection.figma.ts`.

## Safety boundary

This script refuses to create a collection when its name already exists, providing a stable readback key for `outcome_unknown` reconciliation and preventing duplicate creation when only missing work is run. It only creates the listed collection and modes; it never removes collections, modes, or variables. Review mode names and plan limits before execution, because mode limits depend on the Figma plan.

## Script

```typescript
const collectionName = "TODO: Color";
const modeNames: string[] = ["TODO: Light", "TODO: Dark"];

if (modeNames.length === 0) {
  throw new Error("At least one mode name is required.");
}

const existingCollections = await figma.variables.getLocalVariableCollectionsAsync();
if (existingCollections.some((collection) => collection.name === collectionName)) {
  throw new Error(`A local variable collection named \"${collectionName}\" already exists.`);
}

const collection = figma.variables.createVariableCollection(collectionName);
const firstMode = collection.modes[0];
collection.renameMode(firstMode.modeId, modeNames[0]);

const modeIds: Record<string, string> = {
  [modeNames[0]]: firstMode.modeId,
};

for (const modeName of modeNames.slice(1)) {
  modeIds[modeName] = collection.addMode(modeName);
}

return {
  collectionId: collection.id,
  collectionName: collection.name,
  modeIds,
};
```

## Run explicitly

Replace placeholders, review the result, save it as the `.figma.ts` file above, then execute it explicitly. Documentation code does not run by itself.

```text
npm --silent run figma:run -- --file <figma-file-url-or-key> --surface design --script <path/to/script.figma.ts>
```

Record the returned `collectionId` and `modeIds`, then inspect variables before creating primitives or semantics.
