import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { type RemoteMcpClient, type RemoteMcpClientOptions } from "./remote-mcp-client.js";
export interface FigmaWorkspaceUpstreamStdioServerOptions extends RemoteMcpClientOptions {
    client?: FigmaUpstreamMcpProxyClient;
    name?: string;
    version?: string;
}
export interface FigmaUpstreamMcpProxyClient {
    connect(): Promise<void>;
    close(): Promise<void>;
    listTools(): Promise<unknown>;
    callTool(name: string, args?: Record<string, unknown>): Promise<unknown>;
    listResources(): Promise<unknown>;
    listResourceTemplates(): Promise<unknown>;
    readResource(uri: string): Promise<unknown>;
}
export declare function createFigmaWorkspaceUpstreamStdioServer(options?: FigmaWorkspaceUpstreamStdioServerOptions): {
    server: Server;
    client: FigmaUpstreamMcpProxyClient;
};
export type { RemoteMcpClient };
