# figma-code-connect

MCP resource: `skill://figma/figma-code-connect/SKILL.md`

Read when the task mentions Code Connect, Figma component mapping, design-to-code translation, or asks to create or update Code Connect template `.figma.ts` or `.figma.js` files.

Required before tool call: read before creating or maintaining Code Connect templates. Official prerequisites include published Figma components, an Organization or Enterprise plan, and node-specific Figma URLs. Do not route parser-based `.figma.tsx` implementation work here unless the official skill says it applies. If the workflow also writes to Figma, read `figma-use` before the `use_figma` call.

Local plugin reference: read only the Code Connect references selected by the MCP skill, such as API or advanced patterns.
