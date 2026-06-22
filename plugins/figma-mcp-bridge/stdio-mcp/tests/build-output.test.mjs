import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import test from "node:test";

test("build publishes CLI and TypeScript declaration contract", async () => {
  const [
    packageJson,
    cliSource,
    replCliSource,
    apiDeclarations,
    cliDeclarations,
    replDeclarations,
    nodeReplDeclarations,
  ] =
    await Promise.all([
    readFile(new URL("../package.json", import.meta.url), "utf8"),
    readFile(new URL("../dist/stdio-cli.js", import.meta.url), "utf8"),
    readFile(new URL("../dist/repl-stdio-cli.js", import.meta.url), "utf8"),
    readFile(new URL("../dist/index.d.ts", import.meta.url), "utf8"),
    readFile(new URL("../dist/cli.d.ts", import.meta.url), "utf8"),
    readFile(new URL("../dist/repl-server.d.ts", import.meta.url), "utf8"),
    readFile(new URL("../dist/node-repl.d.ts", import.meta.url), "utf8"),
  ]);
  const distFiles = await readdir(new URL("../dist/", import.meta.url));
  const packageData = JSON.parse(packageJson);

  assert.equal(packageData.types, "./dist/index.d.ts");
  assert.equal(packageData.exports["."].types, "./dist/index.d.ts");
  assert.equal(packageData.exports["./cli"].types, "./dist/cli.d.ts");
  assert.equal(packageData.exports["./repl"].types, "./dist/repl-server.d.ts");
  assert.equal(packageData.exports["./node-repl"].types, "./dist/node-repl.d.ts");
  assert.equal(packageData.bin["figma-mcp-stdio-bridge"], "./dist/stdio-cli.js");
  assert.equal(packageData.bin["figma-repl-mcp"], "./dist/repl-stdio-cli.js");
  assert.match(cliSource, /^#!\/usr\/bin\/env node\n/);
  assert.match(replCliSource, /^#!\/usr\/bin\/env node\n/);
  assert.match(apiDeclarations, /createFigmaStdioMcpServer/);
  assert.match(apiDeclarations, /createRemoteMcpClient/);
  assert.match(apiDeclarations, /createFigmaReplClient/);
  assert.match(apiDeclarations, /createFigmaReplMcpServer/);
  assert.match(apiDeclarations, /FigmaReplApplyAssetManifestArguments/);
  assert.match(apiDeclarations, /FigmaReplApplyAssetManifestResult/);
  assert.match(apiDeclarations, /FigmaReplCaptureNodeArguments/);
  assert.match(apiDeclarations, /FigmaReplCaptureNodeResult/);
  assert.match(apiDeclarations, /FigmaReplRunTaskPlanArguments/);
  assert.match(apiDeclarations, /FigmaReplUpstreamEnvelope/);
  assert.match(apiDeclarations, /FigmaReplToolResultBase/);
  assert.doesNotMatch(apiDeclarations, /runFigmaStdioMcpCli/);
  assert.doesNotMatch(apiDeclarations, /startFigmaStdioMcpServer/);
  assert.match(cliDeclarations, /runFigmaStdioMcpCli/);
  assert.match(replDeclarations, /createFigmaReplClient/);
  assert.match(replDeclarations, /export interface FigmaReplUpstreamEnvelope/);
  assert.match(replDeclarations, /export interface FigmaReplPublicUpstreamError/);
  assert.match(replDeclarations, /export interface FigmaReplFilePointer/);
  assert.match(replDeclarations, /export interface FigmaReplToolResultBase/);
  assert.doesNotMatch(replDeclarations, /eval\(args: FigmaReplEvalArguments\): Promise<unknown>/);
  assert.doesNotMatch(replDeclarations, /runScriptFile\(args: FigmaReplRunScriptFileArguments\): Promise<unknown>/);
  assert.doesNotMatch(replDeclarations, /applyAssetManifest\(args: FigmaReplApplyAssetManifestArguments\): Promise<unknown>/);
  assert.doesNotMatch(replDeclarations, /captureNode\(args: FigmaReplCaptureNodeArguments\): Promise<unknown>/);
  assert.doesNotMatch(replDeclarations, /callUpstreamTool\(args: FigmaReplCallUpstreamToolArguments\): Promise<unknown>/);
  assert.match(nodeReplDeclarations, /createRemoteMcpClient/);
  assert.match(nodeReplDeclarations, /installNodeReplWebStreamGlobals/);
  assert.match(replDeclarations, /eval\(args: FigmaReplEvalArguments\): Promise<FigmaReplEvalResult>/);
  assert.match(replDeclarations, /runScriptFile\(args: FigmaReplRunScriptFileArguments\): Promise<FigmaReplRunScriptFileResult>/);
  assert.match(replDeclarations, /applyAssetManifest\(args: FigmaReplApplyAssetManifestArguments\): Promise<FigmaReplApplyAssetManifestResult>/);
  assert.match(replDeclarations, /captureNode\(args: FigmaReplCaptureNodeArguments\): Promise<FigmaReplCaptureNodeResult>/);
  assert.match(replDeclarations, /runTaskPlan\(args: FigmaReplRunTaskPlanArguments\): Promise<FigmaReplRunTaskPlanResult>/);
  assert.match(replDeclarations, /callUpstreamTool\(args: FigmaReplCallUpstreamToolArguments\): Promise<FigmaReplCallUpstreamToolResult>/);
  assert.match(replDeclarations, /@internal[\s\S]*Internal wrapper builder[\s\S]*buildFigmaEvalScript/);
  assert.match(replDeclarations, /@internal[\s\S]*Internal-facing helper-selection utility[\s\S]*resolveFigmaReplScriptHelperSelection/);
  assert.equal(distFiles.includes("node-repl.js"), true);
  assert.equal(distFiles.includes("repl-cli.js"), true);
  assert.equal(distFiles.includes("repl-server.js"), true);
  assert.equal(distFiles.includes("repl-stdio-cli.js"), true);
  assert.equal(distFiles.some((file) => file.endsWith(".d.ts.map")), false);
});
