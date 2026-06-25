# Figma REPL Workflow Reference

Use this reference only when `figma-repl://capabilities` is not enough to choose a workflow. Runtime MCP resources remain the source of truth for public tool contracts.

## Primary File Workflow

- Start non-trivial work with `figma_repl_prepare_task({ title, file, task, surface })`.
- Edit the generated `.figma.js` file in the task workspace.
- Run `figma_repl_run_script_file({ title, sessionId, inputFile, strict: true, surface })`; diagnostics and compiled payload preflight run before upstream execution.
- If preflight diagnostics fail, repair the same file and rerun it.
- Return compact JSON with changed node ids, handles, and validation notes.

## Script Shape

- `.figma.js` files are async function bodies executed in Figma Plugin API context.
- Use native Plugin API for advanced work and `$` helpers for common agent tasks.
- Common helpers include `$.find`, `$.findAll`, `$.create`, `$.text`, `$.layout`, `$.select`, `$.checkpoint`, `$.remember`, `$.forget`, `$.inspect`, `$.imageAsset`, `$.screenshot`, and `$.cloneNodeTree`.
- Prefer `$.select` over direct selection mutation.
- Validate stale handles with `figma_repl_inspect({ mode: "validate" })` before reusing them.

## Workflow Add-ons

- Use `figma_repl_get_metadata` for broad layer-tree discovery before detailed style, fill, or text inspection.
- Use `figma_repl_search_design_system`, `figma_repl_get_libraries`, and `figma_repl_get_variable_defs` for official design-system context. `get_variable_defs.target` accepts a raw node id, node URL, or local handle.
- Use `figma_repl_apply_asset_manifest` for large local generated image assets. Create target rectangles in the script first, then upload/fill through the manifest.
- Use `figma_repl_download_assets` for official asset download workflows.
- Use `figma_repl_capture_node` for final visual QA captures saved as local PNG files.
- Use `figma_repl_run_task_plan` only for repeatable multi-step script, asset, download, capture, and upstream-tool workflows.

## Payload And Output Files

- Keep transactions small enough for upstream `use_figma` payload limits.
- Split dense work into skeleton, asset-target, upload-fill, and fix scripts when needed.
- Clean success paths do not write JSON debug files for eval, script, upstream-tool, asset-manifest, or download-assets calls.
- Debug files are generated on demand for failures, diagnostics, and inline omissions under `outputFiles.debugFile`.
