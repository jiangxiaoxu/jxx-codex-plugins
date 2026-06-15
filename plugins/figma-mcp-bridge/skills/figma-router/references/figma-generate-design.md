# figma-generate-design

MCP resource: `skill://figma/figma-generate-design/SKILL.md`

Read when translating an application page, screen, modal, dialog, drawer, sidebar, panel, or composed multi-section view into Figma from code or description.

Required before tool call: read alongside `figma-use` when writing to Figma. Use `generate_figma_design` only for first-time capture of a web app page into an existing Figma design file; use `use_figma` for non-web targets, from-scratch work, and updates to an existing Figma page. If the source is a web app with images, follow the official parallel `generate_figma_design` capture plus `use_figma` build/refine workflow.

Discovery order: check Code Connect files first, existing screens second, and `search_design_system` last. Use `get_libraries` before scoped library search when a file has libraries available.

Local plugin reference: read only task-specific references named by the MCP skill, such as componentization or product font discovery.
