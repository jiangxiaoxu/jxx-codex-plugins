import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { createFigmaWorkspaceClient } from "../dist/runtime/workspace-runtime.js";

const FILE_KEY = "A".repeat(22);

function client() {
  return createFigmaWorkspaceClient({ client: { connect: async()=>{}, close: async()=>{}, listTools: async()=>({tools:[]}), callTool: async()=>({}) } });
}

test("stateless invocation arguments are strict and reject removed state fields", async () => {
  const current = client();
  try {
    for (const input of [
      { file: FILE_KEY, surface: "design", source: "return {};", sessionId: "legacy" },
      { file: FILE_KEY, surface: "design", source: "return {};", workspaceDir: "C:/legacy" },
      { file: FILE_KEY, surface: "design", source: "return {};", inputFile: "legacy.figma.ts" },
      { file: FILE_KEY, surface: "design", source: "return {};", unexpected: true },
    ]) await assert.rejects(current.run(input), /removed|unknown field/iu);
  } finally { await current.close(); }
});

test("public stateless metadata excludes retired session and local-only fields", async () => {
  const [wrapperContracts, toolArguments, toolMetadata] = await Promise.all([
    readFile(new URL("../src/contract/wrapper-contracts.ts", import.meta.url), "utf8"),
    readFile(new URL("../src/contract/tool-args.ts", import.meta.url), "utf8"),
    readFile(new URL("../src/contract/tool-metadata.ts", import.meta.url), "utf8"),
  ]);
  assert.doesNotMatch(wrapperContracts, /\blocalOnly\b|\bsessionId\b|\bworkspaceDir\b/iu);
  assert.doesNotMatch(toolArguments, /\bsessionId\b|\bworkspaceDir\b/iu);
  assert.doesNotMatch(toolMetadata, /\bsessionId\b|\bworkspaceDir\b|\blocalOnly\b/iu);
});

test("run requires exactly one strict TypeScript source and explicit file", async () => {
  const current = client();
  try {
    await assert.rejects(current.run({ source: "return {};" }), /requires "file"/iu);
    await assert.rejects(current.run({ file: FILE_KEY, surface: "design" }), /Exactly one/iu);
    await assert.rejects(current.run({ file: FILE_KEY, surface: "design", source: "return {};", scriptPath: "x.figma.ts" }), /Exactly one/iu);
    await assert.rejects(current.run({ file: FILE_KEY, source: "return {};" }), /surface/iu);
  } finally { await current.close(); }
});

test("stable node inputs reject dynamic selectors and incomplete context", async () => {
  const current = client();
  try {
    for (const target of ["$selection", "$currentPage", "$legacy"]) {
      await assert.rejects(current.inspect({ file: `https://www.figma.com/design/${FILE_KEY}/UI`, target }), /stable|dynamic|does not accept/iu);
    }
    await assert.rejects(current.captureNode({ target: "1:2" }), /requires "file"/iu);
    await assert.rejects(current.getDesignContext({ file: FILE_KEY, surface: "design", target: { fileKey: FILE_KEY } }), /exact|nodeId/iu);
  } finally { await current.close(); }
});

test("boolean, numeric, and nested arrays do not coerce", async () => {
  const current = client();
  try {
    await assert.rejects(current.captureNode({ file: FILE_KEY, surface: "design", target: "1:2", contentsOnly: "false" }), /contentsOnly.*boolean/iu);
    await assert.rejects(current.inspect({ file: FILE_KEY, surface: "design", target: "1:2", depth: "2" }), /depth.*integer/iu);
    await assert.rejects(current.searchDesignSystem({ file: FILE_KEY, surface: "design", query: "button", includeLibraryKeys: [7] }), /includeLibraryKeys.*string array/iu);
    await assert.rejects(current.applyAssetManifest({ file: FILE_KEY, surface: "design", assets: Array.from({length:65},()=>({path:"x",target:"1:2"})) }), /at most 64/iu);
  } finally { await current.close(); }
});

test("non-display numeric boundaries remain strict", async () => {
  const current = client();
  try {
    await assert.rejects(
      current.captureNode({ file: FILE_KEY, surface: "design", target: "1:2", maxDimension: 65_537 }),
      /maxDimension.*1 to 65536/iu,
    );
    await assert.rejects(
      current.inspect({ file: FILE_KEY, surface: "design", target: "1:2", depth: 0 }),
      /depth.*1 to 9007199254740991/iu,
    );
    await assert.rejects(
      current.getLibraries({ file: FILE_KEY, surface: "design", offset: -1 }),
      /offset.*0 to 9007199254740991/iu,
    );
    await assert.rejects(
      current.getMetadata({ file: FILE_KEY, surface: "design", inlineResultLimit: 10_001 }),
      /inlineResultLimit.*0 to 10000/iu,
    );
  } finally { await current.close(); }
});
