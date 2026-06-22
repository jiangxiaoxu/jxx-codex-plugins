import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { dirname, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createFigmaStdioMcpServer } from "../dist/index.js";

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
            inputSchema: {
              type: "object",
              properties: {
                verbose: { type: "boolean" },
              },
              required: ["verbose"],
            },
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
        inputSchema: {
          type: "object",
          properties: {
            verbose: { type: "boolean" },
            title: {
              type: "string",
              description:
                "One concise sentence-style line for UI/log display.",
            },
          },
          required: ["verbose"],
        },
      },
    ],
  });
  assert.deepEqual(await mcpClient.callTool({
    name: "whoami",
    arguments: { verbose: true, title: "Current Figma user" },
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
  assert.deepEqual(await mcpClient.callTool({
    name: "whoami",
    arguments: { verbose: false },
  }), {
    content: [
      {
        type: "text",
        text: JSON.stringify({
          ok: true,
          name: "whoami",
          args: { verbose: false },
        }),
      },
    ],
  });
  await assert.rejects(
    mcpClient.callTool({
      name: "whoami",
      arguments: { verbose: true, title: 123 },
    }),
    /Tool argument "title" must be a string\./,
  );
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
    ["callTool", "whoami", { verbose: false }],
    ["listResources"],
    ["readResource", "figma://doc"],
  ]);
});

test("stdio CLI exits cleanly when stdin ends", async () => {
  const result = await runCliWithClosedStdin();

  assert.equal(result.code, 0);
  assert.equal(result.signal, null);
  assert.equal(result.stdout, "");
  assert.equal(result.stderr, "");
});

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
