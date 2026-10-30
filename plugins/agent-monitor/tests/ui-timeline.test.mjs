import test from 'node:test';
import assert from 'node:assert/strict';
import { RateTimeline } from '../ui/timeline.mjs';

const history = (offset = 0) => Array.from({ length: 300 }, (_, index) => ({
  time: new Date((offset + index) * 1000).toISOString(), measuredTps: index, estimatedTps: 2,
}));

test('a focused time range and its rate samples survive live refresh and reset to latest data', () => {
  const timeline = new RateTimeline();
  timeline.update('agent-a', history());
  timeline.focus(100_000, 120_000);
  assert.deepEqual(timeline.view, [100_000, 120_000]);
  assert.equal(timeline.nearest(110_100).measuredTps, 110);
  timeline.update('agent-a', history(300));
  assert.deepEqual(timeline.view, [100_000, 120_000]);
  assert.equal(timeline.nearest(110_100).measuredTps, 110);
  timeline.live();
  assert.deepEqual(timeline.view, [300_000, 599_000]);
  timeline.update('agent-b', history(600));
  assert.equal(timeline.frozen, null);
  assert.deepEqual(timeline.view, [600_000, 899_000]);
});

test('zoom and pan stay within retained sample bounds and allow keyboard point inspection', () => {
  const timeline = new RateTimeline();
  timeline.update('agent-a', history());
  timeline.cursor = 100_000;
  timeline.zoom(.5);
  assert.deepEqual(timeline.view, [25_250, 174_750]);
  timeline.pan(-1);
  assert.deepEqual(timeline.view, [0, 149_500]);
  timeline.focus(298_000, 297_000);
  assert.deepEqual(timeline.view, [294_000, 299_000]);
  timeline.cursor = null;
  timeline.step(-1);
  assert.equal(timeline.cursor, 299_000);
  timeline.step(-1);
  assert.equal(timeline.cursor, 298_000);
  timeline.zoom(100);
  assert.deepEqual(timeline.view, [0, 299_000]);
});

test('missing or invalid samples are never presented as a rate at an unobserved time', () => {
  const timeline = new RateTimeline();
  timeline.update('agent-a', [history()[0], history()[10], { time: 'invalid', measuredTps: 5, estimatedTps: 0 }]);
  assert.equal(timeline.nearest(5000), null);
  assert.equal(timeline.nearest(10_000).measuredTps, 10);
  timeline.update('agent-b', []);
  timeline.zoom(.5);
  timeline.step(1);
  assert.equal(timeline.view, null);
  assert.equal(timeline.cursor, null);
});
