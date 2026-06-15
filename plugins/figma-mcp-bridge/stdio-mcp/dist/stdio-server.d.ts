import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { type RemoteMcpClient, type RemoteMcpClientOptions } from "./client.js";
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
export declare function createFigmaStdioMcpServer(options?: FigmaStdioMcpServerOptions): {
    server: Server;
    client: FigmaMcpProxyClient;
};
export type { RemoteMcpClient };
