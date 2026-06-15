import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { RemoteMcpClient } from "../dist/index.js";

test("RemoteMcpClient does not start the OAuth callback server when cached auth connects", async () => {
  const dir = await mkdtemp(join(tmpdir(), "figma-stdio-client-"));
  try {
    let callbackStarted = false;
    class SuccessfulRemoteMcpClient extends RemoteMcpClient {
      connectCalls = 0;

      async connectOnce() {
        this.connectCalls += 1;
        return {
          client: {},
          transport: {},
        };
      }
    }

    const client = new SuccessfulRemoteMcpClient({
      statePath: join(dir, "state.json"),
      callbackServerFactory: async () => {
        callbackStarted = true;
        throw new Error("callback server should not start");
      },
    });

    await client.connect();

    assert.equal(client.connectCalls, 1);
    assert.equal(callbackStarted, false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
