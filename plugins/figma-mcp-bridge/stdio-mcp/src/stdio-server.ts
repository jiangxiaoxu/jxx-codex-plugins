import { Server } from "@modelcontextprotocol/sdk/server/index.js";
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

const TOOL_TITLE_ARGUMENT = "title";

export interface FigmaStdioMcpServerOptions extends RemoteMcpClientOptions {
  client?: FigmaMcpProxyClient;
  name?: string;
  version?: string;
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
    return injectRequiredTitleArgument(asMcpResult(await client.listTools()));
  });

  server.setRequestHandler(CallToolRequestSchema, async (request: CallToolRequest) => {
    await client.connect();
    const args = asRecord(request.params.arguments);
    assertRequiredTitleArgument(args);
    return asMcpResult(
      await client.callTool(
        request.params.name,
        stripTitleArgument(args),
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

function injectRequiredTitleArgument(
  result: Record<string, unknown>,
): Record<string, unknown> {
  if (!Array.isArray(result.tools)) {
    return result;
  }
  return {
    ...result,
    tools: result.tools.map((tool) => {
      if (!isRecord(tool)) {
        return tool;
      }
      return {
        ...tool,
        inputSchema: injectTitleIntoInputSchema(tool.inputSchema),
      };
    }),
  };
}

function injectTitleIntoInputSchema(inputSchema: unknown): Record<string, unknown> {
  const schema = isRecord(inputSchema) ? inputSchema : {};
  const properties = isRecord(schema.properties) ? schema.properties : {};
  const required = Array.isArray(schema.required) ? schema.required : [];
  return {
    ...schema,
    type: "object",
    properties: {
      ...properties,
      [TOOL_TITLE_ARGUMENT]: {
        type: "string",
        description: "Human-readable title used when presenting output to the user.",
      },
    },
    required: required.includes(TOOL_TITLE_ARGUMENT)
      ? required
      : [...required, TOOL_TITLE_ARGUMENT],
  };
}

function assertRequiredTitleArgument(args: Record<string, unknown>): void {
  if (typeof args[TOOL_TITLE_ARGUMENT] !== "string") {
    throw new Error('Tool argument "title" is required and must be a string.');
  }
}

function stripTitleArgument(
  args: Record<string, unknown>,
): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(args).filter(([name]) => name !== TOOL_TITLE_ARGUMENT),
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export type { RemoteMcpClient };
