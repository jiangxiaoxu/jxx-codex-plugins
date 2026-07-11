import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { runFigmaCommandCli as runFigmaCli } from "../mcp-server/dist/cli/figma-command-runtime.js";
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
  const expectedEntrypoints = {
    figma: "figma.mjs",
    "figma:help": "figma-help.mjs",
    "figma:raw": "figma-raw.mjs",
    "figma:raw:help": "figma-raw-help.mjs",
    "figma:docs": "figma-docs.mjs",
    "figma:docs:list": "figma-docs-list.mjs",
    "figma:docs:read": "figma-docs-read.mjs",
    "figma:docs:search": "figma-docs-search.mjs",
    "figma:api": "figma-api.mjs",
    "figma:api:search": "figma-api-search.mjs",
    "figma:guidance": "figma-guidance.mjs",
    "figma:doctor": "figma-doctor.mjs",
    "figma:sessions": "figma-sessions.mjs",
    "figma:sessions:list": "figma-sessions-list.mjs",
    "figma:sessions:read": "figma-sessions-read.mjs",
    "figma:upstream": "figma-upstream.mjs",
    "figma:upstream:list": "figma-upstream-list.mjs",
    "figma:upstream:read": "figma-upstream-read.mjs",
    "figma:inspect": "figma-inspect.mjs",
    "figma:metadata": "figma-metadata.mjs",
    "figma:design-context": "figma-design-context.mjs",
    "figma:motion-context": "figma-motion-context.mjs",
    "figma:variables": "figma-variables.mjs",
    "figma:design-system": "figma-design-system.mjs",
    "figma:libraries": "figma-libraries.mjs",
    "figma:open": "figma-open.mjs",
    "figma:eval": "figma-eval.mjs",
    "figma:script:run": "figma-script-run.mjs",
    "figma:assets:apply": "figma-assets-apply.mjs",
    "figma:assets:download": "figma-assets-download.mjs",
    "figma:capture": "figma-capture.mjs",
    "figma:task:run": "figma-task-run.mjs",
    "figma:task:prepare": "figma-task-prepare.mjs",
    "figma:upstream:call": "figma-upstream-call.mjs",
    start: "figma-start.mjs",
  };
  const scriptEntrypoints = [];
  for (const [scriptName, entrypoint] of Object.entries(expectedEntrypoints)) {
    const expected = `node scripts/commands/${entrypoint}`;
    assert.equal(packageJson.scripts[scriptName], expected);
    scriptEntrypoints.push(expected);
    const source = await readFile(new URL(`../scripts/commands/${entrypoint}`, import.meta.url), "utf8");
    if (!["figma:raw", "figma:raw:help"].includes(scriptName)) {
      assert.match(source, /dist\/cli\/figma-command-runtime\.js/u, scriptName);
    }
    if (scriptName.startsWith("figma:") && !["figma:help", "figma:raw", "figma:raw:help"].includes(scriptName)) {
      const commandName = scriptName.slice("figma:".length);
      assert.match(source, /dist\/cli\/figma-command-runtime\.js/u, scriptName);
      assert.match(source, new RegExp(`runFigmaCommand\\("${commandName}"`, "u"), scriptName);
    }
  }
  assert.equal(new Set(scriptEntrypoints).size, scriptEntrypoints.length, "each public command owns one executable entrypoint");
  assert.equal(await readFile(new URL("../.npmrc", import.meta.url), "utf8"), "loglevel=silent\n");
});

test("direct commands map positional options into canonical runtime input", async () => {
  const invocations = [];
  const output = createCommandOutput();
  const runCli = async (args, dependencies) => {
    invocations.push({ args, input: JSON.parse(await dependencies.io.readStdin()) });
    return 0;
  };

  assert.equal(await runFigmaCli([
    "api:search", "createFrame", "--limit", "2", "--max-inline-bytes", "10000",
  ], { ...output.dependencies, runCli }), 0);
  assert.deepEqual(invocations[0], {
    args: ["lookup", "--input", "-", "--inline-result-limit", "10000"],
    input: { kind: "api", symbol: "createFrame", maxResults: 2 },
  });

  assert.equal(await runFigmaCli([
    "sessions:read", "default", "--with-handles", "--with-history", "--state-file", "C:/work/state.json",
  ], { ...output.dependencies, runCli }), 0);
  assert.deepEqual(invocations[1], {
    args: ["sessions", "--input", "-", "--session-file", "C:/work/state.json"],
    input: { sessionId: "default", includeHandles: true, includeHistory: true },
  });

  assert.equal(await runFigmaCli([
    "design-context", "--file", "https://www.figma.com/design/file-key/Test?node-id=1-2",
    "--force-code", "--no-code-connect", "--session-id", "design-review",
  ], { ...output.dependencies, runCli }), 0);
  assert.deepEqual(invocations[2], {
    args: ["get-design-context", "--input", "-"],
    input: {
      file: "https://www.figma.com/design/file-key/Test?node-id=1-2",
      forceCode: true,
      disableCodeConnect: true,
      sessionId: "design-review",
    },
  });

  assert.equal(await runFigmaCli([
    "design-system", "button", "--no-components", "--library", "one", "--library", "two",
  ], { ...output.dependencies, runCli }), 0);
  assert.deepEqual(invocations[3], {
    args: ["search-design-system", "--input", "-"],
    input: {
      query: "button",
      includeComponents: false,
      includeLibraryKeys: ["one", "two"],
    },
  });
});

test("every command accepts -h and --help before runtime validation", async () => {
  const commandNames = [
    "guidance", "docs:list", "docs:read", "docs:search", "api:search", "doctor",
    "sessions:list", "sessions:read", "upstream:list", "upstream:read", "inspect",
    "metadata", "design-context", "motion-context", "variables", "design-system", "libraries",
    "open", "eval", "script:run", "assets:apply", "assets:download", "capture",
    "task:run", "task:prepare", "upstream:call",
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
    "guidance", "docs:list", "docs:read", "docs:search", "api:search", "doctor",
    "sessions:list", "sessions:read", "upstream:list", "upstream:read", "inspect",
    "metadata", "design-context", "motion-context", "variables", "design-system", "libraries",
    "open", "eval", "script:run", "assets:apply", "assets:download", "capture",
    "task:run", "task:prepare", "upstream:call",
  ];
  const stateFileCommands = new Set([
    "sessions:list", "sessions:read", "inspect", "metadata", "design-context", "motion-context",
    "variables", "design-system", "libraries", "open", "eval", "script:run", "assets:apply",
    "assets:download", "capture", "task:run", "task:prepare", "upstream:call",
  ]);
  const sessionIdCommands = new Set([
    "inspect", "metadata", "design-context", "motion-context", "variables", "design-system", "libraries",
  ]);
  for (const commandName of commandNames) {
    const output = createCommandOutput();
    assert.equal(await runFigmaCli([commandName, "-h"], output.dependencies), 0);
    const help = output.stdout();
    assert.doesNotMatch(help, /--session-file|--inline-result-limit|--max-results|--max-snippet-lines|--max-cards|--workspace-dir|--library-key/u, commandName);
    assert.equal(help.includes("--state-file"), stateFileCommands.has(commandName), `${commandName} state file`);
    assert.equal(help.includes("--session-id"), sessionIdCommands.has(commandName), `${commandName} session id`);
    assert.match(help, /--max-inline-bytes/u, commandName);
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
    [["api:search", "createFrame", "--limit", "11"], /must be at most 10/u],
    [["api:search", "createFrame", "--max-inline-bytes", "10001"], /must be at most 10000/u],
    [["api:search", "createFrame", "--max-inline-bytes", "1", "--max-inline-bytes", "2"], /Duplicate option/u],
    [["api:search", "createFrame", "--state-file", "state.json"], /Unknown option/u],
    [["docs:search", "session", "--snippet-lines", "0"], /must be at least 1/u],
    [["guidance", "text", "--surface", "canvas"], /must be one of/u],
    [["guidance", "text.font", "--mode", "card"], /must be one of/u],
    [["guidance", "text", "--card-limit", "9"], /must be at most 8/u],
    [["inspect", "$hero", "--depth", "0"], /must be at least 1/u],
    [["libraries", "--offset", "-1"], /must be at least 0/u],
    [["sessions:read", "default", "--with-handles", "--with-handles"], /Duplicate option/u],
    [["doctor", "unexpected"], /Unexpected argument/u],
    [["api:search", "two", "arguments"], /accepts one <symbol>/u],
  ];
  for (const [argv, expected] of cases) {
    const output = createCommandOutput();
    const exitCode = await runFigmaCli(argv, {
      ...output.dependencies,
      runCli: async () => assert.fail(`${argv.join(" ")} must not enter runtime`),
    });
    assert.equal(exitCode, 2, argv.join(" "));
    assert.equal(output.stdout(), "");
    assert.match(output.stderr(), expected);
  }
});

test("JSON commands translate optimized options into canonical runtime options", async () => {
  const invocations = [];
  const exitCode = await runFigmaCli([
    "eval", "--input", "eval.json", "--state-file", "C:/work/state.json",
    "--max-inline-bytes", "0",
  ], {
    runCli: async (args) => {
      invocations.push(args);
      return 0;
    },
  });

  assert.equal(exitCode, 0);
  assert.deepEqual(invocations, [[
    "eval", "--input", "eval.json", "--session-file", "C:/work/state.json",
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
  assert.equal(await runFigmaCli(["open"], {
    runCli: async (args) => {
      invocations.push(args);
      return 0;
    },
  }), 0);
  assert.deepEqual(invocations, [["open"]]);
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
  const npmCli = process.env.npm_execpath;
  assert.ok(npmCli, "npm_execpath must be available when the plugin test runs through npm");
  const result = spawnSync(process.execPath, [npmCli, "run", "--silent", "figma:help"], {
    cwd: fileURLToPath(new URL("../", import.meta.url)),
    encoding: "utf8",
  });

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /^# Figma command CLI help$/mu);
});

test("npm command script help is Markdown without npm banners", () => {
  const npmCli = process.env.npm_execpath;
  assert.ok(npmCli);
  const result = spawnSync(process.execPath, [npmCli, "run", "figma:api:search", "--", "-h"], {
    cwd: fileURLToPath(new URL("../", import.meta.url)),
    encoding: "utf8",
  });

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /^# figma api:search help$/mu);
  assert.doesNotMatch(result.stdout, /^>/mu);
  assert.equal(result.stderr, "");
});

test("root figma CLI dispatches the same canonical command", () => {
  const npmCli = process.env.npm_execpath;
  assert.ok(npmCli);
  const result = spawnSync(process.execPath, [npmCli, "run", "figma", "--", "api:search", "-h"], {
    cwd: fileURLToPath(new URL("../", import.meta.url)),
    encoding: "utf8",
  });

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /^# figma api:search help$/mu);
  assert.doesNotMatch(result.stdout, /^>/mu);
  assert.equal(result.stderr, "");
});

test("figma:raw keeps the transport schema escape hatch", () => {
  const npmCli = process.env.npm_execpath;
  assert.ok(npmCli);
  const result = spawnSync(process.execPath, [npmCli, "run", "figma:raw", "--", "lookup", "--help"], {
    cwd: fileURLToPath(new URL("../", import.meta.url)),
    encoding: "utf8",
  });

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /^# figma-workspace lookup help$/mu);
  assert.equal(result.stderr, "");
});

test("figma:raw command help takes precedence over invalid or I/O-bound options", () => {
  const npmCli = process.env.npm_execpath;
  assert.ok(npmCli);
  const cases = [
    ["lookup", "--input", "definitely-missing.json", "--help"],
    ["lookup", "--unknown", "value", "-h"],
    ["lookup", "--input", "--help"],
  ];

  for (const args of cases) {
    const result = spawnSync(process.execPath, [npmCli, "run", "figma:raw", "--", ...args], {
      cwd: fileURLToPath(new URL("../", import.meta.url)),
      encoding: "utf8",
    });

    assert.equal(result.status, 0, `${args.join(" ")}\n${result.stderr}`);
    assert.match(result.stdout, /^# figma-workspace lookup help$/mu);
    assert.equal(result.stderr, "");
  }
});

test("npm package includes runtime surfaces and excludes local state and source tests", async () => {
  const npmCli = process.env.npm_execpath;
  assert.ok(npmCli);
  const result = spawnSync(process.execPath, [npmCli, "pack", "--dry-run", "--json"], {
    cwd: fileURLToPath(new URL("../", import.meta.url)),
    encoding: "utf8",
  });

  assert.equal(result.status, 0, result.stderr);
  const report = JSON.parse(result.stdout);
  assert.equal(report.length, 1);
  const paths = report[0].files.map(({ path }) => path.replaceAll("\\", "/"));
  for (const requiredPath of [
    ".codex-plugin/plugin.json",
    "mcp-server/dist/cli/figma-command-runtime.js",
    "scripts/commands/figma.mjs",
    "skills/figma-workspace/SKILL.md",
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
});

test("npm direct command script returns runtime Markdown without npm banners", async () => {
  const npmCli = process.env.npm_execpath;
  assert.ok(npmCli);
  const result = spawnSync(process.execPath, [npmCli, "run", "figma:docs:read", "--", "overview"], {
    cwd: fileURLToPath(new URL("../", import.meta.url)),
    encoding: "utf8",
  });

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /^# figma-workspace docs$/mu);
  assert.match(result.stdout, /^Status: succeeded$/mu);
  assert.doesNotMatch(result.stdout, /^>/mu);
  assert.equal(result.stderr, "");
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
