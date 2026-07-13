# Figma Workspace CLI Package

Node package behind the `figma-workspace` agent CLI. It provides stateful local `.figma.ts` workflows while using the official Figma remote MCP only as an internal transport.

## Build And Run

```bash
npm install
npm run build
```

The installed plugin exposes this package through independent plugin-root npm command entrypoints. Use `npm.cmd --silent` in Windows PowerShell and `npm --silent` in other shells so lifecycle banners do not contaminate Restricted Markdown stdout, put npm's `--` before arguments passed to an independent entrypoint, and run a selected command with `-h` or `--help` before first use. The canonical command CLI and the equivalent independent entrypoint are:

```text
npm.cmd --silent run figma -- api:search createFrame
npm.cmd --silent run figma:api:search -- createFrame
```

Family entrypoints are `figma:docs`, `figma:api`, `figma:sessions`, and `figma:upstream`. Direct query/read commands are `figma:guidance`, `figma:docs:list`, `figma:docs:read`, `figma:docs:search`, `figma:api:search`, `figma:doctor`, `figma:sessions:list`, `figma:sessions:read`, `figma:upstream:list`, `figma:upstream:read`, `figma:inspect`, `figma:metadata`, `figma:design-context`, `figma:motion-context`, `figma:variables`, `figma:design-system`, and `figma:libraries`.

JSON commands are `figma:open`, `figma:eval`, `figma:script:run`, `figma:assets:apply`, `figma:assets:download`, `figma:capture`, `figma:task:run`, `figma:task:prepare`, and `figma:upstream:call`. They expose only `--input <json-file|->`, `--state-file <path>`, `--max-inline-bytes <bytes>`, and help. Each public npm command has an independent `scripts/commands/*.mjs` executable that delegates to the shared typechecked `dist/cli/figma-command-runtime.js`; business behavior remains in that runtime.

The 22 transport-level JSON commands are available only through `figma:raw` and `figma:raw:help`. Run `npm --silent run figma:raw -- <transport-command> --help` for a complete transport schema.

The CLI has exactly 22 kebab-case commands: `open`, `eval`, `run-script-file`, `apply-asset-manifest`, `download-assets`, `capture-node`, `run-task-plan`, `prepare-task`, `guidance`, `inspect`, `get-metadata`, `get-design-context`, `get-motion-context`, `search-design-system`, `get-libraries`, `get-variable-defs`, `call-upstream-tool`, `lookup`, `docs`, `doctor`, `sessions`, and `upstream-tools`.

`--state-file` selects the persisted workspace state store and anchors its sibling `results/` directory. Sessions and direct file-context commands expose it; direct file-context commands also expose `--session-id`. Guidance, docs, API, doctor, and upstream list/read omit it and use `<plugin-root>/.figma-workspace/results/` for sidecars. All executing commands expose `--max-inline-bytes`; search uses `--limit` and `--snippet-lines`, guidance uses `--card-limit`, and file-binding commands use `--workspace`. Design-system uses repeatable `--library`, and sessions read uses `--with-handles` and `--with-history`. Inspect reuses context already bound to the session, omits `--workspace` and `--file`, and supports repeatable `--handle`.

At the transport CLI, `--input` accepts a JSON file or `-` for stdin and defaults to `{}`. Transport state path priority is explicit `--session-file`, `FIGMA_WORKSPACE_SESSION_FILE`, then `<cwd>/.figma-workspace/session.json`; relative explicit and environment paths resolve from the current directory. `figma:raw:help` and `figma:raw -- <transport-command> --help` write the complete transport usage and schema.

This package is not installed as a Codex MCP server and does not expose local MCP tools or resources. Legacy `figma_workspace_*` names remain implementation operation identifiers where needed, but they are not the agent invocation contract.

## Workspace File Workflow

`run-script-file` is the primary path for non-trivial Plugin API work. Prepare one workspace per Figma file and reuse one command state file:

```json
{
  "sessionId": "settings-workspace",
  "file": "https://www.figma.com/design/ExampleFigmaFileKey012/UI",
  "taskName": "settings-panel-polish",
  "workspaceDir": "C:/work/project/figma-workspace",
  "overwrite": true
}
```

`prepare-task` creates `<workspaceDir>/<fileKey-or-fileSlug>/<taskName>.figma.ts`. The supplied `workspaceDir` is used directly. `run-script-file` strict-checks TypeScript with Figma Plugin API typings, compiles the upstream payload, and reports diagnostics before remote execution.

Scripts are ordinary async TypeScript bodies. Use native Figma Plugin API for creation, queries, and layout, with `$` helpers for handles, font-safe text, checkpoints, inspection, assets, placement, guarded replacement, and cloning. Keep transactions small and return compact JSON containing changed ids, handles, and validation notes.

## Assets, Capture, Plans, And Lookup

- `apply-asset-manifest` places larger local generated assets and validates target IMAGE fills when available.
- `download-assets` exports official assets into the requested output directory.
- `capture-node` writes a PNG to `imageFile`. Agents must inspect generated or edited images with `view_image`.
- `run-task-plan` executes repeatable script, asset, download, capture, and upstream-tool steps.
- `guidance` returns compact workflow cards, helper profiles, guardrails, query hints, and API symbols.
- `lookup` returns capped docs or Plugin API snippets; bundled JSONL corpus is internal data, not an agent-facing documentation path.

Use `get-metadata` for broad tree discovery before `inspect`. Context, motion, library, variable, and design-system commands are first-class official wrappers. `call-upstream-tool` is the escape hatch for uncovered official capabilities such as Code Connect writes, shader reads, and `export_video`.

## Result And Session State

Typed CLI results are Restricted Markdown on stdout. Each document contains a command title, an `Input` section, explicit status, and expanded result fields. Simple fields are rendered directly; complex nested values may use fenced `json` blocks. Runtime names such as `upstream`, `diagnostics`, `outputFiles.debugFile`, and `imageFile` remain visible where useful.

Presentation classification leaves backend and complete sidecar results unchanged. An unhealthy doctor result renders `Status: observed unhealthy` and exits 0; every other top-level `ok: false` result renders failure and exits 1. Usage errors exit 2, typed `AbortError`, `ABORT_ERR`, and `ERR_CANCELED` interrupts exit 130, and input, transport, I/O, or unexpected errors use stderr and a non-zero exit. Stdout is not a JSON document and must not be passed to `JSON.parse`.

`--max-inline-bytes` accepts 0 through 10000 bytes and defaults to 4096. A complete result above the threshold is written through a sibling temporary file and atomic rename under the selected state file's sibling `results/`, or the plugin-root default for stateless commands; Markdown returns only `outputFiles.cliResultFile` and the omitted-byte metadata. A limit of 0 always writes the sidecar. Sidecars may contain sensitive Figma content, remain available for recovery, and are cleaned up manually rather than automatically. The transport runtime names the corresponding control `--inline-result-limit`. Long input values are summarized in the `Input` line.

The state file replaces process-local MCP resource state. Prefer an absolute command-level `--state-file`, reuse it for a workflow, and do not commit it by default. Use the sessions commands rather than parsing its JSON directly. Its lock coordinates same-machine processes on a local filesystem using process identity and PID liveness; it is not a distributed lock and does not guarantee safety across hosts, network filesystems, or shared volumes.

## Authentication

The CLI reuses the OAuth cache created by the plugin login helper. Cache path priority is `FIGMA_WORKSPACE_OAUTH_CACHE_PATH`, `CODEX_HOME/.figma-workspace-oauth.json`, then `USERPROFILE/.codex/.figma-workspace-oauth.json`. The cache must already contain valid OAuth state before live official calls.

## Validation

```bash
npm run typecheck
npm test
```

`npm test` builds generated output and runs the Node test suite. Live upstream contract checks are separate and may require OAuth, network access, and upstream availability:

```bash
npm run upstream:contract:check
npm run upstream:contract:refresh
```
