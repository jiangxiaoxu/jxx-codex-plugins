import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
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
  assert.equal(result.content?.[0]?.type, "text");
  assert.ok(result.structuredContent);
  const expectedSummary = result.structuredContent.ok === false
    ? "Figma REPL tool failed."
    : "Figma REPL tool completed.";
  assert.equal(result.content[0].text, expectedSummary);
  assert.doesNotMatch(result.content[0].text, /structuredContent/i);
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
  assert.equal(evalJson.result.result.id, "12:34");
  assert.equal(evalJson.parsed, undefined);
  assert.equal(evalJson.text, undefined);
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
  assert.equal(sessionJson.history.length, 1);

  assert.deepEqual(calls.map((call) => call[0]), ["connect", "listTools", "callTool"]);
  await mcpClient.close();
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

  const shadowSelection = resolveFigmaReplScriptHelperSelection("const $ = { find() { return null; } };\nreturn $.find();");
  assert.deepEqual(shadowSelection.injectedHelpers, []);
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
  assert.ok(capabilities.guide.preferredFlow.includes("figma_repl_call_upstream_tool when a task explicitly needs an upstream Figma MCP tool"));
  assert.match(capabilities.guide.upstreamBridge, /figma_repl_call_upstream_tool/);
  assert.deepEqual(capabilities.queryStrategy.outputFields, queryOutputFields);
  assert.ok(capabilities.queryStrategy.commonCards.includes("text.font"));
  assert.ok(capabilities.queryStrategy.commonCards.includes("surface.slides"));
  assert.equal(capabilities.scriptWorkflow.primaryTool, "figma_repl_run_script_file");
  assert.equal(capabilities.fileWorkflow.primaryTool, "figma_repl_run_script_file");
  assert.ok(capabilities.fileWorkflow.guidance.some((line) => line.includes("eval wrapper")));
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
    ["figma_repl_apply_asset_manifest", "figma_repl_capture_node", "figma_repl_run_task_plan"],
  );
  assert.equal(capabilities.workflowTools.assetManifest.tool, "figma_repl_apply_asset_manifest");
  assert.equal(capabilities.workflowTools.capture.tool, "figma_repl_capture_node");
  assert.equal(capabilities.workflowTools.taskPlan.tool, "figma_repl_run_task_plan");
  assert.equal(capabilities.fileWorkflow.prepareTool, "figma_repl_prepare_task");
  assert.match(capabilities.fileWorkflow.workspaceLayout, /<fileKey-or-fileSlug>/);
  assert.match(capabilities.scriptWorkflow.options.outputFile, /result\.json/);
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
    "figma_repl_eval",
    "figma_repl_guidance",
    "figma_repl_inspect",
    "figma_repl_lookup",
    "figma_repl_open",
    "figma_repl_prepare_task",
    "figma_repl_run_script_file",
    "figma_repl_run_task_plan",
  ]);
  assert.equal(tools.tools.length, 11);
  const runScriptFileTool = tools.tools.find((tool) => tool.name === "figma_repl_run_script_file");
  assert.ok(runScriptFileTool);
  assert.match(runScriptFileTool.description, /figma-repl:\/\/capabilities/);
  assert.doesNotMatch(runScriptFileTool.description, /\$\[name\]/);
  const evalTool = tools.tools.find((tool) => tool.name === "figma_repl_eval");
  assert.ok(evalTool);
  assert.match(evalTool.description, /AST-referenced \$ helpers/);
  assert.match(evalTool.description, /figma-repl:\/\/capabilities/);
  assert.doesNotMatch(evalTool.description, /\$\[name\]/);
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
      Object.keys(tool.outputSchema?.properties ?? {}).length <= 12,
      `${tool.name} outputSchema stays concise`,
    );
  }
  const guidanceTool = tools.tools.find((tool) => tool.name === "figma_repl_guidance");
  assert.match(guidanceTool.inputSchema.properties.task.description, /Trimmed and capped to 120 characters/);
  assert.match(guidanceTool.inputSchema.properties.intent.description, /Trimmed and capped to 120 characters/);
  assert.match(guidanceTool.inputSchema.properties.goal.description, /Trimmed and capped to 120 characters/);
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
  ]);

  const aggregateResource = await mcpClient.readResource({ uri: "figma-repl://capabilities" });
  assert.deepEqual(JSON.parse(aggregateResource.contents[0].text).queryStrategy.outputFields, queryOutputFields);

  const scriptsResource = await mcpClient.readResource({ uri: "figma-repl://scripts" });
  const scripts = JSON.parse(scriptsResource.contents[0].text);
  assert.equal(scripts.primaryTool, "figma_repl_run_script_file");
  assert.match(scripts.options.scriptPath, /Absolute path escape hatch/);

  const workflowResource = await mcpClient.readResource({ uri: "figma-repl://file-workflow" });
  const workflow = JSON.parse(workflowResource.contents[0].text);
  assert.equal(workflow.prepareTool, "figma_repl_prepare_task");
  assert.deepEqual(workflow.helpers, ["$", ...FIGMA_REPL_EVAL_COMMON_HELPER_NAMES.map((name) => `$.${name}`)]);
  assert.deepEqual(workflow.workflowTools, [
    "figma_repl_apply_asset_manifest",
    "figma_repl_capture_node",
    "figma_repl_run_task_plan",
  ]);

  const workflowToolsResource = await mcpClient.readResource({ uri: "figma-repl://workflow-tools" });
  const workflowTools = JSON.parse(workflowToolsResource.contents[0].text);
  assert.equal(workflowTools.assetManifest.tool, "figma_repl_apply_asset_manifest");
  assert.match(workflowTools.assetManifest.defaults, /explicit toolName/);
  assert.equal(workflowTools.capture.tool, "figma_repl_capture_node");

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
  assert.match(upstream.guidance, /figma_repl_call_upstream_tool/);
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
  assert.equal(json.result.diagramId, "abc123");
  assert.equal(json.text, undefined);
  assert.equal(json.raw, undefined);

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
  assert.deepEqual(calls.map((call) => call[0]), ["connect", "listTools", "callTool"]);
  await mcpClient.close();
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
    /Tool argument "upstreamArguments" must be an object\./,
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
      name: "figma_repl_apply_asset_manifest",
      arguments: {
        title: "Reject asset aliases",
        assets: [{ filePath: 123, targetNodeId: "12:34" }],
      },
    }),
    /Tool argument "assets\[0\]\.filePath" must be a string\./,
  );
  await assert.rejects(
    mcpClient.callTool({
      name: "figma_repl_capture_node",
      arguments: {
        title: "Reject capture alias",
        nodeId: 123,
      },
    }),
    /Tool argument "nodeId" must be a string\./,
  );
  await assert.rejects(
    mcpClient.callTool({
      name: "figma_repl_prepare_task",
      arguments: {
        title: "Reject prepare taskDir alias",
        taskDir: 123,
      },
    }),
    /Tool argument "taskDir" must be a string\./,
  );
  await assert.rejects(
    mcpClient.callTool({
      name: "figma_repl_prepare_task",
      arguments: {
        title: "Reject prepare scriptName alias",
        scriptName: 123,
      },
    }),
    /Tool argument "scriptName" must be a string\./,
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

test("figma REPL applies asset manifests through explicit fake upstream schemas", async () => {
  const tempDir = await mkdtemp(resolve(tmpdir(), "figma-repl-assets-"));
  const assetPath = resolve(tempDir, "hero.png");
  const resultFile = resolve(tempDir, "asset-result.json");
  await writeFile(assetPath, "fake image bytes", "utf8");
  const calls = [];
  const fakeClient = createFakeFigmaClient(
    calls,
    ({ name, args }) => {
      assert.equal(name, "fake_upload_asset");
      assert.deepEqual(args, {
        file: assetPath,
        target: "12:34",
        label: "Hero art",
        meta: { role: "background" },
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
          name: "fake_upload_asset",
          description: "Fake upload tool.",
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

    const result = await mcpClient.callTool({
      name: "figma_repl_apply_asset_manifest",
      arguments: {
        title: "Apply assets",
        assets: [
          {
            path: assetPath,
            targetNodeId: "12:34",
            name: "Hero art",
            metadata: { role: "background" },
          },
        ],
        toolName: "fake_upload_asset",
        argumentsTemplate: {
          file: "{{path}}",
          target: "{{targetNodeId}}",
          label: "{{name}}",
          meta: "{{metadata}}",
        },
        resultFile,
      },
    });
    const json = structuredToolResult(result);
    assert.equal(json.ok, true);
    assert.equal(json.assets.length, 1);
    assert.equal(json.assets[0].toolName, "fake_upload_asset");
    assert.equal(json.assets[0].result.result.result.summary, "asset filled");
    assert.equal(json.assets[0].result.result.result.payload.length, 2_000);
    assert.equal(json.failures, undefined);
    assertFilePointer(json.outputFiles.resultFile, resultFile);
    const fileJson = await readPrettyJsonPointer(json.outputFiles.resultFile, resultFile);
    assert.equal(fileJson.outputFiles, undefined);
    assert.equal(fileJson.assets[0].result.result.result.summary, "asset filled");
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
      if (name === "fake_upload_asset") {
        assert.deepEqual(args, { file: assetPath, target: "12:34" });
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
        { name: "fake_upload_asset", description: "Fake upload tool.", inputSchema: { type: "object", properties: {} } },
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

    const result = await mcpClient.callTool({
      name: "figma_repl_apply_asset_manifest",
      arguments: {
        title: "Apply and validate assets",
        assets: [{ path: assetPath, targetNodeId: "12:34" }],
        toolName: "fake_upload_asset",
        argumentsTemplate: { file: "{{path}}", target: "{{targetNodeId}}" },
      },
    });
    const json = structuredToolResult(result);
    assert.equal(json.ok, true);
    assert.equal(json.validation.ok, true);
    assert.equal(json.validation.validCount, 1);
    assert.equal(json.assets[0].validation.status, "valid");
    assert.deepEqual(calls.map((call) => call[0]), ["connect", "listTools", "callTool", "callTool"]);
    assert.deepEqual(calls.filter((call) => call[0] === "callTool").map((call) => call[1]), ["fake_upload_asset", "use_figma"]);
    await mcpClient.close();
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("figma REPL submits local bytes when upload_assets returns a submit URL", async () => {
  const tempDir = await mkdtemp(resolve(tmpdir(), "figma-repl-upload-assets-"));
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
        title: "Open upload file context",
        sessionId: "upload",
        connect: false,
        fileUrl: "https://www.figma.com/design/file123/Test",
        handles: { "$iconTarget": "12:34" },
      },
    });
    const result = await mcpClient.callTool({
      name: "figma_repl_apply_asset_manifest",
      arguments: {
        title: "Apply upload asset",
        sessionId: "upload",
        assets: [{ path: assetPath, targetHandle: "$iconTarget", name: "Icon" }],
        toolName: "upload_assets",
      },
    });
    const json = structuredToolResult(result);
    assert.equal(json.ok, true);
    assert.equal(json.assets[0].result.upload.ok, true);
    assert.equal(json.assets[0].result.upload.response.placedOnNodeId, "12:34");
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

test("figma REPL captures node screenshot responses to a local file", async () => {
  const tempDir = await mkdtemp(resolve(tmpdir(), "figma-repl-capture-"));
  const outputFile = resolve(tempDir, "node.png");
  const calls = [];
  const fakeClient = createFakeFigmaClient(
    calls,
    ({ name, args }) => {
      assert.equal(name, "fake_screenshot");
      assert.deepEqual(args, { id: "22:7", scale: 2 });
      return {
        content: [
          {
            type: "image",
            mimeType: "image/png",
            data: Buffer.from("fake png").toString("base64"),
          },
        ],
      };
    },
    {
      tools: [
        {
          name: "fake_screenshot",
          description: "Fake screenshot tool.",
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

    const result = await mcpClient.callTool({
      name: "figma_repl_capture_node",
      arguments: {
        title: "Capture node",
        nodeId: "22:7",
        outputFile,
        toolName: "fake_screenshot",
        argumentsTemplate: {
          id: "{{nodeId}}",
          scale: 2,
        },
      },
    });
    const json = structuredToolResult(result);
    assert.equal(json.ok, true);
    assert.equal(json.file, outputFile);
    assertFilePointer(json.outputFiles.outputFile, outputFile, { bytes: Buffer.byteLength("fake png", "utf8"), lineCount: 0 });
    assert.equal(json.nodeId, "22:7");
    assert.equal(json.toolName, "fake_screenshot");
    assert.equal(json.mimeType, "image/png");
    assert.equal(await readFile(outputFile, "utf8"), "fake png");
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
  const pngBytes = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=",
    "base64",
  );
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
      assert.equal(name, "fake_screenshot");
      assert.deepEqual(args, { id: "22:8" });
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
          name: "fake_screenshot",
          description: "Fake screenshot tool.",
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

    const result = await mcpClient.callTool({
      name: "figma_repl_capture_node",
      arguments: {
        title: "Capture node",
        nodeId: "22:8",
        outputFile,
        toolName: "fake_screenshot",
        argumentsTemplate: {
          id: "{{nodeId}}",
        },
      },
    });
    const json = structuredToolResult(result);
    assert.equal(json.ok, true);
    assert.equal(json.file, outputFile);
    assertFilePointer(json.outputFiles.outputFile, outputFile, { bytes: pngBytes.byteLength, lineCount: 0 });
    assert.equal(json.nodeId, "22:8");
    assert.equal(json.kind, "image");
    assert.equal(json.mimeType, "image/png");
    assert.equal(json.bytes, pngBytes.byteLength);
    assert.equal(json.width, 1);
    assert.equal(json.height, 1);
    assert.equal(json.sourceUrl, "https://example.test/capture.png");
    assert.deepEqual(await readFile(outputFile), pngBytes);
    assert.deepEqual(json.qa, { ok: false, warnings: ["image payload is very small", "image dimensions are very small"] });
    assert.deepEqual(fetches, ["https://example.test/capture.png"]);
    assert.deepEqual(calls.map((call) => call[0]), ["connect", "listTools", "callTool"]);
    await mcpClient.close();
  } finally {
    globalThis.fetch = originalFetch;
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("figma REPL capture node injects session file key when upstream schema needs it", async () => {
  const tempDir = await mkdtemp(resolve(tmpdir(), "figma-repl-capture-filekey-"));
  const outputFile = resolve(tempDir, "node.png");
  const calls = [];
  const fakeClient = createFakeFigmaClient(
    calls,
    ({ name, args }) => {
      assert.equal(name, "fake_screenshot");
      assert.deepEqual(args, {
        nodeId: "22:9",
        fileKey: "EctrdKKdR3c8JTPl55qn3r",
      });
      return {
        content: [
          {
            type: "image",
            mimeType: "image/png",
            data: Buffer.from("fake png").toString("base64"),
          },
        ],
      };
    },
    {
      tools: [
        {
          name: "fake_screenshot",
          description: "Fake screenshot tool.",
          inputSchema: {
            type: "object",
            properties: {
              nodeId: { type: "string" },
              fileKey: { type: "string" },
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
        title: "Open file context",
        sessionId: "capture-filekey",
        connect: false,
        fileUrl: "https://www.figma.com/design/EctrdKKdR3c8JTPl55qn3r/Untitled",
        handles: { "$hero": "22:9" },
      },
    });
    const result = await mcpClient.callTool({
      name: "figma_repl_capture_node",
      arguments: {
        title: "Capture node",
        sessionId: "capture-filekey",
        target: { handle: "$hero" },
        outputFile,
        toolName: "fake_screenshot",
      },
    });
    const json = structuredToolResult(result);
    assert.equal(json.ok, true);
    assert.equal(json.file, outputFile);
    assertFilePointer(json.outputFiles.outputFile, outputFile, { bytes: Buffer.byteLength("fake png", "utf8"), lineCount: 0 });
    assert.deepEqual(calls.map((call) => call[0]), ["connect", "listTools", "callTool"]);
    await mcpClient.close();
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
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
        resultFile,
        steps: [
          {
            id: "dry-run",
            type: "figma_repl_run_script_file",
            scriptPath,
            dryRun: true,
          },
          {
            id: "upstream-ok",
            type: "upstream",
            toolName: "fake_upstream_ok",
            arguments: { marker: "ok" },
          },
          {
            id: "upstream-fail",
            type: "figma_repl_call_upstream_tool",
            toolName: "fake_upstream_fail",
            arguments: { marker: "fail" },
          },
          {
            id: "after-stop",
            type: "upstream-tool",
            toolName: "fake_after_stop",
            arguments: {},
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

test("figma REPL task plans resolve workspace-relative step files consistently", async () => {
  const tempDir = await mkdtemp(resolve(tmpdir(), "figma-repl-plan-workspace-"));
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
      if (name === "fake_asset") {
        assert.equal(args.nodeId, "11:22");
        assert.match(args.path, /asset\.png$/);
        return {
          content: [{ type: "text", text: JSON.stringify({ ok: true, placedOnNodeId: args.nodeId }) }],
        };
      }
      if (name === "fake_screenshot") {
        assert.deepEqual(args, { id: "11:22" });
        return {
          content: [
            {
              type: "image",
              mimeType: "image/png",
              data: Buffer.from("workspace capture").toString("base64"),
            },
          ],
        };
      }
      if (name === "fake_reference") {
        assert.match(args.assetResult, /asset\.assets\.result\.json$/u);
        assert.match(args.captureOutput, /capture\.png$/u);
        return {
          content: [{ type: "text", text: JSON.stringify({ ok: true, result: { summary: "referenced outputs" } }) }],
        };
      }
      throw new Error(`unexpected tool ${name}`);
    },
    {
      tools: [
        { name: "fake_asset", inputSchema: { type: "object", properties: {} } },
        { name: "fake_screenshot", inputSchema: { type: "object", properties: {} } },
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
        fileKey: "file123",
        intent: "Workspace Plan",
        expectedSurface: "design",
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
            inputFile: "workspace-plan.figma.js",
          },
          {
            id: "asset",
            type: "asset-manifest",
            assets: [{ path: "asset.png", targetNodeId: "{{steps.script.result.result.assetTargets.central}}" }],
            toolName: "fake_asset",
            argumentsTemplate: { path: "{{path}}", nodeId: "{{targetNodeId}}" },
          },
          {
            id: "capture",
            type: "screenshot-capture",
            nodeId: "{{steps.script.result.result.captureTarget}}",
            toolName: "fake_screenshot",
            argumentsTemplate: { id: "{{nodeId}}" },
          },
          {
            id: "reference",
            type: "upstream-tool",
            toolName: "fake_reference",
            arguments: {
              assetResult: "{{outputs.asset.resultFile.path}}",
              captureOutput: "{{steps.capture.outputFiles.outputFile.path}}",
            },
          },
        ],
      },
    });
    const json = structuredToolResult(result);
    assert.equal(json.ok, true);
    assertFilePointer(json.outputFiles.resultFile, resolve(fileDir, "run-workspace-plan.plan.result.json"));
    const planFile = await readPrettyJsonPointer(json.outputFiles.resultFile, resolve(fileDir, "run-workspace-plan.plan.result.json"));
    assert.equal(planFile.outputFiles, undefined);
    assert.deepEqual(json.steps.map((step) => step.status), ["completed", "completed", "completed", "completed"]);
    assert.match(json.outputReferences.asset.resultFile.path, /asset\.assets\.result\.json$/u);
    assert.match(json.outputReferences.capture.outputFile.path, /capture\.png$/u);
    assert.equal(JSON.parse(await readFile(resolve(fileDir, "script.result.json"), "utf8")).result.result.assetTargets.central, "11:22");
    assert.equal(JSON.parse(await readFile(resolve(fileDir, "asset.assets.result.json"), "utf8")).ok, true);
    const captureFile = JSON.parse(await readFile(resolve(fileDir, "capture.capture.result.json"), "utf8"));
    assert.equal(captureFile.file, resolve(fileDir, "capture.png"));
    assert.equal(captureFile.outputFiles, undefined);
    assert.equal(await readFile(resolve(fileDir, "capture.png"), "utf8"), "workspace capture");
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
        expectedSurface: "design",
        outputDir,
        inlineResultLimit: 1_000_000,
      },
    });
    const json = structuredToolResult(result);
    assert.equal(json.ok, true);
    assert.equal(json.dryRun, true);
    assert.equal(json.script.scriptPath, scriptPath);
    assert.equal(json.script.sourceLineCount, 3);
    assert.equal(json.script.executed, false);
    assert.equal(json.compiledScript, undefined);
    assert.equal(json.diagnostics[0].code, "FIGMA_REPL_TEXT_MUTATION_NEEDS_FONT");
    assert.equal(json.diagnostics[0].source.scriptPath, scriptPath);
    assert.equal(json.diagnostics[0].source.line, 2);
    assert.equal(json.diagnostics[0].source.column, 1);
    const resultFile = await readPrettyJsonPointer(json.outputFiles.resultFile, resolve(outputDir, "result.json"));
    const diagnosticsFile = await readPrettyJsonPointer(json.outputFiles.diagnosticsFile, resolve(outputDir, "diagnostics.json"));
    const summaryFile = await readTextPointer(json.outputFiles.summaryFile, resolve(outputDir, "summary.md"));
    assert.equal(resultFile.dryRun, true);
    assert.equal(resultFile.compiledScript, undefined);
    assert.equal(resultFile.raw, undefined);
    assert.equal(json.outputFiles.resultFile.rawBytes, undefined);
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
        expectedSurface: "design",
      },
    });
    const json = structuredToolResult(result);
    assert.equal(json.ok, true);
    assert.equal(json.script.executed, true);
    assert.equal(json.script.targetPageId, "0:1");
    assert.ok(json.script.injectedHelpers.includes("$.checkpoint"));
    assert.ok(json.script.injectedHelpers.includes("$.create"));
    assert.ok(json.script.injectedHelpers.includes("$.text"));
    assert.ok(json.script.injectedHelpers.includes("$.layout"));
    assert.equal(json.script.injectedHelpers.includes("$.find"), false);
    assert.equal(json.result.result.resized.width, 360);
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
        expectedSurface: "design",
      },
    });
    const json = structuredToolResult(result);
    assert.equal(json.ok, true);
    assert.deepEqual(json.script.injectedHelpers, []);
    assert.ok(json.script.compiledScriptBytes < 15_000);
    assert.equal(json.result.result.name, "Native frame");
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
        expectedSurface: "design",
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
          expectedSurface: "design",
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
        expectedSurface: "design",
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
        expectedSurface: "design",
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
      },
    });
    const json = structuredToolResult(result);
    assert.equal(json.ok, false);
    assert.equal(json.upstreamError.code, "FIGMA_INSTANCE_CHILD_REMOVE");
    assert.match(json.upstreamError.message, /instance subtree/);
    assert.match(json.primaryFix, /\$\.cloneNodeTree/);
    assert.equal(json.compiledScript, undefined);
    assert.equal(json.raw, undefined);
    const resultFile = await readPrettyJsonPointer(json.outputFiles.resultFile, resolve(outputDir, "result.json"));
    const compiledFilePath = resolve(outputDir, "result.failure.compiled.js");
    const compiledFile = await readTextPointer(json.outputFiles.compiledScriptFile, compiledFilePath);
    const summaryFile = await readTextPointer(json.outputFiles.summaryFile, resolve(outputDir, "summary.md"));
    assert.equal(resultFile.ok, false);
    assert.equal(resultFile.compiledScript, undefined);
    assert.deepEqual(resultFile.raw, {
      ok: false,
      error: {
        code: "FIGMA_INSTANCE_CHILD_REMOVE",
        message: "Cannot remove children inside an instance subtree.",
      },
    });
    assert.equal(json.outputFiles.resultFile.rawBytes, Buffer.byteLength(JSON.stringify(resultFile.raw), "utf8"));
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
    assert.equal(json.upstreamError.code, "FIGMA_UPSTREAM_TEXT_ERROR");
    assert.match(json.upstreamError.message, /set_selection/);
    assert.equal(json.upstreamError.details.debugUuid, "59c9dee0-3819-4e15-9a9e-a4a37a71072d");
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
        resultFile: "full-result.json",
        inlineResultLimit: 40,
      },
    });
    const json = structuredToolResult(result);
    assert.equal(json.ok, true);
    assert.equal(json.result, undefined);
    assert.equal(json.text, undefined);
    assert.equal(json.raw, undefined);
    assert.deepEqual(
      json.inlineResultLimit.omitted.map((item) => item.field),
      ["result"],
    );
    const resultFile = await readPrettyJsonPointer(json.outputFiles.resultFile, resolve(outputDir, "full-result.json"));
    const summaryFile = await readTextPointer(json.outputFiles.summaryFile, resolve(outputDir, "summary.md"));
    assert.equal(resultFile.result.result.payload.length, 200);
    assert.deepEqual(resultFile.raw, {
      ok: true,
      result: {
        summary: "large result",
        payload: "x".repeat(200),
      },
    });
    assert.equal(json.outputFiles.resultFile.rawBytes, Buffer.byteLength(JSON.stringify(resultFile.raw), "utf8"));
    assert.match(summaryFile, /resultSummary: large result/);
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
        intent: "Settings Panel Polish",
        fileUrl: "https://www.figma.com/design/ExampleFigmaFileKey012/UI?node-id=1-2",
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
    assert.equal(initJson.task.intentSlug, "settings-panel-polish");
    assert.equal(initJson.task.workspace.fileDir, resolve(tempDir, "figma-mcp", "ExampleFigmaFileKey012"));
    assert.equal(initJson.task.workspace.sessionDir, initJson.task.workspace.fileDir);
    assert.equal(initJson.task.workspace.files.script, "settings-panel-polish.figma.js");
    assert.equal(initJson.task.workspace.files.result, "settings-panel-polish.result.json");

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
    assert.equal(json.session.workspace.fileContext, "ExampleFigmaFileKey012");
    assert.deepEqual(json.session.workspace.files, initJson.task.workspace.files);
    assert.equal(json.session.workspace.sessionDir, initJson.task.workspace.sessionDir);
    assert.equal(json.session.surface, "design");
    assertFilePointer(json.outputFiles.resultFile, resolve(initJson.task.workspace.fileDir, "settings-panel-polish.result.json"));
    assert.equal(json.result, undefined);
    const resultFile = await readPrettyJsonPointer(json.outputFiles.resultFile, resolve(initJson.task.workspace.fileDir, "settings-panel-polish.result.json"));
    assert.equal(resultFile.result.result.payload.length, 160);

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
        title: "Prepare another intent",
        sessionId: "settings-workspace",
        intent: "Token Audit",
        goal: "Audit local color tokens",
        expectedSurface: "design",
        overwrite: true,
      },
    });
    const preparedJson = structuredToolResult(prepared);
    assert.equal(preparedJson.task.fileContext, "ExampleFigmaFileKey012");
    assert.equal(preparedJson.task.workspace.fileKey, "ExampleFigmaFileKey012");
    assert.equal(preparedJson.task.intentSlug, "token-audit");
    assert.equal(preparedJson.task.scriptPath, resolve(initJson.task.workspace.fileDir, "token-audit.figma.js"));
    assertFilePointer(preparedJson.task.resultFile, resolve(initJson.task.workspace.fileDir, "token-audit.result.json"));

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
        taskDir: workspaceDir,
        fileName: "settings-panel.figma.js",
        goal: "Create a settings panel",
        expectedSurface: "design",
        targetPageId: "0:1",
      },
    });
    const json = structuredToolResult(result);
    assert.equal(json.ok, true);
    assert.equal(json.task.workspaceDir, workspaceDir);
    assert.equal(json.task.taskDir, workspaceDir);
    assert.equal(json.task.scriptPath, resolve(workspaceDir, "settings-panel.figma.js"));
    assertFilePointer(json.task.resultFile, resolve(workspaceDir, "settings-panel.result.json"));
    assert.match(await readFile(json.task.scriptPath, "utf8"), /\$\.checkpoint/);
    assert.match(await readFile(json.task.scriptPath, "utf8"), /Goal: Create a settings panel/);
    const pendingResult = await readPrettyJsonPointer(json.task.resultFile, resolve(workspaceDir, "settings-panel.result.json"));
    assert.equal(pendingResult.status, "pending");

    await assert.rejects(
      mcpClient.callTool({
        name: "figma_repl_prepare_task",
        arguments: {
          title: "Refuse overwrite",
          taskSlug: "settings-panel",
          taskDir: workspaceDir,
        },
      }),
      /Refusing to overwrite/,
    );
    await assert.rejects(
      mcpClient.callTool({
        name: "figma_repl_prepare_task",
        arguments: {
          title: "Reject relative workspace",
          taskDir: "relative-workspace",
        },
      }),
      /taskDir\/workspaceDir" must be an absolute path/,
    );
    await assert.rejects(
      mcpClient.callTool({
        name: "figma_repl_prepare_task",
        arguments: {
          title: "Reject absolute script name",
          taskDir: resolve(tempDir, "other"),
          fileName: resolve(tempDir, "bad.figma.js"),
        },
      }),
      /fileName\/scriptName" must be a file name/,
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
  assert.doesNotMatch(cardResult.content[0].text, /text|Read text card|loadFontAsync/);

  const planResult = await mcpClient.callTool({
    name: "figma_repl_guidance",
    arguments: {
      title: "Plan file workflow",
      mode: "plan",
      goal: "Create a settings card with title and button",
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
      title: "Plan long goal",
      mode: "plan",
      goal: `Create a settings card with title and button ${"using polished layout details ".repeat(8)}`,
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
    json.result.result.validations.map((item) => item.status),
    ["valid", "missing", "stale"],
  );
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
    fileUrl: "https://www.figma.com/design/ExampleFigmaFileKey012/UI?node-id=1-2",
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
  assert.equal(result.result.result.summary, "read current page");
  assert.deepEqual(calls.map((call) => call[0]), ["connect", "listTools", "callTool"]);
});

test("figma REPL programmatic client returns typed script and upstream payloads", async () => {
  const tempDir = await mkdtemp(resolve(tmpdir(), "figma-repl-client-typed-"));
  const scriptPath = resolve(tempDir, "typed-client.figma.js");
  await writeFile(scriptPath, "return { summary: 'typed dry run' };", "utf8");
  const calls = [];
  const fakeClient = createFakeFigmaClient(
    calls,
    ({ name, args }) => {
      assert.equal(name, "fake_upstream");
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
    },
    {
      tools: [
        { name: "fake_upstream", inputSchema: { type: "object", properties: {} } },
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
    assert.equal(upstreamResult.result.result.summary, "typed upstream");
    assert.equal("content" in upstreamResult, false);
    assert.deepEqual(calls.map((call) => call[0]), ["connect", "listTools", "callTool"]);
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
