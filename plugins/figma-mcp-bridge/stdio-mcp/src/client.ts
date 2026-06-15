import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { UnauthorizedError } from "@modelcontextprotocol/sdk/client/auth.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type {
  ListResourcesResult,
  ListToolsResult,
  ReadResourceResult,
} from "@modelcontextprotocol/sdk/types.js";
import { openBrowser as defaultOpenBrowser } from "./browser.js";
import {
  createConfig,
  type NodeReplConfig,
  type NodeReplConfigInput,
} from "./config.js";
import { PersistentOAuthProvider } from "./oauth-provider.js";
import {
  startOAuthCallbackServer,
  type OAuthCallbackServer,
  type OAuthCallbackServerOptions,
} from "./oauth-callback.js";

interface RemoteMcpConnection {
  client: Client;
  transport: StreamableHTTPClientTransport;
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
        throw error;
      }
      const unauthorizedTransport = this.transport;
      if (isForbiddenClientRegistrationError(error)) {
        await this.closeTransport(unauthorizedTransport, {
          clearInFlight: false,
        });
        throw new Error(
          [
            "Figma MCP OAuth client registration was rejected before a browser authorization URL was issued.",
            "The official Figma remote MCP may only allow supported catalog clients or waitlisted custom clients.",
            "If Figma provides a registered OAuth client for this runtime, seed that client information in the OAuth state file before connecting.",
          ].join(" "),
          { cause: error },
        );
      }
      if (!isUnauthorizedError(error) || !unauthorizedTransport) {
        await this.closeTransport(unauthorizedTransport, {
          clearInFlight: false,
        });
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
            throw new StaleConnectionError();
          }
          throw callbackServerError;
        }
        if (!this.trackCallbackServer(callbackServer, connectionGeneration)) {
          await this.closeCallbackServer(callbackServer);
          throw new StaleConnectionError();
        }
        const authorizationCode = await callbackServer.waitForCode();
        if (!this.isCurrentConnectionAttempt(connectionGeneration)) {
          throw new StaleConnectionError();
        }
        await unauthorizedTransport.finishAuth(authorizationCode);
      } finally {
        await this.closeTransport(unauthorizedTransport, {
          clearInFlight: false,
        });
        await this.closeCallbackServer(callbackServer);
      }

      await this.setConnectedIfCurrent(
        await this.connectOnce(connectionGeneration),
        connectionGeneration,
      );
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
      await client.connect(transport);
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

  async listTools(): Promise<ListToolsResult> {
    return this.requireClient().listTools();
  }

  async callTool(
    name: string,
    args: Record<string, unknown> = {},
  ): Promise<unknown> {
    return this.requireClient().callTool({ name, arguments: args });
  }

  async listResources(): Promise<ListResourcesResult> {
    return this.requireClient().listResources();
  }

  async readResource(uri: string): Promise<ReadResourceResult> {
    return this.requireClient().readResource({ uri });
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

export function createRemoteMcpClient(
  options: RemoteMcpClientOptions = {},
): RemoteMcpClient {
  return new RemoteMcpClient(options);
}

function isForbiddenClientRegistrationError(error: unknown): boolean {
  const message =
    typeof error === "object" &&
    error !== null &&
    "message" in error &&
    typeof error.message === "string"
      ? error.message
      : String(error);
  return message.includes("HTTP 403") && message.includes("Forbidden");
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

class StaleConnectionError extends Error {
  constructor() {
    super("MCP connection attempt was cancelled.");
    this.name = "StaleConnectionError";
  }
}
