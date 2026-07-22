import type { OAuthDiscoveryState } from "@modelcontextprotocol/sdk/client/auth.js";
import type {
  OAuthClientInformationMixed,
  OAuthTokens,
} from "@modelcontextprotocol/sdk/shared/auth.js";
import {
  AtomicCredentialStore,
  type LockedCredentialStore,
} from "./credential-store.js";

export interface OAuthState {
  [key: string]: unknown;
  clientInformation?: OAuthClientInformationMixed;
  tokens?: OAuthTokens;
  codeVerifier?: string;
  discoveryState?: OAuthDiscoveryState;
  lastState?: string;
}

export type OAuthCredentialScope =
  | "all"
  | "client"
  | "tokens"
  | "verifier"
  | "discovery";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function optionalRecord<T>(value: unknown): T | undefined {
  return isRecord(value) ? (value as T) : undefined;
}

export function parseOAuthState(json: string): OAuthState {
  const value: unknown = JSON.parse(json);
  if (!isRecord(value)) {
    return {};
  }

  return {
    ...value,
    clientInformation: optionalRecord<OAuthClientInformationMixed>(
      value.clientInformation,
    ),
    tokens: optionalRecord<OAuthTokens>(value.tokens),
    codeVerifier:
      typeof value.codeVerifier === "string" ? value.codeVerifier : undefined,
    discoveryState: optionalRecord<OAuthDiscoveryState>(value.discoveryState),
    lastState: typeof value.lastState === "string" ? value.lastState : undefined,
  };
}

export class OAuthStateStore {
  private readonly store: AtomicCredentialStore<OAuthState>;

  constructor(readonly statePath: string) {
    this.store = new AtomicCredentialStore(statePath, {
      empty: () => ({}),
      parse: parseOAuthState,
    });
  }

  async read(): Promise<OAuthState> {
    return this.store.read();
  }

  async write(state: OAuthState): Promise<void> {
    await this.store.write(state);
  }

  async update(update: (state: OAuthState) => OAuthState): Promise<OAuthState> {
    return this.store.update(update);
  }

  async clear(): Promise<void> {
    await this.store.clear();
  }

  async withLock<R>(
    operation: (store: LockedCredentialStore<OAuthState>) => R | Promise<R>,
  ): Promise<R> {
    return this.store.withLock(operation);
  }
}
