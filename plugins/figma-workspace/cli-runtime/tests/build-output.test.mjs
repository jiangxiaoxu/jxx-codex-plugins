import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";
import packageJson from "../package.json" with { type: "json" };
import {
  FIGMA_WORKSPACE_CLI_COMMANDS,
  acquireFigmaWorkspaceFileLock,
  parseFigmaWorkspaceCliArguments,
  runFigmaWorkspaceCli,
} from "../dist/runtime/workspace-runtime.js";

test("distribution keeps the public runtime and executable entrypoints", () => {
  assert.equal(packageJson.bin["figma-workspace"], "./dist/cli/figma-workspace-cli.js");
  assert.equal(packageJson.version, "0.5.0");
});

test("internal CLI inventory is stateless and includes public doctor", () => {
  assert.deepEqual(FIGMA_WORKSPACE_CLI_COMMANDS, [
    "run", "apply-asset-manifest", "download-assets", "capture-node", "inspect",
    "get-metadata", "get-design-context", "get-motion-context", "search-design-system",
    "get-libraries", "get-variable-defs", "call-upstream-tool", "lookup", "docs", "doctor", "upstream-tools",
  ]);
  assert.deepEqual(parseFigmaWorkspaceCliArguments(["doctor"]), { kind: "command", command: "doctor", inputFile: undefined, inlineResultLimit: undefined });
  for (const args of [
    ["doctor", "--state-file", "state.json"],
    ["doctor", "--session-file", "state.json"],
    ["doctor", "--inline-result-limit", "100"],
    ["docs", "--inline-result-limit", "100"],
    ["lookup", "--inline-result-limit", "100"],
  ]) {
    assert.throws(() => parseFigmaWorkspaceCliArguments(args), /Unknown option|available only/iu);
  }
});

test("doctor runs without a target, state file, or remote connection", async () => {
  const output = createIo();
  let closed = false;
  const exit = await runFigmaWorkspaceCli(["doctor"], {
    io: output.io,
    createClient: () => ({
      close: async () => { closed = true; },
      doctor: async () => ({ ok: true, runtime: { projectDocs: { ok: true }, lookup: { ok: true }, typescript: { ok: true } } }),
    }),
  });
  assert.equal(exit, 0);
  assert.equal(closed, true);
  assert.match(output.stdout.join(""), /^# figma:doctor/mu);
  assert.doesNotMatch(output.stdout.join(""), /sessionId|state-file/u);
});

test("large local doctor output stays inline and creates no result sidecar", async () => {
  const output = createIo();
  const exit = await runFigmaWorkspaceCli(["doctor"], {
    io: output.io,
    createClient: () => ({
      close: async () => {},
      doctor: async () => ({ ok: true, runtime: { payload: "local-diagnostic-".repeat(512) } }),
    }),
  });
  assert.equal(exit, 0);
  const rendered = output.stdout.join("");
  assert.match(rendered, /local-diagnostic-/u);
  assert.doesNotMatch(rendered, /cliResultFile/u);
  const outputRoot = /"outputRoot": "([^"]+)"/u.exec(rendered)?.[1].replaceAll("\\\\", "\\");
  assert.ok(outputRoot);
  await assert.rejects(stat(outputRoot), /ENOENT/u);
});

test("CLI emits invocation identity and never writes persistent session state", async () => {
  const directory = await mkdtemp(resolve(tmpdir(), "figma-cli-invocation-"));
  const input = JSON.stringify({ file: "https://www.figma.com/design/ExampleKey/UI", surface: "design", source: "return {};", outputDir: directory });
  const output = createIo(input, directory);
  try {
    const exit = await runFigmaWorkspaceCli(["run", "--input", "-"], {
      io: output.io,
      createClient: (options) => ({
        close: async () => {},
        run: async () => ({ ok: true, executionOutcome: "succeeded", seenInvocationId: options.invocationId }),
      }),
    });
    assert.equal(exit, 0);
    const rendered = output.stdout.join("");
    assert.match(rendered, /"invocationId": "[0-9a-f-]+"/u);
    assert.match(rendered, /"fileKey": "ExampleKey"/u);
    assert.doesNotMatch(rendered, /"session"|sessionId/u);
    await assert.rejects(readFile(resolve(directory, "state.json"), "utf8"), /ENOENT/u);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("oversized results are written beneath explicit output root", async () => {
  const directory = await mkdtemp(resolve(tmpdir(), "figma-cli-sidecar-"));
  const input = JSON.stringify({ file: "https://www.figma.com/design/ExampleKey/UI", outputDir: directory, inlineResultLimit: 0 });
  const output = createIo(input, directory);
  try {
    const exit = await runFigmaWorkspaceCli(["get-metadata", "--input", "-"], {
      io: output.io,
      createClient: () => ({ close: async () => {}, getMetadata: async () => ({ ok: true, metadata: { payload: "x".repeat(1024) } }) }),
    });
    assert.equal(exit, 0);
    const match = /"path": "([^"]+get-metadata\.result\.json)"/u.exec(output.stdout.join(""));
    assert.ok(match);
    assert.ok(resolve(match[1]).startsWith(resolve(directory)));
    assert.match(await readFile(match[1], "utf8"), /"payload"/u);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("remote inline limits are forwarded to the client and outer renderer without an inner default truncation", async () => {
  const directory = await mkdtemp(resolve(tmpdir(), "figma-cli-inline-limit-"));
  const input = JSON.stringify({ file: "https://www.figma.com/design/ExampleKey/UI", outputDir: directory });
  const output = createIo(input, directory);
  let observedLimit;
  try {
    const exit = await runFigmaWorkspaceCli(["get-metadata", "--input", "-", "--inline-result-limit", "10000"], {
      io: output.io,
      createClient: () => ({
        close: async () => {},
        getMetadata: async (args) => {
          observedLimit = args.inlineResultLimit;
          return { ok: true, metadata: { payload: "x".repeat(6_000) } };
        },
      }),
    });
    assert.equal(exit, 0);
    assert.equal(observedLimit, 10_000);
    assert.match(output.stdout.join(""), /"payload": "x{100}/u);
    assert.doesNotMatch(output.stdout.join(""), /cliResultFile/u);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("local commands reject inlineResultLimit supplied through internal JSON input", async () => {
  const output = createIo(JSON.stringify({ inlineResultLimit: 100 }));
  let createClientCalls = 0;
  const exit = await runFigmaWorkspaceCli(["doctor", "--input", "-"], {
    io: output.io,
    createClient: () => { createClientCalls += 1; return { close: async () => {}, doctor: async () => ({ ok: true }) }; },
  });
  assert.equal(exit, 2);
  assert.equal(createClientCalls, 0);
  assert.match(output.stderr.join(""), /available only for commands that return remote Figma data/u);
});

test("remote commands reject an invalid inlineResultLimit before client creation", async () => {
  const output = createIo(JSON.stringify({ file: "ExampleKey", inlineResultLimit: "1000" }));
  let createClientCalls = 0;
  const exit = await runFigmaWorkspaceCli(["get-metadata", "--input", "-"], {
    io: output.io,
    createClient: () => { createClientCalls += 1; return { close: async () => {}, getMetadata: async () => ({ ok: true }) }; },
  });
  assert.equal(exit, 2);
  assert.equal(createClientCalls, 0);
  assert.match(output.stderr.join(""), /inlineResultLimit must be an integer/u);
});

test("oversized replacement preserves mutation recovery facts", async () => {
  const directory = await mkdtemp(resolve(tmpdir(), "figma-cli-recovery-facts-"));
  const input = JSON.stringify({ file: "https://www.figma.com/design/ExampleKey/UI", source: "return {};", outputDir: directory });
  const output = createIo(input, directory);
  try {
    const exit = await runFigmaWorkspaceCli(["run", "--input", "-", "--inline-result-limit", "0"], {
      io: output.io,
      createClient: () => ({
        close: async () => {},
        run: async () => ({
          ok: false,
          executionOutcome: "outcome_unknown",
          retryGuidance: "Inspect before retrying.",
          captureProcessingSucceeded: false,
          postProcessing: { capture: { status: "failed" } },
          outputFiles: { compiledFile: { path: resolve(directory, "compiled.js") } },
          payload: "x".repeat(1_024),
        }),
      }),
    });
    const rendered = output.stdout.join("");
    assert.equal(exit, 1);
    assert.match(rendered, /^Status: failed after execution$/mu);
    assert.match(rendered, /"executionOutcome": "outcome_unknown"/u);
    assert.match(rendered, /"retryGuidance": "Inspect before retrying\."/u);
    assert.match(rendered, /"captureProcessingSucceeded": false/u);
    assert.match(rendered, /"postProcessing"/u);
    assert.match(rendered, /"compiledFile"/u);
    assert.match(rendered, /cliResultFile/u);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("sidecar failure after a dispatched mutation stays machine-readable and preserves the outcome", async () => {
  const directory = await mkdtemp(resolve(tmpdir(), "figma-cli-sidecar-failure-"));
  const outputPath = resolve(directory, "not-a-directory");
  await writeFile(outputPath, "occupied", "utf8");
  const input = JSON.stringify({ file: "https://www.figma.com/design/ExampleKey/UI", source: "return {};", outputDir: outputPath });
  const output = createIo(input, directory);
  try {
    const exit = await runFigmaWorkspaceCli(["run", "--input", "-", "--inline-result-limit", "0"], {
      io: output.io,
      createClient: () => ({
        close: async () => {},
        run: async () => ({ ok: true, executionOutcome: "succeeded", captureProcessingSucceeded: true, payload: "x".repeat(1_024) }),
      }),
    });
    const rendered = output.stdout.join("");
    assert.equal(exit, 1);
    assert.equal(output.stderr.join(""), "");
    assert.match(rendered, /^Status: failed after execution$/mu);
    assert.match(rendered, /"executionOutcome": "succeeded"/u);
    assert.match(rendered, /"captureProcessingSucceeded": true/u);
    assert.match(rendered, /FIGMA_WORKSPACE_RESULT_PERSISTENCE_FAILED/u);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("invalid Figma URLs fail before lock acquisition, client creation, or dispatch", async () => {
  const validFile = "https://www.figma.com/design/ExampleKey/UI";
  const invalidFile = "https://example.com/design/OtherKey/UI";
  for (const [command, input] of [
    ["run", { file: invalidFile, source: "return {};" }],
    ["capture-node", { file: validFile, target: `${invalidFile}?node-id=1-2` }],
    ["apply-asset-manifest", { file: validFile, assets: [{ path: "asset.png", target: `${invalidFile}?node-id=1-2` }] }],
    ["apply-asset-manifest", { file: validFile, assets: [{ path: "asset.png", target: { fileKey: "OtherKey", nodeId: "1:2" } }] }],
    ["call-upstream-tool", { file: validFile, toolName: "example_mutation", arguments: { fileKey: invalidFile } }],
  ]) {
    const output = createIo(JSON.stringify(input));
    let createClientCalls = 0;
    const exit = await runFigmaWorkspaceCli([command, "--input", "-"], {
      io: output.io,
      createClient: () => { createClientCalls += 1; return { close: async () => {} }; },
    });
    assert.equal(exit, 2, command);
    assert.equal(createClientCalls, 0, command);
    assert.match(output.stderr.join(""), /Figma URLs must use https|conflicts with explicit file/u, command);
  }
});

test("assets apply requires one explicit file before lock or client creation", async () => {
  const output = createIo(JSON.stringify({ assets: [{ path: "asset.png", target: { fileKey: "ExampleKey", nodeId: "1:2" } }] }));
  let createClientCalls = 0;
  const exit = await runFigmaWorkspaceCli(["apply-asset-manifest", "--input", "-"], {
    io: output.io,
    createClient: () => { createClientCalls += 1; return { close: async () => {} }; },
  });
  assert.equal(exit, 2);
  assert.equal(createClientCalls, 0);
  assert.match(output.stderr.join(""), /requires an explicit file target/u);
});

test("file-key mutation lock serializes one file and permits distinct files", async () => {
  const releaseA = await acquireFigmaWorkspaceFileLock("file-a", { timeoutMs: 500 });
  let acquiredSame = false;
  const same = acquireFigmaWorkspaceFileLock("file-a", { timeoutMs: 2_000, retryMs: 5 }).then((release) => { acquiredSame = true; return release; });
  await new Promise((resolveWait) => setTimeout(resolveWait, 30));
  assert.equal(acquiredSame, false);
  const releaseB = await acquireFigmaWorkspaceFileLock("file-b", { timeoutMs: 500 });
  await releaseB();
  await releaseA();
  const releaseSame = await same;
  await releaseSame();
  assert.equal(acquiredSame, true);
});

test("fresh malformed lock owners are not reclaimed until the stale threshold", async () => {
  const fileKey = `fresh-malformed-${randomUUID()}`;
  const lockPath = mutationLockPath(fileKey);
  await mkdir(lockPath, { recursive: true });
  await writeFile(resolve(lockPath, "owner.json"), "{", "utf8");
  try {
    await assert.rejects(
      acquireFigmaWorkspaceFileLock(fileKey, { timeoutMs: 20, retryMs: 2, staleMs: 60_000 }),
      (error) => error?.code === "FIGMA_WORKSPACE_LOCK_TIMEOUT",
    );
    assert.equal(await readFile(resolve(lockPath, "owner.json"), "utf8"), "{");
  } finally {
    await rm(lockPath, { recursive: true, force: true });
  }
});

test("stale malformed lock owners are reclaimed after the stale threshold", async () => {
  const fileKey = `stale-malformed-${randomUUID()}`;
  const lockPath = mutationLockPath(fileKey);
  const ownerPath = resolve(lockPath, "owner.json");
  await mkdir(lockPath, { recursive: true });
  await writeFile(ownerPath, "{", "utf8");
  const now = Date.now();
  await utimes(ownerPath, new Date(now - 60_000), new Date(now - 60_000));
  const release = await acquireFigmaWorkspaceFileLock(fileKey, {
    now: () => now,
    timeoutMs: 500,
    retryMs: 2,
    staleMs: 100,
    isProcessAlive: () => false,
  });
  await release();
  await assert.rejects(stat(lockPath), /ENOENT/u);
});

test("lock heartbeats always expose a complete non-empty owner record", async () => {
  const fileKey = `heartbeat-${randomUUID()}`;
  const lockPath = mutationLockPath(fileKey);
  const ownerPath = resolve(lockPath, "owner.json");
  const release = await acquireFigmaWorkspaceFileLock(fileKey, { heartbeatMs: 1, timeoutMs: 500 });
  try {
    for (let index = 0; index < 50; index += 1) {
      const source = await readFile(ownerPath, "utf8");
      assert.ok(source.length > 0);
      const owner = JSON.parse(source);
      assert.equal(owner.pid, process.pid);
      assert.equal(typeof owner.token, "string");
      await new Promise((resolveWait) => setTimeout(resolveWait, 1));
    }
  } finally {
    await release();
  }
});

test("generic upstream calls serialize by nested arguments.fileKey", async () => {
  const input = JSON.stringify({ toolName: "example_mutation", arguments: { fileKey: "nested-file-key" } });
  const firstOutput = createIo(input);
  const secondOutput = createIo(input);
  let callCount = 0;
  let releaseFirst;
  let reportFirstStarted;
  const firstStarted = new Promise((resolveStarted) => { reportFirstStarted = resolveStarted; });
  const firstGate = new Promise((resolveGate) => { releaseFirst = resolveGate; });
  const createClient = () => ({
    close: async () => {},
    callUpstreamTool: async () => {
      callCount += 1;
      if (callCount === 1) {
        reportFirstStarted();
        await firstGate;
      }
      return { ok: true };
    },
  });

  const first = runFigmaWorkspaceCli(["call-upstream-tool", "--input", "-"], { io: firstOutput.io, createClient });
  await firstStarted;
  const second = runFigmaWorkspaceCli(["call-upstream-tool", "--input", "-"], { io: secondOutput.io, createClient });
  await new Promise((resolveWait) => setTimeout(resolveWait, 30));
  assert.equal(callCount, 1);
  releaseFirst();
  assert.deepEqual(await Promise.all([first, second]), [0, 0]);
  assert.equal(callCount, 2);
});

function createIo(stdin = "{}", cwd = process.cwd()) {
  const stdout = [];
  const stderr = [];
  return {
    stdout, stderr,
    io: {
      cwd: () => cwd,
      env: () => undefined,
      readFile: async (path) => readFile(path, "utf8"),
      readStdin: async () => stdin,
      writeStdout: (value) => stdout.push(value),
      writeStderr: (value) => stderr.push(value),
    },
  };
}

function mutationLockPath(fileKey) {
  return resolve(tmpdir(), "figma-workspace", "locks", `${createHash("sha256").update(fileKey).digest("hex")}.lock`);
}
