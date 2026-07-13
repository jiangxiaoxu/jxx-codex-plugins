import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { cp, mkdtemp, readFile, readdir, rename, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import test from "node:test";
import {
  FIGMA_WORKSPACE_CLI_COMMANDS,
  FIGMA_WORKSPACE_CLI_EXIT_EXECUTION_ERROR,
  FIGMA_WORKSPACE_CLI_EXIT_INTERRUPT,
  FIGMA_WORKSPACE_CLI_EXIT_SUCCESS,
  classifyFigmaWorkspaceCliResult,
  createFigmaWorkspaceClient,
  createFigmaWorkspaceCommandHelp,
  formatFigmaWorkspaceCommandMarkdown,
  runFigmaWorkspaceCli,
  writeFigmaWorkspaceSessions,
} from "../dist/index.js";

const packageRoot = resolve(import.meta.dirname, "..");
const cliPath = resolve(packageRoot, "dist/cli/figma-workspace-cli.js");

const commandMethods = {
  open: "open",
  eval: "eval",
  "run-script-file": "runScriptFile",
  "apply-asset-manifest": "applyAssetManifest",
  "download-assets": "downloadAssets",
  "capture-node": "captureNode",
  "run-task-plan": "runTaskPlan",
  "prepare-task": "prepareTask",
  guidance: "guidance",
  inspect: "inspect",
  "get-metadata": "getMetadata",
  "get-design-context": "getDesignContext",
  "get-motion-context": "getMotionContext",
  "search-design-system": "searchDesignSystem",
  "get-libraries": "getLibraries",
  "get-variable-defs": "getVariableDefs",
  "call-upstream-tool": "callUpstreamTool",
  lookup: "lookup",
  docs: "docs",
  doctor: "doctor",
  sessions: "sessionsInfo",
  "upstream-tools": "upstreamTools",
};

test("build publishes a private package with only the figma-workspace CLI bin", async () => {
  const packageData = JSON.parse(await readFile(resolve(packageRoot, "package.json"), "utf8"));
  const distFiles = (await readdir(resolve(packageRoot, "dist"), { recursive: true }))
    .map((entry) => entry.replaceAll("\\", "/"));

  assert.equal(packageData.name, "@jxx-codex-plugins/figma-workspace-cli");
  assert.equal(packageData.private, true);
  assert.equal(packageData.main, undefined);
  assert.equal(packageData.types, undefined);
  assert.equal(packageData.exports, undefined);
  assert.deepEqual(packageData.bin, {
    "figma-workspace": "./dist/cli/figma-workspace-cli.js",
  });
  assert.equal(distFiles.includes("index.js"), true);
  assert.equal(distFiles.includes("index.d.ts"), false);
  assert.equal(distFiles.includes("workspace-client.js"), true);
  assert.equal(distFiles.includes("workspace-client.d.ts"), false);
  assert.equal(distFiles.includes("cli/figma-workspace-cli.js"), true);
  assert.equal(distFiles.some((entry) => entry === "mcp" || entry.startsWith("mcp/")), false);
  assert.equal(distFiles.some((entry) => entry.includes("upstream-stdio")), false);
  for (const file of [
    "figma-workspace-overview.md",
    "figma-workspace-workflow.md",
    "figma-workspace-guidance-and-lookup.md",
    "figma-workspace-safety.md",
    "figma-workspace-diagnostics.md",
    "figma-workspace-sessions.md",
    "figma-workspace-upstream-tools.md",
  ]) {
    assert.equal(distFiles.includes(`skills/figma-workspace/references/${file}`), true, file);
  }
  assert.match(await readFile(cliPath, "utf8"), /^#!\/usr\/bin\/env node\n/u);
});

test("CLI exposes local help and returns a usage error for unknown commands", async () => {
  const help = await runCli(["--help"]);
  assert.equal(help.code, 0, help.stderr);
  assert.match(help.stdout, /^# Figma Workspace CLI help\n/u);
  assert.match(help.stdout, /^## Usage$/mu);
  assert.match(help.stdout, /^## Commands$/mu);
  assert.match(help.stdout, /^## Options$/mu);
  assert.match(help.stdout, /^## Output$/mu);
  for (const command of Object.keys(commandMethods)) {
    assert.match(help.stdout, new RegExp("^- `" + command + "`$", "mu"));
  }

  const commandHelp = await runCli(["open", "--help"]);
  assert.equal(commandHelp.code, 0, commandHelp.stderr);
  assert.match(commandHelp.stdout, /^# figma-workspace open help\n/u);
  assert.match(commandHelp.stdout, /^## CLI Options$/mu);
  assert.match(commandHelp.stdout, /^## Input JSON Schema$/mu);
  assert.match(commandHelp.stdout, /```json\n\{/u);

  const usage = await runCli(["not-a-command"]);
  assert.equal(usage.code, 2);
  assert.match(usage.stderr, /Unknown command: not-a-command/u);
  assert.match(usage.stderr, /# Figma Workspace CLI help/u);
});

test("every command-specific help exposes its canonical input JSON schema", () => {
  for (const command of FIGMA_WORKSPACE_CLI_COMMANDS) {
    const help = createFigmaWorkspaceCommandHelp(command);
    assert.match(help, new RegExp(`^# figma-workspace ${command} help$`, "mu"));
    assert.match(help, /^## Purpose\n.+/mu);
    assert.match(help, /^## Usage$/mu);
    assert.match(help, /^## CLI Options$/mu);
    assert.match(help, /^## Input JSON Schema$/mu);
    assert.match(help, /^## Output$/mu);
    assert.doesNotMatch(help, /figma_workspace_|figma-workspace:\/\//u, command);
    const schemaSource = help.match(/## Input JSON Schema\n```json\n([\s\S]*?)\n```/u)?.[1];
    assert.notEqual(schemaSource, undefined, command);
    const schema = JSON.parse(schemaSource);
    assert.equal(schema.type, "object", command);
    assert.equal(typeof schema.properties, "object", command);
    assert.equal(Array.isArray(schema.required), true, command);
  }
  const runScriptHelp = createFigmaWorkspaceCommandHelp("run-script-file");
  assert.match(runScriptHelp, /"scriptPath"/u);
  assert.match(runScriptHelp, /"required": \[/u);
  assert.match(runScriptHelp, /--inline-result-limit <bytes>/u);
});

test("Restricted Markdown formatter expands nested objects, arrays, and fenced values", () => {
  const markdown = formatFigmaWorkspaceCommandMarkdown("inspect", {
    ok: true,
    summary: "complete",
    nested: {
      child: {
        value: 7,
        multiline: "before\r\n```\r\n# injected\r\n\u001b[31mred\u001b[0m\r\n````\r\nafter",
      },
    },
    items: [{ id: "first", detail: { enabled: true } }, "plain"],
    deep: { one: { two: { three: { four: { five: { six: "```json\n# escaped heading" } } } } } },
  }, {
    target: "$selection",
    options: { depth: 2 },
  });
  assert.match(markdown, /^# figma-workspace inspect$/mu);
  assert.match(markdown, /^Input: target=\$selection, options=\{"depth":2\}$/mu);
  assert.match(markdown, /^Summary: complete$/mu);
  assert.match(markdown, /^## Nested$/mu);
  assert.match(markdown, /^### Child$/mu);
  assert.match(markdown, /^Value: 7$/mu);
  assert.match(markdown, /`````text\nbefore\r\n```\r\n# injected\r\nred\r\n````\r\nafter\n`````/u);
  assert.doesNotMatch(markdown, /\u001b/u);
  assert.match(markdown, /^## Items$/mu);
  assert.match(markdown, /^### first$/mu);
  assert.match(markdown, /^Enabled: true$/mu);
  assert.match(markdown, /^- plain$/mu);
  assert.match(markdown, /````json\n\{[\s\S]*"six": "```json\\n# escaped heading"[\s\S]*\n````/u);
  assert.doesNotMatch(markdown, /^\s*\{/u);
});

test("Restricted Markdown formatter sanitizes control characters in result labels", () => {
  const markdown = formatFigmaWorkspaceCommandMarkdown("inspect", {
    ok: true,
    "safe\r\nStatus: failed\u0000\u0085\u2028# injected": "value",
  });
  assert.match(markdown, /^Safe Status: failed # injected: value$/mu);
  assert.doesNotMatch(markdown, /^Status: failed$/mu);
  assert.doesNotMatch(markdown, /^# injected/mu);
  assert.doesNotMatch(markdown, /[\u0000\u0085\u2028]/u);
});

test("inline threshold measures final Markdown bytes rather than JSON bytes", async () => {
  const tempDir = await mkdtemp(join(tmpdir(), "figma-workspace-cli-markdown-threshold-"));
  try {
    const result = { ok: true, a: "x" };
    const markdownBytes = Buffer.byteLength(formatFigmaWorkspaceCommandMarkdown("guidance", result), "utf8");
    const jsonBytes = Buffer.byteLength(`${JSON.stringify(result, null, 2)}\n`, "utf8");
    assert.ok(markdownBytes > jsonBytes);
    const output = await runInjectedCliResult({ tempDir, result, inlineResultLimit: jsonBytes });
    assert.match(output.stdout, /Cli Result File/u);
    assert.deepEqual(await readCliResultSidecar(output.stdout), result);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("inline threshold includes the exact boundary and counts multibyte UTF-8", async () => {
  const tempDir = await mkdtemp(join(tmpdir(), "figma-workspace-cli-utf8-threshold-"));
  try {
    const result = { ok: true, message: "汉字🙂" };
    const markdown = formatFigmaWorkspaceCommandMarkdown("guidance", result);
    const markdownBytes = Buffer.byteLength(markdown, "utf8");
    assert.ok(markdownBytes > markdown.length);

    const exact = await runInjectedCliResult({ tempDir, result, inlineResultLimit: markdownBytes });
    assert.match(exact.stdout, /^Message: 汉字🙂$/mu);
    assert.doesNotMatch(exact.stdout, /Cli Result File/u);

    const below = await runInjectedCliResult({ tempDir, result, inlineResultLimit: markdownBytes - 1 });
    assert.match(below.stdout, /Cli Result File/u);
    assert.deepEqual(await readCliResultSidecar(below.stdout), result);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("default 4KB inline limit writes complete JSON to a sidecar", async () => {
  const tempDir = await mkdtemp(join(tmpdir(), "figma-workspace-cli-default-limit-"));
  try {
    const output = createMemoryIo({ cwd: tempDir });
    const result = { ok: true, payload: "x".repeat(5_000), nested: { complete: true } };
    const exitCode = await runFigmaWorkspaceCli(
      ["guidance", "--session-file", resolve(tempDir, "session.json")],
      {
        io: output.io,
        createClient: () => createRecordingClient([], result),
        loadSessions: async () => [],
        saveSessions: async () => undefined,
      },
    );
    assert.equal(exitCode, 0);
    assert.match(output.stdout, /^## Output Files$/mu);
    assert.match(output.stdout, /^### Cli Result File$/mu);
    assert.match(output.stdout, /^Limit Bytes: 4096$/mu);
    assert.doesNotMatch(output.stdout, /x{100}/u);
    assert.deepEqual(await readCliResultSidecar(output.stdout), result);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("CLI inline limit overrides input and keeps a result below the override inline", async () => {
  const tempDir = await mkdtemp(join(tmpdir(), "figma-workspace-cli-limit-override-"));
  try {
    const inputFile = resolve(tempDir, "input.json");
    await writeFile(inputFile, '{"inlineResultLimit":0}', "utf8");
    const output = createMemoryIo({ cwd: tempDir });
    const exitCode = await runFigmaWorkspaceCli(
      [
        "guidance", "--input", inputFile,
        "--session-file", resolve(tempDir, "session.json"),
        "--inline-result-limit", "10000",
      ],
      {
        io: output.io,
        createClient: () => createRecordingClient([], { ok: true, payload: "y".repeat(5_000) }),
        loadSessions: async () => [],
        saveSessions: async () => undefined,
      },
    );
    assert.equal(exitCode, 0);
    assert.match(output.stdout, /^Payload: y{100}/mu);
    assert.doesNotMatch(output.stdout, /Cli Result File/u);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("CLI limit overrides runScriptFile input limit through the real typed client", async () => {
  const tempDir = await mkdtemp(join(tmpdir(), "figma-workspace-cli-typed-script-limit-"));
  try {
    const scriptPath = resolve(tempDir, "typed-limit.figma.ts");
    const inputFile = resolve(tempDir, "input.json");
    await writeFile(scriptPath, "return { payload: 'typed script result' };", "utf8");
    await writeFile(inputFile, JSON.stringify({ scriptPath, inlineResultLimit: 0 }), "utf8");
    const output = createMemoryIo({ cwd: tempDir });
    const exitCode = await runFigmaWorkspaceCli(
      [
        "run-script-file", "--input", inputFile,
        "--session-file", resolve(tempDir, "session.json"),
        "--inline-result-limit", "10000",
      ],
      typedCliDependencies(output.io, createCliFakeUpstream(() => ({
        content: [{ type: "text", text: JSON.stringify({
          ok: true,
          __figmaRepl: { sessionId: "default", handles: {} },
          result: { payload: "typed script result" },
        }) }],
      }))),
    );
    assert.equal(exitCode, 0, output.stderr);
    assert.match(output.stdout, /^Payload: typed script result$/mu);
    assert.doesNotMatch(output.stdout, /Cli Result File/u);
    assert.doesNotMatch(output.stdout, /^## Inline Result Limit$/mu);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("CLI zero limit overrides eval input limit through the real typed client", async () => {
  const tempDir = await mkdtemp(join(tmpdir(), "figma-workspace-cli-typed-eval-limit-"));
  try {
    const inputFile = resolve(tempDir, "input.json");
    await writeFile(inputFile, JSON.stringify({
      code: "return { payload: 'typed eval result' };",
      inlineResultLimit: 10_000,
    }), "utf8");
    const output = createMemoryIo({ cwd: tempDir });
    const exitCode = await runFigmaWorkspaceCli(
      [
        "eval", "--input", inputFile,
        "--session-file", resolve(tempDir, "session.json"),
        "--inline-result-limit", "0",
      ],
      typedCliDependencies(output.io, createCliFakeUpstream(() => ({
        content: [{ type: "text", text: JSON.stringify({
          ok: true,
          __figmaRepl: { sessionId: "default", handles: {} },
          result: { payload: "typed eval result" },
        }) }],
      }))),
    );
    assert.equal(exitCode, 0, output.stderr);
    assert.match(output.stdout, /Cli Result File/u);
    const completeCliResult = await readCliResultSidecar(output.stdout);
    assert.equal(completeCliResult.inlineResultLimit.limitBytes, 0);
    assert.equal(completeCliResult.upstream.result, undefined);
    assert.equal(typeof completeCliResult.outputFiles.upstreamFile.path, "string");
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("inline limit zero always writes even a small complete result to a sidecar", async () => {
  const tempDir = await mkdtemp(join(tmpdir(), "figma-workspace-cli-limit-zero-"));
  try {
    const output = createMemoryIo({ cwd: tempDir });
    const result = { ok: true, summary: "small but complete" };
    const exitCode = await runFigmaWorkspaceCli(
      [
        "guidance", "--session-file", resolve(tempDir, "session.json"),
        "--inline-result-limit", "0",
      ],
      {
        io: output.io,
        createClient: () => createRecordingClient([], result),
        loadSessions: async () => [],
        saveSessions: async () => undefined,
      },
    );
    assert.equal(exitCode, 0);
    assert.match(output.stdout, /^Limit Bytes: 0$/mu);
    assert.doesNotMatch(output.stdout, /small but complete/u);
    assert.deepEqual(await readCliResultSidecar(output.stdout), result);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("inline limit above the global maximum returns a usage error", async () => {
  const output = createMemoryIo();
  const exitCode = await runFigmaWorkspaceCli(
    ["guidance", "--inline-result-limit", "10001"],
    { io: output.io },
  );
  assert.equal(exitCode, 2);
  assert.equal(output.stdout, "");
  assert.match(output.stderr, /must be an integer from 0 to 10000/u);
  assert.match(output.stderr, /# Figma Workspace CLI help/u);
});

test("all 22 CLI commands map one-to-one to typed client methods", async () => {
  assert.equal(FIGMA_WORKSPACE_CLI_COMMANDS.length, 22);
  assert.deepEqual([...FIGMA_WORKSPACE_CLI_COMMANDS], Object.keys(commandMethods));

  for (const [command, expectedMethod] of Object.entries(commandMethods)) {
    const calls = [];
    const client = createRecordingClient(calls);
    const output = createMemoryIo();
    const exitCode = await runFigmaWorkspaceCli(
      [command, "--session-file", resolve(packageRoot, ".test-session.json")],
      {
        io: output.io,
        createClient: () => client,
        loadSessions: async (sessionFile) => {
          assert.equal(isAbsolute(sessionFile), true);
          return [];
        },
        saveSessions: async (sessionFile, sessions) => {
          assert.equal(isAbsolute(sessionFile), true);
          assert.deepEqual(sessions, []);
        },
      },
    );
    assert.equal(exitCode, FIGMA_WORKSPACE_CLI_EXIT_SUCCESS, command);
    assert.deepEqual(calls, [[expectedMethod, {}], ["close"]], command);
    assert.equal(output.stdout, `# figma-workspace ${command}\nInput: none\nStatus: succeeded\nMethod: ${expectedMethod}\n`);
    assert.equal(output.stderr, "");
  }
});

test("CLI accepts JSON from a file and stdin", async () => {
  const tempDir = await mkdtemp(join(tmpdir(), "figma-workspace-cli-input-"));
  try {
    const inputFile = resolve(tempDir, "input.json");
    await writeFile(inputFile, '{"marker":"file"}\n', "utf8");
    for (const [inputOption, marker, stdin] of [
      [inputFile, "file", ""],
      ["-", "stdin", '{"marker":"stdin"}'],
    ]) {
      const calls = [];
      const output = createMemoryIo({ cwd: tempDir, stdin });
      const exitCode = await runFigmaWorkspaceCli(
        ["guidance", "--input", inputOption, "--session-file", resolve(tempDir, "session.json")],
        {
          io: output.io,
          createClient: () => createRecordingClient(calls),
          loadSessions: async () => [],
          saveSessions: async () => undefined,
        },
      );
      assert.equal(exitCode, 0);
      assert.deepEqual(calls[0], ["guidance", { marker }]);
    }
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("built CLI reads JSON stdin through the real process pipe", async () => {
  const tempDir = await mkdtemp(join(tmpdir(), "figma-workspace-cli-real-stdin-"));
  try {
    const sessionFile = resolve(tempDir, "session.json");
    const result = await runCli(
      [
        "guidance", "--input", "-", "--session-file", sessionFile,
        "--inline-result-limit", "0",
      ],
      { stdin: '{"query":"component variants","surface":"design"}' },
    );
    assert.equal(result.code, 0, result.stderr);
    assert.match(result.stdout, /^# figma-workspace guidance$/mu);
    assert.match(result.stdout, /^Input: query=component variants, surface=design$/mu);
    assert.match(result.stdout, /^Status: succeeded$/mu);
    assert.match(result.stdout, /^## Output Files$/mu);
    assert.match(result.stdout, /^### Cli Result File$/mu);
    assert.doesNotMatch(result.stdout, /^Status: failed$/mu);
    const fullResult = await readCliResultSidecar(result.stdout);
    assert.equal(fullResult.ok, true);
    assert.ok(fullResult.suggestions.referenceContext.length > 0);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("CLI exits 1 when a command returns top-level ok false", async () => {
  const output = createMemoryIo();
  const client = createRecordingClient([], { ok: false, diagnostics: [{ message: "blocked" }] });
  const exitCode = await runFigmaWorkspaceCli(
    ["guidance", "--session-file", resolve(packageRoot, ".test-session.json")],
    {
      io: output.io,
      createClient: () => client,
      loadSessions: async () => [],
      saveSessions: async () => undefined,
    },
  );
  assert.equal(exitCode, FIGMA_WORKSPACE_CLI_EXIT_EXECUTION_ERROR);
  assert.match(output.stdout, /^# figma-workspace guidance$/mu);
  assert.match(output.stdout, /^Input: none$/mu);
  assert.match(output.stdout, /^Status: failed$/mu);
  assert.match(output.stdout, /^## Diagnostics$/mu);
  assert.match(output.stdout, /^Message: blocked$/mu);
  assert.equal(output.stderr, "");
});

test("CLI presentation distinguishes completed unhealthy observations from failures", async () => {
  const unhealthy = {
    ok: false,
    runtime: { projectDocs: { ok: false }, lookup: { ok: true }, typescript: { ok: true } },
    guidance: ["repair installed assets"],
    warnings: ["runtime warning"],
  };
  assert.deepEqual(classifyFigmaWorkspaceCliResult("doctor", unhealthy), {
    status: "observed-unhealthy",
    exitCode: FIGMA_WORKSPACE_CLI_EXIT_SUCCESS,
    error: undefined,
    warnings: ["runtime warning"],
  });
  assert.equal(classifyFigmaWorkspaceCliResult("inspect", { ok: false }).exitCode, FIGMA_WORKSPACE_CLI_EXIT_EXECUTION_ERROR);
  assert.equal(classifyFigmaWorkspaceCliResult("inspect", {
    ok: true,
    validations: [{ status: "stale" }, { status: "missing" }],
  }).exitCode, FIGMA_WORKSPACE_CLI_EXIT_SUCCESS);

  const output = createMemoryIo();
  const exitCode = await runFigmaWorkspaceCli(
    ["doctor", "--session-file", resolve(packageRoot, ".test-session.json")],
    {
      io: output.io,
      createClient: () => createRecordingClient([], unhealthy),
      loadSessions: async () => [],
      saveSessions: async () => undefined,
    },
  );
  assert.equal(exitCode, FIGMA_WORKSPACE_CLI_EXIT_SUCCESS);
  assert.match(output.stdout, /^Status: observed unhealthy$/mu);
  assert.equal(output.stderr, "");
});

test("doctor sidecars preserve the original unhealthy result while exiting 0", async () => {
  const tempDir = await mkdtemp(join(tmpdir(), "figma-workspace-cli-doctor-observation-"));
  try {
    const unhealthy = { ok: false, runtime: { lookup: { ok: false } }, guidance: ["repair"] };
    const output = createMemoryIo();
    const exitCode = await runFigmaWorkspaceCli(
      ["doctor", "--session-file", resolve(tempDir, "session.json"), "--inline-result-limit", "0"],
      {
        io: output.io,
        createClient: () => createRecordingClient([], unhealthy),
        loadSessions: async () => [],
        saveSessions: async () => undefined,
      },
    );
    assert.equal(exitCode, FIGMA_WORKSPACE_CLI_EXIT_SUCCESS);
    assert.match(output.stdout, /^Status: observed unhealthy$/mu);
    assert.deepEqual(await readCliResultSidecar(output.stdout), unhealthy);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("typed abort errors map to interrupt exit 130", async () => {
  const output = createMemoryIo();
  const client = createRecordingClient([]);
  client.guidance = async () => {
    const error = new Error("interrupted");
    error.name = "AbortError";
    throw error;
  };
  const exitCode = await runFigmaWorkspaceCli(
    ["guidance", "--session-file", resolve(packageRoot, ".test-session.json")],
    {
      io: output.io,
      createClient: () => client,
      loadSessions: async () => [],
      saveSessions: async () => undefined,
    },
  );
  assert.equal(exitCode, FIGMA_WORKSPACE_CLI_EXIT_INTERRUPT);
  assert.match(output.stderr, /interrupted/u);
});

test("CLI saves mutated sessions and closes the client after a command exception", async () => {
  const output = createMemoryIo();
  const saved = [];
  const calls = [];
  const sessions = [{ id: "mutated-after-error" }];
  const client = createRecordingClient(calls);
  client.guidance = async () => {
    calls.push(["guidance", {}]);
    throw new Error("command failed after mutation");
  };
  client.sessions.list = () => sessions;
  const exitCode = await runFigmaWorkspaceCli(
    ["guidance", "--session-file", resolve(packageRoot, ".test-session.json")],
    {
      io: output.io,
      createClient: () => client,
      loadSessions: async () => [],
      saveSessions: async (_path, values) => { saved.push(...values); },
    },
  );
  assert.equal(exitCode, 1);
  assert.match(output.stderr, /command failed after mutation/u);
  assert.deepEqual(saved, sessions);
  assert.deepEqual(calls, [["guidance", {}], ["close"]]);
});

test("built CLI propagates a real offline ok false result as exit 1", async () => {
  const tempDir = await mkdtemp(join(tmpdir(), "figma-workspace-cli-real-failure-"));
  try {
    const scriptPath = resolve(tempDir, "broken.figma.ts");
    const inputFile = resolve(tempDir, "input.json");
    const sessionFile = resolve(tempDir, "session.json");
    await writeFile(scriptPath, "const frame: FrameNode = figma.createFrame(\n", "utf8");
    await writeFile(inputFile, JSON.stringify({ scriptPath }), "utf8");
    const result = await runCli(
      [
        "run-script-file", "--input", inputFile, "--session-file", sessionFile,
        "--inline-result-limit", "10000",
      ],
      { cwd: tempDir },
    );
    assert.equal(result.code, 1, result.stderr);
    assert.match(result.stdout, /^# figma-workspace run-script-file$/mu);
    assert.match(result.stdout, /^Input: scriptPath=/mu);
    assert.match(result.stdout, /^Status: failed$/mu);
    assert.match(result.stdout, /^Phase: preflight$/mu);
    assert.match(result.stdout, /^Executed: false$/mu);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("CLI persists an absolute session file across Node processes", async () => {
  const tempDir = await mkdtemp(join(tmpdir(), "figma-workspace-cli-persist-"));
  try {
    const sessionFile = resolve(tempDir, "state/session.json");
    const inputFile = resolve(tempDir, "open.json");
    await writeFile(inputFile, JSON.stringify({
      sessionId: "cross-process",
      file: "https://www.figma.com/design/ExampleFigmaFileKey012/Test",
      workspaceDir: tempDir,
      connect: false,
    }), "utf8");
    const first = await runCli(["open", "--input", inputFile, "--session-file", sessionFile], { cwd: tempDir });
    assert.equal(first.code, 0, first.stderr);
    assert.match(first.stdout, /^# figma-workspace open$/mu);
    assert.match(first.stdout, /^Input: sessionId=cross-process,/mu);
    assert.match(first.stdout, /^## Session$/mu);
    assert.match(first.stdout, /^Id: cross-process$/mu);
    const persisted = JSON.parse(await readFile(sessionFile, "utf8"));
    assert.equal(persisted[0].id, "cross-process");
    assert.equal(persisted[0].fileKey, "ExampleFigmaFileKey012");

    await writeFile(inputFile, JSON.stringify({
      sessionId: "cross-process",
      workspaceDir: tempDir,
      connect: false,
    }), "utf8");
    const second = await runCli(["open", "--input", inputFile, "--session-file", sessionFile], { cwd: tempDir });
    assert.equal(second.code, 0, second.stderr);
    assert.match(second.stdout, /^# figma-workspace open$/mu);
    assert.match(second.stdout, /^Id: cross-process$/mu);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("session lock serializes concurrent processes without losing either session", async () => {
  const tempDir = await mkdtemp(join(tmpdir(), "figma-workspace-cli-lock-"));
  try {
    const sessionFile = resolve(tempDir, "state/session.json");
    const inputs = await Promise.all(["lock-a", "lock-b"].map(async (sessionId) => {
      const inputFile = resolve(tempDir, `${sessionId}.json`);
      await writeFile(inputFile, JSON.stringify({
        sessionId,
        file: `https://www.figma.com/design/${sessionId}FileKey012345/Test`,
        workspaceDir: tempDir,
        connect: false,
      }), "utf8");
      return inputFile;
    }));
    const results = await Promise.all(inputs.map((inputFile) => runCli(
      ["open", "--input", inputFile, "--session-file", sessionFile],
      { cwd: tempDir },
    )));
    assert.ok(results.every((result) => result.code === 0), results.map((result) => result.stderr).join("\n"));
    const sessions = JSON.parse(await readFile(sessionFile, "utf8"));
    assert.deepEqual(sessions.map((session) => session.id).sort(), ["lock-a", "lock-b"]);
    await assert.rejects(readFile(`${sessionFile}.lock`, "utf8"), /ENOENT/u);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("live stale session lock is not reclaimed", async () => {
  const tempDir = await mkdtemp(join(tmpdir(), "figma-workspace-cli-live-lock-"));
  try {
    const sessionFile = resolve(tempDir, "session.json");
    const lockFile = `${sessionFile}.lock`;
    const lockSource = `${JSON.stringify({ token: "live", pid: 1234, createdAt: "old" })}\n`;
    await writeFile(lockFile, lockSource, "utf8");
    const old = new Date(Date.now() - 20 * 60_000);
    await utimes(lockFile, old, old);
    let currentTime = Date.now();
    let clientCreated = false;
    const output = createMemoryIo({ cwd: tempDir });
    const exitCode = await runFigmaWorkspaceCli(
      ["guidance", "--session-file", sessionFile],
      {
        io: output.io,
        createClient: () => {
          clientCreated = true;
          return createRecordingClient([]);
        },
        sessionLockOptions: {
          now: () => currentTime,
          wait: async (milliseconds) => { currentTime += milliseconds; },
          isProcessAlive: (pid) => pid === 1234,
          staleMs: 1,
          timeoutMs: 3,
          retryMs: 1,
        },
      },
    );
    assert.equal(exitCode, 1);
    assert.equal(clientCreated, false);
    assert.match(output.stderr, /Timed out waiting for session lock/u);
    assert.equal(await readFile(lockFile, "utf8"), lockSource);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("dead stale session lock is reclaimed and the new lock heartbeats", async () => {
  const tempDir = await mkdtemp(join(tmpdir(), "figma-workspace-cli-dead-lock-"));
  try {
    const sessionFile = resolve(tempDir, "session.json");
    const lockFile = `${sessionFile}.lock`;
    await writeFile(lockFile, `${JSON.stringify({ token: "dead", pid: 4321, createdAt: "old" })}\n`, "utf8");
    const old = new Date(Date.now() - 20 * 60_000);
    await utimes(lockFile, old, old);
    let heartbeatScheduled = false;
    let heartbeatCancelled = false;
    const timer = { unref() {} };
    const output = createMemoryIo({ cwd: tempDir });
    const exitCode = await runFigmaWorkspaceCli(
      ["guidance", "--session-file", sessionFile],
      {
        io: output.io,
        createClient: () => createRecordingClient([]),
        sessionLockOptions: {
          isProcessAlive: () => false,
          staleMs: 1,
          setInterval: (callback) => {
            heartbeatScheduled = true;
            callback();
            return timer;
          },
          clearInterval: (value) => {
            assert.equal(value, timer);
            heartbeatCancelled = true;
          },
        },
      },
    );
    assert.equal(exitCode, 0, output.stderr);
    assert.equal(heartbeatScheduled, true);
    assert.equal(heartbeatCancelled, true);
    await assert.rejects(readFile(lockFile, "utf8"), /ENOENT/u);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("stale lock reclaim does not delete a live lock replaced before the atomic claim", async () => {
  const tempDir = await mkdtemp(join(tmpdir(), "figma-workspace-cli-lock-race-"));
  try {
    const sessionFile = resolve(tempDir, "session.json");
    const lockFile = `${sessionFile}.lock`;
    const staleSource = `${JSON.stringify({ token: "dead", pid: 4321, createdAt: "old" })}\n`;
    const liveSource = `${JSON.stringify({ token: "live", pid: 1234, createdAt: "new" })}\n`;
    await writeFile(lockFile, staleSource, "utf8");
    const old = new Date(Date.now() - 20 * 60_000);
    await utimes(lockFile, old, old);
    let currentTime = Date.now();
    let replaced = false;
    const output = createMemoryIo({ cwd: tempDir });
    const exitCode = await runFigmaWorkspaceCli(["guidance", "--session-file", sessionFile], {
      io: output.io,
      createClient: () => createRecordingClient([]),
      sessionLockOptions: {
        now: () => currentTime,
        wait: async (milliseconds) => { currentTime += milliseconds; },
        isProcessAlive: (pid) => pid === 1234,
        staleMs: 1,
        timeoutMs: 3,
        retryMs: 1,
        rename: async (source, destination) => {
          if (!replaced && source === lockFile) {
            replaced = true;
            await rm(lockFile);
            await writeFile(lockFile, liveSource, "utf8");
          }
          await rename(source, destination);
        },
      },
    });
    assert.equal(exitCode, 1);
    assert.equal(replaced, true);
    assert.match(output.stderr, /Timed out waiting for session lock/u);
    assert.equal(await readFile(lockFile, "utf8"), liveSource);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("CLI uses the default absolute session path under cwd", async () => {
  const tempDir = await mkdtemp(join(tmpdir(), "figma-workspace-cli-default-"));
  try {
    const inputFile = resolve(tempDir, "open.json");
    await writeFile(inputFile, JSON.stringify({
      sessionId: "default-path",
      file: "https://www.figma.com/design/DefaultPathKey01234/Test",
      workspaceDir: tempDir,
      connect: false,
    }), "utf8");
    const result = await runCli(["open", "--input", inputFile], {
      cwd: tempDir,
      env: { FIGMA_WORKSPACE_SESSION_FILE: undefined },
    });
    assert.equal(result.code, 0, result.stderr);
    const defaultSessionFile = resolve(tempDir, ".figma-workspace/session.json");
    assert.equal(isAbsolute(defaultSessionFile), true);
    assert.equal(JSON.parse(await readFile(defaultSessionFile, "utf8"))[0].id, "default-path");
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("session path precedence is explicit then environment then cwd default", async () => {
  const tempDir = await mkdtemp(join(tmpdir(), "figma-workspace-cli-path-precedence-"));
  try {
    const inputFile = resolve(tempDir, "open.json");
    await writeFile(inputFile, JSON.stringify({
      sessionId: "path-precedence",
      file: "https://www.figma.com/design/PathPrecedenceKey01/Test",
      workspaceDir: tempDir,
      connect: false,
    }), "utf8");
    const cases = [
      {
        args: ["open", "--input", inputFile],
        env: { FIGMA_WORKSPACE_SESSION_FILE: "env-relative/session.json" },
        expected: resolve(tempDir, "env-relative/session.json"),
      },
      {
        args: ["open", "--input", inputFile],
        env: { FIGMA_WORKSPACE_SESSION_FILE: resolve(tempDir, "env-absolute.json") },
        expected: resolve(tempDir, "env-absolute.json"),
      },
      {
        args: ["open", "--input", inputFile, "--session-file", "explicit/session.json"],
        env: { FIGMA_WORKSPACE_SESSION_FILE: resolve(tempDir, "ignored-env.json") },
        expected: resolve(tempDir, "explicit/session.json"),
      },
    ];
    for (const entry of cases) {
      const result = await runCli(entry.args, { cwd: tempDir, env: entry.env });
      assert.equal(result.code, 0, result.stderr);
      assert.equal(JSON.parse(await readFile(entry.expected, "utf8"))[0].id, "path-precedence");
    }
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("atomic session writes preserve the previous file and clean temporary files on rename failure", async () => {
  const tempDir = await mkdtemp(join(tmpdir(), "figma-workspace-cli-atomic-session-"));
  try {
    const sessionFile = resolve(tempDir, "session.json");
    const previous = '[{"id":"previous"}]\n';
    await writeFile(sessionFile, previous, "utf8");
    await assert.rejects(
      writeFigmaWorkspaceSessions(sessionFile, [], {
        writeFile: (path, source, encoding) => writeFile(path, source, encoding),
        rename: async () => { throw new Error("rename blocked"); },
        rm: (path, options) => rm(path, options),
      }),
      /rename blocked/u,
    );
    assert.equal(await readFile(sessionFile, "utf8"), previous);
    assert.equal((await readdir(tempDir)).some((entry) => entry.endsWith(".tmp")), false);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("sidecar rename failures exit 1 without leaking temporary or partial result files", async () => {
  const tempDir = await mkdtemp(join(tmpdir(), "figma-workspace-cli-atomic-sidecar-"));
  try {
    const output = createMemoryIo({ cwd: tempDir });
    const exitCode = await runFigmaWorkspaceCli(
      ["guidance", "--session-file", resolve(tempDir, "session.json"), "--inline-result-limit", "0"],
      {
        io: output.io,
        createClient: () => createRecordingClient([], { ok: true, payload: "complete" }),
        loadSessions: async () => [],
        saveSessions: async () => undefined,
        atomicFileOperations: {
          writeFile: (path, source, encoding) => writeFile(path, source, encoding),
          rename: async () => { throw new Error("sidecar rename blocked"); },
          rm: (path, options) => rm(path, options),
        },
      },
    );
    assert.equal(exitCode, FIGMA_WORKSPACE_CLI_EXIT_EXECUTION_ERROR);
    assert.match(output.stderr, /sidecar rename blocked/u);
    assert.equal(output.stdout, "");
    const entries = await readdir(tempDir, { recursive: true });
    assert.equal(entries.some((entry) => entry.endsWith(".tmp") || entry.endsWith(".json")), false);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("copied dist starts without the repository node_modules", async () => {
  const tempDir = await mkdtemp(join(tmpdir(), "figma-workspace-cli-installed-"));
  try {
    await cp(resolve(packageRoot, "dist"), resolve(tempDir, "dist"), { recursive: true });
    await writeFile(resolve(tempDir, "package.json"), '{"private":true,"type":"module"}\n', "utf8");
    const copiedCli = resolve(tempDir, "dist/cli/figma-workspace-cli.js");
    const result = await runNode(copiedCli, ["--help"], { cwd: tempDir });
    assert.equal(result.code, 0, result.stderr);
    assert.match(result.stdout, /^# Figma Workspace CLI help/u);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

function createRecordingClient(calls, result) {
  const client = {
    sessions: { list: () => [] },
    async close() {
      calls.push(["close"]);
    },
  };
  for (const method of Object.values(commandMethods)) {
    client[method] = async (input) => {
      calls.push([method, input]);
      return result ?? { ok: true, method };
    };
  }
  return client;
}

function typedCliDependencies(io, upstream) {
  return {
    io,
    createClient: (options) => createFigmaWorkspaceClient({ ...options, client: upstream }),
    loadSessions: async () => [],
    saveSessions: async () => undefined,
  };
}

function createCliFakeUpstream(callTool) {
  return {
    async connect() {},
    async close() {},
    async listTools() {
      return {
        tools: [{
          name: "use_figma",
          inputSchema: {
            type: "object",
            properties: { code: { type: "string" }, description: { type: "string" } },
            required: ["code"],
          },
        }],
      };
    },
    async callTool(name, args) {
      assert.equal(name, "use_figma");
      assert.equal(typeof args.code, "string");
      return callTool({ name, args });
    },
  };
}

async function runInjectedCliResult({ tempDir, result, inlineResultLimit }) {
  const output = createMemoryIo({ cwd: tempDir });
  const exitCode = await runFigmaWorkspaceCli(
    [
      "guidance", "--session-file", resolve(tempDir, `session-${inlineResultLimit}.json`),
      "--inline-result-limit", String(inlineResultLimit),
    ],
    {
      io: output.io,
      createClient: () => createRecordingClient([], result),
      loadSessions: async () => [],
      saveSessions: async () => undefined,
    },
  );
  assert.equal(exitCode, 0, output.stderr);
  return output;
}

async function readCliResultSidecar(markdown) {
  const resultFile = markdown.match(/^Path: (.+)$/mu)?.[1];
  assert.notEqual(resultFile, undefined, markdown);
  return JSON.parse(await readFile(resultFile, "utf8"));
}

function createMemoryIo(options = {}) {
  let stdout = "";
  let stderr = "";
  return {
    get stdout() { return stdout; },
    get stderr() { return stderr; },
    io: {
      cwd: () => options.cwd ?? packageRoot,
      env: () => undefined,
      readFile: (path) => readFile(path, "utf8"),
      readStdin: async () => options.stdin ?? "",
      writeStdout: (value) => { stdout += value; },
      writeStderr: (value) => { stderr += value; },
    },
  };
}

function runCli(args, options = {}) {
  return runNode(cliPath, args, options);
}

function runNode(script, args, options = {}) {
  return new Promise((resolvePromise, reject) => {
    const env = { ...process.env, ...options.env };
    for (const [name, value] of Object.entries(env)) {
      if (value === undefined) delete env[name];
    }
    const child = spawn(process.execPath, [script, ...args], {
      cwd: options.cwd ?? packageRoot,
      env,
      stdio: [options.stdin === undefined ? "ignore" : "pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.once("error", reject);
    child.once("exit", (code, signal) => resolvePromise({ code, signal, stdout, stderr }));
    if (options.stdin !== undefined) child.stdin.end(options.stdin);
  });
}
