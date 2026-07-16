# Reusable component structure

Build reusable structure during the first implementation pass. A screen that contains repeated cards, rows, navigation items, or controls should not be delivered as a flat collection of near-identical frames and repaired later.

Use a published design-system component when it already expresses the needed semantic unit. A local component is appropriate when the library has no match and either the source component is reusable or the visual unit occurs more than once. One source component should normally become one Figma main component; screen content should contain instances, not copies of the main component's child tree.

## Decide before writing the script

Start by reading the implementation context for the selected file/session. This makes existing instances, component keys, layout conventions, and likely reuse boundaries observable before new nodes are created.

```text
npm --silent run figma:design-context -- --session-id <session-id> --state-file C:/work/project/.figma-workspace/state.json
```

Then choose the narrowest structure that preserves editing intent:

| Situation | Structure to create |
| --- | --- |
| A published library component is available | Instantiate it and set only supported instance properties or content overrides. |
| The same local unit appears 2+ times | Create one local `ComponentNode`, then create instances. |
| A source component has variants such as size or state | Use one component set with explicit properties instead of unrelated duplicate components. |
| A unit is genuinely unique to one composition | Keep it as ordinary frame content; do not componentize incidental decoration. |

Do not detach a library instance merely to alter it. If the requested result cannot be represented through its exposed properties, report the limitation or create a separate local component rather than silently breaking the library relationship.

## Implement in a `.figma.ts` transaction

Use the normal TypeScript script workflow: prepare/open the task, edit the local `.figma.ts`, and execute it with `figma:script:run` using a JSON input that names the persisted session and script file. TypeScript preflight must pass before the transaction reaches Figma.

```ts
const metrics: ReadonlyArray<{ label: string }> = [
  { label: "Revenue" },
  { label: "Retention" },
  { label: "Activation" },
];

const list = figma.createFrame();
list.name = "Metrics list";
list.layoutMode = "VERTICAL";
list.itemSpacing = 12;
list.fills = [];
figma.currentPage.appendChild(list);

// Build the reusable unit once, outside the screen wrapper.
const row = figma.createComponent();
row.name = "Metric row";
row.layoutMode = "HORIZONTAL";
row.primaryAxisSizingMode = "FIXED";
row.resize(420, 72);

const title = figma.createText();
await figma.loadFontAsync({ family: "Inter", style: "Regular" });
title.characters = "Label";
row.appendChild(title);

const instanceIds: string[] = [];
for (const metric of metrics) {
  const instance = row.createInstance();
  instance.name = `Metric row / ${metric.label}`;
  // Update known descendant content or exposed component properties here.
  list.appendChild(instance);
  instanceIds.push(instance.id);
}

return {
  componentId: row.id,
  instanceIds,
  validation: "All repeated metric rows are instances of one local component."
};
```

Keep the main component in a dedicated local-components area or safely outside the composed screen. It should remain editable without appearing in the captured UI. Load fonts before setting text, preserve auto-layout and sizing rules on the main component, and avoid changing instance children through assumptions about unstable layer names.

## Verify the delivered structure

After `figma:script:run`, use `figma:inspect` on the returned raw node IDs to confirm the component and instance relationship, then use `figma:capture` for visual QA of the consuming screen. Inspect the captured local image with `view_image`; an instance tree that is structurally correct but has clipped content, unexpected fixed sizing, or a visible component staging area is not complete.

Failure boundaries are deliberate: fatal TypeScript diagnostics mean the script did not execute; an unavailable raw node ID requires re-inspection before reuse; and an unavailable library component is not permission to approximate its internals. For a large migration, split the work into small repairable script runs and validate each repeated unit before replacing the next one.
