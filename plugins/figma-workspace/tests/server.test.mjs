import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import test from "node:test";
import {
  FIGMA_COMMAND_FAMILIES,
  FIGMA_DIRECT_COMMANDS,
  FIGMA_JSON_COMMANDS,
  runFigmaCommandCli as runFigmaCli,
} from "../mcp-server/dist/cli/figma-command-runtime.js";
import {
  OAuthCache,
  OAUTH_AUTHORIZE_PATH,
  createMcpRequestHeaders,
  findCodexHomeOAuthCachePath,
  handleAuthorizationRedirect,
  copyRequestHeaders,
  copyResponseHeaders,
  createBridgeConfig,
  rewriteOAuthRequestBody,
  rewriteAuthorizationServerMetadata,
  rewriteProtectedResourceMetadata,
  rewriteResponseHeaders,
  rewriteWwwAuthenticate,
  startFigmaMcpBridge,
} from "../scripts/server.mjs";

const testStateFile = resolve(tmpdir(), "figma-workspace-server-tests-state.json");
const internalAgentFacingNamePattern = /figma_workspace_|figma-workspace:\/\/|run-script-file|apply-asset-manifest|download-assets|capture-node|prepare-task|call-upstream-tool|upstream-tools|use_figma|get_metadata|get_design_context|get_motion_context|get_variable_defs|get_libraries|search_design_system|get_screenshot/u;

test("createBridgeConfig applies defaults and normalizes path", () => {
  const config = createBridgeConfig({ port: 19001, path: "mcp" });

  assert.equal(config.host, "127.0.0.1");
  assert.equal(config.port, 19001);
  assert.equal(config.path, "/mcp");
  assert.equal(config.target, "https://mcp.figma.com/mcp");
  assert.equal(config.oauthCacheEnabled, true);
});

test("plugin manifest exposes the CLI skill without a local MCP server", async () => {
  const manifest = JSON.parse(
    await readFile(new URL("../.codex-plugin/plugin.json", import.meta.url), "utf8"),
  );
  const packageJson = JSON.parse(
    await readFile(new URL("../package.json", import.meta.url), "utf8"),
  );

  assert.equal(manifest.mcpServers, undefined);
  const specialEntrypoints = {
    figma: "figma.mjs",
    "figma:help": "figma-help.mjs",
    "figma:raw": "figma-raw.mjs",
    "figma:raw:help": "figma-raw-help.mjs",
  };
  const typedNamespaces = new Set([
    ...Object.keys(FIGMA_DIRECT_COMMANDS),
    ...Object.keys(FIGMA_JSON_COMMANDS),
  ]);
  const familyNamespaces = new Set(Object.keys(FIGMA_COMMAND_FAMILIES));
  const expectedEntrypoints = {
    ...specialEntrypoints,
    ...Object.fromEntries(
      [...familyNamespaces, ...typedNamespaces].map((namespace) => [
        `figma:${namespace}`,
        `figma-${namespace.replaceAll(":", "-")}.mjs`,
      ]),
    ),
  };
  const actualFigmaScripts = Object.fromEntries(
    Object.entries(packageJson.scripts).filter(([scriptName]) => (
      scriptName === "figma" || scriptName.startsWith("figma:")
    )),
  );

  assert.deepEqual(
    Object.keys(actualFigmaScripts).sort(),
    Object.keys(expectedEntrypoints).sort(),
    "package figma scripts must exactly match the exported typed and family namespaces",
  );
  assert.equal(Object.keys(actualFigmaScripts).length, 34);
  const scriptEntrypoints = [];
  for (const [scriptName, entrypoint] of Object.entries(expectedEntrypoints)) {
    const expected = `node scripts/commands/${entrypoint}`;
    assert.equal(packageJson.scripts[scriptName], expected);
    scriptEntrypoints.push(expected);
    const source = await readFile(new URL(`../scripts/commands/${entrypoint}`, import.meta.url), "utf8");
    if (!["figma:raw", "figma:raw:help"].includes(scriptName)) {
      assert.match(source, /dist\/cli\/figma-command-runtime\.js/u, scriptName);
    }
    if (typedNamespaces.has(scriptName.slice("figma:".length))) {
      const commandName = scriptName.slice("figma:".length);
      assert.match(source, /dist\/cli\/figma-command-runtime\.js/u, scriptName);
      assert.match(source, new RegExp(`runFigmaCommand\\("${commandName}"`, "u"), scriptName);
    }
  }
  assert.equal(new Set(scriptEntrypoints).size, scriptEntrypoints.length, "each public command owns one executable entrypoint");
});

test("direct commands map positional options into canonical runtime input", async () => {
  const invocations = [];
  const output = createCommandOutput();
  const runCli = async (args, dependencies) => {
    invocations.push({ args, input: JSON.parse(await dependencies.io.readStdin()) });
    return 0;
  };

  assert.equal(await runFigmaCli([
    "api:search", "createFrame", "--limit", "2", "--state-file", testStateFile, "--max-inline-bytes", "10000",
  ], { ...output.dependencies, runCli }), 0);
  assert.deepEqual(invocations[0], {
    args: ["lookup", "--input", "-", "--session-file", testStateFile, "--inline-result-limit", "10000"],
    input: { kind: "api", symbol: "createFrame", maxResults: 2 },
  });

  assert.equal(await runFigmaCli([
    "sessions:read", "default", "--with-history", "--state-file", testStateFile,
  ], { ...output.dependencies, runCli }), 0);
  assert.deepEqual(invocations[1], {
    args: ["sessions", "--input", "-", "--session-file", testStateFile],
    input: { sessionId: "default", includeHistory: true },
  });

  assert.equal(await runFigmaCli([
    "design-context", "--file", "https://www.figma.com/design/file-key/Test?node-id=1-2",
    "--force-code", "--no-code-connect", "--session-id", "design-review", "--state-file", testStateFile,
  ], { ...output.dependencies, runCli }), 0);
  assert.deepEqual(invocations[2], {
    args: ["get-design-context", "--input", "-", "--session-file", testStateFile],
    input: {
      file: "https://www.figma.com/design/file-key/Test?node-id=1-2",
      forceCode: true,
      disableCodeConnect: true,
      sessionId: "design-review",
    },
  });

  assert.equal(await runFigmaCli([
    "design-system", "button", "--no-components", "--library", "one", "--library", "two", "--state-file", testStateFile,
  ], { ...output.dependencies, runCli }), 0);
  assert.deepEqual(invocations[3], {
    args: ["search-design-system", "--input", "-", "--session-file", testStateFile],
    input: {
      query: "button",
      includeComponents: false,
      includeLibraryKeys: ["one", "two"],
    },
  });

  assert.equal(await runFigmaCli([
    "api:search", "--snippet-lines", "4", "--state-file", testStateFile, "--", "--help",
  ], { ...output.dependencies, runCli }), 0);
  assert.deepEqual(invocations[4], {
    args: ["lookup", "--input", "-", "--session-file", testStateFile],
    input: { kind: "api", symbol: "--help", maxSnippetLines: 4 },
  });
});

test("every command accepts -h and --help before runtime validation", async () => {
  const commandNames = [
    "guidance", "docs:list", "docs:catalog", "docs:read", "docs:search", "api:search", "doctor",
    "sessions:list", "sessions:read", "upstream:list", "upstream:read", "inspect",
    "metadata", "design-context", "motion-context", "variables", "design-system", "libraries",
    "open", "eval", "script:run", "assets:apply", "assets:download", "capture",
    "task:prepare", "upstream:call",
  ];
  for (const commandName of commandNames) {
    for (const helpToken of ["-h", "--help"]) {
      const output = createCommandOutput();
      const exitCode = await runFigmaCli([commandName, helpToken], {
        ...output.dependencies,
        runCli: async () => assert.fail(`figma ${commandName} help must not enter runtime`),
      });
      assert.equal(exitCode, 0, `${commandName} ${helpToken}`);
      assert.match(output.stdout(), new RegExp(`^# figma ${commandName} help$`, "mu"));
      assert.equal(output.stderr(), "");
    }
  }
});

test("command help exposes only optimized command-relevant option names", async () => {
  const commandNames = [
    "guidance", "docs:list", "docs:catalog", "docs:read", "docs:search", "api:search", "doctor",
    "sessions:list", "sessions:read", "upstream:list", "upstream:read", "inspect",
    "metadata", "design-context", "motion-context", "variables", "design-system", "libraries",
    "open", "eval", "script:run", "assets:apply", "assets:download", "capture",
    "task:prepare", "upstream:call",
  ];
  const sessionIdCommands = new Set([
    "inspect", "metadata", "design-context", "motion-context", "variables", "design-system", "libraries",
  ]);
  for (const commandName of commandNames) {
    const output = createCommandOutput();
    assert.equal(await runFigmaCli([commandName, "-h"], output.dependencies), 0);
    const help = output.stdout();
    assert.doesNotMatch(help, internalAgentFacingNamePattern, commandName);
    assert.doesNotMatch(help, /--session-file|--inline-result-limit|--max-results|--max-snippet-lines|--max-cards|--workspace-dir|--library-key/u, commandName);
    assert.equal(help.includes("--state-file"), true, `${commandName} state file`);
    assert.equal(help.includes("--session-id"), sessionIdCommands.has(commandName), `${commandName} session id`);
    assert.match(help, /--max-inline-bytes/u, commandName);
    if (Object.hasOwn(FIGMA_DIRECT_COMMANDS, commandName)) {
      assert.match(help, /## Examples[\s\S]*--state-file C:\/work\/project\/\.figma-workspace\/state\.json/u, commandName);
    }
  }
});

test("optimized help declares positional and option omitted states, repeatability, and ranges", async () => {
  const guidance = createCommandOutput();
  assert.equal(await runFigmaCli(["guidance", "--help"], guidance.dependencies), 0);
  assert.match(guidance.stdout(), /<query>.*Required\./u);
  assert.match(guidance.stdout(), /--state-file <path>.*Required\./u);
  assert.match(guidance.stdout(), /--workflow <design-implementation-context\|motion-implementation>.*Default: unset\./u);
  assert.match(guidance.stdout(), /--card-limit <n>.*Range: 1 to 8\./u);
  assert.match(guidance.stdout(), /--max-inline-bytes <bytes>.*Default: 4096\..*Range: 0 to 10000\./u);

  const metadata = createCommandOutput();
  assert.equal(await runFigmaCli(["metadata", "--help"], metadata.dependencies), 0);
  assert.match(metadata.stdout(), /<target>.*Default: unset\./u);

  const inspect = createCommandOutput();
  assert.equal(await runFigmaCli(["inspect", "--help"], inspect.dependencies), 0);
  assert.match(inspect.stdout(), /--mode <inspect\|style>/u);
  assert.doesNotMatch(inspect.stdout(), /--handle|validate|\$handle|handles/u);

  const sessionsRead = createCommandOutput();
  assert.equal(await runFigmaCli(["sessions:read", "--help"], sessionsRead.dependencies), 0);
  assert.match(sessionsRead.stdout(), /--with-history/u);
  assert.doesNotMatch(sessionsRead.stdout(), /--with-handles|handles|\$handle/u);

  const json = createCommandOutput();
  assert.equal(await runFigmaCli(["eval", "--help"], json.dependencies), 0);
  assert.match(json.stdout(), /--input <json-file\|->.*Required\./u);
  assert.match(json.stdout(), /--state-file <path>.*Required\./u);
  assert.match(json.stdout(), /--max-inline-bytes <bytes>.*Default: input inlineResultLimit when present, otherwise 4096\./u);
  assert.match(json.stdout(), /## Input JSON Schema/u);
  assert.doesNotMatch(json.stdout(), /figma:raw|figma_workspace_|run-script-file|use_figma/u);

  for (const commandName of Object.keys(FIGMA_JSON_COMMANDS)) {
    const output = createCommandOutput();
    assert.equal(await runFigmaCli([commandName, "--help"], output.dependencies), 0);
    const help = output.stdout();
    assert.match(help, /^## Input JSON Schema$/mu, commandName);
    const schemaSource = help.match(/## Input JSON Schema\n```json\n([\s\S]*?)\n```/u)?.[1];
    assert.notEqual(schemaSource, undefined, commandName);
    const schema = JSON.parse(schemaSource);
    assert.equal(schema.type, "object", commandName);
    assert.equal(typeof schema.properties, "object", commandName);
    assert.equal(Array.isArray(schema.required), true, commandName);
    assert.doesNotMatch(help, internalAgentFacingNamePattern, commandName);
  }
});

test("every command family accepts -h and --help", async () => {
  for (const family of ["docs", "api", "sessions", "upstream"]) {
    for (const helpToken of ["-h", "--help"]) {
      const output = createCommandOutput();
      const exitCode = await runFigmaCli([family, helpToken], output.dependencies);
      assert.equal(exitCode, 0, `${family} ${helpToken}`);
      assert.match(output.stdout(), new RegExp(`^# figma ${family} help$`, "mu"));
      assert.equal(output.stderr(), "");
    }
  }
});

test("root command help accepts -h and --help", async () => {
  for (const helpToken of ["-h", "--help"]) {
    const output = createCommandOutput();
    assert.equal(await runFigmaCli([helpToken], output.dependencies), 0);
    assert.match(output.stdout(), /^# Figma command CLI help$/mu);
    assert.match(output.stdout(), /npm --silent run figma/u);
    assert.doesNotMatch(output.stdout(), /npm run figma/u);
    assert.equal(output.stderr(), "");
  }
});

test("command usage failures use stderr, exit 2, and command help", async () => {
  const output = createCommandOutput();
  const exitCode = await runFigmaCli(["api:search"], {
    ...output.dependencies,
    runCli: async () => assert.fail("invalid command input must not enter runtime"),
  });
  assert.equal(exitCode, 2);
  assert.equal(output.stdout(), "");
  assert.match(output.stderr(), /Missing required <symbol>/u);
  assert.match(output.stderr(), /# figma api:search help/u);
});

test("direct command validation rejects ambiguous or malformed options without runtime calls", async () => {
  const cases = [
    [["api:search", "createFrame", "--unknown"], /Unknown option/u],
    [["api:search", "createFrame", "--limit", "one"], /requires an integer/u],
    [["api:search", "createFrame", "--limit"], /requires <n>/u],
    [["api:search", "createFrame", "--limit", "11"], /must be at most 10/u],
    [["api:search", "createFrame", "--max-inline-bytes", "10001"], /must be at most 10000/u],
    [["api:search", "createFrame", "--max-inline-bytes", "1", "--max-inline-bytes", "2"], /Duplicate option/u],
    [["api:search", "createFrame", "--state-file", "state.json"], /requires a fully qualified absolute path/u],
    [["docs:search", "session", "--snippet-lines", "0"], /must be at least 1/u],
    [["guidance", "text", "--surface", "canvas"], /must be one of/u],
    [["guidance", "text.font", "--mode", "card"], /Unknown option/u],
    [["guidance", "text", "--card-limit", "9"], /must be at most 8/u],
    [["inspect", "123:456", "--depth", "0"], /must be at least 1/u],
    [["inspect", "$hero"], /\$selection|\$currentPage|node id|node URL|fileKey|target/u],
    [["libraries", "--offset", "-1"], /must be at least 0/u],
    [["sessions:read", "default", "--with-handles"], /Unknown option/u],
    [["inspect", "123:456", "--handle", "hero"], /Unknown option/u],
    [["inspect", "123:456", "--mode", "validate"], /must be one of: inspect, style/u],
    [["eval", "--input", "eval.json", "--mode", "write"], /Unknown option/u],
    [["eval", "--input", "eval.json", "--allow-dangerous-operations"], /Unknown option/u],
    [["eval", "--input", "eval.json", "--handle-updates", "replace"], /Unknown option/u],
    [["script:run", "--input", "script.json", "--allow-dangerous-operations"], /Unknown option/u],
    [["script:run", "--input", "script.json", "--strict"], /Unknown option/u],
    [["task:run", "--input", "task.json"], /Unknown (?:Figma )?command/u],
    [["doctor", "unexpected"], /Unexpected argument/u],
    [["api:search", "two", "arguments"], /accepts one <symbol>/u],
    [["api:search", "--", "one", "two"], /accepts one <symbol>/u],
  ];
  for (const [argv, expected] of cases) {
    const output = createCommandOutput();
    const commandArgv = argv.includes("--state-file")
      ? argv
      : [argv[0], "--state-file", testStateFile, ...argv.slice(1)];
    const exitCode = await runFigmaCli(commandArgv, {
      ...output.dependencies,
      runCli: async () => assert.fail(`${commandArgv.join(" ")} must not enter runtime`),
    });
    assert.equal(exitCode, 2, commandArgv.join(" "));
    assert.equal(output.stdout(), "");
    assert.match(output.stderr(), expected);
  }
});

test("integer options use strict decimal grammar and safe bounded values before runtime", async () => {
  const invalidValues = ["", "+1", "1.0", "1e3", "9007199254740992", "-9007199254740992"];
  for (const value of invalidValues) {
    const output = createCommandOutput();
    assert.equal(await runFigmaCli(["doctor", "--state-file", testStateFile, "--max-inline-bytes", value], {
      ...output.dependencies,
      readFile: async () => assert.fail("invalid input must fail before file I/O"),
      runCli: async () => assert.fail("invalid input must fail before runtime"),
    }), 2, value);
    assert.match(output.stderr(), /requires an integer|requires a safe integer/u, value);
  }

  const invocations = [];
  for (const value of ["0", "10000"]) {
    assert.equal(await runFigmaCli(["doctor", "--state-file", testStateFile, "--max-inline-bytes", value], {
      runCli: async (args) => { invocations.push(args); return 0; },
    }), 0);
  }
  assert.deepEqual(invocations, [
    ["doctor", "--input", "-", "--session-file", testStateFile, "--inline-result-limit", "0"],
    ["doctor", "--input", "-", "--session-file", testStateFile, "--inline-result-limit", "10000"],
  ]);
});

test("JSON commands translate optimized options into canonical runtime options", async () => {
  const invocations = [];
  const exitCode = await runFigmaCli([
    "eval", "--input", "eval.json", "--state-file", testStateFile,
    "--max-inline-bytes", "0",
  ], {
    runCli: async (args) => {
      invocations.push(args);
      return 0;
    },
  });

  assert.equal(exitCode, 0);
  assert.deepEqual(invocations, [[
    "eval", "--input", "eval.json", "--session-file", testStateFile,
    "--inline-result-limit", "0",
  ]]);
});

test("JSON commands require input only when their command needs it", async () => {
  const output = createCommandOutput();
  assert.equal(await runFigmaCli(["eval"], {
    ...output.dependencies,
    runCli: async () => assert.fail("eval without input must not enter runtime"),
  }), 2);
  assert.match(output.stderr(), /requires --input/u);

  const invocations = [];
  assert.equal(await runFigmaCli(["open", "--state-file", testStateFile], {
    runCli: async (args) => {
      invocations.push(args);
      return 0;
    },
  }), 0);
  assert.deepEqual(invocations, [["open", "--session-file", testStateFile]]);
});

test("JSON commands reject transport-level option names", async () => {
  for (const legacyOption of ["--session-file", "--inline-result-limit"]) {
    const output = createCommandOutput();
    assert.equal(await runFigmaCli(["eval", "--input", "eval.json", legacyOption, "value"], {
      ...output.dependencies,
      runCli: async () => assert.fail(`${legacyOption} must not enter runtime`),
    }), 2);
    assert.match(output.stderr(), /Unknown option/u);
    assert.match(output.stderr(), /# figma eval help/u);
  }

  for (const argv of [["eval", "--input", "eval.json", "--"], ["eval", "eval.json"]]) {
    const output = createCommandOutput();
    assert.equal(await runFigmaCli(argv, {
      ...output.dependencies,
      runCli: async () => assert.fail("JSON commands remain option-only"),
    }), 2);
    assert.match(output.stderr(), /Unknown option/u);
  }

  for (const [argv, expected] of [
    [["eval", "--input"], /requires <json-file\|->/u],
    [["eval", "--input", "one.json", "--input", "two.json"], /Duplicate option/u],
  ]) {
    const output = createCommandOutput();
    assert.equal(await runFigmaCli(argv, {
      ...output.dependencies,
      runCli: async () => assert.fail("invalid JSON options must fail before runtime"),
    }), 2);
    assert.match(output.stderr(), expected);
  }
});

test("JSON commands validate optimized output limits before runtime", async () => {
  for (const value of ["many", "-1", "10001"]) {
    const output = createCommandOutput();
    assert.equal(await runFigmaCli(["eval", "--input", "eval.json", "--max-inline-bytes", value], {
      ...output.dependencies,
      runCli: async () => assert.fail(`${value} must not enter runtime`),
    }), 2);
    assert.match(output.stderr(), /requires an integer|must be at least 0|must be at most 10000/u);
    assert.match(output.stderr(), /# figma eval help/u);
  }
});

test("plugin-root npm script starts the bundled CLI", () => {
  const result = runNpm(["--silent", "run", "figma:help"], {
    cwd: fileURLToPath(new URL("../", import.meta.url)),
    encoding: "utf8",
  });

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /^# Figma command CLI help$/mu);
});

test("all public figma npm scripts expose banner-free subprocess help", async () => {
  const packageJson = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
  const figmaScripts = Object.keys(packageJson.scripts).filter((scriptName) => (
    scriptName === "figma" || scriptName.startsWith("figma:")
  ));

  assert.equal(figmaScripts.length, 34);
  for (const scriptName of figmaScripts) {
    const result = runNpm(["--silent", "run", scriptName, "--", "--help"], {
      cwd: fileURLToPath(new URL("../", import.meta.url)),
      encoding: "utf8",
    });

    assert.equal(result.status, 0, `${scriptName}\n${result.stderr}`);
    assert.match(result.stdout, /^# /u, scriptName);
    assert.doesNotMatch(result.stdout, /^>/mu, scriptName);
    assert.equal(result.stderr, "", scriptName);
  }
});

test("root figma CLI dispatches the same canonical command", () => {
  const result = runNpm(["--silent", "run", "figma", "--", "api:search", "-h"], {
    cwd: fileURLToPath(new URL("../", import.meta.url)),
    encoding: "utf8",
  });

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /^# figma api:search help$/mu);
  assert.doesNotMatch(result.stdout, /^>/mu);
  assert.equal(result.stderr, "");
});

test("canonical and independent npm commands accept stdin and file input after npm option forwarding", async () => {
  const tempDir = await mkdtemp(join(tmpdir(), "figma-workspace-public-stdin-"));
  try {
    const pluginRoot = fileURLToPath(new URL("../", import.meta.url));
    const inputFile = resolve(tempDir, "open-input.json");
    await writeFile(inputFile, '{"connect":false}', "utf8");
    const cases = ["figma", "figma:open"];
    for (const [index, command] of cases.entries()) {
      const stateFile = resolve(tempDir, `state-${index}.json`);
      const args = command === "figma"
        ? ["--silent", "run", command, "--", "open", "--input", "-", "--state-file", stateFile]
        : ["--silent", "run", command, "--", "--input", "-", "--state-file", stateFile];
      const result = runNpm(args, {
        cwd: pluginRoot,
        encoding: "utf8",
        input: '{"connect":false}',
      });
      assert.equal(result.status, 0, `${command}\n${result.stderr}`);
      assert.match(result.stdout, /^# figma-workspace open$/mu);
      assert.equal(result.stderr, "");

      const fileStateFile = resolve(tempDir, `file-state-${index}.json`);
      const fileArgs = command === "figma"
        ? ["--silent", "run", command, "--", "open", "--input", inputFile, "--state-file", fileStateFile]
        : ["--silent", "run", command, "--", "--input", inputFile, "--state-file", fileStateFile];
      const fileResult = runNpm(fileArgs, { cwd: pluginRoot, encoding: "utf8" });
      assert.equal(fileResult.status, 0, `${command} file input\n${fileResult.stderr}`);
      assert.match(fileResult.stdout, /^# figma-workspace open$/mu);
      assert.equal(fileResult.stderr, "");

      const duplicateArgs = command === "figma"
        ? ["--silent", "run", command, "--", "open", "--input", "-", "--input", "-", "--state-file", stateFile]
        : ["--silent", "run", command, "--", "--input", "-", "--input", "-", "--state-file", stateFile];
      const duplicate = runNpm(duplicateArgs, {
        cwd: pluginRoot,
        encoding: "utf8",
        input: '{"connect":false}',
      });
      assert.equal(duplicate.status, 2, `${command} duplicate input\n${duplicate.stderr}`);
      assert.equal(duplicate.stdout, "");
      assert.match(duplicate.stderr, /Duplicate input|input may be specified only once|Duplicate option.*--input/iu);
    }
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("public JSON input validation returns npm usage exit 2", async () => {
  const tempDir = await mkdtemp(join(tmpdir(), "figma-workspace-public-usage-"));
  try {
    const result = runNpm([
      "--silent", "run", "figma:script:run", "--",
      "--input", "-",
      "--state-file", resolve(tempDir, "state.json"),
    ], {
      cwd: fileURLToPath(new URL("../", import.meta.url)),
      encoding: "utf8",
      input: JSON.stringify({ scriptPath: resolve(tempDir, "task.figma.ts"), strict: true }),
    });
    assert.equal(result.status, 2, result.stderr);
    assert.equal(result.stdout, "");
    assert.match(result.stderr, /strict.*removed/iu);
    assert.doesNotMatch(result.stderr, internalAgentFacingNamePattern);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("figma:raw keeps the transport schema escape hatch", () => {
  const result = runNpm(["--silent", "run", "figma:raw", "--", "lookup", "--help"], {
    cwd: fileURLToPath(new URL("../", import.meta.url)),
    encoding: "utf8",
  });

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /^# figma-workspace lookup help$/mu);
  assert.equal(result.stderr, "");
});

test("figma:raw command help takes precedence over invalid or I/O-bound options", () => {
  const cases = [
    ["lookup", "--input", "definitely-missing.json", "--help"],
    ["lookup", "--unknown", "value", "-h"],
    ["lookup", "--input", "--help"],
  ];

  for (const args of cases) {
    const result = runNpm(["--silent", "run", "figma:raw", "--", ...args], {
      cwd: fileURLToPath(new URL("../", import.meta.url)),
      encoding: "utf8",
    });

    assert.equal(result.status, 0, `${args.join(" ")}\n${result.stderr}`);
    assert.match(result.stdout, /^# figma-workspace lookup help$/mu);
    assert.equal(result.stderr, "");
  }
});

test("npm package includes runtime surfaces and excludes local state and source tests", async () => {
  const result = runNpm(["pack", "--dry-run", "--json"], {
    cwd: fileURLToPath(new URL("../", import.meta.url)),
    encoding: "utf8",
  });

  assert.equal(result.status, 0, result.stderr);
  const report = JSON.parse(result.stdout);
  assert.equal(report.length, 1);
  const paths = report[0].files.map(({ path }) => path.replaceAll("\\", "/"));
  const corpusManifest = JSON.parse(await readFile(
    new URL("../skills/figma-workspace/references/canonical-corpus/manifest.json", import.meta.url),
    "utf8",
  ));
  for (const requiredPath of [
    ".codex-plugin/plugin.json",
    "mcp-server/dist/cli/figma-command-runtime.js",
    "scripts/commands/figma.mjs",
    "skills/figma-workspace/SKILL.md",
    "mcp-server/dist/skills/figma-workspace/references/figma-workspace-overview.md",
    "mcp-server/dist/skills/figma-workspace/references/figma-workspace-workflow.md",
    "mcp-server/dist/skills/figma-workspace/references/figma-workspace-guidance-and-lookup.md",
    "mcp-server/dist/skills/figma-workspace/references/figma-workspace-safety.md",
    "mcp-server/dist/skills/figma-workspace/references/figma-workspace-diagnostics.md",
    "mcp-server/dist/skills/figma-workspace/references/figma-workspace-sessions.md",
    "mcp-server/dist/skills/figma-workspace/references/figma-workspace-upstream-tools.md",
    "skills/figma-workspace/references/canonical-corpus/manifest.json",
    "skills/figma-workspace/references/canonical-corpus/routes.json",
    `skills/figma-workspace/references/canonical-corpus/${corpusManifest.corpus.file}`,
    "mcp-server/dist/skills/figma-workspace/references/canonical-corpus/manifest.json",
    "mcp-server/dist/skills/figma-workspace/references/canonical-corpus/routes.json",
    `mcp-server/dist/skills/figma-workspace/references/canonical-corpus/${corpusManifest.corpus.file}`,
  ]) {
    assert.ok(paths.includes(requiredPath), `packed files must include ${requiredPath}`);
  }
  const packageJson = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
  for (const [scriptName, command] of Object.entries(packageJson.scripts)) {
    const match = /^(?:node|python) ((?!-)[^ ]+)/u.exec(command);
    if (match !== null) {
      assert.ok(paths.includes(match[1]), `packed files must include the ${scriptName} target ${match[1]}`);
    }
  }
  assert.equal(paths.some((path) => path.split("/").includes(".figma-workspace")), false);
  assert.equal(paths.some((path) => path.includes("/src/") || path.includes("/tests/")), false);
  assert.equal(paths.some((path) => /canonical-corpus\/(?:policy|docs)\//u.test(path)), false);
  assert.equal(paths.some((path) => path.includes("dev/")), false);
  assert.deepEqual(
    paths.filter((path) => path === "SKILL.md" || path.endsWith("/SKILL.md")),
    ["skills/figma-workspace/SKILL.md"],
  );
  assert.deepEqual(
    paths.filter((path) => /canonical-corpus\/corpus-[a-f0-9]{64}\.jsonl$/u.test(path)).sort(),
    [
      `mcp-server/dist/skills/figma-workspace/references/canonical-corpus/${corpusManifest.corpus.file}`,
      `skills/figma-workspace/references/canonical-corpus/${corpusManifest.corpus.file}`,
    ],
  );
});

test("generated project docs are visible to Git and packed", () => {
  const pluginRoot = fileURLToPath(new URL("../", import.meta.url));
  const docs = [
    "figma-workspace-overview.md",
    "figma-workspace-workflow.md",
    "figma-workspace-guidance-and-lookup.md",
    "figma-workspace-safety.md",
    "figma-workspace-diagnostics.md",
    "figma-workspace-sessions.md",
    "figma-workspace-upstream-tools.md",
  ].map((file) => `plugins/figma-workspace/mcp-server/dist/skills/figma-workspace/references/${file}`);
  const result = spawnSync("git", ["ls-files", "--cached", "--others", "--exclude-standard", "--", ...docs], {
    cwd: resolve(pluginRoot, "../.."),
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(
    result.stdout.trim().split(/\r?\n/u).sort(),
    [...docs].sort(),
    "every generated project doc must be tracked or visible as an unignored file",
  );
});

test("packed plugin preserves Restricted Markdown stdout without npm banners", async () => {
  const tempDir = await mkdtemp(join(tmpdir(), "figma-workspace-pack-"));
  try {
    const pack = runNpm(["pack", "--json", "--pack-destination", tempDir], {
      cwd: fileURLToPath(new URL("../", import.meta.url)),
      encoding: "utf8",
    });
    assert.equal(pack.status, 0, pack.stderr);
    const [{ filename }] = JSON.parse(pack.stdout);
    const extractDir = join(tempDir, "extract");
    await mkdir(extractDir);
    const extract = spawnSync("tar", ["-xf", join(tempDir, filename), "-C", extractDir], {
      encoding: "utf8",
    });
    assert.equal(extract.status, 0, extract.stderr);

    const result = runNpm(["--silent", "run", "figma:help"], {
      cwd: join(extractDir, "package"),
      encoding: "utf8",
    });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /^# Figma command CLI help$/mu);
    assert.doesNotMatch(result.stdout, /^>/mu);
    assert.equal(result.stderr, "");

    const docsResult = runNpm(
      ["--silent", "run", "figma:docs:read", "--", "project:overview", "--state-file", join(tempDir, "state.json")],
      { cwd: join(extractDir, "package"), encoding: "utf8" },
    );
    assert.equal(docsResult.status, 0, docsResult.stderr);
    assert.match(docsResult.stdout, /^# figma-workspace docs$/mu);
    assert.match(docsResult.stdout, /^Status: succeeded$/mu);
    assert.match(docsResult.stdout, /# Figma Workspace Overview/u);
    assert.doesNotMatch(docsResult.stdout, /^>/mu);
    assert.equal(docsResult.stderr, "");

    const catalogResult = runNpm(
      ["--silent", "run", "figma:docs:catalog", "--", "--task-family", "code-connect", "--state-file", join(tempDir, "state.json")],
      { cwd: join(extractDir, "package"), encoding: "utf8" },
    );
    assert.equal(catalogResult.status, 0, catalogResult.stderr);
    assert.match(catalogResult.stdout, /canonical:figma-code-connect\/references\/api\.md/u);
    assert.equal(catalogResult.stderr, "");

    const searchResult = runNpm(
      ["--silent", "run", "figma:docs:search", "--", "code connect advanced patterns", "--task-family", "code-connect", "--state-file", join(tempDir, "state.json")],
      { cwd: join(extractDir, "package"), encoding: "utf8" },
    );
    assert.equal(searchResult.status, 0, searchResult.stderr);
    assert.match(searchResult.stdout, /Task Family: code-connect/u);
    assert.equal(searchResult.stderr, "");

    const canonicalReadResult = runNpm(
      ["--silent", "run", "figma:docs:read", "--", "canonical:figma-code-connect/references/api.md", "--state-file", join(tempDir, "state.json")],
      { cwd: join(extractDir, "package"), encoding: "utf8" },
    );
    assert.equal(canonicalReadResult.status, 0, canonicalReadResult.stderr);
    const canonicalReadPath = /^Path: (.+\.json)$/mu.exec(canonicalReadResult.stdout)?.[1];
    assert.ok(canonicalReadPath, canonicalReadResult.stdout);
    const canonicalReadSidecar = JSON.parse(await readFile(canonicalReadPath, "utf8"));
    assert.equal(canonicalReadSidecar.id, "canonical:figma-code-connect/references/api.md");
    assert.match(canonicalReadSidecar.content, /Code Connect Template API Reference/u);
    assert.equal(canonicalReadResult.stderr, "");

    const apiResult = runNpm(
      ["--silent", "run", "figma:api:search", "--", "figma.variables.createVariableCollection", "--state-file", join(tempDir, "state.json")],
      { cwd: join(extractDir, "package"), encoding: "utf8" },
    );
    assert.equal(apiResult.status, 0, apiResult.stderr);
    assert.match(apiResult.stdout, /Normalized Symbol: createVariableCollection/u);
    assert.match(apiResult.stdout, /Owner Match: true/u);
    assert.equal(apiResult.stderr, "");

    const guidanceResult = runNpm(
      ["--silent", "run", "figma:guidance", "--", "text font loadFontAsync", "--state-file", join(tempDir, "guidance-state.json")],
      { cwd: join(extractDir, "package"), encoding: "utf8" },
    );
    assert.equal(guidanceResult.status, 0, guidanceResult.stderr);
    assert.match(guidanceResult.stdout, /Task Family: design-editing/u);
    assert.match(guidanceResult.stdout, /Confidence: high/u);
    assert.equal(guidanceResult.stderr, "");

    for (const [index, command] of ["figma", "figma:task:prepare"].entries()) {
      const workspaceDir = join(tempDir, `packed-task-${index}`);
      const taskName = `packed-stdin-${index}`;
      const args = command === "figma"
        ? ["--silent", "run", command, "--", "task:prepare", "--input", "-", "--state-file", join(tempDir, `task-state-${index}.json`)]
        : ["--silent", "run", command, "--", "--input", "-", "--state-file", join(tempDir, `task-state-${index}.json`)];
      const prepared = runNpm(args, {
        cwd: join(extractDir, "package"),
        encoding: "utf8",
        input: JSON.stringify({ taskName, workspaceDir }),
      });
      assert.equal(prepared.status, 0, `${command}\n${prepared.stderr}`);
      assert.match(prepared.stdout, /^# figma-workspace prepare-task$/mu);
      assert.match(await readFile(join(workspaceDir, `${taskName}.figma.ts`), "utf8"), /figma/u);
      assert.equal(prepared.stderr, "");
    }

    const packedRuntimeUrl = pathToFileURL(join(extractDir, "package", "mcp-server", "dist", "index.js")).href;
    const packedRuntime = await import(`${packedRuntimeUrl}?packed-cross-file=${Date.now()}`);
    const packedCalls = [];
    const packedClient = packedRuntime.createFigmaWorkspaceClient({
      client: {
        async connect() {},
        async close() {},
        async listTools() {
          return { tools: [{
            name: "use_figma",
            inputSchema: {
              type: "object",
              properties: { code: { type: "string" }, fileKey: { type: "string" } },
              required: ["code", "fileKey"],
            },
          }] };
        },
        async callTool(name, args) {
          packedCalls.push([name, args]);
          return { content: [{ type: "text", text: JSON.stringify({
            ok: true,
            __figmaWorkspace: { sessionId: "packed-cross-file", captureRequests: [], knownPages: {} },
            result: { target: "22:7", mode: "inspect", summary: { id: "22:7", type: "FRAME", name: "Target" } },
          }) }] };
        },
      },
    });
    try {
      const fileA = "PackedFileAKey0123456789";
      const fileB = "PackedFileBKey0123456789";
      await packedClient.open({
        sessionId: "packed-cross-file",
        file: `https://www.figma.com/design/${fileA}/Source`,
        workspaceDir: join(tempDir, "packed-cross-file-workspace"),
        connect: false,
      });
      const inspected = await packedClient.inspect({
        sessionId: "packed-cross-file",
        target: `https://www.figma.com/design/${fileB}/Target?node-id=22-7`,
      });
      assert.equal(inspected.target, "22:7");
      assert.equal(packedCalls[0][0], "use_figma");
      assert.equal(packedCalls[0][1].fileKey, fileB);
      assert.equal(packedClient.sessions.get("packed-cross-file").fileKey, fileA);
    } finally {
      await packedClient.close();
    }
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("npm direct command script returns runtime Markdown without npm banners", async () => {
  const tempDir = await mkdtemp(join(tmpdir(), "figma-workspace-command-"));
  try {
    const result = runNpm([
      "--silent", "run", "figma:docs:read", "--", "project:overview", "--state-file", join(tempDir, "state.json"),
    ], {
      cwd: fileURLToPath(new URL("../", import.meta.url)),
      encoding: "utf8",
    });

    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /^# figma-workspace docs$/mu);
    assert.match(result.stdout, /^Status: succeeded$/mu);
    assert.doesNotMatch(result.stdout, /^>/mu);
    assert.equal(result.stderr, "");
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("representative guidance stays within the default inline budget", async () => {
  const tempDir = await mkdtemp(join(tmpdir(), "figma-workspace-guidance-budget-"));
  try {
    const result = runNpm([
      "--silent", "run", "figma:guidance", "--", "text font loadFontAsync",
      "--state-file", join(tempDir, "state.json"),
    ], {
      cwd: fileURLToPath(new URL("../", import.meta.url)),
      encoding: "utf8",
    });

    assert.equal(result.status, 0, result.stderr);
    assert.ok(Buffer.byteLength(result.stdout, "utf8") <= 4096, `guidance output was ${Buffer.byteLength(result.stdout, "utf8")} bytes`);
    assert.doesNotMatch(result.stdout, /Cli Result File/u);
    assert.equal(result.stderr, "");
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("optimized command sidecars stay under the explicit state-file owner", async () => {
  const tempDir = await mkdtemp(join(tmpdir(), "figma-workspace-sidecar-owner-"));
  try {
    const stateFile = join(tempDir, "state.json");
    const result = runNpm([
      "--silent", "run", "figma:guidance", "--", "layout", "--state-file", stateFile,
      "--max-inline-bytes", "0",
    ], {
      cwd: fileURLToPath(new URL("../", import.meta.url)),
      encoding: "utf8",
    });

    assert.equal(result.status, 0, result.stderr);
    const pathMatch = /^Path: (.+\.json)$/mu.exec(result.stdout);
    assert.ok(pathMatch, result.stdout);
    const sidecarFile = pathMatch[1];
    assert.equal(dirname(sidecarFile), join(tempDir, "results"));
    assert.equal(JSON.parse(await readFile(sidecarFile, "utf8")).ok, true);
    assert.equal(result.stderr, "");
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("skill-relative plugin root resolves to the npm package directory", () => {
  const skillFile = fileURLToPath(new URL("../skills/figma-workspace/SKILL.md", import.meta.url));
  const pluginRoot = fileURLToPath(new URL("../", import.meta.url));

  assert.equal(resolve(dirname(skillFile), "../.."), resolve(pluginRoot));
});

test("createBridgeConfig uses CODEX_HOME as the OAuth cache location", async () => {
  const dir = await mkdtemp(join(tmpdir(), "figma-workspace-codex-home-"));
  try {
    const cachePath = join(dir, ".figma-workspace-oauth.json");

    assert.equal(
      findCodexHomeOAuthCachePath({ CODEX_HOME: dir }),
      cachePath,
    );

    const previous = process.env.CODEX_HOME;
    process.env.CODEX_HOME = dir;
    try {
      const config = createBridgeConfig({ port: 19001 });
      assert.equal(config.oauthCachePath, cachePath);
    } finally {
      if (previous === undefined) {
        delete process.env.CODEX_HOME;
      } else {
        process.env.CODEX_HOME = previous;
      }
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("createBridgeConfig uses FIGMA_WORKSPACE_OAUTH_CACHE_PATH first", async () => {
  const dir = await mkdtemp(join(tmpdir(), "figma-workspace-cache-path-"));
  try {
    const cachePath = join(dir, "custom-oauth.json");
    withEnv(
      {
        FIGMA_WORKSPACE_OAUTH_CACHE_PATH: cachePath,
        CODEX_HOME: "C:/ignored-codex-home",
        USERPROFILE: "C:/ignored-userprofile",
      },
      () => {
        const config = createBridgeConfig({ port: 19001 });
        assert.equal(config.oauthCachePath, cachePath);
      },
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("findCodexHomeOAuthCachePath uses USERPROFILE .codex when CODEX_HOME is missing", async () => {
  const dir = await mkdtemp(join(tmpdir(), "figma-workspace-home-"));
  try {
    const cachePath = join(dir, ".codex", ".figma-workspace-oauth.json");

    assert.equal(findCodexHomeOAuthCachePath({ USERPROFILE: dir }), cachePath);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("resolve-oauth-cache-path.py follows bridge cache priority", async () => {
  const dir = await mkdtemp(join(tmpdir(), "figma-workspace-python-cache-"));
  try {
    const explicitPath = join(dir, "explicit-oauth.json");
    const codexHome = join(dir, "codex-home");
    const userProfile = join(dir, "profile");

    const result = runResolveOAuthCachePath({
      FIGMA_WORKSPACE_OAUTH_CACHE_PATH: explicitPath,
      CODEX_HOME: codexHome,
      USERPROFILE: userProfile,
    });

    assert.equal(result.status, 0);
    assert.equal(result.stdout.trim(), explicitPath);

    const jsonResult = runResolveOAuthCachePath(
      {
        FIGMA_WORKSPACE_OAUTH_CACHE_PATH: undefined,
        CODEX_HOME: codexHome,
        USERPROFILE: userProfile,
      },
      ["--json"],
    );
    assert.equal(jsonResult.status, 0);
    assert.deepEqual(JSON.parse(jsonResult.stdout), {
      path: join(codexHome, ".figma-workspace-oauth.json"),
      source: "CODEX_HOME",
      exists: false,
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("resolve-oauth-cache-path.py can require an existing cache file", async () => {
  const dir = await mkdtemp(join(tmpdir(), "figma-workspace-python-missing-cache-"));
  const cachePath = join(dir, "missing-oauth.json");
  const result = runResolveOAuthCachePath({
    FIGMA_WORKSPACE_OAUTH_CACHE_PATH: cachePath,
  }, ["--require-existing"]);

  assert.equal(result.status, 2);
  assert.match(result.stderr, /Resolved OAuth cache file does not exist/u);
  await rm(dir, { recursive: true, force: true });
});

test("login-figma-http.mjs runs in foreground and validates OAuth cache", async () => {
  const script = await readFile(
    new URL("../mcp-server/scripts/login-figma-http.mjs", import.meta.url),
    "utf8",
  );

  assert.doesNotMatch(script, /FIGMA_WORKSPACE_BRIDGE_LOGIN_CHILD/u);
  assert.doesNotMatch(script, /-NoExit/u);
  assert.match(script, /async function testOAuthCacheReady/u);
  assert.match(script, /function reportOAuthCacheWriteStatus/u);
  assert.match(script, /async function removeOAuthCacheForForceLogin/u);
  assert.match(script, /--force/u);
  assert.match(script, /OAuth cache is not ready after adding the temporary server/u);
  assert.match(script, /invokeCodexMcp\(\["mcp", "login", serverName\]\)/u);
  assert.match(script, /invokeCodexMcp\(\["mcp", "add", serverName, "--url", serverUrl\]\)/u);
  assert.match(script, /invokeCodexMcp\(\["mcp", "remove", serverName\], \{ ignoreFailure: true \}\)/u);
  assert.match(script, /tokens\.access_token/u);
  assert.match(script, /expires within 60 seconds/u);
  assert.match(script, /process\.exitCode = 2/u);
  assert.match(script, /already usable; no new token was written/u);
  assert.match(script, /Restored the previous OAuth cache after login failure/u);
  assert.match(script, /OAuth cache ready/u);
});

test("createBridgeConfig fails without an allowed OAuth cache location", () => {
  withEnv(
    {
      FIGMA_WORKSPACE_OAUTH_CACHE_PATH: undefined,
      CODEX_HOME: undefined,
      HOME: "C:/ignored-home",
      USERPROFILE: undefined,
    },
    () => {
      assert.throws(
        () => createBridgeConfig({ port: 19001 }),
        /FIGMA_WORKSPACE_OAUTH_CACHE_PATH, CODEX_HOME, or USERPROFILE/u,
      );
    },
  );
});

test("copyRequestHeaders preserves MCP and auth headers but drops hop-by-hop headers", () => {
  const headers = copyRequestHeaders({
    authorization: "Bearer token",
    "mcp-session-id": "session-1",
    "mcp-protocol-version": "2025-06-18",
    connection: "keep-alive",
    host: "127.0.0.1:18766",
  });

  assert.equal(headers.get("authorization"), "Bearer token");
  assert.equal(headers.get("mcp-session-id"), "session-1");
  assert.equal(headers.get("mcp-protocol-version"), "2025-06-18");
  assert.equal(headers.get("connection"), null);
  assert.equal(headers.get("host"), null);
});

test("copyResponseHeaders preserves OAuth challenge and MCP session headers", () => {
  const headers = new Headers({
    "www-authenticate": "Bearer resource_metadata=\"https://mcp.figma.com/.well-known/oauth-protected-resource\"",
    "mcp-session-id": "session-1",
    connection: "keep-alive",
  });

  const copied = copyResponseHeaders(headers);

  assert.equal(
    copied.get("www-authenticate"),
    "Bearer resource_metadata=\"https://mcp.figma.com/.well-known/oauth-protected-resource\"",
  );
  assert.equal(copied.get("mcp-session-id"), "session-1");
  assert.equal(copied.has("connection"), false);
});

test("rewriteWwwAuthenticate points resource metadata to the local bridge", () => {
  const config = createBridgeConfig({ port: 19001 });
  const rewritten = rewriteWwwAuthenticate(
    'Bearer resource_metadata="https://mcp.figma.com/.well-known/oauth-protected-resource",scope="mcp:connect"',
    config,
  );

  assert.match(
    rewritten,
    /resource_metadata="http:\/\/127\.0\.0\.1:19001\/\.well-known\/oauth-protected-resource"/,
  );
  assert.match(rewritten, /scope="mcp:connect"/);
});

test("rewriteResponseHeaders rewrites OAuth challenge metadata URL", () => {
  const config = createBridgeConfig({ port: 19001 });
  const headers = new Map([
    [
      "www-authenticate",
      'Bearer resource_metadata="https://mcp.figma.com/.well-known/oauth-protected-resource",scope="mcp:connect"',
    ],
  ]);

  rewriteResponseHeaders(headers, config);

  assert.match(
    headers.get("www-authenticate"),
    /resource_metadata="http:\/\/127\.0\.0\.1:19001\/\.well-known\/oauth-protected-resource"/,
  );
});

test("rewriteProtectedResourceMetadata points resource to the local bridge", () => {
  const config = createBridgeConfig({ port: 19001 });
  const rewritten = JSON.parse(
    rewriteProtectedResourceMetadata(
      JSON.stringify({
        resource: "https://mcp.figma.com/mcp",
        authorization_servers: ["https://api.figma.com"],
        scopes_supported: ["mcp:connect"],
      }),
      config,
    ),
  );

  assert.equal(rewritten.resource, "http://127.0.0.1:19001/mcp");
  assert.equal(
    rewritten.resource_metadata,
    "http://127.0.0.1:19001/.well-known/oauth-protected-resource",
  );
  assert.deepEqual(rewritten.authorization_servers, ["http://127.0.0.1:19001"]);
});

test("rewriteAuthorizationServerMetadata points OAuth endpoints to the local bridge", () => {
  const config = createBridgeConfig({ port: 19001 });
  const rewritten = JSON.parse(
    rewriteAuthorizationServerMetadata(
      JSON.stringify({
        issuer: "https://api.figma.com",
        authorization_endpoint: "https://www.figma.com/oauth/mcp",
        token_endpoint: "https://api.figma.com/v1/oauth/token",
        registration_endpoint: "https://api.figma.com/v1/oauth/mcp/register",
      }),
      config,
    ),
  );

  assert.equal(rewritten.issuer, "http://127.0.0.1:19001");
  assert.equal(
    rewritten.authorization_endpoint,
    "http://127.0.0.1:19001/oauth/authorize",
  );
  assert.equal(rewritten.token_endpoint, "http://127.0.0.1:19001/oauth/token");
  assert.equal(
    rewritten.registration_endpoint,
    "http://127.0.0.1:19001/oauth/register",
  );
});

test("handleAuthorizationRedirect redirects to Figma with the original query", () => {
  const config = createBridgeConfig({ port: 19001 });
  const incomingUrl = new URL(
    `http://127.0.0.1:19001${OAUTH_AUTHORIZE_PATH}?client_id=abc&state=xyz`,
  );
  const response = {
    headers: undefined,
    status: undefined,
    writeHead(status, headers) {
      this.status = status;
      this.headers = headers;
    },
    end() {},
  };

  handleAuthorizationRedirect(config, incomingUrl, response);

  assert.equal(response.status, 302);
  assert.equal(
    response.headers.location,
    "https://www.figma.com/oauth/mcp?client_id=abc&state=xyz",
  );
});

test("handleAuthorizationRedirect rewrites local resource query to Figma target", () => {
  const config = createBridgeConfig({ port: 19001 });
  const incomingUrl = new URL(
    `http://127.0.0.1:19001${OAUTH_AUTHORIZE_PATH}?resource=http%3A%2F%2F127.0.0.1%3A19001%2Fmcp`,
  );
  const response = {
    headers: undefined,
    status: undefined,
    writeHead(status, headers) {
      this.status = status;
      this.headers = headers;
    },
    end() {},
  };

  handleAuthorizationRedirect(config, incomingUrl, response);

  assert.equal(response.status, 302);
  assert.equal(
    new URL(response.headers.location).searchParams.get("resource"),
    "https://mcp.figma.com/mcp",
  );
});

test("rewriteOAuthRequestBody rewrites local resource form field to Figma target", () => {
  const config = createBridgeConfig({ port: 19001 });
  const rewritten = rewriteOAuthRequestBody(
    "application/x-www-form-urlencoded",
    Buffer.from("grant_type=authorization_code&resource=http%3A%2F%2F127.0.0.1%3A19001%2Fmcp"),
    config,
  );

  assert.equal(
    new URLSearchParams(rewritten.toString("utf8")).get("resource"),
    "https://mcp.figma.com/mcp",
  );
});

test("OAuthCache stores client registration and token responses", async () => {
  const dir = await mkdtemp(join(tmpdir(), "figma-workspace-"));
  try {
    const cache = new OAuthCache(join(dir, "oauth.json"), {
      now: () => 100000,
    });
    await cache.saveClientInformation({
      client_id: "client-1",
      client_secret: "secret-1",
    });
    await cache.saveTokenResponse({
      access_token: "access-1",
      refresh_token: "refresh-1",
      expires_in: 3600,
      token_type: "Bearer",
    });
    await cache.saveTokenResponse({
      access_token: "access-2",
      expires_in: 3600,
      token_type: "Bearer",
    });

    const state = await cache.read();
    assert.equal(state.clientInformation.client_id, "client-1");
    assert.equal(state.tokens.access_token, "access-2");
    assert.equal(state.tokens.refresh_token, "refresh-1");
    assert.equal(state.tokens.expires_at, 3700000);
    assert.equal(await cache.getUsableAccessToken(), "access-2");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("createMcpRequestHeaders injects a cached access token when Authorization is missing", async () => {
  const dir = await mkdtemp(join(tmpdir(), "figma-workspace-"));
  try {
    const cache = new OAuthCache(join(dir, "oauth.json"), {
      now: () => 100000,
    });
    await cache.saveTokenResponse({
      access_token: "access-1",
      refresh_token: "refresh-1",
      expires_in: 3600,
    });

    const { headers, injectedCachedToken } = await createMcpRequestHeaders(
      createBridgeConfig({ port: 19001 }),
      {},
      cache,
    );

    assert.equal(injectedCachedToken, true);
    assert.equal(headers.get("authorization"), "Bearer access-1");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("createMcpRequestHeaders keeps explicit Authorization over cache", async () => {
  const dir = await mkdtemp(join(tmpdir(), "figma-workspace-"));
  try {
    const cache = new OAuthCache(join(dir, "oauth.json"), {
      now: () => 100000,
    });
    await cache.saveTokenResponse({
      access_token: "access-1",
      expires_in: 3600,
    });

    const { headers, injectedCachedToken } = await createMcpRequestHeaders(
      createBridgeConfig({ port: 19001 }),
      { authorization: "Bearer explicit" },
      cache,
    );

    assert.equal(injectedCachedToken, false);
    assert.equal(headers.get("authorization"), "Bearer explicit");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("startFigmaMcpBridge starts and returns an HTTP MCP URL", async () => {
  const bridge = await startFigmaMcpBridge({ port: 19002 });
  try {
    assert.equal(bridge.url, "http://127.0.0.1:19002/mcp");
    const response = await fetch("http://127.0.0.1:19002/not-mcp");
    assert.equal(response.status, 404);
  } finally {
    await bridge.close();
  }
});

function withEnv(overrides, run) {
  const previous = {};
  for (const key of Object.keys(overrides)) {
    previous[key] = process.env[key];
    if (overrides[key] === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = overrides[key];
    }
  }
  try {
    return run();
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
}

function runResolveOAuthCachePath(overrides, args = []) {
  const env = { ...process.env };
  for (const [key, value] of Object.entries(overrides)) {
    for (const existingKey of Object.keys(env)) {
      if (existingKey.toLowerCase() === key.toLowerCase()) {
        delete env[existingKey];
      }
    }
    if (value === undefined) {
      continue;
    } else {
      env[key] = value;
    }
  }
  return spawnSync("python", ["scripts/resolve-oauth-cache-path.py", ...args], {
    cwd: new URL("..", import.meta.url),
    env,
    encoding: "utf8",
  });
}

function createCommandOutput() {
  let stdout = "";
  let stderr = "";
  return {
    dependencies: {
      writeStdout(value) {
        stdout += value;
      },
      writeStderr(value) {
        stderr += value;
      },
    },
    stdout: () => stdout,
    stderr: () => stderr,
  };
}

function runNpm(args, options = {}) {
  const npmCli = process.env.npm_execpath;
  if (npmCli) {
    return spawnSync(process.execPath, [npmCli, ...args], options);
  }
  return spawnSync(process.platform === "win32" ? "npm.cmd" : "npm", args, options);
}
