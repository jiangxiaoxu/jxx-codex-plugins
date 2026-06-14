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
import { startOAuthCallbackServer } from "./oauth-callback.js";

export interface RemoteMcpClientOptions extends NodeReplConfigInput {
  onAuthorizationUrl?: (authorizationUrl: URL) => void | Promise<void>;
}

export class RemoteMcpClient {
  readonly config: NodeReplConfig;
  readonly authProvider: PersistentOAuthProvider;
  private client?: Client;
  private transport?: StreamableHTTPClientTransport;

  constructor(options: RemoteMcpClientOptions = {}) {
    this.config = createConfig(options);
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
    const callbackServer = await startOAuthCallbackServer({
      host: this.config.callbackHost,
      port: this.config.callbackPort,
      path: this.config.callbackPath,
      timeoutMs: this.config.authTimeoutMs,
      getExpectedState: () => this.authProvider.expectedState(),
    });

    try {
      await this.connectOnce();
      await callbackServer.close();
      return;
    } catch (error) {
      const unauthorizedTransport = this.transport;
      if (isForbiddenClientRegistrationError(error)) {
        await callbackServer.close();
        throw new Error(
          [
            "Figma MCP OAuth client registration was rejected before a browser authorization URL was issued.",
            "The official Figma remote MCP may only allow supported catalog clients or waitlisted custom clients.",
            "If Figma provides a registered OAuth client for this runtime, seed that client information in the OAuth state file before connecting.",
          ].join(" "),
          { cause: error },
        );
      }
      if (!(error instanceof UnauthorizedError) || !unauthorizedTransport) {
        await callbackServer.close();
        throw error;
      }

      const authorizationCode = await callbackServer.waitForCode();
      await unauthorizedTransport.finishAuth(authorizationCode);
      await unauthorizedTransport.close().catch(() => undefined);
      await this.connectOnce();
    }
  }

  private async connectOnce(): Promise<{
    client: Client;
    transport: StreamableHTTPClientTransport;
  }> {
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
    this.transport = transport;
    await client.connect(transport);
    this.client = client;
    return { client, transport };
  }

  async close(): Promise<void> {
    await this.transport?.close();
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
