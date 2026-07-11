# Figma Workspace Safety Reference

Use this reference when diagnostics or guardrails need more context. Runtime diagnostics and tool schemas remain the source of truth for enforcement.

Before executing a command, read its help and use only the optimized flags it exposes. Do not infer transport CLI options on a command; use `npm run figma:raw -- <transport-command> --help` only when the complete transport JSON schema is required.

## Diagnostics

- Diagnostics use `{ code, severity, message, suggestion, docsHint }`.
- Fatal diagnostics block upstream execution.
- Warnings return with the tool result.
- Script-file diagnostics may include source locations for repair.

## Guardrails

- Load fonts before mutating text characters or font names.
- Convert typography sizes when translating from 96 DPI game-engine UI systems such as UE5/UMG/Slate to Figma's 72 DPI text sizing: `figmaSize = engineSize * 72 / 96`; convert back with `engineSize = figmaSize * 96 / 72`.
- Use `$.select` instead of direct `figma.currentPage.selection` mutation.
- Use `figma.setCurrentPageAsync` or `targetPageId`; do not assign `figma.currentPage` directly.
- Avoid `figma.root.findAll`; scope searches to the current page or a known handle.
- Do not use PluginData APIs for agent state. Use local session handles.
- Place visible audit markers or temporary verification labels outside the inspected frame or in a confirmed free slot; do not cover primary controls, text, or content that a capture must validate.
- Destructive operations require explicit review and guarded patterns.
- Keep mutation commands on one explicit `--state-file` and `--session-id` so file context cannot silently drift between logical sessions.

## Surfaces

- Use the correct surface: design, figjam, or slides.
- FigJam-only and Slides-only APIs should not be used in Design file scripts.
- When a file URL reveals a surface, pass matching `surface` so preflight diagnostics use the right API surface.
