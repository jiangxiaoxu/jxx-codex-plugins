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
  ] =
    await Promise.all([
    readFile(new URL("../package.json", import.meta.url), "utf8"),
    readFile(new URL("../dist/stdio-cli.js", import.meta.url), "utf8"),
    readFile(new URL("../dist/repl-stdio-cli.js", import.meta.url), "utf8"),
    readFile(new URL("../dist/index.d.ts", import.meta.url), "utf8"),
    readFile(new URL("../dist/cli.d.ts", import.meta.url), "utf8"),
    readFile(new URL("../dist/repl-server.d.ts", import.meta.url), "utf8"),
  ]);
  const distFiles = await readdir(new URL("../dist/", import.meta.url));
  const packageData = JSON.parse(packageJson);

  assert.equal(packageData.types, "./dist/index.d.ts");
  assert.equal(packageData.exports["."].types, "./dist/index.d.ts");
  assert.equal(packageData.exports["./cli"].types, "./dist/cli.d.ts");
  assert.equal(packageData.exports["./repl"].types, "./dist/repl-server.d.ts");
  assert.equal(packageData.bin["figma-mcp-stdio-bridge"], "./dist/stdio-cli.js");
  assert.equal(packageData.bin["figma-repl-mcp"], "./dist/repl-stdio-cli.js");
  assert.match(cliSource, /^#!\/usr\/bin\/env node\n/);
  assert.match(replCliSource, /^#!\/usr\/bin\/env node\n/);
  assert.match(apiDeclarations, /createFigmaStdioMcpServer/);
  assert.match(apiDeclarations, /createFigmaReplClient/);
  assert.match(apiDeclarations, /createFigmaReplMcpServer/);
  assert.doesNotMatch(apiDeclarations, /compileFigmaReplOps/);
  assert.doesNotMatch(apiDeclarations, /FigmaReplApplyOpsArguments/);
  assert.doesNotMatch(apiDeclarations, /type FigmaReplOp(?:,|\s|})/);
  assert.doesNotMatch(apiDeclarations, /runFigmaStdioMcpCli/);
  assert.doesNotMatch(apiDeclarations, /startFigmaStdioMcpServer/);
  assert.match(cliDeclarations, /runFigmaStdioMcpCli/);
  assert.match(replDeclarations, /createFigmaReplClient/);
  assert.doesNotMatch(replDeclarations, /compileFigmaReplOps/);
  assert.doesNotMatch(replDeclarations, /FigmaReplApplyOpsArguments/);
  assert.doesNotMatch(replDeclarations, /type FigmaReplOp(?:,|\s|})/);
  assert.equal(distFiles.includes("repl-cli.js"), true);
  assert.equal(distFiles.includes("repl-server.js"), true);
  assert.equal(distFiles.includes("repl-stdio-cli.js"), true);
  assert.equal(distFiles.some((file) => file.endsWith(".d.ts.map")), false);
});
