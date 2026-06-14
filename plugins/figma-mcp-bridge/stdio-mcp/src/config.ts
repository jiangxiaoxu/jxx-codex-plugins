import { resolve } from "node:path";
import type { OAuthClientMetadata } from "@modelcontextprotocol/sdk/shared/auth.js";
import {
  DEFAULT_AUTH_TIMEOUT_MS,
  DEFAULT_CALLBACK_HOST,
  DEFAULT_CALLBACK_PATH,
  DEFAULT_CALLBACK_PORT,
  DEFAULT_CLIENT_NAME,
  DEFAULT_CLIENT_VERSION,
  BRIDGE_OAUTH_CACHE_FILENAME,
  DEFAULT_FIGMA_MCP_ENDPOINT,
  DEFAULT_OAUTH_STATE_PATH,
} from "./constants.js";

export interface NodeReplConfig {
  endpoint: string;
  statePath: string;
  callbackHost: string;
  callbackPort: number;
  callbackPath: string;
  callbackUrl: string;
  authTimeoutMs: number;
  openBrowser: boolean;
  clientName: string;
  clientVersion: string;
  clientMetadata: OAuthClientMetadata;
  useBridgeOAuthCache: boolean;
}

export interface NodeReplConfigInput {
  endpoint?: string;
  statePath?: string;
  callbackHost?: string;
  callbackPort?: number;
  callbackPath?: string;
  authTimeoutMs?: number;
  openBrowser?: boolean;
  clientName?: string;
  clientVersion?: string;
  clientMetadata?: Partial<OAuthClientMetadata>;
  useBridgeOAuthCache?: boolean;
}

export function normalizeCallbackPath(path: string): string {
  return path.startsWith("/") ? path : `/${path}`;
}

export function createCallbackUrl(options: {
  host?: string;
  port?: number;
  path?: string;
} = {}): string {
  const host = options.host ?? DEFAULT_CALLBACK_HOST;
  const port = options.port ?? DEFAULT_CALLBACK_PORT;
  const path = normalizeCallbackPath(options.path ?? DEFAULT_CALLBACK_PATH);
  return `http://${host}:${port}${path}`;
}

export function createClientMetadata(
  redirectUrl: string,
  overrides: Partial<OAuthClientMetadata> = {},
): OAuthClientMetadata {
  return {
    grant_types: ["authorization_code", "refresh_token"],
    response_types: ["code"],
    token_endpoint_auth_method: "client_secret_post",
    ...overrides,
    client_name: overrides.client_name ?? DEFAULT_CLIENT_NAME,
    redirect_uris: overrides.redirect_uris ?? [redirectUrl],
  };
}

function readEnv(name: string): string | undefined {
  if (typeof process === "undefined") {
    return undefined;
  }
  return process.env[name];
}

export function findCodexHomeOAuthCachePath(
  env: Record<string, string | undefined> = typeof process === "undefined"
    ? {}
    : process.env,
): string | undefined {
  if (env.CODEX_HOME) {
    return resolve(env.CODEX_HOME, BRIDGE_OAUTH_CACHE_FILENAME);
  }
  if (env.USERPROFILE) {
    return resolve(env.USERPROFILE, ".codex", BRIDGE_OAUTH_CACHE_FILENAME);
  }
  return undefined;
}

export function createConfig(input: NodeReplConfigInput = {}): NodeReplConfig {
  const callbackHost = input.callbackHost ?? DEFAULT_CALLBACK_HOST;
  const callbackPort = input.callbackPort ?? DEFAULT_CALLBACK_PORT;
  const callbackPath = normalizeCallbackPath(input.callbackPath ?? DEFAULT_CALLBACK_PATH);
  const callbackUrl = createCallbackUrl({
    host: callbackHost,
    port: callbackPort,
    path: callbackPath,
  });
  const useBridgeOAuthCache =
    input.useBridgeOAuthCache ??
    (readEnv("FIGMA_MCP_USE_BRIDGE_OAUTH_CACHE") === "1");
  const statePath =
    input.statePath ??
    readEnv("FIGMA_MCP_OAUTH_CACHE_PATH") ??
    (useBridgeOAuthCache
      ? findCodexHomeOAuthCachePath() ?? missingBridgeOAuthCachePath()
      : DEFAULT_OAUTH_STATE_PATH);

  return {
    endpoint: input.endpoint ?? DEFAULT_FIGMA_MCP_ENDPOINT,
    statePath: resolve(statePath),
    callbackHost,
    callbackPort,
    callbackPath,
    callbackUrl,
    authTimeoutMs: input.authTimeoutMs ?? DEFAULT_AUTH_TIMEOUT_MS,
    openBrowser: input.openBrowser ?? true,
    clientName: input.clientName ?? DEFAULT_CLIENT_NAME,
    clientVersion: input.clientVersion ?? DEFAULT_CLIENT_VERSION,
    clientMetadata: createClientMetadata(callbackUrl, input.clientMetadata),
    useBridgeOAuthCache,
  };
}

function missingBridgeOAuthCachePath(): never {
  throw new Error(
    "Unable to resolve Figma MCP OAuth cache path. Set FIGMA_MCP_OAUTH_CACHE_PATH, CODEX_HOME, or USERPROFILE.",
  );
}
