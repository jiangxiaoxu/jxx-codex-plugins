import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { setTimeout as delay } from 'node:timers/promises';
import { RuntimeClient } from '../src/monitor/runtime.mjs';

test('observer excludes compressed paths before metadata reads, projects metadata and fails closed on disconnect', async t => {
  const home = await mkdtemp(join(tmpdir(), 'agent-monitor-observer-'));
  let runtime;
  t.after(async () => { runtime?.close(); await rm(home, { recursive: true, force: true }); });
  const plain = join(home, 'plain.jsonl'), compressed = join(home, 'compressed.jsonl');
  await writeFile(plain, '{}\n');
  await writeFile(`${compressed}.zst`, 'not a readable JSONL');
  const socketPath = join(home, 'test.sock');
  await writeFile(socketPath, '');
  const db = new DatabaseSync(join(home, 'state_5.sqlite'));
  db.exec('CREATE TABLE threads (id TEXT PRIMARY KEY, rollout_path TEXT NOT NULL)');
  const insert = db.prepare('INSERT INTO threads VALUES (?, ?)');
  insert.run('plain', plain);
  insert.run('compressed', compressed);
  db.close();
  const fixturePath = join(home, 'fixture.json');
  await writeFile(fixturePath, JSON.stringify({ home, threads: [
    { id: 'plain', status: { type: 'active', activeFlags: [] }, path: plain, name: 'Fixture thread', model: 'model-a', preview: 'PRIVATE_MESSAGE', turns: [{ text: 'PRIVATE_MESSAGE' }] },
    { id: 'compressed', forbidden: true }, { id: 'missing', forbidden: true },
  ] }));
  runtime = new RuntimeClient({ codexHome: home, socketPath, command: [process.execPath, fileURLToPath(new URL('./fixtures/runtime-proxy.mjs', import.meta.url)), fixturePath] });
  const threads = await runtime.list();
  assert.deepEqual(threads.map(thread => thread.id), ['plain']);
  assert.equal(threads[0].status.type, 'active');
  assert.equal(threads[0].model, 'model-a');
  assert.ok(!JSON.stringify(threads).includes('PRIVATE_MESSAGE'));
  assert.equal(runtime.skippedCompressedFiles, 1);
  assert.equal(runtime.exclusions.missingMetadata, 1);
  await delay(1050);
  await assert.rejects(runtime.list(), /closed|exited|disconnected/);
  await assert.rejects(runtime.list(), /closed|exited|disconnected/);
});

test('new runtime notifications survive older metadata and normal unload does not fail the catalog', async t => {
  const home = await mkdtemp(join(tmpdir(), 'agent-monitor-runtime-transition-'));
  let runtime;
  t.after(async () => { runtime?.close(); await rm(home, { recursive: true, force: true }); });
  const socketPath = join(home, 'test.sock');
  await writeFile(socketPath, '');
  const db = new DatabaseSync(join(home, 'state_5.sqlite'));
  db.exec('CREATE TABLE threads (id TEXT PRIMARY KEY, rollout_path TEXT NOT NULL)');
  const threads = [];
  for (const id of ['plain', 'vanishing']) {
    const filePath = join(home, `${id}.jsonl`);
    await writeFile(filePath, '{}\n');
    db.prepare('INSERT INTO threads VALUES (?, ?)').run(id, filePath);
    threads.push({ id, path: filePath, status: { type: 'active', activeFlags: [] }, vanish: id === 'vanishing' });
  }
  db.close();
  const fixturePath = join(home, 'fixture.json');
  await writeFile(fixturePath, JSON.stringify({ home, transitions: true, threads }));
  runtime = new RuntimeClient({ codexHome: home, socketPath, command: [process.execPath, fileURLToPath(new URL('./fixtures/runtime-proxy.mjs', import.meta.url)), fixturePath] });
  const initial = await runtime.list();
  assert.deepEqual(initial.map(thread => thread.id), ['plain']);
  assert.equal(initial[0].status.type, 'idle');
  assert.equal((await runtime.list())[0].status.type, 'idle');
});
