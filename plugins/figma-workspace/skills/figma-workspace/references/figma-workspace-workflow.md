# Figma Workspace Workflow Reference

Use this reference when root CLI help is not enough to choose a workflow. Command-specific help and runtime schemas remain the source of truth for public input contracts.

## Primary File Workflow

- Start non-trivial work with `figma:task:prepare -- --input <json-file|-> --state-file <absolute-path>` using JSON fields such as `file`, `taskName`, `workspaceDir`, and `surface`.
- Edit the generated `.figma.ts` file in the task workspace.
- Run `figma:script:run -- --input <json-file|-> --state-file <absolute-path>` with `sessionId`, `inputFile`, `strict: true`, and `surface`; diagnostics and compiled payload preflight run before upstream execution.
- If preflight diagnostics fail, repair the same file and rerun it.
- Return a compact JSON value from the `.figma.ts` script with changed node ids and validation notes. The CLI renders that runtime value into its Restricted Markdown result; CLI stdout itself is not JSON.

## Script Shape

- `.figma.ts` files are async TypeScript script bodies executed in Figma Plugin API context after strict preflight.
- Use native Plugin API for all editing, node traversal, selection, layout, assets, cloning, and advanced work. `$` is a frozen, non-callable namespace with only `$.text` and `$.capture`.
- Use `await $.text({ target?, parent?, text, font? })` for font-safe text creation or replacement. `target` and `parent` accept a real node or raw node ID and are mutually exclusive. With no `target`, the helper creates a TextNode. An explicit font is loaded before mutation; a mixed-font target without an explicit font fails closed.
- Use `figma:guidance -- <query> --state-file <absolute-path>` for task routing, workflow profiles, and Plugin API lookup hints.
- There is no helper-selection analysis or semantic AST policy. Valid Plugin API operations are forwarded after TypeScript preflight; use direct Plugin API calls when they express the intended edit.

## Workflow Add-ons

- Use `figma:metadata` for broad layer-tree discovery before detailed style, fill, or text inspection. File-binding commands accept `--session-id`, `--state-file`, `--workspace`, and `--max-inline-bytes`; node-scoped file-binding commands also accept `--file` when explicit file context is preferable. `figma:inspect` is the exception: it accepts session/state options but reuses the session's existing file context and omits `--workspace` and `--file`.
- Use `figma:inspect` only after `figma:open` or `figma:task:prepare` has bound file context. Its positional target is string-only: `$selection`, `$currentPage`, a raw node id, or node URL string. It supports inspection and style reads, not handle validation.
- Use `figma:guidance` for wrapper profiles and workflow graph nodes when sequencing design-context, motion, or video calls.
- Follow wrapper `guidanceRef.query` with `figma:guidance` when a thin wrapper output needs detailed next-step guidance.
- Use `figma:design-system`, `figma:libraries`, and `figma:variables` for official design-system context. Repeat `--library <key>` to scope design-system search. Variable defs intentionally does not accept client hints; use design context for client-specific output. Node-scoped commands accept raw node ids, node URLs, or structured `{ fileKey, nodeId }` targets where supported.
- Use `figma:assets:apply` for large local generated image assets. Create target rectangles in the script first, then upload/fill through the manifest.
- Use `figma:assets:download` for official asset download workflows.
- Use `figma:capture` for final visual QA captures saved as local PNG files. Use its command help for screenshot tuning; use `figma:upstream:call` for uncovered official screenshot parameters.
- When the target is created or resolved inside a `.figma.ts` script, call `await $.capture(target, { imageFile?, maxDimension?, contentsOnly? })`. `imageFile`, when supplied, must be a safe workspace-relative path. The helper queues at most 8 host-side captures; after the script succeeds, the CLI runs the same capture implementation and returns local paths under `captures[]`. The helper's ticket does not contain image bytes or an in-script file path.
- A queued capture failure sets `scriptExecutionSucceeded: true` and `captureProcessingSucceeded: false` with explicit `retryGuidance`. The script may already have changed Figma; do not rerun it just to recover the image. Retry the affected node with standalone `figma:capture`.
- Do not use inline screenshot methods. When a script genuinely needs PNG, JPG, SVG, PDF, or other export bytes/string for data processing, use native `exportAsync()` for that script-local purpose; do not return large raw export data in the script JSON result.
- Use `figma:task:run` only for repeatable multi-step script, asset, download, capture, and upstream-tool workflows.

## Payload And Output Files

- Keep transactions small enough for upstream `use_figma` payload limits.
- Split dense work into skeleton, asset-target, upload-fill, and fix scripts when needed.
- Clean success paths do not write JSON debug files for eval, script, upstream-tool, asset-manifest, or download-assets calls.
- Debug files are generated on demand for failures, diagnostics, and inline omissions under `outputFiles.debugFile`.

## Reading CLI Results

- Typed results on stdout use Restricted Markdown with a command title, `Input`, explicit status, and expanded fields. Complex nested values may appear in fenced `json` blocks.
- Presentation classification preserves the backend result and complete sidecar. An unhealthy doctor observation uses `Status: observed unhealthy` and exits 0; every other top-level `ok: false` result retains the Markdown shape and exits 1. Usage exits 2 and typed interrupts exit 130.
- Usage errors and thrown failures are text on stderr.
- Do not pass stdout to `JSON.parse`; read Markdown fields and parse only a fenced `json` value when the workflow specifically needs that nested value.
- JSON commands intentionally expose only `--input`, `--state-file`, `--max-inline-bytes`, and help. Run `npm --silent run figma:raw -- <transport-command> --help` when the complete transport JSON schema is needed.
- Every executing optimized command requires an explicit absolute `--state-file`; its parent owns any `results/` sidecars. Commands that need no existing Figma file context still follow this requirement.
