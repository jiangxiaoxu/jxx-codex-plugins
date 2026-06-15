import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { ListResourcesResult, ListToolsResult, ReadResourceResult } from "@modelcontextprotocol/sdk/types.js";
import { type NodeReplConfig, type NodeReplConfigInput } from "./config.js";
import { PersistentOAuthProvider } from "./oauth-provider.js";
import { type OAuthCallbackServer, type OAuthCallbackServerOptions } from "./oauth-callback.js";
interface RemoteMcpConnection {
    client: Client;
    transport: StreamableHTTPClientTransport;
}
export interface RemoteMcpClientOptions extends NodeReplConfigInput {
    onAuthorizationUrl?: (authorizationUrl: URL) => void | Promise<void>;
    callbackServerFactory?: (options: OAuthCallbackServerOptions) => Promise<OAuthCallbackServer>;
}
export declare class RemoteMcpClient {
    readonly config: NodeReplConfig;
    readonly authProvider: PersistentOAuthProvider;
    private readonly callbackServerFactory;
    private client?;
    private transport?;
    private callbackServer?;
    private connectPromise?;
    private connectionGeneration;
    private readonly closedCallbackServers;
    constructor(options?: RemoteMcpClientOptions);
    connect(): Promise<void>;
    private connectWithOAuthRetry;
    protected connectOnce(connectionGeneration?: number): Promise<RemoteMcpConnection>;
    close(): Promise<void>;
    private requireClient;
    listTools(): Promise<ListToolsResult>;
    callTool(name: string, args?: Record<string, unknown>): Promise<unknown>;
    listResources(): Promise<ListResourcesResult>;
    readResource(uri: string): Promise<ReadResourceResult>;
    private setConnectedIfCurrent;
    private setConnected;
    private trackTransport;
    private closeTransport;
    private resetConnection;
    private isCurrentConnectionAttempt;
    private trackCallbackServer;
    private closeCallbackServer;
}
export declare function createRemoteMcpClient(options?: RemoteMcpClientOptions): RemoteMcpClient;
export {};
