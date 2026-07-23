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
