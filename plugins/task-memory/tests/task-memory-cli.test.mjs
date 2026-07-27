import assert from "node:assert/strict";
import { linkSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { spawn, spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";

const pluginRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const npmExecutable = process.execPath;
const npmCli = process.env.npm_execpath ?? resolve(dirname(process.execPath), "node_modules/npm/bin/npm-cli.js");
const publicScripts = Object.freeze({
  init: "task-memory:init",
  status: "task-memory:status",
});

/** @param {string} prefix */
function temporaryDirectory(prefix) {
  return mkdtempSync(join(tmpdir(), prefix));
}

/** @param {string} script @param {string[]} arguments_ @param {number} [expectedStatus] @param {string} [cwd] */
function runNpm(script, arguments_, expectedStatus = 0, cwd = pluginRoot) {
  const result = spawnSync(
    npmExecutable,
    [npmCli, "--silent", "run", script, "--", ...arguments_],
    { cwd, encoding: "utf8", windowsHide: true },
  );
  assert.equal(result.error, undefined);
  assert.equal(result.status, expectedStatus, `stdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
  return result;
}

/** @param {string} script @param {string[]} arguments_ @param {string} [cwd] */
function runNpmAsync(script, arguments_, cwd = pluginRoot) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(npmExecutable, [npmCli, "--silent", "run", script, "--", ...arguments_], {
      cwd,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", (status) => resolvePromise({ status, stdout, stderr }));
  });
}

/** @param {string} workspace @param {string} taskId */
function taskDirectory(workspace, taskId) {
  return join(workspace, "task-memory", taskId);
}

/** @param {string} workspace @param {string} [taskId] */
function initTask(workspace, taskId = "task-example") {
  const result = runNpm(publicScripts.init, ["--workspace", workspace, "--task-id", taskId]);
  assert.equal(result.stdout, `task_id=${taskId}\n`);
  return taskDirectory(workspace, taskId);
}

test("package exposes only the two independent task-memory commands", () => {
  const packageJson = JSON.parse(readFileSync(join(pluginRoot, "package.json"), "utf8"));
  const taskScripts = Object.keys(packageJson.scripts).filter((name) => name.startsWith("task-memory"));
  assert.deepEqual(taskScripts.sort(), Object.values(publicScripts).sort());
  assert.equal(packageJson.scripts["task-memory"], undefined);
  for (const target of Object.values(publicScripts)) {
    const entrypoint = resolve(pluginRoot, packageJson.scripts[target].replace(/^node /u, ""));
    const source = readFileSync(entrypoint, "utf8");
    assert.match(source, /runTaskMemoryCommand/u);
    assert.match(source, /src\/task-memory-cli\.mjs/u);
  }
});

test("help is banner-free and has no file-system side effects", () => {
  const parent = temporaryDirectory("task-memory-help-");
  const missingWorkspace = join(parent, "missing");
  try {
    for (const script of Object.values(publicScripts)) {
      const result = runNpm(script, ["--workspace", missingWorkspace, "--help"]);
      assert.match(result.stdout, new RegExp(`# ${script} help`, "u"));
      assert.match(result.stdout, /Exit Codes:/u);
      assert.equal(result.stderr, "");
      assert.equal(readdirSync(parent).length, 0);
    }
  } finally {
    rmSync(parent, { force: true, recursive: true });
  }
});

test("usage and runtime failures use distinct exit codes and streams", () => {
  const workspace = temporaryDirectory("task-memory-errors-");
  try {
    const usage = runNpm(publicScripts.init, ["--workspace", workspace, "--unknown", "x"], 2);
    assert.equal(usage.stdout, "");
    assert.match(usage.stderr, /unknown option/u);
    assert.match(usage.stderr, /task-memory:init help/u);

    const missing = runNpm(publicScripts.init, ["--workspace", workspace], 2);
    assert.match(missing.stderr, /missing required option: --task-id/u);

    const duplicate = runNpm(publicScripts.init, [
      "--workspace", workspace,
      "--workspace", workspace,
      "--task-id", "task-example",
    ], 2);
    assert.match(duplicate.stderr, /duplicate option: --workspace/u);

    const relative = runNpm(publicScripts.init, ["--workspace", "relative", "--task-id", "task-example"], 2);
    assert.match(relative.stderr, /--workspace must be an absolute path/u);

    const runtime = runNpm(publicScripts.status, ["--workspace", workspace, "--task-id", "task-missing"], 1);
    assert.equal(runtime.stdout, "");
    assert.match(runtime.stderr, /task not found/u);
    assert.doesNotMatch(runtime.stderr, /at file:/u);
  } finally {
    rmSync(workspace, { force: true, recursive: true });
  }
});

test("init creates only task_state.md and artifacts with the complete state template", () => {
  const workspace = temporaryDirectory("task-memory-lifecycle-");
  try {
    const task = initTask(workspace);
    assert.deepEqual(readdirSync(task).sort(), ["artifacts", "task_state.md"]);
    const state = readFileSync(join(task, "task_state.md"), "utf8");
    for (const heading of ["## Goal", "## State", "## Open"]) {
      assert.match(state, new RegExp(heading, "u"));
    }
    assert.doesNotMatch(state, /Reports/u);

    const status = runNpm(publicScripts.status, ["--workspace", workspace, "--task-id", "task-example"]);
    assert.equal(status.stdout, [
      "task_id=task-example",
      `task_state=${join(task, "task_state.md")}`,
      `artifacts=${join(task, "artifacts")}`,
      "",
    ].join("\n"));
  } finally {
    rmSync(workspace, { force: true, recursive: true });
  }
});

test("task ids normalize to lowercase hyphen-case", () => {
  const workspace = temporaryDirectory("task-memory-normalize-");
  try {
    const initialized = runNpm(publicScripts.init, ["--workspace", workspace, "--task-id", "Task Example"]);
    assert.equal(initialized.stdout, "task_id=task-example\n");
    const status = runNpm(publicScripts.status, ["--workspace", workspace, "--task-id", "TASK EXAMPLE"]);
    assert.match(status.stdout, /^task_id=task-example\n/u);
  } finally {
    rmSync(workspace, { force: true, recursive: true });
  }
});

test("status restores a missing artifacts directory after validating task state", () => {
  const workspace = temporaryDirectory("task-memory-restore-artifacts-");
  try {
    const task = initTask(workspace);
    const artifacts = join(task, "artifacts");
    rmSync(artifacts, { recursive: true });

    const status = runNpm(publicScripts.status, ["--workspace", workspace, "--task-id", "task-example"]);
    assert.equal(status.stdout, [
      "task_id=task-example",
      `task_state=${join(task, "task_state.md")}`,
      `artifacts=${artifacts}`,
      "",
    ].join("\n"));
    assert.deepEqual(readdirSync(artifacts), []);
  } finally {
    rmSync(workspace, { force: true, recursive: true });
  }
});

test("status rejects missing and wrong-type task entries", () => {
  const workspace = temporaryDirectory("task-memory-layout-");
  try {
    /** @type {Array<{ taskId: string, mutate: (task: string) => void, expected: RegExp }>} */
    const cases = [
      {
        taskId: "task-missing-state",
        mutate(task) { unlinkSync(join(task, "task_state.md")); },
        expected: /missing task_state\.md/u,
      },
      {
        taskId: "task-directory-state",
        mutate(task) { unlinkSync(join(task, "task_state.md")); mkdirSync(join(task, "task_state.md")); },
        expected: /task_state\.md is not a regular file/u,
      },
      {
        taskId: "task-file-artifacts",
        mutate(task) { rmSync(join(task, "artifacts"), { recursive: true }); writeFileSync(join(task, "artifacts"), "file\n", "utf8"); },
        expected: /artifacts directory is not a directory/u,
      },
    ];
    for (const testCase of cases) {
      const task = initTask(workspace, testCase.taskId);
      testCase.mutate(task);
      const result = runNpm(publicScripts.status, ["--workspace", workspace, "--task-id", testCase.taskId], 1);
      assert.match(result.stderr, testCase.expected);
    }
  } finally {
    rmSync(workspace, { force: true, recursive: true });
  }
});

test("status does not restore artifacts when task state is missing", () => {
  const workspace = temporaryDirectory("task-memory-missing-state-");
  try {
    const task = initTask(workspace);
    const artifacts = join(task, "artifacts");
    unlinkSync(join(task, "task_state.md"));
    rmSync(artifacts, { recursive: true });

    const result = runNpm(publicScripts.status, ["--workspace", workspace, "--task-id", "task-example"], 1);
    assert.match(result.stderr, /missing task_state\.md/u);
    assert.equal(readdirSync(task).includes("artifacts"), false);
  } finally {
    rmSync(workspace, { force: true, recursive: true });
  }
});

test("linked task state is rejected when the platform permits it", (context) => {
  const workspace = temporaryDirectory("task-memory-state-link-");
  try {
    const task = initTask(workspace);
    const state = join(task, "task_state.md");
    const target = join(task, "state-target.md");
    writeFileSync(target, "# State\n", "utf8");
    unlinkSync(state);
    try {
      symlinkSync(target, state, "file");
    } catch (error) {
      context.skip(`file link creation is unavailable: ${error}`);
      return;
    }
    const result = runNpm(publicScripts.status, ["--workspace", workspace, "--task-id", "task-example"], 1);
    assert.match(result.stderr, /task_state\.md symlink or reparse point/u);
  } finally {
    rmSync(workspace, { force: true, recursive: true });
  }
});

test("hard-linked task state is rejected", () => {
  const workspace = temporaryDirectory("task-memory-hardlink-");
  try {
    const task = initTask(workspace);
    linkSync(join(task, "task_state.md"), join(task, "state-copy.md"));
    const result = runNpm(publicScripts.status, ["--workspace", workspace, "--task-id", "task-example"], 1);
    assert.match(result.stderr, /hard-linked task_state\.md/u);
  } finally {
    rmSync(workspace, { force: true, recursive: true });
  }
});

test("linked artifact directories are rejected when the platform permits them", (context) => {
  const workspace = temporaryDirectory("task-memory-link-");
  try {
    const task = initTask(workspace);
    const artifacts = join(task, "artifacts");
    rmSync(artifacts, { recursive: true });
    const target = join(task, "artifacts-target");
    mkdirSync(target);
    try {
      symlinkSync(target, artifacts, process.platform === "win32" ? "junction" : "dir");
    } catch (error) {
      context.skip(`directory link creation is unavailable: ${error}`);
      return;
    }
    const result = runNpm(publicScripts.status, ["--workspace", workspace, "--task-id", "task-example"], 1);
    assert.match(result.stderr, /symlink, junction, or reparse point/u);
  } finally {
    rmSync(workspace, { force: true, recursive: true });
  }
});

test("concurrent init allocates every suffix without failures", async () => {
  const workspace = temporaryDirectory("task-memory-concurrent-init-");
  try {
    const results = await Promise.all(Array.from({ length: 12 }, () => runNpmAsync(publicScripts.init, [
      "--workspace", workspace,
      "--task-id", "task-shared",
    ])));
    for (const result of results) {
      assert.equal(result.status, 0, `stdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
    }
    const taskIds = results.map((result) => result.stdout.trim().split("=", 2)[1]);
    assert.equal(new Set(taskIds).size, 12);
    assert.equal(readdirSync(join(workspace, "task-memory")).length, 12);
  } finally {
    rmSync(workspace, { force: true, recursive: true });
  }
});

test("packed plugin runs both commands without node_modules", () => {
  const destination = temporaryDirectory("task-memory-pack-");
  const workspace = temporaryDirectory("task-memory-packed-workspace-");
  try {
    const packed = spawnSync(
      npmExecutable,
      [npmCli, "pack", "--json", "--pack-destination", destination],
      { cwd: pluginRoot, encoding: "utf8", windowsHide: true },
    );
    assert.equal(packed.status, 0, `stdout:\n${packed.stdout}\nstderr:\n${packed.stderr}`);
    const metadata = /** @type {{ filename: string, files: Array<{ path: string }> }} */ (JSON.parse(packed.stdout)[0]);
    const filenames = metadata.files.map((entry) => entry.path);
    assert.ok(filenames.includes("src/task-memory-cli.mjs"));
    assert.ok(filenames.includes("scripts/commands/task-memory-init.mjs"));
    assert.ok(filenames.includes("scripts/commands/task-memory-status.mjs"));
    assert.equal(filenames.some((path) => path.includes("report")), false);

    const archive = join(destination, metadata.filename);
    const extracted = join(destination, "extracted");
    mkdirSync(extracted);
    const tar = spawnSync("tar", ["-xf", archive, "-C", extracted], { encoding: "utf8", windowsHide: true });
    assert.equal(tar.status, 0, tar.stderr);
    const packedRoot = join(extracted, "package");
    assert.equal(readdirSync(packedRoot).includes("node_modules"), false);
    assert.equal(runNpm(publicScripts.init, ["--workspace", workspace, "--task-id", "task-packed"], 0, packedRoot).stdout, "task_id=task-packed\n");
    assert.match(runNpm(publicScripts.status, ["--workspace", workspace, "--task-id", "task-packed"], 0, packedRoot).stdout, /^task_id=task-packed\n/u);
  } finally {
    rmSync(destination, { force: true, recursive: true });
    rmSync(workspace, { force: true, recursive: true });
  }
});
