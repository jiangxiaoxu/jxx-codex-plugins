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
export declare const OAUTH_CALLBACK_ERROR_CODES: readonly ["OAUTH_CALLBACK_AUTHORIZATION_FAILED", "OAUTH_CALLBACK_CANCELLED", "OAUTH_CALLBACK_INTERNAL_ERROR", "OAUTH_CALLBACK_MISSING_CODE", "OAUTH_CALLBACK_STATE_MISMATCH", "OAUTH_CALLBACK_TIMEOUT"];
export type OAuthCallbackErrorCode = (typeof OAUTH_CALLBACK_ERROR_CODES)[number];
export declare class OAuthCallbackError extends Error {
    readonly code: OAuthCallbackErrorCode;
    constructor(code: OAuthCallbackErrorCode, message: string, options?: {
        cause?: unknown;
    });
}
export declare function startOAuthCallbackServer(options: OAuthCallbackServerOptions): Promise<OAuthCallbackServer>;
