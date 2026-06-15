# figma-create-new-file

MCP resource: `skill://figma/figma-create-new-file/SKILL.md`

Read when the user wants a new blank Figma design, FigJam board, or Slides file, or when a new file is needed before `use_figma`.

Required before tool call: mandatory before every `create_new_file` call. Follow its plan resolution contract: use a provided `planKey`, otherwise call `whoami`; ask the user only if multiple plans are available. If creating Slides, expect a follow-up `use_figma` pass with [figma-use-slides.md](figma-use-slides.md) to handle empty-grid or deck setup behavior.

Local plugin reference: normally none. Read the MCP resource for the current contract before calling the tool.
