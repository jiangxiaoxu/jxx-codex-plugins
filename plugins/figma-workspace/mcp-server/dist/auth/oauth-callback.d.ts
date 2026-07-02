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
export interface OAuthCallbackErrorDetails {
    [key: string]: unknown;
    callbackHost?: string;
    callbackPort?: number;
    callbackPath?: string;
    callbackUrl?: string;
    upstreamCode?: string;
}
export declare const OAUTH_CALLBACK_ERROR_CODES: readonly ["OAUTH_CALLBACK_AUTHORIZATION_FAILED", "OAUTH_CALLBACK_CANCELLED", "OAUTH_CALLBACK_INTERNAL_ERROR", "OAUTH_CALLBACK_MISSING_CODE", "OAUTH_CALLBACK_PORT_IN_USE", "OAUTH_CALLBACK_STATE_MISMATCH", "OAUTH_CALLBACK_STARTUP_FAILED", "OAUTH_CALLBACK_TIMEOUT"];
export type OAuthCallbackErrorCode = (typeof OAUTH_CALLBACK_ERROR_CODES)[number];
export declare class OAuthCallbackError extends Error {
    readonly code: OAuthCallbackErrorCode;
    readonly details?: OAuthCallbackErrorDetails;
    constructor(code: OAuthCallbackErrorCode, message: string, options?: {
        cause?: unknown;
        details?: OAuthCallbackErrorDetails;
    });
}
export declare function startOAuthCallbackServer(options: OAuthCallbackServerOptions): Promise<OAuthCallbackServer>;
