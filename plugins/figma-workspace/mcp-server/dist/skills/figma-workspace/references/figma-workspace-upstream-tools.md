# Figma Workspace Upstream Tools

Use this reference to decide between a first-class CLI command and direct official Figma remote MCP delegation.

## Prefer First-Class Commands

- Use `figma:design-context`, `figma:motion-context`, `figma:metadata`, `figma:design-system`, `figma:libraries`, `figma:variables`, `figma:assets:download`, and `figma:capture` when they cover the task.
- First-class commands preserve session target resolution, local file staging, diagnostics, and compact CLI result conventions.
- When a wrapper result includes `guidanceRef`, pass its query to `figma:guidance` for wrapper-specific sequencing and follow-up suggestions.

## Call An Uncovered Official Capability

- Run `figma:upstream:list -- --state-file <absolute-path>` for the live compact directory. Run `figma:upstream:read -- <name> --refresh --state-file <absolute-path>` to read one current description and `inputSchema`. These discovery commands need no existing Figma file context, but every execution requires the state file; sidecars belong to its sibling `results/` directory.
- Use `figma:upstream:call` for official capabilities without a first-class wrapper, such as Code Connect writes, shader reads, or `export_video`.
- The `figma:upstream:call` JSON command exposes `--input`, `--state-file`, and `--max-inline-bytes`; use `npm --silent run figma:raw -- call-upstream-tool --help` for its complete transport JSON schema.
- Provide the official upstream tool name and arguments exactly as required by that tool.
- Treat raw upstream output as transport-owned data. Do not assume it has fields normalized by the local wrappers.
- Use `figma:guidance` or `figma:docs:search` for sequencing, then `figma:api:search` only when local `.figma.ts` Plugin API details are needed.

## Boundaries

- Do not discover or invoke a legacy local MCP server; the CLI is the agent-facing entrypoint.
- Do not read bundled `canonical-corpus` or generated Plugin API index files directly. They are internal runtime lookup assets. The development source snapshot is not packaged or available to runtime lookup.
- Do not use direct upstream calls to bypass local safety checks for script execution or filesystem outputs.
- Keep writes scoped to the selected file and node, and perform visual QA with `figma:capture` plus `view_image` after visible changes.
