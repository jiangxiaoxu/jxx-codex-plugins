import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
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
  RemoteMcpOAuthError,
} from "../dist/mcp/index.js";
import {
  FIGMA_WORKSPACE_INTERNAL_WRAPPER_CONTRACTS,
  FIGMA_WORKSPACE_EVAL_COMMON_HELPER_NAMES,
  buildFigmaEvalScript,
  createFigmaWorkspaceSessionStore,
  isFigmaWorkspaceMissingFileErrorForTesting,
  resolveFigmaWorkspaceScriptHelperSelection,
} from "../dist/mcp/workspace-mcp-server.js";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const upstreamContractSnapshot = JSON.parse(
  await readFile(resolve(packageRoot, "tests/fixtures/upstream-contract-snapshot.json"), "utf8"),
);
const expectedStaticResourceUris = [
  "figma-workspace://capabilities",
  "figma-workspace://diagnostics",
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
  "figma-workspace://runtime",
  "figma-workspace://safety",
  "figma-workspace://scripts",
  "figma-workspace://workflow-tools",
];
const queryOutputFields = [
  "recommendedCards",
  "queryHints",
  "apiSymbols",
  "guardrails",
  "suggestions.referenceContext",
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
const removedDollarHelperTerms = ["$.create", "$.layout", "$.find", "$.findAll"];

function dollarHelperTermPattern(term) {
  return new RegExp(`${term.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")}(?![A-Za-z0-9_])`, "u");
}

function structuredToolResult(result) {
  assert.ok(result.structuredContent);
  const content = Array.isArray(result.content) ? result.content : [];
  assert.equal(content.some((item) => item?.type === "text"), false);
  return result.structuredContent;
}

function requiredBranches(schema) {
  return (schema.anyOf ?? [])
    .map((branch) => branch.required ?? [])
    .map((required) => [...required].sort());
}

function inputSchemaProperties(schema) {
  return Object.keys(schema?.properties ?? {}).sort();
}

function inputSchemaRequiredProperties(schema) {
  return [...(schema?.required ?? [])].filter((property) => typeof property === "string").sort();
}

function inputSchemaHasProperty(schema, property) {
  if (!schema || typeof schema !== "object") {
    return false;
  }
  if (Object.hasOwn(schema.properties ?? {}, property)) {
    return true;
  }
  if (schema.items && inputSchemaHasProperty(schema.items, property)) {
    return true;
  }
  const nestedSchemas = [
    ...Object.values(schema.properties ?? {}),
    ...(schema.anyOf ?? []),
    ...(schema.oneOf ?? []),
    ...(schema.allOf ?? []),
  ];
  return nestedSchemas.some((item) => inputSchemaHasProperty(item, property));
}

function topLevelInputSchemaHasProperty(schema, property) {
  return Object.hasOwn(schema?.properties ?? {}, property);
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

async function readPublicFigmaWorkspaceContractTexts() {
  const roots = [
    resolve(packageRoot, "../README.md"),
    resolve(packageRoot, "README.md"),
    resolve(packageRoot, "../skills/figma-workspace"),
    resolve(packageRoot, "src/runtime/guidance-catalog.ts"),
    resolve(packageRoot, "src/contract/tool-metadata.ts"),
    resolve(packageRoot, "src/mcp/workspace-mcp-server.ts"),
    resolve(packageRoot, "../../../doc/figma-workspace-ai-agent-development.md"),
  ];
  const files = [];
  async function collectTextFiles(path) {
    const normalizedPath = path.replace(/\\/gu, "/");
    if (normalizedPath.includes("/upstream-corpus/")) return;
    if (/\.(md|ya?ml|ts)$/u.test(path)) {
      files.push(path);
      return;
    }
    const entries = await readdir(path, { withFileTypes: true });
    for (const entry of entries) {
      const childPath = resolve(path, entry.name);
      if (entry.isDirectory()) {
        await collectTextFiles(childPath);
      } else if (entry.isFile() && /\.(md|ya?ml|ts)$/u.test(entry.name)) {
        files.push(childPath);
      }
    }
  }
  for (const root of roots) await collectTextFiles(root);
  return Promise.all(files.map(async (path) => ({ path, text: await readFile(path, "utf8") })));
}

async function openTestWorkspace(mcpClient, { tempDir, sessionId = "default" }) {
  await mcpClient.callTool({
    name: "figma_workspace_open",
    arguments: {
      title: "Open test workspace",
      sessionId,
      file: "https://www.figma.com/design/ExampleFigmaFileKey012/UI?node-id=1-2",
      workspaceDir: tempDir,
      connect: false,
    },
  });
  const fileDir = resolve(tempDir, "ExampleFigmaFileKey012");
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
  assert.equal(sessionListEntry?.description, "Read when you need compact state, handle counts/previews, and workspace file context for this specific active workspace session.");
  assert.equal(sessionListEntry?.mimeType, "application/json");
  const sessionHandlesEntry = sessionResources.resources.find((resource) => resource.uri === "figma-workspace://sessions/main/handles");
  assert.equal(sessionHandlesEntry?.description, "Read when you need the full remembered handle map for this specific active workspace session.");
  assert.equal(sessionHandlesEntry?.mimeType, "application/json");

  const sessionsResource = await mcpClient.readResource({ uri: "figma-workspace://sessions" });
  const sessionsJson = JSON.parse(sessionsResource.contents[0].text);
  assert.deepEqual(sessionsJson, { sessions: [{ id: "main", handleCount: 1 }] });

  const sessionResource = await mcpClient.readResource({ uri: "figma-workspace://sessions/main" });
  const sessionJson = JSON.parse(sessionResource.contents[0].text);
  assert.deepEqual(sessionJson, {
    id: "main",
    handleCount: 1,
    handlePreview: { "$card": "12:34" },
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
  assert.equal(sessionJson.handles, undefined);
  const handlesResource = await mcpClient.readResource({ uri: "figma-workspace://sessions/main/handles" });
  const handlesJson = JSON.parse(handlesResource.contents[0].text);
  assert.deepEqual(handlesJson, { sessionId: "main", handles: { "$card": "12:34" } });

  await mcpClient.callTool({
    name: "figma_workspace_open",
    arguments: {
      title: "Import many handles",
      sessionId: "many-handles",
      connect: false,
      handles: {
        "$zeta": "1:6",
        "$alpha": "1:1",
        "$gamma": "1:3",
        "$beta": "1:2",
        "$epsilon": "1:5",
        "$delta": "1:4",
      },
    },
  });
  const manySessionResource = await mcpClient.readResource({ uri: "figma-workspace://sessions/many-handles" });
  const manySessionJson = JSON.parse(manySessionResource.contents[0].text);
  assert.deepEqual(manySessionJson, {
    id: "many-handles",
    handleCount: 6,
    handlePreview: {
      "$alpha": "1:1",
      "$beta": "1:2",
      "$delta": "1:4",
      "$epsilon": "1:5",
      "$gamma": "1:3",
    },
  });
  assert.equal(manySessionJson.handles, undefined);
  const manyHandlesResource = await mcpClient.readResource({ uri: "figma-workspace://sessions/many-handles/handles" });
  const manyHandlesJson = JSON.parse(manyHandlesResource.contents[0].text);
  assert.deepEqual(manyHandlesJson, {
    sessionId: "many-handles",
    handles: {
      "$alpha": "1:1",
      "$beta": "1:2",
      "$delta": "1:4",
      "$epsilon": "1:5",
      "$gamma": "1:3",
      "$zeta": "1:6",
    },
  });

  assert.deepEqual(calls.map((call) => call[0]), ["connect", "listTools", "callTool"]);
  await mcpClient.close();
});

test("figma workspace eval and run_script_file pass raw session fileKey to upstream use_figma", async () => {
  const tempDir = await mkdtemp(resolve(tmpdir(), "figma-workspace-raw-file-key-"));
  const scriptPath = resolve(tempDir, "raw-file-key.figma.ts");
  await writeFile(scriptPath, "return { source: 'script' };", "utf8");
  const calls = [];
  const fakeClient = createFakeFigmaClient(calls, ({ name, args }) => {
    assert.equal(name, "use_figma");
    assert.equal(args.fileKey, "RawFileKey012");
    return {
      content: [{
        type: "text",
        text: JSON.stringify({
          ok: true,
          __figmaRepl: { sessionId: "raw-key", handles: {}, fileKey: "RawFileKey012" },
          result: { source: args.code.includes("source: 'script'") ? "script" : "eval" },
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

    const openResult = await mcpClient.callTool({
      name: "figma_workspace_open",
      arguments: {
        title: "Open raw file key",
        sessionId: "raw-key",
        file: "RawFileKey012",
        workspaceDir: tempDir,
        connect: false,
      },
    });
    assert.equal(structuredToolResult(openResult).session.fileKey, "RawFileKey012");

    const evalResult = await mcpClient.callTool({
      name: "figma_workspace_eval",
      arguments: {
        title: "Eval raw file key",
        sessionId: "raw-key",
        code: "return { source: 'eval' };",
      },
    });
    assert.equal(structuredToolResult(evalResult).ok, true);

    const scriptResult = await mcpClient.callTool({
      name: "figma_workspace_run_script_file",
      arguments: {
        title: "Run raw file key script",
        sessionId: "raw-key",
        scriptPath,
      },
    });
    assert.equal(structuredToolResult(scriptResult).ok, true);
    assert.deepEqual(
      calls.filter((call) => call[0] === "callTool").map((call) => call[2].fileKey),
      ["RawFileKey012", "RawFileKey012"],
    );
    await mcpClient.close();
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
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
  const tempDir = await mkdtemp(resolve(tmpdir(), "figma-workspace-open-only-"));
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
      workspaceDir: tempDir,
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

test("figma workspace eval fails fast when upstream use_figma requires fileKey without session context", async () => {
  const calls = [];
  const fakeClient = createFakeFigmaClient(
    calls,
    () => {
      throw new Error("unexpected upstream call");
    },
    {
      tools: [
        {
          name: "use_figma",
          inputSchema: {
            type: "object",
            properties: {
              fileKey: { type: "string" },
              code: { type: "string" },
              description: { type: "string" },
            },
            required: ["fileKey", "code", "description"],
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
      name: "figma_workspace_eval",
      arguments: {
        title: "Reject missing use_figma fileKey",
        sessionId: "missing-file",
        code: "return { ok: true };",
      },
    }),
    /requires fileKey\. Call figma_workspace_open\(\{ sessionId, file \}\) or figma_workspace_prepare_task first\./,
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
      code: "const helperName = 'findFreeSlot';\nreturn await $[helperName]({ gap: 8 });",
    },
  });
  const blockedJson = structuredToolResult(blockedEval);
  assert.equal(blockedJson.ok, false);
  assert.equal(blockedJson.repairPlan.status, "blocked");
  assert.deepEqual(blockedJson.repairPlan.steps.map((step) => step.code), ["FIGMA_WORKSPACE_DYNAMIC_HELPER_ACCESS"]);
  assert.deepEqual(calls.map((call) => call[0]), []);
  await mcpClient.close();
});

test("figma workspace eval applies per-call figjam surface before diagnostics", async () => {
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

  const openResult = await mcpClient.callTool({
    name: "figma_workspace_open",
    arguments: {
      title: "Seed design session",
      sessionId: "surface-main",
      connect: false,
      surface: "design",
    },
  });
  assert.equal(structuredToolResult(openResult).session.surface, "design");

  const blockedEval = await mcpClient.callTool({
    name: "figma_workspace_eval",
    arguments: {
      title: "Reject design API in figjam eval",
      sessionId: "surface-main",
      surface: "figjam",
      code: "const frame = figma.createFrame();\nreturn { id: frame.id };",
    },
  });
  const blockedJson = structuredToolResult(blockedEval);
  assert.equal(blockedJson.ok, false);
  assert.equal(blockedJson.session.surface, "figjam");
  assert.deepEqual(blockedJson.repairPlan.steps.map((step) => step.code), [
    "FIGMA_WORKSPACE_SURFACE_DESIGN_API_IN_FIGJAM",
  ]);
  assert.deepEqual(calls.map((call) => call[0]), []);
  await mcpClient.close();
});

test("figma workspace eval sends per-call figjam surface in harmless wrapper", async () => {
  const calls = [];
  const fakeClient = createFakeFigmaClient(calls, ({ name, args }) => {
    assert.equal(name, "use_figma");
    assert.match(args.code, /surface: "figjam"/u);
    return {
      content: [{
        type: "text",
        text: JSON.stringify({
          ok: true,
          __figmaRepl: {
            sessionId: "surface-main",
            surface: "figjam",
            handles: {},
          },
          result: { summary: "figjam noop" },
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

  await server.connect(serverTransport);
  await mcpClient.connect(clientTransport);

  const openResult = await mcpClient.callTool({
    name: "figma_workspace_open",
    arguments: {
      title: "Seed design session",
      sessionId: "surface-main",
      connect: false,
      surface: "design",
    },
  });
  assert.equal(structuredToolResult(openResult).session.surface, "design");

  const evalResult = await mcpClient.callTool({
    name: "figma_workspace_eval",
    arguments: {
      title: "Harmless figjam eval",
      sessionId: "surface-main",
      surface: "figjam",
      mode: "read",
      code: "return { summary: 'figjam noop' };",
    },
  });
  const evalJson = structuredToolResult(evalResult);
  assert.equal(evalJson.ok, true);
  assert.equal(evalJson.session.surface, "figjam");
  assert.equal(evalJson.upstream.result.summary, "figjam noop");
  assert.deepEqual(calls.filter((call) => call[0] === "callTool").map((call) => call[1]), ["use_figma"]);
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

  const shadowCode = "const $ = { text() { return null; } };\nreturn $.text();";
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
  assert.doesNotMatch(script, /\$\.text = async function text/);
});

test("figma workspace helper selector reports injected helpers and dependencies", () => {
  const textSelection = resolveFigmaWorkspaceScriptHelperSelection("return await $.text({ text: 'Card' });");
  assert.deepEqual(textSelection.injectedHelpers, [
    "$",
    "$.forget",
    "$.handles",
    "$.node",
    "$.remember",
    "$.resolveId",
    "$.text",
  ]);
  assert.deepEqual(textSelection.helperUsage.direct, ["$.text"]);
  assert.deepEqual(textSelection.helperUsage.transitive, []);
  assert.deepEqual(textSelection.helperUsage.runtimeBase, ["$.forget", "$.handles", "$.node", "$.remember", "$.resolveId"]);
  assert.deepEqual(textSelection.helperUsage.injected, textSelection.injectedHelpers);

  const placementSelection = resolveFigmaWorkspaceScriptHelperSelection("return await $.placeNode('$card', { avoidOverlap: true });");
  assert.ok(placementSelection.injectedHelpers.includes("$.findFreeSlot"));
  assert.ok(placementSelection.injectedHelpers.includes("$.placeNode"));
  assert.equal(placementSelection.injectedHelpers.includes("$.text"), false);

  const literalSelection = resolveFigmaWorkspaceScriptHelperSelection("return await $['text']({ text: 'Card' });");
  assert.ok(literalSelection.injectedHelpers.includes("$.text"));

  const baseSelection = resolveFigmaWorkspaceScriptHelperSelection("return await $('$selection');");
  assert.deepEqual(baseSelection.injectedHelpers, ["$"]);
  assert.deepEqual(baseSelection.helperUsage.direct, ["$"]);
  assert.deepEqual(baseSelection.helperUsage.transitive, []);
  assert.deepEqual(baseSelection.helperUsage.runtimeBase, []);

  const shadowSelection = resolveFigmaWorkspaceScriptHelperSelection("const $ = { text() { return null; } };\nreturn $.text();");
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
    findAll(predicate) {
      const matches = [];
      const visit = (node) => {
        if (node !== this && predicate(node)) matches.push(node);
        if (Array.isArray(node.children)) {
          for (const child of node.children) visit(child);
        }
      };
      visit(this);
      return matches;
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
      "const root = figma.createFrame();",
      "root.name = 'Eval helper root';",
      "root.resize(120, 80);",
      "root.layoutMode = 'VERTICAL';",
      "root.itemSpacing = 4;",
      "figma.currentPage.appendChild(root);",
      "$.remember('$root', root);",
      "const title = await $.text({ parent: '$root', as: '$title', name: 'Eval helper title', text: 'Hello', font: { family: 'Inter', style: 'Regular', size: 12 } });",
      "const allText = figma.currentPage.findAll((node) => node.type === 'TEXT');",
      "const found = allText.find((node) => node.name === 'Eval helper title');",
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
  const diagnosticsResource = await mcpClient.readResource({ uri: "figma-workspace://diagnostics" });
  const guideResource = await mcpClient.readResource({ uri: "figma-workspace://guide" });
  const lookupIndexResource = await mcpClient.readResource({ uri: "figma-workspace://lookup-index" });
  const capabilities = JSON.parse(capabilitiesResource.contents[0].text);
  const diagnostics = JSON.parse(diagnosticsResource.contents[0].text);
  const guide = JSON.parse(guideResource.contents[0].text);
  const lookupIndex = JSON.parse(lookupIndexResource.contents[0].text);

  assert.equal(capabilitiesResource.contents[0].mimeType, "application/json");
  assert.equal(diagnosticsResource.contents[0].mimeType, "application/json");
  assert.equal(guideResource.contents[0].mimeType, "application/json");
  assert.equal(lookupIndexResource.contents[0].mimeType, "application/json");
  assert.ok(Buffer.byteLength(capabilitiesResource.contents[0].text, "utf8") <= 10240);
  assert.ok(Buffer.byteLength(guideResource.contents[0].text, "utf8") <= 16384);
  assert.ok(Buffer.byteLength(lookupIndexResource.contents[0].text, "utf8") <= 6144);

  assert.match(capabilities.purpose, /Routing manifest/);
  assert.ok(capabilities.defaultFlow.some((step) => /figma_workspace_prepare_task/.test(step) && /workspaceDir/.test(step)));
  assert.equal(capabilities.runtime, undefined);
  assert.equal(capabilities.resources.diagnostics, "figma-workspace://diagnostics");
  assert.match(diagnostics.purpose, /Development\/debugging payload/);
  assert.match(diagnostics.purpose, /MCP faults/);
  assert.match(diagnostics.purpose, /Do not read for normal Figma work/);
  assert.equal(typeof diagnostics.runtime.lookup.ok, "boolean");
  assert.equal(typeof diagnostics.runtime.typescript.ok, "boolean");
  assert.equal(typeof diagnostics.runtime.lookup.packageVersion, "string");
  assert.equal(typeof diagnostics.runtime.lookup.recordCount, "number");
  assert.equal(typeof diagnostics.runtime.lookup.root, "string");
  assert.equal(typeof diagnostics.runtime.lookup.moduleDir, "string");
  assert.equal(typeof diagnostics.runtime.lookup.cwd, "string");
  assert.equal(typeof diagnostics.runtime.typescript.packageVersion, "string");
  assert.equal(typeof diagnostics.runtime.typescript.typescriptLibCount, "number");
  assert.equal(typeof diagnostics.runtime.typescript.moduleDir, "string");
  assert.equal(typeof diagnostics.runtime.typescript.cwd, "string");
  assert.equal(typeof diagnostics.runtime.typescript.helperDeclarationsPath, "string");
  assert.ok(diagnostics.guidance.some((step) => /reload/i.test(step)));
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
  assert.ok(guide.inspectionAndQa.some((step) => /node URL targets or target:\{ fileKey, nodeId \} can supply file context directly/.test(step)));
  assert.ok(guide.inspectionAndQa.some((step) => /visible audit markers.*free slot/i.test(step)));
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
  assert.ok(!lookupIndex.guidance.workflowGraph.includes("shader" + "-lookup"));
  assert.match(lookupIndex.ownership, /Bundled corpus stays internal/);

  const tools = await mcpClient.listTools();
  assert.ok(!tools.tools.some((tool) => tool.name === "figma_workspace_capabilities"));
  const removedLocalShaderToolNames = [
    "figma_workspace_" + "list_shader_effects",
    "figma_workspace_" + "get_shader_effect",
    "figma_workspace_" + "list_shader_fills",
    "figma_workspace_" + "get_shader_fill",
  ];
  for (const removedToolName of removedLocalShaderToolNames) {
    assert.ok(!tools.tools.some((tool) => tool.name === removedToolName), `${removedToolName} is not a local public tool`);
    assert.ok(!capabilities.toolSelection.contextAndLookup.includes(removedToolName), `${removedToolName} is not in capabilities`);
    assert.ok(!lookupIndex.guidance.wrapperProfiles.tools.includes(removedToolName), `${removedToolName} is not a wrapper profile`);
  }
  assert.deepEqual(tools.tools.map((tool) => tool.name).sort(), [
    "figma_workspace_apply_asset_manifest",
    "figma_workspace_call_upstream_tool",
    "figma_workspace_capture_node",
    "figma_workspace_download_assets",
    "figma_workspace_eval",
    "figma_workspace_get_design_context",
    "figma_workspace_get_libraries",
    "figma_workspace_get_metadata",
    "figma_workspace_get_motion_context",
    "figma_workspace_get_variable_defs",
    "figma_workspace_guidance",
    "figma_workspace_inspect",
    "figma_workspace_lookup",
    "figma_workspace_open",
    "figma_workspace_prepare_task",
    "figma_workspace_run_script_file",
    "figma_workspace_run_task_plan",
    "figma_workspace_search_design_system",
  ]);
  assert.equal(tools.tools.length, 18);
  const toolsByName = new Map(tools.tools.map((tool) => [tool.name, tool]));
  const wrapperContracts = FIGMA_WORKSPACE_INTERNAL_WRAPPER_CONTRACTS;
  const wrapperContractsByTool = new Map(wrapperContracts.map((contract) => [contract.toolName, contract]));
  const upstreamSnapshotTools = upstreamContractSnapshot.tools;
  const upstreamSnapshotResources = upstreamContractSnapshot.resources;
  const upstreamSnapshotResourceTemplates = upstreamContractSnapshot.resourceTemplates;
  assert.equal(upstreamContractSnapshot.schemaVersion, 2);
  assert.deepEqual(
    Object.keys(upstreamSnapshotTools).sort(),
    [
      "add_code_connect_map",
      "create_new_file",
      "download_assets",
      "export_video",
      "generate_diagram",
      "generate_figma_design",
      "get_code_connect_map",
      "get_code_connect_suggestions",
      "get_context_for_code_connect",
      "get_design_context",
      "get_figjam",
      "get_libraries",
      "get_metadata",
      "get_motion_context",
      "get_screenshot",
      "get_shader_effect",
      "get_shader_fill",
      "get_variable_defs",
      "list_shader_effects",
      "list_shader_fills",
      "search_design_system",
      "send_code_connect_mappings",
      "upload_assets",
      "use_figma",
      "whoami",
    ],
    "official upstream contract snapshot pins all live upstream tools, not only local wrappers",
  );
  assert.ok(
    upstreamSnapshotResources.some((resource) => resource.uri === "skill://index.json"),
    "official upstream contract snapshot includes upstream resources",
  );
  assert.equal(
    upstreamSnapshotResources.length,
    102,
    "official upstream contract snapshot pins the full upstream resource list",
  );
  assert.deepEqual(
    upstreamSnapshotResourceTemplates.map((template) => template.uriTemplate),
    [
      "file://figma/custom-library/source/{tool_id}/{version}/{+file_path}",
      "file://figma/docs/{doc_name}.md",
      "file://figma/make/image/{file_key}/{image_hash}.png",
      "file://figma/make/source/{file_key}/{+file_path}",
      "skill://figma/{skill_name}/references/{+ref_path}",
      "skill://figma/{skill_name}/SKILL.md",
    ],
    "official upstream contract snapshot pins the full upstream resource template list",
  );
  for (const upstreamToolName of new Set(wrapperContracts.map((contract) => contract.upstreamToolName).filter(Boolean))) {
    assert.ok(
      upstreamSnapshotTools[upstreamToolName],
      `covered wrapper upstream tool ${upstreamToolName} is present in the full upstream contract snapshot`,
    );
  }
  assert.deepEqual(
    [...new Set(wrapperContracts.map((contract) => contract.category))].sort(),
    ["asset-capture-workflow", "enhanced-wrapper", "fixed-execution", "thin-wrapper", "upstream-escape-hatch"],
  );
  for (const contract of wrapperContracts) {
    const tool = tools.tools.find((item) => item.name === contract.toolName);
    assert.ok(tool, `${contract.toolName} has public metadata for its internal wrapper contract`);
    for (const property of contract.parameterMatrix.requiredUpstream) {
      assert.ok(
        (contract.requiredUpstreamProperties ?? []).includes(property),
        `${contract.toolName} runtime property-presence guard includes required upstream field ${property}`,
      );
    }
    for (const property of contract.parameterMatrix.passthroughOptional) {
      assert.ok(
        contract.parameterMatrix.publicPassthrough.includes(property),
        `${contract.toolName} keeps runtime optional passthrough ${property} classified as public passthrough`,
      );
    }
    for (const property of contract.optionalUpstreamProperties ?? []) {
      const classifiedHandled =
        contract.parameterMatrix.hiddenUpstreamOptional.includes(property) ||
        contract.parameterMatrix.publicPassthrough.includes(property) ||
        contract.parameterMatrix.derivedUpstream.includes(property) ||
        contract.parameterMatrix.fixedUpstream.includes(property);
      if (!classifiedHandled) {
        assert.ok(
          false,
          `${contract.toolName} parameter matrix classifies optional upstream field ${property}`,
        );
      }
    }
    const publicInputSchema = tool.inputSchema;
    for (const property of contract.parameterMatrix.publicPassthrough) {
      assert.ok(
        inputSchemaHasProperty(publicInputSchema, property),
        `${contract.toolName} public inputSchema exposes passthrough upstream field ${property}`,
      );
    }
    for (const property of contract.parameterMatrix.localOnly) {
      assert.ok(
        topLevelInputSchemaHasProperty(publicInputSchema, property),
        `${contract.toolName} public inputSchema exposes local-only field ${property}`,
      );
    }
    const classifiedPublicProperties = new Set([
      ...contract.parameterMatrix.publicPassthrough,
      ...contract.parameterMatrix.localOnly,
    ]);
    for (const property of inputSchemaProperties(publicInputSchema)) {
      assert.ok(
        classifiedPublicProperties.has(property),
        `${contract.toolName} public inputSchema field ${property} is classified as passthrough or local-only`,
      );
    }
    for (const property of contract.parameterMatrix.hiddenUpstreamOptional) {
      assert.equal(
        topLevelInputSchemaHasProperty(publicInputSchema, property),
        false,
        `${contract.toolName} hides upstream optional field ${property}`,
      );
    }
    for (const property of contract.parameterMatrix.removedLegacy) {
      assert.equal(
        topLevelInputSchemaHasProperty(publicInputSchema, property),
        false,
        `${contract.toolName} does not expose removed legacy field ${property}`,
      );
    }
    if (contract.upstreamToolName) {
      const snapshotSchema = upstreamSnapshotTools[contract.upstreamToolName]?.inputSchema;
      assert.ok(snapshotSchema, `${contract.toolName} has an offline upstream input-schema snapshot`);
      const upstreamProperties = inputSchemaProperties(snapshotSchema);
      const upstreamRequired = inputSchemaRequiredProperties(snapshotSchema);
      assert.deepEqual(
        [...contract.parameterMatrix.requiredUpstream].sort(),
        upstreamRequired,
        `${contract.toolName} required upstream matrix matches offline snapshot`,
      );
      for (const property of upstreamRequired) {
        assert.ok(
          [
            ...contract.parameterMatrix.publicPassthrough,
            ...contract.parameterMatrix.derivedUpstream,
            ...contract.parameterMatrix.fixedUpstream,
          ].includes(property),
          `${contract.toolName} satisfies required upstream field ${property} through passthrough, derived, or fixed handling`,
        );
      }
      for (const property of contract.parameterMatrix.localOnly) {
        assert.equal(
          upstreamProperties.includes(property),
          false,
          `${contract.toolName} local-only field ${property} is not an upstream snapshot field`,
        );
      }
      const classifiedUpstreamProperties = [
        ...contract.parameterMatrix.publicPassthrough,
        ...contract.parameterMatrix.derivedUpstream,
        ...contract.parameterMatrix.fixedUpstream,
        ...contract.parameterMatrix.hiddenUpstreamOptional,
      ];
      for (const property of classifiedUpstreamProperties) {
        assert.ok(
          upstreamProperties.includes(property),
          `${contract.toolName} upstream-classified field ${property} still exists in the offline upstream input-schema snapshot`,
        );
      }
      for (const property of upstreamProperties) {
        const classifications = [
          contract.parameterMatrix.publicPassthrough.includes(property) ? "publicPassthrough" : undefined,
          contract.parameterMatrix.derivedUpstream.includes(property) ? "derivedUpstream" : undefined,
          contract.parameterMatrix.fixedUpstream.includes(property) ? "fixedUpstream" : undefined,
          contract.parameterMatrix.hiddenUpstreamOptional.includes(property) ? "hiddenUpstreamOptional" : undefined,
        ].filter(Boolean);
        assert.deepEqual(
          classifications,
          [classifications[0]],
          `${contract.toolName} classifies upstream snapshot field ${property} exactly once`,
        );
      }
    }
    const outputFilesSchema = tool.outputSchema.properties.outputFiles?.properties ?? {};
    for (const debugFile of contract.outputPolicy.debugFiles) {
      assert.ok(outputFilesSchema[debugFile], `${contract.toolName} output policy advertises ${debugFile}`);
    }
    for (const inlineField of contract.outputPolicy.inlineLimitFields) {
      assert.match(inlineField, /^(?:upstream\.(?:result|text)|metadata\.json)$/u, `${contract.toolName} keeps inline result budget fields narrow`);
    }
  }
  assert.equal(wrapperContractsByTool.get("figma_workspace_inspect").targetSupport, "string-only");
  assert.equal(wrapperContractsByTool.get("figma_workspace_call_upstream_tool").category, "upstream-escape-hatch");
  assert.equal(wrapperContractsByTool.get("figma_workspace_get_design_context").upstreamToolName, "get_design_context");
  assert.deepEqual(wrapperContractsByTool.get("figma_workspace_get_metadata").outputPolicy.debugFiles, ["metadataFile"]);
  assert.deepEqual(toolsByName.get("figma_workspace_eval").inputSchema.required, ["code"]);
  assert.deepEqual(toolsByName.get("figma_workspace_capture_node").inputSchema.required, ["target"]);
  assert.deepEqual(toolsByName.get("figma_workspace_search_design_system").inputSchema.required, ["query"]);
  assert.deepEqual(toolsByName.get("figma_workspace_lookup").inputSchema.required, ["kind"]);
  assert.deepEqual(toolsByName.get("figma_workspace_prepare_task").inputSchema.required, ["taskName", "workspaceDir"]);
  assert.deepEqual(requiredBranches(toolsByName.get("figma_workspace_run_script_file").inputSchema), [["scriptPath"], ["inputFile"]]);
  assert.deepEqual(requiredBranches(toolsByName.get("figma_workspace_apply_asset_manifest").inputSchema), [["manifestPath"], ["assets"]]);
  assert.deepEqual(requiredBranches(toolsByName.get("figma_workspace_download_assets").inputSchema), [["targets"], ["manifestPath"]]);
  assert.deepEqual(requiredBranches(toolsByName.get("figma_workspace_run_task_plan").inputSchema), [["planPath"], ["steps"]]);
  assert.deepEqual(requiredBranches(toolsByName.get("figma_workspace_get_design_context").inputSchema), [["target"], ["file"]]);
  assert.deepEqual(requiredBranches(toolsByName.get("figma_workspace_get_motion_context").inputSchema), [["target"], ["file"]]);
  assert.deepEqual(requiredBranches(toolsByName.get("figma_workspace_get_variable_defs").inputSchema), [["target"], ["file"]]);
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
  assert.match(runScriptFileTool.description, /\.figma\.ts/);
  assert.match(runScriptFileTool.description, /Figma Plugin API typings/);
  assert.match(runScriptFileTool.description, /always preflights diagnostics/);
  assert.match(runScriptFileTool.description, /Debug JSON files are generated on demand/);
  assert.match(runScriptFileTool.description, /fixed upstream use_figma\/code/);
  assert.doesNotMatch(runScriptFileTool.description, /\$\[name\]/);
  assert.equal(runScriptFileTool.inputSchema.properties.dryRun, undefined);
  assert.match(runScriptFileTool.inputSchema.properties.inputFile.description, /Recommended workspace \.figma\.ts script file name/);
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
  assert.match(evalTool.description, /Small ephemeral JavaScript Plugin API call/);
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
  assert.equal(evalTool.inputSchema.properties.strict, undefined);
  assert.equal(evalTool.inputSchema.properties.typescript.type, "boolean");
  assert.equal(evalTool.inputSchema.properties.typescript.default, false);
  assert.equal(evalTool.inputSchema.properties.compile, undefined);
  assert.match(evalTool.inputSchema.properties.handleUpdates.description, /handle-import\/repair escape hatch/);
  assert.match(evalTool.inputSchema.properties.handleUpdates.description, /before running code/);
  assert.match(evalTool.inputSchema.properties.handleUpdates.description, /not read back from upstream\.result\.handleUpdates/);
  assert.match(evalTool.inputSchema.properties.handleUpdates.description, /\$\.remember/);
  assert.match(evalTool.inputSchema.properties.handleUpdates.description, /top-level handles/);
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
  assert.match(captureNodeTool.description, /Recommended session call for raw string targets/);
  assert.match(captureNodeTool.description, /No-session calls may pass target as a node URL or \{ fileKey, nodeId \}/);
  assert.match(captureNodeTool.description, /saved as PNG/);
  assert.deepEqual(captureNodeTool.inputSchema.required, ["target"]);
  assert.equal(captureNodeTool.inputSchema.required.includes("title"), false);
  assert.equal(captureNodeTool.inputSchema.properties.nodeId, undefined);
  assert.equal(captureNodeTool.inputSchema.properties.targetNodeId, undefined);
  assert.equal(captureNodeTool.inputSchema.properties.handle, undefined);
  assert.match(captureNodeTool.inputSchema.properties.target.description, /Target node/);
  assert.match(captureNodeTool.inputSchema.properties.target.description, /string raw node id/);
  assert.match(captureNodeTool.inputSchema.properties.target.description, /\{ handle:"\$hero" \}/);
  assert.match(captureNodeTool.inputSchema.properties.target.description, /\{ fileKey, nodeId \}/);
  assert.match(captureNodeTool.inputSchema.properties.target.description, /Raw node id and handle strings require an open\/prepare file-context session/);
  assert.match(captureNodeTool.inputSchema.properties.target.description, /node URL and \{ fileKey, nodeId \} can supply file context directly/);
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
  assert.equal(captureNodeTool.inputSchema.properties.maxDimension.type, "integer");
  assert.equal(captureNodeTool.inputSchema.properties.maxDimension.minimum, 1);
  assert.equal(captureNodeTool.inputSchema.properties.maxDimension.maximum, 65536);
  assert.ok(captureNodeTool.inputSchema.properties.contentsOnly);
  assert.equal(captureNodeTool.inputSchema.properties.enableBase64Response, undefined);
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
  assert.match(prepareTaskTool.description, /\.figma\.ts/);
  assert.match(prepareTaskTool.description, /Recommended workspace call: \{ file, taskName, workspaceDir, surface \}/);
  assert.match(prepareTaskTool.inputSchema.properties.file.description, /Figma file URL or raw file key/);
  assert.equal(prepareTaskTool.inputSchema.properties.fileUrl, undefined);
  assert.equal(prepareTaskTool.inputSchema.properties.fileKey, undefined);
  assert.equal(prepareTaskTool.inputSchema.properties.intent, undefined);
  assert.equal(prepareTaskTool.inputSchema.properties.goal, undefined);
  assert.equal(prepareTaskTool.inputSchema.properties.task, undefined);
  assert.match(prepareTaskTool.inputSchema.properties.taskName.description, /slug-style task\/workspace name/);
  assert.match(prepareTaskTool.inputSchema.properties.fileName.description, /\.figma\.ts/);
  assert.equal(prepareTaskTool.inputSchema.properties.taskDir, undefined);
  assert.equal(prepareTaskTool.inputSchema.properties.scriptName, undefined);
  assert.equal(prepareTaskTool.inputSchema.properties.expectedSurface, undefined);
  assert.match(prepareTaskTool.inputSchema.properties.workspaceDir.description, /Required absolute local workspace directory/);
  assert.match(prepareTaskTool.inputSchema.properties.surface.description, /Recommended expected Figma surface/);
  assert.equal(prepareTaskTool.inputSchema.properties.taskRoot, undefined);
  assert.match(prepareTaskTool.inputSchema.properties.overwrite.description, /Advanced destructive/);
  assert.ok(prepareTaskTool.outputSchema.properties.taskChange);
  assert.ok(prepareTaskTool.outputSchema.properties.taskChange.properties.previous);
  assert.ok(prepareTaskTool.outputSchema.properties.taskChange.properties.current);
  assert.ok(prepareTaskTool.outputSchema.properties.taskChange.properties.changed);
  assert.equal(prepareTaskTool.outputSchema.properties.outputFiles, undefined);
  const inspectTool = tools.tools.find((tool) => tool.name === "figma_workspace_inspect");
  assert.ok(inspectTool);
  assert.match(inspectTool.description, /fixed upstream use_figma/);
  assert.match(inspectTool.description, /Requires a file-context session/);
  assert.deepEqual(inspectTool.inputSchema.properties.mode.enum, ["inspect", "validate", "style"]);
  assert.match(inspectTool.inputSchema.properties.sessionId.description, /file context/);
  assert.match(inspectTool.inputSchema.properties.target.description, /String-only target/);
  assert.match(inspectTool.inputSchema.properties.target.description, /Do not pass \{ fileKey, nodeId \}/);
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
  assert.ok(inspectTool.outputSchema.properties.validations.items.properties.locked);
  assert.ok(inspectTool.outputSchema.properties.validations.items.properties.layoutMode);
  assert.ok(inspectTool.outputSchema.properties.validations.items.properties.layoutPositioning);
  const getMetadataTool = tools.tools.find((tool) => tool.name === "figma_workspace_get_metadata");
  assert.ok(getMetadataTool);
  assert.match(getMetadataTool.description, /Metadata-first read tool/);
  assert.match(getMetadataTool.description, /converts returned XML into a compact JSON node tree/);
  assert.match(getMetadataTool.description, /one batched read-only use_figma readback/);
  assert.match(getMetadataTool.description, /\{ target:\{ fileKey, nodeId \} \}/);
  assert.ok(getMetadataTool.inputSchema.properties.file);
  assert.ok(getMetadataTool.inputSchema.properties.target);
  assert.match(getMetadataTool.inputSchema.properties.target.description, /string node URL/);
  assert.match(getMetadataTool.inputSchema.properties.target.description, /\{ handle:"\$hero" \}/);
  assert.match(getMetadataTool.inputSchema.properties.target.description, /\{ fileKey, nodeId \}/);
  assert.match(getMetadataTool.inputSchema.properties.target.description, /\$currentPage/);
  assert.match(getMetadataTool.inputSchema.properties.target.description, /single-node \$selection/);
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
  assert.ok(getMetadataTool.outputSchema.properties.diagnostics);
  assert.ok(getMetadataTool.outputSchema.properties.outputFiles.properties.metadataFile);
  assert.equal(getMetadataTool.outputSchema.properties.outputFiles.properties.upstreamFile, undefined);
  assert.ok(getMetadataTool.outputSchema.properties.inlineResultLimit);
  const getDesignContextTool = tools.tools.find((tool) => tool.name === "figma_workspace_get_design_context");
  assert.ok(getDesignContextTool);
  assert.match(getDesignContextTool.description, /official upstream get_design_context/);
  assert.match(getDesignContextTool.description, /\{ target:\{ fileKey, nodeId \} \}/);
  assert.ok(getDesignContextTool.inputSchema.properties.target);
  assert.ok(getDesignContextTool.inputSchema.properties.clientLanguages);
  assert.ok(getDesignContextTool.inputSchema.properties.clientFrameworks);
  assert.ok(getDesignContextTool.inputSchema.properties.forceCode);
  assert.ok(getDesignContextTool.inputSchema.properties.disableCodeConnect);
  assert.ok(getDesignContextTool.inputSchema.properties.excludeScreenshot);
  assert.ok(getDesignContextTool.inputSchema.properties.inlineResultLimit);
  assert.ok(getDesignContextTool.outputSchema.properties.nodeId);
  assert.ok(getDesignContextTool.outputSchema.properties.upstream);
  assert.ok(getDesignContextTool.outputSchema.properties.outputFiles.properties.upstreamFile);
  assert.equal(getDesignContextTool.outputSchema.properties.videoFile, undefined);
  const getMotionContextTool = tools.tools.find((tool) => tool.name === "figma_workspace_get_motion_context");
  assert.ok(getMotionContextTool);
  assert.match(getMotionContextTool.description, /official upstream get_motion_context/);
  assert.match(getMotionContextTool.description, /\{ target:\{ fileKey, nodeId \}, recursive\? \}/);
  assert.ok(getMotionContextTool.inputSchema.properties.recursive);
  assert.ok(getMotionContextTool.inputSchema.properties.clientLanguages);
  assert.ok(getMotionContextTool.inputSchema.properties.clientFrameworks);
  assert.ok(getMotionContextTool.outputSchema.properties.nodeId);
  assert.ok(getMotionContextTool.outputSchema.properties.upstream);
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
  assert.match(getVariableDefsTool.description, /\{ target:\{ fileKey, nodeId \} \}/);
  assert.equal(getVariableDefsTool.inputSchema.properties.clientLanguages, undefined);
  assert.equal(getVariableDefsTool.inputSchema.properties.clientFrameworks, undefined);
  assert.equal(getVariableDefsTool.inputSchema.properties.nodeId, undefined);
  assert.ok(getVariableDefsTool.outputSchema.properties.nodeId);
  assert.ok(getVariableDefsTool.outputSchema.properties.upstream);
  assert.ok(getVariableDefsTool.outputSchema.properties.outputFiles.properties.upstreamFile);
  assert.equal(getVariableDefsTool.outputSchema.properties.toolName, undefined);
  for (const wrapperTool of [
    getMetadataTool,
    getDesignContextTool,
    getMotionContextTool,
    getVariableDefsTool,
  ]) {
    assert.match(wrapperTool.inputSchema.properties.target.description, /string raw node id/);
    assert.match(wrapperTool.inputSchema.properties.target.description, /\{ handle:"\$hero" \}/);
    assert.match(wrapperTool.inputSchema.properties.target.description, /\{ fileKey, nodeId \}/);
    assert.match(wrapperTool.inputSchema.properties.target.description, /node URL and \{ fileKey, nodeId \} can supply file context directly/);
  }
  for (const wrapperTool of [
    getDesignContextTool,
    getMotionContextTool,
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
  assert.match(callUpstreamTool.description, /Explicit upstream escape hatch/);
  assert.match(callUpstreamTool.description, /figma-workspace:\/\/upstream-tools\/\{name\}/);
  assert.match(callUpstreamTool.description, /Prefer dedicated local workflow tools/);
  assert.match(callUpstreamTool.description, /raw upstream behavior or an uncovered capability/);
  assert.doesNotMatch(callUpstreamTool.description, /Do not use[^.]*export_video/);
  for (const upstreamToolName of wrapperContracts
    .map((contract) => contract.upstreamToolName)
    .filter((value) => typeof value === "string")) {
    assert.match(callUpstreamTool.description, new RegExp(`\\b${upstreamToolName}\\b`, "u"));
  }
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
  const aggregateDiagnosticsResource = await mcpClient.readResource({ uri: "figma-workspace://diagnostics" });
  const aggregateGuideResource = await mcpClient.readResource({ uri: "figma-workspace://guide" });
  const aggregateLookupIndexResource = await mcpClient.readResource({ uri: "figma-workspace://lookup-index" });
  const aggregateDiagnostics = JSON.parse(aggregateDiagnosticsResource.contents[0].text);
  const aggregateGuide = JSON.parse(aggregateGuideResource.contents[0].text);
  const aggregateLookupIndex = JSON.parse(aggregateLookupIndexResource.contents[0].text);
  assert.equal(aggregateCapabilities.resources.diagnostics, "figma-workspace://diagnostics");
  assert.equal(aggregateCapabilities.resources.guide, "figma-workspace://guide");
  assert.equal(aggregateCapabilities.resources.lookupIndex, "figma-workspace://lookup-index");
  assert.match(aggregateDiagnostics.purpose, /Development\/debugging payload/);
  assert.match(aggregateDiagnostics.purpose, /MCP faults/);
  assert.ok(aggregateDiagnostics.guidance.some((step) => /installed plugin cache/.test(step)));
  assert.ok(aggregateCapabilities.toolSelection.contextAndLookup.includes("figma_workspace_get_motion_context"));
  assert.ok(!aggregateCapabilities.toolSelection.workflowAddOns.includes("figma_workspace_export_video"));
  assert.ok(!aggregateCapabilities.toolSelection.upstreamEscapeHatchExamples.includes("get_motion_context"));
  assert.deepEqual(aggregateCapabilities.lookupStrategy.outputFields, queryOutputFields);
  assert.ok(!aggregateCapabilities.wrapperGuidance.profileTools.includes("figma_workspace_export_video"));
  assert.ok(Object.hasOwn(aggregateCapabilities.helperGuidance.categories, "layout"));
  assert.ok(aggregateCapabilities.helperGuidance.hardRules.some((rule) => /Forbid dynamic/.test(rule)));
  assert.equal(aggregateCapabilities.apiCards, undefined);
  assert.equal(aggregateCapabilities.docsLookup, undefined);
  assert.ok(aggregateGuide.scriptFileWorkflow.some((step) => /figma_workspace_prepare_task/.test(step)));
  assert.ok(aggregateGuide.helperIndex.categories.some((category) => category.helpers.includes("$.replaceGeneratedFrame")));
  assert.ok(aggregateGuide.assetWorkflow.some((step) => /figma_workspace_apply_asset_manifest/.test(step)));
  assert.ok(aggregateGuide.upstreamEscapeHatch.some((step) => /figma-workspace:\/\/upstream-tools\/\{name\}/.test(step)));
  assert.ok(aggregateGuide.evalWorkflow.some((step) => /pre-run handle import\/repair/.test(step)));
  assert.ok(aggregateGuide.evalWorkflow.some((step) => /not read back from upstream\.result\.handleUpdates/.test(step)));
  assert.ok(aggregateGuide.evalWorkflow.some((step) => /\$\.remember/.test(step)));
  assert.ok(aggregateGuide.evalWorkflow.some((step) => /top-level handles/.test(step)));
  assert.ok(aggregateGuide.inspectionAndQa.some((step) => /figma_workspace_get_motion_context/.test(step)));
  assert.ok(aggregateGuide.inspectionAndQa.some((step) => /\$currentPage/.test(step) && /single-node \$selection/.test(step)));
  assert.ok(!aggregateGuide.motionAndShaders.some((step) => /figma_workspace_export_video/.test(step)));
  assert.ok(aggregateGuide.motionAndShaders.some((step) => /figma_workspace_call_upstream_tool/.test(step) && /export_video/.test(step)));
  assert.ok(aggregateGuide.motionAndShaders.some((step) => /shader library reads/.test(step)));
  assert.equal(aggregateLookupIndex.guidance.tool, "figma_workspace_guidance");
  assert.equal(aggregateLookupIndex.lookup.tool, "figma_workspace_lookup");
  assert.ok(aggregateLookupIndex.guidance.commonCards.includes("text.font"));
  assert.deepEqual(aggregateLookupIndex.guidance.outputFields, queryOutputFields);
  assert.ok(aggregateLookupIndex.guidance.helperProfiles.categories.repair.includes("checkpoint"));
  assert.ok(aggregateLookupIndex.guidance.workflowGraph.includes("design-implementation-context"));
  assert.ok(!aggregateLookupIndex.guidance.workflowGraph.includes("shader" + "-lookup"));
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
  assert.match(upstream.guidance, /including shader effect\/fill tools/);
  assert.match(upstream.guidance, /dedicated figma_workspace_\* workflow tools/);
  assert.equal(upstream.tools[0].name, "use_figma");
  assert.equal(upstream.tools[0].category, "execution");
  assert.equal(upstream.tools[0].description, "Run Plugin API code to create, inspect, or edit Figma content.");
  assert.deepEqual(
    Object.fromEntries(upstream.tools.map((tool) => [tool.name, [tool.category, tool.description]])),
    {
      use_figma: ["execution", "Run Plugin API code to create, inspect, or edit Figma content."],
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
  assert.match(upstreamTool.guidance, /Prefer dedicated figma_workspace_\* workflow tools/);
  assert.match(upstreamTool.guidance, /raw upstream behavior or an uncovered capability/);

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
      throw new RemoteMcpOAuthError(
        "FIGMA_UPSTREAM_AUTH_REQUIRED",
        "Figma MCP upstream authentication is required or incomplete.",
      );
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
  assert.equal(upstream.upstreamError.message, "Figma MCP upstream authentication is required or incomplete.");
  assert.equal(upstream.upstreamError.code, "FIGMA_UPSTREAM_AUTH_REQUIRED");
  assert.equal(upstream.upstreamError.details.loginCommand, "npm run login:figma-http");
  assert.equal(upstream.upstreamError.details.oauthCacheFile, ".figma-workspace-oauth.json");
  assert.doesNotMatch(JSON.stringify(upstream.upstreamError), /StaleConnectionError|connectOnce|workspace-mcp-cli/u);
  assert.match(upstream.primaryFix, /npm run login:figma-http/);
  assert.deepEqual(calls, [["connect"]]);

  const upstreamDetailResource = await mcpClient.readResource({ uri: "figma-workspace://upstream-tools/use_figma" });
  const upstreamDetail = JSON.parse(upstreamDetailResource.contents[0].text);
  assert.equal(upstreamDetail.ok, false);
  assert.equal(upstreamDetail.name, "use_figma");
  assert.equal(upstreamDetail.upstreamError.message, "Figma MCP upstream authentication is required or incomplete.");
  assert.equal(upstreamDetail.upstreamError.code, "FIGMA_UPSTREAM_AUTH_REQUIRED");
  assert.equal(upstreamDetail.upstreamError.details.loginCommand, "npm run login:figma-http");
  assert.equal(upstreamDetail.upstreamError.details.oauthCacheFile, ".figma-workspace-oauth.json");
  assert.doesNotMatch(JSON.stringify(upstreamDetail.upstreamError), /StaleConnectionError|connectOnce|workspace-mcp-cli/u);
  assert.match(upstreamDetail.primaryFix, /npm run login:figma-http/);
  assert.equal(upstreamDetail.callTool, "figma_workspace_call_upstream_tool");
  assert.match(upstreamDetail.guidance, /Retry this resource/);
  assert.deepEqual(calls, [["connect"], ["connect"]]);

  await mcpClient.close();
});

test("figma upstream-tools resource uses typed OAuth error codes without facade string heuristics", async () => {
  async function readUpstreamToolsFailure(error) {
    const fakeClient = {
      async connect() {
        throw error;
      },
      async close() {},
      async listTools() {
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
    try {
      const upstreamResource = await mcpClient.readResource({ uri: "figma-workspace://upstream-tools" });
      return JSON.parse(upstreamResource.contents[0].text);
    } finally {
      await mcpClient.close();
    }
  }

  const registration = await readUpstreamToolsFailure(
    new RemoteMcpOAuthError(
      "FIGMA_UPSTREAM_OAUTH_REGISTRATION_REJECTED",
      "Figma MCP OAuth client registration was rejected before a browser authorization URL was issued.",
    ),
  );
  assert.equal(registration.ok, false);
  assert.equal(registration.upstreamError.code, "FIGMA_UPSTREAM_OAUTH_REGISTRATION_REJECTED");
  assert.equal(registration.upstreamError.message, "Figma MCP OAuth client registration was rejected before authorization.");
  assert.match(registration.primaryFix, /supported OAuth client/);
  assert.doesNotMatch(JSON.stringify(registration.upstreamError), /Forbidden|HTTP 403|stack/u);

  const timeout = await readUpstreamToolsFailure(
    new RemoteMcpOAuthError(
      "FIGMA_UPSTREAM_OAUTH_CALLBACK_TIMEOUT",
      "Figma MCP OAuth browser authorization timed out.",
    ),
  );
  assert.equal(timeout.upstreamError.code, "FIGMA_UPSTREAM_OAUTH_CALLBACK_TIMEOUT");
  assert.match(timeout.primaryFix, /before the timeout/);

  const portInUse = await readUpstreamToolsFailure(
    new RemoteMcpOAuthError(
      "FIGMA_UPSTREAM_OAUTH_CALLBACK_PORT_IN_USE",
      "Figma MCP OAuth callback port is already in use.",
      {
        details: {
          callbackHost: "127.0.0.1",
          callbackPort: 18765,
          callbackUrl: "http://127.0.0.1:18765/oauth/callback",
          upstreamCode: "EADDRINUSE",
        },
      },
    ),
  );
  assert.equal(portInUse.upstreamError.code, "FIGMA_UPSTREAM_OAUTH_CALLBACK_PORT_IN_USE");
  assert.equal(portInUse.upstreamError.message, "Figma MCP OAuth callback port is already in use.");
  assert.equal(portInUse.upstreamError.details.callbackPort, 18765);
  assert.equal(portInUse.upstreamError.details.upstreamCode, "EADDRINUSE");
  assert.match(portInUse.primaryFix, /Free OAuth callback port 18765/);
  assert.match(portInUse.primaryFix, /different callback port/);

  const startupFailed = await readUpstreamToolsFailure(
    new RemoteMcpOAuthError(
      "FIGMA_UPSTREAM_OAUTH_CALLBACK_STARTUP_FAILED",
      "Figma MCP OAuth callback listener failed to start.",
    ),
  );
  assert.equal(startupFailed.upstreamError.code, "FIGMA_UPSTREAM_OAUTH_CALLBACK_STARTUP_FAILED");
  assert.equal(startupFailed.upstreamError.message, "Figma MCP OAuth callback listener failed to start.");
  assert.match(startupFailed.primaryFix, /host\/port/);

  const cancelled = await readUpstreamToolsFailure(
    new RemoteMcpOAuthError(
      "FIGMA_UPSTREAM_OAUTH_CANCELLED",
      "Figma MCP OAuth browser authorization was cancelled before completion.",
    ),
  );
  assert.equal(cancelled.upstreamError.code, "FIGMA_UPSTREAM_OAUTH_CANCELLED");
  assert.match(cancelled.primaryFix, /Restart/);

  const tokenExchange = await readUpstreamToolsFailure(
    new RemoteMcpOAuthError(
      "FIGMA_UPSTREAM_OAUTH_TOKEN_EXCHANGE_FAILED",
      "Figma MCP OAuth token exchange failed after browser authorization.",
    ),
  );
  assert.equal(tokenExchange.upstreamError.code, "FIGMA_UPSTREAM_OAUTH_TOKEN_EXCHANGE_FAILED");
  assert.equal(tokenExchange.upstreamError.message, "Figma MCP OAuth token exchange failed after browser authorization.");
  assert.match(tokenExchange.primaryFix, /refresh the OAuth token exchange/);

  const plainOauthLookingError = await readUpstreamToolsFailure(
    new Error("OAuth authorization failed with HTTP 403 Forbidden."),
  );
  assert.equal(plainOauthLookingError.upstreamError.code, "FIGMA_UPSTREAM_FAILED");
  assert.equal(plainOauthLookingError.upstreamError.message, "OAuth authorization failed with HTTP 403 Forbidden.");
  assert.equal(plainOauthLookingError.upstreamError.details, undefined);
  assert.match(plainOauthLookingError.primaryFix, /upstream Figma MCP connection/);
});

test("figma router docs preserve runtime-owned contract wording", async () => {
  const skillText = await readFile(resolve(packageRoot, "../skills/figma-workspace/SKILL.md"), "utf8");
  const openaiText = await readFile(resolve(packageRoot, "../skills/figma-workspace/agents/openai.yaml"), "utf8");
  const pluginReadme = await readFile(resolve(packageRoot, "../README.md"), "utf8");
  const stdioReadme = await readFile(resolve(packageRoot, "README.md"), "utf8");
  const docsText = [skillText, openaiText, pluginReadme, stdioReadme].join("\n");

  assert.match(skillText, /After OAuth registration, use `figma_workspace_mcp` as the agent-facing entrypoint/);
  assert.match(skillText, /read `figma-workspace:\/\/capabilities`/);
  assert.match(skillText, /Bundled JSONL upstream corpus files are internal lookup data/);
  assert.match(skillText, /recommendedCards`, `queryHints`, `apiSymbols`, `guardrails`, and `suggestions\.referenceContext`/);
  assert.match(skillText, /figma_workspace_lookup\(\{ kind: "docs" \}\)/);
  for (const uri of removedStaticResourceUris) {
    assert.ok(!skillText.includes(uri), `SKILL.md must not route agents to removed resource ${uri}`);
  }
  assert.match(pluginReadme, /`figma_workspace_mcp` is the primary agent workflow after OAuth registration/);
  assert.match(pluginReadme, /persistent MCP server id is `figma_workspace_mcp`/);
  assert.match(pluginReadme, /`upstream-corpus\/manifest\.json` and `upstream-corpus\/corpus\.jsonl` files are internal lookup corpus/);
  assert.match(stdioReadme, /old hyphenated persistent server ids/);
  assert.match(stdioReadme, /bundled JSONL corpus files are internal and are not an agent-facing documentation path/);
  assert.match(stdioReadme, /raw upstream behavior or uncovered capabilities/);
  assert.match(docsText, /Prefer first-class wrappers/);
  assert.match(docsText, /raw upstream behavior or an uncovered official capability/);
  assert.match(openaiText, /figma_workspace_mcp/);
  assert.match(openaiText, /\$figma-workspace\b/);
  for (const term of forbiddenRouterContractTerms) {
    assert.ok(!docsText.includes(term), `router docs must not mention ${term}`);
  }
});

test("figma public guidance text excludes legacy script and removed helper wording", async () => {
  const publicTexts = await readPublicFigmaWorkspaceContractTexts();
  assert.ok(publicTexts.length > 0);
  for (const { path, text } of publicTexts) {
    assert.equal(path.replace(/\\/gu, "/").includes("/upstream-corpus/"), false);
    assert.equal(text.includes(".figma.js"), false, `${path} must not mention legacy .figma.js scripts`);
    assert.equal(text.includes('clientLanguages: "unknown"'), false, `${path} must not recommend unknown clientLanguages hints`);
    assert.equal(text.includes('clientFrameworks: "unknown"'), false, `${path} must not recommend unknown clientFrameworks hints`);
    assert.equal(/get_variable_defs[\s\S]{0,240}client(?:Languages|Frameworks)/u.test(text), false, `${path} must not document client hints for get_variable_defs`);
    for (const helperTerm of removedDollarHelperTerms) {
      assert.equal(dollarHelperTermPattern(helperTerm).test(text), false, `${path} must not mention removed helper ${helperTerm}`);
    }
  }
});

test("figma upstream corpus is JSONL-backed with motion and SwiftUI included", async () => {
  const corpusDir = resolve(packageRoot, "../skills/figma-workspace/references/upstream-corpus");
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
      if (name === "get_metadata") {
        assert.deepEqual(args, { fileKey: "file123", nodeId: "1:2" });
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({ ok: true, xml: "<node />" }),
            },
          ],
        };
      }
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
        {
          name: "get_metadata",
          description: "Read node metadata.",
          inputSchema: { type: "object", properties: { fileKey: { type: "string" }, nodeId: { type: "string" } } },
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

  const coveredUpstreamResult = await mcpClient.callTool({
    name: "figma_workspace_call_upstream_tool",
    arguments: {
      title: "Covered upstream passthrough",
      toolName: "get_metadata",
      arguments: { fileKey: "file123", nodeId: "1:2" },
    },
  });
  const coveredUpstreamJson = structuredToolResult(coveredUpstreamResult);
  assert.equal(coveredUpstreamJson.ok, true);
  assert.equal(coveredUpstreamJson.toolName, "get_metadata");
  assert.equal(coveredUpstreamJson.upstream.kind, "json");
  assert.equal(coveredUpstreamJson.upstream.ok, true);
  assert.equal(coveredUpstreamJson.upstream.result.xml, "<node />");

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
  assert.match(failureJson.primaryFix, /repair the upstream Plugin API error/);
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
  assert.deepEqual(calls.map((call) => call[0]), ["connect", "listTools", "callTool", "callTool", "callTool", "callTool"]);
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
    assert.match(wrappedFailure.primaryFix, /repair the upstream Plugin API error/);
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
      if (name === "get_metadata") {
        if (args.clientLanguages !== undefined || args.clientFrameworks !== undefined) {
          assert.deepEqual(args, {
            fileKey: "ExampleFigmaFileKey012",
            nodeId: "1:2",
            clientLanguages: "typescript",
            clientFrameworks: "react",
          });
        } else {
          assert.deepEqual(args, {
            fileKey: "ExampleFigmaFileKey012",
            nodeId: "1:2",
          });
        }
        return {
          content: [{ type: "text", text: xml }],
        };
      }
      assert.equal(name, "use_figma");
      assert.equal(args.fileKey, "ExampleFigmaFileKey012");
      assert.match(args.code, /const __metadataNodeIds = \["1:2","1:3","1:4"\]/u);
      assert.match(args.code, /const __metadataFields = \["locked","visible","layoutPositioning"/u);
      assert.match(args.code, /figma\.getNodeByIdAsync/u);
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              ok: true,
              __figmaRepl: { sessionId: "metadata-main", handles: {} },
              result: {
                enrichment: {
                  nodes: {
                    "1:2": {
                      locked: true,
                      visible: false,
                      layoutPositioning: "AUTO",
                      layoutMode: "HORIZONTAL",
                      primaryAxisSizingMode: "FIXED",
                      counterAxisSizingMode: "AUTO",
                      primaryAxisAlignItems: "CENTER",
                      counterAxisAlignItems: "MIN",
                      itemSpacing: 12,
                      counterAxisSpacing: 8,
                      paddingLeft: 16,
                      paddingRight: 18,
                      paddingTop: 20,
                      paddingBottom: 22,
                      layoutWrap: "WRAP",
                    },
                    "1:4": {
                      locked: false,
                      visible: true,
                      layoutPositioning: "ABSOLUTE",
                    },
                  },
                },
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
          inputSchema: { type: "object", properties: { code: { type: "string" }, fileKey: { type: "string" } } },
        },
        {
          name: "get_metadata",
          description: "Read XML metadata.",
          inputSchema: {
            type: "object",
            properties: {
              fileKey: { type: "string" },
              nodeId: { type: "string" },
              clientLanguages: { type: "string" },
              clientFrameworks: { type: "string" },
            },
          },
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
      workspaceDir: tempDir,
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
    assert.equal(result.metadata.enrichment, undefined);
    assert.equal(result.metadata.json.root.locked, true);
    assert.equal(result.metadata.json.root.visible, false);
    assert.equal(result.metadata.json.root.layoutPositioning, "AUTO");
    assert.equal(result.metadata.json.root.layoutMode, "HORIZONTAL");
    assert.equal(result.metadata.json.root.primaryAxisSizingMode, "FIXED");
    assert.equal(result.metadata.json.root.counterAxisSizingMode, "AUTO");
    assert.equal(result.metadata.json.root.primaryAxisAlignItems, "CENTER");
    assert.equal(result.metadata.json.root.counterAxisAlignItems, "MIN");
    assert.equal(result.metadata.json.root.itemSpacing, 12);
    assert.equal(result.metadata.json.root.counterAxisSpacing, 8);
    assert.equal(result.metadata.json.root.paddingLeft, 16);
    assert.equal(result.metadata.json.root.paddingRight, 18);
    assert.equal(result.metadata.json.root.paddingTop, 20);
    assert.equal(result.metadata.json.root.paddingBottom, 22);
    assert.equal(result.metadata.json.root.layoutWrap, "WRAP");
    assert.equal(result.metadata.json.root.children[1].type, "rounded-rectangle");
    assert.equal(result.metadata.json.root.children[1].locked, false);
    assert.equal(result.metadata.json.root.children[1].layoutPositioning, "ABSOLUTE");
    assert.deepEqual(result.diagnostics, []);
    assert.equal(result.inlineResultLimit, undefined);
    assert.equal(result.outputFiles, undefined);

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
    assert.equal(omittedMetadataFile.root.layoutMode, "HORIZONTAL");
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
    assert.equal(fileOnlyMetadataFile.root.locked, true);
    assert.equal(fileOnly.outputFiles.upstreamFile, undefined);

    const objectTarget = await repl.getMetadata({
      title: "Read metadata object target",
      sessionId: "metadata-main",
      target: { fileKey: "ExampleFigmaFileKey012", nodeId: "1:2" },
      clientLanguages: "typescript",
      clientFrameworks: "react",
    });
    assert.equal(objectTarget.ok, true);
    assert.equal(objectTarget.fileKey, "ExampleFigmaFileKey012");
    assert.equal(objectTarget.nodeId, "1:2");
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
    "callTool",
    "callTool",
    "callTool",
    "callTool",
    "callTool",
  ]);
  assert.deepEqual(calls.filter((call) => call[0] === "callTool").map((call) => call[1]), [
    "get_metadata",
    "use_figma",
    "get_metadata",
    "use_figma",
    "get_metadata",
    "use_figma",
    "get_metadata",
    "use_figma",
  ]);
});

test("figma workspace get_metadata splits native enrichment readback when upstream truncates a large batch", async () => {
  const tempDir = await mkdtemp(resolve(tmpdir(), "figma-workspace-get-metadata-chunk-"));
  const childIds = Array.from({ length: 81 }, (_, index) => `2:${index + 1}`);
  const xml = `<frame id="1:1" name="Large Page" width="100" height="80">\n${childIds.map((id) => `  <frame id="${id}" name="Node ${id}" width="10" height="10" />`).join("\n")}\n</frame>`;
  const enrichmentBatchSizes = [];
  const fakeClient = createFakeFigmaClient(
    [],
    ({ name, args }) => {
      if (name === "get_metadata") {
        assert.deepEqual(args, { fileKey: "ExampleFigmaFileKey012", nodeId: "1:1" });
        return { content: [{ type: "text", text: xml }] };
      }
      assert.equal(name, "use_figma");
      const idsMatch = /const __metadataNodeIds = (\[[^;]+\]);/u.exec(args.code);
      assert.ok(idsMatch);
      const ids = JSON.parse(idsMatch[1]);
      enrichmentBatchSizes.push(ids.length);
      if (ids.length > 40) {
        return { content: [{ type: "text", text: `${JSON.stringify({ ok: true })}\n// truncated to 20kb` }] };
      }
      const nodes = Object.fromEntries(ids.map((id) => [id, { visible: true, layoutMode: "NONE" }]));
      return {
        content: [{
          type: "text",
          text: JSON.stringify({ ok: true, result: { enrichment: { nodes } } }),
        }],
      };
    },
    {
      tools: [
        {
          name: "use_figma",
          description: "Execute JavaScript in the active Figma file.",
          inputSchema: { type: "object", properties: { code: { type: "string" }, fileKey: { type: "string" } } },
        },
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
      sessionId: "metadata-chunk",
      file: "https://www.figma.com/design/ExampleFigmaFileKey012/UI?node-id=1-1",
      workspaceDir: tempDir,
    });
    assert.equal(result.ok, true);
    assert.equal(result.metadata.nodeCount, 82);
    assert.equal(result.metadata.enrichment, undefined);
    const metadataJson = result.metadata.json ?? await readPrettyJsonPointer(result.outputFiles.metadataFile, result.outputFiles.metadataFile.path);
    assert.equal(metadataJson.root.visible, true);
    assert.equal(metadataJson.root.children[80].visible, true);
    assert.deepEqual(enrichmentBatchSizes, [80, 40, 40, 2]);
    assert.deepEqual(result.diagnostics, []);
  } finally {
    await repl.close();
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("figma workspace get_metadata warns and omits derived optional nodeId missing from live upstream schema", async () => {
  const calls = [];
  const fakeClient = createFakeFigmaClient(
    calls,
    ({ name, args }) => {
      if (name === "get_metadata") {
        assert.deepEqual(args, { fileKey: "ExampleFigmaFileKey012" });
        return {
          content: [{ type: "text", text: '<frame id="1:2" name="Root" width="100" height="80" />' }],
        };
      }
      assert.equal(name, "use_figma");
      assert.equal(args.fileKey, "ExampleFigmaFileKey012");
      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            ok: true,
            __figmaRepl: { sessionId: "metadata-nodeid-drift", handles: {} },
            result: { enrichment: { nodes: { "1:2": { visible: true, locked: false } } } },
          }),
        }],
      };
    },
    {
      tools: [
        {
          name: "use_figma",
          description: "Execute JavaScript in the active Figma file.",
          inputSchema: { type: "object", properties: { code: { type: "string" }, fileKey: { type: "string" } } },
        },
        {
          name: "get_metadata",
          description: "Read XML metadata after nodeId was removed upstream.",
          inputSchema: {
            type: "object",
            properties: {
              fileKey: { type: "string" },
            },
          },
        },
      ],
    },
  );
  const repl = createFigmaWorkspaceClient({ client: fakeClient });

  try {
    const result = await repl.getMetadata({
      title: "Read metadata with optional nodeId drift",
      sessionId: "metadata-nodeid-drift",
      target: { fileKey: "ExampleFigmaFileKey012", nodeId: "1:2" },
    });
    assert.equal(result.ok, true);
    assert.equal(result.nodeId, "1:2");
    assert.equal(result.metadata.json.root.nodeId, "1:2");
    const nodeIdSkip = result.diagnostics.find((diagnostic) =>
      diagnostic.code === "FIGMA_WORKSPACE_UPSTREAM_OPTIONAL_SKIPPED" &&
      /nodeId/.test(diagnostic.message)
    );
    assert.ok(nodeIdSkip);
    assert.equal(nodeIdSkip.severity, "warning");
    assert.match(nodeIdSkip.message, /get_metadata/);
  } finally {
    await repl.close();
  }
  assert.deepEqual(calls.filter((call) => call[0] !== "close").map((call) => call[0]), [
    "connect",
    "listTools",
    "callTool",
    "callTool",
  ]);
});

test("figma workspace get_metadata resolves supported dynamic selectors before upstream metadata read", async () => {
  const tempDir = await mkdtemp(resolve(tmpdir(), "figma-workspace-metadata-dynamic-"));
  const calls = [];
  const metadataNodeIds = [];
  const fakeClient = createFakeFigmaClient(
    calls,
    ({ name, args }) => {
      if (name === "get_metadata") {
        metadataNodeIds.push(args.nodeId);
        return {
          content: [{ type: "text", text: `<frame id="${args.nodeId}" name="Resolved" width="100" height="80" />` }],
        };
      }
      assert.equal(name, "use_figma");
      assert.equal(args.fileKey, "ExampleFigmaFileKey012");
      if (/const __selector/u.test(args.code)) {
        const selector = /const __selector = "\$currentPage"/u.test(args.code) ? "$currentPage" : "$selection";
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                ok: true,
                __figmaRepl: { sessionId: "metadata-dynamic", handles: {} },
                result: {
                  target: selector,
                  nodeId: selector === "$currentPage" ? "0:1" : "2:3",
                  nodeType: selector === "$currentPage" ? "PAGE" : "FRAME",
                  name: selector === "$currentPage" ? "Page 1" : "Selected frame",
                },
              }),
            },
          ],
        };
      }
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              ok: true,
              __figmaRepl: { sessionId: "metadata-dynamic", handles: {} },
              result: { enrichment: { nodes: {} } },
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
          inputSchema: { type: "object", properties: { code: { type: "string" }, fileKey: { type: "string" } } },
        },
        {
          name: "get_metadata",
          description: "Read XML metadata.",
          inputSchema: {
            type: "object",
            properties: {
              fileKey: { type: "string" },
              nodeId: { type: "string" },
              clientLanguages: { type: "string" },
              clientFrameworks: { type: "string" },
            },
          },
        },
      ],
    },
  );
  const repl = createFigmaWorkspaceClient({ client: fakeClient });

  try {
    const currentPage = await repl.getMetadata({
      sessionId: "metadata-dynamic",
      file: "ExampleFigmaFileKey012",
      workspaceDir: tempDir,
      target: "$currentPage",
    });
    assert.equal(currentPage.ok, true);
    assert.equal(currentPage.nodeId, "0:1");
    assert.equal(currentPage.metadata.json.root.nodeId, "0:1");

    const selection = await repl.getMetadata({
      sessionId: "metadata-dynamic",
      file: "ExampleFigmaFileKey012",
      workspaceDir: tempDir,
      target: "$selection",
    });
    assert.equal(selection.ok, true);
    assert.equal(selection.nodeId, "2:3");
    assert.equal(selection.metadata.json.root.nodeId, "2:3");
  } finally {
    await repl.close();
  }

  assert.deepEqual(metadataNodeIds, ["0:1", "2:3"]);
  assert.deepEqual(calls.filter((call) => call[0] === "callTool").map((call) => call[1]), [
    "use_figma",
    "get_metadata",
    "use_figma",
    "use_figma",
    "get_metadata",
    "use_figma",
  ]);
});

test("figma workspace get_metadata rejects missing file context before upstream discovery", async () => {
  const calls = [];
  const repl = createFigmaWorkspaceClient({
    client: createFakeFigmaClient(calls, () => {
      throw new Error("upstream should not be called for missing file context");
    }, {
      tools: [
        {
          name: "use_figma",
          description: "Execute JavaScript in the active Figma file.",
          inputSchema: { type: "object", properties: { code: { type: "string" }, fileKey: { type: "string" } } },
        },
        {
          name: "get_metadata",
          description: "Read XML metadata.",
          inputSchema: {
            type: "object",
            properties: {
              fileKey: { type: "string" },
              nodeId: { type: "string" },
              clientLanguages: { type: "string" },
              clientFrameworks: { type: "string" },
            },
          },
        },
      ],
    }),
  });

  try {
    await assert.rejects(
      repl.getMetadata({ sessionId: "metadata-missing-context", target: "$currentPage" }),
      /figma_workspace_get_metadata requires a Figma file key/,
    );
  } finally {
    await repl.close();
  }

  assert.deepEqual(calls, [["close"]]);
});

test("figma workspace get_metadata returns nonfatal warning when enrichment fails", async () => {
  const tempDir = await mkdtemp(resolve(tmpdir(), "figma-workspace-metadata-warning-"));
  const calls = [];
  const xml = `<frame id="1:2" name="Root" width="300" height="200" />`;
  const fakeClient = createFakeFigmaClient(
    calls,
    ({ name }) => {
      if (name === "get_metadata") {
        return {
          content: [{ type: "text", text: xml }],
        };
      }
      assert.equal(name, "use_figma");
      return {
        content: [{ type: "text", text: JSON.stringify({ ok: false, message: "Readback denied", code: "READBACK_DENIED" }) }],
      };
    },
    {
      tools: [
        {
          name: "use_figma",
          inputSchema: { type: "object", properties: { code: { type: "string" } } },
        },
        {
          name: "get_metadata",
          inputSchema: {
            type: "object",
            properties: {
              fileKey: { type: "string" },
              nodeId: { type: "string" },
              clientLanguages: { type: "string" },
              clientFrameworks: { type: "string" },
            },
          },
        },
      ],
    },
  );
  const repl = createFigmaWorkspaceClient({ client: fakeClient });

  try {
    const result = await repl.getMetadata({
      sessionId: "metadata-warning",
      file: "ExampleFigmaFileKey012",
      workspaceDir: tempDir,
      target: "1:2",
    });
    assert.equal(result.ok, true);
    assert.equal(result.metadata.json.root.nodeId, "1:2");
    assert.equal(result.metadata.json.root.locked, undefined);
    assert.equal(result.metadata.enrichment, undefined);
    assert.equal(result.diagnostics[0].severity, "warning");
    assert.equal(result.diagnostics[0].code, "FIGMA_METADATA_ENRICHMENT_FAILED");
    assert.equal(result.upstream.ok, true);
    assert.equal(result.upstreamError, undefined);
  } finally {
    await repl.close();
  }
  assert.deepEqual(calls.filter((call) => call[0] === "callTool").map((call) => call[1]), ["get_metadata", "use_figma"]);
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
      workspaceDir: tempDir,
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

    await assert.rejects(
      repl.getVariableDefs({
        sessionId: "design-system",
        target: "$button",
        clientLanguages: "typescript",
        clientFrameworks: "react",
      }),
      /Tool argument "clientLanguages\/clientFrameworks" was removed\. Use "figma_workspace_get_design_context"\./,
    );

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

test("figma workspace context motion wrappers and shader upstream proxy call official tools", async () => {
  const tempDir = await mkdtemp(resolve(tmpdir(), "figma-workspace-context-wrappers-"));
  const calls = [];
  const fakeClient = createFakeFigmaClient(
    calls,
    ({ name, args }) => {
      if (name === "get_design_context") {
        if (args.clientLanguages === "fail") {
          assert.deepEqual(args, {
            fileKey: "ExampleFigmaFileKey012",
            nodeId: "9:9",
            clientLanguages: "fail",
            clientFrameworks: "swiftui",
          });
          return {
            content: [{ type: "text", text: JSON.stringify({ ok: false, message: "Design context failed", code: "DESIGN_CONTEXT_FAILED" }) }],
          };
        }
        if (args.clientLanguages === undefined && args.clientFrameworks === undefined) {
          assert.deepEqual(args, {
            fileKey: "ExampleFigmaFileKey012",
            nodeId: "9:9",
          });
          return {
            content: [{ type: "text", text: JSON.stringify({ ok: true, code: "<div data-node-id=\"9:9\" data-hints=\"none\" />" }) }],
          };
        }
        assert.deepEqual(args, {
          fileKey: "ExampleFigmaFileKey012",
          nodeId: "9:9",
          clientLanguages: "swift",
          clientFrameworks: "swiftui",
          forceCode: true,
          disableCodeConnect: true,
          excludeScreenshot: true,
        });
        return {
          content: [{ type: "text", text: JSON.stringify({ ok: true, code: "<div data-node-id=\"9:9\" />" }) }],
        };
      }
      if (name === "get_motion_context") {
        if (args.clientLanguages !== undefined || args.clientFrameworks !== undefined) {
          assert.deepEqual(args, {
            fileKey: "ExampleFigmaFileKey012",
            nodeId: "9:9",
            recursive: true,
            clientLanguages: "swift",
            clientFrameworks: "swiftui",
          });
        } else {
          assert.deepEqual(args, { fileKey: "ExampleFigmaFileKey012", nodeId: "9:9", recursive: true });
        }
        return {
          content: [{ type: "text", text: JSON.stringify({ ok: true, nodes: [{ nodeId: "9:9" }] }) }],
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
        { name: "get_design_context", inputSchema: { type: "object", properties: { fileKey: { type: "string" }, nodeId: { type: "string" }, clientLanguages: { type: "string" }, clientFrameworks: { type: "string" }, forceCode: { type: "boolean" }, disableCodeConnect: { type: "boolean" }, excludeScreenshot: { type: "boolean" } } } },
        { name: "get_motion_context", inputSchema: { type: "object", properties: { fileKey: { type: "string" }, nodeId: { type: "string" }, recursive: { type: "boolean" }, clientLanguages: { type: "string" }, clientFrameworks: { type: "string" } } } },
        { name: "get_shader_fill", inputSchema: { type: "object", properties: { id: { type: "string" } } } },
      ],
    },
  );
  const repl = createFigmaWorkspaceClient({ client: fakeClient });

  try {
    await repl.open({
      sessionId: "context-main",
      file: "https://www.figma.com/design/ExampleFigmaFileKey012/UI",
      workspaceDir: tempDir,
      handles: { "$button": "9:9" },
      connect: false,
    });

    const design = await repl.getDesignContext({
      sessionId: "context-main",
      target: "$button",
      clientLanguages: "swift",
      clientFrameworks: "swiftui",
      forceCode: true,
      disableCodeConnect: true,
      excludeScreenshot: true,
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

    const designFromObjectTarget = await repl.getDesignContext({
      target: { fileKey: "ExampleFigmaFileKey012", nodeId: "9:9" },
    });
    assert.equal(designFromObjectTarget.ok, true);
    assert.equal(designFromObjectTarget.fileKey, "ExampleFigmaFileKey012");
    assert.equal(designFromObjectTarget.nodeId, "9:9");
    assert.equal(designFromObjectTarget.upstream.result.code, "<div data-node-id=\"9:9\" data-hints=\"none\" />");

    const motion = await repl.getMotionContext({
      sessionId: "context-main",
      target: "$button",
      recursive: true,
      clientLanguages: "swift",
      clientFrameworks: "swiftui",
    });
    assert.equal(motion.ok, true);
    assert.equal(motion.upstream.result.nodes[0].nodeId, "9:9");
    assert.equal(motion.guidance, undefined);
    assert.equal(motion.guidanceRef.source, "figma_workspace_guidance");
    assert.equal(motion.guidanceRef.query, "figma_workspace_get_motion_context get_motion_context motion-implementation");
    assert.deepEqual(motion.guidanceRef.workflowIds, ["motion-implementation"]);

    const motionFromNodeUrl = await repl.getMotionContext({
      target: "https://www.figma.com/design/ExampleFigmaFileKey012/UI?node-id=9-9",
      recursive: true,
    });
    assert.equal(motionFromNodeUrl.ok, true);
    assert.equal(motionFromNodeUrl.fileKey, "ExampleFigmaFileKey012");
    assert.equal(motionFromNodeUrl.nodeId, "9:9");

    const fill = await repl.callUpstreamTool({
      sessionId: "context-main",
      toolName: "get_shader_fill",
      arguments: { id: "fill-1" },
    });
    assert.equal(fill.ok, true);
    assert.equal(fill.toolName, "get_shader_fill");
    assert.equal(fill.upstream.result.source, "fill");

    const failedDesign = await repl.getDesignContext({
      sessionId: "context-main",
      target: "$button",
      clientLanguages: "fail",
      clientFrameworks: "swiftui",
    });
    assert.equal(failedDesign.ok, false);
    assert.equal(failedDesign.upstreamError.code, "DESIGN_CONTEXT_FAILED");
    assert.match(failedDesign.primaryFix, /repair the upstream Plugin API error/);

  } finally {
    await repl.close();
  }
  assert.deepEqual(calls.filter((call) => call[0] === "callTool").map((call) => call[1]), [
    "get_design_context",
    "get_design_context",
    "get_motion_context",
    "get_motion_context",
    "get_shader_fill",
    "get_design_context",
  ]);
});

test("figma workspace design context retries selection-dependent upstream failures", async () => {
  const calls = [];
  let designContextCalls = 0;
  const fakeClient = createFakeFigmaClient(
    calls,
    ({ name, args }) => {
      if (name === "get_design_context") {
        designContextCalls += 1;
        assert.deepEqual(args, { fileKey: "file123", nodeId: "22:7" });
        if (designContextCalls === 1) {
          return { content: [{ type: "text", text: "Error: You currently have nothing selected" }] };
        }
        return { content: [{ type: "text", text: JSON.stringify({ ok: true, code: "<div data-node-id=\"22:7\" />" }) }] };
      }
      if (name === "use_figma") {
        assert.match(args.code, /figma\.currentPage\.selection = \[__node\]/u);
        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              ok: true,
              result: { selected: true, nodeId: "22:7", nodeType: "FRAME" },
            }),
          }],
        };
      }
      assert.fail(`unexpected tool ${name}`);
      return { content: [] };
    },
    {
      tools: [
        { name: "get_design_context", inputSchema: { type: "object", properties: { fileKey: { type: "string" }, nodeId: { type: "string" } } } },
        { name: "use_figma", inputSchema: { type: "object", properties: { code: { type: "string" } }, required: ["code"] } },
      ],
    },
  );
  const repl = createFigmaWorkspaceClient({ client: fakeClient });
  try {
    const result = await repl.getDesignContext({
      target: { fileKey: "file123", nodeId: "22:7" },
    });
    assert.equal(result.ok, true);
    assert.equal(result.upstream.result.code, "<div data-node-id=\"22:7\" />");
    assert.equal(result.diagnostics, undefined);
  } finally {
    await repl.close();
  }
  assert.deepEqual(calls.filter((call) => call[0] === "callTool").map((call) => call[1]), [
    "get_design_context",
    "use_figma",
    "get_design_context",
  ]);
});

test("figma workspace variable defs reports page targets as non-selectable after selection-dependent upstream failures", async () => {
  const calls = [];
  const fakeClient = createFakeFigmaClient(
    calls,
    ({ name, args }) => {
      if (name === "get_variable_defs") {
        assert.deepEqual(args, { fileKey: "file123", nodeId: "670:1337" });
        return { content: [{ type: "text", text: "Error: You currently have nothing selected" }] };
      }
      if (name === "use_figma") {
        assert.match(args.code, /unsupported-container-target/u);
        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              ok: true,
              result: { selected: false, reason: "unsupported-container-target", nodeId: "670:1337", nodeType: "PAGE", name: "re mean", childCount: 42 },
            }),
          }],
        };
      }
      assert.fail(`unexpected tool ${name}`);
      return { content: [] };
    },
    {
      tools: [
        { name: "get_variable_defs", inputSchema: { type: "object", properties: { fileKey: { type: "string" }, nodeId: { type: "string" } } } },
        { name: "use_figma", inputSchema: { type: "object", properties: { code: { type: "string" } }, required: ["code"] } },
      ],
    },
  );
  const repl = createFigmaWorkspaceClient({ client: fakeClient });
  try {
    const result = await repl.getVariableDefs({
      target: { fileKey: "file123", nodeId: "670:1337" },
    });
    assert.equal(result.ok, false);
    assert.equal(result.upstreamError.code, "FIGMA_UPSTREAM_TEXT_ERROR");
    assert.equal(result.diagnostics[0].code, "FIGMA_WORKSPACE_CONTEXT_TARGET_NOT_SELECTABLE");
    assert.equal(result.diagnostics[0].severity, "fatal");
    assert.match(result.diagnostics[0].message, /PAGE/u);
    assert.match(result.diagnostics[0].suggestion, /smaller selectable child node/u);
  } finally {
    await repl.close();
  }
  assert.deepEqual(calls.filter((call) => call[0] === "callTool").map((call) => call[1]), [
    "get_variable_defs",
    "use_figma",
  ]);
});

test("figma workspace motion context retries selection-dependent upstream failures", async () => {
  const calls = [];
  let motionContextCalls = 0;
  const fakeClient = createFakeFigmaClient(
    calls,
    ({ name, args }) => {
      if (name === "get_motion_context") {
        motionContextCalls += 1;
        assert.deepEqual(args, { fileKey: "file123", nodeId: "22:8", recursive: true });
        if (motionContextCalls === 1) {
          return { content: [{ type: "text", text: "Error: You currently have nothing selected" }] };
        }
        return { content: [{ type: "text", text: JSON.stringify({ ok: true, nodes: [{ nodeId: "22:8" }] }) }] };
      }
      if (name === "use_figma") {
        assert.match(args.code, /figma\.currentPage\.selection = \[__node\]/u);
        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              ok: true,
              result: { selected: true, nodeType: "FRAME" },
            }),
          }],
        };
      }
      assert.fail(`unexpected tool ${name}`);
      return { content: [] };
    },
    {
      tools: [
        { name: "get_motion_context", inputSchema: { type: "object", properties: { fileKey: { type: "string" }, nodeId: { type: "string" }, recursive: { type: "boolean" } } } },
        { name: "use_figma", inputSchema: { type: "object", properties: { code: { type: "string" } }, required: ["code"] } },
      ],
    },
  );
  const repl = createFigmaWorkspaceClient({ client: fakeClient });
  try {
    const motion = await repl.getMotionContext({
      target: { fileKey: "file123", nodeId: "22:8" },
      recursive: true,
    });
    assert.equal(motion.ok, true);
    assert.equal(motion.upstream.result.nodes[0].nodeId, "22:8");
  } finally {
    await repl.close();
  }
  assert.deepEqual(calls.filter((call) => call[0] === "callTool").map((call) => call[1]), [
    "get_motion_context",
    "use_figma",
    "get_motion_context",
  ]);
});

test("figma workspace selection-dependent retry only matches official nothing-selected wording", async () => {
  const calls = [];
  const fakeClient = createFakeFigmaClient(
    calls,
    ({ name, args }) => {
      if (name === "get_design_context") {
        assert.deepEqual(args, { fileKey: "file123", nodeId: "22:7" });
        return { content: [{ type: "text", text: "Error: Selection is empty for this operation" }] };
      }
      assert.fail(`unexpected retry tool ${name}`);
      return { content: [] };
    },
    {
      tools: [
        { name: "get_design_context", inputSchema: { type: "object", properties: { fileKey: { type: "string" }, nodeId: { type: "string" } } } },
        { name: "use_figma", inputSchema: { type: "object", properties: { code: { type: "string" } }, required: ["code"] } },
      ],
    },
  );
  const repl = createFigmaWorkspaceClient({ client: fakeClient });
  try {
    const result = await repl.getDesignContext({
      target: { fileKey: "file123", nodeId: "22:7" },
    });
    assert.equal(result.ok, false);
    assert.equal(result.upstreamError.code, "FIGMA_UPSTREAM_TEXT_ERROR");
    assert.equal(result.diagnostics, undefined);
  } finally {
    await repl.close();
  }
  assert.deepEqual(calls.filter((call) => call[0] === "callTool").map((call) => call[1]), [
    "get_design_context",
  ]);
});

test("figma workspace thin wrappers warn and omit supplied optional args missing from live upstream schema", async () => {
  const calls = [];
  const fakeClient = createFakeFigmaClient(
    calls,
    ({ name, args }) => {
      assert.equal(name, "get_design_context");
      assert.deepEqual(args, {
        fileKey: "ExampleFigmaFileKey012",
        nodeId: "9:9",
        clientLanguages: "typescript",
      });
      return {
        content: [{ type: "text", text: JSON.stringify({ ok: true, code: "<div data-node-id=\"9:9\" />" }) }],
      };
    },
    {
      tools: [
        {
          name: "get_design_context",
          inputSchema: {
            type: "object",
            properties: {
              fileKey: { type: "string" },
              nodeId: { type: "string" },
              clientLanguages: { type: "string" },
            },
            required: ["fileKey", "nodeId"],
          },
        },
      ],
    },
  );
  const repl = createFigmaWorkspaceClient({ client: fakeClient });

  try {
    const result = await repl.getDesignContext({
      target: { fileKey: "ExampleFigmaFileKey012", nodeId: "9:9" },
      clientLanguages: "typescript",
      forceCode: true,
    });
    assert.equal(result.ok, true);
    assert.equal(result.upstream.result.code, "<div data-node-id=\"9:9\" />");
    assert.equal(result.diagnostics.length, 1);
    assert.equal(result.diagnostics[0].code, "FIGMA_WORKSPACE_UPSTREAM_OPTIONAL_SKIPPED");
    assert.equal(result.diagnostics[0].severity, "warning");
    assert.match(result.diagnostics[0].message, /forceCode/);
    assert.match(result.diagnostics[0].message, /get_design_context/);
  } finally {
    await repl.close();
  }
  assert.deepEqual(calls.filter((call) => call[0] !== "close").map((call) => call[0]), [
    "connect",
    "listTools",
    "callTool",
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
      name: "figma_workspace_inspect",
      arguments: {
        title: "Reject inspect object target",
        target: { fileKey: "file123", nodeId: "22:7" },
      },
    }),
    /Tool argument "target" must be a string selector, handle, node id, or node URL\. Do not pass \{ fileKey, nodeId \} to figma_workspace_inspect\./,
  );
  await assert.rejects(
    mcpClient.callTool({
      name: "figma_workspace_get_metadata",
      arguments: {
        title: "Reject metadata numeric target",
        target: 123,
      },
    }),
    /Tool argument "target" must be a string or object\./,
  );
  await assert.rejects(
    mcpClient.callTool({
      name: "figma_workspace_get_metadata",
      arguments: {
        title: "Reject metadata malformed object target",
        target: { nodeId: 123 },
      },
    }),
    /Tool argument "target\.nodeId" must be a string\./,
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
  const missingManifestResult = await mcpClient.callTool({
    name: "figma_workspace_apply_asset_manifest",
    arguments: {
      title: "Missing manifest is structured",
      manifestPath: resolve(tmpdir(), `figma-workspace-missing-${Date.now()}.json`),
    },
  });
  const missingManifestJson = structuredToolResult(missingManifestResult);
  assert.equal(missingManifestJson.ok, false);
  assert.equal(missingManifestJson.diagnostics[0].code, "FIGMA_WORKSPACE_ASSET_MANIFEST_LOAD_FAILED");
  assert.match(missingManifestJson.failures[0].message, /Unable to read asset manifest/u);
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
        title: "Reject hidden screenshot base64",
        target: { fileKey: "file123", nodeId: "22:7" },
        enableBase64Response: true,
      },
    }),
    /Tool argument "enableBase64Response" was removed\. Use "figma_workspace_call_upstream_tool"\./,
  );
  await assert.rejects(
    mcpClient.callTool({
      name: "figma_workspace_capture_node",
      arguments: {
        title: "Reject capture max dimension",
        target: { fileKey: "file123", nodeId: "22:7" },
        maxDimension: 65537,
      },
    }),
    /Tool argument "maxDimension" must be an integer from 1 to 65536\./,
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
  await assert.rejects(
    mcpClient.callTool({
      name: "figma_workspace_apply_asset_manifest",
      arguments: {
        title: "Reject hidden upload batch commit",
        batchCommit: true,
      },
    }),
    /Tool argument "batchCommit" was removed\. Use "figma_workspace_call_upstream_tool"\./,
  );
  await assert.rejects(
    mcpClient.callTool({
      name: "figma_workspace_get_variable_defs",
      arguments: {
        title: "Reject variable defs legacy client hints",
        target: { fileKey: "file123", nodeId: "22:7" },
        clientLanguages: "typescript",
      },
    }),
    /Tool argument "clientLanguages\/clientFrameworks" was removed\. Use "figma_workspace_get_design_context"\./,
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
    const manifestSubdir = resolve(badManifestDir, "nested");
    await mkdir(manifestSubdir);
    const escapedAsset = resolve(badManifestDir, "outside.png");
    await writeFile(escapedAsset, "outside asset", "utf8");
    const escapedManifest = resolve(manifestSubdir, "escaped-asset.json");
    await writeFile(
      escapedManifest,
      JSON.stringify({ assets: [{ path: "../outside.png", target: "12:34" }] }),
      "utf8",
    );
    await assert.rejects(
      mcpClient.callTool({
        name: "figma_workspace_apply_asset_manifest",
        arguments: {
          title: "Reject relative asset path traversal",
          manifestPath: escapedManifest,
        },
      }),
      /Asset manifest entry 0 path must stay inside manifest directory\./,
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
  for (const [field, value] of [
    ["cwd", "/tmp/project"],
    ["workspaceCwd", "/tmp/project"],
    ["dirName", "figma-workspace"],
    ["taskRoot", "/tmp/tasks"],
  ]) {
    await assert.rejects(
      mcpClient.callTool({
        name: "figma_workspace_prepare_task",
        arguments: {
          title: `Reject prepare ${field}`,
          [field]: value,
        },
      }),
      /Tool argument ".*" was removed\. Use "workspaceDir"\./,
    );
  }
  await assert.rejects(
    mcpClient.callTool({
      name: "figma_workspace_prepare_task",
      arguments: {
        title: "Reject prepare scriptName alias",
        scriptName: "task.figma.ts",
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
        workspaceDir: tempDir,
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

test("figma workspace applies same-directory relative asset manifest paths", async () => {
  const tempDir = await mkdtemp(resolve(tmpdir(), "figma-workspace-assets-relative-"));
  const assetPath = resolve(tempDir, "hero.png");
  const manifestPath = resolve(tempDir, "assets.json");
  await writeFile(assetPath, "fake image bytes", "utf8");
  await writeFile(
    manifestPath,
    JSON.stringify({ assets: [{ path: "hero.png", target: "12:34", name: "Hero art" }] }),
    "utf8",
  );
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
        title: "Open relative asset file context",
        sessionId: "asset-relative",
        connect: false,
        file: "https://www.figma.com/design/file123/Test",
        workspaceDir: tempDir,
      },
    });

    const result = await mcpClient.callTool({
      name: "figma_workspace_apply_asset_manifest",
      arguments: {
        title: "Apply relative manifest assets",
        sessionId: "asset-relative",
        manifestPath,
      },
    });
    const json = structuredToolResult(result);
    assert.equal(json.ok, true);
    assert.equal(json.assets.length, 1);
    assert.equal(json.assets[0].path, assetPath);
    assert.equal(json.assets[0].upstreamError, undefined);
    assert.equal(json.failures, undefined);
    assert.equal(json.outputFiles, undefined);
    assert.deepEqual(calls.map((call) => call[0]), ["connect", "listTools", "callTool"]);
    await mcpClient.close();
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("figma workspace asset manifest validation splits readback when upstream truncates a large target batch", async () => {
  const tempDir = await mkdtemp(resolve(tmpdir(), "figma-workspace-assets-validate-batch-"));
  const assetPath = resolve(tempDir, "hero.png");
  await writeFile(assetPath, "fake image bytes", "utf8");
  const targetIds = Array.from({ length: 81 }, (_, index) => `12:${index + 1}`);
  const batchSizes = [];
  const fakeClient = createFakeFigmaClient(
    [],
    ({ name, args }) => {
      if (name === "upload_assets") {
        return { content: [{ type: "text", text: JSON.stringify({ ok: true, result: { id: args.nodeId } }) }] };
      }
      assert.equal(name, "use_figma");
      const idsMatch = /const targetNodeIds = (\[[^;]+\]);/u.exec(args.code);
      assert.ok(idsMatch);
      const ids = JSON.parse(idsMatch[1]);
      batchSizes.push(ids.length);
      if (ids.length > 40) {
        return { content: [{ type: "text", text: `${JSON.stringify({ ok: true })}\n// truncated to 20kb` }] };
      }
      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            ok: true,
            result: {
              validations: ids.map((targetNodeId) => ({ targetNodeId, status: "valid", nodeId: targetNodeId, nodeType: "RECTANGLE", fillCount: 1, imageFillCount: 1 })),
              validCount: ids.length,
              invalidCount: 0,
            },
          }),
        }],
      };
    },
    {
      tools: [
        { name: "upload_assets", description: "Official upload tool.", inputSchema: { type: "object", properties: { fileKey: { type: "string" }, count: { type: "number" }, nodeId: { type: "string" }, scaleMode: { type: "string" } } } },
        { name: "use_figma", description: "Fake eval tool.", inputSchema: { type: "object", properties: { code: { type: "string" } } } },
      ],
    },
  );
  const { server } = createFigmaWorkspaceMcpServer({ client: fakeClient });
  const mcpClient = new Client({ name: "test-client", version: "0.1.0" }, { capabilities: {} });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

  try {
    await server.connect(serverTransport);
    await mcpClient.connect(clientTransport);
    await mcpClient.callTool({
      name: "figma_workspace_open",
      arguments: {
        sessionId: "asset-validate-batch",
        connect: false,
        file: "https://www.figma.com/design/file123/Test",
        workspaceDir: tempDir,
      },
    });
    const result = await mcpClient.callTool({
      name: "figma_workspace_apply_asset_manifest",
      arguments: {
        sessionId: "asset-validate-batch",
        assets: targetIds.map((target) => ({ path: assetPath, target })),
      },
    });
    const json = structuredToolResult(result);
    assert.equal(json.ok, true);
    assert.equal(json.validation.ok, true);
    assert.equal(json.validation.validCount, 81);
    assert.equal(json.validation.validations.length, 81);
    assert.equal(json.assets[80].validation.status, "valid");
    assert.deepEqual(batchSizes, [80, 40, 40, 1]);
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
        workspaceDir: tempDir,
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
        workspaceDir: tempDir,
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
        workspaceDir: tempDir,
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
        workspaceDir: tempDir,
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
        workspaceDir: tempDir,
        file: "https://www.figma.com/design/file123/Test",
        workspaceDir: tempDir,
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
        workspaceDir: tempDir,
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
        workspaceDir: tempDir,
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

test("figma workspace asset manifest application splits writeback when upstream truncates a large target batch", async () => {
  const tempDir = await mkdtemp(resolve(tmpdir(), "figma-workspace-assets-apply-batch-"));
  const assetPath = resolve(tempDir, "hero.png");
  await writeFile(assetPath, "fake image bytes", "utf8");
  const targetIds = Array.from({ length: 81 }, (_, index) => `12:${index + 1}`);
  const applicationBatchSizes = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(
    JSON.stringify({ success: true, imageHash: "abc", sizeBytes: 16, contentType: "image/png" }),
    { status: 200, headers: { "Content-Type": "application/json" } },
  );
  const fakeClient = createFakeFigmaClient(
    [],
    ({ name, args }) => {
      if (name === "upload_assets") {
        return {
          content: [{ type: "text", text: JSON.stringify({ uploads: [{ submitUrl: "https://example.test/upload" }] }) }],
        };
      }
      assert.equal(name, "use_figma");
      const assetsMatch = /const assetFills = (\[[\s\S]*?\]);\nconst applications/u.exec(args.code);
      assert.ok(assetsMatch);
      const assets = JSON.parse(assetsMatch[1]);
      applicationBatchSizes.push(assets.length);
      if (assets.length > 40) {
        return { content: [{ type: "text", text: `${JSON.stringify({ ok: true })}\n// truncated to 20kb` }] };
      }
      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            ok: true,
            result: {
              applications: assets.map((asset) => ({
                targetNodeId: asset.targetNodeId,
                status: "applied",
                nodeId: asset.targetNodeId,
                nodeType: "RECTANGLE",
                imageHash: asset.imageHash,
                scaleMode: asset.scaleMode,
              })),
              appliedCount: assets.length,
              failedCount: 0,
            },
          }),
        }],
      };
    },
    {
      tools: [
        { name: "upload_assets", description: "Official upload tool.", inputSchema: { type: "object", properties: { fileKey: { type: "string" }, count: { type: "number" }, nodeId: { type: "string" }, scaleMode: { type: "string" } } } },
        { name: "use_figma", description: "Fake eval tool.", inputSchema: { type: "object", properties: { code: { type: "string" } } } },
      ],
    },
  );
  const { server } = createFigmaWorkspaceMcpServer({ client: fakeClient });
  const mcpClient = new Client({ name: "test-client", version: "0.1.0" }, { capabilities: {} });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

  try {
    await server.connect(serverTransport);
    await mcpClient.connect(clientTransport);
    await mcpClient.callTool({
      name: "figma_workspace_open",
      arguments: {
        sessionId: "asset-apply-batch",
        connect: false,
        file: "https://www.figma.com/design/file123/Test",
        workspaceDir: tempDir,
      },
    });
    const result = await mcpClient.callTool({
      name: "figma_workspace_apply_asset_manifest",
      arguments: {
        sessionId: "asset-apply-batch",
        assets: targetIds.map((target) => ({ path: assetPath, target })),
        validateTargets: false,
      },
    });
    const json = structuredToolResult(result);
    assert.equal(json.ok, true);
    assert.equal(json.application.ok, true);
    assert.equal(json.application.appliedCount, 81);
    assert.equal(json.application.applications.length, 81);
    assert.equal(json.assets[80].application.status, "applied");
    assert.deepEqual(applicationBatchSizes, [80, 40, 40, 1]);
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
        workspaceDir: tempDir,
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
        workspaceDir: tempDir,
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
        workspaceDir: tempDir,
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
        workspaceDir: tempDir,
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
        workspaceDir: tempDir,
        file: "https://www.figma.com/design/file123/Test",
        workspaceDir: tempDir,
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
        workspaceDir: tempDir,
        file: "https://www.figma.com/design/file123/Test",
        workspaceDir: tempDir,
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

test("figma workspace download_assets warns and omits supplied optional args missing from live upstream schema", async () => {
  const tempDir = await mkdtemp(resolve(tmpdir(), "figma-workspace-download-optional-drift-"));
  const outputDir = resolve(tempDir, "downloads");
  const pngBytes = Buffer.from("downloaded png bytes");
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(pngBytes, { status: 200, headers: { "Content-Type": "image/png" } });
  const calls = [];
  const fakeClient = createFakeFigmaClient(
    calls,
    ({ name, args }) => {
      assert.equal(name, "download_assets");
      assert.deepEqual(args, {
        fileKey: "file123",
        nodeId: "22:8",
      });
      return {
        content: [{
          type: "text",
          text: JSON.stringify({ exports: [{ url: "https://assets.example/hero.png", format: "png" }] }),
        }],
      };
    },
    {
      tools: [
        {
          name: "download_assets",
          description: "Download tool with optional defaultFormat drift.",
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

  try {
    await server.connect(serverTransport);
    await mcpClient.connect(clientTransport);
    await mcpClient.callTool({
      name: "figma_workspace_open",
      arguments: {
        title: "Open drifted download file context",
        sessionId: "drifted-download",
        connect: false,
        file: "https://www.figma.com/design/file123/Test",
        workspaceDir: tempDir,
      },
    });
    const result = await mcpClient.callTool({
      name: "figma_workspace_download_assets",
      arguments: {
        title: "Download drifted assets",
        sessionId: "drifted-download",
        targets: [{ target: "22:8", name: "Hero", defaultFormat: "png" }],
        outputDir,
      },
    });
    const json = structuredToolResult(result);
    assert.equal(json.ok, true);
    assert.equal(json.targets.length, 1);
    assert.equal(json.targets[0].downloadedFiles[0].path, resolve(outputDir, "hero", "exported.png"));
    assert.deepEqual(await readFile(resolve(outputDir, "hero", "exported.png")), pngBytes);
    assert.equal(json.diagnostics.length, 1);
    assert.equal(json.diagnostics[0].code, "FIGMA_WORKSPACE_UPSTREAM_OPTIONAL_SKIPPED");
    assert.equal(json.diagnostics[0].severity, "warning");
    assert.match(json.diagnostics[0].message, /defaultFormat/);
    assert.deepEqual(calls.map((call) => call[0]), ["connect", "listTools", "callTool"]);
    await mcpClient.close();
  } finally {
    globalThis.fetch = originalFetch;
    await rm(tempDir, { recursive: true, force: true });
  }
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
        workspaceDir: tempDir,
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
      assert.deepEqual(args, { fileKey: "file123", nodeId: "22:8", maxDimension: 1600, contentsOnly: true });
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
          inputSchema: { type: "object", properties: { fileKey: { type: "string" }, nodeId: { type: "string" }, maxDimension: { type: "number" }, contentsOnly: { type: "boolean" } }, required: ["fileKey", "nodeId"] },
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
        maxDimension: 1600,
        contentsOnly: true,
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
  const scriptPath = resolve(tempDir, "script.figma.ts");
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
          dir: resolve(tempDir, "file123", "download-step.downloads"),
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
      await readFile(resolve(tempDir, "file123", "download-step.downloads", "hero", "exported.png")),
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
        workspaceDir: tempDir,
        file: "file123",
        taskName: "workspace-plan",
        surface: "design",
        overwrite: true,
      },
    });
    const initJson = structuredToolResult(initResult);
    const fileDir = initJson.task.workspace.fileDir;
    await writeFile(resolve(fileDir, "workspace-plan.figma.ts"), "return { summary: 'dry run' };", "utf8");
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
              inputFile: "workspace-plan.figma.ts",
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
    diagnoseFigmaWorkspaceCode(
      [
        "const frame = figma.createFrame();",
        "frame.layoutMode = 'VERTICAL';",
        "frame.primaryAxisSizingMode = 'AUTO';",
        "figma.currentPage.appendChild(frame);",
        "const cards = frame.findAll((node) => node.type === 'FRAME');",
        "return { frameId: frame.id, cards: cards.length };",
      ].join("\n"),
      { strict: true, expectedSurface: "design" },
    ).map((item) => item.code),
    [],
  );
  assert.deepEqual(
    diagnoseFigmaWorkspaceCode("const helperName = 'text';\nreturn await $[helperName]({ text: 'Card' });").map((item) => item.code),
    ["FIGMA_WORKSPACE_DYNAMIC_HELPER_ACCESS"],
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
    diagnoseFigmaWorkspaceCode("node.x = node.x + 1;", { mode: "read" }).map((item) => item.code),
    ["FIGMA_WORKSPACE_READ_MODE_ASSIGNMENT"],
  );
  assert.deepEqual(
    diagnoseFigmaWorkspaceCode("node['visible'] = false;", { mode: "read" }).map((item) => item.code),
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
  assert.ok(diagnosticHints.every((hint) => !hint.includes("figma-workspace://runtime")));
});

test("figma workspace run_script_file returns preflight diagnostics without upstream execution", async () => {
  const tempDir = await mkdtemp(resolve(tmpdir(), "figma-workspace-script-"));
  const scriptName = "script.figma.ts";
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
        "const title = figma.createText();",
        "title.characters = 'Published';",
        "return { id: title.id };",
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
    assert.equal(json.diagnostics[0].source.line, 1);
    assert.equal(json.diagnostics[0].source.column, 19);
    assert.equal(json.primaryFix, undefined);
    assert.equal(json.repairPlan.status, "blocked");
    assert.equal(json.repairPlan.steps.length, 1);
    assert.equal(json.repairPlan.steps[0].code, "FIGMA_WORKSPACE_TEXT_MUTATION_NEEDS_FONT");
    assert.deepEqual(json.repairPlan.steps[0].occurrences, [{
      scriptPath,
      line: 1,
      column: 19,
      label: "1:19",
    }]);
    const resultFile = await readPrettyJsonPointer(json.outputFiles.debugFile, resolve(fileDir, "script.result.json"));
    assert.equal(resultFile.phase, "preflight");
    assert.equal(resultFile.executed, false);
    assert.equal(resultFile.script.diagnosticsCount, undefined);
    assert.equal(resultFile.script.executed, undefined);
    assert.equal(resultFile.diagnosticsCount, 1);
    assert.equal(resultFile.diagnostics[0].source.column, 19);
    assert.equal(resultFile.primaryFix, undefined);
    assert.equal(resultFile.repairPlan.status, "blocked");
    assert.equal(resultFile.repairPlan.steps[0].occurrences[0].label, "1:19");
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

test("figma workspace run_script_file type-checks .figma.ts before upstream execution", async () => {
  const tempDir = await mkdtemp(resolve(tmpdir(), "figma-workspace-ts-preflight-"));
  const scriptName = "typed-error.figma.ts";
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
    const fileDir = await openTestWorkspace(mcpClient, { tempDir, sessionId: "typed-main" });
    const scriptPath = resolve(fileDir, scriptName);
    await writeFile(
      scriptPath,
      [
        "const rect: RectangleNode = figma.createRectangle();",
        "rect.appendChild(figma.createFrame());",
        "return { id: rect.id };",
      ].join("\n"),
      "utf8",
    );

    const result = await mcpClient.callTool({
      name: "figma_workspace_run_script_file",
      arguments: {
        sessionId: "typed-main",
        inputFile: scriptName,
        strict: true,
        surface: "design",
      },
    });
    const json = structuredToolResult(result);
    assert.equal(json.ok, false);
    assert.equal(json.phase, "preflight");
    assert.equal(json.executed, false);
    assert.equal(json.diagnostics[0].code, "FIGMA_WORKSPACE_TS_TYPE_ERROR");
    assert.match(json.diagnostics[0].message, /appendChild/u);
    assert.match(json.diagnostics[0].message, /RectangleNode/u);
    assert.equal(json.diagnostics[0].source.scriptPath, scriptPath);
    assert.equal(json.diagnostics[0].source.line, 2);
    assert.equal(json.repairPlan.status, "blocked");
    assert.equal(json.repairPlan.steps[0].code, "FIGMA_WORKSPACE_TS_TYPE_ERROR");
    assert.equal(json.outputFiles.compiledScriptFile, undefined);
    const resultFile = await readPrettyJsonPointer(json.outputFiles.debugFile, resolve(fileDir, "typed-error.result.json"));
    assert.equal(resultFile.phase, "preflight");
    assert.equal(resultFile.diagnostics[0].code, "FIGMA_WORKSPACE_TS_TYPE_ERROR");
    assert.deepEqual(calls.map((call) => call[0]), []);
    await mcpClient.close();
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("figma workspace run_script_file reads canonical helper declarations and rejects removed helpers", async () => {
  const helperDeclarations = await readFile(resolve(packageRoot, "src/runtime/figma-workspace-helpers.d.ts"), "utf8");
  const scriptRunnerSource = await readFile(resolve(packageRoot, "src/runtime/script-runner.ts"), "utf8");
  assert.match(helperDeclarations, /interface FigmaWorkspaceDollar/);
  assert.match(helperDeclarations, /readonly handles: Readonly<Record<string, string>>;/);
  assert.doesNotMatch(scriptRunnerSource, /interface FigmaWorkspaceDollar/);
  assert.match(scriptRunnerSource, /loadFigmaWorkspaceTypescriptRuntimeAssets/);
  assert.match(scriptRunnerSource, /typescriptRuntimeAssets\.helperDeclarations/);
  for (const helperTerm of removedDollarHelperTerms) {
    assert.equal(helperDeclarations.includes(helperTerm), false, `canonical helper declaration must not include ${helperTerm}`);
  }

  const tempDir = await mkdtemp(resolve(tmpdir(), "figma-workspace-removed-helper-"));
  const scriptName = "removed-helper.figma.ts";
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
    const fileDir = await openTestWorkspace(mcpClient, { tempDir, sessionId: "helper-contract" });
    await writeFile(
      resolve(fileDir, scriptName),
      "return await $.find({ name: 'Card' });",
      "utf8",
    );

    const result = await mcpClient.callTool({
      name: "figma_workspace_run_script_file",
      arguments: {
        sessionId: "helper-contract",
        inputFile: scriptName,
        strict: true,
        surface: "design",
      },
    });
    const json = structuredToolResult(result);
    assert.equal(json.ok, false);
    assert.equal(json.phase, "preflight");
    assert.equal(json.executed, false);
    assert.equal(json.diagnostics[0].code, "FIGMA_WORKSPACE_TS_TYPE_ERROR");
    assert.match(json.diagnostics[0].message, /Property 'find' does not exist on type 'FigmaWorkspaceDollar'/u);
    assert.deepEqual(calls.map((call) => call[0]), []);
    await mcpClient.close();
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("figma workspace run_script_file rejects direct handles mutation and accepts remember", async () => {
  const tempDir = await mkdtemp(resolve(tmpdir(), "figma-workspace-handles-mutation-"));
  const calls = [];
  const fakeClient = createFakeFigmaClient(calls, ({ name, args }) => {
    assert.equal(name, "use_figma");
    assert.match(args.code, /\$\.remember = remember;/u);
    assert.doesNotMatch(args.code, /\$\.handles = __figmaRepl\.handles;/u);
    return {
      content: [{
        type: "text",
        text: JSON.stringify({
          ok: true,
          __figmaRepl: { sessionId: "handles-main", handles: { "$card": "70:1" } },
          result: { remembered: "70:1" },
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
    const fileDir = await openTestWorkspace(mcpClient, { tempDir, sessionId: "handles-main" });
    const directMutationScript = "handles-direct-mutation.figma.ts";
    await writeFile(
      resolve(fileDir, directMutationScript),
      "$.handles['$card'] = '70:1';\nreturn { handles: $.handles };",
      "utf8",
    );

    const directMutationResult = await mcpClient.callTool({
      name: "figma_workspace_run_script_file",
      arguments: {
        sessionId: "handles-main",
        inputFile: directMutationScript,
        strict: true,
        surface: "design",
      },
    });
    const directMutationJson = structuredToolResult(directMutationResult);
    assert.equal(directMutationJson.ok, false);
    assert.equal(directMutationJson.phase, "preflight");
    assert.equal(directMutationJson.executed, false);
    assert.equal(directMutationJson.diagnostics[0].code, "FIGMA_WORKSPACE_TS_TYPE_ERROR");
    assert.match(directMutationJson.diagnostics[0].message, /only permits reading/u);

    const rememberScript = "handles-remember.figma.ts";
    await writeFile(
      resolve(fileDir, rememberScript),
      [
        "const frame: FrameNode = figma.createFrame();",
        "frame.name = 'Remembered frame';",
        "const remembered: string = $.remember('$card', frame);",
        "return { remembered };",
      ].join("\n"),
      "utf8",
    );
    const rememberResult = await mcpClient.callTool({
      name: "figma_workspace_run_script_file",
      arguments: {
        sessionId: "handles-main",
        inputFile: rememberScript,
        strict: true,
        surface: "design",
      },
    });
    const rememberJson = structuredToolResult(rememberResult);
    assert.equal(rememberJson.ok, true);
    assert.equal(rememberJson.phase, "execute");
    assert.deepEqual(rememberJson.session.handleChanges.updated, ["$card"]);
    assert.equal(rememberJson.upstream.result.remembered, "70:1");
    await mcpClient.close();
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
  assert.deepEqual(calls.filter((call) => call[0] === "callTool").map((call) => call[1]), ["use_figma"]);
});

test("figma workspace run_script_file returns all recoverable parse errors without guardrail scan", async () => {
  const tempDir = await mkdtemp(resolve(tmpdir(), "figma-workspace-parse-plan-"));
  const scriptName = "parse-errors.figma.ts";
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
    assert.match(json.repairPlan.summary, /Fix all TypeScript syntax errors/);
    assert.deepEqual(json.repairPlan.steps.map((step) => step.code), [
      "FIGMA_WORKSPACE_PARSE_ERROR",
      "FIGMA_WORKSPACE_PARSE_ERROR",
    ]);
    assert.deepEqual(json.repairPlan.steps.map((step) => step.occurrences[0].label), ["2:5", "4:9"]);
    assert.equal(json.repairPlan.steps.some((step) => /selection|remove|createImage/u.test(step.message)), false);
    const resultFile = await readPrettyJsonPointer(json.outputFiles.debugFile, resolve(fileDir, "parse-errors.result.json"));
    assert.deepEqual(resultFile.repairPlan.steps.map((step) => step.occurrences[0].label), ["2:5", "4:9"]);
    assert.deepEqual(calls.map((call) => call[0]), []);
    await mcpClient.close();
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("figma workspace run_script_file repairPlan dedupes guardrails and preserves all occurrences", async () => {
  const tempDir = await mkdtemp(resolve(tmpdir(), "figma-workspace-guardrail-plan-"));
  const scriptName = "guardrails.figma.ts";
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
        "const node = figma.createText();",
        "const bytes = new Uint8Array();",
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
      { scriptPath, line: 3, column: 5, label: "3:5" },
      { scriptPath, line: 8, column: 22, label: "8:22" },
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
      code: "figma.createImage(new Uint8Array([1, 2, 3]));",
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

test("figma workspace eval defaults to JavaScript without TypeScript preflight", async () => {
  const calls = [];
  const fakeClient = createFakeFigmaClient(calls, ({ name, args }) => {
    assert.equal(name, "use_figma");
    assert.match(args.code, /const rectangle = figma\.createFrame\(\);/u);
    return {
      content: [{
        type: "text",
        text: JSON.stringify({
          ok: true,
          __figmaRepl: { sessionId: "eval-js", handles: {} },
          result: { nodeType: "FRAME" },
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

  await server.connect(serverTransport);
  await mcpClient.connect(clientTransport);
  const result = await mcpClient.callTool({
    name: "figma_workspace_eval",
    arguments: {
      sessionId: "eval-js",
      code: "const rectangle = figma.createFrame();\nreturn { nodeType: rectangle.type };",
    },
  });
  const json = structuredToolResult(result);
  assert.equal(json.ok, true);
  assert.deepEqual(json.diagnostics, []);
  assert.equal(json.upstream.result.nodeType, "FRAME");
  assert.deepEqual(calls.map((call) => call[0]), ["connect", "listTools", "callTool"]);
  await mcpClient.close();
});

test("figma workspace eval compiles TypeScript when explicitly enabled", async () => {
  const calls = [];
  const fakeClient = createFakeFigmaClient(calls, ({ name, args }) => {
    assert.equal(name, "use_figma");
    assert.equal(args.code.includes(": FrameNode"), false);
    assert.match(args.code, /const frame = figma\.createFrame\(\);/u);
    return {
      content: [{
        type: "text",
        text: JSON.stringify({
          ok: true,
          __figmaRepl: { sessionId: "eval-ts", handles: {} },
          result: { nodeType: "FRAME" },
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

  await server.connect(serverTransport);
  await mcpClient.connect(clientTransport);
  const result = await mcpClient.callTool({
    name: "figma_workspace_eval",
    arguments: {
      sessionId: "eval-ts",
      typescript: true,
      code: "const frame: FrameNode = figma.createFrame();\nreturn { nodeType: frame.type };",
    },
  });
  const json = structuredToolResult(result);
  assert.equal(json.ok, true);
  assert.deepEqual(json.diagnostics, []);
  assert.equal(json.upstream.result.nodeType, "FRAME");
  assert.equal(json.script, undefined);
  assert.equal(json.outputFiles, undefined);
  assert.deepEqual(calls.map((call) => call[0]), ["connect", "listTools", "callTool"]);
  await mcpClient.close();
});

test("figma workspace eval treats TypeScript syntax as JavaScript unless enabled", async () => {
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
      sessionId: "eval-js-default",
      code: "const frame: FrameNode = figma.createFrame();\nreturn frame.id;",
    },
  });
  const json = structuredToolResult(result);
  assert.equal(json.ok, false);
  assert.equal(json.diagnostics[0].code, "FIGMA_WORKSPACE_PARSE_ERROR");
  assert.equal(json.repairPlan.status, "parse_error");
  assert.equal(json.upstream, undefined);
  assert.deepEqual(calls.map((call) => call[0]), []);
  await mcpClient.close();
});

test("figma workspace eval blocks TypeScript diagnostics only when TypeScript is enabled", async () => {
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
      sessionId: "eval-ts-blocked",
      typescript: true,
      code: "const frame: RectangleNode = figma.createFrame();\nreturn frame.id;",
    },
  });
  const json = structuredToolResult(result);
  assert.equal(json.ok, false);
  assert.equal(json.diagnostics[0].code, "FIGMA_WORKSPACE_TS_TYPE_ERROR");
  assert.match(json.diagnostics[0].message, /TypeScript preflight failed/u);
  assert.equal(json.repairPlan.status, "blocked");
  assert.equal(json.upstream, undefined);
  assert.deepEqual(calls.map((call) => call[0]), []);
  await mcpClient.close();
});

test("figma workspace eval keeps read-mode AST guardrails for JavaScript", async () => {
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
      sessionId: "eval-read-blocked",
      mode: "read",
      code: "const nodes = await $('$selection');\nconst node = nodes[0];\nnode.x = node.x + 1;\nreturn node.id;",
    },
  });
  const json = structuredToolResult(result);
  assert.equal(json.ok, false);
  assert.equal(json.diagnostics[0].code, "FIGMA_WORKSPACE_READ_MODE_ASSIGNMENT");
  assert.equal(json.repairPlan.status, "blocked");
  assert.equal(json.upstream, undefined);
  assert.deepEqual(calls.map((call) => call[0]), []);
  await mcpClient.close();
});

test("figma workspace run_script_file blocks oversized compiled script payloads before upstream", async () => {
  const tempDir = await mkdtemp(resolve(tmpdir(), "figma-workspace-large-script-"));
  const scriptPath = resolve(tempDir, "large-script.figma.ts");
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
  const scriptPath = resolve(tempDir, "script.figma.ts");
  await writeFile(
    scriptPath,
    [
      "const scriptFrame = figma.createFrame();",
      "scriptFrame.name = 'Script frame';",
      "scriptFrame.resize(320, 160);",
      "scriptFrame.layoutMode = 'VERTICAL';",
      "figma.currentPage.appendChild(scriptFrame);",
      "$.remember('$scriptFrame', scriptFrame);",
      "await $.text({ parent: '$scriptFrame', as: '$scriptTitle', text: 'Hello', font: { family: 'Inter', style: 'Bold', size: 18 } });",
      "scriptFrame.itemSpacing = 8;",
      "const frame = await $('$scriptFrame') as FrameNode;",
      "frame.resize(360, 180);",
      "const checkpoint = await $.checkpoint('script-created', ['$scriptFrame', '$scriptTitle']);",
      "return { checkpoint, resized: { id: frame.id, width: frame.width, height: frame.height }, handles: $.handles };",
    ].join("\n"),
    "utf8",
  );
  const calls = [];
  const fakeClient = createFakeFigmaClient(calls, ({ name, args }) => {
    assert.equal(name, "use_figma");
    assert.doesNotMatch(args.code, /\$\.select = async function select/);
    assert.doesNotMatch(args.code, /figma\.createImage\(bytes\)/);
    assert.doesNotMatch(args.code, /\$\.screenshot = async function screenshot/);
    assert.match(args.code, /\$\.text = async function text/);
    assert.doesNotMatch(args.code, /\$\.findFreeSlot = __figmaReplFindFreeSlot/);
    assert.doesNotMatch(args.code, /\$\.placeNode = async function placeNode/);
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

test("figma workspace run_script_file transpiles valid .figma.ts before upstream eval", async () => {
  const tempDir = await mkdtemp(resolve(tmpdir(), "figma-workspace-script-ts-"));
  const scriptPath = resolve(tempDir, "typed-script.figma.ts");
  await writeFile(
    scriptPath,
    [
      "const frame: FrameNode = figma.createFrame();",
      "frame.name = 'Typed frame';",
      "const title: TextNode = await $.text({ parent: frame, text: 'Typed title', as: '$typedTitle' });",
      "return { frameId: frame.id, titleId: title.id, handles: $.handles } as const;",
    ].join("\n"),
    "utf8",
  );
  const calls = [];
  const fakeClient = createFakeFigmaClient(calls, ({ name, args }) => {
    assert.equal(name, "use_figma");
    assert.match(args.code, /figma\.createFrame\(\)/u);
    assert.match(args.code, /\$\.text = async function text/u);
    assert.match(args.code, /Typed title/u);
    assert.doesNotMatch(args.code, /: FrameNode/u);
    assert.doesNotMatch(args.code, /: TextNode/u);
    assert.doesNotMatch(args.code, /as const/u);
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify({
            ok: true,
            __figmaRepl: {
              sessionId: "typed-main",
              handles: { "$typedTitle": "30:2" },
            },
            result: {
              frameId: "30:1",
              titleId: "30:2",
              handles: { "$typedTitle": "30:2" },
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
        sessionId: "typed-main",
        scriptPath,
        strict: true,
        surface: "design",
      },
    });
    const json = structuredToolResult(result);
    assert.equal(json.ok, true);
    assert.equal(json.phase, "execute");
    assert.equal(json.executed, true);
    assert.equal(json.script.scriptPath, scriptPath);
    assert.equal(json.script.expectedSurface, "design");
    assert.ok(json.script.compiledScriptBytes > 0);
    assert.deepEqual(json.diagnostics, []);
    assert.equal(json.upstream.result.frameId, "30:1");
    assert.equal(json.outputFiles, undefined);
    await mcpClient.close();
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
  assert.deepEqual(calls.filter((call) => call[0] === "callTool").map((call) => call[1]), ["use_figma"]);
});

test("figma workspace run_script_file keeps wrapper success when nested business ok is false", async () => {
  const tempDir = await mkdtemp(resolve(tmpdir(), "figma-workspace-script-nested-ok-"));
  const scriptPath = resolve(tempDir, "nested-ok.figma.ts");
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
  const scriptPath = resolve(tempDir, "native-script.figma.ts");
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
  const tempDir = await mkdtemp(resolve(tmpdir(), "figma-workspace-place-helper-"));
  const scriptPath = resolve(tempDir, "place-script.figma.ts");
  await writeFile(scriptPath, "return await $.placeNode('$card', { avoidOverlap: true });", "utf8");
  const calls = [];
  const fakeClient = createFakeFigmaClient(calls, ({ name, args }) => {
    assert.equal(name, "use_figma");
    assert.match(args.code, /\$\.findFreeSlot = __figmaReplFindFreeSlot/);
    assert.match(args.code, /\$\.placeNode = async function placeNode/);
    assert.doesNotMatch(args.code, /\$\.text = async function text/);
    assert.doesNotMatch(args.code, /\$\.checkpoint = async function checkpoint/);
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify({
            ok: true,
            __figmaRepl: { sessionId: "main", handles: {} },
            result: { x: 0, y: 0, shiftedSlots: 0, collidedNodeIds: [] },
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
        title: "Run placement helper script",
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
  const scriptPath = resolve(tempDir, "node-script.figma.ts");
  await writeFile(scriptPath, "return await $.node('$card');", "utf8");
  const calls = [];
  const fakeClient = createFakeFigmaClient(calls, ({ name, args }) => {
    assert.equal(name, "use_figma");
    assert.match(args.code, /function resolveHandleId/);
    assert.match(args.code, /\$\.node = \$;/);
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

test("figma workspace run_script_file does not emit resolveHandleId for remember-only helper usage", async () => {
  const tempDir = await mkdtemp(resolve(tmpdir(), "figma-workspace-remember-helper-"));
  const scriptPath = resolve(tempDir, "remember-script.figma.ts");
  await writeFile(scriptPath, "const frame = figma.createFrame();\n$.remember('$card', frame);\nreturn { id: frame.id };", "utf8");
  const calls = [];
  const fakeClient = createFakeFigmaClient(calls, ({ name, args }) => {
    assert.equal(name, "use_figma");
    assert.match(args.code, /\$\.remember = remember;/);
    assert.doesNotMatch(args.code, /\$\.resolveId = resolveHandleId;/);
    assert.doesNotMatch(args.code, /\bresolveHandleId\b/);
    return {
      content: [{
        type: "text",
        text: JSON.stringify({
          ok: true,
          __figmaRepl: { sessionId: "main", handles: { "$card": "60:1" } },
          result: { id: "60:1" },
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

    const result = await mcpClient.callTool({
      name: "figma_workspace_run_script_file",
      arguments: {
        title: "Run remember helper script",
        sessionId: "main",
        scriptPath,
        surface: "design",
      },
    });
    const json = structuredToolResult(result);
    assert.equal(json.ok, true);
    assert.deepEqual(json.session.handleChanges.updated, ["$card"]);
    await mcpClient.close();
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("figma workspace run_script_file rejects dynamic helper access instead of full injection fallback", async () => {
  const tempDir = await mkdtemp(resolve(tmpdir(), "figma-workspace-dynamic-helper-"));
  const scriptPath = resolve(tempDir, "dynamic-helper.figma.ts");
  await writeFile(
    scriptPath,
    [
      "const helperName = 'text' as 'text';",
      "return await $[helperName]({ text: 'Card' });",
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
  const scriptPath = resolve(tempDir, "literal-helper.figma.ts");
  await writeFile(scriptPath, "return await $['text']({ text: 'Card' });", "utf8");
  const calls = [];
  const fakeClient = createFakeFigmaClient(calls, ({ name, args }) => {
    assert.equal(name, "use_figma");
    assert.match(args.code, /\$\.text = async function text/);
    assert.doesNotMatch(args.code, /\$\.checkpoint = async function checkpoint/);
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify({
            ok: true,
            __figmaRepl: { sessionId: "main", handles: {} },
            result: { id: "61:1", characters: "Card" },
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
  const scriptPath = resolve(tempDir, "image-script.figma.ts");
  await writeFile(
    scriptPath,
    [
      "const root = figma.createFrame();",
      "root.name = 'Image asset root';",
      "root.resize(240, 180);",
      "figma.currentPage.appendChild(root);",
      "$.remember('$root', root);",
      "await $.imageAsset({ parent: '$root', as: '$icon', name: 'Generated icon asset', base64: 'AQIDBA==', size: { width: 64, height: 64 } });",
      "return await $.checkpoint('image-asset-created', ['$root', '$icon']);",
    ].join("\n"),
    "utf8",
  );
  const calls = [];
  const fakeClient = createFakeFigmaClient(calls, ({ name, args }) => {
    assert.equal(name, "use_figma");
    assert.match(args.code, /\$\.imageAsset = async function imageAsset/);
    assert.doesNotMatch(args.code, /\$\.findFreeSlot = __figmaReplFindFreeSlot/);
    assert.doesNotMatch(args.code, /\$\.placeNode = async function placeNode/);
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
  const scriptName = "script.figma.ts";
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
    const compiledFilePath = resolve(fileDir, "script.failure.compiled.txt");
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
    assert.match(compiledFile, /This is the compiled payload sent to upstream Figma MCP/);
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
  const scriptPath = resolve(tempDir, "script.figma.ts");
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
      readFile(resolve(tempDir, "script.compiled.txt"), "utf8"),
      /ENOENT/,
    );
    await assert.rejects(
      readFile(resolve(tempDir, "script.failure.compiled.txt"), "utf8"),
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
  const scriptName = "script.figma.ts";
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
        workspaceDir: tempDir,
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
    assert.equal(initJson.task.inputFile, "settings-panel-polish.figma.ts");
    assert.equal(initJson.task.outputFile, undefined);
    assert.equal(initJson.task.resultFile, undefined);
    assert.equal(initJson.task.fileDir, undefined);
    assert.equal(initJson.task.workspaceDir, undefined);
    assert.equal(initJson.task.taskDir, undefined);
    assert.equal(initJson.task.workspace.fileDir, resolve(tempDir, "ExampleFigmaFileKey012"));
    assert.equal(initJson.task.workspace.sessionDir, initJson.task.workspace.fileDir);
    assert.equal(initJson.task.workspace.taskName, "settings-panel-polish");
    assert.equal(initJson.task.workspace.taskSlug, undefined);
    assert.equal(initJson.task.workspace.intentSlug, undefined);
    assert.equal(initJson.task.workspace.resultFile, undefined);
    assert.equal(initJson.task.workspace.files.inputFile, "settings-panel-polish.figma.ts");
    assert.equal(initJson.task.workspace.files.outputFile, undefined);
    assert.equal(initJson.taskChange.previous, undefined);
    assert.equal(initJson.taskChange.changed, true);
    assert.deepEqual(initJson.taskChange.current, {
      taskName: "settings-panel-polish",
      inputFile: "settings-panel-polish.figma.ts",
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
        handleCount: 0,
      },
    ]);

    const sessionResource = await mcpClient.readResource({ uri: "figma-workspace://sessions/settings-workspace" });
    const sessionJson = JSON.parse(sessionResource.contents[0].text);
    assert.deepEqual(sessionJson, {
      id: "settings-workspace",
      fileKey: "ExampleFigmaFileKey012",
      surface: "design",
      handleCount: 0,
      handlePreview: {},
      workspace: {
        sessionDir: initJson.task.workspace.sessionDir,
      },
    });
    assert.equal(sessionJson.handles, undefined);
    assert.equal(sessionJson.workspace.taskSlug, undefined);
    assert.equal(sessionJson.workspace.inputFile, undefined);
    assert.equal(sessionJson.workspace.root, undefined);
    assert.equal(sessionJson.workspace.fileDir, undefined);
    assert.equal(sessionJson.workspace.fileContext, undefined);
    assert.equal(sessionJson.workspace.fileKey, undefined);
    assert.equal(sessionJson.workspace.fileSlug, undefined);

    await assert.rejects(
      mcpClient.callTool({
        name: "figma_workspace_prepare_task",
        arguments: {
          title: "Rollback failed prepare",
          sessionId: "settings-workspace",
          file: "https://www.figma.com/design/ExampleFigmaFileKey012/UI?node-id=1-2",
          surface: "figjam",
          workspaceDir: tempDir,
          fileName: "settings-panel-polish.figma.ts",
          taskName: "settings-panel-polish",
        },
      }),
      /Refusing to overwrite/,
    );
    const rollbackSessionResource = await mcpClient.readResource({ uri: "figma-workspace://sessions/settings-workspace" });
    const rollbackSessionJson = JSON.parse(rollbackSessionResource.contents[0].text);
    assert.deepEqual(rollbackSessionJson, sessionJson);
    assert.equal(sessionJson.workspace.scriptPath, undefined);
    assert.equal(sessionJson.workspace.files, undefined);

    await writeFile(
      resolve(initJson.task.workspace.fileDir, "settings-panel-polish.figma.ts"),
      "return { summary: 'workspace file result' };",
      "utf8",
    );

    const result = await mcpClient.callTool({
      name: "figma_workspace_run_script_file",
      arguments: {
        title: "Run workspace file",
        sessionId: "settings-workspace",
        inputFile: "settings-panel-polish.figma.ts",
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
      resolve(initJson.task.workspace.fileDir, "settings-panel-polish.figma.ts"),
      "return { summary: 'workspace failure result' };",
      "utf8",
    );
    const failedResult = await mcpClient.callTool({
      name: "figma_workspace_run_script_file",
      arguments: {
        title: "Run failed workspace file",
        sessionId: "settings-workspace",
        inputFile: "settings-panel-polish.figma.ts",
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
      resolve(initJson.task.workspace.fileDir, "settings-panel-polish.failure.compiled.txt"),
    );
    assert.match(failedCompiledFile, /Generated by figma_workspace_run_script_file after upstream execution failure/);
    assert.match(failedCompiledFile, /Source: ExampleFigmaFileKey012\/settings-panel-polish\.figma\.ts/);
    assert.match(failedCompiledFile, /workspace failure result/);
    assert.match(failedCompiledFile, /figma_workspace_run_script_file source:/);

    const missingInputResult = await mcpClient.callTool({
      name: "figma_workspace_run_script_file",
      arguments: {
        title: "Run missing workspace file",
        sessionId: "settings-workspace",
        inputFile: "missing-settings-panel.figma.ts",
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
    assert.equal(preparedJson.task.inputFile, "token-audit.figma.ts");
    assert.equal(preparedJson.task.outputFile, undefined);
    assert.equal(preparedJson.task.workspaceDir, undefined);
    assert.equal(preparedJson.task.taskDir, undefined);
    assert.equal(preparedJson.task.scriptPath, resolve(initJson.task.workspace.fileDir, "token-audit.figma.ts"));
    assert.equal(preparedJson.task.resultFile, undefined);
    assert.equal(preparedJson.taskChange.changed, true);
    assert.equal(preparedJson.taskChange.previous.taskName, "settings-panel-polish");
    assert.deepEqual(preparedJson.taskChange.current, {
      taskName: "token-audit",
      inputFile: "token-audit.figma.ts",
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

    const preparedTs = await mcpClient.callTool({
      name: "figma_workspace_prepare_task",
      arguments: {
        title: "Prepare typed task",
        sessionId: "settings-workspace",
        taskName: "token-audit-ts",
        fileName: "token-audit-ts.figma.ts",
        surface: "design",
        overwrite: true,
      },
    });
    const preparedTsJson = structuredToolResult(preparedTs);
    assert.equal(preparedTsJson.task.inputFile, "token-audit-ts.figma.ts");
    assert.equal(preparedTsJson.task.scriptPath, resolve(initJson.task.workspace.fileDir, "token-audit-ts.figma.ts"));
    assert.deepEqual(preparedTsJson.taskChange.current, {
      taskName: "token-audit-ts",
      inputFile: "token-audit-ts.figma.ts",
      sessionDir: initJson.task.workspace.sessionDir,
    });
    const preparedTsSource = await readFile(preparedTsJson.task.scriptPath, "utf8");
    assert.match(preparedTsSource, /token-audit-ts\.figma\.ts/);
    assert.match(preparedTsSource, /strict-checked with Figma Plugin API typings/);
    assert.match(preparedTsJson.next[0], /\.figma\.ts/);

    await assert.rejects(
      mcpClient.callTool({
        name: "figma_workspace_run_script_file",
        arguments: {
          title: "Reject traversal",
          sessionId: "settings-workspace",
          inputFile: "../bad.figma.ts",
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
          scriptPath: resolve(tmpdir(), "script.figma.ts"),
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
        scriptPath: "relative-script.figma.ts",
      },
    }),
    /scriptPath" must be an absolute path/,
  );
  await assert.rejects(
    mcpClient.callTool({
      name: "figma_workspace_run_script_file",
      arguments: {
        title: "Reject non-TypeScript script",
        scriptPath: resolve(tmpdir(), "script.txt"),
      },
    }),
    /scriptPath" must end with "\.figma\.ts"/,
  );
  assert.deepEqual(calls.map((call) => call[0]), []);
  await mcpClient.close();
});

test("figma workspace open accepts unified file input and auto-binds a workspace", async () => {
  const tempDir = await mkdtemp(resolve(tmpdir(), "figma-workspace-open-file-"));
  const repl = createFigmaWorkspaceClient({
    client: createFakeFigmaClient([], () => {
      throw new Error("unexpected upstream call");
    }),
  });
  const result = await repl.open({
    sessionId: "open-file-workspace",
    file: "https://www.figma.com/design/ExampleFigmaFileKey012/UI?node-id=1-2",
    workspaceDir: tempDir,
    connect: false,
  });
  assert.equal(result.ok, true);
  assert.equal(result.session.fileKey, "ExampleFigmaFileKey012");
  assert.equal(result.session.surface, "design");
  assert.match(result.session.sessionDir, /ExampleFigmaFileKey012/u);
  assert.equal(result.session.workspace, undefined);
  await repl.close();
});

test("figma workspace prepare_task creates .figma.ts workspace and enforces overwrite and path rules", async () => {
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
        fileName: "settings-panel.figma.ts",
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
    assert.equal(json.task.inputFile, "settings-panel.figma.ts");
    assert.equal(json.task.outputFile, undefined);
    assert.equal(json.task.scriptPath, resolve(workspaceDir, "settings-panel.figma.ts"));
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
          fileName: resolve(tempDir, "bad.figma.ts"),
        },
      }),
      /fileName" must be a file name/,
    );
    await assert.rejects(
      mcpClient.callTool({
        name: "figma_workspace_prepare_task",
        arguments: {
          title: "Reject non-TypeScript script name",
          taskName: "bad-script-name",
          workspaceDir: resolve(tempDir, "other"),
          fileName: "bad-script.txt",
        },
      }),
      /fileName" must end with "\.figma\.ts"/,
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
  assert.ok(planJson.workflow.guidance.some((step) => /target:\{ fileKey, nodeId \} can supply file context directly/.test(step)));

  const serverSource = await readFile(resolve(packageRoot, "src/mcp/workspace-mcp-server.ts"), "utf8");
  assert.match(serverSource, /captureFromObjectTarget: \{ target: \{ fileKey: "<figma file key>", nodeId: "<node id>" \}/);
  assert.match(serverSource, /fromHandleObject: \{ sessionId: "<session>", target: \{ handle: "\$hero" \} \}/);
  assert.match(serverSource, /fromObjectTarget: \{ target: \{ fileKey: "<figma file key>", nodeId: "<node id>" \} \}/);
  assert.match(serverSource, /variableDefsFromObjectTarget: \{ target: \{ fileKey: "<figma file key>", nodeId: "<node id>" \} \}/);
  assert.match(serverSource, /fromCurrentPage: \{ sessionId: "<session>", target: "\$currentPage" \}/);
  assert.match(serverSource, /fromSingleSelection: \{ sessionId: "<session>", target: "\$selection" \}/);
  assert.doesNotMatch(serverSource, /Do not pass \$selection here/);
  assert.match(JSON.stringify(planJson.workflow.guidance), /\$currentPage/);
  assert.match(JSON.stringify(planJson.workflow.guidance), /single-node \$selection/);

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

  const layoutResult = await mcpClient.callTool({
    name: "figma_workspace_guidance",
    arguments: {
      title: "Suggest layout",
      query: "auto layout absolute positioning",
      surface: "design",
    },
  });
  const layoutJson = structuredToolResult(layoutResult);
  assert.ok(layoutJson.recommendedCards.includes("layout.auto"));
  assert.match(JSON.stringify(layoutJson.cards), /layoutPositioning.*ABSOLUTE.*auto-layout parent/);

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

test("figma workspace inspect returns compact lock and layout operation state", async () => {
  const tempDir = await mkdtemp(resolve(tmpdir(), "figma-workspace-inspect-state-"));
  const calls = [];
  const fakeClient = createFakeFigmaClient(calls, ({ args }) => {
    assert.equal(args.fileKey, "InspectFileKey012");
    assert.match(args.code, /locked: read\("locked"\)/);
    assert.match(args.code, /layoutMode: read\("layoutMode"\)/);
    assert.match(args.code, /layoutPositioning: read\("layoutPositioning"\)/);
    return {
      content: [{
        type: "text",
        text: JSON.stringify({
          ok: true,
          result: {
            target: "94:2",
            summary: {
              id: "94:2",
              type: "FRAME",
              name: "Panel",
              locked: true,
              layoutMode: "VERTICAL",
              layoutPositioning: "AUTO",
            },
            handles: {},
          },
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

  await server.connect(serverTransport);
  await mcpClient.connect(clientTransport);
  await mcpClient.callTool({
    name: "figma_workspace_open",
    arguments: {
      title: "Open inspect file context",
      sessionId: "inspect-state",
      file: "InspectFileKey012",
      workspaceDir: tempDir,
      connect: false,
    },
  });
  const result = await mcpClient.callTool({
    name: "figma_workspace_inspect",
    arguments: {
      title: "Inspect state",
      sessionId: "inspect-state",
      target: "94:2",
    },
  });
  const json = structuredToolResult(result);
  assert.equal(json.ok, true);
  assert.equal(json.summary.locked, true);
  assert.equal(json.summary.layoutMode, "VERTICAL");
  assert.equal(json.summary.layoutPositioning, "AUTO");
  assert.deepEqual(calls.map((call) => call[0]), ["connect", "listTools", "callTool"]);
  await mcpClient.close();
});

test("figma workspace inspect requires local file context before upstream execution", async () => {
  const calls = [];
  const fakeClient = createFakeFigmaClient(calls, () => {
    throw new Error("unexpected upstream call");
  });
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
      name: "figma_workspace_inspect",
      arguments: {
        title: "Inspect without file context",
        sessionId: "inspect-missing-context",
        target: "$selection",
      },
    }),
    /figma_workspace_inspect requires file context\. Call figma_workspace_open\(\{ sessionId, file \}\) or figma_workspace_prepare_task first\./,
  );
  assert.deepEqual(calls, []);
  await mcpClient.close();
});

test("figma workspace inspect mode=style returns compact visual token audit", async () => {
  const tempDir = await mkdtemp(resolve(tmpdir(), "figma-workspace-inspect-style-"));
  const calls = [];
  const fakeClient = createFakeFigmaClient(calls, ({ args }) => {
    assert.equal(args.fileKey, "StyleFileKey012");
    assert.match(args.code, /__colorCounts/);
    assert.match(args.code, /textStyles/);
    assert.match(args.code, /imageNodes/);
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
  await mcpClient.callTool({
    name: "figma_workspace_open",
    arguments: {
      title: "Open style file context",
      sessionId: "style",
      file: "StyleFileKey012",
      workspaceDir: tempDir,
      connect: false,
    },
  });
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

test("figma workspace inspect mode=style splits style audit when upstream truncates a large batch", async () => {
  const tempDir = await mkdtemp(resolve(tmpdir(), "figma-workspace-inspect-style-batch-"));
  const styleBatchSizes = [];
  const fakeClient = createFakeFigmaClient([], ({ args }) => {
    assert.equal(args.fileKey, "StyleBatchFileKey012");
    assert.match(args.code, /__colorCounts/);
    const limitMatch = /const __limit = (undefined|\d+);/u.exec(args.code);
    assert.ok(limitMatch);
    if (limitMatch[1] === "undefined") {
      return { content: [{ type: "text", text: `${JSON.stringify({ ok: true })}\n// truncated to 20kb` }] };
    }
    const limit = Number(limitMatch[1]);
    styleBatchSizes.push(limit);
    if (limit > 40) {
      return { content: [{ type: "text", text: `${JSON.stringify({ ok: true })}\n// truncated to 20kb` }] };
    }
    const offsetMatch = /const __offset = (\d+);/u.exec(args.code);
    assert.ok(offsetMatch);
    const offset = Number(offsetMatch[1]);
    const count = Math.max(0, Math.min(limit, 81 - offset));
    const includeSummary = /const __includeSummary = true;/u.test(args.code);
    return {
      content: [{
        type: "text",
        text: JSON.stringify({
          ok: true,
          result: {
            target: "94:2",
            mode: "style",
            nodeCount: 81,
            scannedNodeCount: count,
            offset,
            limit,
            summary: includeSummary ? { id: "94:2", type: "FRAME", name: "Panel" } : undefined,
            style: {
              topColors: [{ color: "#101820", count }],
              textStyles: count > 0 ? [{ id: `94:${offset + 6}`, name: "Title", fontSize: 32 }] : [],
              imageNodes: [],
              strokes: [],
              effects: [],
              caps: { topColors: 16, textStyles: 24, imageNodes: 20, strokes: 24, effects: 16 },
            },
          },
        }),
      }],
    };
  });
  const { server } = createFigmaWorkspaceMcpServer({ client: fakeClient });
  const mcpClient = new Client({ name: "test-client", version: "0.1.0" }, { capabilities: {} });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

  try {
    await server.connect(serverTransport);
    await mcpClient.connect(clientTransport);
    await mcpClient.callTool({
      name: "figma_workspace_open",
      arguments: {
        sessionId: "style-batch",
        file: "StyleBatchFileKey012",
        workspaceDir: tempDir,
        connect: false,
      },
    });
    const result = await mcpClient.callTool({
      name: "figma_workspace_inspect",
      arguments: {
        sessionId: "style-batch",
        mode: "style",
        target: "94:2",
      },
    });
    const json = structuredToolResult(result);
    assert.equal(json.ok, true);
    assert.equal(json.mode, "style");
    assert.equal(json.nodeCount, 81);
    assert.equal(json.scannedNodeCount, 81);
    assert.equal(json.style.topColors[0].count, 81);
    assert.equal(json.style.textStyles.length, 3);
    assert.equal(json.batching.source, "adaptive");
    assert.deepEqual(styleBatchSizes, [80, 40, 40, 1]);
  } finally {
    await mcpClient.close();
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("figma workspace inspect failures return upstreamError without upstream wrapper fields", async () => {
  const tempDir = await mkdtemp(resolve(tmpdir(), "figma-workspace-inspect-failure-"));
  const calls = [];
  const fakeClient = createFakeFigmaClient(calls, ({ args }) => {
    assert.equal(args.fileKey, "InspectFailureFileKey012");
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
  await mcpClient.callTool({
    name: "figma_workspace_open",
    arguments: {
      title: "Open inspect failure file context",
      sessionId: "inspect-failure",
      file: "InspectFailureFileKey012",
      workspaceDir: tempDir,
      connect: false,
    },
  });
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

test("figma workspace inspect mode=validate splits handle validation when upstream truncates a large batch", async () => {
  const tempDir = await mkdtemp(resolve(tmpdir(), "figma-workspace-inspect-validate-batch-"));
  const handles = Object.fromEntries(Array.from({ length: 81 }, (_, index) => [`$node${index + 1}`, `10:${index + 1}`]));
  const calls = [];
  const batchSizes = [];
  const fakeClient = createFakeFigmaClient(calls, ({ args }) => {
    assert.equal(args.fileKey, "ValidateBatchFileKey012");
    const handlesMatch = /const __requestedHandles = (\[[^;]+\]);/u.exec(args.code);
    assert.ok(handlesMatch);
    const requested = JSON.parse(handlesMatch[1]);
    batchSizes.push(requested.length);
    if (requested.length > 40) {
      return { content: [{ type: "text", text: `${JSON.stringify({ ok: true })}\n// truncated to 20kb` }] };
    }
    return {
      content: [{
        type: "text",
        text: JSON.stringify({
          ok: true,
          result: {
            validations: requested.map((handle) => ({ handle, status: "valid", id: handles[handle], type: "FRAME", name: handle, locked: false })),
            validatedNodeIds: requested.map((handle) => handles[handle]),
          },
        }),
      }],
    };
  });
  const { server } = createFigmaWorkspaceMcpServer({ client: fakeClient });
  const mcpClient = new Client({ name: "test-client", version: "0.1.0" }, { capabilities: {} });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

  await server.connect(serverTransport);
  await mcpClient.connect(clientTransport);
  await mcpClient.callTool({
    name: "figma_workspace_open",
    arguments: {
      sessionId: "validate-batch",
      connect: false,
      file: "ValidateBatchFileKey012",
      workspaceDir: tempDir,
      handles,
    },
  });
  const result = await mcpClient.callTool({
    name: "figma_workspace_inspect",
    arguments: {
      sessionId: "validate-batch",
      mode: "validate",
      handles: Object.keys(handles),
    },
  });
  const json = structuredToolResult(result);
  assert.equal(json.ok, true);
  assert.equal(json.validations.length, 81);
  assert.equal(json.validatedNodeIds.length, 81);
  assert.deepEqual(batchSizes, [80, 40, 40, 1]);
  await mcpClient.close();
  await rm(tempDir, { recursive: true, force: true });
});

test("figma workspace inspect mode=validate reports valid, missing, and stale", async () => {
  const tempDir = await mkdtemp(resolve(tmpdir(), "figma-workspace-inspect-validate-"));
  const calls = [];
  const fakeClient = createFakeFigmaClient(calls, ({ args }) => {
    assert.equal(args.fileKey, "ValidateFileKey012");
    assert.match(args.code, /__requestedHandles/);
    assert.match(args.code, /layoutPositioning/);
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
                { handle: "$valid", status: "valid", id: "10:1", type: "FRAME", name: "Valid", locked: false, layoutMode: "HORIZONTAL", layoutPositioning: "AUTO" },
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
      file: "ValidateFileKey012",
      workspaceDir: tempDir,
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
  assert.equal(json.validations[0].locked, false);
  assert.equal(json.validations[0].layoutMode, "HORIZONTAL");
  assert.equal(json.validations[0].layoutPositioning, "AUTO");
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
  const tempDir = await mkdtemp(resolve(tmpdir(), "figma-workspace-client-eval-"));
  const calls = [];
  const fakeClient = createFakeFigmaClient(calls, ({ args }) => {
    assert.equal(typeof args.code, "string");
    assert.equal(args.fileKey, "ExampleFigmaFileKey012");
    assert.equal(args.description, "Figma Workspace Plugin API execution");
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
    workspaceDir: tempDir,
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
  const tempDir = await mkdtemp(resolve(tmpdir(), "figma-workspace-client-desc-"));
  const calls = [];
  const fakeClient = createFakeFigmaClient(
    calls,
    ({ args }) => {
      assert.equal(typeof args.code, "string");
      assert.equal(args.fileKey, "ExampleFigmaFileKey012");
      assert.equal(args.description, "Figma Workspace Plugin API execution");
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
    workspaceDir: tempDir,
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
  const scriptPath = resolve(tempDir, "typed-client.figma.ts");
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
        { name: "get_variable_defs", inputSchema: { type: "object", properties: { fileKey: { type: "string" }, nodeId: { type: "string" } } } },
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
      workspaceDir: tempDir,
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
      fileName: "typed-task.figma.ts",
      taskName: "typed-task",
    });
    assert.equal(preparedResult.ok, true);
    assert.equal(preparedResult.task.taskName, "typed-task");
    assert.equal(preparedResult.task.taskSlug, undefined);
    assert.equal(preparedResult.task.intentSlug, undefined);
    assert.equal(preparedResult.task.inputFile, "typed-task.figma.ts");
    assert.equal(preparedResult.task.outputFile, undefined);
    assert.equal(preparedResult.task.workspace.fileDir, workspaceDir);
    assert.equal(preparedResult.task.workspace.files.inputFile, "typed-task.figma.ts");
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
  const tempDir = await mkdtemp(resolve(tmpdir(), "figma-workspace-node-upstream-"));
  const nodeRepl = await import("../dist/upstream/node-upstream-client.js");
  assert.equal(typeof nodeRepl.createRemoteMcpClient, "function");
  assert.equal(typeof nodeRepl.createFigmaWorkspaceClient, "function");
  assert.equal(nodeRepl.formatFigmaUpstreamContractElapsedTime(42), "42 ms");
  assert.equal(nodeRepl.formatFigmaUpstreamContractElapsedTime(1250), "1.25 s (1250 ms)");
  assert.equal(nodeRepl.formatFigmaUpstreamContractElapsedTime(65_000), "1 min 5 s (65000 ms)");

  const fakeClient = createFakeFigmaClient([], () => {
    throw new Error("unexpected upstream call");
  });
  const repl = nodeRepl.createFigmaWorkspaceClient({ client: fakeClient });
  assert.equal(repl.client, fakeClient);
  assert.equal(typeof repl.open, "function");
  await repl.open({
    sessionId: "node-upstream-client-fake",
    file: "https://www.figma.com/design/ExampleFigmaFileKey012/UI?node-id=1-2",
    workspaceDir: tempDir,
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
      workspaceDir: "C:/Users/example/AppData/Local/Temp/figma-workspace-node-upstream-default",
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
      async listResourceTemplates() { return { resourceTemplates: [] }; },
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
  const messageOnlyError = new Error("ENOENT: no such file or directory, unlink 'script.failure.compiled.txt'");
  const accessError = new Error("EACCES: permission denied, unlink 'script.failure.compiled.txt'");

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
    async listResourceTemplates() {
      return { resourceTemplates: [] };
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
