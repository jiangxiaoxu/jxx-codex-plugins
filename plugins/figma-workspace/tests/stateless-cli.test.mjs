import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import test from "node:test";

const pluginRoot = fileURLToPath(new URL("../", import.meta.url));
const repositoryRoot = resolve(pluginRoot, "../..");
const designUrl = "https://www.figma.com/design/EctrdKKdR3c8JTPl55qn3r/Untitled?node-id=230-2";
const publicScripts = [
  "figma:help",
  "figma:docs:help",
  "figma:docs:list",
  "figma:docs:catalog",
  "figma:docs:read",
  "figma:docs:search",
  "figma:api:help",
  "figma:api:read",
  "figma:api:search",
  "figma:doctor",
  "figma:metadata",
  "figma:inspect",
  "figma:design-context",
  "figma:motion-context",
  "figma:variables",
  "figma:design-system",
  "figma:libraries",
  "figma:run",
  "figma:capture",
  "figma:assets:apply",
  "figma:assets:download",
  "figma:upstream:help",
  "figma:upstream:list",
  "figma:upstream:read",
  "figma:upstream:call",
];
const removedPublicScripts = [
  "figma",
  "figma:docs",
  "figma:api",
  "figma:upstream",
  "figma:guidance",
  "figma:open",
  "figma:sessions",
  "figma:sessions:list",
  "figma:sessions:read",
  "figma:task:prepare",
  "figma:eval",
  "figma:script:run",
  "start",
];
const nonPublicMaintenanceScripts = ["maintenance:raw", "maintenance:raw:help"];
const oldSessionTokens = /--state-file|--session-file|--session-id|--workspace-dir|\$selection|\$currentPage/u;

function commandEntryPoint(scriptName) {
  return `scripts/commands/${scriptName.replace(/^figma:/u, "figma-").replaceAll(":", "-")}.mjs`;
}

function runNpm(args, options = {}) {
  const npmCli = process.env.npm_execpath;
  if (npmCli) {
    return spawnSync(process.execPath, [npmCli, ...args], options);
  }
  return spawnSync(process.platform === "win32" ? "npm.cmd" : "npm", args, options);
}

function commandOutput(result) {
  return `${result.stdout ?? ""}\n${result.stderr ?? ""}`;
}

async function createFreshPluginFixture() {
  const container = await mkdtemp(join(tmpdir(), "figma-workspace-tracked-fixture-"));
  const listedFiles = spawnSync(
    "git",
    ["ls-files", "-z", "--cached", "--others", "--exclude-standard", "--", "plugins/figma-workspace"],
    { cwd: repositoryRoot, encoding: "utf8" },
  );
  assert.equal(listedFiles.status, 0, listedFiles.stderr);
  const listedDeletedFiles = spawnSync(
    "git",
    ["ls-files", "-z", "--deleted", "--", "plugins/figma-workspace"],
    { cwd: repositoryRoot, encoding: "utf8" },
  );
  assert.equal(listedDeletedFiles.status, 0, listedDeletedFiles.stderr);
  const deletedFiles = new Set(listedDeletedFiles.stdout.split("\0").filter(Boolean));
  try {
    for (const relativePath of listedFiles.stdout.split("\0").filter(Boolean)) {
      if (deletedFiles.has(relativePath)) continue;
      assert.equal(relativePath.split("/").includes("node_modules"), false, relativePath);
      const source = resolve(repositoryRoot, relativePath);
      const destination = resolve(container, relativePath);
      await mkdir(dirname(destination), { recursive: true });
      await cp(source, destination, { force: false, preserveTimestamps: true });
    }
    const fixturePluginRoot = join(container, "plugins", "figma-workspace");
    return {
      container,
      pluginRoot: fixturePluginRoot,
      cliRuntimeRoot: join(fixturePluginRoot, "cli-runtime"),
    };
  } catch (error) {
    await rm(container, { recursive: true, force: true });
    throw error;
  }
}

test("fixed public leaf wrappers are complete, unique, and separate from maintenance commands", async () => {
  const [manifest, packageJson, entrypoint] = await Promise.all([
    readFile(new URL("../.codex-plugin/plugin.json", import.meta.url), "utf8").then(JSON.parse),
    readFile(new URL("../package.json", import.meta.url), "utf8").then(JSON.parse),
    readFile(new URL("../scripts/commands/command-entrypoint.mjs", import.meta.url), "utf8"),
  ]);
  const actualPublicScripts = Object.keys(packageJson.scripts)
    .filter((scriptName) => scriptName.startsWith("figma:"))
    .sort();

  assert.equal(manifest.mcpServers, undefined);
  assert.deepEqual(actualPublicScripts, [...publicScripts].sort());
  assert.equal(actualPublicScripts.length, publicScripts.length);
  for (const scriptName of removedPublicScripts) {
    assert.equal(packageJson.scripts[scriptName], undefined, `${scriptName} must remain removed`);
  }
  for (const scriptName of nonPublicMaintenanceScripts) {
    assert.match(packageJson.scripts[scriptName], /^node scripts\/commands\//u, scriptName);
  }
  assert.match(entrypoint, /PUBLIC_EXIT_CODES/u);
  assert.match(entrypoint, /process\.exitCode/u);
  assert.match(entrypoint, /runFigmaCommand\(/u);

  const entrypoints = new Set();
  for (const scriptName of publicScripts) {
    const entrypointPath = commandEntryPoint(scriptName);
    assert.equal(packageJson.scripts[scriptName], `node ${entrypointPath}`, scriptName);
    assert.equal(entrypoints.has(entrypointPath), false, `${scriptName} must own one leaf wrapper`);
    entrypoints.add(entrypointPath);
    const source = await readFile(new URL(`../${entrypointPath}`, import.meta.url), "utf8");
    assert.match(source, /runFigmaCommandEntrypoint/u, scriptName);
    assert.doesNotMatch(source, /state-file|session-file|session-id|workspace-dir/u, scriptName);
  }
});

test("release metadata keeps the 0.5.2 plugin, CLI package, lockfile, and OAuth client aligned", async () => {
  const [manifest, packageJson, cliPackageJson, cliLockfile, authConstants] = await Promise.all([
    readFile(new URL("../.codex-plugin/plugin.json", import.meta.url), "utf8").then(JSON.parse),
    readFile(new URL("../package.json", import.meta.url), "utf8").then(JSON.parse),
    readFile(new URL("../cli-runtime/package.json", import.meta.url), "utf8").then(JSON.parse),
    readFile(new URL("../cli-runtime/package-lock.json", import.meta.url), "utf8").then(JSON.parse),
    readFile(new URL("../cli-runtime/src/auth/constants.ts", import.meta.url), "utf8"),
  ]);
  const clientVersion = authConstants.match(/DEFAULT_CLIENT_VERSION = "([^"]+)"/u)?.[1];

  assert.equal(manifest.version, "0.5.2");
  assert.equal(packageJson.version, manifest.version);
  assert.equal(cliPackageJson.version, manifest.version);
  assert.equal(cliLockfile.version, manifest.version);
  assert.equal(cliLockfile.packages[""].version, manifest.version);
  assert.equal(clientVersion, manifest.version);
});

test("every public leaf emits banner-free help and family/root help rejects forwarded arguments", async () => {
  for (const scriptName of publicScripts) {
    const args = scriptName.endsWith(":help")
      ? ["--silent", "run", scriptName]
      : ["--silent", "run", scriptName, "--", "--help"];
    const result = runNpm(args, {
      cwd: pluginRoot,
      encoding: "utf8",
    });
    assert.equal(result.status, 0, `${scriptName}\n${commandOutput(result)}`);
    assert.match(result.stdout, /^# /u, scriptName);
    assert.doesNotMatch(result.stdout, /^>/mu, scriptName);
    assert.equal(result.stderr, "", scriptName);
  }

  for (const scriptName of ["figma:help", "figma:docs:help", "figma:api:help", "figma:upstream:help"]) {
    const result = runNpm(["--silent", "run", scriptName, "--", "unexpected"], {
      cwd: pluginRoot,
      encoding: "utf8",
    });
    assert.equal(result.status, 2, `${scriptName}\n${commandOutput(result)}`);
    assert.match(commandOutput(result), /does not accept arguments/u);
  }
});

test("run and target help expose the stateless contract without session options", () => {
  const cases = [
    ["figma:run", ["--file", "--script", "--source", "--surface", "--target-page", "--output-dir", "--max-inline-bytes"]],
    ["figma:inspect", ["--file", "--node", "--target", "--surface"]],
    ["figma:capture", ["--file", "--node", "--target", "--image-file", "--output-dir"]],
  ];
  for (const [scriptName, expectedOptions] of cases) {
    const result = runNpm(["--silent", "run", scriptName, "--", "--help"], {
      cwd: pluginRoot,
      encoding: "utf8",
    });
    assert.equal(result.status, 0, `${scriptName}\n${commandOutput(result)}`);
    for (const option of expectedOptions) {
      assert.match(result.stdout, new RegExp(option.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&"), "u"), `${scriptName} ${option}`);
    }
    assert.doesNotMatch(result.stdout, oldSessionTokens, scriptName);
  }
});

test("numeric help exposes exact ranges, clamp output is explicit, and API read closes the local id loop", () => {
  for (const scriptName of ["figma:docs:search", "figma:api:search"]) {
    const help = runNpm(["--silent", "run", scriptName, "--", "--help"], {
      cwd: pluginRoot,
      encoding: "utf8",
    });
    assert.equal(help.status, 0, `${scriptName}\n${commandOutput(help)}`);
    assert.match(help.stdout, /--limit <1\.\.10>/u);
    assert.match(help.stdout, /--snippet-lines <1\.\.16>/u);
    assert.match(help.stdout, /parameterAdjustments/u);
    assert.match(help.stdout, /12000-byte UTF-8 budget/u);
  }

  for (const [scriptName, expectedRange] of [
    ["figma:docs:catalog", /--limit <1\.\.100>/u],
    ["figma:inspect", /--depth <1\.\.9007199254740991>/u],
    ["figma:libraries", /--offset <0\.\.9007199254740991>/u],
    ["figma:capture", /--max-dimension <1\.\.65536>/u],
  ]) {
    const help = runNpm(["--silent", "run", scriptName, "--", "--help"], {
      cwd: pluginRoot,
      encoding: "utf8",
    });
    assert.equal(help.status, 0, `${scriptName}\n${commandOutput(help)}`);
    assert.match(help.stdout, expectedRange, scriptName);
  }

  const catalogClamped = runNpm([
    "--silent", "run", "figma:docs:catalog", "--", "--limit", "999",
  ], {
    cwd: pluginRoot,
    encoding: "utf8",
  });
  assert.equal(catalogClamped.status, 0, commandOutput(catalogClamped));
  assert.match(catalogClamped.stdout, /^Status: succeeded$/mu);
  assert.match(catalogClamped.stdout, /"option": "--limit"/u);
  assert.match(catalogClamped.stdout, /"requested": 999/u);
  assert.match(catalogClamped.stdout, /"applied": 100/u);
  assert.match(catalogClamped.stdout, /"range": \[\s*1,\s*100\s*\]/u);
  assert.doesNotMatch(catalogClamped.stdout, /"parameter"|"supportedRange"|"reason"|"message"/u);

  const clamped = runNpm([
    "--silent", "run", "figma:api:search", "--",
    "figma.createFrame", "--limit", "0", "--snippet-lines", "99",
  ], {
    cwd: pluginRoot,
    encoding: "utf8",
  });
  assert.equal(clamped.status, 0, commandOutput(clamped));
  assert.match(clamped.stdout, /^Status: succeeded$/mu);
  assert.match(clamped.stdout, /"parameterAdjustments": \[/u);
  assert.match(clamped.stdout, /"applied": 1/u);
  assert.match(clamped.stdout, /"applied": 16/u);
  assert.doesNotMatch(clamped.stdout, /^Status: observed unhealthy$/mu);

  const search = runNpm(["--silent", "run", "figma:api:search", "--", "figma.createFrame"], {
    cwd: pluginRoot,
    encoding: "utf8",
  });
  assert.equal(search.status, 0, commandOutput(search));
  assert.doesNotMatch(search.stdout, /"parameterAdjustments"/u);
  const apiId = /"apiId": "([^"]+)"/u.exec(search.stdout)?.[1];
  assert.ok(apiId, search.stdout);
  const read = runNpm(["--silent", "run", "figma:api:read", "--", apiId], {
    cwd: pluginRoot,
    encoding: "utf8",
  });
  assert.equal(read.status, 0, commandOutput(read));
  assert.match(read.stdout, /"mode": "read"/u);
  assert.match(read.stdout, /"content":/u);
  assert.match(read.stdout, /createFrame/u);
});

test("removed state, session, dynamic-selector, and duplicate-source inputs fail before dispatch", () => {
  const cases = [
    ["figma:api:search", ["createFrame", "--state-file", "C:/work/state.json"], undefined, /Unknown option|state-file/u],
    ["figma:run", ["--file", designUrl, "--source", "-", "--session-file", "C:/work/state.json"], "return 1;", /Unknown option|session-file/u],
    ["figma:run", ["--source", "-"], "return 1;", /file|required/u],
    ["figma:run", ["--file", designUrl, "--source", "-", "--script", "C:/work/change.figma.ts"], "return 1;", /Duplicate|mutually exclusive|exactly one/iu],
    ["figma:run", ["--file", designUrl, "--source", "file.figma.ts"], undefined, /--source|-|source/u],
    ["figma:inspect", ["--node", "230:2", "--surface", "design"], undefined, /file|target|node/u],
    ["figma:inspect", ["--target", "$selection"], undefined, /\$selection|node URL|target/u],
  ];
  for (const [scriptName, args, input, expected] of cases) {
    const result = runNpm(["--silent", "run", scriptName, "--", ...args], {
      cwd: pluginRoot,
      encoding: "utf8",
      input,
    });
    assert.equal(result.status, 2, `${scriptName}\n${commandOutput(result)}`);
    assert.match(commandOutput(result), expected, scriptName);
  }
});

test("local docs and API lookup stay inline without a state file or remote result limit", async () => {
  const docsRead = runNpm(["--silent", "run", "figma:docs:read", "--", "project:overview"], {
    cwd: pluginRoot,
    encoding: "utf8",
  });
  assert.equal(docsRead.status, 0, commandOutput(docsRead));
  assert.match(docsRead.stdout, /^# figma:docs$/mu);
  assert.doesNotMatch(docsRead.stdout, /state-file|session-file/u);

  const apiSearch = runNpm(["--silent", "run", "figma:api:search", "--", "figma.createFrame"], {
    cwd: pluginRoot,
    encoding: "utf8",
  });
  assert.equal(apiSearch.status, 0, commandOutput(apiSearch));
  assert.match(apiSearch.stdout, /"normalizedSymbol": "createFrame"/u);

  const search = runNpm([
    "--silent", "run", "figma:docs:search", "--",
    "code connect advanced patterns", "--task-family", "code-connect",
  ], {
    cwd: pluginRoot,
    encoding: "utf8",
  });
  assert.equal(search.status, 0, commandOutput(search));
  assert.match(search.stdout, /"taskFamily": "code-connect"/u);
  assert.doesNotMatch(search.stdout, /cliResultFile|^Path:/mu);

  const invalidLimit = runNpm([
    "--silent", "run", "figma:docs:search", "--", "layout", "--max-inline-bytes", "0",
  ], {
    cwd: pluginRoot,
    encoding: "utf8",
  });
  assert.equal(invalidLimit.status, 2, commandOutput(invalidLimit));
  assert.match(commandOutput(invalidLimit), /Unknown option.*max-inline-bytes/u);
});

test("Skill routes static discovery and documents explicit targets without retired public commands", async () => {
  const [skill, agentMetadata, lookupReference, artifactsReference] = await Promise.all([
    readFile(new URL("../skills/figma-workspace/SKILL.md", import.meta.url), "utf8"),
    readFile(new URL("../skills/figma-workspace/agents/openai.yaml", import.meta.url), "utf8"),
    readFile(new URL("../skills/figma-workspace/references/figma-workspace-guidance-and-lookup.md", import.meta.url), "utf8"),
    readFile(new URL("../skills/figma-workspace/references/figma-workspace-artifacts.md", import.meta.url), "utf8"),
  ]);
  const commandMap = skill.match(/## Public Command Map\n(?<body>[\s\S]*?)\n## /u)?.groups?.body;
  assert.notEqual(commandMap, undefined, "SKILL must own one parseable public command map");
  const mapped = new Set([...commandMap.matchAll(/`(figma:[a-z][a-z:-]*)`/gu)].map((match) => match[1]));
  for (const command of [
    "figma:docs:catalog", "figma:docs:search", "figma:docs:read", "figma:api:search",
    "figma:api:read", "figma:doctor", "figma:metadata", "figma:inspect", "figma:run", "figma:capture", "figma:upstream:call",
  ]) {
    assert.equal(mapped.has(command), true, command);
  }
  for (const retired of [
    "figma:guidance", "figma:open", "figma:sessions", "figma:task:prepare",
    "figma:eval", "figma:script:run",
  ]) {
    assert.equal(skill.includes(retired), false, retired);
    assert.equal(lookupReference.includes(retired), false, retired);
  }
  for (const required of [
    "--file <Figma-file-URL|fileKey>",
    "--target <URL>",
    "--source -",
    "outputFiles.cliResultFile",
    "outcome_unknown",
    "Never blindly replay a mutation",
  ]) {
    assert.equal(skill.includes(required), true, required);
  }
  assert.match(artifactsReference, /Local Artifacts/u);
  assert.doesNotMatch(artifactsReference, /--state-file|--session-file|figma:open|figma:sessions/u);
  assert.doesNotMatch(skill, /maintenance:raw|figma:raw|transport schema escape hatch/iu);
  assert.doesNotMatch(agentMetadata, /maintenance:raw|figma:raw|transport schema escape hatch/iu);
});

test("packed plugin contains every fixed leaf wrapper and can run local stateless commands", async () => {
  const fixture = await createFreshPluginFixture();
  const tempDir = await mkdtemp(join(tmpdir(), "figma-workspace-pack-"));
  try {
    const install = runNpm(["ci", "--ignore-scripts"], { cwd: fixture.cliRuntimeRoot, encoding: "utf8" });
    assert.equal(install.status, 0, commandOutput(install));
    const build = runNpm(["run", "build"], { cwd: fixture.cliRuntimeRoot, encoding: "utf8" });
    assert.equal(build.status, 0, commandOutput(build));
    const pack = runNpm(["pack", "--json", "--pack-destination", tempDir], {
      cwd: fixture.pluginRoot,
      encoding: "utf8",
    });
    assert.equal(pack.status, 0, commandOutput(pack));
    const [{ filename }] = JSON.parse(pack.stdout);
    const extractDir = join(tempDir, "extract");
    await mkdir(extractDir);
    const extract = spawnSync("tar", ["-xf", join(tempDir, filename), "-C", extractDir], { encoding: "utf8" });
    assert.equal(extract.status, 0, extract.stderr);
    const packedRoot = join(extractDir, "package");

    const help = runNpm(["--silent", "run", "figma:help"], { cwd: packedRoot, encoding: "utf8" });
    assert.equal(help.status, 0, commandOutput(help));
    assert.match(help.stdout, /^# Figma Workspace stateless CLI$/mu);
    const docs = runNpm(["--silent", "run", "figma:docs:read", "--", "project:overview"], {
      cwd: packedRoot,
      encoding: "utf8",
    });
    assert.equal(docs.status, 0, commandOutput(docs));
    assert.match(docs.stdout, /# Figma Workspace Overview/u);
    const api = runNpm(["--silent", "run", "figma:api:search", "--", "figma.createFrame"], {
      cwd: packedRoot,
      encoding: "utf8",
    });
    assert.equal(api.status, 0, commandOutput(api));
    assert.match(api.stdout, /"normalizedSymbol": "createFrame"/u);
    const apiId = /"apiId": "([^"]+)"/u.exec(api.stdout)?.[1];
    assert.ok(apiId, api.stdout);
    const apiRead = runNpm(["--silent", "run", "figma:api:read", "--", apiId], {
      cwd: packedRoot,
      encoding: "utf8",
    });
    assert.equal(apiRead.status, 0, commandOutput(apiRead));
    assert.match(apiRead.stdout, /"mode": "read"/u);
    const runHelp = runNpm(["--silent", "run", "figma:run", "--", "--help"], {
      cwd: packedRoot,
      encoding: "utf8",
    });
    assert.equal(runHelp.status, 0, commandOutput(runHelp));
    assert.match(runHelp.stdout, /--script/u);
    assert.doesNotMatch(runHelp.stdout, oldSessionTokens);

    const doctor = runNpm(["--silent", "run", "figma:doctor"], {
      cwd: packedRoot,
      encoding: "utf8",
    });
    assert.equal(doctor.status, 0, commandOutput(doctor));
    assert.match(doctor.stdout, /^Status: succeeded$/mu);
    const doctorJson = /```json\r?\n(?<json>[\s\S]+?)\r?\n```/u.exec(doctor.stdout)?.groups?.json;
    assert.notEqual(doctorJson, undefined, doctor.stdout);
    const doctorPayload = JSON.parse(doctorJson);
    assert.equal(doctorPayload.runtime.projectDocs.ok, true);
    assert.match(
      doctorPayload.runtime.projectDocs.root.replaceAll("\\", "/"),
      /cli-runtime\/dist\/skills\/figma-workspace\/references$/u,
    );
    assert.equal(doctorPayload.runtime.lookup.ok, true);
    assert.ok(doctorPayload.runtime.lookup.api.recordCount > 1_000);
    assert.match(
      doctorPayload.runtime.lookup.api.root.replaceAll("\\", "/"),
      /cli-runtime\/dist\/runtime\/figma-plugin-api-index$/u,
    );
    assert.equal(doctorPayload.runtime.typescript.ok, true);
    assert.match(
      doctorPayload.runtime.typescript.helperDeclarationsPath.replaceAll("\\", "/"),
      /cli-runtime\/dist\/runtime\/figma-workspace-helpers\.d\.ts$/u,
    );
    assert.match(
      doctorPayload.runtime.typescript.figmaPluginTypingsPath.replaceAll("\\", "/"),
      /cli-runtime\/dist\/runtime\/figma-plugin-typings\/index\.d\.ts$/u,
    );
    assert.match(
      doctorPayload.runtime.typescript.typescriptLibDir.replaceAll("\\", "/"),
      /cli-runtime\/dist\/runtime\/typescript-lib$/u,
    );
    assert.ok(doctorPayload.runtime.typescript.typescriptLibCount > 100);

    const preflight = runNpm([
      "--silent", "run", "figma:run", "--",
      "--file", "ABCDEFGHIJKLMNOPQRSTUV", "--surface", "design", "--source", "-",
    ], {
      cwd: packedRoot,
      encoding: "utf8",
      input: "const broken: = 1;\n",
    });
    assert.equal(preflight.status, 1, commandOutput(preflight));
    assert.match(preflight.stdout, /^Status: failed$/mu);
    assert.match(preflight.stdout, /"executionOutcome": "not_started"/u);
    assert.doesNotMatch(preflight.stdout, /Unable to load|Cannot find module|MODULE_NOT_FOUND/iu);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
    await rm(fixture.container, { recursive: true, force: true });
  }
});

test("npm pack includes public runtime surfaces and excludes local artifacts and source tests", async () => {
  const result = runNpm(["pack", "--dry-run", "--json"], { cwd: pluginRoot, encoding: "utf8" });
  assert.equal(result.status, 0, commandOutput(result));
  const [{ files }] = JSON.parse(result.stdout);
  const paths = files.map(({ path }) => path.replaceAll("\\", "/"));
  for (const scriptName of [...publicScripts, ...nonPublicMaintenanceScripts]) {
    const command = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8")).scripts[scriptName];
    const target = /^(?:node|python) ((?!-)[^ ]+)/u.exec(command)?.[1];
    assert.notEqual(target, undefined, scriptName);
    assert.equal(paths.includes(target), true, `${scriptName} target ${target}`);
  }
  for (const required of [
    ".codex-plugin/plugin.json",
    "cli-runtime/dist/cli/figma-command-runtime.js",
    "scripts/commands/command-entrypoint.mjs",
    "skills/figma-workspace/SKILL.md",
  ]) {
    assert.equal(paths.includes(required), true, required);
  }
  assert.equal(paths.some((path) => path.split("/").includes(".figma-workspace")), false);
  assert.equal(paths.some((path) => path.includes("/src/") || path.includes("/tests/")), false);
  assert.equal(paths.some((path) => path.includes("dev/")), false);
});
