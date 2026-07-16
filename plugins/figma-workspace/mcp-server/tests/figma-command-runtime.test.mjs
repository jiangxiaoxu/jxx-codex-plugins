import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";
import {
  FIGMA_COMMAND_FAMILIES,
  FIGMA_DIRECT_COMMANDS,
  FIGMA_JSON_COMMANDS,
  FIGMA_TASK_FAMILIES,
  formatRootHelp,
  runFigmaCommand,
  runFigmaCommandCli,
} from "../dist/cli/figma-command-runtime.js";

const packageRoot = resolve(import.meta.dirname, "..");
const runtimePath = resolve(packageRoot, "dist/cli/figma-command-runtime.js");
const stateFile = resolve(packageRoot, ".test-state.json");

test("build publishes the typed shared Figma command runtime", async () => {
  const source = await readFile(runtimePath, "utf8");
  assert.match(source, /runFigmaCommandCli/u);
  assert.equal(typeof runFigmaCommandCli, "function");
  assert.equal(typeof runFigmaCommand, "function");
  assert.equal(Object.keys(FIGMA_DIRECT_COMMANDS).length, 18);
  assert.equal(Object.keys(FIGMA_JSON_COMMANDS).length, 8);
  assert.equal(FIGMA_TASK_FAMILIES.length, 12);
  assert.deepEqual(Object.keys(FIGMA_COMMAND_FAMILIES), ["docs", "api", "sessions", "upstream"]);
});

test("direct command parsing maps typed input and optimized global arguments", async () => {
  const calls = [];
  const output = createOutput();
  const exitCode = await runFigmaCommand("inspect", [
    "123:456", "--mode", "style", "--depth", "2",
    "--session-id", "workspace", "--state-file", stateFile, "--max-inline-bytes", "512",
  ], {
    ...output.dependencies,
    runCli: async (argv, dependencies) => {
      calls.push({ argv, input: JSON.parse(await dependencies.io.readStdin()) });
      return 0;
    },
  });
  assert.equal(exitCode, 0, output.stderr);
  assert.deepEqual(calls, [{
    argv: ["inspect", "--input", "-", "--session-file", stateFile, "--inline-result-limit", "512"],
    input: {
      target: "123:456", mode: "style", depth: 2, sessionId: "workspace",
    },
  }]);
});

test("removed handle and policy options fail as optimized CLI usage errors", async () => {
  const cases = [
    ["sessions:read", ["default", "--with-handles"]],
    ["inspect", ["123:456", "--handle", "hero"]],
    ["inspect", ["123:456", "--mode", "validate"]],
    ["eval", ["--input", "eval.json", "--mode", "write"]],
    ["eval", ["--input", "eval.json", "--allow-dangerous-operations"]],
    ["eval", ["--input", "eval.json", "--handle-updates", "replace"]],
    ["script:run", ["--input", "script.json", "--allow-dangerous-operations"]],
  ];

  for (const [commandName, args] of cases) {
    const output = createOutput();
    assert.equal(await runFigmaCommand(commandName, [
      ...args,
      "--state-file", stateFile,
    ], {
      ...output.dependencies,
      runCli: async () => assert.fail(`${commandName} must reject removed options before runtime`),
    }), 2, `${commandName} ${args.join(" ")}`);
    assert.match(output.stderr, /Unknown option|must be one of: inspect, style/u);
  }
});

test("direct parsing supports option order and an exact positional separator", async () => {
  const calls = [];
  const runCli = async (argv, dependencies) => {
    calls.push({ argv, input: JSON.parse(await dependencies.io.readStdin()) });
    return 0;
  };

  assert.equal(await runFigmaCommand("api:search", ["--limit", "2", "createFrame", "--state-file", stateFile], { runCli }), 0);
  assert.equal(await runFigmaCommand("api:search", ["createFrame", "--limit", "2", "--state-file", stateFile], { runCli }), 0);
  assert.equal(await runFigmaCommand("api:search", ["--limit", "2", "--state-file", stateFile, "--", "--help"], { runCli }), 0);
  assert.deepEqual(calls.map(({ input }) => input), [
    { kind: "api", symbol: "createFrame", maxResults: 2 },
    { kind: "api", symbol: "createFrame", maxResults: 2 },
    { kind: "api", symbol: "--help", maxResults: 2 },
  ]);
});

test("docs commands map catalog filters, stable ids, and automatic search routing", async () => {
  const calls = [];
  const runCli = async (_argv, dependencies) => {
    calls.push(JSON.parse(await dependencies.io.readStdin()));
    return 0;
  };

  assert.equal(await runFigmaCommand("docs:list", ["--state-file", stateFile], { runCli }), 0);
  assert.equal(await runFigmaCommand("docs:catalog", [
    "--task-family", "code-connect", "--surface", "design", "--classification", "conditional",
    "--limit", "25", "--state-file", stateFile,
  ], { runCli }), 0);
  assert.equal(await runFigmaCommand("docs:read", ["canonical:code-connect/router", "--state-file", stateFile], { runCli }), 0);
  assert.equal(await runFigmaCommand("docs:search", ["components", "--state-file", stateFile], { runCli }), 0);
  assert.equal(await runFigmaCommand("docs:search", [
    "components", "--scope", "router", "--surface", "design", "--task-family", "design-editing",
    "--state-file", stateFile,
  ], { runCli }), 0);
  assert.deepEqual(calls, [
    { mode: "list" },
    { mode: "catalog", taskFamily: "code-connect", surface: "design", classification: "conditional", limit: 25 },
    { mode: "read", id: "canonical:code-connect/router" },
    { kind: "docs", scope: "auto", query: "components" },
    { kind: "docs", scope: "router", query: "components", surface: "design", taskFamily: "design-editing" },
  ]);

  for (const scope of ["unknown", "Auto", "example"]) {
    const output = createOutput();
    assert.equal(await runFigmaCommand("docs:search", [
      "components", "--scope", scope, "--state-file", stateFile,
    ], { ...output.dependencies, runCli }), 2, scope);
    assert.match(output.stderr, /must be one of: auto, active, conditional, router, examples, all/u, scope);
  }

  const catalogOutput = createOutput();
  assert.equal(await runFigmaCommand("docs:catalog", [
    "--task-family", "create-new-file", "--state-file", stateFile,
  ], { ...catalogOutput.dependencies, runCli }), 2);
  assert.match(catalogOutput.stderr, /must be one of: code-connect, create-file/u);

  const workflowCalls = [];
  assert.equal(await runFigmaCommand("guidance", [
    "motion implementation", "--workflow", "motion-implementation", "--state-file", stateFile,
  ], {
    runCli: async (_argv, dependencies) => {
      workflowCalls.push(JSON.parse(await dependencies.io.readStdin()));
      return 0;
    },
  }), 0);
  assert.deepEqual(workflowCalls, [{
    query: "motion implementation",
    workflow: "motion-implementation",
  }]);

  const unknownWorkflowOutput = createOutput();
  assert.equal(await runFigmaCommand("guidance", [
    "motion implementation", "--workflow", "missing-workflow", "--state-file", stateFile,
  ], {
    ...unknownWorkflowOutput.dependencies,
    runCli: async () => assert.fail("unknown workflow must fail before runtime"),
  }), 2);
  assert.match(unknownWorkflowOutput.stderr, /must be one of: design-implementation-context, motion-implementation/u);

  const apiOutput = createOutput();
  assert.equal(await runFigmaCommand("api:search", [
    "createFrame", "--scope", "active", "--state-file", stateFile,
  ], { ...apiOutput.dependencies, runCli }), 2);
  assert.match(apiOutput.stderr, /Unknown option for figma api:search: --scope/u);
});

test("strict integers accept exact boundaries and reject non-decimal or unsafe values before runtime", async () => {
  const accepted = [];
  for (const value of ["0", "10000"]) {
    assert.equal(await runFigmaCommand("doctor", ["--state-file", stateFile, "--max-inline-bytes", value], {
      runCli: async (argv) => { accepted.push(argv); return 0; },
    }), 0);
  }
  assert.deepEqual(accepted, [
    ["doctor", "--input", "-", "--session-file", stateFile, "--inline-result-limit", "0"],
    ["doctor", "--input", "-", "--session-file", stateFile, "--inline-result-limit", "10000"],
  ]);

  for (const value of ["", "+1", "1.0", "1e3", "9007199254740992", "-9007199254740992"]) {
    const output = createOutput();
    assert.equal(await runFigmaCommand("doctor", ["--state-file", stateFile, "--max-inline-bytes", value], {
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
    "--input", "task.json", "--state-file", stateFile, "--max-inline-bytes", "0",
  ], {
    ...output.dependencies,
    runCli: async (argv) => { calls.push(argv); return 7; },
  }), 7);
  assert.deepEqual(calls, [[
    "prepare-task", "--input", "task.json", "--session-file", stateFile, "--inline-result-limit", "0",
  ]]);

  assert.equal(await runFigmaCommand("task:prepare", ["--state-file", stateFile], output.dependencies), 2);
  assert.match(output.stderr, /requires --input <json-file\|->/u);
});

test("JSON commands normalize an npm-forwarded standalone dash to stdin and reject duplicate input", async () => {
  const calls = [];
  assert.equal(await runFigmaCommand("eval", [
    "--state-file", stateFile, "-",
  ], {
    runCli: async (argv) => { calls.push(argv); return 0; },
  }), 0);
  assert.deepEqual(calls, [["eval", "--session-file", stateFile, "--input", "-"]]);

  const output = createOutput();
  assert.equal(await runFigmaCommand("eval", [
    "--input", "eval.json", "--state-file", stateFile, "-",
  ], {
    ...output.dependencies,
    runCli: async () => assert.fail("duplicate input must fail before runtime"),
  }), 2);
  assert.match(output.stderr, /Duplicate input/u);
});

test("every executing optimized command requires an explicit absolute state file", async () => {
  for (const commandName of Object.keys(FIGMA_DIRECT_COMMANDS)) {
    const output = createOutput();
    const args = commandName === "guidance" ? ["query"]
      : commandName === "docs:read" ? ["project:overview"]
        : commandName === "docs:search" || commandName === "api:search" || commandName === "design-system" ? ["query"]
          : commandName === "sessions:read" ? ["default"]
            : commandName === "upstream:read" ? ["whoami"]
              : [];
    assert.equal(await runFigmaCommand(commandName, args, {
      ...output.dependencies,
      runCli: async () => assert.fail("missing state file must fail before runtime"),
    }), 2, commandName);
    assert.match(output.stderr, /requires --state-file <path>/u, commandName);
  }

  for (const commandName of Object.keys(FIGMA_JSON_COMMANDS)) {
    const output = createOutput();
    const inputArgs = commandName === "open" ? [] : ["--input", "input.json"];
    assert.equal(await runFigmaCommand(commandName, inputArgs, {
      ...output.dependencies,
      runCli: async () => assert.fail("missing state file must fail before runtime"),
    }), 2, commandName);
    assert.match(output.stderr, /requires --state-file <path>/u, commandName);
  }

  const invalidStateFiles = [
    "relative/state.json",
    ...(process.platform === "win32" ? ["/state.json", "\\state.json"] : []),
  ];
  for (const [commandName, args] of [["guidance", ["query"]], ["open", []]]) {
    for (const invalidStateFile of invalidStateFiles) {
      const output = createOutput();
      assert.equal(await runFigmaCommand(commandName, [...args, "--state-file", invalidStateFile], {
        ...output.dependencies,
        runCli: async () => assert.fail("invalid state file must fail before runtime"),
      }), 2, `${commandName} ${invalidStateFile}`);
      assert.match(output.stderr, /requires a fully qualified absolute path/u, `${commandName} ${invalidStateFile}`);
    }
  }
});

test("bare help remains a legal positional or option value", async () => {
  const directCalls = [];
  const directOutput = createOutput();
  assert.equal(await runFigmaCommand("api:search", ["help", "--state-file", stateFile], {
    ...directOutput.dependencies,
    runCli: async (argv, dependencies) => {
      directCalls.push({ argv, input: JSON.parse(await dependencies.io.readStdin()) });
      return 0;
    },
  }), 0);
  assert.deepEqual(directCalls, [{
    argv: ["lookup", "--input", "-", "--session-file", stateFile],
    input: { kind: "api", symbol: "help" },
  }]);
  assert.equal(directOutput.stdout, "");

  const jsonCalls = [];
  const jsonOutput = createOutput();
  assert.equal(await runFigmaCommand("eval", ["--input", "help", "--state-file", stateFile], {
    ...jsonOutput.dependencies,
    runCli: async (argv) => { jsonCalls.push(argv); return 0; },
  }), 0);
  assert.deepEqual(jsonCalls, [["eval", "--input", "help", "--session-file", stateFile]]);
  assert.equal(jsonOutput.stdout, "");
});

test("root, family, direct, and JSON help remain locally formatted", async () => {
  const root = createOutput();
  assert.equal(await runFigmaCommandCli(["--help"], root.dependencies), 0);
  assert.equal(root.stdout, formatRootHelp());
  assert.match(root.stdout, /^# Figma command CLI help/u);
  assert.match(root.stdout, /^- `guidance`$/mu);
  assert.match(root.stdout, /^- `task:prepare`$/mu);
  assert.doesNotMatch(root.stdout, /task:run|run-task-plan/u);

  const family = createOutput();
  assert.equal(await runFigmaCommand("docs", [], family.dependencies), 0);
  assert.match(family.stdout, /^# figma docs help/u);
  assert.match(family.stdout, /figma:docs:catalog/u);
  assert.match(family.stdout, /figma:docs:search/u);

  const direct = createOutput();
  assert.equal(await runFigmaCommand("guidance", ["--help"], direct.dependencies), 0);
  assert.match(direct.stdout, /--card-limit <n>/u);
  assert.doesNotMatch(direct.stdout, /--mode|card mode|catalog mode/iu);
  assert.match(direct.stdout, /--state-file <path>.*Required\./u);
  assert.match(direct.stdout, /--max-inline-bytes <bytes>/u);
  assert.match(direct.stdout, /<query>.*Required\./u);
  assert.match(direct.stdout, /--workflow <design-implementation-context\|motion-implementation>.*Default: unset\./u);
  assert.match(direct.stdout, /--card-limit <n>.*Range: 1 to 8\./u);
  assert.match(direct.stdout, /--max-inline-bytes <bytes>.*Default: 4096\..*Range: 0 to 10000\./u);

  const json = createOutput();
  assert.equal(await runFigmaCommand("capture", ["-h"], json.dependencies), 0);
  assert.match(json.stdout, /## Input JSON Schema/u);
  assert.match(json.stdout, /"target"/u);
  assert.match(json.stdout, /"required": \[\s*"target"/u);
  assert.doesNotMatch(json.stdout, /figma:raw|capture-node|get_screenshot|figma_workspace_/u);
  assert.match(json.stdout, /--input <json-file\|->.*Required\./u);
  assert.match(json.stdout, /--state-file <path>.*Required\./u);
  assert.match(json.stdout, /--max-inline-bytes <bytes>.*Default: input inlineResultLimit when present, otherwise 4096\./u);

  const inspect = createOutput();
  assert.equal(await runFigmaCommand("inspect", ["--help"], inspect.dependencies), 0);
  assert.match(inspect.stdout, /--mode <inspect\|style>/u);
  assert.doesNotMatch(inspect.stdout, /--handle|validate|\$handle|handles/u);

  const sessionsRead = createOutput();
  assert.equal(await runFigmaCommand("sessions:read", ["--help"], sessionsRead.dependencies), 0);
  assert.match(sessionsRead.stdout, /--with-history/u);
  assert.doesNotMatch(sessionsRead.stdout, /--with-handles|handles|\$handle/u);

  for (const commandName of ["open", "eval", "script:run"]) {
    const output = createOutput();
    assert.equal(await runFigmaCommand(commandName, ["--help"], output.dependencies), 0);
    assert.doesNotMatch(output.stdout, /allowDangerousOperations|allow-dangerous-operations|handleUpdates|handle-updates|handles|"strict"/u, commandName);
  }

  for (const commandName of Object.keys(FIGMA_JSON_COMMANDS)) {
    const output = createOutput();
    assert.equal(await runFigmaCommand(commandName, ["--help"], output.dependencies), 0);
    const schemaSource = output.stdout.match(/## Input JSON Schema\n```json\n([\s\S]*?)\n```/u)?.[1];
    assert.notEqual(schemaSource, undefined, commandName);
    const schema = JSON.parse(schemaSource);
    assert.equal(schema.type, "object", commandName);
    assert.equal(typeof schema.properties, "object", commandName);
    assert.equal(Array.isArray(schema.required), true, commandName);
    assert.doesNotMatch(
      output.stdout,
      /figma_workspace_|figma-workspace:\/\/|run-script-file|apply-asset-manifest|download-assets|capture-node|prepare-task|call-upstream-tool|use_figma/u,
      commandName,
    );
  }

  const docsSearch = createOutput();
  assert.equal(await runFigmaCommand("docs:search", ["--help"], docsSearch.dependencies), 0);
  assert.match(docsSearch.stdout, /--scope <auto\|active\|conditional\|router\|examples\|all>/u);
  assert.match(docsSearch.stdout, /--scope .*Default: auto\..*Allowed: auto, active, conditional, router, examples, all\./u);
  assert.match(docsSearch.stdout, /--surface <design\|figjam\|slides>/u);
  assert.match(docsSearch.stdout, /--task-family <code-connect\|create-file\|design-to-code/u);

  const docsCatalog = createOutput();
  assert.equal(await runFigmaCommand("docs:catalog", ["--help"], docsCatalog.dependencies), 0);
  assert.match(docsCatalog.stdout, /--classification <active\|conditional\|router\|examples>/u);
  assert.match(docsCatalog.stdout, /--limit <n>.*Range: 1 to 100\./u);

  const docsRead = createOutput();
  assert.equal(await runFigmaCommand("docs:read", ["--help"], docsRead.dependencies), 0);
  assert.match(docsRead.stdout, /<doc-id>.*Required\./u);
  assert.match(docsRead.stdout, /project:workflow/u);

  const apiSearch = createOutput();
  assert.equal(await runFigmaCommand("api:search", ["--help"], apiSearch.dependencies), 0);
  assert.doesNotMatch(apiSearch.stdout, /--scope/u);
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
