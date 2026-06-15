import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { dirname, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import {
  createFigmaStdioMcpServer,
  startFigmaStdioMcpServer,
} from "../dist/index.js";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

test("stdio MCP server proxies tools and resources to the Figma client", async () => {
  const calls = [];
  let connected = false;
  const fakeClient = {
    async connect() {
      if (!connected) {
        connected = true;
        calls.push(["connect"]);
      }
    },
    async close() {
      calls.push(["close"]);
    },
    async listTools() {
      calls.push(["listTools"]);
      return {
        tools: [
          {
            name: "whoami",
            description: "Return the authenticated Figma user.",
            inputSchema: { type: "object", properties: {} },
          },
        ],
      };
    },
    async callTool(name, args) {
      calls.push(["callTool", name, args]);
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({ ok: true, name, args }),
          },
        ],
      };
    },
    async listResources() {
      calls.push(["listResources"]);
      return { resources: [{ uri: "figma://doc", name: "doc" }] };
    },
    async readResource(uri) {
      calls.push(["readResource", uri]);
      return {
        contents: [
          {
            uri,
            mimeType: "text/plain",
            text: "resource-body",
          },
        ],
      };
    },
  };

  const { server } = createFigmaStdioMcpServer({ client: fakeClient });
  const mcpClient = new Client(
    { name: "test-client", version: "0.1.0" },
    { capabilities: {} },
  );
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

  await server.connect(serverTransport);
  await mcpClient.connect(clientTransport);

  assert.deepEqual(await mcpClient.listTools(), {
    tools: [
      {
        name: "whoami",
        description: "Return the authenticated Figma user.",
        inputSchema: { type: "object", properties: {} },
      },
    ],
  });
  assert.deepEqual(await mcpClient.callTool({
    name: "whoami",
    arguments: { verbose: true },
  }), {
    content: [
      {
        type: "text",
        text: JSON.stringify({
          ok: true,
          name: "whoami",
          args: { verbose: true },
        }),
      },
    ],
  });
  assert.deepEqual(await mcpClient.listResources(), {
    resources: [{ uri: "figma://doc", name: "doc" }],
  });
  assert.deepEqual(await mcpClient.readResource({ uri: "figma://doc" }), {
    contents: [
      {
        uri: "figma://doc",
        mimeType: "text/plain",
        text: "resource-body",
      },
    ],
  });

  await mcpClient.close();
  assert.deepEqual(calls, [
    ["connect"],
    ["listTools"],
    ["callTool", "whoami", { verbose: true }],
    ["listResources"],
    ["readResource", "figma://doc"],
  ]);
});

test("startFigmaStdioMcpServer removes owned signal handlers when transport closes", async () => {
  const calls = [];
  const transport = new ControlledTransport();
  let existingOnCloseCalls = 0;
  transport.onclose = () => {
    existingOnCloseCalls += 1;
  };
  const sigintCount = process.listenerCount("SIGINT");
  const sigtermCount = process.listenerCount("SIGTERM");

  const running = startFigmaStdioMcpServer({
    client: createFakeProxyClient(calls),
    transport,
  });

  assert.equal(transport.startCalls, 1);
  assert.equal(process.listenerCount("SIGINT"), sigintCount + 1);
  assert.equal(process.listenerCount("SIGTERM"), sigtermCount + 1);

  await transport.close();
  await transport.close();
  await running;

  assert.equal(process.listenerCount("SIGINT"), sigintCount);
  assert.equal(process.listenerCount("SIGTERM"), sigtermCount);
  assert.equal(existingOnCloseCalls, 2);
  assert.deepEqual(calls, [["close"]]);
});

test("startFigmaStdioMcpServer removes owned signal handlers when transport start fails", async () => {
  const calls = [];
  const transport = new ControlledTransport({ failStart: true });
  const sigintCount = process.listenerCount("SIGINT");
  const sigtermCount = process.listenerCount("SIGTERM");

  await assert.rejects(
    startFigmaStdioMcpServer({
      client: createFakeProxyClient(calls),
      transport,
    }),
    /transport start failed/,
  );

  assert.equal(process.listenerCount("SIGINT"), sigintCount);
  assert.equal(process.listenerCount("SIGTERM"), sigtermCount);
  assert.equal(transport.closeCalls, 1);
  assert.deepEqual(calls, [["close"]]);
});

test("stdio CLI exits cleanly when stdin ends", async () => {
  const result = await runCliWithClosedStdin();

  assert.equal(result.code, 0);
  assert.equal(result.signal, null);
  assert.equal(result.stdout, "");
  assert.equal(result.stderr, "");
});

class ControlledTransport {
  constructor(options = {}) {
    this.failStart = options.failStart ?? false;
    this.startCalls = 0;
    this.closeCalls = 0;
  }

  async start() {
    this.startCalls += 1;
    if (this.failStart) {
      throw new Error("transport start failed");
    }
  }

  async send() {
    // Test transport never sends messages.
  }

  async close() {
    this.closeCalls += 1;
    this.onclose?.();
  }
}

function runCliWithClosedStdin() {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["dist/stdio-cli.js"], {
      cwd: packageRoot,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    const timeout = setTimeout(() => {
      child.kill();
      reject(new Error("stdio CLI did not exit after stdin closed"));
    }, 5000);

    child.stdout.on("data", (data) => {
      stdout += data;
    });
    child.stderr.on("data", (data) => {
      stderr += data;
    });
    child.on("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.on("exit", (code, signal) => {
      clearTimeout(timeout);
      resolve({ code, signal, stdout, stderr });
    });
    child.stdin.end();
  });
}

function createFakeProxyClient(calls) {
  return {
    async connect() {
      calls.push(["connect"]);
    },
    async close() {
      calls.push(["close"]);
    },
    async listTools() {
      return { tools: [] };
    },
    async callTool() {
      return { content: [] };
    },
    async listResources() {
      return { resources: [] };
    },
    async readResource(uri) {
      return { contents: [{ uri }] };
    },
  };
}
