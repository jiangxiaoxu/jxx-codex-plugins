export class RateTimeline {
  constructor() { this.reset(); }

  reset() {
    this.agentId = null;
    this.points = [];
    this.sampleMs = 1000;
    this.cursor = null;
  }

  update(agentId, history, groups, sampleMs = 1000) {
    if (agentId !== this.agentId) { this.reset(); this.agentId = agentId; }
    this.sampleMs = sampleMs;
    this.points = history.map((point, index) => {
      const sample = { ...point, time: Date.parse(point.time) };
      if (Array.isArray(groups)) {
        let resolved;
        Object.defineProperty(sample, 'groups', { enumerable: true, get() {
          return resolved ??= groups.flatMap(series => {
            const values = (series.samples ?? []).filter(([slot, count, rate]) => slot === index
              && Number.isInteger(count) && count > 0 && Number.isFinite(rate) && rate > 0);
            if (!values.length) return [];
            return [{ model: series.model, serviceTier: series.serviceTier,
              agentCount: values.reduce((total, value) => total + value[1], 0),
              measuredTps: values.reduce((total, value) => total + value[2], 0) }];
          }).sort((a, b) => b.measuredTps - a.measuredTps);
        } });
      }
      return sample;
    })
      .filter(point => Number.isFinite(point.time) && ['measuredTps', 'estimatedTps'].every(key => Number.isFinite(point[key]) && point[key] >= 0))
      .sort((a, b) => a.time - b.time);
    const bounds = this.bounds;
    if (!bounds || this.cursor < bounds[0] || this.cursor > bounds[1]) this.cursor = null;
  }

  get data() { return this.points; }
  get bounds() { return this.data.length ? [this.data[0].time, this.data.at(-1).time] : null; }
  get view() { return this.bounds; }

  nearest(time) {
    const view = this.view;
    if (!view) return null;
    let nearest = null;
    for (const point of this.data) {
      if (point.time < view[0] || point.time > view[1]) continue;
      if (!nearest || Math.abs(point.time - time) < Math.abs(nearest.time - time)) nearest = point;
    }
    return nearest && Math.abs(nearest.time - time) <= this.sampleMs * 1.5 ? nearest : null;
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
