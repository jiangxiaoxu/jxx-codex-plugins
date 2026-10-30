import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, appendFile, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { Monitor } from '../src/monitor/index.mjs';

const epoch = Date.parse('2026-10-30T07:00:00.000Z');
const iso = offset => new Date(epoch + offset).toISOString();
const line = (type, offset, payload, ordinal) => JSON.stringify({ timestamp: iso(offset), type, payload, ...(ordinal === undefined ? {} : { ordinal }) }) + '\n';
const meta = (id, offset, extra = {}) => line('session_meta', offset, { id, cwd: '/workspace/project', ...extra });
const input = offset => line('event_msg', offset, { type: 'task_started' });
const usage = (id, offset, output, extra = {}) => line('token_usage_record', offset, { response_id: id, usage: { input_tokens: 50, cached_input_tokens: 10, output_tokens: output, reasoning_output_tokens: 20 }, ...extra });

async function setup(t, { clock } = {}) {
  const folder = await mkdtemp(path.join(tmpdir(), 'agent-monitor-'));
  const codexHome = path.join(folder, 'codex');
  const stateDir = path.join(folder, 'state');
  await mkdir(path.join(codexHome, 'sessions'), { recursive: true });
  let now = epoch;
  const paths = new Set(), overrides = new Map();
  const runtime = { paths, overrides, error: null, close() {}, assertConnected() { if (this.error) throw this.error; }, async list() {
    if (this.error) throw this.error;
    const threads = [];
    for (const filePath of paths) {
      let entry;
      try { entry = filePath.endsWith('.zst') ? {} : JSON.parse((await readFile(filePath, 'utf8')).split('\n')[0]).payload; }
      catch (error) { if (error.code === 'ENOENT') continue; throw error; }
      const id = entry.id ?? path.basename(filePath);
      threads.push({ id, path: filePath, parentThreadId: entry.parent_thread_id ?? null, status: { type: 'active', activeFlags: [] }, createdAt: (epoch - 20000) / 1000, updatedAt: epoch / 1000, recencyAt: epoch / 1000, ...overrides.get(id) });
    }
    return threads;
  } };
  const monitor = new Monitor({ codexHome, stateDir, runtime, now: clock ?? (() => now) });
  const monitors = [monitor];
  t.after(async () => { await Promise.all(monitors.map(item => item.stop())); await rm(folder, { recursive: true, force: true }); });
  return { folder, codexHome, stateDir, monitor, monitors, runtime, setNow(value) { now = value; }, file(name) { const filePath = path.join(codexHome, 'sessions', name); paths.add(filePath); return filePath; } };
}

test('modern main and nested agents are counted once, copied context is excluded, and modes stay per agent', async t => {
  const env = await setup(t);
  await writeFile(path.join(env.codexHome, 'config.toml'), 'service_tier = "priority"\n');
  await writeFile(env.file('root.jsonl'), meta('root-id', -20000) + line('turn_context', -11000, { model: 'model-a', effort: 'xhigh' }) + input(-10000) + line('event_msg', -9000, { type: 'thread_settings_applied', thread_settings: { service_tier: 'ultrafast' } }) + usage('root-response', 0, 1000));
  const copied = line('token_usage_record', -4000, { response_id: 'inherited-fresh-timestamp', usage: { output_tokens: 8000 } }, 1);
  const child = meta('child-id', -5000, { parent_thread_id: 'root-id', thread_source: 'subagent', subagent_history_start_ordinal: 5 }) + copied + line('turn_context', -3500, { model: 'model-b' }, 5) + line('event_msg', -3000, { type: 'task_started' }, 6) + line('token_usage_record', -1000, { response_id: 'child-response', usage: { input_tokens: 50, output_tokens: 200 } }, 7) + usage('child-response', -500, 200);
  await writeFile(env.file('child.jsonl'), child);
  env.runtime.overrides.set('root-id', { name: 'A real metadata title' });
  await env.monitor.start();
  const snapshot = await env.monitor.getSnapshot({ limit: 1 });
  assert.equal(snapshot.totals.outputTokens, 1200);
  assert.equal(snapshot.totals.reasoningTokens, 20);
  assert.equal(snapshot.totals.threadCount, 1);
  assert.equal(snapshot.threads[0].agentCount, 2);
  assert.equal(snapshot.threads[0].title, 'A real metadata title');
  assert.ok(Math.abs(snapshot.totals.outputTps - 166.6666667) < 0.001);
  assert.equal(snapshot.models.reduce((sum, model) => sum + model.outputTps, 0), snapshot.totals.outputTps);
  assert.equal(snapshot.threads[0].rate.outputTps, snapshot.totals.outputTps);
  const root = await env.monitor.getAgent({ agentId: 'root-id' });
  const childResult = await env.monitor.getAgent({ agentId: 'child-id' });
  assert.equal(root.agent.name, 'A real metadata title');
  assert.equal(root.agent.mode.selected, 'ultrafast');
  assert.equal(root.agent.mode.served, null);
  assert.equal(childResult.agent.mode.configured, 'fast');
  assert.equal(childResult.agent.mode.selected, null);
  assert.equal(childResult.agent.parentId, 'root-id');
});

test('agent labels use structured task paths and titles without random nicknames or message bodies', async t => {
  const env = await setup(t);
  const cases = [
    ['root', { title: 'Root metadata title' }, { agentNickname: 'Plato' }, 'Root metadata title'],
    ['task', { parent_thread_id: 'root', agent_path: '/root/worker_timeline_ui', agent_nickname: 'Banach' }, {}, 'Worker timeline ui'],
    ['runtime-task', { parent_thread_id: 'root', agent_path: '/root/old_task' }, { agentPath: '/root/explorer_timeline_data', agentNickname: 'McClintock' }, 'Explorer timeline data'],
    ['titled', { parent_thread_id: 'root' }, { name: 'Review parser', agentNickname: 'Plato' }, 'Review parser'],
    ['untitled', { parent_thread_id: 'root', agent_nickname: 'Banach' }, {}, 'Agent untitled'],
  ];
  for (const [id, metadata, runtime, expected] of cases) {
    await writeFile(env.file(`${id}.jsonl`), meta(id, -20000, metadata) + line('response_item', -10000, { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'PRIVATE TITLE' }] }));
    env.runtime.overrides.set(id, runtime);
  }
  await env.monitor.start();
  const result = await env.monitor.getThread({ threadId: 'root' });
  assert.equal(result.thread.title, 'Root metadata title');
  for (const [id, , , expected] of cases) {
    assert.equal(result.agents.find(agent => agent.id === id).name, expected);
    assert.equal((await env.monitor.getAgent({ agentId: id })).agent.name, expected);
  }
  assert.ok(!JSON.stringify(result).includes('PRIVATE TITLE'));
});

test('legacy cumulative token counters use deltas, skip duplicates and do not count modern mirror events', async t => {
  const env = await setup(t);
  const counts = (total, last) => ({ type: 'token_count', info: { total_token_usage: { input_tokens: 10, output_tokens: total, total_tokens: total + 10 }, last_token_usage: { input_tokens: 10, output_tokens: last, total_tokens: last + 10 } } });
  await writeFile(env.file('legacy.jsonl'), meta('legacy', -30000) + input(-20000) + line('event_msg', -10000, counts(100, 100)) + input(-9000) + line('event_msg', -5000, counts(150, 50)) + line('event_msg', -4000, counts(150, 50)));
  await writeFile(env.file('modern.jsonl'), meta('modern', -30000) + input(-5000) + usage('modern-final', 0, 300) + line('event_msg', 0, counts(300, 300)));
  await env.monitor.start();
  const snapshot = await env.monitor.getSnapshot();
  assert.equal(snapshot.totals.outputTokens, 450);
  const history = await env.monitor.getHistory();
  assert.equal(history.days.reduce((n, day) => n + day.requests, 0), 3);
});

test('incremental appends wait for complete lines and never expose user message content', async t => {
  const env = await setup(t);
  const record = usage('appended', 0, 300);
  const cut = record.length >> 1;
  await writeFile(env.file('append.jsonl'), meta('append', -20000) + line('response_item', -3000, { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'PRIVATE PROMPT DO NOT STORE' }] }) + record.slice(0, cut));
  await env.monitor.start();
  assert.equal((await env.monitor.getSnapshot()).totals.outputTokens, 0);
  await appendFile(env.file('append.jsonl'), record.slice(cut));
  await env.monitor.refresh();
  const snapshot = await env.monitor.getSnapshot();
  assert.equal(snapshot.totals.outputTokens, 300);
  assert.equal(snapshot.totals.outputTps, 100);
  assert.ok(!JSON.stringify(snapshot).includes('PRIVATE PROMPT'));
  await env.monitor.refresh();
  assert.equal((await env.monitor.getSnapshot()).totals.outputTokens, 300);
});

test('in-flight estimates need measured samples and stale logs become unknown', async t => {
  const env = await setup(t);
  await writeFile(env.file('sampled.jsonl'), meta('sampled', -30000) + line('turn_context', -21000, { model: 'known-model' }) + input(-20000) + usage('sample', -10000, 500) + input(-5000));
  await writeFile(env.file('unknown.jsonl'), meta('no-sample', -10000) + line('turn_context', -9000, { model: 'other-model' }) + input(-5000));
  await env.monitor.start();
  const sampled = await env.monitor.getAgent({ agentId: 'sampled' });
  const unknown = await env.monitor.getAgent({ agentId: 'no-sample' });
  assert.equal(sampled.agent.rate.measuredTps, 0);
  assert.equal(sampled.agent.rate.estimatedTps, 50);
  assert.equal(unknown.agent.rate.estimatedTps, 0);
  assert.equal(sampled.history.length, 300);
  env.setNow(epoch + 301000);
  await env.monitor.refresh();
  const stale = await env.monitor.getAgent({ agentId: 'sampled' });
  assert.equal(stale.agent.phase, 'unknown');
  assert.equal(stale.agent.rate.estimatedTps, 0);
});

test('global rate history covers every monitored agent once independently of list filters and pagination', async t => {
  const env = await setup(t);
  await writeFile(env.file('root.jsonl'), meta('root', -30000) + input(-3000) + usage('root-done', -1000, 200));
  await writeFile(env.file('child.jsonl'), meta('child', -30000, { parent_thread_id: 'root' })
    + line('turn_context', -21000, { model: 'sample-model' }) + input(-20000) + usage('child-sample', -10000, 500) + input(-5000));
  await writeFile(env.file('grandchild.jsonl'), meta('grandchild', -30000, { parent_thread_id: 'child' }) + input(-2000) + usage('grandchild-done', 0, 100));
  await writeFile(env.file('ready.jsonl'), meta('ready', -30000) + input(-2000) + usage('ready-done', 0, 40));
  await writeFile(env.file('excluded.jsonl'), meta('excluded', -30000) + input(-2000) + usage('excluded-done', 0, 10000));
  env.runtime.overrides.set('ready', { status: { type: 'idle' } });
  env.runtime.overrides.set('excluded', { status: { type: 'active', activeFlags: ['waitingOnUserInput'] } });
  await env.monitor.start();
  const snapshot = await env.monitor.getSnapshot({ limit: 1 });
  assert.equal(snapshot.history.length, 300);
  assert.equal(snapshot.history.at(-1).time, iso(0));
  assert.equal(snapshot.history.at(-1).measuredTps, 70);
  assert.equal(snapshot.history.at(-1).estimatedTps, 50);
  assert.equal(snapshot.history.at(-1).outputTps, 120);
  assert.equal(snapshot.history.at(-2).measuredTps, 170);
  assert.equal(snapshot.history[0].outputTps, 0);
  assert.ok(snapshot.nextCursor);
  const next = await env.monitor.getSnapshot({ limit: 1, cursor: snapshot.nextCursor });
  const ready = await env.monitor.getSnapshot({ scope: 'ready', order: 'priority', limit: 1 });
  assert.deepEqual(next.history, snapshot.history);
  assert.deepEqual(ready.history, snapshot.history);
  assert.equal(ready.threads.length, 1);
  assert.equal(ready.threads[0].id, 'ready');
  const individual = await Promise.all(['root', 'child', 'grandchild', 'ready'].map(agentId => env.monitor.getAgent({ agentId })));
  for (let index = 0; index < snapshot.history.length; index++) {
    for (const key of ['measuredTps', 'estimatedTps', 'outputTps']) {
      assert.equal(snapshot.history[index][key], individual.reduce((sum, agent) => sum + agent.history[index][key], 0));
    }
  }
});

test('global agent counts retain model and tier evidence and count unknowns independently of visible rows', async t => {
  const env = await setup(t);
  await writeFile(path.join(env.codexHome, 'config.toml'), 'service_tier = "priority"\n');
  await writeFile(env.file('root.jsonl'), meta('root', -30000) + input(-2000)
    + line('event_msg', -1500, { type: 'thread_settings_applied', thread_settings: { service_tier: 'ultrafast' } })
    + usage('selected-wins', 0, 100, { service_tier: 'priority' }));
  await writeFile(env.file('child.jsonl'), meta('child', -30000, { parent_thread_id: 'root' })
    + line('turn_context', -3000, { model: 'model-b' }) + input(-2000) + usage('recorded-fast', 0, 100, { service_tier: 'priority' }));
  await writeFile(env.file('ready.jsonl'), meta('ready', -30000) + input(-2000) + usage('recorded-standard', 0, 100, { service_tier: 'default' }));
  await writeFile(env.file('unknown.jsonl'), meta('unknown', -30000));
  await writeFile(env.file('excluded.jsonl'), meta('excluded', -30000));
  env.runtime.overrides.set('root', { model: 'model-a' });
  env.runtime.overrides.set('child', { model: 'next-model' });
  env.runtime.overrides.set('ready', { model: 'model-a', status: { type: 'idle' } });
  env.runtime.overrides.set('excluded', { model: 'excluded-model', status: { type: 'notLoaded' } });
  await env.monitor.start();
  const snapshot = await env.monitor.getSnapshot({ limit: 1 });
  const counts = snapshot.agentCounts;
  assert.equal(counts.total, 4);
  assert.deepEqual(counts.models, [
    { model: 'model-a', count: 2, sources: { turn_context: 0, runtime_config: 2, log_metadata: 0, unknown: 0 } },
    { model: null, count: 1, sources: { turn_context: 0, runtime_config: 0, log_metadata: 0, unknown: 1 } },
    { model: 'model-b', count: 1, sources: { turn_context: 1, runtime_config: 0, log_metadata: 0, unknown: 0 } },
  ]);
  assert.deepEqual(counts.serviceTiers, [
    { tier: null, count: 1, sources: { selected: 0, recorded: 0, unknown: 1 } },
    { tier: 'fast', count: 1, sources: { selected: 0, recorded: 1, unknown: 0 } },
    { tier: 'standard', count: 1, sources: { selected: 0, recorded: 1, unknown: 0 } },
    { tier: 'ultrafast', count: 1, sources: { selected: 1, recorded: 0, unknown: 0 } },
  ]);
  const filtered = await env.monitor.getSnapshot({ scope: 'ready', order: 'priority', limit: 1 });
  assert.equal(filtered.threads.length, 1);
  assert.deepEqual(filtered.agentCounts, counts);
  const next = await env.monitor.getSnapshot({ limit: 1, cursor: snapshot.nextCursor });
  assert.deepEqual(next.agentCounts, counts);
});

test('daily totals survive restarts and deleted logs without replay double counting', async t => {
  const env = await setup(t);
  const source = meta('persisted', -20000) + input(-10000) + usage('durable-response', 0, 400);
  await writeFile(env.file('persisted.jsonl'), source);
  await env.monitor.start();
  await env.monitor.stop();
  const reopened = new Monitor({ codexHome: env.codexHome, stateDir: env.stateDir, runtime: env.runtime, now: () => epoch });
  t.after(() => reopened.stop());
  await reopened.start();
  assert.equal((await reopened.getSnapshot()).totals.outputTokens, 400);
  assert.equal((await reopened.getAgent({ agentId: 'persisted' })).agent.phase, 'tools');
  await reopened.stop();
  await rm(env.file('persisted.jsonl'));
  const withoutLogs = new Monitor({ codexHome: env.codexHome, stateDir: env.stateDir, runtime: env.runtime, now: () => epoch });
  t.after(() => withoutLogs.stop());
  await withoutLogs.start();
  const history = await withoutLogs.getHistory();
  assert.equal(history.days[0].outputTokens, 400);
  assert.equal(history.days[0].requests, 1);
  assert.equal((await withoutLogs.getSnapshot()).totals.threadCount, 0);
  await withoutLogs.stop();
});

test('independent collectors reconcile shared facts through duplicate reads, pause and restart', async t => {
  const env = await setup(t);
  const filePath = env.file('shared.jsonl');
  const replicaPath = path.join(env.codexHome, 'replica.jsonl');
  const source = meta('shared', -7200000) + input(-3601000) + usage('old-shared', -3600000, 40)
    + line('turn_context', -20000, { model: 'shared-model' });
  await writeFile(filePath, source);
  await writeFile(replicaPath, source);
  const replicaRuntime = { close() {}, async list() {
    return [{ id: 'shared', path: replicaPath, status: { type: 'active', activeFlags: [] }, recencyAt: epoch / 1000 }];
  } };
  const second = new Monitor({ codexHome: env.codexHome, stateDir: env.stateDir, runtime: replicaRuntime, now: () => epoch });
  env.monitors.push(second);
  await env.monitor.refresh();
  await second.refresh();
  const firstUsage = input(-3000) + usage('new-shared', 0, 300);
  await appendFile(filePath, firstUsage);
  await appendFile(replicaPath, firstUsage);
  await env.monitor.refresh();
  await second.refresh();
  const compare = async (left, right, expected) => {
    const a = await left.getAgent({ agentId: 'shared' }), b = await right.getAgent({ agentId: 'shared' });
    assert.equal(a.agent.tokens.output, expected);
    assert.deepEqual(a.agent.tokens, b.agent.tokens);
    assert.deepEqual(a.agent.rate, b.agent.rate);
    assert.deepEqual(a.history, b.history);
    assert.ok(a.agent.rate.measuredTps > 0);
    const leftSnapshot = await left.getSnapshot(), rightSnapshot = await right.getSnapshot();
    assert.deepEqual(leftSnapshot.totals, rightSnapshot.totals);
    assert.deepEqual(leftSnapshot.history, rightSnapshot.history);
  };
  await compare(env.monitor, second, 340);
  env.monitor.pause();
  const nextUsage = input(-1000) + usage('replica-only', 0, 60);
  await appendFile(replicaPath, nextUsage);
  await second.refresh();
  // The resumed collector has no access to the replica's extra log records.
  await env.monitor.refresh();
  await compare(env.monitor, second, 400);
  await appendFile(filePath, nextUsage);
  await env.monitor.refresh();
  await compare(env.monitor, second, 400);
  await env.monitor.stop();
  const reopened = new Monitor({ codexHome: env.codexHome, stateDir: env.stateDir, runtime: env.runtime, now: () => epoch });
  env.monitors.push(reopened);
  await reopened.refresh();
  await compare(reopened, second, 400);
  assert.equal((await reopened.getHistory()).days[0].requests, 3);
});

test('collection waits for a separate process to release a short metrics write transaction', async t => {
  const env = await setup(t);
  const filePath = env.file('contended.jsonl');
  await writeFile(filePath, meta('contended', -20000));
  await env.monitor.refresh();
  await appendFile(filePath, input(-1000) + usage('after-contention', 0, 90));
  const script = `
    import { DatabaseSync } from 'node:sqlite';
    const db = new DatabaseSync(process.argv[1]);
    db.exec('BEGIN IMMEDIATE');
    process.send('locked');
    setTimeout(() => { db.exec('COMMIT'); db.close(); process.disconnect(); }, 250);
  `;
  const child = spawn(process.execPath, ['--input-type=module', '--eval', script, path.join(env.stateDir, 'metrics.sqlite')], { stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
  let stderr = '';
  child.stderr.setEncoding('utf8').on('data', chunk => { stderr += chunk; });
  const exited = new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', code => resolve(code));
  });
  t.after(() => { if (child.exitCode === null) child.kill(); });
  await new Promise((resolve, reject) => {
    child.once('message', resolve);
    child.once('error', reject);
    child.once('exit', code => reject(new Error(`Writer exited before locking (${code}): ${stderr}`)));
  });
  await env.monitor.refresh();
  assert.equal(await exited, 0, stderr);
  const snapshot = await env.monitor.getSnapshot();
  assert.equal(snapshot.collection.state, 'ready');
  assert.equal(snapshot.totals.outputTokens, 90);
  assert.equal((await env.monitor.getAgent({ agentId: 'contended' })).agent.tokens.output, 90);
});

test('a completion collected by another instance replaces stale estimates and preserves the next request', async t => {
  const env = await setup(t);
  const filePath = env.file('pending.jsonl'), replicaPath = path.join(env.codexHome, 'pending-replica.jsonl');
  const source = meta('pending', -20000) + line('turn_context', -15000, { model: 'shared-model' })
    + input(-10000) + usage('pending-sample', -5000, 500) + input(-3000);
  await writeFile(filePath, source);
  await writeFile(replicaPath, source);
  let now = epoch;
  const second = new Monitor({ codexHome: env.codexHome, stateDir: env.stateDir, now: () => now,
    runtime: { close() {}, async list() { return [{ id: 'pending', path: replicaPath, status: { type: 'active', activeFlags: [] } }]; } } });
  env.monitors.push(second);
  await env.monitor.refresh();
  await second.refresh();
  assert.equal((await env.monitor.getAgent({ agentId: 'pending' })).agent.rate.estimatedTps, 100);
  await appendFile(replicaPath, usage('completed-elsewhere', 0, 300));
  await second.refresh();
  await env.monitor.refresh();
  const staleParser = await env.monitor.getAgent({ agentId: 'pending' });
  const completedParser = await second.getAgent({ agentId: 'pending' });
  assert.deepEqual(staleParser.agent.rate, completedParser.agent.rate);
  assert.equal(staleParser.agent.rate.measuredTps, 100);
  assert.equal(staleParser.agent.rate.estimatedTps, 0);
  assert.ok(staleParser.history.every(point => point.estimatedTps === 0));
  // A new request may start at exactly the preceding completion's timestamp.
  await appendFile(filePath, input(0));
  await appendFile(replicaPath, input(0));
  now += 1000;
  env.setNow(now);
  await env.monitor.refresh();
  await second.refresh();
  const next = await env.monitor.getAgent({ agentId: 'pending' });
  assert.ok(next.agent.rate.estimatedTps > 0);
  assert.deepEqual(next.agent.rate, (await second.getAgent({ agentId: 'pending' })).agent.rate);
  assert.deepEqual(next.history.filter(point => point.estimatedTps > 0).map(point => point.time), [iso(1000)]);
});

test('compressed files are skipped without warnings or exposed threads while plain rollouts remain readable', async t => {
  const env = await setup(t);
  const compressedOnly = meta('compressed-only', -20000) + input(-10000) + usage('must-not-read', 0, 9000);
  await mkdir(path.join(env.codexHome, 'archived_sessions'));
  await writeFile(path.join(env.codexHome, 'archived_sessions', 'archive.jsonl.zst'), compressedOnly);
  env.runtime.paths.add(path.join(env.codexHome, 'archived_sessions', 'archive.jsonl.zst'));
  await writeFile(env.file('broken.jsonl.zst'), Buffer.from('arbitrary broken compressed bytes'));
  await writeFile(env.file('healthy.jsonl'), meta('healthy-plain', -20000) + input(-10000) + usage('plain-response', 0, 600));
  await env.monitor.start();
  const snapshot = await env.monitor.getSnapshot();
  assert.equal(snapshot.totals.outputTokens, 600);
  assert.equal(snapshot.collection.skippedCompressedFiles, 2);
  assert.deepEqual(snapshot.collection.warnings, []);
  assert.equal(snapshot.totals.threadCount, 1);
  assert.equal(snapshot.threads[0].id, 'healthy-plain');
  assert.equal(snapshot.threads[0].agentCount, 1);
  assert.equal(snapshot.totals.outputTps, 60);
  assert.equal((await env.monitor.getAgent({ agentId: 'compressed-only' })).agent, null);
  await rm(env.file('healthy.jsonl'));
  await env.monitor.refresh();
  assert.equal((await env.monitor.getSnapshot()).totals.threadCount, 0);
  assert.equal((await env.monitor.getHistory()).days[0].outputTokens, 600);
});

test('scroll cursors limit visible rows without changing the totals', async t => {
  const env = await setup(t);
  for (let i = 0; i < 3; i++) await writeFile(env.file(`${i}.jsonl`), meta(`thread-${i}`, -20000) + input(-10000) + usage(`response-${i}`, i, 100));
  await env.monitor.start();
  const first = await env.monitor.getSnapshot({ limit: 1 });
  const second = await env.monitor.getSnapshot({ limit: 1, cursor: first.nextCursor });
  assert.equal(first.threads.length, 1);
  assert.notEqual(first.threads[0].id, second.threads[0].id);
  assert.equal(first.totals.outputTokens, 300);
  assert.deepEqual(first.totals, second.totals);
});

test('runtime Working and Ready alone are monitored, sorted by interaction recency, and retained on source failure', async t => {
  const env = await setup(t);
  for (const id of ['working', 'ready', 'approval', 'input', 'inactive', 'error']) {
    await writeFile(env.file(`${id}.jsonl`), meta(id, -30000) + line('turn_context', -21000, { model: 'known-model' }) + input(-20000) + usage(`${id}-response`, -10000, 100) + input(-5000));
  }
  env.runtime.overrides.set('working', { recencyAt: (epoch - 2000) / 1000 });
  env.runtime.overrides.set('ready', { status: { type: 'idle' }, recencyAt: (epoch - 1000) / 1000 });
  env.runtime.overrides.set('approval', { status: { type: 'active', activeFlags: ['waitingOnApproval'] } });
  env.runtime.overrides.set('input', { status: { type: 'active', activeFlags: ['waitingOnUserInput'] } });
  env.runtime.overrides.set('inactive', { status: { type: 'notLoaded' } });
  env.runtime.overrides.set('error', { status: { type: 'systemError' } });
  await env.monitor.start();
  const first = await env.monitor.getSnapshot();
  assert.deepEqual(first.threads.map(thread => thread.id), ['ready', 'working']);
  assert.equal(first.totals.outputTokens, 200);
  assert.equal(first.totals.workingThreadCount, 1);
  assert.equal(first.totals.readyThreadCount, 1);
  assert.equal((await env.monitor.getAgent({ agentId: 'ready' })).agent.rate.estimatedTps, 0);
  assert.equal((await env.monitor.getAgent({ agentId: 'working' })).agent.rate.estimatedTps, 10);
  assert.deepEqual((await env.monitor.getSnapshot({ scope: 'working' })).threads.map(thread => thread.id), ['working']);
  assert.deepEqual((await env.monitor.getSnapshot({ scope: 'ready' })).threads.map(thread => thread.id), ['ready']);
  env.runtime.overrides.set('working', { recencyAt: epoch / 1000 });
  await env.monitor.refresh();
  assert.deepEqual((await env.monitor.getSnapshot()).threads.map(thread => thread.id), ['working', 'ready']);
  env.runtime.error = Object.assign(new Error('Runtime unavailable'), { code: 'CONNECTION_CLOSED' });
  env.setNow(epoch + 1000);
  await env.monitor.refresh();
  const failed = await env.monitor.getSnapshot();
  assert.equal(failed.collection.state, 'error');
  assert.equal(failed.collection.lastSuccessAt, first.collection.lastSuccessAt);
  assert.equal(failed.totals.outputTokens, 200);
  assert.equal(failed.totals.threadCount, 2);
  env.runtime.error = null;
  env.runtime.overrides.set('working', { status: { type: 'idle' }, recencyAt: epoch / 1000 });
  await env.monitor.refresh();
  const recovered = await env.monitor.getSnapshot();
  assert.equal(recovered.collection.lastSuccessAt, iso(1000));
  assert.equal(recovered.totals.workingThreadCount, 0);
  assert.equal(recovered.totals.estimatedTps, 0);
});

test('loaded grandchildren stay in their runtime root when the intermediate parent is unloaded', async t => {
  const env = await setup(t);
  await writeFile(env.file('root.jsonl'), meta('root', -30000) + input(-10000) + usage('root-response', 0, 100));
  await writeFile(env.file('middle.jsonl'), meta('middle', -25000, { parent_thread_id: 'root' }));
  await writeFile(env.file('grandchild.jsonl'), meta('grandchild', -20000, { parent_thread_id: 'middle' }) + input(-5000) + usage('grandchild-response', 0, 50));
  env.runtime.overrides.set('root', { sessionId: 'root', status: { type: 'idle' } });
  env.runtime.overrides.set('middle', { sessionId: 'root', status: { type: 'notLoaded' } });
  env.runtime.overrides.set('grandchild', { sessionId: 'root', parentThreadId: 'middle' });
  await env.monitor.start();
  const snapshot = await env.monitor.getSnapshot();
  assert.equal(snapshot.totals.threadCount, 1);
  assert.equal(snapshot.threads[0].id, 'root');
  assert.equal(snapshot.threads[0].agentCount, 2);
  assert.equal(snapshot.threads[0].tokens.output, 150);
  const grandchild = (await env.monitor.getAgent({ agentId: 'grandchild' })).agent;
  assert.equal(grandchild.parentId, 'middle');
  assert.equal(grandchild.rootThreadId, 'root');
});

test('request model evidence stays separate from next-turn configuration and estimates require matching-model samples', async t => {
  const env = await setup(t);
  const filePath = env.file('model-evidence.jsonl');
  await writeFile(filePath, meta('model-evidence', -30000) + line('turn_context', -21000, { model: 'model-a', effort: 'high' }) + input(-20000) + line('event_msg', -19000, { type: 'thread_settings_applied', thread_settings: { model: 'model-b', reasoning_effort: 'low' } }) + usage('sample-a', -10000, 500) + input(-5000));
  await writeFile(env.file('config-only.jsonl'), meta('config-only', -10000) + input(-5000));
  env.runtime.overrides.set('model-evidence', { model: 'model-b', reasoningEffort: 'low' });
  env.runtime.overrides.set('config-only', { model: 'model-a' });
  await env.monitor.start();
  const running = (await env.monitor.getAgent({ agentId: 'model-evidence' })).agent;
  assert.equal(running.model, 'model-a');
  assert.equal(running.modelSource, 'turn_context');
  assert.equal(running.configuredModel, 'model-b');
  assert.equal(running.reasoningEffort, 'high');
  assert.equal(running.configuredReasoningEffort, 'low');
  assert.equal(running.rate.estimatedTps, 50);
  const configOnly = (await env.monitor.getAgent({ agentId: 'config-only' })).agent;
  assert.equal(configOnly.modelSource, 'runtime_config');
  assert.equal(configOnly.rate.estimatedTps, 0);
  const snapshot = await env.monitor.getSnapshot();
  assert.equal(snapshot.models.find(model => model.model === 'model-a').estimatedTps, 50);
  assert.equal(snapshot.models.find(model => model.model === 'model-b')?.estimatedTps ?? 0, 0);
  env.runtime.overrides.set('model-evidence', { model: 'model-b', reasoningEffort: 'low', status: { type: 'idle' } });
  await env.monitor.refresh();
  const ready = (await env.monitor.getAgent({ agentId: 'model-evidence' })).agent;
  assert.equal(ready.model, 'model-b');
  assert.equal(ready.modelSource, 'runtime_config');
  assert.equal(ready.reasoningEffort, 'low');
  assert.equal(ready.rate.estimatedTps, 0);
  env.runtime.overrides.set('model-evidence', { model: 'model-b', reasoningEffort: 'low' });
  await appendFile(filePath, line('turn_context', 1000, { model: 'model-b', effort: 'low' }) + input(1000));
  env.setNow(epoch + 4000);
  await env.monitor.refresh();
  const nextTurn = (await env.monitor.getAgent({ agentId: 'model-evidence' })).agent;
  assert.equal(nextTurn.model, 'model-b');
  assert.equal(nextTurn.modelSource, 'turn_context');
  assert.equal(nextTurn.rate.estimatedTps, 0);
});

test('a loaded thread can wait for input then resume without collecting while excluded or replaying usage', async t => {
  const env = await setup(t);
  const filePath = env.file('waiting.jsonl');
  await writeFile(filePath, meta('waiting', -20000) + input(-10000) + usage('before-input', 0, 100));
  await env.monitor.start();
  env.runtime.overrides.set('waiting', { status: { type: 'active', activeFlags: ['waitingOnUserInput'] } });
  await appendFile(filePath, input(500) + usage('while-excluded', 1000, 50));
  env.setNow(epoch + 1000);
  await env.monitor.refresh();
  assert.equal((await env.monitor.getSnapshot()).totals.outputTokens, 100);
  assert.equal((await env.monitor.getSnapshot()).totals.threadCount, 0);
  assert.equal((await env.monitor.getThread({ threadId: 'waiting' })).thread, null);
  assert.equal((await env.monitor.getAgent({ agentId: 'waiting' })).agent, null);
  env.runtime.overrides.set('waiting', { status: { type: 'active', activeFlags: [] } });
  await env.monitor.refresh();
  assert.equal((await env.monitor.getAgent({ agentId: 'waiting' })).agent.tokens.output, 150);
  await env.monitor.refresh();
  assert.equal((await env.monitor.getHistory()).days[0].requests, 2);
  assert.equal((await env.monitor.getSnapshot()).totals.outputTokens, 150);
});

test('queries retain the last complete view while refreshing and a late source disconnect cannot publish partial data', async t => {
  const env = await setup(t);
  await writeFile(env.file('previous.jsonl'), meta('previous', -20000) + input(-10000) + usage('previous-response', 0, 100));
  await env.monitor.start();
  const previous = await env.monitor.getSnapshot();
  env.runtime.overrides.set('previous', { status: { type: 'notLoaded' } });
  await writeFile(env.file('replacement.jsonl'), meta('replacement', -20000) + input(0) + usage('replacement-response', 1000, 200));
  env.setNow(epoch + 1000);
  let releaseBefore, releaseAfter, reachedBefore, reachedAfter;
  const before = new Promise(resolve => { releaseBefore = resolve; });
  const after = new Promise(resolve => { releaseAfter = resolve; });
  const beforeReached = new Promise(resolve => { reachedBefore = resolve; });
  const afterReached = new Promise(resolve => { reachedAfter = resolve; });
  const readFile = env.monitor.readFile.bind(env.monitor);
  env.monitor.readFile = async file => {
    reachedBefore();
    await before;
    const changed = await readFile(file);
    reachedAfter();
    await after;
    return changed;
  };
  const refreshing = env.monitor.refresh();
  try {
    await beforeReached;
    const duringDiscovery = await env.monitor.getSnapshot();
    assert.equal(duringDiscovery.collection.state, 'ready');
    assert.deepEqual(duringDiscovery.threads.map(thread => thread.id), ['previous']);
    assert.ok(duringDiscovery.totals.outputTps > 0);
    assert.equal(duringDiscovery.history.at(-1).measuredTps, 0);
    assert.equal((await env.monitor.getThread({ threadId: 'previous' })).thread.id, 'previous');
    assert.equal((await env.monitor.getAgent({ agentId: 'replacement' })).agent, null);
    releaseBefore();
    await afterReached;
    const duringRead = await env.monitor.getSnapshot();
    assert.equal(duringRead.totals.outputTokens, 100);
    assert.deepEqual(duringRead.history, duringDiscovery.history);
    assert.equal((await env.monitor.getAgent({ agentId: 'previous' })).agent.tokens.output, 100);
    env.runtime.error = Object.assign(new Error('Connection lost after metadata read'), { code: 'CONNECTION_CLOSED' });
    releaseAfter();
    await refreshing;
    const failed = await env.monitor.getSnapshot();
    assert.equal(failed.collection.state, 'error');
    assert.equal(failed.collection.lastSuccessAt, previous.collection.lastSuccessAt);
    assert.equal(failed.totals.outputTokens, 100);
    assert.deepEqual(failed.history, duringDiscovery.history);
    assert.deepEqual(failed.threads.map(thread => thread.id), ['previous']);
  } finally {
    releaseBefore();
    releaseAfter();
    await refreshing;
    env.monitor.readFile = readFile;
    env.runtime.error = null;
  }
  await env.monitor.refresh();
  const recovered = await env.monitor.getSnapshot();
  assert.equal(recovered.collection.lastSuccessAt, iso(1000));
  assert.deepEqual(recovered.threads.map(thread => thread.id), ['replacement']);
  assert.equal(recovered.totals.outputTokens, 300);
  assert.equal(recovered.history.at(-1).measuredTps, 200);
  assert.equal((await env.monitor.getAgent({ agentId: 'replacement' })).agent.tokens.output, 200);
  await appendFile(env.file('replacement.jsonl'), line('event_msg', 1500, { type: 'thread_settings_applied', thread_settings: { service_tier: 'priority' } }) + input(1500));
  env.setNow(epoch + 2500);
  let releaseMode, reachedMode;
  const modeGate = new Promise(resolve => { releaseMode = resolve; });
  const modeReached = new Promise(resolve => { reachedMode = resolve; });
  env.monitor.readFile = async file => {
    const changed = await readFile(file);
    reachedMode();
    await modeGate;
    return changed;
  };
  const modeRefresh = env.monitor.refresh();
  try {
    await modeReached;
    const duringModeRead = await env.monitor.getAgent({ agentId: 'replacement' });
    assert.equal(duringModeRead.agent.mode.selected, null);
    assert.equal(duringModeRead.agent.phase, 'tools');
  } finally {
    releaseMode();
    await modeRefresh;
    env.monitor.readFile = readFile;
  }
  const afterModeRead = await env.monitor.getAgent({ agentId: 'replacement' });
  assert.equal(afterModeRead.agent.mode.selected, 'fast');
  assert.equal(afterModeRead.agent.phase, 'generating');
});

test('invalid usage records are skipped while later complete records continue to be collected', async t => {
  const env = await setup(t);
  const bad = [null, 123, 'invalid', [], {}].map((value, i) => line('token_usage_record', -8000 + i, { response_id: `bad-${i}`, usage: value })).join('');
  await writeFile(env.file('invalid-usage.jsonl'), meta('valid-after-invalid', -20000) + input(-10000) + bad + usage('good-after-bad', 0, 250));
  await env.monitor.start();
  const snapshot = await env.monitor.getSnapshot();
  assert.equal(snapshot.totals.outputTokens, 250);
  assert.equal(snapshot.totals.outputTps, 25);
  assert.ok(snapshot.collection.warnings.some(warning => warning.includes('Malformed')));
  assert.equal((await env.monitor.getHistory()).days[0].requests, 1);
  await appendFile(env.file('invalid-usage.jsonl'), input(1000) + usage('later-append', 2000, 100));
  env.setNow(epoch + 2000);
  await env.monitor.refresh();
  assert.equal((await env.monitor.getSnapshot()).totals.outputTokens, 350);
});

test('recorded request modes expire on new requests and turns without clearing selected session modes', async t => {
  const env = await setup(t);
  await writeFile(env.file('mode-scope.jsonl'), meta('mode-scope', -20000) + input(-10000) + usage('old-tier', -5000, 100, { service_tier: 'ultrafast' }));
  await env.monitor.start();
  assert.equal((await env.monitor.getAgent({ agentId: 'mode-scope' })).agent.mode.recorded, 'ultrafast');
  await appendFile(env.file('mode-scope.jsonl'), line('turn_context', -4000, { model: 'known-model' }));
  await env.monitor.refresh();
  const newTurn = (await env.monitor.getAgent({ agentId: 'mode-scope' })).agent.mode;
  assert.equal(newTurn.selected, null);
  assert.equal(newTurn.recorded, null);
  await appendFile(env.file('mode-scope.jsonl'), line('event_msg', -3500, { type: 'thread_settings_applied', thread_settings: { service_tier: 'priority' } }) + usage('another-tier', -3000, 100, { service_tier: 'ultrafast' }) + input(-1000));
  await env.monitor.refresh();
  const newRequest = (await env.monitor.getAgent({ agentId: 'mode-scope' })).agent.mode;
  assert.equal(newRequest.recorded, null);
  assert.equal(newRequest.selected, 'fast');
  assert.equal(newRequest.served, null);
});

test('plain reader consumer failures recover the same responses without terminating the process', async t => {
  const folder = await mkdtemp(path.join(tmpdir(), 'agent-monitor-recovery-'));
  const codexHome = path.join(folder, 'codex');
  const sessions = path.join(codexHome, 'sessions');
  const stateDir = path.join(folder, 'state');
  await mkdir(sessions, { recursive: true });
  t.after(() => rm(folder, { recursive: true, force: true }));
  const source = meta('healthy', -20000) + input(-10000) + usage('healthy-first', 0, 250);
  await writeFile(path.join(sessions, '00-consumer-failure.jsonl'), meta('consumer-failure', -20000) + input(-10000) + usage('consumer-response', 0, 40));
  const validPath = path.join(sessions, '99-healthy.jsonl');
  await writeFile(validPath, source);
  const script = `
    import { appendFile } from 'node:fs/promises';
    import { DatabaseSync } from 'node:sqlite';
    import path from 'node:path';
    import { Monitor } from ${JSON.stringify(new URL('../src/monitor/index.mjs', import.meta.url).href)};
    let currentTime = ${epoch + 2000};
    const runtime = { close() {}, async list() { return [
      { id: 'consumer-failure', path: path.join(process.argv[1], 'sessions', '00-consumer-failure.jsonl'), status: { type: 'active', activeFlags: [] }, recencyAt: ${epoch / 1000} },
      { id: 'healthy', path: process.argv[3], status: { type: 'active', activeFlags: [] }, recencyAt: ${epoch / 1000} },
    ]; } };
    const monitor = new Monitor({ codexHome: process.argv[1], stateDir: process.argv[2], runtime, now: () => currentTime });
    const before = await monitor.getSnapshot();
    await monitor.start();
    monitor.store.db.exec('PRAGMA busy_timeout=0');
    const writer = new DatabaseSync(path.join(process.argv[2], 'metrics.sqlite'));
    writer.exec('BEGIN IMMEDIATE');
    try {
      await appendFile(process.argv[3], ${JSON.stringify(input(100) + usage('healthy-locked', 1000, 25))});
      await monitor.refresh();
      await new Promise(resolve => setImmediate(resolve));
      const failed = await monitor.getSnapshot();
      writer.exec('ROLLBACK');
      writer.close();
      await monitor.refresh();
      const first = await monitor.getSnapshot();
      const secondWriter = new DatabaseSync(path.join(process.argv[2], 'metrics.sqlite'));
      secondWriter.exec('BEGIN IMMEDIATE');
      currentTime += 1000;
      await monitor.refresh();
      const stale = await monitor.getSnapshot();
      secondWriter.exec('ROLLBACK');
      secondWriter.close();
      await appendFile(process.argv[3], ${JSON.stringify(input(1000) + usage('healthy-second', 2000, 50))});
      await monitor.refresh();
      await new Promise(resolve => setImmediate(resolve));
      const second = await monitor.getSnapshot();
      console.log(JSON.stringify({ first: first.totals.outputTokens, second: second.totals.outputTokens, before: before.collection.lastSuccessAt, failed: failed.collection.lastSuccessAt, failedState: failed.collection.state, staleSuccess: stale.collection.lastSuccessAt, staleSampledAt: stale.sampledAt, recovered: second.collection.lastSuccessAt }));
    } finally { await monitor.stop(); }
    await new Promise(resolve => setTimeout(resolve, 25));
  `;
  const child = spawn(process.execPath, ['--input-type=module', '--eval', script, codexHome, stateDir, validPath], { stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '', stderr = '';
  child.stdout.setEncoding('utf8').on('data', chunk => { stdout += chunk; });
  child.stderr.setEncoding('utf8').on('data', chunk => { stderr += chunk; });
  const result = await new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (code, signal) => resolve({ code, signal }));
  });
  assert.equal(result.code, 0, stderr);
  assert.equal(result.signal, null);
  const report = JSON.parse(stdout.trim());
  assert.equal(report.first, 315);
  assert.equal(report.second - report.first, 50);
  assert.equal(report.before, null);
  assert.equal(report.failed, iso(2000));
  assert.equal(report.failedState, 'error');
  assert.equal(report.staleSuccess, iso(2000));
  assert.equal(report.staleSampledAt, iso(3000));
  assert.equal(report.recovered, iso(3000));
});

test('panel activity leases lazily initialize, pause reads and resume appended records without replay', async t => {
  const env = await setup(t);
  const filePath = env.file('lease.jsonl');
  const database = path.join(env.stateDir, 'metrics.sqlite');
  await writeFile(filePath, meta('lease-thread', -20000) + input(-10000) + usage('lease-first', 0, 100));
  assert.equal((await env.monitor.getSnapshot()).collection.state, 'paused');
  assert.deepEqual((await env.monitor.getHistory()).days, []);
  await assert.rejects(stat(database), { code: 'ENOENT' });
  const until = async predicate => {
    const deadline = Date.now() + 3000;
    while (Date.now() < deadline) {
      const snapshot = await env.monitor.getSnapshot();
      if (predicate(snapshot)) return snapshot;
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    assert.fail('Expected collector lifecycle transition did not occur');
  };
  assert.equal(env.monitor.activate(), undefined);
  assert.equal((await env.monitor.getSnapshot()).collection.state, 'scanning');
  await until(snapshot => snapshot.collection.state === 'ready');
  assert.equal((await env.monitor.getSnapshot()).totals.outputTokens, 100);
  env.setNow(epoch + 4000);
  env.monitor.activate();
  await appendFile(filePath, input(3000) + usage('lease-visible', 4000, 20));
  env.setNow(epoch + 6000);
  await until(snapshot => snapshot.totals.outputTokens === 120);
  env.setNow(epoch + 10000);
  await appendFile(filePath, input(9000) + usage('lease-paused', 10000, 50));
  const paused = await until(snapshot => snapshot.collection.state === 'paused');
  assert.equal(paused.totals.outputTokens, 120);
  assert.equal(paused.collection.lastSuccessAt, iso(6000));
  await new Promise(resolve => setTimeout(resolve, 1100));
  assert.equal((await env.monitor.getSnapshot()).totals.outputTokens, 120);
  env.monitor.activate();
  const resumed = await until(snapshot => snapshot.collection.lastSuccessAt === iso(10000));
  assert.equal(resumed.totals.outputTokens, 170);
  assert.equal(resumed.threads.length, 1);
  assert.equal((await env.monitor.getHistory()).days[0].requests, 3);
  await env.monitor.stop();
  const unopened = new Monitor({ codexHome: env.codexHome, stateDir: path.join(env.folder, 'never-opened') });
  await unopened.stop();
  await assert.rejects(stat(path.join(env.folder, 'never-opened')), { code: 'ENOENT' });
});

test('temporary background collection outlives the UI lease and disabling restores lease-based pause', async t => {
  const env = await setup(t);
  const filePath = env.file('background.jsonl');
  await writeFile(filePath, meta('background', -20000) + input(-10000) + usage('first', 0, 100));
  const until = async predicate => {
    const deadline = Date.now() + 3000;
    while (Date.now() < deadline) {
      const snapshot = await env.monitor.getSnapshot();
      if (predicate(snapshot)) return snapshot;
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    assert.fail('Expected background collection transition did not occur');
  };
  assert.equal((await env.monitor.getSnapshot()).collection.backgroundEnabled, false);
  assert.deepEqual(env.monitor.setBackgroundCollection({ enabled: true }), { backgroundEnabled: true, scope: 'process' });
  await until(snapshot => snapshot.totals.outputTokens === 100);
  env.setNow(epoch + 6000);
  await appendFile(filePath, input(5000) + usage('beyond-lease', 6000, 10));
  const background = await until(snapshot => snapshot.totals.outputTokens === 110);
  assert.equal(background.collection.backgroundEnabled, true);
  assert.equal(background.collection.state, 'ready');
  assert.deepEqual(env.monitor.setBackgroundCollection({ enabled: false }), { backgroundEnabled: false, scope: 'process' });
  env.setNow(epoch + 10000);
  await appendFile(filePath, input(9000) + usage('remaining-lease', 10000, 20));
  await until(snapshot => snapshot.totals.outputTokens === 130);
  env.setNow(epoch + 12000);
  await appendFile(filePath, input(11000) + usage('after-pause', 12000, 30));
  const paused = await until(snapshot => snapshot.collection.state === 'paused');
  assert.equal(paused.collection.backgroundEnabled, false);
  assert.equal(paused.totals.outputTokens, 130);
  env.monitor.setBackgroundCollection({ enabled: true });
  await until(snapshot => snapshot.totals.outputTokens === 160);
  await env.monitor.stop();
  const restarted = new Monitor({ codexHome: env.codexHome, stateDir: env.stateDir, runtime: env.runtime, now: () => epoch + 12000 });
  env.monitors.push(restarted);
  const initial = await restarted.getSnapshot();
  assert.equal(initial.collection.backgroundEnabled, false);
  assert.equal(initial.collection.state, 'paused');
});

test('an expired lease interrupts a large incomplete record and resumes its buffered bytes without losing usage', async t => {
  let clockTick = 0;
  const env = await setup(t, { clock: () => epoch + 200 * clockTick++ });
  const largeUsage = line('token_usage_record', 0, { response_id: 'large-response', usage: { output_tokens: 175 }, padding: 'x'.repeat(2 * 1024 * 1024) });
  await writeFile(env.file('large.jsonl'), meta('large-thread', -20000) + input(-10000) + largeUsage);
  const until = async predicate => {
    const deadline = Date.now() + 3000;
    while (Date.now() < deadline) {
      const snapshot = await env.monitor.getSnapshot();
      if (predicate(snapshot)) return snapshot;
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    assert.fail('Expected large-reader lease transition did not occur');
  };
  env.monitor.activate();
  const paused = await until(snapshot => snapshot.collection.state === 'paused');
  assert.equal(paused.collection.lastSuccessAt, null);
  assert.equal(paused.totals.outputTokens, 0);
  assert.deepEqual(paused.threads, []);
  let completed;
  for (let attempt = 0; attempt < 8; attempt++) {
    env.monitor.activate();
    completed = await until(snapshot => ['ready', 'paused'].includes(snapshot.collection.state));
    if (completed.collection.state === 'ready') break;
  }
  assert.equal(completed.collection.state, 'ready');
  assert.equal(completed.totals.outputTokens, 175);
  assert.equal((await env.monitor.getHistory()).days[0].requests, 1);
});

test('lazy initialization failures remain observable and a later activation can retry', async t => {
  const env = await setup(t);
  await writeFile(env.stateDir, 'not a directory');
  await writeFile(env.file('init-retry.jsonl'), meta('init-retry', -20000) + input(-10000) + usage('init-retry-response', 0, 100));
  const until = async state => {
    const deadline = Date.now() + 3000;
    while (Date.now() < deadline) {
      const snapshot = await env.monitor.getSnapshot();
      if (snapshot.collection.state === state) return snapshot;
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    assert.fail(`Expected collection state ${state}`);
  };
  env.monitor.activate();
  const failed = await until('error');
  assert.equal(failed.collection.lastSuccessAt, null);
  assert.equal(failed.totals.outputTokens, 0);
  await rm(env.stateDir);
  env.monitor.activate();
  const recovered = await until('ready');
  assert.equal(recovered.totals.outputTokens, 100);
});
