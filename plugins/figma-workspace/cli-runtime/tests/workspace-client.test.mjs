import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";
import {
  createFigmaWorkspaceClient,
} from "../dist/runtime/workspace-runtime.js";

const FILE_KEY = "EctrdKKdR3c8JTPl55qn3r";
const OTHER_FILE_KEY = "B".repeat(22);
const FILE_URL = `https://www.figma.com/design/${FILE_KEY}/Untitled`;
const NODE_URL = `${FILE_URL}?node-id=230-2&t=ignored`;

function fakeUpstream(calls, responder) {
  return {
    async connect() { calls.push({ kind: "connect" }); },
    async close() { calls.push({ kind: "close" }); },
    async listTools() {
      return { tools: [
        { name: "use_figma", inputSchema: { type: "object", required: ["code", "description", "fileKey"], properties: { code: {}, description: {}, fileKey: {} } } },
        { name: "get_screenshot", inputSchema: { type: "object", required: ["fileKey", "nodeId"], properties: { fileKey: {}, nodeId: {}, maxDimension: {}, contentsOnly: {}, enableBase64Response: {} } } },
        { name: "get_metadata", inputSchema: { type: "object", required: ["fileKey"], properties: { fileKey: {}, nodeId: {} } } },
        { name: "get_design_context", inputSchema: { type: "object", required: ["fileKey", "nodeId"], properties: { fileKey: {}, nodeId: {} } } },
        { name: "get_motion_context", inputSchema: { type: "object", required: ["fileKey", "nodeId"], properties: { fileKey: {}, nodeId: {} } } },
        { name: "get_variable_defs", inputSchema: { type: "object", required: ["fileKey", "nodeId"], properties: { fileKey: {}, nodeId: {} } } },
        { name: "search_design_system", inputSchema: { type: "object", required: ["fileKey", "query"], properties: { fileKey: {}, query: {} } } },
        { name: "get_libraries", inputSchema: { type: "object", required: ["fileKey"], properties: { fileKey: {} } } },
      ] };
    },
    async callTool(name, args) {
      calls.push({ kind: "call", name, args });
      return responder ? responder(name, args) : { content: [{ type: "text", text: JSON.stringify({ ok: true, result: { name } }) }] };
    },
  };
}

function invocationIdFromCode(code) {
  return /invocationId:\s*"([^"]+)"/u.exec(code)?.[1];
}

test("client exposes stateless operations and removes session/open/eval APIs", () => {
  const client = createFigmaWorkspaceClient({ client: fakeUpstream([]) });
  for (const removed of ["sessions", "open", "eval", "runScriptFile", "prepareTask", "guidance", "sessionsInfo"]) {
    assert.equal(removed in client, false, removed);
  }
  assert.equal(typeof client.run, "function");
  assert.equal(typeof client.doctor, "function");
});

test("run strict-compiles stdin TypeScript with explicit file context", async () => {
  const directory = await mkdtemp(resolve(tmpdir(), "figma-stateless-client-run-"));
  const calls = [];
  const client = createFigmaWorkspaceClient({
    invocationId: "invocation-test",
    client: fakeUpstream(calls, (_name, args) => ({
      content: [{ type: "text", text: JSON.stringify({
        ok: true,
        __figmaWorkspace: { invocationId: invocationIdFromCode(args.code), currentPageId: "1:1", knownPages: { "1:1": "Page" }, captureRequests: [] },
        result: { changedNodeIds: ["230:2"] },
      }) }],
    })),
  });
  try {
    const result = await client.run({ file: FILE_URL, source: "const frame: FrameNode = figma.createFrame(); return { changedNodeIds: [frame.id] };", outputDir: directory });
    assert.equal(result.executionOutcome, "succeeded");
    assert.equal(result.ok, true);
    const call = calls.find((entry) => entry.kind === "call" && entry.name === "use_figma");
    assert.equal(call.args.fileKey, FILE_KEY);
    assert.match(call.args.code, /invocationId: "invocation-test"/u);
    assert.doesNotMatch(call.args.code, /sessionId/u);
  } finally {
    await client.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("run returns not_started for TypeScript diagnostics and does not dispatch", async () => {
  const calls = [];
  const client = createFigmaWorkspaceClient({ client: fakeUpstream(calls) });
  const result = await client.run({ file: FILE_URL, source: "const value: string = 123; return value;" });
  assert.equal(result.ok, false);
  assert.equal(result.executionOutcome, "not_started");
  assert.ok(result.diagnostics.some((entry) => entry.severity === "fatal"));
  assert.equal(calls.some((entry) => entry.kind === "call"), false);
  await client.close();
});

test("run blocks private plugin data calls before dispatch", async () => {
  const calls = [];
  const client = createFigmaWorkspaceClient({ client: fakeUpstream(calls) });
  const result = await client.run({
    file: FILE_URL,
    source: "const node = figma.currentPage; node.setPluginData('key', 'value'); return {};",
  });
  const diagnostic = result.diagnostics.find((entry) => entry.code === "FIGMA_WORKSPACE_PRIVATE_PLUGIN_DATA_UNSUPPORTED");

  assert.equal(result.ok, false);
  assert.equal(result.phase, "preflight");
  assert.equal(result.executionOutcome, "not_started");
  assert.equal(diagnostic.severity, "fatal");
  assert.match(diagnostic.suggestion, /stable node IDs or names.*narrow read-back/iu);
  assert.equal(calls.some((entry) => entry.kind === "call"), false);
  await client.close();
});

test("run marks direct returned use_figma script errors as atomic failures", async () => {
  for (const [description, response, expectedError] of [
    [
      "structured ok:false error",
      { content: [{ type: "text", text: JSON.stringify({ ok: false, error: { message: "Plugin host rejected the mutation.", code: "FIGMA_HOST_MUTATION_REJECTED" } }) }] },
      { message: "Plugin host rejected the mutation.", code: "FIGMA_HOST_MUTATION_REJECTED" },
    ],
    [
      "bare Error text",
      { content: [{ type: "text", text: "Error: Plugin host rejected the mutation." }] },
      { message: "Error: Plugin host rejected the mutation.", code: "FIGMA_UPSTREAM_TEXT_ERROR" },
    ],
  ]) {
    const calls = [];
    const client = createFigmaWorkspaceClient({
      client: fakeUpstream(calls, () => response),
    });
    try {
      const result = await client.run({ file: FILE_URL, source: "return {};" });
      assert.equal(result.ok, false, description);
      assert.equal(result.executionOutcome, "failed_atomic", description);
      assert.equal(result.upstreamError.message, expectedError.message, description);
      assert.equal(result.upstreamError.code, expectedError.code, description);
      assert.match(result.retryGuidance, /made no file changes.*retry safely/iu, description);
      assert.equal(calls.some((entry) => entry.kind === "call" && entry.name === "use_figma"), true, description);
    } finally {
      await client.close();
    }
  }
});

test("run keeps a truncated use_figma response outcome unknown", async () => {
  const client = createFigmaWorkspaceClient({
    client: fakeUpstream([], () => ({
      content: [{ type: "text", text: "truncated to 8KB" }],
    })),
  });
  try {
    const result = await client.run({ file: FILE_URL, source: "return {};" });
    assert.equal(result.ok, false);
    assert.equal(result.executionOutcome, "outcome_unknown");
    assert.equal(result.upstreamError.code, "FIGMA_UPSTREAM_TRUNCATED");
    assert.match(result.retryGuidance, /Do not rerun the mutation blindly/u);
  } finally {
    await client.close();
  }
});

test("run keeps oversized host-error diagnostics in the sidecar", async () => {
  const directory = await mkdtemp(resolve(tmpdir(), "figma-host-error-sidecar-"));
  const client = createFigmaWorkspaceClient({
    client: fakeUpstream([], () => ({
      content: [{ type: "text", text: JSON.stringify({
        ok: false,
        error: {
          code: "FIGMA_HOST_REJECTED",
          message: "Figma host rejected the mutation.",
          details: { diagnosticPayload: "x".repeat(2_048) },
        },
      }) }],
    })),
  });
  try {
    const result = await client.run({
      file: FILE_URL,
      source: "return {};",
      outputDir: directory,
      inlineResultLimit: 64,
    });
    assert.equal(result.executionOutcome, "failed_atomic");
    assert.equal(result.upstreamError.code, "FIGMA_HOST_REJECTED");
    assert.equal(result.upstreamError.message, "Figma host rejected the mutation.");
    assert.equal(result.upstreamError.details, undefined);
    assert.deepEqual(
      result.inlineResultLimit.omitted.map(({ field }) => field).sort(),
      ["upstream.result", "upstreamError.details"],
    );
    assert.match(await readFile(result.outputFiles.debugFile.path, "utf8"), /diagnosticPayload/u);
  } finally {
    await client.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("stable target URL normalizes URL node-id and ignores slug/t parameter", async () => {
  const calls = [];
  const client = createFigmaWorkspaceClient({ client: fakeUpstream(calls) });
  const result = await client.getDesignContext({ target: NODE_URL });
  assert.equal(result.fileKey, FILE_KEY);
  assert.equal(result.nodeId, "230:2");
  const call = calls.find((entry) => entry.name === "get_design_context");
  assert.deepEqual(call.args, { fileKey: FILE_KEY, nodeId: "230:2" });
  await client.close();
});

test("raw node ids require explicit file and dynamic selectors are rejected", async () => {
  const client = createFigmaWorkspaceClient({ client: fakeUpstream([]) });
  await assert.rejects(client.getDesignContext({ target: "230:2" }), /requires "file"/iu);
  await assert.rejects(client.getDesignContext({ file: FILE_URL, target: "$selection" }), /stable|no longer accepts|dynamic/iu);
  await assert.rejects(client.getDesignContext({ file: OTHER_FILE_KEY, target: NODE_URL, surface: "design" }), /conflicting file contexts/iu);
  await client.close();
});

test("raw file keys require explicit surface for Plugin API execution", async () => {
  const client = createFigmaWorkspaceClient({ client: fakeUpstream([]) });
  await assert.rejects(client.run({ file: FILE_KEY, source: "return {};" }), /surface.*raw Figma file key/iu);
  await assert.rejects(client.inspect({ file: FILE_KEY, target: "230:2" }), /surface.*raw Figma file key/iu);
  await assert.rejects(client.applyAssetManifest({ file: FILE_KEY, assets: [{ path: "asset.png", target: "230:2" }] }), /surface.*raw Figma file key/iu);
  await client.close();
});

test("official read wrappers accept raw file keys without surface", async () => {
  const calls = [];
  const client = createFigmaWorkspaceClient({ client: fakeUpstream(calls) });
  await client.getMetadata({ file: FILE_KEY });
  await client.getDesignContext({ file: FILE_KEY, target: "230:2" });
  await client.getMotionContext({ file: FILE_KEY, target: "230:2" });
  await client.getVariableDefs({ file: FILE_KEY, target: "230:2" });
  await client.searchDesignSystem({ file: FILE_KEY, query: "button" });
  await client.getLibraries({ file: FILE_KEY });
  assert.ok(calls.some((entry) => entry.name === "get_metadata"));
  assert.ok(calls.some((entry) => entry.name === "get_design_context"));
  assert.ok(calls.some((entry) => entry.name === "get_motion_context"));
  assert.ok(calls.some((entry) => entry.name === "get_variable_defs"));
  assert.ok(calls.some((entry) => entry.name === "search_design_system"));
  assert.ok(calls.some((entry) => entry.name === "get_libraries"));
  await client.close();
});

test("metadata defaults to a 2048-byte field limit and honors an explicit override", async () => {
  const directory = await mkdtemp(resolve(tmpdir(), "figma-metadata-default-inline-limit-"));
  const xml = `<frame name="${"x".repeat(3_000)}"/>`;
  const calls = [];
  const client = createFigmaWorkspaceClient({
    invocationId: "metadata-inline-limit-test",
    client: fakeUpstream(calls, (name) => name === "get_metadata"
      ? { content: [{ type: "text", text: xml }] }
      : { content: [{ type: "text", text: JSON.stringify({ ok: true }) }] }),
  });
  try {
    const limited = await client.getMetadata({ file: FILE_KEY, outputDir: directory });
    assert.equal(limited.metadata.json, undefined);
    assert.equal(limited.inlineResultLimit.limitBytes, 2_048);
    assert.deepEqual(limited.inlineResultLimit.omitted.map(({ field }) => field), ["metadata.json"]);
    assert.match(await readFile(limited.outputFiles.metadataFile.path, "utf8"), /"name": "x{100}/u);

    const expanded = await client.getMetadata({ file: FILE_KEY, outputDir: directory, inlineResultLimit: 10_000 });
    assert.equal(expanded.metadata.json.root.name.length, 3_000);
    assert.equal(expanded.inlineResultLimit, undefined);
  } finally {
    await client.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("live schema filtering skips unadvertised optional context hints and reports them", async () => {
  const calls = [];
  const client = createFigmaWorkspaceClient({ client: fakeUpstream(calls) });
  const result = await client.getDesignContext({
    file: FILE_KEY,
    target: "230:2",
    clientLanguages: "typescript",
    clientFrameworks: "react",
  });
  const call = calls.find((entry) => entry.name === "get_design_context");
  assert.deepEqual(call.args, { fileKey: FILE_KEY, nodeId: "230:2" });
  assert.deepEqual(
    result.diagnostics.map((entry) => [entry.code, entry.severity]),
    [
      ["FIGMA_WORKSPACE_UPSTREAM_OPTIONAL_SKIPPED", "warning"],
      ["FIGMA_WORKSPACE_UPSTREAM_OPTIONAL_SKIPPED", "warning"],
    ],
  );
  assert.match(result.diagnostics[0].message, /clientLanguages/u);
  assert.match(result.diagnostics[1].message, /clientFrameworks/u);
  await client.close();
});

test("metadata rejects retired client hints at the strict runtime boundary", async () => {
  const calls = [];
  const client = createFigmaWorkspaceClient({ client: fakeUpstream(calls) });
  await assert.rejects(
    client.getMetadata({ file: FILE_KEY, clientLanguages: "typescript" }),
    /unknown fields: clientLanguages/iu,
  );
  assert.equal(calls.some((entry) => entry.kind === "call"), false);
  await client.close();
});

test("design context keeps upstream skillNames hidden from the public wrapper", async () => {
  const calls = [];
  const client = createFigmaWorkspaceClient({ client: fakeUpstream(calls) });
  await assert.rejects(
    client.getDesignContext({ file: FILE_KEY, target: "1:2", skillNames: "figma-design-to-code" }),
    /unknown fields: skillNames/iu,
  );
  assert.equal(calls.length, 0);
  await client.close();
});

test("official target contracts reject invalid first-class targets before upstream connect", async () => {
  for (const [method, args] of [
    ["getMetadata", { file: "A".repeat(21) }],
    ["getMetadata", { file: "A".repeat(129) }],
    ["getMetadata", { file: `${"A".repeat(21)}_` }],
    ["getDesignContext", { file: FILE_KEY, target: "1" }],
    ["getDesignContext", { file: FILE_KEY, target: "1:2;3:4" }],
    ["getDesignContext", { file: FILE_KEY, target: { fileKey: FILE_KEY, nodeId: "invalid" } }],
    ["getDesignContext", { target: `${FILE_URL}?node-id=invalid` }],
  ]) {
    const calls = [];
    const client = createFigmaWorkspaceClient({ client: fakeUpstream(calls) });
    await assert.rejects(client[method](args), /official Figma|node id|file key|node URL|exact/iu);
    assert.equal(calls.length, 0, `${method} ${JSON.stringify(args)}`);
    await client.close();
  }
});

test("official target boundaries accept 22/128-character keys and I/T composite node ids", async () => {
  for (const fileKey of ["A".repeat(22), "Z".repeat(128)]) {
    const calls = [];
    const client = createFigmaWorkspaceClient({ client: fakeUpstream(calls) });
    await client.getMetadata({ file: fileKey });
    assert.equal(calls.find((entry) => entry.name === "get_metadata").args.fileKey, fileKey);
    await client.close();
  }

  const calls = [];
  const client = createFigmaWorkspaceClient({ client: fakeUpstream(calls) });
  const result = await client.getDesignContext({ target: `${FILE_URL}?node-id=I10-20;30-40` });
  assert.equal(result.nodeId, "I10:20;30:40");
  assert.deepEqual(calls.find((entry) => entry.name === "get_design_context").args, {
    fileKey: FILE_KEY,
    nodeId: "I10:20;30:40",
  });
  await client.close();

  const metadataCalls = [];
  const metadataClient = createFigmaWorkspaceClient({ client: fakeUpstream(metadataCalls) });
  const metadata = await metadataClient.getMetadata({ file: FILE_KEY, target: "T10:20;30-40" });
  assert.equal(metadata.nodeId, "T10:20;30-40");
  assert.deepEqual(metadataCalls.find((entry) => entry.name === "get_metadata").args, {
    fileKey: FILE_KEY,
    nodeId: "T10:20;30-40",
  });
  await metadataClient.close();
});

test("motion context rejects composite node ids before upstream connect", async () => {
  for (const args of [
    { file: FILE_KEY, target: "I10:20;30:40" },
    { target: `${FILE_URL}?node-id=T10-20;30-40` },
    { file: FILE_KEY, target: { fileKey: FILE_KEY, nodeId: "I10:20;30:40" } },
  ]) {
    const calls = [];
    const client = createFigmaWorkspaceClient({ client: fakeUpstream(calls) });
    await assert.rejects(client.getMotionContext(args), /official Figma node id|valid .* node URL|raw node id/iu);
    assert.equal(calls.length, 0);
    await client.close();
  }
});

test("upstream tool directory classifies file component listing as code-connect", async () => {
  const calls = [];
  const upstream = fakeUpstream(calls);
  upstream.listTools = async () => ({ tools: [{ name: "list_file_components_for_code_connect", inputSchema: { type: "object" } }] });
  const client = createFigmaWorkspaceClient({ client: upstream });
  const result = await client.upstreamTools();
  assert.deepEqual(result.tools, [{ name: "list_file_components_for_code_connect", category: "code-connect" }]);
  await client.close();
});

test("file and target URLs reject non-Figma hosts and invalid surfaces before dispatch", async () => {
  for (const [method, args] of [
    ["getMetadata", { file: "https://evil.example/design/ExampleKey/UI" }],
    ["getMetadata", { file: "https://www.figma.com/community/ExampleKey/UI" }],
    ["getDesignContext", { target: "https://evil.example/design/ExampleKey/UI?node-id=1-2" }],
    ["getDesignContext", { target: "https://www.figma.com/community/ExampleKey/UI?node-id=1-2" }],
  ]) {
    const calls = [];
    const client = createFigmaWorkspaceClient({ client: fakeUpstream(calls) });
    await assert.rejects(client[method](args), /figma\.com|Figma URL|valid Figma file key|Design, FigJam, or Slides/iu, `${method} ${JSON.stringify(args)}`);
    assert.equal(calls.some((entry) => entry.kind === "call"), false);
    await client.close();
  }
});

test("capture writes PNG inside explicit output root and returns absolute path", async () => {
  const directory = await mkdtemp(resolve(tmpdir(), "figma-stateless-capture-"));
  const calls = [];
  const png = Buffer.alloc(33);
  Buffer.from([0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a]).copy(png);
  png.writeUInt32BE(13, 8); png.write("IHDR", 12, "ascii"); png.writeUInt32BE(1, 16); png.writeUInt32BE(1, 20);
  const client = createFigmaWorkspaceClient({ client: fakeUpstream(calls, (name) => name === "get_screenshot" ? { content: [{ type: "image", mimeType: "image/png", data: png.toString("base64") }] } : { content: [{ type: "text", text: JSON.stringify({ ok: true }) }] }) });
  try {
    const result = await client.captureNode({ file: FILE_URL, target: "230:2", outputDir: directory });
    assert.equal(result.ok, true);
    assert.equal(result.nodeId, "230:2");
    assert.ok(resolve(result.imageFile).startsWith(resolve(directory)));
    assert.deepEqual(await readFile(result.imageFile), png);
  } finally {
    await client.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("capture without an explicit path writes under the invocation temp root", async () => {
  const calls = [];
  const invocationId = `invocation-temp-${Date.now()}`;
  const expectedRoot = resolve(tmpdir(), "figma-workspace", invocationId);
  const png = Buffer.alloc(33);
  Buffer.from([0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a]).copy(png);
  png.writeUInt32BE(13, 8); png.write("IHDR", 12, "ascii"); png.writeUInt32BE(1, 16); png.writeUInt32BE(1, 20);
  const client = createFigmaWorkspaceClient({
    invocationId,
    client: fakeUpstream(calls, (name) => name === "get_screenshot"
      ? { content: [{ type: "image", mimeType: "image/png", data: png.toString("base64") }] }
      : { content: [{ type: "text", text: JSON.stringify({ ok: true }) }] }),
  });
  try {
    const result = await client.captureNode({ file: FILE_URL, target: "230:2" });
    assert.ok(resolve(result.imageFile).startsWith(`${expectedRoot}\\`) || resolve(result.imageFile).startsWith(`${expectedRoot}/`));
    assert.doesNotMatch(result.imageFile, /[\\/]tasks[\\/]/u);
  } finally {
    await client.close();
    await rm(expectedRoot, { recursive: true, force: true });
  }
});

test("stateless validators reject retired session and workspace fields as unknown input", async () => {
  const client = createFigmaWorkspaceClient({ client: fakeUpstream([]) });
  await assert.rejects(client.run({ file: FILE_URL, source: "return {};", sessionId: "legacy" }), /unknown fields: sessionId/iu);
  await assert.rejects(client.getMetadata({ file: FILE_URL, workspaceDir: "C:/legacy" }), /unknown fields: workspaceDir/iu);
  await client.close();
});

test("lookup clamps integer bounds and reports effective parameters without warning status", async () => {
  const current = createFigmaWorkspaceClient({ client: fakeUpstream([]) });
  try {
    const result = await current.lookup({
      kind: "api",
      symbol: "figma.createFrame",
      maxResults: 0,
      maxSnippetLines: 99,
    });
    assert.equal(result.ok, true);
    assert.equal(result.mode, "search");
    assert.equal(result.results.length, 1);
    assert.deepEqual(result.parameterAdjustments, [
      {
        option: "--limit",
        requested: 0,
        applied: 1,
        range: [1, 10],
      },
      {
        option: "--snippet-lines",
        requested: 99,
        applied: 16,
        range: [1, 16],
      },
    ]);
    assert.equal("warnings" in result, false);
    const inRange = await current.lookup({
      kind: "api",
      symbol: "figma.createFrame",
      maxResults: 5,
      maxSnippetLines: 5,
    });
    assert.equal("parameterAdjustments" in inRange, false);
    const docsResult = await current.lookup({
      kind: "docs",
      query: "text editing",
      maxResults: 99,
      maxSnippetLines: -4,
    });
    assert.deepEqual(
      docsResult.parameterAdjustments,
      [
        { option: "--limit", requested: 99, applied: 10, range: [1, 10] },
        { option: "--snippet-lines", requested: -4, applied: 1, range: [1, 16] },
      ],
    );
    assert.ok(docsResult.results.every((entry) => entry.snippet.split("\n").length <= 1));
    await assert.rejects(
      current.lookup({ kind: "api", symbol: "createFrame", maxSnippetLines: 3.5 }),
      /safe integer/iu,
    );
  } finally {
    await current.close();
  }
});

test("docs catalog clamps its display limit and reports the supported range", async () => {
  const current = createFigmaWorkspaceClient({ client: fakeUpstream([]) });
  try {
    const lower = await current.docs({ mode: "catalog", limit: -9 });
    assert.equal(lower.ok, true);
    assert.equal(lower.mode, "catalog");
    assert.equal(lower.taskFamilies.length, 1);
    assert.deepEqual(lower.parameterAdjustments, [{
      option: "--limit",
      requested: -9,
      applied: 1,
      range: [1, 100],
    }]);
    assert.equal("warnings" in lower, false);

    const upper = await current.docs({ mode: "catalog", limit: 999 });
    assert.equal(upper.taskFamilies.length, 12);
    assert.equal(upper.parameterAdjustments[0].applied, 100);
    assert.deepEqual(upper.parameterAdjustments[0].range, [1, 100]);

    const inRange = await current.docs({ mode: "catalog", limit: 12 });
    assert.equal("parameterAdjustments" in inRange, false);

    await assert.rejects(
      current.docs({ mode: "catalog", limit: 2.5 }),
      /safe integer/iu,
    );
  } finally {
    await current.close();
  }
});

test("API lookup closes the exact search and read loop through apiId", async () => {
  const current = createFigmaWorkspaceClient({ client: fakeUpstream([]) });
  try {
    const search = await current.lookup({ kind: "api", symbol: "figma.createFrame" });
    const apiId = search.results.find((result) => result.apiId)?.apiId;
    assert.ok(apiId);
    assert.equal(search.nextActions[0].commandId, "figma:api:read");
    assert.equal(search.nextActions[0].args.id, apiId);

    const read = await current.lookup({ kind: "api", apiId });
    assert.equal(read.ok, true);
    assert.equal(read.mode, "read");
    assert.equal(read.declaration.apiId, apiId);
    assert.equal(read.declaration.kind, "api");
    assert.match(read.declaration.content, /createFrame/u);
    assert.doesNotMatch(read.declaration.content, /createComponent/u);
    assert.equal(read.declaration.source.package, "@figma/plugin-typings");
    assert.equal("results" in read, false);

    await assert.rejects(
      current.lookup({ kind: "api", apiId: "api:missing" }),
      /Unknown Figma Plugin API id/iu,
    );
  } finally {
    await current.close();
  }
});

test("doctor remains local-only and does not connect upstream", async () => {
  const calls = [];
  const client = createFigmaWorkspaceClient({ client: fakeUpstream(calls) });
  const result = await client.doctor();
  assert.equal(typeof result.runtime.typescript.ok, "boolean");
  assert.equal(calls.length, 0);
});
