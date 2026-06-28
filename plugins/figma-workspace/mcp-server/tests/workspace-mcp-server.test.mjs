import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { deflateSync } from "node:zlib";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import {
  createFigmaWorkspaceClient,
  createFigmaWorkspaceMcpServer,
  diagnoseFigmaWorkspaceCode,
} from "../dist/mcp/index.js";
import {
  FIGMA_WORKSPACE_EVAL_COMMON_HELPER_NAMES,
  buildFigmaEvalScript,
  createFigmaWorkspaceSessionStore,
  isFigmaWorkspaceMissingFileErrorForTesting,
  resolveFigmaWorkspaceScriptHelperSelection,
} from "../dist/mcp/workspace-mcp-server.js";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const expectedStaticResourceUris = [
  "figma-workspace://capabilities",
  "figma-workspace://guide",
  "figma-workspace://lookup-index",
  "figma-workspace://sessions",
  "figma-workspace://upstream-tools",
];
const removedStaticResourceUris = [
  "figma-workspace://api",
  "figma-workspace://api-cards",
  "figma-workspace://docs",
  "figma-workspace://file-workflow",
  "figma-workspace://intents",
  "figma-workspace://patterns",
  "figma-workspace://safety",
  "figma-workspace://scripts",
  "figma-workspace://workflow-tools",
];
const queryOutputFields = [
  "recommendedCards",
  "queryHints",
  "apiSymbols",
  "guardrails",
  "referenceContext",
];
const forbiddenRouterContractTerms = [
  "figma_workspace_apply_ops",
  "figma_workspace_applyOps",
  "apply_ops",
  "$.ops",
  "$.applyOps",
  "compileFigmaWorkspaceOps",
  "FigmaWorkspaceOp",
  "FigmaWorkspaceApplyOpsArguments",
];

function structuredToolResult(result) {
  assert.ok(result.structuredContent);
  const content = Array.isArray(result.content) ? result.content : [];
  assert.equal(content.some((item) => item?.type === "text"), false);
  return result.structuredContent;
}

function assertFilePointer(pointer, expectedPath, options = {}) {
  assert.equal(pointer?.path, expectedPath);
  assert.equal(typeof pointer.bytes, "number");
  assert.equal(typeof pointer.lineCount, "number");
  if (options.bytes !== undefined) {
    assert.equal(pointer.bytes, options.bytes);
  } else {
    assert.ok(pointer.bytes > 0);
  }
  if (options.lineCount !== undefined) {
    assert.equal(pointer.lineCount, options.lineCount);
  } else {
    assert.ok(pointer.lineCount > 0);
  }
  return pointer.path;
}

async function readPrettyJsonPointer(pointer, expectedPath) {
  const path = assertFilePointer(pointer, expectedPath);
  const content = await readFile(path, "utf8");
  assert.match(content, /\n/u);
  assert.ok(content.trim().split(/\r?\n/u).length > 1);
  assert.equal(countTextLines(content), pointer.lineCount);
  assert.equal(Buffer.byteLength(content, "utf8"), pointer.bytes);
  return JSON.parse(content);
}

async function readTextPointer(pointer, expectedPath) {
  const path = assertFilePointer(pointer, expectedPath);
  const content = await readFile(path, "utf8");
  assert.equal(countTextLines(content), pointer.lineCount);
  assert.equal(Buffer.byteLength(content, "utf8"), pointer.bytes);
  return content;
}

async function openTestWorkspace(mcpClient, { tempDir, sessionId = "default" }) {
  await mcpClient.callTool({
    name: "figma_workspace_open",
    arguments: {
      title: "Open test workspace",
      sessionId,
      file: "https://www.figma.com/design/ExampleFigmaFileKey012/UI?node-id=1-2",
      cwd: tempDir,
      connect: false,
    },
  });
  const fileDir = resolve(tempDir, "figma-workspace", "ExampleFigmaFileKey012");
  await mkdir(fileDir, { recursive: true });
  return fileDir;
}

function countTextLines(content) {
  if (content.length === 0) {
    return 0;
  }
  const newlineCount = content.match(/\n/gu)?.length ?? 0;
  return content.endsWith("\n") ? newlineCount : newlineCount + 1;
}

async function createTestPngBuffer(width = 4, height = 3) {
  const pixel = Buffer.from([240, 64, 48, 255]);
  const rows = [];
  for (let y = 0; y < height; y += 1) {
    const row = Buffer.alloc(1 + width * pixel.length);
    row[0] = 0;
    for (let x = 0; x < width; x += 1) {
      pixel.copy(row, 1 + x * pixel.length);
    }
    rows.push(row);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  return Buffer.concat([
    Buffer.from("89504e470d0a1a0a", "hex"),
    pngChunk("IHDR", ihdr),
    pngChunk("IDAT", deflateSync(Buffer.concat(rows))),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

function pngChunk(type, data) {
  const typeBytes = Buffer.from(type, "ascii");
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBytes, data])), 0);
  return Buffer.concat([length, typeBytes, data, crc]);
}

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function assertPngBuffer(buffer) {
  assert.equal(buffer.subarray(0, 8).toString("hex"), "89504e470d0a1a0a");
}

function assertJpegBuffer(buffer) {
  assert.equal(buffer.subarray(0, 3).toString("hex"), "ffd8ff");
}

test("figma workspace eval wraps code and persists returned handles", async () => {
  const calls = [];
  const fakeClient = createFakeFigmaClient(calls, ({ name, args }) => {
    assert.equal(name, "use_figma");
    assert.equal(typeof args.code, "string");
    assert.match(args.code, /async function \$\(nameOrId\)/);
    assert.match(args.code, /const read = \(key\) => key in node/);
    assert.doesNotMatch(args.code, /\$\.findAll = async function findAll/);
    assert.doesNotMatch(args.code, /\$\.create = async function create/);
    assert.doesNotMatch(args.code, /const __figmaReplEvalCheckpoints = \[\]/);
    assert.match(args.code, /remember\('\$card', frame\)/);
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify({
            ok: true,
            __figmaRepl: {
              sessionId: "main",
              handles: { "$card": "12:34" },
              currentPageId: "1:2",
              knownPages: {
                "1:2": "Homepage",
                "3:4": "Components",
              },
            },
            result: {
              summary: "created card",
              id: "12:34",
            },
          }),
        },
      ],
    };
  });

  const { server } = createFigmaWorkspaceMcpServer({ client: fakeClient });
  const mcpClient = new Client(
    { name: "test-client", version: "0.1.0" },
    { capabilities: {} },
  );
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

  await server.connect(serverTransport);
  await mcpClient.connect(clientTransport);

  const evalResult = await mcpClient.callTool({
    name: "figma_workspace_eval",
    arguments: {
      title: "Create card",
      sessionId: "main",
      code: "const frame = figma.createFrame();\nremember('$card', frame);\nreturn summarizeNode(frame, 0);",
    },
  });
  const evalJson = structuredToolResult(evalResult);
  assert.equal(evalJson.ok, true);
  assert.equal(evalJson.upstream.kind, "json");
  assert.equal(evalJson.upstream.ok, true);
  assert.equal(evalJson.upstream.callOk, undefined);
  assert.equal(evalJson.upstream.result.id, "12:34");
  assert.equal(evalJson.upstream.result.__figmaRepl, undefined);
  assert.equal(evalJson.upstream.result.result, undefined);
  assert.equal(evalJson.result, undefined);
  assert.equal(evalJson.execution, undefined);
  assert.equal(evalJson.stateSync, undefined);
  assert.equal(evalJson.debug, undefined);
  assert.equal(evalJson.verbose, undefined);
  assert.equal(evalJson.parsed, undefined);
  assert.equal(evalJson.text, undefined);
  assert.equal(evalJson.script, undefined);
  assert.equal(evalJson.metadata, undefined);
  assert.equal(evalJson.injectedHelpers, undefined);
  assert.equal(evalJson.outputFiles, undefined);
  assert.equal(evalJson.inlineResultLimit, undefined);
  assert.equal(evalJson.upstreamTool, undefined);
  assert.equal(evalJson.upstreamArgument, undefined);
  assert.deepEqual(evalJson.session.handleChanges, { updated: ["$card"], removed: [] });
  assert.equal(evalJson.session.handles, undefined);
  assert.equal(evalJson.session.fileUrl, undefined);
  assert.equal(evalJson.session.knownPages, undefined);
  assert.equal(evalJson.session.currentPageId, undefined);
  assert.equal(evalJson.session.workspace, undefined);

  const sessionResources = await mcpClient.listResources();
  const sessionListEntry = sessionResources.resources.find((resource) => resource.uri === "figma-workspace://sessions/main");
  assert.equal(sessionListEntry?.description, "Read when you need compact state, remembered handles, and workspace file context for this specific active workspace session.");
  assert.equal(sessionListEntry?.mimeType, "application/json");
  const sessionHandlesEntry = sessionResources.resources.find((resource) => resource.uri === "figma-workspace://sessions/main/handles");
  assert.equal(sessionHandlesEntry?.description, "Read when you need the full remembered handle map for this specific active workspace session.");
  assert.equal(sessionHandlesEntry?.mimeType, "application/json");

  const sessionsResource = await mcpClient.readResource({ uri: "figma-workspace://sessions" });
  const sessionsJson = JSON.parse(sessionsResource.contents[0].text);
  assert.deepEqual(sessionsJson, { sessions: [{ id: "main" }] });

  const sessionResource = await mcpClient.readResource({ uri: "figma-workspace://sessions/main" });
  const sessionJson = JSON.parse(sessionResource.contents[0].text);
  assert.deepEqual(sessionJson, {
    id: "main",
    handles: { "$card": "12:34" },
    page: {
      currentPageId: "1:2",
      currentPageName: "Homepage",
      knownPages: [
        { id: "3:4", name: "Components" },
        { id: "1:2", name: "Homepage" },
      ],
    },
  });
  assert.equal(sessionJson.evalToolName, undefined);
  assert.equal(sessionJson.evalToolArgument, undefined);
  assert.equal(sessionJson.upstreamArguments, undefined);
  assert.equal(sessionJson.history, undefined);
  const handlesResource = await mcpClient.readResource({ uri: "figma-workspace://sessions/main/handles" });
  const handlesJson = JSON.parse(handlesResource.contents[0].text);
  assert.deepEqual(handlesJson, { sessionId: "main", handles: { "$card": "12:34" } });

  assert.deepEqual(calls.map((call) => call[0]), ["connect", "listTools", "callTool"]);
  await mcpClient.close();
});

test("figma workspace eval reports authoritative handle removals separately from additive updates", async () => {
  const calls = [];
  const fakeClient = createFakeFigmaClient(calls, ({ name }) => {
    assert.equal(name, "use_figma");
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify({
            ok: true,
            __figmaRepl: {
              sessionId: "main",
              handles: { "$keep": "2:2" },
            },
            result: {
              handles: { "$extra": "3:3" },
            },
          }),
        },
      ],
    };
  });

  const { server } = createFigmaWorkspaceMcpServer({ client: fakeClient });
  const mcpClient = new Client(
    { name: "test-client", version: "0.1.0" },
    { capabilities: {} },
  );
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

  await server.connect(serverTransport);
  await mcpClient.connect(clientTransport);

  const openResult = await mcpClient.callTool({
    name: "figma_workspace_open",
    arguments: {
      title: "Seed handles",
      sessionId: "main",
      connect: false,
      handles: { "$old": "1:1", "$keep": "2:2" },
    },
  });
  const openJson = structuredToolResult(openResult);
  assert.deepEqual(openJson.session.handleChanges, { updated: ["$keep", "$old"], removed: [] });

  const evalResult = await mcpClient.callTool({
    name: "figma_workspace_eval",
    arguments: {
      title: "Replace handles",
      sessionId: "main",
      code: "return { handles: { $extra: '3:3' } };",
    },
  });
  const evalJson = structuredToolResult(evalResult);
  assert.deepEqual(evalJson.session.handleChanges, { updated: ["$extra"], removed: ["$old"] });
  assert.equal(evalJson.session.handles, undefined);

  const handlesResource = await mcpClient.readResource({ uri: "figma-workspace://sessions/main/handles" });
  const handlesJson = JSON.parse(handlesResource.contents[0].text);
  assert.deepEqual(handlesJson, { sessionId: "main", handles: { "$keep": "2:2", "$extra": "3:3" } });

  assert.deepEqual(calls.map((call) => call[0]), ["connect", "listTools", "callTool"]);
  await mcpClient.close();
});

test("figma workspace eval keeps wrapper success when nested business ok is false", async () => {
  const calls = [];
  const fakeClient = createFakeFigmaClient(calls, ({ name, args }) => {
    assert.equal(name, "use_figma");
    assert.match(args.code, /business validation/);
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify({
            ok: true,
            __figmaRepl: {
              sessionId: "nested-ok-eval",
              handles: {},
            },
            result: {
              ok: false,
              reason: "business validation evidence",
              nodeId: "12:34",
            },
          }),
        },
      ],
    };
  });
  const { server } = createFigmaWorkspaceMcpServer({ client: fakeClient });
  const mcpClient = new Client(
    { name: "test-client", version: "0.1.0" },
    { capabilities: {} },
  );
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

  await server.connect(serverTransport);
  await mcpClient.connect(clientTransport);

  const result = await mcpClient.callTool({
    name: "figma_workspace_eval",
    arguments: {
      title: "Read business validation",
      sessionId: "nested-ok-eval",
      code: "return { ok: false, reason: 'business validation evidence' };",
    },
  });
  const json = structuredToolResult(result);
  assert.equal(json.ok, true);
  assert.equal(json.upstream.ok, false);
  assert.equal(json.upstream.callOk, undefined);
  assert.equal(json.upstream.result.ok, undefined);
  assert.equal(json.upstream.result.source, "business");
  assert.equal(json.upstream.result.reason, "business validation evidence");
  assert.equal(json.upstream.result.__figmaRepl, undefined);
  assert.equal(json.upstream.result.result, undefined);
  assert.equal(json.upstreamError, undefined);
  assert.equal(json.outputFiles, undefined);
  assert.deepEqual(calls.map((call) => call[0]), ["connect", "listTools", "callTool"]);
  await mcpClient.close();
});

test("figma workspace open connects without listing upstream tools", async () => {
  const calls = [];
  const { server } = createFigmaWorkspaceMcpServer({
    client: createFakeFigmaClient(calls, () => {
      throw new Error("unexpected upstream call");
    }),
  });
  const mcpClient = new Client(
    { name: "test-client", version: "0.1.0" },
    { capabilities: {} },
  );
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

  await server.connect(serverTransport);
  await mcpClient.connect(clientTransport);

  const result = await mcpClient.callTool({
    name: "figma_workspace_open",
    arguments: {
      title: "Open without discovery",
      sessionId: "open-only",
      file: "https://www.figma.com/design/file123/Test",
    },
  });
  const json = structuredToolResult(result);
  assert.equal(json.ok, true);
  assert.equal(json.session.fileKey, "file123");
  assert.equal(json.upstreamTools, undefined);
  assert.deepEqual(calls.map((call) => call[0]), ["connect"]);
  await mcpClient.close();
});

test("figma workspace eval ignores legacy routing overrides and always uses use_figma code", async () => {
  const previousToolEnv = process.env.FIGMA_WORKSPACE_EVAL_TOOL;
  const previousArgumentEnv = process.env.FIGMA_WORKSPACE_EVAL_TOOL_ARGUMENT;
  process.env.FIGMA_WORKSPACE_EVAL_TOOL = "fake_eval";
  process.env.FIGMA_WORKSPACE_EVAL_TOOL_ARGUMENT = "script";
  const calls = [];
  const fakeClient = createFakeFigmaClient(
    calls,
    ({ name, args }) => {
      assert.equal(name, "use_figma");
      assert.equal(typeof args.code, "string");
      assert.equal(args.script, undefined);
      return {
        content: [{ type: "text", text: JSON.stringify({ ok: true, result: { routed: "fixed" } }) }],
      };
    },
    {
      tools: [
        { name: "fake_eval", inputSchema: { type: "object", properties: { script: { type: "string" } } } },
        { name: "use_figma", inputSchema: { type: "object", properties: { code: { type: "string" } } } },
      ],
    },
  );
  const { server } = createFigmaWorkspaceMcpServer({
    client: fakeClient,
    evalToolName: "fake_eval",
    evalToolArgument: "script",
  });
  const mcpClient = new Client(
    { name: "test-client", version: "0.1.0" },
    { capabilities: {} },
  );
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

  try {
    await server.connect(serverTransport);
    await mcpClient.connect(clientTransport);
    const result = await mcpClient.callTool({
      name: "figma_workspace_eval",
      arguments: {
        title: "Verify fixed eval route",
        code: "return { ok: true };",
      },
    });
    const json = structuredToolResult(result);
    assert.equal(json.ok, true);
    assert.equal(json.upstreamTool, undefined);
    assert.equal(json.upstreamArgument, undefined);
    assert.deepEqual(calls.map((call) => call[0]), ["connect", "listTools", "callTool"]);
    await mcpClient.close();
  } finally {
    if (previousToolEnv === undefined) {
      delete process.env.FIGMA_WORKSPACE_EVAL_TOOL;
    } else {
      process.env.FIGMA_WORKSPACE_EVAL_TOOL = previousToolEnv;
    }
    if (previousArgumentEnv === undefined) {
      delete process.env.FIGMA_WORKSPACE_EVAL_TOOL_ARGUMENT;
    } else {
      process.env.FIGMA_WORKSPACE_EVAL_TOOL_ARGUMENT = previousArgumentEnv;
    }
  }
});

test("figma workspace eval requires official use_figma code schema", async () => {
  const calls = [];
  const fakeClient = createFakeFigmaClient(
    calls,
    () => {
      throw new Error("unexpected upstream call");
    },
    {
      tools: [
        { name: "use_figma", inputSchema: { type: "object", properties: { script: { type: "string" } } } },
      ],
    },
  );
  const { server } = createFigmaWorkspaceMcpServer({ client: fakeClient });
  const mcpClient = new Client(
    { name: "test-client", version: "0.1.0" },
    { capabilities: {} },
  );
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

  await server.connect(serverTransport);
  await mcpClient.connect(clientTransport);
  await assert.rejects(
    mcpClient.callTool({
      name: "figma_workspace_eval",
      arguments: {
        title: "Reject drifted use_figma schema",
        code: "return { ok: true };",
      },
    }),
    /inputSchema\.properties\.code.*upstream contract drift/,
  );
  assert.deepEqual(calls.map((call) => call[0]), ["connect", "listTools"]);
  await mcpClient.close();
});

test("figma workspace eval writes debug result and upstream sidecar for large output only", async () => {
  const tempDir = await mkdtemp(resolve(tmpdir(), "figma-workspace-eval-output-"));
  const previousTaskRoot = process.env.FIGMA_WORKSPACE_TASK_ROOT;
  process.env.FIGMA_WORKSPACE_TASK_ROOT = tempDir;
  const calls = [];
  const fakeClient = createFakeFigmaClient(calls, ({ args }) => {
    if (/large eval/u.test(args.code)) {
      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            ok: true,
            __figmaRepl: { sessionId: "eval-main", handles: {} },
            result: { summary: "large eval", payload: "x".repeat(20_000) },
          }),
        }],
      };
    }
    return {
      content: [{
        type: "text",
        text: JSON.stringify({
          ok: true,
          __figmaRepl: { sessionId: "eval-main", handles: {} },
          result: { summary: "explicit eval", id: "10:1" },
        }),
      }],
    };
  });
  const { server } = createFigmaWorkspaceMcpServer({ client: fakeClient });
  const mcpClient = new Client(
    { name: "test-client", version: "0.1.0" },
    { capabilities: {} },
  );
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

  try {
    await server.connect(serverTransport);
    await mcpClient.connect(clientTransport);

    const largeResult = await mcpClient.callTool({
      name: "figma_workspace_eval",
      arguments: {
        title: "Large eval",
        sessionId: "eval-main",
        mode: "read",
        code: "return { summary: 'large eval' };",
        inlineResultLimit: 40,
      },
    });
    const largeJson = structuredToolResult(largeResult);
    assert.equal(largeJson.ok, true);
    assert.equal(largeJson.upstream.result, undefined);
    assert.equal(largeJson.inlineResultLimit.limit, 40);
    assert.equal(largeJson.inlineResultLimit.limitBytes, 40);
    assert.equal(largeJson.inlineResultLimit.limitHuman, "40 bytes");
    assert.deepEqual(largeJson.inlineResultLimit.omitted.map((item) => item.field), ["upstream.result"]);
    assert.equal(typeof largeJson.inlineResultLimit.omitted[0].bytesHuman, "string");
    assert.equal(largeJson.inlineResultLimit.omitted[0].limitHuman, "40 bytes");
    assertFilePointer(largeJson.outputFiles.debugFile, largeJson.outputFiles.debugFile.path);
    assert.match(largeJson.outputFiles.debugFile.path, /eval-results/u);
    assert.match(largeJson.outputFiles.debugFile.path, /eval-main/u);
    assert.match(largeJson.outputFiles.upstreamFile.path, /\.upstream\.json$/u);
    const fullResult = await readPrettyJsonPointer(largeJson.outputFiles.debugFile, largeJson.outputFiles.debugFile.path);
    assert.equal(fullResult.kind, "figma_workspace_result");
    assert.equal(fullResult.tool, "figma_workspace_eval");
    assert.equal(fullResult.sessionId, "eval-main");
    assert.equal(fullResult.ok, true);
    assert.equal(fullResult.upstreamKind, "json");
    assert.equal(fullResult.upstreamOk, true);
    assert.equal(fullResult.diagnosticsCount, 0);
    assert.equal(fullResult.outputFiles, undefined);
    assert.equal(fullResult.session, undefined);
    assert.equal(fullResult.upstream, undefined);
    const upstreamFile = await readPrettyJsonPointer(largeJson.outputFiles.upstreamFile, largeJson.outputFiles.upstreamFile.path);
    assert.equal(upstreamFile.kind, "json");
    assert.equal(upstreamFile.ok, true);
    assert.equal(upstreamFile.callOk, undefined);
    assert.equal(upstreamFile.result.summary, "large eval");
    assert.equal(upstreamFile.result.payload.length, 20_000);
    assert.equal(upstreamFile.result.__figmaRepl, undefined);
    assert.equal(upstreamFile.result.result, undefined);

    const fileOnlyResult = await mcpClient.callTool({
      name: "figma_workspace_eval",
      arguments: {
        title: "File-only eval output",
        sessionId: "eval-main",
        code: "return { summary: 'explicit eval' };",
        inlineResultLimit: 0,
      },
    });
    const fileOnlyJson = structuredToolResult(fileOnlyResult);
    assert.equal(fileOnlyJson.ok, true);
    assert.equal(fileOnlyJson.upstream.result, undefined);
    assert.equal(fileOnlyJson.inlineResultLimit.limitBytes, 0);
    assert.equal(fileOnlyJson.inlineResultLimit.limitHuman, "0 bytes");
    assert.deepEqual(fileOnlyJson.inlineResultLimit.omitted.map((item) => item.field), ["upstream.result"]);
    assertFilePointer(fileOnlyJson.outputFiles.debugFile, fileOnlyJson.outputFiles.debugFile.path);
    const fileOnlyUpstream = await readPrettyJsonPointer(fileOnlyJson.outputFiles.upstreamFile, fileOnlyJson.outputFiles.upstreamFile.path);
    assert.equal(fileOnlyUpstream.result.id, "10:1");

    const cappedResult = await mcpClient.callTool({
      name: "figma_workspace_eval",
      arguments: {
        title: "Capped eval output",
        sessionId: "eval-main",
        mode: "read",
        code: "return { summary: 'large eval capped' };",
        inlineResultLimit: 10_001,
      },
    });
    const cappedJson = structuredToolResult(cappedResult);
    assert.equal(cappedJson.upstream.result, undefined);
    assert.equal(cappedJson.inlineResultLimit.limitBytes, 10_000);
    assert.equal(cappedJson.inlineResultLimit.limitHuman, "10 KB");
    assert.deepEqual(cappedJson.inlineResultLimit.omitted.map((item) => item.field), ["upstream.result"]);
    const cappedUpstream = await readPrettyJsonPointer(cappedJson.outputFiles.upstreamFile, cappedJson.outputFiles.upstreamFile.path);
    assert.equal(cappedUpstream.result.payload.length, 20_000);

    const cleanResult = await mcpClient.callTool({
      name: "figma_workspace_eval",
      arguments: {
        title: "Clean eval output",
        sessionId: "eval-main",
        code: "return { summary: 'explicit eval' };",
      },
    });
    const cleanJson = structuredToolResult(cleanResult);
    assert.equal(cleanJson.inlineResultLimit, undefined);
    assert.equal(cleanJson.outputFiles, undefined);
    assert.equal(cleanJson.upstream.result.id, "10:1");
    assert.equal(cleanJson.upstream.result.__figmaRepl, undefined);

    await mcpClient.close();
  } finally {
    if (previousTaskRoot === undefined) {
      delete process.env.FIGMA_WORKSPACE_TASK_ROOT;
    } else {
      process.env.FIGMA_WORKSPACE_TASK_ROOT = previousTaskRoot;
    }
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("figma workspace eval rejects dynamic helper access before upstream execution", async () => {
  const calls = [];
  const { server } = createFigmaWorkspaceMcpServer({
    client: createFakeFigmaClient(calls, () => {
      throw new Error("unexpected upstream call");
    }),
  });
  const mcpClient = new Client(
    { name: "test-client", version: "0.1.0" },
    { capabilities: {} },
  );
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

  await server.connect(serverTransport);
  await mcpClient.connect(clientTransport);

  await assert.rejects(
    mcpClient.callTool({
      name: "figma_workspace_open",
      arguments: {
        title: "Reject removed open field",
        fileUrl: "https://www.figma.com/design/file123/Test",
      },
    }),
    /Tool argument "fileUrl" was removed\. Use "file"/,
  );
  await assert.rejects(
    mcpClient.callTool({
      name: "figma_workspace_prepare_task",
      arguments: {
        title: "Reject removed prepare field",
        fileKey: "file123",
      },
    }),
    /Tool argument "fileKey" was removed\. Use "file"/,
  );

  const blockedEval = await mcpClient.callTool({
    name: "figma_workspace_eval",
    arguments: {
      title: "Reject dynamic helper access",
      sessionId: "main",
      code: "const helperName = 'find';\nreturn await $[helperName]({ name: 'Card' });",
    },
  });
  const blockedJson = structuredToolResult(blockedEval);
  assert.equal(blockedJson.ok, false);
  assert.equal(blockedJson.repairPlan.status, "blocked");
  assert.deepEqual(blockedJson.repairPlan.steps.map((step) => step.code), ["FIGMA_WORKSPACE_DYNAMIC_HELPER_ACCESS"]);
  assert.deepEqual(calls.map((call) => call[0]), []);
  await mcpClient.close();
});

test("figma workspace eval supports direct async node lookup followed by $.select", async () => {
  const zoomedNodes = [];
  const page = {
    id: "0:1",
    type: "PAGE",
    name: "Page 1",
    selection: [],
    children: [],
  };
  const menu = {
    id: "12:34",
    type: "FRAME",
    name: "Generated menu",
    parent: page,
    visible: true,
    x: 10,
    y: 20,
    width: 240,
    height: 160,
    children: [],
  };
  page.children.push(menu);
  const nodesById = new Map([
    [page.id, page],
    [menu.id, menu],
  ]);
  const figma = {
    currentPage: page,
    root: { children: [page] },
    getNodeByIdAsync: async (id) => nodesById.get(id) ?? null,
    getNodeById: () => {
      throw new Error("sync lookup should not be used when getNodeByIdAsync exists");
    },
    setCurrentPageAsync: async (nextPage) => {
      figma.currentPage = nextPage;
    },
    viewport: {
      scrollAndZoomIntoView: (nodes) => {
        zoomedNodes.push(...nodes);
      },
    },
  };
  const script = buildFigmaEvalScript({
    session: {
      id: "main",
      handles: {},
      currentPageId: page.id,
      fileUrl: undefined,
      fileKey: undefined,
      surface: "design",
      knownPages: { [page.id]: page.name },
    },
    code: [
      'const menu = await figma.getNodeByIdAsync("12:34");',
      'const selection = await $.select(menu.id, { zoom: true });',
      "return { directId: menu.id, selectedNodeIds: selection.selectedNodeIds };",
    ].join("\n"),
  });
  assert.match(script, /\$\.select = selectNodesForRepl/);
  assert.doesNotMatch(script, /\$\.create = async function create/);
  assert.doesNotMatch(script, /\$\.findAll = async function findAll/);
  const runScript = new Function("figma", `return (async () => {\n${script}\n})();`);
  const result = await runScript(figma);

  assert.equal(result.ok, true);
  assert.equal(result.result.directId, menu.id);
  assert.deepEqual(result.result.selectedNodeIds, [menu.id]);
  assert.deepEqual(page.selection, [menu]);
  assert.deepEqual(zoomedNodes, [menu]);
});

test("figma workspace eval helper selection rejects ambiguous $ binding syntax", () => {
  const aliasDiagnostics = diagnoseFigmaWorkspaceCode(
    "const helper = $;\nreturn await helper.find({ name: 'Card' });",
  );
  assert.deepEqual(aliasDiagnostics.map((item) => item.code), ["FIGMA_WORKSPACE_DYNAMIC_HELPER_ACCESS"]);

  const assignmentDiagnostics = diagnoseFigmaWorkspaceCode("let helper;\nhelper = $;\nreturn helper;");
  assert.deepEqual(assignmentDiagnostics.map((item) => item.code), ["FIGMA_WORKSPACE_DYNAMIC_HELPER_ACCESS"]);

  const shadowCode = "const $ = { find() { return null; } };\nreturn $.find();";
  const shadowDiagnostics = diagnoseFigmaWorkspaceCode(shadowCode);
  assert.deepEqual(shadowDiagnostics.map((item) => item.code), ["FIGMA_WORKSPACE_DYNAMIC_HELPER_ACCESS"]);

  const script = buildFigmaEvalScript({
    session: {
      id: "main",
      handles: {},
      currentPageId: undefined,
      fileUrl: undefined,
      fileKey: undefined,
      surface: "design",
      knownPages: {},
    },
    code: shadowCode,
  });
  assert.doesNotMatch(script, /\$\.find = async function find/);
  assert.doesNotMatch(script, /\$\.findAll = async function findAll/);
});

test("figma workspace helper selector reports injected helpers and dependencies", () => {
  const findSelection = resolveFigmaWorkspaceScriptHelperSelection("return await $.find({ name: 'Card' });");
  assert.deepEqual(findSelection.injectedHelpers, [
    "$",
    "$.forget",
    "$.handles",
    "$.node",
    "$.remember",
    "$.resolveId",
    "$.findAll",
    "$.find",
  ]);
  assert.deepEqual(findSelection.helperUsage.direct, ["$.find"]);
  assert.deepEqual(findSelection.helperUsage.transitive, ["$.findAll"]);
  assert.deepEqual(findSelection.helperUsage.runtimeBase, ["$.forget", "$.handles", "$.node", "$.remember", "$.resolveId"]);
  assert.deepEqual(findSelection.helperUsage.injected, findSelection.injectedHelpers);

  const createSelection = resolveFigmaWorkspaceScriptHelperSelection("return await $.create('FRAME');");
  assert.ok(createSelection.injectedHelpers.includes("$.create"));
  assert.ok(createSelection.injectedHelpers.includes("$.findFreeSlot"));
  assert.ok(createSelection.injectedHelpers.includes("$.placeNode"));
  assert.equal(createSelection.injectedHelpers.includes("$.find"), false);

  const literalSelection = resolveFigmaWorkspaceScriptHelperSelection("return await $['find']({ name: 'Card' });");
  assert.ok(literalSelection.injectedHelpers.includes("$.find"));
  assert.ok(literalSelection.injectedHelpers.includes("$.findAll"));

  const baseSelection = resolveFigmaWorkspaceScriptHelperSelection("return await $('$selection');");
  assert.deepEqual(baseSelection.injectedHelpers, ["$"]);
  assert.deepEqual(baseSelection.helperUsage.direct, ["$"]);
  assert.deepEqual(baseSelection.helperUsage.transitive, []);
  assert.deepEqual(baseSelection.helperUsage.runtimeBase, []);

  const shadowSelection = resolveFigmaWorkspaceScriptHelperSelection("const $ = { find() { return null; } };\nreturn $.find();");
  assert.deepEqual(shadowSelection.injectedHelpers, []);
  assert.deepEqual(shadowSelection.helperUsage, { direct: [], transitive: [], runtimeBase: [], injected: [] });
});

test("figma workspace eval exposes and executes the common $ helper surface", async () => {
  let nextId = 1;
  const loadedFonts = [];
  const nodesById = new Map();
  const page = {
    id: "0:1",
    type: "PAGE",
    name: "Page 1",
    selection: [],
    children: [],
    appendChild(node) {
      appendChild(this, node);
    },
  };
  nodesById.set(page.id, page);

  function appendChild(parent, node) {
    if (node.parent?.children) {
      node.parent.children = node.parent.children.filter((child) => child !== node);
    }
    node.parent = parent;
    parent.children.push(node);
  }

  function createNode(type) {
    const node = {
      id: `90:${nextId++}`,
      type,
      name: type.charAt(0) + type.slice(1).toLowerCase(),
      parent: null,
      visible: true,
      x: 0,
      y: 0,
      width: 0,
      height: 0,
      fills: [],
      resize(width, height) {
        this.width = width;
        this.height = height;
      },
      resizeWithoutConstraints(width, height) {
        this.resize(width, height);
      },
      remove() {
        if (this.parent?.children) {
          this.parent.children = this.parent.children.filter((child) => child !== this);
        }
        this.parent = null;
      },
      clone() {
        const clone = createNode(this.type);
        clone.name = this.name;
        clone.visible = this.visible;
        clone.x = this.x;
        clone.y = this.y;
        clone.width = this.width;
        clone.height = this.height;
        clone.fills = [...this.fills];
        return clone;
      },
      screenshot: async () => new Uint8Array([7, 8, 9]),
    };
    if (type === "FRAME") {
      node.children = [];
      node.appendChild = function appendFrameChild(child) {
        appendChild(this, child);
      };
    }
    if (type === "TEXT") {
      node.characters = "";
      node.fontName = { family: "Inter", style: "Regular" };
    }
    nodesById.set(node.id, node);
    return node;
  }

  const figma = {
    currentPage: page,
    root: { children: [page] },
    getNodeByIdAsync: async (id) => nodesById.get(id) ?? null,
    createFrame: () => createNode("FRAME"),
    createText: () => createNode("TEXT"),
    createRectangle: () => createNode("RECTANGLE"),
    createEllipse: () => createNode("ELLIPSE"),
    createLine: () => createNode("LINE"),
    createImage: (bytes) => ({ hash: `hash-${Array.from(bytes).join("-")}` }),
    loadFontAsync: async (font) => {
      loadedFonts.push(font);
    },
    setCurrentPageAsync: async (nextPage) => {
      figma.currentPage = nextPage;
    },
    viewport: {
      scrollAndZoomIntoView: () => {},
    },
  };
  const expectedFunctionHelpers = [...FIGMA_WORKSPACE_EVAL_COMMON_HELPER_NAMES];
  const helperTypeProperties = expectedFunctionHelpers
    .map((name) => `${JSON.stringify(name)}: typeof $.${name}`)
    .join(", ");
  const script = buildFigmaEvalScript({
    session: {
      id: "main",
      handles: {},
      currentPageId: page.id,
      fileUrl: undefined,
      fileKey: undefined,
      surface: "design",
      knownPages: { [page.id]: page.name },
    },
    code: [
      `const helperTypes = { ${helperTypeProperties} };`,
      "for (const [name, type] of Object.entries(helperTypes)) {",
      "  if (type !== 'function') throw new Error(`$.${name} is not a function`);",
      "}",
      "if (typeof $.handles !== 'object') throw new Error('$.handles is not an object');",
      "if (!Array.isArray($.checkpoints)) throw new Error('$.checkpoints is not an array');",
      "const root = await $.create({ type: 'FRAME', as: '$root', name: 'Eval helper root', size: { width: 120, height: 80 }, layout: { layoutMode: 'VERTICAL' } });",
      "await $.layout('$root', { itemSpacing: 4 });",
      "const title = await $.text({ parent: '$root', as: '$title', name: 'Eval helper title', text: 'Hello', font: { family: 'Inter', style: 'Regular', size: 12 } });",
      "const allText = await $.findAll({ type: 'TEXT' });",
      "const found = await $.find({ name: 'Eval helper title' });",
      "const selected = await $.select('$title', { zoom: false });",
      "const inspected = await $.inspect('$title', 0);",
      "const screenshotBytes = Array.from(await $.screenshot('$root', { format: 'PNG' }));",
      "const asset = await $.imageAsset({ parent: '$root', as: '$asset', name: 'Eval helper asset', base64: 'AQIDBA==', size: { width: 16, height: 16 } });",
      "const clone = await $.cloneNodeTree({ source: '$asset', parent: '$root', as: '$clone', select: false, placement: 'none' });",
      "const freeSlot = await $.findFreeSlot({ parent: figma.currentPage, preferred: { x: 0, y: 0 }, size: { width: 20, height: 20 }, direction: 'right', gap: 4 });",
      "const generated = await $.replaceGeneratedFrame({ name: 'Variant Eval helper generated', size: { width: 20, height: 20 }, position: { x: 0, y: 0 }, as: '$generated', select: false });",
      "const generatedPlacement = await $.placeNode('$generated', { preferred: { x: 0, y: 0 }, size: { width: 20, height: 20 }, avoidOverlap: true, direction: 'right', gap: 4 });",
      "const viaNode = await $.node('$clone');",
      "const resolvedCloneId = $.resolveId('$clone');",
      "$.forget('$clone');",
      "const checkpoint = await $.checkpoint('eval-helper-surface', [root, '$title'], { depth: 0 });",
      "return { helperTypes, handles: { ...$.handles }, checkpoints: $.checkpoints.length, root: root.id, title: title.id, allText: allText.length, found: found.id, selected: selected.selectedNodeIds, inspected, screenshotBytes, assetFill: asset.fills[0], cloneId: clone.clone.id, viaNode: viaNode.id, resolvedCloneId, cloneForgotten: !('$clone' in $.handles), freeSlot, generatedFrame: generated.frame, generatedPlacement, checkpointName: checkpoint.name, checkpointFirstId: checkpoint.summaries[0].id };",
    ].join("\n"),
  });
  const runScript = new Function("figma", `return (async () => {\n${script}\n})();`);
  const result = await runScript(figma);

  assert.equal(result.ok, true);
  assert.deepEqual(result.result.helperTypes, Object.fromEntries(expectedFunctionHelpers.map((name) => [name, "function"])));
  assert.equal(result.result.handles.$root, result.result.root);
  assert.equal(result.result.handles.$title, result.result.title);
  assert.ok(result.result.handles.$generated);
  assert.equal(result.result.generatedFrame.name, "Variant Eval helper generated");
  assert.ok(result.result.freeSlot.shiftedSlots > 0);
  assert.ok(result.result.generatedPlacement.shiftedSlots > 0);
  assert.equal(result.result.allText, 1);
  assert.equal(result.result.found, result.result.title);
  assert.deepEqual(result.result.selected, [result.result.title]);
  assert.equal(result.result.inspected.name, "Eval helper title");
  assert.deepEqual(result.result.screenshotBytes, [7, 8, 9]);
  assert.equal(result.result.assetFill.imageHash, "hash-1-2-3-4");
  assert.equal(result.result.viaNode, result.result.resolvedCloneId);
  assert.equal(result.result.cloneForgotten, true);
  assert.equal(result.result.checkpointName, "eval-helper-surface");
  assert.equal(result.result.checkpointFirstId, result.result.root);
  assert.equal(result.result.checkpoints, 1);
  assert.deepEqual(loadedFonts, [{ family: "Inter", style: "Regular" }]);
});

test("figma workspace exposes self-explaining capabilities and resources", async () => {
  const calls = [];
  const { server } = createFigmaWorkspaceMcpServer({
    client: createFakeFigmaClient(calls, () => {
      throw new Error("unexpected upstream call");
    }, {
      tools: [
        {
          name: "use_figma",
          description: "Execute JavaScript in the active Figma file.",
          inputSchema: {
            type: "object",
            properties: {
              code: { type: "string" },
            },
            required: ["code"],
          },
        },
        {
          name: "get_motion_context",
          description: "Get keyframe animation data for a Figma node. Returns animated-node inventory, keyframe tracks, code snippets, and recursive timeline hints.",
          inputSchema: {
            type: "object",
            properties: {
              nodeId: { type: "string" },
              fileKey: { type: "string" },
              recursive: { type: "boolean" },
            },
            required: ["nodeId", "fileKey"],
          },
        },
        {
          name: "export_video",
          description: "Export a Figma timeline node as an MP4 video with polling via jobId.",
          inputSchema: {
            type: "object",
            properties: {
              fileKey: { type: "string" },
              nodeId: { type: "string" },
              jobId: { type: "string" },
              quality: { type: "string", enum: ["low", "medium", "high"] },
            },
            required: ["fileKey"],
          },
        },
        {
          name: "list_shader_effects",
          description: "Lists shader effects in the authenticated user's account library.",
          inputSchema: { type: "object", properties: { cursor: { type: "string" } } },
        },
        {
          name: "get_shader_effect",
          description: "Reads a shader effect from the account library by id.",
          inputSchema: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
        },
        {
          name: "list_shader_fills",
          description: "Lists shader fills in the authenticated user's account library.",
          inputSchema: { type: "object", properties: { cursor: { type: "string" } } },
        },
        {
          name: "get_shader_fill",
          description: "Reads a shader fill from the account library by id.",
          inputSchema: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
        },
      ],
    }),
  });
  const mcpClient = new Client(
    { name: "test-client", version: "0.1.0" },
    { capabilities: {} },
  );
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

  await server.connect(serverTransport);
  await mcpClient.connect(clientTransport);

  const capabilitiesResource = await mcpClient.readResource({ uri: "figma-workspace://capabilities" });
  const guideResource = await mcpClient.readResource({ uri: "figma-workspace://guide" });
  const lookupIndexResource = await mcpClient.readResource({ uri: "figma-workspace://lookup-index" });
  const capabilities = JSON.parse(capabilitiesResource.contents[0].text);
  const guide = JSON.parse(guideResource.contents[0].text);
  const lookupIndex = JSON.parse(lookupIndexResource.contents[0].text);

  assert.equal(capabilitiesResource.contents[0].mimeType, "application/json");
  assert.equal(guideResource.contents[0].mimeType, "application/json");
  assert.equal(lookupIndexResource.contents[0].mimeType, "application/json");
  assert.ok(Buffer.byteLength(capabilitiesResource.contents[0].text, "utf8") <= 6144);
  assert.ok(Buffer.byteLength(guideResource.contents[0].text, "utf8") <= 15360);
  assert.ok(Buffer.byteLength(lookupIndexResource.contents[0].text, "utf8") <= 3072);

  assert.match(capabilities.purpose, /Routing manifest/);
  assert.ok(capabilities.defaultFlow.some((step) => /figma_workspace_prepare_task/.test(step)));
  assert.ok(capabilities.toolSelection.normalPath.includes("figma_workspace_run_script_file"));
  assert.ok(capabilities.toolSelection.contextAndLookup.includes("figma_workspace_lookup"));
  assert.ok(capabilities.toolSelection.advancedEscapeHatches.includes("figma_workspace_call_upstream_tool"));
  assert.match(capabilities.contractNotes.scriptPreflight, /phase=preflight/);
  assert.match(capabilities.contractNotes.scriptPreflight, /upstream was not called/);
  assert.equal(capabilities.resources.guide, "figma-workspace://guide");
  assert.equal(capabilities.resources.lookupIndex, "figma-workspace://lookup-index");
  assert.deepEqual(capabilities.lookupStrategy.outputFields, queryOutputFields);
  assert.ok(capabilities.lookupStrategy.queryAnchors.includes("text/font"));
  assert.ok(capabilities.lookupStrategy.queryAnchors.includes("FigJam/Slides"));
  assert.equal(capabilities.wrapperGuidance.resultField, "guidanceRef");
  assert.ok(capabilities.wrapperGuidance.profileTools.includes("figma_workspace_get_design_context"));
  assert.ok(capabilities.wrapperGuidance.workflowIds.includes("motion-implementation"));
  assert.ok(Object.hasOwn(capabilities.helperGuidance.categories, "selection"));
  assert.ok(capabilities.helperGuidance.categories.text.includes("text"));
  assert.ok(capabilities.helperGuidance.hardRules.some((rule) => /Static only/.test(rule)));
  assert.equal(capabilities.helperGuidance.profileSource, "figma_workspace_guidance.helperProfiles");

  const compactCapabilitiesText = JSON.stringify(capabilities);
  assert.equal(capabilities.responseExamples, undefined);
  assert.equal(capabilities.avoidUnless, undefined);
  assert.equal(capabilities.apiCards, undefined);
  assert.equal(capabilities.patterns, undefined);
  assert.equal(capabilities.scriptWorkflow, undefined);
  assert.equal(capabilities.fileWorkflow, undefined);
  assert.doesNotMatch(compactCapabilitiesText, /responseExamples/);
  assert.doesNotMatch(compactCapabilitiesText, /apiCards/);
  assert.doesNotMatch(compactCapabilitiesText, /rawBytes/);

  assert.match(guide.purpose, /Continuous workflow guide/);
  assert.ok(guide.scriptFileWorkflow.some((step) => /preflights/.test(step)));
  assert.ok(guide.helperIndex.categories.some((category) => category.id === "clone"));
  assert.ok(guide.helperIndex.hardRules.some((rule) => /dynamic \$\[name\]/i.test(rule)));
  assert.ok(guide.evalWorkflow.some((step) => /small ephemeral/.test(step)));
  assert.ok(guide.assetWorkflow.some((step) => /figma_workspace_apply_asset_manifest/.test(step)));
  assert.ok(guide.inspectionAndQa.some((step) => /figma_workspace_capture_node/.test(step)));
  assert.ok(guide.designSystem.some((step) => /figma_workspace_search_design_system/.test(step)));
  assert.ok(guide.upstreamEscapeHatch.some((step) => /figma_workspace_call_upstream_tool/.test(step)));
  assert.ok(guide.responseContract.some((step) => /upstream\.ok/.test(step)));

  assert.equal(lookupIndex.guidance.tool, "figma_workspace_guidance");
  assert.equal(lookupIndex.lookup.tool, "figma_workspace_lookup");
  assert.deepEqual(lookupIndex.guidance.outputFields, queryOutputFields);
  assert.ok(lookupIndex.guidance.commonCards.includes("text.font"));
  assert.ok(lookupIndex.guidance.commonCards.includes("surface.slides"));
  assert.ok(Object.hasOwn(lookupIndex.guidance.helperProfiles.categories, "assets"));
  assert.ok(lookupIndex.guidance.helperProfiles.categories.assets.includes("imageAsset"));
  assert.ok(lookupIndex.guidance.helperProfiles.categories.capture.includes("screenshot"));
  assert.ok(lookupIndex.guidance.helperProfiles.hardRules.some((rule) => /imageAsset/.test(rule)));
  assert.ok(lookupIndex.guidance.wrapperProfiles.upstreamTools.includes("get_motion_context"));
  assert.ok(lookupIndex.guidance.workflowGraph.includes("shader-lookup"));
  assert.match(lookupIndex.ownership, /Bundled corpus stays internal/);

  const tools = await mcpClient.listTools();
  assert.ok(!tools.tools.some((tool) => tool.name === "figma_workspace_capabilities"));
  assert.deepEqual(tools.tools.map((tool) => tool.name).sort(), [
    "figma_workspace_apply_asset_manifest",
    "figma_workspace_call_upstream_tool",
    "figma_workspace_capture_node",
    "figma_workspace_download_assets",
    "figma_workspace_eval",
    "figma_workspace_export_video",
    "figma_workspace_get_design_context",
    "figma_workspace_get_libraries",
    "figma_workspace_get_metadata",
    "figma_workspace_get_motion_context",
    "figma_workspace_get_shader_effect",
    "figma_workspace_get_shader_fill",
    "figma_workspace_get_variable_defs",
    "figma_workspace_guidance",
    "figma_workspace_inspect",
    "figma_workspace_list_shader_effects",
    "figma_workspace_list_shader_fills",
    "figma_workspace_lookup",
    "figma_workspace_open",
    "figma_workspace_prepare_task",
    "figma_workspace_run_script_file",
    "figma_workspace_run_task_plan",
    "figma_workspace_search_design_system",
  ]);
  assert.equal(tools.tools.length, 23);
  for (const tool of tools.tools) {
    assert.equal(
      tool.inputSchema.properties.title.description,
      "Optional MCP call display label for Codex/UI only; validated as a string but not saved, defaulted, or used for task/file naming.",
      `${tool.name} keeps title display-only`,
    );
    assert.equal(
      (tool.inputSchema.required ?? []).includes("title"),
      false,
      `${tool.name} does not require title`,
    );
    assert.equal(tool.inputSchema.properties.debug, undefined, `${tool.name} does not expose debug`);
    assert.equal(tool.inputSchema.properties.verboseResults, undefined, `${tool.name} does not expose verboseResults`);
  }
  const runScriptFileTool = tools.tools.find((tool) => tool.name === "figma_workspace_run_script_file");
  assert.ok(runScriptFileTool);
  assert.match(runScriptFileTool.description, /always preflights diagnostics/);
  assert.match(runScriptFileTool.description, /Debug JSON files are generated on demand/);
  assert.match(runScriptFileTool.description, /fixed upstream use_figma\/code/);
  assert.doesNotMatch(runScriptFileTool.description, /\$\[name\]/);
  assert.equal(runScriptFileTool.inputSchema.properties.dryRun, undefined);
  assert.match(runScriptFileTool.inputSchema.properties.inputFile.description, /Recommended workspace script file name/);
  assert.match(runScriptFileTool.inputSchema.properties.inputFile.description, /preferred over scriptPath/);
  assert.match(runScriptFileTool.inputSchema.properties.scriptPath.description, /escape hatch/);
  assert.equal(runScriptFileTool.inputSchema.properties.outputFile, undefined);
  assert.equal(runScriptFileTool.inputSchema.properties.resultFile, undefined);
  assert.equal(runScriptFileTool.inputSchema.properties.outputDir, undefined);
  assert.equal(runScriptFileTool.inputSchema.properties.diagnosticsFile, undefined);
  assert.equal(runScriptFileTool.inputSchema.properties.summaryFile, undefined);
  assert.match(runScriptFileTool.inputSchema.properties.surface.description, /Expected Figma surface/);
  assert.equal(runScriptFileTool.inputSchema.properties.upstreamTool, undefined);
  assert.equal(runScriptFileTool.inputSchema.properties.upstreamArgument, undefined);
  assert.equal(runScriptFileTool.inputSchema.properties.upstreamArguments, undefined);
  assert.match(runScriptFileTool.inputSchema.properties.inlineResultLimit.description, /10 KB/);
  assert.match(runScriptFileTool.inputSchema.properties.inlineResultLimit.description, /0 forces/);
  assert.match(runScriptFileTool.inputSchema.properties.inlineResultLimit.description, /complete upstream results stay in outputFiles\.upstreamFile/);
  assert.equal(runScriptFileTool.inputSchema.properties.inlineResultLimit.default, 4000);
  assert.equal(runScriptFileTool.inputSchema.properties.inlineResultLimit.maximum, 10000);
  assert.equal(runScriptFileTool.inputSchema.properties.inlineResultLimit.minimum, 0);
  assert.ok(runScriptFileTool.outputSchema.properties.outputFiles.properties.debugFile);
  assert.ok(runScriptFileTool.outputSchema.properties.outputFiles.properties.upstreamFile);
  assert.ok(runScriptFileTool.outputSchema.properties.outputFiles.properties.compiledScriptFile);
  assert.equal(runScriptFileTool.outputSchema.properties.outputFiles.properties.diagnosticsFile, undefined);
  assert.equal(runScriptFileTool.outputSchema.properties.outputFiles.properties.summaryFile, undefined);
  assert.match(runScriptFileTool.outputSchema.properties.ok.description, /local Figma Workspace wrapper\/tool completed/);
  assert.match(runScriptFileTool.outputSchema.properties.ok.description, /upstream\.ok reports effective upstream success/);
  assert.match(runScriptFileTool.outputSchema.properties.upstream.description, /upstream\.ok reports effective upstream success/);
  assert.match(runScriptFileTool.outputSchema.properties.upstream.description, /consumed top-level ok fields are removed/);
  assert.match(runScriptFileTool.outputSchema.properties.upstream.description, /__figmaRepl metadata is removed/);
  assert.equal(runScriptFileTool.outputSchema.properties.upstream.properties.callOk, undefined);
  assert.equal(runScriptFileTool.outputSchema.properties.upstream.properties.payload, undefined);
  assert.match(runScriptFileTool.outputSchema.properties.upstream.properties.ok.description, /Effective upstream success/);
  assert.match(runScriptFileTool.outputSchema.properties.upstream.properties.result.description, /consumes and removes/);
  assert.match(runScriptFileTool.outputSchema.properties.upstream.properties.result.description, /failure provenance/);
  assert.ok(runScriptFileTool.outputSchema.properties.inlineResultLimit.properties.omitted.items.properties.field);
  assert.deepEqual(
    Object.keys(runScriptFileTool.outputSchema.properties.script.properties).sort(),
    ["compiledScriptBytes", "expectedSurface", "scriptPath"],
  );
  const evalTool = tools.tools.find((tool) => tool.name === "figma_workspace_eval");
  assert.ok(evalTool);
  assert.match(evalTool.description, /Small ephemeral JavaScript call/);
  assert.match(evalTool.description, /prepare_task \+ run_script_file/);
  assert.doesNotMatch(evalTool.description, /\$\[name\]/);
  assert.equal(evalTool.inputSchema.properties.outputFile, undefined);
  assert.match(evalTool.inputSchema.properties.inlineResultLimit.description, /10 KB/);
  assert.match(evalTool.inputSchema.properties.inlineResultLimit.description, /0 forces/);
  assert.equal(evalTool.inputSchema.properties.inlineResultLimit.default, 4000);
  assert.equal(evalTool.inputSchema.properties.inlineResultLimit.maximum, 10000);
  assert.equal(evalTool.inputSchema.properties.inlineResultLimit.minimum, 0);
  assert.deepEqual(evalTool.inputSchema.required, ["code"]);
  assert.equal(evalTool.inputSchema.properties.upstreamTool, undefined);
  assert.equal(evalTool.inputSchema.properties.upstreamArgument, undefined);
  assert.equal(evalTool.inputSchema.properties.upstreamArguments, undefined);
  assert.match(evalTool.inputSchema.properties.handleUpdates.description, /handle-import escape hatch/);
  assert.ok(evalTool.outputSchema.properties.outputFiles.properties.upstreamFile);
  assert.deepEqual(evalTool.outputSchema.properties.upstream.properties.kind.enum, ["json", "text", "unknown"]);
  assert.match(evalTool.outputSchema.properties.ok.description, /local Figma Workspace wrapper\/tool completed/);
  assert.match(evalTool.outputSchema.properties.upstream.description, /upstream\.ok reports effective upstream success/);
  assert.match(evalTool.outputSchema.properties.upstream.description, /__figmaRepl metadata is removed/);
  assert.equal(evalTool.outputSchema.properties.upstream.properties.callOk, undefined);
  assert.equal(evalTool.outputSchema.properties.upstream.properties.payload, undefined);
  assert.match(evalTool.outputSchema.properties.upstream.properties.ok.description, /Effective upstream success/);
  assert.match(evalTool.outputSchema.properties.upstream.properties.result.description, /raw official JSON/);
  assert.equal(evalTool.outputSchema.properties.upstreamTool, undefined);
  assert.equal(evalTool.outputSchema.properties.upstreamArgument, undefined);
  const openTool = tools.tools.find((tool) => tool.name === "figma_workspace_open");
  assert.ok(openTool);
  assert.match(openTool.description, /Recommended call: \{ sessionId, file, surface \}/);
  assert.match(openTool.description, /without tool discovery/);
  assert.match(openTool.inputSchema.properties.file.description, /Figma file URL or raw file key/);
  assert.match(openTool.inputSchema.properties.connect.description, /without listing tools/);
  assert.equal(openTool.inputSchema.properties.connect.default, true);
  assert.equal(openTool.inputSchema.properties.fileUrl, undefined);
  assert.equal(openTool.inputSchema.properties.fileKey, undefined);
  assert.equal(openTool.inputSchema.properties.expectedSurface, undefined);
  assert.equal(openTool.inputSchema.properties.refresh, undefined);
  assert.equal(openTool.inputSchema.properties.upstreamTool, undefined);
  assert.equal(openTool.inputSchema.properties.upstreamArgument, undefined);
  assert.equal(openTool.inputSchema.properties.upstreamArguments, undefined);
  assert.equal(openTool.outputSchema.properties.upstreamTools, undefined);
  const assetManifestTool = tools.tools.find((tool) => tool.name === "figma_workspace_apply_asset_manifest");
  assert.ok(assetManifestTool);
  assert.match(assetManifestTool.description, /Recommended workspace call: \{ sessionId, manifestPath \}/);
  assert.match(assetManifestTool.inputSchema.properties.manifestPath.description, /Recommended manifest file path/);
  assert.match(assetManifestTool.inputSchema.properties.assets.description, /Advanced inline asset entries/);
  assert.equal(assetManifestTool.inputSchema.properties.toolName, undefined);
  assert.equal(assetManifestTool.inputSchema.properties.arguments, undefined);
  assert.equal(assetManifestTool.inputSchema.properties.refresh, undefined);
  assert.equal(assetManifestTool.inputSchema.properties.validateTargets.default, true);
  assert.equal(assetManifestTool.inputSchema.properties.argumentsTemplate, undefined);
  assert.equal(assetManifestTool.inputSchema.properties.resultFile, undefined);
  assert.equal(assetManifestTool.inputSchema.properties.outputFile, undefined);
  assert.equal(assetManifestTool.inputSchema.properties.inlineResultLimit, undefined);
  assert.equal(assetManifestTool.outputSchema.properties.assets.items.properties.toolName, undefined);
  assert.equal(assetManifestTool.outputSchema.properties.assets.items.properties.upload, undefined);
  assert.equal(assetManifestTool.outputSchema.properties.assets.items.properties.upstreamSummary, undefined);
  assert.equal(assetManifestTool.outputSchema.properties.assets.items.properties.error, undefined);
  assert.ok(assetManifestTool.outputSchema.properties.assets.items.properties.upstreamError);
  assert.ok(assetManifestTool.outputSchema.properties.outputFiles.properties.debugFile);
  const downloadAssetsTool = tools.tools.find((tool) => tool.name === "figma_workspace_download_assets");
  assert.ok(downloadAssetsTool);
  assert.match(downloadAssetsTool.description, /official Figma asset downloads/);
  assert.match(downloadAssetsTool.description, /targets:\[\{ target/);
  assert.deepEqual(
    Object.keys(downloadAssetsTool.inputSchema.properties).sort(),
    ["manifestPath", "outputDir", "sessionId", "targets", "title"],
  );
  assert.equal(downloadAssetsTool.inputSchema.properties.target, undefined);
  assert.equal(downloadAssetsTool.inputSchema.properties.assets, undefined);
  assert.equal(downloadAssetsTool.inputSchema.properties.toolName, undefined);
  assert.equal(downloadAssetsTool.inputSchema.properties.arguments, undefined);
  assert.equal(downloadAssetsTool.inputSchema.properties.refresh, undefined);
  assert.equal(downloadAssetsTool.inputSchema.properties.download, undefined);
  assert.deepEqual(
    Object.keys(downloadAssetsTool.inputSchema.properties.targets.items.properties).sort(),
    ["defaultFormat", "defaultScale", "name", "target"],
  );
  assert.deepEqual(downloadAssetsTool.inputSchema.properties.targets.items.properties.defaultFormat.enum, ["png", "jpg", "svg", "pdf"]);
  assert.equal(downloadAssetsTool.inputSchema.properties.targets.items.properties.defaultScale.minimum, 0.01);
  assert.equal(downloadAssetsTool.inputSchema.properties.targets.items.properties.defaultScale.maximum, 4);
  assert.ok(downloadAssetsTool.outputSchema.properties.targets.items.properties.downloadedFiles);
  assert.ok(downloadAssetsTool.outputSchema.properties.targets.items.properties.downloadedFiles.items.properties.sourceUrl);
  assert.equal(downloadAssetsTool.outputSchema.properties.targets.items.properties.upstreamSummary, undefined);
  assert.equal(downloadAssetsTool.outputSchema.properties.targets.items.properties.error, undefined);
  assert.ok(downloadAssetsTool.outputSchema.properties.targets.items.properties.upstreamError);
  assert.ok(downloadAssetsTool.outputSchema.properties.targets.items.properties.downloadError);
  assert.ok(downloadAssetsTool.outputSchema.properties.outputFiles.properties.debugFile);
  const captureNodeTool = tools.tools.find((tool) => tool.name === "figma_workspace_capture_node");
  assert.ok(captureNodeTool);
  assert.match(captureNodeTool.description, /imageFile\?/);
  assert.match(captureNodeTool.description, /saved as PNG/);
  assert.deepEqual(captureNodeTool.inputSchema.required, ["target"]);
  assert.equal(captureNodeTool.inputSchema.required.includes("title"), false);
  assert.equal(captureNodeTool.inputSchema.properties.nodeId, undefined);
  assert.equal(captureNodeTool.inputSchema.properties.targetNodeId, undefined);
  assert.equal(captureNodeTool.inputSchema.properties.handle, undefined);
  assert.match(captureNodeTool.inputSchema.properties.target.description, /Target node/);
  assert.match(captureNodeTool.inputSchema.properties.target.description, /\{ fileKey, nodeId \}/);
  assert.equal(captureNodeTool.inputSchema.properties.outputFile, undefined);
  assert.match(captureNodeTool.inputSchema.properties.imageFile.description, /local PNG output path/);
  assert.match(captureNodeTool.inputSchema.properties.imageFile.description, /non-\.png values normalize to \.png/);
  assert.equal(captureNodeTool.inputSchema.properties.metadataFile, undefined);
  assert.equal(captureNodeTool.inputSchema.properties.preview, undefined);
  assert.equal(captureNodeTool.inputSchema.properties.thumbnail, undefined);
  assert.equal(captureNodeTool.inputSchema.properties.thumbnailMaxSize, undefined);
  assert.equal(captureNodeTool.inputSchema.properties.toolName, undefined);
  assert.equal(captureNodeTool.inputSchema.properties.arguments, undefined);
  assert.equal(captureNodeTool.inputSchema.properties.refresh, undefined);
  assert.equal(captureNodeTool.inputSchema.properties.inlineResultLimit, undefined);
  assert.equal(captureNodeTool.outputSchema.properties.preview, undefined);
  assert.equal(captureNodeTool.outputSchema.properties.thumbnail, undefined);
  assert.ok(captureNodeTool.outputSchema.properties.imageFile);
  assert.ok(captureNodeTool.outputSchema.properties.bytes);
  assert.ok(captureNodeTool.outputSchema.properties.width);
  assert.ok(captureNodeTool.outputSchema.properties.height);
  assert.ok(captureNodeTool.outputSchema.properties.upstreamError);
  assert.equal(captureNodeTool.outputSchema.properties.outputFiles, undefined);
  assert.equal(captureNodeTool.outputSchema.properties.plannedOutputFile, undefined);
  assert.equal(captureNodeTool.outputSchema.properties.handle, undefined);
  assert.equal(captureNodeTool.outputSchema.properties.toolName, undefined);
  assert.equal(captureNodeTool.outputSchema.properties.kind, undefined);
  assert.equal(captureNodeTool.outputSchema.properties.mimeType, undefined);
  assert.equal(captureNodeTool.outputSchema.properties.qa, undefined);
  assert.equal(captureNodeTool.outputSchema.properties.upstream, undefined);
  const taskPlanTool = tools.tools.find((tool) => tool.name === "figma_workspace_run_task_plan");
  assert.ok(taskPlanTool);
  assert.match(taskPlanTool.description, /Recommended file-plan call: \{ sessionId, planPath \}/);
  assert.match(taskPlanTool.description, /\{ id\?, type\?, args\? \}/);
  assert.match(taskPlanTool.inputSchema.properties.planPath.description, /Recommended JSON plan path/);
  assert.match(taskPlanTool.inputSchema.properties.steps.description, /Advanced inline steps/);
  assert.equal(taskPlanTool.inputSchema.properties.stopOnFailure.default, true);
  assert.equal(taskPlanTool.outputSchema.properties.stopOnFailure, undefined);
  assert.equal(taskPlanTool.inputSchema.properties.steps.items.additionalProperties, false);
  assert.deepEqual(Object.keys(taskPlanTool.inputSchema.properties.steps.items.properties).sort(), ["args", "id", "type"]);
  assert.equal(taskPlanTool.inputSchema.properties.outputFile, undefined);
  assert.equal(taskPlanTool.inputSchema.properties.resultFile, undefined);
  assert.equal(taskPlanTool.inputSchema.properties.inlineResultLimit, undefined);
  assert.deepEqual(
    Object.keys(taskPlanTool.outputSchema.properties.failures.items.properties).sort(),
    ["error", "id", "index", "status", "type"],
  );
  const prepareTaskTool = tools.tools.find((tool) => tool.name === "figma_workspace_prepare_task");
  assert.ok(prepareTaskTool);
  assert.match(prepareTaskTool.description, /Recommended workspace call: \{ file, taskName, surface \}/);
  assert.match(prepareTaskTool.inputSchema.properties.file.description, /Figma file URL or raw file key/);
  assert.equal(prepareTaskTool.inputSchema.properties.fileUrl, undefined);
  assert.equal(prepareTaskTool.inputSchema.properties.fileKey, undefined);
  assert.equal(prepareTaskTool.inputSchema.properties.intent, undefined);
  assert.equal(prepareTaskTool.inputSchema.properties.goal, undefined);
  assert.equal(prepareTaskTool.inputSchema.properties.task, undefined);
  assert.match(prepareTaskTool.inputSchema.properties.taskName.description, /slug-style task\/workspace name/);
  assert.equal(prepareTaskTool.inputSchema.properties.taskDir, undefined);
  assert.equal(prepareTaskTool.inputSchema.properties.scriptName, undefined);
  assert.equal(prepareTaskTool.inputSchema.properties.expectedSurface, undefined);
  assert.match(prepareTaskTool.inputSchema.properties.workspaceDir.description, /Advanced absolute workspace/);
  assert.match(prepareTaskTool.inputSchema.properties.surface.description, /Recommended expected Figma surface/);
  assert.match(prepareTaskTool.inputSchema.properties.taskRoot.description, /Advanced absolute task root/);
  assert.match(prepareTaskTool.inputSchema.properties.overwrite.description, /Advanced destructive/);
  assert.ok(prepareTaskTool.outputSchema.properties.taskChange);
  assert.ok(prepareTaskTool.outputSchema.properties.taskChange.properties.previous);
  assert.ok(prepareTaskTool.outputSchema.properties.taskChange.properties.current);
  assert.ok(prepareTaskTool.outputSchema.properties.taskChange.properties.changed);
  assert.equal(prepareTaskTool.outputSchema.properties.outputFiles, undefined);
  const inspectTool = tools.tools.find((tool) => tool.name === "figma_workspace_inspect");
  assert.ok(inspectTool);
  assert.match(inspectTool.description, /fixed upstream use_figma/);
  assert.deepEqual(inspectTool.inputSchema.properties.mode.enum, ["inspect", "validate", "style"]);
  assert.equal(inspectTool.inputSchema.properties.upstreamTool, undefined);
  assert.equal(inspectTool.inputSchema.properties.upstreamArgument, undefined);
  assert.equal(inspectTool.inputSchema.properties.upstreamArguments, undefined);
  assert.equal(inspectTool.outputSchema.properties.upstream, undefined);
  assert.equal(inspectTool.outputSchema.properties.primaryFix, undefined);
  assert.ok(inspectTool.outputSchema.properties.upstreamError);
  assert.ok(inspectTool.outputSchema.properties.style.properties.topColors);
  assert.ok(inspectTool.outputSchema.properties.style.properties.textStyles);
  assert.ok(inspectTool.outputSchema.properties.style.properties.imageNodes);
  assert.ok(inspectTool.outputSchema.properties.validations.items.properties.handle);
  assert.ok(inspectTool.outputSchema.properties.validations.items.properties.status);
  const getMetadataTool = tools.tools.find((tool) => tool.name === "figma_workspace_get_metadata");
  assert.ok(getMetadataTool);
  assert.match(getMetadataTool.description, /Metadata-first read tool/);
  assert.match(getMetadataTool.description, /converts returned XML into a compact JSON node tree/);
  assert.ok(getMetadataTool.inputSchema.properties.file);
  assert.ok(getMetadataTool.inputSchema.properties.target);
  assert.ok(getMetadataTool.inputSchema.properties.inlineResultLimit);
  assert.match(getMetadataTool.inputSchema.properties.inlineResultLimit.description, /10 KB/);
  assert.match(getMetadataTool.inputSchema.properties.inlineResultLimit.description, /0 forces/);
  assert.equal(getMetadataTool.inputSchema.properties.inlineResultLimit.default, 4000);
  assert.equal(getMetadataTool.inputSchema.properties.inlineResultLimit.maximum, 10000);
  assert.equal(getMetadataTool.inputSchema.properties.inlineResultLimit.minimum, 0);
  assert.equal(getMetadataTool.inputSchema.properties.outputFile, undefined);
  assert.equal(getMetadataTool.inputSchema.properties.resultFile, undefined);
  assert.equal(getMetadataTool.inputSchema.properties.metadataFile, undefined);
  assert.ok(getMetadataTool.outputSchema.properties.metadata);
  assert.ok(getMetadataTool.outputSchema.properties.outputFiles.properties.metadataFile);
  assert.equal(getMetadataTool.outputSchema.properties.outputFiles.properties.upstreamFile, undefined);
  assert.ok(getMetadataTool.outputSchema.properties.inlineResultLimit);
  const getDesignContextTool = tools.tools.find((tool) => tool.name === "figma_workspace_get_design_context");
  assert.ok(getDesignContextTool);
  assert.match(getDesignContextTool.description, /official upstream get_design_context/);
  assert.ok(getDesignContextTool.inputSchema.properties.target);
  assert.ok(getDesignContextTool.inputSchema.properties.clientLanguages);
  assert.ok(getDesignContextTool.inputSchema.properties.clientFrameworks);
  assert.ok(getDesignContextTool.inputSchema.properties.inlineResultLimit);
  assert.ok(getDesignContextTool.outputSchema.properties.nodeId);
  assert.ok(getDesignContextTool.outputSchema.properties.upstream);
  assert.ok(getDesignContextTool.outputSchema.properties.outputFiles.properties.upstreamFile);
  assert.equal(getDesignContextTool.outputSchema.properties.videoFile, undefined);
  const getMotionContextTool = tools.tools.find((tool) => tool.name === "figma_workspace_get_motion_context");
  assert.ok(getMotionContextTool);
  assert.match(getMotionContextTool.description, /official upstream get_motion_context/);
  assert.ok(getMotionContextTool.inputSchema.properties.recursive);
  assert.ok(getMotionContextTool.outputSchema.properties.nodeId);
  assert.ok(getMotionContextTool.outputSchema.properties.upstream);
  const exportVideoTool = tools.tools.find((tool) => tool.name === "figma_workspace_export_video");
  assert.ok(exportVideoTool);
  assert.match(exportVideoTool.description, /official upstream export_video/);
  assert.deepEqual(exportVideoTool.inputSchema.properties.quality.enum, ["low", "medium", "high"]);
  assert.ok(exportVideoTool.inputSchema.properties.jobId);
  assert.ok(exportVideoTool.outputSchema.properties.jobId);
  assert.equal(exportVideoTool.outputSchema.properties.videoFile, undefined);
  const searchDesignSystemTool = tools.tools.find((tool) => tool.name === "figma_workspace_search_design_system");
  assert.ok(searchDesignSystemTool);
  assert.deepEqual(searchDesignSystemTool.inputSchema.required, ["query"]);
  assert.match(searchDesignSystemTool.description, /Thin first-class wrapper/);
  assert.match(searchDesignSystemTool.inputSchema.properties.query.description, /Required official search_design_system query/);
  assert.ok(searchDesignSystemTool.inputSchema.properties.disableCodeConnect);
  assert.ok(searchDesignSystemTool.inputSchema.properties.includeComponents);
  assert.ok(searchDesignSystemTool.inputSchema.properties.includeVariables);
  assert.ok(searchDesignSystemTool.inputSchema.properties.includeStyles);
  assert.ok(searchDesignSystemTool.inputSchema.properties.includeLibraryKeys);
  assert.ok(searchDesignSystemTool.inputSchema.properties.inlineResultLimit);
  assert.ok(searchDesignSystemTool.outputSchema.properties.upstream);
  assert.ok(searchDesignSystemTool.outputSchema.properties.outputFiles.properties.upstreamFile);
  assert.equal(searchDesignSystemTool.outputSchema.properties.toolName, undefined);
  const getLibrariesTool = tools.tools.find((tool) => tool.name === "figma_workspace_get_libraries");
  assert.ok(getLibrariesTool);
  assert.equal(getLibrariesTool.inputSchema.properties.offset.type, "number");
  assert.match(getLibrariesTool.description, /official upstream get_libraries/);
  assert.ok(getLibrariesTool.outputSchema.properties.upstream);
  assert.ok(getLibrariesTool.outputSchema.properties.outputFiles.properties.debugFile);
  assert.equal(getLibrariesTool.outputSchema.properties.toolName, undefined);
  const getVariableDefsTool = tools.tools.find((tool) => tool.name === "figma_workspace_get_variable_defs");
  assert.ok(getVariableDefsTool);
  assert.match(getVariableDefsTool.description, /target accepts a raw node id, node URL, local handle/);
  assert.match(getVariableDefsTool.inputSchema.properties.clientLanguages.description, /Defaults to unknown/);
  assert.equal(getVariableDefsTool.inputSchema.properties.nodeId, undefined);
  assert.ok(getVariableDefsTool.outputSchema.properties.nodeId);
  assert.ok(getVariableDefsTool.outputSchema.properties.upstream);
  assert.ok(getVariableDefsTool.outputSchema.properties.outputFiles.properties.upstreamFile);
  assert.equal(getVariableDefsTool.outputSchema.properties.toolName, undefined);
  const listShaderEffectsTool = tools.tools.find((tool) => tool.name === "figma_workspace_list_shader_effects");
  assert.ok(listShaderEffectsTool);
  assert.ok(listShaderEffectsTool.inputSchema.properties.cursor);
  assert.ok(listShaderEffectsTool.outputSchema.properties.upstream);
  const getShaderEffectTool = tools.tools.find((tool) => tool.name === "figma_workspace_get_shader_effect");
  assert.ok(getShaderEffectTool);
  assert.deepEqual(getShaderEffectTool.inputSchema.required, ["id"]);
  assert.ok(getShaderEffectTool.outputSchema.properties.id);
  const listShaderFillsTool = tools.tools.find((tool) => tool.name === "figma_workspace_list_shader_fills");
  assert.ok(listShaderFillsTool);
  assert.ok(listShaderFillsTool.inputSchema.properties.cursor);
  assert.ok(listShaderFillsTool.outputSchema.properties.upstream);
  const getShaderFillTool = tools.tools.find((tool) => tool.name === "figma_workspace_get_shader_fill");
  assert.ok(getShaderFillTool);
  assert.deepEqual(getShaderFillTool.inputSchema.required, ["id"]);
  assert.ok(getShaderFillTool.outputSchema.properties.id);
  for (const wrapperTool of [
    getDesignContextTool,
    getMotionContextTool,
    exportVideoTool,
    listShaderEffectsTool,
    getShaderEffectTool,
    listShaderFillsTool,
    getShaderFillTool,
  ]) {
    assert.ok(wrapperTool.outputSchema.properties.guidanceRef, `${wrapperTool.name} advertises guidanceRef`);
    assert.equal(wrapperTool.outputSchema.properties.guidance, undefined, `${wrapperTool.name} does not advertise guidance`);
    assert.deepEqual(wrapperTool.outputSchema.properties.guidanceRef.properties.source.enum, ["figma_workspace_guidance"]);
    assert.ok(wrapperTool.outputSchema.properties.guidanceRef.properties.query);
    assert.ok(wrapperTool.outputSchema.properties.guidanceRef.properties.workflowIds);
  }
  const guidanceMetadataTool = tools.tools.find((tool) => tool.name === "figma_workspace_guidance");
  assert.ok(guidanceMetadataTool);
  assert.match(guidanceMetadataTool.description, /BM25-style keyword queries/);
  assert.ok(guidanceMetadataTool.outputSchema.properties.catalogSize);
  assert.ok(guidanceMetadataTool.outputSchema.properties.guidance);
  assert.ok(guidanceMetadataTool.outputSchema.properties.helperProfiles);
  assert.ok(guidanceMetadataTool.outputSchema.properties.suggestions.properties.referenceContext);
  assert.ok(guidanceMetadataTool.outputSchema.properties.suggestions.properties.referenceContext.items.properties.matchType);
  assert.equal(guidanceMetadataTool.outputSchema.properties.mode, undefined);
  assert.equal(guidanceMetadataTool.inputSchema.properties.intent, undefined);
  assert.equal(guidanceMetadataTool.inputSchema.properties.goal, undefined);
  assert.equal(guidanceMetadataTool.inputSchema.properties.expectedSurface, undefined);
  const lookupMetadataTool = tools.tools.find((tool) => tool.name === "figma_workspace_lookup");
  assert.ok(lookupMetadataTool);
  assert.match(lookupMetadataTool.description, /kind=docs use query/);
  assert.deepEqual(lookupMetadataTool.inputSchema.required, ["kind"]);
  assert.match(lookupMetadataTool.inputSchema.properties.symbol.description, /Recommended for kind=api/);
  assert.match(lookupMetadataTool.inputSchema.properties.maxResults.description, /Result-size control only/);
  assert.equal(lookupMetadataTool.outputSchema.properties.kind, undefined);
  assert.equal(lookupMetadataTool.outputSchema.properties.query, undefined);
  assert.equal(lookupMetadataTool.outputSchema.properties.symbol, undefined);
  assert.equal(lookupMetadataTool.outputSchema.properties.maxResults, undefined);
  assert.equal(lookupMetadataTool.outputSchema.properties.maxSnippetLines, undefined);
  const callUpstreamTool = tools.tools.find((tool) => tool.name === "figma_workspace_call_upstream_tool");
  assert.ok(callUpstreamTool);
  assert.match(callUpstreamTool.description, /Explicit upstream-only escape hatch/);
  assert.match(callUpstreamTool.description, /figma-workspace:\/\/upstream-tools\/\{name\}/);
  assert.match(callUpstreamTool.description, /Do not use for use_figma, get_metadata, get_screenshot, upload_assets, download_assets, get_design_context, get_motion_context, export_video/);
  assert.equal(callUpstreamTool.inputSchema.properties.outputFile, undefined);
  assert.ok(callUpstreamTool.inputSchema.properties.inlineResultLimit);
  assert.equal(callUpstreamTool.inputSchema.properties.inlineResultLimit.default, 4000);
  assert.equal(callUpstreamTool.inputSchema.properties.inlineResultLimit.maximum, 10000);
  assert.equal(callUpstreamTool.inputSchema.properties.inlineResultLimit.minimum, 0);
  assert.ok(callUpstreamTool.outputSchema.properties.outputFiles.properties.upstreamFile);
  assert.ok(callUpstreamTool.outputSchema.properties.inlineResultLimit.properties.omitted);
  await assert.rejects(
    () => mcpClient.callTool({
      name: "figma_workspace_capabilities",
      arguments: { title: "Read capabilities" },
    }),
    /Unknown figma_workspace_mcp tool: figma_workspace_capabilities/,
  );
  for (const deletedTool of [
    "figma_workspace_init_workspace",
    "figma_workspace_plan_task",
    "figma_workspace_cache_get",
    "figma_workspace_validate_handles",
    "figma_workspace_list_upstream_tools",
    "figma_workspace_docs_search",
    "figma_workspace_api_lookup",
    "figma_workspace_suggest_api",
    "figma_workspace_api_card",
  ]) {
    await assert.rejects(
      () => mcpClient.callTool({
        name: deletedTool,
        arguments: { title: "Deleted tool" },
      }),
      new RegExp(`Unknown figma_workspace_mcp tool: ${deletedTool}`),
    );
  }
  for (const tool of tools.tools) {
    assert.equal(tool.inputSchema?.properties?.returnMode, undefined, `${tool.name} does not promote returnMode`);
    assert.equal(tool.inputSchema?.properties?.includeRawUpstream, undefined, `${tool.name} does not promote raw inline inputs`);
    assert.equal(tool.outputSchema?.type, "object", `${tool.name} advertises an object outputSchema`);
    assert.equal(tool.outputSchema?.properties?.ok?.type, "boolean", `${tool.name} pins ok in outputSchema`);
    assert.equal(tool.outputSchema?.properties?.raw, undefined, `${tool.name} does not advertise raw inline output`);
    assert.deepEqual(tool.outputSchema?.required, ["ok"], `${tool.name} requires ok in outputSchema`);
    assert.equal(tool.outputSchema?.additionalProperties, true, `${tool.name} keeps outputSchema forward-compatible`);
    const outputPropertyLimit = tool.name === "figma_workspace_guidance" ? 17 : 13;
    assert.ok(
      Object.keys(tool.outputSchema?.properties ?? {}).length <= outputPropertyLimit,
      `${tool.name} outputSchema stays concise`,
    );
  }
  const guidanceTool = tools.tools.find((tool) => tool.name === "figma_workspace_guidance");
  assert.match(guidanceTool.inputSchema.properties.query.description, /BM25-style keyword search query/);
  assert.equal(guidanceTool.inputSchema.properties.intent, undefined);
  assert.equal(guidanceTool.inputSchema.properties.goal, undefined);
  assert.match(guidanceTool.inputSchema.properties.card.description, /Hard limit 120 characters/);
  assert.match(guidanceTool.inputSchema.properties.query.description, /Hard limit 120 characters/);
  const lookupTool = tools.tools.find((tool) => tool.name === "figma_workspace_lookup");
  assert.match(lookupTool.inputSchema.properties.query.description, /Hard limit 120 characters/);
  assert.match(lookupTool.inputSchema.properties.symbol.description, /Hard limit 120 characters/);

  const resources = await mcpClient.listResources();
  const uris = resources.resources.map((resource) => resource.uri);
  const staticResources = resources.resources.filter((resource) => !resource.uri.startsWith("figma-workspace://sessions/"));
  assert.deepEqual(staticResources.map((resource) => resource.uri).sort(), expectedStaticResourceUris);
  assert.ok(!uris.includes("figma-workspace://helpers"));
  for (const resource of staticResources) {
    assert.match(resource.description ?? "", /Read (first|when|only)/, `${resource.uri} has actionable description`);
  }
  assert.ok(uris.every((uri) => !uri.includes("official-figma-skills")));
  assert.ok(uris.every((uri) => !uri.includes("/references/")));

  const resourceTemplates = await mcpClient.listResourceTemplates();
  assert.deepEqual(resourceTemplates.resourceTemplates, [
    {
      uriTemplate: "figma-workspace://sessions/{id}",
      name: "Figma Workspace session by id",
      description: "Read when you need compact state, remembered handles, and workspace file context for a known workspace session id.",
      mimeType: "application/json",
    },
    {
      uriTemplate: "figma-workspace://sessions/{id}/handles",
      name: "Figma Workspace session handles by id",
      description: "Read when you need the full remembered handle map for a known workspace session id without reading full session history.",
      mimeType: "application/json",
    },
    {
      uriTemplate: "figma-workspace://upstream-tools/{name}",
      name: "Figma upstream MCP tool by name",
      description: "Read only after figma-workspace://upstream-tools when you need the full upstream tool description and inputSchema for one official tool.",
      mimeType: "application/json",
    },
  ]);

  const aggregateResource = await mcpClient.readResource({ uri: "figma-workspace://capabilities" });
  const aggregateCapabilities = JSON.parse(aggregateResource.contents[0].text);
  const aggregateGuideResource = await mcpClient.readResource({ uri: "figma-workspace://guide" });
  const aggregateLookupIndexResource = await mcpClient.readResource({ uri: "figma-workspace://lookup-index" });
  const aggregateGuide = JSON.parse(aggregateGuideResource.contents[0].text);
  const aggregateLookupIndex = JSON.parse(aggregateLookupIndexResource.contents[0].text);
  assert.equal(aggregateCapabilities.resources.guide, "figma-workspace://guide");
  assert.equal(aggregateCapabilities.resources.lookupIndex, "figma-workspace://lookup-index");
  assert.ok(aggregateCapabilities.toolSelection.contextAndLookup.includes("figma_workspace_get_motion_context"));
  assert.ok(aggregateCapabilities.toolSelection.contextAndLookup.includes("figma_workspace_list_shader_effects"));
  assert.ok(aggregateCapabilities.toolSelection.workflowAddOns.includes("figma_workspace_export_video"));
  assert.ok(!aggregateCapabilities.toolSelection.upstreamEscapeHatchExamples.includes("get_motion_context"));
  assert.deepEqual(aggregateCapabilities.lookupStrategy.outputFields, queryOutputFields);
  assert.ok(aggregateCapabilities.wrapperGuidance.profileTools.includes("figma_workspace_export_video"));
  assert.ok(Object.hasOwn(aggregateCapabilities.helperGuidance.categories, "layout"));
  assert.ok(aggregateCapabilities.helperGuidance.hardRules.some((rule) => /Forbid dynamic/.test(rule)));
  assert.equal(aggregateCapabilities.apiCards, undefined);
  assert.equal(aggregateCapabilities.docsLookup, undefined);
  assert.ok(aggregateGuide.scriptFileWorkflow.some((step) => /figma_workspace_prepare_task/.test(step)));
  assert.ok(aggregateGuide.helperIndex.categories.some((category) => category.helpers.includes("$.replaceGeneratedFrame")));
  assert.ok(aggregateGuide.assetWorkflow.some((step) => /figma_workspace_apply_asset_manifest/.test(step)));
  assert.ok(aggregateGuide.upstreamEscapeHatch.some((step) => /figma-workspace:\/\/upstream-tools\/\{name\}/.test(step)));
  assert.ok(aggregateGuide.inspectionAndQa.some((step) => /figma_workspace_get_motion_context/.test(step)));
  assert.ok(aggregateGuide.motionAndShaders.some((step) => /figma_workspace_export_video/.test(step)));
  assert.ok(aggregateGuide.motionAndShaders.some((step) => /shader library reads/.test(step)));
  assert.equal(aggregateLookupIndex.guidance.tool, "figma_workspace_guidance");
  assert.equal(aggregateLookupIndex.lookup.tool, "figma_workspace_lookup");
  assert.ok(aggregateLookupIndex.guidance.commonCards.includes("text.font"));
  assert.deepEqual(aggregateLookupIndex.guidance.outputFields, queryOutputFields);
  assert.ok(aggregateLookupIndex.guidance.helperProfiles.categories.repair.includes("checkpoint"));
  assert.ok(aggregateLookupIndex.guidance.wrapperProfiles.tools.includes("figma_workspace_list_shader_effects"));
  assert.ok(aggregateLookupIndex.guidance.workflowGraph.includes("design-implementation-context"));
  for (const uri of removedStaticResourceUris) {
    await assert.rejects(
      mcpClient.readResource({ uri }),
      new RegExp(`Unknown figma-workspace resource URI: ${uri.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`),
    );
  }

  const upstreamResource = await mcpClient.readResource({ uri: "figma-workspace://upstream-tools" });
  const upstream = JSON.parse(upstreamResource.contents[0].text);
  assert.ok(Array.isArray(upstream.tools));
  assert.equal(upstream.detailTemplate, "figma-workspace://upstream-tools/{name}");
  assert.deepEqual(upstream.categories, ["capture", "design-context", "motion", "video", "execution", "assets", "code-connect", "libraries", "figjam", "generation", "shader", "account", "other"]);
  assert.match(upstream.guidance, /figma_workspace_call_upstream_tool/);
  assert.match(upstream.guidance, /dedicated figma_workspace_\* wrappers/);
  assert.equal(upstream.tools[0].name, "use_figma");
  assert.equal(upstream.tools[0].category, "execution");
  assert.equal(upstream.tools[0].description, "Run Plugin API JavaScript to create, inspect, or edit Figma content.");
  assert.deepEqual(
    Object.fromEntries(upstream.tools.map((tool) => [tool.name, [tool.category, tool.description]])),
    {
      use_figma: ["execution", "Run Plugin API JavaScript to create, inspect, or edit Figma content."],
      get_motion_context: ["motion", "Get keyframe animation data and motion code snippets for a node."],
      export_video: ["video", "Export a Figma timeline node as an MP4 video."],
      list_shader_effects: ["shader", "List shader effects in the authenticated user's account library."],
      get_shader_effect: ["shader", "Read a shader effect source manifest by id."],
      list_shader_fills: ["shader", "List shader fills in the authenticated user's account library."],
      get_shader_fill: ["shader", "Read a shader fill source manifest by id."],
    },
  );
  assert.ok(upstream.tools.every((tool) => !tool.description || tool.description.length <= 96));
  assert.ok(upstream.tools.every((tool) => typeof tool.category === "string"));
  assert.equal(upstream.tools[0].resource, undefined);
  assert.equal(upstream.tools[0].inputSchema, undefined);

  const upstreamToolUri = upstream.detailTemplate.replace("{name}", encodeURIComponent(upstream.tools[0].name));
  const upstreamToolResource = await mcpClient.readResource({ uri: upstreamToolUri });
  const upstreamTool = JSON.parse(upstreamToolResource.contents[0].text);
  assert.equal(upstreamTool.name, "use_figma");
  assert.match(upstreamTool.description, /Execute JavaScript/);
  assert.deepEqual(upstreamTool.inputSchema.required, ["code"]);
  assert.equal(upstreamTool.callTool, "figma_workspace_call_upstream_tool");
  assert.match(upstreamTool.guidance, /explicit uncovered official upstream capabilities/);

  const motionToolResource = await mcpClient.readResource({ uri: "figma-workspace://upstream-tools/get_motion_context" });
  const motionTool = JSON.parse(motionToolResource.contents[0].text);
  assert.equal(motionTool.name, "get_motion_context");
  assert.deepEqual(motionTool.inputSchema.required, ["nodeId", "fileKey"]);
  assert.equal(motionTool.callTool, "figma_workspace_call_upstream_tool");

  const shaderToolResource = await mcpClient.readResource({ uri: "figma-workspace://upstream-tools/get_shader_fill" });
  const shaderTool = JSON.parse(shaderToolResource.contents[0].text);
  assert.equal(shaderTool.name, "get_shader_fill");
  assert.deepEqual(shaderTool.inputSchema.required, ["id"]);
  assert.deepEqual(calls.map((call) => call[0]), ["connect", "listTools"]);
  await mcpClient.close();
});

test("figma upstream-tools resource reports upstream connection failures as JSON", async () => {
  const calls = [];
  const fakeClient = {
    async connect() {
      calls.push(["connect"]);
      throw new Error("MCP connection attempt was cancelled.");
    },
    async close() {
      calls.push(["close"]);
    },
    async listTools() {
      calls.push(["listTools"]);
      return { tools: [] };
    },
    async callTool() {
      throw new Error("unexpected upstream call");
    },
  };
  const { server } = createFigmaWorkspaceMcpServer({ client: fakeClient });
  const mcpClient = new Client(
    { name: "test-client", version: "0.1.0" },
    { capabilities: {} },
  );
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

  await server.connect(serverTransport);
  await mcpClient.connect(clientTransport);

  const upstreamResource = await mcpClient.readResource({ uri: "figma-workspace://upstream-tools" });
  const upstream = JSON.parse(upstreamResource.contents[0].text);
  assert.equal(upstream.ok, false);
  assert.deepEqual(upstream.tools, []);
  assert.equal(upstream.detailTemplate, "figma-workspace://upstream-tools/{name}");
  assert.match(upstream.upstreamError.message, /MCP connection attempt was cancelled/);
  assert.match(upstream.primaryFix, /OAuth\/login/);
  assert.deepEqual(calls, [["connect"]]);

  await assert.rejects(
    mcpClient.readResource({ uri: "figma-workspace://upstream-tools/use_figma" }),
    /Upstream Figma MCP tool directory unavailable: MCP connection attempt was cancelled/,
  );
  await mcpClient.close();
});

test("figma router docs preserve runtime-owned contract wording", async () => {
  const skillText = await readFile(resolve(packageRoot, "../skills/figma-workspace-router/SKILL.md"), "utf8");
  const openaiText = await readFile(resolve(packageRoot, "../skills/figma-workspace-router/agents/openai.yaml"), "utf8");
  const pluginReadme = await readFile(resolve(packageRoot, "../README.md"), "utf8");
  const stdioReadme = await readFile(resolve(packageRoot, "README.md"), "utf8");
  const docsText = [skillText, openaiText, pluginReadme, stdioReadme].join("\n");

  assert.match(skillText, /After OAuth registration, use `figma_workspace_mcp` as the agent-facing entrypoint/);
  assert.match(skillText, /read `figma-workspace:\/\/capabilities`/);
  assert.match(skillText, /Bundled JSONL upstream corpus files are internal lookup data/);
  assert.match(skillText, /recommendedCards`, `queryHints`, `apiSymbols`, `guardrails`, and `referenceContext`/);
  assert.match(skillText, /figma_workspace_lookup\(\{ kind: "docs" \}\)/);
  for (const uri of removedStaticResourceUris) {
    assert.ok(!skillText.includes(uri), `SKILL.md must not route agents to removed resource ${uri}`);
  }
  assert.match(pluginReadme, /`figma_workspace_mcp` is the primary agent workflow after OAuth registration/);
  assert.match(pluginReadme, /persistent MCP server id is `figma_workspace_mcp`/);
  assert.match(pluginReadme, /`upstream-corpus\/manifest\.json` and `upstream-corpus\/corpus\.jsonl` files are internal lookup corpus/);
  assert.match(stdioReadme, /old hyphenated persistent server ids/);
  assert.match(stdioReadme, /bundled JSONL corpus files are internal and are not an agent-facing documentation path/);
  assert.match(stdioReadme, /explicit uncovered upstream capability/);
  assert.match(openaiText, /figma_workspace_mcp/);
  for (const term of forbiddenRouterContractTerms) {
    assert.ok(!docsText.includes(term), `router docs must not mention ${term}`);
  }
});

test("figma upstream corpus is JSONL-backed with motion and SwiftUI included", async () => {
  const corpusDir = resolve(packageRoot, "../skills/figma-workspace-router/references/upstream-corpus");
  const manifest = JSON.parse(await readFile(resolve(corpusDir, "manifest.json"), "utf8"));
  const records = (await readFile(resolve(corpusDir, "corpus.jsonl"), "utf8"))
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));

  assert.equal(manifest.schemaVersion, 1);
  assert.equal(manifest.corpus.file, "corpus.jsonl");
  assert.equal(manifest.corpus.recordCount, records.length);
  assert.match(manifest.corpus.contract, /Internal lookup corpus only/);
  assert.ok(manifest.includedSkills.includes("figma-use-motion"));
  assert.ok(manifest.includedSkills.includes("figma-implement-motion"));
  assert.ok(manifest.includedSkills.includes("figma-swiftui"));
  assert.ok(manifest.outOfScopeSkills.every((item) => item.skill !== "figma-swiftui"));
  assert.ok(records.some((record) => record.id === "figma-use-motion/SKILL.md"));
  assert.ok(records.some((record) => record.id === "figma-implement-motion/references/motion-lint-rules.md"));
  assert.ok(records.some((record) => record.id === "figma-swiftui/SKILL.md"));
  assert.ok(records.some((record) => record.id === "figma-swiftui/references/design-to-code.md"));
  assert.ok(records.some((record) => record.id === "figma-swiftui/references/code-to-design.md"));
  assert.ok(records.every((record) => typeof record.text === "string" && record.text.length > 0));
});

test("figma workspace proxies a fake upstream official tool and rejects local tool names", async () => {
  const calls = [];
  const fakeClient = createFakeFigmaClient(
    calls,
    ({ name, args }) => {
      assert.equal(name, "generate_diagram");
      if (args.prompt === "Fail") {
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({ ok: false, error: { code: "UPSTREAM_FAILED", message: "Diagram failed" } }),
            },
          ],
        };
      }
      if (args.prompt === "Truncated") {
        return {
          content: [
            {
              type: "text",
              text: `${JSON.stringify({ ok: true, result: { summary: "partial diagram" } })}\n truncated to 20kb`,
            },
          ],
        };
      }
      assert.deepEqual(args, { prompt: "Flow" });
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({ ok: true, diagramId: "abc123" }),
          },
        ],
      };
    },
    {
      tools: [
        {
          name: "use_figma",
          description: "Execute JavaScript in the active Figma file.",
          inputSchema: { type: "object", properties: { code: { type: "string" } } },
        },
        {
          name: "generate_diagram",
          description: "Generate a diagram.",
          inputSchema: { type: "object", properties: { prompt: { type: "string" } } },
        },
      ],
    },
  );
  const { server } = createFigmaWorkspaceMcpServer({ client: fakeClient });
  const mcpClient = new Client(
    { name: "test-client", version: "0.1.0" },
    { capabilities: {} },
  );
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

  await server.connect(serverTransport);
  await mcpClient.connect(clientTransport);

  const result = await mcpClient.callTool({
    name: "figma_workspace_call_upstream_tool",
    arguments: {
      title: "Generate diagram",
      toolName: "generate_diagram",
      arguments: { prompt: "Flow" },
      includeRawUpstream: true,
    },
  });
  const json = structuredToolResult(result);
  assert.equal(json.ok, true);
  assert.equal(json.toolName, "generate_diagram");
  assert.equal(json.upstream.kind, "json");
  assert.equal(json.upstream.ok, true);
  assert.equal(json.upstream.result.diagramId, "abc123");
  assert.equal(json.upstream.result.ok, undefined);
  assert.equal(json.result, undefined);
  assert.equal(json.text, undefined);
  assert.equal(json.raw, undefined);

  const failureResult = await mcpClient.callTool({
    name: "figma_workspace_call_upstream_tool",
    arguments: {
      title: "Generate failed diagram",
      toolName: "generate_diagram",
      arguments: { prompt: "Fail" },
    },
  });
  const failureJson = structuredToolResult(failureResult);
  assert.equal(failureJson.ok, false);
  assert.equal(failureJson.upstream.kind, "json");
  assert.equal(failureJson.upstream.ok, false);
  assert.equal(failureJson.upstream.result.error.code, "UPSTREAM_FAILED");
  assert.equal(failureJson.upstream.result.ok, undefined);
  assert.equal(failureJson.upstream.result.source, "business");
  assert.equal(failureJson.upstreamError.code, "UPSTREAM_FAILED");
  assert.match(failureJson.upstreamError.message, /Diagram failed/);
  assert.equal(failureJson.upstreamError.text, undefined);
  assert.equal(failureJson.upstreamError.parsed, undefined);
  assert.equal(failureJson.result, undefined);
  assert.equal(failureJson.text, undefined);

  const truncatedResult = await mcpClient.callTool({
    name: "figma_workspace_call_upstream_tool",
    arguments: {
      title: "Generate truncated diagram",
      toolName: "generate_diagram",
      arguments: { prompt: "Truncated" },
    },
  });
  const truncatedJson = structuredToolResult(truncatedResult);
  assert.equal(truncatedJson.ok, false);
  assert.equal(truncatedJson.upstream.kind, "text");
  assert.equal(truncatedJson.upstream.ok, false);
  assert.equal(truncatedJson.upstream.result.source, "call");
  assert.equal(truncatedJson.upstreamError.code, "FIGMA_UPSTREAM_TRUNCATED");
  assert.match(truncatedJson.upstreamError.message, /truncated at 20kb/);
  assert.equal(truncatedJson.upstreamError.details.size, "20kb");
  assert.equal(truncatedJson.upstreamError.text, undefined);
  assert.equal(truncatedJson.upstreamError.parsed, undefined);
  assert.match(truncatedJson.upstream.text, /truncated to 20kb/);
  assert.equal(truncatedJson.upstream.result.result, undefined);

  await assert.rejects(
    mcpClient.callTool({
      name: "figma_workspace_call_upstream_tool",
      arguments: {
        title: "Reject local",
        toolName: "figma_workspace_eval",
        arguments: {},
      },
    }),
    /Refusing to proxy local figma_workspace_mcp tool/,
  );
  assert.deepEqual(calls.map((call) => call[0]), ["connect", "listTools", "callTool", "callTool", "callTool"]);
  await mcpClient.close();
});

test("figma workspace call_upstream_tool writes debug result and upstream sidecar for large output only", async () => {
  const tempDir = await mkdtemp(resolve(tmpdir(), "figma-workspace-call-upstream-"));
  const originalTaskRoot = process.env.FIGMA_WORKSPACE_TASK_ROOT;
  process.env.FIGMA_WORKSPACE_TASK_ROOT = tempDir;
  const calls = [];
  const fakeClient = createFakeFigmaClient(
    calls,
    ({ name, args }) => {
      assert.equal(name, "generate_diagram");
      if (args.prompt === "Large") {
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                ok: true,
                result: {
                  summary: "large upstream",
                  blob: "x".repeat(200),
                },
              }),
            },
          ],
        };
      }
      if (args.prompt === "Wrapped") {
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                ok: true,
                __figmaRepl: { sessionId: "upstream-main", handles: {} },
                result: { summary: "wrapped upstream" },
              }),
            },
          ],
        };
      }
      if (args.prompt === "Wrapped failure") {
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                ok: false,
                __figmaRepl: { sessionId: "upstream-main", handles: {} },
                code: "WRAPPED_FAILED",
                message: "Wrapped upstream failed",
                details: { retryable: false },
              }),
            },
          ],
        };
      }
      assert.deepEqual(args, { prompt: "Explicit" });
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({ ok: true, result: { summary: "explicit upstream" } }),
          },
        ],
      };
    },
    {
      tools: [
        {
          name: "generate_diagram",
          description: "Generate a diagram.",
          inputSchema: { type: "object", properties: { prompt: { type: "string" } } },
        },
      ],
    },
  );
  const repl = createFigmaWorkspaceClient({ client: fakeClient });

  try {
    const largeResult = await repl.callUpstreamTool({
      sessionId: "upstream-main",
      toolName: "generate_diagram",
      arguments: { prompt: "Large" },
      inlineResultLimit: 40,
    });
    assert.equal(largeResult.ok, true);
    assert.equal(largeResult.upstream.kind, "json");
    assert.equal(largeResult.upstream.ok, true);
    assert.equal(largeResult.upstream.result, undefined);
    assert.equal(largeResult.inlineResultLimit.limitBytes, 40);
    assert.equal(largeResult.inlineResultLimit.limitHuman, "40 bytes");
    assert.deepEqual(largeResult.inlineResultLimit.omitted.map((item) => item.field), ["upstream.result"]);
    assert.match(largeResult.outputFiles.debugFile.path, /upstream-results.*upstream-main.*upstream-generate_diagram.*\.result\.json$/u);
    assert.match(largeResult.outputFiles.upstreamFile.path, /\.upstream\.json$/u);
    const largeResultFile = await readPrettyJsonPointer(largeResult.outputFiles.debugFile, largeResult.outputFiles.debugFile.path);
    assert.equal(largeResultFile.kind, "figma_workspace_result");
    assert.equal(largeResultFile.tool, "figma_workspace_call_upstream_tool");
    assert.equal(largeResultFile.sessionId, "upstream-main");
    assert.equal(largeResultFile.upstreamToolName, "generate_diagram");
    assert.equal(largeResultFile.upstreamKind, "json");
    assert.equal(largeResultFile.upstreamOk, true);
    assert.equal(largeResultFile.outputFiles, undefined);
    assert.equal(largeResultFile.session, undefined);
    assert.equal(largeResultFile.upstream, undefined);
    const largeUpstreamFile = await readPrettyJsonPointer(largeResult.outputFiles.upstreamFile, largeResult.outputFiles.upstreamFile.path);
    assert.equal(largeUpstreamFile.result.result.summary, "large upstream");
    assert.equal(largeUpstreamFile.result.result.blob.length, 200);

    const explicitResult = await repl.callUpstreamTool({
      toolName: "generate_diagram",
      arguments: { prompt: "Explicit" },
    });
    assert.equal(explicitResult.ok, true);
    assert.equal(explicitResult.inlineResultLimit, undefined);
    assert.equal(explicitResult.upstream.result.result.summary, "explicit upstream");
    assert.equal(explicitResult.outputFiles, undefined);

    const fileOnlyResult = await repl.callUpstreamTool({
      toolName: "generate_diagram",
      arguments: { prompt: "Explicit" },
      inlineResultLimit: 0,
    });
    assert.equal(fileOnlyResult.ok, true);
    assert.equal(fileOnlyResult.upstream.result, undefined);
    assert.equal(fileOnlyResult.inlineResultLimit.limitBytes, 0);
    assert.deepEqual(fileOnlyResult.inlineResultLimit.omitted.map((item) => item.field), ["upstream.result"]);
    assert.match(fileOnlyResult.outputFiles.upstreamFile.path, /\.upstream\.json$/u);
    const fileOnlyUpstreamFile = await readPrettyJsonPointer(fileOnlyResult.outputFiles.upstreamFile, fileOnlyResult.outputFiles.upstreamFile.path);
    assert.equal(fileOnlyUpstreamFile.result.result.summary, "explicit upstream");

    const wrappedResult = await repl.callUpstreamTool({
      sessionId: "upstream-main",
      toolName: "generate_diagram",
      arguments: { prompt: "Wrapped" },
    });
    assert.equal(wrappedResult.ok, true);
    assert.equal(wrappedResult.upstream.result.summary, "wrapped upstream");
    assert.equal(wrappedResult.upstream.result.__figmaRepl, undefined);
    assert.equal(wrappedResult.upstream.result.result, undefined);

    const wrappedFailure = await repl.callUpstreamTool({
      sessionId: "upstream-main",
      toolName: "generate_diagram",
      arguments: { prompt: "Wrapped failure" },
    });
    assert.equal(wrappedFailure.ok, false);
    assert.equal(wrappedFailure.upstream.ok, false);
    assert.equal(wrappedFailure.upstream.result.message, "Wrapped upstream failed");
    assert.equal(wrappedFailure.upstream.result.code, "WRAPPED_FAILED");
    assert.deepEqual(wrappedFailure.upstream.result.details, { retryable: false });
    assert.equal(wrappedFailure.upstream.result.source, "call");
    assert.equal(wrappedFailure.upstream.result.ok, undefined);
    assert.equal(wrappedFailure.upstream.result.__figmaRepl, undefined);
    const wrappedFailureUpstreamFile = await readPrettyJsonPointer(
      wrappedFailure.outputFiles.upstreamFile,
      wrappedFailure.outputFiles.upstreamFile.path,
    );
    assert.equal(wrappedFailureUpstreamFile.result.message, "Wrapped upstream failed");
    assert.equal(wrappedFailureUpstreamFile.result.code, "WRAPPED_FAILED");
    assert.equal(wrappedFailureUpstreamFile.result.source, "call");
    assert.equal(wrappedFailureUpstreamFile.result.__figmaRepl, undefined);
    assert.equal(wrappedFailureUpstreamFile.result.ok, undefined);
  } finally {
    await repl.close();
    if (originalTaskRoot === undefined) {
      delete process.env.FIGMA_WORKSPACE_TASK_ROOT;
    } else {
      process.env.FIGMA_WORKSPACE_TASK_ROOT = originalTaskRoot;
    }
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("figma workspace get_metadata converts upstream XML to compact JSON tree", async () => {
  const tempDir = await mkdtemp(resolve(tmpdir(), "figma-workspace-get-metadata-"));
  const calls = [];
  const xml = `<frame id="1:2" name="Root &amp; Frame" x="10" y="20" width="300" height="200">
  <text id="1:3" name="Title" x="24" y="32" width="120" height="24" />
  <rounded-rectangle id="1:4" name="Button" x="24" y="80" width="160" height="44" />
</frame>
IMPORTANT: After you call this tool, you MUST call get_design_context if trying to implement the design.`;
  const fakeClient = createFakeFigmaClient(
    calls,
    ({ name, args }) => {
      assert.equal(name, "get_metadata");
      assert.deepEqual(args, {
        fileKey: "ExampleFigmaFileKey012",
        nodeId: "1:2",
        clientLanguages: "unknown",
        clientFrameworks: "unknown",
      });
      return {
        content: [{ type: "text", text: xml }],
      };
    },
    {
      tools: [
        {
          name: "get_metadata",
          description: "Read XML metadata.",
          inputSchema: { type: "object", properties: { fileKey: { type: "string" }, nodeId: { type: "string" } } },
        },
      ],
    },
  );
  const repl = createFigmaWorkspaceClient({ client: fakeClient });

  try {
    const result = await repl.getMetadata({
      title: "Read metadata",
      sessionId: "metadata-main",
      file: "https://www.figma.com/design/ExampleFigmaFileKey012/UI?node-id=1-2",
      cwd: tempDir,
    });
    assert.equal(result.ok, true);
    assert.equal(result.fileKey, "ExampleFigmaFileKey012");
    assert.equal(result.nodeId, "1:2");
    assert.equal(result.upstream.kind, "text");
    assert.equal(result.upstream.ok, true);
    assert.equal(result.upstream.text, undefined);
    assert.equal(result.metadata.format, "figma-metadata-tree");
    assert.equal(result.metadata.source, "get_metadata");
    assert.equal(result.metadata.nodeCount, 3);
    assert.equal(result.metadata.xmlBytes, undefined);
    assert.equal(result.metadata.json.root.nodeId, "1:2");
    assert.equal(result.metadata.json.root.type, "frame");
    assert.equal(result.metadata.json.root.name, "Root & Frame");
    assert.equal(result.metadata.json.root.children[1].type, "rounded-rectangle");
    assert.equal(result.inlineResultLimit, undefined);
    assert.deepEqual(result.outputFiles, {});

    const omitted = await repl.getMetadata({
      title: "Read metadata omitted",
      sessionId: "metadata-main",
      file: "ExampleFigmaFileKey012",
      target: "1:2",
      inlineResultLimit: 40,
    });
    assert.equal(omitted.ok, true);
    assert.equal(omitted.metadata.json, undefined);
    assert.deepEqual(omitted.inlineResultLimit.omitted.map((item) => item.field), ["metadata.json"]);
    assert.match(omitted.inlineResultLimit.guidance, /outputFiles pointer/);
    const omittedMetadataFile = await readPrettyJsonPointer(omitted.outputFiles.metadataFile, omitted.outputFiles.metadataFile.path);
    assert.equal(omittedMetadataFile.nodeCount, 3);
    assert.equal(omitted.outputFiles.upstreamFile, undefined);

    const fileOnly = await repl.getMetadata({
      title: "Read metadata file-only",
      sessionId: "metadata-main",
      file: "ExampleFigmaFileKey012",
      target: "1:2",
      inlineResultLimit: 0,
    });
    assert.equal(fileOnly.ok, true);
    assert.equal(fileOnly.metadata.json, undefined);
    assert.equal(fileOnly.inlineResultLimit.limitBytes, 0);
    assert.deepEqual(fileOnly.inlineResultLimit.omitted.map((item) => item.field), ["metadata.json"]);
    const fileOnlyMetadataFile = await readPrettyJsonPointer(fileOnly.outputFiles.metadataFile, fileOnly.outputFiles.metadataFile.path);
    assert.equal(fileOnlyMetadataFile.root.nodeId, "1:2");
    assert.equal(fileOnly.outputFiles.upstreamFile, undefined);
  } finally {
    await repl.close();
    await rm(tempDir, { recursive: true, force: true });
  }
  assert.deepEqual(calls.filter((call) => call[0] !== "close").map((call) => call[0]), [
    "connect",
    "listTools",
    "callTool",
    "callTool",
    "callTool",
  ]);
});

test("figma workspace design system wrappers call dedicated upstream tools", async () => {
  const tempDir = await mkdtemp(resolve(tmpdir(), "figma-workspace-design-system-"));
  const originalTaskRoot = process.env.FIGMA_WORKSPACE_TASK_ROOT;
  process.env.FIGMA_WORKSPACE_TASK_ROOT = tempDir;
  const calls = [];
  const fakeClient = createFakeFigmaClient(
    calls,
    ({ name, args }) => {
      if (name === "search_design_system") {
        if (args.query === "Large") {
          assert.deepEqual(args, { fileKey: "ExampleFigmaFileKey012", query: "Large" });
          return {
            content: [{ type: "text", text: JSON.stringify({ ok: true, result: { summary: "large search", blob: "x".repeat(200) } }) }],
          };
        }
        assert.deepEqual(args, {
          fileKey: "ExampleFigmaFileKey012",
          query: "Button",
          disableCodeConnect: true,
          includeComponents: true,
          includeVariables: false,
          includeStyles: true,
          includeLibraryKeys: ["lib-core"],
        });
        return {
          content: [{ type: "text", text: JSON.stringify({ ok: true, results: [{ name: "Button/Primary" }] }) }],
        };
      }
      if (name === "get_libraries") {
        assert.deepEqual(args, { fileKey: "ExampleFigmaFileKey012", offset: 20 });
        return {
          content: [{ type: "text", text: JSON.stringify({ libraries: [{ name: "Core" }] }) }],
        };
      }
      if (name === "get_variable_defs") {
        assert.deepEqual(args, {
          fileKey: "ExampleFigmaFileKey012",
          nodeId: "9:9",
          clientLanguages: "unknown",
          clientFrameworks: "unknown",
        });
        return {
          content: [{ type: "text", text: JSON.stringify({ ok: true, variables: [{ name: "color.bg" }] }) }],
        };
      }
      assert.fail(`unexpected tool ${name}`);
      return { content: [] };
    },
    {
      tools: [
        {
          name: "search_design_system",
          inputSchema: {
            type: "object",
            properties: {
              fileKey: { type: "string" },
              query: { type: "string" },
              disableCodeConnect: { type: "boolean" },
              includeComponents: { type: "boolean" },
              includeVariables: { type: "boolean" },
              includeStyles: { type: "boolean" },
              includeLibraryKeys: { type: "array", items: { type: "string" } },
            },
          },
        },
        { name: "get_libraries", inputSchema: { type: "object", properties: { fileKey: { type: "string" }, offset: { type: "number" } } } },
        { name: "get_variable_defs", inputSchema: { type: "object", properties: { fileKey: { type: "string" }, nodeId: { type: "string" } } } },
      ],
    },
  );
  const repl = createFigmaWorkspaceClient({ client: fakeClient });

  try {
    await repl.open({
      sessionId: "design-system",
      file: "https://www.figma.com/design/ExampleFigmaFileKey012/UI",
      handles: { "$button": "9:9" },
      connect: false,
    });

    const search = await repl.searchDesignSystem({
      sessionId: "design-system",
      query: "Button",
      disableCodeConnect: true,
      includeComponents: true,
      includeVariables: false,
      includeStyles: true,
      includeLibraryKeys: ["lib-core"],
    });
    assert.equal(search.ok, true);
    assert.equal(search.fileKey, "ExampleFigmaFileKey012");
    assert.equal(search.query, "Button");
    assert.equal(search.upstream.kind, "json");
    assert.equal(search.upstream.ok, true);
    assert.equal(search.upstream.result.results[0].name, "Button/Primary");
    assert.equal(search.upstream.result.ok, undefined);
    assert.equal(search.toolName, undefined);
    assert.equal(search.session.handles, undefined);

    const libraries = await repl.getLibraries({
      sessionId: "design-system",
      offset: 20,
    });
    assert.equal(libraries.ok, true);
    assert.equal(libraries.fileKey, "ExampleFigmaFileKey012");
    assert.equal(libraries.offset, 20);
    assert.equal(libraries.upstream.result.libraries[0].name, "Core");
    assert.equal(libraries.toolName, undefined);

    const variableDefs = await repl.getVariableDefs({
      sessionId: "design-system",
      target: "$button",
    });
    assert.equal(variableDefs.ok, true);
    assert.equal(variableDefs.fileKey, "ExampleFigmaFileKey012");
    assert.equal(variableDefs.nodeId, "9:9");
    assert.equal(variableDefs.upstream.result.variables[0].name, "color.bg");
    assert.equal(variableDefs.toolName, undefined);

    const large = await repl.searchDesignSystem({
      sessionId: "design-system",
      query: "Large",
      inlineResultLimit: 40,
    });
    assert.equal(large.ok, true);
    assert.equal(large.upstream.result, undefined);
    assert.deepEqual(large.inlineResultLimit.omitted.map((item) => item.field), ["upstream.result"]);
    assert.match(large.outputFiles.debugFile.path, /upstream-search_design_system-.*\.result\.json$/u);
    const resultFile = await readPrettyJsonPointer(large.outputFiles.debugFile, large.outputFiles.debugFile.path);
    assert.equal(resultFile.tool, "figma_workspace_search_design_system");
    assert.equal(resultFile.upstreamToolName, "search_design_system");
    const upstreamFile = await readPrettyJsonPointer(large.outputFiles.upstreamFile, large.outputFiles.upstreamFile.path);
    assert.equal(upstreamFile.result.result.summary, "large search");

    await assert.rejects(
      repl.getVariableDefs({ sessionId: "design-system", target: "$selection" }),
      /cannot resolve dynamic selector "\$selection"/,
    );
  } finally {
    await repl.close();
    if (originalTaskRoot === undefined) {
      delete process.env.FIGMA_WORKSPACE_TASK_ROOT;
    } else {
      process.env.FIGMA_WORKSPACE_TASK_ROOT = originalTaskRoot;
    }
    await rm(tempDir, { recursive: true, force: true });
  }
  assert.deepEqual(calls.filter((call) => call[0] !== "close").map((call) => call[0]), [
    "connect",
    "listTools",
    "callTool",
    "callTool",
    "callTool",
    "callTool",
  ]);
});

test("figma workspace context motion video and shader wrappers call dedicated upstream tools", async () => {
  const calls = [];
  const fakeClient = createFakeFigmaClient(
    calls,
    ({ name, args }) => {
      if (name === "get_design_context") {
        assert.deepEqual(args, {
          fileKey: "ExampleFigmaFileKey012",
          nodeId: "9:9",
          clientLanguages: "swift",
          clientFrameworks: "swiftui",
        });
        return {
          content: [{ type: "text", text: JSON.stringify({ ok: true, code: "<div data-node-id=\"9:9\" />" }) }],
        };
      }
      if (name === "get_motion_context") {
        assert.deepEqual(args, { fileKey: "ExampleFigmaFileKey012", nodeId: "9:9", recursive: true });
        return {
          content: [{ type: "text", text: JSON.stringify({ ok: true, nodes: [{ nodeId: "9:9" }] }) }],
        };
      }
      if (name === "export_video") {
        if (args.jobId) {
          assert.deepEqual(args, { fileKey: "ExampleFigmaFileKey012", jobId: "job-123" });
          return {
            content: [{ type: "text", text: JSON.stringify({ ok: true, jobId: "job-123", status: "done" }) }],
          };
        }
        assert.deepEqual(args, { fileKey: "ExampleFigmaFileKey012", nodeId: "9:9", quality: "low" });
        return {
          content: [{ type: "text", text: JSON.stringify({ ok: true, jobId: "job-123", status: "processing" }) }],
        };
      }
      if (name === "list_shader_effects") {
        assert.deepEqual(args, { cursor: "after-effects" });
        return {
          content: [{ type: "text", text: JSON.stringify({ ok: true, effects: [{ id: "effect-1" }] }) }],
        };
      }
      if (name === "get_shader_effect") {
        assert.deepEqual(args, { id: "effect-1" });
        return {
          content: [{ type: "text", text: JSON.stringify({ ok: true, id: "effect-1", source: "effect" }) }],
        };
      }
      if (name === "list_shader_fills") {
        assert.deepEqual(args, { cursor: "after-fills" });
        return {
          content: [{ type: "text", text: JSON.stringify({ ok: true, fills: [{ id: "fill-1" }] }) }],
        };
      }
      if (name === "get_shader_fill") {
        assert.deepEqual(args, { id: "fill-1" });
        return {
          content: [{ type: "text", text: JSON.stringify({ ok: true, id: "fill-1", source: "fill" }) }],
        };
      }
      assert.fail(`unexpected tool ${name}`);
      return { content: [] };
    },
    {
      tools: [
        { name: "get_design_context", inputSchema: { type: "object", properties: { fileKey: { type: "string" }, nodeId: { type: "string" } } } },
        { name: "get_motion_context", inputSchema: { type: "object", properties: { fileKey: { type: "string" }, nodeId: { type: "string" }, recursive: { type: "boolean" } } } },
        { name: "export_video", inputSchema: { type: "object", properties: { fileKey: { type: "string" }, nodeId: { type: "string" }, jobId: { type: "string" }, quality: { type: "string" } } } },
        { name: "list_shader_effects", inputSchema: { type: "object", properties: { cursor: { type: "string" } } } },
        { name: "get_shader_effect", inputSchema: { type: "object", properties: { id: { type: "string" } } } },
        { name: "list_shader_fills", inputSchema: { type: "object", properties: { cursor: { type: "string" } } } },
        { name: "get_shader_fill", inputSchema: { type: "object", properties: { id: { type: "string" } } } },
      ],
    },
  );
  const repl = createFigmaWorkspaceClient({ client: fakeClient });

  try {
    await repl.open({
      sessionId: "context-main",
      file: "https://www.figma.com/design/ExampleFigmaFileKey012/UI",
      handles: { "$button": "9:9" },
      connect: false,
    });

    const design = await repl.getDesignContext({
      sessionId: "context-main",
      target: "$button",
      clientLanguages: "swift",
      clientFrameworks: "swiftui",
    });
    assert.equal(design.ok, true);
    assert.equal(design.fileKey, "ExampleFigmaFileKey012");
    assert.equal(design.nodeId, "9:9");
    assert.equal(design.upstream.result.code, "<div data-node-id=\"9:9\" />");
    assert.equal(design.guidance, undefined);
    assert.equal(design.guidanceRef.source, "figma_workspace_guidance");
    assert.equal(design.guidanceRef.query, "figma_workspace_get_design_context get_design_context design-implementation-context");
    assert.deepEqual(design.guidanceRef.workflowIds, ["design-implementation-context"]);
    const designGuidance = await repl.guidance({
      query: design.guidanceRef.query,
      maxCards: 3,
    });
    assert.ok(designGuidance.wrapperProfiles.some((profile) => profile.tool === "figma_workspace_get_design_context"));
    assert.ok(designGuidance.workflowGraph.some((workflow) => workflow.id === "design-implementation-context"));

    const motion = await repl.getMotionContext({ sessionId: "context-main", target: "$button", recursive: true });
    assert.equal(motion.ok, true);
    assert.equal(motion.upstream.result.nodes[0].nodeId, "9:9");
    assert.equal(motion.guidance, undefined);
    assert.equal(motion.guidanceRef.source, "figma_workspace_guidance");
    assert.equal(motion.guidanceRef.query, "figma_workspace_get_motion_context get_motion_context motion-implementation");
    assert.deepEqual(motion.guidanceRef.workflowIds, ["motion-implementation"]);

    const exportStart = await repl.exportVideo({ sessionId: "context-main", target: "$button", quality: "low" });
    assert.equal(exportStart.ok, true);
    assert.equal(exportStart.nodeId, "9:9");
    assert.equal(exportStart.upstream.result.jobId, "job-123");
    assert.equal(exportStart.videoFile, undefined);
    assert.equal(exportStart.guidance, undefined);
    assert.equal(exportStart.guidanceRef.source, "figma_workspace_guidance");
    assert.equal(exportStart.guidanceRef.query, "figma_workspace_export_video export_video motion-implementation video-export");
    assert.deepEqual(exportStart.guidanceRef.workflowIds, ["motion-implementation", "video-export"]);

    const exportPoll = await repl.exportVideo({ sessionId: "context-main", file: "ExampleFigmaFileKey012", jobId: "job-123" });
    assert.equal(exportPoll.ok, true);
    assert.equal(exportPoll.jobId, "job-123");
    assert.equal(exportPoll.nodeId, undefined);
    assert.equal(exportPoll.guidance, undefined);
    assert.equal(exportPoll.guidanceRef.query, "figma_workspace_export_video export_video motion-implementation video-export");

    const effects = await repl.listShaderEffects({ sessionId: "context-main", cursor: "after-effects" });
    assert.equal(effects.ok, true);
    assert.equal(effects.upstream.result.effects[0].id, "effect-1");
    assert.equal(effects.guidance, undefined);
    assert.equal(effects.guidanceRef.source, "figma_workspace_guidance");
    assert.equal(effects.guidanceRef.query, "figma_workspace_list_shader_effects list_shader_effects shader-lookup");
    assert.deepEqual(effects.guidanceRef.workflowIds, ["shader-lookup"]);

    const effect = await repl.getShaderEffect({ sessionId: "context-main", id: "effect-1" });
    assert.equal(effect.ok, true);
    assert.equal(effect.id, "effect-1");
    assert.equal(effect.upstream.result.source, "effect");
    assert.equal(effect.guidance, undefined);
    assert.equal(effect.guidanceRef.query, "figma_workspace_get_shader_effect get_shader_effect shader-lookup");

    const fills = await repl.listShaderFills({ sessionId: "context-main", cursor: "after-fills" });
    assert.equal(fills.ok, true);
    assert.equal(fills.upstream.result.fills[0].id, "fill-1");
    assert.equal(fills.guidance, undefined);
    assert.equal(fills.guidanceRef.query, "figma_workspace_list_shader_fills list_shader_fills shader-lookup");

    const fill = await repl.getShaderFill({ sessionId: "context-main", id: "fill-1" });
    assert.equal(fill.ok, true);
    assert.equal(fill.id, "fill-1");
    assert.equal(fill.upstream.result.source, "fill");
    assert.equal(fill.guidance, undefined);
    assert.equal(fill.guidanceRef.query, "figma_workspace_get_shader_fill get_shader_fill shader-lookup");

    await assert.rejects(
      repl.exportVideo({ sessionId: "context-main" }),
      /requires "target" to start an export, or "jobId" to poll/,
    );
  } finally {
    await repl.close();
  }
  assert.deepEqual(calls.filter((call) => call[0] === "callTool").map((call) => call[1]), [
    "get_design_context",
    "get_motion_context",
    "export_video",
    "export_video",
    "list_shader_effects",
    "get_shader_effect",
    "list_shader_fills",
    "get_shader_fill",
  ]);
});

test("figma workspace runtime parsers reject malformed tool argument shapes", async () => {
  const programmaticCalls = [];
  const repl = createFigmaWorkspaceClient({
    client: createFakeFigmaClient(programmaticCalls, () => {
      throw new Error("unexpected upstream call");
    }),
  });
  await assert.rejects(
    repl.eval("not an object"),
    /Tool arguments must be an object\./,
  );
  await repl.close();
  assert.deepEqual(programmaticCalls, [["close"]]);

  const calls = [];
  const { server } = createFigmaWorkspaceMcpServer({
    client: createFakeFigmaClient(calls, () => {
      throw new Error("unexpected upstream call");
    }),
  });
  const mcpClient = new Client(
    { name: "test-client", version: "0.1.0" },
    { capabilities: {} },
  );
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

  await server.connect(serverTransport);
  await mcpClient.connect(clientTransport);

  const noTitleOpenResult = await mcpClient.callTool({
    name: "figma_workspace_open",
    arguments: {
      sessionId: "no-title-open",
      connect: false,
    },
  });
  assert.equal(structuredToolResult(noTitleOpenResult).ok, true);
  await assert.rejects(
    mcpClient.callTool({
      name: "figma_workspace_guidance",
      arguments: {
        title: 123,
      },
    }),
    /Tool argument "title" must be a string\./,
  );
  await assert.rejects(
    mcpClient.callTool({
      name: "figma_workspace_eval",
      arguments: {
        title: "Reject invalid enum",
        code: "return {};",
        mode: "inspect",
      },
    }),
    /Tool argument "mode" must be one of: read, write\./,
  );
  await assert.rejects(
    mcpClient.callTool({
      name: "figma_workspace_eval",
      arguments: {
        title: "Reject code shape",
        code: 123,
      },
    }),
    /Tool argument "code" must be a string\./,
  );
  await assert.rejects(
    mcpClient.callTool({
      name: "figma_workspace_eval",
      arguments: {
        title: "Reject upstream args",
        code: "return {};",
        upstreamArguments: [],
      },
    }),
    /Tool argument "upstreamArguments" was removed\. Use "fixed use_figma execution"\./,
  );
  await assert.rejects(
    mcpClient.callTool({
      name: "figma_workspace_open",
      arguments: {
        title: "Reject open upstream tool override",
        upstreamTool: "fake_eval",
      },
    }),
    /Tool argument "upstreamTool" was removed\. Use "fixed use_figma execution"\./,
  );
  await assert.rejects(
    mcpClient.callTool({
      name: "figma_workspace_open",
      arguments: {
        title: "Reject open refresh",
        refresh: true,
      },
    }),
    /Tool argument "refresh" was removed\. Use "figma-workspace:\/\/upstream-tools"\./,
  );
  await assert.rejects(
    mcpClient.callTool({
      name: "figma_workspace_run_script_file",
      arguments: {
        title: "Reject script upstream argument override",
        upstreamArgument: "script",
      },
    }),
    /Tool argument "upstreamArgument" was removed\. Use "fixed use_figma execution"\./,
  );
  await assert.rejects(
    mcpClient.callTool({
      name: "figma_workspace_inspect",
      arguments: {
        title: "Reject inspect upstream arguments override",
        upstreamArguments: {},
      },
    }),
    /Tool argument "upstreamArguments" was removed\. Use "fixed use_figma execution"\./,
  );
  await assert.rejects(
    mcpClient.callTool({
      name: "figma_workspace_call_upstream_tool",
      arguments: {
        title: "Reject upstream toolName",
        toolName: 123,
      },
    }),
    /Tool argument "toolName" must be a string\./,
  );
  await assert.rejects(
    mcpClient.callTool({
      name: "figma_workspace_call_upstream_tool",
      arguments: {
        title: "Reject upstream call args",
        toolName: "generate_diagram",
        arguments: [],
      },
    }),
    /Tool argument "arguments" must be an object\./,
  );
  await assert.rejects(
    mcpClient.callTool({
      name: "figma_workspace_lookup",
      arguments: {
        title: "Reject docs query",
        kind: "docs",
        query: 123,
      },
    }),
    /Tool argument "query" must be a string\./,
  );
  await assert.rejects(
    mcpClient.callTool({
      name: "figma_workspace_guidance",
      arguments: {
        title: "Reject removed task",
        task: "   ",
      },
    }),
    /Tool argument "task" was removed. Use "query"./,
  );
  const longGuidanceResult = await mcpClient.callTool({
      name: "figma_workspace_guidance",
      arguments: {
        title: "Trim long guidance query",
        query: "component properties ".repeat(8),
      },
    });
  const longGuidanceJson = structuredToolResult(longGuidanceResult);
  assert.equal(longGuidanceJson.ok, true);
  assert.ok(longGuidanceJson.suggestions.recommendedCards.includes("components.variants"));
  await assert.rejects(
    mcpClient.callTool({
      name: "figma_workspace_search_design_system",
      arguments: {
        query: "button",
        includeComponents: "yes",
      },
    }),
    /Tool argument "includeComponents" must be a boolean\./,
  );
  await assert.rejects(
    mcpClient.callTool({
      name: "figma_workspace_search_design_system",
      arguments: {
        query: "button",
        includeLibraryKeys: ["lib-core", 123],
      },
    }),
    /Tool argument "includeLibraryKeys\[1\]" must be a string\./,
  );
  await assert.rejects(
    mcpClient.callTool({
      name: "figma_workspace_get_libraries",
      arguments: {
        offset: 1.5,
      },
    }),
    /Tool argument "offset" must be a non-negative integer\./,
  );
  await assert.rejects(
    mcpClient.callTool({
      name: "figma_workspace_lookup",
      arguments: {
        title: "Reject long lookup query",
        kind: "docs",
        query: "component properties ".repeat(8),
      },
    }),
    /Tool argument "query" must be 120 characters or fewer\./,
  );
  await assert.rejects(
    mcpClient.callTool({
      name: "figma_workspace_lookup",
      arguments: {
        title: "Reject API symbol",
        kind: "api",
        symbol: 123,
      },
    }),
    /Tool argument "symbol" must be a string\./,
  );
  await assert.rejects(
    mcpClient.callTool({
      name: "figma_workspace_lookup",
      arguments: {
        title: "Reject lookup kind",
        kind: "bad",
      },
    }),
    /Tool argument "kind" must be one of: docs, api\./,
  );
  await assert.rejects(
    mcpClient.callTool({
      name: "figma_workspace_run_script_file",
      arguments: {
        title: "Reject input file shape",
        inputFile: 123,
      },
    }),
    /Tool argument "inputFile" must be a string\./,
  );
  await assert.rejects(
    mcpClient.callTool({
      name: "figma_workspace_run_script_file",
      arguments: {
        title: "Reject run resultFile alias",
        resultFile: "result.json",
      },
    }),
    /Tool argument "resultFile" was removed\. Debug files are generated on demand/,
  );
  await assert.rejects(
    mcpClient.callTool({
      name: "figma_workspace_open",
      arguments: {
        title: "Reject open expectedSurface alias",
        expectedSurface: "design",
      },
    }),
    /Tool argument "expectedSurface" was removed\. Use "surface"\./,
  );
  await assert.rejects(
    mcpClient.callTool({
      name: "figma_workspace_apply_asset_manifest",
      arguments: {
        title: "Reject assets",
        assets: {},
      },
    }),
    /Tool argument "assets" must be an array\./,
  );
  await assert.rejects(
    mcpClient.callTool({
      name: "figma_workspace_apply_asset_manifest",
      arguments: {
        title: "Reject manifest path shape",
        manifestPath: 123,
      },
    }),
    /Tool argument "manifestPath" must be a string\./,
  );
  await assert.rejects(
    mcpClient.callTool({
      name: "figma_workspace_apply_asset_manifest",
      arguments: {
        title: "Reject manifest argumentsTemplate alias",
        argumentsTemplate: {},
      },
    }),
    /Tool argument "argumentsTemplate" was removed\. Use "figma_workspace_call_upstream_tool"\./,
  );
  await assert.rejects(
    mcpClient.callTool({
      name: "figma_workspace_apply_asset_manifest",
      arguments: {
        title: "Reject manifest escape",
        toolName: "fake_upload",
      },
    }),
    /Tool argument "toolName" was removed\. Use "figma_workspace_call_upstream_tool"\./,
  );
  await assert.rejects(
    mcpClient.callTool({
      name: "figma_workspace_apply_asset_manifest",
      arguments: {
        title: "Reject manifest asset escape",
        assets: [{ path: "asset.png", target: "12:34", toolName: "fake_upload" }],
      },
    }),
    /Tool argument "assets\[0\]\.toolName\/arguments" was removed\. Use "figma_workspace_call_upstream_tool"\./,
  );
  await assert.rejects(
    mcpClient.callTool({
      name: "figma_workspace_run_task_plan",
      arguments: {
        title: "Reject steps",
        steps: {},
      },
    }),
    /Tool argument "steps" must be an array\./,
  );
  await assert.rejects(
    mcpClient.callTool({
      name: "figma_workspace_run_task_plan",
      arguments: {
        title: "Reject step top-level args",
        steps: [{ type: "screenshot-capture", target: "12:34" }],
      },
    }),
    /Tool argument "steps\[0\]\.target" is not supported\. Put step tool inputs under "args"\./,
  );
  await assert.rejects(
    mcpClient.callTool({
      name: "figma_workspace_run_task_plan",
      arguments: {
        title: "Reject step arguments alias",
        steps: [{ type: "upstream-tool", arguments: { toolName: "fake" } }],
      },
    }),
    /Tool argument "steps\[0\]\.arguments" was removed\. Use "args"\./,
  );
  await assert.rejects(
    mcpClient.callTool({
      name: "figma_workspace_run_task_plan",
      arguments: {
        title: "Reject task plan outputFile legacy",
        outputFile: "plan.result.json",
        steps: [{ type: "upstream-tool", args: { toolName: "fake", arguments: {} } }],
      },
    }),
    /Tool argument "outputFile" was removed\. Debug files are generated on demand/,
  );
  const badPlanDir = await mkdtemp(resolve(tmpdir(), "figma-workspace-bad-plan-"));
  const badPlanPath = resolve(badPlanDir, "bad-plan.json");
  await writeFile(
    badPlanPath,
    JSON.stringify([{ type: "screenshot-capture", target: "12:34" }]),
    "utf8",
  );
  await assert.rejects(
    mcpClient.callTool({
      name: "figma_workspace_run_task_plan",
      arguments: {
        title: "Reject plan file step top-level args",
        planPath: badPlanPath,
      },
    }),
    /Tool argument "plan\[0\]\.target" is not supported\. Put step tool inputs under "args"\./,
  );
  await rm(badPlanDir, { recursive: true, force: true });
  await assert.rejects(
    mcpClient.callTool({
      name: "figma_workspace_apply_asset_manifest",
      arguments: {
        title: "Reject asset aliases",
        assets: [{ filePath: "asset.png", target: "12:34" }],
      },
    }),
    /Tool argument "assets\[0\]\.filePath\/localPath" was removed\. Use "path"\./,
  );
  await assert.rejects(
    mcpClient.callTool({
      name: "figma_workspace_download_assets",
      arguments: {
        title: "Reject download target alias",
        target: "12:34",
      },
    }),
    /Tool argument "target" was removed\. Use "targets"\./,
  );
  await assert.rejects(
    mcpClient.callTool({
      name: "figma_workspace_download_assets",
      arguments: {
        title: "Reject download assets alias",
        assets: [{ target: "12:34" }],
      },
    }),
    /Tool argument "assets" was removed\. Use "targets"\./,
  );
  await assert.rejects(
    mcpClient.callTool({
      name: "figma_workspace_download_assets",
      arguments: {
        title: "Reject download escape",
        toolName: "download_assets",
      },
    }),
    /Tool argument "toolName" was removed\. Use "figma_workspace_call_upstream_tool"\./,
  );
  await assert.rejects(
    mcpClient.callTool({
      name: "figma_workspace_download_assets",
      arguments: {
        title: "Reject download target item alias",
        targets: [{ nodeId: "12:34" }],
      },
    }),
    /Tool argument "targets\[0\]\.nodeId\/targetNodeId\/targetHandle\/targetId" was removed\. Use "target"\./,
  );
  await assert.rejects(
    mcpClient.callTool({
      name: "figma_workspace_capture_node",
      arguments: {
        title: "Reject capture alias",
        nodeId: "12:34",
      },
    }),
    /Tool argument "nodeId" was removed\. Use "target"\./,
  );
  await assert.rejects(
    mcpClient.callTool({
      name: "figma_workspace_capture_node",
      arguments: {
        title: "Reject capture resultFile alias",
        resultFile: "capture.json",
      },
    }),
    /Tool argument "resultFile" was removed\. Use "imageFile"\./,
  );
  await assert.rejects(
    mcpClient.callTool({
      name: "figma_workspace_capture_node",
      arguments: {
        title: "Reject capture outputFile legacy",
        outputFile: "capture.png",
      },
    }),
    /Tool argument "outputFile" was removed\. Use "imageFile"\./,
  );
  await assert.rejects(
    mcpClient.callTool({
      name: "figma_workspace_capture_node",
      arguments: {
        title: "Reject capture metadataFile",
        target: { fileKey: "file123", nodeId: "22:7" },
        metadataFile: "capture.json",
      },
    }),
    /Tool argument "metadataFile" was removed\. Use "figma_workspace_call_upstream_tool"\./,
  );
  await assert.rejects(
    mcpClient.callTool({
      name: "figma_workspace_capture_node",
      arguments: {
        title: "Reject capture escape",
        toolName: "fake_screenshot",
      },
    }),
    /Tool argument "toolName" was removed\. Use "figma_workspace_call_upstream_tool"\./,
  );
  const badManifestDir = await mkdtemp(resolve(tmpdir(), "figma-workspace-bad-assets-"));
  try {
    const badManifestTop = resolve(badManifestDir, "bad-top.json");
    await writeFile(
      badManifestTop,
      JSON.stringify({ toolName: "fake_upload", assets: [{ path: "asset.png", target: "12:34" }] }),
      "utf8",
    );
    await assert.rejects(
      mcpClient.callTool({
        name: "figma_workspace_apply_asset_manifest",
        arguments: {
          title: "Reject manifest file escape",
          manifestPath: badManifestTop,
        },
      }),
      /Asset manifest fields "toolName\/arguments\/refresh" were removed\. Use "figma_workspace_call_upstream_tool"\./,
    );
    const badManifestAsset = resolve(badManifestDir, "bad-asset.json");
    await writeFile(
      badManifestAsset,
      JSON.stringify({ assets: [{ path: "asset.png", target: "12:34", arguments: { file: "{{path}}" } }] }),
      "utf8",
    );
    await assert.rejects(
      mcpClient.callTool({
        name: "figma_workspace_apply_asset_manifest",
        arguments: {
          title: "Reject manifest asset file escape",
          manifestPath: badManifestAsset,
        },
      }),
      /Asset manifest entry 0 fields "toolName\/arguments\/refresh" were removed\. Use "figma_workspace_call_upstream_tool"\./,
    );
  } finally {
    await rm(badManifestDir, { recursive: true, force: true });
  }
  await assert.rejects(
    mcpClient.callTool({
      name: "figma_workspace_guidance",
      arguments: {
        title: "Reject guidance intent alias",
        intent: "make a card",
      },
    }),
    /Tool argument "intent" was removed\. Use "query"\./,
  );
  await assert.rejects(
    mcpClient.callTool({
      name: "figma_workspace_prepare_task",
      arguments: {
        title: "Reject prepare taskDir alias",
        taskDir: "/tmp/task",
      },
    }),
    /Tool argument "taskDir" was removed\. Use "workspaceDir"\./,
  );
  await assert.rejects(
    mcpClient.callTool({
      name: "figma_workspace_prepare_task",
      arguments: {
        title: "Reject prepare scriptName alias",
        scriptName: "task.figma.js",
      },
    }),
    /Tool argument "scriptName" was removed\. Use "fileName"\./,
  );
  await assert.rejects(
    mcpClient.callTool({
      name: "figma_workspace_capture_node",
      arguments: {
        title: "Reject capture preview alias",
        target: { fileKey: "file123", nodeId: "22:7" },
        preview: true,
      },
    }),
    /Tool argument "preview" was removed\. Capture results now return local file paths/,
  );
  await assert.rejects(
    mcpClient.callTool({
      name: "figma_workspace_capture_node",
      arguments: {
        title: "Reject removed thumbnail",
        target: { fileKey: "file123", nodeId: "22:7" },
        thumbnail: true,
      },
    }),
    /Tool argument "thumbnail" was removed\. Capture results now return local file paths/,
  );
  await assert.rejects(
    mcpClient.callTool({
      name: "figma_workspace_capture_node",
      arguments: {
        title: "Reject removed thumbnail size",
        target: { fileKey: "file123", nodeId: "22:7" },
        thumbnailMaxSize: 0,
      },
    }),
    /Tool argument "thumbnailMaxSize" was removed\. Capture results now return local file paths/,
  );
  await assert.rejects(
    mcpClient.callTool({
      name: "figma_workspace_inspect",
      arguments: {
        title: "Reject inspect handles",
        mode: "validate",
        handles: [123],
      },
    }),
    /Tool argument "handles\[0\]" must be a string\./,
  );
  assert.deepEqual(calls, []);
  await mcpClient.close();
});

test("figma workspace applies asset manifests through official upload_assets", async () => {
  const tempDir = await mkdtemp(resolve(tmpdir(), "figma-workspace-assets-"));
  const assetPath = resolve(tempDir, "hero.png");
  await writeFile(assetPath, "fake image bytes", "utf8");
  const calls = [];
  const fakeClient = createFakeFigmaClient(
    calls,
    ({ name, args }) => {
      assert.equal(name, "upload_assets");
      assert.deepEqual(args, {
        fileKey: "file123",
        count: 1,
        nodeId: "12:34",
        scaleMode: "FILL",
      });
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              ok: true,
              result: {
                summary: "asset filled",
                payload: "x".repeat(2_000),
                id: "12:34",
              },
            }),
          },
        ],
      };
    },
    {
      tools: [
        {
          name: "upload_assets",
          description: "Official upload_assets tool.",
          inputSchema: {
            type: "object",
            properties: {
              fileKey: { type: "string" },
              count: { type: "number" },
              nodeId: { type: "string" },
              scaleMode: { type: "string" },
            },
          },
        },
      ],
    },
  );
  const { server } = createFigmaWorkspaceMcpServer({ client: fakeClient });
  const mcpClient = new Client(
    { name: "test-client", version: "0.1.0" },
    { capabilities: {} },
  );
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

  try {
    await server.connect(serverTransport);
    await mcpClient.connect(clientTransport);
    await mcpClient.callTool({
      name: "figma_workspace_open",
      arguments: {
        title: "Open asset file context",
        sessionId: "asset-output",
        connect: false,
        file: "https://www.figma.com/design/file123/Test",
      },
    });

    const result = await mcpClient.callTool({
      name: "figma_workspace_apply_asset_manifest",
      arguments: {
        title: "Apply assets",
        sessionId: "asset-output",
        assets: [
          {
            path: assetPath,
            target: "12:34",
            name: "Hero art",
            metadata: { role: "background" },
          },
        ],
      },
    });
    const json = structuredToolResult(result);
    assert.equal(json.ok, true);
    assert.equal(json.assets.length, 1);
    assert.equal(json.assets[0].toolName, undefined);
    assert.equal(json.assets[0].upload, undefined);
    assert.equal(json.assets[0].upstreamSummary, undefined);
    assert.equal(json.assets[0].error, undefined);
    assert.equal(json.assets[0].upstreamError, undefined);
    assert.equal(json.assets[0].result, undefined);
    assert.equal(json.assets[0].arguments, undefined);
    assert.equal(json.assets[0].upstream, undefined);
    assert.equal(json.failures, undefined);
    assert.equal(json.outputFiles, undefined);
    assert.deepEqual(calls.map((call) => call[0]), ["connect", "listTools", "callTool"]);
    await mcpClient.close();
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("figma workspace validates asset manifest targets when upstream eval is available", async () => {
  const tempDir = await mkdtemp(resolve(tmpdir(), "figma-workspace-assets-validate-"));
  const assetPath = resolve(tempDir, "hero.png");
  await writeFile(assetPath, "fake image bytes", "utf8");
  const calls = [];
  const fakeClient = createFakeFigmaClient(
    calls,
    ({ name, args }) => {
      if (name === "upload_assets") {
        assert.deepEqual(args, {
          fileKey: "file123",
          count: 1,
          nodeId: "12:34",
          scaleMode: "FILL",
        });
        return {
          content: [{ type: "text", text: JSON.stringify({ ok: true, result: { id: "12:34" } }) }],
        };
      }
      if (name === "use_figma") {
        assert.equal(typeof args.code, "string");
        assert.match(args.code, /targetNodeIds/);
        assert.match(args.code, /12:34/);
        assert.doesNotMatch(args.code, /\$\.create = async function create/);
        assert.doesNotMatch(args.code, /\$\.checkpoint = async function checkpoint/);
        assert.doesNotMatch(args.code, /const __figmaReplEvalCheckpoints = \[\]/);
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                ok: true,
                result: {
                  validations: [
                    {
                      targetNodeId: "12:34",
                      status: "valid",
                      nodeId: "12:34",
                      nodeType: "RECTANGLE",
                      fillCount: 1,
                      imageFillCount: 1,
                    },
                  ],
                  validCount: 1,
                  invalidCount: 0,
                },
              }),
            },
          ],
        };
      }
      throw new Error(`unexpected tool ${name}`);
    },
    {
      tools: [
        { name: "upload_assets", description: "Official upload tool.", inputSchema: { type: "object", properties: { fileKey: { type: "string" }, count: { type: "number" }, nodeId: { type: "string" }, scaleMode: { type: "string" } } } },
        { name: "use_figma", description: "Fake eval tool.", inputSchema: { type: "object", properties: { code: { type: "string" } } } },
      ],
    },
  );
  const { server } = createFigmaWorkspaceMcpServer({ client: fakeClient });
  const mcpClient = new Client(
    { name: "test-client", version: "0.1.0" },
    { capabilities: {} },
  );
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

  try {
    await server.connect(serverTransport);
    await mcpClient.connect(clientTransport);
    await mcpClient.callTool({
      name: "figma_workspace_open",
      arguments: {
        title: "Open validate file context",
        sessionId: "asset-validate",
        connect: false,
        file: "https://www.figma.com/design/file123/Test",
      },
    });

    const result = await mcpClient.callTool({
      name: "figma_workspace_apply_asset_manifest",
      arguments: {
        title: "Apply and validate assets",
        sessionId: "asset-validate",
        assets: [{ path: assetPath, target: "12:34" }],
      },
    });
    const json = structuredToolResult(result);
    assert.equal(json.ok, true);
    assert.equal(json.validation.ok, true);
    assert.equal(json.validation.validationSource, "parsed.json.result");
    assert.equal(json.validation.validCount, 1);
    assert.equal(json.assets[0].validation.status, "valid");
    assert.deepEqual(calls.map((call) => call[0]), ["connect", "listTools", "callTool", "callTool"]);
    assert.deepEqual(calls.filter((call) => call[0] === "callTool").map((call) => call[1]), ["upload_assets", "use_figma"]);
    await mcpClient.close();
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("figma workspace asset manifest validation handles nested upstream eval results", async () => {
  const tempDir = await mkdtemp(resolve(tmpdir(), "figma-workspace-assets-nested-validate-"));
  const assetPath = resolve(tempDir, "hero.png");
  await writeFile(assetPath, "fake image bytes", "utf8");
  const calls = [];
  const fakeClient = createFakeFigmaClient(
    calls,
    ({ name }) => {
      if (name === "upload_assets") {
        return {
          content: [{ type: "text", text: JSON.stringify({ ok: true, result: { id: "12:34" } }) }],
        };
      }
      if (name === "use_figma") {
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                ok: true,
                result: {
                  ok: true,
                  result: {
                    validations: [
                      {
                        targetNodeId: "12:34",
                        status: "valid",
                        nodeId: "12:34",
                        nodeType: "RECTANGLE",
                        fillCount: 1,
                        imageFillCount: 1,
                      },
                    ],
                    validCount: 1,
                    invalidCount: 0,
                  },
                },
              }),
            },
          ],
        };
      }
      throw new Error(`unexpected tool ${name}`);
    },
    {
      tools: [
        { name: "upload_assets", description: "Official upload tool.", inputSchema: { type: "object", properties: { fileKey: { type: "string" }, count: { type: "number" }, nodeId: { type: "string" }, scaleMode: { type: "string" } } } },
        { name: "use_figma", description: "Fake eval tool.", inputSchema: { type: "object", properties: { code: { type: "string" } } } },
      ],
    },
  );
  const { server } = createFigmaWorkspaceMcpServer({ client: fakeClient });
  const mcpClient = new Client(
    { name: "test-client", version: "0.1.0" },
    { capabilities: {} },
  );
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

  try {
    await server.connect(serverTransport);
    await mcpClient.connect(clientTransport);
    await mcpClient.callTool({
      name: "figma_workspace_open",
      arguments: {
        title: "Open nested validate file context",
        sessionId: "asset-nested-validate",
        connect: false,
        file: "https://www.figma.com/design/file123/Test",
      },
    });

    const result = await mcpClient.callTool({
      name: "figma_workspace_apply_asset_manifest",
      arguments: {
        title: "Apply and validate nested assets",
        sessionId: "asset-nested-validate",
        assets: [{ path: assetPath, target: "12:34" }],
      },
    });
    const json = structuredToolResult(result);
    assert.equal(json.ok, true);
    assert.equal(json.validation.ok, true);
    assert.equal(json.validation.validationSource, "parsed.json.result.result");
    assert.equal(json.validation.expectedCount, 1);
    assert.equal(json.validation.validCount, 1);
    assert.equal(json.validation.missingValidationCount, 0);
    assert.equal(json.assets[0].validation.status, "valid");
    await mcpClient.close();
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("figma workspace asset manifest validation is indeterminate when upstream eval returns no target records", async () => {
  const tempDir = await mkdtemp(resolve(tmpdir(), "figma-workspace-assets-empty-validate-"));
  const assetPath = resolve(tempDir, "hero.png");
  await writeFile(assetPath, "fake image bytes", "utf8");
  const calls = [];
  const fakeClient = createFakeFigmaClient(
    calls,
    ({ name }) => {
      if (name === "upload_assets") {
        return {
          content: [{ type: "text", text: JSON.stringify({ ok: true, result: { id: "12:34" } }) }],
        };
      }
      if (name === "use_figma") {
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                ok: true,
                result: {
                  validations: [],
                  validCount: 0,
                  invalidCount: 0,
                },
              }),
            },
          ],
        };
      }
      throw new Error(`unexpected tool ${name}`);
    },
    {
      tools: [
        { name: "upload_assets", description: "Official upload tool.", inputSchema: { type: "object", properties: { fileKey: { type: "string" }, count: { type: "number" }, nodeId: { type: "string" }, scaleMode: { type: "string" } } } },
        { name: "use_figma", description: "Fake eval tool.", inputSchema: { type: "object", properties: { code: { type: "string" } } } },
      ],
    },
  );
  const { server } = createFigmaWorkspaceMcpServer({ client: fakeClient });
  const mcpClient = new Client(
    { name: "test-client", version: "0.1.0" },
    { capabilities: {} },
  );
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

  try {
    await server.connect(serverTransport);
    await mcpClient.connect(clientTransport);
    await mcpClient.callTool({
      name: "figma_workspace_open",
      arguments: {
        title: "Open empty validate file context",
        sessionId: "asset-empty-validate",
        connect: false,
        file: "https://www.figma.com/design/file123/Test",
      },
    });

    const result = await mcpClient.callTool({
      name: "figma_workspace_apply_asset_manifest",
      arguments: {
        title: "Apply and validate empty assets",
        sessionId: "asset-empty-validate",
        assets: [{ path: assetPath, target: "12:34" }],
      },
    });
    const json = structuredToolResult(result);
    assert.equal(json.ok, false);
    assert.equal(json.validation.ok, undefined);
    assert.equal(json.validation.reason, "validation result did not include every target record");
    assert.equal(json.validation.validationSource, "parsed.json.result");
    assert.equal(json.validation.expectedCount, 1);
    assert.equal(json.validation.validCount, 0);
    assert.equal(json.validation.invalidCount, 0);
    assert.equal(json.validation.missingValidationCount, 1);
    assert.equal(json.assets[0].validation, undefined);
    assertFilePointer(json.outputFiles.debugFile, json.outputFiles.debugFile.path);
    const debugFile = await readPrettyJsonPointer(json.outputFiles.debugFile, json.outputFiles.debugFile.path);
    assert.equal(debugFile.validationOk, undefined);
    assert.equal(debugFile.validationReason, "validation result did not include every target record");
    assert.equal(debugFile.validationExpectedCount, 1);
    assert.equal(debugFile.validationMissingCount, 1);
    await mcpClient.close();
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("figma workspace asset manifest validation parses stringified array wrappers", async () => {
  const tempDir = await mkdtemp(resolve(tmpdir(), "figma-workspace-assets-string-validate-"));
  const assetPath = resolve(tempDir, "hero.png");
  await writeFile(assetPath, "fake image bytes", "utf8");
  const calls = [];
  const fakeClient = createFakeFigmaClient(
    calls,
    ({ name }) => {
      if (name === "upload_assets") {
        return {
          content: [{ type: "text", text: JSON.stringify({ ok: true, result: { id: "12:34" } }) }],
        };
      }
      if (name === "use_figma") {
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                ok: true,
                result: JSON.stringify([
                  {
                    targetNodeId: "12:34",
                    status: "valid",
                    nodeId: "12:34",
                    nodeType: "RECTANGLE",
                    fillCount: 1,
                    imageFillCount: 1,
                  },
                ]),
              }),
            },
          ],
        };
      }
      throw new Error(`unexpected tool ${name}`);
    },
    {
      tools: [
        { name: "upload_assets", description: "Official upload tool.", inputSchema: { type: "object", properties: { fileKey: { type: "string" }, count: { type: "number" }, nodeId: { type: "string" }, scaleMode: { type: "string" } } } },
        { name: "use_figma", description: "Fake eval tool.", inputSchema: { type: "object", properties: { code: { type: "string" } } } },
      ],
    },
  );
  const { server } = createFigmaWorkspaceMcpServer({ client: fakeClient });
  const mcpClient = new Client(
    { name: "test-client", version: "0.1.0" },
    { capabilities: {} },
  );
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

  try {
    await server.connect(serverTransport);
    await mcpClient.connect(clientTransport);
    await mcpClient.callTool({
      name: "figma_workspace_open",
      arguments: {
        title: "Open string validate file context",
        sessionId: "asset-string-validate",
        connect: false,
        file: "https://www.figma.com/design/file123/Test",
      },
    });

    const result = await mcpClient.callTool({
      name: "figma_workspace_apply_asset_manifest",
      arguments: {
        title: "Apply and validate string assets",
        sessionId: "asset-string-validate",
        assets: [{ path: assetPath, target: "12:34" }],
      },
    });
    const json = structuredToolResult(result);
    assert.equal(json.ok, true);
    assert.equal(json.validation.ok, true);
    assert.equal(json.validation.validationSource, "parsed.json.result(json)");
    assert.equal(json.validation.validCount, 1);
    assert.equal(json.validation.missingValidationCount, 0);
    assert.equal(json.assets[0].validation.status, "valid");
    await mcpClient.close();
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("figma workspace asset manifest upstream failures use upstreamError inline and on-demand debug file", async () => {
  const tempDir = await mkdtemp(resolve(tmpdir(), "figma-workspace-assets-upstream-error-"));
  const assetPath = resolve(tempDir, "hero.png");
  await writeFile(assetPath, "fake image bytes", "utf8");
  const calls = [];
  const fakeClient = createFakeFigmaClient(
    calls,
    ({ name }) => {
      assert.equal(name, "upload_assets");
      return {
        content: [{ type: "text", text: JSON.stringify({ ok: false, error: { message: "upload failed", code: "UPLOAD_FAILED" } }) }],
      };
    },
    {
      tools: [
        { name: "upload_assets", description: "Official upload tool.", inputSchema: { type: "object", properties: { fileKey: { type: "string" }, count: { type: "number" }, nodeId: { type: "string" }, scaleMode: { type: "string" } } } },
      ],
    },
  );
  const { server } = createFigmaWorkspaceMcpServer({ client: fakeClient });
  const mcpClient = new Client(
    { name: "test-client", version: "0.1.0" },
    { capabilities: {} },
  );
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

  try {
    await server.connect(serverTransport);
    await mcpClient.connect(clientTransport);
    await mcpClient.callTool({
      name: "figma_workspace_open",
      arguments: {
        title: "Open failure file context",
        sessionId: "asset-upstream-error",
        connect: false,
        cwd: tempDir,
        file: "https://www.figma.com/design/file123/Test",
      },
    });
    const result = await mcpClient.callTool({
      name: "figma_workspace_apply_asset_manifest",
      arguments: {
        title: "Apply failing asset",
        sessionId: "asset-upstream-error",
        assets: [{ path: assetPath, target: "12:34" }],
        validateTargets: false,
      },
    });
    const json = structuredToolResult(result);
    assert.equal(json.ok, false);
    assert.equal(json.assets[0].upstreamError.code, "UPLOAD_FAILED");
    assert.equal(json.assets[0].error, undefined);
    assert.equal(json.assets[0].toolName, undefined);
    assert.equal(json.assets[0].upstreamSummary, undefined);
    assert.equal(json.failures[0].upstreamError.code, "UPLOAD_FAILED");
    assert.equal(json.failures[0].toolName, undefined);
    assertFilePointer(json.outputFiles.debugFile, json.outputFiles.debugFile.path);
    assert.match(json.outputFiles.debugFile.path, /asset-manifest\.assets\.result\.json$/u);
    const fileJson = await readPrettyJsonPointer(json.outputFiles.debugFile, json.outputFiles.debugFile.path);
    assert.equal(fileJson.assetDetails[0].toolName, "upload_assets");
    assert.equal(fileJson.assetDetails[0].upstreamError.code, "UPLOAD_FAILED");
    assert.equal(fileJson.assetDetails[0].upstream.ok, false);
    await mcpClient.close();
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("figma workspace submits local bytes when upload_assets returns a submit URL", async () => {
  const tempDir = await mkdtemp(resolve(tmpdir(), "figma-workspace-upload-assets-"));
  const assetPath = resolve(tempDir, "icon.png");
  await writeFile(assetPath, "fake png bytes", "utf8");
  const calls = [];
  const posts = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, init = {}) => {
    posts.push({
      url: String(url),
      method: init.method,
      contentType: init.headers?.["Content-Type"],
      body: Buffer.from(await new Response(init.body).arrayBuffer()).toString("utf8"),
    });
    return new Response(
      JSON.stringify({ success: true, imageHash: "abc", sizeBytes: 14, contentType: "image/png", placedOnNodeId: "12:34" }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );
  };
  const fakeClient = createFakeFigmaClient(
    calls,
    ({ name, args }) => {
      assert.equal(name, "upload_assets");
      assert.deepEqual(args, {
        fileKey: "file123",
        count: 1,
        nodeId: "12:34",
        scaleMode: "FILL",
      });
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({ uploads: [{ submitUrl: "https://example.test/upload" }] }),
          },
        ],
      };
    },
    {
      tools: [
        {
          name: "upload_assets",
          description: "Fake official upload tool.",
          inputSchema: {
            type: "object",
            properties: {
              fileKey: { type: "string" },
              count: { type: "number" },
              nodeId: { type: "string" },
              scaleMode: { type: "string" },
            },
          },
        },
      ],
    },
  );
  const { server } = createFigmaWorkspaceMcpServer({ client: fakeClient });
  const mcpClient = new Client(
    { name: "test-client", version: "0.1.0" },
    { capabilities: {} },
  );
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

  try {
    await server.connect(serverTransport);
    await mcpClient.connect(clientTransport);
    await mcpClient.callTool({
      name: "figma_workspace_open",
      arguments: {
        title: "Open upload file context",
        sessionId: "upload",
        connect: false,
        file: "https://www.figma.com/design/file123/Test",
        handles: { "$iconTarget": "12:34" },
      },
    });
    const result = await mcpClient.callTool({
      name: "figma_workspace_apply_asset_manifest",
      arguments: {
        title: "Apply upload asset",
        sessionId: "upload",
        assets: [{ path: assetPath, target: "$iconTarget", name: "Icon" }],
      },
    });
    const json = structuredToolResult(result);
    assert.equal(json.ok, true);
    assert.equal(json.assets[0].upload.ok, true);
    assert.equal(json.assets[0].upload.status, 200);
    assert.equal(json.assets[0].upload.mimeType, "image/png");
    assert.equal(json.assets[0].upload.bytes, 14);
    assert.deepEqual(json.assets[0].upload.response, {
      success: true,
      imageHash: "abc",
      sizeBytes: 14,
      contentType: "image/png",
      placedOnNodeId: "12:34",
    });
    assert.equal(json.assets[0].upstreamError, undefined);
    assert.equal(json.outputFiles, undefined);
    assert.deepEqual(posts, [
      {
        url: "https://example.test/upload",
        method: "POST",
        contentType: "image/png",
        body: "fake png bytes",
      },
    ]);
    await mcpClient.close();
  } finally {
    globalThis.fetch = originalFetch;
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("figma workspace applies submitted upload imageHash to target node fills", async () => {
  const tempDir = await mkdtemp(resolve(tmpdir(), "figma-workspace-upload-apply-"));
  const assetPath = resolve(tempDir, "icon.png");
  await writeFile(assetPath, "fake png bytes", "utf8");
  const calls = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(
    JSON.stringify({ success: true, imageHash: "abc", sizeBytes: 14, contentType: "image/png" }),
    { status: 200, headers: { "Content-Type": "application/json" } },
  );
  const fakeClient = createFakeFigmaClient(
    calls,
    ({ name, args }) => {
      if (name === "upload_assets") {
        assert.deepEqual(args, {
          fileKey: "file123",
          count: 1,
          nodeId: "12:34",
          scaleMode: "FILL",
        });
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({ uploads: [{ submitUrl: "https://example.test/upload" }] }),
            },
          ],
        };
      }
      if (name === "use_figma") {
        assert.equal(typeof args.code, "string");
        assert.match(args.code, /assetFills/);
        assert.match(args.code, /12:34/);
        assert.match(args.code, /abc/);
        assert.match(args.code, /node\.fills = \[/);
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                ok: true,
                result: {
                  applications: [
                    {
                      targetNodeId: "12:34",
                      status: "applied",
                      nodeId: "12:34",
                      nodeType: "RECTANGLE",
                      imageHash: "abc",
                      scaleMode: "FILL",
                    },
                  ],
                  appliedCount: 1,
                  failedCount: 0,
                },
              }),
            },
          ],
        };
      }
      throw new Error(`unexpected tool ${name}`);
    },
    {
      tools: [
        { name: "upload_assets", description: "Fake official upload tool.", inputSchema: { type: "object", properties: { fileKey: { type: "string" }, count: { type: "number" }, nodeId: { type: "string" }, scaleMode: { type: "string" } } } },
        { name: "use_figma", description: "Fake eval tool.", inputSchema: { type: "object", properties: { code: { type: "string" } } } },
      ],
    },
  );
  const { server } = createFigmaWorkspaceMcpServer({ client: fakeClient });
  const mcpClient = new Client(
    { name: "test-client", version: "0.1.0" },
    { capabilities: {} },
  );
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

  try {
    await server.connect(serverTransport);
    await mcpClient.connect(clientTransport);
    await mcpClient.callTool({
      name: "figma_workspace_open",
      arguments: {
        title: "Open upload apply context",
        sessionId: "upload-apply",
        connect: false,
        file: "https://www.figma.com/design/file123/Test",
        handles: { "$iconTarget": "12:34" },
      },
    });
    const result = await mcpClient.callTool({
      name: "figma_workspace_apply_asset_manifest",
      arguments: {
        title: "Apply uploaded asset",
        sessionId: "upload-apply",
        assets: [{ path: assetPath, target: "$iconTarget", name: "Icon" }],
        validateTargets: false,
      },
    });
    const json = structuredToolResult(result);
    assert.equal(json.ok, true);
    assert.equal(json.application.ok, true);
    assert.equal(json.application.appliedCount, 1);
    assert.equal(json.assets[0].application.status, "applied");
    assert.equal(json.assets[0].application.imageHash, "abc");
    assert.equal(json.validation.skipped, true);
    assert.equal(json.outputFiles, undefined);
    assert.deepEqual(calls.filter((call) => call[0] === "callTool").map((call) => call[1]), ["upload_assets", "use_figma"]);
    await mcpClient.close();
  } finally {
    globalThis.fetch = originalFetch;
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("figma workspace uses the stable official upload_assets schema without overrides", async () => {
  const tempDir = await mkdtemp(resolve(tmpdir(), "figma-workspace-official-upload-assets-"));
  const assetPath = resolve(tempDir, "hero.png");
  await writeFile(assetPath, "official png bytes", "utf8");
  const calls = [];
  const posts = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, init = {}) => {
    posts.push({
      url: String(url),
      method: init.method,
      contentType: init.headers?.["Content-Type"],
      body: Buffer.from(await new Response(init.body).arrayBuffer()).toString("utf8"),
    });
    return new Response(
      JSON.stringify({ success: true, imageHash: "official-hash", sizeBytes: 18, contentType: "image/png", placedOnNodeId: "12:34" }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );
  };
  const fakeClient = createFakeFigmaClient(
    calls,
    ({ name, args }) => {
      assert.equal(name, "upload_assets");
      assert.deepEqual(args, {
        fileKey: "file123",
        count: 1,
        nodeId: "12:34",
        scaleMode: "FILL",
      });
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({ uploads: [{ submitUrl: "https://example.test/official-upload" }] }),
          },
        ],
      };
    },
    {
      tools: [
        {
          name: "upload_assets",
          description: "Official upload_assets schema fixture.",
          inputSchema: {
            type: "object",
            properties: {
              fileKey: { type: "string" },
              count: { type: "number" },
              nodeId: { type: "string" },
              scaleMode: { type: "string" },
            },
            required: ["fileKey", "count"],
          },
        },
      ],
    },
  );
  const { server } = createFigmaWorkspaceMcpServer({ client: fakeClient });
  const mcpClient = new Client(
    { name: "test-client", version: "0.1.0" },
    { capabilities: {} },
  );
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

  try {
    await server.connect(serverTransport);
    await mcpClient.connect(clientTransport);
    await mcpClient.callTool({
      name: "figma_workspace_open",
      arguments: {
        title: "Open official upload file context",
        sessionId: "official-upload",
        connect: false,
        file: "https://www.figma.com/design/file123/Test",
        handles: { "$heroTarget": "12:34" },
      },
    });
    const result = await mcpClient.callTool({
      name: "figma_workspace_apply_asset_manifest",
      arguments: {
        title: "Apply official upload asset",
        sessionId: "official-upload",
        assets: [{ path: assetPath, target: "$heroTarget", name: "Hero" }],
      },
    });
    const json = structuredToolResult(result);
    assert.equal(json.ok, true);
    assert.equal(json.assets[0].toolName, undefined);
    assert.equal(json.assets[0].upload.response.imageHash, "official-hash");
    assert.equal(json.assets[0].upload.response.placedOnNodeId, "12:34");
    assert.equal(json.assets[0].upload.response.sizeBytes, 18);
    assert.equal(json.assets[0].upstreamError, undefined);
    assert.equal(json.outputFiles, undefined);
    assert.deepEqual(posts, [
      {
        url: "https://example.test/official-upload",
        method: "POST",
        contentType: "image/png",
        body: "official png bytes",
      },
    ]);
    await mcpClient.close();
  } finally {
    globalThis.fetch = originalFetch;
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("figma workspace asset manifest requires official upload_assets", async () => {
  const tempDir = await mkdtemp(resolve(tmpdir(), "figma-workspace-missing-upload-assets-"));
  const assetPath = resolve(tempDir, "hero.png");
  await writeFile(assetPath, "fake png bytes", "utf8");
  const calls = [];
  const fakeClient = createFakeFigmaClient(
    calls,
    () => {
      throw new Error("unexpected upstream call");
    },
    {
      tools: [
        {
          name: "fake_upload_asset",
          description: "Legacy upload-like tool.",
          inputSchema: { type: "object", properties: {} },
        },
      ],
    },
  );
  const { server } = createFigmaWorkspaceMcpServer({ client: fakeClient });
  const mcpClient = new Client(
    { name: "test-client", version: "0.1.0" },
    { capabilities: {} },
  );
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

  try {
    await server.connect(serverTransport);
    await mcpClient.connect(clientTransport);
    await mcpClient.callTool({
      name: "figma_workspace_open",
      arguments: {
        title: "Open missing upload file context",
        sessionId: "missing-upload",
        connect: false,
        file: "https://www.figma.com/design/file123/Test",
      },
    });
    await assert.rejects(
      mcpClient.callTool({
        name: "figma_workspace_apply_asset_manifest",
        arguments: {
          title: "Apply missing upload asset",
          sessionId: "missing-upload",
          assets: [{ path: assetPath, target: "12:34" }],
        },
      }),
      /Required official upstream Figma MCP asset upload\/fill tool "upload_assets" was not found/,
    );
    assert.deepEqual(calls.map((call) => call[0]), ["connect", "listTools"]);
    await mcpClient.close();
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("figma workspace asset manifest rejects drifted upload_assets schema", async () => {
  const tempDir = await mkdtemp(resolve(tmpdir(), "figma-workspace-drifted-upload-assets-"));
  const assetPath = resolve(tempDir, "hero.png");
  await writeFile(assetPath, "fake png bytes", "utf8");
  const calls = [];
  const fakeClient = createFakeFigmaClient(
    calls,
    () => {
      throw new Error("unexpected upstream call");
    },
    {
      tools: [
        {
          name: "upload_assets",
          description: "Drifted upload tool.",
          inputSchema: {
            type: "object",
            properties: {
              fileKey: { type: "string" },
              count: { type: "number" },
              scaleMode: { type: "string" },
            },
          },
        },
      ],
    },
  );
  const { server } = createFigmaWorkspaceMcpServer({ client: fakeClient });
  const mcpClient = new Client(
    { name: "test-client", version: "0.1.0" },
    { capabilities: {} },
  );
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

  try {
    await server.connect(serverTransport);
    await mcpClient.connect(clientTransport);
    await mcpClient.callTool({
      name: "figma_workspace_open",
      arguments: {
        title: "Open drifted upload file context",
        sessionId: "drifted-upload",
        connect: false,
        file: "https://www.figma.com/design/file123/Test",
      },
    });
    await assert.rejects(
      mcpClient.callTool({
        name: "figma_workspace_apply_asset_manifest",
        arguments: {
          title: "Apply drifted upload asset",
          sessionId: "drifted-upload",
          assets: [{ path: assetPath, target: "12:34" }],
        },
      }),
      /inputSchema\.properties\.nodeId.*upstream contract drift/,
    );
    assert.deepEqual(calls.map((call) => call[0]), ["connect", "listTools"]);
    await mcpClient.close();
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("figma workspace downloads official exported and raw asset URLs per target", async () => {
  const tempDir = await mkdtemp(resolve(tmpdir(), "figma-workspace-download-assets-"));
  const outputDir = resolve(tempDir, "downloads");
  const exportBytes = Buffer.from("exported png bytes");
  const rawBytes = Buffer.from("raw jpg bytes");
  const originalFetch = globalThis.fetch;
  const fetches = [];
  globalThis.fetch = async (url) => {
    fetches.push(String(url));
    if (String(url).endsWith("/export.png")) {
      return new Response(exportBytes, { status: 200, headers: { "Content-Type": "image/png" } });
    }
    if (String(url).endsWith("/raw.jpg")) {
      return new Response(rawBytes, { status: 200, headers: { "Content-Type": "image/jpeg" } });
    }
    return new Response("missing", { status: 404, statusText: "Not Found" });
  };
  const calls = [];
  const fakeClient = createFakeFigmaClient(
    calls,
    ({ name, args }) => {
      assert.equal(name, "download_assets");
      assert.deepEqual(args, {
        fileKey: "file123",
        nodeId: "22:8",
        defaultFormat: "png",
        defaultScale: 2,
      });
      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            result: {
              exports: [{ downloadUrl: "https://assets.example/export.png", format: "png" }],
              sourceImages: [{ url: "https://assets.example/raw.jpg", format: "jpg" }],
            },
          }),
        }],
      };
    },
    {
      tools: [
        {
          name: "download_assets",
          description: "Fake official download tool.",
          inputSchema: {
            type: "object",
            properties: {
              fileKey: { type: "string" },
              nodeId: { type: "string" },
              defaultFormat: { type: "string" },
              defaultScale: { type: "number" },
            },
            required: ["fileKey", "nodeId"],
          },
        },
      ],
    },
  );
  const { server } = createFigmaWorkspaceMcpServer({ client: fakeClient });
  const mcpClient = new Client(
    { name: "test-client", version: "0.1.0" },
    { capabilities: {} },
  );
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

  try {
    await server.connect(serverTransport);
    await mcpClient.connect(clientTransport);
    await mcpClient.callTool({
      name: "figma_workspace_open",
      arguments: {
        title: "Open download file context",
        sessionId: "download",
        connect: false,
        file: "https://www.figma.com/design/file123/Test",
        handles: { "$hero": "22:8" },
      },
    });

    const result = await mcpClient.callTool({
      name: "figma_workspace_download_assets",
      arguments: {
        title: "Download hero assets",
        sessionId: "download",
        targets: [{ target: "$hero", name: "Hero", defaultFormat: "png", defaultScale: 2 }],
        outputDir,
      },
    });
    const json = structuredToolResult(result);
    assert.equal(json.ok, true);
    assert.equal(json.outputDir, outputDir);
    assert.equal(json.targets.length, 1);
    assert.equal(json.targets[0].targetNodeId, "22:8");
    assert.equal(json.targets[0].handle, "$hero");
    assert.equal(json.targets[0].downloadedFiles.length, 2);
    assert.equal(json.targets[0].downloadedFiles[0].path, resolve(outputDir, "hero", "exported.png"));
    assert.equal(json.targets[0].downloadedFiles[1].path, resolve(outputDir, "hero", "raw-1.jpg"));
    assert.deepEqual(await readFile(resolve(outputDir, "hero", "exported.png")), exportBytes);
    assert.deepEqual(await readFile(resolve(outputDir, "hero", "raw-1.jpg")), rawBytes);
    assert.equal(json.outputFiles, undefined);
    assert.deepEqual(fetches, ["https://assets.example/export.png", "https://assets.example/raw.jpg"]);
    assert.deepEqual(calls.map((call) => call[0]), ["connect", "listTools", "callTool"]);
    await mcpClient.close();
  } finally {
    globalThis.fetch = originalFetch;
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("figma workspace download_assets manifest batches targets and continues after target failures", async () => {
  const tempDir = await mkdtemp(resolve(tmpdir(), "figma-workspace-download-manifest-"));
  const manifestPath = resolve(tempDir, "downloads.json");
  const outputDir = resolve(tempDir, "downloads");
  await writeFile(
    manifestPath,
    JSON.stringify({
      targets: [
        { target: "$hero", name: "Hero" },
        { target: "22:9", name: "Missing" },
      ],
    }),
    "utf8",
  );
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(Buffer.from("asset"), { status: 200, headers: { "Content-Type": "image/png" } });
  const calls = [];
  const fakeClient = createFakeFigmaClient(
    calls,
    ({ name, args }) => {
      assert.equal(name, "download_assets");
      if (args.nodeId === "22:8") {
        return {
          content: [{
            type: "text",
            text: JSON.stringify({ exports: [{ url: "https://assets.example/hero.png", format: "png" }] }),
          }],
        };
      }
      assert.equal(args.nodeId, "22:9");
      return {
        content: [{
          type: "text",
          text: JSON.stringify({ ok: false, error: { message: "missing node", code: "NOT_FOUND" } }),
        }],
      };
    },
    {
      tools: [
        {
          name: "download_assets",
          description: "Fake official download tool.",
          inputSchema: {
            type: "object",
            properties: {
              fileKey: { type: "string" },
              nodeId: { type: "string" },
              defaultFormat: { type: "string" },
              defaultScale: { type: "number" },
            },
            required: ["fileKey", "nodeId"],
          },
        },
      ],
    },
  );
  const { server } = createFigmaWorkspaceMcpServer({ client: fakeClient });
  const mcpClient = new Client(
    { name: "test-client", version: "0.1.0" },
    { capabilities: {} },
  );
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

  try {
    await server.connect(serverTransport);
    await mcpClient.connect(clientTransport);
    await mcpClient.callTool({
      name: "figma_workspace_open",
      arguments: {
        title: "Open manifest download file context",
        sessionId: "download-manifest",
        connect: false,
        cwd: tempDir,
        file: "https://www.figma.com/design/file123/Test",
        handles: { "$hero": "22:8" },
      },
    });
    await assert.rejects(
      mcpClient.callTool({
        name: "figma_workspace_download_assets",
        arguments: {
          title: "Reject ambiguous download sources",
          sessionId: "download-manifest",
          targets: [{ target: "$hero" }],
          manifestPath,
        },
      }),
      /Pass either "targets" or "manifestPath", not both\./,
    );

    const result = await mcpClient.callTool({
      name: "figma_workspace_download_assets",
      arguments: {
        title: "Download manifest assets",
        sessionId: "download-manifest",
        manifestPath,
        outputDir,
      },
    });
    const json = structuredToolResult(result);
    assert.equal(json.ok, false);
    assert.equal(json.targets.length, 2);
    assert.equal(json.targets[0].ok, true);
    assert.equal(json.targets[1].ok, false);
    assert.equal(json.targets[1].error, undefined);
    assert.equal(json.targets[1].upstreamSummary, undefined);
    assert.equal(json.targets[1].upstreamError.code, "NOT_FOUND");
    assert.equal(json.failures.length, 1);
    assert.equal(json.failures[0].error, undefined);
    assert.equal(json.failures[0].upstreamError.code, "NOT_FOUND");
    assert.equal(calls.filter((call) => call[0] === "callTool").length, 2);
    assertFilePointer(json.outputFiles.debugFile, json.outputFiles.debugFile.path);
    assert.match(json.outputFiles.debugFile.path, /download-assets\.downloads\.result\.json$/u);
    const fileJson = await readPrettyJsonPointer(json.outputFiles.debugFile, json.outputFiles.debugFile.path);
    assert.equal(fileJson.targetDetails.length, 2);
    assert.equal(fileJson.targetDetails[1].upstreamError.code, "NOT_FOUND");
    await mcpClient.close();
  } finally {
    globalThis.fetch = originalFetch;
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("figma workspace download_assets local download failures use downloadError, not upstreamError", async () => {
  const tempDir = await mkdtemp(resolve(tmpdir(), "figma-workspace-download-local-error-"));
  const outputDir = resolve(tempDir, "downloads");
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response("missing", { status: 404, statusText: "Not Found" });
  const calls = [];
  const fakeClient = createFakeFigmaClient(
    calls,
    ({ name }) => {
      assert.equal(name, "download_assets");
      return {
        content: [{ type: "text", text: JSON.stringify({ exports: [{ url: "https://assets.example/missing.png", format: "png" }] }) }],
      };
    },
    {
      tools: [
        {
          name: "download_assets",
          description: "Fake official download tool.",
          inputSchema: {
            type: "object",
            properties: {
              fileKey: { type: "string" },
              nodeId: { type: "string" },
            },
            required: ["fileKey", "nodeId"],
          },
        },
      ],
    },
  );
  const { server } = createFigmaWorkspaceMcpServer({ client: fakeClient });
  const mcpClient = new Client(
    { name: "test-client", version: "0.1.0" },
    { capabilities: {} },
  );
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

  try {
    await server.connect(serverTransport);
    await mcpClient.connect(clientTransport);
    await mcpClient.callTool({
      name: "figma_workspace_open",
      arguments: {
        title: "Open local download failure context",
        sessionId: "download-local-error",
        connect: false,
        cwd: tempDir,
        file: "https://www.figma.com/design/file123/Test",
      },
    });
    const result = await mcpClient.callTool({
      name: "figma_workspace_download_assets",
      arguments: {
        title: "Download missing asset",
        sessionId: "download-local-error",
        targets: [{ target: "22:8", name: "Missing" }],
        outputDir,
      },
    });
    const json = structuredToolResult(result);
    assert.equal(json.ok, false);
    assert.equal(json.targets[0].upstreamError, undefined);
    assert.match(json.targets[0].downloadError.message, /HTTP 404/);
    assert.equal(json.failures[0].upstreamError, undefined);
    assert.match(json.failures[0].downloadError.message, /HTTP 404/);
    assertFilePointer(json.outputFiles.debugFile, json.outputFiles.debugFile.path);
    assert.match(json.outputFiles.debugFile.path, /download-assets\.downloads\.result\.json$/u);
    const fileJson = await readPrettyJsonPointer(json.outputFiles.debugFile, json.outputFiles.debugFile.path);
    assert.equal(fileJson.targetDetails[0].toolName, "download_assets");
    assert.equal(fileJson.targetDetails[0].upstream.ok, true);
    assert.match(fileJson.targetDetails[0].downloadError.message, /HTTP 404/);
    await mcpClient.close();
  } finally {
    globalThis.fetch = originalFetch;
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("figma workspace download_assets rejects drifted official schema fields", async () => {
  const calls = [];
  const fakeClient = createFakeFigmaClient(
    calls,
    () => {
      throw new Error("unexpected upstream call");
    },
    {
      tools: [
        {
          name: "download_assets",
          description: "Drifted download tool.",
          inputSchema: {
            type: "object",
            properties: {
              fileKey: { type: "string" },
              nodeId: { type: "string" },
              defaultScale: { type: "number" },
            },
          },
        },
      ],
    },
  );
  const { server } = createFigmaWorkspaceMcpServer({ client: fakeClient });
  const mcpClient = new Client(
    { name: "test-client", version: "0.1.0" },
    { capabilities: {} },
  );
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

  await server.connect(serverTransport);
  await mcpClient.connect(clientTransport);
  await mcpClient.callTool({
    name: "figma_workspace_open",
    arguments: {
      title: "Open drifted download file context",
      sessionId: "drifted-download",
      connect: false,
      file: "https://www.figma.com/design/file123/Test",
    },
  });
  await assert.rejects(
    mcpClient.callTool({
      name: "figma_workspace_download_assets",
      arguments: {
        title: "Download drifted assets",
        sessionId: "drifted-download",
        targets: [{ target: "22:8", defaultFormat: "png" }],
      },
    }),
    /inputSchema\.properties\.defaultFormat.*upstream contract drift/,
  );
  assert.deepEqual(calls.map((call) => call[0]), ["connect", "listTools"]);
  await mcpClient.close();
});

test("figma workspace captures node screenshot responses to a local file", async () => {
  const tempDir = await mkdtemp(resolve(tmpdir(), "figma-workspace-capture-"));
  const outputFile = resolve(tempDir, "node");
  const pngOutputFile = resolve(tempDir, "node.png");
  const pngBytes = await createTestPngBuffer();
  const calls = [];
  const fakeClient = createFakeFigmaClient(
    calls,
    ({ name, args }) => {
      assert.equal(name, "get_screenshot");
      assert.deepEqual(args, { fileKey: "file123", nodeId: "22:7" });
      return {
        content: [
          {
            type: "image",
            mimeType: "image/png",
            data: pngBytes.toString("base64"),
          },
        ],
      };
    },
    {
      tools: [
        {
          name: "get_screenshot",
          description: "Official screenshot tool.",
          inputSchema: { type: "object", properties: { fileKey: { type: "string" }, nodeId: { type: "string" } }, required: ["fileKey", "nodeId"] },
        },
      ],
    },
  );
  const { server } = createFigmaWorkspaceMcpServer({ client: fakeClient });
  const mcpClient = new Client(
    { name: "test-client", version: "0.1.0" },
    { capabilities: {} },
  );
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

  try {
    await server.connect(serverTransport);
    await mcpClient.connect(clientTransport);

    const result = await mcpClient.callTool({
      name: "figma_workspace_capture_node",
      arguments: {
        target: { fileKey: "file123", nodeId: "22:7" },
        imageFile: outputFile,
      },
    });
    const json = structuredToolResult(result);
    assert.equal(json.ok, true);
    assert.equal(result.content.length, 0);
    assert.equal(json.imageFile, pngOutputFile);
    assert.equal(json.file, undefined);
    assert.equal(json.outputFiles, undefined);
    assert.equal(json.nodeId, "22:7");
    assert.equal(json.toolName, undefined);
    assert.equal(json.mimeType, undefined);
    assert.equal(json.bytes, pngBytes.byteLength);
    assert.equal(json.width, 4);
    assert.equal(json.height, 3);
    assert.equal(json.thumbnail, undefined);
    assert.equal(json.upstream, undefined);
    assert.equal(json.qa, undefined);
    assertPngBuffer(await readFile(pngOutputFile));
    assert.deepEqual(calls.map((call) => call[0]), ["connect", "listTools", "callTool"]);
    await mcpClient.close();
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("figma workspace uses the stable official get_screenshot schema without overrides", async () => {
  const tempDir = await mkdtemp(resolve(tmpdir(), "figma-workspace-official-capture-"));
  const outputFile = resolve(tempDir, "official-capture.png");
  const pngBytes = await createTestPngBuffer(8, 6);
  const calls = [];
  const fakeClient = createFakeFigmaClient(
    calls,
    ({ name, args }) => {
      assert.equal(name, "get_screenshot");
      assert.deepEqual(args, { fileKey: "file123", nodeId: "22:7" });
      return {
        content: [
          {
            type: "image",
            mimeType: "image/png",
            data: pngBytes.toString("base64"),
          },
        ],
      };
    },
    {
      tools: [
        {
          name: "get_screenshot",
          description: "Official get_screenshot schema fixture.",
          inputSchema: {
            type: "object",
            properties: {
              fileKey: { type: "string" },
              nodeId: { type: "string" },
            },
            required: ["fileKey", "nodeId"],
          },
        },
      ],
    },
  );
  const { server } = createFigmaWorkspaceMcpServer({ client: fakeClient });
  const mcpClient = new Client(
    { name: "test-client", version: "0.1.0" },
    { capabilities: {} },
  );
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

  try {
    await server.connect(serverTransport);
    await mcpClient.connect(clientTransport);

    await mcpClient.callTool({
      name: "figma_workspace_open",
      arguments: {
        sessionId: "official-capture",
        file: "https://www.figma.com/design/file123/Test",
        connect: false,
      },
    });

    const result = await mcpClient.callTool({
      name: "figma_workspace_capture_node",
      arguments: {
        title: "Capture with official get_screenshot",
        sessionId: "official-capture",
        target: "22:7",
        imageFile: outputFile,
      },
    });
    const json = structuredToolResult(result);
    assert.equal(json.ok, true);
    assert.equal(json.toolName, undefined);
    assert.equal(json.nodeId, "22:7");
    assert.equal(json.imageFile, outputFile);
    assert.equal(json.mimeType, undefined);
    assert.equal(json.outputFiles, undefined);
    assertPngBuffer(await readFile(outputFile));
    assert.deepEqual(calls.map((call) => call[0]), ["connect", "listTools", "callTool"]);
    await mcpClient.close();
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("figma workspace capture node normalizes non-PNG image output paths", async () => {
  const tempDir = await mkdtemp(resolve(tmpdir(), "figma-workspace-capture-png-normalize-"));
  const outputFile = resolve(tempDir, "node.png");
  const requestedOutputFile = resolve(tempDir, "node.jpg");
  const pngBytes = await createTestPngBuffer(16, 10);
  const calls = [];
  const fakeClient = createFakeFigmaClient(
    calls,
    ({ name, args }) => {
      assert.equal(name, "get_screenshot");
      assert.deepEqual(args, { fileKey: "file123", nodeId: "22:73" });
      return {
        content: [
          {
            type: "image",
            mimeType: "image/png",
            data: pngBytes.toString("base64"),
          },
        ],
      };
    },
    {
      tools: [
        {
          name: "get_screenshot",
          description: "Official screenshot tool.",
          inputSchema: { type: "object", properties: { fileKey: { type: "string" }, nodeId: { type: "string" } }, required: ["fileKey", "nodeId"] },
        },
      ],
    },
  );
  const { server } = createFigmaWorkspaceMcpServer({ client: fakeClient });
  const mcpClient = new Client(
    { name: "test-client", version: "0.1.0" },
    { capabilities: {} },
  );
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

  try {
    await server.connect(serverTransport);
    await mcpClient.connect(clientTransport);

    const result = await mcpClient.callTool({
      name: "figma_workspace_capture_node",
      arguments: {
        title: "Capture node as PNG",
        target: { fileKey: "file123", nodeId: "22:73" },
        imageFile: requestedOutputFile,
      },
    });
    const json = structuredToolResult(result);
    assert.equal(json.ok, true);
    assert.equal(result.content.length, 0);
    assert.equal(json.imageFile, outputFile);
    assert.equal(json.mimeType, undefined);
    assert.equal(json.width, 16);
    assert.equal(json.height, 10);
    assert.equal(json.thumbnail, undefined);
    assert.equal(json.outputFiles, undefined);
    assertPngBuffer(await readFile(outputFile));
    await mcpClient.close();
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("figma workspace capture node treats text output as a failed capture", async () => {
  const tempDir = await mkdtemp(resolve(tmpdir(), "figma-workspace-capture-text-"));
  const outputFile = resolve(tempDir, "node.png");
  const calls = [];
  const fakeClient = createFakeFigmaClient(
    calls,
    ({ name, args }) => {
      assert.equal(name, "get_screenshot");
      assert.deepEqual(args, { fileKey: "file123", nodeId: "22:72" });
      return {
        content: [
          {
            type: "text",
            text: "plain capture text",
          },
        ],
      };
    },
    {
      tools: [
        {
          name: "get_screenshot",
          description: "Official screenshot tool.",
          inputSchema: { type: "object", properties: { fileKey: { type: "string" }, nodeId: { type: "string" } }, required: ["fileKey", "nodeId"] },
        },
      ],
    },
  );
  const { server } = createFigmaWorkspaceMcpServer({ client: fakeClient });
  const mcpClient = new Client(
    { name: "test-client", version: "0.1.0" },
    { capabilities: {} },
  );
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

  try {
    await server.connect(serverTransport);
    await mcpClient.connect(clientTransport);

    const result = await mcpClient.callTool({
      name: "figma_workspace_capture_node",
      arguments: {
        title: "Capture node text",
        target: { fileKey: "file123", nodeId: "22:72" },
        imageFile: outputFile,
      },
    });
    const json = structuredToolResult(result);
    assert.equal(result.content.length, 0);
    assert.equal(json.ok, false);
    assert.equal(json.imageFile, undefined);
    assert.equal(json.kind, undefined);
    assert.equal(json.mimeType, undefined);
    assert.equal(json.thumbnail, undefined);
    assert.match(json.upstreamError.message, /did not return an image\/png payload/);
    await assert.rejects(
      readFile(outputFile),
      /ENOENT/,
    );
    await mcpClient.close();
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("figma workspace capture node reports upstreamError on upstream failure", async () => {
  const tempDir = await mkdtemp(resolve(tmpdir(), "figma-workspace-capture-failure-"));
  const outputFile = resolve(tempDir, "node.png");
  const calls = [];
  const fakeClient = createFakeFigmaClient(
    calls,
    ({ name, args }) => {
      assert.equal(name, "get_screenshot");
      assert.deepEqual(args, { fileKey: "file123", nodeId: "22:70" });
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              ok: false,
              error: {
                code: "CAPTURE_FAILED",
                message: "Capture failed before writing.",
              },
            }),
          },
        ],
      };
    },
    {
      tools: [
        {
          name: "get_screenshot",
          description: "Official screenshot tool.",
          inputSchema: { type: "object", properties: { fileKey: { type: "string" }, nodeId: { type: "string" } }, required: ["fileKey", "nodeId"] },
        },
      ],
    },
  );
  const { server } = createFigmaWorkspaceMcpServer({ client: fakeClient });
  const mcpClient = new Client(
    { name: "test-client", version: "0.1.0" },
    { capabilities: {} },
  );
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

  try {
    await server.connect(serverTransport);
    await mcpClient.connect(clientTransport);

    const result = await mcpClient.callTool({
      name: "figma_workspace_capture_node",
      arguments: {
        title: "Capture node failure",
        target: { fileKey: "file123", nodeId: "22:70" },
        imageFile: outputFile,
      },
    });
    const json = structuredToolResult(result);
    assert.equal(json.ok, false);
    assert.equal(json.imageFile, undefined);
    assert.equal(json.plannedOutputFile, undefined);
    assert.equal(json.file, undefined);
    assert.equal(json.upstream, undefined);
    assert.equal(json.upstreamError.code, "CAPTURE_FAILED");
    assert.match(json.upstreamError.message, /Capture failed/);
    assert.equal(json.upstreamError.text, undefined);
    assert.equal(json.upstreamError.parsed, undefined);
    assert.equal(json.outputFiles, undefined);
    await assert.rejects(
      readFile(outputFile, "utf8"),
      /ENOENT/,
    );
    assert.deepEqual(calls.map((call) => call[0]), ["connect", "listTools", "callTool"]);
    await mcpClient.close();
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("figma workspace downloads node screenshot URL responses to a local file", async () => {
  const tempDir = await mkdtemp(resolve(tmpdir(), "figma-workspace-capture-url-"));
  const outputFile = resolve(tempDir, "node.png");
  const calls = [];
  const fetches = [];
  const pngBytes = await createTestPngBuffer(5, 4);
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    fetches.push(url);
    return {
      ok: true,
      status: 200,
      statusText: "OK",
      headers: {
        get(name) {
          return name.toLowerCase() === "content-type" ? "image/png" : null;
        },
      },
      async arrayBuffer() {
        return pngBytes;
      },
    };
  };
  const fakeClient = createFakeFigmaClient(
    calls,
    ({ name, args }) => {
      assert.equal(name, "get_screenshot");
      assert.deepEqual(args, { fileKey: "file123", nodeId: "22:8" });
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              ok: true,
              result: {
                screenshotUrl: "https://example.test/capture.png",
              },
            }),
          },
        ],
      };
    },
    {
      tools: [
        {
          name: "get_screenshot",
          description: "Official screenshot tool.",
          inputSchema: { type: "object", properties: { fileKey: { type: "string" }, nodeId: { type: "string" } }, required: ["fileKey", "nodeId"] },
        },
      ],
    },
  );
  const { server } = createFigmaWorkspaceMcpServer({ client: fakeClient });
  const mcpClient = new Client(
    { name: "test-client", version: "0.1.0" },
    { capabilities: {} },
  );
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

  try {
    await server.connect(serverTransport);
    await mcpClient.connect(clientTransport);

    const result = await mcpClient.callTool({
      name: "figma_workspace_capture_node",
      arguments: {
        title: "Capture node",
        target: { fileKey: "file123", nodeId: "22:8" },
        imageFile: outputFile,
      },
    });
    const json = structuredToolResult(result);
    assert.equal(json.ok, true);
    assert.equal(json.imageFile, outputFile);
    assert.equal(json.file, undefined);
    assert.equal(json.outputFiles, undefined);
    assert.equal(json.nodeId, "22:8");
    assert.equal(json.kind, undefined);
    assert.equal(json.mimeType, undefined);
    assert.equal(json.bytes, pngBytes.byteLength);
    assert.equal(json.width, 5);
    assert.equal(json.height, 4);
    assert.equal(json.sourceUrl, undefined);
    assertPngBuffer(await readFile(outputFile));
    assert.equal(json.qa, undefined);
    assert.deepEqual(fetches, ["https://example.test/capture.png"]);
    assert.deepEqual(calls.map((call) => call[0]), ["connect", "listTools", "callTool"]);
    await mcpClient.close();
  } finally {
    globalThis.fetch = originalFetch;
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("figma workspace capture node requires official get_screenshot", async () => {
  const calls = [];
  const fakeClient = createFakeFigmaClient(
    calls,
    () => {
      throw new Error("unexpected upstream call");
    },
    {
      tools: [
        {
          name: "capture_node_screenshot",
          description: "Legacy screenshot-like tool.",
          inputSchema: {
            type: "object",
            properties: {
              nodeId: { type: "string" },
            },
          },
        },
      ],
    },
  );
  const { server } = createFigmaWorkspaceMcpServer({ client: fakeClient });
  const mcpClient = new Client(
    { name: "test-client", version: "0.1.0" },
    { capabilities: {} },
  );
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

  await server.connect(serverTransport);
  await mcpClient.connect(clientTransport);
  await assert.rejects(
    mcpClient.callTool({
      name: "figma_workspace_capture_node",
      arguments: {
        title: "Capture node",
        target: { fileKey: "file123", nodeId: "22:9" },
      },
    }),
    /Required official upstream Figma MCP node screenshot tool "get_screenshot" was not found/,
  );
  assert.deepEqual(calls.map((call) => call[0]), ["connect", "listTools"]);
  await mcpClient.close();
});

test("figma workspace capture node rejects drifted get_screenshot schema", async () => {
  const calls = [];
  const fakeClient = createFakeFigmaClient(
    calls,
    () => {
      throw new Error("unexpected upstream call");
    },
    {
      tools: [
        {
          name: "get_screenshot",
          description: "Drifted screenshot tool.",
          inputSchema: {
            type: "object",
            properties: {
              nodeId: { type: "string" },
            },
          },
        },
      ],
    },
  );
  const { server } = createFigmaWorkspaceMcpServer({ client: fakeClient });
  const mcpClient = new Client(
    { name: "test-client", version: "0.1.0" },
    { capabilities: {} },
  );
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

  await server.connect(serverTransport);
  await mcpClient.connect(clientTransport);
  await assert.rejects(
    mcpClient.callTool({
      name: "figma_workspace_capture_node",
      arguments: {
        title: "Capture drifted schema",
        target: { fileKey: "file123", nodeId: "22:9" },
      },
    }),
    /inputSchema\.properties\.fileKey.*upstream contract drift/,
  );
  assert.deepEqual(calls.map((call) => call[0]), ["connect", "listTools"]);
  await mcpClient.close();
});

test("figma workspace task plans run steps in order and stop on failure by default", async () => {
  const tempDir = await mkdtemp(resolve(tmpdir(), "figma-workspace-plan-"));
  const previousTaskRoot = process.env.FIGMA_WORKSPACE_TASK_ROOT;
  process.env.FIGMA_WORKSPACE_TASK_ROOT = tempDir;
  const scriptPath = resolve(tempDir, "script.figma.js");
  await writeFile(scriptPath, "return { summary: 'script executed' };", "utf8");
  const calls = [];
  const fakeClient = createFakeFigmaClient(
    calls,
    ({ name, args }) => {
      if (name === "use_figma") {
        assert.match(args.code, /script executed/);
        return {
          content: [{ type: "text", text: JSON.stringify({ result: { summary: "script executed" } }) }],
        };
      }
      if (name === "fake_upstream_ok") {
        assert.deepEqual(args, { marker: "ok" });
        return {
          content: [{ type: "text", text: JSON.stringify({ ok: true, result: { summary: "ok" } }) }],
        };
      }
      if (name === "fake_upstream_fail") {
        assert.deepEqual(args, { marker: "fail" });
        return {
          content: [{ type: "text", text: JSON.stringify({ ok: false, error: { message: "planned failure" } }) }],
        };
      }
      throw new Error(`unexpected tool ${name}`);
    },
    {
      tools: [
        { name: "use_figma", inputSchema: { type: "object", properties: { code: { type: "string" } }, required: ["code"] } },
        { name: "fake_upstream_ok", inputSchema: { type: "object", properties: {} } },
        { name: "fake_upstream_fail", inputSchema: { type: "object", properties: {} } },
        { name: "fake_after_stop", inputSchema: { type: "object", properties: {} } },
      ],
    },
  );
  const { server } = createFigmaWorkspaceMcpServer({ client: fakeClient });
  const mcpClient = new Client(
    { name: "test-client", version: "0.1.0" },
    { capabilities: {} },
  );
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

  try {
    await server.connect(serverTransport);
    await mcpClient.connect(clientTransport);

    const result = await mcpClient.callTool({
      name: "figma_workspace_run_task_plan",
      arguments: {
        title: "Run plan",
        steps: [
          {
            id: "script",
            type: "figma_workspace_run_script_file",
            args: {
              scriptPath,
            },
          },
          {
            id: "upstream-ok",
            type: "upstream",
            args: {
              toolName: "fake_upstream_ok",
              arguments: { marker: "ok" },
            },
          },
          {
            id: "upstream-fail",
            type: "figma_workspace_call_upstream_tool",
            args: {
              toolName: "fake_upstream_fail",
              arguments: { marker: "fail" },
            },
          },
          {
            id: "after-stop",
            type: "upstream-tool",
            args: {
              toolName: "fake_after_stop",
              arguments: {},
            },
          },
        ],
      },
    });
    const json = structuredToolResult(result);
    assert.equal(json.ok, false);
    assert.equal(json.stopped, true);
    assert.equal(json.stopOnFailure, undefined);
    assert.deepEqual(json.steps.map((step) => step.id), ["script", "upstream-ok", "upstream-fail"]);
    assert.deepEqual(json.steps.map((step) => step.status), ["completed", "completed", "failed"]);
    assert.equal(json.steps[1].summary.toolName, undefined);
    assert.equal(json.steps[1].summary.upstreamTool, undefined);
    assert.equal(json.steps[2].summary.toolName, undefined);
    assert.equal(json.steps[2].summary.upstreamTool, undefined);
    assert.equal(json.failures.length, 1);
    assert.deepEqual(
      Object.keys(json.failures[0]).sort(),
      ["id", "index", "status", "type"],
    );
    assert.deepEqual(json.failures[0], { id: "upstream-fail", index: 2, type: "upstream-tool", status: "failed" });
    assertFilePointer(json.outputFiles.debugFile, json.outputFiles.debugFile.path);
    assert.match(json.outputFiles.debugFile.path, /task-plan-results.*task-plan.*task-plan\.plan\.result\.json$/u);
    const fileJson = await readPrettyJsonPointer(json.outputFiles.debugFile, json.outputFiles.debugFile.path);
    assert.equal(fileJson.stopOnFailure, undefined);
    assert.equal(fileJson.kind, "figma_workspace_result");
    assert.equal(fileJson.tool, "figma_workspace_run_task_plan");
    assert.equal(fileJson.sessionId, "default");
    assert.equal(fileJson.ok, false);
    assert.equal(fileJson.stopped, true);
    assert.equal(fileJson.stepCount, 3);
    assert.equal(fileJson.failureCount, 1);
    assert.equal(fileJson.session, undefined);
    assert.equal(fileJson.steps, undefined);
    assert.equal(fileJson.outputReferences, undefined);
    assert.equal(fileJson.outputFiles, undefined);
    assert.deepEqual(fileJson.stepDetails.map((step) => step.id), ["script", "upstream-ok", "upstream-fail"]);
    assert.deepEqual(
      calls.filter((call) => call[0] === "callTool").map((call) => call[1]),
      ["use_figma", "fake_upstream_ok", "fake_upstream_fail"],
    );
    await mcpClient.close();
  } finally {
    if (previousTaskRoot === undefined) {
      delete process.env.FIGMA_WORKSPACE_TASK_ROOT;
    } else {
      process.env.FIGMA_WORKSPACE_TASK_ROOT = previousTaskRoot;
    }
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("figma workspace task plans route download_assets aliases with workspace defaults", async () => {
  const tempDir = await mkdtemp(resolve(tmpdir(), "figma-workspace-plan-download-"));
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(Buffer.from("downloaded"), { status: 200, headers: { "Content-Type": "image/png" } });
  const calls = [];
  const fakeClient = createFakeFigmaClient(
    calls,
    ({ name, args }) => {
      if (name === "fake_upstream_check") {
        assert.deepEqual(args, {
          dir: resolve(tempDir, "download-step.downloads"),
        });
        return {
          content: [{ type: "text", text: JSON.stringify({ ok: true, result: { checked: true } }) }],
        };
      }
      assert.equal(name, "download_assets");
      assert.deepEqual(args, {
        fileKey: "file123",
        nodeId: "22:8",
        defaultFormat: "png",
      });
      return {
        content: [{ type: "text", text: JSON.stringify({ exports: [{ url: "https://assets.example/plan.png", format: "png" }] }) }],
      };
    },
    {
      tools: [
        {
          name: "download_assets",
          inputSchema: {
            type: "object",
            properties: {
              fileKey: { type: "string" },
              nodeId: { type: "string" },
              defaultFormat: { type: "string" },
              defaultScale: { type: "number" },
            },
          },
        },
        { name: "fake_upstream_check", inputSchema: { type: "object", properties: {} } },
      ],
    },
  );
  const { server } = createFigmaWorkspaceMcpServer({ client: fakeClient });
  const mcpClient = new Client(
    { name: "test-client", version: "0.1.0" },
    { capabilities: {} },
  );
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

  try {
    await server.connect(serverTransport);
    await mcpClient.connect(clientTransport);
    const prepared = await mcpClient.callTool({
      name: "figma_workspace_prepare_task",
      arguments: {
        title: "Prepare download plan",
        sessionId: "download-plan",
        workspaceDir: tempDir,
        file: "https://www.figma.com/design/file123/Test",
        taskName: "download-assets",
        overwrite: true,
      },
    });
    const preparedJson = structuredToolResult(prepared);
    const planPath = resolve(tempDir, "download-plan.json");
    const planOutputFile = resolve(tempDir, "download-plan.result.json");
    await writeFile(
      planPath,
      JSON.stringify({
        steps: [
          {
            id: "download-step",
            type: "download_assets",
            args: {
              targets: [{ target: "22:8", name: "Hero", defaultFormat: "png" }],
            },
          },
          {
            id: "check-step",
            type: "upstream-tool",
            args: {
              toolName: "fake_upstream_check",
              arguments: {
                dir: "{{steps.download-step.downloadOutputDir}}",
              },
            },
          },
        ],
      }),
      "utf8",
    );

    const result = await mcpClient.callTool({
      name: "figma_workspace_run_task_plan",
      arguments: {
        title: "Run download plan",
        sessionId: "download-plan",
        planPath,
      },
    });
    const json = structuredToolResult(result);
    assert.equal(json.ok, true);
    assert.equal(json.steps[0].type, "download-assets");
    assert.equal(json.steps[1].type, "upstream-tool");
    assert.equal(json.steps[0].summary.files, undefined);
    assert.equal(json.steps[0].summary.toolName, undefined);
    assert.equal(json.steps[0].summary.upstreamTool, undefined);
    assert.equal(json.steps[1].summary.toolName, undefined);
    assert.equal(json.steps[1].summary.upstreamTool, undefined);
    assert.equal(json.outputReferences, undefined);
    assertFilePointer(json.outputFiles.debugFile, planOutputFile);
    assert.deepEqual(
      await readFile(resolve(tempDir, "download-step.downloads", "hero", "exported.png")),
      Buffer.from("downloaded"),
    );
    assert.equal(preparedJson.session.fileKey, "file123");
    await mcpClient.close();
  } finally {
    globalThis.fetch = originalFetch;
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("figma workspace task plans resolve workspace-relative step files consistently", async () => {
  const tempDir = await mkdtemp(resolve(tmpdir(), "figma-workspace-plan-workspace-"));
  const capturePngBytes = await createTestPngBuffer();
  const calls = [];
  const fakeClient = createFakeFigmaClient(
    calls,
    ({ name, args }) => {
      if (name === "use_figma") {
        assert.equal(typeof args.code, "string");
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                ok: true,
                __figmaRepl: { sessionId: "workspace-plan", handles: {} },
                result: {
                  createdNodeId: "10:1",
                  assetTargets: { central: "11:22" },
                  captureTarget: "11:22",
                },
              }),
            },
          ],
        };
      }
      if (name === "upload_assets") {
        assert.deepEqual(args, {
          fileKey: "file123",
          count: 1,
          nodeId: "11:22",
          scaleMode: "FILL",
        });
        return {
          content: [{ type: "text", text: JSON.stringify({ ok: true, placedOnNodeId: args.nodeId }) }],
        };
      }
      if (name === "get_screenshot") {
        assert.deepEqual(args, { fileKey: "file123", nodeId: "11:22" });
        return {
          content: [
            {
              type: "image",
              mimeType: "image/png",
              data: capturePngBytes.toString("base64"),
            },
          ],
        };
      }
      if (name === "fake_reference") {
        assert.equal(args.assetTarget, "11:22");
        assert.match(args.captureImage, /capture\.png$/u);
        return {
          content: [{ type: "text", text: JSON.stringify({ ok: true, result: { summary: "referenced outputs" } }) }],
        };
      }
      throw new Error(`unexpected tool ${name}`);
    },
    {
      tools: [
        { name: "upload_assets", inputSchema: { type: "object", properties: { fileKey: { type: "string" }, count: { type: "number" }, nodeId: { type: "string" }, scaleMode: { type: "string" } } } },
        { name: "get_screenshot", inputSchema: { type: "object", properties: { fileKey: { type: "string" }, nodeId: { type: "string" } }, required: ["fileKey", "nodeId"] } },
        { name: "fake_reference", inputSchema: { type: "object", properties: {} } },
        { name: "use_figma", inputSchema: { type: "object", properties: { code: { type: "string" } } } },
      ],
    },
  );
  const { server } = createFigmaWorkspaceMcpServer({ client: fakeClient });
  const mcpClient = new Client(
    { name: "test-client", version: "0.1.0" },
    { capabilities: {} },
  );
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

  try {
    await server.connect(serverTransport);
    await mcpClient.connect(clientTransport);

    const initResult = await mcpClient.callTool({
      name: "figma_workspace_prepare_task",
      arguments: {
        title: "Initialize workspace",
        sessionId: "workspace-plan",
        cwd: tempDir,
        file: "file123",
        taskName: "workspace-plan",
        surface: "design",
        overwrite: true,
      },
    });
    const initJson = structuredToolResult(initResult);
    const fileDir = initJson.task.workspace.fileDir;
    await writeFile(resolve(fileDir, "workspace-plan.figma.js"), "return { summary: 'dry run' };", "utf8");
    await writeFile(resolve(fileDir, "asset.png"), "asset bytes", "utf8");

    const result = await mcpClient.callTool({
      name: "figma_workspace_run_task_plan",
      arguments: {
        title: "Run workspace plan",
        sessionId: "workspace-plan",
        steps: [
          {
            id: "script",
            type: "script-file",
            args: {
              inputFile: "workspace-plan.figma.js",
            },
          },
          {
            id: "asset",
            type: "asset-manifest",
            args: {
              assets: [{ path: "asset.png", target: "{{steps.script.upstream.result.assetTargets.central}}" }],
            },
          },
          {
            id: "capture",
            type: "screenshot-capture",
            args: {
              target: "{{steps.script.upstream.result.captureTarget}}",
            },
          },
          {
            id: "reference",
            type: "upstream-tool",
            args: {
              toolName: "fake_reference",
              arguments: {
                assetTarget: "{{steps.script.upstream.result.assetTargets.central}}",
                captureImage: "{{steps.capture.imageFile}}",
              },
            },
          },
        ],
      },
    });
    const json = structuredToolResult(result);
    assert.equal(json.ok, true);
    assertFilePointer(json.outputFiles.debugFile, resolve(fileDir, "task-plan.plan.result.json"));
    const planFile = await readPrettyJsonPointer(json.outputFiles.debugFile, resolve(fileDir, "task-plan.plan.result.json"));
    assert.equal(json.stopOnFailure, undefined);
    assert.equal(planFile.stopOnFailure, undefined);
    assert.equal(planFile.outputFiles, undefined);
    assert.equal(planFile.kind, "figma_workspace_result");
    assert.equal(planFile.tool, "figma_workspace_run_task_plan");
    assert.equal(planFile.sessionId, "workspace-plan");
    assert.equal(planFile.stepCount, 4);
    assert.equal(planFile.failureCount, 0);
    assert.equal(planFile.session, undefined);
    assert.equal(planFile.steps, undefined);
    assert.equal(planFile.outputReferences, undefined);
    assert.deepEqual(planFile.stepDetails.map((step) => step.id), ["script", "asset", "capture", "reference"]);
    assert.deepEqual(json.steps.map((step) => step.status), ["completed", "completed", "completed", "completed"]);
    assert.equal(json.outputReferences.asset, undefined);
    assert.match(json.outputReferences.capture.imageFile, /capture\.png$/u);
    assertPngBuffer(await readFile(resolve(fileDir, "capture.png")));
    await mcpClient.close();
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("figma workspace lookup kind=docs returns capped local reference snippets", async () => {
  const calls = [];
  const { server } = createFigmaWorkspaceMcpServer({
    client: createFakeFigmaClient(calls, () => {
      throw new Error("unexpected upstream call");
    }),
  });
  const mcpClient = new Client(
    { name: "test-client", version: "0.1.0" },
    { capabilities: {} },
  );
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

  await server.connect(serverTransport);
  await mcpClient.connect(clientTransport);

  const result = await mcpClient.callTool({
    name: "figma_workspace_lookup",
    arguments: {
      title: "Search docs",
      kind: "docs",
      query: "component properties",
      maxResults: 2,
      maxSnippetLines: 2,
    },
  });
  const json = structuredToolResult(result);
  assert.equal(json.ok, true);
  assert.equal(json.kind, undefined);
  assert.equal(json.query, undefined);
  assert.equal(json.symbol, undefined);
  assert.equal(json.maxResults, undefined);
  assert.equal(json.maxSnippetLines, undefined);
  assert.equal(json.results.length <= 2, true);
  assert.ok(json.results.length > 0);
  for (const item of json.results) {
    assert.equal(typeof item.sourceId, "string");
    assert.match(item.sourceId, /^internal:/);
    assert.equal(typeof item.lineStart, "number");
    assert.ok(["exact-symbol", "phrase", "token"].includes(item.matchType));
    assert.ok(["high", "medium", "low"].includes(item.confidence));
    assert.equal(typeof item.score, "number");
    assert.equal(item.snippet.split("\n").length <= 2, true);
    assert.equal("file" in item, false);
  }
  assert.match(json.guidance, /BM25-ranked chunks/);

  const motionResult = await mcpClient.callTool({
    name: "figma_workspace_lookup",
    arguments: {
      title: "Search motion docs",
      kind: "docs",
      query: "motion easing",
      maxResults: 3,
      maxSnippetLines: 3,
    },
  });
  const motionJson = structuredToolResult(motionResult);
  assert.equal(motionJson.ok, true);
  assert.ok(motionJson.results.some((item) => item.sourceId.includes("motion")));
  assert.match(JSON.stringify(motionJson.results), /motion|easing/iu);

  const bridgeQueries = [
    ["guidanceRef", /guidanceRef\.query/u],
    ["wrapper profiles", /wrapperProfiles/u],
    ["helper profiles", /helperProfiles/u],
    ["workflow graph", /workflowGraph/u],
  ];
  for (const [query, expectedSnippet] of bridgeQueries) {
    const bridgeResult = await mcpClient.callTool({
      name: "figma_workspace_lookup",
      arguments: {
        title: `Search bridge docs ${query}`,
        kind: "docs",
        query,
        maxResults: 2,
        maxSnippetLines: 3,
      },
    });
    const bridgeJson = structuredToolResult(bridgeResult);
    assert.equal(bridgeJson.ok, true);
    assert.ok(bridgeJson.results.some((item) => item.sourceId.startsWith("internal:bridge/")));
    assert.match(JSON.stringify(bridgeJson.results), expectedSnippet);
    assert.equal(bridgeJson.results.some((item) => "file" in item), false);
  }
  assert.deepEqual(calls.map((call) => call[0]), []);
  await mcpClient.close();
});

test("figma workspace lookup kind=api returns BM25-ranked Plugin API chunks without dumping d.ts", async () => {
  const calls = [];
  const { server } = createFigmaWorkspaceMcpServer({
    client: createFakeFigmaClient(calls, () => {
      throw new Error("unexpected upstream call");
    }),
  });
  const mcpClient = new Client(
    { name: "test-client", version: "0.1.0" },
    { capabilities: {} },
  );
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

  await server.connect(serverTransport);
  await mcpClient.connect(clientTransport);

  const result = await mcpClient.callTool({
    name: "figma_workspace_lookup",
    arguments: {
      title: "Lookup createFrame",
      kind: "api",
      symbol: "createFrame",
      maxResults: 4,
      maxSnippetLines: 4,
    },
  });
  const json = structuredToolResult(result);
  assert.equal(json.ok, true);
  assert.equal(json.kind, undefined);
  assert.equal(json.query, undefined);
  assert.equal(json.symbol, undefined);
  assert.equal(json.maxResults, undefined);
  assert.equal(json.maxSnippetLines, undefined);
  assert.ok(json.results.length > 0);
  assert.equal(json.results.length <= 4, true);
  assert.match(json.guidance, /Bundled corpus files are not returned as documents/);
  assert.equal(json.results[0].matchType, "exact-symbol");
  assert.equal(json.results[0].confidence, "high");
  assert.equal(typeof json.results[0].chunkTitle, "string");
  assert.equal(
    json.results.every((item) => item.snippet.length < 2400 && item.snippet.split("\n").length <= 4),
    true,
  );
  assert.match(JSON.stringify(json.results), /createFrame/);
  assert.deepEqual(calls.map((call) => call[0]), []);
  await mcpClient.close();
});

test("figma workspace diagnostics return stable codes and strict promotes warnings", async () => {
  assert.deepEqual(
    diagnoseFigmaWorkspaceCode(
      [
        "const text = \"eval('1'); fetch('/'); import('x'); node.remove(); figma.createImage(bytes); node.characters = 'Hello'; await $.checkpoint('$root');\";",
        `const inlineAsset = "await $.imageAsset({ base64: '${"A".repeat(100_000)}' });";`,
        "// figma.root.findAll(() => true); figma.currentPage.selection = [node]; node.name = 'Primary'; figma.createSticky();",
      ].join("\n"),
      { mode: "read", expectedSurface: "design" },
    ).map((item) => item.code),
    [],
  );
  assert.deepEqual(
    diagnoseFigmaWorkspaceCode("const = ;").map((item) => item.code),
    ["FIGMA_WORKSPACE_PARSE_ERROR"],
  );
  const parseDiagnostics = diagnoseFigmaWorkspaceCode([
    '"use strict";',
    'with (obj) {}',
    'let x; let x;',
  ].join("\n"));
  assert.deepEqual(
    parseDiagnostics.map((item) => item.code),
    ["FIGMA_WORKSPACE_PARSE_ERROR", "FIGMA_WORKSPACE_PARSE_ERROR"],
  );
  assert.deepEqual(
    diagnoseFigmaWorkspaceCode("figma.currentPage = page;").map((item) => item.code),
    ["FIGMA_WORKSPACE_CURRENT_PAGE_ASSIGNMENT"],
  );
  assert.deepEqual(
    diagnoseFigmaWorkspaceCode("figma.root.findAll(() => true);").map((item) => item.code),
    ["FIGMA_WORKSPACE_ROOT_FIND_ALL"],
  );
  assert.deepEqual(
    diagnoseFigmaWorkspaceCode("node.characters = 'Hello';").map((item) => item.code),
    ["FIGMA_WORKSPACE_TEXT_MUTATION_NEEDS_FONT"],
  );
  assert.deepEqual(
    diagnoseFigmaWorkspaceCode("figma.currentPage.selection = [node];").map((item) => item.code),
    ["FIGMA_WORKSPACE_DIRECT_SELECTION_ACCESS"],
  );
  assert.match(
    diagnoseFigmaWorkspaceCode("node.remove();")[0].suggestion,
    /\$\.cloneNodeTree/,
  );
  assert.match(
    diagnoseFigmaWorkspaceCode("figma.createImage(bytes);")[0].suggestion,
    /\$\.imageAsset/,
  );
  assert.deepEqual(
    diagnoseFigmaWorkspaceCode("eval('1'); fetch('/'); import('x'); delete figma.currentPage; node.detachInstance();").map((item) => item.code),
    [
      "FIGMA_WORKSPACE_DYNAMIC_EVAL",
      "FIGMA_WORKSPACE_NETWORK_ACCESS",
      "FIGMA_WORKSPACE_DYNAMIC_IMPORT",
      "FIGMA_WORKSPACE_FIGMA_DELETE",
      "FIGMA_WORKSPACE_DESTRUCTIVE_OPERATION",
    ],
  );
  assert.deepEqual(
    diagnoseFigmaWorkspaceCode("figma.createSticky();", { expectedSurface: "design" }).map((item) => item.code),
    ["FIGMA_WORKSPACE_SURFACE_FIGJAM_API_IN_DESIGN"],
  );
  assert.deepEqual(
    diagnoseFigmaWorkspaceCode("await $.imageAsset({ base64: 'AQIDBA==' });").map((item) => item.code),
    [],
  );
  assert.deepEqual(
    diagnoseFigmaWorkspaceCode(`await $.imageAsset({ base64: '${"A".repeat(100_000)}' });`, { strict: true }).map((item) => item.code),
    ["FIGMA_WORKSPACE_IMAGE_ASSET_INLINE_TOO_LARGE"],
  );
  assert.deepEqual(
    diagnoseFigmaWorkspaceCode(`await $.imageAsset({ base64: '${"A".repeat(100_000)}' });`, { strict: true }).map((item) => item.severity),
    ["fatal"],
  );
  assert.deepEqual(
    diagnoseFigmaWorkspaceCode(`await $.imageAsset({ ["base64"]: \`${"A".repeat(100_000)}\` });`).map((item) => item.code),
    ["FIGMA_WORKSPACE_IMAGE_ASSET_INLINE_TOO_LARGE"],
  );
  assert.deepEqual(
    diagnoseFigmaWorkspaceCode("await $.checkpoint('$root', { depth: 1 });", { strict: true }).map((item) => item.code),
    ["FIGMA_WORKSPACE_CHECKPOINT_HANDLE_AS_NAME"],
  );
  assert.deepEqual(
    diagnoseFigmaWorkspaceCode("node.characters = 'Hello';", { strict: true }).map((item) => item.severity),
    ["fatal"],
  );
  assert.deepEqual(
    diagnoseFigmaWorkspaceCode("node.remove();", { allowDangerousOperations: true }).map((item) => item.code),
    [],
  );
  assert.deepEqual(
    diagnoseFigmaWorkspaceCode(
      "eval('1'); fetch('/'); import('x'); node.remove(); node.detachInstance();",
      { allowDangerousOperations: true },
    ).map((item) => item.code),
    [],
  );
  assert.deepEqual(
    diagnoseFigmaWorkspaceCode(
      `eval('1'); fetch('/'); import('x'); node.remove(); node.detachInstance(); figma.createImage(bytes); await $.imageAsset({ base64: '${"A".repeat(100_000)}' });`,
      { allowDangerousOperations: true },
    ).map((item) => item.code),
    ["FIGMA_WORKSPACE_IMAGE_CREATION", "FIGMA_WORKSPACE_IMAGE_ASSET_INLINE_TOO_LARGE"],
  );
  assert.deepEqual(
    diagnoseFigmaWorkspaceCode("node.remove(); node.detachInstance(); figma.currentPage.selection;", { generatedCode: true }).map((item) => item.code),
    ["FIGMA_WORKSPACE_DESTRUCTIVE_OPERATION"],
  );
  assert.deepEqual(
    diagnoseFigmaWorkspaceCode(
      "return figma.currentPage.findAll(() => true).filter((node) => node.name === 'Primary' && node.layoutMode === 'VERTICAL').map((node) => ({ id: node.id, name: node.name, layoutMode: node.layoutMode, fills: node.fills }));",
      { mode: "read" },
    ).map((item) => item.code),
    [],
  );
  assert.deepEqual(
    diagnoseFigmaWorkspaceCode("node.name = 'Primary';", { mode: "read" }).map((item) => item.code),
    ["FIGMA_WORKSPACE_READ_MODE_ASSIGNMENT"],
  );
  assert.deepEqual(
    diagnoseFigmaWorkspaceCode("node.paddingLeft += 8;", { mode: "read" }).map((item) => item.code),
    ["FIGMA_WORKSPACE_READ_MODE_ASSIGNMENT"],
  );
  assert.deepEqual(
    diagnoseFigmaWorkspaceCode("node['paddingLeft']++;", { mode: "read" }).map((item) => item.code),
    ["FIGMA_WORKSPACE_READ_MODE_ASSIGNMENT"],
  );
  const diagnosticHints = diagnoseFigmaWorkspaceCode(
    "figma.currentPage = page; figma.root.findAll(() => true); figma.currentPage.selection = [node]; node.characters = 'Hello'; eval('1'); figma.createImage(bytes);",
    { strict: true },
  ).map((item) => item.docsHint);
  assert.ok(diagnosticHints.length > 0);
  assert.ok(diagnosticHints.every((hint) => !hint.includes("figma-workspace://capabilities#")));
});

test("figma workspace run_script_file returns preflight diagnostics without upstream execution", async () => {
  const tempDir = await mkdtemp(resolve(tmpdir(), "figma-workspace-script-"));
  const scriptName = "script.figma.js";
  const calls = [];
  const { server } = createFigmaWorkspaceMcpServer({
    client: createFakeFigmaClient(calls, () => {
      throw new Error("unexpected upstream call");
    }),
  });
  const mcpClient = new Client(
    { name: "test-client", version: "0.1.0" },
    { capabilities: {} },
  );
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

  try {
    await server.connect(serverTransport);
    await mcpClient.connect(clientTransport);
    const fileDir = await openTestWorkspace(mcpClient, { tempDir, sessionId: "main" });
    const scriptPath = resolve(fileDir, scriptName);
    await writeFile(
      scriptPath,
      [
        "const title = await $.text({ parent: '$currentPage', as: '$title', text: 'Draft' });",
        "title.characters = 'Published';",
        "return await $.checkpoint('text-updated', ['$title']);",
      ].join("\n"),
      "utf8",
    );

    const result = await mcpClient.callTool({
      name: "figma_workspace_run_script_file",
      arguments: {
        title: "Preview script",
        sessionId: "main",
        inputFile: scriptName,
        strict: true,
        surface: "design",
        inlineResultLimit: 10_000,
      },
    });
    const json = structuredToolResult(result);
    assert.equal(json.ok, false);
    assert.equal(json.phase, "preflight");
    assert.equal(json.executed, false);
    assert.equal(json.script.scriptPath, scriptPath);
    assert.equal(json.script.sourceLineCount, undefined);
    assert.equal(json.script.sourceBytes, undefined);
    assert.equal(json.script.helperApiVersion, undefined);
    assert.equal(json.script.diagnosticsCount, undefined);
    assert.equal(json.script.executed, undefined);
    assert.equal(json.compiledScript, undefined);
    assert.equal(json.diagnostics[0].code, "FIGMA_WORKSPACE_TEXT_MUTATION_NEEDS_FONT");
    assert.equal(json.diagnostics[0].source.scriptPath, scriptPath);
    assert.equal(json.diagnostics[0].source.line, 2);
    assert.equal(json.diagnostics[0].source.column, 1);
    assert.equal(json.primaryFix, undefined);
    assert.equal(json.repairPlan.status, "blocked");
    assert.equal(json.repairPlan.steps.length, 1);
    assert.equal(json.repairPlan.steps[0].code, "FIGMA_WORKSPACE_TEXT_MUTATION_NEEDS_FONT");
    assert.deepEqual(json.repairPlan.steps[0].occurrences, [{
      scriptPath,
      line: 2,
      column: 1,
      label: "2:1",
    }]);
    const resultFile = await readPrettyJsonPointer(json.outputFiles.debugFile, resolve(fileDir, "script.result.json"));
    assert.equal(resultFile.phase, "preflight");
    assert.equal(resultFile.executed, false);
    assert.equal(resultFile.script.diagnosticsCount, undefined);
    assert.equal(resultFile.script.executed, undefined);
    assert.equal(resultFile.diagnosticsCount, 1);
    assert.equal(resultFile.diagnostics[0].source.column, 1);
    assert.equal(resultFile.primaryFix, undefined);
    assert.equal(resultFile.repairPlan.status, "blocked");
    assert.equal(resultFile.repairPlan.steps[0].occurrences[0].label, "2:1");
    assert.equal(resultFile.compiledScript, undefined);
    assert.equal(resultFile.raw, undefined);
    assert.equal(json.outputFiles.compiledScriptFile, undefined);
    assert.equal(json.outputFiles.diagnosticsFile, undefined);
    assert.equal(json.outputFiles.summaryFile, undefined);
    assert.deepEqual(calls.map((call) => call[0]), []);
    await mcpClient.close();
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("figma workspace run_script_file returns all recoverable parse errors without guardrail scan", async () => {
  const tempDir = await mkdtemp(resolve(tmpdir(), "figma-workspace-parse-plan-"));
  const scriptName = "parse-errors.figma.js";
  const calls = [];
  const { server } = createFigmaWorkspaceMcpServer({
    client: createFakeFigmaClient(calls, () => {
      throw new Error("unexpected upstream call");
    }),
  });
  const mcpClient = new Client(
    { name: "test-client", version: "0.1.0" },
    { capabilities: {} },
  );
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

  try {
    await server.connect(serverTransport);
    await mcpClient.connect(clientTransport);
    const fileDir = await openTestWorkspace(mcpClient, { tempDir, sessionId: "parse" });
    const scriptPath = resolve(fileDir, scriptName);
    await writeFile(
      scriptPath,
      [
        '"use strict";',
        "with (obj) {}",
        "let x; let x;",
        "figma.currentPage.selection = [node];",
        "node.remove();",
        "figma.createImage(bytes);",
      ].join("\n"),
      "utf8",
    );

    const result = await mcpClient.callTool({
      name: "figma_workspace_run_script_file",
      arguments: {
        sessionId: "parse",
        inputFile: scriptName,
        strict: true,
        surface: "design",
        inlineResultLimit: 10_000,
      },
    });
    const json = structuredToolResult(result);
    assert.equal(json.ok, false);
    assert.equal(json.phase, "preflight");
    assert.equal(json.executed, false);
    assert.equal(json.primaryFix, undefined);
    assert.deepEqual(json.diagnostics.map((item) => item.code), [
      "FIGMA_WORKSPACE_PARSE_ERROR",
      "FIGMA_WORKSPACE_PARSE_ERROR",
    ]);
    assert.equal(json.repairPlan.status, "parse_error");
    assert.match(json.repairPlan.summary, /Fix all JavaScript syntax errors/);
    assert.deepEqual(json.repairPlan.steps.map((step) => step.code), [
      "FIGMA_WORKSPACE_PARSE_ERROR",
      "FIGMA_WORKSPACE_PARSE_ERROR",
    ]);
    assert.deepEqual(json.repairPlan.steps.map((step) => step.occurrences[0].label), ["2:1", "3:12"]);
    assert.equal(json.repairPlan.steps.some((step) => /selection|remove|createImage/u.test(step.message)), false);
    const resultFile = await readPrettyJsonPointer(json.outputFiles.debugFile, resolve(fileDir, "parse-errors.result.json"));
    assert.deepEqual(resultFile.repairPlan.steps.map((step) => step.occurrences[0].label), ["2:1", "3:12"]);
    assert.deepEqual(calls.map((call) => call[0]), []);
    await mcpClient.close();
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("figma workspace run_script_file repairPlan dedupes guardrails and preserves all occurrences", async () => {
  const tempDir = await mkdtemp(resolve(tmpdir(), "figma-workspace-guardrail-plan-"));
  const scriptName = "guardrails.figma.js";
  const calls = [];
  const { server } = createFigmaWorkspaceMcpServer({
    client: createFakeFigmaClient(calls, () => {
      throw new Error("unexpected upstream call");
    }),
  });
  const mcpClient = new Client(
    { name: "test-client", version: "0.1.0" },
    { capabilities: {} },
  );
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

  try {
    await server.connect(serverTransport);
    await mcpClient.connect(clientTransport);
    const fileDir = await openTestWorkspace(mcpClient, { tempDir, sessionId: "guardrails" });
    const scriptPath = resolve(fileDir, scriptName);
    await writeFile(
      scriptPath,
      [
        "figma.currentPage.selection = [node];",
        "figma.root.findAll(() => true);",
        "node.characters = 'Hello';",
        "figma.createImage(bytes);",
        "node.remove();",
        "const selected = figma.currentPage.selection;",
      ].join("\n"),
      "utf8",
    );

    const result = await mcpClient.callTool({
      name: "figma_workspace_run_script_file",
      arguments: {
        sessionId: "guardrails",
        inputFile: scriptName,
        strict: true,
        surface: "design",
        inlineResultLimit: 10_000,
      },
    });
    const json = structuredToolResult(result);
    assert.equal(json.ok, false);
    assert.equal(json.repairPlan.status, "blocked");
    const stepCodes = json.repairPlan.steps.map((step) => step.code);
    assert.deepEqual(new Set(stepCodes), new Set([
      "FIGMA_WORKSPACE_NODE_REMOVAL",
      "FIGMA_WORKSPACE_IMAGE_CREATION",
      "FIGMA_WORKSPACE_ROOT_FIND_ALL",
      "FIGMA_WORKSPACE_DIRECT_SELECTION_ACCESS",
      "FIGMA_WORKSPACE_TEXT_MUTATION_NEEDS_FONT",
    ]));
    assert.equal(stepCodes.length, new Set(stepCodes).size);
    const selectionStep = json.repairPlan.steps.find((step) => step.code === "FIGMA_WORKSPACE_DIRECT_SELECTION_ACCESS");
    assert.ok(selectionStep);
    assert.deepEqual(selectionStep.occurrences, [
      { scriptPath, line: 1, column: 1, label: "1:1" },
      { scriptPath, line: 6, column: 18, label: "6:18" },
    ]);
    assert.match(selectionStep.suggestion, /\$\.select/);
    const imageStep = json.repairPlan.steps.find((step) => step.code === "FIGMA_WORKSPACE_IMAGE_CREATION");
    assert.match(imageStep.suggestion, /figma_workspace_apply_asset_manifest/);
    assert.deepEqual(calls.map((call) => call[0]), []);
    await mcpClient.close();
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("figma workspace eval returns structured repairPlan for blocked diagnostics", async () => {
  const calls = [];
  const { server } = createFigmaWorkspaceMcpServer({
    client: createFakeFigmaClient(calls, () => {
      throw new Error("unexpected upstream call");
    }),
  });
  const mcpClient = new Client(
    { name: "test-client", version: "0.1.0" },
    { capabilities: {} },
  );
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

  await server.connect(serverTransport);
  await mcpClient.connect(clientTransport);
  const result = await mcpClient.callTool({
    name: "figma_workspace_eval",
    arguments: {
      sessionId: "eval-blocked",
      mode: "write",
      code: "figma.createImage(bytes);",
    },
  });
  const json = structuredToolResult(result);
  assert.equal(json.ok, false);
  assert.equal(json.primaryFix, undefined);
  assert.equal(json.repairPlan.status, "blocked");
  assert.equal(json.repairPlan.steps[0].code, "FIGMA_WORKSPACE_IMAGE_CREATION");
  assert.deepEqual(json.repairPlan.steps[0].occurrences, [{
    scriptPath: "<inline eval>",
    line: 1,
    column: 1,
    label: "1:1",
  }]);
  assert.deepEqual(calls.map((call) => call[0]), []);
  await mcpClient.close();
});

test("figma workspace run_script_file blocks oversized compiled script payloads before upstream", async () => {
  const tempDir = await mkdtemp(resolve(tmpdir(), "figma-workspace-large-script-"));
  const scriptPath = resolve(tempDir, "large-script.figma.js");
  await writeFile(
    scriptPath,
    [
      "const marker = 'oversized';",
      `const large = '${"A".repeat(60_000)}';`,
      "return { marker, length: large.length };",
    ].join("\n"),
    "utf8",
  );
  const calls = [];
  const { server } = createFigmaWorkspaceMcpServer({
    client: createFakeFigmaClient(calls, () => {
      throw new Error("unexpected upstream call");
    }),
  });
  const mcpClient = new Client(
    { name: "test-client", version: "0.1.0" },
    { capabilities: {} },
  );
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

  try {
    await server.connect(serverTransport);
    await mcpClient.connect(clientTransport);

    const result = await mcpClient.callTool({
      name: "figma_workspace_run_script_file",
      arguments: {
        title: "Run oversized script",
        sessionId: "main",
        scriptPath,
        strict: true,
      },
    });
    const json = structuredToolResult(result);
    assert.equal(json.ok, false);
    assert.equal(json.phase, "preflight");
    assert.equal(json.executed, false);
    assert.equal(json.diagnostics[0].code, "FIGMA_WORKSPACE_SCRIPT_PAYLOAD_TOO_LARGE");
    assert.equal(json.upstream, undefined);
    assert.deepEqual(calls.map((call) => call[0]), []);
    await mcpClient.close();
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("figma workspace run_script_file executes helper-backed scripts through upstream eval", async () => {
  const tempDir = await mkdtemp(resolve(tmpdir(), "figma-workspace-script-"));
  const scriptPath = resolve(tempDir, "script.js");
  await writeFile(
    scriptPath,
    [
      "await $.create({ type: 'FRAME', as: '$scriptFrame', name: 'Script frame', size: { width: 320, height: 160 } });",
      "await $.text({ parent: '$scriptFrame', as: '$scriptTitle', text: 'Hello', font: { family: 'Inter', style: 'Bold', size: 18 } });",
      "await $.layout('$scriptFrame', { layoutMode: 'VERTICAL', itemSpacing: 8 });",
      "const frame = await $('$scriptFrame');",
      "frame.resize(360, 180);",
      "const checkpoint = await $.checkpoint('script-created', ['$scriptFrame', '$scriptTitle']);",
      "return { checkpoint, resized: { id: frame.id, width: frame.width, height: frame.height }, handles: $.handles };",
    ].join("\n"),
    "utf8",
  );
  const calls = [];
  const fakeClient = createFakeFigmaClient(calls, ({ name, args }) => {
    assert.equal(name, "use_figma");
    assert.doesNotMatch(args.code, /\$\.findAll = async function findAll/);
    assert.doesNotMatch(args.code, /\$\.select = async function select/);
    assert.doesNotMatch(args.code, /figma\.createImage\(bytes\)/);
    assert.doesNotMatch(args.code, /\$\.screenshot = async function screenshot/);
    assert.match(args.code, /\$\.text = async function text/);
    assert.match(args.code, /\$\.create = async function create/);
    assert.match(args.code, /\$\.findFreeSlot = __figmaReplFindFreeSlot/);
    assert.match(args.code, /\$\.placeNode = async function placeNode/);
    assert.doesNotMatch(args.code, /\$\.replaceGeneratedFrame = async function replaceGeneratedFrame/);
    assert.doesNotMatch(args.code, /\$\.ops = async function ops/);
    assert.match(args.code, /\$\.checkpoint = async function checkpoint/);
    assert.doesNotMatch(args.code, /\$\.inspect = async function inspect/);
    assert.match(args.code, /figma\.setCurrentPageAsync/);
    assert.match(args.code, /Script frame/);
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify({
            ok: true,
            __figmaRepl: {
              sessionId: "main",
              handles: {
                "$scriptFrame": "20:1",
                "$scriptTitle": "20:2",
              },
            },
            result: {
              checkpoint: { name: "script-created" },
              resized: { id: "20:1", width: 360, height: 180 },
              handles: {
                "$scriptFrame": "20:1",
                "$scriptTitle": "20:2",
              },
            },
          }),
        },
      ],
    };
  });
  const { server } = createFigmaWorkspaceMcpServer({ client: fakeClient });
  const mcpClient = new Client(
    { name: "test-client", version: "0.1.0" },
    { capabilities: {} },
  );
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

  try {
    await server.connect(serverTransport);
    await mcpClient.connect(clientTransport);

    const result = await mcpClient.callTool({
      name: "figma_workspace_run_script_file",
      arguments: {
        title: "Run script",
        sessionId: "main",
        scriptPath,
        targetPageId: "0:1",
        surface: "design",
      },
    });
    const json = structuredToolResult(result);
    assert.equal(json.ok, true);
    assert.equal(json.phase, "execute");
    assert.equal(json.executed, true);
    assert.equal(json.script.executed, undefined);
    assert.equal(json.script.dryRun, undefined);
    assert.equal(json.script.diagnosticsCount, undefined);
    assert.equal(json.script.targetPageId, undefined);
    assert.equal(json.script.injectedHelpers, undefined);
    assert.equal(json.script.helperUsage, undefined);
    assert.equal(json.script.expectedSurface, "design");
    assert.ok(json.script.compiledScriptBytes > 0);
    assert.equal(json.verbose, undefined);
    assert.equal(json.upstream.kind, "json");
    assert.equal(json.upstream.ok, true);
    assert.equal(json.upstream.result.resized.width, 360);
    assert.equal(json.upstream.result.__figmaRepl, undefined);
    assert.equal(json.upstream.result.result, undefined);
    assert.equal(json.result, undefined);
    assert.equal(json.execution, undefined);
    assert.equal(json.stateSync, undefined);
    assert.equal(json.debug, undefined);
    assert.equal(json.parsed, undefined);
    assert.equal(json.text, undefined);
    assert.deepEqual(json.session.handleChanges.updated, ["$scriptFrame", "$scriptTitle"]);
    assert.deepEqual(json.session.handleChanges.removed, []);
    assert.equal(json.session.handles, undefined);
    assert.equal(json.session.history, undefined);
    assert.deepEqual(calls.map((call) => call[0]), ["connect", "listTools", "callTool"]);
    await mcpClient.close();
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("figma workspace run_script_file keeps wrapper success when nested business ok is false", async () => {
  const tempDir = await mkdtemp(resolve(tmpdir(), "figma-workspace-script-nested-ok-"));
  const scriptPath = resolve(tempDir, "nested-ok.figma.js");
  await writeFile(
    scriptPath,
    "return { ok: false, reason: 'business validation evidence', target: '20:1' };",
    "utf8",
  );
  const calls = [];
  const fakeClient = createFakeFigmaClient(calls, ({ name, args }) => {
    assert.equal(name, "use_figma");
    assert.match(args.code, /business validation evidence/);
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify({
            ok: true,
            __figmaRepl: { sessionId: "main", handles: {} },
            result: {
              ok: false,
              reason: "business validation evidence",
              target: "20:1",
            },
          }),
        },
      ],
    };
  });
  const { server } = createFigmaWorkspaceMcpServer({ client: fakeClient });
  const mcpClient = new Client(
    { name: "test-client", version: "0.1.0" },
    { capabilities: {} },
  );
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

  try {
    await server.connect(serverTransport);
    await mcpClient.connect(clientTransport);

    const result = await mcpClient.callTool({
      name: "figma_workspace_run_script_file",
      arguments: {
        title: "Run nested business ok script",
        sessionId: "main",
        scriptPath,
        surface: "design",
      },
    });
    const json = structuredToolResult(result);
    assert.equal(json.ok, true);
    assert.equal(json.phase, "execute");
    assert.equal(json.executed, true);
    assert.equal(json.upstream.ok, false);
    assert.equal(json.upstream.result.ok, undefined);
    assert.equal(json.upstream.result.source, "business");
    assert.equal(json.upstream.result.reason, "business validation evidence");
    assert.equal(json.upstream.result.__figmaRepl, undefined);
    assert.equal(json.upstream.result.result, undefined);
    assert.equal(json.upstreamError, undefined);
    assert.equal(json.outputFiles, undefined);
    assert.deepEqual(calls.map((call) => call[0]), ["connect", "listTools", "callTool"]);
    await mcpClient.close();
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("figma workspace run_script_file avoids helper injection for native Plugin API scripts", async () => {
  const tempDir = await mkdtemp(resolve(tmpdir(), "figma-workspace-native-"));
  const scriptPath = resolve(tempDir, "native-script.figma.js");
  await writeFile(
    scriptPath,
    [
      "const frame = figma.createFrame();",
      "frame.name = 'Native frame';",
      "frame.resize(240, 120);",
      "return { id: frame.id, name: frame.name };",
    ].join("\n"),
    "utf8",
  );
  const calls = [];
  const fakeClient = createFakeFigmaClient(calls, ({ name, args }) => {
    assert.equal(name, "use_figma");
    assert.doesNotMatch(args.code, /\$\.checkpoint = async function checkpoint/);
    assert.doesNotMatch(args.code, /\$\.findAll = async function findAll/);
    assert.doesNotMatch(args.code, /\$\.create = async function create/);
    assert.doesNotMatch(args.code, /const __figmaReplEvalCheckpoints = \[\]/);
    assert.match(args.code, /Native frame/);
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify({
            ok: true,
            __figmaRepl: { sessionId: "main", handles: {} },
            result: { id: "50:1", name: "Native frame" },
          }),
        },
      ],
    };
  });
  const { server } = createFigmaWorkspaceMcpServer({ client: fakeClient });
  const mcpClient = new Client(
    { name: "test-client", version: "0.1.0" },
    { capabilities: {} },
  );
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

  try {
    await server.connect(serverTransport);
    await mcpClient.connect(clientTransport);

    const result = await mcpClient.callTool({
      name: "figma_workspace_run_script_file",
      arguments: {
        title: "Run native script",
        sessionId: "main",
        scriptPath,
        surface: "design",
      },
    });
    const json = structuredToolResult(result);
    assert.equal(json.ok, true);
    assert.equal(json.script.injectedHelpers, undefined);
    assert.equal(json.script.helperUsage, undefined);
    assert.ok(json.script.compiledScriptBytes < 15_000);
    assert.equal(json.upstream.result.name, "Native frame");
    assert.equal(json.upstream.result.__figmaRepl, undefined);
    assert.equal(json.result, undefined);
    await mcpClient.close();
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("figma workspace run_script_file injects helper dependencies from AST usage", async () => {
  const tempDir = await mkdtemp(resolve(tmpdir(), "figma-workspace-find-helper-"));
  const scriptPath = resolve(tempDir, "find-script.figma.js");
  await writeFile(scriptPath, "return await $.find({ name: 'Card', type: 'FRAME' });", "utf8");
  const calls = [];
  const fakeClient = createFakeFigmaClient(calls, ({ name, args }) => {
    assert.equal(name, "use_figma");
    assert.match(args.code, /\$\.find = async function find/);
    assert.match(args.code, /\$\.findAll = async function findAll/);
    assert.doesNotMatch(args.code, /\$\.text = async function text/);
    assert.doesNotMatch(args.code, /\$\.checkpoint = async function checkpoint/);
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify({
            ok: true,
            __figmaRepl: { sessionId: "main", handles: {} },
            result: { id: "60:1", name: "Card" },
          }),
        },
      ],
    };
  });
  const { server } = createFigmaWorkspaceMcpServer({ client: fakeClient });
  const mcpClient = new Client(
    { name: "test-client", version: "0.1.0" },
    { capabilities: {} },
  );
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

  try {
    await server.connect(serverTransport);
    await mcpClient.connect(clientTransport);

    const result = await mcpClient.callTool({
      name: "figma_workspace_run_script_file",
      arguments: {
        title: "Run find helper script",
        sessionId: "main",
        scriptPath,
        surface: "design",
      },
    });
    const json = structuredToolResult(result);
    assert.equal(json.ok, true);
    assert.equal(json.script.injectedHelpers, undefined);
    assert.equal(json.script.helperUsage, undefined);
    assert.ok(json.script.compiledScriptBytes > 0);
    await mcpClient.close();
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("figma workspace run_script_file keeps resolveHandleId for node helper usage", async () => {
  const tempDir = await mkdtemp(resolve(tmpdir(), "figma-workspace-node-helper-"));
  const scriptPath = resolve(tempDir, "node-script.figma.js");
  await writeFile(scriptPath, "return await $.node('$card');", "utf8");
  const calls = [];
  const fakeClient = createFakeFigmaClient(calls, ({ name, args }) => {
    assert.equal(name, "use_figma");
    assert.match(args.code, /function resolveHandleId/);
    assert.match(args.code, /\$\.node = \$;/);
    assert.doesNotMatch(args.code, /\$\.find = async function find/);
    assert.doesNotMatch(args.code, /\$\.text = async function text/);
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify({
            ok: true,
            __figmaRepl: { sessionId: "main", handles: {} },
            result: { id: "60:1", name: "Card" },
          }),
        },
      ],
    };
  });
  const sessions = createFigmaWorkspaceSessionStore({ defaultSessionId: "main" });
  const session = sessions.getOrCreate("main");
  session.fileUrl = "https://www.figma.com/design/ExampleFigmaFileKey012/UI";
  session.handles = {
    "$card": "60:1",
  };
  const { server } = createFigmaWorkspaceMcpServer({
    client: fakeClient,
    sessions,
  });
  const mcpClient = new Client(
    { name: "test-client", version: "0.1.0" },
    { capabilities: {} },
  );
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

  try {
    await server.connect(serverTransport);
    await mcpClient.connect(clientTransport);

    const result = await mcpClient.callTool({
      name: "figma_workspace_run_script_file",
      arguments: {
        title: "Run node helper script",
        sessionId: "main",
        scriptPath,
        surface: "design",
      },
    });
    const json = structuredToolResult(result);
    assert.equal(json.ok, true);
    await mcpClient.close();
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("figma workspace run_script_file rejects dynamic helper access instead of full injection fallback", async () => {
  const tempDir = await mkdtemp(resolve(tmpdir(), "figma-workspace-dynamic-helper-"));
  const scriptPath = resolve(tempDir, "dynamic-helper.figma.js");
  await writeFile(
    scriptPath,
    [
      "const helperName = 'find';",
      "return await $[helperName]({ name: 'Card', type: 'FRAME' });",
    ].join("\n"),
    "utf8",
  );
  const calls = [];
  const { server } = createFigmaWorkspaceMcpServer({
    client: createFakeFigmaClient(calls, () => {
      throw new Error("unexpected upstream call");
    }),
  });
  const mcpClient = new Client(
    { name: "test-client", version: "0.1.0" },
    { capabilities: {} },
  );
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

  try {
    await server.connect(serverTransport);
    await mcpClient.connect(clientTransport);

    const result = await mcpClient.callTool({
      name: "figma_workspace_run_script_file",
      arguments: {
        title: "Run dynamic helper script",
        sessionId: "main",
        scriptPath,
        surface: "design",
      },
    });
    const json = structuredToolResult(result);
    assert.equal(json.ok, false);
    assert.equal(json.phase, "preflight");
    assert.equal(json.executed, false);
    assert.equal(json.diagnostics[0].code, "FIGMA_WORKSPACE_DYNAMIC_HELPER_ACCESS");
    assert.deepEqual(calls.map((call) => call[0]), []);
    await mcpClient.close();
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("figma workspace run_script_file allows literal computed helper access", async () => {
  const tempDir = await mkdtemp(resolve(tmpdir(), "figma-workspace-literal-helper-"));
  const scriptPath = resolve(tempDir, "literal-helper.figma.js");
  await writeFile(scriptPath, "return await $['find']({ name: 'Card', type: 'FRAME' });", "utf8");
  const calls = [];
  const fakeClient = createFakeFigmaClient(calls, ({ name, args }) => {
    assert.equal(name, "use_figma");
    assert.match(args.code, /\$\.find = async function find/);
    assert.match(args.code, /\$\.findAll = async function findAll/);
    assert.doesNotMatch(args.code, /\$\.text = async function text/);
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify({
            ok: true,
            __figmaRepl: { sessionId: "main", handles: {} },
            result: { id: "61:1", name: "Card" },
          }),
        },
      ],
    };
  });
  const { server } = createFigmaWorkspaceMcpServer({ client: fakeClient });
  const mcpClient = new Client(
    { name: "test-client", version: "0.1.0" },
    { capabilities: {} },
  );
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

  try {
    await server.connect(serverTransport);
    await mcpClient.connect(clientTransport);

    const result = await mcpClient.callTool({
      name: "figma_workspace_run_script_file",
      arguments: {
        title: "Run literal helper script",
        sessionId: "main",
        scriptPath,
        surface: "design",
      },
    });
    const json = structuredToolResult(result);
    assert.equal(json.ok, true);
    assert.equal(json.script.injectedHelpers, undefined);
    assert.equal(json.script.helperUsage, undefined);
    assert.ok(json.script.compiledScriptBytes > 0);
    await mcpClient.close();
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("figma workspace run_script_file supports generated image asset helper without raw createImage in source", async () => {
  const tempDir = await mkdtemp(resolve(tmpdir(), "figma-workspace-image-"));
  const scriptPath = resolve(tempDir, "image-script.figma.js");
  await writeFile(
    scriptPath,
    [
      "const root = await $.create({ type: 'FRAME', as: '$root', name: 'Image asset root', size: { width: 240, height: 180 } });",
      "await $.imageAsset({ parent: '$root', as: '$icon', name: 'Generated icon asset', base64: 'AQIDBA==', size: { width: 64, height: 64 } });",
      "return await $.checkpoint('image-asset-created', ['$root', '$icon']);",
    ].join("\n"),
    "utf8",
  );
  const calls = [];
  const fakeClient = createFakeFigmaClient(calls, ({ name, args }) => {
    assert.equal(name, "use_figma");
    assert.match(args.code, /\$\.imageAsset = async function imageAsset/);
    assert.match(args.code, /\$\.findFreeSlot = __figmaReplFindFreeSlot/);
    assert.match(args.code, /\$\.placeNode = async function placeNode/);
    assert.doesNotMatch(args.code, /\$\.replaceGeneratedFrame = async function replaceGeneratedFrame/);
    assert.match(args.code, /figma\.createImage\(bytes\)/);
    assert.match(args.code, /Generated icon asset/);
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify({
            ok: true,
            __figmaRepl: {
              sessionId: "main",
              handles: { "$root": "40:1", "$icon": "40:2" },
            },
            result: { ok: true },
          }),
        },
      ],
    };
  });
  const { server } = createFigmaWorkspaceMcpServer({ client: fakeClient });
  const mcpClient = new Client(
    { name: "test-client", version: "0.1.0" },
    { capabilities: {} },
  );
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

  try {
    await server.connect(serverTransport);
    await mcpClient.connect(clientTransport);

    const result = await mcpClient.callTool({
      name: "figma_workspace_run_script_file",
      arguments: {
        title: "Run image helper script",
        sessionId: "main",
        scriptPath,
        surface: "design",
      },
    });
    const json = structuredToolResult(result);
    assert.equal(json.ok, true);
    assert.deepEqual(json.diagnostics, []);
    assert.equal(json.script.injectedHelpers, undefined);
    assert.equal(json.script.helperUsage, undefined);
    assert.deepEqual(json.session.handleChanges, { updated: ["$icon", "$root"], removed: [] });
    assert.equal(json.session.handles, undefined);
    await mcpClient.close();
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("figma workspace run_script_file structures upstream call failure errors", async () => {
  const tempDir = await mkdtemp(resolve(tmpdir(), "figma-workspace-upstream-error-"));
  const scriptName = "script.figma.js";
  const calls = [];
  const fakeClient = createFakeFigmaClient(calls, ({ args }) => {
    if (/success after failure/u.test(args.code)) {
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({ ok: true, result: { summary: "success after failure" } }),
          },
        ],
      };
    }
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify({
            ok: false,
            error: {
              code: "FIGMA_INSTANCE_CHILD_REMOVE",
              message: "Cannot remove children inside an instance subtree.",
            },
          }),
        },
      ],
    };
  });
  const { server } = createFigmaWorkspaceMcpServer({ client: fakeClient });
  const mcpClient = new Client(
    { name: "test-client", version: "0.1.0" },
    { capabilities: {} },
  );
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

  try {
    await server.connect(serverTransport);
    await mcpClient.connect(clientTransport);
    const fileDir = await openTestWorkspace(mcpClient, { tempDir });
    const scriptPath = resolve(fileDir, scriptName);
    await writeFile(scriptPath, "return await $.cloneNodeTree({ source: '$source', as: '$copy' });", "utf8");

    const result = await mcpClient.callTool({
      name: "figma_workspace_run_script_file",
      arguments: {
        title: "Run script with upstream failure",
        inputFile: scriptName,
      },
    });
    const json = structuredToolResult(result);
    assert.equal(json.ok, false);
    assert.equal(json.phase, "execute");
    assert.equal(json.executed, true);
    assert.equal(json.upstreamError.code, "FIGMA_INSTANCE_CHILD_REMOVE");
    assert.match(json.upstreamError.message, /instance subtree/);
    assert.equal(json.upstreamError.parsed, undefined);
    assert.equal(json.upstreamError.text, undefined);
    assert.equal(json.upstream.kind, "json");
    assert.equal(json.upstream.ok, false);
    assert.equal(json.upstream.result.error.code, "FIGMA_INSTANCE_CHILD_REMOVE");
    assert.equal(json.upstream.result.source, "business");
    assert.equal(json.primaryFix, undefined);
    assert.equal(json.compiledScript, undefined);
    assert.equal(json.raw, undefined);
    const resultFile = await readPrettyJsonPointer(json.outputFiles.debugFile, resolve(fileDir, "script.result.json"));
    const compiledFilePath = resolve(fileDir, "script.failure.compiled.js");
    const compiledFile = await readTextPointer(json.outputFiles.compiledScriptFile, compiledFilePath);
    assert.equal(resultFile.ok, false);
    assert.equal(resultFile.kind, "figma_workspace_result");
    assert.equal(resultFile.tool, "figma_workspace_run_script_file");
    assert.equal(resultFile.sessionId, "default");
    assert.equal(resultFile.phase, "execute");
    assert.equal(resultFile.executed, true);
    assert.equal(resultFile.upstreamKind, "json");
    assert.equal(resultFile.upstreamOk, false);
    assert.equal(resultFile.diagnosticsCount, 0);
    assert.equal(resultFile.session, undefined);
    assert.equal(resultFile.outputFiles, undefined);
    assert.equal(resultFile.compiledScript, undefined);
    assert.equal(resultFile.raw, undefined);
    assert.equal(resultFile.upstream, undefined);
    assert.equal(resultFile.upstreamError.code, "FIGMA_INSTANCE_CHILD_REMOVE");
    assert.equal(resultFile.primaryFix, undefined);
    assert.equal(typeof resultFile.resultSummary, "string");
    assert.equal(json.outputFiles.summaryFile, undefined);
    assert.equal(json.outputFiles.diagnosticsFile, undefined);
    const upstreamFile = await readPrettyJsonPointer(json.outputFiles.upstreamFile, resolve(fileDir, "script.upstream.json"));
    assert.deepEqual(upstreamFile.result, {
      error: {
        code: "FIGMA_INSTANCE_CHILD_REMOVE",
        message: "Cannot remove children inside an instance subtree.",
      },
      source: "business",
    });
    assert.equal(resultFile.upstreamError.parsed, undefined);
    assert.equal(resultFile.upstreamError.text, undefined);
    assert.match(compiledFile, /Generated by figma_workspace_run_script_file after upstream execution failure/);
    assert.match(compiledFile, /This is the compiled wrapper sent to upstream Figma MCP/);
    assert.match(compiledFile, /\$\.cloneNodeTree/);
    assert.match(compiledFile, /figma_workspace_run_script_file source:/);

    await writeFile(scriptPath, "return { summary: 'success after failure' };", "utf8");
    const successResult = await mcpClient.callTool({
      name: "figma_workspace_run_script_file",
      arguments: {
        title: "Run script after upstream failure",
        inputFile: scriptName,
      },
    });
    const successJson = structuredToolResult(successResult);
    assert.equal(successJson.ok, true);
    assert.equal(successJson.outputFiles, undefined);
    await assert.rejects(
      readFile(compiledFilePath, "utf8"),
      /ENOENT/,
    );
    assert.deepEqual(calls.map((call) => call[0]), ["connect", "listTools", "callTool", "callTool"]);
    await mcpClient.close();
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("figma workspace run_script_file structures upstream text errors without implicit files", async () => {
  const tempDir = await mkdtemp(resolve(tmpdir(), "figma-workspace-upstream-text-error-"));
  const scriptPath = resolve(tempDir, "script.figma.js");
  await writeFile(scriptPath, "figma.currentPage.selection = [];", "utf8");
  const calls = [];
  const fakeClient = createFakeFigmaClient(calls, () => ({
    content: [
      {
        type: "text",
        text: [
          "Error: in set_selection: The selection of a page can only include nodes in that page",
          "    at set (<input>:58:11)",
          "",
          "Figma Debug UUID: 59c9dee0-3819-4e15-9a9e-a4a37a71072d",
        ].join("\n"),
      },
    ],
  }));
  const { server } = createFigmaWorkspaceMcpServer({ client: fakeClient });
  const mcpClient = new Client(
    { name: "test-client", version: "0.1.0" },
    { capabilities: {} },
  );
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

  try {
    await server.connect(serverTransport);
    await mcpClient.connect(clientTransport);

    const result = await mcpClient.callTool({
      name: "figma_workspace_run_script_file",
      arguments: {
        title: "Run script with upstream text failure",
        scriptPath,
        allowDangerousOperations: true,
      },
    });
    const json = structuredToolResult(result);
    assert.equal(json.ok, false);
    assert.equal(json.phase, "execute");
    assert.equal(json.executed, true);
    assert.equal(json.upstreamError.code, "FIGMA_UPSTREAM_TEXT_ERROR");
    assert.match(json.upstreamError.message, /set_selection/);
    assert.equal(json.upstreamError.details.debugUuid, "59c9dee0-3819-4e15-9a9e-a4a37a71072d");
    assert.equal(json.upstreamError.text, undefined);
    assert.equal(json.upstreamError.parsed, undefined);
    assert.equal(json.upstream.kind, "text");
    assert.equal(json.upstream.ok, false);
    assert.match(json.upstream.text, /Figma Debug UUID/);
    assert.equal(json.text, undefined);
    assert.equal(json.primaryFix, undefined);
    assert.equal(json.compiledScript, undefined);
    assert.equal(json.outputFiles, undefined);
    await assert.rejects(
      readFile(resolve(tempDir, "script.compiled.js"), "utf8"),
      /ENOENT/,
    );
    await assert.rejects(
      readFile(resolve(tempDir, "script.failure.compiled.js"), "utf8"),
      /ENOENT/,
    );
    assert.deepEqual(calls.map((call) => call[0]), ["connect", "listTools", "callTool"]);
    await mcpClient.close();
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("figma workspace run_script_file writes output files and limits inline result fields", async () => {
  const tempDir = await mkdtemp(resolve(tmpdir(), "figma-workspace-output-"));
  const scriptName = "script.figma.js";
  const calls = [];
  const fakeClient = createFakeFigmaClient(calls, ({ args }) => {
    assert.match(args.code, /large result/);
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify({
            ok: true,
            __figmaRepl: { sessionId: "default", handles: {} },
            result: {
              summary: "large result",
              payload: "x".repeat(200),
            },
          }),
        },
      ],
    };
  });
  const { server } = createFigmaWorkspaceMcpServer({ client: fakeClient });
  const mcpClient = new Client(
    { name: "test-client", version: "0.1.0" },
    { capabilities: {} },
  );
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

  try {
    await server.connect(serverTransport);
    await mcpClient.connect(clientTransport);
    const fileDir = await openTestWorkspace(mcpClient, { tempDir });
    const scriptPath = resolve(fileDir, scriptName);
    await writeFile(scriptPath, "return { summary: 'large result' };", "utf8");

    const result = await mcpClient.callTool({
      name: "figma_workspace_run_script_file",
      arguments: {
        title: "Run script with output files",
        inputFile: scriptName,
        inlineResultLimit: 40,
      },
    });
    const json = structuredToolResult(result);
    assert.equal(json.ok, true);
    assert.equal(json.phase, "execute");
    assert.equal(json.executed, true);
    assert.equal(json.result, undefined);
    assert.equal(json.text, undefined);
    assert.equal(json.raw, undefined);
    assert.equal(json.upstream.kind, "json");
    assert.equal(json.upstream.ok, true);
    assert.equal(json.upstream.result, undefined);
    assert.deepEqual(
      json.inlineResultLimit.omitted.map((item) => item.field),
      ["upstream.result"],
    );
    const resultFile = await readPrettyJsonPointer(json.outputFiles.debugFile, resolve(fileDir, "script.result.json"));
    const upstreamFile = await readPrettyJsonPointer(json.outputFiles.upstreamFile, resolve(fileDir, "script.upstream.json"));
    assert.equal(json.outputFiles.diagnosticsFile, undefined);
    assert.equal(json.outputFiles.summaryFile, undefined);
    assert.equal(resultFile.kind, "figma_workspace_result");
    assert.equal(resultFile.tool, "figma_workspace_run_script_file");
    assert.equal(resultFile.upstreamKind, "json");
    assert.equal(resultFile.upstreamOk, true);
    assert.equal(resultFile.resultSummary, "large result");
    assert.equal(resultFile.upstream, undefined);
    assert.equal(resultFile.outputFiles, undefined);
    assert.equal(upstreamFile.result.payload.length, 200);
    assert.deepEqual(upstreamFile.result, {
      summary: "large result",
      payload: "x".repeat(200),
    });
    assert.equal(resultFile.raw, undefined);
    assert.deepEqual(calls.map((call) => call[0]), ["connect", "listTools", "callTool"]);
    await mcpClient.close();
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("figma workspace prepare_task uses file context and intent file pairs", async () => {
  const tempDir = await mkdtemp(resolve(tmpdir(), "figma-workspace-"));
  const calls = [];
  const fakeClient = createFakeFigmaClient(calls, ({ args }) => {
    if (/workspace failure result/u.test(args.code)) {
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              ok: false,
              error: { message: "workspace failure result" },
            }),
          },
        ],
      };
    }
    assert.match(args.code, /workspace file result/);
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify({
            ok: true,
            __figmaRepl: { sessionId: "settings-workspace", handles: {} },
            result: { summary: "workspace file result", payload: "y".repeat(160) },
          }),
        },
      ],
    };
  });
  const { server } = createFigmaWorkspaceMcpServer({ client: fakeClient });
  const mcpClient = new Client(
    { name: "test-client", version: "0.1.0" },
    { capabilities: {} },
  );
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

  try {
    await server.connect(serverTransport);
    await mcpClient.connect(clientTransport);

    const initResult = await mcpClient.callTool({
      name: "figma_workspace_prepare_task",
      arguments: {
        title: "Init workspace",
        sessionId: "settings-workspace",
        taskName: "settings-panel-polish",
        file: "https://www.figma.com/design/ExampleFigmaFileKey012/UI?node-id=1-2",
        cwd: tempDir,
        overwrite: true,
      },
    });
    const initJson = structuredToolResult(initResult);
    assert.equal(initJson.ok, true);
    assert.equal(initJson.session.id, "settings-workspace");
    assert.equal(initJson.session.fileKey, "ExampleFigmaFileKey012");
    assert.equal(initJson.session.surface, "design");
    assert.equal(initJson.task.fileContext, "ExampleFigmaFileKey012");
    assert.equal(initJson.task.taskName, "settings-panel-polish");
    assert.equal(initJson.task.taskSlug, undefined);
    assert.equal(initJson.task.intentSlug, undefined);
    assert.equal(initJson.task.inputFile, "settings-panel-polish.figma.js");
    assert.equal(initJson.task.outputFile, undefined);
    assert.equal(initJson.task.resultFile, undefined);
    assert.equal(initJson.task.fileDir, undefined);
    assert.equal(initJson.task.workspaceDir, undefined);
    assert.equal(initJson.task.taskDir, undefined);
    assert.equal(initJson.task.workspace.fileDir, resolve(tempDir, "figma-workspace", "ExampleFigmaFileKey012"));
    assert.equal(initJson.task.workspace.sessionDir, initJson.task.workspace.fileDir);
    assert.equal(initJson.task.workspace.taskName, "settings-panel-polish");
    assert.equal(initJson.task.workspace.taskSlug, undefined);
    assert.equal(initJson.task.workspace.intentSlug, undefined);
    assert.equal(initJson.task.workspace.resultFile, undefined);
    assert.equal(initJson.task.workspace.files.inputFile, "settings-panel-polish.figma.js");
    assert.equal(initJson.task.workspace.files.outputFile, undefined);
    assert.equal(initJson.taskChange.previous, undefined);
    assert.equal(initJson.taskChange.changed, true);
    assert.deepEqual(initJson.taskChange.current, {
      taskName: "settings-panel-polish",
      inputFile: "settings-panel-polish.figma.js",
      sessionDir: initJson.task.workspace.sessionDir,
    });
    assert.equal(initJson.outputFiles, undefined);

    const sessionsResource = await mcpClient.readResource({ uri: "figma-workspace://sessions" });
    const sessionsJson = JSON.parse(sessionsResource.contents[0].text);
    assert.deepEqual(sessionsJson.sessions, [
      {
        id: "settings-workspace",
        fileKey: "ExampleFigmaFileKey012",
        surface: "design",
        sessionDir: initJson.task.workspace.sessionDir,
      },
    ]);

    const sessionResource = await mcpClient.readResource({ uri: "figma-workspace://sessions/settings-workspace" });
    const sessionJson = JSON.parse(sessionResource.contents[0].text);
    assert.deepEqual(sessionJson, {
      id: "settings-workspace",
      fileKey: "ExampleFigmaFileKey012",
      surface: "design",
      handles: {},
      workspace: {
        sessionDir: initJson.task.workspace.sessionDir,
      },
    });
    assert.equal(sessionJson.workspace.taskSlug, undefined);
    assert.equal(sessionJson.workspace.inputFile, undefined);
    assert.equal(sessionJson.workspace.root, undefined);
    assert.equal(sessionJson.workspace.fileDir, undefined);
    assert.equal(sessionJson.workspace.fileContext, undefined);
    assert.equal(sessionJson.workspace.fileKey, undefined);
    assert.equal(sessionJson.workspace.fileSlug, undefined);
    assert.equal(sessionJson.workspace.scriptPath, undefined);
    assert.equal(sessionJson.workspace.files, undefined);

    await writeFile(
      resolve(initJson.task.workspace.fileDir, "settings-panel-polish.figma.js"),
      "return { summary: 'workspace file result' };",
      "utf8",
    );

    const result = await mcpClient.callTool({
      name: "figma_workspace_run_script_file",
      arguments: {
        title: "Run workspace file",
        sessionId: "settings-workspace",
        inputFile: "settings-panel-polish.figma.js",
        inlineResultLimit: 40,
      },
    });
    const json = structuredToolResult(result);
    assert.equal(json.ok, true);
    assert.equal(json.phase, "execute");
    assert.equal(json.executed, true);
    assert.equal(json.session.sessionDir, initJson.task.workspace.sessionDir);
    assert.equal(json.session.workspace, undefined);
    assert.equal(json.session.surface, "design");
    assertFilePointer(json.outputFiles.debugFile, resolve(initJson.task.workspace.fileDir, "settings-panel-polish.result.json"));
    assertFilePointer(json.outputFiles.upstreamFile, resolve(initJson.task.workspace.fileDir, "settings-panel-polish.upstream.json"));
    assert.equal(json.result, undefined);
    assert.equal(json.upstream.kind, "json");
    assert.equal(json.upstream.ok, true);
    assert.equal(json.upstream.result, undefined);
    assert.deepEqual(
      json.inlineResultLimit.omitted.map((item) => item.field),
      ["upstream.result"],
    );
    const resultFile = await readPrettyJsonPointer(json.outputFiles.debugFile, resolve(initJson.task.workspace.fileDir, "settings-panel-polish.result.json"));
    assert.equal(resultFile.kind, "figma_workspace_result");
    assert.equal(resultFile.tool, "figma_workspace_run_script_file");
    assert.equal(resultFile.sessionId, "settings-workspace");
    assert.equal(resultFile.upstreamKind, "json");
    assert.equal(resultFile.upstreamOk, true);
    assert.equal(resultFile.upstream, undefined);
    assert.equal(resultFile.outputFiles, undefined);
    const upstreamFile = await readPrettyJsonPointer(json.outputFiles.upstreamFile, resolve(initJson.task.workspace.fileDir, "settings-panel-polish.upstream.json"));
    assert.equal(upstreamFile.result.payload.length, 160);
    assert.equal(upstreamFile.result.__figmaRepl, undefined);
    assert.equal(upstreamFile.result.result, undefined);

    await writeFile(
      resolve(initJson.task.workspace.fileDir, "settings-panel-polish.figma.js"),
      "return { summary: 'workspace failure result' };",
      "utf8",
    );
    const failedResult = await mcpClient.callTool({
      name: "figma_workspace_run_script_file",
      arguments: {
        title: "Run failed workspace file",
        sessionId: "settings-workspace",
        inputFile: "settings-panel-polish.figma.js",
      },
    });
    const failedJson = structuredToolResult(failedResult);
    assert.equal(failedJson.ok, false);
    assertFilePointer(failedJson.outputFiles.upstreamFile, resolve(initJson.task.workspace.fileDir, "settings-panel-polish.upstream.json"));
    const failedUpstreamFile = await readPrettyJsonPointer(failedJson.outputFiles.upstreamFile, resolve(initJson.task.workspace.fileDir, "settings-panel-polish.upstream.json"));
    assert.equal(failedUpstreamFile.kind, "json");
    assert.equal(failedUpstreamFile.ok, false);
    assert.equal(failedUpstreamFile.callOk, undefined);
    const failedCompiledFile = await readTextPointer(
      failedJson.outputFiles.compiledScriptFile,
      resolve(initJson.task.workspace.fileDir, "settings-panel-polish.failure.compiled.js"),
    );
    assert.match(failedCompiledFile, /Generated by figma_workspace_run_script_file after upstream execution failure/);
    assert.match(failedCompiledFile, /Source: ExampleFigmaFileKey012\/settings-panel-polish\.figma\.js/);
    assert.match(failedCompiledFile, /workspace failure result/);
    assert.match(failedCompiledFile, /figma_workspace_run_script_file source:/);

    const missingInputResult = await mcpClient.callTool({
      name: "figma_workspace_run_script_file",
      arguments: {
        title: "Run missing workspace file",
        sessionId: "settings-workspace",
        inputFile: "missing-settings-panel.figma.js",
        strict: true,
      },
    });
    const missingInputJson = structuredToolResult(missingInputResult);
    assert.equal(missingInputJson.ok, false);
    assert.equal(missingInputJson.phase, "preflight");
    assert.equal(missingInputJson.executed, false);
    assert.equal(missingInputJson.diagnostics[0].code, "FIGMA_WORKSPACE_INPUT_FILE_MISSING");
    assert.equal(missingInputJson.repairPlan.status, "blocked");
    assert.equal(missingInputJson.upstream, undefined);
    assert.equal(missingInputJson.upstreamError, undefined);
    assertFilePointer(missingInputJson.outputFiles.debugFile, resolve(initJson.task.workspace.fileDir, "missing-settings-panel.result.json"));
    const missingInputFile = await readPrettyJsonPointer(
      missingInputJson.outputFiles.debugFile,
      resolve(initJson.task.workspace.fileDir, "missing-settings-panel.result.json"),
    );
    assert.equal(missingInputFile.kind, "figma_workspace_result");
    assert.equal(missingInputFile.tool, "figma_workspace_run_script_file");
    assert.equal(missingInputFile.phase, "preflight");
    assert.equal(missingInputFile.executed, false);
    assert.equal(missingInputFile.diagnosticsCount, 1);
    assert.equal(missingInputFile.diagnostics[0].code, "FIGMA_WORKSPACE_INPUT_FILE_MISSING");
    assert.equal(missingInputFile.repairPlan.status, "blocked");

    const prepared = await mcpClient.callTool({
      name: "figma_workspace_prepare_task",
      arguments: {
        title: "Prepare another task",
        sessionId: "settings-workspace",
        taskName: "token-audit",
        surface: "design",
        overwrite: true,
      },
    });
    const preparedJson = structuredToolResult(prepared);
    assert.equal(preparedJson.task.fileContext, "ExampleFigmaFileKey012");
    assert.equal(preparedJson.task.workspace.fileKey, "ExampleFigmaFileKey012");
    assert.equal(preparedJson.task.taskName, "token-audit");
    assert.equal(preparedJson.task.taskSlug, undefined);
    assert.equal(preparedJson.task.intentSlug, undefined);
    assert.equal(preparedJson.task.inputFile, "token-audit.figma.js");
    assert.equal(preparedJson.task.outputFile, undefined);
    assert.equal(preparedJson.task.workspaceDir, undefined);
    assert.equal(preparedJson.task.taskDir, undefined);
    assert.equal(preparedJson.task.scriptPath, resolve(initJson.task.workspace.fileDir, "token-audit.figma.js"));
    assert.equal(preparedJson.task.resultFile, undefined);
    assert.equal(preparedJson.taskChange.changed, true);
    assert.equal(preparedJson.taskChange.previous.taskName, "settings-panel-polish");
    assert.deepEqual(preparedJson.taskChange.current, {
      taskName: "token-audit",
      inputFile: "token-audit.figma.js",
      sessionDir: initJson.task.workspace.sessionDir,
    });
    assert.equal(preparedJson.outputFiles, undefined);

    const preparedAgain = await mcpClient.callTool({
      name: "figma_workspace_prepare_task",
      arguments: {
        title: "Prepare same task",
        sessionId: "settings-workspace",
        taskName: "token-audit",
        surface: "design",
        overwrite: true,
      },
    });
    const preparedAgainJson = structuredToolResult(preparedAgain);
    assert.equal(preparedAgainJson.taskChange.changed, false);
    assert.equal(preparedAgainJson.taskChange.previous.taskName, "token-audit");
    assert.deepEqual(preparedAgainJson.taskChange.current, preparedJson.taskChange.current);

    await assert.rejects(
      mcpClient.callTool({
        name: "figma_workspace_run_script_file",
        arguments: {
          title: "Reject traversal",
          sessionId: "settings-workspace",
          inputFile: "../bad.figma.js",
        },
      }),
      /inputFile" must be a workspace-relative file name/,
    );
    await mcpClient.close();
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("figma workspace run_script_file rejects relative script paths", async () => {
  const calls = [];
  const { server } = createFigmaWorkspaceMcpServer({
    client: createFakeFigmaClient(calls, () => {
      throw new Error("unexpected upstream call");
    }),
  });
  const mcpClient = new Client(
    { name: "test-client", version: "0.1.0" },
    { capabilities: {} },
  );
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

  await server.connect(serverTransport);
  await mcpClient.connect(clientTransport);
  for (const legacyArgument of ["outputDir", "diagnosticsFile", "summaryFile"]) {
    await assert.rejects(
      mcpClient.callTool({
        name: "figma_workspace_run_script_file",
        arguments: {
          title: `Reject ${legacyArgument}`,
          scriptPath: resolve(tmpdir(), "script.figma.js"),
          [legacyArgument]: resolve(tmpdir(), `${legacyArgument}.out`),
        },
      }),
      /was removed.*Debug files are generated on demand.*diagnostics are included in outputFiles\.debugFile/su,
    );
  }
  await assert.rejects(
    mcpClient.callTool({
      name: "figma_workspace_run_script_file",
      arguments: {
        title: "Reject relative script",
        scriptPath: "relative-script.js",
      },
    }),
    /scriptPath" must be an absolute path/,
  );
  assert.deepEqual(calls.map((call) => call[0]), []);
  await mcpClient.close();
});

test("figma workspace open accepts unified file input and auto-binds a workspace", async () => {
  const repl = createFigmaWorkspaceClient({
    client: createFakeFigmaClient([], () => {
      throw new Error("unexpected upstream call");
    }),
  });
  const result = await repl.open({
    sessionId: "open-file-workspace",
    file: "https://www.figma.com/design/ExampleFigmaFileKey012/UI?node-id=1-2",
    connect: false,
  });
  assert.equal(result.ok, true);
  assert.equal(result.session.fileKey, "ExampleFigmaFileKey012");
  assert.equal(result.session.surface, "design");
  assert.match(result.session.sessionDir, /ExampleFigmaFileKey012/u);
  assert.equal(result.session.workspace, undefined);
  await repl.close();
});

test("figma workspace prepare_task creates .figma.js workspace and enforces overwrite and path rules", async () => {
  const tempDir = await mkdtemp(resolve(tmpdir(), "figma-workspace-task-"));
  const workspaceDir = resolve(tempDir, "workspace");
  const calls = [];
  const { server } = createFigmaWorkspaceMcpServer({
    client: createFakeFigmaClient(calls, () => {
      throw new Error("unexpected upstream call");
    }),
  });
  const mcpClient = new Client(
    { name: "test-client", version: "0.1.0" },
    { capabilities: {} },
  );
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

  try {
    await server.connect(serverTransport);
    await mcpClient.connect(clientTransport);

    const result = await mcpClient.callTool({
      name: "figma_workspace_prepare_task",
      arguments: {
        title: "Prepare task",
        workspaceDir,
        fileName: "settings-panel.figma.js",
        taskName: "settings-panel",
        surface: "design",
        targetPageId: "0:1",
      },
    });
    const json = structuredToolResult(result);
    assert.equal(json.ok, true);
    assert.equal(json.task.workspaceDir, undefined);
    assert.equal(json.task.taskDir, undefined);
    assert.equal(json.task.workspace.fileDir, workspaceDir);
    assert.equal(json.task.workspace.sessionDir, workspaceDir);
    assert.equal(json.task.inputFile, "settings-panel.figma.js");
    assert.equal(json.task.outputFile, undefined);
    assert.equal(json.task.scriptPath, resolve(workspaceDir, "settings-panel.figma.js"));
    assert.equal(json.task.intentSlug, undefined);
    assert.equal(json.task.resultFile, undefined);
    assert.equal(json.task.taskName, "settings-panel");
    assert.equal(json.task.taskSlug, undefined);
    assert.equal(json.task.workspace.taskName, "settings-panel");
    assert.equal(json.task.workspace.taskSlug, undefined);
    assert.equal(json.task.workspace.intentSlug, undefined);
    assert.equal(json.task.workspace.resultFile, undefined);
    assert.equal(json.outputFiles, undefined);
    assert.match(await readFile(json.task.scriptPath, "utf8"), /\$\.checkpoint/);
    assert.match(await readFile(json.task.scriptPath, "utf8"), /Task: settings-panel/);
    await assert.rejects(readFile(resolve(workspaceDir, "settings-panel.result.json"), "utf8"), /ENOENT/);

    await assert.rejects(
      mcpClient.callTool({
        name: "figma_workspace_prepare_task",
        arguments: {
          title: "Refuse overwrite",
          taskName: "settings-panel",
          workspaceDir,
        },
      }),
      /Refusing to overwrite/,
    );
    await assert.rejects(
      mcpClient.callTool({
        name: "figma_workspace_prepare_task",
        arguments: {
          taskSlug: "settings-panel",
          workspaceDir: resolve(tempDir, "legacy"),
        },
      }),
      /Tool argument "taskSlug" was removed. Use "taskName"./,
    );
    await assert.rejects(
      mcpClient.callTool({
        name: "figma_workspace_prepare_task",
        arguments: {
          title: "Reject relative workspace",
          taskName: "relative-workspace",
          workspaceDir: "relative-workspace",
        },
      }),
      /workspaceDir" must be an absolute path/,
    );
    await assert.rejects(
      mcpClient.callTool({
        name: "figma_workspace_prepare_task",
        arguments: {
          title: "Reject absolute script name",
          taskName: "absolute-script-name",
          workspaceDir: resolve(tempDir, "other"),
          fileName: resolve(tempDir, "bad.figma.js"),
        },
      }),
      /fileName" must be a file name/,
    );
    assert.deepEqual(calls.map((call) => call[0]), []);
    await mcpClient.close();
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("figma workspace guidance returns compact cards and intent routing without upstream", async () => {
  const calls = [];
  const { server } = createFigmaWorkspaceMcpServer({
    client: createFakeFigmaClient(calls, () => {
      throw new Error("unexpected upstream call");
    }),
  });
  const mcpClient = new Client(
    { name: "test-client", version: "0.1.0" },
    { capabilities: {} },
  );
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

  await server.connect(serverTransport);
  await mcpClient.connect(clientTransport);

  const cardResult = await mcpClient.callTool({
    name: "figma_workspace_guidance",
    arguments: {
      title: "Read text card",
      card: "text",
    },
  });
  const cardJson = structuredToolResult(cardResult);
  assert.equal(cardJson.ok, true);
  assert.equal(cardJson.mode, undefined);
  assert.ok(cardJson.cards.some((card) => card.id === "text.font"));
  assert.ok(cardJson.recommendedCards.includes("text.font"));
  assert.match(JSON.stringify(cardJson.cards), /loadFontAsync/);
  assert.ok(cardJson.cards.find((card) => card.id === "text.font").queryHints.some((hint) => /font/.test(hint)));
  assert.ok(cardJson.cards.find((card) => card.id === "text.font").guardrails.some((entry) => /loadFontAsync/.test(entry)));
  assert.equal(cardJson.cards.find((card) => card.id === "text.font").avoid, undefined);
  assert.ok(cardJson.guardrails.some((entry) => /loadFontAsync/.test(entry)));
  assert.equal(cardJson.avoid, undefined);
  assert.equal(cardResult.content.length, 0);

  const planResult = await mcpClient.callTool({
    name: "figma_workspace_guidance",
    arguments: {
      title: "Plan file workflow",
      mode: "plan",
      query: "settings card title button",
      surface: "design",
      workflow: "script-file",
    },
  });
  const planJson = structuredToolResult(planResult);
  assert.equal(planJson.ok, true);
  assert.equal(planJson.mode, undefined);
  assert.equal(planJson.workflow.primaryTool, "figma_workspace_run_script_file");
  assert.ok(planJson.steps.some((step) => /figma_workspace_prepare_task/.test(step)));
  assert.ok(planJson.recommendedTools.includes("figma_workspace_prepare_task"));
  assert.ok(planJson.recommendedTools.includes("figma_workspace_guidance"));
  assert.ok(planJson.suggestedCards.length > 0);
  assert.ok(planJson.helperProfiles.some((profile) => profile.helper === "text"));
  assert.ok(planJson.helperProfiles.some((profile) => profile.allowedPatterns.some((pattern) => /\$\.text/.test(pattern))));
  assert.ok(planJson.wrapperProfiles.some((profile) => profile.tool === "figma_workspace_get_design_context"));
  assert.ok(planJson.workflowGraph.some((workflow) => workflow.id === "design-implementation-context"));

  const longPlanResult = await mcpClient.callTool({
    name: "figma_workspace_guidance",
    arguments: {
      title: "Plan long task",
      mode: "plan",
      query: `settings card title button ${"polished layout details ".repeat(8)}`,
      surface: "design",
    },
  });
  const longPlanJson = structuredToolResult(longPlanResult);
  assert.equal(longPlanJson.ok, true);
  assert.equal(longPlanJson.mode, undefined);
  assert.ok(longPlanJson.suggestedCards.length > 0);

  const suggestResult = await mcpClient.callTool({
    name: "figma_workspace_guidance",
    arguments: {
      title: "Suggest API",
      query: "component variants text",
      surface: "design",
    },
  });
  const suggestJson = structuredToolResult(suggestResult);
  assert.equal(suggestJson.ok, true);
  assert.equal(suggestJson.mode, undefined);
  assert.equal(Object.hasOwn(suggestJson, "intent"), false);
  assert.equal(Object.hasOwn(suggestJson, "cardQuery"), false);
  assert.equal(Object.hasOwn(suggestJson, "expectedSurface"), false);
  assert.ok(suggestJson.recommendedCards.includes("components.variants"));
  assert.ok(suggestJson.suggestions.cards.some((card) => card.id === "components.variants"));
  assert.ok(suggestJson.suggestions.recommendedCards.includes("components.variants"));
  assert.ok(suggestJson.suggestions.queryHints.some((hint) => /component/.test(hint)));
  assert.ok(suggestJson.suggestions.apiSymbols.includes("figma.combineAsVariants"));
  assert.ok(suggestJson.suggestions.guardrails.some((entry) => /non-component/.test(entry)));
  assert.equal(suggestJson.suggestions.avoid, undefined);
  assert.equal(suggestJson.suggestions.matchType, "api-card");
  assert.equal(suggestJson.suggestions.confidence, "high");
  assert.ok(suggestJson.suggestions.referenceContext.length > 0);
  assert.ok(suggestJson.suggestions.referenceContext.every((item) => ["exact-symbol", "phrase", "token"].includes(item.matchType)));
  assert.ok(suggestJson.suggestions.referenceContext.every((item) => item.snippet.split("\n").length <= 4));
  assert.equal(suggestJson.suggestions.workflow.primaryTool, "figma_workspace_run_script_file");
  assert.ok(suggestJson.helperProfiles.some((profile) => profile.helper === "text"));
  assert.ok(suggestJson.helperProfiles.some((profile) => profile.forbiddenPatterns.some((pattern) => /\$\[name\]/.test(pattern))));
  assert.ok(suggestJson.wrapperProfiles.length > 0);
  assert.ok(suggestJson.workflowGraph.length > 0);

  const longTaskResult = await mcpClient.callTool({
    name: "figma_workspace_guidance",
    arguments: {
      title: "Suggest long task",
      query: `component variants text ${"polish interaction states ".repeat(8)}`,
      surface: "design",
    },
  });
  const longTaskJson = structuredToolResult(longTaskResult);
  assert.equal(longTaskJson.ok, true);
  assert.equal(longTaskJson.mode, undefined);
  assert.ok(longTaskJson.recommendedCards.includes("components.variants"));
  assert.ok(longTaskJson.suggestions.apiSymbols.includes("figma.combineAsVariants"));

  const commonTaskExpectations = [
    ["color variable button fill", "variables.bind", "VariablesAPI.setBoundVariableForPaint"],
    ["instance properties button variant", "instances.properties", "InstanceNode.setProperties"],
    ["generated PNG image fills capture QA", "images.fill", "figma.createImage"],
    ["FigJam sticky notes arrows", "surface.figjam", "figma.createSticky"],
    ["Slides deck slide rows", "surface.slides", "figma.createSlide"],
  ];
  for (const [query, expectedCard, expectedSymbol] of commonTaskExpectations) {
    const commonResult = await mcpClient.callTool({
      name: "figma_workspace_guidance",
      arguments: {
        title: `Suggest ${expectedCard}`,
        query,
        maxCards: 3,
      },
    });
    const commonJson = structuredToolResult(commonResult);
    assert.ok(commonJson.suggestions.recommendedCards.includes(expectedCard));
    assert.ok(commonJson.suggestions.apiSymbols.includes(expectedSymbol));
    assert.ok(commonJson.suggestions.queryHints.length > 0);
    assert.ok(commonJson.suggestions.guardrails.length > 0);
    assert.ok(commonJson.helperProfiles.length > 0);
    assert.equal(commonJson.suggestions.avoid, undefined);
  }

  const helperGuidanceExpectations = [
    ["large png image asset manifest upload", "assets", /asset manifest/],
    ["screenshot capture visual qa", "capture", /screenshot/],
    ["clone existing node replace generated frame", "clone", /replaceGeneratedFrame/],
    ["checkpoint remember handle repair", "repair", /checkpoint/],
  ];
  for (const [query, expectedProfile, expectedText] of helperGuidanceExpectations) {
    const helperResult = await mcpClient.callTool({
      name: "figma_workspace_guidance",
      arguments: {
        title: `Suggest helper ${expectedProfile}`,
        query,
        maxCards: 3,
      },
    });
    const helperJson = structuredToolResult(helperResult);
    const profile = helperJson.helperProfiles.find((entry) => entry.helper === expectedProfile);
    assert.ok(profile);
    assert.match(JSON.stringify(profile), expectedText);
    assert.ok(profile.allowedPatterns.length > 0);
    assert.ok(profile.forbiddenPatterns.some((pattern) => /\$/.test(pattern)));
  }

  const upstreamAgentGuidanceExpectations = [
    [
      "implement selected Figma node production code visual parity",
      "implementation.figma-to-code",
      "get_design_context",
      /figma_workspace_get_design_context/,
    ],
    [
      "implement animation motion keyframes export video",
      "implementation.motion",
      "get_motion_context",
      /figma_workspace_get_motion_context/,
    ],
    [
      "design parity review screenshot spacing typography regression",
      "review.design-parity",
      "figma_workspace_capture_node",
      /screenshot or design context/,
    ],
    [
      "Code Connect template published component mapping",
      "code.connect",
      "get_code_connect_map",
      /ambiguous component targets/,
    ],
  ];
  for (const [query, expectedCard, expectedSymbol, expectedGuardrail] of upstreamAgentGuidanceExpectations) {
    const upstreamAgentResult = await mcpClient.callTool({
      name: "figma_workspace_guidance",
      arguments: {
        title: `Suggest ${expectedCard}`,
        query,
        maxCards: 4,
      },
    });
    const upstreamAgentJson = structuredToolResult(upstreamAgentResult);
    assert.ok(upstreamAgentJson.recommendedCards.includes(expectedCard));
    assert.ok(upstreamAgentJson.suggestions.recommendedCards.includes(expectedCard));
    assert.ok(upstreamAgentJson.suggestions.apiSymbols.includes(expectedSymbol));
    assert.match(JSON.stringify(upstreamAgentJson.suggestions.cards), expectedGuardrail);
    if (expectedSymbol === "get_design_context") {
      assert.ok(upstreamAgentJson.wrapperProfiles.some((profile) => profile.tool === "figma_workspace_get_design_context"));
    }
    if (expectedSymbol === "get_motion_context") {
      assert.ok(upstreamAgentJson.wrapperProfiles.some((profile) => profile.tool === "figma_workspace_get_motion_context"));
      assert.ok(upstreamAgentJson.workflowGraph.some((workflow) => workflow.id === "motion-implementation"));
    }
  }
  assert.deepEqual(calls.map((call) => call[0]), []);
  await mcpClient.close();
});

test("figma workspace inspect mode=style returns compact visual token audit", async () => {
  const calls = [];
  const fakeClient = createFakeFigmaClient(calls, ({ args }) => {
    assert.match(args.code, /__colorCounts/);
    assert.match(args.code, /textStyles/);
    assert.match(args.code, /imageNodes/);
    assert.doesNotMatch(args.code, /\$\.create = async function create/);
    assert.doesNotMatch(args.code, /\$\.checkpoint = async function checkpoint/);
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify({
            ok: true,
            result: {
              target: "94:2",
              mode: "style",
              nodeCount: 12,
              summary: { id: "94:2", type: "FRAME", name: "Panel" },
              style: {
                topColors: [{ color: "#101820", count: 4 }],
                textStyles: [{ id: "94:6", name: "Title", fontSize: 32 }],
                imageNodes: [{ id: "94:45", name: "Asset", type: "RECTANGLE" }],
                strokes: [{ id: "94:12", name: "Panel", strokeWeight: 1 }],
                effects: [],
                caps: { topColors: 16, textStyles: 24, imageNodes: 20, strokes: 24, effects: 16 },
              },
            },
          }),
        },
      ],
    };
  });
  const { server } = createFigmaWorkspaceMcpServer({ client: fakeClient });
  const mcpClient = new Client(
    { name: "test-client", version: "0.1.0" },
    { capabilities: {} },
  );
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

  await server.connect(serverTransport);
  await mcpClient.connect(clientTransport);
  const result = await mcpClient.callTool({
    name: "figma_workspace_inspect",
    arguments: {
      title: "Inspect style",
      sessionId: "style",
      mode: "style",
      target: "94:2",
    },
  });
  const json = structuredToolResult(result);
  assert.equal(json.ok, true);
  assert.equal(json.upstream, undefined);
  assert.equal(json.primaryFix, undefined);
  assert.equal(json.mode, "style");
  assert.equal(json.style.topColors[0].color, "#101820");
  assert.equal(json.style.textStyles.length, 1);
  assert.equal(json.style.imageNodes.length, 1);
  assert.deepEqual(calls.map((call) => call[0]), ["connect", "listTools", "callTool"]);
  await mcpClient.close();
});

test("figma workspace inspect failures return upstreamError without upstream wrapper fields", async () => {
  const calls = [];
  const fakeClient = createFakeFigmaClient(calls, ({ args }) => {
    assert.match(args.code, /summarizeNode/);
    return {
      content: [{
        type: "text",
        text: JSON.stringify({ ok: false, error: { message: "inspect failed", code: "INSPECT_FAILED" } }),
      }],
    };
  });
  const { server } = createFigmaWorkspaceMcpServer({ client: fakeClient });
  const mcpClient = new Client(
    { name: "test-client", version: "0.1.0" },
    { capabilities: {} },
  );
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

  await server.connect(serverTransport);
  await mcpClient.connect(clientTransport);
  const result = await mcpClient.callTool({
    name: "figma_workspace_inspect",
    arguments: {
      title: "Inspect failure",
      sessionId: "inspect-failure",
      target: "$selection",
    },
  });
  const json = structuredToolResult(result);
  assert.equal(json.ok, false);
  assert.equal(json.upstream, undefined);
  assert.equal(json.primaryFix, undefined);
  assert.equal(json.upstreamError.code, "INSPECT_FAILED");
  assert.deepEqual(calls.map((call) => call[0]), ["connect", "listTools", "callTool"]);
  await mcpClient.close();
});

test("figma workspace inspect mode=validate reports valid, missing, and stale", async () => {
  const calls = [];
  const fakeClient = createFakeFigmaClient(calls, ({ args }) => {
    assert.match(args.code, /__requestedHandles/);
    assert.doesNotMatch(args.code, /\$\.create = async function create/);
    assert.doesNotMatch(args.code, /\$\.checkpoint = async function checkpoint/);
    assert.doesNotMatch(args.code, /const __figmaReplEvalCheckpoints = \[\]/);
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify({
            ok: true,
            result: {
              validations: [
                { handle: "$valid", status: "valid", id: "10:1", type: "FRAME", name: "Valid" },
                { handle: "$missing", status: "missing" },
                { handle: "$stale", status: "stale", error: "Figma node not found: 10:2" },
              ],
              validatedNodeIds: ["10:1"],
            },
          }),
        },
      ],
    };
  });
  const { server } = createFigmaWorkspaceMcpServer({ client: fakeClient });
  const mcpClient = new Client(
    { name: "test-client", version: "0.1.0" },
    { capabilities: {} },
  );
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

  await server.connect(serverTransport);
  await mcpClient.connect(clientTransport);
  await mcpClient.callTool({
    name: "figma_workspace_open",
    arguments: {
      title: "Open session",
      sessionId: "main",
      connect: false,
      handles: {
        "$valid": "10:1",
        "$stale": "10:2",
      },
    },
  });
  const result = await mcpClient.callTool({
    name: "figma_workspace_inspect",
    arguments: {
      title: "Validate handles",
      sessionId: "main",
      mode: "validate",
      handles: ["$valid", "$missing", "$stale"],
    },
  });
  const json = structuredToolResult(result);
  assert.deepEqual(
    json.validations.map((item) => item.status),
    ["valid", "missing", "stale"],
  );
  assert.equal(json.upstream, undefined);
  assert.equal(json.primaryFix, undefined);
  assert.equal(json.result, undefined);
  assert.equal(json.text, undefined);
  assert.deepEqual(calls.map((call) => call[0]), ["connect", "listTools", "callTool"]);
  await mcpClient.close();
});

test("figma workspace programmatic client accepts an absolute OAuth cache path", async () => {
  const oauthCachePath = resolve(packageRoot, "test-oauth-cache.json");
  const repl = createFigmaWorkspaceClient({
    oauthCachePath,
    openBrowser: false,
  });

  assert.equal(repl.client.config.statePath, oauthCachePath);
  assert.throws(
    () => createFigmaWorkspaceClient({ oauthCachePath: "relative-oauth-cache.json" }),
    /absolute path/,
  );

  await repl.close();
});

test("figma workspace programmatic client sends fixed eval description without MCP transport", async () => {
  const calls = [];
  const fakeClient = createFakeFigmaClient(calls, ({ args }) => {
    assert.equal(typeof args.code, "string");
    assert.equal(args.fileKey, "ExampleFigmaFileKey012");
    assert.equal(args.description, "Figma Workspace JavaScript execution");
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify({
            ok: true,
            __figmaRepl: { sessionId: "main", handles: {} },
            result: {
              summary: "read current page",
            },
          }),
        },
      ],
    };
  });

  const repl = createFigmaWorkspaceClient({ client: fakeClient });
  await repl.open({
    sessionId: "main",
    file: "https://www.figma.com/design/ExampleFigmaFileKey012/UI?node-id=1-2",
    connect: false,
  });
  const result = await repl.eval({
    sessionId: "main",
    code: "return { summary: figma.currentPage.name };",
    mode: "read",
  });

  assert.equal(result.ok, true);
  assert.equal(result.upstreamTool, undefined);
  assert.equal(result.upstreamArgument, undefined);
  assert.equal(result.upstream.result.summary, "read current page");
  assert.equal(result.upstream.result.__figmaRepl, undefined);
  assert.equal(result.upstream.result.result, undefined);
  assert.equal(result.result, undefined);
  assert.equal(result.text, undefined);
  assert.deepEqual(calls.map((call) => call[0]), ["connect", "listTools", "callTool"]);
});

test("figma workspace eval sends fixed upstream description when official schema requires it", async () => {
  const calls = [];
  const fakeClient = createFakeFigmaClient(
    calls,
    ({ args }) => {
      assert.equal(typeof args.code, "string");
      assert.equal(args.fileKey, "ExampleFigmaFileKey012");
      assert.equal(args.description, "Figma Workspace JavaScript execution");
      assert.notEqual(args.description, "User-visible title only");
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              ok: true,
              __figmaRepl: { sessionId: "main", handles: {} },
              result: {
                summary: "description accepted",
              },
            }),
          },
        ],
      };
    },
    {
      tools: [
        {
          name: "use_figma",
          description: "Execute JavaScript in the active Figma file.",
          inputSchema: {
            type: "object",
            properties: {
              code: { type: "string" },
              description: { type: "string" },
            },
            required: ["code", "description"],
          },
        },
      ],
    },
  );

  const repl = createFigmaWorkspaceClient({ client: fakeClient });
  await repl.open({
    sessionId: "main",
    file: "https://www.figma.com/design/ExampleFigmaFileKey012/UI?node-id=1-2",
    connect: false,
  });
  const result = await repl.eval({
    sessionId: "main",
    title: "User-visible title only",
    code: "return { summary: figma.currentPage.name };",
    mode: "read",
  });

  assert.equal(result.ok, true);
  assert.equal(result.upstream.result.summary, "description accepted");
  assert.deepEqual(calls.map((call) => call[0]), ["connect", "listTools", "callTool"]);
});

test("figma workspace programmatic client returns typed output contracts", async () => {
  const tempDir = await mkdtemp(resolve(tmpdir(), "figma-workspace-mcp-client-typed-"));
  const scriptPath = resolve(tempDir, "typed-client.figma.js");
  const assetPath = resolve(tempDir, "asset.png");
  const capturePath = resolve(tempDir, "capture.png");
  const plannedCapturePath = resolve(tempDir, "capture.png");
  const workspaceDir = resolve(tempDir, "task");
  await writeFile(scriptPath, "return { summary: 'typed script' };", "utf8");
  await writeFile(assetPath, "fake asset bytes", "utf8");
  const calls = [];
  const fakeClient = createFakeFigmaClient(
    calls,
    ({ name, args }) => {
      if (name === "fake_upstream") {
        assert.deepEqual(args, { marker: "typed" });
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                ok: true,
                result: {
                  summary: "typed upstream",
                },
              }),
            },
          ],
        };
      }
      if (name === "use_figma") {
        assert.match(args.code, /typed script/);
        return {
          content: [{ type: "text", text: JSON.stringify({ result: { summary: "typed script" } }) }],
        };
      }
      if (name === "search_design_system") {
        assert.deepEqual(args, { fileKey: "file123", query: "typed" });
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({ ok: true, results: [{ name: "Typed Button" }] }),
            },
          ],
        };
      }
      if (name === "get_libraries") {
        assert.deepEqual(args, { fileKey: "file123" });
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({ libraries: [{ name: "Typed Library" }] }),
            },
          ],
        };
      }
      if (name === "get_variable_defs") {
        assert.deepEqual(args, {
          fileKey: "file123",
          nodeId: "12:36",
          clientLanguages: "unknown",
          clientFrameworks: "unknown",
        });
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({ ok: true, variables: [{ name: "typed.color" }] }),
            },
          ],
        };
      }
      if (name === "upload_assets") {
        assert.deepEqual(args, {
          fileKey: "file123",
          count: 1,
          nodeId: "12:34",
          scaleMode: "FILL",
        });
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({ ok: true, result: { summary: "asset filled" } }),
            },
          ],
        };
      }
      if (name === "get_screenshot") {
        assert.deepEqual(args, { fileKey: "file123", nodeId: "12:35" });
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                ok: false,
                error: {
                  code: "CAPTURE_FAILED",
                  message: "Capture failed before writing.",
                },
              }),
            },
          ],
        };
      }
      assert.fail(`unexpected tool ${name}`);
      return {
        content: [],
      };
    },
    {
      tools: [
        { name: "use_figma", inputSchema: { type: "object", properties: { code: { type: "string" } }, required: ["code"] } },
        { name: "fake_upstream", inputSchema: { type: "object", properties: {} } },
        { name: "search_design_system", inputSchema: { type: "object", properties: { fileKey: { type: "string" }, query: { type: "string" } } } },
        { name: "get_libraries", inputSchema: { type: "object", properties: { fileKey: { type: "string" } } } },
        { name: "get_variable_defs", inputSchema: { type: "object", properties: { fileKey: { type: "string" }, nodeId: { type: "string" }, clientLanguages: { type: "string" }, clientFrameworks: { type: "string" } } } },
        { name: "upload_assets", inputSchema: { type: "object", properties: { fileKey: { type: "string" }, count: { type: "number" }, nodeId: { type: "string" }, scaleMode: { type: "string" } } } },
        { name: "get_screenshot", inputSchema: { type: "object", properties: { fileKey: { type: "string" }, nodeId: { type: "string" } }, required: ["fileKey", "nodeId"] } },
      ],
    },
  );
  const repl = createFigmaWorkspaceClient({ client: fakeClient });

  try {
    const scriptResult = await repl.runScriptFile({
      scriptPath,
    });
    assert.equal(scriptResult.ok, true);
    assert.equal(scriptResult.phase, "execute");
    assert.equal(scriptResult.executed, true);
    assert.equal("content" in scriptResult, false);
    assert.equal(scriptResult.script.injectedHelpers, undefined);
    assert.equal(scriptResult.verbose, undefined);

    const upstreamResult = await repl.callUpstreamTool({
      toolName: "fake_upstream",
      arguments: { marker: "typed" },
    });
    assert.equal(upstreamResult.ok, true);
    assert.equal(upstreamResult.upstream.result.result.summary, "typed upstream");
    assert.equal(upstreamResult.result, undefined);
    assert.equal(upstreamResult.text, undefined);
    assert.equal("content" in upstreamResult, false);
    assert.equal(upstreamResult.verbose, undefined);

    const openResult = await repl.open({
      sessionId: "typed",
      connect: false,
      file: "https://www.figma.com/design/file123/Test",
    });
    assert.equal(openResult.session.slug, undefined);
    assert.equal(openResult.session.label, undefined);
    assert.equal(openResult.session.knownPages, undefined);
    assert.equal(openResult.session.handles, undefined);
    assert.deepEqual(openResult.session.handleChanges, { updated: [], removed: [] });
    assert.match(openResult.session.sessionDir, /file123/u);
    assert.equal(openResult.session.workspace, undefined);
    assert.equal(openResult.verbose, undefined);

    const searchResult = await repl.searchDesignSystem({
      sessionId: "typed",
      query: "typed",
    });
    assert.equal(searchResult.ok, true);
    assert.equal(searchResult.upstream.result.results[0].name, "Typed Button");
    assert.equal(searchResult.result, undefined);
    assert.equal(searchResult.text, undefined);
    assert.equal("content" in searchResult, false);
    assert.equal(searchResult.verbose, undefined);

    const librariesResult = await repl.getLibraries({
      sessionId: "typed",
    });
    assert.equal(librariesResult.ok, true);
    assert.equal(librariesResult.upstream.result.libraries[0].name, "Typed Library");
    assert.equal(librariesResult.result, undefined);
    assert.equal(librariesResult.text, undefined);

    const variableDefsResult = await repl.getVariableDefs({
      sessionId: "typed",
      target: "12:36",
    });
    assert.equal(variableDefsResult.ok, true);
    assert.equal(variableDefsResult.nodeId, "12:36");
    assert.equal(variableDefsResult.upstream.result.variables[0].name, "typed.color");
    assert.equal(variableDefsResult.result, undefined);
    assert.equal(variableDefsResult.text, undefined);

    const assetResult = await repl.applyAssetManifest({
      sessionId: "typed",
      assets: [{ path: assetPath, target: "12:34", name: "Asset" }],
      validateTargets: false,
    });
    assert.equal(assetResult.ok, true);
    assert.equal(assetResult.assets[0].upstreamSummary, undefined);
    assert.equal(assetResult.assets[0].toolName, undefined);
    assert.equal(assetResult.assets[0].upload, undefined);
    assert.equal(assetResult.assets[0].upstreamError, undefined);
    assert.equal(assetResult.assets[0].arguments, undefined);
    assert.equal(assetResult.assets[0].result, undefined);
    assert.equal(assetResult.assets[0].upstream, undefined);
    assert.equal(assetResult.verbose, undefined);

    const captureResult = await repl.captureNode({
      sessionId: "typed",
      target: "12:35",
      imageFile: capturePath,
    });
    assert.equal(captureResult.ok, false);
    assert.equal(captureResult.imageFile, undefined);
    assert.equal(captureResult.plannedOutputFile, undefined);
    assert.equal(captureResult.upstream, undefined);
    assert.equal(captureResult.upstreamError.code, "CAPTURE_FAILED");
    assert.equal(captureResult.upstreamError.parsed, undefined);
    assert.equal(captureResult.upstreamError.text, undefined);
    assert.equal(captureResult.verbose, undefined);
    await assert.rejects(
      readFile(plannedCapturePath, "utf8"),
      /ENOENT/,
    );

    const preparedResult = await repl.prepareTask({
      workspaceDir,
      fileName: "typed-task.figma.js",
      taskName: "typed-task",
    });
    assert.equal(preparedResult.ok, true);
    assert.equal(preparedResult.task.taskName, "typed-task");
    assert.equal(preparedResult.task.taskSlug, undefined);
    assert.equal(preparedResult.task.intentSlug, undefined);
    assert.equal(preparedResult.task.inputFile, "typed-task.figma.js");
    assert.equal(preparedResult.task.outputFile, undefined);
    assert.equal(preparedResult.task.workspace.fileDir, workspaceDir);
    assert.equal(preparedResult.task.workspace.files.inputFile, "typed-task.figma.js");
    assert.equal(preparedResult.task.workspace.files.outputFile, undefined);
    assert.equal(preparedResult.task.resultFile, undefined);
    assert.equal(preparedResult.outputFiles, undefined);
    assert.equal(preparedResult.task.workspaceDir, undefined);
    assert.equal(preparedResult.task.taskDir, undefined);
    assert.equal(preparedResult.session.sessionDir, workspaceDir);
    assert.equal(preparedResult.session.workspace, undefined);
    assert.equal(preparedResult.verbose, undefined);

    assert.deepEqual(calls.map((call) => call[0]), ["connect", "listTools", "callTool", "callTool", "callTool", "callTool", "callTool", "callTool", "callTool"]);
  } finally {
    await repl.close();
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("node-upstream-client entrypoint exports workspace and remote clients in constrained globals", async () => {
  const nodeRepl = await import("../dist/upstream/node-upstream-client.js");
  assert.equal(typeof nodeRepl.createRemoteMcpClient, "function");
  assert.equal(typeof nodeRepl.createFigmaWorkspaceClient, "function");

  const fakeClient = createFakeFigmaClient([], () => {
    throw new Error("unexpected upstream call");
  });
  const repl = nodeRepl.createFigmaWorkspaceClient({ client: fakeClient });
  assert.equal(repl.client, fakeClient);
  assert.equal(typeof repl.open, "function");
  await repl.open({
    sessionId: "node-upstream-client-fake",
    file: "https://www.figma.com/design/ExampleFigmaFileKey012/UI?node-id=1-2",
    connect: false,
  });
  await repl.close();

  const nodeReplPath = resolve(packageRoot, "dist/upstream/node-upstream-client.js");
  const result = await runNodeScript(`
    const { pathToFileURL } = await import("node:url");
    const nodeReplUrl = pathToFileURL(${JSON.stringify(nodeReplPath)}).href;
    Reflect.deleteProperty(globalThis, "TransformStream");
    Reflect.deleteProperty(globalThis, "WritableStream");
    Reflect.deleteProperty(globalThis, "process");
    if (typeof globalThis.process !== "undefined") {
      Object.defineProperty(globalThis, "process", {
        value: undefined,
        configurable: true,
        writable: true,
      });
    }
    const mod = await import(nodeReplUrl);
    if (typeof mod.createRemoteMcpClient !== "function") throw new Error("missing createRemoteMcpClient");
    if (typeof mod.createFigmaWorkspaceClient !== "function") throw new Error("missing createFigmaWorkspaceClient");
    if (typeof globalThis.TransformStream !== "function") throw new Error("missing TransformStream global");
    if (typeof globalThis.WritableStream !== "function") throw new Error("missing WritableStream global");
    const remote = mod.createRemoteMcpClient();
    if (!remote) throw new Error("explicit remote client was not constructed");
    await remote.close();
    const defaultRepl = mod.createFigmaWorkspaceClient({
      oauthCachePath: "C:/Users/example/.codex/.figma-workspace-oauth.json",
    });
    if (!defaultRepl.client) throw new Error("default workspace client was not constructed");
    if (defaultRepl.client.constructor?.name === "RemoteMcpClient") {
      throw new Error("node-upstream-client default workspace client used the SDK remote client");
    }
    await defaultRepl.open({
      sessionId: "node-upstream-client-default",
      file: "https://www.figma.com/design/ExampleFigmaFileKey012/UI?node-id=1-2",
      connect: false,
    });
    let rejected = false;
    try {
      await defaultRepl.connect();
    } catch (error) {
      rejected = true;
      if (!String(error?.message ?? error).includes("pass an explicit { client }")) {
        throw error;
      }
    }
    if (!rejected) throw new Error("node-upstream-client default upstream client did not reject live connect");
    await defaultRepl.close();
    const fakeClient = {
      async connect() {},
      async close() {},
      async listTools() { return { tools: [] }; },
      async callTool() { throw new Error("unexpected upstream call"); },
      async listResources() { return { resources: [] }; },
      async readResource(uri) { return { contents: [{ uri, mimeType: "text/plain", text: "" }] }; },
    };
    const repl = mod.createFigmaWorkspaceClient({ client: fakeClient });
    if (repl.client !== fakeClient) throw new Error("fake upstream client was not preserved");
    console.log("ok");
  `);

  assert.equal(result.code, 0);
  assert.equal(result.signal, null);
  assert.equal(result.stdout.trim(), "ok");
  assert.equal(result.stderr, "");
});

test("workspace cleanup treats message-only ENOENT as a missing file", () => {
  const codeOnlyError = new Error("unlink failed");
  codeOnlyError.code = "ENOENT";
  const messageOnlyError = new Error("ENOENT: no such file or directory, unlink 'script.failure.compiled.js'");
  const accessError = new Error("EACCES: permission denied, unlink 'script.failure.compiled.js'");

  assert.equal(isFigmaWorkspaceMissingFileErrorForTesting(codeOnlyError), true);
  assert.equal(isFigmaWorkspaceMissingFileErrorForTesting(messageOnlyError), true);
  assert.equal(isFigmaWorkspaceMissingFileErrorForTesting(accessError), false);
});

test("figma workspace stdio CLI exits cleanly when stdin ends", async () => {
  const result = await runCliWithClosedStdin("dist/mcp/workspace-mcp-stdio-bin.js");

  assert.equal(result.code, 0);
  assert.equal(result.signal, null);
  assert.equal(result.stdout, "");
  assert.equal(result.stderr, "");
});

test("figma workspace stdio CLI completes initialize and lists local tools", async () => {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ["dist/mcp/workspace-mcp-stdio-bin.js"],
    cwd: packageRoot,
  });
  const client = new Client(
    { name: "test-client", version: "0.1.0" },
    { capabilities: {} },
  );

  try {
    await client.connect(transport);
    const result = await client.listTools();
    assert.ok(result.tools.some((tool) => tool.name === "figma_workspace_capture_node"));
  } finally {
    await client.close().catch(() => undefined);
  }
});

function createFakeFigmaClient(calls, callToolImpl, options = {}) {
  let connected = false;
  const tools = options.tools ?? [
    {
      name: "use_figma",
      description: "Execute JavaScript in the active Figma file.",
      inputSchema: {
        type: "object",
        properties: {
          code: { type: "string" },
        },
        required: ["code"],
      },
    },
  ];
  return {
    async connect() {
      if (!connected) {
        connected = true;
        calls.push(["connect"]);
      }
    },
    async close() {
      calls.push(["close"]);
    },
    async listTools() {
      calls.push(["listTools"]);
      return {
        tools,
      };
    },
    async callTool(name, args) {
      calls.push(["callTool", name, args]);
      return callToolImpl({ name, args });
    },
    async listResources() {
      return { resources: [] };
    },
    async readResource(uri) {
      return { contents: [{ uri, mimeType: "text/plain", text: "" }] };
    },
  };
}

function runCliWithClosedStdin(script) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [script], {
      cwd: packageRoot,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    const timeout = setTimeout(() => {
      child.kill();
      reject(new Error(`${script} did not exit after stdin closed`));
    }, 5000);

    child.stdout.on("data", (data) => {
      stdout += data;
    });
    child.stderr.on("data", (data) => {
      stderr += data;
    });
    child.on("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.on("exit", (code, signal) => {
      clearTimeout(timeout);
      resolve({ code, signal, stdout, stderr });
    });
    child.stdin.end();
  });
}

function runNodeScript(script) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--input-type=module", "-e", script], {
      cwd: packageRoot,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    const timeout = setTimeout(() => {
      child.kill();
      reject(new Error("node script did not exit"));
    }, 5000);

    child.stdout.on("data", (data) => {
      stdout += data;
    });
    child.stderr.on("data", (data) => {
      stderr += data;
    });
    child.on("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.on("exit", (code, signal) => {
      clearTimeout(timeout);
      resolve({ code, signal, stdout, stderr });
    });
  });
}
