# Create a documentation page

Create one Figma Design page with a consistent documentation layout: a title, an optional description, and ordered content sections. Use this as a starting point for Foundations, Getting Started, or a component-documentation page.

## Prerequisites and inputs

- Run this only in a Figma Design file. `figma.createPage()` is unavailable in FigJam and Slides.
- Use the external ledger for the target file. Replace every `TODO` placeholder with an approved deterministic page name and content.
- The example uses Inter `Bold` and `Regular`. Confirm those exact font styles are available before editing text.
- Save the script locally as `C:/work/project/figma-scripts/create-documentation-page.figma.ts` (or another caller-owned path).

## Safety boundary

This creates one page and does not delete or rename existing content. It refuses to create a duplicate deterministic page name, so an unknown or interrupted result must be reconciled against the ledger before another create. Keep this run focused on one page, validate its returned IDs, then inspect its structure and capture it visually before adding more content.

## Script

```typescript
const pageName = "TODO: Foundations";
const titleText = "TODO: Foundations";
const descriptionText = "TODO: Explain the design-system foundations on this page.";
const sections = [
  {
    name: "TODO: Color",
    body: "TODO: Add reviewed color-token guidance or swatches in a later, focused run.",
  },
  {
    name: "TODO: Typography",
    body: "TODO: Add reviewed type-scale guidance or specimens in a later, focused run.",
  },
] as const;

const existingPages = figma.root.children.filter((page) => page.name === pageName);
if (existingPages.length !== 0) {
  throw new Error(`Page ${pageName} already exists or is ambiguous; reconcile its ledger entry before creating another.`);
}

await Promise.all([
  figma.loadFontAsync({ family: "Inter", style: "Bold" }),
  figma.loadFontAsync({ family: "Inter", style: "Regular" }),
]);

const page = figma.createPage();
page.name = pageName;
await figma.setCurrentPageAsync(page);

const root = figma.createFrame();
root.layoutMode = "VERTICAL";
root.name = `${pageName}/Documentation`;
root.resize(1440, 1);
root.layoutSizingHorizontal = "FIXED";
root.primaryAxisAlignItems = "MIN";
root.counterAxisAlignItems = "MIN";
root.itemSpacing = 80;
root.paddingTop = 80;
root.paddingRight = 80;
root.paddingBottom = 120;
root.paddingLeft = 80;
root.fills = [{ type: "SOLID", color: { r: 1, g: 1, b: 1 } }];
page.appendChild(root);

const header = figma.createFrame();
header.layoutMode = "VERTICAL";
header.name = "Header";
header.itemSpacing = 12;
header.fills = [];
root.appendChild(header);
header.layoutSizingHorizontal = "FILL";

const title = figma.createText();
title.name = "Title";
title.fontName = { family: "Inter", style: "Bold" };
title.characters = titleText;
title.fontSize = 40;
title.fills = [{ type: "SOLID", color: { r: 0.07, g: 0.07, b: 0.07 } }];
header.appendChild(title);
title.layoutSizingHorizontal = "FILL";

const description = figma.createText();
description.name = "Description";
description.fontName = { family: "Inter", style: "Regular" };
description.characters = descriptionText;
description.fontSize = 16;
description.lineHeight = { value: 24, unit: "PIXELS" };
description.fills = [{ type: "SOLID", color: { r: 0.4, g: 0.4, b: 0.4 } }];
header.appendChild(description);
description.layoutSizingHorizontal = "FILL";

const sectionIds: string[] = [];
for (const section of sections) {
  const sectionFrame = figma.createFrame();
  sectionFrame.layoutMode = "VERTICAL";
  sectionFrame.name = `Section/${section.name}`;
  sectionFrame.itemSpacing = 20;
  sectionFrame.fills = [];
  root.appendChild(sectionFrame);
  sectionFrame.layoutSizingHorizontal = "FILL";

  const heading = figma.createText();
  heading.name = "Section heading";
  heading.fontName = { family: "Inter", style: "Bold" };
  heading.characters = section.name;
  heading.fontSize = 24;
  heading.fills = [{ type: "SOLID", color: { r: 0.07, g: 0.07, b: 0.07 } }];
  sectionFrame.appendChild(heading);
  heading.layoutSizingHorizontal = "FILL";

  const body = figma.createText();
  body.name = "Section body";
  body.fontName = { family: "Inter", style: "Regular" };
  body.characters = section.body;
  body.fontSize = 16;
  body.lineHeight = { value: 24, unit: "PIXELS" };
  body.fills = [{ type: "SOLID", color: { r: 0.2, g: 0.2, b: 0.2 } }];
  sectionFrame.appendChild(body);
  body.layoutSizingHorizontal = "FILL";

  sectionIds.push(sectionFrame.id);
}

return {
  pageId: page.id,
  pageName: page.name,
  rootId: root.id,
  rootName: root.name,
  titleId: title.id,
  sectionIds,
};
```

## Run explicitly

After replacing the placeholders and reviewing the script, run it explicitly. It is not automatically executable merely because it appears in this document.

```text
npm --silent run figma:run -- --file <figma-file-url-or-key> --surface design --script <path/to/script.figma.ts>
```

Review the returned IDs, read back the page and root before recording them in the external ledger, then use `figma:metadata` and `figma:capture` to validate the new page before extending it. For `outcome_unknown`, first check the exact page name and returned IDs in the explicit file before any retry. For `failed_atomic`, retain the direct host/script diagnostics, repair the script, and retry safely because Figma confirmed no file changes.
