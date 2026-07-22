import assert from "node:assert/strict";
import test from "node:test";
import {
  OAuthCallbackError,
  startOAuthCallbackServer,
} from "../dist/runtime/workspace-runtime.js";

test("OAuth callback server close rejects a pending authorization wait", async () => {
  const server = await startOAuthCallbackServer({
    host: "127.0.0.1",
    port: 0,
    path: "/oauth/callback",
    timeoutMs: 60_000,
  });
  const waitingForCode = assert.rejects(
    server.waitForCode(),
    /closed before authorization/,
  );

  await server.close();
  await server.close();
  await waitingForCode;
});

test("OAuth callback server close rejects with typed cancellation", async () => {
  const server = await startOAuthCallbackServer({
    host: "127.0.0.1",
    port: 0,
    path: "/oauth/callback",
    timeoutMs: 60_000,
  });
  const waitingForCode = assert.rejects(server.waitForCode(), (error) => {
    assert.equal(error instanceof OAuthCallbackError, true);
    assert.equal(error.code, "OAUTH_CALLBACK_CANCELLED");
    assert.match(error.message, /closed before authorization/);
    return true;
  });

  await server.close();
  await waitingForCode;
});

test("OAuth callback server timeout rejects with typed timeout", async () => {
  const server = await startOAuthCallbackServer({
    host: "127.0.0.1",
    port: 0,
    path: "/oauth/callback",
    timeoutMs: 1,
  });
  const waitingForCode = assert.rejects(server.waitForCode(), (error) => {
    assert.equal(error instanceof OAuthCallbackError, true);
    assert.equal(error.code, "OAUTH_CALLBACK_TIMEOUT");
    assert.match(error.message, /Timed out waiting/);
    return true;
  });

  await waitingForCode;
  await server.close();
});
