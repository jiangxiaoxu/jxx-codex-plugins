import test from 'node:test';
import assert from 'node:assert/strict';
import { RateTimeline } from '../ui/timeline.mjs';

const history = (offset = 0) => Array.from({ length: 300 }, (_, index) => ({
  time: new Date((offset + index) * 1000).toISOString(), measuredTps: index, estimatedTps: 2,
}));

test('the timeline always follows fresh samples and expires a pinned sample outside the live window', () => {
  const timeline = new RateTimeline();
  timeline.update('agent-a', history());
  timeline.cursor = 110_000;
  timeline.update('agent-a', history(300));
  assert.deepEqual(timeline.view, [300_000, 599_000]);
  assert.equal(timeline.cursor, null);
  timeline.update('agent-b', history(600));
  assert.deepEqual(timeline.view, [600_000, 899_000]);
});

test('keyboard inspection follows available samples without changing the live window', () => {
  const timeline = new RateTimeline();
  timeline.update('agent-a', history());
  timeline.step(-1);
  assert.equal(timeline.cursor, 299_000);
  timeline.step(-1);
  assert.equal(timeline.cursor, 298_000);
  assert.deepEqual(timeline.view, [0, 299_000]);
});

test('missing or invalid samples are never presented as a rate at an unobserved time', () => {
  const timeline = new RateTimeline();
  timeline.update('agent-a', [history()[0], history()[10], { time: 'invalid', measuredTps: 5, estimatedTps: 0 }]);
  assert.equal(timeline.nearest(5000), null);
  assert.equal(timeline.nearest(10_000).measuredTps, 10);
  timeline.update('agent-b', []);
  timeline.step(1);
  assert.equal(timeline.view, null);
  assert.equal(timeline.cursor, null);
});

test('model and tier groups update with their matching live sample', () => {
  const timeline = new RateTimeline();
  timeline.update('thread', history(), [
    { model: 'model-a', serviceTier: 'priority', samples: [[110, 2, 70], [111, 1, 35]] },
    { model: 'model-a', serviceTier: 'default', samples: [[110, 1, 20]] },
    { model: null, serviceTier: null, samples: [[110, 1, 10]] },
  ]);
  const sample = timeline.nearest(110_000);
  assert.deepEqual(sample.groups.map(group => [group.model, group.serviceTier, group.agentCount, group.measuredTps]), [
    ['model-a', 'priority', 2, 70], ['model-a', 'default', 1, 20], [null, null, 1, 10],
  ]);
  assert.deepEqual(timeline.nearest(109_000).groups, []);
  timeline.update('thread', history(300), []);
  assert.equal(timeline.nearest(110_000), null);
  assert.deepEqual(timeline.nearest(410_000).groups, []);
  timeline.update('other-thread', history(), []);
  assert.deepEqual(timeline.nearest(110_000).groups, []);
});

test('longer time windows inspect their aggregated buckets with matching group evidence', () => {
  const timeline = new RateTimeline();
  timeline.update('global', [0, 12_000, 24_000].map(time => ({ time: new Date(time).toISOString(), measuredTps: 20, estimatedTps: 0 })), [
    { model: 'model-a', serviceTier: 'priority', samples: [[1, 2, 20]] },
  ], 12_000);
  assert.equal(timeline.nearest(17_000).time, 12_000);
  assert.equal(timeline.nearest(17_000).groups[0].agentCount, 2);
  timeline.cursor = 12_000;
  timeline.step(1);
  assert.equal(timeline.cursor, 24_000);
});
