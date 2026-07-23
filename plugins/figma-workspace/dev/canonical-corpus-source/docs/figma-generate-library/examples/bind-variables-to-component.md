# Bind Variables to a Component

Bind existing color and number variables to a component's visual properties. This is useful after the component and its token collections already exist.

## Preconditions and inputs

- Use a Figma Design file and an existing component node.
- Replace `COMPONENT_ID` and every `VariableID:...` placeholder with IDs returned by your own inspection or state ledger. Never guess IDs.
- Ensure each variable has a scope compatible with the property it will control: fills/strokes need color variables; padding, gap, and radius need number variables.
- Review whether replacing the first fill or stroke is intended. This example preserves later paints, but it is still a mutation.

## Script

Save the following as `bind-variables-to-component.figma.ts`. This compact sample binds every listed property; remove the corresponding lookup and `setBoundVariable` call for a property that must remain unchanged.

```typescript
const componentId = "COMPONENT_ID";

const bindingIds = {
  fill: "VariableID:COLOR_FILL",
  stroke: "VariableID:COLOR_STROKE",
  paddingTop: "VariableID:SPACING_TOP",
  paddingRight: "VariableID:SPACING_RIGHT",
  paddingBottom: "VariableID:SPACING_BOTTOM",
  paddingLeft: "VariableID:SPACING_LEFT",
  itemSpacing: "VariableID:SPACING_GAP",
  cornerRadius: "VariableID:RADIUS",
} as const;

const node = await figma.getNodeByIdAsync(componentId);
if (!node || node.type !== "COMPONENT") {
  throw new Error(`Expected a COMPONENT at ${componentId}.`);
}

const [fill, stroke, paddingTop, paddingRight, paddingBottom, paddingLeft, itemSpacing, cornerRadius] =
  await Promise.all([
    figma.variables.getVariableByIdAsync(bindingIds.fill),
    figma.variables.getVariableByIdAsync(bindingIds.stroke),
    figma.variables.getVariableByIdAsync(bindingIds.paddingTop),
    figma.variables.getVariableByIdAsync(bindingIds.paddingRight),
    figma.variables.getVariableByIdAsync(bindingIds.paddingBottom),
    figma.variables.getVariableByIdAsync(bindingIds.paddingLeft),
    figma.variables.getVariableByIdAsync(bindingIds.itemSpacing),
    figma.variables.getVariableByIdAsync(bindingIds.cornerRadius),
  ]);

if (!fill || !stroke || !paddingTop || !paddingRight || !paddingBottom || !paddingLeft || !itemSpacing || !cornerRadius) {
  throw new Error("One or more variable IDs could not be resolved.");
}

const bindPaint = (paints: readonly Paint[], variable: Variable): Paint[] => {
  const firstPaint: SolidPaint = paints[0]?.type === "SOLID"
    ? paints[0]
    : { type: "SOLID", color: { r: 0.5, g: 0.5, b: 0.5 } };
  const bound = figma.variables.setBoundVariableForPaint(firstPaint, "color", variable);
  return [bound, ...paints.slice(1)];
};

node.fills = bindPaint(Array.isArray(node.fills) ? node.fills : [], fill);
node.strokes = bindPaint(Array.isArray(node.strokes) ? node.strokes : [], stroke);
node.setBoundVariable("paddingTop", paddingTop);
node.setBoundVariable("paddingRight", paddingRight);
node.setBoundVariable("paddingBottom", paddingBottom);
node.setBoundVariable("paddingLeft", paddingLeft);
node.setBoundVariable("itemSpacing", itemSpacing);
node.setBoundVariable("cornerRadius", cornerRadius);

return {
  componentId: node.id,
  componentName: node.name,
  boundProperties: Object.keys(bindingIds),
};
```

## Run and review

Run `npm --silent run figma:run -- --help` first. Save the reviewed local `.figma.ts` file, then run it with its explicit Design file target:

```text
npm --silent run figma:run -- --file <figma-file-url-or-key> --surface design --script <path/to/script.figma.ts>
```

Execute it with the explicit Design file target:

```text
npm --silent run figma:run -- --file <figma-file-url-or-key> --surface design --script <path/to/script.figma.ts>
```

This is not automatically executable: replace all placeholders, review the resolved component and variables, then inspect the returned IDs and bindings before continuing. For a component set, apply the script to each intended variant ID; do not assume a binding on the set changes every child.
