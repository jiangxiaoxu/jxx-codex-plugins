import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { PersistentOAuthProvider } from "../dist/index.js";

test("PersistentOAuthProvider persists client, token, verifier, discovery, and state", async () => {
  const dir = await mkdtemp(join(tmpdir(), "figma-stdio-oauth-"));
  try {
    const statePath = join(dir, "state.json");
    const redirects = [];
    const provider = new PersistentOAuthProvider({
      redirectUrl: "http://127.0.0.1:18765/oauth/callback",
      clientMetadata: {
        client_name: "test-client",
        redirect_uris: ["http://127.0.0.1:18765/oauth/callback"],
      },
      statePath,
      onRedirect: (url) => redirects.push(url.toString()),
    });

    const generatedState = await provider.state();
    await provider.saveClientInformation({
      client_id: "client-1",
      client_secret: "secret-1",
    });
    await provider.saveTokens({
      access_token: "access-1",
      token_type: "Bearer",
      refresh_token: "refresh-1",
    });
    await provider.saveCodeVerifier("verifier-1");
    await provider.saveDiscoveryState({
      authorizationServerUrl: "https://auth.example.com",
    });
    await provider.redirectToAuthorization(new URL("https://auth.example.com/start"));

    const reloaded = new PersistentOAuthProvider({
      redirectUrl: "http://127.0.0.1:18765/oauth/callback",
      clientMetadata: {
        client_name: "test-client",
        redirect_uris: ["http://127.0.0.1:18765/oauth/callback"],
      },
      statePath,
    });

    assert.equal(await reloaded.expectedState(), generatedState);
    assert.deepEqual(await reloaded.clientInformation(), {
      client_id: "client-1",
      client_secret: "secret-1",
    });
    assert.deepEqual(await reloaded.tokens(), {
      access_token: "access-1",
      token_type: "Bearer",
      refresh_token: "refresh-1",
    });
    assert.equal(await reloaded.codeVerifier(), "verifier-1");
    assert.deepEqual(await reloaded.discoveryState(), {
      authorizationServerUrl: "https://auth.example.com",
    });
    assert.deepEqual(redirects, ["https://auth.example.com/start"]);

    await reloaded.invalidateCredentials("tokens");
    assert.equal(await reloaded.tokens(), undefined);
    assert.equal((await reloaded.clientInformation())?.client_id, "client-1");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("PersistentOAuthProvider can reuse and update the bridge OAuth cache file", async () => {
  const dir = await mkdtemp(join(tmpdir(), "figma-stdio-bridge-oauth-"));
  try {
    const statePath = join(dir, "figma-mcp-oauth.json");
    await writeFile(
      statePath,
      `${JSON.stringify(
        {
          clientInformation: {
            client_id: "bridge-client",
            client_secret: "bridge-secret",
          },
          tokens: {
            access_token: "bridge-access",
            refresh_token: "bridge-refresh",
            token_type: "Bearer",
            expires_at: Date.now() + 3600000,
          },
          updatedAt: "2026-06-14T00:00:00.000Z",
        },
        null,
        2,
      )}\n`,
    );

    const provider = new PersistentOAuthProvider({
      redirectUrl: "http://127.0.0.1:18765/oauth/callback",
      clientMetadata: {
        client_name: "test-client",
        redirect_uris: ["http://127.0.0.1:18765/oauth/callback"],
      },
      statePath,
    });

    assert.deepEqual(await provider.clientInformation(), {
      client_id: "bridge-client",
      client_secret: "bridge-secret",
    });
    assert.equal((await provider.tokens())?.access_token, "bridge-access");

    await provider.saveTokens({
      access_token: "stdio-access",
      refresh_token: "bridge-refresh",
      token_type: "Bearer",
    });

    const saved = JSON.parse(await readFile(statePath, "utf8"));
    assert.equal(saved.clientInformation.client_id, "bridge-client");
    assert.equal(saved.tokens.access_token, "stdio-access");
    assert.equal(saved.tokens.refresh_token, "bridge-refresh");
    assert.equal(saved.updatedAt, "2026-06-14T00:00:00.000Z");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
