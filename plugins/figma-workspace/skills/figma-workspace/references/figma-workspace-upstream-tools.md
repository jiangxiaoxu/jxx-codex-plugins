# Figma Workspace Upstream Tools

Use this reference to decide between a first-class CLI command and direct official Figma remote MCP delegation.

## Prefer First-Class Commands

- Use `figma:design-context`, `figma:motion-context`, `figma:metadata`, `figma:design-system`, `figma:libraries`, `figma:variables`, `figma:assets:download`, and `figma:capture` when they cover the task.
- First-class commands preserve session target resolution, local file staging, diagnostics, and compact CLI result conventions.
- When a wrapper result includes `guidanceRef`, pass its query to `figma:guidance` for wrapper-specific sequencing and follow-up suggestions.

## Call An Uncovered Official Capability

- Run `figma:upstream:list` for the live compact directory. Run `figma:upstream:read -- <name> --refresh` to read one current description and `inputSchema`. These stateless discovery commands omit `--state-file`, accept `--max-inline-bytes`, and use the plugin-root default `results/` directory for sidecars.
- Use `figma:upstream:call` for official capabilities without a first-class wrapper, such as Code Connect writes, shader reads, or `export_video`.
- The `figma:upstream:call` JSON command exposes `--input`, `--state-file`, and `--max-inline-bytes`; use `npm run figma:raw -- call-upstream-tool --help` for its complete transport JSON schema.
- Provide the official upstream tool name and arguments exactly as required by that tool.
- Treat raw upstream output as transport-owned data. Do not assume it has fields normalized by the local wrappers.
- Use `figma:guidance` or `figma:docs:search` for sequencing, then `figma:api:search` only when local `.figma.ts` Plugin API details are needed.

## Boundaries

- Do not discover or invoke a legacy local MCP server; the CLI is the agent-facing entrypoint.
- Do not read bundled `upstream-corpus` JSONL files directly. They are internal lookup assets.
- Do not use direct upstream calls to bypass local safety checks for script execution or filesystem outputs.
- Keep writes scoped to the selected file and node, and perform visual QA with `figma:capture` plus `view_image` after visible changes.
