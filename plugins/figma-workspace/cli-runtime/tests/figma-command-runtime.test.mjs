import assert from "node:assert/strict";
import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";
import {
  formatCommandHelp,
  formatRootHelp,
  runFigmaCommand,
  runFigmaCommandCli,
} from "../dist/cli/figma-command-runtime.js";

function harness(options = {}) {
  const stdout = [];
  const stderr = [];
  const calls = [];
  return {
    stdout,
    stderr,
    calls,
    dependencies: {
      cwd: () => options.cwd ?? process.cwd(),
      readFile: options.readFile,
      readStdin: async (maxBytes) => {
        options.stdinLimits?.push(maxBytes);
        return options.stdin ?? "";
      },
      writeStdout: (value) => stdout.push(value),
      writeStderr: (value) => stderr.push(value),
      runCli: async (argv, dependencies) => {
        calls.push({ argv: [...argv], input: JSON.parse(await dependencies.io.readStdin(options.mappedMaxBytes)) });
        return 0;
      },
    },
  };
}

test("root and family help expose only stateless fixed leaf commands", async () => {
  const root = harness();
  assert.equal(await runFigmaCommandCli(["--help"], root.dependencies), 0);
  assert.match(root.stdout.join(""), /^# Figma Workspace/um);
  assert.match(root.stdout.join(""), /figma:run/u);
  assert.match(root.stdout.join(""), /figma:doctor/u);
  assert.doesNotMatch(root.stdout.join(""), /state-file|session-file|figma:open|task:prepare|script:run|figma:eval|figma:guidance/u);

  for (const family of ["docs", "api", "upstream"]) {
    const current = harness();
    assert.equal(await runFigmaCommand(family, [], current.dependencies), 0);
    assert.match(current.stdout.join(""), new RegExp(`^# figma:${family}:help`, "mu"));
  }
  assert.doesNotMatch(formatRootHelp(), /figma:sessions/u);
});

test("run forwards one explicit file and safe TypeScript file", async () => {
  const directory = await mkdtemp(resolve(tmpdir(), "figma-stateless-run-"));
  try {
    const script = resolve(directory, "change.figma.ts");
    await writeFile(script, "return { ok: true };\n", "utf8");
    const current = harness({ cwd: directory });
    assert.equal(await runFigmaCommand("run", ["--file", "https://www.figma.com/design/ExampleKey/UI", "--script", "change.figma.ts", "--output-dir", "results", "--max-inline-bytes", "2048"], current.dependencies), 0);
    assert.deepEqual(current.calls[0].argv, ["run", "--input", "-", "--inline-result-limit", "2048"]);
    assert.equal(current.calls[0].input.file, "https://www.figma.com/design/ExampleKey/UI");
    assert.equal(current.calls[0].input.scriptPath, script);
    assert.equal(current.calls[0].input.outputDir, resolve(directory, "results"));
    assert.equal("sessionId" in current.calls[0].input, false);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("run accepts TypeScript stdin and rejects ambiguous or unsafe input", async () => {
  const source = "return { ok: true };";
  const current = harness({ stdin: source });
  assert.equal(await runFigmaCommand("run", ["--file", "ExampleKey", "--surface", "design", "--source", "-"], current.dependencies), 0);
  assert.equal(current.calls[0].input.source, source);

  for (const argv of [
    ["--file", "ExampleKey", "--surface", "design"],
    ["--file", "ExampleKey", "--surface", "design", "--source", "inline"],
    ["--file", "ExampleKey", "--surface", "design", "--source", "-", "--state-file", "state.json"],
  ]) {
    const invalid = harness({ stdin: source });
    assert.equal(await runFigmaCommand("run", argv, invalid.dependencies), 2);
    assert.equal(invalid.calls.length, 0);
  }
});

test("run rejects symlink script targets", async (t) => {
  const directory = await mkdtemp(resolve(tmpdir(), "figma-stateless-symlink-"));
  try {
    const target = resolve(directory, "target.figma.ts");
    const link = resolve(directory, "link.figma.ts");
    await writeFile(target, "return {};\n", "utf8");
    try { await symlink(target, link, "file"); } catch (error) { if (["EPERM", "EACCES", "ENOTSUP"].includes(error.code)) return t.skip("symlinks unavailable"); throw error; }
    const current = harness();
    assert.equal(await runFigmaCommand("run", ["--file", "ExampleKey", "--surface", "design", "--script", link], current.dependencies), 2);
    assert.match(current.stderr.join(""), /non-symlink|reparse/u);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("capture supports file+node or one full node URL", async () => {
  const pair = harness();
  assert.equal(await runFigmaCommand("capture", ["--file", "ExampleKey", "--node", "230:2", "--surface", "design", "--image-file", "capture.png", "--output-dir", "out"], pair.dependencies), 0);
  assert.deepEqual(pair.calls[0].input, { file: "ExampleKey", target: "230:2", surface: "design", imageFile: resolve("capture.png"), outputDir: resolve("out") });

  const url = "https://www.figma.com/design/ExampleKey/UI?node-id=230-2";
  const direct = harness();
  assert.equal(await runFigmaCommand("capture", ["--target", url], direct.dependencies), 0);
  assert.equal(direct.calls[0].input.target, url);

  const conflict = harness();
  assert.equal(await runFigmaCommand("capture", ["--target", url, "--file", "Other", "--node", "1:2"], conflict.dependencies), 2);
});

test("doctor is public, local-only, and argument-free", async () => {
  const current = harness();
  assert.equal(await runFigmaCommand("doctor", [], current.dependencies), 0);
  assert.deepEqual(current.calls[0], { argv: ["doctor", "--input", "-"], input: {} });
  const invalid = harness();
  assert.equal(await runFigmaCommand("doctor", ["--file", "ExampleKey"], invalid.dependencies), 2);
});

test("local docs and API leaves reject remote inline-result limits", async () => {
  for (const [command, argv] of [
    ["docs:catalog", ["--max-inline-bytes", "100"]],
    ["docs:read", ["project:README.md", "--max-inline-bytes", "100"]],
    ["docs:search", ["layout", "--max-inline-bytes", "100"]],
    ["api:search", ["createFrame", "--max-inline-bytes", "100"]],
  ]) {
    const current = harness();
    assert.equal(await runFigmaCommand(command, argv, current.dependencies), 2, command);
    assert.equal(current.calls.length, 0, command);
  }
});

test("removed umbrella and stateful commands fail as usage errors", async () => {
  for (const command of ["open", "sessions", "sessions:list", "task:prepare", "eval", "script:run", "guidance", "maintenance:doctor"]) {
    const current = harness();
    assert.equal(await runFigmaCommand(command, [], current.dependencies), 2, command);
    assert.equal(current.calls.length, 0, command);
  }
});

test("every public leaf help publishes its real argv contract", () => {
  const leaves = [
    "docs:list", "docs:catalog", "docs:read", "docs:search", "api:search", "doctor",
    "metadata", "inspect", "design-context", "motion-context", "variables", "design-system", "libraries",
    "run", "capture", "assets:apply", "assets:download", "upstream:list", "upstream:read", "upstream:call",
  ];
  for (const leaf of leaves) {
    const help = formatCommandHelp(leaf);
    assert.match(help, new RegExp(`Usage: figma:${leaf.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")}`), leaf);
    assert.doesNotMatch(help, /Use figma:help for the complete/u, leaf);
  }
  for (const leaf of ["design-context", "motion-context", "variables"]) {
    assert.match(formatCommandHelp(leaf), /--node <node-id>/u, leaf);
  }
  assert.match(formatCommandHelp("metadata"), /--file <url\|key> \[--node <node-id>\]/u);
});

test("official read leaves accept raw file keys without surface while native leaves defer to their strict contract", async () => {
  for (const [command, argv] of [
    ["metadata", ["--file", "ExampleKey"]],
    ["design-context", ["--file", "ExampleKey", "--node", "1:2"]],
    ["motion-context", ["--file", "ExampleKey", "--node", "1:2"]],
    ["variables", ["--file", "ExampleKey", "--node", "1:2"]],
    ["design-system", ["button", "--file", "ExampleKey"]],
    ["libraries", ["--file", "ExampleKey"]],
  ]) {
    const current = harness();
    assert.equal(await runFigmaCommand(command, argv, current.dependencies), 0, command);
  }
});

test("explicit public paths resolve from invocation cwd instead of outputDir", async () => {
  const cwd = resolve(tmpdir(), "figma-public-path-base");
  const manifest = JSON.stringify({
    file: "ExampleKey",
    surface: "design",
    outputDir: "artifacts",
    manifestPath: "manifests/assets.json",
    assets: [{ path: "images/a.png", target: "1:2" }],
  });
  const current = harness({ cwd, stdin: manifest });
  assert.equal(await runFigmaCommand("assets:apply", ["--input", "-"], current.dependencies), 0);
  assert.equal(current.calls[0].input.outputDir, resolve(cwd, "artifacts"));
  assert.equal(current.calls[0].input.manifestPath, resolve(cwd, "manifests/assets.json"));
  assert.equal(current.calls[0].input.assets[0].path, resolve(cwd, "images/a.png"));
});

test("public stdin, JSON files, and mapped input honor the 256 KiB boundary", async () => {
  const limit = 256 * 1024;
  const prefix = '{"toolName":"x","arguments":{"pad":"';
  const suffix = '"}}';
  const boundary = `${prefix}${"a".repeat(limit - Buffer.byteLength(prefix) - Buffer.byteLength(suffix))}${suffix}`;
  assert.equal(Buffer.byteLength(boundary), limit);

  const ok = harness({ stdin: boundary });
  assert.equal(await runFigmaCommand("upstream:call", ["--input", "-"], ok.dependencies), 0);

  const oversizedStdin = harness({ stdin: `${boundary} ` });
  assert.equal(await runFigmaCommand("upstream:call", ["--input", "-"], oversizedStdin.dependencies), 2);
  assert.match(oversizedStdin.stderr.join(""), /Input exceeds 262144 bytes/u);

  const oversizedFile = harness({ readFile: async () => `${boundary} ` });
  assert.equal(await runFigmaCommand("upstream:call", ["--input", "input.json"], oversizedFile.dependencies), 2);

  const mapped = harness({ stdin: '{"toolName":"x"}', mappedMaxBytes: 8 });
  assert.equal(await runFigmaCommand("upstream:call", ["--input", "-"], mapped.dependencies), 2);
  assert.match(mapped.stderr.join(""), /Input exceeds 8 bytes/u);
});

test("public leaves reject non-Figma and malformed Figma URLs before dispatch", async () => {
  for (const [command, argv] of [
    ["run", ["--file", "https://evil.example/design/ExampleKey/UI", "--surface", "design", "--source", "-"]],
    ["metadata", ["--file", "https://www.figma.com/community/ExampleKey"]],
    ["capture", ["--target", "https://evil.example/design/ExampleKey/UI?node-id=1-2"]],
  ]) {
    const current = harness({ stdin: "return {};" });
    assert.equal(await runFigmaCommand(command, argv, current.dependencies), 2, command);
    assert.equal(current.calls.length, 0, command);
  }
});
