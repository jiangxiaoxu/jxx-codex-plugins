import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
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

test("API lookup defaults to readable selectors and TypeScript instead of the generic lookup envelope", () => {
  const search = cli.formatFigmaWorkspaceCommandMarkdown("lookup", {
    ok: true,
    mode: "search",
    normalizedSelector: "fontName",
    results: [{
      selector: "BaseNonResizableTextMixin.fontName",
      declarationKind: "property",
      snippet: "readonly fontName: FontName | PluginAPI['mixed'];",
    }],
    parameterAdjustments: [{ option: "--limit", requested: 99, applied: 10, range: [1, 10] }],
    invocation: { invocationId: "ephemeral", outputRoot: "C:/temporary/result" },
  }, {
    kind: "api",
    mode: "search",
    selector: "fontName",
  });
  assert.match(search, /^# Figma Plugin API search: fontName$/mu);
  assert.match(search, /BaseNonResizableTextMixin\.fontName \(property\)/u);
  assert.match(search, /^```ts$/mu);
  assert.match(search, /Read: figma:api:read BaseNonResizableTextMixin\.fontName/u);
  assert.match(search, /Note: --limit was adjusted to 10\./u);
  assert.doesNotMatch(search, /# figma:lookup|invocationId|outputRoot|apiId/u);

  const read = cli.formatFigmaWorkspaceCommandMarkdown("lookup", {
    ok: true,
    mode: "read",
    selector: "PluginAPI.on",
    declarations: [{
      kind: "api",
      selector: "PluginAPI.on",
      declarationKind: "method",
      source: { package: "@figma/plugin-typings", version: "1.138.0" },
      content: "on(type: 'selectionchange', callback: () => void): void;",
    }],
  }, {
    kind: "api",
    mode: "read",
    selector: "PluginAPI.on",
  });
  assert.match(read, /^# Figma Plugin API: PluginAPI\.on$/mu);
  assert.match(read, /^Source: @figma\/plugin-typings 1\.138\.0$/mu);
  assert.match(read, /on\(type: 'selectionchange'/u);
  assert.doesNotMatch(read, /# figma:lookup|"content"|invocation/u);
});

test("API JSON output is a pure payload without invocation metadata", async () => {
  const stdout = [];
  const stderr = [];
  const result = {
    ok: true,
    mode: "search",
    normalizedSelector: "fontName",
    results: [{
      selector: "Font.fontName",
      declarationKind: "property",
      snippet: "fontName: FontName;",
    }],
  };
  const exitCode = await cli.runFigmaWorkspaceCli(["lookup", "--input", "-", "--format", "json"], {
    io: {
      cwd: () => process.cwd(),
      env: () => undefined,
      readFile: async () => JSON.stringify({ kind: "api", mode: "search", selector: "fontName" }),
      readStdin: async () => JSON.stringify({ kind: "api", mode: "search", selector: "fontName" }),
      writeStdout: (value) => stdout.push(value),
      writeStderr: (value) => stderr.push(value),
    },
    createClient: () => ({
      lookup: async () => result,
      close: async () => {},
    }),
  });
  assert.equal(exitCode, 0);
  assert.equal(stderr.join(""), "");
  const payload = JSON.parse(stdout.join(""));
  assert.deepEqual(payload, result);
  assert.doesNotMatch(stdout.join(""), /```|# figma:lookup|invocation|outputRoot/u);
});

test("API JSON errors retain machine-readable code and ambiguity candidates", async () => {
  const stdout = [];
  const stderr = [];
  const error = Object.assign(new Error("fontName is ambiguous."), {
    code: "FIGMA_WORKSPACE_API_SELECTOR_AMBIGUOUS",
    candidates: ["Font.fontName", "BaseNonResizableTextMixin.fontName"],
  });
  const exitCode = await cli.runFigmaWorkspaceCli(["lookup", "--input", "-", "--format", "json"], {
    io: {
      cwd: () => process.cwd(),
      env: () => undefined,
      readFile: async () => JSON.stringify({ kind: "api", mode: "read", selector: "fontName" }),
      readStdin: async () => JSON.stringify({ kind: "api", mode: "read", selector: "fontName" }),
      writeStdout: (value) => stdout.push(value),
      writeStderr: (value) => stderr.push(value),
    },
    createClient: () => ({
      lookup: async () => { throw error; },
      close: async () => {},
    }),
  });
  assert.equal(exitCode, 1);
  assert.equal(stderr.join(""), "");
  assert.deepEqual(JSON.parse(stdout.join("")), {
    ok: false,
    mode: "read",
    error: {
      code: "FIGMA_WORKSPACE_API_SELECTOR_AMBIGUOUS",
      message: "fontName is ambiguous.",
      candidates: ["Font.fontName", "BaseNonResizableTextMixin.fontName"],
    },
  });
});

test("an oversized CLI result reuses the runtime receipt instead of writing a second receipt", async () => {
  const directory = await mkdtemp(resolve(tmpdir(), "figma-cli-existing-result-file-"));
  const receiptPath = resolve(directory, "runtime result's.json");
  await writeFile(receiptPath, JSON.stringify({ kind: "figma-cli-result", schemaVersion: 1 }), "utf8");
  const stdout = [];
  const stderr = [];
  try {
    const exitCode = await cli.runFigmaWorkspaceCli(["run", "--input", "-", "--inline-result-limit", "0"], {
      io: {
        cwd: () => process.cwd(),
        env: () => undefined,
        readFile: async () => "",
        readStdin: async () => JSON.stringify({
          file: "https://www.figma.com/design/ExampleKey/UI",
          source: "return {};",
          outputDir: directory,
        }),
        writeStdout: (value) => stdout.push(value),
        writeStderr: (value) => stderr.push(value),
      },
      createClient: () => ({
        close: async () => {},
        run: async () => ({
          ok: true,
          phase: "execute",
          executionOutcome: "succeeded",
          upstream: { kind: "json", ok: true, result: { message: "x".repeat(2_048) } },
          outputFiles: {
            resultFile: {
              path: receiptPath,
              bytes: 53,
              lineCount: 1,
              jq: {
                full: ".",
                data: ".result.upstream.result",
                status: ".result | {ok,phase,executionOutcome,upstreamError,error,operationError,diagnostics,retryGuidance,postProcessing}",
              },
            },
          },
        }),
      }),
    });
    const rendered = stdout.join("");
    assert.equal(exitCode, 0);
    assert.equal(stderr.join(""), "");
    assert.match(rendered, /^Status: succeeded$/mu);
    assert.match(rendered, /jq '\.result\.upstream\.result' -- /u);
    const quote = process.platform === "win32"
      ? (value) => `'${value.replaceAll("'", "''")}'`
      : (value) => `'${value.replaceAll("'", "'\"'\"'")}'`;
    assert.ok(rendered.includes(`\`\`\`${process.platform === "win32" ? "powershell" : "sh"}`), rendered);
    assert.ok(rendered.includes(`-- ${quote(receiptPath)}`), rendered);
    assert.match(rendered, /"resultFile"/u);
    assert.doesNotMatch(rendered, /cliResultFile|"message": "x{128}/u);
    assert.deepEqual(await readdir(directory), ["runtime result's.json"]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("an oversized CLI fallback writes one complete versioned result receipt", async () => {
  const directory = await mkdtemp(resolve(tmpdir(), "figma-cli-fallback-result-file-"));
  const stdout = [];
  const stderr = [];
  const payload = "x".repeat(2_048);
  try {
    const exitCode = await cli.runFigmaWorkspaceCli(["run", "--input", "-", "--inline-result-limit", "0"], {
      io: {
        cwd: () => process.cwd(),
        env: () => undefined,
        readFile: async () => "",
        readStdin: async () => JSON.stringify({
          file: "https://www.figma.com/design/ExampleKey/UI",
          source: "return {};",
          outputDir: directory,
        }),
        writeStdout: (value) => stdout.push(value),
        writeStderr: (value) => stderr.push(value),
      },
      createClient: () => ({
        close: async () => {},
        run: async () => ({
          ok: true,
          phase: "execute",
          executionOutcome: "succeeded",
          upstream: { kind: "json", ok: true, result: { payload, falseValue: false, nullValue: null } },
        }),
      }),
    });
    const rendered = stdout.join("");
    const resultPath = /"resultFile":\s*\{\s*"path": "([^"]+)"/u.exec(rendered)?.[1];
    assert.equal(exitCode, 0);
    assert.equal(stderr.join(""), "");
    assert.ok(resultPath, rendered);
    assert.match(rendered, /jq '\.result\.upstream\.result' -- /u);
    assert.doesNotMatch(rendered, /cliResultFile|"payload": "x{128}/u);
    const receipt = JSON.parse(await readFile(resultPath.replaceAll("\\\\", "\\"), "utf8"));
    assert.equal(receipt.kind, "figma-cli-result");
    assert.equal(receipt.schemaVersion, 1);
    assert.equal(receipt.tool, "figma:run");
    assert.equal(receipt.result.upstream.result.payload, payload);
    assert.equal(receipt.result.upstream.result.falseValue, false);
    assert.equal(receipt.result.upstream.result.nullValue, null);
    assert.equal("resultFile" in (receipt.result.outputFiles ?? {}), false);
    assert.deepEqual(await readdir(directory), ["run.result.json"]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
