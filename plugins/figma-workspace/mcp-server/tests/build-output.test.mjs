import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { cp, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createFigmaWorkspaceMcpServer } from "../dist/mcp/index.js";

test("build publishes CLI and TypeScript declaration contract", async () => {
  const [
    packageJson,
    upstreamCliSource,
    workspaceCliSource,
    apiDeclarations,
    upstreamCliDeclarations,
    workspaceDeclarations,
    nodeWorkspaceDeclarations,
    runtimeHelperDeclarations,
    runtimeFigmaPluginTypings,
    runtimeFigmaPluginApiTypings,
    sharedRuntimeSource,
    compilerRuntimeSource,
    apiSource,
    workspaceServerSource,
  ] =
    await Promise.all([
    readFile(new URL("../package.json", import.meta.url), "utf8"),
    readFile(new URL("../dist/upstream/upstream-stdio-bin.js", import.meta.url), "utf8"),
    readFile(new URL("../dist/mcp/workspace-mcp-stdio-bin.js", import.meta.url), "utf8"),
    readFile(new URL("../dist/mcp/index.d.ts", import.meta.url), "utf8"),
    readFile(new URL("../dist/upstream/upstream-stdio-cli.d.ts", import.meta.url), "utf8"),
    readFile(new URL("../dist/mcp/workspace-mcp-server.d.ts", import.meta.url), "utf8"),
    readFile(new URL("../dist/upstream/node-upstream-client.d.ts", import.meta.url), "utf8"),
    readFile(new URL("../dist/runtime/figma-workspace-helpers.d.ts", import.meta.url), "utf8"),
    readFile(new URL("../dist/runtime/figma-plugin-typings/index.d.ts", import.meta.url), "utf8"),
    readFile(new URL("../dist/runtime/figma-plugin-typings/plugin-api.d.ts", import.meta.url), "utf8"),
    readFile(new URL("../dist/runtime/workspace-runtime.js", import.meta.url), "utf8"),
    readFile(new URL("../dist/runtime/typescript-compiler-runtime.js", import.meta.url), "utf8"),
    readFile(new URL("../dist/mcp/index.js", import.meta.url), "utf8"),
    readFile(new URL("../dist/mcp/workspace-mcp-server.js", import.meta.url), "utf8"),
  ]);
  const distFiles = (await readdir(new URL("../dist/", import.meta.url), {
    recursive: true,
  })).map((file) => file.replaceAll("\\", "/"));
  const packageData = JSON.parse(packageJson);

  assert.equal(packageData.types, "./dist/mcp/index.d.ts");
  assert.equal(packageData.exports["."].types, "./dist/mcp/index.d.ts");
  assert.equal(packageData.exports["./upstream-stdio"].types, "./dist/upstream/upstream-stdio-cli.d.ts");
  assert.equal(packageData.exports["./workspace"].types, "./dist/mcp/workspace-mcp-server.d.ts");
  assert.equal(packageData.exports["./node-upstream-client"].types, "./dist/upstream/node-upstream-client.d.ts");
  assert.equal(packageData.bin["figma_workspace_upstream_stdio"], "./dist/upstream/upstream-stdio-bin.js");
  assert.equal(packageData.bin["figma_workspace_mcp"], "./dist/mcp/workspace-mcp-stdio-bin.js");
  assert.match(upstreamCliSource, /^#!\/usr\/bin\/env node\n/);
  assert.match(workspaceCliSource, /^#!\/usr\/bin\/env node\n/);
  assert.match(apiDeclarations, /createFigmaWorkspaceUpstreamStdioServer/);
  assert.match(apiDeclarations, /createRemoteMcpClient/);
  assert.match(apiDeclarations, /createFigmaWorkspaceClient/);
  assert.match(apiDeclarations, /createFigmaWorkspaceMcpServer/);
  assert.match(apiDeclarations, /FigmaWorkspaceApplyAssetManifestArguments/);
  assert.match(apiDeclarations, /FigmaWorkspaceApplyAssetManifestResult/);
  assert.match(apiDeclarations, /FigmaWorkspaceCaptureNodeArguments/);
  assert.match(apiDeclarations, /FigmaWorkspaceCaptureNodeResult/);
  assert.match(apiDeclarations, /FigmaWorkspaceGetMetadataArguments/);
  assert.match(apiDeclarations, /FigmaWorkspaceGetMetadataResult/);
  assert.match(apiDeclarations, /FigmaWorkspaceSearchDesignSystemArguments/);
  assert.match(apiDeclarations, /FigmaWorkspaceSearchDesignSystemResult/);
  assert.match(apiDeclarations, /FigmaWorkspaceGetLibrariesArguments/);
  assert.match(apiDeclarations, /FigmaWorkspaceGetLibrariesResult/);
  assert.match(apiDeclarations, /FigmaWorkspaceGetVariableDefsArguments/);
  assert.match(apiDeclarations, /FigmaWorkspaceGetVariableDefsResult/);
  assert.match(apiDeclarations, /FigmaWorkspaceRunTaskPlanArguments/);
  assert.match(apiDeclarations, /FigmaWorkspaceUpstreamEnvelope/);
  assert.match(apiDeclarations, /FigmaWorkspaceToolResultBase/);
  assert.doesNotMatch(apiDeclarations, /runFigmaWorkspaceUpstreamStdioCli/);
  assert.doesNotMatch(apiDeclarations, /startFigmaWorkspaceUpstreamStdioServer/);
  assert.match(upstreamCliDeclarations, /runFigmaWorkspaceUpstreamStdioCli/);
  assert.match(workspaceDeclarations, /createFigmaWorkspaceClient/);
  assert.match(workspaceDeclarations, /export interface FigmaWorkspaceUpstreamEnvelope/);
  assert.match(workspaceDeclarations, /export interface FigmaWorkspacePublicUpstreamError/);
  assert.match(workspaceDeclarations, /export interface FigmaWorkspaceFilePointer/);
  assert.match(workspaceDeclarations, /export interface FigmaWorkspaceToolResultBase/);
  assert.doesNotMatch(workspaceDeclarations, /eval\(args: FigmaWorkspaceEvalArguments\): Promise<unknown>/);
  assert.doesNotMatch(workspaceDeclarations, /runScriptFile\(args: FigmaWorkspaceRunScriptFileArguments\): Promise<unknown>/);
  assert.doesNotMatch(workspaceDeclarations, /applyAssetManifest\(args: FigmaWorkspaceApplyAssetManifestArguments\): Promise<unknown>/);
  assert.doesNotMatch(workspaceDeclarations, /captureNode\(args: FigmaWorkspaceCaptureNodeArguments\): Promise<unknown>/);
  assert.doesNotMatch(workspaceDeclarations, /getMetadata\(args: FigmaWorkspaceGetMetadataArguments\): Promise<unknown>/);
  assert.doesNotMatch(workspaceDeclarations, /searchDesignSystem\(args: FigmaWorkspaceSearchDesignSystemArguments\): Promise<unknown>/);
  assert.doesNotMatch(workspaceDeclarations, /getLibraries\(args\?: FigmaWorkspaceGetLibrariesArguments\): Promise<unknown>/);
  assert.doesNotMatch(workspaceDeclarations, /getVariableDefs\(args: FigmaWorkspaceGetVariableDefsArguments\): Promise<unknown>/);
  assert.doesNotMatch(workspaceDeclarations, /callUpstreamTool\(args: FigmaWorkspaceCallUpstreamToolArguments\): Promise<unknown>/);
  assert.match(nodeWorkspaceDeclarations, /createRemoteMcpClient/);
  assert.match(nodeWorkspaceDeclarations, /createFigmaWorkspaceClient/);
  assert.match(nodeWorkspaceDeclarations, /installNodeReplWebStreamGlobals/);
  assert.match(runtimeHelperDeclarations, /readonly handles: Readonly<Record<string, string>>;/);
  assert.doesNotMatch(runtimeHelperDeclarations, /\$\.create|\$\.layout|\$\.find\b|\$\.findAll\b/);
  assert.match(runtimeFigmaPluginTypings, /plugin-api\.d\.ts/);
  assert.match(runtimeFigmaPluginApiTypings, /interface PluginAPI/);
  assert.match(sharedRuntimeSource, /(?:from "\.\/typescript-compiler-runtime\.js"|import "\.\/typescript-compiler-runtime\.js")/);
  assert.doesNotMatch(sharedRuntimeSource, /node_modules\/@typescript\/typescript6\/node_modules\/typescript\/lib\/typescript\.js/);
  assert.match(compilerRuntimeSource, /node_modules\/@typescript\/typescript6\/node_modules\/typescript\/lib\/typescript\.js/);
  assert.doesNotMatch(apiSource, /node_modules\/@typescript\/typescript6\/node_modules\/typescript\/lib\/typescript\.js/);
  assert.doesNotMatch(workspaceServerSource, /from "typescript"|require\("typescript"\)/);
  assert.doesNotMatch(workspaceServerSource, /node_modules\/@typescript\/typescript6\/node_modules\/typescript\/lib\/typescript\.js/);
  assert.match(workspaceDeclarations, /eval\(args: FigmaWorkspaceEvalArguments\): Promise<FigmaWorkspaceEvalResult>/);
  assert.match(workspaceDeclarations, /runScriptFile\(args: FigmaWorkspaceRunScriptFileArguments\): Promise<FigmaWorkspaceRunScriptFileResult>/);
  assert.match(workspaceDeclarations, /applyAssetManifest\(args: FigmaWorkspaceApplyAssetManifestArguments\): Promise<FigmaWorkspaceApplyAssetManifestResult>/);
  assert.match(workspaceDeclarations, /captureNode\(args: FigmaWorkspaceCaptureNodeArguments\): Promise<FigmaWorkspaceCaptureNodeResult>/);
  assert.match(workspaceDeclarations, /getMetadata\(args: FigmaWorkspaceGetMetadataArguments\): Promise<FigmaWorkspaceGetMetadataResult>/);
  assert.match(workspaceDeclarations, /searchDesignSystem\(args: FigmaWorkspaceSearchDesignSystemArguments\): Promise<FigmaWorkspaceSearchDesignSystemResult>/);
  assert.match(workspaceDeclarations, /getLibraries\(args\?: FigmaWorkspaceGetLibrariesArguments\): Promise<FigmaWorkspaceGetLibrariesResult>/);
  assert.match(workspaceDeclarations, /getVariableDefs\(args: FigmaWorkspaceGetVariableDefsArguments\): Promise<FigmaWorkspaceGetVariableDefsResult>/);
  assert.match(workspaceDeclarations, /runTaskPlan\(args: FigmaWorkspaceRunTaskPlanArguments\): Promise<FigmaWorkspaceRunTaskPlanResult>/);
  assert.match(workspaceDeclarations, /callUpstreamTool\(args: FigmaWorkspaceCallUpstreamToolArguments\): Promise<FigmaWorkspaceCallUpstreamToolResult>/);
  assert.match(workspaceDeclarations, /export interface FigmaWorkspaceMetadataJson/);
  assert.match(workspaceDeclarations, /format: "figma-metadata-tree"/);
  assert.match(apiDeclarations, /FigmaWorkspaceCompactScriptMetadata/);
  assert.doesNotMatch(apiDeclarations, /FigmaWorkspaceVerboseScriptMetadata/);
  assert.doesNotMatch(workspaceDeclarations, /verboseResults/);
  assert.doesNotMatch(workspaceDeclarations, /verbose\?:/);
  assert.match(workspaceDeclarations, /script\?: FigmaWorkspaceCompactScriptMetadata;/);
  const compactScriptMetadata = workspaceDeclarations.match(
    /export interface FigmaWorkspaceCompactScriptMetadata \{([\s\S]*?)\n\}/,
  )?.[1];
  assert.notEqual(compactScriptMetadata, undefined);
  assert.match(compactScriptMetadata, /scriptPath\?: string;/);
  assert.match(compactScriptMetadata, /compiledScriptBytes\?: number;/);
  assert.doesNotMatch(compactScriptMetadata, /targetPageId/);
  assert.doesNotMatch(compactScriptMetadata, /injectedHelpers/);
  assert.doesNotMatch(compactScriptMetadata, /helperUsage/);
  assert.match(workspaceDeclarations, /@internal[\s\S]*Internal wrapper builder[\s\S]*buildFigmaEvalScript/);
  assert.match(workspaceDeclarations, /@internal[\s\S]*Internal-facing helper-selection utility[\s\S]*resolveFigmaWorkspaceScriptHelperSelection/);
  assert.equal(distFiles.includes("upstream/node-upstream-client.js"), true);
  assert.equal(distFiles.includes("runtime/workspace-runtime.js"), true);
  assert.equal(distFiles.includes("runtime/typescript-compiler-runtime.js"), true);
  assert.equal(distFiles.includes("mcp/workspace-mcp-cli.js"), true);
  assert.equal(distFiles.includes("mcp/workspace-mcp-server.js"), true);
  assert.equal(distFiles.includes("mcp/workspace-mcp-stdio-bin.js"), true);
  assert.equal(distFiles.includes("upstream/upstream-stdio-bin.js"), true);
  assert.equal(distFiles.includes("runtime/figma-workspace-helpers.d.ts"), true);
  assert.equal(distFiles.includes("runtime/figma-plugin-typings/index.d.ts"), true);
  assert.equal(distFiles.includes("runtime/figma-plugin-typings/plugin-api.d.ts"), true);
  assert.equal(distFiles.includes("runtime/typescript-lib/lib.es2022.d.ts"), true);
  assert.equal(distFiles.includes("runtime/typescript-lib/lib.dom.d.ts"), true);
  assert.equal(distFiles.includes("mcp/figma-workspace-helpers.d.ts"), false);
  assert.equal(distFiles.includes("mcp/figma-plugin-typings/index.d.ts"), false);
  assert.equal(distFiles.includes("mcp/figma-plugin-typings/plugin-api.d.ts"), false);
  assert.equal(distFiles.includes("mcp/typescript-lib/lib.es2022.d.ts"), false);
  assert.equal(distFiles.includes("upstream/figma-workspace-helpers.d.ts"), false);
  assert.equal(distFiles.includes("upstream/figma-plugin-typings/index.d.ts"), false);
  assert.equal(distFiles.includes("upstream/figma-plugin-typings/plugin-api.d.ts"), false);
  assert.equal(distFiles.includes("upstream/typescript-lib/lib.es2022.d.ts"), false);
  assert.equal(distFiles.includes("skills/figma-workspace/references/upstream-corpus/manifest.json"), true);
  assert.equal(distFiles.includes("skills/figma-workspace/references/upstream-corpus/corpus.jsonl"), true);
  assert.equal(distFiles.some((file) => file.endsWith(".d.ts.map")), false);

  const stagedCorpusManifest = JSON.parse(
    await readFile(new URL("../dist/skills/figma-workspace/references/upstream-corpus/manifest.json", import.meta.url), "utf8"),
  );
  assert.equal(stagedCorpusManifest.corpus.file, "corpus.jsonl");
  assert.match(stagedCorpusManifest.corpus.contract, /Internal lookup corpus only/);
});

test("build output serves guidance and lookup from staged upstream corpus", async () => {
  const { server } = createFigmaWorkspaceMcpServer();
  const mcpClient = new Client(
    { name: "test-client", version: "0.1.0" },
    { capabilities: {} },
  );
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

  await server.connect(serverTransport);
  await mcpClient.connect(clientTransport);

  try {
    const guidanceResult = await mcpClient.callTool({
      name: "figma_workspace_guidance",
      arguments: {
        title: "Built guidance",
        query: "component variants text",
        surface: "design",
      },
    });
    const guidanceJson = structuredToolResult(guidanceResult);
    assert.equal(guidanceJson.ok, true);
    assert.equal(guidanceJson.referenceContext, undefined);
    assert.ok(guidanceJson.suggestions.referenceContext.length > 0);
    assert.ok(guidanceJson.suggestions.referenceContext.every((item) => item.sourceId.startsWith("internal:")));

    const lookupResult = await mcpClient.callTool({
      name: "figma_workspace_lookup",
      arguments: {
        title: "Built lookup",
        kind: "api",
        symbol: "createFrame",
        maxResults: 2,
        maxSnippetLines: 3,
      },
    });
    const lookupJson = structuredToolResult(lookupResult);
    assert.equal(lookupJson.ok, true);
    assert.ok(lookupJson.results.length > 0);
    assert.equal(lookupJson.results[0].matchType, "exact-symbol");
    assert.match(JSON.stringify(lookupJson.results), /createFrame/);
  } finally {
    await mcpClient.close().catch(() => undefined);
  }
});

test("packaged dist starts and typechecks without package node_modules", async () => {
  const tempDir = await mkdtemp(join(tmpdir(), "figma-workspace-installed-dist-"));
  try {
    await cp(new URL("../package.json", import.meta.url), join(tempDir, "package.json"));
    await cp(new URL("../dist/", import.meta.url), join(tempDir, "dist"), { recursive: true });
    await writeFile(join(tempDir, "smoke.mjs"), installedDistSmokeScript, "utf8");

    const result = await runNodeScript(join(tempDir, "smoke.mjs"), tempDir);
    assert.equal(result.code, 0, result.stderr);
    assert.equal(result.stderr, "");

    const smoke = JSON.parse(result.stdout);
    assert.deepEqual(smoke, {
      ok: true,
      diagnostics: 0,
      upstreamCalls: 1,
      upstreamName: "use_figma",
      hasCode: true,
      upstreamOk: true,
      smoke: true,
    });
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("packaged dist keeps preloaded runtime assets after installed files are removed", async () => {
  const tempDir = await mkdtemp(join(tmpdir(), "figma-workspace-preloaded-assets-"));
  try {
    await cp(new URL("../package.json", import.meta.url), join(tempDir, "package.json"));
    await cp(new URL("../dist/", import.meta.url), join(tempDir, "dist"), { recursive: true });
    await writeFile(join(tempDir, "preloaded-assets.mjs"), preloadedAssetsSmokeScript, "utf8");

    const result = await runNodeScript(join(tempDir, "preloaded-assets.mjs"), tempDir);
    assert.equal(result.code, 0, result.stderr);
    assert.equal(result.stderr, "");

    const smoke = JSON.parse(result.stdout);
    assert.equal(smoke.lookupOk, true);
    assert.equal(smoke.lookupResults, true);
    assert.equal(smoke.evalBlocked, true);
    assert.equal(smoke.scriptBlocked, true);
    assert.equal(smoke.noMissingAssetDiagnostics, true);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("packaged dist returns structured lookup diagnostics when corpus is missing at startup", async () => {
  const tempDir = await mkdtemp(join(tmpdir(), "figma-workspace-missing-corpus-"));
  try {
    await cp(new URL("../package.json", import.meta.url), join(tempDir, "package.json"));
    await cp(new URL("../dist/", import.meta.url), join(tempDir, "dist"), { recursive: true });
    await rm(join(tempDir, "dist/skills/figma-workspace/references/upstream-corpus"), { recursive: true, force: true });
    await writeFile(join(tempDir, "missing-corpus.mjs"), missingCorpusSmokeScript, "utf8");

    const result = await runNodeScript(join(tempDir, "missing-corpus.mjs"), tempDir);
    assert.equal(result.code, 0, result.stderr);
    assert.equal(result.stderr, "");

    const smoke = JSON.parse(result.stdout);
    assert.equal(smoke.ok, false);
    assert.equal(smoke.diagnosticCode, "FIGMA_WORKSPACE_LOOKUP_CORPUS_UNAVAILABLE");
    assert.equal(smoke.hasRuntime, true);
    assert.equal(smoke.hasAttemptedPaths, true);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

function structuredToolResult(result) {
  assert.ok(result.structuredContent);
  const content = Array.isArray(result.content) ? result.content : [];
  assert.equal(content.some((item) => item?.type === "text"), false);
  return result.structuredContent;
}

const installedDistSmokeScript = String.raw`
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createFigmaWorkspaceClient } from "./dist/mcp/index.js";

await import("./dist/mcp/workspace-mcp-stdio-bin.js");

const calls = [];
const fakeUpstream = {
  async connect() {
    calls.push(["connect"]);
  },
  async close() {
    calls.push(["close"]);
  },
  async callTool(name, args) {
    calls.push(["callTool", name, args]);
    if (name !== "use_figma") {
      throw new Error("unexpected upstream tool " + name);
    }
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify({
            ok: true,
            __figmaRepl: { sessionId: "main", handles: {} },
            result: { smoke: true },
          }),
        },
      ],
    };
  },
  async listTools() {
    calls.push(["listTools"]);
    return {
      tools: [
        {
          name: "use_figma",
          inputSchema: {
            type: "object",
            properties: { code: { type: "string" } },
            required: ["code"],
          },
        },
      ],
    };
  },
  async listResources() {
    return { resources: [] };
  },
  async listResourceTemplates() {
    return { resourceTemplates: [] };
  },
  async readResource() {
    return { contents: [] };
  },
};

const client = createFigmaWorkspaceClient({ client: fakeUpstream });
const workspaceDir = join(process.cwd(), "workspace");
await mkdir(workspaceDir, { recursive: true });
const inputFile = join(workspaceDir, "smoke.figma.ts");
await writeFile(
  inputFile,
  "const frame = figma.createFrame();\nframe.name = 'Smoke';\nreturn { id: frame.id };\n",
  "utf8",
);

const result = await client.runScriptFile({
  file: "FILE123",
  scriptPath: inputFile,
  strict: true,
  cwd: workspaceDir,
});
const callTool = calls.find((entry) => entry[0] === "callTool") ?? [];
console.log(JSON.stringify({
  ok: result.ok,
  diagnostics: (result.diagnostics ?? []).length,
  upstreamCalls: calls.filter((entry) => entry[0] === "callTool").length,
  upstreamName: callTool[1],
  hasCode: typeof callTool[2]?.code === "string",
  upstreamOk: result.upstream?.ok,
  smoke: result.upstream?.result?.smoke === true,
}));
`;

const preloadedAssetsSmokeScript = String.raw`
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createFigmaWorkspaceClient } from "./dist/mcp/index.js";

const fakeUpstream = {
  async connect() {},
  async close() {},
  async callTool(name) {
    throw new Error("unexpected upstream tool " + name);
  },
  async listTools() {
    return { tools: [] };
  },
  async listResources() {
    return { resources: [] };
  },
  async listResourceTemplates() {
    return { resourceTemplates: [] };
  },
  async readResource() {
    return { contents: [] };
  },
};

const client = createFigmaWorkspaceClient({ client: fakeUpstream });
await rm(join(process.cwd(), "dist/skills/figma-workspace/references/upstream-corpus"), { recursive: true, force: true });
await rm(join(process.cwd(), "dist/runtime/figma-workspace-helpers.d.ts"), { force: true });
await rm(join(process.cwd(), "dist/runtime/figma-plugin-typings"), { recursive: true, force: true });
await rm(join(process.cwd(), "dist/runtime/typescript-lib"), { recursive: true, force: true });

const lookup = await client.lookup({ kind: "api", symbol: "createFrame", maxResults: 1 });
const evalResult = await client.eval({
  mode: "read",
  typescript: true,
  code: "const rect: RectangleNode = figma.createRectangle();\nrect.appendChild(figma.createFrame());\nreturn { id: rect.id };",
});
const workspaceDir = join(process.cwd(), "workspace");
await mkdir(workspaceDir, { recursive: true });
const prepared = await client.prepareTask({
  sessionId: "preloaded",
  file: "FILE123",
  taskName: "post-delete",
  workspaceDir,
  overwrite: true,
});
await writeFile(
  prepared.task.scriptPath,
  "const rect: RectangleNode = figma.createRectangle();\nrect.appendChild(figma.createFrame());\nreturn { id: rect.id };\n",
  "utf8",
);
const scriptResult = await client.runScriptFile({
  sessionId: "preloaded",
  inputFile: prepared.task.inputFile,
  strict: true,
});
const diagnosticsText = JSON.stringify([
  ...(evalResult.diagnostics ?? []),
  ...(scriptResult.diagnostics ?? []),
]);

console.log(JSON.stringify({
  lookupOk: lookup.ok === true,
  lookupResults: lookup.results.length > 0,
  evalBlocked: evalResult.ok === false && (evalResult.diagnostics ?? []).length > 0,
  scriptBlocked: scriptResult.ok === false && (scriptResult.diagnostics ?? []).length > 0,
  noMissingAssetDiagnostics: !/ENOENT|no such file|Cannot find global type|figma-workspace-helpers|figma-plugin-typings|typescript-lib/u.test(diagnosticsText),
}));
`;

const missingCorpusSmokeScript = String.raw`
import { createFigmaWorkspaceClient } from "./dist/mcp/index.js";

const client = createFigmaWorkspaceClient({
  client: {
    async connect() {},
    async close() {},
    async callTool(name) {
      throw new Error("unexpected upstream tool " + name);
    },
    async listTools() {
      return { tools: [] };
    },
    async listResources() {
      return { resources: [] };
    },
    async listResourceTemplates() {
      return { resourceTemplates: [] };
    },
    async readResource() {
      return { contents: [] };
    },
  },
});

const result = await client.lookup({ kind: "docs", query: "text font", maxResults: 1 });
console.log(JSON.stringify({
  ok: result.ok,
  diagnosticCode: result.diagnostics?.[0]?.code,
  hasRuntime: result.runtime?.ok === false,
  hasAttemptedPaths: Array.isArray(result.runtime?.attemptedPaths) && result.runtime.attemptedPaths.length > 0,
}));
`;

function runNodeScript(scriptPath, cwd) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [scriptPath], {
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (data) => {
      stdout += data;
    });
    child.stderr.on("data", (data) => {
      stderr += data;
    });
    child.on("error", reject);
    child.on("exit", (code, signal) => {
      resolve({ code, signal, stdout: stdout.trim(), stderr: stderr.trim() });
    });
  });
}
