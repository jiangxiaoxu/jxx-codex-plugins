# Figma Workspace Safety Reference

Use this reference when diagnostics or guardrails need more context. Runtime diagnostics and tool schemas remain the source of truth for enforcement.

## Diagnostics

- Diagnostics use `{ code, severity, message, suggestion, docsHint }`.
- Fatal diagnostics block upstream execution.
- Warnings return with the tool result.
- Script-file diagnostics may include source locations for repair.

## Guardrails

- Load fonts before mutating text characters or font names.
- Use `$.select` instead of direct `figma.currentPage.selection` mutation.
- Use `figma.setCurrentPageAsync` or `targetPageId`; do not assign `figma.currentPage` directly.
- Avoid `figma.root.findAll`; scope searches to the current page or a known handle.
- Do not use PluginData APIs for agent state. Use local session handles.
- Destructive operations require explicit review and guarded patterns.

## Surfaces

- Use the correct surface: design, figjam, or slides.
- FigJam-only and Slides-only APIs should not be used in Design file scripts.
- When a file URL reveals a surface, pass matching `surface` so preflight diagnostics use the right API surface.
