import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import {
  LIVE_SMOKE_PLUGIN_DATA_NAMESPACE,
  LIVE_SMOKE_PLUGIN_DATA_KEY,
  LiveSmokeUsageError,
  createNpmCommandExecutor,
  isSafeRelativePngFileName,
  loadLiveTestConfig,
  parseLiveTestConfig,
  runLiveSmokeTest,
} from "../scripts/test-live.mjs";

const PNG_BYTES = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 0]);

function configFor(tempDir) {
  return {
    schemaVersion: 1,
    designFileUrl: "https://www.figma.com/design/live-fixture/Live-Smoke-Fixture",
    stateFile: resolve(tempDir, "state.json"),
    workspaceDir: resolve(tempDir, "workspace"),
    allowMutationCleanup: true,
  };
}

function sidecarMarkdown(path) {
  return [
    "# figma-workspace test",
    "Input: none",
    "Status: succeeded",
    "",
    "## Output Files",
    "",
    "### Cli Result File",
    "",
    `Path: ${path}`,
    "",
  ].join("\n");
}

function createLiveScenario(tempDir, options = {}) {
  const stateFile = resolve(tempDir, "state.json");
  const runId = options.runId ?? "live-smoke-run-0001";
  const capturePath = resolve(tempDir, "workspace", "capture-results", "live-smoke.png");
  const sources = new Map([[capturePath, PNG_BYTES]]);
  const commands = [];
  let sidecarIndex = 0;
  let readbackCount = 0;

  const completeMatches = [
    { id: "100:1", type: "FRAME", parentId: "0:1", tag: runId },
    { id: "100:2", type: "TEXT", parentId: "100:1", tag: runId },
  ];
  const matches = options.matches ?? completeMatches;
  const evalSuccess = (payload) => ({
    ok: true,
    executionOutcome: "succeeded",
    upstream: { ok: true, result: payload },
  });
  const reconcile = (entries) => evalSuccess({
    tagNamespace: LIVE_SMOKE_PLUGIN_DATA_NAMESPACE,
    tagKey: LIVE_SMOKE_PLUGIN_DATA_KEY,
    runId,
    matches: entries,
  });
  const nextResult = (command) => {
    if (command.script === "figma:doctor") return { result: { ok: true }, exitCode: 0 };
    if (command.script === "figma:upstream:read") {
      return { result: { ok: true, name: "whoami", inputSchema: { type: "object" } }, exitCode: 0 };
    }
    if (command.script === "figma:upstream:call") {
      if (options.omitWhoamiUpstreamResult) {
        const upstreamPath = resolve(tempDir, "workspace", "whoami.upstream.json");
        const upstream = { kind: "json", ok: true, result: { account: "live-test" } };
        const source = JSON.stringify(upstream);
        sources.set(upstreamPath, source);
        return {
          result: {
            ok: true,
            upstream: { kind: "json", ok: true },
            outputFiles: {
              upstreamFile: {
                path: upstreamPath,
                bytes: Buffer.byteLength(source, "utf8"),
                lineCount: 1,
              },
            },
          },
          exitCode: 0,
        };
      }
      return { result: { ok: true, upstream: { ok: true, result: { account: "live-test" } } }, exitCode: 0 };
    }
    if (command.script === "figma:open") {
      return { result: { ok: true, session: { id: "live-smoke-opened" } }, exitCode: 0 };
    }
    if (command.script === "figma:metadata") {
      return { result: { ok: true, session: { id: "live-smoke-opened" } }, exitCode: 0 };
    }
    if (command.script === "figma:capture") {
      return {
        result: { ok: true, nodeId: "100:1", imageFile: capturePath, bytes: PNG_BYTES.byteLength },
        exitCode: 0,
      };
    }
    if (command.script === "figma:eval") {
      const code = command.input.code;
      if (code.includes("const frame = figma.createFrame();")) {
        if (options.creationOutcomeUnknown || options.loadFontPartialFailure) {
          return {
            result: {
              ok: false,
              executionOutcome: "outcome_unknown",
              retryGuidance: "Inspect/readback/reconcile before retrying; do not blindly rerun this mutation.",
              upstreamError: options.loadFontPartialFailure
                ? { code: "SCRIPT_FAILED", message: "loadFontAsync failed after tagged hierarchy creation." }
                : undefined,
            },
            exitCode: 1,
          };
        }
        return {
          result: evalSuccess({
            tagNamespace: LIVE_SMOKE_PLUGIN_DATA_NAMESPACE,
            tagKey: LIVE_SMOKE_PLUGIN_DATA_KEY,
            runId,
            frameId: "100:1",
            textId: "100:2",
            changedNodeIds: options.creationChangedNodeIds ?? ["100:1", "100:2"],
          }),
          exitCode: 0,
        };
      }
      if (code.includes("const ordered = [...matches].sort")) {
        if (options.deleteOutcomeUnknown) {
          return {
            result: {
              ok: false,
              executionOutcome: "outcome_unknown",
              retryGuidance: "Inspect/readback/reconcile before retrying; do not blindly rerun this mutation.",
            },
            exitCode: 1,
          };
        }
        return {
          result: evalSuccess({
            tagNamespace: LIVE_SMOKE_PLUGIN_DATA_NAMESPACE,
            tagKey: LIVE_SMOKE_PLUGIN_DATA_KEY,
            runId,
            removedNodeIds: ["100:2", "100:1"],
            changedNodeIds: ["100:2", "100:1"],
          }),
          exitCode: 0,
        };
      }
      if (code.includes("const matches = figma.currentPage.findAll")) {
        const result = readbackCount < 2 ? reconcile(matches) : reconcile([]);
        readbackCount += 1;
        return { result, exitCode: 0 };
      }
    }
    throw new Error(`Unexpected command: ${command.script}`);
  };

  return {
    commands,
    readFile: async (path, encoding) => {
      const source = sources.get(resolve(path));
      if (source === undefined) throw new Error(`Missing fake file: ${path}`);
      if (encoding === "utf8") return Buffer.isBuffer(source) ? source.toString("utf8") : source;
      return Buffer.isBuffer(source) ? source : Buffer.from(source);
    },
    executor: async (command) => {
      commands.push(command);
      const next = nextResult(command);
      const sidecarPath = resolve(dirname(stateFile), "results", `${sidecarIndex += 1}.json`);
      sources.set(sidecarPath, JSON.stringify(next.result));
      return {
        exitCode: next.exitCode,
        stdout: sidecarMarkdown(sidecarPath),
        stderr: "",
        timedOut: false,
        spawnError: undefined,
      };
    },
  };
}

test("live config is fixed, strict, and rejects secrets or unknown fields", async () => {
  const tempDir = await mkdtemp(join(tmpdir(), "figma-workspace-live-config-"));
  try {
    const valid = configFor(tempDir);
    assert.deepEqual(parseLiveTestConfig(valid, { configPath: "live-test.json" }), valid);
    assert.throws(
      () => parseLiveTestConfig({ ...valid, accessToken: "not-allowed" }, { configPath: "live-test.json" }),
      LiveSmokeUsageError,
    );
    assert.throws(
      () => parseLiveTestConfig({ ...valid, extra: true }, { configPath: "live-test.json" }),
      /does not allow unknown field/u,
    );
    assert.throws(
      () => parseLiveTestConfig({ ...valid, allowMutationCleanup: false }, { configPath: "live-test.json" }),
      /must be true/u,
    );

    let requestedPath;
    const loaded = await loadLiveTestConfig({
      pluginRoot: tempDir,
      readFile: async (path) => {
        requestedPath = path;
        return JSON.stringify(valid);
      },
    });
    assert.equal(requestedPath, resolve(tempDir, ".figma-workspace", "live-test.json"));
    assert.deepEqual(loaded.config, valid);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("live smoke reconciles a loadFont partial failure only after its complete tagged hierarchy exists", async () => {
  const tempDir = await mkdtemp(join(tmpdir(), "figma-workspace-live-unknown-"));
  try {
    const runId = "live-smoke-run-0001";
    const scenario = createLiveScenario(tempDir, {
      runId,
      loadFontPartialFailure: true,
      deleteOutcomeUnknown: true,
    });
    const result = await runLiveSmokeTest({
      config: configFor(tempDir),
      configPath: resolve(tempDir, ".figma-workspace", "live-test.json"),
      runId,
      executor: scenario.executor,
      readFile: scenario.readFile,
      stat: async () => ({ isFile: () => true }),
      env: { FIGMA_WORKSPACE_OAUTH_CACHE_PATH: resolve(tempDir, "oauth.json") },
    });

    assert.equal(result.creationOutcome, "outcome_unknown");
    const evalCommands = scenario.commands.filter((command) => command.script === "figma:eval");
    const creationCommands = evalCommands.filter((command) => command.input.code.includes("const frame = figma.createFrame();"));
    const deletionCommands = evalCommands.filter((command) => command.input.code.includes("const ordered = [...matches].sort"));
    const readbackCommands = evalCommands.filter((command) => command.input.code.includes("changedNodeIds: matches.map"));
    assert.equal(creationCommands.length, 1);
    assert.equal(deletionCommands.length, 1);
    assert.equal(readbackCommands.length, 3);
    const creationCode = creationCommands[0].input.code;
    const firstAwait = creationCode.indexOf("await figma.loadFontAsync");
    assert.ok(firstAwait > 0);
    for (const requiredSetup of [
      "frame.setSharedPluginData(tagNamespace, tagKey, runId);",
      "text.setSharedPluginData(tagNamespace, tagKey, runId);",
      "frame.appendChild(text);",
    ]) {
      assert.ok(creationCode.indexOf(requiredSetup) >= 0 && creationCode.indexOf(requiredSetup) < firstAwait, requiredSetup);
    }
    assert.match(readbackCommands[0].input.code, /parentId: node\.parent\?\.id \?\? null/u);
    assert.match(readbackCommands[0].input.code, /tag: node\.getSharedPluginData\(tagNamespace, tagKey\)/u);
    const metadataCommand = scenario.commands.find((command) => command.script === "figma:metadata");
    assert.ok(metadataCommand);
    assert.equal(metadataCommand.args[0], configFor(tempDir).designFileUrl);
    assert.equal(scenario.commands.some((command) => command.script === "figma:capture"), true);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("live smoke hydrates an omitted nested upstream result from the bounded upstream sidecar", async () => {
  const tempDir = await mkdtemp(join(tmpdir(), "figma-workspace-live-upstream-sidecar-"));
  try {
    const runId = "live-smoke-run-0007";
    const scenario = createLiveScenario(tempDir, { runId, omitWhoamiUpstreamResult: true });
    const result = await runLiveSmokeTest({
      config: configFor(tempDir),
      runId,
      executor: scenario.executor,
      readFile: scenario.readFile,
      stat: async () => ({ isFile: () => true, size: 0 }),
      env: { FIGMA_WORKSPACE_OAUTH_CACHE_PATH: resolve(tempDir, "oauth.json") },
    });
    assert.equal(result.creationOutcome, "succeeded");
    const whoami = scenario.commands.find((command) => command.script === "figma:upstream:call");
    assert.ok(whoami);
    assert.equal(scenario.commands.some((command) => command.script === "figma:open"), true);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("live smoke uses an exact PluginData tag for cleanup and sends bounded sidecar commands", async () => {
  const tempDir = await mkdtemp(join(tmpdir(), "figma-workspace-live-cleanup-"));
  try {
    const runId = "live-smoke-run-0002";
    const scenario = createLiveScenario(tempDir, { runId });
    const result = await runLiveSmokeTest({
      config: configFor(tempDir),
      runId,
      executor: scenario.executor,
      readFile: scenario.readFile,
      stat: async () => ({ isFile: () => true }),
      env: { FIGMA_WORKSPACE_OAUTH_CACHE_PATH: resolve(tempDir, "oauth.json") },
    });

    assert.equal(result.cleanup.after.matches.length, 0);
    const cleanup = scenario.commands.find((command) => (
      command.script === "figma:eval" && command.input.code.includes("const ordered = [...matches].sort")
    ));
    assert.ok(cleanup);
    assert.match(cleanup.input.code, /getSharedPluginData\(tagNamespace, tagKey\) === runId/u);
    assert.doesNotMatch(cleanup.input.code, /includes\(runId\)|indexOf\(runId\)/u);
    assert.match(cleanup.input.code, /const depthOf = \(node: SceneNode\): number =>/u);
    assert.match(cleanup.input.code, /depthOf\(right\) - depthOf\(left\)/u);
    assert.match(cleanup.input.code, /for \(const node of ordered\)/u);
    assert.match(cleanup.input.code, /const untaggedNodes = figma\.currentPage\.findAll/u);
    assert.match(cleanup.input.code, /blockedNodeIds\.push\(node\.id\)/u);
    assert.doesNotMatch(cleanup.input.code, /const roots =/u);
    for (const command of scenario.commands) {
      assert.equal(command.script.startsWith("figma:"), true, command.script);
      assert.deepEqual(command.args.slice(-4), ["--state-file", configFor(tempDir).stateFile, "--max-inline-bytes", "0"]);
    }
    const capture = scenario.commands.find((command) => command.script === "figma:capture");
    assert.ok(capture);
    assert.equal(isSafeRelativePngFileName(capture.input.imageFile), true);
    assert.equal(capture.input.imageFile, `live-smoke-${runId}.png`);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("live smoke rejects FRAME-only reconciliation before capture and still cleans the exact tag", async () => {
  const tempDir = await mkdtemp(join(tmpdir(), "figma-workspace-live-frame-only-"));
  try {
    const runId = "live-smoke-run-0003";
    const scenario = createLiveScenario(tempDir, {
      runId,
      creationOutcomeUnknown: true,
      matches: [{ id: "100:1", type: "FRAME", parentId: "0:1", tag: runId }],
    });
    await assert.rejects(
      () => runLiveSmokeTest({
        config: configFor(tempDir),
        runId,
        executor: scenario.executor,
        readFile: scenario.readFile,
        stat: async () => ({ isFile: () => true }),
        env: { FIGMA_WORKSPACE_OAUTH_CACHE_PATH: resolve(tempDir, "oauth.json") },
      }),
      /exactly one figma_workspace\.live_smoke\/run_id-tagged FRAME and one figma_workspace\.live_smoke\/run_id-tagged TEXT/u,
    );
    assert.equal(scenario.commands.some((command) => command.script === "figma:capture"), false);
    assert.equal(
      scenario.commands.filter((command) => command.script === "figma:eval" && command.input.code.includes("const ordered = [...matches].sort")).length,
      1,
    );
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("live smoke rejects TEXT-only reconciliation before capture and still cleans the exact tag", async () => {
  const tempDir = await mkdtemp(join(tmpdir(), "figma-workspace-live-text-only-"));
  try {
    const runId = "live-smoke-run-0006";
    const scenario = createLiveScenario(tempDir, {
      runId,
      creationOutcomeUnknown: true,
      matches: [{ id: "100:2", type: "TEXT", parentId: "100:1", tag: runId }],
    });
    await assert.rejects(
      () => runLiveSmokeTest({
        config: configFor(tempDir),
        runId,
        executor: scenario.executor,
        readFile: scenario.readFile,
        stat: async () => ({ isFile: () => true }),
        env: { FIGMA_WORKSPACE_OAUTH_CACHE_PATH: resolve(tempDir, "oauth.json") },
      }),
      /exactly one figma_workspace\.live_smoke\/run_id-tagged FRAME and one figma_workspace\.live_smoke\/run_id-tagged TEXT/u,
    );
    assert.equal(scenario.commands.some((command) => command.script === "figma:capture"), false);
    assert.equal(
      scenario.commands.filter((command) => command.script === "figma:eval" && command.input.code.includes("const ordered = [...matches].sort")).length,
      1,
    );
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("live smoke rejects duplicate tagged nodes before capture and cleans the malformed tag set", async () => {
  const tempDir = await mkdtemp(join(tmpdir(), "figma-workspace-live-duplicate-"));
  try {
    const runId = "live-smoke-run-0004";
    const scenario = createLiveScenario(tempDir, {
      runId,
      matches: [
        { id: "100:1", type: "FRAME", parentId: "0:1", tag: runId },
        { id: "100:2", type: "TEXT", parentId: "100:1", tag: runId },
        { id: "100:3", type: "TEXT", parentId: "100:1", tag: runId },
      ],
    });
    await assert.rejects(
      () => runLiveSmokeTest({
        config: configFor(tempDir),
        runId,
        executor: scenario.executor,
        readFile: scenario.readFile,
        stat: async () => ({ isFile: () => true }),
        env: { FIGMA_WORKSPACE_OAUTH_CACHE_PATH: resolve(tempDir, "oauth.json") },
      }),
      /exactly one figma_workspace\.live_smoke\/run_id-tagged FRAME and one figma_workspace\.live_smoke\/run_id-tagged TEXT/u,
    );
    assert.equal(scenario.commands.some((command) => command.script === "figma:capture"), false);
    assert.equal(
      scenario.commands.filter((command) => command.script === "figma:eval" && command.input.code.includes("const ordered = [...matches].sort")).length,
      1,
    );
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("live smoke requires confirmed creation changedNodeIds to cover both reconciled nodes", async () => {
  const tempDir = await mkdtemp(join(tmpdir(), "figma-workspace-live-changed-node-ids-"));
  try {
    const runId = "live-smoke-run-0005";
    const scenario = createLiveScenario(tempDir, {
      runId,
      creationChangedNodeIds: ["100:1"],
    });
    await assert.rejects(
      () => runLiveSmokeTest({
        config: configFor(tempDir),
        runId,
        executor: scenario.executor,
        readFile: scenario.readFile,
        stat: async () => ({ isFile: () => true }),
        env: { FIGMA_WORKSPACE_OAUTH_CACHE_PATH: resolve(tempDir, "oauth.json") },
      }),
      /upstream\.result\.changedNodeIds did not cover the reconciled nodes: 100:2/u,
    );
    assert.equal(scenario.commands.some((command) => command.script === "figma:capture"), false);
    assert.equal(
      scenario.commands.filter((command) => command.script === "figma:eval" && command.input.code.includes("const ordered = [...matches].sort")).length,
      1,
    );
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("npm command executor uses public npm --silent argv and streams JSON stdin", async () => {
  const spawned = [];
  const stdinValues = [];
  const fakeSpawn = (command, args, options) => {
    spawned.push({ command, args, options });
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.stdin = new EventEmitter();
    child.stdin.end = (value) => {
      stdinValues.push(value);
      queueMicrotask(() => {
        child.stdout.emit("data", Buffer.from("partial stdout", "utf8"));
        child.emit("close", 0, null);
      });
    };
    child.kill = () => true;
    return child;
  };
  const executor = createNpmCommandExecutor({
    npmCommand: "npm-test",
    cwd: "C:/figma-workspace",
    env: { TEST: "1" },
    spawn: fakeSpawn,
  });
  const result = await executor({
    script: "figma:eval",
    args: ["--input", "-", "--state-file", "C:/figma-workspace/state.json", "--max-inline-bytes", "0"],
    input: { sessionId: "live-smoke", code: "return 1;" },
  });

  assert.deepEqual(spawned[0], {
    command: "npm-test",
    args: [
      "--silent", "run", "figma:eval", "--", "--input", "-",
      "--state-file", "C:/figma-workspace/state.json", "--max-inline-bytes", "0",
    ],
    options: {
      cwd: "C:/figma-workspace",
      env: { TEST: "1" },
      stdio: "pipe",
      windowsHide: true,
    },
  });
  assert.deepEqual(JSON.parse(stdinValues[0]), { sessionId: "live-smoke", code: "return 1;" });
  assert.equal(result.exitCode, 0);
  assert.equal(result.stdout, "partial stdout");
  assert.equal(result.timedOut, false);
});

test("default npm command executor starts the offline doctor child without Windows npm.cmd spawning", async () => {
  const tempDir = await mkdtemp(join(tmpdir(), "figma-workspace-live-doctor-child-"));
  try {
    const executor = createNpmCommandExecutor();
    const result = await executor({
      script: "figma:doctor",
      args: ["--state-file", resolve(tempDir, "state.json"), "--max-inline-bytes", "0"],
    });
    assert.equal(result.timedOut, false);
    assert.equal(result.spawnError, undefined);
    assert.equal(result.exitCode, 0);
    assert.match(result.stdout, /Cli Result File/u);
    if (process.platform === "win32") {
      assert.equal(result.command, process.execPath);
      assert.match(result.args[0], /npm-cli\.js$/iu);
    }
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});
