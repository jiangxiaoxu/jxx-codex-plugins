# Figma Workspace

Stateful Node CLI and plugin bundle for file-based Figma automation through the official Figma remote MCP.

The plugin provides:

- independent plugin-root npm command entrypoints for `.figma.ts`, assets, captures, guidance, lookup, and official Figma operations;
- a JSON state file that preserves workspace context across CLI processes;
- a transient HTTP OAuth bridge for initial login and credential repair.

The plugin does not register a local MCP server. The official Figma remote MCP is used internally as the CLI transport.

## NPM Commands

Run from the plugin root. Use `npm --silent` in every shell so npm lifecycle banners do not contaminate Restricted Markdown stdout. Put npm's `--` before arguments passed to an independent npm entrypoint, and run a selected command with `-h` or `--help` before first use. The canonical command CLI and the equivalent independent entrypoint are:

```text
npm --silent run figma -- api:search createFrame --state-file C:/work/project/.figma-workspace/state.json
npm --silent run figma:api:search -- createFrame --state-file C:/work/project/.figma-workspace/state.json
```

- Family entrypoints: `figma:docs`, `figma:api`, `figma:sessions`, and `figma:upstream`.
- The 17 direct query/read commands are `figma:guidance`, `figma:docs:list`, `figma:docs:read`, `figma:docs:search`, `figma:api:search`, `figma:doctor`, `figma:sessions:list`, `figma:sessions:read`, `figma:upstream:list`, `figma:upstream:read`, `figma:inspect`, `figma:metadata`, `figma:design-context`, `figma:motion-context`, `figma:variables`, `figma:design-system`, and `figma:libraries`.
- JSON commands: `figma:open`, `figma:eval`, `figma:script:run`, `figma:assets:apply`, `figma:assets:download`, `figma:capture`, `figma:task:run`, `figma:task:prepare`, and `figma:upstream:call`.

Direct commands accept task-shaped positional arguments and optimized options. Their typed help declares required/default/unset behavior, repeatability, and applicable ranges or enum values. Exact `--` ends option parsing, so later `-h` and `--help` tokens are positional. JSON commands remain option-only and expose only `--input <json-file|->`, `--state-file <path>`, `--max-inline-bytes <bytes>`, and help. Each public npm command has its own `scripts/commands/*.mjs` executable, and every command entrypoint delegates to the shared typechecked `mcp-server/dist/cli/figma-command-runtime.js` instead of copying business logic.

The 22 transport-level kebab-case JSON commands are available only through `figma:raw` and `figma:raw:help`. Run `npm --silent run figma:raw -- <transport-command> --help` for the complete transport schema.

The plugin-root `package.json` owns these paths. Every executing optimized command, including all 17 direct commands and all 9 JSON commands, requires an explicit fully qualified absolute `--state-file`. It is both the persisted workspace state store and the anchor whose parent owns `results/` sidecars; reuse one path across related commands. Guidance, docs, API, doctor, and upstream list/read do not require existing Figma file context, but they still require this option. At the raw transport layer, pass a fully qualified absolute `--session-file` or set fully qualified absolute `FIGMA_WORKSPACE_SESSION_FILE`; there is no current-directory default, and relative or current-drive-rooted paths are rejected.

All executing commands expose `--max-inline-bytes`. Search commands expose `--limit` and `--snippet-lines`; `figma:docs:search` also exposes `--scope active|conditional|examples|all`, defaulting to `active`; guidance exposes `--card-limit` and uses the `active` canonical scope. File-binding commands expose `--session-id`, `--state-file`, and `--workspace`; design-system additionally supports repeatable `--library`. Sessions read supports `--with-handles` and `--with-history`. `figma:inspect` reuses file context already bound to its session, intentionally omits `--workspace` and `--file`, and supports repeatable `--handle`; initialize context with `figma:open` or a file-binding read command first.

Typed command results use Restricted Markdown on stdout: a command title, an `Input` section, explicit status, and expanded fields. Complex nested values may use fenced `json` blocks. CLI presentation does not rewrite the backend result or complete sidecar. An unhealthy doctor observation uses `Status: observed unhealthy` and exits 0; every other top-level `ok: false` result exits 1. Usage errors exit 2, typed interrupts exit 130, and thrown failures use stderr. Do not call `JSON.parse` on stdout. Use the selected command's help for usage text.

Markdown result size defaults to 4096 bytes and is capped at 10000. `--max-inline-bytes` controls it; `0` forces the complete JSON result into the selected state file's sibling `results/`. Oversized Markdown returns `outputFiles.cliResultFile` with path, byte count, and line count plus an omitted-byte summary. Long input values are summarized rather than echoed.

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
  npm --silent run figma:open -- --input - --state-file C:/work/project/.figma-workspace/state.json
```

State files and result sidecars may contain sensitive Figma workspace content or references to an OAuth-backed workflow. Prefer a Git-ignored project-local `.figma-workspace/`; otherwise use an explicitly selected Figma task-artifact directory. Do not treat capability-specific output roots as generic task storage, and do not commit state or sidecars by default. Sidecars are retained for result recovery and are removed manually by the user or owning workflow; the CLI does not delete them automatically. Session locks coordinate same-machine processes on a local filesystem and do not provide distributed, network-filesystem, or shared-volume safety.

## Agent Workflow

1. Choose one fully qualified absolute `--state-file` and pass it to every executing optimized command. Use `figma:docs:list` and `figma:docs:read` for project Markdown; use `figma:sessions:list` or `figma:sessions:read` when resuming state and `figma:doctor` for runtime faults.
2. Call `figma:guidance` for planning guidance, `figma:docs:search` for docs, and `figma:api:search` for Plugin API symbols. Use `docs:search --scope conditional` only deliberately; `--scope examples` and `--scope all` include plugin-owned TypeScript-in-Markdown templates, while router records appear only in `all`. These commands need no existing Figma file context, but still require the selected state file.

3. Call `figma:task:prepare` with JSON containing a Figma URL or key, slug-style `taskName`, absolute `workspaceDir`, and optional surface.
4. Edit the generated `.figma.ts` using native Figma Plugin API and injected `$` helpers.
5. Call `figma:script:run` with JSON containing `strict: true`; repair preflight diagnostics and rerun.
6. Use `figma:assets:apply`, `figma:assets:download`, `figma:capture`, and `figma:task:run` as needed.
7. Use `figma:upstream:list` or `figma:upstream:read` before `figma:upstream:call`; after generating, editing, or capturing an image, inspect the local output with `view_image`.

Use `figma:metadata` before targeted `figma:inspect` when broad layer structure is needed. Direct context and design-system commands cover common official reads. Use `figma:upstream:call` only for uncovered official capabilities such as `whoami`, file creation, Code Connect writes, shader reads, or `export_video`.

The CLI expands the workspace runtime result into Markdown fields. Parsed official output, non-JSON upstream text, diagnostics, output-file pointers, and capture paths retain their runtime field names where useful; complex nested values may be shown in fenced `json` blocks.

## Canonical Runtime References

Runtime workflow lookup reads only the bundled, plugin-owned `skills/figma-workspace/references/canonical-corpus/`. Its 87 records comprise 46 `active`, 20 `conditional`, 12 `router`, and 9 `examples` records; examples are plugin-owned TypeScript-in-Markdown templates. Upstream source text is not packaged or read at runtime. `figma:api:search` instead reads a plugin-owned symbol index generated from bundled `@figma/plugin-typings`.

For maintainers, `dev/upstream-snapshot/` holds the complete source snapshot and `dev/upstream-changes/` holds its drift report. Neither directory is packaged or copied to `mcp-server/dist/`. `npm run update:upstream-snapshot -- --ref <git-ref>` updates only those development artifacts and never publishes canonical content; `npm run build:canonical-corpus` builds the runtime corpus only from plugin-owned mirrors and policy. `figma:doctor` diagnoses the canonical corpus, generated API index, project docs, and TypeScript assets; upstream drift remains a maintenance-command responsibility.

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
