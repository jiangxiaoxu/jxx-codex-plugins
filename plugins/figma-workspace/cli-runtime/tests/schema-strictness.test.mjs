import assert from "node:assert/strict";
import test from "node:test";
import {
  createFigmaWorkspaceClient,
  getFigmaWorkspaceCommandInputSchema,
} from "../dist/runtime/workspace-runtime.js";

test("all public boolean inputs reject string coercion", async () => {
  const client = createStrictnessClient();
  const cases = [
    ["open", { reset: "false" }, "reset"],
    ["open", { connect: "false" }, "connect"],
    ["eval", { code: "return true;", typescript: "false" }, "typescript"],
    ["applyAssetManifest", { assets: [], validateTargets: "false" }, "validateTargets"],
    ["captureNode", { target: "1:2", contentsOnly: "false" }, "contentsOnly"],
    ["prepareTask", { taskName: "strict", workspaceDir: process.cwd(), overwrite: "false" }, "overwrite"],
    ["getMetadata", { refresh: "false" }, "refresh"],
    ["getDesignContext", { target: "1:2", forceCode: "false" }, "forceCode"],
    ["getDesignContext", { target: "1:2", disableCodeConnect: "false" }, "disableCodeConnect"],
    ["getDesignContext", { target: "1:2", excludeScreenshot: "false" }, "excludeScreenshot"],
    ["getDesignContext", { target: "1:2", refresh: "false" }, "refresh"],
    ["getMotionContext", { target: "1:2", recursive: "false" }, "recursive"],
    ["getMotionContext", { target: "1:2", refresh: "false" }, "refresh"],
    ["searchDesignSystem", { query: "button", disableCodeConnect: "false" }, "disableCodeConnect"],
    ["searchDesignSystem", { query: "button", includeComponents: "false" }, "includeComponents"],
    ["searchDesignSystem", { query: "button", includeVariables: "false" }, "includeVariables"],
    ["searchDesignSystem", { query: "button", includeStyles: "false" }, "includeStyles"],
    ["searchDesignSystem", { query: "button", refresh: "false" }, "refresh"],
    ["getLibraries", { refresh: "false" }, "refresh"],
    ["getVariableDefs", { target: "1:2", refresh: "false" }, "refresh"],
    ["callUpstreamTool", { toolName: "whoami", arguments: {}, refresh: "false" }, "refresh"],
    ["sessionsInfo", { includeHistory: "false" }, "includeHistory"],
    ["upstreamTools", { refresh: "false" }, "refresh"],
  ];

  try {
    for (const [method, input, field] of cases) {
      await assert.rejects(client[method](input), new RegExp(`${field}.*boolean`, "iu"), `${method}.${field}`);
    }
  } finally {
    await client.close();
  }
});

test("public numeric and array inputs reject wrong types and invalid bounds", async () => {
  const client = createStrictnessClient();
  const numericCases = [
    ["eval", { code: "return true;", inlineResultLimit: "1" }, "inlineResultLimit"],
    ["runScriptFile", { scriptPath: "unused.figma.ts", inlineResultLimit: "1" }, "inlineResultLimit"],
    ["downloadAssets", { targets: [{ target: "1:2", defaultScale: "1" }] }, "defaultScale"],
    ["captureNode", { target: "1:2", maxDimension: "100" }, "maxDimension"],
    ["guidance", { query: "text", maxCards: "4" }, "maxCards"],
    ["inspect", { depth: "2" }, "depth"],
    ["getMetadata", { inlineResultLimit: "1" }, "inlineResultLimit"],
    ["getDesignContext", { target: "1:2", inlineResultLimit: "1" }, "inlineResultLimit"],
    ["getMotionContext", { target: "1:2", inlineResultLimit: "1" }, "inlineResultLimit"],
    ["searchDesignSystem", { query: "button", inlineResultLimit: "1" }, "inlineResultLimit"],
    ["getLibraries", { offset: "0" }, "offset"],
    ["getLibraries", { inlineResultLimit: "1" }, "inlineResultLimit"],
    ["getVariableDefs", { target: "1:2", inlineResultLimit: "1" }, "inlineResultLimit"],
    ["callUpstreamTool", { toolName: "whoami", arguments: {}, inlineResultLimit: "1" }, "inlineResultLimit"],
    ["lookup", { kind: "docs", query: "text", maxResults: "2" }, "maxResults"],
    ["lookup", { kind: "docs", query: "text", maxSnippetLines: "2" }, "maxSnippetLines"],
    ["docs", { mode: "catalog", limit: "2" }, "limit"],
  ];
  const arrayCases = [
    ["applyAssetManifest", { assets: {} }, "assets"],
    ["downloadAssets", { targets: {} }, "targets"],
    ["searchDesignSystem", { query: "button", includeLibraryKeys: {} }, "includeLibraryKeys"],
    ["searchDesignSystem", { query: "button", includeLibraryKeys: [7] }, "includeLibraryKeys\\[0\\]"],
  ];

  try {
    for (const [method, input, field] of numericCases) {
      await assert.rejects(client[method](input), new RegExp(field, "u"), `${method}.${field}`);
    }
    for (const [method, input, field] of arrayCases) {
      await assert.rejects(client[method](input), new RegExp(field, "u"), `${method}.${field}`);
    }
    await assert.rejects(
      client.applyAssetManifest({ assets: Array.from({ length: 65 }, () => ({ path: "asset.png", target: "1:2" })) }),
      /assets.*at most 64/iu,
    );
    await assert.rejects(
      client.downloadAssets({ targets: Array.from({ length: 65 }, () => ({ target: "1:2" })) }),
      /targets.*at most 64/iu,
    );
  } finally {
    await client.close();
  }
});

test("top-level and canonical nested objects reject unknown fields", async () => {
  const client = createStrictnessClient();
  const topLevelCases = [
    ["open", { unexpected: true }],
    ["eval", { code: "return true;", unexpected: true }],
    ["runScriptFile", { scriptPath: "unused.figma.ts", unexpected: true }],
    ["applyAssetManifest", { assets: [], unexpected: true }],
    ["downloadAssets", { targets: [], unexpected: true }],
    ["captureNode", { target: "1:2", unexpected: true }],
    ["prepareTask", { taskName: "strict", workspaceDir: process.cwd(), unexpected: true }],
    ["guidance", { query: "text", unexpected: true }],
    ["inspect", { unexpected: true }],
    ["getMetadata", { unexpected: true }],
    ["getDesignContext", { target: "1:2", unexpected: true }],
    ["getMotionContext", { target: "1:2", unexpected: true }],
    ["searchDesignSystem", { query: "button", unexpected: true }],
    ["getLibraries", { unexpected: true }],
    ["getVariableDefs", { target: "1:2", unexpected: true }],
    ["callUpstreamTool", { toolName: "whoami", arguments: {}, unexpected: true }],
    ["lookup", { kind: "docs", query: "text", unexpected: true }],
    ["docs", { mode: "list", unexpected: true }],
    ["doctor", { unexpected: true }],
    ["sessionsInfo", { unexpected: true }],
    ["upstreamTools", { unexpected: true }],
  ];

  try {
    for (const [method, input] of topLevelCases) {
      await assert.rejects(client[method](input), /unknown field.*unexpected/iu, method);
    }
    for (const input of [
      { assets: [{ path: "asset.png", target: "1:2", nodeUrl: "https://example.invalid" }] },
      { assets: [{ path: "asset.png", target: "1:2", scaleMode: "FILL" }] },
      { assets: [{ path: "asset.png", target: { fileKey: "Example", nodeId: "1:2", unexpected: true } }] },
    ]) {
      await assert.rejects(client.applyAssetManifest(input), /unknown field|exactly non-empty string fileKey and nodeId/iu);
    }
    await assert.rejects(
      client.downloadAssets({ targets: [{ target: "1:2", unexpected: true }] }),
      /unknown field.*unexpected/iu,
    );
    await assert.rejects(
      client.captureNode({ target: { fileKey: "Example", nodeId: "1:2", unexpected: true } }),
      /exactly non-empty string fileKey and nodeId/iu,
    );
  } finally {
    await client.close();
  }
});

test("asset help schema matches the canonical parser allowlist", () => {
  const schema = getFigmaWorkspaceCommandInputSchema("apply-asset-manifest");
  const assets = schema.properties.assets;
  assert.equal(assets.type, "array");
  assert.equal(assets.maxItems, 64);
  assert.equal(assets.items.additionalProperties, false);
  assert.deepEqual(Object.keys(assets.items.properties), ["path", "target", "name", "metadata"]);
  assert.equal("nodeUrl" in assets.items.properties, false);
  assert.equal("url" in assets.items.properties, false);
  assert.equal("scaleMode" in assets.items.properties, false);
});

test("help schema publishes the unified 4096-byte backend inline default", () => {
  for (const command of ["eval", "run-script-file", "get-metadata", "call-upstream-tool"]) {
    const schema = getFigmaWorkspaceCommandInputSchema(command);
    assert.equal(schema.properties.inlineResultLimit.default, 4096, command);
  }
});

function createStrictnessClient() {
  return createFigmaWorkspaceClient({
    client: {
      async connect() {
        throw new Error("unexpected upstream connection");
      },
      async close() {},
      async listTools() {
        throw new Error("unexpected upstream tool listing");
      },
      async callTool() {
        throw new Error("unexpected upstream call");
      },
    },
  });
}
