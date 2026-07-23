# Implement a Figma Design as Code (Design → Code)

Use this workflow to turn a Figma design into code in a target codebase. This is the **read-FROM-Figma** direction: pull design context out of Figma with `figma:design-context`, then adapt it into the project's real stack. For the reverse direction — building or updating a design *in* Figma from code — use a `.figma.ts` script executed with `figma:run`.

Parameter mechanics (nodeId / fileKey / branchKey extraction, URL parsing, `format` / `query` options, and response shape) live in `figma:design-context --help`; follow that contract.

## Direction and Scope

- Use this workflow for design → code: implementing, translating, or porting a Figma node into code.
- Do not use this workflow to write to Figma.

## Workflow

### 1. Call figma:design-context first

- You MUST call `figma:design-context` on the target node before writing any code. It is your primary command — a single call returns reference code, a capture, and contextual hints.
- You MUST NOT use `figma:metadata` or `figma:capture` as a substitute. Use them only to orient (e.g. picking a node) or to validate, not in place of `figma:design-context`.

### 2. Treat the output as a reference, not final code

- The returned code is React + Tailwind enriched with hints. You MUST treat it as a REFERENCE, not as final code to paste verbatim.
- You MUST adapt it to the target project's language, framework, component library, styling system, and conventions. Match the surrounding code.

### 3. Reuse what the project already has

- Before writing new code, You MUST check the target project for existing components, layout patterns, and design tokens that match the design intent.
- You MUST reuse the project's existing components and tokens instead of generating new equivalents from scratch.

### 4. Honor the response hints by priority

Apply the hints in this order — earlier sources override later ones:

1. **Code Connect snippets** → use the mapped codebase component directly.
2. **Component documentation links** → follow them for usage and guidelines.
3. **Design annotations** → follow any designer notes or constraints.
4. **Design tokens (CSS variables)** → map them to the project's token system.
5. **Raw hex / absolute positioning** → loosely structured; lean on the capture for intent.

### 5. Reproduce images and icons faithfully

Images and icons may arrive with asset metadata in the design-context response. Apply these rules as you write the code:

- **Render every icon/image from its exported asset.** Never hand-write or inline `<svg>`/`<path>`, never author your own icon file, never drop an icon or leave a placeholder — you don't have the real vector data, so anything you draw is wrong.
- **Sourcing:** use `figma:assets:download` to obtain the exact asset bytes for code you will commit, or wire a dynamic-content image to the project's data source (API, CDN, or props). Never author the asset contents yourself.
- **Reuse a project icon component only if its glyph clearly matches** (a name match is not enough); otherwise use the exported asset.
- **Size explicitly:** a fixed-size container (icons are usually square, e.g. `size-[24px]`, `overflow-clip`) with BOTH width and height set, and size the leaf `<img>` to fill it (`100%` or fixed px) — never `auto`, which blows the image up to its intrinsic size.

## Error Recovery

- On a `figma:design-context` error, STOP and read the message before retrying.
- If the design URL has no `node-id` (a file-only URL), ask the user for a node-specific URL — You MUST NOT guess or pass an empty `nodeId`.
- On a timeout, retry against a smaller node or selection.
- You MUST NOT silently fall back to hand-writing the screen from a capture alone when `figma:design-context` can still provide context.
