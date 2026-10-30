export class RateTimeline {
  constructor() { this.reset(); }

  reset() {
    this.agentId = null;
    this.points = [];
    this.frozen = null;
    this.range = null;
    this.cursor = null;
  }

  update(agentId, history) {
    if (agentId !== this.agentId) { this.reset(); this.agentId = agentId; }
    this.points = history.map(point => ({ ...point, time: Date.parse(point.time) }))
      .filter(point => Number.isFinite(point.time) && ['measuredTps', 'estimatedTps'].every(key => Number.isFinite(point[key]) && point[key] >= 0))
      .sort((a, b) => a.time - b.time);
  }

  get data() { return this.frozen ?? this.points; }
  get bounds() { return this.data.length ? [this.data[0].time, this.data.at(-1).time] : null; }
  get view() { return this.range ?? this.bounds; }

  live() { this.frozen = null; this.range = null; this.cursor = null; }

  focus(start, end) {
    const bounds = this.bounds;
    if (!bounds || bounds[0] === bounds[1]) return;
    if (!this.frozen) this.frozen = this.points.map(point => ({ ...point }));
    const span = Math.min(bounds[1] - bounds[0], Math.max(5000, Math.abs(end - start)));
    const first = Math.max(bounds[0], Math.min(Math.min(start, end), bounds[1] - span));
    this.range = [first, first + span];
    if (this.cursor !== null) this.cursor = Math.max(first, Math.min(first + span, this.cursor));
  }

  zoom(factor) {
    if (!this.view) return;
    const [start, end] = this.view;
    const center = this.cursor ?? (start + end) / 2;
    const span = (end - start) * factor;
    this.focus(center - span / 2, center + span / 2);
  }

  pan(direction) {
    if (!this.view) return;
    const [start, end] = this.view, delta = (end - start) * .5 * direction;
    this.focus(start + delta, end + delta);
  }

  nearest(time) {
    const view = this.view;
    if (!view) return null;
    let nearest = null;
    for (const point of this.data) {
      if (point.time < view[0] || point.time > view[1]) continue;
      if (!nearest || Math.abs(point.time - time) < Math.abs(nearest.time - time)) nearest = point;
    }
    return nearest && Math.abs(nearest.time - time) <= 1500 ? nearest : null;
  }

  step(direction) {
    if (!this.view) return;
    const [start, end] = this.view;
    const points = this.data.filter(point => point.time >= start && point.time <= end);
    if (!points.length) return;
    const index = this.cursor === null ? (direction < 0 ? points.length : -1)
      : points.findIndex(point => point.time === this.nearest(this.cursor)?.time);
    this.cursor = points[Math.max(0, Math.min(points.length - 1, index + direction))].time;
  }
}
