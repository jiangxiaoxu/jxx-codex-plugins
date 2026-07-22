import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { pathToFileURL } from "node:url";
import { PersistentOAuthProvider } from "../dist/runtime/workspace-runtime.js";

test("PersistentOAuthProvider persists client, token, verifier, discovery, and state", async () => {
  const dir = await mkdtemp(join(tmpdir(), "figma-workspace-stdio-oauth-"));
  try {
    const statePath = join(dir, "state.json");
    const redirects = [];
    const provider = new PersistentOAuthProvider({
      redirectUrl: "http://127.0.0.1:18765/oauth/callback",
      clientMetadata: {
        client_name: "test-client",
        redirect_uris: ["http://127.0.0.1:18765/oauth/callback"],
      },
      statePath,
      onRedirect: (url) => redirects.push(url.toString()),
    });

    const generatedState = await provider.state();
    await provider.saveClientInformation({
      client_id: "client-1",
      client_secret: "secret-1",
    });
    await provider.saveTokens({
      access_token: "access-1",
      token_type: "Bearer",
      refresh_token: "refresh-1",
    });
    await provider.saveCodeVerifier("verifier-1");
    await provider.saveDiscoveryState({
      authorizationServerUrl: "https://auth.example.com",
    });
    await provider.redirectToAuthorization(new URL("https://auth.example.com/start"));

    const reloaded = new PersistentOAuthProvider({
      redirectUrl: "http://127.0.0.1:18765/oauth/callback",
      clientMetadata: {
        client_name: "test-client",
        redirect_uris: ["http://127.0.0.1:18765/oauth/callback"],
      },
      statePath,
    });

    assert.equal(await reloaded.expectedState(), generatedState);
    assert.deepEqual(await reloaded.clientInformation(), {
      client_id: "client-1",
      client_secret: "secret-1",
    });
    assert.deepEqual(await reloaded.tokens(), {
      access_token: "access-1",
      token_type: "Bearer",
      refresh_token: "refresh-1",
    });
    assert.equal(await reloaded.codeVerifier(), "verifier-1");
    assert.deepEqual(await reloaded.discoveryState(), {
      authorizationServerUrl: "https://auth.example.com",
    });
    assert.deepEqual(redirects, ["https://auth.example.com/start"]);

    await reloaded.invalidateCredentials("tokens");
    assert.equal(await reloaded.tokens(), undefined);
    assert.equal((await reloaded.clientInformation())?.client_id, "client-1");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("PersistentOAuthProvider can reuse and update the bridge OAuth cache file", async () => {
  const dir = await mkdtemp(join(tmpdir(), "figma-workspace-stdio-bridge-oauth-"));
  try {
    const statePath = join(dir, "figma-workspace-oauth.json");
    await writeFile(
      statePath,
      `${JSON.stringify(
        {
          clientInformation: {
            client_id: "bridge-client",
            client_secret: "bridge-secret",
          },
          tokens: {
            access_token: "bridge-access",
            refresh_token: "bridge-refresh",
            token_type: "Bearer",
            expires_at: Date.now() + 3600000,
          },
          updatedAt: "2026-06-14T00:00:00.000Z",
        },
        null,
        2,
      )}\n`,
    );

    const provider = new PersistentOAuthProvider({
      redirectUrl: "http://127.0.0.1:18765/oauth/callback",
      clientMetadata: {
        client_name: "test-client",
        redirect_uris: ["http://127.0.0.1:18765/oauth/callback"],
      },
      statePath,
    });

    assert.deepEqual(await provider.clientInformation(), {
      client_id: "bridge-client",
      client_secret: "bridge-secret",
    });
    assert.equal((await provider.tokens())?.access_token, "bridge-access");

    await provider.saveTokens({
      access_token: "stdio-access",
      refresh_token: "bridge-refresh",
      token_type: "Bearer",
    });

    const saved = JSON.parse(await readFile(statePath, "utf8"));
    assert.equal(saved.clientInformation.client_id, "bridge-client");
    assert.equal(saved.tokens.access_token, "stdio-access");
    assert.equal(saved.tokens.refresh_token, "bridge-refresh");
    assert.equal(saved.updatedAt, "2026-06-14T00:00:00.000Z");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("PersistentOAuthProvider serializes expired refresh flows across providers", async () => {
  const dir = await mkdtemp(join(tmpdir(), "figma-workspace-oauth-refresh-lock-"));
  try {
    const statePath = join(dir, "state.json");
    await writeFile(statePath, JSON.stringify({
      clientInformation: { client_id: "client-1" },
      tokens: {
        access_token: "expired-access",
        refresh_token: "refresh-1",
        token_type: "Bearer",
        expires_at: Date.now() - 1,
      },
    }));
    const createProvider = () => new PersistentOAuthProvider({
      redirectUrl: "http://127.0.0.1:18765/oauth/callback",
      clientMetadata: {
        client_name: "test-client",
        redirect_uris: ["http://127.0.0.1:18765/oauth/callback"],
      },
      statePath,
    });
    const first = createProvider();
    const second = createProvider();
    const observed = [];

    const firstRun = first.runWithRefreshLockIfNeeded(async () => {
      observed.push("first-start");
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 25));
      await first.saveTokens({
        access_token: "fresh-access",
        refresh_token: "refresh-2",
        token_type: "Bearer",
        expires_in: 3600,
      });
      observed.push("first-end");
    });
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 5));
    const secondRun = second.runWithRefreshLockIfNeeded(async () => {
      observed.push(`second:${(await second.tokens())?.access_token}`);
    });
    await Promise.all([firstRun, secondRun]);

    assert.deepEqual(observed, [
      "first-start",
      "first-end",
      "second:fresh-access",
    ]);
    const saved = JSON.parse(await readFile(statePath, "utf8"));
    assert.equal(saved.tokens.refresh_token, "refresh-2");
    assert.ok(saved.tokens.expires_at > Date.now() + 3_500_000);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("PersistentOAuthProvider serializes and upgrades legacy tokens without expires_at", async () => {
  const dir = await mkdtemp(join(tmpdir(), "figma-workspace-oauth-legacy-lock-"));
  try {
    const statePath = join(dir, "state.json");
    await writeFile(statePath, JSON.stringify({
      clientInformation: { client_id: "client-1" },
      tokens: {
        access_token: "legacy-access",
        refresh_token: "refresh-1",
        token_type: "Bearer",
      },
    }));
    const createProvider = () => new PersistentOAuthProvider({
      redirectUrl: "http://127.0.0.1:18765/oauth/callback",
      clientMetadata: {
        client_name: "test-client",
        redirect_uris: ["http://127.0.0.1:18765/oauth/callback"],
      },
      statePath,
    });
    const first = createProvider();
    const second = createProvider();
    const observed = [];

    const firstRun = first.runWithRefreshLockIfNeeded(async () => {
      observed.push(`first:${(await first.tokens())?.access_token}`);
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 25));
      await first.saveTokens({
        access_token: "fresh-access",
        refresh_token: "refresh-2",
        token_type: "Bearer",
        expires_in: 3600,
      });
      observed.push("first-end");
    });
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 5));
    const secondRun = second.runWithRefreshLockIfNeeded(async () => {
      const tokens = await second.tokens();
      observed.push(`second:${tokens?.access_token}`);
      assert.equal(typeof tokens?.expires_at, "number");
    });
    await Promise.all([firstRun, secondRun]);

    assert.deepEqual(observed, [
      "first:legacy-access",
      "first-end",
      "second:fresh-access",
    ]);
    const saved = JSON.parse(await readFile(statePath, "utf8"));
    assert.equal(saved.tokens.refresh_token, "refresh-2");
    assert.ok(saved.tokens.expires_at > Date.now() + 3_500_000);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("PersistentOAuthProvider prevents two processes from rotating one legacy refresh token", async () => {
  const dir = await mkdtemp(join(tmpdir(), "figma-workspace-oauth-legacy-processes-"));
  try {
    const statePath = join(dir, "state.json");
    const goPath = join(dir, "go");
    const readyPaths = [join(dir, "ready-1"), join(dir, "ready-2")];
    await writeFile(statePath, JSON.stringify({
      clientInformation: { client_id: "client-1" },
      tokens: {
        access_token: "legacy-access",
        refresh_token: "refresh-1",
        token_type: "Bearer",
      },
    }));

    const workers = readyPaths.map((readyPath) => runLegacyRefreshWorker({
      statePath,
      readyPath,
      goPath,
    }));
    await Promise.all(readyPaths.map((path) => waitForFile(path)));
    await writeFile(goPath, "go");
    const results = await Promise.all(workers);

    assert.equal(results.filter((result) => result.refreshed).length, 1);
    assert.equal(results.filter((result) => result.observed === "legacy-access").length, 1);
    const saved = JSON.parse(await readFile(statePath, "utf8"));
    assert.match(saved.tokens.access_token, /^fresh-/u);
    assert.equal(saved.tokens.refresh_token, "refresh-2");
    assert.ok(saved.tokens.expires_at > Date.now() + 3_500_000);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("PersistentOAuthProvider does not serialize a token with a proven future expiry", async () => {
  const dir = await mkdtemp(join(tmpdir(), "figma-workspace-oauth-fresh-token-"));
  try {
    const statePath = join(dir, "state.json");
    await writeFile(statePath, JSON.stringify({
      clientInformation: { client_id: "client-1" },
      tokens: {
        access_token: "fresh-access",
        refresh_token: "refresh-1",
        token_type: "Bearer",
        expires_at: Date.now() + 3_600_000,
      },
    }));
    const createProvider = () => new PersistentOAuthProvider({
      redirectUrl: "http://127.0.0.1:18765/oauth/callback",
      clientMetadata: {
        client_name: "test-client",
        redirect_uris: ["http://127.0.0.1:18765/oauth/callback"],
      },
      statePath,
    });
    const first = createProvider();
    const second = createProvider();
    let releaseFirst;
    const firstBlocked = new Promise((resolvePromise) => {
      releaseFirst = resolvePromise;
    });
    let markFirstStarted;
    const firstStarted = new Promise((resolvePromise) => {
      markFirstStarted = resolvePromise;
    });
    let secondStarted = false;

    const firstRun = first.runWithRefreshLockIfNeeded(async () => {
      markFirstStarted();
      await firstBlocked;
    });
    await firstStarted;
    const secondRun = second.runWithRefreshLockIfNeeded(async () => {
      secondStarted = true;
    });
    await secondRun;

    assert.equal(secondStarted, true);
    releaseFirst();
    await firstRun;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

function runLegacyRefreshWorker({ statePath, readyPath, goPath }) {
  const moduleUrl = pathToFileURL(
    resolve("dist/runtime/workspace-runtime.js"),
  ).href;
  const worker = [
    `import { PersistentOAuthProvider } from ${JSON.stringify(moduleUrl)};`,
    'import { readFile, writeFile } from "node:fs/promises";',
    "const provider = new PersistentOAuthProvider({",
    '  redirectUrl: "http://127.0.0.1:18765/oauth/callback",',
    "  clientMetadata: {",
    '    client_name: "test-client",',
    '    redirect_uris: ["http://127.0.0.1:18765/oauth/callback"],',
    "  },",
    "  statePath: process.env.TEST_STATE_PATH,",
    "});",
    'await writeFile(process.env.TEST_READY_PATH, "ready");',
    "while (true) {",
    "  try {",
    "    await readFile(process.env.TEST_GO_PATH);",
    "    break;",
    "  } catch (error) {",
    '    if (error?.code !== "ENOENT") throw error;',
    "    await new Promise((resolvePromise) => setTimeout(resolvePromise, 5));",
    "  }",
    "}",
    "let observed;",
    "let refreshed = false;",
    "await provider.runWithRefreshLockIfNeeded(async () => {",
    "  const tokens = await provider.tokens();",
    "  observed = tokens?.access_token;",
    '  if (observed === "legacy-access") {',
    "    refreshed = true;",
    "    await new Promise((resolvePromise) => setTimeout(resolvePromise, 100));",
    "    await provider.saveTokens({",
    "      access_token: `fresh-${process.pid}` ,",
    '      refresh_token: "refresh-2",',
    '      token_type: "Bearer",',
    "      expires_in: 3600,",
    "    });",
    "  }",
    "});",
    "console.log(JSON.stringify({ observed, refreshed }));",
  ].join("\n");

  return new Promise((resolvePromise, reject) => {
    const child = spawn(process.execPath, ["--input-type=module", "--eval", worker], {
      env: {
        ...process.env,
        TEST_STATE_PATH: statePath,
        TEST_READY_PATH: readyPath,
        TEST_GO_PATH: goPath,
      },
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("exit", (code, signal) => {
      if (code === 0 && !signal) {
        resolvePromise(JSON.parse(stdout));
      } else {
        reject(new Error(`OAuth worker failed (${signal ?? code}): ${stderr}`));
      }
    });
  });
}

async function waitForFile(path) {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    try {
      await readFile(path);
      return;
    } catch (error) {
      if (error?.code !== "ENOENT") {
        throw error;
      }
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 5));
    }
  }
  throw new Error(`Timed out waiting for worker readiness: ${path}`);
}
