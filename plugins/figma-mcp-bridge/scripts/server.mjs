#!/usr/bin/env node

import { createServer } from "node:http";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";

export const DEFAULT_TARGET = "https://mcp.figma.com/mcp";
export const DEFAULT_HOST = "127.0.0.1";
export const DEFAULT_PORT = 18766;
export const DEFAULT_PATH = "/mcp";
export const OAUTH_CACHE_FILENAME = ".figma-mcp-bridge-oauth.json";
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
  const server = createServer((request, response) => {
    void handleBridgeRequest(config, request, response, { oauthCache });
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
    close: () =>
      new Promise((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      }),
  };
}

export function createBridgeConfig(options = {}) {
  return {
    host: options.host ?? process.env.FIGMA_MCP_BRIDGE_HOST ?? DEFAULT_HOST,
    port: normalizePort(options.port ?? process.env.FIGMA_MCP_BRIDGE_PORT ?? DEFAULT_PORT),
    path: normalizePath(options.path ?? process.env.FIGMA_MCP_BRIDGE_PATH ?? DEFAULT_PATH),
    target: new URL(options.target ?? process.env.FIGMA_MCP_BRIDGE_TARGET ?? DEFAULT_TARGET).toString(),
    log: options.log ?? process.env.FIGMA_MCP_BRIDGE_LOG === "1",
    oauthCacheEnabled:
      options.oauthCacheEnabled ??
      process.env.FIGMA_MCP_BRIDGE_OAUTH_CACHE !== "0",
    oauthCachePath:
      options.oauthCachePath ??
      process.env.FIGMA_MCP_OAUTH_CACHE_PATH ??
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
    "Unable to resolve Figma MCP OAuth cache path. Set FIGMA_MCP_OAUTH_CACHE_PATH, CODEX_HOME, or USERPROFILE.",
  );
}

export async function handleBridgeRequest(config, request, response, runtime = {}) {
  try {
    const incomingUrl = new URL(request.url ?? "/", `http://${config.host}:${config.port}`);
    if (incomingUrl.pathname === PROTECTED_RESOURCE_PATH) {
      await handleProtectedResourceMetadata(config, request, response);
      return;
    }
    if (incomingUrl.pathname === AUTHORIZATION_SERVER_METADATA_PATH) {
      await handleAuthorizationServerMetadata(config, request, response);
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
      });
      return;
    }
    if (incomingUrl.pathname === OAUTH_REGISTER_PATH) {
      await proxyOAuthEndpoint(FIGMA_REGISTRATION_ENDPOINT, request, response, {
        config,
        oauthCache: runtime.oauthCache,
        cacheKind: "client",
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

    const { headers, injectedCachedToken } = await createMcpRequestHeaders(
      config,
      request.headers,
      runtime.oauthCache,
    );
    const hasBody = request.method !== "GET" && request.method !== "HEAD";
    const upstream = await fetch(targetUrl, {
      method: request.method,
      headers,
      body: hasBody ? request : undefined,
      duplex: hasBody ? "half" : undefined,
      redirect: "manual",
    });

    if (config.log) {
      console.error(
        `${request.method} ${incomingUrl.pathname}${incomingUrl.search} -> ${upstream.status}`,
      );
    }
    if (injectedCachedToken && upstream.status === 401) {
      await runtime.oauthCache?.clearTokens();
    }

    const responseHeaders = rewriteResponseHeaders(
      copyResponseHeaders(upstream.headers),
      config,
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

    await pipeWebStream(upstream.body, response);
  } catch (error) {
    response.writeHead(502, { "content-type": "text/plain; charset=utf-8" });
    response.end(error instanceof Error ? error.message : String(error));
  }
}

export async function handleProtectedResourceMetadata(config, request, response) {
  if (request.method !== "GET" && request.method !== "HEAD") {
    response.writeHead(405, { allow: "GET, HEAD" });
    response.end();
    return;
  }

  const upstream = await fetch(
    new URL(PROTECTED_RESOURCE_PATH, config.target).toString(),
    {
      method: "GET",
      headers: copyRequestHeaders(request.headers),
      redirect: "manual",
    },
  );

  const text = await upstream.text();
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

export async function handleAuthorizationServerMetadata(config, request, response) {
  if (request.method !== "GET" && request.method !== "HEAD") {
    response.writeHead(405, { allow: "GET, HEAD" });
    response.end();
    return;
  }

  const upstream = await fetch(FIGMA_AUTHORIZATION_SERVER_METADATA, {
    method: "GET",
    headers: copyRequestHeaders(request.headers),
    redirect: "manual",
  });

  const text = await upstream.text();
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
  const requestBody = hasBody ? await readRequestBody(request) : undefined;
  const rewrittenBody =
    requestBody && options.config
      ? rewriteOAuthRequestBody(
          request.headers["content-type"],
          requestBody,
          options.config,
        )
      : requestBody;
  const upstream = await fetch(target, {
    method: request.method,
    headers: copyRequestHeaders(request.headers, { dropContentLength: true }),
    body: rewrittenBody,
    duplex: hasBody ? "half" : undefined,
    redirect: "manual",
  });

  const responseHeaders = copyResponseHeaders(upstream.headers);
  const responseBody = upstream.body ? Buffer.from(await upstream.arrayBuffer()) : undefined;
  if (upstream.ok && responseBody && options.oauthCache) {
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

export async function createMcpRequestHeaders(config, input, oauthCache) {
  const headers = copyRequestHeaders(input);
  if (headers.has("authorization") || !oauthCache) {
    return { headers, injectedCachedToken: false };
  }

  const accessToken = await oauthCache.getUsableAccessToken();
  if (accessToken) {
    headers.set("authorization", `Bearer ${accessToken}`);
    return { headers, injectedCachedToken: true };
  }

  const refreshed = await refreshAccessToken(config, oauthCache);
  if (refreshed?.access_token) {
    headers.set("authorization", `Bearer ${refreshed.access_token}`);
    return { headers, injectedCachedToken: true };
  }

  return { headers, injectedCachedToken: false };
}

export async function refreshAccessToken(config, oauthCache) {
  const state = await oauthCache.read();
  const refreshToken = state.tokens?.refresh_token;
  const clientId = state.clientInformation?.client_id;
  if (!refreshToken || !clientId) {
    return undefined;
  }

  const params = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: refreshToken,
    client_id: clientId,
  });
  if (state.clientInformation?.client_secret) {
    params.set("client_secret", state.clientInformation.client_secret);
  }
  params.set("resource", config.target);

  const response = await fetch(FIGMA_TOKEN_ENDPOINT, {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      accept: "application/json",
    },
    body: params,
  });

  if (!response.ok) {
    await oauthCache.clearTokens();
    return undefined;
  }

  const tokenResponse = await response.json();
  await oauthCache.saveTokenResponse(tokenResponse);
  return tokenResponse;
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

async function pipeWebStream(readable, response) {
  const reader = readable.getReader();
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      response.write(Buffer.from(value));
    }
    response.end();
  } finally {
    reader.releaseLock();
  }
}

async function readRequestBody(request) {
  const chunks = [];
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
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
    this.path = path;
    this.now = options.now ?? (() => Date.now());
  }

  async read() {
    try {
      const value = JSON.parse(await readFile(this.path, "utf8"));
      return value && typeof value === "object" && !Array.isArray(value)
        ? value
        : {};
    } catch (error) {
      if (error?.code === "ENOENT") {
        return {};
      }
      throw error;
    }
  }

  async write(state) {
    await mkdir(dirname(this.path), { recursive: true });
    const tmpPath = `${this.path}.tmp`;
    await writeFile(tmpPath, `${JSON.stringify(state, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
    await rename(tmpPath, this.path);
  }

  async update(fn) {
    const next = fn(await this.read());
    await this.write(next);
    return next;
  }

  async saveClientInformation(clientInformation) {
    await this.update((state) => ({
      ...state,
      clientInformation,
      updatedAt: new Date(this.now()).toISOString(),
    }));
  }

  async saveTokenResponse(tokenResponse) {
    await this.update((state) => {
      const previousTokens = state.tokens ?? {};
      const expiresIn =
        typeof tokenResponse.expires_in === "number"
          ? tokenResponse.expires_in
          : Number(tokenResponse.expires_in);
      const expiresAt =
        Number.isFinite(expiresIn) && expiresIn > 0
          ? this.now() + expiresIn * 1000
          : undefined;
      return {
        ...state,
        tokens: {
          ...previousTokens,
          ...tokenResponse,
          refresh_token:
            tokenResponse.refresh_token ?? previousTokens.refresh_token,
          expires_at: expiresAt,
        },
        updatedAt: new Date(this.now()).toISOString(),
      };
    });
  }

  async getUsableAccessToken() {
    const state = await this.read();
    const token = state.tokens?.access_token;
    if (typeof token !== "string") {
      return undefined;
    }
    const expiresAt = state.tokens?.expires_at;
    if (typeof expiresAt === "number" && expiresAt <= this.now() + 60000) {
      return undefined;
    }
    return token;
  }

  async clearTokens() {
    await this.update((state) => {
      const next = { ...state };
      delete next.tokens;
      next.updatedAt = new Date(this.now()).toISOString();
      return next;
    });
  }

  async clear() {
    await rm(this.path, { force: true });
  }
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
