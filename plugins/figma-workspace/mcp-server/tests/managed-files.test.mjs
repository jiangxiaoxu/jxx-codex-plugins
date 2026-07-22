import assert from "node:assert/strict";
import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { after, test } from "node:test";
import { build } from "esbuild";

const compiledRoot = await mkdtemp(join(tmpdir(), "figma-managed-files-tests-"));
const compiledModule = join(compiledRoot, "managed-files.mjs");
await build({
  entryPoints: [resolve("src/runtime/managed-files.ts")],
  outfile: compiledModule,
  bundle: true,
  format: "esm",
  platform: "node",
  target: "node20",
});
const {
  assertManagedFilePath,
  atomicWriteManagedBinaryFile,
  atomicWriteManagedJsonFile,
  atomicWriteManagedTextFile,
  ensureManagedDirectory,
} = await import(pathToFileURL(compiledModule).href);

after(async () => {
  await rm(compiledRoot, { recursive: true, force: true });
});

test("managed writers atomically publish text, JSON, and binary files with private permissions", async () => {
  const fixture = await createFixture("writes");
  try {
    const nested = join(fixture.root, "nested");
    const textPath = join(nested, "result.txt");
    const jsonPath = join(nested, "result.json");
    const binaryPath = join(nested, "capture.png");

    await atomicWriteManagedTextFile({ root: fixture.root, path: textPath, overwrite: true }, "hello\n");
    await atomicWriteManagedJsonFile({ root: fixture.root, path: jsonPath, overwrite: true }, { ok: true });
    await atomicWriteManagedBinaryFile(
      { root: fixture.root, path: binaryPath, overwrite: true },
      Uint8Array.from([0x89, 0x50, 0x4e, 0x47]),
    );

    assert.equal(await readFile(textPath, "utf8"), "hello\n");
    assert.deepEqual(JSON.parse(await readFile(jsonPath, "utf8")), { ok: true });
    assert.deepEqual([...await readFile(binaryPath)], [0x89, 0x50, 0x4e, 0x47]);
    assert.equal((await lstat(textPath)).mode & 0o777, process.platform === "win32" ? (await lstat(textPath)).mode & 0o777 : 0o600);
    assert.deepEqual((await readdir(nested)).sort(), ["capture.png", "result.json", "result.txt"]);
    assert.equal(await assertManagedFilePath({ root: fixture.root, path: textPath }), textPath);
  } finally {
    await fixture.cleanup();
  }
});

test("overwrite=false uses an exclusive publication step under concurrent writers", async () => {
  const fixture = await createFixture("exclusive");
  try {
    const target = join(fixture.root, "task.figma.ts");
    const settled = await Promise.allSettled([
      atomicWriteManagedTextFile({ root: fixture.root, path: target, overwrite: false }, "first\n"),
      atomicWriteManagedTextFile({ root: fixture.root, path: target, overwrite: false }, "second\n"),
    ]);
    assert.equal(settled.filter((item) => item.status === "fulfilled").length, 1);
    const rejected = settled.find((item) => item.status === "rejected");
    assert.match(String(rejected?.reason?.message), /Refusing to overwrite existing file/u);
    assert.match(await readFile(target, "utf8"), /^(?:first|second)\n$/u);
    assert.deepEqual(await readdir(fixture.root), ["task.figma.ts"]);
  } finally {
    await fixture.cleanup();
  }
});

test("rename failure preserves the previous target and removes sibling temporary files", async () => {
  const fixture = await createFixture("rename-failure");
  try {
    const target = join(fixture.root, "state.json");
    await writeFile(target, "previous\n", { encoding: "utf8", mode: 0o600 });
    await assert.rejects(
      atomicWriteManagedTextFile({
        root: fixture.root,
        path: target,
        overwrite: true,
        operations: {
          rename: async () => {
            const error = new Error("rename blocked");
            Object.assign(error, { code: "EACCES" });
            throw error;
          },
        },
      }, "replacement\n"),
      /rename blocked/u,
    );
    assert.equal(await readFile(target, "utf8"), "previous\n");
    assert.deepEqual(await readdir(fixture.root), ["state.json"]);
  } finally {
    await fixture.cleanup();
  }
});

test("managed paths reject symlink or junction ancestors and final targets", async (t) => {
  const fixture = await createFixture("links");
  const outside = await mkdtemp(join(tmpdir(), "figma-managed-files-outside-"));
  try {
    const linkedDirectory = join(fixture.root, "linked");
    try {
      await symlink(outside, linkedDirectory, process.platform === "win32" ? "junction" : "dir");
    } catch (error) {
      if (hasCode(error, "EPERM") || hasCode(error, "EACCES") || hasCode(error, "ENOSYS")) {
        t.skip(`This platform cannot create a test symlink or junction: ${error.message}`);
        return;
      }
      throw error;
    }
    await assert.rejects(
      ensureManagedDirectory({ root: fixture.root, directory: join(linkedDirectory, "nested") }),
      /symlink, junction, reparse/u,
    );
    await assert.rejects(
      atomicWriteManagedTextFile({
        root: fixture.root,
        path: join(linkedDirectory, "escaped.txt"),
        overwrite: true,
      }, "must not escape\n"),
      /symlink, junction, reparse/u,
    );
    await assert.rejects(readFile(join(outside, "escaped.txt"), "utf8"), { code: "ENOENT" });

    const realTarget = join(fixture.root, "real.txt");
    const linkedTarget = join(fixture.root, "linked.txt");
    await writeFile(realTarget, "safe\n", { encoding: "utf8", mode: 0o600 });
    try {
      await symlink(realTarget, linkedTarget, "file");
      await assert.rejects(
        atomicWriteManagedTextFile({ root: fixture.root, path: linkedTarget, overwrite: true }, "unsafe\n"),
        /regular file, not a symlink/u,
      );
      assert.equal(await readFile(realTarget, "utf8"), "safe\n");
    } catch (error) {
      if (!hasCode(error, "EPERM") && !hasCode(error, "EACCES") && !hasCode(error, "ENOSYS")) throw error;
    }
  } finally {
    await Promise.all([
      fixture.cleanup(),
      rm(outside, { recursive: true, force: true }),
    ]);
  }
});

async function createFixture(name) {
  const parent = await mkdtemp(join(tmpdir(), `figma-managed-files-${name}-`));
  const root = join(parent, "managed");
  await mkdir(root);
  return {
    root,
    cleanup: () => rm(parent, { recursive: true, force: true }),
  };
}

function hasCode(error, code) {
  return error instanceof Error && "code" in error && error.code === code;
}
