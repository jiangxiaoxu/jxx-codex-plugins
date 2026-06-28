import type { OAuthClientProvider, OAuthDiscoveryState } from "@modelcontextprotocol/sdk/client/auth.js";
import type { OAuthClientInformationMixed, OAuthClientMetadata, OAuthTokens } from "@modelcontextprotocol/sdk/shared/auth.js";
import { type OAuthCredentialScope, type OAuthState } from "./oauth-state.js";
export type AuthorizationRedirectHandler = (authorizationUrl: URL) => void | Promise<void>;
export interface PersistentOAuthProviderOptions {
    redirectUrl: string | URL;
    clientMetadata: OAuthClientMetadata;
    statePath: string;
    clientMetadataUrl?: string;
    onRedirect?: AuthorizationRedirectHandler;
}
export declare class PersistentOAuthProvider implements OAuthClientProvider {
    private readonly options;
    readonly clientMetadataUrl?: string;
    private readonly store;
    private readonly redirectHandler;
    constructor(options: PersistentOAuthProviderOptions);
    get redirectUrl(): string | URL;
    get clientMetadata(): OAuthClientMetadata;
    get statePath(): string;
    state(): Promise<string>;
    savedState(): Promise<OAuthState>;
    expectedState(): Promise<string | undefined>;
    clientInformation(): Promise<OAuthClientInformationMixed | undefined>;
    saveClientInformation(clientInformation: OAuthClientInformationMixed): Promise<void>;
    tokens(): Promise<OAuthTokens | undefined>;
    saveTokens(tokens: OAuthTokens): Promise<void>;
    redirectToAuthorization(authorizationUrl: URL): Promise<void>;
    saveCodeVerifier(codeVerifier: string): Promise<void>;
    codeVerifier(): Promise<string>;
    saveDiscoveryState(discoveryState: OAuthDiscoveryState): Promise<void>;
    discoveryState(): Promise<OAuthDiscoveryState | undefined>;
    invalidateCredentials(scope: OAuthCredentialScope): Promise<void>;
}
