# Slides lifecycle and section structure

Use Slides nodes as a deck structure, not ordinary frames arranged by guesswork. `createSlide()` returns a `SlideNode` and parents it into the page's slide grid. `createSlideRow()` returns a `SlideRowNode`; each row is a section that can be named for both editor navigation and presenter navigation.

Create, rename, or reorganize slides in a local `.figma.ts` file, then execute it through `figma:run` with an explicit Slides target. Start a structural edit by inspecting existing metadata when the deck was not created in the current task; do not assume that a page child index stays stable across prior edits.

```ts
// Append a section and two slides. The row's name is the section label.
const section = figma.createSlideRow();
section.name = "Product proof";

const overview = figma.createSlide();
overview.name = "Customer signal";

const detail = figma.createSlide();
detail.name = "Evidence";

return {
  sectionId: section.id,
  slideIds: [overview.id, detail.id],
  validation: "Created a named section and two slides in the deck grid."
};
```

## Operations and constraints

| Task | Native API operation | Boundary to preserve |
| --- | --- | --- |
| Append a slide | `figma.createSlide()` | It is inserted into the grid automatically. |
| Place a slide by grid coordinates | `figma.createSlide(rowIndex, columnIndex)` | Verify the resulting deck order after structural changes. |
| Append/insert a section | `figma.createSlideRow()` or `figma.createSlideRow(index)` | New rows are empty; add slides deliberately. |
| Label a section | `row.name = "..."` | `SLIDE_ROW` is otherwise opaque; use its name, not visual styling, to express the section. |
| Duplicate a slide | `slide.clone()` | The clone is appended by default; reposition it with `setSlideGrid`. |
| Delete a slide | `slide.remove()` | Empty rows remain and may need an explicit cleanup decision. |
| Reorder | `getSlideGrid` and `setSlideGrid` | Never clone the slide grid: `SlideGridNode.clone()` throws at runtime. |

For changes that mix layout and lifecycle, do the structural operation first and return created raw node IDs from the script. Use another focused script run for dense content changes, so a failed layout edit does not obscure whether the deck order changed.

## Validate before reporting success

Run `figma:run` only after TypeScript preflight is clean. A fatal diagnostic means no partial lifecycle operation was executed. After a successful run, inspect the returned nodes or fresh metadata to confirm section names, slide count, and order; then use `figma:capture` on representative slides and inspect each local image with `view_image`.

Capture cannot prove presenter navigation or transitions, and still images do not reveal an empty section outside the selected view. If the requested reorder could remove or relocate user-authored slides, inspect first, make the smallest explicit structural change, and report the resulting ids and order rather than treating an inferred grid layout as authoritative.
