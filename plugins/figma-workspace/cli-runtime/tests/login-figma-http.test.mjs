import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { main as runLogin } from "../scripts/login-figma-http.mjs";

test("force login rolls back its marker when bridge startup fails", async (t) => {
  t.mock.method(console, "log", () => undefined);
  t.mock.method(console, "error", () => undefined);
  const dir = await mkdtemp(join(tmpdir(), "figma-oauth-login-startup-"));
  try {
    const cachePath = join(dir, "oauth.json");
    const previous = Buffer.from('{"tokens":{"access_token":"previous"}}\n');
    await writeFile(cachePath, previous, { mode: 0o600 });
    const invocations = [];

    await assert.rejects(
      runLogin({
        argv: ["--force"],
        env: { FIGMA_WORKSPACE_OAUTH_CACHE_PATH: cachePath },
        ensureCommandAvailable: async () => undefined,
        startBridge: async () => {
          throw new Error("bridge startup failed");
        },
        invokeCodexMcp: async (args, options) => {
          invocations.push({ args, options });
          return 0;
        },
      }),
      /bridge startup failed/u,
    );

    assert.deepEqual(await readFile(cachePath), previous);
    assert.deepEqual(await readdir(dir), ["oauth.json"]);
    assert.deepEqual(invocations, [{
      args: ["mcp", "remove", "figma-http"],
      options: { ignoreFailure: true },
    }]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("force login removes its marker after bridge startup fails without an old cache", async (t) => {
  t.mock.method(console, "log", () => undefined);
  t.mock.method(console, "error", () => undefined);
  const dir = await mkdtemp(join(tmpdir(), "figma-oauth-login-empty-startup-"));
  try {
    const cachePath = join(dir, "oauth.json");

    await assert.rejects(
      runLogin({
        argv: ["--force"],
        env: { FIGMA_WORKSPACE_OAUTH_CACHE_PATH: cachePath },
        ensureCommandAvailable: async () => undefined,
        startBridge: async () => {
          throw new Error("bridge startup failed");
        },
        invokeCodexMcp: async () => 0,
      }),
      /bridge startup failed/u,
    );

    await assert.rejects(readFile(cachePath), (error) => error?.code === "ENOENT");
    assert.deepEqual(await readdir(dir), []);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("force login preserves a concurrent credential when bridge startup fails", async (t) => {
  t.mock.method(console, "log", () => undefined);
  t.mock.method(console, "error", () => undefined);
  const dir = await mkdtemp(join(tmpdir(), "figma-oauth-login-conflict-"));
  try {
    const cachePath = join(dir, "oauth.json");
    const previous = Buffer.from('{"tokens":{"access_token":"previous"}}\n');
    const concurrent = Buffer.from('{"tokens":{"access_token":"concurrent"}}\n');
    await writeFile(cachePath, previous, { mode: 0o600 });

    await assert.rejects(
      runLogin({
        argv: ["--force"],
        env: { FIGMA_WORKSPACE_OAUTH_CACHE_PATH: cachePath },
        ensureCommandAvailable: async () => undefined,
        startBridge: async () => {
          await writeFile(cachePath, concurrent, { mode: 0o600 });
          throw new Error("bridge startup failed");
        },
        invokeCodexMcp: async () => 0,
      }),
      /bridge startup failed/u,
    );

    assert.deepEqual(await readFile(cachePath), concurrent);
    assert.deepEqual(await readdir(dir), ["oauth.json"]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
