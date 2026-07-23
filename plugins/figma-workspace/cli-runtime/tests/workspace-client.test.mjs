import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";
import {
  createFigmaWorkspaceClient,
} from "../dist/runtime/workspace-runtime.js";

const FILE_KEY = "EctrdKKdR3c8JTPl55qn3r";
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
  await assert.rejects(client.getDesignContext({ file: "OtherKey", target: NODE_URL, surface: "design" }), /conflicting file contexts/iu);
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

test("doctor remains local-only and does not connect upstream", async () => {
  const calls = [];
  const client = createFigmaWorkspaceClient({ client: fakeUpstream(calls) });
  const result = await client.doctor();
  assert.equal(typeof result.runtime.typescript.ok, "boolean");
  assert.equal(calls.length, 0);
});
