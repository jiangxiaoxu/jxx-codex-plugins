import test from 'node:test';
import assert from 'node:assert/strict';
import {
  SnapshotHealth, ThreadList, createVisiblePoller, mergeStableItems, modePresentation,
} from '../ui/state.mjs';

const item = (id, recencyAt, extra = {}) => ({ id, recencyAt, status: 'completed', attention: null, ...extra });
const timestamp = seconds => new Date(Date.UTC(2026, 9, 30, 0, 0, seconds)).toISOString();

test('activity ordering prioritizes attention while preserving existing positions as output updates', () => {
  const list = new ThreadList('priority');
  list.merge([
    item('recent-idle', timestamp(50)),
    item('running', timestamp(30), { status: 'running' }),
    item('approval', timestamp(10), { attention: 'approval', status: 'running' }),
    item('unread', timestamp(40), { attention: 'unread' }),
  ]);
  assert.deepEqual(list.items.map(row => row.id), ['approval', 'unread', 'running', 'recent-idle']);
  assert.deepEqual(list.sections().priority.map(row => row.id), ['approval', 'unread', 'running']);

  list.merge([
    item('running', timestamp(59), { status: 'running', rate: { outputTps: 140 } }),
    item('approval', timestamp(10), { attention: null, status: 'completed' }),
    item('new-thread', timestamp(58), { status: 'running' }),
  ]);
  assert.deepEqual(list.items.map(row => row.id), ['approval', 'unread', 'running', 'recent-idle', 'new-thread']);
  assert.equal(list.items.find(row => row.id === 'running').rate.outputTps, 140);
  assert.deepEqual(list.sections().priority.map(row => row.id), ['approval', 'unread', 'running', 'new-thread']);
});

test('changing to recent order starts a fresh recency-ordered view', () => {
  const list = new ThreadList('priority');
  const rows = [item('older-approval', timestamp(1), { attention: 'approval' }), item('recent', timestamp(50))];
  list.merge(rows);
  list.reset('recent');
  list.merge(rows);
  assert.deepEqual(list.items.map(row => row.id), ['recent', 'older-approval']);
  assert.equal(list.sections().priority.length, 0);
});

test('overlapping scroll pages update known agents without duplicate rows or losing selection data', () => {
  const first = [item('main', timestamp(1), { role: 'main' }), item('child-1', timestamp(2)), item('child-2', timestamp(3))];
  const second = [item('child-2', timestamp(4), { phase: 'completed' }), item('child-3', timestamp(5))];
  const merged = mergeStableItems(first, second);
  assert.deepEqual(merged.map(row => row.id), ['main', 'child-1', 'child-2', 'child-3']);
  assert.equal(merged.find(row => row.id === 'child-2').phase, 'completed');
  assert.equal(first[2].phase, undefined);
});

test('a complete filtered refresh removes finished rows but retains the selected agent', () => {
  const previous = [item('still-running', timestamp(1)), item('finished', timestamp(2)), item('selected', timestamp(3))];
  const current = [item('still-running', timestamp(4), { phase: 'generating' })];
  const merged = mergeStableItems(previous, current, { complete: true, preserveIds: ['selected'] });
  assert.deepEqual(merged.map(row => row.id), ['still-running', 'selected']);
  assert.equal(merged[0].phase, 'generating');
  assert.equal(mergeStableItems(previous, current).length, 3);
});

test('default configuration never becomes an asserted execution mode', () => {
  assert.deepEqual(modePresentation({ configured: 'ultrafast' }), { label: '未知', evidence: '默认配置 Ultrafast' });
  assert.deepEqual(modePresentation({ selected: 'priority', configured: 'ultrafast' }), { label: 'Fast', evidence: '已选择' });
  assert.deepEqual(modePresentation({ recorded: 'ultrafast', served: null }), { label: 'Ultrafast', evidence: '最近完成请求记录' });
  assert.deepEqual(modePresentation({}), { label: '未知', evidence: '缺少模式记录' });
});

test('visible polling pauses when hidden, resumes immediately, and never overlaps an unfinished request', async () => {
  const timers = new Map();
  let nextTimer = 0;
  let calls = 0;
  let finish;
  const poller = createVisiblePoller(() => {
    calls++;
    return new Promise(resolve => { finish = resolve; });
  }, {
    setTimer: callback => { timers.set(++nextTimer, callback); return nextTimer; },
    clearTimer: id => timers.delete(id),
  });

  poller.setVisible(true);
  assert.equal(calls, 1);
  poller.setVisible(false);
  poller.setVisible(true);
  assert.equal(calls, 1);
  finish();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(timers.size, 1);

  poller.setVisible(false);
  assert.equal(timers.size, 0);
  poller.setVisible(true);
  assert.equal(calls, 2);
  poller.stop();
  finish();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(timers.size, 0);
  poller.setVisible(true);
  assert.equal(calls, 2);
});

const snapshot = (sampledAt, lastSuccessAt, outputTps, collectionState = 'ready') => ({
  schemaVersion: 1, sampledAt, collection: { state: collectionState, lastSuccessAt, warnings: [] },
  totals: { measuredTps: outputTps, estimatedTps: 0, outputTps }, models: [], threads: [],
});

test('initial scanning and incomplete counts never become a trusted zero sample', () => {
  const health = new SnapshotHealth({ now: () => 1000 });
  assert.equal(health.accept(snapshot(timestamp(1), null, 0, 'scanning')), false);
  assert.equal(health.snapshot, null);
  assert.equal(health.inspect().lastSuccessAt, null);
  assert.equal(health.inspect().kind, 'pending');
  assert.equal(health.accept({ ...snapshot(timestamp(1), timestamp(1), 0), totals: null }), false);
  assert.equal(health.snapshot, null);
  assert.equal(health.accept(snapshot(timestamp(1), null, 0, 'paused')), false);
  assert.equal(health.inspect().collectionState, 'paused');
  assert.equal(health.snapshot, null);
});

test('advancing query timestamps do not hide a stalled collector or depend on the client clock', () => {
  let localNow = 900_000;
  const health = new SnapshotHealth({ now: () => localNow });
  const good = snapshot(timestamp(1), timestamp(0), 120);
  assert.equal(health.accept(good), true);
  assert.equal(health.inspect().kind, 'live');
  localNow += 2000;
  assert.equal(health.inspect().ageMs, 3000);
  assert.equal(health.accept(snapshot(timestamp(8), timestamp(0), 0)), false);
  assert.equal(health.snapshot.totals.outputTps, 120);
  assert.equal(health.inspect().kind, 'stale');
  assert.equal(health.inspect().lastSuccessAt, timestamp(0));
  assert.equal(health.inspect().reportedLastSuccessAt, timestamp(0));
  assert.equal(health.inspect().querySampledAt, timestamp(8));
  assert.equal(health.accept(snapshot(timestamp(9), timestamp(9), 80)), true);
  assert.equal(health.inspect().kind, 'live');
  localNow += 5001;
  assert.equal(health.inspect().kind, 'stale');
  assert.equal(health.snapshot.totals.outputTps, 80);
});

test('polling preserves the last successful values through failure and collection errors and recovers on a new sample', async () => {
  let scheduled;
  let calls = 0;
  const health = new SnapshotHealth({ now: () => 1000 });
  const poller = createVisiblePoller(async () => {
    calls++;
    if (calls === 2) throw new Error('Closed');
    const next = calls === 1 ? snapshot(timestamp(1), timestamp(1), 130)
      : calls === 3 ? snapshot(timestamp(3), timestamp(1), 0, 'error')
        : calls === 4 ? snapshot(timestamp(4), timestamp(1), 0, 'paused')
          : snapshot(timestamp(5), timestamp(5), 0);
    health.accept(next);
  }, {
    setTimer: callback => { scheduled = callback; return 1; },
    clearTimer: () => { scheduled = null; },
    onError: error => health.fail(error),
  });
  poller.setVisible(true);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(health.snapshot.totals.outputTps, 130);
  assert.equal(health.inspect().kind, 'live');
  assert.equal(typeof scheduled, 'function');
  await scheduled();
  assert.equal(calls, 2);
  assert.equal(health.snapshot.totals.outputTps, 130);
  assert.equal(health.inspect().kind, 'stale');
  await scheduled();
  assert.equal(calls, 3);
  assert.equal(health.snapshot.totals.outputTps, 130);
  assert.equal(health.inspect().lastSuccessAt, timestamp(1));
  await scheduled();
  assert.equal(calls, 4);
  assert.equal(health.snapshot.totals.outputTps, 130);
  assert.equal(health.inspect().kind, 'stale');
  assert.equal(health.inspect().collectionState, 'paused');
  await scheduled();
  assert.equal(calls, 5);
  assert.equal(health.snapshot.totals.outputTps, 0);
  assert.equal(health.inspect().kind, 'live');
  assert.equal(health.inspect().lastSuccessAt, timestamp(5));
  poller.stop();
});
