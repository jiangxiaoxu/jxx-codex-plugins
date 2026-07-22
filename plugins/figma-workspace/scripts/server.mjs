#!/usr/bin/env node

import { createServer } from "node:http";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Readable, Transform, Writable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { AtomicCredentialStore } from "../mcp-server/dist/auth/credential-store.js";

export const DEFAULT_TARGET = "https://mcp.figma.com/mcp";
export const DEFAULT_HOST = "127.0.0.1";
export const DEFAULT_PORT = 18766;
export const DEFAULT_PATH = "/mcp";
export const OAUTH_CACHE_FILENAME = ".figma-workspace-oauth.json";
export const PROTECTED_RESOURCE_PATH = "/.well-known/oauth-protected-resource";
export const AUTHORIZATION_SERVER_METADATA_PATH =
  "/.well-known/oauth-authorization-server";
export const OAUTH_AUTHORIZE_PATH = "/oauth/authorize";
export const OAUTH_TOKEN_PATH = "/oauth/token";
export const OAUTH_REGISTER_PATH = "/oauth/register";
export const FIGMA_AUTHORIZATION_SERVER_METADATA =
  "https://api.figma.com/.well-known/oauth-authorization-server";
export const FIGMA_AUTHORIZATION_ENDPOINT = "https://www.figma.com/oauth/mcp";
export const FIGMA_TOKEN_ENDPOINT = "https://api.figma.com/v1/oauth/token";
export const FIGMA_REGISTRATION_ENDPOINT =
  "https://api.figma.com/v1/oauth/mcp/register";

export const MCP_REQUEST_BODY_LIMIT_BYTES = 512 * 1024;
export const OAUTH_BODY_LIMIT_BYTES = 64 * 1024;
export const BRIDGE_RESPONSE_LIMIT_BYTES = 64 * 1024 * 1024;
export const BRIDGE_TOTAL_TIMEOUT_MS = 5 * 60 * 1000;
export const BRIDGE_IDLE_TIMEOUT_MS = 60 * 1000;
export const BRIDGE_SHUTDOWN_GRACE_MS = 10 * 1000;

const refreshFlights = new Map();

const HOP_BY_HOP_HEADERS = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
  "host",
]);

export async function startFigmaMcpBridge(options = {}) {
  const config = createBridgeConfig(options);
  const oauthCache = config.oauthCacheEnabled
    ? new OAuthCache(config.oauthCachePath)
    : undefined;
  const activeControllers = new Set();
  const sockets = new Set();
  const server = createServer((request, response) => {
    const controller = new AbortController();
    activeControllers.add(controller);
    void handleBridgeRequest(config, request, response, { oauthCache, controller })
      .finally(() => activeControllers.delete(controller));
  });
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
  });

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(config.port, config.host, () => {
      server.off("error", reject);
      resolve();
    });
  });

  return {
    ...config,
    url: `http://${config.host}:${config.port}${config.path}`,
    close: () => closeBridgeServer(server, activeControllers, sockets),
  };
}

export function createBridgeConfig(options = {}) {
  return {
    host: options.host ?? process.env.FIGMA_WORKSPACE_BRIDGE_HOST ?? DEFAULT_HOST,
    port: normalizePort(options.port ?? process.env.FIGMA_WORKSPACE_BRIDGE_PORT ?? DEFAULT_PORT),
    path: normalizePath(options.path ?? process.env.FIGMA_WORKSPACE_BRIDGE_PATH ?? DEFAULT_PATH),
    target: new URL(options.target ?? process.env.FIGMA_WORKSPACE_BRIDGE_TARGET ?? DEFAULT_TARGET).toString(),
    log: options.log ?? process.env.FIGMA_WORKSPACE_BRIDGE_LOG === "1",
    oauthCacheEnabled:
      options.oauthCacheEnabled ??
      process.env.FIGMA_WORKSPACE_BRIDGE_OAUTH_CACHE !== "0",
    oauthCachePath:
      options.oauthCachePath ??
      process.env.FIGMA_WORKSPACE_OAUTH_CACHE_PATH ??
      findCodexHomeOAuthCachePath() ??
      missingOAuthCachePath(),
  };
}

export function findCodexHomeOAuthCachePath(env = process.env) {
  if (env.CODEX_HOME) {
    return resolve(env.CODEX_HOME, OAUTH_CACHE_FILENAME);
  }
  if (env.USERPROFILE) {
    return resolve(env.USERPROFILE, ".codex", OAUTH_CACHE_FILENAME);
  }
  return undefined;
}

function missingOAuthCachePath() {
  throw new Error(
    "Unable to resolve Figma MCP OAuth cache path. Set FIGMA_WORKSPACE_OAUTH_CACHE_PATH, CODEX_HOME, or USERPROFILE.",
  );
}

export async function handleBridgeRequest(config, request, response, runtime = {}) {
  const controller = runtime.controller ?? new AbortController();
  const activity = createRequestActivityController(
    controller,
    request,
    response,
    {
      totalTimeoutMs: runtime.totalTimeoutMs,
      idleTimeoutMs: runtime.idleTimeoutMs,
    },
  );
  try {
    const incomingUrl = new URL(request.url ?? "/", `http://${config.host}:${config.port}`);
    if (incomingUrl.pathname === PROTECTED_RESOURCE_PATH) {
      await handleProtectedResourceMetadata(config, request, response, {
        signal: controller.signal,
        activity,
        fetch: runtime.fetch,
      });
      return;
    }
    if (incomingUrl.pathname === AUTHORIZATION_SERVER_METADATA_PATH) {
      await handleAuthorizationServerMetadata(config, request, response, {
        signal: controller.signal,
        activity,
        fetch: runtime.fetch,
      });
      return;
    }
    if (incomingUrl.pathname === OAUTH_AUTHORIZE_PATH) {
      handleAuthorizationRedirect(config, incomingUrl, response);
      return;
    }
    if (incomingUrl.pathname === OAUTH_TOKEN_PATH) {
      await proxyOAuthEndpoint(FIGMA_TOKEN_ENDPOINT, request, response, {
        config,
        oauthCache: runtime.oauthCache,
        cacheKind: "token",
        signal: controller.signal,
        activity,
        fetch: runtime.fetch,
      });
      return;
    }
    if (incomingUrl.pathname === OAUTH_REGISTER_PATH) {
      await proxyOAuthEndpoint(FIGMA_REGISTRATION_ENDPOINT, request, response, {
        config,
        oauthCache: runtime.oauthCache,
        cacheKind: "client",
        signal: controller.signal,
        activity,
        fetch: runtime.fetch,
      });
      return;
    }

    if (incomingUrl.pathname !== config.path) {
      response.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
      response.end("Not found");
      return;
    }

    const targetUrl = new URL(config.target);
    targetUrl.search = incomingUrl.search;

    const { headers, injectedCachedToken, credentialFingerprint } = await createMcpRequestHeaders(
      config,
      request.headers,
      runtime.oauthCache,
      { signal: controller.signal },
    );
    const hasBody = request.method !== "GET" && request.method !== "HEAD";
    if (hasBody) {
      assertDeclaredBodyLimit(
        request.headers["content-length"],
        MCP_REQUEST_BODY_LIMIT_BYTES,
        "MCP request body",
        activity,
      );
    }
    const incomingBody = hasBody
      ? createLimitedNodeStream(
          request,
          MCP_REQUEST_BODY_LIMIT_BYTES,
          activity,
          "MCP request body",
          controller.signal,
        )
      : undefined;
    const upstreamPromise = fetchWithBridgeAbort(targetUrl, {
      method: request.method,
      headers,
      body: incomingBody?.stream,
      duplex: hasBody ? "half" : undefined,
      redirect: "manual",
      signal: controller.signal,
    }, activity, runtime.fetch);
    const operations = incomingBody
      ? [upstreamPromise, incomingBody.completion]
      : [upstreamPromise];
    let upstream;
    try {
      [upstream] = await Promise.all(operations);
    } catch (error) {
      activity.abort(error);
      await Promise.allSettled(operations);
      throw error;
    }

    if (config.log) {
      console.error(
        `${request.method} ${incomingUrl.pathname}${incomingUrl.search} -> ${upstream.status}`,
      );
    }
    if (injectedCachedToken && upstream.status === 401) {
      await runtime.oauthCache?.invalidateAccessToken(credentialFingerprint);
    }

    const responseHeaders = rewriteResponseHeaders(
      copyResponseHeaders(upstream.headers),
      config,
    );
    await assertUpstreamResponseLength(
      responseHeaders.get("content-length"),
      BRIDGE_RESPONSE_LIMIT_BYTES,
      "Bridge response body",
      upstream.body,
      activity,
    );
    response.writeHead(
      upstream.status,
      upstream.statusText,
      Object.fromEntries(responseHeaders),
    );

    if (!upstream.body) {
      response.end();
      return;
    }

    await pipeWebStream(
      upstream.body,
      response,
      BRIDGE_RESPONSE_LIMIT_BYTES,
      activity,
      controller.signal,
    );
  } catch (error) {
    const bridgeError = findBridgeHttpError(error);
    if (!response.headersSent && !response.destroyed) {
      const status = bridgeError?.status ?? 502;
      response.writeHead(status, { "content-type": "text/plain; charset=utf-8" });
      response.end(bridgeError?.message ?? (error instanceof Error ? error.message : String(error)));
    } else if (!response.destroyed && !response.writableEnded) {
      response.destroy(error instanceof Error ? error : undefined);
    }
  } finally {
    activity.close();
  }
}

export async function handleProtectedResourceMetadata(config, request, response, runtime = {}) {
  if (request.method !== "GET" && request.method !== "HEAD") {
    response.writeHead(405, { allow: "GET, HEAD" });
    response.end();
    return;
  }

  const upstream = await fetchWithBridgeAbort(
    new URL(PROTECTED_RESOURCE_PATH, config.target).toString(),
    {
      method: "GET",
      headers: copyRequestHeaders(request.headers),
      redirect: "manual",
      signal: runtime.signal,
    },
    runtime.activity,
    runtime.fetch,
  );

  const text = (await readWebResponseBody(
    upstream,
    OAUTH_BODY_LIMIT_BYTES,
    runtime.activity,
    "OAuth metadata response",
  )).toString("utf8");
  const responseHeaders = copyResponseHeaders(upstream.headers);
  const rewritten = rewriteProtectedResourceMetadata(text, config);
  responseHeaders.set("content-length", String(Buffer.byteLength(rewritten)));
  response.writeHead(
    upstream.status,
    upstream.statusText,
    Object.fromEntries(responseHeaders),
  );
  if (request.method === "HEAD") {
    response.end();
    return;
  }
  response.end(rewritten);
}

export function rewriteProtectedResourceMetadata(text, config) {
  let metadata;
  try {
    metadata = JSON.parse(text);
  } catch {
    return text;
  }

  return `${JSON.stringify({
    ...metadata,
    resource: publicMcpUrl(config),
    authorization_servers: [publicBaseUrl(config)],
    resource_metadata: publicProtectedResourceUrl(config),
  })}\n`;
}

export async function handleAuthorizationServerMetadata(config, request, response, runtime = {}) {
  if (request.method !== "GET" && request.method !== "HEAD") {
    response.writeHead(405, { allow: "GET, HEAD" });
    response.end();
    return;
  }

  const upstream = await fetchWithBridgeAbort(FIGMA_AUTHORIZATION_SERVER_METADATA, {
    method: "GET",
    headers: copyRequestHeaders(request.headers),
    redirect: "manual",
    signal: runtime.signal,
  }, runtime.activity, runtime.fetch);

  const text = (await readWebResponseBody(
    upstream,
    OAUTH_BODY_LIMIT_BYTES,
    runtime.activity,
    "OAuth metadata response",
  )).toString("utf8");
  const responseHeaders = copyResponseHeaders(upstream.headers);
  const rewritten = rewriteAuthorizationServerMetadata(text, config);
  responseHeaders.set("content-length", String(Buffer.byteLength(rewritten)));
  response.writeHead(
    upstream.status,
    upstream.statusText,
    Object.fromEntries(responseHeaders),
  );
  if (request.method === "HEAD") {
    response.end();
    return;
  }
  response.end(rewritten);
}

export function rewriteAuthorizationServerMetadata(text, config) {
  let metadata;
  try {
    metadata = JSON.parse(text);
  } catch {
    return text;
  }

  return `${JSON.stringify({
    ...metadata,
    issuer: publicBaseUrl(config),
    authorization_endpoint: `${publicBaseUrl(config)}${OAUTH_AUTHORIZE_PATH}`,
    token_endpoint: `${publicBaseUrl(config)}${OAUTH_TOKEN_PATH}`,
    registration_endpoint: `${publicBaseUrl(config)}${OAUTH_REGISTER_PATH}`,
  })}\n`;
}

export function handleAuthorizationRedirect(config, incomingUrl, response) {
  const upstream = new URL(FIGMA_AUTHORIZATION_ENDPOINT);
  upstream.search = incomingUrl.search;
  rewriteLocalResourceParam(upstream.searchParams, config);
  response.writeHead(302, { location: upstream.toString() });
  response.end();
}

export async function proxyOAuthEndpoint(target, request, response, options = {}) {
  const hasBody = request.method !== "GET" && request.method !== "HEAD";
  if (hasBody) {
    assertDeclaredBodyLimit(
      request.headers["content-length"],
      OAUTH_BODY_LIMIT_BYTES,
      "OAuth request body",
      options.activity,
    );
  }
  const requestBody = hasBody
    ? await readRequestBody(
        request,
        OAUTH_BODY_LIMIT_BYTES,
        options.activity,
        "OAuth request body",
        options.signal,
      )
    : undefined;
  const rewrittenBody =
    requestBody && options.config
      ? rewriteOAuthRequestBody(
          request.headers["content-type"],
          requestBody,
          options.config,
        )
      : requestBody;
  const upstream = await fetchWithBridgeAbort(target, {
    method: request.method,
    headers: copyRequestHeaders(request.headers, { dropContentLength: true }),
    body: rewrittenBody,
    duplex: hasBody ? "half" : undefined,
    redirect: "manual",
    signal: options.signal,
  }, options.activity, options.fetch);

  const responseHeaders = copyResponseHeaders(upstream.headers);
  const responseBody = upstream.body
    ? await readWebResponseBody(
        upstream,
        OAUTH_BODY_LIMIT_BYTES,
        options.activity,
        "OAuth response body",
      )
    : undefined;
  if (
    upstream.ok &&
    responseBody &&
    options.oauthCache &&
    isJsonLike(responseHeaders.get("content-type"))
  ) {
    await cacheOAuthResponse(
      options.oauthCache,
      options.cacheKind,
      responseHeaders.get("content-type"),
      responseBody,
    );
  }
  response.writeHead(
    upstream.status,
    upstream.statusText,
    Object.fromEntries(responseHeaders),
  );
  if (!responseBody) {
    response.end();
    return;
  }
  response.end(responseBody);
}

export async function createMcpRequestHeaders(config, input, oauthCache, options = {}) {
  const headers = copyRequestHeaders(input);
  if (headers.has("authorization") || !oauthCache) {
    return { headers, injectedCachedToken: false };
  }

  const cached = await oauthCache.getUsableAccessTokenSnapshot();
  if (cached?.accessToken) {
    headers.set("authorization", `Bearer ${cached.accessToken}`);
    return {
      headers,
      injectedCachedToken: true,
      credentialFingerprint: cached.fingerprint,
    };
  }

  const refreshed = await refreshAccessToken(config, oauthCache, options);
  if (refreshed?.access_token) {
    headers.set("authorization", `Bearer ${refreshed.access_token}`);
    return {
      headers,
      injectedCachedToken: true,
      credentialFingerprint: refreshed.credentialFingerprint,
    };
  }

  return { headers, injectedCachedToken: false };
}

export async function refreshAccessToken(config, oauthCache, options = {}) {
  const flightKey = oauthCache.path;
  const existing = refreshFlights.get(flightKey);
  if (existing) {
    return existing;
  }
  const flight = refreshAccessTokenLocked(config, oauthCache, options)
    .finally(() => {
      if (refreshFlights.get(flightKey) === flight) {
        refreshFlights.delete(flightKey);
      }
    });
  refreshFlights.set(flightKey, flight);
  return flight;
}

async function refreshAccessTokenLocked(config, oauthCache, options) {
  return oauthCache.withLock(async (locked) => {
    const snapshot = await locked.readSnapshot();
    const cached = usableAccessToken(snapshot.state, oauthCache.now());
    if (cached) {
      return {
        ...snapshot.state.tokens,
        access_token: cached,
        credentialFingerprint: snapshot.fingerprint,
      };
    }

    const refreshToken = snapshot.state.tokens?.refresh_token;
    const clientId = snapshot.state.clientInformation?.client_id;
    if (typeof refreshToken !== "string" || typeof clientId !== "string") {
      return undefined;
    }

    const params = new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: refreshToken,
      client_id: clientId,
      resource: config.target,
    });
    if (snapshot.state.clientInformation?.client_secret) {
      params.set("client_secret", snapshot.state.clientInformation.client_secret);
    }

    let response;
    try {
      response = await fetch(FIGMA_TOKEN_ENDPOINT, {
        method: "POST",
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          accept: "application/json",
        },
        body: params,
        signal: options.signal,
      });
    } catch (error) {
      throw new OAuthRefreshError(
        "transient",
        "Figma OAuth token refresh failed due to a network or cancellation error.",
        { cause: error },
      );
    }

    const contentType = response.headers.get("content-type");
    const body = response.body
      ? await readWebResponseBody(
          response,
          OAUTH_BODY_LIMIT_BYTES,
          options.activity,
          "OAuth token response",
        )
      : Buffer.alloc(0);
    const value = isJsonLike(contentType) ? parseJsonObject(body) : undefined;

    if (!response.ok) {
      const code = typeof value?.error === "string" ? value.error : undefined;
      if (code === "invalid_grant" || code === "invalid_client") {
        const next = withoutTokens(snapshot.state, oauthCache.now());
        await locked.write(next);
        return undefined;
      }
      throw new OAuthRefreshError(
        "transient",
        `Figma OAuth token refresh failed with HTTP ${response.status}${code ? ` (${code})` : ""}; existing credentials were preserved.`,
        { status: response.status, oauthCode: code },
      );
    }

    if (!value || typeof value.access_token !== "string") {
      throw new OAuthRefreshError(
        "transient",
        "Figma OAuth token refresh returned an invalid JSON token response; existing credentials were preserved.",
        { status: response.status },
      );
    }

    const next = mergeTokenResponse(snapshot.state, value, oauthCache.now());
    await locked.write(next);
    const written = await locked.readSnapshot();
    return {
      ...next.tokens,
      credentialFingerprint: written.fingerprint,
    };
  });
}

export function rewriteResponseHeaders(headers, config) {
  const challenge = headers.get("www-authenticate");
  if (challenge) {
    headers.set("www-authenticate", rewriteWwwAuthenticate(challenge, config));
  }
  return headers;
}

export function rewriteWwwAuthenticate(value, config) {
  return value.replace(
    /resource_metadata="[^"]+"/u,
    `resource_metadata="${publicProtectedResourceUrl(config)}"`,
  );
}

export function copyRequestHeaders(input, options = {}) {
  const headers = new Headers();
  for (const [name, value] of Object.entries(input)) {
    const lowerName = name.toLowerCase();
    if (
      value === undefined ||
      HOP_BY_HOP_HEADERS.has(lowerName) ||
      (options.dropContentLength && lowerName === "content-length")
    ) {
      continue;
    }
    headers.set(name, Array.isArray(value) ? value.join(", ") : value);
  }
  return headers;
}

export function copyResponseHeaders(input) {
  const headers = new Map();
  for (const [name, value] of input.entries()) {
    if (!HOP_BY_HOP_HEADERS.has(name.toLowerCase())) {
      headers.set(name, value);
    }
  }
  return headers;
}

async function pipeWebStream(readable, response, limit, activity, signal) {
  const source = Readable.fromWeb(readable);
  await pipeline(
    source,
    createCountingTransform(limit, activity, "Bridge response body"),
    response,
    { signal },
  );
}

export async function readRequestBody(request, limit, activity, label, signal) {
  const chunks = [];
  let total = 0;
  const collector = new Writable({
    write(chunk, _encoding, callback) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      total += buffer.byteLength;
      chunks.push(buffer);
      callback();
    },
  });
  await pipeline(
    request,
    createCountingTransform(limit, activity, label),
    collector,
    signal ? { signal } : {},
  );
  return Buffer.concat(chunks, total);
}

export function rewriteOAuthRequestBody(contentType, body, config) {
  const type = String(contentType ?? "").toLowerCase();
  if (type.includes("application/x-www-form-urlencoded")) {
    const params = new URLSearchParams(body.toString("utf8"));
    rewriteLocalResourceParam(params, config);
    return Buffer.from(params.toString());
  }
  if (type.includes("application/json") || type.includes("+json")) {
    try {
      const value = JSON.parse(body.toString("utf8"));
      if (value && typeof value === "object" && !Array.isArray(value)) {
        if (value.resource === publicMcpUrl(config)) {
          value.resource = config.target;
        }
        return Buffer.from(JSON.stringify(value));
      }
    } catch {
      return body;
    }
  }
  return body;
}

function rewriteLocalResourceParam(params, config) {
  if (params.get("resource") === publicMcpUrl(config)) {
    params.set("resource", config.target);
  }
}

async function cacheOAuthResponse(oauthCache, cacheKind, contentType, body) {
  if (!isJsonLike(contentType)) {
    return;
  }
  let value;
  try {
    value = JSON.parse(body.toString("utf8"));
  } catch {
    return;
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return;
  }
  if (cacheKind === "client" && typeof value.client_id === "string") {
    await oauthCache.saveClientInformation(value);
  }
  if (cacheKind === "token" && typeof value.access_token === "string") {
    await oauthCache.saveTokenResponse(value);
  }
}

function isJsonLike(contentType) {
  const type = String(contentType ?? "").toLowerCase();
  return type.includes("application/json") || type.includes("+json");
}

function normalizePath(path) {
  return path.startsWith("/") ? path : `/${path}`;
}

function normalizePort(value) {
  const port = typeof value === "number" ? value : Number(value);
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    throw new Error(`Invalid bridge port: ${value}`);
  }
  return port;
}

export class OAuthCache {
  constructor(path, options = {}) {
    this.path = resolve(path);
    this.now = options.now ?? (() => Date.now());
    this.store = new AtomicCredentialStore(this.path, {
      empty: () => ({}),
      parse: parseJsonState,
      now: this.now,
      lockTimeoutMs: options.lockTimeoutMs,
      lockRetryMs: options.lockRetryMs,
    });
  }

  async read() {
    return this.store.read();
  }

  async write(state) {
    await this.store.write(state);
  }

  async update(fn) {
    return this.store.update(fn);
  }

  async withLock(fn) {
    return this.store.withLock(fn);
  }

  async saveClientInformation(clientInformation) {
    await this.update((state) => ({
      ...state,
      clientInformation,
      updatedAt: new Date(this.now()).toISOString(),
    }));
  }

  async saveTokenResponse(tokenResponse) {
    await this.update((state) => mergeTokenResponse(state, tokenResponse, this.now()));
  }

  async getUsableAccessToken() {
    return (await this.getUsableAccessTokenSnapshot())?.accessToken;
  }

  async getUsableAccessTokenSnapshot() {
    const snapshot = await this.store.readSnapshot();
    const accessToken = usableAccessToken(snapshot.state, this.now());
    return accessToken
      ? { accessToken, fingerprint: snapshot.fingerprint }
      : undefined;
  }

  async clearTokens(expectedFingerprint) {
    return this.store.withLock(async (locked) => {
      const snapshot = await locked.readSnapshot();
      if (
        expectedFingerprint !== undefined &&
        snapshot.fingerprint !== expectedFingerprint
      ) {
        return false;
      }
      await locked.write(withoutTokens(snapshot.state, this.now()));
      return true;
    });
  }

  async invalidateAccessToken(expectedFingerprint) {
    return this.store.withLock(async (locked) => {
      const snapshot = await locked.readSnapshot();
      if (
        expectedFingerprint !== undefined &&
        snapshot.fingerprint !== expectedFingerprint
      ) {
        return false;
      }
      const tokens = { ...(snapshot.state.tokens ?? {}) };
      delete tokens.access_token;
      delete tokens.expires_at;
      await locked.write({
        ...snapshot.state,
        tokens,
        updatedAt: new Date(this.now()).toISOString(),
      });
      return true;
    });
  }

  async clear() {
    await this.store.clear();
  }
}

export class OAuthRefreshError extends Error {
  constructor(kind, message, options = {}) {
    super(message, { cause: options.cause });
    this.name = "OAuthRefreshError";
    this.kind = kind;
    this.status = options.status;
    this.oauthCode = options.oauthCode;
  }
}

class BridgeHttpError extends Error {
  constructor(status, message) {
    super(message);
    this.name = "BridgeHttpError";
    this.status = status;
  }
}

function findBridgeHttpError(error) {
  const visited = new Set();
  let current = error;
  while (current && typeof current === "object" && !visited.has(current)) {
    if (current instanceof BridgeHttpError) {
      return current;
    }
    visited.add(current);
    current = current.cause;
  }
  return undefined;
}

function assertDeclaredBodyLimit(value, limit, label, activity) {
  const normalized = Array.isArray(value) ? value[0] : value;
  if (normalized === undefined) return;
  const length = Number(normalized);
  if (Number.isFinite(length) && length > limit) {
    const error = new BridgeHttpError(413, `${label} exceeds ${limit} bytes.`);
    activity?.abort(error);
    throw error;
  }
}

async function assertUpstreamResponseLength(value, limit, label, body, activity) {
  if (value === undefined || value === null) return;
  const length = Number(value);
  if (Number.isFinite(length) && length > limit) {
    const error = new BridgeHttpError(502, `${label} exceeds ${limit} bytes.`);
    await body?.cancel(error).catch(() => undefined);
    activity?.abort(error);
    throw error;
  }
}

function createRequestActivityController(controller, request, response, options = {}) {
  const totalTimeoutMs = options.totalTimeoutMs ?? BRIDGE_TOTAL_TIMEOUT_MS;
  const idleTimeoutMs = options.idleTimeoutMs ?? BRIDGE_IDLE_TIMEOUT_MS;
  let idleTimer;
  const totalTimer = setTimeout(() => {
    controller.abort(new Error("Bridge request exceeded the 5 minute total timeout."));
  }, totalTimeoutMs);
  const touch = () => {
    clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      controller.abort(new Error("Bridge request was idle for more than 60 seconds."));
    }, idleTimeoutMs);
  };
  const abortDisconnectedClient = () => {
    if (!response.writableEnded) {
      controller.abort(new Error("Bridge client disconnected."));
    }
  };
  request.once("aborted", abortDisconnectedClient);
  response.once("close", abortDisconnectedClient);
  const destroyIncomingRequest = () => {
    if (!request.destroyed) {
      request.destroy();
    }
  };
  controller.signal.addEventListener("abort", destroyIncomingRequest, { once: true });
  touch();
  return {
    touch,
    abort(reason) {
      if (!controller.signal.aborted) {
        controller.abort(reason instanceof Error ? reason : new Error(String(reason)));
      }
    },
    close() {
      clearTimeout(totalTimer);
      clearTimeout(idleTimer);
      request.off("aborted", abortDisconnectedClient);
      response.off("close", abortDisconnectedClient);
      controller.signal.removeEventListener("abort", destroyIncomingRequest);
    },
  };
}

export function createLimitedNodeStream(readable, limit, activity, label, signal) {
  const stream = createCountingTransform(limit, activity, label);
  return {
    stream,
    completion: pipeline(readable, stream, signal ? { signal } : {}),
  };
}

function createCountingTransform(limit, activity, label) {
  let total = 0;
  return new Transform({
    transform(chunk, _encoding, callback) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      total += buffer.byteLength;
      activity?.touch();
      if (total > limit) {
        callback(new BridgeHttpError(413, `${label} exceeds ${limit} bytes.`));
        return;
      }
      callback(null, buffer);
    },
  });
}

async function readWebResponseBody(response, limit, activity, label) {
  const contentLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(contentLength) && contentLength > limit) {
    const error = new BridgeHttpError(502, `${label} exceeds ${limit} bytes.`);
    await response.body?.cancel(error).catch(() => undefined);
    activity?.abort(error);
    throw error;
  }
  if (!response.body) {
    return Buffer.alloc(0);
  }
  const chunks = [];
  let total = 0;
  for await (const chunk of Readable.fromWeb(response.body)) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += buffer.byteLength;
    activity?.touch();
    if (total > limit) {
      throw new BridgeHttpError(502, `${label} exceeds ${limit} bytes.`);
    }
    chunks.push(buffer);
  }
  return Buffer.concat(chunks, total);
}

async function fetchWithBridgeAbort(input, init, activity, fetchImplementation = fetch) {
  try {
    return await fetchImplementation(input, init);
  } catch (error) {
    activity?.abort(error);
    throw error;
  }
}

function parseJsonObject(body) {
  try {
    return parseJsonState(body.toString("utf8"));
  } catch {
    return undefined;
  }
}

function parseJsonState(json) {
  const value = JSON.parse(json);
  return value && typeof value === "object" && !Array.isArray(value)
    ? value
    : {};
}

function usableAccessToken(state, now) {
  const token = state.tokens?.access_token;
  if (typeof token !== "string" || token.length === 0) {
    return undefined;
  }
  const expiresAt = state.tokens?.expires_at;
  if (typeof expiresAt === "number" && expiresAt <= now + 60_000) {
    return undefined;
  }
  return token;
}

function mergeTokenResponse(state, tokenResponse, now) {
  const previousTokens = state.tokens ?? {};
  const expiresIn = typeof tokenResponse.expires_in === "number"
    ? tokenResponse.expires_in
    : Number(tokenResponse.expires_in);
  const expiresAt = Number.isFinite(expiresIn) && expiresIn > 0
    ? now + expiresIn * 1000
    : undefined;
  return {
    ...state,
    tokens: {
      ...previousTokens,
      ...tokenResponse,
      refresh_token: tokenResponse.refresh_token ?? previousTokens.refresh_token,
      expires_at: expiresAt,
    },
    updatedAt: new Date(now).toISOString(),
  };
}

function withoutTokens(state, now) {
  const next = { ...state };
  delete next.tokens;
  next.updatedAt = new Date(now).toISOString();
  return next;
}

async function closeBridgeServer(server, activeControllers, sockets) {
  if (!server.listening) {
    return;
  }
  let timer;
  await new Promise((resolvePromise, reject) => {
    let settled = false;
    const finish = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error);
      else resolvePromise();
    };
    timer = setTimeout(() => {
      for (const controller of activeControllers) {
        controller.abort(new Error("Figma MCP bridge is shutting down."));
      }
      for (const socket of sockets) {
        socket.destroy();
      }
      server.closeAllConnections?.();
    }, BRIDGE_SHUTDOWN_GRACE_MS);
    server.close(finish);
  });
}

function publicBaseUrl(config) {
  return `http://${config.host}:${config.port}`;
}

function publicMcpUrl(config) {
  return `${publicBaseUrl(config)}${config.path}`;
}

function publicProtectedResourceUrl(config) {
  return `${publicBaseUrl(config)}${PROTECTED_RESOURCE_PATH}`;
}

if (isDirectRun()) {
  const bridge = await startFigmaMcpBridge();
  console.error(`Figma MCP bridge listening on ${bridge.url}`);
  console.error(`Forwarding to ${bridge.target}`);
  if (bridge.oauthCacheEnabled) {
    console.error(`OAuth cache enabled at ${bridge.oauthCachePath}`);
  }
}

function isDirectRun() {
  return resolve(fileURLToPath(import.meta.url)) === resolve(process.argv[1] ?? "");
}
