import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
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
    mcpHelperDeclarations,
    upstreamHelperDeclarations,
    mcpFigmaPluginTypings,
    upstreamFigmaPluginTypings,
    mcpFigmaPluginApiTypings,
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
    readFile(new URL("../dist/mcp/figma-workspace-helpers.d.ts", import.meta.url), "utf8"),
    readFile(new URL("../dist/upstream/figma-workspace-helpers.d.ts", import.meta.url), "utf8"),
    readFile(new URL("../dist/mcp/figma-plugin-typings/index.d.ts", import.meta.url), "utf8"),
    readFile(new URL("../dist/upstream/figma-plugin-typings/index.d.ts", import.meta.url), "utf8"),
    readFile(new URL("../dist/mcp/figma-plugin-typings/plugin-api.d.ts", import.meta.url), "utf8"),
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
  assert.equal(mcpHelperDeclarations, upstreamHelperDeclarations);
  assert.match(mcpHelperDeclarations, /readonly handles: Readonly<Record<string, string>>;/);
  assert.doesNotMatch(mcpHelperDeclarations, /\$\.create|\$\.layout|\$\.find\b|\$\.findAll\b/);
  assert.equal(mcpFigmaPluginTypings, upstreamFigmaPluginTypings);
  assert.match(mcpFigmaPluginTypings, /plugin-api\.d\.ts/);
  assert.match(mcpFigmaPluginApiTypings, /interface PluginAPI/);
  assert.doesNotMatch(workspaceServerSource, /from "typescript"|require\("typescript"\)/);
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
  assert.match(workspaceDeclarations, /script: FigmaWorkspaceCompactScriptMetadata;/);
  const compactScriptMetadata = workspaceDeclarations.match(
    /export interface FigmaWorkspaceCompactScriptMetadata \{([\s\S]*?)\n\}/,
  )?.[1];
  assert.notEqual(compactScriptMetadata, undefined);
  assert.match(compactScriptMetadata, /scriptPath: string;/);
  assert.match(compactScriptMetadata, /compiledScriptBytes: number;/);
  assert.doesNotMatch(compactScriptMetadata, /targetPageId/);
  assert.doesNotMatch(compactScriptMetadata, /injectedHelpers/);
  assert.doesNotMatch(compactScriptMetadata, /helperUsage/);
  assert.match(workspaceDeclarations, /@internal[\s\S]*Internal wrapper builder[\s\S]*buildFigmaEvalScript/);
  assert.match(workspaceDeclarations, /@internal[\s\S]*Internal-facing helper-selection utility[\s\S]*resolveFigmaWorkspaceScriptHelperSelection/);
  assert.equal(distFiles.includes("upstream/node-upstream-client.js"), true);
  assert.equal(distFiles.includes("mcp/workspace-mcp-cli.js"), true);
  assert.equal(distFiles.includes("mcp/workspace-mcp-server.js"), true);
  assert.equal(distFiles.includes("mcp/workspace-mcp-stdio-bin.js"), true);
  assert.equal(distFiles.includes("upstream/upstream-stdio-bin.js"), true);
  assert.equal(distFiles.includes("mcp/figma-plugin-typings/index.d.ts"), true);
  assert.equal(distFiles.includes("mcp/figma-plugin-typings/plugin-api.d.ts"), true);
  assert.equal(distFiles.includes("upstream/figma-plugin-typings/index.d.ts"), true);
  assert.equal(distFiles.includes("upstream/figma-plugin-typings/plugin-api.d.ts"), true);
  assert.equal(distFiles.includes("mcp/typescript-lib/lib.es2022.d.ts"), true);
  assert.equal(distFiles.includes("mcp/typescript-lib/lib.dom.d.ts"), true);
  assert.equal(distFiles.includes("upstream/typescript-lib/lib.es2022.d.ts"), true);
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

function structuredToolResult(result) {
  assert.ok(result.structuredContent);
  const content = Array.isArray(result.content) ? result.content : [];
  assert.equal(content.some((item) => item?.type === "text"), false);
  return result.structuredContent;
}
