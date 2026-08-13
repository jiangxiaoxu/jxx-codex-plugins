# Clean Up Explicit Ledger Objects

Remove orphaned scene nodes, variables, and collections only when each exact object is present in a reviewed external ledger. This script never scans by name, prefix, run marker, or document-wide inventory.

## Preconditions and inputs

- Copy each record from the ledger for the explicit Figma file. Every record includes an exact ID plus its expected live identity.
- Review the targets in Figma before removal. A mismatched or missing target stops the entire operation.
- Keep `dryRun` enabled until the returned plan exactly matches the reviewed ledger.
- This example refuses to remove pages and the document root because those operations have broad descendant effects. Use a separately approved, page-specific procedure when that is truly intended.

## Script

Save as `cleanup-orphans.figma.ts`, replace the placeholder records, run the dry run, then change only `dryRun` after review.

```typescript
const dryRun = true;

const sceneTargets = [
  {
    id: "NODE_ID_1",
    type: "FRAME",
    name: "Button / Documentation",
    parentId: "PAGE_ID_FROM_LEDGER",
  },
] as const;

const variableTargets = [
  {
    id: "VariableID:VARIABLE_1",
    name: "color/bg/temporary",
    collectionId: "VariableCollectionId:COLLECTION_1",
    resolvedType: "COLOR",
  },
] as const;

const collectionTargets = [
  {
    id: "VariableCollectionId:COLLECTION_2",
    name: "Temporary experiment",
  },
] as const;

const seen = new Set<string>();
for (const target of [...sceneTargets, ...variableTargets, ...collectionTargets]) {
  if (seen.has(target.id)) throw new Error(`Ledger repeats cleanup target ${target.id}.`);
  seen.add(target.id);
}

const planned: Array<{ id: string; type: string; name: string; parentId?: string }> = [];
const sceneNodes: SceneNode[] = [];

for (const target of sceneTargets) {
  const node = await figma.getNodeByIdAsync(target.id);
  if (!node || node.type === "DOCUMENT" || node.type === "PAGE") {
    throw new Error(`Expected removable scene node ${target.id}.`);
  }
  if (node.type !== target.type || node.name !== target.name || node.parent?.id !== target.parentId) {
    throw new Error(`Scene target ${target.id} no longer matches its reviewed ledger identity.`);
  }
  sceneNodes.push(node);
  planned.push({ id: node.id, type: node.type, name: node.name, parentId: node.parent.id });
}

const variables = await Promise.all(variableTargets.map(async (target) => {
  const variable = await figma.variables.getVariableByIdAsync(target.id);
  if (!variable
    || variable.name !== target.name
    || variable.variableCollectionId !== target.collectionId
    || variable.resolvedType !== target.resolvedType) {
    throw new Error(`Variable target ${target.id} no longer matches its reviewed ledger identity.`);
  }
  planned.push({ id: variable.id, type: "VARIABLE", name: variable.name });
  return variable;
}));

const collections = await Promise.all(collectionTargets.map(async (target) => {
  const collection = await figma.variables.getVariableCollectionByIdAsync(target.id);
  if (!collection || collection.name !== target.name) {
    throw new Error(`Collection target ${target.id} no longer matches its reviewed ledger identity.`);
  }
  planned.push({ id: collection.id, type: "VARIABLE_COLLECTION", name: collection.name });
  return collection;
}));

if (dryRun) return { dryRun: true, plannedRemoval: planned };

for (const node of sceneNodes) node.remove();
for (const variable of variables) variable.remove();
for (const collection of collections) collection.remove();

return { dryRun: false, removed: planned };
```

## Run and review

```text
npm --silent run figma:run -- --file <figma-file-url-or-key> --surface design --script <path/to/cleanup-orphans.figma.ts>
```

Run the exact reviewed script once with `dryRun: true`. Only when every planned item matches the ledger should you set `dryRun: false` and run it once. Require `executionOutcome: "succeeded"` and then read back every removed ID. If the result is `outcome_unknown`, treat the removal set as partially applied until exact IDs have been reconciled; never rerun the cleanup blindly. For `failed_atomic`, retain the direct host/script diagnostics, repair the reviewed script, and retry safely because Figma confirmed no file changes.
