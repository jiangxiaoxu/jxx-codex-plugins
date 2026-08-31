# Figma Workspace Upstream Tools

Use this reference for an official Figma capability whose live schema is the required contract. This is the only public schema-first fallback.

## Prefer The CLI Surface

- Prefer `figma:design-context`, `figma:motion-context`, `figma:metadata`, `figma:design-system`, `figma:libraries`, `figma:variables`, `figma:assets:download`, and `figma:capture` when they cover the task.
- Each wrapper receives only the target and output paths its own schema requires in the current invocation. It does not inherit file context or local staging from another command.

## Delegate Deliberately

- Run `figma:upstream:list` for the complete live directory, then `figma:upstream:read` for the selected official description, input schema, and output schema. A local `coverage` hint can name a first-class command, but never blocks a direct call.
- `figma:upstream:call` may invoke any listed official capability, including one with first-class coverage. Prefer the typed command when its safeguards meet the need; choose the direct path when the live schema must be used. Read public help and the selected live schema, then provide the selected name and arguments exactly as required.
- `figma:upstream:list` and `figma:upstream:read` are targetless. When a selected live schema requires `fileKey` or `nodeId`, provide that explicit target; otherwise do not invent one. The directory follows cursor pages under one five-minute deadline, reads at most 100 pages, and fails without a partial result on a cursor cycle, conflicting identity, page limit, or fetch failure.
- If the selected description marks an action as destructive, an external workflow, credit/cost-bearing, or an asset upload, explain that impact and obtain explicit user confirmation before `figma:upstream:call`. Weave capabilities remain available only through this escape hatch, not as new first-class commands.
- Keep writes scoped to an explicit file or node when the selected schema accepts one, then use capture and `view_image` for visible changes.

## Do Not Bypass Boundaries

- Do not discover a legacy local MCP server or read bundled corpus and generated index files directly.
- A direct `use_figma` call does not use `figma:run` TypeScript preflight, private PluginData checks, typed argument validation, or typed recovery presentation. Use it only when the live schema is needed. Within the response budget, preserve its sanitized result sidecar; an over-budget response returns a bounded resource-limit diagnostic without persisting its payload.
- An official `isError: true` result is a failed call with `FIGMA_UPSTREAM_TOOL_ERROR`; do not treat its text or structured payload as a successful operation.
- A directly returned `use_figma` script error is `failed_atomic` and can be repaired and retried. A direct non-`use_figma` error after dispatch is `outcome_unknown`; timeout, cancellation, response loss, or truncation are also `outcome_unknown`. Inspect and reconcile before another mutation. A missing response does not prove that Figma did not apply it.
- Direct results within the response budget write a sanitized visible-protocol sidecar. It preserves `content`, `structuredContent`, `isError`, and standard ContentBlock `annotations`; it strips protocol `_meta`, never exposes tool-definition annotations, and leaves a business `_meta` inside `structuredContent` unchanged. An over-budget response does not write a payload sidecar and instead returns a bounded resource-limit diagnostic. Restricted Markdown shows only non-text content summaries and never binary, blob, or base64 payloads.
