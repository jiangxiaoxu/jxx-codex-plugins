import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createServer, UI_URI } from '../src/server.mjs';

test('MCP discovery opens an app resource and supports independent read-only refresh', async (t) => {
  const temporary = await mkdtemp(join(tmpdir(), 'agent-monitor-protocol-'));
  t.after(() => rm(temporary, { recursive: true, force: true }));
  const uiUrl = pathToFileURL(join(temporary, 'dashboard.html'));
  await writeFile(uiUrl, '<!doctype html><title>Agent Monitor</title><main id="app"></main>');
  const overview = { schemaVersion: 1, totals: { outputTps: 82, estimatedTps: 12 }, threads: [], nextCursor: null };
  const monitor = {
    activate() {},
    getSnapshot: async () => overview,
    getThread: async () => { throw new Error('Unknown thread'); },
    getAgent: async () => { throw new Error('Unknown agent'); },
    getHistory: async () => ({ days: [] })
  };
  const server = createServer(monitor, { uiUrl });
  const client = new Client({ name: 'agent-monitor-test', version: '1' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  t.after(() => client.close());
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  const { tools } = await client.listTools();
  const open = tools.find((tool) => tool.name === 'monitor_open');
  assert.equal(open._meta.ui.resourceUri, UI_URI);
  assert.deepEqual(open._meta['openai/ui'].entrypoints, [{ type: 'global' }, { type: 'thread' }]);
  assert.deepEqual(tools.find((tool) => tool.name === 'monitor_snapshot')._meta.ui.visibility, ['app']);
  assert.ok(tools.every((tool) => tool.annotations.readOnlyHint));
  const resource = await client.readResource({ uri: UI_URI });
  assert.equal(resource.contents[0].mimeType, 'text/html;profile=mcp-app');
  assert.ok(resource.contents[0].text.includes('<main id="app">'));
  const initial = await client.callTool({ name: 'monitor_open', arguments: {} });
  assert.deepEqual(initial.structuredContent, overview);
  overview.totals.outputTps = 91;
  const refreshed = await client.callTool({ name: 'monitor_snapshot', arguments: {} });
  assert.equal(refreshed.structuredContent.totals.outputTps, 91);
  const missing = await client.callTool({ name: 'monitor_agent', arguments: { agentId: 'missing' } });
  assert.equal(missing.isError, true);
  assert.equal(missing.structuredContent, undefined);
});
