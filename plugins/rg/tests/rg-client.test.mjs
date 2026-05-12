import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

import { RgProcessError, setupRgRuntime } from "../scripts/rg-client.mjs";

const SEARCH_TEXT_MAX_BYTES = 12 * 1024;

async function withFixture(t) {
  const directory = await mkdtemp(join(tmpdir(), "rg-client-test-"));
  t.after(async () => {
    await rm(directory, { force: true, recursive: true });
  });
  await writeFile(
    join(directory, "alpha.txt"),
    "one\nmatch-a\nthree\nfour\nfive\nmatch-b\nseven\neight\nnine\nmatch-c\nten\n"
  );
  await writeFile(join(directory, "adjacent.txt"), "zero\nmatch left\nmatch right\ntail\n");
  await writeFile(join(directory, "beta.txt"), "plain text\n");
  return directory;
}

async function setupAvailableRuntime(t, directory) {
  const { rg } = setupRgRuntime({ defaultCwd: directory, readTimeoutMs: 5000 });
  try {
    await rg.raw(["--version"], { maxBytes: 1024, timeoutMs: 5000 });
  } catch (error) {
    t.skip(`ripgrep is not available: ${error.message}`);
    return undefined;
  }
  return rg;
}

test("SearchSession treats rg exit code 1 as normal no-result completion", async (t) => {
  const directory = await withFixture(t);
  const rg = await setupAvailableRuntime(t, directory);
  if (!rg) {
    return;
  }

  const session = rg.search("not-present").start();
  const batch = await session.next(10);

  assert.equal(batch.info, "done");
  assert.equal(Object.hasOwn(batch, "stats"), false);
  assert.equal(Object.hasOwn(batch, "files"), false);
  assert.equal(Object.hasOwn(batch, "readTimedOut"), false);
  assert.equal(Object.hasOwn(batch, "blockCount"), false);
  assert.equal(Object.hasOwn(batch, "done"), false);
  assert.equal(Object.hasOwn(batch, "truncated"), false);
  assert.equal(Object.hasOwn(batch, "stopReason"), false);
  assert.equal(batch.text, "");
});

test("SearchSession throws RgProcessError when rg exits above code 1", async (t) => {
  const directory = await withFixture(t);
  const rg = await setupAvailableRuntime(t, directory);
  if (!rg) {
    return;
  }

  const session = rg.search("[").start();

  await assert.rejects(
    session.next(10),
    (error) => {
      assert.equal(error instanceof RgProcessError, true);
      assert.equal(error.kind, "search");
      assert.deepEqual(error.args.slice(0, 2), ["--json", "["]);
      assert.equal(error.cwd, directory);
      assert.equal(error.exitCode > 1, true);
      assert.match(error.stderr, /regex|error|parse/i);
      assert.match(error.stderrPreview, /regex|error|parse/i);
      assert.equal(typeof error.stderrBytes, "number");
      assert.equal(error.stderrTruncated, false);
      assert.equal(JSON.stringify(error).includes("stderrPreview"), true);
      assert.equal(JSON.stringify(error).includes("stderr\":\""), false);
      return true;
    }
  );
});

test("FileSession throws RgProcessError when rg exits above code 1", async (t) => {
  const directory = await withFixture(t);
  const rg = await setupAvailableRuntime(t, directory);
  if (!rg) {
    return;
  }

  const session = rg.files().arg("--type").start();

  await assert.rejects(
    session.next(10),
    (error) => {
      assert.equal(error instanceof RgProcessError, true);
      assert.equal(error.kind, "files");
      assert.deepEqual(error.args, ["--files", "--type"]);
      assert.equal(error.cwd, directory);
      assert.equal(error.exitCode > 1, true);
      assert.equal(error.stderrTruncated, false);
      return true;
    }
  );
});

test("SearchSession.next returns heading text with context block separators", async (t) => {
  const directory = await withFixture(t);
  const rg = await setupAvailableRuntime(t, directory);
  if (!rg) {
    return;
  }

  const session = rg.search("match").path("alpha.txt").context(1).start();
  const batch = await session.next({ maxBlocks: 2 });
  await session.cancel();

  assert.equal(batch.info, "maxBlocks");
  assert.equal(
    batch.text,
    ["alpha.txt", "1-one", "2:match-a", "3-three", "--", "5-five", "6:match-b", "7-seven"].join("\n")
  );
  assert.equal(Object.hasOwn(batch, "files"), false);
  assert.equal(Object.hasOwn(batch, "stats"), false);
  assert.equal(Object.hasOwn(batch, "readTimedOut"), false);
  assert.equal(Object.hasOwn(batch, "blockCount"), false);
  assert.equal(Object.hasOwn(batch, "done"), false);
  assert.equal(Object.hasOwn(batch, "truncated"), false);
  assert.equal(Object.hasOwn(batch, "stopReason"), false);
});

test("SearchSession.next omits match-only block separators and uses paths only as headings", async (t) => {
  const directory = await withFixture(t);
  const rg = await setupAvailableRuntime(t, directory);
  if (!rg) {
    return;
  }

  const session = rg.search("match").path("alpha.txt").path("adjacent.txt").start();
  const batch = await session.next({ maxBlocks: 10 });

  assert.equal(batch.info, "done");
  assert.equal(Object.hasOwn(batch, "done"), false);
  assert.equal(Object.hasOwn(batch, "stopReason"), false);
  assert.equal(Object.hasOwn(batch, "blockCount"), false);
  assert.equal(Object.hasOwn(batch, "truncated"), false);
  assert.equal(batch.text.includes("--"), false);
  assert.equal((batch.text.match(/^alpha\.txt$/gm) ?? []).length, 1);
  assert.equal((batch.text.match(/^adjacent\.txt$/gm) ?? []).length, 1);
  assert.equal(batch.text.includes("2:match-a"), true);
  assert.equal(batch.text.includes("6:match-b"), true);
  assert.equal(batch.text.includes("10:match-c"), true);
  assert.equal(batch.text.includes("2:match left"), true);
  assert.equal(batch.text.includes("3:match right"), true);
});

test("SearchSession.next caps large text batches at 12KB", async (t) => {
  const directory = await withFixture(t);
  const rg = await setupAvailableRuntime(t, directory);
  if (!rg) {
    return;
  }

  const lines = Array.from({ length: 120 }, (_, index) => `needle-${index}-${"x".repeat(180)}`).join("\n");
  await writeFile(join(directory, "large-text.txt"), `${lines}\n`);

  const session = rg.search("needle").path("large-text.txt").start();
  const batch = await session.next({ maxBlocks: 500 });
  await session.cancel();

  assert.equal(batch.info, "maxTextBytes");
  assert.equal(Buffer.byteLength(batch.text, "utf8") <= SEARCH_TEXT_MAX_BYTES, true);
});

test("SearchSession.next truncates a single long line within the 12KB cap", async (t) => {
  const directory = await withFixture(t);
  const rg = await setupAvailableRuntime(t, directory);
  if (!rg) {
    return;
  }

  await writeFile(join(directory, "long-line.txt"), `${"x".repeat(30 * 1024)}needle\n`);

  const session = rg.search("needle").path("long-line.txt").start();
  const batch = await session.next({ maxBlocks: 10 });
  await session.cancel();

  assert.equal(batch.info, "maxTextBytes");
  assert.equal(Buffer.byteLength(batch.text, "utf8") <= SEARCH_TEXT_MAX_BYTES, true);
  assert.equal(batch.text.startsWith("long-line.txt\n1:"), true);
});

test("SearchSession maxBlocks truncates on block boundaries and next continues", async (t) => {
  const directory = await withFixture(t);
  const rg = await setupAvailableRuntime(t, directory);
  if (!rg) {
    return;
  }

  const session = rg.search("match").path("alpha.txt").context(1).start();
  const first = await session.next({ maxBlocks: 2 });
  const second = await session.next({ maxBlocks: 2 });

  assert.equal(first.info, "maxBlocks");
  assert.equal(
    first.text,
    ["alpha.txt", "1-one", "2:match-a", "3-three", "--", "5-five", "6:match-b", "7-seven"].join("\n")
  );
  assert.equal(second.info, "done");
  assert.equal(second.text, ["alpha.txt", "9-nine", "10:match-c", "11-ten"].join("\n"));
});

test("SearchSession rejects maxResults object input", async (t) => {
  const directory = await withFixture(t);
  const rg = await setupAvailableRuntime(t, directory);
  if (!rg) {
    return;
  }

  const session = rg.search("match").start();

  await assert.rejects(session.next({ maxResults: 1 }), {
    name: "TypeError"
  });
  await session.cancel();
});

test("SearchSession.batches yields default heading text objects", async (t) => {
  const directory = await withFixture(t);
  const rg = await setupAvailableRuntime(t, directory);
  if (!rg) {
    return;
  }

  const session = rg.search("match").path("alpha.txt").start();
  const iterator = session.batches({ maxBlocks: 1 });
  const first = await iterator.next();
  await session.cancel();

  assert.equal(first.done, false);
  assert.equal(typeof first.value.text, "string");
  assert.equal(Object.hasOwn(first.value, "files"), false);
  assert.equal(Object.hasOwn(first.value, "blockCount"), false);
  assert.equal(Object.hasOwn(first.value, "done"), false);
  assert.equal(Object.hasOwn(first.value, "truncated"), false);
  assert.equal(Object.hasOwn(first.value, "stopReason"), false);
  assert.equal(first.value.info, "maxBlocks");
});

test("FileSession uses maxFiles as the truncation stop reason", async (t) => {
  const directory = await withFixture(t);
  const rg = await setupAvailableRuntime(t, directory);
  if (!rg) {
    return;
  }

  const session = rg.files().start();
  const batch = await session.next({ maxFiles: 1 });
  await session.cancel();

  assert.equal(batch.files.length, 1);
  assert.equal(batch.truncated, true);
  assert.equal(batch.stopReason, "maxFiles");
});

test("raw validates maxBytes before spawning rg", async (t) => {
  const directory = await withFixture(t);
  const rg = await setupAvailableRuntime(t, directory);
  if (!rg) {
    return;
  }

  assert.throws(() => rg.raw(["--version"], { maxBytes: 0 }), /maxBytes must be a positive integer/);
});

test("raw defaults to a strict 16KB output cap and allows explicit expansion", async (t) => {
  const directory = await withFixture(t);
  const rg = await setupAvailableRuntime(t, directory);
  if (!rg) {
    return;
  }

  await writeFile(join(directory, "large.txt"), `${"x".repeat(30 * 1024)}\n`);

  const capped = await rg.raw(["x", "large.txt"], { cwd: directory });
  assert.equal(capped.truncated, true);
  assert.equal(capped.stdout.length <= 16 * 1024, true);

  const expanded = await rg.raw(["x", "large.txt"], {
    cwd: directory,
    maxBytes: 40 * 1024
  });
  assert.equal(expanded.truncated, false);
  assert.equal(expanded.stdout.length > 16 * 1024, true);
});

test("session stderr truncation is reported on errors, summaries, and stats", async (t) => {
  if (process.platform === "win32") {
    t.skip("fake executable fixture is POSIX-only");
    return;
  }

  const directory = await withFixture(t);
  const fakeRg = join(directory, "rg");
  const stderr = Array.from({ length: 40 }, (_, index) => `stderr-line-${index}-${"x".repeat(80)}`).join("\n");
  await writeFile(fakeRg, `#!/usr/bin/env node\nprocess.stderr.write(${JSON.stringify(stderr)});\nprocess.exit(2);\n`, {
    mode: 0o755
  });
  const { rg } = setupRgRuntime({ defaultCwd: directory, rgPath: fakeRg, readTimeoutMs: 5000 });
  const session = rg.search("needle").start();

  assert.equal(session.summary().stderrTruncated, false);
  await assert.rejects(
    session.next(10),
    (error) => {
      assert.equal(error instanceof RgProcessError, true);
      assert.equal(error.stderrTruncated, true);
      assert.equal(error.stderr.length <= 1024, true);
      assert.equal(error.stderrPreview.length < error.stderr.length, true);
      assert.equal(error.stderrPreview.split("\n").length <= 10, true);
      assert.equal(error.stderrPreview.includes("stderr-line-39"), true);
      assert.equal(JSON.stringify(error).includes(error.stderr), false);
      return true;
    }
  );
  const summary = session.summary();
  assert.equal(summary.stderrTruncated, true);
  assert.equal(summary.stderrPreview.split("\n").length <= 10, true);
  assert.equal(summary.stderrPreview.includes("stderr-line-39"), true);
  assert.equal(typeof summary.stderrBytes, "number");
  assert.equal(Object.hasOwn(summary, "stderr"), false);
  assert.equal(summary.stats.stderrTruncated, true);
  assert.equal(typeof summary.stats.stderrBytes, "number");
});
