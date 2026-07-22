import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";
import {
  buildFigmaEvalScript,
  createFigmaWorkspaceClient,
  createFigmaWorkspaceSessionStore,
} from "../dist/runtime/workspace-runtime.js";

test("session store clones initial state and caps history without local handles", () => {
  const initial = {
    id: "main",
    slug: "main",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    knownPages: { Home: "1:2" },
    lastDiagnostics: [],
    history: [],
  };
  const store = createFigmaWorkspaceSessionStore({ initialSessions: [initial], historyLimit: 2 });
  initial.knownPages.Home = "changed";
  const session = store.get("main");
  assert.equal(session.knownPages.Home, "1:2");
  assert.equal("handles" in session, false);
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
  assert.throws(
    () => createFigmaWorkspaceSessionStore({ initialSessions: [{ ...initial, handles: { hero: "2:3" } }] }),
    /legacy.*handles|handles.*no longer supported/iu,
  );
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

test("typed client rejects removed handle and semantic-guardrail inputs", async () => {
  const calls = [];
  const client = createFigmaWorkspaceClient({ client: createFakeUpstream(calls) });
  try {
    await assert.rejects(
      client.open({ handles: { hero: "1:2" }, connect: false }),
      /handles.*removed|local handles.*no longer supported/iu,
    );
    await assert.rejects(
      client.eval({ code: "return true;", mode: "read" }),
      /mode.*removed/iu,
    );
    await assert.rejects(
      client.eval({ code: "return true;", allowDangerousOperations: true }),
      /allowDangerousOperations.*removed/iu,
    );
    await assert.rejects(
      client.eval({ code: "return true;", handleUpdates: { hero: "1:2" } }),
      /handleUpdates.*removed|local handles.*no longer supported/iu,
    );
    await assert.rejects(
      client.runScriptFile({ scriptPath: "unused.figma.ts", allowDangerousOperations: true }),
      /allowDangerousOperations.*removed/iu,
    );
    await assert.rejects(
      client.runScriptFile({ scriptPath: "unused.figma.ts", strict: true }),
      /strict.*removed/iu,
    );
    for (const operation of [
      client.runScriptFile({ scriptPath: "unused.figma.ts", outputDir: "legacy" }),
      client.eval({ code: "return true;", upstreamTool: "legacy" }),
      client.inspect({ target: "1:2", upstreamTool: "legacy" }),
    ]) {
      const error = await operation.then(
        () => assert.fail("removed input must fail"),
        (reason) => reason,
      );
      assert.doesNotMatch(
        error.message,
        /figma_workspace_|run-script-file|use_figma|prepare-task|call-upstream-tool/u,
      );
    }
    const relativeScriptError = await client.runScriptFile({ scriptPath: "relative.figma.ts" }).then(
      () => assert.fail("relative script path must fail"),
      (reason) => reason,
    );
    assert.match(relativeScriptError.message, /figma:task:prepare/u);
    assert.doesNotMatch(relativeScriptError.message, /prepare-task/u);
    await assert.rejects(
      client.guidance({ query: "text editing", mode: "plan" }),
      /mode.*removed/iu,
    );
    await assert.rejects(
      client.inspect({ mode: "validate" }),
      /mode.*inspect.*style|must be one of/iu,
    );
    assert.deepEqual(calls, []);
  } finally {
    await client.close();
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
          __figmaWorkspace: { sessionId: "main", currentPageId: "1:2", knownPages: {}, captureRequests: [] },
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
    assert.equal(result.executionOutcome, "succeeded");
    assert.equal("executed" in result, false);
    assert.equal("scriptExecutionSucceeded" in result, false);
    assert.equal(result.upstream.result.selected, "1:2");
    assert.equal(result.content, undefined);
    assert.deepEqual(calls.map((entry) => entry[0]), ["connect", "listTools", "callTool"]);
  } finally {
    await client.close();
  }
});

test("backend default inline limit keeps 4096 bytes and omits 4097 bytes", async () => {
  const tempDir = await mkdtemp(resolve(tmpdir(), "figma-workspace-inline-4096-"));
  let resultBytes = 4096;
  const client = createFigmaWorkspaceClient({
    client: createFakeUpstream([], () => ({
      content: [{ type: "text", text: JSON.stringify({ ok: true, result: "x".repeat(resultBytes - 13) }) }],
    })),
  });
  try {
    await client.prepareTask({ workspaceDir: tempDir, taskName: "inline-boundary" });
    const exact = await client.eval({ code: "return true;" });
    assert.equal(Buffer.byteLength(JSON.stringify(exact.upstream.result), "utf8"), 4096);
    assert.equal(exact.inlineResultLimit, undefined);

    resultBytes = 4097;
    const oversized = await client.eval({ code: "return true;" });
    assert.equal(oversized.upstream.result, undefined);
    assert.equal(oversized.inlineResultLimit.limitBytes, 4096);
    assert.deepEqual(oversized.inlineResultLimit.omitted, [{ field: "upstream.result", bytes: 4097 }]);
  } finally {
    await client.close();
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("typed eval reports not_started when upstream connection fails before request dispatch", async () => {
  const calls = [];
  const client = createFigmaWorkspaceClient({
    client: createFakeUpstream(calls, undefined, {
      connectError: new Error("authentication unavailable"),
    }),
  });
  try {
    const result = await client.eval({ code: "return true;" });
    assert.equal(result.ok, false);
    assert.equal(result.executionOutcome, "not_started");
    assert.equal(result.retryGuidance, undefined);
    assert.match(result.upstreamError.message, /authentication unavailable/u);
    assert.deepEqual(calls, [["connect"]]);
  } finally {
    await client.close();
  }
});

test("typed eval reports outcome_unknown without retrying dispatched failures", async () => {
  const failureCases = [
    { name: "script error after mutation", error: new Error("node created, then script failed") },
    { name: "timeout", error: Object.assign(new Error("request timed out"), { code: "ETIMEDOUT" }) },
    { name: "cancel", error: Object.assign(new Error("request canceled"), { name: "AbortError", code: "ERR_CANCELED" }) },
    { name: "transport loss", error: Object.assign(new Error("connection lost"), { code: "ECONNRESET" }) },
  ];
  for (const failureCase of failureCases) {
    const calls = [];
    let simulatedMutation = false;
    const client = createFigmaWorkspaceClient({
      client: createFakeUpstream(calls, () => {
        simulatedMutation = true;
        throw failureCase.error;
      }),
    });
    try {
      const result = await client.eval({ code: "return figma.createFrame().id;" });
      assert.equal(simulatedMutation, true, failureCase.name);
      assert.equal(result.ok, false, failureCase.name);
      assert.equal(result.executionOutcome, "outcome_unknown", failureCase.name);
      assert.match(result.retryGuidance, /Do not rerun.*blindly.*reconcile/iu, failureCase.name);
      assert.equal(calls.filter((entry) => entry[0] === "callTool").length, 1, failureCase.name);
    } finally {
      await client.close();
    }
  }
});

test("typed eval deadline aborts the dispatched upstream request", async () => {
  const originalSetTimeout = globalThis.setTimeout;
  let requestAborted = false;
  const calls = [];
  globalThis.setTimeout = (callback, delay, ...args) =>
    originalSetTimeout(callback, delay === 5 * 60 * 1000 ? 5 : delay, ...args);
  const client = createFigmaWorkspaceClient({
    client: createFakeUpstream(calls, ({ signal }) => new Promise((_resolve, reject) => {
      signal.addEventListener("abort", () => {
        requestAborted = true;
        reject(signal.reason);
      }, { once: true });
    })),
  });
  try {
    const result = await client.eval({ code: "return figma.createFrame().id;" });
    assert.equal(result.executionOutcome, "outcome_unknown");
    assert.equal(requestAborted, true);
    assert.equal(calls.filter((entry) => entry[0] === "callTool").length, 1);
  } finally {
    globalThis.setTimeout = originalSetTimeout;
    await client.close();
  }
});

test("typed eval treats a dispatched structured script error as outcome_unknown", async () => {
  const client = createFigmaWorkspaceClient({
    client: createFakeUpstream([], () => ({ content: [{ type: "text", text: JSON.stringify({
      ok: false,
      error: { code: "SCRIPT_FAILED", message: "Script failed after a partial update." },
    }) }] })),
  });
  try {
    const result = await client.eval({ code: "return figma.createFrame().id;" });
    assert.equal(result.ok, false);
    assert.equal(result.executionOutcome, "outcome_unknown");
    assert.match(result.retryGuidance, /inspect|read back/iu);
    assert.equal(result.upstreamError.code, "SCRIPT_FAILED");
  } finally {
    await client.close();
  }
});

test("eval accepts exactly 50,000 wrapped UTF-8 bytes and rejects 50,001 without upstream", async () => {
  const calls = [];
  const wrappedByteLengths = [];
  const client = createFigmaWorkspaceClient({
    client: createFakeUpstream(calls, ({ name, args }) => {
      assert.equal(name, "use_figma");
      wrappedByteLengths.push(Buffer.byteLength(args.code, "utf8"));
      return { content: [{ type: "text", text: JSON.stringify({
        ok: true,
        __figmaWorkspace: {
          sessionId: "eval-size-boundary",
          currentPageId: "1:1",
          knownPages: {},
          captureRequests: [],
        },
        result: { accepted: true },
      }) }] };
    }),
  });
  const fixtures = [
    {
      name: "JavaScript",
      typescript: false,
      source: (padding) => `return ${JSON.stringify("x".repeat(padding))}.length;`,
    },
    {
      name: "TypeScript",
      typescript: true,
      source: (padding) => `const value: string = ${JSON.stringify("x".repeat(padding))};\nreturn value.length;`,
    },
    {
      name: "capture helper",
      typescript: false,
      source: (padding) => `const value = ${JSON.stringify("x".repeat(padding))};\nreturn $.capture("1:2", { imageFile: "capture.png" });`,
    },
  ];
  try {
    for (const fixture of fixtures) {
      const baseline = await client.eval({
        sessionId: "eval-size-boundary",
        code: fixture.source(0),
        typescript: fixture.typescript,
      });
      assert.equal(baseline.ok, true, fixture.name);
      let padding = 50_000 - wrappedByteLengths.at(-1);
      assert.ok(padding > 0, fixture.name);

      const exact = await client.eval({
        sessionId: "eval-size-boundary",
        code: fixture.source(padding),
        typescript: fixture.typescript,
      });
      assert.equal(exact.ok, true, fixture.name);
      padding += 50_000 - wrappedByteLengths.at(-1);
      if (wrappedByteLengths.at(-1) !== 50_000) {
        const recalibrated = await client.eval({
          sessionId: "eval-size-boundary",
          code: fixture.source(padding),
          typescript: fixture.typescript,
        });
        assert.equal(recalibrated.ok, true, fixture.name);
      }
      assert.equal(wrappedByteLengths.at(-1), 50_000, fixture.name);

      const upstreamCallCount = calls.length;
      const acceptedEvalCount = wrappedByteLengths.length;
      const oversized = await client.eval({
        sessionId: "eval-size-boundary",
        code: fixture.source(padding + 1),
        typescript: fixture.typescript,
      });
      assert.equal(oversized.ok, false, fixture.name);
      assert.equal(oversized.executionOutcome, "not_started", fixture.name);
      assert.ok(
        oversized.diagnostics.some((diagnostic) => (
          diagnostic.code === "FIGMA_WORKSPACE_SCRIPT_PAYLOAD_TOO_LARGE"
          && /50001 bytes.*50000 UTF-8 bytes/u.test(diagnostic.message)
        )),
        fixture.name,
      );
      assert.equal(calls.length, upstreamCallCount, `${fixture.name} oversized call must not reach upstream`);
      assert.equal(wrappedByteLengths.length, acceptedEvalCount, fixture.name);
    }
  } finally {
    await client.close();
  }
});

test("typed eval exposes font-safe $.text for node objects and raw ids", async () => {
  const mock = createTextHelperFigmaMock();
  const calls = [];
  const client = createFigmaWorkspaceClient({
    client: createFakeUpstream(calls, async ({ name, args }) => {
      assert.equal(name, "use_figma");
      const payload = await executeWrappedFigmaScript(args.code, mock.figma);
      return { content: [{ type: "text", text: JSON.stringify(payload) }] };
    }),
  });
  try {
    const result = await client.eval({
      sessionId: "text-helper",
      code: [
        "const objectTarget = await figma.getNodeByIdAsync('text:node');",
        "const createdOnPage = await $.text({ text: 'Created on page' });",
        "const createdInParent = await $.text({ parent: 'parent:1', text: 'Created in parent', font: { family: 'Roboto', style: 'Bold' } });",
        "const updatedById = await $.text({ target: 'text:raw', text: 'Updated by id' });",
        "const updatedByNode = await $.text({ target: objectTarget, text: 'Updated by node', font: { family: 'Work Sans', style: 'Semi Bold' } });",
        "const errors = {};",
        "try { await $.text({ target: 'text:raw', parent: 'parent:1', text: 'invalid' }); } catch (error) { errors.targetParent = error.message; }",
        "try { await $.text({ target: 'text:raw' }); } catch (error) { errors.missingText = error.message; }",
        "try { await $.text({ target: 'text:mixed', text: 'invalid' }); } catch (error) { errors.mixedFont = error.message; }",
        "try { await $.text({ target: ({ id: 'missing:fake', type: 'TEXT' }), text: 'invalid' }); } catch (error) { errors.fakeNode = error.message; }",
        "try { await $.text({ target: '$legacy', text: 'invalid' }); } catch (error) { errors.legacyHandle = error.message; }",
        "try { $(); } catch (error) { errors.nonCallable = error.message; }",
        "return {",
        "  createdOnPage: createdOnPage.id,",
        "  createdInParent: createdInParent.id,",
        "  updatedById: updatedById.id,",
        "  updatedByNode: updatedByNode.id,",
        "  helperKeys: Object.keys($),",
        "  frozen: Object.isFrozen($),",
        "  errors,",
        "};",
      ].join("\n"),
    });
    assert.equal(result.ok, true);
    assert.deepEqual(result.upstream.result.helperKeys, ["text", "capture"]);
    assert.equal(result.upstream.result.frozen, true);
    assert.equal(mock.nodes.get("text:raw").characters, "Updated by id");
    assert.equal(mock.nodes.get("text:node").characters, "Updated by node");
    assert.equal(mock.nodes.get(result.upstream.result.createdInParent).parent, mock.nodes.get("parent:1"));
    assert.equal(mock.nodes.get(result.upstream.result.createdOnPage).parent, mock.figma.currentPage);
    assert.deepEqual(mock.loadedFonts, [
      { family: "Inter", style: "Regular" },
      { family: "Roboto", style: "Bold" },
      { family: "Inter", style: "Medium" },
      { family: "Work Sans", style: "Semi Bold" },
    ]);
    assert.match(result.upstream.result.errors.targetParent, /mutually exclusive/u);
    assert.match(result.upstream.result.errors.missingText, /requires text as a string/u);
    assert.match(result.upstream.result.errors.mixedFont, /mixed fonts/u);
    assert.match(result.upstream.result.errors.fakeNode, /not found/u);
    assert.match(result.upstream.result.errors.legacyHandle, /raw node id/u);
    assert.match(result.upstream.result.errors.nonCallable, /not a function/u);
  } finally {
    await client.close();
  }
});

test("typed eval processes queued $.capture requests into local PNG files", async () => {
  const tempDir = await mkdtemp(resolve(tmpdir(), "figma-workspace-client-eval-capture-"));
  const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAFgwJ/lP2PAAAAAElFTkSuQmCC", "base64");
  const calls = [];
  const client = createFigmaWorkspaceClient({
    client: createFakeUpstream(calls, ({ name, args }) => {
      if (name === "use_figma") {
        assert.match(args.code, /async function __figmaWorkspaceCapture\(target, options = \{\}\)/u);
        assert.match(args.code, /const \$ = Object\.freeze/u);
        assert.doesNotMatch(args.code, /\$\.screenshot|node\.screenshot/u);
        return { content: [{ type: "text", text: JSON.stringify({
          ok: true,
          __figmaWorkspace: {
            sessionId: "queued-eval",
            currentPageId: "1:1",
            knownPages: {},
            captureRequests: [{
              requestId: "capture-1",
              nodeId: "22:7",
              imageFile: "queued-eval.png",
              maxDimension: 1600,
              contentsOnly: true,
            }],
          },
          result: { frameId: "22:7" },
        }) }] };
      }
      assert.equal(name, "get_screenshot");
      assert.deepEqual(args, { fileKey: "file123", nodeId: "22:7", maxDimension: 1600, contentsOnly: true });
      return { content: [{ type: "image", mimeType: "image/png", data: png.toString("base64") }] };
    }, {
      tools: [
        {
          name: "use_figma",
          description: "Execute JavaScript in Figma.",
          inputSchema: {
            type: "object",
            properties: { code: { type: "string" }, description: { type: "string" }, fileKey: { type: "string" } },
            required: ["code", "fileKey"],
          },
        },
        {
          name: "get_screenshot",
          inputSchema: {
            type: "object",
            properties: {
              fileKey: { type: "string" },
              nodeId: { type: "string" },
              maxDimension: { type: "integer" },
              contentsOnly: { type: "boolean" },
            },
            required: ["fileKey", "nodeId"],
          },
        },
      ],
    }),
  });
  try {
    await client.open({
      sessionId: "queued-eval",
      file: "https://www.figma.com/design/file123/Test",
      workspaceDir: tempDir,
      connect: false,
    });
    const result = await client.eval({
      sessionId: "queued-eval",
      code: "const frame = figma.createFrame(); return $.capture(frame, { maxDimension: 1600 });",
    });
    assert.equal(result.ok, true);
    assert.equal(result.executionOutcome, "succeeded");
    assert.equal(result.captureProcessingSucceeded, true);
    assert.equal(result.upstream.result.frameId, "22:7");
    assert.equal(result.captures.length, 1);
    assert.equal(result.captures[0].requestId, "capture-1");
    assert.equal(result.captures[0].imageFile, resolve(tempDir, "file123", "queued-eval.png"));
    assert.equal((await readFile(result.captures[0].imageFile)).subarray(0, 8).toString("hex"), "89504e470d0a1a0a");
    assert.deepEqual(calls.filter((entry) => entry[0] === "callTool").map((entry) => entry[1]), ["use_figma", "get_screenshot"]);
  } finally {
    await client.close();
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("typed eval accepts a valid queued capture envelope without source authorization", async () => {
  const tempDir = await mkdtemp(resolve(tmpdir(), "figma-workspace-client-eval-envelope-"));
  const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAFgwJ/lP2PAAAAAElFTkSuQmCC", "base64");
  const calls = [];
  const client = createFigmaWorkspaceClient({
    client: createFakeUpstream(calls, ({ name }) => {
      if (name === "use_figma") {
        return { content: [{ type: "text", text: JSON.stringify({
          ok: true,
          __figmaWorkspace: {
            sessionId: "capture-envelope",
            currentPageId: "1:1",
            knownPages: {},
            captureRequests: [{ requestId: "capture-1", nodeId: "1:1", imageFile: "envelope.png" }],
          },
          result: { frameId: "1:1" },
        }) }] };
      }
      assert.equal(name, "get_screenshot");
      return { content: [{ type: "image", mimeType: "image/png", data: png.toString("base64") }] };
    }, {
      tools: [
        {
          name: "use_figma",
          inputSchema: { type: "object", properties: { code: { type: "string" }, fileKey: { type: "string" } }, required: ["code", "fileKey"] },
        },
        {
          name: "get_screenshot",
          inputSchema: { type: "object", properties: { fileKey: { type: "string" }, nodeId: { type: "string" } }, required: ["fileKey", "nodeId"] },
        },
      ],
    }),
  });
  try {
    await client.open({
      sessionId: "capture-envelope",
      file: "https://www.figma.com/design/file123/Test",
      workspaceDir: tempDir,
      connect: false,
    });
    const result = await client.eval({
      sessionId: "capture-envelope",
      code: "return { frameId: figma.currentPage.children[0]?.id };",
    });
    assert.equal(result.ok, true);
    assert.equal(result.executionOutcome, "succeeded");
    assert.equal(result.captureProcessingSucceeded, true);
    assert.equal(result.upstream.result.frameId, "1:1");
    assert.equal(result.captures.length, 1);
    assert.equal(result.captures[0].requestId, "capture-1");
    assert.equal(result.captures[0].imageFile, resolve(tempDir, "file123", "envelope.png"));
    assert.deepEqual(calls.filter((entry) => entry[0] === "callTool").map((entry) => entry[1]), ["use_figma", "get_screenshot"]);
  } finally {
    await client.close();
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("typed eval rejects absolute imageFile paths from queued capture envelopes", async () => {
  const tempDir = await mkdtemp(resolve(tmpdir(), "figma-workspace-client-eval-capture-path-"));
  const calls = [];
  const client = createFigmaWorkspaceClient({
    client: createFakeUpstream(calls, ({ name }) => {
      assert.equal(name, "use_figma");
      return { content: [{ type: "text", text: JSON.stringify({
        ok: true,
        __figmaWorkspace: {
          sessionId: "unsafe-capture-path",
          currentPageId: "1:1",
          knownPages: {},
          captureRequests: [{
            requestId: "capture-1",
            nodeId: "1:1",
            imageFile: resolve(tempDir, "outside.png"),
          }],
        },
        result: { frameId: "1:1" },
      }) }] };
    }),
  });
  try {
    const result = await client.eval({
      sessionId: "unsafe-capture-path",
      code: "return $.capture(figma.currentPage.children[0]);",
    });
    assert.equal(result.ok, false);
    assert.equal(result.executionOutcome, "succeeded");
    assert.equal(result.captureProcessingSucceeded, false);
    assert.equal(result.captures[0].requestId, "capture-envelope");
    assert.match(result.captures[0].upstreamError.message, /workspace-relative/u);
    assert.deepEqual(calls.filter((entry) => entry[0] === "callTool").map((entry) => entry[1]), ["use_figma"]);
  } finally {
    await client.close();
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("typed eval rejects malformed queued capture envelopes before host capture", async () => {
  const cases = [
    {
      name: "session mismatch",
      envelope: { sessionId: "other-session", captureRequests: [] },
      message: /active Figma Workspace session/u,
    },
    {
      name: "non-array requests",
      envelope: { sessionId: "capture-malformed", captureRequests: {} },
      message: /must be an array/u,
    },
    {
      name: "unknown request field",
      envelope: { sessionId: "capture-malformed", captureRequests: [{ requestId: "capture-1", nodeId: "1:1", extra: true }] },
      message: /unsupported fields/u,
    },
    {
      name: "out-of-order request id",
      envelope: { sessionId: "capture-malformed", captureRequests: [{ requestId: "capture-2", nodeId: "1:1" }] },
      message: /invalid requestId/u,
    },
    {
      name: "legacy node id",
      envelope: { sessionId: "capture-malformed", captureRequests: [{ requestId: "capture-1", nodeId: "$legacy" }] },
      message: /invalid nodeId/u,
    },
    {
      name: "path traversal",
      envelope: { sessionId: "capture-malformed", captureRequests: [{ requestId: "capture-1", nodeId: "1:1", imageFile: "../escape.png" }] },
      message: /workspace-relative/u,
    },
    {
      name: "invalid dimension",
      envelope: { sessionId: "capture-malformed", captureRequests: [{ requestId: "capture-1", nodeId: "1:1", maxDimension: 0 }] },
      message: /invalid maxDimension/u,
    },
    {
      name: "invalid boolean",
      envelope: { sessionId: "capture-malformed", captureRequests: [{ requestId: "capture-1", nodeId: "1:1", contentsOnly: "yes" }] },
      message: /invalid contentsOnly/u,
    },
  ];

  for (const testCase of cases) {
    const calls = [];
    const client = createFigmaWorkspaceClient({
      client: createFakeUpstream(calls, ({ name }) => {
        assert.equal(name, "use_figma", testCase.name);
        return { content: [{ type: "text", text: JSON.stringify({
          ok: true,
          __figmaWorkspace: testCase.envelope,
          result: { frameId: "1:1" },
        }) }] };
      }),
    });
    try {
      const result = await client.eval({
        sessionId: "capture-malformed",
        code: "return { frameId: '1:1' };",
      });
      assert.equal(result.ok, false, testCase.name);
      assert.equal(result.executionOutcome, "succeeded", testCase.name);
      assert.equal(result.captureProcessingSucceeded, false, testCase.name);
      assert.equal(result.captures[0].requestId, "capture-envelope", testCase.name);
      assert.equal(result.captures[0].upstreamError.code, "FIGMA_WORKSPACE_CAPTURE_REQUEST_INVALID", testCase.name);
      assert.match(result.captures[0].upstreamError.message, testCase.message, testCase.name);
      assert.deepEqual(calls.filter((entry) => entry[0] === "callTool").map((entry) => entry[1]), ["use_figma"], testCase.name);
    } finally {
      await client.close();
    }
  }
});

test("typed eval enforces the host limit on validated queued captures", async () => {
  const calls = [];
  const client = createFigmaWorkspaceClient({
    client: createFakeUpstream(calls, ({ name }) => {
      assert.equal(name, "use_figma");
      return { content: [{ type: "text", text: JSON.stringify({
        ok: true,
        __figmaWorkspace: {
          sessionId: "oversized-captures",
          currentPageId: "1:1",
          knownPages: {},
          captureRequests: Array.from({ length: 9 }, (_, index) => ({
            requestId: `capture-${index + 1}`,
            nodeId: `${index + 1}:1`,
          })),
        },
        result: { frameId: "1:1" },
      }) }] };
    }),
  });
  try {
    const result = await client.eval({
      sessionId: "oversized-captures",
      code: "return $.capture(figma.currentPage.children[0]);",
    });
    assert.equal(result.ok, false);
    assert.equal(result.captureProcessingSucceeded, false);
    assert.equal(result.captures[0].upstreamError.code, "FIGMA_WORKSPACE_CAPTURE_REQUEST_INVALID");
    assert.match(result.captures[0].upstreamError.message, /8-request host limit/u);
    assert.deepEqual(calls.filter((entry) => entry[0] === "callTool").map((entry) => entry[1]), ["use_figma"]);
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
    assert.ok(guidance.referenceContext.length > 0);
    assert.ok(guidance.referenceContext.every((entry) => typeof entry.docId === "string"));
    assert.ok(guidance.referenceContext.every((entry) => entry.classification !== "examples"));
    assert.equal(guidance.route.surface, "design");
    assert.equal("suggestions" in guidance, false);
    assert.doesNotMatch(JSON.stringify(guidance), /"text"\s*:/u);
    assert.doesNotMatch(JSON.stringify(guidance), /figma_workspace_/u);
    assert.doesNotMatch(JSON.stringify(guidance), /\$\.screenshot|node\.screenshot|SceneNode\.screenshot/u);

    const inferredSlidesGuidance = await client.guidance({ query: "slides presentation" });
    assert.equal(inferredSlidesGuidance.route.surface, "slides");
    assert.ok(inferredSlidesGuidance.cards.every((card) => card.surface === "slides" || card.surface === "any"));
    assert.deepEqual(inferredSlidesGuidance.workflowGraph, []);

    const intentMatrix = [
      ["code connect", "code-connect", "canonical:figma-code-connect/references/api.md"],
      ["create file", "create-file", "canonical:figma-create-new-file/SKILL.md"],
      ["design to code", "design-to-code", "canonical:figma-design-to-code/SKILL.md"],
      ["generate design", "design-generation", "canonical:figma-generate-design/SKILL.md"],
      ["generate diagram", "diagram", "canonical:figma-generate-diagram/SKILL.md"],
      ["create component library", "library-generation", "canonical:figma-generate-library/SKILL.md"],
      ["motion implementation", "motion-implementation", "canonical:figma-implement-motion/SKILL.md"],
      ["swiftui design to code", "swiftui", "canonical:figma-swiftui/SKILL.md"],
      ["figjam board", "figjam", "canonical:figma-use-figjam/SKILL.md"],
      ["motion design", "motion", "canonical:figma-use-motion/SKILL.md"],
      ["slides presentation", "slides", "canonical:figma-use-slides/references/slide-lifecycle.md"],
      ["design editing", "design-editing", "canonical:figma-use/SKILL.md"],
    ];
    for (const [query, taskFamily, topDocId] of intentMatrix) {
      const routed = await client.guidance({ query });
      assert.equal(routed.route.status, "matched", query);
      assert.equal(routed.route.taskFamily, taskFamily, query);
      assert.equal(routed.referenceContext[0]?.docId, topDocId, query);
      if (routed.route.confidence === "low") {
        assert.equal(routed.nextActions[0]?.commandId, "figma:docs:catalog", query);
      } else {
        assert.equal(routed.nextActions[0]?.commandId, "figma:docs:read", query);
        assert.equal(routed.nextActions[0]?.args?.id, topDocId, query);
      }
      assert.ok(routed.nextActions.every((action) => /^figma:/u.test(action.commandId)), query);
      assert.ok(routed.referenceContext.slice(0, 3).every((entry) =>
        !entry.docId.startsWith("canonical:") || entry.taskFamily === taskFamily), query);
    }

    for (const [query, status] of [
      ["layout", "fallback"],
      ["component", "ambiguous"],
      ["quantum banana", "none"],
    ]) {
      const uncertain = await client.guidance({ query });
      assert.equal(uncertain.route.status, status, query);
      assert.equal(uncertain.nextActions[0]?.commandId, "figma:docs:catalog", query);
    }

    for (const removedInput of [
      { mode: "plan", query: "component variants text" },
      { mode: "catalog" },
      { mode: "card", card: "text.font" },
    ]) {
      await assert.rejects(client.guidance(removedInput), /mode.*removed/iu);
    }

    const docsLookup = await client.lookup({
      kind: "docs",
      query: "guidanceRef wrapperProfiles helperProfiles local wrapper tools",
      maxResults: 4,
      maxSnippetLines: 8,
    });
    assert.equal(docsLookup.ok, true);
    assert.ok(docsLookup.results.some((entry) => entry.docId.startsWith("bridge:")));
    assert.match(JSON.stringify(docsLookup.results), /guidance|get-design-context/u);
    assert.doesNotMatch(JSON.stringify(docsLookup.results), /figma_workspace_/u);
    assert.ok(Buffer.byteLength(JSON.stringify(docsLookup), "utf8") <= 12 * 1024);

    const projectDocsLookup = await client.lookup({
      kind: "docs",
      query: "state file sidecars results",
      maxResults: 3,
      maxSnippetLines: 4,
    });
    assert.equal(projectDocsLookup.ok, true);
    assert.ok(projectDocsLookup.results.some((entry) => entry.docId === "project:sessions"));
    assert.match(JSON.stringify(projectDocsLookup.results), /--state-file|\.figma-workspace\/results/u);

    const defaultExampleLookup = await client.lookup({
      kind: "docs",
      query: "cleanupOrphans",
      maxResults: 3,
      maxSnippetLines: 4,
    });
    assert.equal(defaultExampleLookup.ok, true);
    assert.equal(defaultExampleLookup.requestedScope, "auto");
    assert.equal(defaultExampleLookup.effectiveScopes.includes("examples"), false);
    assert.equal(defaultExampleLookup.results.length, 0);

    const exampleLookup = await client.lookup({
      kind: "docs",
      scope: "examples",
      query: "explicitly owned orphans reviewed state ledger",
      maxResults: 3,
      maxSnippetLines: 4,
    });
    assert.equal(exampleLookup.ok, true);
    assert.ok(exampleLookup.results.some(
      (entry) => entry.docId.includes("figma-generate-library/examples/cleanup-orphans"),
    ));
    assert.ok(exampleLookup.results.every((entry) => entry.classification === "examples"));
    assert.ok(exampleLookup.results.every((entry) => entry.nonExecutable === true));
    assert.ok(exampleLookup.results.every((entry) => !entry.docId.includes("/scripts/") && !entry.docId.endsWith(".js")));
    const allExampleLookup = await client.lookup({
      kind: "docs",
      scope: "all",
      query: "explicitly owned orphans reviewed state ledger",
      maxResults: 3,
      maxSnippetLines: 4,
    });
    assert.ok(allExampleLookup.results.some(
      (entry) => entry.docId.includes("figma-generate-library/examples/cleanup-orphans") && entry.nonExecutable === true,
    ));

    const activeLookup = await client.lookup({
      kind: "docs",
      query: "createCodeBlock codeLanguage PLAINTEXT",
      maxResults: 3,
      maxSnippetLines: 4,
    });
    assert.ok(activeLookup.results.some(
      (entry) => entry.docId === "canonical:figma-use-figjam/references/create-code-block.md",
    ));
    assert.ok(activeLookup.results.every((entry) => entry.classification === "active"));

    const conditionalDefaultLookup = await client.lookup({
      kind: "docs",
      query: "code connect advanced patterns",
      maxResults: 5,
      maxSnippetLines: 4,
    });
    assert.ok(conditionalDefaultLookup.results.some(
      (entry) => entry.docId === "canonical:figma-code-connect/references/advanced-patterns.md",
    ));
    const conditionalLookup = await client.lookup({
      kind: "docs",
      scope: "conditional",
      query: "code connect advanced patterns",
      taskFamily: "code-connect",
      maxResults: 5,
      maxSnippetLines: 4,
    });
    assert.ok(conditionalLookup.results.some(
      (entry) => entry.docId === "canonical:figma-code-connect/references/advanced-patterns.md",
    ));
    assert.ok(conditionalLookup.results.every((entry) => entry.classification === "conditional"));

    const routerDefaultLookup = await client.lookup({
      kind: "docs",
      query: "read-FROM-Figma design context response hints",
      maxResults: 5,
      maxSnippetLines: 4,
    });
    assert.ok(routerDefaultLookup.results.some(
      (entry) => entry.docId === "canonical:figma-design-to-code/SKILL.md",
    ));
    const allLookup = await client.lookup({
      kind: "docs",
      scope: "all",
      query: "read-FROM-Figma design context response hints",
      maxResults: 5,
      maxSnippetLines: 4,
    });
    const designToCodeResult = allLookup.results.find(
      (entry) => entry.docId === "canonical:figma-design-to-code/SKILL.md",
    );
    assert.ok(designToCodeResult);
    assert.equal(designToCodeResult.classification, "router");
    assert.equal("sanitized" in designToCodeResult, false);
    assert.equal("text" in designToCodeResult, false);
    assert.doesNotMatch(designToCodeResult.snippet, /invoke skill|skillNames|resource:/iu);

    const lookup = await client.lookup({ kind: "api", symbol: "createFrame", maxResults: 2, maxSnippetLines: 3 });
    assert.equal(lookup.ok, true);
    assert.ok(lookup.results.length > 0);
    assert.equal(lookup.results[0].matchType, "exact-symbol");
    assert.match(JSON.stringify(lookup.results), /createFrame/u);
    assert.ok(lookup.results.every((entry) => entry.classification === "api"));
    assert.ok(lookup.results.every((entry) => entry.apiId.startsWith("api:")));
    assert.ok(lookup.results.every((entry) => !("sourceContract" in entry) && !("text" in entry)));
    const detailedApiLookup = await client.lookup({
      kind: "api",
      symbol: "createFrame",
      maxResults: 10,
      maxSnippetLines: 3,
    });
    const pluginApiLines = (await readFile(
      resolve(import.meta.dirname, "../dist/runtime/figma-plugin-typings/plugin-api.d.ts"),
      "utf8",
    )).replace(/\r\n/gu, "\n").split("\n");
    const createFrameDeclarationLine = pluginApiLines.findIndex(
      (line) => /^\s*createFrame\(\): FrameNode\s*$/u.test(line),
    ) + 1;
    assert.ok(createFrameDeclarationLine > 0);
    const exactCreateFrame = detailedApiLookup.results.find((entry) =>
      entry.matchType === "exact-symbol" &&
      entry.title === "PluginAPI.createFrame" &&
      entry.apiId.includes("plugin-api.d.ts") &&
      entry.lineStart <= createFrameDeclarationLine &&
      entry.lineEnd >= createFrameDeclarationLine);
    assert.ok(exactCreateFrame);
    assert.match(exactCreateFrame.snippet, /^\s*createFrame\(\): FrameNode\s*$/mu);
    assert.ok(detailedApiLookup.results.every((entry) =>
      entry.matchType !== "exact-symbol" || entry.title.endsWith(".createFrame")));
    const caseVariantApiLookup = await client.lookup({
      kind: "api",
      symbol: "CreateFrame",
      maxResults: 5,
      maxSnippetLines: 3,
    });
    assert.ok(caseVariantApiLookup.results.length > 0);
    assert.ok(caseVariantApiLookup.results.every((entry) => entry.matchType !== "exact-symbol"));
    const missingScreenshotLookup = await client.lookup({
      kind: "api",
      symbol: "SceneNode.screenshot",
      maxResults: 5,
      maxSnippetLines: 3,
    });
    assert.ok(missingScreenshotLookup.results.every((entry) => entry.classification === "api"));
    assert.ok(missingScreenshotLookup.results.every((entry) => entry.matchType !== "exact-symbol"));
    const invalidOwnerLookup = await client.lookup({
      kind: "api",
      symbol: "createFrame.createRectangle",
      maxResults: 5,
      maxSnippetLines: 3,
    });
    assert.ok(invalidOwnerLookup.results.every((entry) => entry.matchType !== "exact-symbol"));
    await assert.rejects(
      client.lookup({ kind: "api", scope: "active", symbol: "createFrame" }),
      /scope.*only allowed.*kind.*docs/u,
    );
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
      lastDiagnostics: [],
      history: [
        {
          id: "h1",
          at: "2026-01-02T00:00:00.000Z",
          tool: "figma_workspace_eval",
          summary: "evaluated",
          nodeIds: ["1:2"],
        },
        {
          id: "h2",
          at: "2026-01-02T00:01:00.000Z",
          tool: "legacy-private-operation",
          mode: "legacy",
          summary: "legacy summary",
          nodeIds: ["9:9"],
        },
        {
          id: "h3",
          at: "2026-01-02T00:02:00.000Z",
          tool: "figma_workspace_download_assets",
          mode: "download-assets",
          summary: "downloaded",
          nodeIds: ["3:4"],
        },
      ],
    }],
  });
  try {
    const docs = await client.docs({ mode: "list" });
    assert.equal(docs.ok, true);
    assert.ok(docs.topics.some((entry) => entry.id === "project:workflow"));
    const catalog = await client.docs({ mode: "catalog", taskFamily: "code-connect" });
    assert.ok(catalog.records.some((entry) => entry.id === "canonical:figma-code-connect/references/advanced-patterns.md"));
    const workflow = await client.docs({ mode: "read", id: "project:workflow" });
    assert.equal(workflow.ok, true);
    assert.match(workflow.content, /figma\.ts/u);
    for (const topic of docs.topics) {
      const projectDoc = await client.docs({ mode: "read", id: topic.id });
      assert.doesNotMatch(
        projectDoc.content,
        /figma_workspace_|figma-workspace:\/\/|run-script-file|prepare-task|call-upstream-tool|use_figma|get_metadata|get_design_context|get_motion_context|get_variable_defs|get_libraries|search_design_system|get_screenshot|download-assets/u,
        topic.id,
      );
    }
    const canonicalDoc = await client.docs({ mode: "read", id: "canonical:figma-code-connect/references/advanced-patterns.md" });
    assert.equal(canonicalDoc.kind, "canonical");
    assert.match(canonicalDoc.content, /Code Connect/iu);
    const crossLinkedDoc = await client.docs({ mode: "read", id: "canonical:figma-generate-design/SKILL.md" });
    const canonicalLink = crossLinkedDoc.content.match(/\]\((canonical:[^)]+)\)/u)?.[1];
    assert.equal(typeof canonicalLink, "string");
    const followedCanonicalLink = await client.docs({ mode: "read", id: canonicalLink });
    assert.equal(followedCanonicalLink.ok, true);
    assert.equal(followedCanonicalLink.kind, "canonical");

    const doctor = await client.doctor();
    assert.equal(typeof doctor.runtime.projectDocs.ok, "boolean");
    assert.equal(typeof doctor.runtime.lookup.ok, "boolean");
    assert.equal(typeof doctor.runtime.typescript.ok, "boolean");
    assert.match(doctor.runtime.lookup.canonical.corpusSha256, /^[a-f0-9]{64}$/u);
    assert.equal(doctor.runtime.lookup.canonical.recordCount, 87);
    assert.deepEqual(doctor.runtime.lookup.canonical.inventories.classifications, {
      active: 46,
      conditional: 20,
      router: 12,
      examples: 9,
    });
    assert.equal(doctor.runtime.lookup.api.package, "@figma/plugin-typings");
    assert.match(doctor.runtime.lookup.api.version, /^\d+\.\d+\.\d+/u);
    assert.ok(doctor.runtime.lookup.api.recordCount > 0);
    assert.match(doctor.runtime.lookup.api.indexSha256, /^[a-f0-9]{64}$/u);
    assert.equal("raw" in doctor.runtime.lookup, false);
    assert.equal("active" in doctor.runtime.lookup, false);

    const summaries = await client.sessionsInfo();
    assert.equal(summaries.sessions[0].id, "saved");
    assert.equal("handleCount" in summaries.sessions[0], false);
    const detail = await client.sessionsInfo({ sessionId: "saved" });
    assert.equal("handles" in detail.session, false);
    assert.equal(detail.session.history, undefined);
    const expanded = await client.sessionsInfo({ sessionId: "saved", includeHistory: true });
    assert.equal("handles" in expanded.session, false);
    assert.equal(expanded.session.history.length, 3);
    assert.deepEqual(expanded.session.history[0], {
      id: "h1",
      at: "2026-01-02T00:00:00.000Z",
      commandId: "figma:eval",
      kind: "execution",
      summary: "evaluated",
      nodeIds: ["1:2"],
    });
    assert.deepEqual(expanded.session.history[1], {
      kind: "operation",
      summary: "legacy summary",
    });
    assert.deepEqual(expanded.session.history[2], {
      id: "h3",
      at: "2026-01-02T00:02:00.000Z",
      commandId: "figma:assets:download",
      kind: "assets",
      summary: "downloaded",
      nodeIds: ["3:4"],
    });
    assert.doesNotMatch(JSON.stringify(expanded), /figma_workspace_|legacy-private-operation|download-assets|"tool"/u);
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
    assert.equal(result.executionOutcome, "not_started");
    assert.ok(result.diagnostics.length > 0);
    assert.doesNotMatch(JSON.stringify(result.diagnostics), /figma_workspace_/);
    assert.deepEqual(calls, []);
  } finally {
    await client.close();
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("runScriptFile rejects script-only screenshot methods before upstream execution", async () => {
  const tempDir = await mkdtemp(resolve(tmpdir(), "figma-workspace-client-script-screenshot-"));
  const scriptPath = resolve(tempDir, "unsupported-screenshot.figma.ts");
  await writeFile(scriptPath, "const frame = figma.createFrame();\nawait frame.screenshot();\nreturn frame.id;\n", "utf8");
  const calls = [];
  const client = createFigmaWorkspaceClient({ client: createFakeUpstream(calls) });
  try {
    const result = await client.runScriptFile({ scriptPath });
    assert.equal(result.ok, false);
    assert.equal(result.phase, "preflight");
    assert.equal(result.executionOutcome, "not_started");
    assert.ok(result.diagnostics.some((diagnostic) => /screenshot/u.test(diagnostic.message)));
    assert.deepEqual(calls, []);
  } finally {
    await client.close();
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("runScriptFile forwards valid Plugin API operations without semantic policy diagnostics", async () => {
  const tempDir = await mkdtemp(resolve(tmpdir(), "figma-workspace-client-script-native-api-"));
  const scriptPath = resolve(tempDir, "native-api.figma.ts");
  await writeFile(scriptPath, [
    "const node = figma.createRectangle();",
    "const component = figma.createComponent();",
    "const instance = component.createInstance();",
    "node.setPluginData('owner', 'agent');",
    "const matches = figma.root.findAll((candidate) => candidate.type === 'RECTANGLE');",
    "figma.createImage(new Uint8Array([137, 80, 78, 71]));",
    "figma.currentPage.selection = [node];",
    "await figma.setCurrentPageAsync(figma.currentPage);",
    "await fetch('https://example.com/resource');",
    "const moduleName: string = 'data:text/javascript,export default 1';",
    "await import(moduleName);",
    "eval('1 + 1');",
    "figma.flatten([node]);",
    "instance.detachInstance();",
    "node.remove();",
    "return { matchCount: matches.length };",
  ].join("\n"), "utf8");
  const calls = [];
  const client = createFigmaWorkspaceClient({
    client: createFakeUpstream(calls, ({ name, args }) => {
      assert.equal(name, "use_figma");
      assert.match(args.code, /root\.findAll/u);
      assert.match(args.code, /fetch\(/u);
      assert.match(args.code, /\.remove\(\)/u);
      return { content: [{ type: "text", text: JSON.stringify({
        ok: true,
        __figmaWorkspace: { sessionId: "native-api", currentPageId: "1:1", knownPages: {}, captureRequests: [] },
        result: { matchCount: 1 },
      }) }] };
    }),
  });
  try {
    const result = await client.runScriptFile({ sessionId: "native-api", scriptPath });
    assert.equal(result.ok, true);
    assert.equal(result.executionOutcome, "succeeded");
    assert.deepEqual(result.diagnostics ?? [], []);
    assert.equal(result.upstream.result.matchCount, 1);
    assert.deepEqual(calls.filter((entry) => entry[0] === "callTool").map((entry) => entry[1]), ["use_figma"]);
  } finally {
    await client.close();
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("runScriptFile accepts exactly 50,000 wrapped UTF-8 bytes and rejects 50,001", async () => {
  const tempDir = await mkdtemp(resolve(tmpdir(), "figma-workspace-client-script-size-"));
  const scriptPath = resolve(tempDir, "size-boundary.figma.ts");
  const baselineSource = "/* */\nreturn null;\n";
  await writeFile(scriptPath, baselineSource, "utf8");
  const calls = [];
  const wrappedByteLengths = [];
  const client = createFigmaWorkspaceClient({
    client: createFakeUpstream(calls, ({ name, args }) => {
      assert.equal(name, "use_figma");
      wrappedByteLengths.push(Buffer.byteLength(args.code, "utf8"));
      return { content: [{ type: "text", text: JSON.stringify({
        ok: true,
        __figmaWorkspace: {
          sessionId: "size-boundary",
          currentPageId: "1:1",
          knownPages: {},
          captureRequests: [],
        },
        result: null,
      }) }] };
    }),
  });
  try {
    const baseline = await client.runScriptFile({ sessionId: "size-boundary", scriptPath });
    assert.equal(baseline.ok, true);
    assert.equal(wrappedByteLengths.length, 1);
    let paddingLength = 50_000 - wrappedByteLengths[0];
    assert.ok(paddingLength > 0);

    await writeFile(scriptPath, `/*${"x".repeat(paddingLength)} */\nreturn null;\n`, "utf8");
    const calibration = await client.runScriptFile({ sessionId: "size-boundary", scriptPath });
    assert.equal(calibration.ok, true);
    paddingLength += 50_000 - wrappedByteLengths.at(-1);

    if (wrappedByteLengths.at(-1) !== 50_000) {
      await writeFile(scriptPath, `/*${"x".repeat(paddingLength)} */\nreturn null;\n`, "utf8");
      const exact = await client.runScriptFile({ sessionId: "size-boundary", scriptPath });
      assert.equal(exact.ok, true);
    }
    assert.equal(wrappedByteLengths.at(-1), 50_000);
    const acceptedCallCount = wrappedByteLengths.length;

    await writeFile(scriptPath, `/*${"x".repeat(paddingLength + 1)} */\nreturn null;\n`, "utf8");
    const oversized = await client.runScriptFile({ sessionId: "size-boundary", scriptPath });
    assert.equal(oversized.ok, false);
    assert.equal(oversized.phase, "preflight");
    assert.equal(oversized.executionOutcome, "not_started");
    assert.ok(oversized.diagnostics.some((diagnostic) => diagnostic.code === "FIGMA_WORKSPACE_SCRIPT_PAYLOAD_TOO_LARGE"));
    assert.equal(wrappedByteLengths.length, acceptedCallCount);
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
        __figmaWorkspace: { sessionId: "script-success", currentPageId: "1:1", knownPages: {}, captureRequests: [] },
        result: { frameId: "30:1" },
      }) }] };
    }),
  });
  try {
    const result = await client.runScriptFile({ sessionId: "script-success", scriptPath });
    assert.equal(result.ok, true);
    assert.equal(result.phase, "execute");
    assert.equal(result.executionOutcome, "succeeded");
    assert.equal(result.upstream.result.frameId, "30:1");
    assert.deepEqual(calls.map((entry) => entry[0]), ["connect", "listTools", "callTool"]);
  } finally {
    await client.close();
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("runScriptFile preserves script success when a queued capture fails", async () => {
  const tempDir = await mkdtemp(resolve(tmpdir(), "figma-workspace-client-script-capture-failure-"));
  const scriptPath = resolve(tempDir, "capture-failure.figma.ts");
  await writeFile(scriptPath, [
    "const frame = figma.createFrame();",
    "await $.capture(frame);",
    "return { frameId: frame.id };",
  ].join("\n"), "utf8");
  const calls = [];
  const client = createFigmaWorkspaceClient({
    client: createFakeUpstream(calls, ({ name }) => {
      if (name === "use_figma") {
        return { content: [{ type: "text", text: JSON.stringify({
          ok: true,
          __figmaWorkspace: {
            sessionId: "queued-script-failure",
            currentPageId: "1:1",
            knownPages: {},
            captureRequests: [{ requestId: "capture-1", nodeId: "30:1" }],
          },
          result: { frameId: "30:1" },
        }) }] };
      }
      assert.equal(name, "get_screenshot");
      return { content: [{ type: "text", text: JSON.stringify({
        ok: false,
        error: {
          code: "CAPTURE_FAILED",
          message: `Screenshot unavailable. ${"图".repeat(1000)}`,
          details: { secretMarker: "must-not-reach-public-capture-result", payload: "x".repeat(20_000) },
        },
      }) }] };
    }, {
      tools: [
        {
          name: "use_figma",
          description: "Execute JavaScript in Figma.",
          inputSchema: {
            type: "object",
            properties: { code: { type: "string" }, description: { type: "string" }, fileKey: { type: "string" } },
            required: ["code", "fileKey"],
          },
        },
        {
          name: "get_screenshot",
          inputSchema: {
            type: "object",
            properties: { fileKey: { type: "string" }, nodeId: { type: "string" } },
            required: ["fileKey", "nodeId"],
          },
        },
      ],
    }),
  });
  try {
    await client.open({
      sessionId: "queued-script-failure",
      file: "https://www.figma.com/design/file123/Test",
      workspaceDir: tempDir,
      connect: false,
    });
    const result = await client.runScriptFile({
      sessionId: "queued-script-failure",
      scriptPath,
    });
    assert.equal(result.ok, false);
    assert.equal(result.phase, "execute");
    assert.equal(result.executionOutcome, "succeeded");
    assert.equal(result.captureProcessingSucceeded, false);
    assert.match(result.retryGuidance, /Do not rerun/u);
    assert.equal(result.upstream.result.frameId, "30:1");
    assert.equal(result.captures[0].ok, false);
    assert.equal(result.captures[0].upstreamError.code, "CAPTURE_FAILED");
    assert.ok(Buffer.byteLength(result.captures[0].upstreamError.message, "utf8") <= 600);
    assert.equal("details" in result.captures[0].upstreamError, false);
    assert.doesNotMatch(JSON.stringify(result.captures), /must-not-reach-public-capture-result/u);
    assert.ok(result.outputFiles?.debugFile?.path);
    assert.deepEqual(calls.filter((entry) => entry[0] === "callTool").map((entry) => entry[1]), ["use_figma", "get_screenshot"]);
  } finally {
    await client.close();
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("applyAssetManifest validates official upload_assets arguments offline", async () => {
  const tempDir = await mkdtemp(resolve(tmpdir(), "figma-workspace-client-assets-"));
  const fileA = "AssetSourceFileKey012345";
  const fileB = "AssetTargetFileKey012345";
  const assetPath = resolve(tempDir, "hero.png");
  await writeFile(assetPath, "fake image bytes", "utf8");
  const calls = [];
  const client = createFigmaWorkspaceClient({
    client: createFakeUpstream(calls, ({ name, args }) => {
      assert.equal(name, "upload_assets");
      assert.deepEqual(args, { fileKey: fileB, count: 1, nodeId: "12:34", scaleMode: "FILL" });
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
      file: `https://www.figma.com/design/${fileA}/Test`,
      workspaceDir: tempDir,
      connect: false,
    });
    const result = await client.applyAssetManifest({
      sessionId: "asset-test",
      assets: [{ path: assetPath, target: { fileKey: fileB, nodeId: "12:34" }, name: "Hero art" }],
      validateTargets: false,
    });
    assert.equal(result.ok, true);
    assert.equal(result.assets.length, 1);
    assert.equal(result.failures, undefined);
    assert.deepEqual(calls.map((entry) => entry[0]), ["connect", "listTools", "callTool"]);
    assert.equal(client.sessions.get("asset-test").fileKey, fileA);
  } finally {
    await client.close();
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("downloadAssets groups cross-file targets without rebinding the session", async () => {
  const tempDir = await mkdtemp(resolve(tmpdir(), "figma-workspace-client-download-assets-"));
  const fileA = "DownloadSourceFileKey0123";
  const fileB = "DownloadTargetFileKey0123";
  const calls = [];
  const client = createFigmaWorkspaceClient({
    client: createFakeUpstream(calls, ({ name, args }) => {
      assert.equal(name, "download_assets");
      assert.deepEqual(args, { fileKey: fileB, nodeId: "15:9" });
      return { content: [{ type: "text", text: JSON.stringify({
        ok: false,
        error: { code: "EXPECTED_TEST_FAILURE", message: "No download required for routing test." },
      }) }] };
    }, {
      tools: [{
        name: "download_assets",
        inputSchema: {
          type: "object",
          properties: { fileKey: { type: "string" }, nodeId: { type: "string" } },
          required: ["fileKey", "nodeId"],
        },
      }],
    }),
  });
  try {
    await client.open({
      sessionId: "download-cross-file",
      file: `https://www.figma.com/design/${fileA}/Source`,
      workspaceDir: tempDir,
      connect: false,
    });
    const result = await client.downloadAssets({
      sessionId: "download-cross-file",
      targets: [{ target: { fileKey: fileB, nodeId: "15:9" } }],
      outputDir: resolve(tempDir, "downloads"),
    });
    assert.equal(result.ok, false);
    assert.equal(calls.filter((entry) => entry[0] === "callTool").length, 1);
    assert.equal(client.sessions.get("download-cross-file").fileKey, fileA);
  } finally {
    await client.close();
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("captureNode writes a deterministic PNG returned by get_screenshot", async () => {
  const tempDir = await mkdtemp(resolve(tmpdir(), "figma-workspace-client-capture-"));
  const fileA = "CaptureSourceFileKey0123";
  const fileB = "CaptureTargetFileKey0123";
  const outputFile = resolve(tempDir, "capture.png");
  const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAFgwJ/lP2PAAAAAElFTkSuQmCC", "base64");
  const calls = [];
  const client = createFigmaWorkspaceClient({
    client: createFakeUpstream(calls, ({ name, args }) => {
      assert.equal(name, "get_screenshot");
      assert.deepEqual(args, { fileKey: fileB, nodeId: "22:7" });
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
    await client.open({
      sessionId: "capture-cross-file",
      file: `https://www.figma.com/design/${fileA}/Source`,
      workspaceDir: tempDir,
      connect: false,
    });
    const result = await client.captureNode({
      sessionId: "capture-cross-file",
      target: { fileKey: fileB, nodeId: "22:7" },
      imageFile: outputFile,
    });
    assert.equal(result.ok, true);
    assert.equal(result.imageFile, outputFile);
    assert.equal((await readFile(outputFile)).subarray(0, 8).toString("hex"), "89504e470d0a1a0a");
    assert.equal(client.sessions.get("capture-cross-file").fileKey, fileA);
  } finally {
    await client.close();
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("captureNode fails closed for explicit non-PNG MIME types and malformed PNG payloads", async () => {
  const tempDir = await mkdtemp(resolve(tmpdir(), "figma-workspace-client-capture-invalid-"));
  const validPng = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAFgwJ/lP2PAAAAAElFTkSuQmCC", "base64");
  const invalidPayloads = [
    { name: "explicit non-PNG MIME", mimeType: "image/jpeg", data: validPng, message: /image\/png.*image\/jpeg/iu },
    { name: "short PNG", mimeType: "image/png", data: validPng.subarray(0, 24), message: /IHDR chunk is incomplete/iu },
    { name: "forged IHDR", mimeType: "image/png", data: Buffer.concat([validPng.subarray(0, 8), Buffer.from([0, 0, 0, 13]), Buffer.from("JUNK"), validPng.subarray(16)]), message: /IHDR chunk is missing or invalid/iu },
    { name: "zero dimensions", mimeType: "image/png", data: Buffer.from(validPng).fill(0, 16, 24), message: /width and height must be positive/iu },
  ];
  try {
    for (const fixture of invalidPayloads) {
      const outputFile = resolve(tempDir, `${fixture.name}.png`);
      const calls = [];
      const client = createFigmaWorkspaceClient({
        client: createFakeUpstream(calls, () => ({
          content: [{ type: "image", mimeType: fixture.mimeType, data: fixture.data.toString("base64") }],
        }), {
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
        assert.equal(result.ok, false, fixture.name);
        assert.match(result.upstreamError.message, fixture.message, fixture.name);
        await assert.rejects(readFile(outputFile));
      } finally {
        await client.close();
      }
    }
  } finally {
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
      connect: false,
    });
    const metadata = await client.getMetadata({ sessionId: "context-test", target: "1:2" });
    assert.equal(metadata.ok, true);
    assert.equal(metadata.metadata.source, "figma:metadata");
    assert.equal(metadata.metadata.json.source, "figma:metadata");
    assert.equal(metadata.metadata.json.root.nodeId, "1:2");
    const design = await client.getDesignContext({ sessionId: "context-test", target: "1:2" });
    assert.equal(design.ok, true);
    assert.equal(design.upstream.result.code, "<div />");
    const inspect = await client.inspect({ sessionId: "context-test", target: "1:2" });
    assert.equal(inspect.ok, true);
    assert.equal(inspect.summary.locked, true);
    await assert.rejects(
      client.getMetadata({ sessionId: "context-test", target: "$root" }),
      /no longer accepts local handles|raw node id/iu,
    );
    await assert.rejects(
      client.getDesignContext({ sessionId: "context-test", target: { handle: "$root" } }),
      /no longer accepts local handles|nodeId/iu,
    );
  } finally {
    await client.close();
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("inspect and style use node URL file context without rebinding the session", async () => {
  const tempDir = await mkdtemp(resolve(tmpdir(), "figma-workspace-cross-file-inspect-"));
  const fileA = "InspectFileAKey0123456789";
  const fileB = "InspectFileBKey0123456789";
  const calls = [];
  const client = createFigmaWorkspaceClient({
    client: createFakeUpstream(calls, ({ name, args }) => {
      assert.equal(name, "use_figma");
      const target = args.code.match(/const __target = "([^"]+)";/u)?.[1];
      assert.notEqual(target, undefined);
      assert.doesNotMatch(args.code, /https:\/\/www\.figma\.com/u);
      const style = args.code.includes("const __includeSummary");
      return { content: [{ type: "text", text: JSON.stringify({
        ok: true,
        __figmaWorkspace: {
          sessionId: "cross-file-inspect",
          currentPageId: args.fileKey === fileB ? "B:page" : "A:page",
          knownPages: args.fileKey === fileB ? { B: "B:page" } : { A: "A:page" },
          captureRequests: [],
        },
        result: style
          ? {
              target,
              mode: "style",
              nodeCount: 1,
              scannedNodeCount: 1,
              targetSummary: { id: target, type: "FRAME", name: "Target" },
              styleCounts: {},
              style: {},
            }
          : {
              target,
              mode: "inspect",
              summary: target === "$selection" ? [] : { id: target, type: "FRAME", name: "Target" },
            },
      }) }] };
    }, {
      tools: [{
        name: "use_figma",
        inputSchema: {
          type: "object",
          properties: { code: { type: "string" }, fileKey: { type: "string" } },
          required: ["code", "fileKey"],
        },
      }],
    }),
  });
  const nodeUrl = `https://www.figma.com/design/${fileB}/Target?node-id=22-7`;
  try {
    await client.open({
      sessionId: "cross-file-inspect",
      file: `https://www.figma.com/design/${fileA}/Source`,
      workspaceDir: tempDir,
      currentPageId: "A:page",
      connect: false,
    });

    const inspected = await client.inspect({ sessionId: "cross-file-inspect", target: nodeUrl });
    assert.equal(inspected.ok, true);
    assert.equal(inspected.target, "22:7");
    const styled = await client.inspect({ sessionId: "cross-file-inspect", target: nodeUrl, mode: "style" });
    assert.equal(styled.ok, true);
    assert.equal(styled.target, "22:7");

    const raw = await client.inspect({ sessionId: "cross-file-inspect", target: "33:9" });
    assert.equal(raw.target, "33:9");
    const instanceQualified = await client.inspect({
      sessionId: "cross-file-inspect",
      target: "I4005:6111;30:8005",
    });
    assert.equal(instanceQualified.target, "I4005:6111;30:8005");
    const selection = await client.inspect({ sessionId: "cross-file-inspect", target: "$selection" });
    assert.equal(selection.target, "$selection");

    const evalCalls = calls.filter((entry) => entry[0] === "callTool");
    assert.deepEqual(evalCalls.map((entry) => entry[2].fileKey), [fileB, fileB, fileA, fileA, fileA]);
    assert.match(evalCalls[0][2].code, /const __target = "22:7";/u);
    assert.match(evalCalls[1][2].code, /const __target = "22:7";/u);
    assert.match(evalCalls[2][2].code, /const __target = "33:9";/u);
    assert.match(evalCalls[3][2].code, /const __target = "I4005:6111;30:8005";/u);
    assert.match(evalCalls[4][2].code, /const __target = "\$selection";/u);

    const session = client.sessions.get("cross-file-inspect");
    assert.equal(session.fileKey, fileA);
    assert.equal(session.fileUrl, `https://www.figma.com/design/${fileA}/Source`);
    assert.equal(session.currentPageId, "A:page");
    assert.deepEqual(session.knownPages, { A: "A:page" });

    const withoutSession = await client.inspect({ sessionId: "url-only-inspect", target: nodeUrl });
    assert.equal(withoutSession.ok, true);
    const urlOnlySession = client.sessions.get("url-only-inspect");
    assert.equal(urlOnlySession.fileKey, undefined);
    assert.equal(urlOnlySession.fileUrl, undefined);
    assert.equal(urlOnlySession.currentPageId, undefined);
    assert.deepEqual(urlOnlySession.knownPages, {});
    assert.equal(calls.filter((entry) => entry[0] === "callTool").at(-1)[2].fileKey, fileB);

    const beforeInvalidUrlCallCount = calls.length;
    await assert.rejects(
      client.inspect({ sessionId: "cross-file-inspect", target: `https://www.figma.com/design/${fileB}/Target` }),
      /node URL must include a node-id/iu,
    );
    await assert.rejects(
      client.inspect({ sessionId: "cross-file-inspect", target: `https://example.com/design/${fileB}/Target?node-id=22-7` }),
      /figma\.com Figma URL/iu,
    );
    await assert.rejects(
      client.inspect({ sessionId: "cross-file-inspect", target: "https://[" }),
      /target URL is malformed/iu,
    );
    await assert.rejects(
      client.inspect({ sessionId: "cross-file-inspect", target: `ftp://www.figma.com/design/${fileB}/Target?node-id=22-7` }),
      /https:\/\/\*\.figma\.com/iu,
    );
    assert.equal(calls.length, beforeInvalidUrlCallCount);
    assert.equal(client.sessions.get("cross-file-inspect").fileKey, fileA);
  } finally {
    await client.close();
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("cross-file metadata keeps main and enrichment reads together and rejects conflicts before upstream", async () => {
  const tempDir = await mkdtemp(resolve(tmpdir(), "figma-workspace-cross-file-metadata-"));
  const fileA = "MetadataFileAKey0123456789";
  const fileB = "MetadataFileBKey0123456789";
  const conflictingFile = "MetadataConflictKey012345";
  const calls = [];
  const client = createFigmaWorkspaceClient({
    client: createFakeUpstream(calls, ({ name, args }) => {
      if (name === "get_metadata") {
        assert.equal(args.fileKey, fileB);
        assert.equal(args.nodeId, "22:7");
        return { content: [{ type: "text", text: '<frame id="22:7" name="Cross-file target" width="300" height="200" />' }] };
      }
      assert.equal(name, "use_figma");
      assert.equal(args.fileKey, fileB);
      assert.match(args.code, /const __metadataNodeIds = \["22:7"\];/u);
      return { content: [{ type: "text", text: JSON.stringify({
        ok: true,
        result: { enrichment: { nodes: { "22:7": { locked: false, layoutMode: "VERTICAL" } } } },
      }) }] };
    }, {
      tools: [
        {
          name: "get_metadata",
          inputSchema: {
            type: "object",
            properties: { fileKey: { type: "string" }, nodeId: { type: "string" } },
            required: ["fileKey"],
          },
        },
        {
          name: "use_figma",
          inputSchema: {
            type: "object",
            properties: { code: { type: "string" }, fileKey: { type: "string" } },
            required: ["code", "fileKey"],
          },
        },
      ],
    }),
  });
  const nodeUrl = `https://www.figma.com/design/${fileB}/Target?node-id=22-7`;
  try {
    await client.open({
      sessionId: "cross-file-metadata",
      file: `https://www.figma.com/design/${fileA}/Source`,
      workspaceDir: tempDir,
      currentPageId: "A:page",
      connect: false,
    });
    const metadata = await client.getMetadata({ sessionId: "cross-file-metadata", target: nodeUrl });
    assert.equal(metadata.ok, true);
    assert.equal(metadata.fileKey, fileB);
    assert.equal(metadata.nodeId, "22:7");
    assert.equal(metadata.metadata.source, "figma:metadata");
    assert.equal(metadata.metadata.json.root.locked, false);
    assert.equal(metadata.metadata.json.root.layoutMode, "VERTICAL");
    assert.deepEqual(
      calls.filter((entry) => entry[0] === "callTool").map((entry) => [entry[1], entry[2].fileKey]),
      [["get_metadata", fileB], ["use_figma", fileB]],
    );

    const beforeConflictCallCount = calls.length;
    await assert.rejects(
      client.getMetadata({
        sessionId: "cross-file-metadata",
        file: `https://www.figma.com/design/${conflictingFile}/Conflict`,
        target: nodeUrl,
      }),
      /conflicting file contexts/iu,
    );
    assert.equal(calls.length, beforeConflictCallCount);
    const session = client.sessions.get("cross-file-metadata");
    assert.equal(session.fileKey, fileA);
    assert.equal(session.fileUrl, `https://www.figma.com/design/${fileA}/Source`);
    assert.equal(session.currentPageId, "A:page");
  } finally {
    await client.close();
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("all dedicated node-scoped reads keep target file context request-scoped", async () => {
  const tempDir = await mkdtemp(resolve(tmpdir(), "figma-workspace-cross-file-node-reads-"));
  const fileA = "NodeReadFileAKey0123456789";
  const fileB = "NodeReadFileBKey0123456789";
  const conflictingFile = "NodeReadConflictKey012345";
  const calls = [];
  const client = createFigmaWorkspaceClient({
    client: createFakeUpstream(calls, ({ name, args }) => {
      assert.equal(args.fileKey, fileB);
      assert.equal(args.nodeId, "44:8");
      return { content: [{ type: "text", text: JSON.stringify({ ok: true, source: name }) }] };
    }, {
      tools: ["get_design_context", "get_motion_context", "get_variable_defs"].map((name) => ({
        name,
        inputSchema: {
          type: "object",
          properties: { fileKey: { type: "string" }, nodeId: { type: "string" } },
          required: ["fileKey", "nodeId"],
        },
      })),
    }),
  });
  const nodeUrl = `https://www.figma.com/design/${fileB}/Target?node-id=44-8`;
  try {
    await client.open({
      sessionId: "cross-file-node-reads",
      file: `https://www.figma.com/design/${fileA}/Source`,
      workspaceDir: tempDir,
      currentPageId: "A:page",
      connect: false,
    });

    assert.equal((await client.getDesignContext({ sessionId: "cross-file-node-reads", target: nodeUrl })).ok, true);
    assert.equal((await client.getMotionContext({ sessionId: "cross-file-node-reads", target: nodeUrl })).ok, true);
    assert.equal((await client.getVariableDefs({ sessionId: "cross-file-node-reads", target: nodeUrl })).ok, true);
    assert.deepEqual(
      calls.filter((entry) => entry[0] === "callTool").map((entry) => [entry[1], entry[2].fileKey, entry[2].nodeId]),
      [
        ["get_design_context", fileB, "44:8"],
        ["get_motion_context", fileB, "44:8"],
        ["get_variable_defs", fileB, "44:8"],
      ],
    );

    const beforeConflictCallCount = calls.length;
    for (const run of [
      () => client.getDesignContext({ sessionId: "cross-file-node-reads", file: conflictingFile, target: nodeUrl }),
      () => client.getMotionContext({ sessionId: "cross-file-node-reads", file: conflictingFile, target: nodeUrl }),
      () => client.getVariableDefs({ sessionId: "cross-file-node-reads", file: conflictingFile, target: nodeUrl }),
    ]) {
      await assert.rejects(run(), /conflicting file contexts/iu);
    }
    assert.equal(calls.length, beforeConflictCallCount);
    const session = client.sessions.get("cross-file-node-reads");
    assert.equal(session.fileKey, fileA);
    assert.equal(session.fileUrl, `https://www.figma.com/design/${fileA}/Source`);
    assert.equal(session.currentPageId, "A:page");
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
    assert.equal(result.executionOutcome, "outcome_unknown");
    assert.match(result.retryGuidance, /Do not rerun.*blindly.*reconcile/iu);
    assert.equal(result.upstreamError.code, "FIGMA_INSTANCE_CHILD_REMOVE");
    assert.match(result.upstreamError.message, /instance child/u);
    assert.equal(result.upstream.ok, false);
  } finally {
    await client.close();
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("runScriptFile distinguishes connection failure from a dispatched transport failure", async () => {
  const tempDir = await mkdtemp(resolve(tmpdir(), "figma-workspace-client-dispatch-failure-"));
  const scriptPath = resolve(tempDir, "dispatch-failure.figma.ts");
  await writeFile(scriptPath, "return figma.createFrame().id;", "utf8");
  try {
    const connectCalls = [];
    const connectFailureClient = createFigmaWorkspaceClient({
      client: createFakeUpstream(connectCalls, undefined, {
        connectError: new Error("login required"),
      }),
    });
    try {
      const result = await connectFailureClient.runScriptFile({ scriptPath });
      assert.equal(result.ok, false);
      assert.equal(result.phase, "preflight");
      assert.equal(result.executionOutcome, "not_started");
      assert.equal(result.retryGuidance, undefined);
      assert.deepEqual(connectCalls, [["connect"]]);
    } finally {
      await connectFailureClient.close();
    }

    const dispatchCalls = [];
    const dispatchFailureClient = createFigmaWorkspaceClient({
      client: createFakeUpstream(dispatchCalls, () => {
        throw Object.assign(new Error("socket closed"), { code: "ECONNRESET" });
      }),
    });
    try {
      const result = await dispatchFailureClient.runScriptFile({ scriptPath });
      assert.equal(result.ok, false);
      assert.equal(result.phase, "execute");
      assert.equal(result.executionOutcome, "outcome_unknown");
      assert.match(result.retryGuidance, /Do not rerun.*blindly.*reconcile/iu);
      assert.equal(dispatchCalls.filter((entry) => entry[0] === "callTool").length, 1);
    } finally {
      await dispatchFailureClient.close();
    }
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("runScriptFile preserves confirmed and unknown outcomes when result sidecars fail", async () => {
  const cases = [
    {
      name: "confirmed",
      response: { content: [{ type: "text", text: JSON.stringify({ ok: true, result: { changedNodeIds: ["8:1"] } }) }] },
      outcome: "succeeded",
    },
    {
      name: "partial mutation",
      response: { content: [{ type: "text", text: JSON.stringify({ ok: false, error: { code: "PARTIAL", message: "Created a node, then failed." } }) }] },
      outcome: "outcome_unknown",
    },
  ];
  for (const fixture of cases) {
    const tempDir = await mkdtemp(resolve(tmpdir(), `figma-workspace-sidecar-${fixture.name}-`));
    const workspaceDir = resolve(tempDir, "workspace");
    const client = createFigmaWorkspaceClient({
      client: createFakeUpstream([], () => fixture.response),
    });
    try {
      const prepared = await client.prepareTask({
        workspaceDir,
        taskName: "sidecar-recovery",
        fileName: "sidecar-recovery.figma.ts",
      });
      await writeFile(resolve(workspaceDir, "sidecar-recovery.figma.ts"), "return figma.createFrame().id;", "utf8");
      await mkdir(resolve(workspaceDir, "sidecar-recovery.result.json"));
      const result = await client.runScriptFile({
        inputFile: prepared.task.workspace.files.inputFile,
        inlineResultLimit: 0,
      });
      assert.equal(result.ok, false, fixture.name);
      assert.equal(result.executionOutcome, fixture.outcome, fixture.name);
      assert.equal(result.postProcessing.scriptResultSidecars.status, "failed", fixture.name);
      assert.match(result.postProcessing.scriptResultSidecars.message, /regular file|directory/iu, fixture.name);
      assert.match(result.retryGuidance, /Do not rerun|reconcile/iu, fixture.name);
    } finally {
      await client.close();
      await rm(tempDir, { recursive: true, force: true });
    }
  }
});

test("eval preserves a confirmed outcome when generated sidecars cannot be written", async () => {
  const tempDir = await mkdtemp(resolve(tmpdir(), "figma-workspace-eval-sidecar-"));
  const workspaceDir = resolve(tempDir, "workspace");
  const client = createFigmaWorkspaceClient({
    client: createFakeUpstream([], () => ({
      content: [{ type: "text", text: JSON.stringify({ ok: true, result: { changedNodeIds: ["9:1"] } }) }],
    })),
  });
  try {
    await client.prepareTask({ workspaceDir, taskName: "eval-sidecar" });
    await rm(workspaceDir, { recursive: true, force: true });
    await writeFile(workspaceDir, "blocks generated sidecars", "utf8");
    const result = await client.eval({
      code: "return figma.createFrame().id;",
      inlineResultLimit: 0,
    });
    assert.equal(result.ok, false);
    assert.equal(result.executionOutcome, "succeeded");
    assert.equal(result.postProcessing.backendSidecars.status, "failed");
    assert.match(result.retryGuidance, /Do not rerun/iu);
  } finally {
    await client.close();
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("workspace script, manifest, and asset inputs reject symlinks before upstream dispatch", async (t) => {
  const tempDir = await mkdtemp(resolve(tmpdir(), "figma-workspace-managed-input-"));
  const workspaceDir = resolve(tempDir, "workspace");
  const calls = [];
  const client = createFigmaWorkspaceClient({ client: createFakeUpstream(calls) });
  try {
    await client.prepareTask({
      workspaceDir,
      taskName: "managed-input",
      fileName: "managed-input.figma.ts",
    });
    const externalDir = resolve(tempDir, "external");
    const linkedDir = resolve(workspaceDir, "linked");
    await mkdir(externalDir);
    await writeFile(resolve(externalDir, "external.figma.ts"), "return true;", "utf8");
    await writeFile(resolve(externalDir, "external-manifest.json"), JSON.stringify({ assets: [{ path: "asset.png", target: { fileKey: "ManagedInputFileKey123", nodeId: "1:1" } }] }), "utf8");
    await writeFile(resolve(externalDir, "asset.png"), Buffer.from([1, 2, 3]));
    try {
      await symlink(externalDir, linkedDir, process.platform === "win32" ? "junction" : "dir");
    } catch (error) {
      if (error?.code === "EPERM") {
        t.skip("Creating a junction or directory symlink is unavailable on this filesystem.");
        return;
      }
      throw error;
    }
    await assert.rejects(
      client.runScriptFile({ inputFile: "linked/external.figma.ts" }),
      /regular file|symlink|reparse/iu,
    );

    const manifestResult = await client.applyAssetManifest({ manifestPath: "linked/external-manifest.json", validateTargets: false });
    assert.equal(manifestResult.ok, false);
    assert.match(manifestResult.diagnostics[0].message, /regular file|symlink|reparse/iu);

    await writeFile(resolve(workspaceDir, "manifest.json"), JSON.stringify({ assets: [{ path: "linked/asset.png", target: { fileKey: "ManagedInputFileKey123", nodeId: "1:1" } }] }), "utf8");
    await assert.rejects(
      client.applyAssetManifest({ manifestPath: "manifest.json", validateTargets: false }),
      /regular file|symlink|reparse/iu,
    );
    assert.deepEqual(calls.filter((entry) => entry[0] === "callTool"), []);
  } finally {
    await client.close();
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("post-response budget failures preserve confirmed and unknown mutation outcomes", async () => {
  const oversizedResponse = { payload: "x".repeat(64 * 1024 * 1024) };
  const evalClient = createFigmaWorkspaceClient({
    client: createFakeUpstream([], () => oversizedResponse),
  });
  try {
    const result = await evalClient.eval({ code: "return figma.createFrame().id;" });
    assert.equal(result.ok, false);
    assert.equal(result.executionOutcome, "succeeded");
    assert.equal(result.postProcessing.upstreamResponseBudget.status, "failed");
    assert.equal(result.postProcessing.upstreamResponseBudget.code, "FIGMA_WORKSPACE_RESOURCE_LIMIT_EXCEEDED");
  } finally {
    await evalClient.close();
  }

  const failedResponse = {
    content: [{ type: "text", text: JSON.stringify({ ok: false, error: { code: "PARTIAL", message: "Mutation failed." } }) }],
    payload: "x".repeat(64 * 1024 * 1024),
  };
  const failedEvalClient = createFigmaWorkspaceClient({
    client: createFakeUpstream([], () => failedResponse),
  });
  try {
    const result = await failedEvalClient.eval({ code: "return figma.createFrame().id;" });
    assert.equal(result.executionOutcome, "outcome_unknown");
    assert.equal(result.upstreamError.code, "PARTIAL");
    assert.equal(result.postProcessing.upstreamResponseBudget.code, "FIGMA_WORKSPACE_RESOURCE_LIMIT_EXCEEDED");
  } finally {
    await failedEvalClient.close();
  }

  const dedicatedClient = createFigmaWorkspaceClient({
    client: createFakeUpstream([], () => oversizedResponse, {
      tools: [{
        name: "get_libraries",
        inputSchema: { type: "object", properties: { fileKey: { type: "string" } } },
      }],
    }),
    initialSessions: [{
      id: "default",
      slug: "default",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
      fileKey: "ResponseBudgetFileKey123",
      knownPages: {},
      lastDiagnostics: [],
      history: [],
    }],
  });
  try {
    await assert.rejects(
      dedicatedClient.getLibraries({}),
      /64 MiB/iu,
    );
  } finally {
    await dedicatedClient.close();
  }

  const rawClient = createFigmaWorkspaceClient({
    client: createFakeUpstream([], () => oversizedResponse, {
      tools: [{ name: "whoami", inputSchema: { type: "object", properties: {} } }],
    }),
  });
  try {
    await assert.rejects(
      rawClient.callUpstreamTool({ toolName: "whoami", arguments: {} }),
      /64 MiB/iu,
    );
  } finally {
    await rawClient.close();
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
    const template = await readFile(resolve(workspaceDir, "build-card.figma.ts"), "utf8");
    assert.match(template, /figma/u);
    assert.doesNotMatch(
      template,
      /figma_workspace_|run-script-file|prepare-task|call-upstream-tool|use_figma|figma-workspace:\/\//u,
    );
    assert.deepEqual(calls, []);
  } finally {
    await client.close();
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("buildFigmaEvalScript always injects one frozen non-callable two-helper namespace", () => {
  const wrapper = buildFigmaEvalScript({
    session: {
      id: "main",
      knownPages: {},
    },
    code: "return figma.currentPage.id;",
  });
  assert.match(wrapper, /figma\.currentPage\.id/u);
  assert.match(wrapper, /const \$ = Object\.freeze\(\{\s*text: __figmaWorkspaceText,\s*capture: __figmaWorkspaceCapture,?\s*\}\);/u);
  assert.match(wrapper, /async function __figmaWorkspaceText\(input\)/u);
  assert.match(wrapper, /async function __figmaWorkspaceCapture\(target, options = \{\}\)/u);
  assert.match(wrapper, /__figmaWorkspace/u);
  assert.doesNotMatch(wrapper, /function\s+\$\s*\(|const\s+\$\s*=\s*(?:async\s*)?\(/u);
  assert.doesNotMatch(
    wrapper,
    /\$\.(?:handles|remember|forget|resolveId|node|select|inspect|checkpoint|checkpoints|imageAsset|findFreeSlot|placeNode|replaceGeneratedFrame|cloneNodeTree|screenshot)|node\.screenshot|injectedHelpers|helperApiVersion/u,
  );
  assert.doesNotMatch(wrapper, /\bhandles\b/u);
});

test("eval and .figma.ts execution inject byte-identical helper bootstrap", async () => {
  const tempDir = await mkdtemp(resolve(tmpdir(), "figma-workspace-shared-bootstrap-"));
  const scriptPath = resolve(tempDir, "shared-bootstrap.figma.ts");
  await writeFile(scriptPath, "return 2;\n", "utf8");
  const wrappedScripts = [];
  const client = createFigmaWorkspaceClient({
    client: createFakeUpstream([], ({ name, args }) => {
      assert.equal(name, "use_figma");
      wrappedScripts.push(args.code);
      return { content: [{ type: "text", text: JSON.stringify({
        ok: true,
        __figmaWorkspace: {
          sessionId: "shared-bootstrap",
          knownPages: {},
          captureRequests: [],
        },
        result: wrappedScripts.length,
      }) }] };
    }),
  });
  try {
    assert.equal((await client.eval({ sessionId: "shared-bootstrap", code: "return 1;" })).ok, true);
    assert.equal((await client.runScriptFile({ sessionId: "shared-bootstrap", scriptPath })).ok, true);
    assert.equal(wrappedScripts.length, 2);
    const marker = "\nasync function __figmaWorkspaceUserMain()";
    const bootstraps = wrappedScripts.map((source) => source.slice(0, source.indexOf(marker)));
    assert.ok(bootstraps.every((bootstrap) => bootstrap.length > 0));
    assert.equal(bootstraps[0], bootstraps[1]);
  } finally {
    await client.close();
    await rm(tempDir, { recursive: true, force: true });
  }
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
        if (options.connectError) {
          throw options.connectError;
        }
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
    async callTool(name, args, signal) {
      calls.push(["callTool", name, args]);
      return callTool({ name, args, signal });
    },
  };
}

async function executeWrappedFigmaScript(source, figma) {
  const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
  return new AsyncFunction("figma", source)(figma);
}

function createTextHelperFigmaMock() {
  const nodes = new Map();
  const loadedFonts = [];
  let createdCount = 0;
  const attach = (parent, node) => {
    if (node.parent && Array.isArray(node.parent.children)) {
      node.parent.children = node.parent.children.filter((child) => child !== node);
    }
    node.parent = parent;
    parent.children.push(node);
  };
  const currentPage = {
    id: "page:1",
    type: "PAGE",
    name: "Page 1",
    children: [],
    appendChild(node) {
      attach(this, node);
    },
  };
  const parent = {
    id: "parent:1",
    type: "FRAME",
    name: "Parent",
    children: [],
    appendChild(node) {
      attach(this, node);
    },
  };
  const rawText = {
    id: "text:raw",
    type: "TEXT",
    name: "Raw target",
    fontName: { family: "Inter", style: "Medium" },
    characters: "Before",
  };
  const objectText = {
    id: "text:node",
    type: "TEXT",
    name: "Node target",
    fontName: { family: "Inter", style: "Regular" },
    characters: "Before",
  };
  const mixedText = {
    id: "text:mixed",
    type: "TEXT",
    name: "Mixed target",
    fontName: Symbol("mixed"),
    characters: "Mixed",
  };
  for (const node of [currentPage, parent, rawText, objectText, mixedText]) {
    nodes.set(node.id, node);
  }
  const figma = {
    currentPage,
    root: { id: "0:0", type: "DOCUMENT", name: "Document", children: [currentPage] },
    createText() {
      createdCount += 1;
      const node = {
        id: `text:created-${createdCount}`,
        type: "TEXT",
        name: "",
        fontName: { family: "Inter", style: "Regular" },
        characters: "",
      };
      nodes.set(node.id, node);
      return node;
    },
    async getNodeByIdAsync(id) {
      return nodes.get(id) ?? null;
    },
    getNodeById(id) {
      return nodes.get(id) ?? null;
    },
    async loadFontAsync(font) {
      loadedFonts.push({ ...font });
    },
  };
  return { figma, loadedFonts, nodes };
}
