import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { UnauthorizedError } from "@modelcontextprotocol/sdk/client/auth.js";
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
    await client.connect();

    assert.equal(client.connectCalls, 1);
    assert.equal(callbackStarted, false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("RemoteMcpClient reuses an in-flight connection attempt", async () => {
  const dir = await mkdtemp(join(tmpdir(), "figma-stdio-client-"));
  try {
    let resolveConnect;
    class DelayedRemoteMcpClient extends RemoteMcpClient {
      connectCalls = 0;

      async connectOnce() {
        this.connectCalls += 1;
        return new Promise((resolve) => {
          resolveConnect = () =>
            resolve({
              client: {},
              transport: { close: async () => undefined },
            });
        });
      }
    }

    const client = new DelayedRemoteMcpClient({
      statePath: join(dir, "state.json"),
    });
    const firstConnect = client.connect();
    const secondConnect = client.connect();

    assert.equal(client.connectCalls, 1);
    resolveConnect();
    await Promise.all([firstConnect, secondConnect]);
    assert.equal(client.connectCalls, 1);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("RemoteMcpClient discards an in-flight connection after close", async () => {
  const dir = await mkdtemp(join(tmpdir(), "figma-stdio-client-"));
  try {
    const pendingConnects = [];
    const closedTransports = [];
    class DelayedRemoteMcpClient extends RemoteMcpClient {
      connectCalls = 0;

      async connectOnce() {
        this.connectCalls += 1;
        const connectionId = this.connectCalls;
        return new Promise((resolve) => {
          pendingConnects.push(() => {
            resolve({
              client: {
                listTools: async () => ({
                  tools: [{ name: `tools-${connectionId}` }],
                }),
              },
              transport: {
                close: async () => {
                  closedTransports.push(connectionId);
                },
              },
            });
          });
        });
      }
    }

    const client = new DelayedRemoteMcpClient({
      statePath: join(dir, "state.json"),
    });
    const firstConnect = client.connect();

    assert.equal(client.connectCalls, 1);
    await client.close();
    pendingConnects[0]();
    await assert.rejects(firstConnect, /cancelled/);
    await assert.rejects(client.listTools(), /not connected/);
    assert.deepEqual(closedTransports, [1]);

    const secondConnect = client.connect();
    assert.equal(client.connectCalls, 2);
    pendingConnects[1]();
    await secondConnect;
    assert.deepEqual(await client.listTools(), {
      tools: [{ name: "tools-2" }],
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("RemoteMcpClient reconnects after transport close", async () => {
  const dir = await mkdtemp(join(tmpdir(), "figma-stdio-client-"));
  try {
    class ResettableRemoteMcpClient extends RemoteMcpClient {
      connectCalls = 0;
      transports = [];

      async connectOnce() {
        this.connectCalls += 1;
        const transport = {
          close: async () => {
            transport.onclose?.();
          },
        };
        this.transports.push(transport);
        return {
          client: {},
          transport,
        };
      }
    }

    const client = new ResettableRemoteMcpClient({
      statePath: join(dir, "state.json"),
    });

    await client.connect();
    await client.close();
    await client.connect();

    assert.equal(client.connectCalls, 2);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("RemoteMcpClient keeps unauthorized transport after SDK error callback", async () => {
  const dir = await mkdtemp(join(tmpdir(), "figma-stdio-client-"));
  try {
    let callbackClosed = false;
    class UnauthorizedRemoteMcpClient extends RemoteMcpClient {
      transportCloseCalls = 0;

      async connectOnce() {
        const transport = {
          close: async () => {
            this.transportCloseCalls += 1;
          },
          finishAuth: async () => {
            throw new Error("token exchange failed");
          },
        };
        this.trackTransport(transport);
        transport.onerror?.(new UnauthorizedError("authorization required"));
        throw new UnauthorizedError("authorization required");
      }
    }

    const client = new UnauthorizedRemoteMcpClient({
      statePath: join(dir, "state.json"),
      callbackServerFactory: async () => ({
        waitForCode: async () => "bad-code",
        close: async () => {
          callbackClosed = true;
        },
      }),
    });

    await assert.rejects(client.connect(), /token exchange failed/);
    assert.equal(client.transportCloseCalls, 1);
    assert.equal(callbackClosed, true);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("RemoteMcpClient cleans up unauthorized transport when OAuth retry fails", async () => {
  const dir = await mkdtemp(join(tmpdir(), "figma-stdio-client-"));
  try {
    let callbackClosed = false;
    class UnauthorizedRemoteMcpClient extends RemoteMcpClient {
      transportCloseCalls = 0;

      async connectOnce() {
        this.transport = {
          close: async () => {
            this.transportCloseCalls += 1;
          },
          finishAuth: async () => {
            throw new Error("token exchange failed");
          },
        };
        throw new UnauthorizedError("authorization required");
      }
    }

    const client = new UnauthorizedRemoteMcpClient({
      statePath: join(dir, "state.json"),
      callbackServerFactory: async () => ({
        waitForCode: async () => "bad-code",
        close: async () => {
          callbackClosed = true;
        },
      }),
    });

    await assert.rejects(client.connect(), /token exchange failed/);
    assert.equal(client.transportCloseCalls, 1);
    assert.equal(callbackClosed, true);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("RemoteMcpClient cancels a pending OAuth callback when closed", async () => {
  const dir = await mkdtemp(join(tmpdir(), "figma-stdio-client-"));
  try {
    let callbackCloseCalls = 0;
    let finishAuthCalls = 0;
    let transportCloseCalls = 0;
    let rejectWaitForCode;
    let resolveWaitForCodeStarted;
    const waitForCodeStarted = new Promise((resolve) => {
      resolveWaitForCodeStarted = resolve;
    });

    class UnauthorizedRemoteMcpClient extends RemoteMcpClient {
      async connectOnce() {
        const transport = {
          close: async () => {
            transportCloseCalls += 1;
          },
          finishAuth: async () => {
            finishAuthCalls += 1;
          },
        };
        this.trackTransport(transport);
        throw new UnauthorizedError("authorization required");
      }
    }

    const client = new UnauthorizedRemoteMcpClient({
      statePath: join(dir, "state.json"),
      callbackServerFactory: async () => ({
        waitForCode: () => {
          resolveWaitForCodeStarted();
          return new Promise((_, reject) => {
            rejectWaitForCode = reject;
          });
        },
        close: async () => {
          callbackCloseCalls += 1;
          rejectWaitForCode?.(
            new Error(
              "OAuth callback server was closed before authorization completed.",
            ),
          );
        },
      }),
    });

    const connectPromise = client.connect();

    await waitForCodeStarted;
    await client.close();

    await withTimeout(
      assert.rejects(connectPromise, /closed before authorization/),
      1000,
    );
    assert.equal(callbackCloseCalls, 1);
    assert.equal(finishAuthCalls, 0);
    assert.equal(transportCloseCalls >= 1, true);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

function withTimeout(promise, timeoutMs) {
  let timeout;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timeout = setTimeout(() => {
        reject(new Error(`Timed out after ${timeoutMs}ms`));
      }, timeoutMs);
    }),
  ]).finally(() => clearTimeout(timeout));
}
