# figma-use

MCP resource: `skill://figma/figma-use/SKILL.md`

Read when the task needs JavaScript execution through `use_figma`, including Figma canvas writes, node creation or editing, variable/style work, or unique programmatic inspection.

Escalate specialized work before calling tools:

- Full page, full screen, multi-section layout, modal, drawer, sidebar, or panel work also reads [figma-generate-design.md](figma-generate-design.md).
- Creating any production-quality component also reads [figma-generate-library.md](figma-generate-library.md).
- Design-system component, variable, style, or token work starts from the official `figma-use` working-with-design-systems reference selected by that skill.
- FigJam boards also read [figma-use-figjam.md](figma-use-figjam.md).
- Slides files also read [figma-use-slides.md](figma-use-slides.md).

Required before tool call: read the `figma-use` skill or this MCP resource before every `use_figma` call. When using the MCP resource route, pass `skillNames: "resource:figma-use"` unless another loaded Figma skill instructs otherwise.

Local plugin reference: read only the specific referenced files needed by the `figma-use` skill. For exact Plugin API symbols, use [plugin-api-lookup.md](plugin-api-lookup.md).
