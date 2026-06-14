import assert from "node:assert/strict";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createFigmaStdioMcpServer } from "../dist/index.js";

test("stdio MCP server proxies tools and resources to the Figma client", async () => {
  const calls = [];
  const fakeClient = {
    async connect() {
      calls.push(["connect"]);
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
    ["connect"],
    ["callTool", "whoami", { verbose: true }],
    ["connect"],
    ["listResources"],
    ["connect"],
    ["readResource", "figma://doc"],
  ]);
});
