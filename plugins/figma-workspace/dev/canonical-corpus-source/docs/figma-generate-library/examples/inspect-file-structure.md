# Inspect File Structure

## Purpose

Create a read-only inventory before planning library work. The result lists pages, local variable collections, standalone components and component sets, and local text and effect styles. Use the returned IDs as observed data; do not infer or invent IDs.

## Prerequisites and inputs

- An explicit Design file URL or fileKey.
- A local `.figma.ts` path chosen by the caller.
- Replace every `<...>` placeholder below and review the script against the target file before running it.

## Safety boundary

This script only reads Figma objects. It does not create, rename, remove, reparent, or select nodes, and it does not change `figma.currentPage`. Its result can contain file structure and naming data; keep caller-owned artifacts in an approved local directory when retention is needed.

## Save and run

Save the following body as `<path/to/inspect-file-structure.figma.ts>`, then execute that file directly:

```text
npm --silent run figma:run -- --file <figma-file-url-or-key> --surface design --script <path/to/script.figma.ts>
```

The CLI does not execute this document or pasted code automatically. Review the returned inventory before using it to decide what may be created or updated.

```typescript
const inventoryStartedAt = Date.now();

type PageInventory = {
  id: string;
  name: string;
  childCount: number;
};

type VariableCollectionInventory = {
  id: string;
  name: string;
  modes: Array<{ modeId: string; name: string }>;
  variableCount: number;
  variableNames: string[];
};

type ComponentInventory = {
  id: string;
  name: string;
  variantCount: number;
  pageId: string;
  pageName: string;
};

const pages: PageInventory[] = figma.root.children.map((page) => ({
  id: page.id,
  name: page.name,
  childCount: page.children.length,
}));

const variableCollections: VariableCollectionInventory[] = [];
for (const collection of await figma.variables.getLocalVariableCollectionsAsync()) {
  const variables = await Promise.all(
    collection.variableIds.map((id) => figma.variables.getVariableByIdAsync(id)),
  );

  variableCollections.push({
    id: collection.id,
    name: collection.name,
    modes: collection.modes.map(({ modeId, name }) => ({ modeId, name })),
    variableCount: collection.variableIds.length,
    variableNames: variables.flatMap((variable) => variable ? [variable.name] : []),
  });
}

const components: ComponentInventory[] = [];
for (const page of figma.root.children) {
  const nodes = page.findAllWithCriteria({ types: ["COMPONENT_SET", "COMPONENT"] });
  for (const node of nodes) {
    if (node.type === "COMPONENT_SET") {
      components.push({
        id: node.id,
        name: node.name,
        variantCount: node.children.length,
        pageId: page.id,
        pageName: page.name,
      });
    } else if (node.parent?.type !== "COMPONENT_SET") {
      components.push({
        id: node.id,
        name: node.name,
        variantCount: 1,
        pageId: page.id,
        pageName: page.name,
      });
    }
  }
}

const textStyles = figma.getLocalTextStyles().map((style) => ({
  id: style.id,
  name: style.name,
  fontFamily: style.fontName.family,
  fontStyle: style.fontName.style,
  fontSize: style.fontSize,
}));

const effectStyles = figma.getLocalEffectStyles().map((style) => ({
  id: style.id,
  name: style.name,
  effectCount: style.effects.length,
}));

return {
  pages,
  variableCollections,
  components,
  textStyles,
  effectStyles,
  durationMs: Date.now() - inventoryStartedAt,
};
```
