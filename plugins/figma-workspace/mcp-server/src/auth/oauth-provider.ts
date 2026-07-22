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
import type { LockedCredentialStore } from "./credential-store.js";

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
  private lockedStore?: LockedCredentialStore<OAuthState>;

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
    await this.updateState((current) => ({ ...current, lastState: state }));
    return state;
  }

  async savedState(): Promise<OAuthState> {
    return this.readState();
  }

  async expectedState(): Promise<string | undefined> {
    return (await this.readState()).lastState;
  }

  async clientInformation(): Promise<OAuthClientInformationMixed | undefined> {
    return (await this.readState()).clientInformation;
  }

  async saveClientInformation(
    clientInformation: OAuthClientInformationMixed,
  ): Promise<void> {
    await this.updateState((current) => ({ ...current, clientInformation }));
  }

  async tokens(): Promise<OAuthTokens | undefined> {
    return (await this.readState()).tokens;
  }

  async saveTokens(tokens: OAuthTokens): Promise<void> {
    await this.updateState((current) => ({
      ...current,
      tokens: withTokenExpiry(tokens),
    }));
  }

  async redirectToAuthorization(authorizationUrl: URL): Promise<void> {
    await this.redirectHandler(authorizationUrl);
  }

  async saveCodeVerifier(codeVerifier: string): Promise<void> {
    await this.updateState((current) => ({ ...current, codeVerifier }));
  }

  async codeVerifier(): Promise<string> {
    const codeVerifier = (await this.readState()).codeVerifier;
    if (!codeVerifier) {
      throw new Error("No OAuth code verifier is saved.");
    }
    return codeVerifier;
  }

  async saveDiscoveryState(discoveryState: OAuthDiscoveryState): Promise<void> {
    await this.updateState((current) => ({ ...current, discoveryState }));
  }

  async discoveryState(): Promise<OAuthDiscoveryState | undefined> {
    return (await this.readState()).discoveryState;
  }

  async invalidateCredentials(scope: OAuthCredentialScope): Promise<void> {
    if (scope === "all") {
      if (this.lockedStore) {
        await this.lockedStore.clear();
      } else {
        await this.store.clear();
      }
      return;
    }

    await this.updateState((current) => {
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

  async runWithRefreshLockIfNeeded<R>(operation: () => Promise<R>): Promise<R> {
    const initial = await this.store.read();
    if (!requiresSerializedRefresh(initial)) {
      return operation();
    }

    const retryOutsideLock = Symbol("retryOutsideLock");
    const result = await this.store.withLock(async (locked) => {
      if (!requiresSerializedRefresh(await locked.read())) {
        return retryOutsideLock;
      }
      this.lockedStore = locked;
      try {
        return await operation();
      } finally {
        this.lockedStore = undefined;
      }
    });
    return result === retryOutsideLock ? operation() : result;
  }

  private readState(): Promise<OAuthState> {
    return this.lockedStore ? this.lockedStore.read() : this.store.read();
  }

  private updateState(update: (state: OAuthState) => OAuthState): Promise<OAuthState> {
    return this.lockedStore
      ? this.lockedStore.update(update)
      : this.store.update(update);
  }
}

function withTokenExpiry(tokens: OAuthTokens): OAuthTokens {
  const expiresIn = Number(tokens.expires_in);
  if (!Number.isFinite(expiresIn) || expiresIn <= 0) {
    return tokens;
  }
  return {
    ...tokens,
    expires_at: Date.now() + expiresIn * 1000,
  } as OAuthTokens;
}

function requiresSerializedRefresh(state: OAuthState): boolean {
  const tokens = state.tokens as (OAuthTokens & { expires_at?: unknown }) | undefined;
  if (
    typeof tokens?.refresh_token !== "string" ||
    tokens.refresh_token.length === 0 ||
    typeof state.clientInformation?.client_id !== "string" ||
    state.clientInformation.client_id.length === 0
  ) {
    return false;
  }
  if (typeof tokens.access_token !== "string" || tokens.access_token.length === 0) {
    return true;
  }
  return typeof tokens.expires_at !== "number" ||
    !Number.isFinite(tokens.expires_at) ||
    tokens.expires_at <= Date.now() + 60_000;
}
