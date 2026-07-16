# Validate Created Nodes

## Purpose

Check that specific nodes from a completed creation step still exist and meet exact structural expectations before the next build phase. Each check may require a node type, exact name, and direct-child count. The script returns separate passed and failed lists instead of changing the file to make a check pass.

## Prerequisites and inputs

- An opened Design file and a persisted workspace session.
- The node IDs must come from a previous command result or inspected state ledger; never guess them.
- Replace the sample values in `checks` with the expected nodes and properties for the reviewed creation step.

## Safety boundary

The script is read-only. It does not repair missing nodes, rename incorrect nodes, or remove duplicates. A passing structural check is not visual QA; run a focused capture and inspect the image when the change affects appearance.

## Save and run

Save this body as `<absolute-task-directory>/validate-creation.figma.ts`. Create `<absolute-task-directory>/run-validate-creation.json`:

```json
{
  "sessionId": "<persisted-session-id>",
  "scriptPath": "<absolute-task-directory>/validate-creation.figma.ts",
  "surface": "design"
}
```

Replace the placeholders, review every expected value, then run:

```text
npm --silent run figma:script:run -- --input <absolute-task-directory>/run-validate-creation.json --state-file <absolute-task-directory>/state.json
```

This example is not automatically executable. Do not continue to the next creation step until failed checks are understood and the file has been reviewed.

```typescript
const validationStartedAt = Date.now();

type CreationCheck = {
  nodeId: string;
  expectedType?: SceneNode["type"] | PageNode["type"];
  expectedName?: string;
  expectedChildCount?: number;
};

const checks: CreationCheck[] = [
  {
    nodeId: "<node-id-from-previous-result>",
    expectedType: "COMPONENT_SET",
    expectedName: "<exact-component-set-name>",
    expectedChildCount: 4,
  },
];

const hasChildren = (node: BaseNode): node is BaseNode & ChildrenMixin => "children" in node;
const passed: string[] = [];
const failed: Array<{ nodeId: string; reason: string }> = [];

for (const check of checks) {
  const node = await figma.getNodeByIdAsync(check.nodeId);
  if (!node) {
    failed.push({
      nodeId: check.nodeId,
      reason: "Node not found. It may not have been created, or it was deleted.",
    });
    continue;
  }

  const reasons: string[] = [];
  if (check.expectedType !== undefined && node.type !== check.expectedType) {
    reasons.push(`type is \"${node.type}\", expected \"${check.expectedType}\"`);
  }
  if (check.expectedName !== undefined && "name" in node && node.name !== check.expectedName) {
    reasons.push(`name is \"${node.name}\", expected \"${check.expectedName}\"`);
  }
  if (check.expectedChildCount !== undefined) {
    if (!hasChildren(node)) {
      reasons.push(`node type \"${node.type}\" has no children, but a child count was required`);
    } else if (node.children.length !== check.expectedChildCount) {
      reasons.push(`has ${node.children.length} children, expected ${check.expectedChildCount}`);
    }
  }

  if (reasons.length === 0) {
    passed.push(check.nodeId);
  } else {
    failed.push({ nodeId: check.nodeId, reason: reasons.join("; ") });
  }
}

return { passed, failed, durationMs: Date.now() - validationStartedAt };
```
