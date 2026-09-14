import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";

const packageRoot = resolve(import.meta.dirname, "..");
const temporaryRoot = await mkdtemp(resolve(tmpdir(), "figma-cli-presentation-"));
const compiledFile = resolve(temporaryRoot, "figma-workspace-cli.mjs");

await build({
  entryPoints: [resolve(packageRoot, "src/cli/figma-workspace-cli.ts")],
  outfile: compiledFile,
  bundle: true,
  format: "esm",
  platform: "node",
  target: "node20",
  banner: { js: 'import { createRequire as __figmaWorkspaceCreateRequire } from "node:module"; import { fileURLToPath as __figmaWorkspaceFileURLToPath } from "node:url"; import { dirname as __figmaWorkspacePathDirname } from "node:path"; const require = __figmaWorkspaceCreateRequire(import.meta.url); const __filename = __figmaWorkspaceFileURLToPath(import.meta.url); const __dirname = __figmaWorkspacePathDirname(__filename);' },
});
const cli = await import(pathToFileURL(compiledFile).href);

test.after(async () => {
  await rm(temporaryRoot, { recursive: true, force: true });
});

test("direct host script errors are summarized as failed atomically", () => {
  const result = {
    ok: false,
    executionOutcome: "failed_atomic",
  };
  const rendered = cli.formatFigmaWorkspaceCommandMarkdown("run", result, {}, {
    status: "failed-atomically",
    exitCode: 1,
    warnings: [],
    error: {
      code: "FIGMA_HOST_REJECTED",
      message: `Figma host rejected the mutation. ${"x".repeat(1_024)}`,
    },
  });

  assert.match(rendered, /^Status: failed atomically$/mu);
  assert.match(rendered, /^## Remote execution error$/mu);
  assert.match(rendered, /FIGMA_HOST_REJECTED: Figma host rejected the mutation\./u);
  assert.match(rendered, /failed atomically.*No file changes were applied; repair the script and retry safely/isu);
  assert.doesNotMatch(rendered, /x{601}/u);
});

test("only confirmed execution followed by local failure is failed after execution", () => {
  const presentation = cli.classifyFigmaWorkspaceCliResult("run", {
    ok: false,
    executionOutcome: "succeeded",
    error: { code: "FIGMA_WORKSPACE_RESULT_PERSISTENCE_FAILED", message: "Could not write result." },
  });
  const rendered = cli.formatFigmaWorkspaceCommandMarkdown("run", {
    ok: false,
    executionOutcome: "succeeded",
    error: { code: "FIGMA_WORKSPACE_RESULT_PERSISTENCE_FAILED", message: "Could not write result." },
  }, {}, presentation);

  assert.equal(presentation.status, "failed-after-execution");
  assert.match(rendered, /^Status: failed after execution$/mu);
  assert.doesNotMatch(rendered, /^## Remote execution error$/mu);
  assert.match(rendered, /^## Error$/mu);
  assert.match(rendered, /FIGMA_WORKSPACE_RESULT_PERSISTENCE_FAILED: Could not write result\./u);
});

test("batch failures summarize their first nested error", () => {
  const rendered = cli.formatFigmaWorkspaceCommandMarkdown("apply-asset-manifest", {
    ok: false,
    assets: [{
      ok: false,
      path: "asset.png",
      targetNodeId: "1:2",
      upstreamError: { code: "FIGMA_ASSET_UPLOAD_FAILED", message: "Asset upload failed." },
    }],
    failures: [{
      path: "asset.png",
      targetNodeId: "1:2",
      upstreamError: { code: "FIGMA_ASSET_UPLOAD_FAILED", message: "Asset upload failed." },
    }],
  }, {});

  assert.match(rendered, /^Status: failed$/mu);
  assert.match(rendered, /^## Error$/mu);
  assert.match(rendered, /FIGMA_ASSET_UPLOAD_FAILED: Asset upload failed\./u);
});

test("nested failures take precedence over unrelated warning diagnostics", () => {
  const rendered = cli.formatFigmaWorkspaceCommandMarkdown("download-assets", {
    ok: false,
    diagnostics: [{
      code: "FIGMA_WORKSPACE_UPSTREAM_OPTIONAL_SKIPPED",
      severity: "warning",
      message: "An optional upstream argument was skipped.",
      suggestion: "No local repair is required.",
    }],
    failures: [{
      targetNodeId: "1:2",
      downloadError: { code: "HTTP_500", message: "Asset download failed." },
    }],
  }, {});

  assert.match(rendered, /HTTP_500: Asset download failed\./u);
  assert.doesNotMatch(rendered, /Next step: No local repair is required/u);
});
