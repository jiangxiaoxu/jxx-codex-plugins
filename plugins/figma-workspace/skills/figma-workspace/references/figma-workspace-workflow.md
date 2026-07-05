# Figma Workspace Workflow Reference

Use this reference only when `figma-workspace://capabilities` is not enough to choose a workflow. Runtime MCP resources remain the source of truth for public tool contracts.

## Primary File Workflow

- Start non-trivial work with `figma_workspace_prepare_task({ file, taskName, surface })`.
- Edit the generated `.figma.ts` file in the task workspace.
- Run `figma_workspace_run_script_file({ title, sessionId, inputFile, strict: true, surface })`; diagnostics and compiled payload preflight run before upstream execution.
- If preflight diagnostics fail, repair the same file and rerun it.
- Return compact JSON with changed node ids, handles, and validation notes.

## Script Shape

- `.figma.ts` files are async TypeScript script bodies executed in Figma Plugin API context after strict preflight.
- Use native Plugin API for advanced work and `$` helpers for common agent tasks.
- Common helpers include `$.text`, `$.select`, `$.checkpoint`, `$.remember`, `$.forget`, `$.inspect`, `$.imageAsset`, `$.screenshot`, `$.cloneNodeTree`, `$.findFreeSlot`, `$.placeNode`, and `$.replaceGeneratedFrame`. Use native Figma Plugin API for node creation, querying, and auto layout.
- Helper access must be static so runtime injection can be analyzed: use `$.helper(...)`, `$["helper"](...)`, or explicit destructuring; avoid dynamic `$[name]`, aliasing `$`, object rest destructuring, and local `$` declarations.
- Use `figma_workspace_guidance({ query })` for on-demand `helperProfiles` when choosing between selection, text, layout, assets, capture/QA, repair, and clone/rebuild helpers.
- Prefer `$.select` over direct selection mutation.
- Validate stale handles with `figma_workspace_inspect({ mode: "validate" })` before reusing them.

## Workflow Add-ons

- Use `figma_workspace_get_metadata` for broad layer-tree discovery before detailed style, fill, or text inspection. It converts upstream XML to a compact tree and enriches supported lock/layout-state fields with one read-only `use_figma` readback.
- Use `figma_workspace_inspect` only after `figma_workspace_open({ sessionId, file })` or `figma_workspace_prepare_task` has bound file context. Its `target` is string-only: `$selection`, `$currentPage`, a stored handle, raw node id, or node URL string. Do not pass `{ fileKey, nodeId }` to `inspect`.
- Use `figma_workspace_guidance` or `figma-workspace://lookup-index` for wrapper profiles and workflow graph nodes when sequencing design-context, motion, or video wrapper calls.
- Follow wrapper `guidanceRef.query` with `figma_workspace_guidance` when a thin wrapper output needs detailed next-step guidance.
- Use `figma_workspace_search_design_system`, `figma_workspace_get_libraries`, and `figma_workspace_get_variable_defs` for official design-system context. Node-scoped wrappers such as metadata, design context, motion context, export video, and variable defs accept string raw node ids, node URLs, `$handles`, `{ handle:"$hero" }`, and `{ fileKey, nodeId }`; raw node id and handle strings require session file context.
- Use `figma_workspace_apply_asset_manifest` for large local generated image assets. Create target rectangles in the script first, then upload/fill through the manifest.
- Use `figma_workspace_download_assets` for official asset download workflows.
- Use `figma_workspace_capture_node` for final visual QA captures saved as local PNG files. Raw node id or `$handle` string targets require session file context; node URL targets or `target:{ fileKey, nodeId }` can supply file context directly.
- Use `figma_workspace_run_task_plan` only for repeatable multi-step script, asset, download, capture, and upstream-tool workflows.

## Payload And Output Files

- Keep transactions small enough for upstream `use_figma` payload limits.
- Split dense work into skeleton, asset-target, upload-fill, and fix scripts when needed.
- Clean success paths do not write JSON debug files for eval, script, upstream-tool, asset-manifest, or download-assets calls.
- Debug files are generated on demand for failures, diagnostics, and inline omissions under `outputFiles.debugFile`.
