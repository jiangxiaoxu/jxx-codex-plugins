import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, appendFile, rm, stat } from 'node:fs/promises';
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
  const monitor = new Monitor({ codexHome, stateDir, now: clock ?? (() => now) });
  t.after(async () => { await monitor.stop(); await rm(folder, { recursive: true, force: true }); });
  return { folder, codexHome, stateDir, monitor, setNow(value) { now = value; }, file(name) { return path.join(codexHome, 'sessions', name); } };
}

test('modern main and nested agents are counted once, copied context is excluded, and modes stay per agent', async t => {
  const env = await setup(t);
  await writeFile(path.join(env.codexHome, 'config.toml'), 'service_tier = "priority"\n');
  await writeFile(env.file('root.jsonl'), meta('root-id', -20000) + line('turn_context', -11000, { model: 'model-a', effort: 'xhigh' }) + input(-10000) + line('event_msg', -9000, { type: 'thread_settings_applied', thread_settings: { service_tier: 'ultrafast' } }) + usage('root-response', 0, 1000));
  const copied = line('token_usage_record', -4000, { response_id: 'inherited-fresh-timestamp', usage: { output_tokens: 8000 } }, 1);
  const child = meta('child-id', -5000, { parent_thread_id: 'root-id', thread_source: 'subagent', subagent_history_start_ordinal: 5 }) + copied + line('turn_context', -3500, { model: 'model-b' }, 5) + line('event_msg', -3000, { type: 'task_started' }, 6) + line('token_usage_record', -1000, { response_id: 'child-response', usage: { input_tokens: 50, output_tokens: 200 } }, 7) + usage('child-response', -500, 200);
  await writeFile(env.file('child.jsonl'), child);
  await writeFile(path.join(env.codexHome, 'session_index.jsonl'), JSON.stringify({ id: 'root-id', thread_name: 'A real metadata title', updated_at: iso(0) }) + '\n');
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

test('daily totals survive restarts and deleted logs without replay double counting', async t => {
  const env = await setup(t);
  const source = meta('persisted', -20000) + input(-10000) + usage('durable-response', 0, 400);
  await writeFile(env.file('persisted.jsonl'), source);
  await env.monitor.start();
  await env.monitor.stop();
  const reopened = new Monitor({ codexHome: env.codexHome, stateDir: env.stateDir, now: () => epoch });
  t.after(() => reopened.stop());
  await reopened.start();
  assert.equal((await reopened.getSnapshot()).totals.outputTokens, 400);
  assert.equal((await reopened.getAgent({ agentId: 'persisted' })).agent.phase, 'tools');
  await reopened.stop();
  await rm(env.file('persisted.jsonl'));
  const withoutLogs = new Monitor({ codexHome: env.codexHome, stateDir: env.stateDir, now: () => epoch });
  t.after(() => withoutLogs.stop());
  await withoutLogs.start();
  const history = await withoutLogs.getHistory();
  assert.equal(history.days[0].outputTokens, 400);
  assert.equal(history.days[0].requests, 1);
  assert.equal((await withoutLogs.getSnapshot()).totals.threadCount, 0);
  await withoutLogs.stop();
});

test('compressed files are skipped without warnings or exposed threads while plain rollouts remain readable', async t => {
  const env = await setup(t);
  const compressedOnly = meta('compressed-only', -20000) + input(-10000) + usage('must-not-read', 0, 9000);
  await mkdir(path.join(env.codexHome, 'archived_sessions'));
  await writeFile(path.join(env.codexHome, 'archived_sessions', 'archive.jsonl.zst'), compressedOnly);
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
  await assert.rejects(env.monitor.getAgent({ agentId: 'compressed-only' }), /Agent not found/);
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
    const monitor = new Monitor({ codexHome: process.argv[1], stateDir: process.argv[2], now: () => currentTime });
    const before = await monitor.getSnapshot();
    await monitor.start();
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
      console.log(JSON.stringify({ first: first.totals.outputTokens, second: second.totals.outputTokens, before: before.collection.lastSuccessAt, failed: failed.collection.lastSuccessAt, failedState: failed.collection.state, staleSuccess: stale.collection.lastSuccessAt, staleSampledAt: stale.sampledAt, recovered: second.collection.lastSuccessAt, warnings: second.collection.warnings }));
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
  assert.ok(report.warnings.some(warning => warning.includes('99-healthy.jsonl')));
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
  assert.equal(paused.threads[0].id, 'large-thread');
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
