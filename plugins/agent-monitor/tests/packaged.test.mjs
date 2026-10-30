import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, copyFile, rm, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

test('bundled stdio runtime starts outside the repository without node_modules', async (t) => {
  const temporary = await mkdtemp(join(tmpdir(), 'agent-monitor-packed-'));
  let client;
  t.after(async () => {
    await client?.close();
    await rm(temporary, { recursive: true, force: true });
  });
  await mkdir(join(temporary, 'dist'));
  await mkdir(join(temporary, 'codex-home'));
  for (const name of ['server.mjs', 'dashboard.html']) {
    await copyFile(new URL(`../dist/${name}`, import.meta.url), join(temporary, 'dist', name));
  }
  client = new Client({ name: 'agent-monitor-package-test', version: '1' });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [join(temporary, 'dist/server.mjs')],
    cwd: temporary,
    env: { ...process.env, CODEX_HOME: join(temporary, 'codex-home'), AGENT_MONITOR_STATE_DIR: join(temporary, 'state') },
    stderr: 'pipe'
  });
  let stderr = '';
  transport.stderr?.on('data', (data) => { stderr += data.toString(); });
  await client.connect(transport);
  await client.listTools();
  const { contents } = await client.readResource({ uri: 'ui://agent-monitor/dashboard' });
  await assert.rejects(access(join(temporary, 'state', 'metrics.sqlite')), { code: 'ENOENT' });
  const opened = await client.callTool({ name: 'monitor_open', arguments: {} });
  assert.notEqual(opened.isError, true, stderr);
  assert.equal(opened.structuredContent.totals.outputTps, 0);
  const diagnostics = await client.callTool({ name: 'monitor_diagnostics', arguments: {} });
  assert.equal(diagnostics.structuredContent.version, '0.1.1');
  assert.ok(diagnostics.structuredContent.logPath.startsWith(join(temporary, 'state')));
  assert.ok(diagnostics.structuredContent.events.some((event) => event.event === 'mcp.initialized'));
  assert.ok(diagnostics.structuredContent.events.some((event) => event.event === 'mcp.entrypoint_opened'));
  assert.ok(contents[0].text.includes('id="monitor"'));
  assert.ok(!/<script\b[^>]*\bsrc=["']\.\//i.test(contents[0].text));
  assert.ok(!/<link\b[^>]*\bhref=["']\.\//i.test(contents[0].text));
});
