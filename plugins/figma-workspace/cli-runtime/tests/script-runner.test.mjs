import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { compileFigmaWorkspaceTypescriptSource } from "../dist/runtime/typescript-compiler-runtime.js";

test("script diagnostics route recovery through stateless public leaves", async () => {
  const [runnerSource, compilerSource] = await Promise.all([
    readFile(new URL("../src/runtime/script-runner.ts", import.meta.url), "utf8"),
    readFile(new URL("../src/runtime/typescript-compiler-runtime.ts", import.meta.url), "utf8"),
  ]);
  assert.match(runnerSource, /figma:run --file <url\|key>/u);
  assert.match(runnerSource, /--script <path\.figma\.ts> or --source -/u);
  assert.match(runnerSource, /\/\/ figma:run source:/u);
  assert.doesNotMatch(`${runnerSource}\n${compilerSource}`, /figma:script:run|--state-file|lookup kind=/u);

  const typeError = compileFigmaWorkspaceTypescriptSource(
    "type-error.figma.ts",
    "figma.currentPage.appendChild(figma.createPage());",
  ).diagnostics.find((diagnostic) => diagnostic.code === "FIGMA_WORKSPACE_TS_TYPE_ERROR");
  assert.ok(typeError);
  assert.equal(typeError.docsHint, "Figma Workspace CLI: figma:api:search ChildrenMixin.appendChild");
  assert.doesNotMatch(typeError.docsHint, /lookup kind=/u);
});

test("script preflight blocks private plugin data member calls without matching text or shared data calls", () => {
  const source = [
    "const node = figma.currentPage;",
    "// node.getPluginData(\"comment\");",
    "const example = 'node.setPluginData(\"string\", \"value\")';",
    "node.getPluginData(\"private-read\");",
    "node[\"setPluginData\"](\"private-write\", \"value\");",
    "node.getSharedPluginData(\"namespace\", \"shared-read\");",
    "node.setSharedPluginData(\"namespace\", \"shared-write\", \"value\");",
    "return { example };",
  ].join("\n");
  const diagnostics = compileFigmaWorkspaceTypescriptSource(
    "private-plugin-data.figma.ts",
    source,
  ).diagnostics.filter((diagnostic) => diagnostic.code === "FIGMA_WORKSPACE_PRIVATE_PLUGIN_DATA_UNSUPPORTED");

  assert.deepEqual(
    diagnostics.map(({ message, source: location }) => [message, location.line, location.column]),
    [
      ["Figma's use_figma host rejects private plugin data calls such as getPluginData().", 4, 1],
      ["Figma's use_figma host rejects private plugin data calls such as setPluginData().", 5, 1],
    ],
  );
  for (const diagnostic of diagnostics) {
    assert.equal(diagnostic.severity, "fatal");
    assert.match(diagnostic.suggestion, /stable node IDs or names.*narrow read-back/iu);
  }
});

test("script preflight allows non-Figma objects with private-plugin-data method names", () => {
  const source = [
    "const cache = {",
    "  getPluginData(key: string) { return key; },",
    "  setPluginData(_key: string, _value: string) {},",
    "};",
    "const value = cache.getPluginData(\"domain-read\");",
    "cache[\"setPluginData\"](\"domain-write\", value);",
    "return { value };",
  ].join("\n");
  const diagnostics = compileFigmaWorkspaceTypescriptSource(
    "non-figma-plugin-data.figma.ts",
    source,
  ).diagnostics.filter((diagnostic) => diagnostic.code === "FIGMA_WORKSPACE_PRIVATE_PLUGIN_DATA_UNSUPPORTED");

  assert.deepEqual(diagnostics, []);
});
