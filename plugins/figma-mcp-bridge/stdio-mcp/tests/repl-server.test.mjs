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

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

test("figma REPL eval wraps code and persists returned handles", async () => {
  const calls = [];
  const fakeClient = createFakeFigmaClient(calls, ({ name, args }) => {
    assert.equal(name, "use_figma");
    assert.equal(typeof args.code, "string");
    assert.match(args.code, /async function \$\(nameOrId\)/);
    assert.match(args.code, /const read = \(key\) => key in node/);
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
  const evalJson = JSON.parse(evalResult.content[0].text);
  assert.equal(evalJson.ok, true);
  assert.equal(evalJson.session.handles.$card, "12:34");
  assert.equal(evalJson.upstreamTool, "use_figma");
  assert.equal(evalJson.upstreamArgument, "code");

  const cacheResult = await mcpClient.callTool({
    name: "figma_repl_cache_get",
    arguments: {
      title: "Read local session cache",
      sessionId: "main",
    },
  });
  const cacheJson = JSON.parse(cacheResult.content[0].text);
  assert.equal(cacheJson.session.handles.$card, "12:34");
  assert.equal(cacheJson.session.history.length, 1);

  assert.deepEqual(calls.map((call) => call[0]), ["connect", "listTools", "callTool"]);
  await mcpClient.close();
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

  const capabilitiesResult = await mcpClient.callTool({
    name: "figma_repl_capabilities",
    arguments: { title: "Read capabilities" },
  });
  const capabilities = JSON.parse(capabilitiesResult.content[0].text);
  assert.equal(capabilities.ok, true);
  assert.ok(capabilities.guide);
  assert.equal(capabilities.ops, undefined);
  assert.ok(capabilities.patterns);
  assert.ok(capabilities.scriptWorkflow);
  assert.ok(capabilities.fileWorkflow);
  assert.ok(capabilities.workflowTools);
  assert.ok(capabilities.apiCards);
  assert.ok(capabilities.intents);
  assert.ok(capabilities.safety);
  assert.ok(capabilities.facadeRoutingDelegationBoundaries);
  assert.ok(capabilities.docsLookup);
  assert.match(capabilities.guide.purpose, /Unified Figma-facing MCP facade/);
  assert.ok(capabilities.guide.preferredFlow.includes("figma_repl_call_upstream_tool for official capabilities not covered by the file workflow"));
  assert.equal(capabilities.scriptWorkflow.primaryTool, "figma_repl_run_script_file");
  assert.equal(capabilities.fileWorkflow.primaryTool, "figma_repl_run_script_file");
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
  assert.match(capabilities.scriptWorkflow.helpers["$.imageAsset"], /image-fill rectangle/);
  assert.match(capabilities.scriptWorkflow.helpers["$.screenshot"], /final QA/);
  assert.equal(capabilities.scriptWorkflow.helpers["$.ops"], undefined);
  assert.match(capabilities.scriptWorkflow.helpers["$.checkpoint"], /summaries/);
  assert.ok(capabilities.examples);
  assert.equal(JSON.stringify(capabilities).includes("figma_repl_apply_ops"), false);
  assert.equal(JSON.stringify(capabilities).includes("$.ops"), false);
  assert.ok(capabilities.examples.every((example) => JSON.stringify(example)));

  const tools = await mcpClient.listTools();
  assert.equal(
    tools.tools.some((tool) => tool.name === "figma_repl_apply_ops"),
    false,
  );
  assert.ok(tools.tools.some((tool) => tool.name === "figma_repl_apply_asset_manifest"));
  assert.ok(tools.tools.some((tool) => tool.name === "figma_repl_capture_node"));
  assert.ok(tools.tools.some((tool) => tool.name === "figma_repl_run_task_plan"));

  const resources = await mcpClient.listResources();
  const uris = resources.resources.map((resource) => resource.uri);
  assert.ok(uris.includes("figma-repl://guide"));
  assert.equal(uris.includes("figma-repl://ops"), false);
  assert.ok(uris.includes("figma-repl://patterns"));
  assert.ok(uris.includes("figma-repl://scripts"));
  assert.ok(uris.includes("figma-repl://file-workflow"));
  assert.ok(uris.includes("figma-repl://workflow-tools"));
  assert.ok(uris.includes("figma-repl://api-cards"));
  assert.ok(uris.includes("figma-repl://intents"));
  assert.ok(uris.includes("figma-repl://safety"));
  assert.ok(uris.includes("figma-repl://docs"));
  assert.ok(uris.includes("figma-repl://api"));
  assert.ok(uris.includes("figma-repl://sessions"));

  const scriptsResource = await mcpClient.readResource({ uri: "figma-repl://scripts" });
  const scripts = JSON.parse(scriptsResource.contents[0].text);
  assert.equal(scripts.primaryTool, "figma_repl_run_script_file");
  assert.match(scripts.options.scriptPath, /Absolute path escape hatch/);

  const workflowResource = await mcpClient.readResource({ uri: "figma-repl://file-workflow" });
  const workflow = JSON.parse(workflowResource.contents[0].text);
  assert.equal(workflow.prepareTool, "figma_repl_prepare_task");
  assert.equal(workflow.helpers.includes("$.ops"), false);
  assert.ok(workflow.helpers.includes("$.cloneNodeTree"));
  assert.ok(workflow.workflowTools.includes("figma_repl_apply_asset_manifest"));

  const workflowToolsResource = await mcpClient.readResource({ uri: "figma-repl://workflow-tools" });
  const workflowTools = JSON.parse(workflowToolsResource.contents[0].text);
  assert.equal(workflowTools.assetManifest.tool, "figma_repl_apply_asset_manifest");
  assert.match(workflowTools.assetManifest.defaults, /explicit toolName/);
  assert.equal(workflowTools.capture.tool, "figma_repl_capture_node");

  const cardsResource = await mcpClient.readResource({ uri: "figma-repl://api-cards" });
  const cards = JSON.parse(cardsResource.contents[0].text);
  assert.ok(cards.cards.some((card) => card.id === "text"));

  const intentsResource = await mcpClient.readResource({ uri: "figma-repl://intents" });
  const intents = JSON.parse(intentsResource.contents[0].text);
  assert.equal(intents.tool, "figma_repl_suggest_api");

  const docsResource = await mcpClient.readResource({ uri: "figma-repl://docs" });
  const docs = JSON.parse(docsResource.contents[0].text);
  assert.equal(docs.tool, "figma_repl_docs_search");

  const apiResource = await mcpClient.readResource({ uri: "figma-repl://api" });
  const api = JSON.parse(apiResource.contents[0].text);
  assert.equal(api.tool, "figma_repl_api_lookup");
  assert.match(api.guardrail, /never returned/);
  assert.deepEqual(calls.map((call) => call[0]), []);
  await mcpClient.close();
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
  const json = JSON.parse(result.content[0].text);
  assert.equal(json.ok, true);
  assert.equal(json.toolName, "generate_diagram");
  assert.equal(json.result.diagramId, "abc123");
  assert.ok(json.raw);

  await assert.rejects(
    mcpClient.callTool({
      name: "figma_repl_call_upstream_tool",
      arguments: {
        title: "Reject local",
        toolName: "figma_repl_eval",
        arguments: {},
      },
    }),
    /Refusing to proxy local figma-repl-mcp tool/,
  );
  assert.deepEqual(calls.map((call) => call[0]), ["connect", "listTools", "callTool"]);
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
    const json = JSON.parse(result.content[0].text);
    assert.equal(json.ok, true);
    assert.equal(json.assets.length, 1);
    assert.equal(json.assets[0].toolName, "fake_upload_asset");
    assert.equal(json.assets[0].result.summary, "asset filled");
    assert.equal(json.assets[0].result.payload, undefined);
    assert.deepEqual(json.failures, []);
    assert.equal(json.files.resultFile, resultFile);
    const fileJson = JSON.parse(await readFile(resultFile, "utf8"));
    assert.equal(fileJson.assets[0].result.summary, "asset filled");
    assert.equal(JSON.stringify(fileJson).includes("x".repeat(200)), false);
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
    const json = JSON.parse(result.content[0].text);
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
    const result = await mcpClient.callTool({
      name: "figma_repl_apply_asset_manifest",
      arguments: {
        title: "Apply upload asset",
        assets: [{ path: assetPath, targetNodeId: "12:34", name: "Icon" }],
        toolName: "upload_assets",
        argumentsTemplate: {
          fileKey: "file123",
          count: 1,
          nodeId: "{{targetNodeId}}",
          scaleMode: "FILL",
        },
      },
    });
    const json = JSON.parse(result.content[0].text);
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
    const json = JSON.parse(result.content[0].text);
    assert.equal(json.ok, true);
    assert.equal(json.file, outputFile);
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
    const json = JSON.parse(result.content[0].text);
    assert.equal(json.ok, true);
    assert.equal(json.file, outputFile);
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
            type: "script-file",
            scriptPath,
            dryRun: true,
          },
          {
            id: "upstream-ok",
            type: "upstream-tool",
            toolName: "fake_upstream_ok",
            arguments: { marker: "ok" },
          },
          {
            id: "upstream-fail",
            type: "upstream-tool",
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
    const json = JSON.parse(result.content[0].text);
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
      throw new Error(`unexpected tool ${name}`);
    },
    {
      tools: [
        { name: "fake_asset", inputSchema: { type: "object", properties: {} } },
        { name: "fake_screenshot", inputSchema: { type: "object", properties: {} } },
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
      name: "figma_repl_init_workspace",
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
    const initJson = JSON.parse(initResult.content[0].text);
    const fileDir = initJson.workspace.fileDir;
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
            dryRun: true,
          },
          {
            id: "asset",
            type: "asset-manifest",
            assets: [{ path: "asset.png", targetNodeId: "11:22" }],
            toolName: "fake_asset",
            argumentsTemplate: { path: "{{path}}", nodeId: "{{targetNodeId}}" },
          },
          {
            id: "capture",
            type: "screenshot-capture",
            nodeId: "11:22",
            toolName: "fake_screenshot",
            argumentsTemplate: { id: "{{nodeId}}" },
          },
        ],
      },
    });
    const json = JSON.parse(result.content[0].text);
    assert.equal(json.ok, true);
    assert.equal(json.files.resultFile, resolve(fileDir, "run-workspace-plan.plan.result.json"));
    assert.deepEqual(json.steps.map((step) => step.status), ["completed", "completed", "completed"]);
    assert.equal(JSON.parse(await readFile(resolve(fileDir, "script.result.json"), "utf8")).dryRun, true);
    assert.equal(JSON.parse(await readFile(resolve(fileDir, "asset.assets.result.json"), "utf8")).ok, true);
    assert.equal(JSON.parse(await readFile(resolve(fileDir, "capture.capture.result.json"), "utf8")).file, resolve(fileDir, "capture.png"));
    assert.equal(await readFile(resolve(fileDir, "capture.png"), "utf8"), "workspace capture");
    await mcpClient.close();
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("figma REPL docs_search returns capped local reference snippets", async () => {
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
    name: "figma_repl_docs_search",
    arguments: {
      title: "Search docs",
      query: "component properties",
      maxResults: 2,
      maxSnippetLines: 2,
    },
  });
  const json = JSON.parse(result.content[0].text);
  assert.equal(json.ok, true);
  assert.equal(json.results.length <= 2, true);
  assert.ok(json.results.length > 0);
  for (const item of json.results) {
    assert.equal(typeof item.file, "string");
    assert.equal(typeof item.lineStart, "number");
    assert.equal(item.snippet.split("\n").length <= 2, true);
    assert.doesNotMatch(item.file, /plugin-api-standalone\.d\.ts$/);
  }
  assert.deepEqual(calls.map((call) => call[0]), []);
  await mcpClient.close();
});

test("figma REPL api_lookup returns targeted Plugin API snippets without dumping d.ts", async () => {
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
    name: "figma_repl_api_lookup",
    arguments: {
      title: "Lookup createFrame",
      symbol: "createFrame",
      maxResults: 4,
      maxSnippetLines: 4,
    },
  });
  const json = JSON.parse(result.content[0].text);
  assert.equal(json.ok, true);
  assert.ok(json.results.length > 0);
  assert.equal(json.results.length <= 4, true);
  assert.match(json.guidance, /never returns the full plugin-api-standalone\.d\.ts/);
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
});

test("figma REPL run_script_file dryRun returns file-aware diagnostics and compiled script", async () => {
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
    const json = JSON.parse(result.content[0].text);
    assert.equal(json.ok, true);
    assert.equal(json.dryRun, true);
    assert.equal(json.script.scriptPath, scriptPath);
    assert.equal(json.script.sourceLineCount, 3);
    assert.equal(json.script.executed, false);
    assert.match(json.compiledScript, /\$\.checkpoint/);
    assert.match(json.compiledScript, /figma_repl_run_script_file source:/);
    assert.equal(json.diagnostics[0].code, "FIGMA_REPL_TEXT_MUTATION_NEEDS_FONT");
    assert.equal(json.diagnostics[0].source.scriptPath, scriptPath);
    assert.equal(json.diagnostics[0].source.line, 2);
    assert.equal(json.outputFiles.resultFile, resolve(outputDir, "result.json"));
    assert.equal(json.outputFiles.diagnosticsFile, resolve(outputDir, "diagnostics.json"));
    assert.equal(json.outputFiles.summaryFile, resolve(outputDir, "summary.md"));
    const resultFile = JSON.parse(await readFile(json.outputFiles.resultFile, "utf8"));
    const diagnosticsFile = JSON.parse(await readFile(json.outputFiles.diagnosticsFile, "utf8"));
    const summaryFile = await readFile(json.outputFiles.summaryFile, "utf8");
    assert.equal(resultFile.dryRun, true);
    assert.equal(diagnosticsFile.count, 1);
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
      `const large = '${"A".repeat(30_000)}';`,
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
    assert.match(args.code, /\$\.findAll = async function findAll/);
    assert.match(args.code, /\$\.select = async function select/);
    assert.doesNotMatch(args.code, /figma\.createImage\(bytes\)/);
    assert.match(args.code, /\$\.screenshot = async function screenshot/);
    assert.match(args.code, /\$\.text = async function text/);
    assert.doesNotMatch(args.code, /\$\.ops = async function ops/);
    assert.match(args.code, /\$\.checkpoint = async function checkpoint/);
    assert.match(args.code, /\$\.inspect = async function inspect/);
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
    const json = JSON.parse(result.content[0].text);
    assert.equal(json.ok, true);
    assert.equal(json.script.executed, true);
    assert.equal(json.script.helperProfile, "auto");
    assert.equal(json.script.helpersIncluded.includes("$.imageAsset"), false);
    assert.equal(json.script.helpersIncluded.includes("$.cloneNodeTree"), false);
    assert.equal(json.script.targetPageId, "0:1");
    assert.equal(json.parsed.result.resized.width, 360);
    assert.equal(json.session.handles.$scriptFrame, "20:1");
    assert.equal(json.session.handles.$scriptTitle, "20:2");
    assert.equal(json.session.history[0].tool, "figma_repl_run_script_file");
    assert.deepEqual(calls.map((call) => call[0]), ["connect", "listTools", "callTool"]);
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
    const json = JSON.parse(result.content[0].text);
    assert.equal(json.ok, true);
    assert.deepEqual(json.diagnostics, []);
    assert.equal(json.script.helpersIncluded.includes("$.imageAsset"), true);
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
  const fakeClient = createFakeFigmaClient(calls, () => ({
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
        title: "Run script with upstream failure",
        scriptPath,
        outputDir,
      },
    });
    const json = JSON.parse(result.content[0].text);
    assert.equal(json.ok, false);
    assert.equal(json.upstreamError.code, "FIGMA_INSTANCE_CHILD_REMOVE");
    assert.match(json.upstreamError.message, /instance subtree/);
    assert.match(json.primaryFix, /\$\.cloneNodeTree/);
    assert.equal(json.outputFiles.resultFile, resolve(outputDir, "result.json"));
    const resultFile = JSON.parse(await readFile(json.outputFiles.resultFile, "utf8"));
    const summaryFile = await readFile(json.outputFiles.summaryFile, "utf8");
    assert.equal(resultFile.ok, false);
    assert.match(summaryFile, /primaryFix:/);
    assert.deepEqual(calls.map((call) => call[0]), ["connect", "listTools", "callTool"]);
    await mcpClient.close();
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("figma REPL run_script_file structures upstream text errors", async () => {
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
    const json = JSON.parse(result.content[0].text);
    assert.equal(json.ok, false);
    assert.equal(json.upstreamError.code, "FIGMA_UPSTREAM_TEXT_ERROR");
    assert.match(json.upstreamError.message, /set_selection/);
    assert.equal(json.upstreamError.details.debugUuid, "59c9dee0-3819-4e15-9a9e-a4a37a71072d");
    assert.match(json.primaryFix, /\$\.select/);
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
        includeRawUpstream: true,
      },
    });
    const json = JSON.parse(result.content[0].text);
    assert.equal(json.ok, true);
    assert.equal(json.parsed, undefined);
    assert.equal(json.text, undefined);
    assert.equal(json.upstream, undefined);
    assert.deepEqual(
      json.inlineResultLimit.omitted.map((item) => item.field),
      ["parsed", "text", "upstream"],
    );
    assert.equal(json.outputFiles.resultFile, resolve(outputDir, "full-result.json"));
    const resultFile = JSON.parse(await readFile(json.outputFiles.resultFile, "utf8"));
    const summaryFile = await readFile(json.outputFiles.summaryFile, "utf8");
    assert.equal(resultFile.parsed.result.payload.length, 200);
    assert.match(summaryFile, /resultSummary: large result/);
    assert.deepEqual(calls.map((call) => call[0]), ["connect", "listTools", "callTool"]);
    await mcpClient.close();
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("figma REPL init_workspace uses file context and intent file pairs", async () => {
  const tempDir = await mkdtemp(resolve(tmpdir(), "figma-repl-workspace-"));
  const calls = [];
  const fakeClient = createFakeFigmaClient(calls, ({ args }) => {
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
      name: "figma_repl_init_workspace",
      arguments: {
        title: "Init workspace",
        sessionId: "settings-workspace",
        intent: "Settings Panel Polish",
        fileUrl: "https://www.figma.com/design/ExampleFigmaFileKey012/UI?node-id=1-2",
        cwd: tempDir,
      },
    });
    const initJson = JSON.parse(initResult.content[0].text);
    assert.equal(initJson.ok, true);
    assert.equal(initJson.session.slug, "settings-workspace");
    assert.equal(initJson.session.fileKey, "ExampleFigmaFileKey012");
    assert.equal(initJson.session.surface, "design");
    assert.equal(initJson.workspace.fileContext, "ExampleFigmaFileKey012");
    assert.equal(initJson.workspace.intentSlug, "settings-panel-polish");
    assert.equal(initJson.workspace.fileDir, resolve(tempDir, "figma-mcp", "ExampleFigmaFileKey012"));
    assert.equal(initJson.workspace.sessionDir, initJson.workspace.fileDir);
    assert.equal(initJson.files.script, "settings-panel-polish.figma.js");
    assert.equal(initJson.files.result, "settings-panel-polish.result.json");

    await writeFile(
      resolve(initJson.workspace.fileDir, "settings-panel-polish.figma.js"),
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
    const json = JSON.parse(result.content[0].text);
    assert.equal(json.ok, true);
    assert.equal(json.session.workspace.sessionDir, initJson.workspace.sessionDir);
    assert.equal(json.session.surface, "design");
    assert.equal(json.outputFiles.resultFile, resolve(initJson.workspace.fileDir, "settings-panel-polish.result.json"));
    assert.equal(json.parsed, undefined);
    const resultFile = JSON.parse(await readFile(json.outputFiles.resultFile, "utf8"));
    assert.equal(resultFile.parsed.result.payload.length, 160);

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
    const preparedJson = JSON.parse(prepared.content[0].text);
    assert.equal(preparedJson.task.fileContext, "ExampleFigmaFileKey012");
    assert.equal(preparedJson.task.workspace.fileKey, "ExampleFigmaFileKey012");
    assert.equal(preparedJson.task.intentSlug, "token-audit");
    assert.equal(preparedJson.task.scriptPath, resolve(initJson.workspace.fileDir, "token-audit.figma.js"));
    assert.equal(preparedJson.task.resultFile, resolve(initJson.workspace.fileDir, "token-audit.result.json"));

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
    const json = JSON.parse(result.content[0].text);
    assert.equal(json.ok, true);
    assert.equal(json.task.workspaceDir, workspaceDir);
    assert.equal(json.task.taskDir, workspaceDir);
    assert.equal(json.task.scriptPath, resolve(workspaceDir, "settings-panel.figma.js"));
    assert.equal(json.task.resultFile, resolve(workspaceDir, "settings-panel.result.json"));
    assert.match(await readFile(json.task.scriptPath, "utf8"), /\$\.checkpoint/);
    assert.match(await readFile(json.task.scriptPath, "utf8"), /Goal: Create a settings panel/);
    assert.equal(JSON.parse(await readFile(json.task.resultFile, "utf8")).status, "pending");

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

test("figma REPL api_card and suggest_api return compact guidance without upstream", async () => {
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
    name: "figma_repl_api_card",
    arguments: {
      title: "Read text card",
      card: "text",
    },
  });
  const cardJson = JSON.parse(cardResult.content[0].text);
  assert.equal(cardJson.ok, true);
  assert.ok(cardJson.cards.some((card) => card.id === "text"));
  assert.match(JSON.stringify(cardJson.cards), /loadFontAsync/);

  const planResult = await mcpClient.callTool({
    name: "figma_repl_plan_task",
    arguments: {
      title: "Plan file workflow",
      goal: "Create a settings card with title and button",
      surface: "design",
      workflow: "script-file",
    },
  });
  const planJson = JSON.parse(planResult.content[0].text);
  assert.equal(planJson.ok, true);
  assert.equal(planJson.plan.surface, "design");
  assert.equal(planJson.plan.workflow, "script-file");
  assert.ok(planJson.plan.recommendedTools.includes("figma_repl_prepare_task"));

  const suggestResult = await mcpClient.callTool({
    name: "figma_repl_suggest_api",
    arguments: {
      title: "Suggest API",
      task: "create component variants with text",
      surface: "design",
    },
  });
  const suggestJson = JSON.parse(suggestResult.content[0].text);
  assert.equal(suggestJson.ok, true);
  assert.ok(suggestJson.suggestions.cards.some((card) => card.id === "components"));
  assert.equal(suggestJson.suggestions.workflow.primaryTool, "figma_repl_run_script_file");
  assert.deepEqual(calls.map((call) => call[0]), []);
  await mcpClient.close();
});

test("figma REPL validate_handles reports valid, missing, and stale", async () => {
  const calls = [];
  const fakeClient = createFakeFigmaClient(calls, ({ args }) => {
    assert.match(args.code, /__requestedHandles/);
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
    name: "figma_repl_validate_handles",
    arguments: {
      title: "Validate handles",
      sessionId: "main",
      handles: ["$valid", "$missing", "$stale"],
    },
  });
  const json = JSON.parse(result.content[0].text);
  assert.deepEqual(
    json.parsed.result.validations.map((item) => item.status),
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
  assert.equal(result.parsed.result.summary, "read current page");
  assert.deepEqual(calls.map((call) => call[0]), ["connect", "listTools", "callTool"]);
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
