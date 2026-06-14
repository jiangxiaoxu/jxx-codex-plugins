import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { OAuthDiscoveryState } from "@modelcontextprotocol/sdk/client/auth.js";
import type {
  OAuthClientInformationMixed,
  OAuthTokens,
} from "@modelcontextprotocol/sdk/shared/auth.js";

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
  constructor(readonly statePath: string) {}

  async read(): Promise<OAuthState> {
    try {
      return parseOAuthState(await readFile(this.statePath, "utf8"));
    } catch (error) {
      if (
        error instanceof Error &&
        "code" in error &&
        (error as NodeJS.ErrnoException).code === "ENOENT"
      ) {
        return {};
      }
      throw error;
    }
  }

  async write(state: OAuthState): Promise<void> {
    await mkdir(dirname(this.statePath), { recursive: true });
    const tmpPath = `${this.statePath}.tmp`;
    await writeFile(tmpPath, `${JSON.stringify(state, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
    await rename(tmpPath, this.statePath);
  }

  async update(update: (state: OAuthState) => OAuthState): Promise<OAuthState> {
    const next = update(await this.read());
    await this.write(next);
    return next;
  }

  async clear(): Promise<void> {
    await rm(this.statePath, { force: true });
  }
}
