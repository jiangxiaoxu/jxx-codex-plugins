---
name: figma-router
description: Unified routing entry for official Figma MCP skill workflows, Figma REPL MCP workflows, and Figma MCP login. Use for Figma design, FigJam, Slides, Make, Code Connect, design systems, tokens, components, use_figma, figma_repl_run_script_file, figma_repl_eval, create_new_file, generate_diagram, generate_figma_design, Plugin API lookup, Figma MCP login/auth refresh, or any task that needs choosing the correct official Figma skill, MCP resource, or local Figma reference before tool use.
---

# Figma Router

Use this skill as the lightweight entry point for Figma MCP tasks, including Figma MCP login for the bundled bridge and choosing the future single Figma-facing facade path through stateful `figma-repl-mcp` whenever possible. Do not copy, rewrite, delete, or reorganize the official Figma plugin cache.

## Route

1. Identify the task type before reading a large Figma skill.
2. If the user asks for Figma MCP login, auth setup, credential refresh, or auth repair, use the Figma MCP Login section below.
3. Otherwise, use the route table below to choose the reader input and the local lightweight reference.
4. Read exactly the most relevant local reference from `references/`.
5. Resolve the official Figma skill document with `python <skill_dir>/scripts/figma_skill_reader.py <reader-input>`. The helper returns only the bundled file path and file size, not file content.
6. Use MCP resources only as tool/runtime identities, not as the documentation source. Bundled official skill entry files are named `SKILL.source.md` so they are not discovered as live skills.
7. For `use_figma`, `figma_repl_run_script_file`, `figma_repl_eval`, `figma_repl_inspect`, `create_new_file`, or `generate_diagram`, preserve the original mandatory prerequisite semantics. When using `figma-repl-mcp`, prefer `figma_repl_capabilities`, `figma_repl_docs_search`, and `figma_repl_api_lookup` before reading large bundled references directly; use `figma_repl_apply_asset_manifest` for large local generated assets after target rectangles exist, `figma_repl_capture_node` for final visual QA saved to a local file, including upstream screenshot URL payloads, `figma_repl_run_task_plan` for sequential file plans, and `figma_repl_call_upstream_tool` for official capabilities not covered by the file workflow. If the plugin is not installed in the current Codex environment and direct `figma_repl_*` tools are not discoverable, use the package-local Node fallback `createFigmaReplClient` instead of reporting missing direct tools as an MCP bug.

For deterministic resolution from a `skill://figma/...` URI or a short skill name such as `figma-use`, run the bundled helper at `<skill_dir>/scripts/figma_skill_reader.py`, where `<skill_dir>` is the directory containing this `SKILL.md`. The command prints `path=<resolved-file>` and `size_bytes=<bytes>` to stdout.

After this `SKILL.md` is loaded, use the loaded skill instructions from the current context. Do not reread this file only because the Figma Router skill activates again. Likewise, after a routed official skill `SKILL.source.md` or reference document is progressively loaded, use the loaded text from the current context. Reread a skill or reference document only when the current context does not contain the needed text.

## Route Table

| Task | Reader input | Local reference | Required before tool call |
| --- | --- | --- | --- |
| Code Connect templates, component mapping, `.figma.ts`, `.figma.js` | `figma-code-connect` | `references/figma-code-connect.md` | Read before Code Connect work. |
| Create a new design, FigJam, or Slides file | `figma-create-new-file` | `references/figma-create-new-file.md` | Mandatory before every `create_new_file` call. |
| App/page/view/modal/drawer/panel to Figma | `figma-generate-design` | `references/figma-generate-design.md` | Read alongside `figma-use` guidance when writing to Figma. |
| Diagram, Mermaid, flowchart, ERD, sequence, state, Gantt, timeline, architecture | `figma-generate-diagram` | `references/figma-generate-diagram.md` | Mandatory before every `generate_diagram` call. |
| Design system, tokens, variables, component library, component creation | `figma-generate-library` | `references/figma-generate-library.md` | Read with `figma-use` before Figma library writes. |
| Figma Plugin API execution, canvas writes, programmatic inspection | `figma-use` | `references/figma-use.md` | Mandatory before every `use_figma` call. |
| Stateful unified facade work through `figma-repl-mcp`, including `figma_repl_run_script_file`, `figma_repl_apply_asset_manifest`, `figma_repl_capture_node`, `figma_repl_run_task_plan`, `figma_repl_init_workspace`, `figma_repl_prepare_task`, `figma_repl_plan_task`, `figma_repl_api_card`, `figma_repl_suggest_api`, `figma_repl_eval`, `figma_repl_inspect`, `figma_repl_validate_handles`, `figma_repl_docs_search`, `figma_repl_api_lookup`, `figma_repl_call_upstream_tool`, or Node REPL use of `createFigmaReplClient` | `figma-use` when executing Plugin API code; facade lookup tools when only searching docs/API | `references/figma-use.md` | For Plugin API execution, preserve `figma-use` prerequisites. Prefer `figma_repl_init_workspace` once, then local `.figma.js` files with `inputFile`/`outputFile` names for non-trivial work. For large generated assets, create target rectangles in script and apply local files through `figma_repl_apply_asset_manifest` with explicit upstream `toolName`/`argumentsTemplate` when needed. For final visual QA, use `figma_repl_capture_node` to write a screenshot/capture to a local file. For repeatable workflows, use `figma_repl_run_task_plan` with `script-file`, `asset-manifest`, `screenshot-capture`, and `upstream-tool` steps. For guidance, prefer `figma_repl_capabilities`, `figma-repl://file-workflow`, `figma-repl://workflow-tools`, `figma-repl://api-cards`, `figma-repl://intents`, `figma_repl_api_card`, `figma_repl_suggest_api`, `figma_repl_docs_search`, and `figma_repl_api_lookup`; for official capabilities not covered by the file workflow, stay on the facade and call `figma_repl_call_upstream_tool`. |
| FigJam board inspection, board scaffolds, FigJam nodes, image upload routing | `figma-use-figjam` | `references/figma-use-figjam.md` | Read with `figma-use` for FigJam boards; route image uploads to asset upload guidance. |
| Slides deck organization, speaker notes, themes, slide grids, lifecycle, properties | `figma-use-slides` | `references/figma-use-slides.md` | Read with `figma-use` for Slides files. |
| Exact Plugin API type lookup | Prefer `figma_repl_api_lookup`; fallback to `figma-use/references/plugin-api-standalone.index.md` and targeted `.d.ts` search only when the facade result is insufficient | `references/plugin-api-lookup.md` and `references/plugin-api-standalone.md` | Do not read or dump the full bundled `.d.ts`; use targeted symbol lookup with file/line evidence. |

## Official Skill Summaries

- `figma-use`: Mandatory prerequisite before every direct `use_figma` call and before REPL calls that execute Plugin API code (`figma_repl_run_script_file`, `figma_repl_eval`, `figma_repl_inspect`, `figma_repl_validate_handles`). Use `figma_repl_apply_asset_manifest` for large local assets after target rectangles exist, `figma_repl_capture_node` for final capture-to-file QA, including upstream screenshot URL payloads, and `figma_repl_run_task_plan` for sequential file workflows. Use `figma_repl_api_card`/`figma_repl_suggest_api`/`figma_repl_docs_search`/`figma_repl_api_lookup` for compact guidance before opening large reference files.
- `figma-create-new-file`: Mandatory prerequisite before every `create_new_file` call. Use for new blank Figma design, FigJam, or Slides files and plan/project resolution.
- `figma-generate-diagram`: Mandatory prerequisite before every `generate_diagram` call. Use for Mermaid, FigJam diagrams, flowcharts, architecture diagrams, ERD, sequence, state, Gantt, timeline, dependency graph, schema, and pipeline visuals.
- `figma-code-connect`: Use for Figma Code Connect template files that map published Figma components to code snippets, especially `.figma.ts` and `.figma.js`.
- `figma-generate-design`: Use alongside `figma-use` for composed app pages, screens, modals, drawers, sidebars, panels, and multi-section views in Figma.
- `figma-generate-library`: Use with `figma-use` for design systems, tokens, variables, styles, component libraries, variants, theming, documentation, and even single production-quality component creation.
- `figma-use-figjam`: Use with `figma-use` for FigJam board workflows, existing-board inspection, board-content planning, stickies, sections, connectors, labels, tables, and FigJam-specific layout behavior.
- `figma-use-slides`: Use with `figma-use` for Figma Slides workflows, deck organization, speaker notes, themes, slide lifecycle, slide grids, slide properties, and Slides-specific gotchas.

## API Lookup

The full `plugin-api-standalone.d.ts` is bundled at `references/official-figma-skills/figma-use/references/plugin-api-standalone.d.ts`, but agents should use `figma_repl_api_lookup` for targeted symbol snippets before reading it directly. Treat the plugin-local copy as the source-of-truth document only when facade lookup is insufficient; use [references/plugin-api-standalone.md](references/plugin-api-standalone.md) for its path and access rules. The bundled official Figma 2.0.9 skill copy contains eight skill folders; do not add routes for skills that are not present there.

## Figma MCP Login

Run the login helper from the plugin root, which is two directories above this `SKILL.md`:

```text
workdir: <plugin-root>
command: npm run login:figma-http
```

The helper starts the local HTTP bridge, temporarily logs in through `figma-http`, then removes that temporary MCP entry. After browser OAuth, the shared cache is written to the first matching path:

```text
FIGMA_MCP_OAUTH_CACHE_PATH
CODEX_HOME/.figma-mcp-bridge-oauth.json
USERPROFILE/.codex/.figma-mcp-bridge-oauth.json
```

Do not add persistent `figma-http`; the plugin's persistent MCP servers are `figma-stdio` and `figma-repl-mcp`.

## Bundled MCP Servers

- `figma-stdio`: transparent stdio bridge to the official remote Figma MCP server. Keep for raw upstream debugging and bridge parity checks.
- `figma-repl-mcp`: stateful local MCP facade that can call upstream `use_figma` and other official tools, runs file-based Plugin API scripts, stores in-process session handles/history/diagnostics, and exposes tools such as `figma_repl_capabilities`, `figma_repl_open`, `figma_repl_run_script_file`, `figma_repl_apply_asset_manifest`, `figma_repl_capture_node`, `figma_repl_run_task_plan`, `figma_repl_init_workspace`, `figma_repl_prepare_task`, `figma_repl_plan_task`, `figma_repl_api_card`, `figma_repl_suggest_api`, `figma_repl_eval`, `figma_repl_inspect`, `figma_repl_cache_get`, `figma_repl_validate_handles`, `figma_repl_list_upstream_tools`, `figma_repl_call_upstream_tool`, `figma_repl_docs_search`, and `figma_repl_api_lookup`. Prefer it as the agent-facing entrypoint after OAuth registration; if these tools are not installed into the active Codex environment, use `createFigmaReplClient` as the expected local fallback.

When using `figma-repl-mcp`, do not treat local handles as durable storage: they are process-local and can go stale when nodes are deleted or the MCP process restarts. Use `figma_repl_cache_get`, `figma_repl_validate_handles`, or `figma_repl_inspect` to verify state before relying on old handles. `figma_repl_run_script_file` is the primary path for non-trivial Plugin API JavaScript; initialize a workspace with `figma_repl_init_workspace` so later calls can use `inputFile` and `outputFile` names under `<cwd>/figma-mcp/<fileKey-or-fileSlug>/`, with paired `<intentSlug>.figma.js` and `<intentSlug>.result.json` files. Raw `figma_repl_eval` still runs Plugin API JavaScript in Figma; read `figma-use` guidance first and pass `allowDangerousOperations: true` only after reviewing destructive code. `allowDangerousOperations` does not bypass API contract, read-mode, or Design/FigJam/Slides surface diagnostics.

## Scripts

Resolve the helper script as `<skill_dir>/scripts/figma_skill_reader.py`, with `<skill_dir>` equal to the directory containing this `SKILL.md`. Do not resolve `scripts/figma_skill_reader.py` from the current working directory, plugin root, repository root, installed cache root, or any hard-coded local path. Before the first helper command in a session, verify that `<skill_dir>/scripts/figma_skill_reader.py` exists; if it does not, search only the current `figma-router` skill bundle for `scripts/figma_skill_reader.py`, use the discovered absolute path, and report the path mismatch briefly.

Run the helper directly with Python. It does not print file content; it prints the resolved plugin-local path and file size.

`python <skill_dir>/scripts/figma_skill_reader.py <uri-or-name>`

Examples:

```bash
python <skill_dir>/scripts/figma_skill_reader.py figma-use
python <skill_dir>/scripts/figma_skill_reader.py figma-use/references/api-reference.md
python <skill_dir>/scripts/figma_skill_reader.py skill://figma/figma-code-connect/SKILL.md
python <skill_dir>/scripts/figma_skill_reader.py figma-use/references/plugin-api-standalone.d.ts
python <skill_dir>/scripts/figma_skill_reader.py -h
```

Output shape:

```text
path=<absolute-plugin-local-path>
size_bytes=<file-size>
```

The resolver accepts `skill://figma/...` URIs, relative Figma skill document paths such as `figma-use/references/api-reference.md`, or short skill names. Inputs ending in `SKILL.md` are mapped to bundled `SKILL.source.md` files. It only returns files inside `references/official-figma-skills/`.
