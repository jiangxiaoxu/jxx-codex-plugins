import type { RemoteMcpClientOptions } from "./remote-mcp-client.js";
import type { FigmaWorkspaceClientOptions } from "../mcp/workspace-mcp-server.js";
export declare function installNodeReplWebStreamGlobals(): void;
declare const clientModule: typeof import("./remote-mcp-client.js"), replServerModule: typeof import("../mcp/workspace-mcp-server.js");
export declare const RemoteMcpClient: typeof import("./remote-mcp-client.js").RemoteMcpClient;
export declare function createRemoteMcpClient(options?: RemoteMcpClientOptions): ReturnType<typeof clientModule.createRemoteMcpClient>;
export declare function createFigmaWorkspaceClient(options?: FigmaWorkspaceClientOptions): ReturnType<typeof replServerModule.createFigmaWorkspaceClient>;
export type { RemoteMcpClientOptions } from "./remote-mcp-client.js";
export type { FigmaWorkspaceClient, FigmaWorkspaceClientOptions, } from "../mcp/workspace-mcp-server.js";
