# Clean Up Explicitly Owned Orphans

Remove scene nodes and local variables that belong to an abandoned build only when their exact IDs have been recorded in a reviewed state ledger. This intentionally does not infer ownership from names, prefixes, or a broad document scan.

## Preconditions and inputs

- Build the allowlists from IDs returned by the interrupted run or an audited ledger. Do not reconstruct or guess IDs.
- Review each listed object in Figma before removal, especially parent nodes: removing a parent also removes its descendants.
- Leave at least one page in the document. The script refuses to remove the final page.
- The `dryRun` switch belongs to this example and is not a Figma Workspace preflight requirement.

## Script

Save the script as `cleanup-orphans.figma.ts`, then replace the placeholder IDs with the reviewed IDs. Run it first with `dryRun: true`; change that one value only after validating the returned removal plan.

```typescript
const dryRun = true;

const sceneNodeIds = [
  "NODE_ID_1",
  "NODE_ID_2",
] as const;

const variableIds = [
  "VariableID:VARIABLE_1",
] as const;

const collectionIds = [
  "VariableCollectionId:COLLECTION_1",
] as const;

const planned: Array<{ id: string; name: string; type: string }> = [];

for (const id of sceneNodeIds) {
  const node = await figma.getNodeByIdAsync(id);
  if (!node) throw new Error(`Scene node ${id} no longer exists.`);
  if (node.type === "DOCUMENT" || node.type === "PAGE") {
    if (node.type === "PAGE" && figma.root.children.length <= 1) {
      throw new Error("Refusing to remove the final page in the document.");
    }
  }
  planned.push({ id: node.id, name: node.name, type: node.type });
}

const variables = await Promise.all(variableIds.map((id) => figma.variables.getVariableByIdAsync(id)));
const collections = await Promise.all(collectionIds.map((id) => figma.variables.getVariableCollectionByIdAsync(id)));

if (variables.some((variable) => !variable) || collections.some((collection) => !collection)) {
  throw new Error("A reviewed variable or collection ID could not be resolved.");
}

for (const variable of variables) planned.push({ id: variable!.id, name: variable!.name, type: "VARIABLE" });
for (const collection of collections) planned.push({ id: collection!.id, name: collection!.name, type: "VARIABLE_COLLECTION" });

if (dryRun) {
  return { dryRun: true, plannedRemoval: planned };
}

for (const id of sceneNodeIds) {
  const node = await figma.getNodeByIdAsync(id);
  if (node && node.type !== "DOCUMENT") node.remove();
}
for (const variable of variables) variable!.remove();
for (const collection of collections) collection!.remove();

return { dryRun: false, removed: planned };
```

## Run and review

Run `npm --silent run figma:script:run -- --help` first. Use this JSON input for the dry run:

```json
{
  "sessionId": "YOUR_SESSION_ID",
  "inputFile": "cleanup-orphans.figma.ts",
  "strict": true,
  "surface": "design"
}
```

Then execute it with the chosen absolute state file:

```text
npm --silent run figma:script:run -- --input C:/work/project/.figma-workspace/cleanup-orphans.json --state-file C:/work/project/.figma-workspace/state.json
```

This example is not automatically executable: replace every placeholder, keep `dryRun` enabled until the returned plan exactly matches your review, and only then change it to `false`. Rerun only the same reviewed script and verify the returned IDs before proceeding.
