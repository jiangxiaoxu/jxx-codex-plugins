import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, open, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import {
  AtomicCredentialStore,
  restoreQuarantinedCredentialLock,
} from "../dist/auth/credential-store.js";
import { removeOAuthCacheForForceLogin } from "../scripts/login-figma-http.mjs";

const parseState = (json) => {
  const value = JSON.parse(json);
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
};

test("AtomicCredentialStore writes atomically with private permissions and no residue", async () => {
  const dir = await mkdtemp(join(tmpdir(), "figma-oauth-store-"));
  try {
    const path = join(dir, "oauth.json");
    const store = new AtomicCredentialStore(path, {
      empty: () => ({}),
      parse: parseState,
    });
    await store.write({ tokens: { access_token: "secret" } });

    assert.deepEqual(JSON.parse(await readFile(path, "utf8")), {
      tokens: { access_token: "secret" },
    });
    assert.deepEqual(await readdir(dir), ["oauth.json"]);
    if (process.platform !== "win32") {
      assert.equal((await stat(path)).mode & 0o777, 0o600);
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("AtomicCredentialStore CAS does not clear a newer credential", async () => {
  const dir = await mkdtemp(join(tmpdir(), "figma-oauth-store-cas-"));
  try {
    const path = join(dir, "oauth.json");
    const store = new AtomicCredentialStore(path, {
      empty: () => ({}),
      parse: parseState,
    });
    await store.write({ value: 1 });
    const stale = await store.readSnapshot();
    await store.write({ value: 2 });

    assert.equal(await store.clear(stale.fingerprint), false);
    assert.deepEqual(await store.read(), { value: 2 });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("AtomicCredentialStore immediately reclaims a dead process lock", async () => {
  const dir = await mkdtemp(join(tmpdir(), "figma-oauth-store-dead-lock-"));
  try {
    const path = join(dir, "oauth.json");
    const store = new AtomicCredentialStore(path, {
      empty: () => ({}),
      parse: parseState,
      lockTimeoutMs: 2_000,
    });
    await writeFile(`${path}.lock`, JSON.stringify({
      pid: 2_147_483_647,
      nonce: "dead-owner",
      createdAt: Date.now(),
    }));

    await store.write({ recovered: true });
    assert.deepEqual(await store.read(), { recovered: true });
    assert.deepEqual(await readdir(dir), ["oauth.json"]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

for (const contentionCode of ["EPERM", "EBUSY"]) {
  test(`AtomicCredentialStore retries observable Windows ${contentionCode} lock contention`, async () => {
    const dir = await mkdtemp(join(tmpdir(), "figma-oauth-store-windows-contention-"));
    try {
      const path = join(dir, "oauth.json");
      await writeFile(`${path}.lock`, JSON.stringify({
        pid: 2_147_483_647,
        nonce: "dead-owner",
        createdAt: Date.now(),
      }));
      let lockOpenCalls = 0;
      const store = new AtomicCredentialStore(path, {
        empty: () => ({}),
        parse: parseState,
        lockTimeoutMs: 2_000,
        platform: "win32",
        lockOpen: async (...args) => {
          lockOpenCalls += 1;
          if (lockOpenCalls === 1) {
            throw Object.assign(new Error(`injected ${contentionCode}`), {
              code: contentionCode,
              path: `${path}.lock`,
              syscall: "open",
            });
          }
          return open(...args);
        },
      });

      await store.write({ recovered: true });
      assert.equal(lockOpenCalls, 2);
      assert.deepEqual(await store.read(), { recovered: true });
      assert.deepEqual(await readdir(dir), ["oauth.json"]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
}

test("AtomicCredentialStore does not retry Windows EPERM without an observable lock", async () => {
  const dir = await mkdtemp(join(tmpdir(), "figma-oauth-store-windows-permission-"));
  try {
    const path = join(dir, "oauth.json");
    const permissionError = Object.assign(new Error("injected permission failure"), {
      code: "EPERM",
      path: `${path}.lock`,
      syscall: "open",
    });
    let lockOpenCalls = 0;
    const store = new AtomicCredentialStore(path, {
      empty: () => ({}),
      parse: parseState,
      platform: "win32",
      lockOpen: async () => {
        lockOpenCalls += 1;
        throw permissionError;
      },
    });

    await assert.rejects(store.write({ forbidden: true }), (error) => error === permissionError);
    assert.equal(lockOpenCalls, 1);
    assert.deepEqual(await readdir(dir), []);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("AtomicCredentialStore times out without replacing a live Windows lock after EPERM", async () => {
  const dir = await mkdtemp(join(tmpdir(), "figma-oauth-store-windows-live-lock-"));
  try {
    const path = join(dir, "oauth.json");
    const liveOwner = `${JSON.stringify({
      pid: process.pid,
      nonce: "live-owner",
      createdAt: Date.now(),
    })}\n`;
    await writeFile(`${path}.lock`, liveOwner);
    const store = new AtomicCredentialStore(path, {
      empty: () => ({}),
      parse: parseState,
      lockTimeoutMs: 0,
      platform: "win32",
      lockOpen: async () => {
        throw Object.assign(new Error("injected lock contention"), {
          code: "EPERM",
          path: `${path}.lock`,
          syscall: "open",
        });
      },
    });

    await assert.rejects(store.write({ forbidden: true }), /Timed out waiting/u);
    assert.equal(await readFile(`${path}.lock`, "utf8"), liveOwner);
    assert.deepEqual(await readdir(dir), ["oauth.json.lock"]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("credential lock quarantine recovery never overwrites a new canonical lock", async () => {
  const dir = await mkdtemp(join(tmpdir(), "figma-oauth-store-lock-race-"));
  try {
    const canonicalPath = join(dir, "oauth.json.lock");
    const quarantinePath = `${canonicalPath}.reclaim`;
    await writeFile(quarantinePath, "dead lock\n");
    await writeFile(canonicalPath, "live lock\n");

    await assert.rejects(
      restoreQuarantinedCredentialLock(quarantinePath, canonicalPath),
      /refusing to overwrite the canonical lock/u,
    );
    assert.equal(await readFile(canonicalPath, "utf8"), "live lock\n");
    assert.equal(await readFile(quarantinePath, "utf8"), "dead lock\n");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("credential lock quarantine recovery fails closed when hard links are unsupported", async () => {
  const dir = await mkdtemp(join(tmpdir(), "figma-oauth-store-link-unsupported-"));
  try {
    const canonicalPath = join(dir, "oauth.json.lock");
    const quarantinePath = `${canonicalPath}.reclaim`;
    await mkdir(quarantinePath);

    await assert.rejects(
      restoreQuarantinedCredentialLock(quarantinePath, canonicalPath),
      /exclusive hard-link restore failed/u,
    );
    await assert.rejects(readFile(canonicalPath), (error) => error?.code === "ENOENT");
    assert.equal((await stat(quarantinePath)).isDirectory(), true);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("force-login rollback restores only its own marker and preserves concurrent credentials", async (t) => {
  t.mock.method(console, "log", () => undefined);
  t.mock.method(console, "error", () => undefined);
  const dir = await mkdtemp(join(tmpdir(), "figma-oauth-force-login-race-"));
  try {
    const path = join(dir, "oauth.json");
    const previous = Buffer.from('{"tokens":{"access_token":"previous"}}\n');
    const concurrent = Buffer.from('{"tokens":{"access_token":"concurrent"}}\n');
    await writeFile(path, previous, { mode: 0o600 });

    const rollbackOwnMarker = await removeOAuthCacheForForceLogin(path);
    assert.equal(await rollbackOwnMarker(), true);
    assert.deepEqual(await readFile(path), previous);

    const rollbackMissingCache = await removeOAuthCacheForForceLogin(path);
    await rm(path);
    assert.equal(await rollbackMissingCache(), true);
    assert.deepEqual(await readFile(path), previous);

    const rollbackConflict = await removeOAuthCacheForForceLogin(path);
    await writeFile(path, concurrent, { mode: 0o600 });
    assert.equal(await rollbackConflict(), false);
    assert.deepEqual(await readFile(path), concurrent);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("force-login rollback removes its marker when no credential existed", async (t) => {
  t.mock.method(console, "log", () => undefined);
  t.mock.method(console, "error", () => undefined);
  const dir = await mkdtemp(join(tmpdir(), "figma-oauth-force-login-empty-"));
  try {
    const path = join(dir, "oauth.json");
    const rollback = await removeOAuthCacheForForceLogin(path);
    assert.equal(await rollback(), true);
    await assert.rejects(readFile(path), (error) => error?.code === "ENOENT");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("AtomicCredentialStore serializes updates across processes", async () => {
  const dir = await mkdtemp(join(tmpdir(), "figma-oauth-store-processes-"));
  try {
    const path = join(dir, "oauth.json");
    const moduleUrl = pathToFileURL(
      resolve("dist/auth/credential-store.js"),
    ).href;
    const worker = [
      `import { AtomicCredentialStore } from ${JSON.stringify(moduleUrl)};`,
      "const store = new AtomicCredentialStore(process.env.TEST_STORE_PATH, {",
      "  empty: () => ({ count: 0 }),",
      "  parse: (json) => JSON.parse(json),",
      "});",
      "await store.update((state) => ({ count: (state.count ?? 0) + 1 }));",
    ].join("\n");

    await Promise.all(Array.from({ length: 8 }, () => runWorker(worker, path)));
    assert.deepEqual(JSON.parse(await readFile(path, "utf8")), { count: 8 });
    assert.deepEqual(await readdir(dir), ["oauth.json"]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

function runWorker(source, path) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(process.execPath, ["--input-type=module", "-e", source], {
      env: { ...process.env, TEST_STORE_PATH: path },
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    let stderr = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0 && !signal) {
        resolvePromise();
        return;
      }
      reject(new Error(`credential worker failed (${signal ?? code}): ${stderr}`));
    });
  });
}
