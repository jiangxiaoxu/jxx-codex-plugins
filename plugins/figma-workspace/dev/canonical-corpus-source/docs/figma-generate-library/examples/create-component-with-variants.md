# Create a Component Set with Variants

Create a small component set by generating the Cartesian product of variant axes, combining the components, and arranging the resulting variants in a grid.

## Preconditions and inputs

- Use a Figma Design file and replace the component name, axes, dimensions, page ID, and optional colors with project-approved values from the external ledger.
- Keep the generated matrix deliberately small. If axes produce more than about 30 combinations, split the component or redesign its property model before generating it.
- The external ledger is the primary identity source. This script verifies the target page ID and uses the exact component-set name only for a narrow duplicate check inside that page.
- The generated variants have fixed visual values. Bind approved variables in a separate reviewed step when your design system requires token bindings.

## Script

Save as `create-component-with-variants.figma.ts`.

```typescript
const pageId = "PAGE_ID";
const componentName = "Button";
const variantAxes = {
  Size: ["Small", "Medium"],
  Style: ["Primary", "Secondary"],
} as const;

const width = 120;
const height = 40;
const gridGap = 16;
const setPadding = 40;

const page = await figma.getNodeByIdAsync(pageId);
if (!page || page.type !== "PAGE") throw new Error(`Expected a PAGE at ${pageId}.`);
await figma.setCurrentPageAsync(page);

const existingSets = page.findAllWithCriteria({ types: ["COMPONENT_SET"] })
  .filter((node) => node.name === componentName);
if (existingSets.length !== 0) {
  throw new Error(`Component set ${componentName} already exists or is ambiguous on the recorded page; reconcile its ledger entry first.`);
}

const axisNames = Object.keys(variantAxes);
const axisValues = Object.values(variantAxes) as readonly (readonly string[])[];
const combinations = axisValues.reduce<string[][]>(
  (accumulator, values) => accumulator.flatMap((prefix) => values.map((value) => [...prefix, value])),
  [[]],
);

if (combinations.length === 0 || combinations.length > 30) {
  throw new Error(`Expected 1-30 variants, received ${combinations.length}.`);
}

const variants: ComponentNode[] = [];
for (const values of combinations) {
  const variant = figma.createComponent();
  variant.name = axisNames.map((axis, index) => `${axis}=${values[index]}`).join(", ");
  variant.resize(width, height);
  variant.layoutMode = "HORIZONTAL";
  variant.primaryAxisAlignItems = "CENTER";
  variant.counterAxisAlignItems = "CENTER";
  variant.paddingLeft = 16;
  variant.paddingRight = 16;
  variant.fills = [{ type: "SOLID", color: { r: 0.15, g: 0.39, b: 0.92 } }];
  page.appendChild(variant);
  variants.push(variant);
}

const componentSet = figma.combineAsVariants(variants, page);
componentSet.name = componentName;

const columns = axisValues.at(-1)?.length ?? 1;
for (const [index, variant] of componentSet.children.entries()) {
  variant.x = (index % columns) * (width + gridGap);
  variant.y = Math.floor(index / columns) * (height + gridGap);
}

const rows = Math.ceil(combinations.length / columns);
componentSet.resize(
  columns * width + (columns - 1) * gridGap + setPadding * 2,
  rows * height + (rows - 1) * gridGap + setPadding * 2,
);
componentSet.x = 480;
componentSet.y = 80;

return {
  pageId: page.id,
  componentSetId: componentSet.id,
  componentSetName: componentSet.name,
  variantCount: componentSet.children.length,
  variantIds: componentSet.children.map((variant) => variant.id),
};
```

## Run and review

Run `npm --silent run figma:run -- --help` first. Save the reviewed local TypeScript script, then execute it through the CLI:

```text
npm --silent run figma:run -- --file <figma-file-url-or-key> --surface design --script <path/to/script.figma.ts>
```

This is not automatically executable. Replace every placeholder and review the proposed variant count, page, name, layout, and colors before running it. After execution, read back the returned IDs, record them in the external ledger, and visually verify that the variants form the expected grid rather than overlapping. For `outcome_unknown`, reconcile the exact page/set/variant IDs before creating anything else. For `failed_atomic`, retain the direct host/script diagnostics, repair the script, and retry safely because Figma confirmed no file changes.
