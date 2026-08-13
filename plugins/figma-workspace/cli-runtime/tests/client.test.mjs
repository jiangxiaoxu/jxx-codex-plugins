import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { UnauthorizedError } from "@modelcontextprotocol/sdk/client/auth.js";
import {
  OAuthCallbackError,
  RemoteMcpClient,
  RemoteMcpOAuthError,
  startOAuthCallbackServer,
} from "../dist/runtime/workspace-runtime.js";

test("RemoteMcpClient does not start the OAuth callback server when cached auth connects", async () => {
  const dir = await mkdtemp(join(tmpdir(), "figma-workspace-mcp-stdio-binent-"));
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
  const dir = await mkdtemp(join(tmpdir(), "figma-workspace-mcp-stdio-binent-"));
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

test("RemoteMcpClient forwards AbortSignal and the five-minute total deadline to SDK requests", async () => {
  const dir = await mkdtemp(join(tmpdir(), "figma-workspace-mcp-request-options-"));
  const calls = [];
  try {
    class RequestOptionsRemoteMcpClient extends RemoteMcpClient {
      async connectOnce() {
        return {
          client: {
            async listTools(params, options) {
              calls.push(["listTools", params, options]);
              return { tools: [] };
            },
            async callTool(params, schema, options) {
              calls.push(["callTool", params, schema, options]);
              return { content: [] };
            },
            async listResources(params, options) {
              calls.push(["listResources", params, options]);
              return { resources: [] };
            },
            async listResourceTemplates(params, options) {
              calls.push(["listResourceTemplates", params, options]);
              return { resourceTemplates: [] };
            },
            async readResource(params, options) {
              calls.push(["readResource", params, options]);
              return { contents: [] };
            },
          },
          transport: { close: async () => undefined },
        };
      }
    }
    const client = new RequestOptionsRemoteMcpClient({ statePath: join(dir, "state.json") });
    const controller = new AbortController();
    await client.connect();
    await client.listTools(controller.signal);
    await client.callTool("whoami", {}, controller.signal);
    await client.listResources(controller.signal);
    await client.listResourceTemplates(controller.signal);
    await client.readResource("figma://resource", controller.signal);

    for (const call of calls) {
      const options = call.at(-1);
      assert.equal(options.timeout, 5 * 60 * 1000, call[0]);
      assert.equal(options.maxTotalTimeout, 5 * 60 * 1000, call[0]);
      if (["listTools", "listResources", "listResourceTemplates"].includes(call[0])) {
        assert.notEqual(options.signal, controller.signal, call[0]);
        assert.equal(options.signal.aborted, false, call[0]);
      } else {
        assert.equal(options.signal, controller.signal, call[0]);
      }
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("RemoteMcpClient aggregates paginated discovery with one shared signal", async () => {
  const dir = await mkdtemp(join(tmpdir(), "figma-workspace-mcp-discovery-pagination-"));
  const calls = [];
  try {
    class PagedRemoteMcpClient extends RemoteMcpClient {
      async connectOnce() {
        return {
          client: {
            async listTools(params, options) {
              calls.push(["tools", params, options]);
              return params.cursor === "tools-2"
                ? {
                    tools: [
                      { name: "alpha", description: "first", inputSchema: { type: "object" } },
                      { name: "beta", inputSchema: { type: "object" } },
                    ],
                  }
                : {
                    tools: [{ description: "first", inputSchema: { type: "object" }, name: "alpha" }],
                    nextCursor: "tools-2",
                  };
            },
            async listResources(params, options) {
              calls.push(["resources", params, options]);
              return params.cursor === "resources-2"
                ? { resources: [{ uri: "figma://beta", name: "Beta" }] }
                : { resources: [{ uri: "figma://alpha", name: "Alpha" }], nextCursor: "resources-2" };
            },
            async listResourceTemplates(params, options) {
              calls.push(["resourceTemplates", params, options]);
              return params.cursor === "templates-2"
                ? { resourceTemplates: [{ uriTemplate: "figma://beta/{id}", name: "Beta" }] }
                : {
                    resourceTemplates: [{ uriTemplate: "figma://alpha/{id}", name: "Alpha" }],
                    nextCursor: "templates-2",
                  };
            },
          },
          transport: { close: async () => undefined },
        };
      }
    }

    const client = new PagedRemoteMcpClient({ statePath: join(dir, "state.json") });
    const controller = new AbortController();
    await client.connect();

    assert.deepEqual(await client.listTools(controller.signal), {
      tools: [
        { description: "first", inputSchema: { type: "object" }, name: "alpha" },
        { name: "beta", inputSchema: { type: "object" } },
      ],
    });
    assert.deepEqual(await client.listResources(controller.signal), {
      resources: [
        { uri: "figma://alpha", name: "Alpha" },
        { uri: "figma://beta", name: "Beta" },
      ],
    });
    assert.deepEqual(await client.listResourceTemplates(controller.signal), {
      resourceTemplates: [
        { uriTemplate: "figma://alpha/{id}", name: "Alpha" },
        { uriTemplate: "figma://beta/{id}", name: "Beta" },
      ],
    });

    assert.deepEqual(calls.map(([kind, params]) => [kind, params]), [
      ["tools", {}],
      ["tools", { cursor: "tools-2" }],
      ["resources", {}],
      ["resources", { cursor: "resources-2" }],
      ["resourceTemplates", {}],
      ["resourceTemplates", { cursor: "templates-2" }],
    ]);
    for (const [, , options] of calls) {
      assert.equal(options.timeout, 5 * 60 * 1000);
      assert.equal(options.maxTotalTimeout, 5 * 60 * 1000);
    }
    assert.notEqual(calls[0][2].signal, controller.signal);
    assert.equal(calls[0][2].signal, calls[1][2].signal);
    assert.equal(calls[2][2].signal, calls[3][2].signal);
    assert.equal(calls[4][2].signal, calls[5][2].signal);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("RemoteMcpClient combines caller cancellation with one total discovery deadline", async () => {
  const dir = await mkdtemp(join(tmpdir(), "figma-workspace-mcp-discovery-deadline-"));
  const caller = new AbortController();
  const callerReason = new Error("caller cancelled discovery");
  const signals = [];
  const scheduledDelays = [];
  const originalSetTimeout = globalThis.setTimeout;
  try {
    class DelayedPagedRemoteMcpClient extends RemoteMcpClient {
      async connectOnce() {
        return {
          client: {
            async listTools(params, options) {
              signals.push(options.signal);
              if (!params.cursor) {
                return {
                  tools: [{ name: "first", inputSchema: { type: "object" } }],
                  nextCursor: "next",
                };
              }
              return new Promise((resolve, reject) => {
                if (options.signal.aborted) {
                  reject(options.signal.reason);
                  return;
                }
                options.signal.addEventListener("abort", () => reject(options.signal.reason), {
                  once: true,
                });
              });
            },
          },
          transport: { close: async () => undefined },
        };
      }
    }

    globalThis.setTimeout = (callback, delay, ...args) => {
      scheduledDelays.push(delay);
      return originalSetTimeout(callback, delay, ...args);
    };
    const client = new DelayedPagedRemoteMcpClient({ statePath: join(dir, "state.json") });
    await client.connect();
    const pending = client.listTools(caller.signal);
    while (signals.length < 2) {
      await new Promise((resolve) => setImmediate(resolve));
    }
    caller.abort(callerReason);

    await assert.rejects(pending, (error) => {
      assert.equal(error.code, "FIGMA_UPSTREAM_DISCOVERY_PAGINATION_FAILED");
      assert.equal(error.cause, callerReason);
      return true;
    });
    assert.deepEqual(scheduledDelays, [5 * 60 * 1000]);
    assert.notEqual(signals[0], caller.signal);
    assert.equal(signals[0], signals[1]);
    assert.equal(signals[0].aborted, true);
    assert.equal(signals[0].reason, callerReason);
  } finally {
    globalThis.setTimeout = originalSetTimeout;
    await rm(dir, { recursive: true, force: true });
  }
});

test("RemoteMcpClient fails closed on discovery pagination corruption or a later page error", async () => {
  const dir = await mkdtemp(join(tmpdir(), "figma-workspace-mcp-discovery-failure-"));
  try {
    class InvalidPagedRemoteMcpClient extends RemoteMcpClient {
      mode = "conflict";

      async connectOnce() {
        const owner = this;
        return {
          client: {
            async listTools(params) {
              if (owner.mode === "later-error" && params.cursor === "next") {
                throw new Error("network interruption");
              }
              if (owner.mode === "page-limit") {
                const page = Number(params.cursor ?? "0");
                return {
                  tools: [{ name: `tool-${page}`, inputSchema: { type: "object" } }],
                  nextCursor: String(page + 1),
                };
              }
              if (owner.mode === "cursor-loop") {
                return {
                  tools: [{ name: params.cursor ?? "first", inputSchema: { type: "object" } }],
                  nextCursor: "loop",
                };
              }
              if (params.cursor === "next") {
                return { tools: [{ name: "shared", description: "second", inputSchema: { type: "object" } }] };
              }
              return {
                tools: [{ name: "shared", description: "first", inputSchema: { type: "object" } }],
                nextCursor: "next",
              };
            },
          },
          transport: { close: async () => undefined },
        };
      }
    }

    const client = new InvalidPagedRemoteMcpClient({ statePath: join(dir, "state.json") });
    await client.connect();
    for (const [mode, pattern] of [
      ["conflict", /conflicting entries/u],
      ["cursor-loop", /nextCursor loop/u],
      ["page-limit", /100-page limit/u],
      ["later-error", /failed on page 2/u],
    ]) {
      client.mode = mode;
      await assert.rejects(client.listTools(), (error) => {
        assert.equal(error.code, "FIGMA_UPSTREAM_DISCOVERY_PAGINATION_FAILED");
        assert.match(error.message, pattern);
        return true;
      });
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("RemoteMcpClient discards an in-flight connection after close", async () => {
  const dir = await mkdtemp(join(tmpdir(), "figma-workspace-mcp-stdio-binent-"));
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
    await assert.rejects(firstConnect, (error) => {
      assert.equal(error instanceof RemoteMcpOAuthError, true);
      assert.equal(error.code, "FIGMA_UPSTREAM_OAUTH_CANCELLED");
      assert.equal(error.cause?.message, "MCP connection attempt was cancelled.");
      return true;
    });
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
  const dir = await mkdtemp(join(tmpdir(), "figma-workspace-mcp-stdio-binent-"));
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
  const dir = await mkdtemp(join(tmpdir(), "figma-workspace-mcp-stdio-binent-"));
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

    await assert.rejects(client.connect(), (error) => {
      assert.equal(error instanceof RemoteMcpOAuthError, true);
      assert.equal(error.code, "FIGMA_UPSTREAM_OAUTH_TOKEN_EXCHANGE_FAILED");
      assert.match(error.cause?.message, /token exchange failed/);
      return true;
    });
    assert.equal(client.transportCloseCalls, 1);
    assert.equal(callbackClosed, true);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("RemoteMcpClient cleans up unauthorized transport when OAuth retry fails", async () => {
  const dir = await mkdtemp(join(tmpdir(), "figma-workspace-mcp-stdio-binent-"));
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

    await assert.rejects(client.connect(), (error) => {
      assert.equal(error instanceof RemoteMcpOAuthError, true);
      assert.equal(error.code, "FIGMA_UPSTREAM_OAUTH_TOKEN_EXCHANGE_FAILED");
      assert.match(error.cause?.message, /token exchange failed/);
      return true;
    });
    assert.equal(client.transportCloseCalls, 1);
    assert.equal(callbackClosed, true);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("RemoteMcpClient classifies OAuth client registration rejection from structured status", async () => {
  const dir = await mkdtemp(join(tmpdir(), "figma-workspace-mcp-stdio-binent-"));
  try {
    class RegistrationRejectedRemoteMcpClient extends RemoteMcpClient {
      async connectOnce() {
        const error = new Error("Figma OAuth client registration rejected.");
        error.response = { status: 403 };
        error.code = "FORBIDDEN";
        throw error;
      }
    }

    const client = new RegistrationRejectedRemoteMcpClient({
      statePath: join(dir, "state.json"),
    });

    await assert.rejects(client.connect(), (error) => {
      assert.equal(error instanceof RemoteMcpOAuthError, true);
      assert.equal(error.code, "FIGMA_UPSTREAM_OAUTH_REGISTRATION_REJECTED");
      assert.equal(error.details.oauthCacheFile, ".figma-workspace-oauth.json");
      assert.equal(error.details.upstreamStatus, 403);
      assert.equal(error.details.upstreamCode, "FORBIDDEN");
      return true;
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("RemoteMcpClient ignores OAuth-looking registration text when structured status disagrees", async () => {
  const dir = await mkdtemp(join(tmpdir(), "figma-workspace-mcp-stdio-binent-"));
  try {
    const originalError = new Error("HTTP 403 Forbidden");
    originalError.status = 500;
    class RegistrationFailedRemoteMcpClient extends RemoteMcpClient {
      async connectOnce() {
        throw originalError;
      }
    }

    const client = new RegistrationFailedRemoteMcpClient({
      statePath: join(dir, "state.json"),
    });

    await assert.rejects(client.connect(), (error) => {
      assert.equal(error, originalError);
      assert.equal(error instanceof RemoteMcpOAuthError, false);
      return true;
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("RemoteMcpClient maps typed OAuth callback timeout without message matching", async () => {
  const dir = await mkdtemp(join(tmpdir(), "figma-workspace-mcp-stdio-binent-"));
  try {
    class UnauthorizedRemoteMcpClient extends RemoteMcpClient {
      async connectOnce() {
        const transport = {
          close: async () => undefined,
          finishAuth: async () => undefined,
        };
        this.trackTransport(transport);
        throw new UnauthorizedError("authorization required");
      }
    }

    const client = new UnauthorizedRemoteMcpClient({
      statePath: join(dir, "state.json"),
      callbackServerFactory: async () => ({
        waitForCode: async () => {
          throw new OAuthCallbackError(
            "OAUTH_CALLBACK_TIMEOUT",
            "Different localized timeout text.",
          );
        },
        close: async () => undefined,
      }),
    });

    await assert.rejects(client.connect(), (error) => {
      assert.equal(error instanceof RemoteMcpOAuthError, true);
      assert.equal(error.code, "FIGMA_UPSTREAM_OAUTH_CALLBACK_TIMEOUT");
      assert.match(error.cause?.message, /Different localized timeout text/);
      return true;
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("startOAuthCallbackServer reports port conflicts as typed startup errors", async () => {
  const occupiedServer = createServer((_request, response) => {
    response.end("busy");
  });
  await listen(occupiedServer, 0, "127.0.0.1");
  const address = occupiedServer.address();
  assert.equal(typeof address, "object");
  assert.notEqual(address, null);

  try {
    await assert.rejects(
      startOAuthCallbackServer({
        host: "127.0.0.1",
        port: address.port,
        path: "/oauth/callback",
        timeoutMs: 1000,
      }),
      (error) => {
        assert.equal(error instanceof OAuthCallbackError, true);
        assert.equal(error.code, "OAUTH_CALLBACK_PORT_IN_USE");
        assert.equal(error.details.callbackHost, "127.0.0.1");
        assert.equal(error.details.callbackPort, address.port);
        assert.equal(error.details.callbackPath, "/oauth/callback");
        assert.equal(error.details.callbackUrl, `http://127.0.0.1:${address.port}/oauth/callback`);
        assert.equal(error.details.upstreamCode, "EADDRINUSE");
        assert.equal(error.cause?.code, "EADDRINUSE");
        assert.match(error.message, /already in use/u);
        return true;
      },
    );
  } finally {
    await closeServer(occupiedServer);
  }
});

test("RemoteMcpClient maps OAuth callback port conflicts to specific recovery details", async () => {
  const dir = await mkdtemp(join(tmpdir(), "figma-workspace-mcp-stdio-binent-"));
  try {
    class UnauthorizedRemoteMcpClient extends RemoteMcpClient {
      async connectOnce() {
        const transport = {
          close: async () => undefined,
          finishAuth: async () => undefined,
        };
        this.trackTransport(transport);
        throw new UnauthorizedError("authorization required");
      }
    }

    const client = new UnauthorizedRemoteMcpClient({
      statePath: join(dir, "state.json"),
      callbackHost: "127.0.0.1",
      callbackPort: 39123,
      callbackServerFactory: async () => {
        throw new OAuthCallbackError(
          "OAUTH_CALLBACK_PORT_IN_USE",
          "OAuth callback port 39123 on 127.0.0.1 is already in use.",
          {
            details: {
              callbackHost: "127.0.0.1",
              callbackPort: 39123,
              callbackPath: "/oauth/callback",
              callbackUrl: "http://127.0.0.1:39123/oauth/callback",
              upstreamCode: "EADDRINUSE",
            },
          },
        );
      },
    });

    await assert.rejects(client.connect(), (error) => {
      assert.equal(error instanceof RemoteMcpOAuthError, true);
      assert.equal(error.code, "FIGMA_UPSTREAM_OAUTH_CALLBACK_PORT_IN_USE");
      assert.equal(error.message, "Figma MCP OAuth callback port is already in use.");
      assert.equal(error.details.loginCommand, "npm run login:figma-http");
      assert.equal(error.details.oauthCacheFile, ".figma-workspace-oauth.json");
      assert.equal(error.details.callbackHost, "127.0.0.1");
      assert.equal(error.details.callbackPort, 39123);
      assert.equal(error.details.callbackUrl, "http://127.0.0.1:39123/oauth/callback");
      assert.equal(error.details.upstreamCode, "EADDRINUSE");
      return true;
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("RemoteMcpClient treats callback-like plain messages as generic callback failures", async () => {
  const dir = await mkdtemp(join(tmpdir(), "figma-workspace-mcp-stdio-binent-"));
  try {
    class UnauthorizedRemoteMcpClient extends RemoteMcpClient {
      async connectOnce() {
        const transport = {
          close: async () => undefined,
          finishAuth: async () => undefined,
        };
        this.trackTransport(transport);
        throw new UnauthorizedError("authorization required");
      }
    }

    const client = new UnauthorizedRemoteMcpClient({
      statePath: join(dir, "state.json"),
      callbackServerFactory: async () => ({
        waitForCode: async () => {
          throw new Error("Timed out waiting for OAuth callback.");
        },
        close: async () => undefined,
      }),
    });

    await assert.rejects(client.connect(), (error) => {
      assert.equal(error instanceof RemoteMcpOAuthError, true);
      assert.equal(error.code, "FIGMA_UPSTREAM_OAUTH_CALLBACK_FAILED");
      return true;
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("RemoteMcpClient cancels a pending OAuth callback when closed", async () => {
  const dir = await mkdtemp(join(tmpdir(), "figma-workspace-mcp-stdio-binent-"));
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
            new OAuthCallbackError(
              "OAUTH_CALLBACK_CANCELLED",
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
      assert.rejects(connectPromise, (error) => {
        assert.equal(error instanceof RemoteMcpOAuthError, true);
        assert.equal(error.code, "FIGMA_UPSTREAM_OAUTH_CANCELLED");
        assert.match(error.cause?.message, /closed before authorization/);
        return true;
      }),
      1000,
    );
    assert.equal(callbackCloseCalls, 1);
    assert.equal(finishAuthCalls, 0);
    assert.equal(transportCloseCalls >= 1, true);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("RemoteMcpClient reports stale OAuth retry as typed cancellation", async () => {
  const dir = await mkdtemp(join(tmpdir(), "figma-workspace-mcp-stdio-binent-"));
  try {
    let callbackCloseCalls = 0;
    let transportCloseCalls = 0;

    class UnauthorizedRemoteMcpClient extends RemoteMcpClient {
      async connectOnce() {
        const transport = {
          close: async () => {
            transportCloseCalls += 1;
          },
          finishAuth: async () => undefined,
        };
        this.trackTransport(transport);
        throw new UnauthorizedError("authorization required");
      }
    }

    let client;
    client = new UnauthorizedRemoteMcpClient({
      statePath: join(dir, "state.json"),
      callbackServerFactory: async () => {
        await client.close();
        return {
          waitForCode: async () => "unused",
          close: async () => {
            callbackCloseCalls += 1;
          },
        };
      },
    });

    await assert.rejects(client.connect(), (error) => {
      assert.equal(error instanceof RemoteMcpOAuthError, true);
      assert.equal(error.code, "FIGMA_UPSTREAM_OAUTH_CANCELLED");
      assert.equal(error.cause?.message, "MCP connection attempt was cancelled.");
      return true;
    });
    assert.equal(callbackCloseCalls, 1);
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

function listen(server, port, host) {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      server.off("error", reject);
      resolve();
    });
  });
}

function closeServer(server) {
  if (!server.listening) {
    return Promise.resolve();
  }
  return new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}
