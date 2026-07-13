import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";
import {
  FIGMA_COMMAND_FAMILIES,
  FIGMA_DIRECT_COMMANDS,
  FIGMA_JSON_COMMANDS,
  formatRootHelp,
  runFigmaCommand,
  runFigmaCommandCli,
} from "../dist/cli/figma-command-runtime.js";

const packageRoot = resolve(import.meta.dirname, "..");
const runtimePath = resolve(packageRoot, "dist/cli/figma-command-runtime.js");

test("build publishes the typed shared Figma command runtime", async () => {
  const source = await readFile(runtimePath, "utf8");
  assert.match(source, /runFigmaCommandCli/u);
  assert.equal(typeof runFigmaCommandCli, "function");
  assert.equal(typeof runFigmaCommand, "function");
  assert.equal(Object.keys(FIGMA_DIRECT_COMMANDS).length, 17);
  assert.equal(Object.keys(FIGMA_JSON_COMMANDS).length, 9);
  assert.deepEqual(Object.keys(FIGMA_COMMAND_FAMILIES), ["docs", "api", "sessions", "upstream"]);
});

test("direct command parsing maps typed input and optimized global arguments", async () => {
  const calls = [];
  const output = createOutput();
  const exitCode = await runFigmaCommand("inspect", [
    "$hero", "--mode", "validate", "--depth", "2", "--handle", "title", "--handle", "body",
    "--session-id", "workspace", "--state-file", "state.json", "--max-inline-bytes", "512",
  ], {
    ...output.dependencies,
    runCli: async (argv, dependencies) => {
      calls.push({ argv, input: JSON.parse(await dependencies.io.readStdin()) });
      return 0;
    },
  });
  assert.equal(exitCode, 0, output.stderr);
  assert.deepEqual(calls, [{
    argv: ["inspect", "--input", "-", "--session-file", "state.json", "--inline-result-limit", "512"],
    input: {
      target: "$hero", mode: "validate", depth: 2, handles: ["title", "body"], sessionId: "workspace",
    },
  }]);
});

test("direct parsing supports option order and an exact positional separator", async () => {
  const calls = [];
  const runCli = async (argv, dependencies) => {
    calls.push({ argv, input: JSON.parse(await dependencies.io.readStdin()) });
    return 0;
  };

  assert.equal(await runFigmaCommand("api:search", ["--limit", "2", "createFrame"], { runCli }), 0);
  assert.equal(await runFigmaCommand("api:search", ["createFrame", "--limit", "2"], { runCli }), 0);
  assert.equal(await runFigmaCommand("api:search", ["--limit", "2", "--", "--help"], { runCli }), 0);
  assert.deepEqual(calls.map(({ input }) => input), [
    { kind: "api", symbol: "createFrame", maxResults: 2 },
    { kind: "api", symbol: "createFrame", maxResults: 2 },
    { kind: "api", symbol: "--help", maxResults: 2 },
  ]);
});

test("strict integers accept exact boundaries and reject non-decimal or unsafe values before runtime", async () => {
  const accepted = [];
  for (const value of ["0", "10000"]) {
    assert.equal(await runFigmaCommand("doctor", ["--max-inline-bytes", value], {
      runCli: async (argv) => { accepted.push(argv); return 0; },
    }), 0);
  }
  assert.deepEqual(accepted, [
    ["doctor", "--input", "-", "--inline-result-limit", "0"],
    ["doctor", "--input", "-", "--inline-result-limit", "10000"],
  ]);

  for (const value of ["", "+1", "1.0", "1e3", "9007199254740992", "-9007199254740992"]) {
    const output = createOutput();
    assert.equal(await runFigmaCommand("doctor", ["--max-inline-bytes", value], {
      ...output.dependencies,
      readFile: async () => assert.fail("invalid input must fail before file I/O"),
      runCli: async () => assert.fail("invalid input must fail before runtime"),
    }), 2, value);
    assert.match(output.stderr, /requires an integer|requires a safe integer/u, value);
  }
});

test("JSON commands retain optimized option validation and transport mapping", async () => {
  const calls = [];
  const output = createOutput();
  assert.equal(await runFigmaCommand("task:prepare", [
    "--input", "task.json", "--state-file", "state.json", "--max-inline-bytes", "0",
  ], {
    ...output.dependencies,
    runCli: async (argv) => { calls.push(argv); return 7; },
  }), 7);
  assert.deepEqual(calls, [[
    "prepare-task", "--input", "task.json", "--session-file", "state.json", "--inline-result-limit", "0",
  ]]);

  assert.equal(await runFigmaCommand("task:prepare", [], output.dependencies), 2);
  assert.match(output.stderr, /requires --input <json-file\|->/u);
});

test("bare help remains a legal positional or option value", async () => {
  const directCalls = [];
  const directOutput = createOutput();
  assert.equal(await runFigmaCommand("api:search", ["help"], {
    ...directOutput.dependencies,
    runCli: async (argv, dependencies) => {
      directCalls.push({ argv, input: JSON.parse(await dependencies.io.readStdin()) });
      return 0;
    },
  }), 0);
  assert.deepEqual(directCalls, [{
    argv: ["lookup", "--input", "-"],
    input: { kind: "api", symbol: "help" },
  }]);
  assert.equal(directOutput.stdout, "");

  const jsonCalls = [];
  const jsonOutput = createOutput();
  assert.equal(await runFigmaCommand("eval", ["--input", "help"], {
    ...jsonOutput.dependencies,
    runCli: async (argv) => { jsonCalls.push(argv); return 0; },
  }), 0);
  assert.deepEqual(jsonCalls, [["eval", "--input", "help"]]);
  assert.equal(jsonOutput.stdout, "");
});

test("root, family, direct, and JSON help remain locally formatted", async () => {
  const root = createOutput();
  assert.equal(await runFigmaCommandCli(["--help"], root.dependencies), 0);
  assert.equal(root.stdout, formatRootHelp());
  assert.match(root.stdout, /^# Figma command CLI help/u);
  assert.match(root.stdout, /^- `guidance`$/mu);
  assert.match(root.stdout, /^- `task:prepare`$/mu);

  const family = createOutput();
  assert.equal(await runFigmaCommand("docs", [], family.dependencies), 0);
  assert.match(family.stdout, /^# figma docs help/u);
  assert.match(family.stdout, /figma:docs:search/u);

  const direct = createOutput();
  assert.equal(await runFigmaCommand("guidance", ["--help"], direct.dependencies), 0);
  assert.match(direct.stdout, /--card-limit <n>/u);
  assert.match(direct.stdout, /--max-inline-bytes <bytes>/u);
  assert.match(direct.stdout, /<query>.*Required\./u);
  assert.match(direct.stdout, /--workflow <id>.*Default: unset\./u);
  assert.match(direct.stdout, /--card-limit <n>.*Range: 1 to 8\./u);
  assert.match(direct.stdout, /--max-inline-bytes <bytes>.*Default: 4096\..*Range: 0 to 10000\./u);

  const json = createOutput();
  assert.equal(await runFigmaCommand("capture", ["-h"], json.dependencies), 0);
  assert.match(json.stdout, /figma:raw -- capture-node --help/u);
  assert.match(json.stdout, /--input <json-file\|->.*Required\./u);
  assert.match(json.stdout, /--state-file <path>.*Default: FIGMA_WORKSPACE_SESSION_FILE/u);
  assert.match(json.stdout, /--max-inline-bytes <bytes>.*Default: input inlineResultLimit when present, otherwise 4096\./u);

  const repeatable = createOutput();
  assert.equal(await runFigmaCommand("inspect", ["--help"], repeatable.dependencies), 0);
  assert.match(repeatable.stdout, /--handle <name>.*Default: unset\. Repeatable: yes\./u);
});

function createOutput() {
  let stdout = "";
  let stderr = "";
  return {
    get stdout() { return stdout; },
    get stderr() { return stderr; },
    dependencies: {
      writeStdout: (value) => { stdout += value; },
      writeStderr: (value) => { stderr += value; },
    },
  };
}
