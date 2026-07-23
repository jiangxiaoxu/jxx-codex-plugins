import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { createServer, request as createHttpRequest } from "node:http";
import { PassThrough } from "node:stream";
import test from "node:test";
import {
  OAuthCache,
  OAuthRefreshError,
  OAUTH_AUTHORIZE_PATH,
  OAUTH_TOKEN_PATH,
  createMcpRequestHeaders,
  refreshAccessToken,
  findCodexHomeOAuthCachePath,
  handleAuthorizationRedirect,
  handleBridgeRequest,
  copyRequestHeaders,
  copyResponseHeaders,
  createBridgeConfig,
  rewriteOAuthRequestBody,
  rewriteAuthorizationServerMetadata,
  rewriteProtectedResourceMetadata,
  rewriteResponseHeaders,
  rewriteWwwAuthenticate,
  startFigmaMcpBridge,
  createLimitedNodeStream,
  readRequestBody,
  MCP_REQUEST_BODY_LIMIT_BYTES,
  OAUTH_BODY_LIMIT_BYTES,
  BRIDGE_RESPONSE_LIMIT_BYTES,
} from "../scripts/server.mjs";

test("createBridgeConfig applies defaults and normalizes path", () => {
  const config = createBridgeConfig({ port: 19001, path: "mcp" });

  assert.equal(config.host, "127.0.0.1");
  assert.equal(config.port, 19001);
  assert.equal(config.path, "/mcp");
  assert.equal(config.target, "https://mcp.figma.com/mcp");
  assert.equal(config.oauthCacheEnabled, true);
});

test("createBridgeConfig uses CODEX_HOME as the OAuth cache location", async () => {
  const dir = await mkdtemp(join(tmpdir(), "figma-workspace-codex-home-"));
  try {
    const cachePath = join(dir, ".figma-workspace-oauth.json");

    assert.equal(
      findCodexHomeOAuthCachePath({ CODEX_HOME: dir }),
      cachePath,
    );

    const previous = process.env.CODEX_HOME;
    process.env.CODEX_HOME = dir;
    try {
      const config = createBridgeConfig({ port: 19001 });
      assert.equal(config.oauthCachePath, cachePath);
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

test("createBridgeConfig uses FIGMA_WORKSPACE_OAUTH_CACHE_PATH first", async () => {
  const dir = await mkdtemp(join(tmpdir(), "figma-workspace-cache-path-"));
  try {
    const cachePath = join(dir, "custom-oauth.json");
    withEnv(
      {
        FIGMA_WORKSPACE_OAUTH_CACHE_PATH: cachePath,
        CODEX_HOME: "C:/ignored-codex-home",
        USERPROFILE: "C:/ignored-userprofile",
      },
      () => {
        const config = createBridgeConfig({ port: 19001 });
        assert.equal(config.oauthCachePath, cachePath);
      },
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("findCodexHomeOAuthCachePath uses USERPROFILE .codex when CODEX_HOME is missing", async () => {
  const dir = await mkdtemp(join(tmpdir(), "figma-workspace-home-"));
  try {
    const cachePath = join(dir, ".codex", ".figma-workspace-oauth.json");

    assert.equal(findCodexHomeOAuthCachePath({ USERPROFILE: dir }), cachePath);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("resolve-oauth-cache-path.py follows bridge cache priority", async () => {
  const dir = await mkdtemp(join(tmpdir(), "figma-workspace-python-cache-"));
  try {
    const explicitPath = join(dir, "explicit-oauth.json");
    const codexHome = join(dir, "codex-home");
    const userProfile = join(dir, "profile");

    const result = runResolveOAuthCachePath({
      FIGMA_WORKSPACE_OAUTH_CACHE_PATH: explicitPath,
      CODEX_HOME: codexHome,
      USERPROFILE: userProfile,
    });

    assert.equal(result.status, 0);
    assert.equal(result.stdout.trim(), explicitPath);

    const jsonResult = runResolveOAuthCachePath(
      {
        FIGMA_WORKSPACE_OAUTH_CACHE_PATH: undefined,
        CODEX_HOME: codexHome,
        USERPROFILE: userProfile,
      },
      ["--json"],
    );
    assert.equal(jsonResult.status, 0);
    assert.deepEqual(JSON.parse(jsonResult.stdout), {
      path: join(codexHome, ".figma-workspace-oauth.json"),
      source: "CODEX_HOME",
      exists: false,
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("resolve-oauth-cache-path.py can require an existing cache file", async () => {
  const dir = await mkdtemp(join(tmpdir(), "figma-workspace-python-missing-cache-"));
  const cachePath = join(dir, "missing-oauth.json");
  const result = runResolveOAuthCachePath({
    FIGMA_WORKSPACE_OAUTH_CACHE_PATH: cachePath,
  }, ["--require-existing"]);

  assert.equal(result.status, 2);
  assert.match(result.stderr, /Resolved OAuth cache file does not exist/u);
  await rm(dir, { recursive: true, force: true });
});

test("login-figma-http.mjs runs in foreground and validates OAuth cache", async () => {
  const script = await readFile(
    new URL("../cli-runtime/scripts/login-figma-http.mjs", import.meta.url),
    "utf8",
  );

  assert.doesNotMatch(script, /FIGMA_WORKSPACE_BRIDGE_LOGIN_CHILD/u);
  assert.doesNotMatch(script, /-NoExit/u);
  assert.match(script, /async function testOAuthCacheReady/u);
  assert.match(script, /function reportOAuthCacheWriteStatus/u);
  assert.match(script, /async function removeOAuthCacheForForceLogin/u);
  assert.match(script, /--force/u);
  assert.match(script, /OAuth cache is not ready after adding the temporary server/u);
  assert.match(script, /invokeCodexMcpImpl\(\["mcp", "login", serverName\]\)/u);
  assert.match(script, /invokeCodexMcpImpl\(\["mcp", "add", serverName, "--url", serverUrl\]\)/u);
  assert.match(script, /invokeCodexMcpImpl\(\["mcp", "remove", serverName\], \{ ignoreFailure: true \}\)/u);
  assert.match(script, /tokens\.access_token/u);
  assert.match(script, /expires within 60 seconds/u);
  assert.match(script, /process\.exitCode = 2/u);
  assert.match(script, /already usable; no new token was written/u);
  assert.match(script, /Restored the previous OAuth cache after login failure/u);
  assert.match(script, /unique attempt marker/u);
  assert.match(script, /OAuth cache rollback conflict/u);
  assert.match(script, /OAuth cache ready/u);
});

test("createBridgeConfig fails without an allowed OAuth cache location", () => {
  withEnv(
    {
      FIGMA_WORKSPACE_OAUTH_CACHE_PATH: undefined,
      CODEX_HOME: undefined,
      HOME: "C:/ignored-home",
      USERPROFILE: undefined,
    },
    () => {
      assert.throws(
        () => createBridgeConfig({ port: 19001 }),
        /FIGMA_WORKSPACE_OAUTH_CACHE_PATH, CODEX_HOME, or USERPROFILE/u,
      );
    },
  );
});

test("copyRequestHeaders preserves MCP and auth headers but drops hop-by-hop headers", () => {
  const headers = copyRequestHeaders({
    authorization: "Bearer token",
    "mcp-session-id": "session-1",
    "mcp-protocol-version": "2025-06-18",
    connection: "keep-alive",
    host: "127.0.0.1:18766",
  });

  assert.equal(headers.get("authorization"), "Bearer token");
  assert.equal(headers.get("mcp-session-id"), "session-1");
  assert.equal(headers.get("mcp-protocol-version"), "2025-06-18");
  assert.equal(headers.get("connection"), null);
  assert.equal(headers.get("host"), null);
});

test("copyResponseHeaders preserves OAuth challenge and MCP session headers", () => {
  const headers = new Headers({
    "www-authenticate": "Bearer resource_metadata=\"https://mcp.figma.com/.well-known/oauth-protected-resource\"",
    "mcp-session-id": "session-1",
    connection: "keep-alive",
  });

  const copied = copyResponseHeaders(headers);

  assert.equal(
    copied.get("www-authenticate"),
    "Bearer resource_metadata=\"https://mcp.figma.com/.well-known/oauth-protected-resource\"",
  );
  assert.equal(copied.get("mcp-session-id"), "session-1");
  assert.equal(copied.has("connection"), false);
});

test("rewriteWwwAuthenticate points resource metadata to the local bridge", () => {
  const config = createBridgeConfig({ port: 19001 });
  const rewritten = rewriteWwwAuthenticate(
    'Bearer resource_metadata="https://mcp.figma.com/.well-known/oauth-protected-resource",scope="mcp:connect"',
    config,
  );

  assert.match(
    rewritten,
    /resource_metadata="http:\/\/127\.0\.0\.1:19001\/\.well-known\/oauth-protected-resource"/,
  );
  assert.match(rewritten, /scope="mcp:connect"/);
});

test("rewriteResponseHeaders rewrites OAuth challenge metadata URL", () => {
  const config = createBridgeConfig({ port: 19001 });
  const headers = new Map([
    [
      "www-authenticate",
      'Bearer resource_metadata="https://mcp.figma.com/.well-known/oauth-protected-resource",scope="mcp:connect"',
    ],
  ]);

  rewriteResponseHeaders(headers, config);

  assert.match(
    headers.get("www-authenticate"),
    /resource_metadata="http:\/\/127\.0\.0\.1:19001\/\.well-known\/oauth-protected-resource"/,
  );
});

test("rewriteProtectedResourceMetadata points resource to the local bridge", () => {
  const config = createBridgeConfig({ port: 19001 });
  const rewritten = JSON.parse(
    rewriteProtectedResourceMetadata(
      JSON.stringify({
        resource: "https://mcp.figma.com/mcp",
        authorization_servers: ["https://api.figma.com"],
        scopes_supported: ["mcp:connect"],
      }),
      config,
    ),
  );

  assert.equal(rewritten.resource, "http://127.0.0.1:19001/mcp");
  assert.equal(
    rewritten.resource_metadata,
    "http://127.0.0.1:19001/.well-known/oauth-protected-resource",
  );
  assert.deepEqual(rewritten.authorization_servers, ["http://127.0.0.1:19001"]);
});

test("rewriteAuthorizationServerMetadata points OAuth endpoints to the local bridge", () => {
  const config = createBridgeConfig({ port: 19001 });
  const rewritten = JSON.parse(
    rewriteAuthorizationServerMetadata(
      JSON.stringify({
        issuer: "https://api.figma.com",
        authorization_endpoint: "https://www.figma.com/oauth/mcp",
        token_endpoint: "https://api.figma.com/v1/oauth/token",
        registration_endpoint: "https://api.figma.com/v1/oauth/mcp/register",
      }),
      config,
    ),
  );

  assert.equal(rewritten.issuer, "http://127.0.0.1:19001");
  assert.equal(
    rewritten.authorization_endpoint,
    "http://127.0.0.1:19001/oauth/authorize",
  );
  assert.equal(rewritten.token_endpoint, "http://127.0.0.1:19001/oauth/token");
  assert.equal(
    rewritten.registration_endpoint,
    "http://127.0.0.1:19001/oauth/register",
  );
});

test("handleAuthorizationRedirect redirects to Figma with the original query", () => {
  const config = createBridgeConfig({ port: 19001 });
  const incomingUrl = new URL(
    `http://127.0.0.1:19001${OAUTH_AUTHORIZE_PATH}?client_id=abc&state=xyz`,
  );
  const response = {
    headers: undefined,
    status: undefined,
    writeHead(status, headers) {
      this.status = status;
      this.headers = headers;
    },
    end() {},
  };

  handleAuthorizationRedirect(config, incomingUrl, response);

  assert.equal(response.status, 302);
  assert.equal(
    response.headers.location,
    "https://www.figma.com/oauth/mcp?client_id=abc&state=xyz",
  );
});

test("handleAuthorizationRedirect rewrites local resource query to Figma target", () => {
  const config = createBridgeConfig({ port: 19001 });
  const incomingUrl = new URL(
    `http://127.0.0.1:19001${OAUTH_AUTHORIZE_PATH}?resource=http%3A%2F%2F127.0.0.1%3A19001%2Fmcp`,
  );
  const response = {
    headers: undefined,
    status: undefined,
    writeHead(status, headers) {
      this.status = status;
      this.headers = headers;
    },
    end() {},
  };

  handleAuthorizationRedirect(config, incomingUrl, response);

  assert.equal(response.status, 302);
  assert.equal(
    new URL(response.headers.location).searchParams.get("resource"),
    "https://mcp.figma.com/mcp",
  );
});

test("rewriteOAuthRequestBody rewrites local resource form field to Figma target", () => {
  const config = createBridgeConfig({ port: 19001 });
  const rewritten = rewriteOAuthRequestBody(
    "application/x-www-form-urlencoded",
    Buffer.from("grant_type=authorization_code&resource=http%3A%2F%2F127.0.0.1%3A19001%2Fmcp"),
    config,
  );

  assert.equal(
    new URLSearchParams(rewritten.toString("utf8")).get("resource"),
    "https://mcp.figma.com/mcp",
  );
});

test("OAuthCache stores client registration and token responses", async () => {
  const dir = await mkdtemp(join(tmpdir(), "figma-workspace-"));
  try {
    const cache = new OAuthCache(join(dir, "oauth.json"), {
      now: () => 100000,
    });
    await cache.saveClientInformation({
      client_id: "client-1",
      client_secret: "secret-1",
    });
    await cache.saveTokenResponse({
      access_token: "access-1",
      refresh_token: "refresh-1",
      expires_in: 3600,
      token_type: "Bearer",
    });
    await cache.saveTokenResponse({
      access_token: "access-2",
      expires_in: 3600,
      token_type: "Bearer",
    });

    const state = await cache.read();
    assert.equal(state.clientInformation.client_id, "client-1");
    assert.equal(state.tokens.access_token, "access-2");
    assert.equal(state.tokens.refresh_token, "refresh-1");
    assert.equal(state.tokens.expires_at, 3700000);
    assert.equal(await cache.getUsableAccessToken(), "access-2");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("refreshAccessToken is single-flight and rotates credentials under the cache lock", async () => {
  const dir = await mkdtemp(join(tmpdir(), "figma-workspace-refresh-flight-"));
  const originalFetch = globalThis.fetch;
  try {
    const cache = new OAuthCache(join(dir, "oauth.json"), { now: () => 100_000 });
    await cache.write({
      clientInformation: { client_id: "client-1", client_secret: "secret-1" },
      tokens: {
        access_token: "expired-access",
        refresh_token: "refresh-1",
        expires_at: 100_000,
      },
    });
    let fetchCount = 0;
    globalThis.fetch = async () => {
      fetchCount += 1;
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 20));
      return new Response(JSON.stringify({
        access_token: "access-2",
        refresh_token: "refresh-2",
        expires_in: 3600,
        token_type: "Bearer",
      }), { status: 200, headers: { "content-type": "application/json" } });
    };

    const config = createBridgeConfig({ port: 19001 });
    const [first, second] = await Promise.all([
      refreshAccessToken(config, cache),
      refreshAccessToken(config, cache),
    ]);

    assert.equal(fetchCount, 1);
    assert.equal(first.access_token, "access-2");
    assert.equal(second.access_token, "access-2");
    assert.equal(typeof first.credentialFingerprint, "string");
    const state = await cache.read();
    assert.equal(state.tokens.refresh_token, "refresh-2");
    assert.equal(state.tokens.expires_at, 3_700_000);
  } finally {
    globalThis.fetch = originalFetch;
    await rm(dir, { recursive: true, force: true });
  }
});

test("refreshAccessToken preserves credentials for 429, 5xx, and network failures", async () => {
  const dir = await mkdtemp(join(tmpdir(), "figma-workspace-refresh-transient-"));
  const originalFetch = globalThis.fetch;
  try {
    const cachePath = join(dir, "oauth.json");
    const cache = new OAuthCache(cachePath, { now: () => 100_000 });
    const originalState = {
      clientInformation: { client_id: "client-1" },
      tokens: {
        access_token: "expired-access",
        refresh_token: "refresh-1",
        expires_at: 100_000,
      },
    };
    const config = createBridgeConfig({ port: 19001 });
    for (const status of [429, 500, 503]) {
      await cache.write(originalState);
      globalThis.fetch = async () => new Response(
        JSON.stringify({ error: "temporarily_unavailable" }),
        { status, headers: { "content-type": "application/json" } },
      );
      await assert.rejects(
        refreshAccessToken(config, cache),
        (error) => error instanceof OAuthRefreshError &&
          error.kind === "transient" && error.status === status,
      );
      assert.deepEqual((await cache.read()).tokens, originalState.tokens);
    }

    await cache.write(originalState);
    globalThis.fetch = async () => {
      throw new Error("network unavailable");
    };
    await assert.rejects(
      refreshAccessToken(config, cache),
      (error) => error instanceof OAuthRefreshError && error.kind === "transient",
    );
    assert.deepEqual((await cache.read()).tokens, originalState.tokens);
  } finally {
    globalThis.fetch = originalFetch;
    await rm(dir, { recursive: true, force: true });
  }
});

test("refreshAccessToken clears tokens only for terminal OAuth errors", async () => {
  const dir = await mkdtemp(join(tmpdir(), "figma-workspace-refresh-terminal-"));
  const originalFetch = globalThis.fetch;
  try {
    const cache = new OAuthCache(join(dir, "oauth.json"), { now: () => 100_000 });
    await cache.write({
      clientInformation: { client_id: "client-1" },
      tokens: {
        access_token: "expired-access",
        refresh_token: "refresh-1",
        expires_at: 100_000,
      },
    });
    globalThis.fetch = async () => new Response(
      JSON.stringify({ error: "invalid_grant" }),
      { status: 400, headers: { "content-type": "application/json" } },
    );

    assert.equal(
      await refreshAccessToken(createBridgeConfig({ port: 19001 }), cache),
      undefined,
    );
    const state = await cache.read();
    assert.equal(state.tokens, undefined);
    assert.equal(state.clientInformation.client_id, "client-1");
  } finally {
    globalThis.fetch = originalFetch;
    await rm(dir, { recursive: true, force: true });
  }
});

test("OAuthCache token clearing uses credential fingerprint CAS", async () => {
  const dir = await mkdtemp(join(tmpdir(), "figma-workspace-oauth-cas-"));
  try {
    const cache = new OAuthCache(join(dir, "oauth.json"), { now: () => 100_000 });
    await cache.saveTokenResponse({ access_token: "access-1", expires_in: 3600 });
    const stale = await cache.getUsableAccessTokenSnapshot();
    await cache.saveTokenResponse({ access_token: "access-2", expires_in: 3600 });

    assert.equal(await cache.clearTokens(stale.fingerprint), false);
    assert.equal((await cache.read()).tokens.access_token, "access-2");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("OAuthCache invalidates a rejected access token without losing its refresh token", async () => {
  const dir = await mkdtemp(join(tmpdir(), "figma-workspace-oauth-invalidate-"));
  try {
    const cache = new OAuthCache(join(dir, "oauth.json"), { now: () => 100_000 });
    await cache.saveTokenResponse({
      access_token: "access-1",
      refresh_token: "refresh-1",
      expires_in: 3600,
    });
    const current = await cache.getUsableAccessTokenSnapshot();

    assert.equal(await cache.invalidateAccessToken(current.fingerprint), true);
    const state = await cache.read();
    assert.equal(state.tokens.access_token, undefined);
    assert.equal(state.tokens.expires_at, undefined);
    assert.equal(state.tokens.refresh_token, "refresh-1");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("createMcpRequestHeaders injects a cached access token when Authorization is missing", async () => {
  const dir = await mkdtemp(join(tmpdir(), "figma-workspace-"));
  try {
    const cache = new OAuthCache(join(dir, "oauth.json"), {
      now: () => 100000,
    });
    await cache.saveTokenResponse({
      access_token: "access-1",
      refresh_token: "refresh-1",
      expires_in: 3600,
    });

    const { headers, injectedCachedToken } = await createMcpRequestHeaders(
      createBridgeConfig({ port: 19001 }),
      {},
      cache,
    );

    assert.equal(injectedCachedToken, true);
    assert.equal(headers.get("authorization"), "Bearer access-1");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("createMcpRequestHeaders keeps explicit Authorization over cache", async () => {
  const dir = await mkdtemp(join(tmpdir(), "figma-workspace-"));
  try {
    const cache = new OAuthCache(join(dir, "oauth.json"), {
      now: () => 100000,
    });
    await cache.saveTokenResponse({
      access_token: "access-1",
      expires_in: 3600,
    });

    const { headers, injectedCachedToken } = await createMcpRequestHeaders(
      createBridgeConfig({ port: 19001 }),
      { authorization: "Bearer explicit" },
      cache,
    );

    assert.equal(injectedCachedToken, false);
    assert.equal(headers.get("authorization"), "Bearer explicit");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("startFigmaMcpBridge starts and returns an HTTP MCP URL", async () => {
  const bridge = await startFigmaMcpBridge({ port: 19002 });
  try {
    assert.equal(bridge.url, "http://127.0.0.1:19002/mcp");
    const response = await fetch("http://127.0.0.1:19002/not-mcp");
    assert.equal(response.status, 404);
  } finally {
    await bridge.close();
  }
});

test("limited MCP body pipeline destroys its source and transform on abort or overflow", async () => {
  {
    const source = new PassThrough();
    const controller = new AbortController();
    const body = createLimitedNodeStream(
      source,
      16,
      undefined,
      "MCP request body",
      controller.signal,
    );
    body.stream.resume();
    source.write("partial");
    controller.abort(new Error("test shutdown"));

    await assert.rejects(body.completion, /abort/u);
    assert.equal(source.destroyed, true);
    assert.equal(body.stream.destroyed, true);
  }

  {
    const source = new PassThrough();
    const body = createLimitedNodeStream(
      source,
      4,
      undefined,
      "MCP request body",
    );
    body.stream.resume();
    source.end("12345");

    await assert.rejects(body.completion, /MCP request body exceeds 4 bytes/u);
    assert.equal(source.destroyed, true);
    assert.equal(body.stream.destroyed, true);
  }
});

test("buffered OAuth body read destroys its source when its signal aborts", async () => {
  const source = new PassThrough();
  const controller = new AbortController();
  const reading = readRequestBody(
    source,
    OAUTH_BODY_LIMIT_BYTES,
    undefined,
    "OAuth request body",
    controller.signal,
  );
  source.write("grant_type=");
  controller.abort(new Error("test timeout"));

  await assert.rejects(reading, /abort/u);
  assert.equal(source.destroyed, true);
});

test("client abort cancels an in-flight MCP upload and upstream fetch", async () => {
  let upstreamRequest;
  let markUpstreamStarted;
  let markUpstreamTerminated;
  const upstreamStarted = new Promise((resolvePromise) => {
    markUpstreamStarted = resolvePromise;
  });
  const upstreamTerminated = new Promise((resolvePromise) => {
    markUpstreamTerminated = resolvePromise;
  });
  const upstream = createServer((request) => {
    upstreamRequest = request;
    request.once("data", markUpstreamStarted);
    request.once("aborted", markUpstreamTerminated);
    request.once("close", markUpstreamTerminated);
  });
  await listenTestServer(upstream);
  const upstreamAddress = upstream.address();
  assert.ok(upstreamAddress && typeof upstreamAddress === "object");

  let incomingRequest;
  let handling;
  const bridgeServer = createServer((request, response) => {
    incomingRequest = request;
    handling = handleBridgeRequest(
      createBridgeConfig({
        port: 19005,
        target: `http://127.0.0.1:${upstreamAddress.port}/mcp`,
      }),
      request,
      response,
      { controller: new AbortController() },
    );
  });
  await listenTestServer(bridgeServer);
  const bridgeAddress = bridgeServer.address();
  assert.ok(bridgeAddress && typeof bridgeAddress === "object");

  const client = createHttpRequest({
    host: "127.0.0.1",
    port: bridgeAddress.port,
    path: "/mcp",
    method: "POST",
    headers: { "content-type": "application/json" },
  });
  client.on("error", () => undefined);
  try {
    client.write('{"jsonrpc":"2.0",');
    await withinTestTimeout(upstreamStarted, "upstream MCP upload did not start");
    client.destroy();
    await withinTestTimeout(upstreamTerminated, "upstream MCP upload was not aborted");
    await withinTestTimeout(handling, "bridge request handler did not settle");

    assert.equal(incomingRequest.destroyed, true);
    assert.equal(upstreamRequest.destroyed, true);
  } finally {
    client.destroy();
    await closeTestServer(bridgeServer);
    await closeTestServer(upstream);
  }
});

test("upstream fetch failure destroys the incoming MCP request lifecycle", async () => {
  let incomingRequest;
  let handling;
  const bridgeServer = createServer((request, response) => {
    incomingRequest = request;
    handling = handleBridgeRequest(
      createBridgeConfig({ port: 19006 }),
      request,
      response,
      {
        controller: new AbortController(),
        fetch: async () => {
          throw new Error("test upstream fetch failure");
        },
      },
    );
  });
  await listenTestServer(bridgeServer);
  const address = bridgeServer.address();
  assert.ok(address && typeof address === "object");

  const clientTerminated = new Promise((resolvePromise) => {
    const client = createHttpRequest({
      host: "127.0.0.1",
      port: address.port,
      path: "/mcp",
      method: "POST",
      headers: { "content-type": "application/json" },
    });
    client.once("error", resolvePromise);
    client.once("response", (response) => {
      response.resume();
      response.once("end", resolvePromise);
    });
    client.end("{}");
  });

  try {
    await withinTestTimeout(clientTerminated, "failed fetch did not terminate its client");
    await withinTestTimeout(handling, "failed fetch handler did not settle");
    assert.equal(incomingRequest.destroyed, true);
  } finally {
    await closeTestServer(bridgeServer);
  }
});

test("slow OAuth bodies terminate on injected idle and total request timeouts", async () => {
  const scenarios = [
    { name: "idle", idleTimeoutMs: 25, totalTimeoutMs: 1_000 },
    { name: "total", idleTimeoutMs: 1_000, totalTimeoutMs: 25 },
  ];

  for (const scenario of scenarios) {
    let incomingRequest;
    let handling;
    const bridgeServer = createServer((request, response) => {
      incomingRequest = request;
      handling = handleBridgeRequest(
        createBridgeConfig({ port: 19006 }),
        request,
        response,
        {
          controller: new AbortController(),
          idleTimeoutMs: scenario.idleTimeoutMs,
          totalTimeoutMs: scenario.totalTimeoutMs,
        },
      );
    });
    await listenTestServer(bridgeServer);
    const address = bridgeServer.address();
    assert.ok(address && typeof address === "object");

    const clientTerminated = new Promise((resolvePromise) => {
      const client = createHttpRequest({
        host: "127.0.0.1",
        port: address.port,
        path: OAUTH_TOKEN_PATH,
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
      });
      client.once("error", resolvePromise);
      client.once("response", (response) => {
        response.resume();
        response.once("end", resolvePromise);
      });
      client.write("grant_type=");
    });

    try {
      await withinTestTimeout(
        clientTerminated,
        `slow OAuth body did not hit the ${scenario.name} timeout`,
      );
      await withinTestTimeout(handling, "OAuth bridge request handler did not settle");
      assert.equal(incomingRequest.destroyed, true);
    } finally {
      await closeTestServer(bridgeServer);
    }
  }
});

test("declared oversized MCP and OAuth bodies destroy the request before upstream dispatch", async () => {
  const scenarios = [
    { path: "/mcp", limit: MCP_REQUEST_BODY_LIMIT_BYTES },
    { path: OAUTH_TOKEN_PATH, limit: OAUTH_BODY_LIMIT_BYTES },
  ];

  for (const scenario of scenarios) {
    let incomingRequest;
    let handling;
    let fetchCalls = 0;
    const bridgeServer = createServer((request, response) => {
      incomingRequest = request;
      handling = handleBridgeRequest(
        createBridgeConfig({ port: 19003 }),
        request,
        response,
        {
          controller: new AbortController(),
          fetch: async () => {
            fetchCalls += 1;
            return new Response("{}");
          },
        },
      );
    });
    await listenTestServer(bridgeServer);
    const address = bridgeServer.address();
    assert.ok(address && typeof address === "object");

    const clientTerminated = new Promise((resolvePromise) => {
      const client = createHttpRequest({
        host: "127.0.0.1",
        port: address.port,
        path: scenario.path,
        method: "POST",
        headers: {
          "content-type": "application/octet-stream",
          "content-length": String(scenario.limit + 1),
        },
      });
      client.once("error", resolvePromise);
      client.once("response", (response) => {
        response.resume();
        response.once("end", resolvePromise);
      });
      client.write("x");
    });

    try {
      await withinTestTimeout(clientTerminated, `${scenario.path} was not terminated`);
      await withinTestTimeout(handling, `${scenario.path} handler did not settle`);
      assert.equal(incomingRequest.destroyed, true);
      assert.equal(fetchCalls, 0);
    } finally {
      await closeTestServer(bridgeServer);
    }
  }
});

test("declared oversized upstream response cancels its body and request lifecycle", async () => {
  let canceledReason;
  const upstreamBody = new ReadableStream({
    start(controller) {
      controller.enqueue(Buffer.from("{}"));
    },
    cancel(reason) {
      canceledReason = reason;
    },
  });
  let incomingRequest;
  let handling;
  const bridgeServer = createServer((request, response) => {
    incomingRequest = request;
    handling = handleBridgeRequest(
      createBridgeConfig({ port: 19004 }),
      request,
      response,
      {
        controller: new AbortController(),
        fetch: async () => new Response(upstreamBody, {
          status: 200,
          headers: {
            "content-type": "application/json",
            "content-length": String(BRIDGE_RESPONSE_LIMIT_BYTES + 1),
          },
        }),
      },
    );
  });
  await listenTestServer(bridgeServer);
  const address = bridgeServer.address();
  assert.ok(address && typeof address === "object");

  const clientTerminated = new Promise((resolvePromise) => {
    const client = createHttpRequest({
      host: "127.0.0.1",
      port: address.port,
      path: "/mcp",
      method: "GET",
    });
    client.once("error", resolvePromise);
    client.once("response", (response) => {
      response.resume();
      response.once("end", resolvePromise);
    });
    client.end();
  });

  try {
    await withinTestTimeout(clientTerminated, "oversized upstream response did not terminate");
    await withinTestTimeout(handling, "oversized upstream response handler did not settle");
    assert.equal(incomingRequest.destroyed, true);
    assert.match(canceledReason?.message ?? "", /Bridge response body exceeds/u);
  } finally {
    await closeTestServer(bridgeServer);
  }
});

async function listenTestServer(server) {
  await new Promise((resolvePromise, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolvePromise();
    });
  });
}
async function closeTestServer(server) {
  if (!server.listening) return;
  server.closeAllConnections?.();
  await new Promise((resolvePromise, reject) => {
    server.close((error) => (error ? reject(error) : resolvePromise()));
  });
}

async function withinTestTimeout(promise, message, timeoutMs = 1_000) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(message)), timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

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

function runResolveOAuthCachePath(overrides, args = []) {
  const env = { ...process.env };
  for (const [key, value] of Object.entries(overrides)) {
    for (const existingKey of Object.keys(env)) {
      if (existingKey.toLowerCase() === key.toLowerCase()) {
        delete env[existingKey];
      }
    }
    if (value === undefined) {
      continue;
    } else {
      env[key] = value;
    }
  }
  return spawnSync("python", ["scripts/resolve-oauth-cache-path.py", ...args], {
    cwd: new URL("..", import.meta.url),
    env,
    encoding: "utf8",
  });
}
