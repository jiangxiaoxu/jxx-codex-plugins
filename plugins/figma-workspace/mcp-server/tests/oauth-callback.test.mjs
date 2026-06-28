import assert from "node:assert/strict";
import test from "node:test";
import { startOAuthCallbackServer } from "../dist/mcp/index.js";

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
