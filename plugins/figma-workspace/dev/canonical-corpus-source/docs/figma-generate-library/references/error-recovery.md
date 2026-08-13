> Part of the [figma-generate-library skill](canonical:figma-generate-library/SKILL.md).

# Error Recovery Reference

Recover a design-system build from the CLI result, live read-back, and a caller-owned external exact-ID ledger. Do not keep recovery markers on Figma objects or infer ownership from names. A direct returned host or script error from `figma:run` is `failed_atomic`; only use reconciliation when completion is genuinely unknown.

All code below is a non-executable Plugin API example. Adapt a reviewed script into a local `.figma.ts` file and run it with `figma:run`.

## 1. Stop and classify

After every `figma:run`, stop further writes and classify the result before retrying.

| Signal | Meaning | Required next step |
| --- | --- | --- |
| `executionOutcome: "not_started"` | Local validation, preflight, authentication, or connection prevented dispatch. | Correct the local problem, then rerun only after reviewing the unchanged target. |
| `executionOutcome: "failed_atomic"` | `figma:run` directly returned a host or script error and Figma confirmed no file changes. | Retain the diagnostics, repair the script, and retry safely. |
| `executionOutcome: "succeeded"` | Figma confirmed script completion. | Record returned IDs, read them back, then continue. Do not replay merely because later local output handling failed. |
| `executionOutcome: "outcome_unknown"` | Completion is not confirmed, for example after timeout, response loss, or truncated execution state. | Assume partial or complete effects are possible. Read back the intended exact entities and reconcile before any write. |

Do not apply `failed_atomic` to arbitrary upstream operations: it specifically describes a direct returned `.figma.ts` host/script error from `figma:run`. A transport failure that leaves completion unconfirmed is `outcome_unknown`; never retry that mutation blindly.

## 2. Reconcile from the external ledger

The ledger belongs outside Figma and is keyed by the explicit file target. It records exact returned IDs plus enough immutable identity to validate them:

```json
{
  "fileKey": "explicit-file-key",
  "runId": "design-system-2026-08-13",
  "entities": {
    "pages": {
      "foundations": { "id": "12:34", "name": "Foundations" }
    },
    "collections": {
      "color": { "id": "VariableCollectionId:12:40", "name": "Color" }
    },
    "variables": {
      "color/bg/primary": {
        "id": "VariableID:12:41",
        "collectionId": "VariableCollectionId:12:40",
        "name": "color/bg/primary",
        "resolvedType": "COLOR"
      }
    },
    "components": {
      "button": { "id": "12:50", "pageId": "12:35", "name": "Button", "type": "COMPONENT_SET" }
    }
  },
  "pendingValidations": ["button:capture"]
}
```

For every record touched by a failed or unknown run:

1. Read the exact ledger ID.
2. Verify its type, name, and expected parent or collection.
3. Mark it `confirmed`, `missing`, or `mismatched`; do not silently overwrite a mismatch.
4. When an ID is missing, recover only with a deterministic name lookup constrained to the known parent and type. Require exactly one match.
5. If recovery is ambiguous, stop and ask for review. Do not create a replacement or remove candidates.

### Narrow scene-node read-back

```typescript
const expected = {
  id: "COMPONENT_SET_ID_FROM_LEDGER",
  pageId: "PAGE_ID_FROM_LEDGER",
  name: "Button",
  type: "COMPONENT_SET",
} as const;

const node = await figma.getNodeByIdAsync(expected.id);
if (!node) return { status: "missing", id: expected.id };
if (node.type !== expected.type || node.name !== expected.name || node.parent?.id !== expected.pageId) {
  throw new Error(`Ledger record ${expected.id} no longer has the expected identity.`);
}
return { status: "confirmed", id: node.id, name: node.name, type: node.type };
```

### Constrained variable recovery when an ID is unavailable

```typescript
const expected = {
  collectionId: "VariableCollectionId:COLOR",
  name: "color/bg/primary",
  resolvedType: "COLOR",
} as const;

const variables = await figma.variables.getLocalVariablesAsync();
const matches = variables.filter((variable) =>
  variable.variableCollectionId === expected.collectionId
  && variable.name === expected.name
  && variable.resolvedType === expected.resolvedType,
);
if (matches.length !== 1) {
  throw new Error(`Expected exactly one recovery match for ${expected.name}; found ${matches.length}.`);
}
return { status: "recovered", id: matches[0].id, name: matches[0].name };
```

Record a recovered ID only after this validation succeeds. A recovered ID does not make unrelated ledger entries valid.

## 3. Exact-ID cleanup

Cleanup is allowed only for reviewed IDs from the ledger. First execute the cleanup example with `dryRun: true`, compare every returned object with the approved ledger records, then run the same reviewed list once with `dryRun: false`.

Never authorize cleanup with:

- a name or prefix;
- a document-wide or page-wide scan;
- a run marker stored on a Figma object;
- an inferred child list of a parent being removed;
- IDs reconstructed from conversation memory.

Before deletion, verify every candidate still has the exact expected type, name, and scope. Do not remove a `PAGE` when it would remove the final document page. If the requested result contains a mismatch or an unresolved ID, stop rather than deleting the remaining candidates.

Read [explicit-ID cleanup](canonical:figma-generate-library/examples/cleanup-orphans.md) for the reviewed script.

## 4. Idempotent creates

Before a create:

1. Resolve and verify the ledger entry if it exists.
2. If it is absent, make one narrow deterministic-name check in the expected scope.
3. If none exists, create one object and return its ID and enough identity to validate it.
4. Read back that object, then write the confirmed record to the external ledger.

For example, a component set can be recovered only from its known page and exact name:

```typescript
const pageId = "PAGE_ID_FROM_LEDGER";
const componentSetName = "Button";
const page = await figma.getNodeByIdAsync(pageId);
if (!page || page.type !== "PAGE") throw new Error("Expected recorded component page.");

const matches = page.findAllWithCriteria({ types: ["COMPONENT_SET"] })
  .filter((candidate) => candidate.name === componentSetName);
if (matches.length > 1) throw new Error(`Component set ${componentSetName} is ambiguous on this page.`);
return { existingComponentSetId: matches[0]?.id ?? null };
```

Do not use an existence check to decide that a structurally mismatched object is safe to update. Surface the mismatch to the user or create a separately approved migration plan.

## 5. Resume protocol

At session start:

1. Open the ledger for the explicit file target and verify the file key matches the requested target.
2. Read back every pending or recently mutated exact ID.
3. Recover a missing record only through the constrained procedure above.
4. Continue from the first unconfirmed validation or genuinely missing object.
5. Capture edited visuals before reporting success when the workflow changed layout or appearance.

Do not perform a broad "rehydrate all state" scan. It cannot establish ownership for cleanup and can mistake user-owned objects for workflow output.

## 6. Common outcomes

| Situation | Safe action |
| --- | --- |
| Font load fails before a text write | Repair the font selection; the failed operation is normally `not_started` or has no intended text write, but still inspect the returned outcome. |
| A collection creation fails after mode edits | Find the exact collection by ledger ID or one exact local name, inspect its modes, and add only the missing approved mode after review. |
| Variant creation fails after some clones were created | Reconcile returned and intended variant IDs against the known component page, then create only missing combinations or use reviewed exact-ID cleanup. |
| `figma:run` directly returns a host property-override error | It is `failed_atomic`: retain the diagnostic, choose a supported property or component-level alternative, then submit the repaired script again. |
| Unknown result after a write | Inspect exact ledger IDs and constrained deterministic names; no retry until the ledger is reconciled. |
