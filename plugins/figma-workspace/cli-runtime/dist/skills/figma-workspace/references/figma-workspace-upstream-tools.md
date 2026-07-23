# Figma Workspace Upstream Tools

Use this reference when no first-class CLI command covers an official Figma capability. This is the only public capability fallback.

## Prefer The CLI Surface

- Prefer `figma:design-context`, `figma:motion-context`, `figma:metadata`, `figma:design-system`, `figma:libraries`, `figma:variables`, `figma:assets:download`, and `figma:capture` when they cover the task.
- Each wrapper receives its Figma target and output paths in the current invocation. It does not inherit file context or local staging from another command.

## Delegate Deliberately

- Run `figma:upstream:list` for the live directory, then `figma:upstream:read` for the selected official description and input schema.
- Use `figma:upstream:call` only for uncovered official capabilities such as Code Connect writes, shader reads, or `export_video`. Read its public help and provide the upstream name and arguments exactly as required.
- When the live schema requires `fileKey` or `nodeId`, provide an explicit target in that call. Treat upstream output as transport-owned data; do not assume wrapper-normalized fields.
- Keep writes scoped to the selected file and node, then use capture and `view_image` for visible changes.

## Do Not Bypass Boundaries

- Do not discover a legacy local MCP server or read bundled corpus and generated index files directly.
- Do not use direct upstream calls to bypass script execution or filesystem safety checks.
- After timeout, cancellation, or transport loss, inspect and reconcile an upstream mutation before another attempt. A missing response does not prove that Figma did not apply it.
