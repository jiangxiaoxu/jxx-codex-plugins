import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  CallToolRequestSchema,
  ListResourcesRequestSchema,
  ListToolsRequestSchema,
  ReadResourceRequestSchema,
  type CallToolRequest,
  type ListResourcesRequest,
  type ListToolsRequest,
  type ReadResourceRequest,
} from "@modelcontextprotocol/sdk/types.js";
import {
  createRemoteMcpClient,
  type RemoteMcpClient,
  type RemoteMcpClientOptions,
} from "./client.js";

export interface FigmaStdioMcpServerOptions extends RemoteMcpClientOptions {
  client?: FigmaMcpProxyClient;
  name?: string;
  version?: string;
}

export interface StartFigmaStdioMcpServerOptions
  extends FigmaStdioMcpServerOptions {
  transport?: Transport;
}

export interface FigmaMcpProxyClient {
  connect(): Promise<void>;
  close(): Promise<void>;
  listTools(): Promise<unknown>;
  callTool(name: string, args?: Record<string, unknown>): Promise<unknown>;
  listResources(): Promise<unknown>;
  readResource(uri: string): Promise<unknown>;
}

export function createFigmaStdioMcpServer(
  options: FigmaStdioMcpServerOptions = {},
): {
  server: Server;
  client: FigmaMcpProxyClient;
} {
  const client =
    options.client ??
    createRemoteMcpClient({
      ...options,
      useBridgeOAuthCache: options.useBridgeOAuthCache ?? true,
      openBrowser: options.openBrowser ?? false,
    });

  const server = new Server(
    {
      name: options.name ?? "figma-mcp-stdio-bridge",
      version: options.version ?? "0.1.0",
    },
    {
      capabilities: {
        tools: {},
        resources: {},
      },
      instructions:
        "Transparent stdio MCP bridge for the official Figma remote MCP server. OAuth is read from the local figma-mcp-bridge cache by default.",
    },
  );

  server.setRequestHandler(ListToolsRequestSchema, async (_request: ListToolsRequest) => {
    await client.connect();
    return asMcpResult(await client.listTools());
  });

  server.setRequestHandler(CallToolRequestSchema, async (request: CallToolRequest) => {
    await client.connect();
    return asMcpResult(
      await client.callTool(
        request.params.name,
        asRecord(request.params.arguments),
      ),
    );
  });

  server.setRequestHandler(
    ListResourcesRequestSchema,
    async (_request: ListResourcesRequest) => {
      await client.connect();
      return asMcpResult(await client.listResources());
    },
  );

  server.setRequestHandler(
    ReadResourceRequestSchema,
    async (request: ReadResourceRequest) => {
      await client.connect();
      return asMcpResult(await client.readResource(request.params.uri));
    },
  );

  return { server, client };
}

export async function startFigmaStdioMcpServer(
  options: StartFigmaStdioMcpServerOptions = {},
): Promise<void> {
  const { transport: configuredTransport, ...serverOptions } = options;
  const { server, client } = createFigmaStdioMcpServer(serverOptions);
  const transport = configuredTransport ?? new StdioServerTransport();
  let clientClosePromise: Promise<void> | undefined;
  let cleanupComplete = false;
  let removeStdinCloseHandlers: () => void = () => undefined;
  let closedResolved = false;
  let resolveClosed: () => void;
  const closed = new Promise<void>((resolve) => {
    resolveClosed = resolve;
  });

  const resolveServerClosed = () => {
    if (closedResolved) {
      return;
    }
    closedResolved = true;
    resolveClosed();
  };
  const closeClient = () => {
    clientClosePromise ??= client.close().catch(() => undefined);
    return clientClosePromise;
  };
  const cleanupSignalHandlers = () => {
    if (cleanupComplete) {
      return;
    }
    cleanupComplete = true;
    process.off("SIGINT", onSigint);
    process.off("SIGTERM", onSigterm);
    removeStdinCloseHandlers();
  };
  const closeFromTransport = () => {
    try {
      existingOnClose?.();
    } finally {
      cleanupSignalHandlers();
      void closeClient().finally(() => resolveServerClosed());
    }
  };
  const closeFromSignal = (exitCode: number) => {
    cleanupSignalHandlers();
    void closeClient().finally(() => process.exit(exitCode));
  };
  const onSigint = () => {
    closeFromSignal(130);
  };
  const onSigterm = () => {
    closeFromSignal(143);
  };

  const existingOnClose = transport.onclose;
  transport.onclose = closeFromTransport;
  process.once("SIGINT", onSigint);
  process.once("SIGTERM", onSigterm);
  if (!configuredTransport) {
    removeStdinCloseHandlers = closeTransportWhenStdinEnds(transport, () => {
      cleanupSignalHandlers();
      void closeClient().finally(() => resolveServerClosed());
    });
  }

  try {
    await server.connect(transport);
    await closed;
  } catch (error) {
    cleanupSignalHandlers();
    await server.close().catch(async () => {
      await transport.close().catch(() => undefined);
    });
    await closeClient();
    throw error;
  }
}

function closeTransportWhenStdinEnds(
  transport: Transport,
  onCloseError: () => void,
): () => void {
  let closeRequested = false;
  const closeTransport = () => {
    if (closeRequested) {
      return;
    }
    closeRequested = true;
    void transport.close().catch(onCloseError);
  };
  process.stdin.once("end", closeTransport);
  process.stdin.once("close", closeTransport);
  return () => {
    process.stdin.off("end", closeTransport);
    process.stdin.off("close", closeTransport);
  };
}

function asRecord(value: unknown): Record<string, unknown> {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return {};
}

function asMcpResult(value: unknown): Record<string, unknown> {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  throw new Error("Upstream MCP server returned a non-object result.");
}

export function isDirectRun(importMetaUrl: string, argv = process.argv): boolean {
  const script = argv[1];
  if (!script) {
    return false;
  }
  return resolve(fileURLToPath(importMetaUrl)) === resolve(script);
}

export type { RemoteMcpClient };
