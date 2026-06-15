---
name: figma-router
description: Unified routing entry for official Figma MCP skill workflows. Use for Figma design, FigJam, Slides, Make, Code Connect, design systems, tokens, components, use_figma, create_new_file, generate_diagram, generate_figma_design, Plugin API lookup, or any task that needs choosing the correct official Figma skill, MCP resource, or local Figma reference before tool use.
---

# Figma Router

Use this skill as the lightweight entry point for Figma MCP tasks. Do not copy, rewrite, delete, or reorganize the official Figma plugin cache.

## Route

1. Identify the task type before reading a large Figma skill.
2. Use the route table below to choose the official bundled skill document and the local lightweight reference.
3. Read exactly the most relevant local reference from `references/`.
4. Read the bundled official copy under `references/official-figma-skills/<skill>/` before acting; use MCP resources only as tool/runtime identities, not as the documentation source. Bundled official skill entry files are named `SKILL.source.md` so they are not discovered as live skills.
5. For `use_figma`, `create_new_file`, or `generate_diagram`, preserve the original mandatory prerequisite semantics: load the specific Figma skill or its `skill://figma/.../SKILL.md` MCP resource before every matching tool call.

For deterministic loading from a `skill://figma/...` URI or a short skill name such as `figma-use`, use the bundled helper at `<skill_dir>/scripts/figma_skill_reader.py`, where `<skill_dir>` is the directory containing this `SKILL.md`. Its `read(uri_or_name) -> str` function returns the bundled plugin-local document content.

## Route Table

| Task | Bundled official document | Local reference | Required before tool call |
| --- | --- | --- | --- |
| Code Connect templates, component mapping, `.figma.ts`, `.figma.js` | `references/official-figma-skills/figma-code-connect/SKILL.source.md` | `references/figma-code-connect.md` | Read before Code Connect work. |
| Create a new design, FigJam, or Slides file | `references/official-figma-skills/figma-create-new-file/SKILL.source.md` | `references/figma-create-new-file.md` | Mandatory before every `create_new_file` call. |
| App/page/view/modal/drawer/panel to Figma | `references/official-figma-skills/figma-generate-design/SKILL.source.md` | `references/figma-generate-design.md` | Read alongside `figma-use` guidance when writing to Figma. |
| Diagram, Mermaid, flowchart, ERD, sequence, state, Gantt, timeline, architecture | `references/official-figma-skills/figma-generate-diagram/SKILL.source.md` | `references/figma-generate-diagram.md` | Mandatory before every `generate_diagram` call. |
| Design system, tokens, variables, component library, component creation | `references/official-figma-skills/figma-generate-library/SKILL.source.md` | `references/figma-generate-library.md` | Read with `figma-use` before Figma library writes. |
| Figma Plugin API execution, canvas writes, programmatic inspection | `references/official-figma-skills/figma-use/SKILL.source.md` | `references/figma-use.md` | Mandatory before every `use_figma` call. |
| FigJam board inspection, board scaffolds, FigJam nodes, image upload routing | `references/official-figma-skills/figma-use-figjam/SKILL.source.md` | `references/figma-use-figjam.md` | Read with `figma-use` for FigJam boards; route image uploads to asset upload guidance. |
| Slides deck organization, speaker notes, themes, slide grids, lifecycle, properties | `references/official-figma-skills/figma-use-slides/SKILL.source.md` | `references/figma-use-slides.md` | Read with `figma-use` for Slides files. |
| Exact Plugin API type lookup | `references/official-figma-skills/figma-use/references/plugin-api-standalone.index.md` and `references/official-figma-skills/figma-use/references/plugin-api-standalone.d.ts` | `references/plugin-api-lookup.md` and `references/plugin-api-standalone.md` | Read index first, then use the bundled `.d.ts` document reference for targeted symbol search. |

## Official Skill Summaries

- `figma-use`: Mandatory prerequisite before every `use_figma` call. Use for Figma writes, Plugin API execution, node edits, variables, styles, components, and programmatic inspection.
- `figma-create-new-file`: Mandatory prerequisite before every `create_new_file` call. Use for new blank Figma design, FigJam, or Slides files and plan/project resolution.
- `figma-generate-diagram`: Mandatory prerequisite before every `generate_diagram` call. Use for Mermaid, FigJam diagrams, flowcharts, architecture diagrams, ERD, sequence, state, Gantt, timeline, dependency graph, schema, and pipeline visuals.
- `figma-code-connect`: Use for Figma Code Connect template files that map published Figma components to code snippets, especially `.figma.ts` and `.figma.js`.
- `figma-generate-design`: Use alongside `figma-use` for composed app pages, screens, modals, drawers, sidebars, panels, and multi-section views in Figma.
- `figma-generate-library`: Use with `figma-use` for design systems, tokens, variables, styles, component libraries, variants, theming, documentation, and even single production-quality component creation.
- `figma-use-figjam`: Use with `figma-use` for FigJam board workflows, existing-board inspection, board-content planning, stickies, sections, connectors, labels, tables, and FigJam-specific layout behavior.
- `figma-use-slides`: Use with `figma-use` for Figma Slides workflows, deck organization, speaker notes, themes, slide lifecycle, slide grids, slide properties, and Slides-specific gotchas.

## API Lookup

The full `plugin-api-standalone.d.ts` is bundled at `references/official-figma-skills/figma-use/references/plugin-api-standalone.d.ts`. Treat that plugin-local copy as the source-of-truth document for exact API symbols; use [references/plugin-api-standalone.md](references/plugin-api-standalone.md) for its path and access rules. The bundled official Figma 2.0.9 skill copy contains eight skill folders; do not add routes for skills that are not present there.

## Scripts

Resolve the helper script as `<skill_dir>/scripts/figma_skill_reader.py`, with `<skill_dir>` equal to the directory containing this `SKILL.md`. Do not resolve `scripts/figma_skill_reader.py` from the current working directory, plugin root, repository root, installed cache root, or any hard-coded local path. Before the first helper command in a session, verify that `<skill_dir>/scripts/figma_skill_reader.py` exists; if it does not, search only the current `figma-router` skill bundle for `scripts/figma_skill_reader.py`, use the discovered absolute path, and report the path mismatch briefly.

Run the helper directly with Python:

`python <skill_dir>/scripts/figma_skill_reader.py <uri-or-name> [--path]`

Examples:

```bash
python <skill_dir>/scripts/figma_skill_reader.py figma-use
python <skill_dir>/scripts/figma_skill_reader.py figma-use/references/api-reference.md
python <skill_dir>/scripts/figma_skill_reader.py skill://figma/figma-code-connect/SKILL.md
python <skill_dir>/scripts/figma_skill_reader.py figma-use --path
python <skill_dir>/scripts/figma_skill_reader.py -h
```

The command prints document content to stdout by default. With `--path`, it prints the resolved plugin-local file path.

Python API, when importing is more convenient:

```python
from scripts.figma_skill_reader import read

content = read("skill://figma/figma-code-connect/SKILL.md")
figma_use = read("figma-use")
api_ref = read("figma-use/references/api-reference.md")
api_index = read("figma-use/references/plugin-api-standalone.index.md")
```

The resolver accepts `skill://figma/...` URIs, relative Figma skill document paths such as `figma-use/references/api-reference.md`, or short skill names. Inputs ending in `SKILL.md` are mapped to bundled `SKILL.source.md` files. It only returns files inside `references/official-figma-skills/`.
