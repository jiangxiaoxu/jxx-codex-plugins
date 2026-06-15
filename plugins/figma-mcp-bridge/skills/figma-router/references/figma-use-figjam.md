# figma-use-figjam

MCP resource: `skill://figma/figma-use-figjam/SKILL.md`

Read when using `use_figma` against a FigJam board or when the task involves existing-board inspection, board-content planning, FigJam-specific nodes, or board planning layouts. FigJam-specific nodes include stickies, sections, connectors, labels, tables, shapes with text, code blocks, and editable text.

Required before tool call: read with `figma-use` before `use_figma` for FigJam. Use `figma-use` for the base Plugin API contract and this route for FigJam-specific behavior. For existing boards, start with official FigJam inspection guidance. For board-content requests, read `plan-board-content.md`. For adding images to FigJam, route to asset upload guidance instead of creating images directly with `use_figma`.

Local plugin reference: read only the specific FigJam reference needed, such as plan-board-content, create-section, create-sticky, create-connector, create-text, create-table, create-label, create-shape-with-text, create-code-block, edit-text, batch-modify, colors, or positioning.
