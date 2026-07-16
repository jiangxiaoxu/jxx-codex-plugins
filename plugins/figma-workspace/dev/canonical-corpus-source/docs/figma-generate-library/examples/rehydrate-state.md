# Rehydrate Design-System State

## Purpose

Rebuild a conservative state map after an interrupted library build. The script finds scene nodes tagged with a run-specific shared-plugin-data namespace, then inventories local variable collections, variables, and styles. Treat the result as a recovery aid: verify each returned ID and do not resume a creation phase merely because an item has a similar name.

## Prerequisites and inputs

- An opened Design file and a persisted workspace session.
- Replace `<run-id>` with the exact run identifier used when tagging nodes. Use an empty string only when deliberately reviewing every node in the namespace.
- Replace `<namespace>` with the stable namespace used by the build, and replace all path and session placeholders before review.

## Safety boundary

This is a read-only scan. It neither creates nor edits Figma objects, does not alter the current page, and intentionally returns only nodes carrying the chosen shared-plugin-data key. It cannot prove that a recovered object is correct for a future mutation; inspect its structure before proceeding.

## Save and run

Save this body as `<absolute-task-directory>/rehydrate-state.figma.ts`. Use an input JSON file such as:

```json
{
  "sessionId": "<persisted-session-id>",
  "scriptPath": "<absolute-task-directory>/rehydrate-state.figma.ts",
  "surface": "design"
}
```

After replacing placeholders and reviewing the scope, execute:

```text
npm --silent run figma:script:run -- --input <absolute-task-directory>/run-rehydrate-state.json --state-file <absolute-task-directory>/state.json
```

The command runs only the saved `.figma.ts` file. It is not automatic; review the returned state map and reconcile it with the build ledger before making changes.

```typescript
const RUN_ID: string = "<run-id>";
const NAMESPACE = "<namespace>";
const KEY_NAME = "key";
const KEY_RUN_ID = "run_id";
const KEY_PHASE = "phase";

type TaggedNode = {
  nodeId: string;
  type: SceneNode["type"] | PageNode["type"];
  name: string;
  phase: string;
};

const taggedNodes: Record<string, TaggedNode> = {};
const belongsToRun = (node: BaseNode): boolean =>
  RUN_ID === "" || node.getSharedPluginData(NAMESPACE, KEY_RUN_ID) === RUN_ID;

for (const page of figma.root.children) {
  const pageKey = page.getSharedPluginData(NAMESPACE, KEY_NAME);
  if (pageKey && belongsToRun(page)) {
    taggedNodes[pageKey] = {
      nodeId: page.id,
      type: page.type,
      name: page.name,
      phase: page.getSharedPluginData(NAMESPACE, KEY_PHASE) || "unknown",
    };
  }

  const candidates = page.findAllWithCriteria({
    sharedPluginData: { namespace: NAMESPACE, keys: [KEY_NAME, KEY_RUN_ID] },
  });
  for (const node of candidates) {
    const key = node.getSharedPluginData(NAMESPACE, KEY_NAME);
    if (key && belongsToRun(node)) {
      taggedNodes[key] = {
        nodeId: node.id,
        type: node.type,
        name: node.name,
        phase: node.getSharedPluginData(NAMESPACE, KEY_PHASE) || "unknown",
      };
    }
  }
}

const variableCollections = (await figma.variables.getLocalVariableCollectionsAsync()).map((collection) => ({
  id: collection.id,
  name: collection.name,
  modes: collection.modes.map(({ modeId, name }) => ({ modeId, name })),
  variableCount: collection.variableIds.length,
}));

const variables = (await figma.variables.getLocalVariablesAsync()).map((variable) => ({
  id: variable.id,
  name: variable.name,
  collectionId: variable.variableCollectionId,
  resolvedType: variable.resolvedType,
}));

const styles = [
  ...figma.getLocalTextStyles().map((style) => ({ id: style.id, name: style.name, type: "TEXT" })),
  ...figma.getLocalEffectStyles().map((style) => ({ id: style.id, name: style.name, type: "EFFECT" })),
  ...figma.getLocalPaintStyles().map((style) => ({ id: style.id, name: style.name, type: "PAINT" })),
];

return {
  runId: RUN_ID || "all",
  taggedNodes,
  taggedNodeCount: Object.keys(taggedNodes).length,
  variableCollections,
  variableCount: variables.length,
  variables,
  styleCount: styles.length,
  styles,
};
```
