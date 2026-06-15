# figma-generate-diagram

MCP resource: `skill://figma/figma-generate-diagram/SKILL.md`

Read when the task asks to create, generate, draw, render, sketch, or build a diagram, including Mermaid, FigJam diagramming, flowchart, architecture, ERD, sequence, state, Gantt, timeline, dependency graph, auth handshake, schema, or pipeline visuals.

Required before tool call: mandatory before every `generate_diagram` call. Read any diagram-type reference named by the skill, such as flowchart, sequence, ERD, architecture, state, Gantt, or workflow. Route infrastructure-style flowcharts to architecture guidance when the official skill says to do so. For annotation, color, or post-generation FigJam edits, combine the diagram route with [figma-use-figjam.md](figma-use-figjam.md).

Local plugin reference: use the MCP resource references first. Do not hand-roll Mermaid constraints when the specific diagram reference is available.
