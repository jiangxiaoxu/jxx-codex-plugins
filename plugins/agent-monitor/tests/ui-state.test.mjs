import test from 'node:test';
import assert from 'node:assert/strict';
import {
  SnapshotHealth, ThreadList, compareAgents, createVisiblePoller, mergeStableItems, modePresentation, modelPresentation, phasePresentation,
} from '../ui/state.mjs';

const item = (id, recencyAt, extra = {}) => ({ id, recencyAt, status: 'ready', attention: null, ...extra });
const timestamp = seconds => new Date(Date.UTC(2026, 9, 30, 0, 0, seconds)).toISOString();

test('working priority follows current runtime status and newest interaction within each group', () => {
  const list = new ThreadList('priority');
  list.merge([
    item('recent-ready', timestamp(50)),
    item('working', timestamp(30), { status: 'working' }),
    item('older-working', timestamp(10), { status: 'working' }),
  ]);
  assert.deepEqual(list.items.map(row => row.id), ['working', 'older-working', 'recent-ready']);
  assert.deepEqual(list.sections().priority.map(row => row.id), ['working', 'older-working']);

  list.merge([
    item('working', timestamp(59), { status: 'working', rate: { outputTps: 140 } }),
    item('older-working', timestamp(10), { status: 'ready' }),
    item('new-thread', timestamp(58), { status: 'working' }),
  ]);
  assert.deepEqual(list.items.map(row => row.id), ['working', 'new-thread', 'recent-ready', 'older-working']);
  assert.equal(list.items.find(row => row.id === 'working').rate.outputTps, 140);
  assert.deepEqual(list.sections().priority.map(row => row.id), ['working', 'new-thread']);
  assert.equal(phasePresentation('ready'), 'Ready');
});

test('recent ordering moves updated and new threads to the front without treating output rate as recency', () => {
  const list = new ThreadList();
  list.merge([item('older', timestamp(1), { status: 'working' }), item('recent', timestamp(50))]);
  assert.deepEqual(list.items.map(row => row.id), ['recent', 'older']);
  list.merge([item('older', timestamp(59), { status: 'working' }), item('new', timestamp(58))]);
  assert.deepEqual(list.items.map(row => row.id), ['older', 'new', 'recent']);
  list.merge([item('recent', timestamp(50), { rate: { outputTps: 999 } })]);
  assert.deepEqual(list.items.map(row => row.id), ['older', 'new', 'recent']);
  assert.equal(list.sections().priority.length, 0);
});

test('overlapping scroll pages update and reorder agents by interaction while pinning the main agent', () => {
  const first = [item('main', timestamp(1), { role: 'main' }), item('child-1', timestamp(2)), item('child-2', timestamp(3))];
  const second = [item('child-2', timestamp(4), { phase: 'ready' }), item('child-3', timestamp(5))];
  const merged = mergeStableItems(first, second).sort(compareAgents);
  assert.deepEqual(merged.map(row => row.id), ['main', 'child-3', 'child-2', 'child-1']);
  assert.equal(merged.find(row => row.id === 'child-2').phase, 'ready');
  assert.equal(first[2].phase, undefined);
});

test('a complete refresh removes threads that leave the monitored runtime set', () => {
  const previous = [item('still-running', timestamp(1)), item('finished', timestamp(2)), item('selected', timestamp(3))];
  const current = [item('still-running', timestamp(4), { phase: 'generating' })];
  const merged = mergeStableItems(previous, current, { complete: true });
  assert.deepEqual(merged.map(row => row.id), ['still-running']);
  assert.equal(merged[0].phase, 'generating');
  assert.equal(mergeStableItems(previous, current).length, 3);
});

test('a refreshed prefix retains only its selected row while keeping the main agent first', () => {
  const list = new ThreadList();
  list.merge([item('opened', timestamp(1)), item('outside', timestamp(2))]);
  for (let update = 0; update < 4; update++) {
    const prefix = Array.from({ length: 10 }, (_, index) => item(`prefix-${update}-${index}`, timestamp(50 - index)));
    list.merge(prefix, { complete: true, preserveIds: ['opened'] });
    assert.equal(list.items.length, 11);
    assert.equal(list.items.at(-1).id, 'opened');
    assert.equal(list.items.some(row => row.id === 'outside'), false);
  }
  list.merge([item('opened', timestamp(59), { status: 'working' })]);
  assert.equal(list.items[0].id, 'opened');
  assert.equal(list.items.length, 11);
  list.merge([item('latest', timestamp(60))], { complete: true });
  assert.deepEqual(list.items.map(row => row.id), ['latest']);

  let agents = [item('main', timestamp(0), { role: 'main' }), item('selected-child', timestamp(1)), item('old-child', timestamp(2))];
  for (let update = 0; update < 4; update++) {
    const prefix = [item('main', timestamp(0), { role: 'main' }), ...Array.from({ length: 9 }, (_, index) => item(`child-${update}-${index}`, timestamp(50 - index)))];
    agents = mergeStableItems(agents, prefix, { complete: true, preserveIds: ['selected-child'] }).sort(compareAgents);
    assert.equal(agents.length, 11);
    assert.equal(agents[0].id, 'main');
    assert.equal(agents.at(-1).id, 'selected-child');
    assert.equal(agents.some(agent => agent.id === 'old-child'), false);
  }
});

test('default configuration never becomes an asserted execution mode', () => {
  assert.deepEqual(modePresentation({ configured: 'ultrafast' }), { label: '未知', evidence: '默认配置 Ultrafast' });
  assert.deepEqual(modePresentation({ selected: 'priority', configured: 'ultrafast' }), { label: 'Fast', evidence: '已选择' });
  assert.deepEqual(modePresentation({ recorded: 'ultrafast', served: null }), { label: 'Ultrafast', evidence: '最近完成请求记录' });
  assert.deepEqual(modePresentation({}), { label: '未知', evidence: '缺少模式记录' });
});

test('model configuration is distinguished from request evidence and a different future configuration', () => {
  assert.deepEqual(modelPresentation({ model: 'model-b', configuredModel: 'model-b', modelSource: 'runtime_config' }), {
    label: 'model-b (配置)', effortLabel: '推理强度未知', configuration: null,
  });
  assert.deepEqual(modelPresentation({
    model: 'model-a', modelSource: 'turn_context', reasoningEffort: 'high',
    configuredModel: 'model-b', configuredReasoningEffort: 'ultra',
  }), { label: 'model-a', effortLabel: 'high', configuration: '配置: model-b / ultra' });
  assert.deepEqual(modelPresentation({ model: 'model-a', modelSource: 'log_metadata' }), {
    label: 'model-a (日志)', effortLabel: '推理强度未知', configuration: null,
  });
  assert.deepEqual(modelPresentation({ model: 'model-a', modelSource: 'turn_context', reasoningEffort: 'high', reasoningEffortSource: 'runtime_config' }), {
    label: 'model-a', effortLabel: 'high (配置)', configuration: null,
  });
});

test('visible polling pauses when hidden, resumes immediately, and never overlaps an unfinished request', async () => {
  const timers = new Map();
  let nextTimer = 0;
  let calls = 0;
  let now = 0;
  let delay;
  let finish;
  const poller = createVisiblePoller(() => {
    calls++;
    return new Promise(resolve => { finish = resolve; });
  }, {
    now: () => now,
    setTimer: (callback, milliseconds) => { delay = milliseconds; timers.set(++nextTimer, callback); return nextTimer; },
    clearTimer: id => timers.delete(id),
  });

  poller.setVisible(true);
  assert.equal(calls, 1);
  poller.setVisible(false);
  poller.setVisible(true);
  assert.equal(calls, 1);
  now = 300;
  finish();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(timers.size, 1);
  assert.equal(delay, 200);

  poller.setVisible(false);
  assert.equal(timers.size, 0);
  poller.setVisible(true);
  assert.equal(calls, 2);
  now = 900;
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
