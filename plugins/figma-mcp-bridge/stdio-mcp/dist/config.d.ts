import type { OAuthClientMetadata } from "@modelcontextprotocol/sdk/shared/auth.js";
export interface NodeReplConfig {
    endpoint: string;
    statePath: string;
    callbackHost: string;
    callbackPort: number;
    callbackPath: string;
    callbackUrl: string;
    authTimeoutMs: number;
    openBrowser: boolean;
    clientName: string;
    clientVersion: string;
    clientMetadata: OAuthClientMetadata;
    useBridgeOAuthCache: boolean;
}
export interface NodeReplConfigInput {
    endpoint?: string;
    statePath?: string;
    callbackHost?: string;
    callbackPort?: number;
    callbackPath?: string;
    authTimeoutMs?: number;
    openBrowser?: boolean;
    clientName?: string;
    clientVersion?: string;
    clientMetadata?: Partial<OAuthClientMetadata>;
    useBridgeOAuthCache?: boolean;
}
export declare function normalizeCallbackPath(path: string): string;
export declare function createCallbackUrl(options?: {
    host?: string;
    port?: number;
    path?: string;
}): string;
export declare function createClientMetadata(redirectUrl: string, overrides?: Partial<OAuthClientMetadata>): OAuthClientMetadata;
export declare function findCodexHomeOAuthCachePath(env?: Record<string, string | undefined>): string | undefined;
export declare function createConfig(input?: NodeReplConfigInput): NodeReplConfig;
