import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import sharp from "sharp";
import {
  createFigmaReplClient,
  createFigmaReplMcpServer,
  diagnoseFigmaReplCode,
} from "../dist/index.js";
import {
  FIGMA_REPL_EVAL_COMMON_HELPER_NAMES,
  buildFigmaEvalScript,
  resolveFigmaReplScriptHelperSelection,
} from "../dist/repl-server.js";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const expectedStaticResourceUris = [
  "figma-repl://api",
  "figma-repl://api-cards",
  "figma-repl://capabilities",
  "figma-repl://docs",
  "figma-repl://file-workflow",
  "figma-repl://guide",
  "figma-repl://intents",
  "figma-repl://patterns",
  "figma-repl://safety",
  "figma-repl://scripts",
  "figma-repl://sessions",
  "figma-repl://upstream-tools",
  "figma-repl://workflow-tools",
];
const queryOutputFields = [
  "recommendedCards",
  "queryHints",
  "apiSymbols",
  "avoid",
  "referenceContext",
];
const forbiddenRouterContractTerms = [
  "figma_repl_apply_ops",
  "figma_repl_applyOps",
  "apply_ops",
  "$.ops",
  "$.applyOps",
  "compileFigmaReplOps",
  "FigmaReplOp",
  "FigmaReplApplyOpsArguments",
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

function countTextLines(content) {
  if (content.length === 0) {
    return 0;
  }
  const newlineCount = content.match(/\n/gu)?.length ?? 0;
  return content.endsWith("\n") ? newlineCount : newlineCount + 1;
}

async function createTestPngBuffer(width = 4, height = 3) {
  return sharp({
    create: {
      width,
      height,
      channels: 4,
      background: { r: 240, g: 64, b: 48, alpha: 1 },
    },
  }).png().toBuffer();
}

function assertWebpBuffer(buffer) {
  assert.equal(buffer.subarray(0, 4).toString("ascii"), "RIFF");
  assert.equal(buffer.subarray(8, 12).toString("ascii"), "WEBP");
}

function assertPngBuffer(buffer) {
  assert.equal(buffer.subarray(0, 8).toString("hex"), "89504e470d0a1a0a");
}

function assertJpegBuffer(buffer) {
  assert.equal(buffer.subarray(0, 3).toString("hex"), "ffd8ff");
}

test("figma REPL eval wraps code and persists returned handles", async () => {
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

  const { server } = createFigmaReplMcpServer({ client: fakeClient });
  const mcpClient = new Client(
    { name: "test-client", version: "0.1.0" },
    { capabilities: {} },
  );
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

  await server.connect(serverTransport);
  await mcpClient.connect(clientTransport);

  const evalResult = await mcpClient.callTool({
    name: "figma_repl_eval",
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
  assert.equal(evalJson.upstream.payload.result.id, "12:34");
  assert.equal(evalJson.result, undefined);
  assert.equal(evalJson.parsed, undefined);
  assert.equal(evalJson.text, undefined);
  assert.equal(evalJson.script, undefined);
  assert.equal(evalJson.metadata, undefined);
  assert.equal(evalJson.injectedHelpers, undefined);
  assert.equal(evalJson.outputFiles, undefined);
  assert.equal(evalJson.inlineResultLimit, undefined);
  assert.equal(evalJson.upstreamTool, "use_figma");
  assert.equal(evalJson.upstreamArgument, "code");
  assert.equal(evalJson.session.handles.$card, "12:34");

  const sessionResources = await mcpClient.listResources();
  const sessionListEntry = sessionResources.resources.find((resource) => resource.uri === "figma-repl://sessions/main");
  assert.equal(sessionListEntry?.description, "Read when you need public state for this specific active REPL session.");
  assert.equal(sessionListEntry?.mimeType, "application/json");

  const sessionResource = await mcpClient.readResource({ uri: "figma-repl://sessions/main" });
  const sessionJson = JSON.parse(sessionResource.contents[0].text);
  assert.equal(sessionJson.handles.$card, "12:34");
  assert.equal(sessionJson.evalToolName, undefined);
  assert.equal(sessionJson.evalToolArgument, undefined);
  assert.equal(sessionJson.upstreamArguments, undefined);
  assert.equal(sessionJson.history.length, 1);

  assert.deepEqual(calls.map((call) => call[0]), ["connect", "listTools", "callTool"]);
  await mcpClient.close();
});

test("figma REPL eval ignores legacy routing overrides and always uses use_figma code", async () => {
  const previousToolEnv = process.env.FIGMA_REPL_EVAL_TOOL;
  const previousArgumentEnv = process.env.FIGMA_REPL_EVAL_TOOL_ARGUMENT;
  process.env.FIGMA_REPL_EVAL_TOOL = "fake_eval";
  process.env.FIGMA_REPL_EVAL_TOOL_ARGUMENT = "script";
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
  const { server } = createFigmaReplMcpServer({
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
      name: "figma_repl_eval",
      arguments: {
        title: "Verify fixed eval route",
        code: "return { ok: true };",
      },
    });
    const json = structuredToolResult(result);
    assert.equal(json.ok, true);
    assert.equal(json.upstreamTool, "use_figma");
    assert.equal(json.upstreamArgument, "code");
    assert.deepEqual(calls.map((call) => call[0]), ["connect", "listTools", "callTool"]);
    await mcpClient.close();
  } finally {
    if (previousToolEnv === undefined) {
      delete process.env.FIGMA_REPL_EVAL_TOOL;
    } else {
      process.env.FIGMA_REPL_EVAL_TOOL = previousToolEnv;
    }
    if (previousArgumentEnv === undefined) {
      delete process.env.FIGMA_REPL_EVAL_TOOL_ARGUMENT;
    } else {
      process.env.FIGMA_REPL_EVAL_TOOL_ARGUMENT = previousArgumentEnv;
    }
  }
});

test("figma REPL eval requires official use_figma code schema", async () => {
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
  const { server } = createFigmaReplMcpServer({ client: fakeClient });
  const mcpClient = new Client(
    { name: "test-client", version: "0.1.0" },
    { capabilities: {} },
  );
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

  await server.connect(serverTransport);
  await mcpClient.connect(clientTransport);
  await assert.rejects(
    mcpClient.callTool({
      name: "figma_repl_eval",
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

test("figma REPL eval writes full result and upstream sidecar for large or requested output", async () => {
  const tempDir = await mkdtemp(resolve(tmpdir(), "figma-repl-eval-output-"));
  const previousTaskRoot = process.env.FIGMA_REPL_TASK_ROOT;
  process.env.FIGMA_REPL_TASK_ROOT = tempDir;
  const explicitOutputFile = resolve(tempDir, "explicit-eval.result.json");
  const calls = [];
  const fakeClient = createFakeFigmaClient(calls, ({ args }) => {
    if (/large eval/u.test(args.code)) {
      return {
        content: [{
          type: "text",
          text: JSON.stringify({ ok: true, result: { summary: "large eval", payload: "x".repeat(200) } }),
        }],
      };
    }
    return {
      content: [{
        type: "text",
        text: JSON.stringify({ ok: true, result: { summary: "explicit eval", id: "10:1" } }),
      }],
    };
  });
  const { server } = createFigmaReplMcpServer({ client: fakeClient });
  const mcpClient = new Client(
    { name: "test-client", version: "0.1.0" },
    { capabilities: {} },
  );
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

  try {
    await server.connect(serverTransport);
    await mcpClient.connect(clientTransport);

    const largeResult = await mcpClient.callTool({
      name: "figma_repl_eval",
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
    assert.equal(largeJson.upstream.payload, undefined);
    assert.equal(largeJson.inlineResultLimit.limit, 40);
    assert.equal(largeJson.inlineResultLimit.limitBytes, 40);
    assert.equal(largeJson.inlineResultLimit.limitHuman, "40 bytes");
    assert.deepEqual(largeJson.inlineResultLimit.omitted.map((item) => item.field), ["upstream.payload"]);
    assert.equal(typeof largeJson.inlineResultLimit.omitted[0].bytesHuman, "string");
    assert.equal(largeJson.inlineResultLimit.omitted[0].limitHuman, "40 bytes");
    assertFilePointer(largeJson.outputFiles.outputFile, largeJson.outputFiles.outputFile.path);
    assert.match(largeJson.outputFiles.outputFile.path, /eval-results/u);
    assert.match(largeJson.outputFiles.outputFile.path, /eval-main/u);
    assert.match(largeJson.outputFiles.upstreamFile.path, /\.upstream\.json$/u);
    const fullResult = await readPrettyJsonPointer(largeJson.outputFiles.outputFile, largeJson.outputFiles.outputFile.path);
    assert.equal(fullResult.outputFiles, undefined);
    assert.equal(fullResult.upstream.payload.result.payload.length, 200);
    const upstreamFile = await readPrettyJsonPointer(largeJson.outputFiles.upstreamFile, largeJson.outputFiles.upstreamFile.path);
    assert.equal(upstreamFile.kind, "json");
    assert.equal(upstreamFile.ok, true);
    assert.equal(upstreamFile.payload.result.summary, "large eval");

    const explicitResult = await mcpClient.callTool({
      name: "figma_repl_eval",
      arguments: {
        title: "Explicit eval output",
        sessionId: "eval-main",
        code: "return { summary: 'explicit eval' };",
        outputFile: explicitOutputFile,
      },
    });
    const explicitJson = structuredToolResult(explicitResult);
    assert.equal(explicitJson.inlineResultLimit, undefined);
    assertFilePointer(explicitJson.outputFiles.outputFile, explicitOutputFile);
    assert.match(explicitJson.outputFiles.upstreamFile.path, /explicit-eval\.upstream\.json$/u);
    const explicitFile = await readPrettyJsonPointer(explicitJson.outputFiles.outputFile, explicitOutputFile);
    assert.equal(explicitFile.upstream.payload.result.id, "10:1");

    await mcpClient.close();
  } finally {
    if (previousTaskRoot === undefined) {
      delete process.env.FIGMA_REPL_TASK_ROOT;
    } else {
      process.env.FIGMA_REPL_TASK_ROOT = previousTaskRoot;
    }
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("figma REPL eval rejects dynamic helper access before upstream execution", async () => {
  const calls = [];
  const { server } = createFigmaReplMcpServer({
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
      name: "figma_repl_open",
      arguments: {
        title: "Reject removed open field",
        fileUrl: "https://www.figma.com/design/file123/Test",
      },
    }),
    /Tool argument "fileUrl" was removed\. Use "file"/,
  );
  await assert.rejects(
    mcpClient.callTool({
      name: "figma_repl_prepare_task",
      arguments: {
        title: "Reject removed prepare field",
        fileKey: "file123",
      },
    }),
    /Tool argument "fileKey" was removed\. Use "file"/,
  );

  await assert.rejects(
    mcpClient.callTool({
      name: "figma_repl_eval",
      arguments: {
        title: "Reject dynamic helper access",
        sessionId: "main",
        code: "const helperName = 'find';\nreturn await $[helperName]({ name: 'Card' });",
      },
    }),
    /FIGMA_REPL_DYNAMIC_HELPER_ACCESS/,
  );
  assert.deepEqual(calls.map((call) => call[0]), []);
  await mcpClient.close();
});

test("figma REPL eval supports direct async node lookup followed by $.select", async () => {
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

test("figma REPL eval helper selection rejects ambiguous $ binding syntax", () => {
  const aliasDiagnostics = diagnoseFigmaReplCode(
    "const helper = $;\nreturn await helper.find({ name: 'Card' });",
  );
  assert.deepEqual(aliasDiagnostics.map((item) => item.code), ["FIGMA_REPL_DYNAMIC_HELPER_ACCESS"]);

  const assignmentDiagnostics = diagnoseFigmaReplCode("let helper;\nhelper = $;\nreturn helper;");
  assert.deepEqual(assignmentDiagnostics.map((item) => item.code), ["FIGMA_REPL_DYNAMIC_HELPER_ACCESS"]);

  const shadowCode = "const $ = { find() { return null; } };\nreturn $.find();";
  const shadowDiagnostics = diagnoseFigmaReplCode(shadowCode);
  assert.deepEqual(shadowDiagnostics.map((item) => item.code), ["FIGMA_REPL_DYNAMIC_HELPER_ACCESS"]);

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

test("figma REPL helper selector reports injected helpers and dependencies", () => {
  const findSelection = resolveFigmaReplScriptHelperSelection("return await $.find({ name: 'Card' });");
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

  const createSelection = resolveFigmaReplScriptHelperSelection("return await $.create('FRAME');");
  assert.ok(createSelection.injectedHelpers.includes("$.create"));
  assert.ok(createSelection.injectedHelpers.includes("$.findFreeSlot"));
  assert.ok(createSelection.injectedHelpers.includes("$.placeNode"));
  assert.equal(createSelection.injectedHelpers.includes("$.find"), false);

  const literalSelection = resolveFigmaReplScriptHelperSelection("return await $['find']({ name: 'Card' });");
  assert.ok(literalSelection.injectedHelpers.includes("$.find"));
  assert.ok(literalSelection.injectedHelpers.includes("$.findAll"));

  const baseSelection = resolveFigmaReplScriptHelperSelection("return await $('$selection');");
  assert.deepEqual(baseSelection.injectedHelpers, ["$"]);
  assert.deepEqual(baseSelection.helperUsage.direct, ["$"]);
  assert.deepEqual(baseSelection.helperUsage.transitive, []);
  assert.deepEqual(baseSelection.helperUsage.runtimeBase, []);

  const shadowSelection = resolveFigmaReplScriptHelperSelection("const $ = { find() { return null; } };\nreturn $.find();");
  assert.deepEqual(shadowSelection.injectedHelpers, []);
  assert.deepEqual(shadowSelection.helperUsage, { direct: [], transitive: [], runtimeBase: [], injected: [] });
});

test("figma REPL eval exposes and executes the common $ helper surface", async () => {
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
  const expectedFunctionHelpers = [...FIGMA_REPL_EVAL_COMMON_HELPER_NAMES];
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
      "const generatedDryRun = await $.replaceGeneratedFrame({ name: 'Variant Eval helper generated', dryRun: true });",
      "const generatedPlacement = await $.placeNode('$generated', { preferred: { x: 0, y: 0 }, size: { width: 20, height: 20 }, avoidOverlap: true, direction: 'right', gap: 4 });",
      "const viaNode = await $.node('$clone');",
      "const resolvedCloneId = $.resolveId('$clone');",
      "$.forget('$clone');",
      "const checkpoint = await $.checkpoint('eval-helper-surface', [root, '$title'], { depth: 0 });",
      "return { helperTypes, handles: { ...$.handles }, checkpoints: $.checkpoints.length, root: root.id, title: title.id, allText: allText.length, found: found.id, selected: selected.selectedNodeIds, inspected, screenshotBytes, assetFill: asset.fills[0], cloneId: clone.clone.id, viaNode: viaNode.id, resolvedCloneId, cloneForgotten: !('$clone' in $.handles), freeSlot, generatedFrame: generated.frame, generatedDryRunMatches: generatedDryRun.matches.length, generatedPlacement, checkpointName: checkpoint.name, checkpointFirstId: checkpoint.summaries[0].id };",
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
  assert.equal(result.result.generatedDryRunMatches, 1);
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

test("figma REPL exposes self-explaining capabilities and resources", async () => {
  const calls = [];
  const { server } = createFigmaReplMcpServer({
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

  const capabilitiesResource = await mcpClient.readResource({ uri: "figma-repl://capabilities" });
  const capabilities = JSON.parse(capabilitiesResource.contents[0].text);
  assert.ok(capabilities.guide);
  assert.ok(capabilities.patterns);
  assert.ok(capabilities.scriptWorkflow);
  assert.ok(capabilities.fileWorkflow);
  assert.ok(capabilities.workflowTools);
  assert.ok(capabilities.toolTiers);
  assert.ok(capabilities.toolArgumentGuidance);
  assert.ok(capabilities.apiCards);
  assert.ok(capabilities.intents);
  assert.ok(capabilities.safety);
  assert.ok(capabilities.facadeRoutingDelegationBoundaries);
  assert.ok(capabilities.docsLookup);
  assert.ok(capabilities.queryStrategy);
  assert.ok(capabilities.queryStrategy.searchAnchors.includes("text/font"));
  assert.ok(capabilities.queryStrategy.searchAnchors.includes("FigJam/Slides"));
  assert.match(capabilities.guide.purpose, /Unified Figma-facing MCP facade/);
  assert.match(capabilities.guide.purpose, /figma_repl_mcp/);
  assert.ok(capabilities.guide.preferredFlow.includes("figma_repl_eval only for small ephemeral calls; prefer run_script_file for repairable work"));
  assert.ok(capabilities.guide.preferredFlow.includes("figma_repl_call_upstream_tool only when a task explicitly needs an uncovered upstream Figma MCP tool"));
  assert.match(capabilities.guide.upstreamBridge, /figma_repl_call_upstream_tool/);
  assert.match(capabilities.guide.upstreamBridge, /figma-repl:\/\/upstream-tools\/\{name\}/);
  assert.match(capabilities.guide.upstreamBridge, /dedicated wrappers cover use_figma, get_screenshot, upload_assets, and download_assets/);
  assert.match(capabilities.guide.responseShape, /Structured-first payloads/);
  assert.match(capabilities.guide.responseShape, /content is empty except for MCP protocol media items/);
  assert.match(capabilities.guide.responseShape, /upstream\.payload/);
  assert.match(capabilities.guide.responseShape, /upstream\.text/);
  assert.match(capabilities.guide.responseShape, /outputFiles\.upstreamFile/);
  assert.doesNotMatch(capabilities.guide.responseShape, /parsed JSON in result/);
  assert.deepEqual(capabilities.queryStrategy.outputFields, queryOutputFields);
  assert.ok(capabilities.queryStrategy.commonCards.includes("text.font"));
  assert.ok(capabilities.queryStrategy.commonCards.includes("surface.slides"));
  assert.equal(capabilities.scriptWorkflow.primaryTool, "figma_repl_run_script_file");
  assert.equal(capabilities.fileWorkflow.primaryTool, "figma_repl_run_script_file");
  assert.deepEqual(
    capabilities.toolTiers.normalPath.tools,
    ["figma_repl_prepare_task", "figma_repl_run_script_file", "figma_repl_inspect", "figma_repl_capture_node"],
  );
  assert.deepEqual(
    capabilities.toolTiers.advancedEscapeHatches.tools,
    ["figma_repl_eval", "figma_repl_call_upstream_tool"],
  );
  assert.equal(capabilities.toolArgumentGuidance.title.optional, true);
  assert.equal(capabilities.toolArgumentGuidance.title.preferSupplying, true);
  assert.equal(
    capabilities.toolArgumentGuidance.title.schemaDescription,
    "One concise sentence-style line for UI/log display.",
  );
  assert.match(capabilities.toolArgumentGuidance.title.guidance, /Prefer supplying title/);
  assert.match(capabilities.toolArgumentGuidance.title.guidance, /avoid bare labels or tool names/);
  assert.ok(capabilities.toolArgumentGuidance.title.examples.includes("Capture the hero variant for visual QA"));
  assert.deepEqual(
    capabilities.scriptWorkflow.recommendedCalls.dryRun,
    { title: "Dry-run the token audit script", sessionId: "<session>", inputFile: "<task>.figma.js", dryRun: true, strict: true, surface: "design" },
  );
  assert.deepEqual(
    capabilities.scriptWorkflow.recommendedCalls.execute,
    { title: "Execute the token audit script", sessionId: "<session>", inputFile: "<task>.figma.js", outputFile: "<task>.result.json" },
  );
  assert.ok(capabilities.scriptWorkflow.advancedArguments.includes("scriptPath"));
  assert.equal(capabilities.scriptWorkflow.advancedArguments.includes("upstreamTool"), false);
  assert.equal(capabilities.scriptWorkflow.advancedArguments.includes("upstreamArgument"), false);
  assert.equal(capabilities.scriptWorkflow.advancedArguments.includes("upstreamArguments"), false);
  assert.match(capabilities.scriptWorkflow.avoidUnless.scriptPath, /prefer inputFile/i);
  assert.match(capabilities.scriptWorkflow.avoidUnless.inlineResultLimit, /30 KB/);
  assert.equal(capabilities.scriptWorkflow.avoidUnless.upstreamOverrides, undefined);
  assert.deepEqual(
    capabilities.toolArgumentGuidance.prepareTask.recommendedCalls.workspaceFromFile,
    { title: "Prepare the token audit workspace", file: "<figma file URL or file key>", task: "<task>", surface: "design" },
  );
  assert.ok(capabilities.toolArgumentGuidance.prepareTask.advancedArguments.includes("taskRoot"));
  assert.equal(capabilities.toolArgumentGuidance.prepareTask.tier, "normalPath");
  assert.equal(capabilities.toolArgumentGuidance.prepareTask.advancedArguments.includes("taskDir"), false);
  assert.equal(capabilities.toolArgumentGuidance.prepareTask.advancedArguments.includes("scriptName"), false);
  assert.deepEqual(
    capabilities.toolArgumentGuidance.assetManifest.recommendedCalls.applyManifest,
    { title: "Apply generated assets to target rectangles", sessionId: "<session>", manifestPath: "<assets>.json", outputFile: "<assets>.result.json" },
  );
  assert.equal(capabilities.toolArgumentGuidance.assetManifest.advancedArguments.includes("argumentsTemplate"), false);
  assert.equal(capabilities.toolArgumentGuidance.assetManifest.advancedArguments.includes("resultFile"), false);
  assert.equal(capabilities.toolArgumentGuidance.assetManifest.advancedArguments.includes("inlineResultLimit"), false);
  assert.equal(capabilities.toolArgumentGuidance.assetManifest.advancedArguments.includes("toolName"), false);
  assert.equal(capabilities.toolArgumentGuidance.assetManifest.advancedArguments.includes("arguments"), false);
  assert.equal(capabilities.toolArgumentGuidance.assetManifest.advancedArguments.includes("refresh"), false);
  assert.equal(capabilities.toolArgumentGuidance.assetManifest.avoidUnless.upstreamTemplates, undefined);
  assert.deepEqual(
    capabilities.toolArgumentGuidance.captureNode.recommendedCalls.capture,
    { title: "Capture the target node for visual QA", sessionId: "<session>", target: "$target", outputFile: "<capture>.webp", preview: true },
  );
  assert.ok(capabilities.toolArgumentGuidance.captureNode.advancedArguments.includes("metadataFile"));
  assert.equal(capabilities.toolArgumentGuidance.captureNode.advancedArguments.includes("targetNodeId"), false);
  assert.equal(capabilities.toolArgumentGuidance.captureNode.advancedArguments.includes("argumentsTemplate"), false);
  assert.equal(capabilities.toolArgumentGuidance.captureNode.advancedArguments.includes("inlineResultLimit"), false);
  assert.equal(capabilities.toolArgumentGuidance.captureNode.advancedArguments.includes("toolName"), false);
  assert.equal(capabilities.toolArgumentGuidance.captureNode.advancedArguments.includes("arguments"), false);
  assert.equal(capabilities.toolArgumentGuidance.captureNode.advancedArguments.includes("refresh"), false);
  assert.equal(capabilities.toolArgumentGuidance.captureNode.avoidUnless.upstreamTemplates, undefined);
  assert.deepEqual(
    capabilities.toolArgumentGuidance.taskPlan.recommendedCalls.filePlan,
    { title: "Run the repeatable asset QA plan", sessionId: "<session>", planPath: "<plan>.json", outputFile: "<plan>.result.json" },
  );
  assert.ok(capabilities.toolArgumentGuidance.taskPlan.advancedArguments.includes("steps"));
  assert.equal(capabilities.toolArgumentGuidance.taskPlan.advancedArguments.includes("resultFile"), false);
  assert.equal(capabilities.toolArgumentGuidance.taskPlan.advancedArguments.includes("inlineResultLimit"), false);
  assert.equal(capabilities.toolArgumentGuidance.open.advancedArguments.includes("upstreamTool"), false);
  assert.equal(capabilities.toolArgumentGuidance.open.advancedArguments.includes("upstreamArgument"), false);
  assert.equal(capabilities.toolArgumentGuidance.open.advancedArguments.includes("upstreamArguments"), false);
  assert.equal(capabilities.toolArgumentGuidance.open.avoidUnless.upstreamOverrides, undefined);
  assert.equal(capabilities.toolArgumentGuidance.open.tier, "contextAndLookup");
  assert.equal(capabilities.toolArgumentGuidance.eval.tier, "advancedEscapeHatches");
  assert.match(capabilities.toolArgumentGuidance.eval.guidance, /small ephemeral calls/);
  assert.match(capabilities.toolArgumentGuidance.eval.guidance, /prepare_task/);
  assert.ok(capabilities.toolArgumentGuidance.eval.advancedArguments.includes("outputFile"));
  assert.ok(capabilities.toolArgumentGuidance.eval.advancedArguments.includes("inlineResultLimit"));
  assert.equal(capabilities.toolArgumentGuidance.eval.advancedArguments.includes("upstreamTool"), false);
  assert.equal(capabilities.toolArgumentGuidance.eval.advancedArguments.includes("upstreamArgument"), false);
  assert.equal(capabilities.toolArgumentGuidance.eval.advancedArguments.includes("upstreamArguments"), false);
  assert.match(capabilities.toolArgumentGuidance.eval.avoidUnless.inlineResultLimit, /30 KB/);
  assert.equal(capabilities.toolArgumentGuidance.eval.avoidUnless.upstreamOverrides, undefined);
  assert.deepEqual(
    capabilities.toolArgumentGuidance.inspect.recommendedCalls.inspectStyle,
    { title: "Inspect visual style tokens", sessionId: "<session>", mode: "style", target: "$selection" },
  );
  assert.equal(capabilities.toolArgumentGuidance.inspect.tier, "normalPath");
  assert.equal(capabilities.toolArgumentGuidance.inspect.advancedArguments.includes("upstreamTool"), false);
  assert.equal(capabilities.toolArgumentGuidance.inspect.advancedArguments.includes("upstreamArgument"), false);
  assert.equal(capabilities.toolArgumentGuidance.inspect.advancedArguments.includes("upstreamArguments"), false);
  assert.equal(capabilities.toolArgumentGuidance.inspect.avoidUnless.upstreamOverrides, undefined);
  assert.equal(capabilities.toolArgumentGuidance.guidance.tier, "contextAndLookup");
  assert.equal(capabilities.toolArgumentGuidance.lookup.tier, "contextAndLookup");
  assert.deepEqual(capabilities.toolArgumentGuidance.lookup.preferredArguments.api, ["kind=api", "symbol"]);
  assert.match(capabilities.toolArgumentGuidance.callUpstreamTool.guidance, /Explicit upstream escape hatch/);
  assert.match(capabilities.toolArgumentGuidance.callUpstreamTool.guidance, /figma-repl:\/\/upstream-tools/);
  assert.match(capabilities.toolArgumentGuidance.callUpstreamTool.guidance, /do not use for use_figma\/get_screenshot\/upload_assets\/download_assets/);
  assert.equal(capabilities.toolArgumentGuidance.callUpstreamTool.tier, "advancedEscapeHatches");
  assert.ok(capabilities.toolArgumentGuidance.callUpstreamTool.advancedArguments.includes("outputFile"));
  assert.ok(capabilities.toolArgumentGuidance.callUpstreamTool.advancedArguments.includes("inlineResultLimit"));
  assert.match(capabilities.toolArgumentGuidance.callUpstreamTool.avoidUnless.inlineResultLimit, /30 KB/);
  assert.ok(capabilities.fileWorkflow.guidance.some((line) => line.includes("eval wrapper")));
  assert.ok(capabilities.fileWorkflow.guidance.some((line) => line.includes("outputFiles.upstreamFile")));
  assert.ok(capabilities.fileWorkflow.guidance.some((line) => line.includes("Dynamic $ helper access")));
  assert.ok(capabilities.fileWorkflow.guidance.some((line) => line.includes("$[name] / $name-style")));
  assert.ok(capabilities.fileWorkflow.guidance.some((line) => line.includes("const { ...rest } = $")));
  assert.ok(capabilities.fileWorkflow.guidance.some((line) => line.includes("aliasing $")));
  assert.ok(capabilities.fileWorkflow.guidance.some((line) => line.includes("declaring a local $")));
  assert.ok(capabilities.fileWorkflow.guidance.some((line) => line.includes("$.helper(...)")));
  assert.ok(capabilities.fileWorkflow.guidance.some((line) => line.includes("$['helper'](...)")));
  assert.ok(capabilities.fileWorkflow.guidance.some((line) => line.includes("const { helper } = $")));
  assert.deepEqual(
    capabilities.fileWorkflow.workflowTools,
    ["figma_repl_apply_asset_manifest", "figma_repl_download_assets", "figma_repl_capture_node", "figma_repl_run_task_plan"],
  );
  assert.equal(capabilities.workflowTools.assetManifest.tool, "figma_repl_apply_asset_manifest");
  assert.match(capabilities.workflowTools.assetManifest.result, /assetDetails/);
  assert.match(capabilities.workflowTools.assetManifest.result, /compact upload summary/);
  assert.equal(capabilities.workflowTools.downloadAssets.tool, "figma_repl_download_assets");
  assert.match(capabilities.workflowTools.downloadAssets.targetShape, /\{ target, name\?, defaultFormat\?, defaultScale\? \}/);
  assert.match(capabilities.workflowTools.downloadAssets.result, /targetDetails/);
  assert.deepEqual(
    capabilities.toolArgumentGuidance.downloadAssets.recommendedCalls.downloadTargets,
    { title: "Download source assets from targets", sessionId: "<session>", targets: [{ target: "$target", defaultFormat: "png" }], outputDir: "<downloads>", outputFile: "<downloads>.result.json" },
  );
  assert.equal(capabilities.workflowTools.capture.tool, "figma_repl_capture_node");
  assert.match(capabilities.workflowTools.capture.metadata, /full upstream capture envelope/);
  assert.equal(capabilities.workflowTools.taskPlan.tool, "figma_repl_run_task_plan");
  assert.match(capabilities.workflowTools.taskPlan.stepShape, /\{ id\?, type\?, args\? \}/);
  assert.ok(capabilities.workflowTools.taskPlan.stepTypes.includes("download-assets"));
  assert.ok(capabilities.workflowTools.taskPlan.stepTypes.includes("download_assets"));
  assert.match(capabilities.workflowTools.taskPlan.references, /upstream\.payload/);
  assert.match(capabilities.workflowTools.taskPlan.references, /downloadOutputDir/);
  assert.equal(capabilities.fileWorkflow.prepareTool, "figma_repl_prepare_task");
  assert.match(capabilities.fileWorkflow.workspaceLayout, /<fileKey-or-fileSlug>/);
  assert.match(capabilities.scriptWorkflow.options.outputFile, /result\.json/);
  assert.deepEqual(
    capabilities.scriptWorkflow.responseExamples.jsonSuccess.upstream,
    { kind: "json", ok: true, payload: { ok: true, result: {} } },
  );
  assert.equal(capabilities.scriptWorkflow.responseExamples.textOutput.upstream.kind, "text");
  assert.equal(
    capabilities.scriptWorkflow.responseExamples.inlinePayloadOmitted.inlineResultLimit.omitted[0].field,
    "upstream.payload",
  );
  assert.equal(capabilities.scriptWorkflow.responseExamples.inlinePayloadOmitted.inlineResultLimit.limitHuman, "4 KB");
  assert.equal(capabilities.scriptWorkflow.responseExamples.inlinePayloadOmitted.upstream.payload, undefined);
  assert.doesNotMatch(JSON.stringify(capabilities), /rawBytes/);
  assert.match(capabilities.scriptWorkflow.helpers["$.select"], /selection/);
  assert.match(capabilities.scriptWorkflow.helpers["$.cloneNodeTree"], /instance-subtree/);
  assert.match(capabilities.scriptWorkflow.helpers["$.findFreeSlot"], /non-overlapping/);
  assert.match(capabilities.scriptWorkflow.helpers["$.placeNode"], /placement/);
  assert.match(capabilities.scriptWorkflow.helpers["$.replaceGeneratedFrame"], /replace/);
  assert.match(capabilities.scriptWorkflow.helpers["$.imageAsset"], /image-fill rectangle/);
  assert.match(capabilities.scriptWorkflow.helpers["$.screenshot"], /final QA/);
  assert.match(capabilities.scriptWorkflow.helpers["$.checkpoint"], /summaries/);
  assert.deepEqual(
    Object.keys(capabilities.scriptWorkflow.helpers).sort(),
    ["$", ...FIGMA_REPL_EVAL_COMMON_HELPER_NAMES.map((name) => `$.${name}`)].sort(),
  );
  assert.ok(capabilities.examples);
  assert.ok(capabilities.examples.every((example) => JSON.stringify(example)));

  const tools = await mcpClient.listTools();
  assert.ok(!tools.tools.some((tool) => tool.name === "figma_repl_capabilities"));
  assert.deepEqual(tools.tools.map((tool) => tool.name).sort(), [
    "figma_repl_apply_asset_manifest",
    "figma_repl_call_upstream_tool",
    "figma_repl_capture_node",
    "figma_repl_download_assets",
    "figma_repl_eval",
    "figma_repl_guidance",
    "figma_repl_inspect",
    "figma_repl_lookup",
    "figma_repl_open",
    "figma_repl_prepare_task",
    "figma_repl_run_script_file",
    "figma_repl_run_task_plan",
  ]);
  assert.equal(tools.tools.length, 12);
  for (const tool of tools.tools) {
    assert.equal(
      tool.inputSchema.properties.title.description,
      "One concise sentence-style line for UI/log display.",
      `${tool.name} keeps title description concise`,
    );
    assert.equal(
      (tool.inputSchema.required ?? []).includes("title"),
      false,
      `${tool.name} does not require title`,
    );
  }
  const runScriptFileTool = tools.tools.find((tool) => tool.name === "figma_repl_run_script_file");
  assert.ok(runScriptFileTool);
  assert.match(runScriptFileTool.description, /dry-run with \{ title, sessionId, inputFile/);
  assert.match(runScriptFileTool.description, /execute with \{ title, sessionId, inputFile, outputFile \}/);
  assert.match(runScriptFileTool.description, /file\/output controls/);
  assert.match(runScriptFileTool.description, /fixed upstream use_figma\/code/);
  assert.doesNotMatch(runScriptFileTool.description, /\$\[name\]/);
  assert.match(runScriptFileTool.inputSchema.properties.inputFile.description, /Recommended workspace script file name/);
  assert.match(runScriptFileTool.inputSchema.properties.inputFile.description, /preferred over scriptPath/);
  assert.match(runScriptFileTool.inputSchema.properties.scriptPath.description, /escape hatch/);
  assert.match(runScriptFileTool.inputSchema.properties.outputFile.description, /Recommended normal result file/);
  assert.equal(runScriptFileTool.inputSchema.properties.resultFile, undefined);
  assert.match(runScriptFileTool.inputSchema.properties.surface.description, /Expected Figma surface/);
  assert.equal(runScriptFileTool.inputSchema.properties.upstreamTool, undefined);
  assert.equal(runScriptFileTool.inputSchema.properties.upstreamArgument, undefined);
  assert.equal(runScriptFileTool.inputSchema.properties.upstreamArguments, undefined);
  assert.match(runScriptFileTool.inputSchema.properties.diagnosticsFile.description, /Advanced opt-in/);
  assert.match(runScriptFileTool.inputSchema.properties.summaryFile.description, /Advanced opt-in/);
  assert.match(runScriptFileTool.inputSchema.properties.inlineResultLimit.description, /30 KB/);
  assert.match(runScriptFileTool.inputSchema.properties.inlineResultLimit.description, /complete payloads stay in outputFile/);
  assert.equal(runScriptFileTool.inputSchema.properties.inlineResultLimit.default, 4000);
  assert.equal(runScriptFileTool.inputSchema.properties.inlineResultLimit.maximum, 30000);
  assert.equal(runScriptFileTool.inputSchema.properties.inlineResultLimit.minimum, 0);
  assert.ok(runScriptFileTool.outputSchema.properties.outputFiles.properties.upstreamFile);
  assert.ok(runScriptFileTool.outputSchema.properties.inlineResultLimit.properties.omitted.items.properties.field);
  assert.deepEqual(
    Object.keys(runScriptFileTool.outputSchema.properties.script.properties.helperUsage.properties).sort(),
    ["direct", "injected", "runtimeBase", "transitive"],
  );
  const evalTool = tools.tools.find((tool) => tool.name === "figma_repl_eval");
  assert.ok(evalTool);
  assert.match(evalTool.description, /Small ephemeral JavaScript call/);
  assert.match(evalTool.description, /prepare_task \+ run_script_file/);
  assert.doesNotMatch(evalTool.description, /\$\[name\]/);
  assert.match(evalTool.inputSchema.properties.outputFile.description, /full result JSON file/);
  assert.match(evalTool.inputSchema.properties.inlineResultLimit.description, /30 KB/);
  assert.equal(evalTool.inputSchema.properties.inlineResultLimit.default, 4000);
  assert.equal(evalTool.inputSchema.properties.inlineResultLimit.maximum, 30000);
  assert.equal(evalTool.inputSchema.properties.inlineResultLimit.minimum, 0);
  assert.equal(evalTool.inputSchema.properties.upstreamTool, undefined);
  assert.equal(evalTool.inputSchema.properties.upstreamArgument, undefined);
  assert.equal(evalTool.inputSchema.properties.upstreamArguments, undefined);
  assert.match(evalTool.inputSchema.properties.handleUpdates.description, /handle-import escape hatch/);
  assert.ok(evalTool.outputSchema.properties.outputFiles.properties.upstreamFile);
  assert.deepEqual(evalTool.outputSchema.properties.upstream.properties.kind.enum, ["json", "text", "unknown"]);
  const openTool = tools.tools.find((tool) => tool.name === "figma_repl_open");
  assert.ok(openTool);
  assert.match(openTool.description, /Recommended call: \{ title, sessionId, file, surface \}/);
  assert.match(openTool.inputSchema.properties.file.description, /Figma file URL or raw file key/);
  assert.equal(openTool.inputSchema.properties.connect.default, true);
  assert.equal(openTool.inputSchema.properties.fileUrl, undefined);
  assert.equal(openTool.inputSchema.properties.fileKey, undefined);
  assert.equal(openTool.inputSchema.properties.expectedSurface, undefined);
  assert.equal(openTool.inputSchema.properties.upstreamTool, undefined);
  assert.equal(openTool.inputSchema.properties.upstreamArgument, undefined);
  assert.equal(openTool.inputSchema.properties.upstreamArguments, undefined);
  const assetManifestTool = tools.tools.find((tool) => tool.name === "figma_repl_apply_asset_manifest");
  assert.ok(assetManifestTool);
  assert.match(assetManifestTool.description, /Recommended workspace call: \{ title, sessionId, manifestPath, outputFile\? \}/);
  assert.match(assetManifestTool.inputSchema.properties.manifestPath.description, /Recommended manifest file path/);
  assert.match(assetManifestTool.inputSchema.properties.assets.description, /Advanced inline asset entries/);
  assert.equal(assetManifestTool.inputSchema.properties.toolName, undefined);
  assert.equal(assetManifestTool.inputSchema.properties.arguments, undefined);
  assert.equal(assetManifestTool.inputSchema.properties.refresh, undefined);
  assert.equal(assetManifestTool.inputSchema.properties.validateTargets.default, true);
  assert.equal(assetManifestTool.inputSchema.properties.argumentsTemplate, undefined);
  assert.equal(assetManifestTool.inputSchema.properties.resultFile, undefined);
  assert.match(assetManifestTool.inputSchema.properties.outputFile.description, /Recommended manifest result JSON/);
  assert.equal(assetManifestTool.inputSchema.properties.inlineResultLimit, undefined);
  assert.ok(assetManifestTool.outputSchema.properties.assets.items.properties.upstreamSummary);
  assert.ok(assetManifestTool.outputSchema.properties.outputFiles.properties.outputFile);
  const downloadAssetsTool = tools.tools.find((tool) => tool.name === "figma_repl_download_assets");
  assert.ok(downloadAssetsTool);
  assert.match(downloadAssetsTool.description, /official Figma asset downloads/);
  assert.match(downloadAssetsTool.description, /targets:\[\{ target/);
  assert.deepEqual(
    Object.keys(downloadAssetsTool.inputSchema.properties).sort(),
    ["manifestPath", "outputDir", "outputFile", "sessionId", "targets", "title"],
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
  assert.ok(downloadAssetsTool.outputSchema.properties.outputFiles.properties.outputFile);
  const captureNodeTool = tools.tools.find((tool) => tool.name === "figma_repl_capture_node");
  assert.ok(captureNodeTool);
  assert.match(captureNodeTool.description, /outputFile\?/);
  assert.match(captureNodeTool.description, /\.png\/\.jpg\/\.jpeg/);
  assert.equal(captureNodeTool.inputSchema.properties.nodeId, undefined);
  assert.equal(captureNodeTool.inputSchema.properties.targetNodeId, undefined);
  assert.equal(captureNodeTool.inputSchema.properties.handle, undefined);
  assert.match(captureNodeTool.inputSchema.properties.target.description, /Recommended target/);
  assert.match(captureNodeTool.inputSchema.properties.target.description, /\{ fileKey, nodeId \}/);
  assert.match(captureNodeTool.inputSchema.properties.outputFile.description, /Recommended extension.*\.webp/);
  assert.match(captureNodeTool.inputSchema.properties.outputFile.description, /\.png, \.jpg, and \.jpeg extensions are preserved/);
  assert.match(captureNodeTool.inputSchema.properties.metadataFile.description, /metadata JSON/);
  assert.equal(captureNodeTool.inputSchema.properties.preview.default, false);
  assert.equal(captureNodeTool.inputSchema.properties.toolName, undefined);
  assert.equal(captureNodeTool.inputSchema.properties.arguments, undefined);
  assert.equal(captureNodeTool.inputSchema.properties.refresh, undefined);
  assert.equal(captureNodeTool.inputSchema.properties.inlineResultLimit, undefined);
  assert.deepEqual(captureNodeTool.outputSchema.properties.preview.properties.omittedReason.enum, ["not-image", "generation-failed"]);
  assert.deepEqual(captureNodeTool.outputSchema.properties.mimeType.enum, ["image/webp", "image/png", "image/jpeg", "text/plain"]);
  assert.ok(captureNodeTool.outputSchema.properties.outputFiles.properties.metadataFile);
  const taskPlanTool = tools.tools.find((tool) => tool.name === "figma_repl_run_task_plan");
  assert.ok(taskPlanTool);
  assert.match(taskPlanTool.description, /Recommended file-plan call: \{ title, sessionId, planPath, outputFile \}/);
  assert.match(taskPlanTool.description, /\{ id\?, type\?, args\? \}/);
  assert.match(taskPlanTool.inputSchema.properties.planPath.description, /Recommended JSON plan path/);
  assert.match(taskPlanTool.inputSchema.properties.steps.description, /Advanced inline steps/);
  assert.equal(taskPlanTool.inputSchema.properties.stopOnFailure.default, true);
  assert.equal(taskPlanTool.inputSchema.properties.steps.items.additionalProperties, false);
  assert.deepEqual(Object.keys(taskPlanTool.inputSchema.properties.steps.items.properties).sort(), ["args", "id", "type"]);
  assert.equal(taskPlanTool.inputSchema.properties.resultFile, undefined);
  assert.equal(taskPlanTool.inputSchema.properties.inlineResultLimit, undefined);
  const prepareTaskTool = tools.tools.find((tool) => tool.name === "figma_repl_prepare_task");
  assert.ok(prepareTaskTool);
  assert.match(prepareTaskTool.description, /Recommended workspace call: \{ title, file, task, surface \}/);
  assert.match(prepareTaskTool.inputSchema.properties.file.description, /Figma file URL or raw file key/);
  assert.equal(prepareTaskTool.inputSchema.properties.fileUrl, undefined);
  assert.equal(prepareTaskTool.inputSchema.properties.fileKey, undefined);
  assert.equal(prepareTaskTool.inputSchema.properties.intent, undefined);
  assert.equal(prepareTaskTool.inputSchema.properties.goal, undefined);
  assert.equal(prepareTaskTool.inputSchema.properties.taskName, undefined);
  assert.equal(prepareTaskTool.inputSchema.properties.taskDir, undefined);
  assert.equal(prepareTaskTool.inputSchema.properties.scriptName, undefined);
  assert.equal(prepareTaskTool.inputSchema.properties.expectedSurface, undefined);
  assert.match(prepareTaskTool.inputSchema.properties.task.description, /Recommended human task/);
  assert.match(prepareTaskTool.inputSchema.properties.workspaceDir.description, /Advanced absolute workspace/);
  assert.match(prepareTaskTool.inputSchema.properties.surface.description, /Recommended expected Figma surface/);
  assert.match(prepareTaskTool.inputSchema.properties.taskRoot.description, /Advanced absolute task root/);
  assert.match(prepareTaskTool.inputSchema.properties.overwrite.description, /Advanced destructive/);
  assert.ok(prepareTaskTool.outputSchema.properties.taskChange);
  assert.ok(prepareTaskTool.outputSchema.properties.taskChange.properties.previous);
  assert.ok(prepareTaskTool.outputSchema.properties.taskChange.properties.current);
  assert.ok(prepareTaskTool.outputSchema.properties.taskChange.properties.changed);
  assert.ok(prepareTaskTool.outputSchema.properties.outputFiles);
  const inspectTool = tools.tools.find((tool) => tool.name === "figma_repl_inspect");
  assert.ok(inspectTool);
  assert.match(inspectTool.description, /fixed upstream use_figma/);
  assert.deepEqual(inspectTool.inputSchema.properties.mode.enum, ["inspect", "validate", "style"]);
  assert.equal(inspectTool.inputSchema.properties.upstreamTool, undefined);
  assert.equal(inspectTool.inputSchema.properties.upstreamArgument, undefined);
  assert.equal(inspectTool.inputSchema.properties.upstreamArguments, undefined);
  const guidanceMetadataTool = tools.tools.find((tool) => tool.name === "figma_repl_guidance");
  assert.ok(guidanceMetadataTool);
  assert.match(guidanceMetadataTool.description, /Use task/);
  assert.equal(guidanceMetadataTool.inputSchema.properties.intent, undefined);
  assert.equal(guidanceMetadataTool.inputSchema.properties.goal, undefined);
  assert.equal(guidanceMetadataTool.inputSchema.properties.expectedSurface, undefined);
  const lookupMetadataTool = tools.tools.find((tool) => tool.name === "figma_repl_lookup");
  assert.ok(lookupMetadataTool);
  assert.match(lookupMetadataTool.description, /kind=docs use query/);
  assert.match(lookupMetadataTool.inputSchema.properties.symbol.description, /Recommended for kind=api/);
  assert.match(lookupMetadataTool.inputSchema.properties.maxResults.description, /Result-size control only/);
  const callUpstreamTool = tools.tools.find((tool) => tool.name === "figma_repl_call_upstream_tool");
  assert.ok(callUpstreamTool);
  assert.match(callUpstreamTool.description, /Explicit upstream-only escape hatch/);
  assert.match(callUpstreamTool.description, /figma-repl:\/\/upstream-tools\/\{name\}/);
  assert.match(callUpstreamTool.description, /Do not use for use_figma, get_screenshot, upload_assets, or download_assets/);
  assert.ok(callUpstreamTool.inputSchema.properties.outputFile);
  assert.ok(callUpstreamTool.inputSchema.properties.inlineResultLimit);
  assert.equal(callUpstreamTool.inputSchema.properties.inlineResultLimit.default, 4000);
  assert.equal(callUpstreamTool.inputSchema.properties.inlineResultLimit.maximum, 30000);
  assert.equal(callUpstreamTool.inputSchema.properties.inlineResultLimit.minimum, 0);
  assert.ok(callUpstreamTool.outputSchema.properties.outputFiles.properties.upstreamFile);
  assert.ok(callUpstreamTool.outputSchema.properties.inlineResultLimit.properties.omitted);
  await assert.rejects(
    () => mcpClient.callTool({
      name: "figma_repl_capabilities",
      arguments: { title: "Read capabilities" },
    }),
    /Unknown figma_repl_mcp tool: figma_repl_capabilities/,
  );
  for (const deletedTool of [
    "figma_repl_init_workspace",
    "figma_repl_plan_task",
    "figma_repl_cache_get",
    "figma_repl_validate_handles",
    "figma_repl_list_upstream_tools",
    "figma_repl_docs_search",
    "figma_repl_api_lookup",
    "figma_repl_suggest_api",
    "figma_repl_api_card",
  ]) {
    await assert.rejects(
      () => mcpClient.callTool({
        name: deletedTool,
        arguments: { title: "Deleted tool" },
      }),
      new RegExp(`Unknown figma_repl_mcp tool: ${deletedTool}`),
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
    assert.ok(
      Object.keys(tool.outputSchema?.properties ?? {}).length <= 13,
      `${tool.name} outputSchema stays concise`,
    );
  }
  const guidanceTool = tools.tools.find((tool) => tool.name === "figma_repl_guidance");
  assert.match(guidanceTool.inputSchema.properties.task.description, /Trimmed and capped to 120 characters/);
  assert.equal(guidanceTool.inputSchema.properties.intent, undefined);
  assert.equal(guidanceTool.inputSchema.properties.goal, undefined);
  assert.match(guidanceTool.inputSchema.properties.card.description, /Hard limit 120 characters/);
  assert.match(guidanceTool.inputSchema.properties.query.description, /Hard limit 120 characters/);
  const lookupTool = tools.tools.find((tool) => tool.name === "figma_repl_lookup");
  assert.match(lookupTool.inputSchema.properties.query.description, /Hard limit 120 characters/);
  assert.match(lookupTool.inputSchema.properties.symbol.description, /Hard limit 120 characters/);

  const resources = await mcpClient.listResources();
  const uris = resources.resources.map((resource) => resource.uri);
  const staticResources = resources.resources.filter((resource) => !resource.uri.startsWith("figma-repl://sessions/"));
  assert.deepEqual(staticResources.map((resource) => resource.uri).sort(), expectedStaticResourceUris);
  for (const resource of staticResources) {
    assert.match(resource.description ?? "", /Read (first|when|only)/, `${resource.uri} has actionable description`);
  }
  assert.ok(uris.every((uri) => !uri.includes("official-figma-skills")));
  assert.ok(uris.every((uri) => !uri.includes("/references/")));

  const resourceTemplates = await mcpClient.listResourceTemplates();
  assert.deepEqual(resourceTemplates.resourceTemplates, [
    {
      uriTemplate: "figma-repl://sessions/{id}",
      name: "Figma REPL session by id",
      description: "Read when you need full public state for a known REPL session id, including remembered handles, workspace files, file context, and recent call history.",
      mimeType: "application/json",
    },
    {
      uriTemplate: "figma-repl://upstream-tools/{name}",
      name: "Figma upstream MCP tool by name",
      description: "Read only after figma-repl://upstream-tools when you need the full upstream tool description and inputSchema for one official tool.",
      mimeType: "application/json",
    },
  ]);

  const aggregateResource = await mcpClient.readResource({ uri: "figma-repl://capabilities" });
  assert.deepEqual(JSON.parse(aggregateResource.contents[0].text).queryStrategy.outputFields, queryOutputFields);

  const scriptsResource = await mcpClient.readResource({ uri: "figma-repl://scripts" });
  const scripts = JSON.parse(scriptsResource.contents[0].text);
  assert.equal(scripts.primaryTool, "figma_repl_run_script_file");
  assert.match(scripts.options.scriptPath, /absolute-path escape hatch/i);

  const workflowResource = await mcpClient.readResource({ uri: "figma-repl://file-workflow" });
  const workflow = JSON.parse(workflowResource.contents[0].text);
  assert.equal(workflow.prepareTool, "figma_repl_prepare_task");
  assert.deepEqual(workflow.helpers, ["$", ...FIGMA_REPL_EVAL_COMMON_HELPER_NAMES.map((name) => `$.${name}`)]);
  assert.deepEqual(workflow.workflowTools, [
    "figma_repl_apply_asset_manifest",
    "figma_repl_download_assets",
    "figma_repl_capture_node",
    "figma_repl_run_task_plan",
  ]);

  const workflowToolsResource = await mcpClient.readResource({ uri: "figma-repl://workflow-tools" });
  const workflowTools = JSON.parse(workflowToolsResource.contents[0].text);
  assert.equal(workflowTools.assetManifest.tool, "figma_repl_apply_asset_manifest");
  assert.match(workflowTools.assetManifest.defaults, /official upload_assets/);
  assert.doesNotMatch(workflowTools.assetManifest.assetShape, /toolName|arguments/);
  assert.equal(workflowTools.downloadAssets.tool, "figma_repl_download_assets");
  assert.match(workflowTools.downloadAssets.defaults, /\{ targets: \[\.\.\.\] \}/);
  assert.ok(workflowTools.taskPlan.stepTypes.includes("download_assets"));
  assert.equal(workflowTools.capture.tool, "figma_repl_capture_node");
  assert.match(workflowTools.capture.defaulting, /official get_screenshot/);
  assert.match(workflowTools.capture.defaulting, /\{ fileKey, nodeId \}/);

  const cardsResource = await mcpClient.readResource({ uri: "figma-repl://api-cards" });
  const cards = JSON.parse(cardsResource.contents[0].text);
  const cardIds = cards.cards.map((card) => card.id);
  assert.ok(cardIds.includes("text.font"));
  assert.ok(cardIds.includes("layout.auto"));
  assert.ok(cardIds.includes("variables.bind"));
  assert.ok(cardIds.includes("styles.apply"));
  assert.ok(cardIds.includes("components.variants"));
  assert.ok(cardIds.includes("instances.properties"));
  assert.ok(cardIds.includes("images.fill"));
  assert.ok(cardIds.includes("capture.qa"));
  assert.ok(cardIds.includes("surface.figjam"));
  assert.ok(cardIds.includes("surface.slides"));
  assert.ok(cards.cards.find((card) => card.id === "text.font").apiSymbols.includes("figma.loadFontAsync"));
  assert.ok(cards.cards.find((card) => card.id === "images.fill").avoid.some((entry) => /large base64/.test(entry)));

  const intentsResource = await mcpClient.readResource({ uri: "figma-repl://intents" });
  const intents = JSON.parse(intentsResource.contents[0].text);
  assert.equal(intents.tool, "figma_repl_guidance");
  assert.deepEqual(intents.queryStrategy.outputFields, capabilities.queryStrategy.outputFields);
  assert.deepEqual(intents.examples[0].referenceContext, []);

  const docsResource = await mcpClient.readResource({ uri: "figma-repl://docs" });
  const docs = JSON.parse(docsResource.contents[0].text);
  assert.equal(docs.tool, "figma_repl_lookup");
  assert.equal(docs.kind, "docs");
  assert.match(docs.purpose, /internal Figma corpus/);
  assert.match(docs.workflow.join(" "), /instead of reading bundled corpus files/);

  const apiResource = await mcpClient.readResource({ uri: "figma-repl://api" });
  const api = JSON.parse(apiResource.contents[0].text);
  assert.equal(api.tool, "figma_repl_lookup");
  assert.equal(api.kind, "api");
  assert.match(api.guardrail, /never returned/);

  const upstreamResource = await mcpClient.readResource({ uri: "figma-repl://upstream-tools" });
  const upstream = JSON.parse(upstreamResource.contents[0].text);
  assert.ok(Array.isArray(upstream.tools));
  assert.equal(upstream.detailTemplate, "figma-repl://upstream-tools/{name}");
  assert.deepEqual(upstream.categories, ["capture", "design-context", "execution", "assets", "code-connect", "libraries", "figjam", "generation", "account", "other"]);
  assert.match(upstream.guidance, /figma_repl_call_upstream_tool/);
  assert.match(upstream.guidance, /dedicated figma_repl_\* wrappers/);
  assert.equal(upstream.tools[0].name, "use_figma");
  assert.equal(upstream.tools[0].category, "execution");
  assert.equal(upstream.tools[0].description, "Run Plugin API JavaScript to create, inspect, or edit Figma content.");
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
  assert.equal(upstreamTool.callTool, "figma_repl_call_upstream_tool");
  assert.match(upstreamTool.guidance, /explicit uncovered official upstream capabilities/);
  assert.deepEqual(calls.map((call) => call[0]), ["connect", "listTools"]);
  await mcpClient.close();
});

test("figma router docs preserve runtime-owned contract wording", async () => {
  const skillText = await readFile(resolve(packageRoot, "../skills/figma-router/SKILL.md"), "utf8");
  const openaiText = await readFile(resolve(packageRoot, "../skills/figma-router/agents/openai.yaml"), "utf8");
  const pluginReadme = await readFile(resolve(packageRoot, "../README.md"), "utf8");
  const stdioReadme = await readFile(resolve(packageRoot, "README.md"), "utf8");
  const docsText = [skillText, openaiText, pluginReadme, stdioReadme].join("\n");

  assert.match(skillText, /After OAuth registration, use `figma_repl_mcp` as the agent-facing entrypoint/);
  assert.match(skillText, /read `figma-repl:\/\/capabilities`/);
  assert.match(skillText, /Bundled reference files are internal lookup corpus/);
  assert.match(skillText, /recommendedCards`, `queryHints`, `apiSymbols`, `avoid`, and `referenceContext`/);
  for (const uri of expectedStaticResourceUris.filter((uri) => uri !== "figma-repl://sessions")) {
    assert.match(skillText, new RegExp(uri.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  }
  assert.match(pluginReadme, /`figma_repl_mcp` is the primary agent workflow after OAuth registration/);
  assert.match(pluginReadme, /server id changed from `figma-repl-mcp` to `figma_repl_mcp`/);
  assert.match(pluginReadme, /Bundled reference files are internal lookup corpus/);
  assert.match(stdioReadme, /old persistent server id `figma-repl-mcp`/);
  assert.match(stdioReadme, /bundled corpus files are internal and are not an agent-facing documentation path/);
  assert.match(stdioReadme, /explicit uncovered upstream capability/);
  assert.match(openaiText, /figma_repl_mcp/);
  for (const term of forbiddenRouterContractTerms) {
    assert.ok(!docsText.includes(term), `router docs must not mention ${term}`);
  }
});

test("figma REPL proxies a fake upstream official tool and rejects local tool names", async () => {
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
  const { server } = createFigmaReplMcpServer({ client: fakeClient });
  const mcpClient = new Client(
    { name: "test-client", version: "0.1.0" },
    { capabilities: {} },
  );
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

  await server.connect(serverTransport);
  await mcpClient.connect(clientTransport);

  const result = await mcpClient.callTool({
    name: "figma_repl_call_upstream_tool",
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
  assert.equal(json.upstream.payload.diagramId, "abc123");
  assert.equal(json.result, undefined);
  assert.equal(json.text, undefined);
  assert.equal(json.raw, undefined);

  const failureResult = await mcpClient.callTool({
    name: "figma_repl_call_upstream_tool",
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
  assert.equal(failureJson.upstream.payload.error.code, "UPSTREAM_FAILED");
  assert.equal(failureJson.upstreamError.code, "UPSTREAM_FAILED");
  assert.match(failureJson.upstreamError.message, /Diagram failed/);
  assert.equal(failureJson.upstreamError.text, undefined);
  assert.equal(failureJson.upstreamError.parsed, undefined);
  assert.equal(failureJson.result, undefined);
  assert.equal(failureJson.text, undefined);

  await assert.rejects(
    mcpClient.callTool({
      name: "figma_repl_call_upstream_tool",
      arguments: {
        title: "Reject local",
        toolName: "figma_repl_eval",
        arguments: {},
      },
    }),
    /Refusing to proxy local figma_repl_mcp tool/,
  );
  assert.deepEqual(calls.map((call) => call[0]), ["connect", "listTools", "callTool", "callTool"]);
  await mcpClient.close();
});

test("figma REPL call_upstream_tool writes full result and upstream sidecar for large or requested output", async () => {
  const tempDir = await mkdtemp(resolve(tmpdir(), "figma-repl-call-upstream-"));
  const originalTaskRoot = process.env.FIGMA_REPL_TASK_ROOT;
  process.env.FIGMA_REPL_TASK_ROOT = tempDir;
  const outputDir = resolve(tempDir, "explicit");
  const explicitOutput = resolve(outputDir, "explicit-call.json");
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
  const repl = createFigmaReplClient({ client: fakeClient });

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
    assert.equal(largeResult.upstream.payload, undefined);
    assert.equal(largeResult.inlineResultLimit.limitBytes, 40);
    assert.equal(largeResult.inlineResultLimit.limitHuman, "40 bytes");
    assert.deepEqual(largeResult.inlineResultLimit.omitted.map((item) => item.field), ["upstream.payload"]);
    assert.match(largeResult.outputFiles.outputFile.path, /upstream-results.*upstream-main.*upstream-generate_diagram.*\.result\.json$/u);
    assert.match(largeResult.outputFiles.upstreamFile.path, /\.upstream\.json$/u);
    const largeResultFile = await readPrettyJsonPointer(largeResult.outputFiles.outputFile, largeResult.outputFiles.outputFile.path);
    assert.equal(largeResultFile.outputFiles, undefined);
    assert.equal(largeResultFile.upstream.payload.result.summary, "large upstream");
    assert.equal(largeResultFile.upstream.payload.result.blob.length, 200);
    const largeUpstreamFile = await readPrettyJsonPointer(largeResult.outputFiles.upstreamFile, largeResult.outputFiles.upstreamFile.path);
    assert.deepEqual(largeUpstreamFile, largeResultFile.upstream);

    const explicitResult = await repl.callUpstreamTool({
      toolName: "generate_diagram",
      arguments: { prompt: "Explicit" },
      outputFile: explicitOutput,
    });
    assert.equal(explicitResult.ok, true);
    assert.equal(explicitResult.inlineResultLimit, undefined);
    assert.equal(explicitResult.upstream.payload.result.summary, "explicit upstream");
    assertFilePointer(explicitResult.outputFiles.outputFile, explicitOutput);
    assertFilePointer(explicitResult.outputFiles.upstreamFile, resolve(outputDir, "explicit-call.upstream.json"));
    const explicitResultFile = await readPrettyJsonPointer(explicitResult.outputFiles.outputFile, explicitOutput);
    assert.equal(explicitResultFile.outputFiles, undefined);
    assert.equal(explicitResultFile.upstream.payload.result.summary, "explicit upstream");
    const explicitUpstreamFile = await readPrettyJsonPointer(explicitResult.outputFiles.upstreamFile, resolve(outputDir, "explicit-call.upstream.json"));
    assert.deepEqual(explicitUpstreamFile, explicitResultFile.upstream);
  } finally {
    await repl.close();
    if (originalTaskRoot === undefined) {
      delete process.env.FIGMA_REPL_TASK_ROOT;
    } else {
      process.env.FIGMA_REPL_TASK_ROOT = originalTaskRoot;
    }
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("figma REPL runtime parsers reject malformed tool argument shapes", async () => {
  const programmaticCalls = [];
  const repl = createFigmaReplClient({
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
  const { server } = createFigmaReplMcpServer({
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
    name: "figma_repl_open",
    arguments: {
      sessionId: "no-title-open",
      connect: false,
    },
  });
  assert.equal(structuredToolResult(noTitleOpenResult).ok, true);
  await assert.rejects(
    mcpClient.callTool({
      name: "figma_repl_guidance",
      arguments: {
        title: 123,
      },
    }),
    /Tool argument "title" must be a string\./,
  );
  await assert.rejects(
    mcpClient.callTool({
      name: "figma_repl_eval",
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
      name: "figma_repl_eval",
      arguments: {
        title: "Reject code shape",
        code: 123,
      },
    }),
    /Tool argument "code" must be a string\./,
  );
  await assert.rejects(
    mcpClient.callTool({
      name: "figma_repl_eval",
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
      name: "figma_repl_open",
      arguments: {
        title: "Reject open upstream tool override",
        upstreamTool: "fake_eval",
      },
    }),
    /Tool argument "upstreamTool" was removed\. Use "fixed use_figma execution"\./,
  );
  await assert.rejects(
    mcpClient.callTool({
      name: "figma_repl_run_script_file",
      arguments: {
        title: "Reject script upstream argument override",
        upstreamArgument: "script",
      },
    }),
    /Tool argument "upstreamArgument" was removed\. Use "fixed use_figma execution"\./,
  );
  await assert.rejects(
    mcpClient.callTool({
      name: "figma_repl_inspect",
      arguments: {
        title: "Reject inspect upstream arguments override",
        upstreamArguments: {},
      },
    }),
    /Tool argument "upstreamArguments" was removed\. Use "fixed use_figma execution"\./,
  );
  await assert.rejects(
    mcpClient.callTool({
      name: "figma_repl_call_upstream_tool",
      arguments: {
        title: "Reject upstream toolName",
        toolName: 123,
      },
    }),
    /Tool argument "toolName" must be a string\./,
  );
  await assert.rejects(
    mcpClient.callTool({
      name: "figma_repl_call_upstream_tool",
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
      name: "figma_repl_lookup",
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
      name: "figma_repl_guidance",
      arguments: {
        title: "Reject blank task",
        task: "   ",
      },
    }),
    /Tool argument "task" must not be empty\./,
  );
  await assert.rejects(
    mcpClient.callTool({
      name: "figma_repl_guidance",
      arguments: {
        title: "Reject long guidance query",
        query: "component properties ".repeat(8),
      },
    }),
    /Tool argument "card or query" must be 120 characters or fewer\./,
  );
  await assert.rejects(
    mcpClient.callTool({
      name: "figma_repl_lookup",
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
      name: "figma_repl_lookup",
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
      name: "figma_repl_lookup",
      arguments: {
        title: "Reject lookup kind",
        kind: "bad",
      },
    }),
    /Tool argument "kind" must be one of: docs, api\./,
  );
  await assert.rejects(
    mcpClient.callTool({
      name: "figma_repl_run_script_file",
      arguments: {
        title: "Reject input file shape",
        inputFile: 123,
      },
    }),
    /Tool argument "inputFile" must be a string\./,
  );
  await assert.rejects(
    mcpClient.callTool({
      name: "figma_repl_run_script_file",
      arguments: {
        title: "Reject run resultFile alias",
        resultFile: "result.json",
      },
    }),
    /Tool argument "resultFile" was removed\. Use "outputFile"\./,
  );
  await assert.rejects(
    mcpClient.callTool({
      name: "figma_repl_open",
      arguments: {
        title: "Reject open expectedSurface alias",
        expectedSurface: "design",
      },
    }),
    /Tool argument "expectedSurface" was removed\. Use "surface"\./,
  );
  await assert.rejects(
    mcpClient.callTool({
      name: "figma_repl_apply_asset_manifest",
      arguments: {
        title: "Reject assets",
        assets: {},
      },
    }),
    /Tool argument "assets" must be an array\./,
  );
  await assert.rejects(
    mcpClient.callTool({
      name: "figma_repl_apply_asset_manifest",
      arguments: {
        title: "Reject manifest path shape",
        manifestPath: 123,
      },
    }),
    /Tool argument "manifestPath" must be a string\./,
  );
  await assert.rejects(
    mcpClient.callTool({
      name: "figma_repl_apply_asset_manifest",
      arguments: {
        title: "Reject manifest argumentsTemplate alias",
        argumentsTemplate: {},
      },
    }),
    /Tool argument "argumentsTemplate" was removed\. Use "figma_repl_call_upstream_tool"\./,
  );
  await assert.rejects(
    mcpClient.callTool({
      name: "figma_repl_apply_asset_manifest",
      arguments: {
        title: "Reject manifest escape",
        toolName: "fake_upload",
      },
    }),
    /Tool argument "toolName" was removed\. Use "figma_repl_call_upstream_tool"\./,
  );
  await assert.rejects(
    mcpClient.callTool({
      name: "figma_repl_apply_asset_manifest",
      arguments: {
        title: "Reject manifest asset escape",
        assets: [{ path: "asset.png", target: "12:34", toolName: "fake_upload" }],
      },
    }),
    /Tool argument "assets\[0\]\.toolName\/arguments" was removed\. Use "figma_repl_call_upstream_tool"\./,
  );
  await assert.rejects(
    mcpClient.callTool({
      name: "figma_repl_run_task_plan",
      arguments: {
        title: "Reject steps",
        steps: {},
      },
    }),
    /Tool argument "steps" must be an array\./,
  );
  await assert.rejects(
    mcpClient.callTool({
      name: "figma_repl_run_task_plan",
      arguments: {
        title: "Reject step top-level args",
        steps: [{ type: "screenshot-capture", target: "12:34" }],
      },
    }),
    /Tool argument "steps\[0\]\.target" is not supported\. Put step tool inputs under "args"\./,
  );
  await assert.rejects(
    mcpClient.callTool({
      name: "figma_repl_run_task_plan",
      arguments: {
        title: "Reject step arguments alias",
        steps: [{ type: "upstream-tool", arguments: { toolName: "fake" } }],
      },
    }),
    /Tool argument "steps\[0\]\.arguments" was removed\. Use "args"\./,
  );
  const badPlanDir = await mkdtemp(resolve(tmpdir(), "figma-repl-bad-plan-"));
  const badPlanPath = resolve(badPlanDir, "bad-plan.json");
  await writeFile(
    badPlanPath,
    JSON.stringify([{ type: "screenshot-capture", target: "12:34" }]),
    "utf8",
  );
  await assert.rejects(
    mcpClient.callTool({
      name: "figma_repl_run_task_plan",
      arguments: {
        title: "Reject plan file step top-level args",
        planPath: badPlanPath,
        outputFile: resolve(badPlanDir, "bad-plan.result.json"),
      },
    }),
    /Tool argument "plan\[0\]\.target" is not supported\. Put step tool inputs under "args"\./,
  );
  await rm(badPlanDir, { recursive: true, force: true });
  await assert.rejects(
    mcpClient.callTool({
      name: "figma_repl_apply_asset_manifest",
      arguments: {
        title: "Reject asset aliases",
        assets: [{ filePath: "asset.png", target: "12:34" }],
      },
    }),
    /Tool argument "assets\[0\]\.filePath\/localPath" was removed\. Use "path"\./,
  );
  await assert.rejects(
    mcpClient.callTool({
      name: "figma_repl_download_assets",
      arguments: {
        title: "Reject download target alias",
        target: "12:34",
      },
    }),
    /Tool argument "target" was removed\. Use "targets"\./,
  );
  await assert.rejects(
    mcpClient.callTool({
      name: "figma_repl_download_assets",
      arguments: {
        title: "Reject download assets alias",
        assets: [{ target: "12:34" }],
      },
    }),
    /Tool argument "assets" was removed\. Use "targets"\./,
  );
  await assert.rejects(
    mcpClient.callTool({
      name: "figma_repl_download_assets",
      arguments: {
        title: "Reject download escape",
        toolName: "download_assets",
      },
    }),
    /Tool argument "toolName" was removed\. Use "figma_repl_call_upstream_tool"\./,
  );
  await assert.rejects(
    mcpClient.callTool({
      name: "figma_repl_download_assets",
      arguments: {
        title: "Reject download target item alias",
        targets: [{ nodeId: "12:34" }],
      },
    }),
    /Tool argument "targets\[0\]\.nodeId\/targetNodeId\/targetHandle\/targetId" was removed\. Use "target"\./,
  );
  await assert.rejects(
    mcpClient.callTool({
      name: "figma_repl_capture_node",
      arguments: {
        title: "Reject capture alias",
        nodeId: "12:34",
      },
    }),
    /Tool argument "nodeId" was removed\. Use "target"\./,
  );
  await assert.rejects(
    mcpClient.callTool({
      name: "figma_repl_capture_node",
      arguments: {
        title: "Reject capture resultFile alias",
        resultFile: "capture.json",
      },
    }),
    /Tool argument "resultFile" was removed\. Use "metadataFile"\./,
  );
  await assert.rejects(
    mcpClient.callTool({
      name: "figma_repl_capture_node",
      arguments: {
        title: "Reject capture escape",
        toolName: "fake_screenshot",
      },
    }),
    /Tool argument "toolName" was removed\. Use "figma_repl_call_upstream_tool"\./,
  );
  const badManifestDir = await mkdtemp(resolve(tmpdir(), "figma-repl-bad-assets-"));
  try {
    const badManifestTop = resolve(badManifestDir, "bad-top.json");
    await writeFile(
      badManifestTop,
      JSON.stringify({ toolName: "fake_upload", assets: [{ path: "asset.png", target: "12:34" }] }),
      "utf8",
    );
    await assert.rejects(
      mcpClient.callTool({
        name: "figma_repl_apply_asset_manifest",
        arguments: {
          title: "Reject manifest file escape",
          manifestPath: badManifestTop,
        },
      }),
      /Asset manifest fields "toolName\/arguments\/refresh" were removed\. Use "figma_repl_call_upstream_tool"\./,
    );
    const badManifestAsset = resolve(badManifestDir, "bad-asset.json");
    await writeFile(
      badManifestAsset,
      JSON.stringify({ assets: [{ path: "asset.png", target: "12:34", arguments: { file: "{{path}}" } }] }),
      "utf8",
    );
    await assert.rejects(
      mcpClient.callTool({
        name: "figma_repl_apply_asset_manifest",
        arguments: {
          title: "Reject manifest asset file escape",
          manifestPath: badManifestAsset,
        },
      }),
      /Asset manifest entry 0 fields "toolName\/arguments\/refresh" were removed\. Use "figma_repl_call_upstream_tool"\./,
    );
  } finally {
    await rm(badManifestDir, { recursive: true, force: true });
  }
  await assert.rejects(
    mcpClient.callTool({
      name: "figma_repl_guidance",
      arguments: {
        title: "Reject guidance intent alias",
        intent: "make a card",
      },
    }),
    /Tool argument "intent" was removed\. Use "task"\./,
  );
  await assert.rejects(
    mcpClient.callTool({
      name: "figma_repl_prepare_task",
      arguments: {
        title: "Reject prepare taskDir alias",
        taskDir: "/tmp/task",
      },
    }),
    /Tool argument "taskDir" was removed\. Use "workspaceDir"\./,
  );
  await assert.rejects(
    mcpClient.callTool({
      name: "figma_repl_prepare_task",
      arguments: {
        title: "Reject prepare scriptName alias",
        scriptName: "task.figma.js",
      },
    }),
    /Tool argument "scriptName" was removed\. Use "fileName"\./,
  );
  await assert.rejects(
    mcpClient.callTool({
      name: "figma_repl_inspect",
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

test("figma REPL applies asset manifests through official upload_assets", async () => {
  const tempDir = await mkdtemp(resolve(tmpdir(), "figma-repl-assets-"));
  const assetPath = resolve(tempDir, "hero.png");
  const resultFile = resolve(tempDir, "asset-result.json");
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
  const { server } = createFigmaReplMcpServer({ client: fakeClient });
  const mcpClient = new Client(
    { name: "test-client", version: "0.1.0" },
    { capabilities: {} },
  );
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

  try {
    await server.connect(serverTransport);
    await mcpClient.connect(clientTransport);
    await mcpClient.callTool({
      name: "figma_repl_open",
      arguments: {
        title: "Open asset file context",
        sessionId: "asset-output",
        connect: false,
        file: "https://www.figma.com/design/file123/Test",
      },
    });

    const result = await mcpClient.callTool({
      name: "figma_repl_apply_asset_manifest",
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
        outputFile: resultFile,
      },
    });
    const json = structuredToolResult(result);
    assert.equal(json.ok, true);
    assert.equal(json.assets.length, 1);
    assert.equal(json.assets[0].toolName, "upload_assets");
    assert.equal(json.assets[0].upstreamSummary, "asset filled");
    assert.equal(json.assets[0].result, undefined);
    assert.equal(json.assets[0].arguments, undefined);
    assert.equal(json.assets[0].upstream, undefined);
    assert.equal(json.failures, undefined);
    assertFilePointer(json.outputFiles.outputFile, resultFile);
    const fileJson = await readPrettyJsonPointer(json.outputFiles.outputFile, resultFile);
    assert.equal(fileJson.outputFiles, undefined);
    assert.equal(fileJson.assets[0].result, undefined);
    assert.equal(fileJson.assetDetails[0].upstream.kind, "json");
    assert.equal(fileJson.assetDetails[0].upstream.ok, true);
    assert.equal(fileJson.assetDetails[0].upstream.payload.result.summary, "asset filled");
    assert.equal(fileJson.assetDetails[0].upstream.payload.result.payload.length, 2_000);
    assert.deepEqual(fileJson.assetDetails[0].arguments, {
      fileKey: "file123",
      count: 1,
      nodeId: "12:34",
      scaleMode: "FILL",
    });
    assert.equal(JSON.stringify(fileJson).includes("x".repeat(200)), true);
    assert.deepEqual(calls.map((call) => call[0]), ["connect", "listTools", "callTool"]);
    await mcpClient.close();
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("figma REPL validates asset manifest targets when upstream eval is available", async () => {
  const tempDir = await mkdtemp(resolve(tmpdir(), "figma-repl-assets-validate-"));
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
  const { server } = createFigmaReplMcpServer({ client: fakeClient });
  const mcpClient = new Client(
    { name: "test-client", version: "0.1.0" },
    { capabilities: {} },
  );
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

  try {
    await server.connect(serverTransport);
    await mcpClient.connect(clientTransport);
    await mcpClient.callTool({
      name: "figma_repl_open",
      arguments: {
        title: "Open validate file context",
        sessionId: "asset-validate",
        connect: false,
        file: "https://www.figma.com/design/file123/Test",
      },
    });

    const result = await mcpClient.callTool({
      name: "figma_repl_apply_asset_manifest",
      arguments: {
        title: "Apply and validate assets",
        sessionId: "asset-validate",
        assets: [{ path: assetPath, target: "12:34" }],
      },
    });
    const json = structuredToolResult(result);
    assert.equal(json.ok, true);
    assert.equal(json.validation.ok, true);
    assert.equal(json.validation.validCount, 1);
    assert.equal(json.assets[0].validation.status, "valid");
    assert.deepEqual(calls.map((call) => call[0]), ["connect", "listTools", "callTool", "callTool"]);
    assert.deepEqual(calls.filter((call) => call[0] === "callTool").map((call) => call[1]), ["upload_assets", "use_figma"]);
    await mcpClient.close();
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("figma REPL submits local bytes when upload_assets returns a submit URL", async () => {
  const tempDir = await mkdtemp(resolve(tmpdir(), "figma-repl-upload-assets-"));
  const assetPath = resolve(tempDir, "icon.png");
  const resultFile = resolve(tempDir, "upload-assets.result.json");
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
      JSON.stringify({ success: true, imageHash: "abc", placedOnNodeId: "12:34" }),
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
  const { server } = createFigmaReplMcpServer({ client: fakeClient });
  const mcpClient = new Client(
    { name: "test-client", version: "0.1.0" },
    { capabilities: {} },
  );
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

  try {
    await server.connect(serverTransport);
    await mcpClient.connect(clientTransport);
    await mcpClient.callTool({
      name: "figma_repl_open",
      arguments: {
        title: "Open upload file context",
        sessionId: "upload",
        connect: false,
        file: "https://www.figma.com/design/file123/Test",
        handles: { "$iconTarget": "12:34" },
      },
    });
    const result = await mcpClient.callTool({
      name: "figma_repl_apply_asset_manifest",
      arguments: {
        title: "Apply upload asset",
        sessionId: "upload",
        assets: [{ path: assetPath, target: "$iconTarget", name: "Icon" }],
        outputFile: resultFile,
      },
    });
    const json = structuredToolResult(result);
    assert.equal(json.ok, true);
    assert.equal(json.assets[0].upload.ok, true);
    assert.equal(json.assets[0].upload.response, undefined);
    assert.equal(json.assets[0].upload.bytes, "fake png bytes".length);
    const fileJson = await readPrettyJsonPointer(json.outputFiles.outputFile, resultFile);
    assert.equal(fileJson.assetDetails[0].upload.response.placedOnNodeId, "12:34");
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

test("figma REPL uses the stable official upload_assets schema without overrides", async () => {
  const tempDir = await mkdtemp(resolve(tmpdir(), "figma-repl-official-upload-assets-"));
  const assetPath = resolve(tempDir, "hero.png");
  const resultFile = resolve(tempDir, "official-upload-assets.result.json");
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
      JSON.stringify({ success: true, imageHash: "official-hash", placedOnNodeId: "12:34" }),
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
  const { server } = createFigmaReplMcpServer({ client: fakeClient });
  const mcpClient = new Client(
    { name: "test-client", version: "0.1.0" },
    { capabilities: {} },
  );
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

  try {
    await server.connect(serverTransport);
    await mcpClient.connect(clientTransport);
    await mcpClient.callTool({
      name: "figma_repl_open",
      arguments: {
        title: "Open official upload file context",
        sessionId: "official-upload",
        connect: false,
        file: "https://www.figma.com/design/file123/Test",
        handles: { "$heroTarget": "12:34" },
      },
    });
    const result = await mcpClient.callTool({
      name: "figma_repl_apply_asset_manifest",
      arguments: {
        title: "Apply official upload asset",
        sessionId: "official-upload",
        assets: [{ path: assetPath, target: "$heroTarget", name: "Hero" }],
        outputFile: resultFile,
      },
    });
    const json = structuredToolResult(result);
    assert.equal(json.ok, true);
    assert.equal(json.assets[0].toolName, "upload_assets");
    assert.equal(json.assets[0].upload.ok, true);
    const fileJson = await readPrettyJsonPointer(json.outputFiles.outputFile, resultFile);
    assert.equal(fileJson.assetDetails[0].arguments.fileKey, "file123");
    assert.equal(fileJson.assetDetails[0].arguments.nodeId, "12:34");
    assert.equal(fileJson.assetDetails[0].arguments.count, 1);
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

test("figma REPL asset manifest requires official upload_assets", async () => {
  const tempDir = await mkdtemp(resolve(tmpdir(), "figma-repl-missing-upload-assets-"));
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
  const { server } = createFigmaReplMcpServer({ client: fakeClient });
  const mcpClient = new Client(
    { name: "test-client", version: "0.1.0" },
    { capabilities: {} },
  );
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

  try {
    await server.connect(serverTransport);
    await mcpClient.connect(clientTransport);
    await mcpClient.callTool({
      name: "figma_repl_open",
      arguments: {
        title: "Open missing upload file context",
        sessionId: "missing-upload",
        connect: false,
        file: "https://www.figma.com/design/file123/Test",
      },
    });
    await assert.rejects(
      mcpClient.callTool({
        name: "figma_repl_apply_asset_manifest",
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

test("figma REPL asset manifest rejects drifted upload_assets schema", async () => {
  const tempDir = await mkdtemp(resolve(tmpdir(), "figma-repl-drifted-upload-assets-"));
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
  const { server } = createFigmaReplMcpServer({ client: fakeClient });
  const mcpClient = new Client(
    { name: "test-client", version: "0.1.0" },
    { capabilities: {} },
  );
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

  try {
    await server.connect(serverTransport);
    await mcpClient.connect(clientTransport);
    await mcpClient.callTool({
      name: "figma_repl_open",
      arguments: {
        title: "Open drifted upload file context",
        sessionId: "drifted-upload",
        connect: false,
        file: "https://www.figma.com/design/file123/Test",
      },
    });
    await assert.rejects(
      mcpClient.callTool({
        name: "figma_repl_apply_asset_manifest",
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

test("figma REPL downloads official exported and raw asset URLs per target", async () => {
  const tempDir = await mkdtemp(resolve(tmpdir(), "figma-repl-download-assets-"));
  const outputDir = resolve(tempDir, "downloads");
  const outputFile = resolve(tempDir, "downloads.result.json");
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
  const { server } = createFigmaReplMcpServer({ client: fakeClient });
  const mcpClient = new Client(
    { name: "test-client", version: "0.1.0" },
    { capabilities: {} },
  );
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

  try {
    await server.connect(serverTransport);
    await mcpClient.connect(clientTransport);
    await mcpClient.callTool({
      name: "figma_repl_open",
      arguments: {
        title: "Open download file context",
        sessionId: "download",
        connect: false,
        file: "https://www.figma.com/design/file123/Test",
        handles: { "$hero": "22:8" },
      },
    });

    const result = await mcpClient.callTool({
      name: "figma_repl_download_assets",
      arguments: {
        title: "Download hero assets",
        sessionId: "download",
        targets: [{ target: "$hero", name: "Hero", defaultFormat: "png", defaultScale: 2 }],
        outputDir,
        outputFile,
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
    const fileJson = await readPrettyJsonPointer(json.outputFiles.outputFile, outputFile);
    assert.equal(fileJson.targetDetails[0].arguments.fileKey, "file123");
    assert.equal(fileJson.targetDetails[0].arguments.nodeId, "22:8");
    assert.equal(fileJson.targetDetails[0].links.length, 2);
    assert.equal(fileJson.targetDetails[0].downloadedFiles[0].sourceUrl, "https://assets.example/export.png");
    assert.deepEqual(fetches, ["https://assets.example/export.png", "https://assets.example/raw.jpg"]);
    assert.deepEqual(calls.map((call) => call[0]), ["connect", "listTools", "callTool"]);
    await mcpClient.close();
  } finally {
    globalThis.fetch = originalFetch;
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("figma REPL download_assets manifest batches targets and continues after target failures", async () => {
  const tempDir = await mkdtemp(resolve(tmpdir(), "figma-repl-download-manifest-"));
  const manifestPath = resolve(tempDir, "downloads.json");
  const outputDir = resolve(tempDir, "downloads");
  const outputFile = resolve(tempDir, "downloads.result.json");
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
  const { server } = createFigmaReplMcpServer({ client: fakeClient });
  const mcpClient = new Client(
    { name: "test-client", version: "0.1.0" },
    { capabilities: {} },
  );
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

  try {
    await server.connect(serverTransport);
    await mcpClient.connect(clientTransport);
    await mcpClient.callTool({
      name: "figma_repl_open",
      arguments: {
        title: "Open manifest download file context",
        sessionId: "download-manifest",
        connect: false,
        file: "https://www.figma.com/design/file123/Test",
        handles: { "$hero": "22:8" },
      },
    });
    await assert.rejects(
      mcpClient.callTool({
        name: "figma_repl_download_assets",
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
      name: "figma_repl_download_assets",
      arguments: {
        title: "Download manifest assets",
        sessionId: "download-manifest",
        manifestPath,
        outputDir,
        outputFile,
      },
    });
    const json = structuredToolResult(result);
    assert.equal(json.ok, false);
    assert.equal(json.targets.length, 2);
    assert.equal(json.targets[0].ok, true);
    assert.equal(json.targets[1].ok, false);
    assert.equal(json.targets[1].error.code, "NOT_FOUND");
    assert.equal(json.failures.length, 1);
    assert.equal(calls.filter((call) => call[0] === "callTool").length, 2);
    const fileJson = await readPrettyJsonPointer(json.outputFiles.outputFile, outputFile);
    assert.equal(fileJson.targetDetails.length, 2);
    assert.equal(fileJson.targetDetails[1].upstreamError.code, "NOT_FOUND");
    await mcpClient.close();
  } finally {
    globalThis.fetch = originalFetch;
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("figma REPL download_assets rejects drifted official schema fields", async () => {
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
  const { server } = createFigmaReplMcpServer({ client: fakeClient });
  const mcpClient = new Client(
    { name: "test-client", version: "0.1.0" },
    { capabilities: {} },
  );
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

  await server.connect(serverTransport);
  await mcpClient.connect(clientTransport);
  await mcpClient.callTool({
    name: "figma_repl_open",
    arguments: {
      title: "Open drifted download file context",
      sessionId: "drifted-download",
      connect: false,
      file: "https://www.figma.com/design/file123/Test",
    },
  });
  await assert.rejects(
    mcpClient.callTool({
      name: "figma_repl_download_assets",
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

test("figma REPL captures node screenshot responses to a local file", async () => {
  const tempDir = await mkdtemp(resolve(tmpdir(), "figma-repl-capture-"));
  const outputFile = resolve(tempDir, "node");
  const webpOutputFile = resolve(tempDir, "node.webp");
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
  const { server } = createFigmaReplMcpServer({ client: fakeClient });
  const mcpClient = new Client(
    { name: "test-client", version: "0.1.0" },
    { capabilities: {} },
  );
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

  try {
    await server.connect(serverTransport);
    await mcpClient.connect(clientTransport);

    const result = await mcpClient.callTool({
      name: "figma_repl_capture_node",
      arguments: {
        title: "Capture node",
        target: { fileKey: "file123", nodeId: "22:7" },
        outputFile,
      },
    });
    const json = structuredToolResult(result);
    assert.equal(json.ok, true);
    assert.equal(result.content.length, 0);
    assert.equal(json.outputFile, webpOutputFile);
    assert.equal(json.file, undefined);
    assertFilePointer(json.outputFiles.outputFile, webpOutputFile, { lineCount: 0 });
    assert.equal(json.nodeId, "22:7");
    assert.equal(json.toolName, "get_screenshot");
    assert.equal(json.mimeType, "image/webp");
    assert.equal(json.width, 4);
    assert.equal(json.height, 3);
    assert.equal(json.preview, undefined);
    assertWebpBuffer(await readFile(webpOutputFile));
    assert.deepEqual(calls.map((call) => call[0]), ["connect", "listTools", "callTool"]);
    await mcpClient.close();
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("figma REPL uses the stable official get_screenshot schema without overrides", async () => {
  const tempDir = await mkdtemp(resolve(tmpdir(), "figma-repl-official-capture-"));
  const outputFile = resolve(tempDir, "official-capture.webp");
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
  const { server } = createFigmaReplMcpServer({ client: fakeClient });
  const mcpClient = new Client(
    { name: "test-client", version: "0.1.0" },
    { capabilities: {} },
  );
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

  try {
    await server.connect(serverTransport);
    await mcpClient.connect(clientTransport);

    await mcpClient.callTool({
      name: "figma_repl_open",
      arguments: {
        sessionId: "official-capture",
        file: "https://www.figma.com/design/file123/Test",
        connect: false,
      },
    });

    const result = await mcpClient.callTool({
      name: "figma_repl_capture_node",
      arguments: {
        title: "Capture with official get_screenshot",
        sessionId: "official-capture",
        target: "22:7",
        outputFile,
      },
    });
    const json = structuredToolResult(result);
    assert.equal(json.ok, true);
    assert.equal(json.toolName, "get_screenshot");
    assert.equal(json.nodeId, "22:7");
    assert.equal(json.outputFile, outputFile);
    assert.equal(json.mimeType, "image/webp");
    assertFilePointer(json.outputFiles.outputFile, outputFile, { lineCount: 0 });
    assertWebpBuffer(await readFile(outputFile));
    assert.deepEqual(calls.map((call) => call[0]), ["connect", "listTools", "callTool"]);
    await mcpClient.close();
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("figma REPL capture node can return an opt-in WebP MCP preview", async () => {
  const tempDir = await mkdtemp(resolve(tmpdir(), "figma-repl-capture-preview-"));
  const previousTaskRoot = process.env.FIGMA_REPL_TASK_ROOT;
  process.env.FIGMA_REPL_TASK_ROOT = tempDir;
  const pngBytes = await createTestPngBuffer(24, 18);
  const calls = [];
  const fakeClient = createFakeFigmaClient(
    calls,
    ({ name, args }) => {
      assert.equal(name, "get_screenshot");
      assert.deepEqual(args, { fileKey: "file123", nodeId: "22:71" });
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
  const { server } = createFigmaReplMcpServer({ client: fakeClient });
  const mcpClient = new Client(
    { name: "test-client", version: "0.1.0" },
    { capabilities: {} },
  );
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

  try {
    await server.connect(serverTransport);
    await mcpClient.connect(clientTransport);

    const result = await mcpClient.callTool({
      name: "figma_repl_capture_node",
      arguments: {
        title: "Capture node preview",
        sessionId: "capture-preview",
        target: "https://www.figma.com/design/file123/Test?node-id=22-71",
        preview: true,
      },
    });
    const json = structuredToolResult(result);
    assert.equal(json.ok, true);
    assert.match(json.outputFile, /capture-results.*capture-preview.*capture-.*\.webp$/u);
    assertFilePointer(json.outputFiles.outputFile, json.outputFile, { lineCount: 0 });
    assert.equal(json.mimeType, "image/webp");
    assert.equal(json.width, 24);
    assert.equal(json.height, 18);
    assert.equal(json.preview.enabled, true);
    assert.equal(json.preview.kind, "mcp-image");
    assert.equal(json.preview.mimeType, "image/webp");
    assert.equal(json.preview.width, 24);
    assert.equal(json.preview.height, 18);
    assert.equal(json.preview.source, "outputFile");
    assert.equal(result.content.length, 1);
    assert.equal(result.content[0].type, "image");
    assert.equal(result.content[0].mimeType, "image/webp");
    assert.equal(json.preview.data, undefined);
    assertWebpBuffer(Buffer.from(result.content[0].data, "base64"));
    assertWebpBuffer(await readFile(json.outputFile));
    await mcpClient.close();
  } finally {
    if (previousTaskRoot === undefined) {
      delete process.env.FIGMA_REPL_TASK_ROOT;
    } else {
      process.env.FIGMA_REPL_TASK_ROOT = previousTaskRoot;
    }
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("figma REPL capture node saves text output as txt and omits preview image", async () => {
  const tempDir = await mkdtemp(resolve(tmpdir(), "figma-repl-capture-text-"));
  const outputFile = resolve(tempDir, "node.png");
  const textOutputFile = resolve(tempDir, "node.txt");
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
  const { server } = createFigmaReplMcpServer({ client: fakeClient });
  const mcpClient = new Client(
    { name: "test-client", version: "0.1.0" },
    { capabilities: {} },
  );
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

  try {
    await server.connect(serverTransport);
    await mcpClient.connect(clientTransport);

    const result = await mcpClient.callTool({
      name: "figma_repl_capture_node",
      arguments: {
        title: "Capture node text",
        target: { fileKey: "file123", nodeId: "22:72" },
        outputFile,
        preview: true,
      },
    });
    const json = structuredToolResult(result);
    assert.equal(result.content.length, 0);
    assert.equal(json.ok, true);
    assert.equal(json.outputFile, textOutputFile);
    assert.equal(json.kind, "text");
    assert.equal(json.mimeType, "text/plain");
    assert.equal(json.preview.enabled, true);
    assert.equal(json.preview.omittedReason, "not-image");
    assert.equal(await readFile(textOutputFile, "utf8"), "plain capture text");
    await mcpClient.close();
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("figma REPL capture node reports planned output on upstream failure", async () => {
  const tempDir = await mkdtemp(resolve(tmpdir(), "figma-repl-capture-failure-"));
  const outputFile = resolve(tempDir, "node.png");
  const plannedOutputFile = resolve(tempDir, "node.png");
  const metadataFile = resolve(tempDir, "capture.result.json");
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
  const { server } = createFigmaReplMcpServer({ client: fakeClient });
  const mcpClient = new Client(
    { name: "test-client", version: "0.1.0" },
    { capabilities: {} },
  );
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

  try {
    await server.connect(serverTransport);
    await mcpClient.connect(clientTransport);

    const result = await mcpClient.callTool({
      name: "figma_repl_capture_node",
      arguments: {
        title: "Capture node failure",
        target: { fileKey: "file123", nodeId: "22:70" },
        outputFile,
        metadataFile,
      },
    });
    const json = structuredToolResult(result);
    assert.equal(json.ok, false);
    assert.equal(json.outputFile, undefined);
    assert.equal(json.plannedOutputFile, plannedOutputFile);
    assert.equal(json.file, undefined);
    assert.equal(json.upstream.kind, "json");
    assert.equal(json.upstream.ok, false);
    assert.equal(json.upstream.payload, undefined);
    assert.equal(json.upstreamError.code, "CAPTURE_FAILED");
    assert.match(json.upstreamError.message, /Capture failed/);
    assert.equal(json.upstreamError.text, undefined);
    assert.equal(json.upstreamError.parsed, undefined);
    assertFilePointer(json.outputFiles.metadataFile, metadataFile);
    const fileJson = await readPrettyJsonPointer(json.outputFiles.metadataFile, metadataFile);
    assert.equal(fileJson.plannedOutputFile, plannedOutputFile);
    assert.equal(fileJson.outputFile, undefined);
    assert.equal(fileJson.file, undefined);
    assert.equal(fileJson.upstream.kind, "json");
    assert.equal(fileJson.upstream.ok, false);
    assert.equal(fileJson.upstream.payload.error.code, "CAPTURE_FAILED");
    await assert.rejects(
      readFile(plannedOutputFile, "utf8"),
      /ENOENT/,
    );
    assert.deepEqual(calls.map((call) => call[0]), ["connect", "listTools", "callTool"]);
    await mcpClient.close();
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("figma REPL downloads node screenshot URL responses to a local file", async () => {
  const tempDir = await mkdtemp(resolve(tmpdir(), "figma-repl-capture-url-"));
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
  const { server } = createFigmaReplMcpServer({ client: fakeClient });
  const mcpClient = new Client(
    { name: "test-client", version: "0.1.0" },
    { capabilities: {} },
  );
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

  try {
    await server.connect(serverTransport);
    await mcpClient.connect(clientTransport);

    const result = await mcpClient.callTool({
      name: "figma_repl_capture_node",
      arguments: {
        title: "Capture node",
        target: { fileKey: "file123", nodeId: "22:8" },
        outputFile,
      },
    });
    const json = structuredToolResult(result);
    assert.equal(json.ok, true);
    assert.equal(json.outputFile, outputFile);
    assert.equal(json.file, undefined);
    assertFilePointer(json.outputFiles.outputFile, outputFile, { lineCount: 0 });
    assert.equal(json.nodeId, "22:8");
    assert.equal(json.kind, "image");
    assert.equal(json.mimeType, "image/png");
    assert.equal(json.width, 5);
    assert.equal(json.height, 4);
    assert.equal(json.sourceUrl, "https://example.test/capture.png");
    assertPngBuffer(await readFile(outputFile));
    assert.equal(json.qa.ok, false);
    assert.ok(json.qa.warnings.includes("image dimensions are very small"));
    assert.deepEqual(fetches, ["https://example.test/capture.png"]);
    assert.deepEqual(calls.map((call) => call[0]), ["connect", "listTools", "callTool"]);
    await mcpClient.close();
  } finally {
    globalThis.fetch = originalFetch;
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("figma REPL capture node requires official get_screenshot", async () => {
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
  const { server } = createFigmaReplMcpServer({ client: fakeClient });
  const mcpClient = new Client(
    { name: "test-client", version: "0.1.0" },
    { capabilities: {} },
  );
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

  await server.connect(serverTransport);
  await mcpClient.connect(clientTransport);
  await assert.rejects(
    mcpClient.callTool({
      name: "figma_repl_capture_node",
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

test("figma REPL capture node rejects drifted get_screenshot schema", async () => {
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
  const { server } = createFigmaReplMcpServer({ client: fakeClient });
  const mcpClient = new Client(
    { name: "test-client", version: "0.1.0" },
    { capabilities: {} },
  );
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

  await server.connect(serverTransport);
  await mcpClient.connect(clientTransport);
  await assert.rejects(
    mcpClient.callTool({
      name: "figma_repl_capture_node",
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

test("figma REPL task plans run steps in order and stop on failure by default", async () => {
  const tempDir = await mkdtemp(resolve(tmpdir(), "figma-repl-plan-"));
  const scriptPath = resolve(tempDir, "script.figma.js");
  const resultFile = resolve(tempDir, "plan-result.json");
  await writeFile(scriptPath, "return { summary: 'dry run only' };", "utf8");
  const calls = [];
  const fakeClient = createFakeFigmaClient(
    calls,
    ({ name, args }) => {
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
        { name: "fake_upstream_ok", inputSchema: { type: "object", properties: {} } },
        { name: "fake_upstream_fail", inputSchema: { type: "object", properties: {} } },
        { name: "fake_after_stop", inputSchema: { type: "object", properties: {} } },
      ],
    },
  );
  const { server } = createFigmaReplMcpServer({ client: fakeClient });
  const mcpClient = new Client(
    { name: "test-client", version: "0.1.0" },
    { capabilities: {} },
  );
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

  try {
    await server.connect(serverTransport);
    await mcpClient.connect(clientTransport);

    const result = await mcpClient.callTool({
      name: "figma_repl_run_task_plan",
      arguments: {
        title: "Run plan",
        outputFile: resultFile,
        steps: [
          {
            id: "dry-run",
            type: "figma_repl_run_script_file",
            args: {
              scriptPath,
              dryRun: true,
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
            type: "figma_repl_call_upstream_tool",
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
    assert.deepEqual(json.steps.map((step) => step.id), ["dry-run", "upstream-ok", "upstream-fail"]);
    assert.deepEqual(json.steps.map((step) => step.status), ["completed", "completed", "failed"]);
    assert.equal(json.failures.length, 1);
    const fileJson = JSON.parse(await readFile(resultFile, "utf8"));
    assert.deepEqual(fileJson.steps.map((step) => step.id), ["dry-run", "upstream-ok", "upstream-fail"]);
    assert.deepEqual(
      calls.filter((call) => call[0] === "callTool").map((call) => call[1]),
      ["fake_upstream_ok", "fake_upstream_fail"],
    );
    await mcpClient.close();
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("figma REPL task plans route download_assets aliases with workspace defaults", async () => {
  const tempDir = await mkdtemp(resolve(tmpdir(), "figma-repl-plan-download-"));
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(Buffer.from("downloaded"), { status: 200, headers: { "Content-Type": "image/png" } });
  const calls = [];
  const fakeClient = createFakeFigmaClient(
    calls,
    ({ name, args }) => {
      if (name === "fake_upstream_check") {
        assert.deepEqual(args, {
          dir: resolve(tempDir, "download-step.downloads"),
          resultFile: resolve(tempDir, "download-step.downloads.result.json"),
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
  const { server } = createFigmaReplMcpServer({ client: fakeClient });
  const mcpClient = new Client(
    { name: "test-client", version: "0.1.0" },
    { capabilities: {} },
  );
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

  try {
    await server.connect(serverTransport);
    await mcpClient.connect(clientTransport);
    const prepared = await mcpClient.callTool({
      name: "figma_repl_prepare_task",
      arguments: {
        title: "Prepare download plan",
        sessionId: "download-plan",
        workspaceDir: tempDir,
        file: "https://www.figma.com/design/file123/Test",
        task: "Download Assets",
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
                resultFile: "{{steps.download-step.outputFiles.outputFile.path}}",
              },
            },
          },
        ],
      }),
      "utf8",
    );

    const result = await mcpClient.callTool({
      name: "figma_repl_run_task_plan",
      arguments: {
        title: "Run download plan",
        sessionId: "download-plan",
        planPath,
        outputFile: planOutputFile,
      },
    });
    const json = structuredToolResult(result);
    assert.equal(json.ok, true);
    assert.equal(json.steps[0].type, "download-assets");
    assert.equal(json.steps[1].type, "upstream-tool");
    assert.equal(json.steps[0].summary.files.outputFile.path, resolve(tempDir, "download-step.downloads.result.json"));
    assert.equal(json.outputReferences["download-step"].outputFile.path, resolve(tempDir, "download-step.downloads.result.json"));
    const stepResult = JSON.parse(await readFile(resolve(tempDir, "download-step.downloads.result.json"), "utf8"));
    assert.equal(stepResult.outputDir, resolve(tempDir, "download-step.downloads"));
    assert.equal(stepResult.targets[0].downloadedFiles[0].path, resolve(tempDir, "download-step.downloads", "hero", "exported.png"));
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

test("figma REPL task plans resolve workspace-relative step files consistently", async () => {
  const tempDir = await mkdtemp(resolve(tmpdir(), "figma-repl-plan-workspace-"));
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
        assert.match(args.assetResult, /asset\.assets\.result\.json$/u);
        assert.match(args.captureOutput, /capture\.webp$/u);
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
  const { server } = createFigmaReplMcpServer({ client: fakeClient });
  const mcpClient = new Client(
    { name: "test-client", version: "0.1.0" },
    { capabilities: {} },
  );
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

  try {
    await server.connect(serverTransport);
    await mcpClient.connect(clientTransport);

    const initResult = await mcpClient.callTool({
      name: "figma_repl_prepare_task",
      arguments: {
        title: "Initialize workspace",
        sessionId: "workspace-plan",
        cwd: tempDir,
        file: "file123",
        task: "Workspace Plan",
        surface: "design",
        overwrite: true,
      },
    });
    const initJson = structuredToolResult(initResult);
    const fileDir = initJson.task.workspace.fileDir;
    await writeFile(resolve(fileDir, "workspace-plan.figma.js"), "return { summary: 'dry run' };", "utf8");
    await writeFile(resolve(fileDir, "asset.png"), "asset bytes", "utf8");

    const result = await mcpClient.callTool({
      name: "figma_repl_run_task_plan",
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
              assets: [{ path: "asset.png", target: "{{steps.script.upstream.payload.result.assetTargets.central}}" }],
            },
          },
          {
            id: "capture",
            type: "screenshot-capture",
            args: {
              target: "{{steps.script.upstream.payload.result.captureTarget}}",
            },
          },
          {
            id: "reference",
            type: "upstream-tool",
            args: {
              toolName: "fake_reference",
              arguments: {
                assetResult: "{{outputs.asset.outputFile.path}}",
                captureOutput: "{{steps.capture.outputFiles.outputFile.path}}",
              },
            },
          },
        ],
      },
    });
    const json = structuredToolResult(result);
    assert.equal(json.ok, true);
    assertFilePointer(json.outputFiles.outputFile, resolve(fileDir, "run-workspace-plan.plan.result.json"));
    const planFile = await readPrettyJsonPointer(json.outputFiles.outputFile, resolve(fileDir, "run-workspace-plan.plan.result.json"));
    assert.equal(planFile.outputFiles, undefined);
    assert.deepEqual(json.steps.map((step) => step.status), ["completed", "completed", "completed", "completed"]);
    assert.match(json.outputReferences.asset.outputFile.path, /asset\.assets\.result\.json$/u);
    assert.match(json.outputReferences.capture.outputFile.path, /capture\.webp$/u);
    assert.equal(JSON.parse(await readFile(resolve(fileDir, "script.result.json"), "utf8")).upstream.payload.result.assetTargets.central, "11:22");
    assert.equal(JSON.parse(await readFile(resolve(fileDir, "asset.assets.result.json"), "utf8")).ok, true);
    const captureFile = JSON.parse(await readFile(resolve(fileDir, "capture.capture.result.json"), "utf8"));
    assert.equal(captureFile.outputFile, resolve(fileDir, "capture.webp"));
    assert.equal(captureFile.file, undefined);
    assert.equal(captureFile.outputFiles, undefined);
    assertWebpBuffer(await readFile(resolve(fileDir, "capture.webp")));
    await mcpClient.close();
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("figma REPL lookup kind=docs returns capped local reference snippets", async () => {
  const calls = [];
  const { server } = createFigmaReplMcpServer({
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
    name: "figma_repl_lookup",
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
  assert.equal(json.kind, "docs");
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
  assert.deepEqual(calls.map((call) => call[0]), []);
  await mcpClient.close();
});

test("figma REPL lookup kind=api returns BM25-ranked Plugin API chunks without dumping d.ts", async () => {
  const calls = [];
  const { server } = createFigmaReplMcpServer({
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
    name: "figma_repl_lookup",
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
  assert.equal(json.kind, "api");
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

test("figma REPL diagnostics return stable codes and strict promotes warnings", async () => {
  assert.deepEqual(
    diagnoseFigmaReplCode(
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
    diagnoseFigmaReplCode("const = ;").map((item) => item.code),
    ["FIGMA_REPL_PARSE_ERROR"],
  );
  assert.deepEqual(
    diagnoseFigmaReplCode("figma.currentPage = page;").map((item) => item.code),
    ["FIGMA_REPL_CURRENT_PAGE_ASSIGNMENT"],
  );
  assert.deepEqual(
    diagnoseFigmaReplCode("figma.root.findAll(() => true);").map((item) => item.code),
    ["FIGMA_REPL_ROOT_FIND_ALL"],
  );
  assert.deepEqual(
    diagnoseFigmaReplCode("node.characters = 'Hello';").map((item) => item.code),
    ["FIGMA_REPL_TEXT_MUTATION_NEEDS_FONT"],
  );
  assert.deepEqual(
    diagnoseFigmaReplCode("figma.currentPage.selection = [node];").map((item) => item.code),
    ["FIGMA_REPL_DIRECT_SELECTION_ACCESS"],
  );
  assert.match(
    diagnoseFigmaReplCode("node.remove();")[0].suggestion,
    /\$\.cloneNodeTree/,
  );
  assert.match(
    diagnoseFigmaReplCode("figma.createImage(bytes);")[0].suggestion,
    /\$\.imageAsset/,
  );
  assert.deepEqual(
    diagnoseFigmaReplCode("eval('1'); fetch('/'); import('x'); delete figma.currentPage; node.detachInstance();").map((item) => item.code),
    [
      "FIGMA_REPL_DYNAMIC_EVAL",
      "FIGMA_REPL_NETWORK_ACCESS",
      "FIGMA_REPL_DYNAMIC_IMPORT",
      "FIGMA_REPL_FIGMA_DELETE",
      "FIGMA_REPL_DESTRUCTIVE_OPERATION",
    ],
  );
  assert.deepEqual(
    diagnoseFigmaReplCode("figma.createSticky();", { expectedSurface: "design" }).map((item) => item.code),
    ["FIGMA_REPL_SURFACE_FIGJAM_API_IN_DESIGN"],
  );
  assert.deepEqual(
    diagnoseFigmaReplCode("await $.imageAsset({ base64: 'AQIDBA==' });").map((item) => item.code),
    [],
  );
  assert.deepEqual(
    diagnoseFigmaReplCode(`await $.imageAsset({ base64: '${"A".repeat(100_000)}' });`, { strict: true }).map((item) => item.code),
    ["FIGMA_REPL_IMAGE_ASSET_INLINE_TOO_LARGE"],
  );
  assert.deepEqual(
    diagnoseFigmaReplCode(`await $.imageAsset({ base64: '${"A".repeat(100_000)}' });`, { strict: true }).map((item) => item.severity),
    ["fatal"],
  );
  assert.deepEqual(
    diagnoseFigmaReplCode(`await $.imageAsset({ ["base64"]: \`${"A".repeat(100_000)}\` });`).map((item) => item.code),
    ["FIGMA_REPL_IMAGE_ASSET_INLINE_TOO_LARGE"],
  );
  assert.deepEqual(
    diagnoseFigmaReplCode("await $.checkpoint('$root', { depth: 1 });", { strict: true }).map((item) => item.code),
    ["FIGMA_REPL_CHECKPOINT_HANDLE_AS_NAME"],
  );
  assert.deepEqual(
    diagnoseFigmaReplCode("node.characters = 'Hello';", { strict: true }).map((item) => item.severity),
    ["fatal"],
  );
  assert.deepEqual(
    diagnoseFigmaReplCode("node.remove();", { allowDangerousOperations: true }).map((item) => item.code),
    [],
  );
  assert.deepEqual(
    diagnoseFigmaReplCode(
      "eval('1'); fetch('/'); import('x'); node.remove(); node.detachInstance();",
      { allowDangerousOperations: true },
    ).map((item) => item.code),
    [],
  );
  assert.deepEqual(
    diagnoseFigmaReplCode(
      `eval('1'); fetch('/'); import('x'); node.remove(); node.detachInstance(); figma.createImage(bytes); await $.imageAsset({ base64: '${"A".repeat(100_000)}' });`,
      { allowDangerousOperations: true },
    ).map((item) => item.code),
    ["FIGMA_REPL_IMAGE_CREATION", "FIGMA_REPL_IMAGE_ASSET_INLINE_TOO_LARGE"],
  );
  assert.deepEqual(
    diagnoseFigmaReplCode("node.remove(); node.detachInstance(); figma.currentPage.selection;", { generatedCode: true }).map((item) => item.code),
    ["FIGMA_REPL_DESTRUCTIVE_OPERATION"],
  );
  assert.deepEqual(
    diagnoseFigmaReplCode(
      "return figma.currentPage.findAll(() => true).filter((node) => node.name === 'Primary' && node.layoutMode === 'VERTICAL').map((node) => ({ id: node.id, name: node.name, layoutMode: node.layoutMode, fills: node.fills }));",
      { mode: "read" },
    ).map((item) => item.code),
    [],
  );
  assert.deepEqual(
    diagnoseFigmaReplCode("node.name = 'Primary';", { mode: "read" }).map((item) => item.code),
    ["FIGMA_REPL_READ_MODE_ASSIGNMENT"],
  );
  assert.deepEqual(
    diagnoseFigmaReplCode("node.paddingLeft += 8;", { mode: "read" }).map((item) => item.code),
    ["FIGMA_REPL_READ_MODE_ASSIGNMENT"],
  );
  assert.deepEqual(
    diagnoseFigmaReplCode("node['paddingLeft']++;", { mode: "read" }).map((item) => item.code),
    ["FIGMA_REPL_READ_MODE_ASSIGNMENT"],
  );
});

test("figma REPL run_script_file dryRun returns file-aware diagnostics without compiled script output", async () => {
  const tempDir = await mkdtemp(resolve(tmpdir(), "figma-repl-script-"));
  const scriptPath = resolve(tempDir, "script.js");
  const outputDir = resolve(tempDir, "outputs");
  await writeFile(
    scriptPath,
    [
      "const title = await $.text({ parent: '$currentPage', as: '$title', text: 'Draft' });",
      "title.characters = 'Published';",
      "return await $.checkpoint('text-updated', ['$title']);",
    ].join("\n"),
    "utf8",
  );
  const calls = [];
  const { server } = createFigmaReplMcpServer({
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
      name: "figma_repl_run_script_file",
      arguments: {
        title: "Preview script",
        sessionId: "main",
        scriptPath,
        dryRun: true,
        surface: "design",
        outputDir,
        diagnosticsFile: "diagnostics.json",
        summaryFile: "summary.md",
        inlineResultLimit: 1_000_000,
      },
    });
    const json = structuredToolResult(result);
    assert.equal(json.ok, true);
    assert.equal(json.dryRun, true);
    assert.equal(json.script.scriptPath, scriptPath);
    assert.equal(json.script.sourceLineCount, undefined);
    assert.equal(json.script.sourceBytes, undefined);
    assert.equal(json.script.helperApiVersion, undefined);
    assert.equal(json.script.diagnosticsCount, undefined);
    assert.equal(json.script.dryRun, undefined);
    assert.equal(json.script.executed, undefined);
    assert.equal(json.compiledScript, undefined);
    assert.equal(json.diagnostics[0].code, "FIGMA_REPL_TEXT_MUTATION_NEEDS_FONT");
    assert.equal(json.diagnostics[0].source.scriptPath, scriptPath);
    assert.equal(json.diagnostics[0].source.line, 2);
    assert.equal(json.diagnostics[0].source.column, 1);
    const resultFile = await readPrettyJsonPointer(json.outputFiles.outputFile, resolve(outputDir, "result.json"));
    const diagnosticsFile = await readPrettyJsonPointer(json.outputFiles.diagnosticsFile, resolve(outputDir, "diagnostics.json"));
    const summaryFile = await readTextPointer(json.outputFiles.summaryFile, resolve(outputDir, "summary.md"));
    assert.equal(resultFile.dryRun, true);
    assert.equal(resultFile.script.diagnosticsCount, undefined);
    assert.equal(resultFile.script.dryRun, undefined);
    assert.equal(resultFile.script.executed, undefined);
    assert.equal(resultFile.compiledScript, undefined);
    assert.equal(resultFile.raw, undefined);
    assert.equal(json.outputFiles.compiledScriptFile, undefined);
    assert.equal(diagnosticsFile.count, 1);
    assert.equal(diagnosticsFile.diagnostics[0].source.column, 1);
    assert.match(summaryFile, /dryRun: true/);
    assert.deepEqual(calls.map((call) => call[0]), []);
    await mcpClient.close();
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("figma REPL run_script_file blocks oversized compiled script payloads before upstream", async () => {
  const tempDir = await mkdtemp(resolve(tmpdir(), "figma-repl-large-script-"));
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
  const { server } = createFigmaReplMcpServer({
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

    await assert.rejects(
      mcpClient.callTool({
        name: "figma_repl_run_script_file",
        arguments: {
          title: "Run oversized script",
          sessionId: "main",
          scriptPath,
          dryRun: true,
          strict: true,
        },
      }),
      /FIGMA_REPL_SCRIPT_PAYLOAD_TOO_LARGE/,
    );
    assert.deepEqual(calls.map((call) => call[0]), []);
    await mcpClient.close();
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("figma REPL run_script_file executes helper-backed scripts through upstream eval", async () => {
  const tempDir = await mkdtemp(resolve(tmpdir(), "figma-repl-script-"));
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
  const { server } = createFigmaReplMcpServer({ client: fakeClient });
  const mcpClient = new Client(
    { name: "test-client", version: "0.1.0" },
    { capabilities: {} },
  );
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

  try {
    await server.connect(serverTransport);
    await mcpClient.connect(clientTransport);

    const result = await mcpClient.callTool({
      name: "figma_repl_run_script_file",
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
    assert.equal(json.dryRun, false);
    assert.equal(json.script.executed, undefined);
    assert.equal(json.script.dryRun, undefined);
    assert.equal(json.script.diagnosticsCount, undefined);
    assert.equal(json.script.targetPageId, "0:1");
    assert.ok(json.script.injectedHelpers.includes("$.checkpoint"));
    assert.ok(json.script.injectedHelpers.includes("$.create"));
    assert.ok(json.script.injectedHelpers.includes("$.text"));
    assert.ok(json.script.injectedHelpers.includes("$.layout"));
    assert.equal(json.script.injectedHelpers.includes("$.find"), false);
    assert.ok(json.script.helperUsage.direct.includes("$.create"));
    assert.ok(json.script.helperUsage.direct.includes("$.text"));
    assert.ok(json.script.helperUsage.direct.includes("$.layout"));
    assert.ok(json.script.helperUsage.direct.includes("$.checkpoint"));
    assert.ok(json.script.helperUsage.transitive.includes("$.placeNode"));
    assert.deepEqual(json.script.helperUsage.injected, json.script.injectedHelpers);
    assert.equal(json.upstream.kind, "json");
    assert.equal(json.upstream.ok, true);
    assert.equal(json.upstream.payload.result.resized.width, 360);
    assert.equal(json.result, undefined);
    assert.equal(json.parsed, undefined);
    assert.equal(json.text, undefined);
    assert.equal(json.session.handles.$scriptTitle, "20:2");
    assert.equal(json.session.history, undefined);
    assert.deepEqual(calls.map((call) => call[0]), ["connect", "listTools", "callTool"]);
    await mcpClient.close();
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("figma REPL run_script_file avoids helper injection for native Plugin API scripts", async () => {
  const tempDir = await mkdtemp(resolve(tmpdir(), "figma-repl-native-"));
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
  const { server } = createFigmaReplMcpServer({ client: fakeClient });
  const mcpClient = new Client(
    { name: "test-client", version: "0.1.0" },
    { capabilities: {} },
  );
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

  try {
    await server.connect(serverTransport);
    await mcpClient.connect(clientTransport);

    const result = await mcpClient.callTool({
      name: "figma_repl_run_script_file",
      arguments: {
        title: "Run native script",
        sessionId: "main",
        scriptPath,
        surface: "design",
      },
    });
    const json = structuredToolResult(result);
    assert.equal(json.ok, true);
    assert.deepEqual(json.script.injectedHelpers, []);
    assert.deepEqual(json.script.helperUsage, { direct: [], transitive: [], runtimeBase: [], injected: [] });
    assert.ok(json.script.compiledScriptBytes < 15_000);
    assert.equal(json.upstream.payload.result.name, "Native frame");
    assert.equal(json.result, undefined);
    await mcpClient.close();
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("figma REPL run_script_file injects helper dependencies from AST usage", async () => {
  const tempDir = await mkdtemp(resolve(tmpdir(), "figma-repl-find-helper-"));
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
  const { server } = createFigmaReplMcpServer({ client: fakeClient });
  const mcpClient = new Client(
    { name: "test-client", version: "0.1.0" },
    { capabilities: {} },
  );
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

  try {
    await server.connect(serverTransport);
    await mcpClient.connect(clientTransport);

    const result = await mcpClient.callTool({
      name: "figma_repl_run_script_file",
      arguments: {
        title: "Run find helper script",
        sessionId: "main",
        scriptPath,
        surface: "design",
      },
    });
    const json = structuredToolResult(result);
    assert.equal(json.ok, true);
    assert.ok(json.script.injectedHelpers.includes("$.find"));
    assert.ok(json.script.injectedHelpers.includes("$.findAll"));
    assert.equal(json.script.injectedHelpers.includes("$.text"), false);
    assert.deepEqual(json.script.helperUsage.direct, ["$.find"]);
    assert.deepEqual(json.script.helperUsage.transitive, ["$.findAll"]);
    await mcpClient.close();
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("figma REPL run_script_file rejects dynamic helper access instead of full injection fallback", async () => {
  const tempDir = await mkdtemp(resolve(tmpdir(), "figma-repl-dynamic-helper-"));
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
  const { server } = createFigmaReplMcpServer({
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

    await assert.rejects(
      mcpClient.callTool({
        name: "figma_repl_run_script_file",
        arguments: {
          title: "Run dynamic helper script",
          sessionId: "main",
          scriptPath,
          surface: "design",
        },
      }),
      /FIGMA_REPL_DYNAMIC_HELPER_ACCESS/,
    );
    assert.deepEqual(calls.map((call) => call[0]), []);
    await mcpClient.close();
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("figma REPL run_script_file allows literal computed helper access", async () => {
  const tempDir = await mkdtemp(resolve(tmpdir(), "figma-repl-literal-helper-"));
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
  const { server } = createFigmaReplMcpServer({ client: fakeClient });
  const mcpClient = new Client(
    { name: "test-client", version: "0.1.0" },
    { capabilities: {} },
  );
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

  try {
    await server.connect(serverTransport);
    await mcpClient.connect(clientTransport);

    const result = await mcpClient.callTool({
      name: "figma_repl_run_script_file",
      arguments: {
        title: "Run literal helper script",
        sessionId: "main",
        scriptPath,
        surface: "design",
      },
    });
    const json = structuredToolResult(result);
    assert.equal(json.ok, true);
    assert.ok(json.script.injectedHelpers.includes("$.find"));
    assert.ok(json.script.injectedHelpers.includes("$.findAll"));
    assert.equal(json.script.injectedHelpers.includes("$.text"), false);
    await mcpClient.close();
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("figma REPL run_script_file supports generated image asset helper without raw createImage in source", async () => {
  const tempDir = await mkdtemp(resolve(tmpdir(), "figma-repl-image-"));
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
  const { server } = createFigmaReplMcpServer({ client: fakeClient });
  const mcpClient = new Client(
    { name: "test-client", version: "0.1.0" },
    { capabilities: {} },
  );
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

  try {
    await server.connect(serverTransport);
    await mcpClient.connect(clientTransport);

    const result = await mcpClient.callTool({
      name: "figma_repl_run_script_file",
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
    assert.equal(json.script.injectedHelpers.includes("$.imageAsset"), true);
    assert.equal(json.session.handles.$icon, "40:2");
    await mcpClient.close();
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("figma REPL run_script_file structures upstream ok false errors", async () => {
  const tempDir = await mkdtemp(resolve(tmpdir(), "figma-repl-upstream-error-"));
  const scriptPath = resolve(tempDir, "script.figma.js");
  const outputDir = resolve(tempDir, "outputs");
  await writeFile(scriptPath, "return await $.cloneNodeTree({ source: '$source', as: '$copy' });", "utf8");
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
  const { server } = createFigmaReplMcpServer({ client: fakeClient });
  const mcpClient = new Client(
    { name: "test-client", version: "0.1.0" },
    { capabilities: {} },
  );
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

  try {
    await server.connect(serverTransport);
    await mcpClient.connect(clientTransport);

    const result = await mcpClient.callTool({
      name: "figma_repl_run_script_file",
      arguments: {
        title: "Run script with upstream failure",
        scriptPath,
        outputDir,
        summaryFile: "summary.md",
      },
    });
    const json = structuredToolResult(result);
    assert.equal(json.ok, false);
    assert.equal(json.dryRun, false);
    assert.equal(json.upstreamError.code, "FIGMA_INSTANCE_CHILD_REMOVE");
    assert.match(json.upstreamError.message, /instance subtree/);
    assert.equal(json.upstreamError.parsed, undefined);
    assert.equal(json.upstreamError.text, undefined);
    assert.equal(json.upstream.kind, "json");
    assert.equal(json.upstream.ok, false);
    assert.equal(json.upstream.payload.error.code, "FIGMA_INSTANCE_CHILD_REMOVE");
    assert.match(json.primaryFix, /\$\.cloneNodeTree/);
    assert.equal(json.compiledScript, undefined);
    assert.equal(json.raw, undefined);
    const resultFile = await readPrettyJsonPointer(json.outputFiles.outputFile, resolve(outputDir, "result.json"));
    const compiledFilePath = resolve(outputDir, "result.failure.compiled.js");
    const compiledFile = await readTextPointer(json.outputFiles.compiledScriptFile, compiledFilePath);
    const summaryFile = await readTextPointer(json.outputFiles.summaryFile, resolve(outputDir, "summary.md"));
    assert.equal(resultFile.ok, false);
    assert.equal(resultFile.compiledScript, undefined);
    assert.equal(resultFile.raw, undefined);
    assert.equal(resultFile.upstream.kind, "json");
    assert.equal(resultFile.upstream.ok, false);
    assert.deepEqual(resultFile.upstream.payload, {
      ok: false,
      error: {
        code: "FIGMA_INSTANCE_CHILD_REMOVE",
        message: "Cannot remove children inside an instance subtree.",
      },
    });
    assert.equal(resultFile.upstreamError.parsed, undefined);
    assert.equal(resultFile.upstreamError.text, undefined);
    assert.match(compiledFile, /Generated by figma_repl_run_script_file after upstream execution failure/);
    assert.match(compiledFile, /This is the compiled wrapper sent to upstream Figma MCP/);
    assert.match(compiledFile, /\$\.cloneNodeTree/);
    assert.match(compiledFile, /figma_repl_run_script_file source:/);
    assert.match(summaryFile, /primaryFix:/);

    await writeFile(scriptPath, "return { summary: 'success after failure' };", "utf8");
    const successResult = await mcpClient.callTool({
      name: "figma_repl_run_script_file",
      arguments: {
        title: "Run script after upstream failure",
        scriptPath,
        outputDir,
      },
    });
    const successJson = structuredToolResult(successResult);
    assert.equal(successJson.ok, true);
    assert.equal(successJson.outputFiles.compiledScriptFile, undefined);
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

test("figma REPL run_script_file structures upstream text errors without implicit files", async () => {
  const tempDir = await mkdtemp(resolve(tmpdir(), "figma-repl-upstream-text-error-"));
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
  const { server } = createFigmaReplMcpServer({ client: fakeClient });
  const mcpClient = new Client(
    { name: "test-client", version: "0.1.0" },
    { capabilities: {} },
  );
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

  try {
    await server.connect(serverTransport);
    await mcpClient.connect(clientTransport);

    const result = await mcpClient.callTool({
      name: "figma_repl_run_script_file",
      arguments: {
        title: "Run script with upstream text failure",
        scriptPath,
        allowDangerousOperations: true,
      },
    });
    const json = structuredToolResult(result);
    assert.equal(json.ok, false);
    assert.equal(json.dryRun, false);
    assert.equal(json.upstreamError.code, "FIGMA_UPSTREAM_TEXT_ERROR");
    assert.match(json.upstreamError.message, /set_selection/);
    assert.equal(json.upstreamError.details.debugUuid, "59c9dee0-3819-4e15-9a9e-a4a37a71072d");
    assert.equal(json.upstreamError.text, undefined);
    assert.equal(json.upstreamError.parsed, undefined);
    assert.equal(json.upstream.kind, "text");
    assert.equal(json.upstream.ok, false);
    assert.match(json.upstream.text, /Figma Debug UUID/);
    assert.equal(json.text, undefined);
    assert.match(json.primaryFix, /\$\.select/);
    assert.equal(json.compiledScript, undefined);
    assert.equal(json.outputFiles.compiledScriptFile, undefined);
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

test("figma REPL run_script_file writes output files and limits inline result fields", async () => {
  const tempDir = await mkdtemp(resolve(tmpdir(), "figma-repl-output-"));
  const scriptPath = resolve(tempDir, "script.figma.js");
  const outputDir = resolve(tempDir, "outputs");
  await writeFile(scriptPath, "return { summary: 'large result' };", "utf8");
  const calls = [];
  const fakeClient = createFakeFigmaClient(calls, ({ args }) => {
    assert.match(args.code, /large result/);
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify({
            ok: true,
            result: {
              summary: "large result",
              payload: "x".repeat(200),
            },
          }),
        },
      ],
    };
  });
  const { server } = createFigmaReplMcpServer({ client: fakeClient });
  const mcpClient = new Client(
    { name: "test-client", version: "0.1.0" },
    { capabilities: {} },
  );
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

  try {
    await server.connect(serverTransport);
    await mcpClient.connect(clientTransport);

    const result = await mcpClient.callTool({
      name: "figma_repl_run_script_file",
      arguments: {
        title: "Run script with output files",
        scriptPath,
        outputDir,
        outputFile: "full-result.json",
        inlineResultLimit: 40,
      },
    });
    const json = structuredToolResult(result);
    assert.equal(json.ok, true);
    assert.equal(json.dryRun, false);
    assert.equal(json.result, undefined);
    assert.equal(json.text, undefined);
    assert.equal(json.raw, undefined);
    assert.equal(json.upstream.kind, "json");
    assert.equal(json.upstream.ok, true);
    assert.equal(json.upstream.payload, undefined);
    assert.deepEqual(
      json.inlineResultLimit.omitted.map((item) => item.field),
      ["upstream.payload"],
    );
    const resultFile = await readPrettyJsonPointer(json.outputFiles.outputFile, resolve(outputDir, "full-result.json"));
    const upstreamFile = await readPrettyJsonPointer(json.outputFiles.upstreamFile, resolve(outputDir, "full-result.upstream.json"));
    assert.equal(json.outputFiles.diagnosticsFile, undefined);
    assert.equal(json.outputFiles.summaryFile, undefined);
    assert.equal(resultFile.upstream.kind, "json");
    assert.equal(resultFile.upstream.ok, true);
    assert.equal(resultFile.upstream.payload.result.payload.length, 200);
    assert.deepEqual(upstreamFile, resultFile.upstream);
    assert.deepEqual(resultFile.upstream.payload, {
      ok: true,
      result: {
        summary: "large result",
        payload: "x".repeat(200),
      },
    });
    assert.equal(resultFile.raw, undefined);
    assert.deepEqual(calls.map((call) => call[0]), ["connect", "listTools", "callTool"]);
    await mcpClient.close();
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("figma REPL prepare_task uses file context and intent file pairs", async () => {
  const tempDir = await mkdtemp(resolve(tmpdir(), "figma-repl-workspace-"));
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
            result: { summary: "workspace file result", payload: "y".repeat(160) },
          }),
        },
      ],
    };
  });
  const { server } = createFigmaReplMcpServer({ client: fakeClient });
  const mcpClient = new Client(
    { name: "test-client", version: "0.1.0" },
    { capabilities: {} },
  );
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

  try {
    await server.connect(serverTransport);
    await mcpClient.connect(clientTransport);

    const initResult = await mcpClient.callTool({
      name: "figma_repl_prepare_task",
      arguments: {
        title: "Init workspace",
        sessionId: "settings-workspace",
        task: "Settings Panel Polish",
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
    assert.equal(initJson.task.taskSlug, "settings-panel-polish");
    assert.equal(initJson.task.intentSlug, undefined);
    assert.equal(initJson.task.inputFile, "settings-panel-polish.figma.js");
    assert.equal(initJson.task.outputFile, "settings-panel-polish.result.json");
    assert.equal(initJson.task.resultFile, undefined);
    assert.equal(initJson.task.fileDir, undefined);
    assert.equal(initJson.task.workspaceDir, undefined);
    assert.equal(initJson.task.taskDir, undefined);
    assert.equal(initJson.task.workspace.fileDir, resolve(tempDir, "figma-mcp", "ExampleFigmaFileKey012"));
    assert.equal(initJson.task.workspace.sessionDir, initJson.task.workspace.fileDir);
    assert.equal(initJson.task.workspace.taskSlug, "settings-panel-polish");
    assert.equal(initJson.task.workspace.intentSlug, undefined);
    assert.equal(initJson.task.workspace.resultFile, undefined);
    assert.equal(initJson.task.workspace.files.inputFile, "settings-panel-polish.figma.js");
    assert.equal(initJson.task.workspace.files.outputFile, "settings-panel-polish.result.json");
    assert.equal(initJson.taskChange.previous, undefined);
    assert.equal(initJson.taskChange.changed, true);
    assert.deepEqual(initJson.taskChange.current, {
      taskSlug: "settings-panel-polish",
      inputFile: "settings-panel-polish.figma.js",
      outputFile: "settings-panel-polish.result.json",
      sessionDir: initJson.task.workspace.sessionDir,
    });
    assertFilePointer(initJson.outputFiles.outputFile, resolve(initJson.task.workspace.fileDir, "settings-panel-polish.result.json"));

    await writeFile(
      resolve(initJson.task.workspace.fileDir, "settings-panel-polish.figma.js"),
      "return { summary: 'workspace file result' };",
      "utf8",
    );

    const result = await mcpClient.callTool({
      name: "figma_repl_run_script_file",
      arguments: {
        title: "Run workspace file",
        sessionId: "settings-workspace",
        inputFile: "settings-panel-polish.figma.js",
        inlineResultLimit: 40,
      },
    });
    const json = structuredToolResult(result);
    assert.equal(json.ok, true);
    assert.equal(json.dryRun, false);
    assert.equal(json.session.workspace.fileContext, "ExampleFigmaFileKey012");
    assert.deepEqual(json.session.workspace.files, initJson.task.workspace.files);
    assert.equal(json.session.workspace.sessionDir, initJson.task.workspace.sessionDir);
    assert.equal(json.session.workspace.intentSlug, undefined);
    assert.equal(json.session.workspace.resultFile, undefined);
    assert.equal(json.session.surface, "design");
    assertFilePointer(json.outputFiles.outputFile, resolve(initJson.task.workspace.fileDir, "settings-panel-polish.result.json"));
    assertFilePointer(json.outputFiles.upstreamFile, resolve(initJson.task.workspace.fileDir, "settings-panel-polish.upstream.json"));
    assert.equal(json.result, undefined);
    assert.equal(json.upstream.kind, "json");
    assert.equal(json.upstream.ok, true);
    assert.equal(json.upstream.payload, undefined);
    assert.deepEqual(
      json.inlineResultLimit.omitted.map((item) => item.field),
      ["upstream.payload"],
    );
    const resultFile = await readPrettyJsonPointer(json.outputFiles.outputFile, resolve(initJson.task.workspace.fileDir, "settings-panel-polish.result.json"));
    assert.equal(resultFile.upstream.payload.result.payload.length, 160);
    const upstreamFile = await readPrettyJsonPointer(json.outputFiles.upstreamFile, resolve(initJson.task.workspace.fileDir, "settings-panel-polish.upstream.json"));
    assert.deepEqual(upstreamFile, resultFile.upstream);

    await writeFile(
      resolve(initJson.task.workspace.fileDir, "settings-panel-polish.figma.js"),
      "return { summary: 'workspace failure result' };",
      "utf8",
    );
    const failedResult = await mcpClient.callTool({
      name: "figma_repl_run_script_file",
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
    const failedCompiledFile = await readTextPointer(
      failedJson.outputFiles.compiledScriptFile,
      resolve(initJson.task.workspace.fileDir, "settings-panel-polish.failure.compiled.js"),
    );
    assert.match(failedCompiledFile, /Generated by figma_repl_run_script_file after upstream execution failure/);
    assert.match(failedCompiledFile, /Source: ExampleFigmaFileKey012\/settings-panel-polish\.figma\.js/);
    assert.match(failedCompiledFile, /workspace failure result/);
    assert.match(failedCompiledFile, /figma_repl_run_script_file source:/);

    const prepared = await mcpClient.callTool({
      name: "figma_repl_prepare_task",
      arguments: {
        title: "Prepare another task",
        sessionId: "settings-workspace",
        task: "Token Audit",
        surface: "design",
        overwrite: true,
      },
    });
    const preparedJson = structuredToolResult(prepared);
    assert.equal(preparedJson.task.fileContext, "ExampleFigmaFileKey012");
    assert.equal(preparedJson.task.workspace.fileKey, "ExampleFigmaFileKey012");
    assert.equal(preparedJson.task.taskSlug, "token-audit");
    assert.equal(preparedJson.task.intentSlug, undefined);
    assert.equal(preparedJson.task.inputFile, "token-audit.figma.js");
    assert.equal(preparedJson.task.outputFile, "token-audit.result.json");
    assert.equal(preparedJson.task.workspaceDir, undefined);
    assert.equal(preparedJson.task.taskDir, undefined);
    assert.equal(preparedJson.task.scriptPath, resolve(initJson.task.workspace.fileDir, "token-audit.figma.js"));
    assert.equal(preparedJson.task.resultFile, undefined);
    assert.equal(preparedJson.taskChange.changed, true);
    assert.equal(preparedJson.taskChange.previous.taskSlug, "settings-panel-polish");
    assert.deepEqual(preparedJson.taskChange.current, {
      taskSlug: "token-audit",
      inputFile: "token-audit.figma.js",
      outputFile: "token-audit.result.json",
      sessionDir: initJson.task.workspace.sessionDir,
    });
    assertFilePointer(preparedJson.outputFiles.outputFile, resolve(initJson.task.workspace.fileDir, "token-audit.result.json"));

    const preparedAgain = await mcpClient.callTool({
      name: "figma_repl_prepare_task",
      arguments: {
        title: "Prepare same task",
        sessionId: "settings-workspace",
        task: "Token Audit",
        surface: "design",
        overwrite: true,
      },
    });
    const preparedAgainJson = structuredToolResult(preparedAgain);
    assert.equal(preparedAgainJson.taskChange.changed, false);
    assert.equal(preparedAgainJson.taskChange.previous.taskSlug, "token-audit");
    assert.deepEqual(preparedAgainJson.taskChange.current, preparedJson.taskChange.current);

    await assert.rejects(
      mcpClient.callTool({
        name: "figma_repl_run_script_file",
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

test("figma REPL run_script_file rejects relative script paths", async () => {
  const calls = [];
  const { server } = createFigmaReplMcpServer({
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
      name: "figma_repl_run_script_file",
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

test("figma REPL open accepts unified file input and auto-binds a workspace", async () => {
  const repl = createFigmaReplClient({
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
  assert.equal(
    result.session.workspace.fileDir,
    resolve(process.cwd(), "figma-mcp", "ExampleFigmaFileKey012"),
  );
  assert.equal(result.session.workspace.files.inputFile, "open-file-workspace.figma.js");
  assert.equal(result.session.workspace.files.outputFile, "open-file-workspace.result.json");
  assert.equal(result.session.workspace.intentSlug, undefined);
  assert.equal(result.session.workspace.resultFile, undefined);
  await repl.close();
});

test("figma REPL prepare_task creates .figma.js workspace and enforces overwrite and path rules", async () => {
  const tempDir = await mkdtemp(resolve(tmpdir(), "figma-repl-task-"));
  const workspaceDir = resolve(tempDir, "workspace");
  const calls = [];
  const { server } = createFigmaReplMcpServer({
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
      name: "figma_repl_prepare_task",
      arguments: {
        title: "Prepare task",
        taskSlug: "settings-panel",
        workspaceDir,
        fileName: "settings-panel.figma.js",
        task: "Create a settings panel",
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
    assert.equal(json.task.outputFile, "settings-panel.result.json");
    assert.equal(json.task.scriptPath, resolve(workspaceDir, "settings-panel.figma.js"));
    assert.equal(json.task.intentSlug, undefined);
    assert.equal(json.task.resultFile, undefined);
    assert.equal(json.task.workspace.taskSlug, "settings-panel");
    assert.equal(json.task.workspace.intentSlug, undefined);
    assert.equal(json.task.workspace.resultFile, undefined);
    assertFilePointer(json.outputFiles.outputFile, resolve(workspaceDir, "settings-panel.result.json"));
    assert.match(await readFile(json.task.scriptPath, "utf8"), /\$\.checkpoint/);
    assert.match(await readFile(json.task.scriptPath, "utf8"), /Task: Create a settings panel/);
    const pendingResult = await readPrettyJsonPointer(json.outputFiles.outputFile, resolve(workspaceDir, "settings-panel.result.json"));
    assert.equal(pendingResult.status, "pending");
    assert.equal(pendingResult.taskSlug, "settings-panel");
    assert.equal(pendingResult.intentSlug, undefined);
    assert.equal(pendingResult.inputFile, "settings-panel.figma.js");
    assert.equal(pendingResult.outputFile, "settings-panel.result.json");

    await assert.rejects(
      mcpClient.callTool({
        name: "figma_repl_prepare_task",
        arguments: {
          title: "Refuse overwrite",
          taskSlug: "settings-panel",
          workspaceDir,
        },
      }),
      /Refusing to overwrite/,
    );
    await assert.rejects(
      mcpClient.callTool({
        name: "figma_repl_prepare_task",
        arguments: {
          title: "Reject relative workspace",
          workspaceDir: "relative-workspace",
        },
      }),
      /workspaceDir" must be an absolute path/,
    );
    await assert.rejects(
      mcpClient.callTool({
        name: "figma_repl_prepare_task",
        arguments: {
          title: "Reject absolute script name",
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

test("figma REPL guidance returns compact cards and intent routing without upstream", async () => {
  const calls = [];
  const { server } = createFigmaReplMcpServer({
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
    name: "figma_repl_guidance",
    arguments: {
      title: "Read text card",
      card: "text",
    },
  });
  const cardJson = structuredToolResult(cardResult);
  assert.equal(cardJson.ok, true);
  assert.equal(cardJson.mode, "card");
  assert.ok(cardJson.cards.some((card) => card.id === "text.font"));
  assert.ok(cardJson.recommendedCards.includes("text.font"));
  assert.match(JSON.stringify(cardJson.cards), /loadFontAsync/);
  assert.ok(cardJson.cards.find((card) => card.id === "text.font").queryHints.some((hint) => /font/.test(hint)));
  assert.equal(cardResult.content.length, 0);

  const planResult = await mcpClient.callTool({
    name: "figma_repl_guidance",
    arguments: {
      title: "Plan file workflow",
      mode: "plan",
      task: "Create a settings card with title and button",
      surface: "design",
      workflow: "script-file",
    },
  });
  const planJson = structuredToolResult(planResult);
  assert.equal(planJson.ok, true);
  assert.equal(planJson.mode, "plan");
  assert.equal(planJson.workflow.primaryTool, "figma_repl_run_script_file");
  assert.ok(planJson.steps.some((step) => /figma_repl_prepare_task/.test(step)));
  assert.ok(planJson.recommendedTools.includes("figma_repl_prepare_task"));
  assert.ok(planJson.recommendedTools.includes("figma_repl_guidance"));
  assert.ok(planJson.suggestedCards.length > 0);

  const longPlanResult = await mcpClient.callTool({
    name: "figma_repl_guidance",
    arguments: {
      title: "Plan long task",
      mode: "plan",
      task: `Create a settings card with title and button ${"using polished layout details ".repeat(8)}`,
      surface: "design",
    },
  });
  const longPlanJson = structuredToolResult(longPlanResult);
  assert.equal(longPlanJson.ok, true);
  assert.equal(longPlanJson.mode, "plan");
  assert.ok(longPlanJson.suggestedCards.length > 0);

  const suggestResult = await mcpClient.callTool({
    name: "figma_repl_guidance",
    arguments: {
      title: "Suggest API",
      task: "create component variants with text",
      surface: "design",
    },
  });
  const suggestJson = structuredToolResult(suggestResult);
  assert.equal(suggestJson.ok, true);
  assert.equal(suggestJson.mode, "guidance");
  assert.equal(Object.hasOwn(suggestJson, "intent"), false);
  assert.equal(Object.hasOwn(suggestJson, "cardQuery"), false);
  assert.equal(Object.hasOwn(suggestJson, "expectedSurface"), false);
  assert.ok(suggestJson.recommendedCards.includes("components.variants"));
  assert.ok(suggestJson.suggestions.cards.some((card) => card.id === "components.variants"));
  assert.ok(suggestJson.suggestions.recommendedCards.includes("components.variants"));
  assert.ok(suggestJson.suggestions.queryHints.some((hint) => /component/.test(hint)));
  assert.ok(suggestJson.suggestions.apiSymbols.includes("figma.combineAsVariants"));
  assert.ok(suggestJson.suggestions.avoid.some((entry) => /non-component/.test(entry)));
  assert.equal(suggestJson.suggestions.matchType, "api-card");
  assert.equal(suggestJson.suggestions.confidence, "high");
  assert.ok(suggestJson.suggestions.referenceContext.length > 0);
  assert.ok(suggestJson.suggestions.referenceContext.every((item) => ["exact-symbol", "phrase", "token"].includes(item.matchType)));
  assert.ok(suggestJson.suggestions.referenceContext.every((item) => item.snippet.split("\n").length <= 4));
  assert.equal(suggestJson.suggestions.workflow.primaryTool, "figma_repl_run_script_file");

  const longTaskResult = await mcpClient.callTool({
    name: "figma_repl_guidance",
    arguments: {
      title: "Suggest long task",
      task: `create component variants with text ${"and polish interaction states ".repeat(8)}`,
      surface: "design",
    },
  });
  const longTaskJson = structuredToolResult(longTaskResult);
  assert.equal(longTaskJson.ok, true);
  assert.equal(longTaskJson.mode, "guidance");
  assert.ok(longTaskJson.recommendedCards.includes("components.variants"));
  assert.ok(longTaskJson.suggestions.apiSymbols.includes("figma.combineAsVariants"));

  const commonTaskExpectations = [
    ["bind a color variable to a button fill", "variables.bind", "VariablesAPI.setBoundVariableForPaint"],
    ["set instance properties on a button variant", "instances.properties", "InstanceNode.setProperties"],
    ["apply generated PNG image fills and capture QA", "images.fill", "figma.createImage"],
    ["create FigJam sticky notes connected by arrows", "surface.figjam", "figma.createSticky"],
    ["organize a Slides deck into slide rows", "surface.slides", "figma.createSlide"],
  ];
  for (const [task, expectedCard, expectedSymbol] of commonTaskExpectations) {
    const commonResult = await mcpClient.callTool({
      name: "figma_repl_guidance",
      arguments: {
        title: `Suggest ${expectedCard}`,
        task,
        maxCards: 3,
      },
    });
    const commonJson = structuredToolResult(commonResult);
    assert.ok(commonJson.suggestions.recommendedCards.includes(expectedCard));
    assert.ok(commonJson.suggestions.apiSymbols.includes(expectedSymbol));
    assert.ok(commonJson.suggestions.queryHints.length > 0);
    assert.ok(commonJson.suggestions.avoid.length > 0);
  }
  assert.deepEqual(calls.map((call) => call[0]), []);
  await mcpClient.close();
});

test("figma REPL inspect mode=style returns compact visual token audit", async () => {
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
  const { server } = createFigmaReplMcpServer({ client: fakeClient });
  const mcpClient = new Client(
    { name: "test-client", version: "0.1.0" },
    { capabilities: {} },
  );
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

  await server.connect(serverTransport);
  await mcpClient.connect(clientTransport);
  const result = await mcpClient.callTool({
    name: "figma_repl_inspect",
    arguments: {
      title: "Inspect style",
      sessionId: "style",
      mode: "style",
      target: "94:2",
    },
  });
  const json = structuredToolResult(result);
  assert.equal(json.ok, true);
  assert.equal(json.upstream.payload.result.mode, "style");
  assert.equal(json.upstream.payload.result.style.topColors[0].color, "#101820");
  assert.equal(json.upstream.payload.result.style.textStyles.length, 1);
  assert.equal(json.upstream.payload.result.style.imageNodes.length, 1);
  assert.deepEqual(calls.map((call) => call[0]), ["connect", "listTools", "callTool"]);
  await mcpClient.close();
});

test("figma REPL inspect mode=validate reports valid, missing, and stale", async () => {
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
  const { server } = createFigmaReplMcpServer({ client: fakeClient });
  const mcpClient = new Client(
    { name: "test-client", version: "0.1.0" },
    { capabilities: {} },
  );
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

  await server.connect(serverTransport);
  await mcpClient.connect(clientTransport);
  await mcpClient.callTool({
    name: "figma_repl_open",
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
    name: "figma_repl_inspect",
    arguments: {
      title: "Validate handles",
      sessionId: "main",
      mode: "validate",
      handles: ["$valid", "$missing", "$stale"],
    },
  });
  const json = structuredToolResult(result);
  assert.deepEqual(
    json.upstream.payload.result.validations.map((item) => item.status),
    ["valid", "missing", "stale"],
  );
  assert.equal(json.result, undefined);
  assert.equal(json.text, undefined);
  assert.deepEqual(calls.map((call) => call[0]), ["connect", "listTools", "callTool"]);
  await mcpClient.close();
});

test("figma REPL programmatic client accepts an absolute OAuth cache path", async () => {
  const oauthCachePath = resolve(packageRoot, "test-oauth-cache.json");
  const repl = createFigmaReplClient({
    oauthCachePath,
    openBrowser: false,
  });

  assert.equal(repl.client.config.statePath, oauthCachePath);
  assert.throws(
    () => createFigmaReplClient({ oauthCachePath: "relative-oauth-cache.json" }),
    /absolute path/,
  );

  await repl.close();
});

test("figma REPL programmatic client can call eval without MCP transport", async () => {
  const calls = [];
  const fakeClient = createFakeFigmaClient(calls, ({ args }) => {
    assert.equal(typeof args.code, "string");
    assert.equal(args.fileKey, "ExampleFigmaFileKey012");
    assert.equal(args.description, "Run Figma REPL JavaScript");
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify({
            ok: true,
            result: {
              summary: "read current page",
            },
          }),
        },
      ],
    };
  });

  const repl = createFigmaReplClient({ client: fakeClient });
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
  assert.equal(result.upstreamTool, "use_figma");
  assert.equal(result.upstreamArgument, "code");
  assert.equal(result.upstream.payload.result.summary, "read current page");
  assert.equal(result.result, undefined);
  assert.equal(result.text, undefined);
  assert.deepEqual(calls.map((call) => call[0]), ["connect", "listTools", "callTool"]);
});

test("figma REPL programmatic client returns typed output contracts", async () => {
  const tempDir = await mkdtemp(resolve(tmpdir(), "figma-repl-client-typed-"));
  const scriptPath = resolve(tempDir, "typed-client.figma.js");
  const assetPath = resolve(tempDir, "asset.png");
  const capturePath = resolve(tempDir, "capture.png");
  const plannedCapturePath = resolve(tempDir, "capture.png");
  const workspaceDir = resolve(tempDir, "task");
  await writeFile(scriptPath, "return { summary: 'typed dry run' };", "utf8");
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
        { name: "fake_upstream", inputSchema: { type: "object", properties: {} } },
        { name: "upload_assets", inputSchema: { type: "object", properties: { fileKey: { type: "string" }, count: { type: "number" }, nodeId: { type: "string" }, scaleMode: { type: "string" } } } },
        { name: "get_screenshot", inputSchema: { type: "object", properties: { fileKey: { type: "string" }, nodeId: { type: "string" } }, required: ["fileKey", "nodeId"] } },
      ],
    },
  );
  const repl = createFigmaReplClient({ client: fakeClient });

  try {
    const scriptResult = await repl.runScriptFile({
      scriptPath,
      dryRun: true,
    });
    assert.equal(scriptResult.ok, true);
    assert.equal(scriptResult.dryRun, true);
    assert.equal("content" in scriptResult, false);

    const upstreamResult = await repl.callUpstreamTool({
      toolName: "fake_upstream",
      arguments: { marker: "typed" },
    });
    assert.equal(upstreamResult.ok, true);
    assert.equal(upstreamResult.upstream.payload.result.summary, "typed upstream");
    assert.equal(upstreamResult.result, undefined);
    assert.equal(upstreamResult.text, undefined);
    assert.equal("content" in upstreamResult, false);

    await repl.open({
      sessionId: "typed",
      connect: false,
      file: "https://www.figma.com/design/file123/Test",
    });
    const assetResult = await repl.applyAssetManifest({
      sessionId: "typed",
      assets: [{ path: assetPath, target: "12:34", name: "Asset" }],
      validateTargets: false,
    });
    assert.equal(assetResult.ok, true);
    assert.equal(assetResult.assets[0].upstreamSummary, "asset filled");
    assert.equal(assetResult.assets[0].arguments, undefined);
    assert.equal(assetResult.assets[0].result, undefined);
    assert.equal(assetResult.assets[0].upstream, undefined);

    const captureResult = await repl.captureNode({
      sessionId: "typed",
      target: "12:35",
      outputFile: capturePath,
    });
    assert.equal(captureResult.ok, false);
    assert.equal(captureResult.outputFile, undefined);
    assert.equal(captureResult.plannedOutputFile, plannedCapturePath);
    assert.equal(captureResult.upstream.kind, "json");
    assert.equal(captureResult.upstream.ok, false);
    assert.equal(captureResult.upstream.payload, undefined);
    assert.equal(captureResult.upstreamError.code, "CAPTURE_FAILED");
    assert.equal(captureResult.upstreamError.parsed, undefined);
    assert.equal(captureResult.upstreamError.text, undefined);
    await assert.rejects(
      readFile(plannedCapturePath, "utf8"),
      /ENOENT/,
    );

    const preparedResult = await repl.prepareTask({
      taskSlug: "typed-task",
      workspaceDir,
      fileName: "typed-task.figma.js",
      task: "Typed Task",
    });
    assert.equal(preparedResult.ok, true);
    assert.equal(preparedResult.task.taskSlug, "typed-task");
    assert.equal(preparedResult.task.intentSlug, undefined);
    assert.equal(preparedResult.task.inputFile, "typed-task.figma.js");
    assert.equal(preparedResult.task.outputFile, "typed-task.result.json");
    assert.equal(preparedResult.task.workspace.fileDir, workspaceDir);
    assert.equal(preparedResult.task.workspace.files.inputFile, "typed-task.figma.js");
    assert.equal(preparedResult.task.workspace.files.outputFile, "typed-task.result.json");
    assert.equal(preparedResult.task.resultFile, undefined);
    assertFilePointer(preparedResult.outputFiles.outputFile, resolve(workspaceDir, "typed-task.result.json"));
    assert.equal(preparedResult.task.workspaceDir, undefined);
    assert.equal(preparedResult.task.taskDir, undefined);

    assert.deepEqual(calls.map((call) => call[0]), ["connect", "listTools", "callTool", "callTool", "callTool"]);
  } finally {
    await repl.close();
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("figma REPL stdio CLI exits cleanly when stdin ends", async () => {
  const result = await runCliWithClosedStdin("dist/repl-stdio-cli.js");

  assert.equal(result.code, 0);
  assert.equal(result.signal, null);
  assert.equal(result.stdout, "");
  assert.equal(result.stderr, "");
});

test("figma REPL stdio CLI completes initialize and lists local tools", async () => {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ["dist/repl-stdio-cli.js"],
    cwd: packageRoot,
  });
  const client = new Client(
    { name: "test-client", version: "0.1.0" },
    { capabilities: {} },
  );

  try {
    await client.connect(transport);
    const result = await client.listTools();
    assert.ok(result.tools.some((tool) => tool.name === "figma_repl_capture_node"));
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
