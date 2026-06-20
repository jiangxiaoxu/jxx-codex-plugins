# Figma MCP Stdio Frontend

Stdio MCP frontend for the official Figma remote MCP endpoint:

```text
https://mcp.figma.com/mcp
```

This package reuses the OAuth cache created by `figma-mcp-bridge` and exposes Figma's remote MCP tools over stdio. It is useful for MCP clients that support stdio servers but do not need the local HTTP OAuth bridge running after the cache has been created.

## Install

```bash
npm install
npm run build
```

## Codex Stdio MCP Config

```json
{
  "mcpServers": {
    "figma-stdio": {
      "command": "node",
      "args": [
        "G:/Project/jxx-codex-plugins/plugins/figma-mcp-bridge/stdio-mcp/dist/stdio-cli.js"
      ]
    }
  }
}
```

The stdio server defaults to:

```text
endpoint: https://mcp.figma.com/mcp
cache:    FIGMA_MCP_OAUTH_CACHE_PATH when set,
          otherwise CODEX_HOME/.figma-mcp-bridge-oauth.json when CODEX_HOME is set,
          otherwise USERPROFILE/.codex/.figma-mcp-bridge-oauth.json
browser:  disabled
```

`FIGMA_MCP_OAUTH_CACHE_PATH`, `CODEX_HOME`, and `USERPROFILE` are environment variables. In PowerShell, set explicit values with `$env:FIGMA_MCP_OAUTH_CACHE_PATH` or `$env:CODEX_HOME`.

The shared cache must already contain valid `clientInformation`, `access_token`, and `refresh_token`. The HTTP bridge can create that cache through Codex's OAuth flow. After that, this stdio frontend can refresh and update the same JSON file.

## Package API

```ts
import { createFigmaStdioMcpServer } from "@jxx-codex-plugins/figma-mcp-stdio";
import {
  createFigmaReplClient,
  diagnoseFigmaReplCode,
} from "@jxx-codex-plugins/figma-mcp-stdio/repl";
```

The package root is the API entry and does not own the process lifecycle. The CLI run-loop entry is `@jxx-codex-plugins/figma-mcp-stdio/cli` and is used by the `figma-mcp-stdio-bridge` bin.

For Node REPL workflows, pass an absolute bridge OAuth cache file path:

```js
const { createFigmaReplClient } = await import("./dist/repl-server.js");
const figma = createFigmaReplClient({
  oauthCachePath: "C:/Users/you/.codex/.figma-mcp-bridge-oauth.json",
});
await figma.open({
  fileUrl: "https://www.figma.com/design/<fileKey>/<fileName>?node-id=<nodeId>",
  expectedSurface: "design",
});
await figma.eval({
  mode: "read",
  code: "return { page: figma.currentPage.name };",
});
await figma.runScriptFile({
  scriptPath: "C:/work/figma-scripts/build-settings-card.js",
  dryRun: true,
  strict: true,
  expectedSurface: "design",
});
await figma.close();
```

`oauthCachePath` is a Node API alias for the underlying OAuth state path and must be absolute. CLI/MCP usage can also select the same file with `FIGMA_MCP_OAUTH_CACHE_PATH`.

`figma_repl_run_script_file` is the primary workflow for non-trivial Plugin API work. Prefer initializing a per-task workspace first, then use file names instead of absolute paths:

```js
await figma.initWorkspace({
  sessionId: "settings workspace",
  fileUrl: "https://www.figma.com/design/ExampleFigmaFileKey012/UI",
  intent: "settings panel polish",
  cwd: "G:/Project/my-app",
});
await figma.prepareTask({
  sessionId: "settings workspace",
  intent: "settings panel polish",
  goal: "Update the settings panel",
  overwrite: true,
});
await figma.runScriptFile({
  sessionId: "settings workspace",
  inputFile: "settings-panel-polish.figma.js",
  dryRun: true,
  strict: true,
});
```

`figma_repl_init_workspace` creates one file-context folder: `<cwd>/figma-mcp/<fileKey-or-fileSlug>/`. The file context prefers an explicit or URL-derived `fileKey`; if no key is available it falls back to a safe file slug. The default input/output pair is `<intentSlug>.figma.js` and `<intentSlug>.result.json` in that folder, where `intentSlug` is derived from `intent`, `task`, `title`, then `sessionId`. Absolute `scriptPath`, `outputDir`, and `resultFile` still work as escape hatches.

Keep each `.figma.js` transaction small enough for upstream `use_figma` payload limits. For dense screens, split work into multiple intent scripts such as skeleton, asset targets, upload fills, and visual fixes. `dryRun`/`strict` reports `FIGMA_REPL_SCRIPT_PAYLOAD_TOO_LARGE` before calling upstream when the compiled payload is too large.

`helperProfile` defaults to `auto`. Common helpers are always available, while heavier `$.imageAsset` and `$.cloneNodeTree` helpers are injected only when the script source uses them; use `helperProfile: "full"` when debugging old scripts that expect the full helper block.

For image-gen-to-Figma work, keep large generated PNG/JPEG files out of `.figma.js` payloads. Create named target rectangles in script, then call `figma_repl_apply_asset_manifest` with inline `assets` or `manifestPath`. After `figma_repl_init_workspace`, `manifestPath`, asset `path`, `resultFile`, and `outputFile` can be simple file names inside the file-context folder; absolute paths remain valid escape hatches. Each asset entry supports `path`/`filePath`/`localPath`, `targetNodeId`/`nodeId`, optional `name`/`metadata`, and per-asset `toolName`/`arguments`; top-level `toolName` and `argumentsTemplate` provide defaults. Use templates such as `{{path}}`, `{{targetNodeId}}`, `{{name}}`, and `{{metadata.role}}` to match the actual upstream or fake upload schema. When upstream eval is available, `validateTargets` defaults on and verifies that target nodes have image fills after upload. The REPL will not assume a fixed official asset upload schema when the upstream tool schema is not recognizable.

Use `figma_repl_capture_node` for final visual QA. It calls a configurable upstream screenshot/capture tool, writes image bytes, downloaded screenshot URL payloads, or text responses to `outputFile`, and returns only compact file metadata. After workspace initialization, `outputFile` and optional `resultFile` can be simple file names in the file-context folder; absolute paths remain valid. Capture metadata includes kind, MIME type, byte size, width/height when detectable, source URL when downloaded, and simple QA warnings for empty, text, tiny, or dimensionless captures. Inline `$.screenshot(target)` remains opportunistic because upstream runtimes may not return image bytes through script results.

Use `figma_repl_run_task_plan` when the task has a repeatable local plan. JSON plans can run sequential `script-file`, `asset-manifest`, `screenshot-capture`, and `upstream-tool` steps, stop on the first failure by default, write a compact result JSON, and return per-step statuses. In an initialized workspace, plan-level and step-level `planPath`, `manifestPath`, `resultFile`, and `outputFile` accept either absolute paths or file names inside the file-context folder. Missing step outputs default to `<step-id>.result.json`, `<step-id>.assets.result.json`, and `<step-id>.png` plus `<step-id>.capture.result.json`.

Script files can use the injected `$` helper directly:

```js
await $.create({
  type: "FRAME",
  as: "$section",
  name: "Settings section",
  size: { width: 360, height: 160 },
  layout: { layoutMode: "VERTICAL", itemSpacing: 12 },
  appearance: { fills: "#FFFFFF", cornerRadius: 12 },
});
await $.text({
  parent: "$section",
  as: "$sectionTitle",
  text: "Settings",
  font: { family: "Inter", style: "Bold", size: 20 },
});
return await $.checkpoint("section-created", ["$section"], { depth: 1 });
```

`$` resolves handles and node ids. Helper methods include `$.find`, `$.findAll`, `$.text`, `$.layout`, `$.create`, `$.imageAsset`, `$.screenshot`, `$.select`, `$.cloneNodeTree`, `$.checkpoint`, `$.remember`, `$.forget`, and `$.inspect`. Use `$.imageAsset({ base64, parent, size, position, as })` to turn small generated PNG/JPEG assets into Figma image-fill rectangles from local script data. For large generated assets, create target rectangles in `.figma.js` and use the official `upload_assets`/upstream asset fill workflow to avoid MCP payload limits. Use `$.screenshot(target)` or `node.screenshot()` as an opportunistic inline check when the upstream runtime returns image payloads; use official screenshot tools for final visual QA if the script result has no image payload. Use `$.select([...])` instead of writing `figma.currentPage.selection` directly. Use `$.cloneNodeTree({ source, as, placement: "right" })` for side-by-side copy workflows; it clones outer-to-inner and preserves instance subtrees whole when Figma prevents rebuilding internal children. Use `$` helpers for common edits and native Figma Plugin API calls for advanced work.

`figma_repl_prepare_task` creates or reuses a repairable intent pair with a `.figma.js` script and paired `.result.json` file in the file-context folder. With an initialized workspace it writes into that file context and can prepare multiple intent pairs for the same Figma file. Without one, its fallback root is `FIGMA_REPL_TASK_ROOT`, then the OS temp path `figma-repl-mcp/tasks/<slug>`. `figma_repl_plan_task`, `figma_repl_api_card`, and `figma_repl_suggest_api` return compact guidance without upstream calls.

The REPL MCP layer exposes `figma_repl_capabilities`, `figma_repl_docs_search`, `figma_repl_api_lookup`, `figma_repl_call_upstream_tool`, `figma_repl_init_workspace`, `figma_repl_prepare_task`, `figma_repl_run_script_file`, `figma_repl_apply_asset_manifest`, `figma_repl_capture_node`, `figma_repl_run_task_plan`, `figma_repl_plan_task`, `figma_repl_api_card`, and `figma_repl_suggest_api`, plus JSON resources at `figma-repl://guide`, `figma-repl://patterns`, `figma-repl://scripts`, `figma-repl://file-workflow`, `figma-repl://workflow-tools`, `figma-repl://api-cards`, `figma-repl://intents`, `figma-repl://safety`, `figma-repl://docs`, `figma-repl://api`, and `figma-repl://sessions`. Use these compact references and lookup tools instead of reading the large bundled docs tree or `plugin-api-standalone.d.ts` directly.

Diagnostics are structured as `{ code, severity, message, suggestion, docsHint }`; script-file diagnostics also include `{ source: { scriptPath, line, column } }` when the policy engine can locate the match. Fatal diagnostics block upstream execution; warnings return with the result. Upstream script failures returned by `figma_repl_run_script_file` are structured as `{ ok:false, upstreamError, primaryFix }` where feasible, including upstream `ok:false` payloads and thrown tool errors. `allowDangerousOperations` bypasses only dynamic/destructive guards, not Plugin API contract, read-mode, or surface guards. `figma_repl_run_script_file` supports `dryRun`, `strict`, `targetPageId`, and `expectedSurface`; `figma_repl_validate_handles` checks cached handles through a read-mode upstream eval.

Facade routing/delegation boundaries: after OAuth registration, agents should stay on `figma-repl-mcp` first. Use `.figma.js` files for Plugin API work, `figma_repl_api_card`/`figma_repl_suggest_api`/`figma_repl_docs_search`/`figma_repl_api_lookup` for compact guidance, and `figma_repl_call_upstream_tool` for official upstream capabilities not covered by the file workflow. Use local handles/session metadata instead of PluginData for agent state.

Low-level exports remain available for embedding: `RemoteMcpClient`, `PersistentOAuthProvider`, `OAuthStateStore`, and config helpers.

## Validation

```bash
npm run typecheck
npm test
```
