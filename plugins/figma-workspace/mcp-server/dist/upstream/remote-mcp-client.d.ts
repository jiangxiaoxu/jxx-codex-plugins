import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { ListResourceTemplatesResult, ListResourcesResult, ListToolsResult, ReadResourceResult } from "@modelcontextprotocol/sdk/types.js";
import { type NodeReplConfig, type NodeReplConfigInput } from "../auth/config.js";
import { PersistentOAuthProvider } from "../auth/oauth-provider.js";
import { type OAuthCallbackServer, type OAuthCallbackServerOptions } from "../auth/oauth-callback.js";
interface RemoteMcpConnection {
    client: Client;
    transport: StreamableHTTPClientTransport;
}
export declare const REMOTE_MCP_OAUTH_ERROR_CODES: readonly ["FIGMA_UPSTREAM_AUTH_REQUIRED", "FIGMA_UPSTREAM_OAUTH_REGISTRATION_REJECTED", "FIGMA_UPSTREAM_OAUTH_CALLBACK_TIMEOUT", "FIGMA_UPSTREAM_OAUTH_CANCELLED", "FIGMA_UPSTREAM_OAUTH_CALLBACK_PORT_IN_USE", "FIGMA_UPSTREAM_OAUTH_CALLBACK_STARTUP_FAILED", "FIGMA_UPSTREAM_OAUTH_CALLBACK_FAILED", "FIGMA_UPSTREAM_OAUTH_TOKEN_EXCHANGE_FAILED"];
export type RemoteMcpOAuthErrorCode = (typeof REMOTE_MCP_OAUTH_ERROR_CODES)[number];
export interface RemoteMcpOAuthErrorDetails {
    [key: string]: unknown;
    loginCommand?: string;
    oauthCacheFile?: string;
}
export declare class RemoteMcpOAuthError extends Error {
    readonly code: RemoteMcpOAuthErrorCode;
    readonly details?: RemoteMcpOAuthErrorDetails;
    constructor(code: RemoteMcpOAuthErrorCode, message: string, options?: {
        cause?: unknown;
        details?: RemoteMcpOAuthErrorDetails;
    });
}
export declare function isRemoteMcpOAuthError(error: unknown): error is RemoteMcpOAuthError;
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
    listResourceTemplates(): Promise<ListResourceTemplatesResult>;
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
