import { randomBytes } from "node:crypto";
import type {
  OAuthClientProvider,
  OAuthDiscoveryState,
} from "@modelcontextprotocol/sdk/client/auth.js";
import type {
  OAuthClientInformationMixed,
  OAuthClientMetadata,
  OAuthTokens,
} from "@modelcontextprotocol/sdk/shared/auth.js";
import {
  type OAuthCredentialScope,
  type OAuthState,
  OAuthStateStore,
} from "./oauth-state.js";

export type AuthorizationRedirectHandler = (
  authorizationUrl: URL,
) => void | Promise<void>;

export interface PersistentOAuthProviderOptions {
  redirectUrl: string | URL;
  clientMetadata: OAuthClientMetadata;
  statePath: string;
  clientMetadataUrl?: string;
  onRedirect?: AuthorizationRedirectHandler;
}

export class PersistentOAuthProvider implements OAuthClientProvider {
  readonly clientMetadataUrl?: string;
  private readonly store: OAuthStateStore;
  private readonly redirectHandler: AuthorizationRedirectHandler;

  constructor(private readonly options: PersistentOAuthProviderOptions) {
    this.clientMetadataUrl = options.clientMetadataUrl;
    this.store = new OAuthStateStore(options.statePath);
    this.redirectHandler =
      options.onRedirect ??
      ((authorizationUrl) => {
        console.error(
          `Open this URL to authorize MCP access:\n${authorizationUrl.toString()}`,
        );
      });
  }

  get redirectUrl(): string | URL {
    return this.options.redirectUrl;
  }

  get clientMetadata(): OAuthClientMetadata {
    return this.options.clientMetadata;
  }

  get statePath(): string {
    return this.options.statePath;
  }

  async state(): Promise<string> {
    const state = randomBytes(16).toString("hex");
    await this.store.update((current) => ({ ...current, lastState: state }));
    return state;
  }

  async savedState(): Promise<OAuthState> {
    return this.store.read();
  }

  async expectedState(): Promise<string | undefined> {
    return (await this.store.read()).lastState;
  }

  async clientInformation(): Promise<OAuthClientInformationMixed | undefined> {
    return (await this.store.read()).clientInformation;
  }

  async saveClientInformation(
    clientInformation: OAuthClientInformationMixed,
  ): Promise<void> {
    await this.store.update((current) => ({ ...current, clientInformation }));
  }

  async tokens(): Promise<OAuthTokens | undefined> {
    return (await this.store.read()).tokens;
  }

  async saveTokens(tokens: OAuthTokens): Promise<void> {
    await this.store.update((current) => ({ ...current, tokens }));
  }

  async redirectToAuthorization(authorizationUrl: URL): Promise<void> {
    await this.redirectHandler(authorizationUrl);
  }

  async saveCodeVerifier(codeVerifier: string): Promise<void> {
    await this.store.update((current) => ({ ...current, codeVerifier }));
  }

  async codeVerifier(): Promise<string> {
    const codeVerifier = (await this.store.read()).codeVerifier;
    if (!codeVerifier) {
      throw new Error("No OAuth code verifier is saved.");
    }
    return codeVerifier;
  }

  async saveDiscoveryState(discoveryState: OAuthDiscoveryState): Promise<void> {
    await this.store.update((current) => ({ ...current, discoveryState }));
  }

  async discoveryState(): Promise<OAuthDiscoveryState | undefined> {
    return (await this.store.read()).discoveryState;
  }

  async invalidateCredentials(scope: OAuthCredentialScope): Promise<void> {
    if (scope === "all") {
      await this.store.clear();
      return;
    }

    await this.store.update((current) => {
      const next = { ...current };
      if (scope === "client") {
        delete next.clientInformation;
      }
      if (scope === "tokens") {
        delete next.tokens;
      }
      if (scope === "verifier") {
        delete next.codeVerifier;
        delete next.lastState;
      }
      if (scope === "discovery") {
        delete next.discoveryState;
      }
      return next;
    });
  }
}
