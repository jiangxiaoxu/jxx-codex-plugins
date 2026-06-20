import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import {
  OAuthCache,
  OAUTH_AUTHORIZE_PATH,
  createMcpRequestHeaders,
  findCodexHomeOAuthCachePath,
  handleAuthorizationRedirect,
  copyRequestHeaders,
  copyResponseHeaders,
  createBridgeConfig,
  rewriteOAuthRequestBody,
  rewriteAuthorizationServerMetadata,
  rewriteProtectedResourceMetadata,
  rewriteResponseHeaders,
  rewriteWwwAuthenticate,
  startFigmaMcpBridge,
} from "../scripts/server.mjs";

test("createBridgeConfig applies defaults and normalizes path", () => {
  const config = createBridgeConfig({ port: 19001, path: "mcp" });

  assert.equal(config.host, "127.0.0.1");
  assert.equal(config.port, 19001);
  assert.equal(config.path, "/mcp");
  assert.equal(config.target, "https://mcp.figma.com/mcp");
  assert.equal(config.oauthCacheEnabled, true);
});

test(".mcp.json registers stdio and REPL MCP servers", async () => {
  const manifest = JSON.parse(
    await readFile(new URL("../.mcp.json", import.meta.url), "utf8"),
  );

  assert.deepEqual(manifest.mcpServers["figma-stdio"], {
    command: "node",
    cwd: ".",
    args: ["./stdio-mcp/dist/stdio-cli.js"],
  });
  assert.deepEqual(manifest.mcpServers["figma-repl-mcp"], {
    command: "node",
    cwd: ".",
    args: ["./stdio-mcp/dist/repl-stdio-cli.js"],
  });
});

test("createBridgeConfig uses CODEX_HOME as the OAuth cache location", async () => {
  const dir = await mkdtemp(join(tmpdir(), "figma-mcp-bridge-codex-home-"));
  try {
    const cachePath = join(dir, ".figma-mcp-bridge-oauth.json");

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

test("createBridgeConfig uses FIGMA_MCP_OAUTH_CACHE_PATH first", async () => {
  const dir = await mkdtemp(join(tmpdir(), "figma-mcp-bridge-cache-path-"));
  try {
    const cachePath = join(dir, "custom-oauth.json");
    withEnv(
      {
        FIGMA_MCP_OAUTH_CACHE_PATH: cachePath,
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
  const dir = await mkdtemp(join(tmpdir(), "figma-mcp-bridge-home-"));
  try {
    const cachePath = join(dir, ".codex", ".figma-mcp-bridge-oauth.json");

    assert.equal(findCodexHomeOAuthCachePath({ USERPROFILE: dir }), cachePath);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("createBridgeConfig fails without an allowed OAuth cache location", () => {
  withEnv(
    {
      FIGMA_MCP_OAUTH_CACHE_PATH: undefined,
      CODEX_HOME: undefined,
      HOME: "C:/ignored-home",
      USERPROFILE: undefined,
    },
    () => {
      assert.throws(
        () => createBridgeConfig({ port: 19001 }),
        /FIGMA_MCP_OAUTH_CACHE_PATH, CODEX_HOME, or USERPROFILE/u,
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
  const dir = await mkdtemp(join(tmpdir(), "figma-mcp-bridge-"));
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

test("createMcpRequestHeaders injects a cached access token when Authorization is missing", async () => {
  const dir = await mkdtemp(join(tmpdir(), "figma-mcp-bridge-"));
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
  const dir = await mkdtemp(join(tmpdir(), "figma-mcp-bridge-"));
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
