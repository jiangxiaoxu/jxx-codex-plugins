import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
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

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function configFor(tempDir, options = {}) {
  const config = {
    schemaVersion: 2,
    designFileUrl: "https://www.figma.com/design/live-fixture/Live-Smoke-Fixture",
    allowMutationCleanup: true,
  };
  if (options.outputDir !== undefined) {
    config.outputDir = options.outputDir;
  } else if (options.withoutOutputDir !== true) {
    config.outputDir = resolve(tempDir, "output");
  }
  return config;
}

function sidecarMarkdown(path, inlineResult) {
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
    ...(inlineResult === undefined ? [] : [
      "```json",
      JSON.stringify(inlineResult, null, 2),
      "```",
      "",
    ]),
  ].join("\n");
}

function inlineResultMarkdown(result, commandName = "upstream-tools") {
  return [
    `# figma:${commandName}`,
    "",
    "Status: succeeded",
    "",
    "```json",
    JSON.stringify(result, null, 2),
    "```",
    "",
  ].join("\n");
}

function createLiveScenario(tempDir, config, options = {}) {
  const runId = options.runId ?? "live-smoke-run-0001";
  const temporaryOutputRoot = resolve(tmpdir(), "figma-workspace", "live-test-invocation");
  const outputRoot = config.outputDir ?? temporaryOutputRoot;
  const capturePath = config.outputDir === undefined
    ? resolve(outputRoot, "captures", `live-smoke-${runId}.png`)
    : resolve(config.outputDir, `live-smoke-${runId}.png`);
  const sources = new Map([[capturePath, PNG_BYTES]]);
  const commands = [];
  let sidecarIndex = 0;
  let readbackCount = 0;

  const completeMatches = [
    { id: "100:1", type: "FRAME", parentId: "0:1", tag: runId },
    { id: "100:2", type: "TEXT", parentId: "100:1", tag: runId },
  ];
  const matches = options.matches ?? completeMatches;
  const runSuccess = (payload) => ({
    ok: true,
    executionOutcome: "succeeded",
    upstream: { ok: true, result: payload },
  });
  const reconcile = (entries) => runSuccess({
    tagNamespace: LIVE_SMOKE_PLUGIN_DATA_NAMESPACE,
    tagKey: LIVE_SMOKE_PLUGIN_DATA_KEY,
    runId,
    matches: entries,
  });
  const nextResult = (command) => {
    if (command.script === "figma:doctor") return { result: undefined, exitCode: 0 };
    if (command.script === "figma:upstream:read") {
      return { result: { ok: true, name: "whoami", inputSchema: { type: "object" } }, exitCode: 0 };
    }
    if (command.script === "figma:metadata") return { result: { ok: true }, exitCode: 0 };
    if (command.script === "figma:capture") {
      return {
        result: { ok: true, nodeId: "100:1", imageFile: capturePath, bytes: PNG_BYTES.byteLength },
        exitCode: 0,
      };
    }
    if (command.script === "figma:run") {
      const source = command.input;
      if (typeof source !== "string") throw new Error("figma:run must receive TypeScript source on stdin.");
      if (source.includes("const frame = figma.createFrame();")) {
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
          result: runSuccess({
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
      if (source.includes("const ordered = [...matches].sort")) {
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
          result: runSuccess({
            tagNamespace: LIVE_SMOKE_PLUGIN_DATA_NAMESPACE,
            tagKey: LIVE_SMOKE_PLUGIN_DATA_KEY,
            runId,
            removedNodeIds: ["100:2", "100:1"],
            changedNodeIds: ["100:2", "100:1"],
          }),
          exitCode: 0,
        };
      }
      if (source.includes("const matches = figma.currentPage.findAll")) {
        const result = readbackCount < 2 ? reconcile(matches) : reconcile([]);
        readbackCount += 1;
        return { result, exitCode: 0 };
      }
    }
    throw new Error(`Unexpected command: ${command.script}`);
  };

  return {
    commands,
    capturePath,
    lstat: async (path) => ({
      isFile: () => true,
      isSymbolicLink: () => (
        options.symbolicLinkResult === true && /\.json$/iu.test(String(path))
      ) || (
        options.symbolicLinkCaptureResult === true && /capture\.result\.json$/iu.test(String(path))
      ) || (
        options.symbolicLinkUpstream === true && /\.upstream\.json$/iu.test(String(path))
      ),
      size: 0,
    }),
    realpath: async (path) => options.canonicalOutsideUpstream === true && /\.upstream\.json$/iu.test(String(path))
      ? "G:\\Project\\jxx-codex-plugins\\plugins\\figma-workspace\\.figma-workspace\\live-workspace\\link\\artifact.upstream.json"
      : path,
    readFile: async (path, encoding) => {
      const source = sources.get(resolve(path));
      if (source === undefined) throw new Error(`Missing fake file: ${path}`);
      if (encoding === "utf8") return Buffer.isBuffer(source) ? source.toString("utf8") : source;
      return Buffer.isBuffer(source) ? source : Buffer.from(source);
    },
    executor: async (command) => {
      commands.push(command);
      const next = nextResult(command);
      if (command.script === "figma:doctor") {
        return {
          exitCode: next.exitCode,
          stdout: "figma doctor succeeded\n",
          stderr: "",
          timedOut: false,
          spawnError: undefined,
        };
      }
      if (command.script === "figma:upstream:read") {
        return {
          exitCode: next.exitCode,
          stdout: inlineResultMarkdown(next.result),
          stderr: "",
          timedOut: false,
          spawnError: undefined,
        };
      }
      if (command.script === "figma:metadata") {
        const metadataPath = resolve(outputRoot, "metadata.json");
        sources.set(metadataPath, JSON.stringify({ ok: true }));
        return {
          exitCode: next.exitCode,
          stdout: inlineResultMarkdown({
            ...next.result,
            outputFiles: { metadataFile: { path: metadataPath, bytes: 11 } },
          }, "get-metadata"),
          stderr: "",
          timedOut: false,
          spawnError: undefined,
        };
      }
      const sidecarRoot = command.args.includes("--output-dir") ? outputRoot : temporaryOutputRoot;
      const sidecarIndexValue = sidecarIndex += 1;
      const sidecarPath = resolve(
        sidecarRoot,
        "results",
        command.script === "figma:capture" ? "capture.result.json" : `${sidecarIndexValue}.json`,
      );
      let sidecarResult = next.result;
      let markerPath = sidecarPath;
      let inlineResult;
      if (
        command.script === "figma:run"
        && isRecord(next.result)
        && isRecord(next.result.upstream)
        && Object.hasOwn(next.result.upstream, "result")
      ) {
        const upstreamPath = options.staleUpstreamPath
          ?? resolve(sidecarRoot, "results", `${sidecarIndexValue}.upstream.json`);
        const upstreamSidecar = JSON.stringify({
          kind: "json",
          ok: next.result.upstream.ok,
          result: next.result.upstream.result,
        });
        sources.set(upstreamPath, upstreamSidecar);
        sidecarResult = {
          ...next.result,
          upstream: { kind: "json", ok: next.result.upstream.ok },
          outputFiles: {
            ...(isRecord(next.result.outputFiles) ? next.result.outputFiles : {}),
            upstreamFile: { path: upstreamPath, bytes: Buffer.byteLength(upstreamSidecar, "utf8") },
          },
        };
        const { upstream: _omittedUpstream, ...compactResult } = sidecarResult;
        inlineResult = {
          ...compactResult,
          outputFiles: {
            ...sidecarResult.outputFiles,
            cliResultFile: { path: sidecarPath, bytes: 0 },
          },
        };
      }
      if (command.script === "figma:capture") {
        const { imageFile: _omittedImageFile, ...compactResult } = next.result;
        inlineResult = {
          ...compactResult,
          outputFiles: { cliResultFile: { path: sidecarPath, bytes: 0 } },
        };
      }
      sources.set(sidecarPath, JSON.stringify(sidecarResult));
      return {
        exitCode: next.exitCode,
        stdout: inlineResult === undefined
          ? sidecarMarkdown(markerPath)
          : inlineResultMarkdown(inlineResult, command.script === "figma:capture" ? "capture-node" : "run"),
        stderr: "",
        timedOut: false,
        spawnError: undefined,
      };
    },
  };
}

function smokeOptions(tempDir, config, scenario, runId) {
  return {
    config,
    configPath: resolve(tempDir, ".figma-workspace", "live-test.json"),
    runId,
    executor: scenario.executor,
    readFile: scenario.readFile,
    stat: async () => ({ isFile: () => true, size: 0 }),
    lstat: scenario.lstat,
    realpath: scenario.realpath,
    env: { FIGMA_WORKSPACE_OAUTH_CACHE_PATH: resolve(tempDir, "oauth.json") },
  };
}

function runCommands(commands) {
  return commands.filter((command) => command.script === "figma:run");
}

test("live config is strict, supports an optional outputDir, and rejects legacy state fields", async () => {
  const tempDir = await mkdtemp(join(tmpdir(), "figma-workspace-live-config-"));
  try {
    const valid = configFor(tempDir);
    assert.deepEqual(parseLiveTestConfig(valid, { configPath: "live-test.json" }), valid);
    assert.deepEqual(
      parseLiveTestConfig(configFor(tempDir, { withoutOutputDir: true }), { configPath: "live-test.json" }),
      { ...configFor(tempDir, { withoutOutputDir: true }), outputDir: undefined },
    );
    assert.throws(
      () => parseLiveTestConfig({ ...valid, schemaVersion: 1 }, { configPath: "live-test.json" }),
      /must equal 2/u,
    );
    assert.throws(
      () => parseLiveTestConfig({ ...valid, accessToken: "not-allowed" }, { configPath: "live-test.json" }),
      LiveSmokeUsageError,
    );
    assert.throws(
      () => parseLiveTestConfig({ ...valid, stateFile: resolve(tempDir, "state.json") }, { configPath: "live-test.json" }),
      /does not allow unknown field/u,
    );
    assert.throws(
      () => parseLiveTestConfig({ ...valid, workspaceDir: resolve(tempDir, "workspace") }, { configPath: "live-test.json" }),
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

test("live smoke runs against an explicit Design target with TypeScript stdin and captures the tagged frame", async () => {
  const tempDir = await mkdtemp(join(tmpdir(), "figma-workspace-live-stateless-"));
  try {
    const runId = "live-smoke-run-0001";
    const config = configFor(tempDir);
    const scenario = createLiveScenario(tempDir, config, { runId });
    const result = await runLiveSmokeTest(smokeOptions(tempDir, config, scenario, runId));

    assert.equal(result.creationOutcome, "succeeded");
    assert.equal(result.cleanup.after.matches.length, 0);
    assert.equal(result.designFileUrl, config.designFileUrl);
    assert.equal(result.outputDir, config.outputDir);
    assert.equal(result.captureFile, scenario.capturePath);
    assert.equal(scenario.commands[0].script, "figma:doctor");
    assert.equal(scenario.commands.some((command) => command.script === "figma:open"), false);
    assert.equal(scenario.commands.some((command) => command.script === "figma:eval"), false);
    assert.equal(scenario.commands.some((command) => command.script === "figma:script:run"), false);

    const metadata = scenario.commands.find((command) => command.script === "figma:metadata");
    assert.ok(metadata);
    assert.deepEqual(metadata.args, [
      "--file", config.designFileUrl,
      "--output-dir", config.outputDir,
      "--max-inline-bytes", "0",
    ]);

    const upstreamRead = scenario.commands.find((command) => command.script === "figma:upstream:read");
    assert.ok(upstreamRead);
    assert.deepEqual(upstreamRead.args, ["whoami", "--refresh"]);

    const runs = runCommands(scenario.commands);
    assert.equal(runs.length, 5);
    for (const command of runs) {
      assert.deepEqual(command.args, [
        "--file", config.designFileUrl,
        "--source", "-",
        "--surface", "design",
        "--output-dir", config.outputDir,
        "--max-inline-bytes", "0",
      ]);
      assert.equal(typeof command.input, "string");
      assert.doesNotMatch(command.input, /"sessionId"|"code"/u);
    }
    const creation = runs.find((command) => command.input.includes("const frame = figma.createFrame();"));
    assert.ok(creation);
    const firstAwait = creation.input.indexOf("await figma.loadFontAsync");
    assert.ok(firstAwait > 0);
    for (const requiredSetup of [
      "frame.setSharedPluginData(tagNamespace, tagKey, runId);",
      "text.setSharedPluginData(tagNamespace, tagKey, runId);",
      "frame.appendChild(text);",
    ]) {
      assert.ok(creation.input.indexOf(requiredSetup) >= 0 && creation.input.indexOf(requiredSetup) < firstAwait, requiredSetup);
    }

    const capture = scenario.commands.find((command) => command.script === "figma:capture");
    assert.ok(capture);
    assert.deepEqual(capture.args, [
      "--file", config.designFileUrl,
      "--node", "100:1",
      "--max-dimension", "1024",
      "--output-dir", config.outputDir,
      "--image-file", scenario.capturePath,
      "--max-inline-bytes", "0",
    ]);
    assert.equal(isSafeRelativePngFileName(`live-smoke-${runId}.png`), true);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("live smoke uses the invocation temp root when outputDir is omitted", async () => {
  const tempDir = await mkdtemp(join(tmpdir(), "figma-workspace-live-temp-output-"));
  try {
    const runId = "live-smoke-run-0010";
    const config = configFor(tempDir, { withoutOutputDir: true });
    const scenario = createLiveScenario(tempDir, config, { runId });
    const result = await runLiveSmokeTest(smokeOptions(tempDir, config, scenario, runId));

    assert.equal(result.outputDir, undefined);
    assert.match(result.captureFile, /figma-workspace/u);
    for (const command of runCommands(scenario.commands)) {
      assert.deepEqual(command.args, [
        "--file", config.designFileUrl,
        "--source", "-",
        "--surface", "design",
        "--max-inline-bytes", "0",
      ]);
    }
    const capture = scenario.commands.find((command) => command.script === "figma:capture");
    assert.ok(capture);
    assert.equal(capture.args.includes("--output-dir"), false);
    assert.equal(capture.args.includes("--image-file"), false);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("live smoke reconciles a loadFont partial failure only after its complete tagged hierarchy exists", async () => {
  const tempDir = await mkdtemp(join(tmpdir(), "figma-workspace-live-unknown-"));
  try {
    const runId = "live-smoke-run-0002";
    const config = configFor(tempDir);
    const scenario = createLiveScenario(tempDir, config, {
      runId,
      loadFontPartialFailure: true,
      deleteOutcomeUnknown: true,
    });
    const result = await runLiveSmokeTest(smokeOptions(tempDir, config, scenario, runId));

    assert.equal(result.creationOutcome, "outcome_unknown");
    const runs = runCommands(scenario.commands);
    const creationCommands = runs.filter((command) => command.input.includes("const frame = figma.createFrame();"));
    const deletionCommands = runs.filter((command) => command.input.includes("const ordered = [...matches].sort"));
    const readbackCommands = runs.filter((command) => command.input.includes("changedNodeIds: matches.map"));
    assert.equal(creationCommands.length, 1);
    assert.equal(deletionCommands.length, 1);
    assert.equal(readbackCommands.length, 3);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("live smoke uses an exact PluginData tag for cleanup", async () => {
  const tempDir = await mkdtemp(join(tmpdir(), "figma-workspace-live-cleanup-"));
  try {
    const runId = "live-smoke-run-0003";
    const config = configFor(tempDir);
    const scenario = createLiveScenario(tempDir, config, { runId });
    const result = await runLiveSmokeTest(smokeOptions(tempDir, config, scenario, runId));

    assert.equal(result.cleanup.after.matches.length, 0);
    const cleanup = runCommands(scenario.commands).find((command) => command.input.includes("const ordered = [...matches].sort"));
    assert.ok(cleanup);
    assert.match(cleanup.input, /getSharedPluginData\(tagNamespace, tagKey\) === runId/u);
    assert.doesNotMatch(cleanup.input, /includes\(runId\)|indexOf\(runId\)/u);
    assert.match(cleanup.input, /const depthOf = \(node: SceneNode\): number =>/u);
    assert.match(cleanup.input, /depthOf\(right\) - depthOf\(left\)/u);
    assert.match(cleanup.input, /const untaggedNodes = figma\.currentPage\.findAll/u);
    assert.match(cleanup.input, /blockedNodeIds\.push\(node\.id\)/u);
    assert.doesNotMatch(cleanup.input, /const roots =/u);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

for (const scenarioCase of [
  {
    name: "FRAME-only",
    runId: "live-smoke-run-0004",
    matches: [{ id: "100:1", type: "FRAME", parentId: "0:1", tag: "live-smoke-run-0004" }],
  },
  {
    name: "TEXT-only",
    runId: "live-smoke-run-0005",
    matches: [{ id: "100:2", type: "TEXT", parentId: "100:1", tag: "live-smoke-run-0005" }],
  },
  {
    name: "duplicate tagged nodes",
    runId: "live-smoke-run-0006",
    matches: [
      { id: "100:1", type: "FRAME", parentId: "0:1", tag: "live-smoke-run-0006" },
      { id: "100:2", type: "TEXT", parentId: "100:1", tag: "live-smoke-run-0006" },
      { id: "100:3", type: "TEXT", parentId: "100:1", tag: "live-smoke-run-0006" },
    ],
  },
]) {
  test(`live smoke rejects ${scenarioCase.name} reconciliation before capture and still cleans the exact tag`, async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "figma-workspace-live-malformed-"));
    try {
      const config = configFor(tempDir);
      const scenario = createLiveScenario(tempDir, config, {
        runId: scenarioCase.runId,
        creationOutcomeUnknown: true,
        matches: scenarioCase.matches,
      });
      await assert.rejects(
        () => runLiveSmokeTest(smokeOptions(tempDir, config, scenario, scenarioCase.runId)),
        /exactly one figma_workspace\.live_smoke\/run_id-tagged FRAME and one figma_workspace\.live_smoke\/run_id-tagged TEXT/u,
      );
      assert.equal(scenario.commands.some((command) => command.script === "figma:capture"), false);
      assert.equal(
        runCommands(scenario.commands).filter((command) => command.input.includes("const ordered = [...matches].sort")).length,
        1,
      );
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });
}

test("live smoke rejects a stale legacy upstream artifact outside the invocation root", async () => {
  const tempDir = await mkdtemp(join(tmpdir(), "figma-workspace-live-stale-artifact-"));
  try {
    const runId = "live-smoke-run-stale";
    const config = configFor(tempDir);
    const scenario = createLiveScenario(tempDir, config, {
      runId,
      staleUpstreamPath: "G:\\Project\\jxx-codex-plugins\\plugins\\figma-workspace\\.figma-workspace\\live-workspace\\legacy.upstream.json",
    });
    await assert.rejects(
      () => runLiveSmokeTest(smokeOptions(tempDir, config, scenario, runId)),
      (error) => {
        assert.match(error.message, /could not safely hydrate/u);
        assert.match(error.cause?.cause?.message ?? "", /must remain inside/u);
        return true;
      },
    );
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("live smoke rejects an upstream sidecar symlink before reading its payload", async () => {
  const tempDir = await mkdtemp(join(tmpdir(), "figma-workspace-live-sidecar-link-"));
  try {
    const runId = "live-smoke-run-link";
    const config = configFor(tempDir);
    const scenario = createLiveScenario(tempDir, config, { runId, symbolicLinkUpstream: true });
    await assert.rejects(
      () => runLiveSmokeTest(smokeOptions(tempDir, config, scenario, runId)),
      (error) => {
        assert.match(error.message, /could not safely hydrate/u);
        assert.match(error.cause?.cause?.message ?? "", /regular JSON file/u);
        return true;
      },
    );
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("live smoke rejects an upstream sidecar whose intermediate path resolves outside the output root", async () => {
  const tempDir = await mkdtemp(join(tmpdir(), "figma-workspace-live-canonical-link-"));
  try {
    const runId = "live-smoke-run-canonical-link";
    const config = configFor(tempDir);
    const scenario = createLiveScenario(tempDir, config, { runId, canonicalOutsideUpstream: true });
    await assert.rejects(
      () => runLiveSmokeTest(smokeOptions(tempDir, config, scenario, runId)),
      (error) => {
        assert.match(error.message, /could not safely hydrate/u);
        assert.match([error.message, error.cause?.message, error.cause?.cause?.message].join("\n"), /canonical output root/u);
        return true;
      },
    );
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("live smoke rejects a marker sidecar symlink before reading its envelope", async () => {
  const tempDir = await mkdtemp(join(tmpdir(), "figma-workspace-live-marker-link-"));
  try {
    const runId = "live-smoke-run-marker-link";
    const config = configFor(tempDir);
    const scenario = createLiveScenario(tempDir, config, { runId, symbolicLinkResult: true, creationOutcomeUnknown: true });
    await assert.rejects(
      () => runLiveSmokeTest(smokeOptions(tempDir, config, scenario, runId)),
      (error) => {
        assert.match(error.message, /did not produce a readable complete result sidecar/u);
        assert.match([error.message, error.cause?.message, error.cause?.cause?.message].join("\n"), /regular JSON file/u);
        return true;
      },
    );
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("live smoke rejects a cliResultFile symlink before reading capture output", async () => {
  const tempDir = await mkdtemp(join(tmpdir(), "figma-workspace-live-cli-result-link-"));
  try {
    const runId = "live-smoke-run-cli-link";
    const config = configFor(tempDir);
    const scenario = createLiveScenario(tempDir, config, { runId, symbolicLinkCaptureResult: true });
    await assert.rejects(
      () => runLiveSmokeTest(smokeOptions(tempDir, config, scenario, runId)),
      (error) => {
        assert.match(error.message, /did not produce a readable complete result sidecar/u);
        assert.match([error.message, error.cause?.message, error.cause?.cause?.message].join("\n"), /regular JSON file/u);
        return true;
      },
    );
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("live smoke requires confirmed creation changedNodeIds to cover both reconciled nodes", async () => {
  const tempDir = await mkdtemp(join(tmpdir(), "figma-workspace-live-changed-node-ids-"));
  try {
    const runId = "live-smoke-run-0007";
    const config = configFor(tempDir);
    const scenario = createLiveScenario(tempDir, config, {
      runId,
      creationChangedNodeIds: ["100:1"],
    });
    await assert.rejects(
      () => runLiveSmokeTest(smokeOptions(tempDir, config, scenario, runId)),
      /upstream\.result\.changedNodeIds did not cover the reconciled nodes: 100:2/u,
    );
    assert.equal(scenario.commands.some((command) => command.script === "figma:capture"), false);
    assert.equal(
      runCommands(scenario.commands).filter((command) => command.input.includes("const ordered = [...matches].sort")).length,
      1,
    );
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("npm command executor uses public npm --silent argv and streams TypeScript stdin unchanged", async () => {
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
    script: "figma:run",
    args: ["--file", "https://www.figma.com/design/file-key/Test", "--source", "-"],
    input: "return 1;",
  });

  assert.deepEqual(spawned[0], {
    command: "npm-test",
    args: [
      "--silent", "run", "figma:run", "--",
      "--file", "https://www.figma.com/design/file-key/Test", "--source", "-",
    ],
    options: {
      cwd: "C:/figma-workspace",
      env: { TEST: "1" },
      stdio: "pipe",
      windowsHide: true,
    },
  });
  assert.equal(stdinValues[0], "return 1;\n");
  assert.equal(result.exitCode, 0);
  assert.equal(result.stdout, "partial stdout");
  assert.equal(result.timedOut, false);
});

test("default npm command executor starts the public doctor leaf without Windows npm.cmd spawning", async () => {
  const executor = createNpmCommandExecutor();
  const result = await executor({ script: "figma:doctor", args: [] });
  assert.equal(result.timedOut, false);
  assert.equal(result.spawnError, undefined);
  assert.equal(result.exitCode, 0);
  if (process.platform === "win32") {
    assert.equal(result.command, process.execPath);
    assert.match(result.args[0], /npm-cli\.js$/iu);
  }
});
