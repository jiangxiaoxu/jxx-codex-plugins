import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";
import {
  FIGMA_WORKSPACE_CLI_COMMANDS,
  buildFigmaEvalScript,
  createFigmaWorkspaceClient,
  createFigmaWorkspaceSessionStore,
  diagnoseFigmaWorkspaceCode,
  resolveFigmaWorkspaceScriptHelperSelection,
} from "../dist/index.js";

test("neutral entrypoints expose the typed client and CLI contract", async () => {
  const root = await import("../dist/index.js");
  const workspaceClient = await import("../dist/workspace-client.js");
  assert.equal(typeof root.createFigmaWorkspaceClient, "function");
  assert.equal(typeof workspaceClient.createFigmaWorkspaceClient, "function");
  assert.equal(typeof root.runFigmaWorkspaceCli, "function");
  assert.equal(FIGMA_WORKSPACE_CLI_COMMANDS.length, 22);
  assert.equal("createFigmaWorkspaceMcpServer" in root, false);
});

test("session store clones initial state and caps history", () => {
  const initial = {
    id: "main",
    slug: "main",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    knownPages: { Home: "1:2" },
    handles: { hero: "2:3" },
    lastDiagnostics: [],
    history: [],
  };
  const store = createFigmaWorkspaceSessionStore({ initialSessions: [initial], historyLimit: 2 });
  initial.handles.hero = "changed";
  const session = store.get("main");
  assert.equal(session.handles.hero, "2:3");
  for (let index = 0; index < 3; index += 1) {
    store.rememberHistory(session, {
      id: String(index),
      at: new Date(index).toISOString(),
      tool: "test",
      summary: String(index),
      nodeIds: [],
    });
  }
  assert.deepEqual(store.list()[0].history.map((entry) => entry.id), ["1", "2"]);
});

test("typed client opens a workspace without contacting upstream", async () => {
  const tempDir = await mkdtemp(resolve(tmpdir(), "figma-workspace-client-open-"));
  const calls = [];
  const client = createFigmaWorkspaceClient({ client: createFakeUpstream(calls) });
  try {
    const result = await client.open({
      sessionId: "typed-open",
      file: "https://www.figma.com/design/ExampleFigmaFileKey012/UI?node-id=1-2",
      workspaceDir: tempDir,
      connect: false,
    });
    assert.equal(result.ok, true);
    assert.equal(result.session.id, "typed-open");
    assert.equal(result.session.fileKey, "ExampleFigmaFileKey012");
    assert.deepEqual(calls, []);
    assert.equal(client.sessions.get("typed-open").workspace.fileDir, resolve(tempDir, "ExampleFigmaFileKey012"));
  } finally {
    await client.close();
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("typed eval delegates through use_figma and returns compact output", async () => {
  const calls = [];
  const upstream = createFakeUpstream(calls, ({ name, args }) => {
    assert.equal(name, "use_figma");
    assert.equal(typeof args.code, "string");
    assert.match(args.code, /figma\.currentPage/u);
    return {
      content: [{
        type: "text",
        text: JSON.stringify({
          ok: true,
          __figmaRepl: { sessionId: "main", handles: { selected: "1:2" } },
          result: { selected: "1:2" },
        }),
      }],
    };
  });
  const client = createFigmaWorkspaceClient({ client: upstream });
  try {
    const result = await client.eval({
      sessionId: "main",
      code: "return { id: figma.currentPage.id };",
    });
    assert.equal(result.ok, true);
    assert.equal(result.upstream.result.selected, "1:2");
    assert.equal(result.content, undefined);
    assert.deepEqual(calls.map((entry) => entry[0]), ["connect", "listTools", "callTool"]);
  } finally {
    await client.close();
  }
});

test("guidance and lookup run locally against staged runtime assets", async () => {
  const calls = [];
  const client = createFigmaWorkspaceClient({ client: createFakeUpstream(calls) });
  try {
    const guidance = await client.guidance({ query: "component variants text", surface: "design" });
    assert.equal(guidance.ok, true);
    assert.ok(guidance.suggestions.referenceContext.length > 0);
    assert.ok(guidance.suggestions.referenceContext.every((entry) => entry.sourceId.startsWith("internal:")));
    assert.doesNotMatch(JSON.stringify(guidance), /figma_workspace_/u);

    const plan = await client.guidance({ mode: "plan", query: "component variants text" });
    assert.equal(plan.ok, true);
    assert.ok(plan.recommendedTools.includes("guidance"));
    assert.ok(plan.recommendedTools.includes("inspect"));
    assert.match(plan.workflow.workspaceDirGuidance, /Git-ignored <project>\/\.figma-workspace/u);
    assert.match(plan.workflow.workspaceDirGuidance, /capability-specific output roots/u);
    assert.doesNotMatch(JSON.stringify(plan), /task-memory|<project>\/figma-workspace|absolute project\/worktree/u);
    assert.doesNotMatch(JSON.stringify(plan), /figma_workspace_/u);

    for (const result of [
      await client.guidance({ mode: "catalog" }),
      await client.guidance({ mode: "card", card: "text.font" }),
    ]) {
      assert.equal(result.ok, true);
      assert.doesNotMatch(JSON.stringify(result), /figma_workspace_|figma-workspace:\/\//u);
    }

    const docsLookup = await client.lookup({
      kind: "docs",
      query: "guidanceRef wrapperProfiles helperProfiles local wrapper tools",
      maxResults: 4,
      maxSnippetLines: 8,
    });
    assert.equal(docsLookup.ok, true);
    assert.ok(docsLookup.results.some((entry) => entry.sourceId.startsWith("internal:bridge/")));
    assert.match(JSON.stringify(docsLookup.results), /guidance|get-design-context/u);
    assert.doesNotMatch(JSON.stringify(docsLookup.results), /figma_workspace_/u);

    const projectDocsLookup = await client.lookup({
      kind: "docs",
      query: "state file sidecars results",
      maxResults: 3,
      maxSnippetLines: 4,
    });
    assert.equal(projectDocsLookup.ok, true);
    assert.ok(projectDocsLookup.results.some((entry) => entry.sourceId.startsWith("project:sessions#")));
    assert.match(JSON.stringify(projectDocsLookup.results), /--state-file|\.figma-workspace\/results/u);

    const lookup = await client.lookup({ kind: "api", symbol: "createFrame", maxResults: 2, maxSnippetLines: 3 });
    assert.equal(lookup.ok, true);
    assert.ok(lookup.results.length > 0);
    assert.equal(lookup.results[0].matchType, "exact-symbol");
    assert.match(JSON.stringify(lookup.results), /createFrame/u);
    assert.deepEqual(calls, []);
  } finally {
    await client.close();
  }
});

test("read-only discovery commands expose docs, runtime status, sessions, and live upstream schemas", async () => {
  const calls = [];
  const client = createFigmaWorkspaceClient({
    client: createFakeUpstream(calls, undefined, {
      tools: [{
        name: "whoami",
        description: "Read the authenticated Figma user.",
        inputSchema: { type: "object", properties: {}, required: [] },
      }],
    }),
    initialSessions: [{
      id: "saved",
      slug: "saved",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-02T00:00:00.000Z",
      knownPages: {},
      handles: { hero: "1:2" },
      lastDiagnostics: [],
      history: [{ id: "h1", at: "2026-01-02T00:00:00.000Z", tool: "eval", summary: "read", nodeIds: [] }],
    }],
  });
  try {
    const docs = await client.docs();
    assert.equal(docs.ok, true);
    assert.ok(docs.topics.some((entry) => entry.topic === "workflow"));
    const workflow = await client.docs({ topic: "workflow" });
    assert.equal(workflow.ok, true);
    assert.match(workflow.content, /figma\.ts/u);

    const doctor = await client.doctor();
    assert.equal(typeof doctor.runtime.projectDocs.ok, "boolean");
    assert.equal(typeof doctor.runtime.lookup.ok, "boolean");
    assert.equal(typeof doctor.runtime.typescript.ok, "boolean");

    const summaries = await client.sessionsInfo();
    assert.equal(summaries.sessions[0].id, "saved");
    assert.equal(summaries.sessions[0].handleCount, 1);
    const detail = await client.sessionsInfo({ sessionId: "saved" });
    assert.equal(detail.session.handles, undefined);
    assert.equal(detail.session.history, undefined);
    const expanded = await client.sessionsInfo({ sessionId: "saved", includeHandles: true, includeHistory: true });
    assert.deepEqual(expanded.session.handles, { hero: "1:2" });
    assert.equal(expanded.session.history.length, 1);
    assert.equal(client.sessions.list().length, 1);

    const directory = await client.upstreamTools();
    assert.equal(directory.tools[0].name, "whoami");
    assert.equal(directory.tools[0].category, "account");
    const tool = await client.upstreamTools({ name: "whoami" });
    assert.equal(tool.name, "whoami");
    assert.deepEqual(tool.inputSchema, { type: "object", properties: {}, required: [] });
    assert.deepEqual(calls, [["connect"], ["listTools"]]);
  } finally {
    await client.close();
  }
});

test("runScriptFile blocks TypeScript diagnostics before upstream execution", async () => {
  const tempDir = await mkdtemp(resolve(tmpdir(), "figma-workspace-client-script-"));
  const scriptPath = resolve(tempDir, "broken.figma.ts");
  await writeFile(scriptPath, "const frame: FrameNode = figma.createRectangle();\nreturn frame.id;\n", "utf8");
  const calls = [];
  const client = createFigmaWorkspaceClient({ client: createFakeUpstream(calls) });
  try {
    const result = await client.runScriptFile({ scriptPath });
    assert.equal(result.ok, false);
    assert.equal(result.phase, "preflight");
    assert.equal(result.executed, false);
    assert.ok(result.diagnostics.length > 0);
    assert.doesNotMatch(JSON.stringify(result.diagnostics), /figma_workspace_/);
    assert.ok(result.diagnostics.some((diagnostic) => diagnostic.docsHint.startsWith("lookup kind=api")));
    assert.deepEqual(calls, []);
  } finally {
    await client.close();
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("successful runScriptFile transpiles TypeScript and delegates to use_figma", async () => {
  const tempDir = await mkdtemp(resolve(tmpdir(), "figma-workspace-client-script-success-"));
  const scriptPath = resolve(tempDir, "success.figma.ts");
  await writeFile(scriptPath, [
    "const frame: FrameNode = figma.createFrame();",
    "frame.name = 'Typed frame';",
    "return { frameId: frame.id } as const;",
  ].join("\n"), "utf8");
  const calls = [];
  const client = createFigmaWorkspaceClient({
    client: createFakeUpstream(calls, ({ name, args }) => {
      assert.equal(name, "use_figma");
      assert.match(args.code, /figma\.createFrame\(\)/u);
      assert.doesNotMatch(args.code, /: FrameNode|as const/u);
      return { content: [{ type: "text", text: JSON.stringify({
        ok: true,
        __figmaRepl: { sessionId: "script-success", handles: {} },
        result: { frameId: "30:1" },
      }) }] };
    }),
  });
  try {
    const result = await client.runScriptFile({ sessionId: "script-success", scriptPath, strict: true });
    assert.equal(result.ok, true);
    assert.equal(result.phase, "execute");
    assert.equal(result.executed, true);
    assert.equal(result.upstream.result.frameId, "30:1");
    assert.deepEqual(calls.map((entry) => entry[0]), ["connect", "listTools", "callTool"]);
  } finally {
    await client.close();
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("applyAssetManifest validates official upload_assets arguments offline", async () => {
  const tempDir = await mkdtemp(resolve(tmpdir(), "figma-workspace-client-assets-"));
  const assetPath = resolve(tempDir, "hero.png");
  await writeFile(assetPath, "fake image bytes", "utf8");
  const calls = [];
  const client = createFigmaWorkspaceClient({
    client: createFakeUpstream(calls, ({ name, args }) => {
      assert.equal(name, "upload_assets");
      assert.deepEqual(args, { fileKey: "file123", count: 1, nodeId: "12:34", scaleMode: "FILL" });
      return { content: [{ type: "text", text: JSON.stringify({ ok: true, result: { summary: "asset filled" } }) }] };
    }, {
      tools: [{
        name: "upload_assets",
        inputSchema: { type: "object", properties: {
          fileKey: { type: "string" }, count: { type: "number" },
          nodeId: { type: "string" }, scaleMode: { type: "string" },
        } },
      }],
    }),
  });
  try {
    await client.open({
      sessionId: "asset-test",
      file: "https://www.figma.com/design/file123/Test",
      workspaceDir: tempDir,
      connect: false,
    });
    const result = await client.applyAssetManifest({
      sessionId: "asset-test",
      assets: [{ path: assetPath, target: "12:34", name: "Hero art" }],
      validateTargets: false,
    });
    assert.equal(result.ok, true);
    assert.equal(result.assets.length, 1);
    assert.equal(result.failures, undefined);
    assert.deepEqual(calls.map((entry) => entry[0]), ["connect", "listTools", "callTool"]);
  } finally {
    await client.close();
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("captureNode writes a deterministic PNG returned by get_screenshot", async () => {
  const tempDir = await mkdtemp(resolve(tmpdir(), "figma-workspace-client-capture-"));
  const outputFile = resolve(tempDir, "capture.png");
  const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAFgwJ/lP2PAAAAAElFTkSuQmCC", "base64");
  const calls = [];
  const client = createFigmaWorkspaceClient({
    client: createFakeUpstream(calls, ({ name, args }) => {
      assert.equal(name, "get_screenshot");
      assert.deepEqual(args, { fileKey: "file123", nodeId: "22:7" });
      return { content: [{ type: "image", mimeType: "image/png", data: png.toString("base64") }] };
    }, {
      tools: [{
        name: "get_screenshot",
        inputSchema: {
          type: "object",
          properties: { fileKey: { type: "string" }, nodeId: { type: "string" } },
          required: ["fileKey", "nodeId"],
        },
      }],
    }),
  });
  try {
    const result = await client.captureNode({
      target: { fileKey: "file123", nodeId: "22:7" },
      imageFile: outputFile,
    });
    assert.equal(result.ok, true);
    assert.equal(result.imageFile, outputFile);
    assert.equal((await readFile(outputFile)).subarray(0, 8).toString("hex"), "89504e470d0a1a0a");
  } finally {
    await client.close();
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("runTaskPlan stops after a structured upstream failure", async () => {
  const tempDir = await mkdtemp(resolve(tmpdir(), "figma-workspace-client-plan-"));
  const previousTaskRoot = process.env.FIGMA_WORKSPACE_TASK_ROOT;
  process.env.FIGMA_WORKSPACE_TASK_ROOT = tempDir;
  const calls = [];
  const client = createFigmaWorkspaceClient({
    client: createFakeUpstream(calls, ({ name }) => ({
      content: [{ type: "text", text: JSON.stringify(name === "plan-ok"
        ? { ok: true, result: { summary: "ok" } }
        : { ok: false, error: { code: "PLAN_FAILED", message: "planned failure" } }) }],
    }), {
      tools: ["plan-ok", "plan-fail", "after-stop"].map((name) => ({
        name,
        inputSchema: { type: "object", properties: {} },
      })),
    }),
  });
  try {
    const result = await client.runTaskPlan({
      steps: [
        { id: "ok", type: "upstream", args: { toolName: "plan-ok", arguments: {} } },
        { id: "fail", type: "upstream", args: { toolName: "plan-fail", arguments: {} } },
        { id: "after", type: "upstream", args: { toolName: "after-stop", arguments: {} } },
      ],
    });
    assert.equal(result.ok, false);
    assert.equal(result.stopped, true);
    assert.deepEqual(result.steps.map((step) => step.id), ["ok", "fail"]);
    assert.deepEqual(result.steps.map((step) => step.status), ["completed", "failed"]);
    assert.equal(result.failures.length, 1);
    assert.deepEqual(calls.filter((entry) => entry[0] === "callTool").map((entry) => entry[1]), ["plan-ok", "plan-fail"]);
  } finally {
    await client.close();
    if (previousTaskRoot === undefined) delete process.env.FIGMA_WORKSPACE_TASK_ROOT;
    else process.env.FIGMA_WORKSPACE_TASK_ROOT = previousTaskRoot;
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("metadata, design context, and inspect use typed official-tool wrappers", async () => {
  const tempDir = await mkdtemp(resolve(tmpdir(), "figma-workspace-client-context-"));
  const calls = [];
  const client = createFigmaWorkspaceClient({
    client: createFakeUpstream(calls, ({ name, args }) => {
      if (name === "get_metadata") {
        assert.equal(args.fileKey, "ContextFileKey012");
        assert.equal(args.nodeId, "1:2");
        return { content: [{ type: "text", text: '<frame id="1:2" name="Root" width="300" height="200" />' }] };
      }
      if (name === "get_design_context") {
        assert.deepEqual(args, { fileKey: "ContextFileKey012", nodeId: "1:2" });
        return { content: [{ type: "text", text: JSON.stringify({ ok: true, code: "<div />" }) }] };
      }
      assert.equal(name, "use_figma");
      assert.match(args.code, /locked: read\("locked"\)|__metadataNodeIds/u);
      return { content: [{ type: "text", text: JSON.stringify({
        ok: true,
        result: args.code.includes("__metadataNodeIds")
          ? { enrichment: { nodes: {} } }
          : { target: "1:2", summary: { id: "1:2", type: "FRAME", name: "Root", locked: true } },
      }) }] };
    }, {
      tools: [
        { name: "get_metadata", inputSchema: { type: "object", properties: { fileKey: { type: "string" }, nodeId: { type: "string" } } } },
        { name: "get_design_context", inputSchema: { type: "object", properties: { fileKey: { type: "string" }, nodeId: { type: "string" } } } },
        { name: "use_figma", inputSchema: { type: "object", properties: { code: { type: "string" }, fileKey: { type: "string" } }, required: ["code"] } },
      ],
    }),
  });
  try {
    await client.open({
      sessionId: "context-test",
      file: "https://www.figma.com/design/ContextFileKey012/Test",
      workspaceDir: tempDir,
      handles: { "$root": "1:2" },
      connect: false,
    });
    const metadata = await client.getMetadata({ sessionId: "context-test", target: "$root" });
    assert.equal(metadata.ok, true);
    assert.equal(metadata.metadata.json.root.nodeId, "1:2");
    const design = await client.getDesignContext({ sessionId: "context-test", target: "$root" });
    assert.equal(design.ok, true);
    assert.equal(design.upstream.result.code, "<div />");
    const inspect = await client.inspect({ sessionId: "context-test", target: "$root" });
    assert.equal(inspect.ok, true);
    assert.equal(inspect.summary.locked, true);
  } finally {
    await client.close();
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("runScriptFile returns a structured upstream error without throwing", async () => {
  const tempDir = await mkdtemp(resolve(tmpdir(), "figma-workspace-client-upstream-failure-"));
  const scriptPath = resolve(tempDir, "failure.figma.ts");
  await writeFile(scriptPath, "return { attempted: true };", "utf8");
  const client = createFigmaWorkspaceClient({
    client: createFakeUpstream([], () => ({ content: [{ type: "text", text: JSON.stringify({
      ok: false,
      error: { code: "FIGMA_INSTANCE_CHILD_REMOVE", message: "Cannot remove instance child." },
    }) }] })),
  });
  try {
    const result = await client.runScriptFile({ scriptPath });
    assert.equal(result.ok, false);
    assert.equal(result.phase, "execute");
    assert.equal(result.executed, true);
    assert.equal(result.upstreamError.code, "FIGMA_INSTANCE_CHILD_REMOVE");
    assert.match(result.upstreamError.message, /instance child/u);
    assert.equal(result.upstream.ok, false);
  } finally {
    await client.close();
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("typed prepareTask creates a local .figma.ts workspace without upstream", async () => {
  const tempDir = await mkdtemp(resolve(tmpdir(), "figma-workspace-client-prepare-"));
  const workspaceDir = resolve(tempDir, "workspace");
  const calls = [];
  const client = createFigmaWorkspaceClient({ client: createFakeUpstream(calls) });
  try {
    const result = await client.prepareTask({
      workspaceDir,
      fileName: "build-card.figma.ts",
      taskName: "build-card",
    });
    assert.equal(result.ok, true);
    assert.equal(result.task.taskName, "build-card");
    assert.equal(result.task.workspace.files.inputFile, "build-card.figma.ts");
    assert.match(await readFile(resolve(workspaceDir, "build-card.figma.ts"), "utf8"), /figma/u);
    assert.deepEqual(calls, []);
  } finally {
    await client.close();
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("runtime code diagnostics and helper selection remain available", () => {
  const diagnostics = diagnoseFigmaWorkspaceCode("await fetch('https://example.com'); figma.root.findAll();", { mode: "write" });
  assert.ok(diagnostics.some((diagnostic) => diagnostic.code === "FIGMA_WORKSPACE_NETWORK_ACCESS"));
  assert.doesNotMatch(JSON.stringify(diagnostics), /figma_workspace_/);

  const selection = resolveFigmaWorkspaceScriptHelperSelection(
    "return $.inspect(figma.currentPage);",
  );
  assert.equal(selection.helperNames.has("inspect"), true);
  assert.equal(selection.injectedHelpers.includes("$.inspect"), true);
  const wrapper = buildFigmaEvalScript({
    session: {
      id: "main",
      handles: {},
      knownPages: {},
    },
    code: "return figma.currentPage.id;",
  });
  assert.match(wrapper, /figma\.currentPage\.id/u);
  assert.match(wrapper, /__figmaRepl/u);
});

test("typed client validates an absolute OAuth cache path", async () => {
  const tempDir = await mkdtemp(resolve(tmpdir(), "figma-workspace-client-oauth-"));
  const client = createFigmaWorkspaceClient({
    client: createFakeUpstream([]),
    oauthCachePath: resolve(tempDir, "oauth.json"),
  });
  await client.close();
  assert.throws(
    () => createFigmaWorkspaceClient({ oauthCachePath: "relative-oauth.json" }),
    /absolute/u,
  );
  await rm(tempDir, { recursive: true, force: true });
});

function createFakeUpstream(calls, callTool = () => {
  throw new Error("unexpected upstream call");
}, options = {}) {
  let connected = false;
  return {
    async connect() {
      if (!connected) {
        connected = true;
        calls.push(["connect"]);
      }
    },
    async close() {},
    async listTools() {
      calls.push(["listTools"]);
      return {
        tools: options.tools ?? [{
          name: "use_figma",
          description: "Execute JavaScript in Figma.",
          inputSchema: {
            type: "object",
            properties: {
              code: { type: "string" },
              description: { type: "string" },
            },
            required: ["code"],
          },
        }],
      };
    },
    async callTool(name, args) {
      calls.push(["callTool", name, args]);
      return callTool({ name, args });
    },
  };
}
