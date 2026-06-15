import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import test from "node:test";

test("build publishes CLI and TypeScript declaration contract", async () => {
  const [packageJson, cliSource, declarations] = await Promise.all([
    readFile(new URL("../package.json", import.meta.url), "utf8"),
    readFile(new URL("../dist/stdio-cli.js", import.meta.url), "utf8"),
    readFile(new URL("../dist/index.d.ts", import.meta.url), "utf8"),
  ]);
  const distFiles = await readdir(new URL("../dist/", import.meta.url));
  const packageData = JSON.parse(packageJson);

  assert.equal(packageData.types, "./dist/index.d.ts");
  assert.equal(packageData.bin["figma-mcp-stdio-bridge"], "./dist/stdio-cli.js");
  assert.match(cliSource, /^#!\/usr\/bin\/env node\n/);
  assert.match(declarations, /startFigmaStdioMcpServer/);
  assert.match(declarations, /StartFigmaStdioMcpServerOptions/);
  assert.equal(distFiles.some((file) => file.endsWith(".d.ts.map")), false);
});
