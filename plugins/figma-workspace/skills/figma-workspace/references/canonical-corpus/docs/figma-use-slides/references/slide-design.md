# Designing a coherent Slides deck

A deck is a paced visual argument, not a document divided into pages. Give each slide one job: establish a premise, show evidence, create contrast, make a transition, or leave the audience with a conclusion. If it cannot be understood in a few seconds, edit the content or split the slide before reducing type size.

For an existing deck, inspect its canvas, hierarchy, palette, typography, spacing habits, and recurring motifs first. Match those established decisions unless the user supplies a replacement direction. For a new deck, use the decision table below before creating slides in a `.figma.ts` script.

| Design decision | Practical rule |
| --- | --- |
| Palette | Let one color dominate, support it with a secondary tone, and reserve accents for emphasis. Body text must retain strong contrast, especially on dark slides. |
| Type | Load an available display/body pairing when no brand system is supplied. Titles need a visible scale jump; paragraphs and lists should normally be left-aligned. |
| Density | Prefer one insight with generous space, or a deliberately dense evidence slide. Avoid the accidental middle where everything is merely small. |
| Composition | Let the rhetorical purpose decide the layout. Use asymmetric regions, edge anchoring, overlap, and cropping only when they reinforce the message. |
| Deck rhythm | Alternate information-rich and quiet slides; vary anchor points, dark/light treatments, and composition across the sequence. |
| Motif | Repeat one recognizable shape, line treatment, or layering rule with variation. It must be visible enough to feel intentional. |

## Build through the CLI workflow

Prepare the Slides task, edit the generated `.figma.ts`, and use `figma:script:run`; TypeScript preflight is always enabled. Keep a slide's creation and its local layout together so each transaction is small and repairable. Slides are isolated subtrees, so building several simple slides in one run is reasonable; split a complex deck at section boundaries.

```ts
const slide = figma.createSlide();
slide.name = "Why now";
slide.backgrounds = [{ type: "SOLID", color: { r: 0.04, g: 0.06, b: 0.12 } }];

const titleFont: FontName = { family: "Inter", style: "Bold" };
await figma.loadFontAsync(titleFont);
const title = figma.createText();
title.fontName = titleFont;
title.characters = "The cost of waiting is compounding";
title.fontSize = 76;
title.fills = [{ type: "SOLID", color: { r: 1, g: 1, b: 1 } }];
slide.appendChild(title);
title.x = 120;
title.y = 140;

const accent = figma.createEllipse();
accent.resize(520, 520);
accent.fills = [{ type: "SOLID", color: { r: 0.4, g: 0.8, b: 0.67 }, opacity: 0.9 }];
slide.appendChild(accent);
accent.x = 1540;
accent.y = 730;

return { slideId: slide.id, validation: "Dark section divider with high-contrast title and visible motif." };
```

Do not blindly repeat this composition. A comparison can use separation, a single metric can occupy most of the canvas, and a quotation can be almost entirely type. Avoid template tells: identical title-plus-grid layouts, a line under every heading, cards around every item, weak decorative shapes, centered body copy, uniform margins, and swapped colors on otherwise identical slides.

## Validate the sequence, not just node creation

Use `figma:capture` for representative slides and inspect every resulting image with `view_image`. Check title dominance, clipping, contrast, empty-space intent, and whether decorative elements still help at presentation scale. Capture a title, a dense evidence slide, and a transition slide at minimum; a deck can have individually acceptable slides but a monotonous sequence.

Fatal script diagnostics are an execution boundary: repair them before retrying. If available fonts or existing branding do not support the requested direction, keep the deck consistent and report the restriction rather than substituting unreviewed typography. A still capture confirms layout and legibility, not presenter timing or animations.
