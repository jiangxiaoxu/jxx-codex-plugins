import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { UnauthorizedError } from "@modelcontextprotocol/sdk/client/auth.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type {
  ListResourceTemplatesResult,
  ListResourcesResult,
  ListToolsResult,
  ReadResourceResult,
} from "@modelcontextprotocol/sdk/types.js";
import { openBrowser as defaultOpenBrowser } from "../auth/browser.js";
import {
  createConfig,
  type NodeReplConfig,
  type NodeReplConfigInput,
} from "../auth/config.js";
import { PersistentOAuthProvider } from "../auth/oauth-provider.js";
import {
  OAuthCallbackError,
  startOAuthCallbackServer,
  type OAuthCallbackServer,
  type OAuthCallbackServerOptions,
} from "../auth/oauth-callback.js";

interface RemoteMcpConnection {
  client: Client;
  transport: StreamableHTTPClientTransport;
}

const OAUTH_CACHE_FILE_NAME = ".figma-workspace-oauth.json";
const LOGIN_COMMAND = "npm run login:figma-http";
const REMOTE_MCP_REQUEST_TOTAL_TIMEOUT_MS = 5 * 60 * 1000;

export const REMOTE_MCP_OAUTH_ERROR_CODES = [
  "FIGMA_UPSTREAM_AUTH_REQUIRED",
  "FIGMA_UPSTREAM_OAUTH_REGISTRATION_REJECTED",
  "FIGMA_UPSTREAM_OAUTH_CALLBACK_TIMEOUT",
  "FIGMA_UPSTREAM_OAUTH_CANCELLED",
  "FIGMA_UPSTREAM_OAUTH_CALLBACK_PORT_IN_USE",
  "FIGMA_UPSTREAM_OAUTH_CALLBACK_STARTUP_FAILED",
  "FIGMA_UPSTREAM_OAUTH_CALLBACK_FAILED",
  "FIGMA_UPSTREAM_OAUTH_TOKEN_EXCHANGE_FAILED",
] as const;

export type RemoteMcpOAuthErrorCode = (typeof REMOTE_MCP_OAUTH_ERROR_CODES)[number];

export interface RemoteMcpOAuthErrorDetails {
  [key: string]: unknown;
  loginCommand?: string;
  oauthCacheFile?: string;
}

export class RemoteMcpOAuthError extends Error {
  readonly code: RemoteMcpOAuthErrorCode;
  readonly details?: RemoteMcpOAuthErrorDetails;

  constructor(
    code: RemoteMcpOAuthErrorCode,
    message: string,
    options: { cause?: unknown; details?: RemoteMcpOAuthErrorDetails } = {},
  ) {
    super(message, { cause: options.cause });
    this.name = "RemoteMcpOAuthError";
    this.code = code;
    this.details = options.details;
  }
}

export function isRemoteMcpOAuthError(error: unknown): error is RemoteMcpOAuthError {
  if (error instanceof RemoteMcpOAuthError) {
    return true;
  }
  if (!isRecord(error)) {
    return false;
  }
  return (
    error.name === "RemoteMcpOAuthError" &&
    typeof error.code === "string" &&
    (REMOTE_MCP_OAUTH_ERROR_CODES as readonly string[]).includes(error.code)
  );
}

export interface RemoteMcpClientOptions extends NodeReplConfigInput {
  onAuthorizationUrl?: (authorizationUrl: URL) => void | Promise<void>;
  callbackServerFactory?: (
    options: OAuthCallbackServerOptions,
  ) => Promise<OAuthCallbackServer>;
}

export class RemoteMcpClient {
  readonly config: NodeReplConfig;
  readonly authProvider: PersistentOAuthProvider;
  private readonly callbackServerFactory: (
    options: OAuthCallbackServerOptions,
  ) => Promise<OAuthCallbackServer>;
  private client?: Client;
  private transport?: StreamableHTTPClientTransport;
  private callbackServer?: OAuthCallbackServer;
  private connectPromise?: Promise<void>;
  private connectionGeneration = 0;
  private readonly closedCallbackServers = new WeakSet<OAuthCallbackServer>();

  constructor(options: RemoteMcpClientOptions = {}) {
    this.config = createConfig(options);
    this.callbackServerFactory =
      options.callbackServerFactory ?? startOAuthCallbackServer;
    this.authProvider = new PersistentOAuthProvider({
      redirectUrl: this.config.callbackUrl,
      clientMetadata: this.config.clientMetadata,
      statePath: this.config.statePath,
      onRedirect: async (authorizationUrl) => {
        await options.onAuthorizationUrl?.(authorizationUrl);
        console.error(
          `Open this URL to authorize MCP access:\n${authorizationUrl.toString()}`,
        );
        if (this.config.openBrowser) {
          const opened = await defaultOpenBrowser(authorizationUrl);
          if (!opened) {
            console.error("Could not open a browser automatically.");
          }
        }
      },
    });
  }

  async connect(): Promise<void> {
    if (this.client) {
      return;
    }

    const connectionGeneration = this.connectionGeneration;
    const connectPromise =
      this.connectPromise ??
      (this.connectPromise = this.connectWithOAuthRetry(connectionGeneration));
    try {
      await connectPromise;
    } finally {
      if (this.connectPromise === connectPromise) {
        this.connectPromise = undefined;
      }
    }
  }

  private async connectWithOAuthRetry(
    connectionGeneration: number,
  ): Promise<void> {
    try {
      await this.setConnectedIfCurrent(
        await this.connectOnce(connectionGeneration),
        connectionGeneration,
      );
      return;
    } catch (error) {
      if (error instanceof StaleConnectionError) {
        throw oauthCancelledError(error);
      }
      const unauthorizedTransport = this.transport;
      const registrationRejection = extractRegistrationRejection(error);
      if (registrationRejection) {
        await this.closeTransport(unauthorizedTransport, {
          clearInFlight: false,
        });
        throw new RemoteMcpOAuthError(
          "FIGMA_UPSTREAM_OAUTH_REGISTRATION_REJECTED",
          "Figma MCP OAuth client registration was rejected before a browser authorization URL was issued.",
          {
            cause: error,
            details: {
              oauthCacheFile: OAUTH_CACHE_FILE_NAME,
              upstreamStatus: registrationRejection.status,
              upstreamCode: registrationRejection.code,
            },
          },
        );
      }
      if (!isUnauthorizedError(error) || !unauthorizedTransport) {
        await this.closeTransport(unauthorizedTransport, {
          clearInFlight: false,
        });
        if (isUnauthorizedError(error)) {
          throw authRequiredError(error);
        }
        throw error;
      }

      let callbackServer: OAuthCallbackServer | undefined;

      try {
        try {
          callbackServer = await this.callbackServerFactory({
            host: this.config.callbackHost,
            port: this.config.callbackPort,
            path: this.config.callbackPath,
            timeoutMs: this.config.authTimeoutMs,
            getExpectedState: () => this.authProvider.expectedState(),
          });
        } catch (callbackServerError) {
          if (!this.isCurrentConnectionAttempt(connectionGeneration)) {
            throw oauthCancelledError(new StaleConnectionError());
          }
          throw oauthCallbackError(callbackServerError);
        }
        if (!this.trackCallbackServer(callbackServer, connectionGeneration)) {
          await this.closeCallbackServer(callbackServer);
          throw oauthCancelledError(new StaleConnectionError());
        }
        let authorizationCode: string;
        try {
          authorizationCode = await callbackServer.waitForCode();
        } catch (callbackError) {
          throw oauthCallbackError(callbackError);
        }
        if (!this.isCurrentConnectionAttempt(connectionGeneration)) {
          throw oauthCancelledError(new StaleConnectionError());
        }
        try {
          await unauthorizedTransport.finishAuth(authorizationCode);
        } catch (finishAuthError) {
          throw oauthTokenExchangeFailedError(finishAuthError);
        }
      } finally {
        await this.closeTransport(unauthorizedTransport, {
          clearInFlight: false,
        });
        await this.closeCallbackServer(callbackServer);
      }

      try {
        await this.setConnectedIfCurrent(
          await this.connectOnce(connectionGeneration),
          connectionGeneration,
        );
      } catch (postAuthError) {
        if (postAuthError instanceof StaleConnectionError) {
          throw oauthCancelledError(postAuthError);
        }
        throw postAuthError;
      }
    }
  }

  protected async connectOnce(
    connectionGeneration = this.connectionGeneration,
  ): Promise<RemoteMcpConnection> {
    const client = new Client(
      {
        name: this.config.clientName,
        version: this.config.clientVersion,
      },
      { capabilities: {} },
    );
    const transport = new StreamableHTTPClientTransport(
      new URL(this.config.endpoint),
      {
        authProvider: this.authProvider,
      },
    );
    if (!this.trackTransport(transport, connectionGeneration)) {
      await transport.close().catch(() => undefined);
      throw new StaleConnectionError();
    }
    try {
      await this.authProvider.runWithRefreshLockIfNeeded(() =>
        client.connect(transport));
    } catch (error) {
      if (!this.isCurrentConnectionAttempt(connectionGeneration)) {
        await transport.close().catch(() => undefined);
        throw new StaleConnectionError();
      }
      throw error;
    }
    if (!this.isCurrentConnectionAttempt(connectionGeneration)) {
      await this.closeTransport(transport, { clearInFlight: false });
      throw new StaleConnectionError();
    }
    return { client, transport };
  }

  async close(): Promise<void> {
    await this.closeTransport(this.transport, { clearInFlight: true });
  }

  private requireClient(): Client {
    if (!this.client) {
      throw new Error("MCP client is not connected.");
    }
    return this.client;
  }

  async listTools(signal?: AbortSignal): Promise<ListToolsResult> {
    return this.requireClient().listTools({}, remoteRequestOptions(signal));
  }

  async callTool(
    name: string,
    args: Record<string, unknown> = {},
    signal?: AbortSignal,
  ): Promise<unknown> {
    return this.requireClient().callTool(
      { name, arguments: args },
      undefined,
      remoteRequestOptions(signal),
    );
  }

  async listResources(signal?: AbortSignal): Promise<ListResourcesResult> {
    return this.requireClient().listResources({}, remoteRequestOptions(signal));
  }

  async listResourceTemplates(signal?: AbortSignal): Promise<ListResourceTemplatesResult> {
    return this.requireClient().listResourceTemplates({}, remoteRequestOptions(signal));
  }

  async readResource(uri: string, signal?: AbortSignal): Promise<ReadResourceResult> {
    return this.requireClient().readResource({ uri }, remoteRequestOptions(signal));
  }

  private async setConnectedIfCurrent(
    connection: RemoteMcpConnection,
    connectionGeneration: number,
  ): Promise<void> {
    if (!this.isCurrentConnectionAttempt(connectionGeneration)) {
      await this.closeTransport(connection.transport, { clearInFlight: false });
      throw new StaleConnectionError();
    }
    this.setConnected(connection);
  }

  private setConnected(connection: RemoteMcpConnection): void {
    if (this.transport !== connection.transport) {
      this.trackTransport(connection.transport);
    }
    this.client = connection.client;
  }

  private trackTransport(
    transport: StreamableHTTPClientTransport,
    connectionGeneration = this.connectionGeneration,
  ): boolean {
    if (!this.isCurrentConnectionAttempt(connectionGeneration)) {
      return false;
    }
    const existingOnClose = transport.onclose;
    const existingOnError = transport.onerror;
    this.transport = transport;
    transport.onclose = () => {
      existingOnClose?.();
      const callbackServer = this.resetConnection(transport);
      void this.closeCallbackServer(callbackServer);
    };
    transport.onerror = (error) => {
      existingOnError?.(error);
    };
    return true;
  }

  private async closeTransport(
    transport: StreamableHTTPClientTransport | undefined,
    { clearInFlight }: { clearInFlight: boolean },
  ): Promise<void> {
    const callbackServer = this.resetConnection(transport, { clearInFlight });
    await Promise.all([
      transport?.close().catch(() => undefined),
      this.closeCallbackServer(callbackServer),
    ]);
  }

  private resetConnection(
    transport?: StreamableHTTPClientTransport,
    { clearInFlight = true }: { clearInFlight?: boolean } = {},
  ): OAuthCallbackServer | undefined {
    if (transport && this.transport !== transport) {
      return undefined;
    }
    this.client = undefined;
    this.transport = undefined;
    if (clearInFlight) {
      this.connectionGeneration += 1;
      this.connectPromise = undefined;
      const callbackServer = this.callbackServer;
      this.callbackServer = undefined;
      return callbackServer;
    }
    return undefined;
  }

  private isCurrentConnectionAttempt(connectionGeneration: number): boolean {
    return connectionGeneration === this.connectionGeneration;
  }

  private trackCallbackServer(
    callbackServer: OAuthCallbackServer,
    connectionGeneration: number,
  ): boolean {
    if (!this.isCurrentConnectionAttempt(connectionGeneration)) {
      return false;
    }
    this.callbackServer = callbackServer;
    return true;
  }

  private async closeCallbackServer(
    callbackServer: OAuthCallbackServer | undefined,
  ): Promise<void> {
    if (!callbackServer || this.closedCallbackServers.has(callbackServer)) {
      return;
    }
    if (this.callbackServer === callbackServer) {
      this.callbackServer = undefined;
    }
    this.closedCallbackServers.add(callbackServer);
    await callbackServer.close().catch(() => undefined);
  }
}

function remoteRequestOptions(signal: AbortSignal | undefined): {
  signal?: AbortSignal;
  timeout: number;
  maxTotalTimeout: number;
} {
  return {
    signal,
    timeout: REMOTE_MCP_REQUEST_TOTAL_TIMEOUT_MS,
    maxTotalTimeout: REMOTE_MCP_REQUEST_TOTAL_TIMEOUT_MS,
  };
}

export function createRemoteMcpClient(
  options: RemoteMcpClientOptions = {},
): RemoteMcpClient {
  return new RemoteMcpClient(options);
}

function extractRegistrationRejection(
  error: unknown,
): { status?: number; code?: string } | undefined {
  const signals = collectErrorStatusSignals(error);
  if (signals.status !== undefined) {
    return signals.status === 403
      ? { status: signals.status, code: signals.code }
      : undefined;
  }
  if (signals.code !== undefined) {
    return isForbiddenStatusCode(signals.code)
      ? { code: signals.code }
      : undefined;
  }

  const message = messageFromUnknown(error);
  if (!message) {
    return undefined;
  }
  return /\bHTTP 403\b/u.test(message) && /\bForbidden\b/u.test(message)
    ? {}
    : undefined;
}

function authRequiredError(error: unknown): RemoteMcpOAuthError {
  return new RemoteMcpOAuthError(
    "FIGMA_UPSTREAM_AUTH_REQUIRED",
    "Figma MCP upstream authentication is required or incomplete.",
    {
      cause: error,
      details: defaultOAuthRecoveryDetails(),
    },
  );
}

function oauthCallbackError(error: unknown): RemoteMcpOAuthError {
  if (error instanceof OAuthCallbackError) {
    switch (error.code) {
      case "OAUTH_CALLBACK_TIMEOUT":
        return new RemoteMcpOAuthError(
          "FIGMA_UPSTREAM_OAUTH_CALLBACK_TIMEOUT",
          "Figma MCP OAuth browser authorization timed out.",
          {
            cause: error,
            details: defaultOAuthRecoveryDetails(),
          },
        );
      case "OAUTH_CALLBACK_CANCELLED":
        return oauthCancelledError(error);
      case "OAUTH_CALLBACK_PORT_IN_USE":
        return oauthCallbackPortInUseError(error);
      case "OAUTH_CALLBACK_STARTUP_FAILED":
        return oauthCallbackStartupFailedError(error);
      case "OAUTH_CALLBACK_AUTHORIZATION_FAILED":
      case "OAUTH_CALLBACK_INTERNAL_ERROR":
      case "OAUTH_CALLBACK_MISSING_CODE":
      case "OAUTH_CALLBACK_STATE_MISMATCH":
        return oauthCallbackFailedError(error);
    }
  }
  return oauthCallbackFailedError(error);
}

function oauthCancelledError(error: unknown): RemoteMcpOAuthError {
  return new RemoteMcpOAuthError(
    "FIGMA_UPSTREAM_OAUTH_CANCELLED",
    "Figma MCP OAuth browser authorization was cancelled before completion.",
    {
      cause: error,
      details: defaultOAuthRecoveryDetails(),
    },
  );
}

function oauthCallbackPortInUseError(error: OAuthCallbackError): RemoteMcpOAuthError {
  return new RemoteMcpOAuthError(
    "FIGMA_UPSTREAM_OAUTH_CALLBACK_PORT_IN_USE",
    "Figma MCP OAuth callback port is already in use.",
    {
      cause: error,
      details: oauthCallbackRecoveryDetails(error),
    },
  );
}

function oauthCallbackStartupFailedError(error: OAuthCallbackError): RemoteMcpOAuthError {
  return new RemoteMcpOAuthError(
    "FIGMA_UPSTREAM_OAUTH_CALLBACK_STARTUP_FAILED",
    "Figma MCP OAuth callback listener failed to start.",
    {
      cause: error,
      details: oauthCallbackRecoveryDetails(error),
    },
  );
}

function oauthCallbackFailedError(error: unknown): RemoteMcpOAuthError {
  return new RemoteMcpOAuthError(
    "FIGMA_UPSTREAM_OAUTH_CALLBACK_FAILED",
    "Figma MCP OAuth browser authorization did not complete.",
    {
      cause: error,
      details: defaultOAuthRecoveryDetails(),
    },
  );
}

function oauthTokenExchangeFailedError(error: unknown): RemoteMcpOAuthError {
  return new RemoteMcpOAuthError(
    "FIGMA_UPSTREAM_OAUTH_TOKEN_EXCHANGE_FAILED",
    "Figma MCP OAuth token exchange failed after browser authorization.",
    {
      cause: error,
      details: defaultOAuthRecoveryDetails(),
    },
  );
}

function defaultOAuthRecoveryDetails(): RemoteMcpOAuthErrorDetails {
  return {
    loginCommand: LOGIN_COMMAND,
    oauthCacheFile: OAUTH_CACHE_FILE_NAME,
  };
}

function oauthCallbackRecoveryDetails(error: OAuthCallbackError): RemoteMcpOAuthErrorDetails {
  return isRecord(error.details)
    ? { ...defaultOAuthRecoveryDetails(), ...error.details }
    : defaultOAuthRecoveryDetails();
}

function isUnauthorizedError(error: unknown): error is UnauthorizedError {
  if (error instanceof UnauthorizedError) {
    return true;
  }
  return (
    typeof error === "object" &&
    error !== null &&
    "constructor" in error &&
    typeof error.constructor === "function" &&
    error.constructor.name === "UnauthorizedError"
  );
}

function messageFromUnknown(error: unknown): string | undefined {
  if (error instanceof Error) {
    return error.message;
  }
  if (isRecord(error) && typeof error.message === "string") {
    return error.message;
  }
  if (typeof error === "string") {
    return error;
  }
  return undefined;
}

function collectErrorStatusSignals(
  error: unknown,
): { status?: number; code?: string } {
  const visited = new Set<unknown>();
  const pending: unknown[] = [error];
  let code: string | undefined;

  while (pending.length > 0) {
    const current = pending.shift();
    if (!isRecord(current) || visited.has(current)) {
      continue;
    }
    visited.add(current);

    const status = numberFromStatusField(current.status) ??
      numberFromStatusField(current.statusCode);
    if (status !== undefined) {
      return {
        status,
        code: code ?? stringFromStatusCodeField(current.code),
      };
    }
    code ??= stringFromStatusCodeField(current.code);

    for (const key of ["cause", "response", "error"] as const) {
      if (isRecord(current[key])) {
        pending.push(current[key]);
      }
    }
  }

  return { code };
}

function numberFromStatusField(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isInteger(value)) {
    return value;
  }
  if (typeof value !== "string" || !/^\d{3}$/u.test(value)) {
    return undefined;
  }
  return Number(value);
}

function stringFromStatusCodeField(value: unknown): string | undefined {
  if (typeof value === "number" && Number.isInteger(value)) {
    return String(value);
  }
  if (typeof value !== "string" || value.length === 0) {
    return undefined;
  }
  return value;
}

function isForbiddenStatusCode(value: string): boolean {
  const normalized = value.trim().toUpperCase();
  return normalized === "403" || normalized === "FORBIDDEN";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

class StaleConnectionError extends Error {
  constructor() {
    super("MCP connection attempt was cancelled.");
    this.name = "StaleConnectionError";
  }
}
