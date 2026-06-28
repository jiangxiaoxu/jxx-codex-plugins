import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import {
  DEFAULT_FIGMA_WORKSPACE_ENDPOINT,
  createCallbackUrl,
  createConfig,
  findCodexHomeOAuthCachePath,
} from "../dist/mcp/index.js";

test("createConfig applies Figma MCP defaults", () => {
  const config = createConfig({ openBrowser: false });

  assert.equal(config.endpoint, DEFAULT_FIGMA_WORKSPACE_ENDPOINT);
  assert.equal(config.callbackHost, "127.0.0.1");
  assert.equal(config.callbackPort, 18765);
  assert.equal(config.callbackPath, "/oauth/callback");
  assert.equal(config.callbackUrl, "http://127.0.0.1:18765/oauth/callback");
  assert.equal(config.openBrowser, false);
  assert.match(config.statePath, /figma-workspace[\\/]mcp-server[\\/]dist[\\/]\.mcp-oauth-state\.json$/);
  assert.deepEqual(config.clientMetadata.redirect_uris, [
    "http://127.0.0.1:18765/oauth/callback",
  ]);
});

test("createConfig uses USERPROFILE .codex as the bridge OAuth cache path", async () => {
  const dir = await mkdtemp(join(tmpdir(), "figma-workspace-stdio-home-config-"));
  const cachePath = join(dir, ".codex", ".figma-workspace-oauth.json");
  withEnv(
    {
      CODEX_HOME: undefined,
      USERPROFILE: dir,
    },
    () => {
      const config = createConfig({
        useBridgeOAuthCache: true,
        openBrowser: false,
      });

      assert.equal(config.statePath, cachePath);
      assert.equal(config.useBridgeOAuthCache, true);
    },
  );
  await rm(dir, { recursive: true, force: true });
});

test("createConfig accepts an explicit shared OAuth cache path", () => {
  const config = createConfig({
    statePath: "C:/Users/jxx73/.codex/figma-workspace-oauth.json",
    openBrowser: false,
  });

  assert.match(config.statePath, /figma-workspace-oauth\.json$/);
});

test("createConfig uses FIGMA_WORKSPACE_OAUTH_CACHE_PATH first", async () => {
  const dir = await mkdtemp(join(tmpdir(), "figma-workspace-stdio-cache-path-"));
  try {
    const cachePath = join(dir, "custom-oauth.json");
    withEnv(
      {
        FIGMA_WORKSPACE_OAUTH_CACHE_PATH: cachePath,
        CODEX_HOME: "C:/ignored-codex-home",
        USERPROFILE: "C:/ignored-userprofile",
      },
      () => {
        const config = createConfig({
          useBridgeOAuthCache: true,
          openBrowser: false,
        });
        assert.equal(config.statePath, cachePath);
      },
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("createConfig uses CODEX_HOME as the bridge OAuth cache location", async () => {
  const dir = await mkdtemp(join(tmpdir(), "figma-workspace-stdio-codex-home-"));
  try {
    const cachePath = join(dir, ".figma-workspace-oauth.json");

    assert.equal(
      findCodexHomeOAuthCachePath({ CODEX_HOME: dir }),
      cachePath,
    );

    const previous = process.env.CODEX_HOME;
    process.env.CODEX_HOME = dir;
    try {
      const config = createConfig({
        useBridgeOAuthCache: true,
        openBrowser: false,
      });
      assert.equal(config.statePath, cachePath);
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

test("findCodexHomeOAuthCachePath uses USERPROFILE .codex when CODEX_HOME is missing", async () => {
  const dir = await mkdtemp(join(tmpdir(), "figma-workspace-stdio-home-"));
  try {
    const cachePath = join(dir, ".codex", ".figma-workspace-oauth.json");

    assert.equal(findCodexHomeOAuthCachePath({ USERPROFILE: dir }), cachePath);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("createConfig fails without an allowed bridge OAuth cache location", () => {
  withEnv(
    {
      FIGMA_WORKSPACE_OAUTH_CACHE_PATH: undefined,
      CODEX_HOME: undefined,
      HOME: "C:/ignored-home",
      USERPROFILE: undefined,
    },
    () => {
      assert.throws(
        () =>
          createConfig({
            useBridgeOAuthCache: true,
            openBrowser: false,
          }),
        /FIGMA_WORKSPACE_OAUTH_CACHE_PATH, CODEX_HOME, or USERPROFILE/u,
      );
    },
  );
});

test("createCallbackUrl normalizes callback paths", () => {
  assert.equal(
    createCallbackUrl({ host: "localhost", port: 9001, path: "cb" }),
    "http://localhost:9001/cb",
  );
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
