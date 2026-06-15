import type { OAuthDiscoveryState } from "@modelcontextprotocol/sdk/client/auth.js";
import type { OAuthClientInformationMixed, OAuthTokens } from "@modelcontextprotocol/sdk/shared/auth.js";
export interface OAuthState {
    [key: string]: unknown;
    clientInformation?: OAuthClientInformationMixed;
    tokens?: OAuthTokens;
    codeVerifier?: string;
    discoveryState?: OAuthDiscoveryState;
    lastState?: string;
}
export type OAuthCredentialScope = "all" | "client" | "tokens" | "verifier" | "discovery";
export declare function parseOAuthState(json: string): OAuthState;
export declare class OAuthStateStore {
    readonly statePath: string;
    constructor(statePath: string);
    read(): Promise<OAuthState>;
    write(state: OAuthState): Promise<void>;
    update(update: (state: OAuthState) => OAuthState): Promise<OAuthState>;
    clear(): Promise<void>;
}
