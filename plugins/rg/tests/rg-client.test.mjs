import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

import { RgProcessError, setupRgRuntime } from "../scripts/rg-client.mjs";

const SEARCH_TEXT_MAX_BYTES = 12 * 1024;
const DRAIN_TEXT_MAX_BYTES = 16 * 1024;

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

async function setupAvailableRuntime(t, directory, options = {}) {
  const { rg } = setupRgRuntime({ ...options, defaultCwd: directory, readTimeoutMs: 5000 });
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
      assert.match(error.message, /rg search failed with exit code 2\./);
      assert.match(error.message, /unclosed character class/);
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

  const session = rg.files().glob("[").start();

  await assert.rejects(
    session.next(10),
    (error) => {
      assert.equal(error instanceof RgProcessError, true);
      assert.equal(error.kind, "files");
      assert.deepEqual(error.args, ["--files", "--glob", "["]);
      assert.equal(error.cwd, directory);
      assert.equal(error.exitCode > 1, true);
      assert.equal(error.stderrTruncated, false);
      return true;
    }
  );
});

test("trimmed builder and runtime APIs are unavailable", async (t) => {
  const directory = await withFixture(t);
  const { rg } = setupRgRuntime({ defaultCwd: directory });

  assert.equal(typeof rg.createSearch, "undefined");
  assert.equal(typeof rg.createFiles, "undefined");
  assert.equal(typeof rg.search("x").context, "undefined");
  assert.equal(typeof rg.search("x").word, "undefined");
  assert.equal(typeof rg.search("x").follow, "undefined");
  assert.equal(typeof rg.files().args, "undefined");
  assert.equal(typeof rg.files().follow, "undefined");
});

test("SearchSession.next returns heading text with context block separators", async (t) => {
  const directory = await withFixture(t);
  const rg = await setupAvailableRuntime(t, directory);
  if (!rg) {
    return;
  }

  const session = rg.search("match").path("alpha.txt").beforeContext(1).afterContext(1).start();
  const batch = await session.next(2);
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

test("SearchBuilder.next returns first batch and auto-cancels truncated sessions", async (t) => {
  const directory = await withFixture(t);
  const rg = await setupAvailableRuntime(t, directory);
  if (!rg) {
    return;
  }

  const batch = await rg.search("match").path("alpha.txt").beforeContext(1).afterContext(1).next(2);

  assert.equal(batch.info, "maxBlocks");
  assert.equal(
    batch.text,
    ["alpha.txt", "1-one", "2:match-a", "3-three", "--", "5-five", "6:match-b", "7-seven"].join("\n")
  );
  assert.deepEqual(rg.sessions(), []);
});

test("SearchBuilder.drain reads complete small result and leaves no active session", async (t) => {
  const directory = await withFixture(t);
  const rg = await setupAvailableRuntime(t, directory);
  if (!rg) {
    return;
  }

  const batch = await rg.search("match").path("adjacent.txt").drain();

  assert.equal(batch.info, "done");
  assert.equal(batch.text, ["adjacent.txt", "2:match left", "3:match right"].join("\n"));
  assert.deepEqual(rg.sessions(), []);
});

test("SearchBuilder.show writes search text and returns the drained batch", async (t) => {
  const directory = await withFixture(t);
  const writes = [];
  const rg = await setupAvailableRuntime(t, directory, { write: (text) => writes.push(text) });
  if (!rg) {
    return;
  }

  const batch = await rg.search("match").path("adjacent.txt").show();

  assert.equal(batch.info, "done");
  assert.equal(writes.join(""), ["adjacent.txt", "2:match left", "3:match right"].join("\n"));
  assert.deepEqual(rg.sessions(), []);
});

test("SearchSession.next omits match-only block separators and uses paths only as headings", async (t) => {
  const directory = await withFixture(t);
  const rg = await setupAvailableRuntime(t, directory);
  if (!rg) {
    return;
  }

  const session = rg.search("match").path("alpha.txt").path("adjacent.txt").start();
  const batch = await session.next(10);

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
  const batch = await session.next(500);
  await session.cancel();

  assert.equal(batch.info, "maxTextBytes");
  assert.equal(Buffer.byteLength(batch.text, "utf8") <= SEARCH_TEXT_MAX_BYTES, true);
});

test("SearchSession.drain caps large text batches at 16KB", async (t) => {
  const directory = await withFixture(t);
  const rg = await setupAvailableRuntime(t, directory);
  if (!rg) {
    return;
  }

  const lines = Array.from({ length: 160 }, (_, index) => `needle-${index}-${"x".repeat(180)}`).join("\n");
  await writeFile(join(directory, "large-drain.txt"), `${lines}\n`);

  const session = rg.search("needle").path("large-drain.txt").start();
  const batch = await session.drain();
  await session.cancel();

  assert.equal(batch.info, "maxTextBytes");
  assert.equal(Buffer.byteLength(batch.text, "utf8") <= DRAIN_TEXT_MAX_BYTES, true);
});

test("SearchSession.next truncates a single long line within the 12KB cap", async (t) => {
  const directory = await withFixture(t);
  const rg = await setupAvailableRuntime(t, directory);
  if (!rg) {
    return;
  }

  await writeFile(join(directory, "long-line.txt"), `${"x".repeat(30 * 1024)}needle\n`);

  const session = rg.search("needle").path("long-line.txt").start();
  const batch = await session.next(10);
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

  const session = rg.search("match").path("alpha.txt").beforeContext(1).afterContext(1).start();
  const first = await session.next(2);
  const second = await session.next(2);

  assert.equal(first.info, "maxBlocks");
  assert.equal(
    first.text,
    ["alpha.txt", "1-one", "2:match-a", "3-three", "--", "5-five", "6:match-b", "7-seven"].join("\n")
  );
  assert.equal(second.info, "done");
  assert.equal(second.text, ["alpha.txt", "9-nine", "10:match-c", "11-ten"].join("\n"));
});

test("SearchSession.drain after next returns only remaining output", async (t) => {
  const directory = await withFixture(t);
  const rg = await setupAvailableRuntime(t, directory);
  if (!rg) {
    return;
  }

  const session = rg.search("match").path("alpha.txt").beforeContext(1).afterContext(1).start();
  const first = await session.next(2);
  const remaining = await session.drain();

  assert.equal(first.info, "maxBlocks");
  assert.equal(remaining.info, "done");
  assert.equal(remaining.text, ["alpha.txt", "9-nine", "10:match-c", "11-ten"].join("\n"));
});

test("SearchSession.show after next writes only remaining output", async (t) => {
  const directory = await withFixture(t);
  const writes = [];
  const rg = await setupAvailableRuntime(t, directory, { write: (text) => writes.push(text) });
  if (!rg) {
    return;
  }

  const session = rg.search("match").path("alpha.txt").beforeContext(1).afterContext(1).start();
  const first = await session.next(2);
  const remaining = await session.show();

  assert.equal(first.info, "maxBlocks");
  assert.equal(remaining.info, "done");
  assert.equal(writes.join(""), ["alpha.txt", "9-nine", "10:match-c", "11-ten"].join("\n"));
});

test("SearchSession rejects object input", async (t) => {
  const directory = await withFixture(t);
  const rg = await setupAvailableRuntime(t, directory);
  if (!rg) {
    return;
  }

  const session = rg.search("match").start();

  await assert.rejects(session.next({ maxBlocks: 2 }), /only accepts a positive integer count/);
  await assert.rejects(session.next({ timeoutMs: 1 }), /only accepts a positive integer count/);
  await assert.rejects(session.next({ maxResults: 1 }), /only accepts a positive integer count/);
  await assert.rejects(session.next(-1), /only accepts a positive integer count/);
  await assert.rejects(session.drain(1), /does not accept arguments/);
  await assert.rejects(session.show(1), /does not accept arguments/);
  await assert.rejects(rg.search("match").drain(1), /does not accept arguments/);
  await assert.rejects(rg.search("match").show(1), /does not accept arguments/);
  await session.cancel();
});

test("FilesBuilder.next returns first batch and auto-cancels truncated sessions", async (t) => {
  const directory = await withFixture(t);
  const rg = await setupAvailableRuntime(t, directory);
  if (!rg) {
    return;
  }

  const batch = await rg.files().next(1);

  assert.equal(batch.files.length, 1);
  assert.equal(batch.truncated, true);
  assert.equal(batch.stopReason, "maxFiles");
  assert.deepEqual(rg.sessions(), []);
});

test("FilesBuilder.drain reads complete result and leaves no active session", async (t) => {
  const directory = await withFixture(t);
  const rg = await setupAvailableRuntime(t, directory);
  if (!rg) {
    return;
  }

  const batch = await rg.files().drain();

  assert.deepEqual(new Set(batch.files), new Set(["alpha.txt", "adjacent.txt", "beta.txt"]));
  assert.equal(batch.done, true);
  assert.equal(batch.truncated, false);
  assert.equal(batch.readTimedOut, false);
  assert.equal(batch.stopReason, "done");
  assert.deepEqual(rg.sessions(), []);
});

test("FilesBuilder.show writes file paths and returns the drained batch", async (t) => {
  const directory = await withFixture(t);
  const writes = [];
  const rg = await setupAvailableRuntime(t, directory, { write: (text) => writes.push(text) });
  if (!rg) {
    return;
  }

  const batch = await rg.files().show();

  assert.deepEqual(new Set(batch.files), new Set(["alpha.txt", "adjacent.txt", "beta.txt"]));
  assert.deepEqual(new Set(writes.join("").split("\n")), new Set(["alpha.txt", "adjacent.txt", "beta.txt"]));
  assert.deepEqual(rg.sessions(), []);
});

test("FileSession uses maxFiles as the truncation stop reason", async (t) => {
  const directory = await withFixture(t);
  const rg = await setupAvailableRuntime(t, directory);
  if (!rg) {
    return;
  }

  const session = rg.files().start();
  const batch = await session.next(1);
  await session.cancel();

  assert.equal(batch.files.length, 1);
  assert.equal(batch.truncated, true);
  assert.equal(batch.stopReason, "maxFiles");
});

test("FileSession.drain after next returns only remaining files", async (t) => {
  const directory = await withFixture(t);
  const rg = await setupAvailableRuntime(t, directory);
  if (!rg) {
    return;
  }

  const session = rg.files().start();
  const first = await session.next(1);
  const remaining = await session.drain();

  assert.equal(first.files.length, 1);
  assert.equal(remaining.files.includes(first.files[0]), false);
  assert.deepEqual(new Set([...first.files, ...remaining.files]), new Set(["alpha.txt", "adjacent.txt", "beta.txt"]));
  assert.equal(remaining.done, true);
  assert.equal(remaining.truncated, false);
  assert.equal(remaining.stopReason, "done");
});

test("FileSession.show after next writes only remaining files", async (t) => {
  const directory = await withFixture(t);
  const writes = [];
  const rg = await setupAvailableRuntime(t, directory, { write: (text) => writes.push(text) });
  if (!rg) {
    return;
  }

  const session = rg.files().start();
  const first = await session.next(1);
  const remaining = await session.show();

  assert.equal(first.files.length, 1);
  assert.equal(remaining.files.includes(first.files[0]), false);
  assert.deepEqual(new Set(writes.join("").split("\n")), new Set(remaining.files));
  assert.equal(remaining.stopReason, "done");
});

test("session.cancel uses fixed internal timing and rejects arguments", async (t) => {
  const directory = await withFixture(t);
  const rg = await setupAvailableRuntime(t, directory);
  if (!rg) {
    return;
  }

  const session = rg.search("match").start();
  const result = await session.cancel();
  assert.equal(typeof result.cancelled, "boolean");
  assert.deepEqual(rg.sessions(), []);

  const invalid = rg.search("match").start();
  await assert.rejects(invalid.cancel("fast"), /does not accept arguments/);
  await assert.rejects(invalid.cancel({ graceMs: 50 }), /does not accept arguments/);
  await invalid.cancel();
});

test("FileSession rejects object input", async (t) => {
  const directory = await withFixture(t);
  const rg = await setupAvailableRuntime(t, directory);
  if (!rg) {
    return;
  }

  const session = rg.files().start();

  await assert.rejects(session.next({ maxFiles: 1 }), /only accepts a positive integer count/);
  await assert.rejects(session.next({ timeoutMs: 1 }), /only accepts a positive integer count/);
  await assert.rejects(session.next(-1), /only accepts a positive integer count/);
  await assert.rejects(session.drain(1), /does not accept arguments/);
  await assert.rejects(session.show(1), /does not accept arguments/);
  await assert.rejects(rg.files().drain(1), /does not accept arguments/);
  await assert.rejects(rg.files().show(1), /does not accept arguments/);
  await session.cancel();
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
  assert.equal(capped.stdout.length > 0, true);

  const expanded = await rg.raw(["x", "large.txt"], {
    cwd: directory,
    maxBytes: 40 * 1024
  });
  assert.equal(expanded.truncated, false);
  assert.equal(expanded.stdout.length > 16 * 1024, true);
});

test("raw keeps partial chunks when maxBytes truncates output", async (t) => {
  const directory = await withFixture(t);
  const rg = await setupAvailableRuntime(t, directory);
  if (!rg) {
    return;
  }

  await writeFile(join(directory, "large.txt"), `${"x".repeat(30 * 1024)}\n`);

  const capped = await rg.raw(["x", "large.txt"], { cwd: directory, maxBytes: 80 });

  assert.equal(capped.truncated, true);
  assert.equal(capped.stdout.length > 0, true);
  assert.equal(Buffer.byteLength(capped.stdout) <= 80, true);
});

test("rg.show writes raw stdout and returns the resolved value", async (t) => {
  const directory = await withFixture(t);
  const writes = [];
  const rg = await setupAvailableRuntime(t, directory, { write: (text) => writes.push(text) });
  if (!rg) {
    return;
  }

  const raw = await rg.raw(["--version"], { maxBytes: 1024, timeoutMs: 5000 }).then(rg.show);

  assert.equal(typeof raw.stdout, "string");
  assert.equal(writes.join(""), raw.stdout);
});
