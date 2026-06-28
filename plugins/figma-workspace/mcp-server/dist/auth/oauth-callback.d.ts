export interface OAuthCallbackServerOptions {
    host: string;
    port: number;
    path: string;
    timeoutMs: number;
    getExpectedState?: () => string | undefined | Promise<string | undefined>;
}
export interface OAuthCallbackServer {
    url: string;
    waitForCode(): Promise<string>;
    close(): Promise<void>;
}
export declare function startOAuthCallbackServer(options: OAuthCallbackServerOptions): Promise<OAuthCallbackServer>;
