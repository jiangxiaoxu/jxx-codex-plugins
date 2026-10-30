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
    setBackgroundCollection: ({ enabled }) => ({ backgroundEnabled: enabled, scope: 'process' }),
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
  const [icon] = client.getServerVersion().icons;
  assert.equal(icon.mimeType, 'image/svg+xml');
  assert.match(icon.src, /^data:image\/svg\+xml;base64,/);
  assert.match(Buffer.from(icon.src.split(',')[1], 'base64').toString('utf8'), /<svg\b[^>]*xmlns="http:\/\/www\.w3\.org\/2000\/svg"/);
  const { tools } = await client.listTools();
  const open = tools.find((tool) => tool.name === 'monitor_open');
  assert.equal(open._meta.ui.resourceUri, UI_URI);
  assert.deepEqual(open._meta['openai/ui'].entrypoints, [{ type: 'global' }, { type: 'thread' }]);
  assert.deepEqual(tools.find((tool) => tool.name === 'monitor_snapshot')._meta.ui.visibility, ['app']);
  assert.ok(tools.filter(tool => tool.name !== 'monitor_background').every((tool) => tool.annotations.readOnlyHint));
  const background = tools.find(tool => tool.name === 'monitor_background');
  assert.equal(background.annotations.readOnlyHint, false);
  assert.deepEqual(background._meta.ui.visibility, ['app']);
  const resource = await client.readResource({ uri: UI_URI });
  assert.equal(resource.contents[0].mimeType, 'text/html;profile=mcp-app');
  assert.ok(resource.contents[0].text.includes('<main id="app">'));
  const initial = await client.callTool({ name: 'monitor_open', arguments: {} });
  assert.deepEqual(initial.structuredContent, overview);
  overview.totals.outputTps = 91;
  const refreshed = await client.callTool({ name: 'monitor_snapshot', arguments: {} });
  assert.equal(refreshed.structuredContent.totals.outputTps, 91);
  const enabled = await client.callTool({ name: 'monitor_background', arguments: { enabled: true } });
  assert.deepEqual(enabled.structuredContent, { backgroundEnabled: true, scope: 'process' });
  const disabled = await client.callTool({ name: 'monitor_background', arguments: { enabled: false } });
  assert.deepEqual(disabled.structuredContent, { backgroundEnabled: false, scope: 'process' });
  const missing = await client.callTool({ name: 'monitor_agent', arguments: { agentId: 'missing' } });
  assert.equal(missing.isError, true);
  assert.equal(missing.structuredContent, undefined);
});
