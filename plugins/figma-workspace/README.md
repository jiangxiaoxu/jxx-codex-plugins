# Figma Workspace

Stateful Node CLI and plugin bundle for file-based Figma automation through the official Figma remote MCP.

The plugin provides:

- independent plugin-root npm command entrypoints for `.figma.ts`, assets, captures, guidance, lookup, and official Figma operations;
- a JSON state file that preserves workspace context across CLI processes;
- a transient HTTP OAuth bridge for initial login and credential repair.

The plugin does not register a local MCP server. The official Figma remote MCP is used internally as the CLI transport.

## NPM Commands

Run from the plugin root. Use `npm.cmd` in Windows PowerShell and `npm` in other shells. Put npm's `--` before arguments passed to an independent npm entrypoint, and run a selected command with `-h` or `--help` before first use. The canonical command CLI and the equivalent independent entrypoint are:

```text
npm.cmd run figma -- api:search createFrame
npm.cmd run figma:api:search -- createFrame
```

- Family entrypoints: `figma:docs`, `figma:api`, `figma:sessions`, and `figma:upstream`.
- Direct query/read commands: `figma:guidance`, `figma:docs:list`, `figma:docs:read`, `figma:docs:search`, `figma:api:search`, `figma:doctor`, `figma:sessions:list`, `figma:sessions:read`, `figma:upstream:list`, `figma:upstream:read`, `figma:inspect`, `figma:metadata`, `figma:design-context`, `figma:motion-context`, `figma:variables`, `figma:design-system`, and `figma:libraries`.
- JSON commands: `figma:open`, `figma:eval`, `figma:script:run`, `figma:assets:apply`, `figma:assets:download`, `figma:capture`, `figma:task:run`, `figma:task:prepare`, and `figma:upstream:call`.

Direct commands accept task-shaped positional arguments and optimized options. JSON commands expose only `--input <json-file|->`, `--state-file <path>`, `--max-inline-bytes <bytes>`, and help. Each public npm command has its own `scripts/commands/*.mjs` executable, and every command entrypoint delegates to the shared typechecked `mcp-server/dist/cli/figma-command-runtime.js` instead of copying business logic.

The 22 transport-level kebab-case JSON commands are available only through `figma:raw` and `figma:raw:help`. Run `npm run figma:raw -- <transport-command> --help` for the complete transport schema.

The plugin-root `package.json` owns these paths. `--state-file` is both the persisted workspace state store and the anchor whose parent owns `results/` sidecars; prefer one explicit absolute path reused by related stateful commands. Guidance, docs, API, doctor, and upstream list/read commands are stateless and omit this option; their sidecars use `<plugin-root>/.figma-workspace/results/`.

All executing commands expose `--max-inline-bytes`. Search commands expose `--limit` and `--snippet-lines`; guidance exposes `--card-limit`. Direct file-context commands expose `--session-id`, `--state-file`, and `--workspace`; design-system additionally supports repeatable `--library`. Sessions read supports `--with-handles` and `--with-history`, and inspect supports repeatable `--handle`.

Typed command results use Restricted Markdown on stdout: a command title, an `Input` section, explicit status, and expanded fields. Complex nested values may use fenced `json` blocks. Typed `ok: false` results use the same Markdown contract and exit with code 1. Usage errors and thrown failures are text on stderr. Do not call `JSON.parse` on stdout. Use the selected command's help for usage text.

Markdown result size defaults to 4096 bytes and is capped at 10000. `--max-inline-bytes` controls it; `0` forces the complete JSON result into the selected state file's sibling `results/`, or the plugin-root default for a stateless command. Oversized Markdown returns `outputFiles.cliResultFile` with path, byte count, and line count plus an omitted-byte summary. Long input values are summarized rather than echoed.

The raw transport command names behind `figma:raw` are:

```text
open                         eval
run-script-file              apply-asset-manifest
download-assets              capture-node
run-task-plan                prepare-task
guidance                     inspect
get-metadata                 get-design-context
get-motion-context           search-design-system
get-libraries                get-variable-defs
call-upstream-tool           lookup
docs                         doctor
sessions                     upstream-tools
```

Example with stdin:

```powershell
'{"file":"https://www.figma.com/design/<fileKey>/<name>"}' |
  npm.cmd run figma:open -- --input - --state-file C:/work/project/figma-workspace/state.json
```

State files contain local Figma workspace state and may reference a sensitive OAuth-backed workflow. Keep them in the project, worktree, or task artifacts and do not commit them by default.

## Agent Workflow

1. Use `figma:docs:list` and `figma:docs:read` for project Markdown; use `figma:sessions:list` or `figma:sessions:read` when resuming state and `figma:doctor` for runtime faults.
2. Call `figma:guidance` for planning, `figma:docs:search` for docs, and `figma:api:search` for Plugin API symbols.
3. Call `figma:task:prepare` with JSON containing a Figma URL or key, slug-style `taskName`, absolute `workspaceDir`, and optional surface.
4. Edit the generated `.figma.ts` using native Figma Plugin API and injected `$` helpers.
5. Call `figma:script:run` with JSON containing `strict: true`; repair preflight diagnostics and rerun.
6. Use `figma:assets:apply`, `figma:assets:download`, `figma:capture`, and `figma:task:run` as needed.
7. Use `figma:upstream:list` or `figma:upstream:read` before `figma:upstream:call`; after generating, editing, or capturing an image, inspect the local output with `view_image`.

Use `figma:metadata` before targeted `figma:inspect` when broad layer structure is needed. Direct context and design-system commands cover common official reads. Use `figma:upstream:call` only for uncovered official capabilities such as `whoami`, file creation, Code Connect writes, shader reads, or `export_video`.

The CLI expands the workspace runtime result into Markdown fields. Parsed official output, non-JSON upstream text, diagnostics, output-file pointers, and capture paths retain their runtime field names where useful; complex nested values may be shown in fenced `json` blocks.

## OAuth Cache And Login

Cache path priority:

```text
FIGMA_WORKSPACE_OAUTH_CACHE_PATH
CODEX_HOME/.figma-workspace-oauth.json
USERPROFILE/.codex/.figma-workspace-oauth.json
```

The cache may contain OAuth client and token secrets. It is ignored by git and must be treated as sensitive.

To print the resolved path:

```powershell
npm run oauth-cache:path
python scripts/resolve-oauth-cache-path.py --json
```

To complete browser OAuth, run from this plugin directory:

```powershell
npm run login:figma-http
```

The helper adds a temporary `figma-http` entry, completes browser OAuth through the local bridge, and removes the temporary entry. Do not install any persistent local MCP server. Repeated runs reuse a valid cache; use `npm run login:figma-http -- --force` only when a fresh authorization is required.

## Local Development

```bash
cd mcp-server
npm install
npm run build
npm test
```

The HTTP bridge defaults to `http://127.0.0.1:18766/mcp` and targets `https://mcp.figma.com/mcp`. Relevant environment variables include `FIGMA_WORKSPACE_OAUTH_CACHE_PATH`, `FIGMA_WORKSPACE_BRIDGE_HOST`, `FIGMA_WORKSPACE_BRIDGE_PORT`, `FIGMA_WORKSPACE_BRIDGE_PATH`, and `FIGMA_WORKSPACE_BRIDGE_TARGET`.
