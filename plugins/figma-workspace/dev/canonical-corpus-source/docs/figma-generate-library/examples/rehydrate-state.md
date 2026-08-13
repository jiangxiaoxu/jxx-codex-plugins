# Reconcile an External Ledger

This replaces the retired object-metadata rehydration pattern. It verifies only exact IDs from a caller-owned external ledger and supports one constrained recovery lookup when a recorded ID is missing. It does not scan the document, query object PluginData, or infer a cleanup set.

## Preconditions and inputs

- Use a ledger for the explicit Figma file target. Each entry has an exact ID, expected type, exact name, and expected parent or collection ID.
- Run this as a read-only reconciliation step after `outcome_unknown` and before another mutation. A direct returned host/script error is `failed_atomic`: repair the script and retry safely instead of reconciling a file Figma confirmed unchanged.
- If an exact-ID record is missing, recovery is allowed only inside its known page or variable collection. Ambiguous matches are a blocker.

## Script

Save as `reconcile-ledger.figma.ts`, replace all placeholder records from the reviewed external ledger, and return the result to the caller before changing the ledger.

```typescript
const componentRecord = {
  id: "COMPONENT_SET_ID_FROM_LEDGER",
  pageId: "PAGE_ID_FROM_LEDGER",
  name: "Button",
  type: "COMPONENT_SET",
} as const;

const variableRecord = {
  id: "VariableID:COLOR_BG_PRIMARY",
  collectionId: "VariableCollectionId:COLOR",
  name: "color/bg/primary",
  resolvedType: "COLOR",
} as const;

const component = await figma.getNodeByIdAsync(componentRecord.id);
const componentStatus = !component
  ? { status: "missing", id: componentRecord.id }
  : component.type !== componentRecord.type
    || component.name !== componentRecord.name
    || component.parent?.id !== componentRecord.pageId
    ? { status: "mismatched", id: component.id, type: component.type, name: component.name }
    : { status: "confirmed", id: component.id, type: component.type, name: component.name };

const variable = await figma.variables.getVariableByIdAsync(variableRecord.id);
const variableStatus = !variable
  ? { status: "missing", id: variableRecord.id }
  : variable.variableCollectionId !== variableRecord.collectionId
    || variable.name !== variableRecord.name
    || variable.resolvedType !== variableRecord.resolvedType
    ? { status: "mismatched", id: variable.id, name: variable.name, resolvedType: variable.resolvedType }
    : { status: "confirmed", id: variable.id, name: variable.name, resolvedType: variable.resolvedType };

return { component: componentStatus, variable: variableStatus };
```

## Narrow recovery

Only run this section when a single ledger record is missing and the expected parent is already confirmed. It never removes a result.

```typescript
const pageId = "PAGE_ID_FROM_LEDGER";
const expectedName = "Button";
const page = await figma.getNodeByIdAsync(pageId);
if (!page || page.type !== "PAGE") throw new Error("Expected ledger page for recovery.");

const matches = page.findAllWithCriteria({ types: ["COMPONENT_SET"] })
  .filter((node) => node.name === expectedName);
if (matches.length !== 1) {
  throw new Error(`Expected one ${expectedName} component set on the ledger page; found ${matches.length}.`);
}

return { status: "recovered", id: matches[0].id, name: matches[0].name, type: matches[0].type };
```

After a confirmed recovery, update only that ledger record and re-read it before continuing. Do not use this example to rebuild all workflow state, identify orphaned objects, or authorize cleanup. For removal, use [explicit-ID cleanup](canonical:figma-generate-library/examples/cleanup-orphans.md) with dry-run review.
