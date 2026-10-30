import { RateTimeline } from './timeline.mjs';

export const rateChartHtml = ({ id, label }) => `<div class="rate-timeline" id="${id}">
  <div class="curve-controls" aria-label="时间线控制">
    <span class="curve-mode">实时 · 5 分钟</span>
    <div><button type="button" data-curve="previous" aria-label="向前移动时间段">←</button><button type="button" data-curve="next" aria-label="向后移动时间段">→</button><button type="button" data-curve="in" aria-label="放大时间线">+</button><button type="button" data-curve="out" aria-label="缩小时间线">−</button><button type="button" data-curve="live">恢复实时</button></div>
  </div>
  <div class="agent-curve" tabindex="0" role="group" aria-label="${label}" aria-describedby="${id}-help ${id}-detail" title="拖拽框选; 悬浮查看; 方向键逐秒查看, +/− 缩放."><div class="curve-svg"></div><div class="curve-tooltip" id="${id}-detail" hidden></div></div>
  <div class="curve-foot"><span title="单位 tok/s; 实线为已测请求速率, 虚线为生成中估算.">已测 ━ / 估算 ┄</span><span class="curve-range"></span></div>
  <div class="sr-only" id="${id}-help">拖拽框选放大; 悬浮或轻点查看. 方向键逐秒查看, +/− 缩放. 仅最近 5 分钟速率采样, 无完整历史状态.</div>
</div>`;

const clock = time => new Date(time).toLocaleTimeString('zh-CN', { hour12: false });
const decimal = value => value.toLocaleString('en-US', { minimumFractionDigits: 1, maximumFractionDigits: 1 });

export class RateChart {
  constructor() {
    this.timeline = new RateTimeline();
    this.host = null;
    this.drag = null;
    this.pinned = false;
  }

  update(host, agentId, history = []) {
    if (agentId !== this.timeline.agentId) { this.pinned = false; this.drag = null; }
    this.timeline.update(agentId, history);
    if (!host) return;
    if (host !== this.host) {
      this.host = host;
      this.drag = null;
      this.bind();
    }
    this.draw();
  }

  get plot() { return this.host.querySelector('.agent-curve'); }

  timeAt(event) {
    const rect = this.plot.getBoundingClientRect();
    const width = Math.max(220, this.plot.clientWidth);
    const fraction = Math.max(0, Math.min(1, ((event.clientX - rect.left) / Math.max(1, rect.width) * width - 38) / (width - 46)));
    const [start, end] = this.timeline.view;
    return start + fraction * (end - start);
  }

  bind() {
    const plot = this.plot;
    this.host.addEventListener('click', event => {
      const action = event.target.closest('[data-curve]')?.dataset.curve;
      if (!action) return;
      this.drag = null;
      if (action === 'live') { this.timeline.live(); this.pinned = false; }
      else if (action === 'in' || action === 'out') this.timeline.zoom(action === 'in' ? .5 : 2);
      else this.timeline.pan(action === 'previous' ? -1 : 1);
      this.draw();
    });
    plot.addEventListener('pointerdown', event => {
      if (!this.timeline.view || event.button !== 0) return;
      const time = this.timeAt(event);
      this.drag = { id: event.pointerId, start: time, end: time, x: event.clientX };
      plot.setPointerCapture(event.pointerId);
      plot.focus({ preventScroll: true });
      this.timeline.cursor = time;
      this.draw();
    });
    plot.addEventListener('pointermove', event => {
      if (!this.timeline.view) return;
      if (this.drag) this.drag.end = this.timeAt(event);
      if (!this.pinned || this.drag) this.timeline.cursor = this.timeAt(event);
      this.draw();
    });
    plot.addEventListener('pointerup', event => {
      if (!this.drag || this.drag.id !== event.pointerId) return;
      const drag = this.drag;
      this.drag = null;
      if (Math.abs(event.clientX - drag.x) >= 8) {
        this.timeline.focus(drag.start, drag.end);
        this.timeline.cursor = null;
        this.pinned = false;
      } else this.pinned = true;
      plot.releasePointerCapture(event.pointerId);
      this.draw();
    });
    plot.addEventListener('pointercancel', () => { this.drag = null; this.draw(); });
    plot.addEventListener('pointerleave', () => {
      if (!this.drag && !this.pinned) { this.timeline.cursor = null; this.draw(); }
    });
    plot.addEventListener('keydown', event => {
      if (!['ArrowLeft', 'ArrowRight', '+', '=', '-', 'Escape', 'Home', 'End'].includes(event.key)) return;
      event.preventDefault();
      this.drag = null;
      if (event.key === 'Escape') { this.timeline.live(); this.pinned = false; }
      else if (['+', '=', '-'].includes(event.key)) this.timeline.zoom(event.key === '-' ? 2 : .5);
      else if (event.key === 'Home' || event.key === 'End') {
        this.timeline.cursor = this.timeline.view?.[event.key === 'Home' ? 0 : 1] ?? null;
        this.pinned = true;
      } else if (event.shiftKey) this.timeline.pan(event.key === 'ArrowLeft' ? -1 : 1);
      else { this.timeline.step(event.key === 'ArrowLeft' ? -1 : 1); this.pinned = true; }
      this.draw();
    });
  }

  draw() {
    const timeline = this.timeline, plot = this.plot;
    const tooltip = this.host.querySelector('.curve-tooltip');
    const view = timeline.view;
    this.host.querySelector('.curve-mode').textContent = timeline.frozen ? '回看' : '实时 · 5 分钟';
    for (const button of this.host.querySelectorAll('[data-curve]')) {
      const action = button.dataset.curve;
      button.disabled = !view || (action === 'live' && !timeline.frozen)
        || (action === 'previous' && view[0] <= timeline.bounds[0])
        || (action === 'next' && view[1] >= timeline.bounds[1])
        || (action === 'in' && view[1] - view[0] <= 5000)
        || (action === 'out' && view[1] - view[0] >= timeline.bounds[1] - timeline.bounds[0]);
    }
    if (!view) {
      plot.querySelector('.curve-svg').innerHTML = '<div class="curve-empty">尚无速率历史</div>';
      tooltip.hidden = true;
      this.host.querySelector('.curve-range').textContent = '';
      return;
    }
    const width = Math.max(220, plot.clientWidth), height = Math.max(110, plot.clientHeight || 140);
    const left = 38, right = width - 8, top = 12, bottom = height - 25;
    const [start, end] = view;
    const visible = timeline.data.filter(point => point.time >= start && point.time <= end);
    const max = Math.max(1, ...visible.flatMap(point => [point.measuredTps, point.estimatedTps])) * 1.1;
    const x = time => left + (time - start) / Math.max(1, end - start) * (right - left);
    const y = value => bottom - value / max * (bottom - top);
    const path = key => visible.map((point, index) => `${!index || point.time - visible[index - 1].time > 1500 ? 'M' : 'L'}${x(point.time).toFixed(2)},${y(point[key]).toFixed(2)}`).join(' ');
    let svg = `<svg viewBox="0 0 ${width} ${height}" aria-hidden="true">`;
    for (const value of [0, max / 2, max]) svg += `<line x1="${left}" x2="${right}" y1="${y(value)}" y2="${y(value)}" stroke="var(--monitor-line)"/><text x="${left - 5}" y="${y(value) + 4}" text-anchor="end" fill="var(--monitor-muted)" font-size="11">${Math.round(value)}</text>`;
    svg += `<path d="${path('measuredTps')}" fill="none" stroke="var(--monitor-blue)" stroke-width="1.6"/><path d="${path('estimatedTps')}" fill="none" stroke="var(--monitor-purple)" stroke-width="1.6" stroke-dasharray="3 3"/>`;
    const selected = timeline.cursor === null ? null : timeline.nearest(timeline.cursor);
    if (selected) {
      const pos = x(selected.time);
      svg += `<line x1="${pos}" x2="${pos}" y1="${top}" y2="${bottom}" stroke="var(--monitor-muted)" stroke-dasharray="2 2"/>`;
      for (const [key, color] of [['measuredTps', 'blue'], ['estimatedTps', 'purple']]) svg += `<circle cx="${pos}" cy="${y(selected[key])}" r="3" fill="var(--monitor-${color})"/>`;
    }
    if (this.drag) svg += `<rect x="${x(Math.min(this.drag.start, this.drag.end))}" y="${top}" width="${Math.abs(x(this.drag.end) - x(this.drag.start))}" height="${bottom - top}" fill="var(--monitor-blue)" opacity=".2"/>`;
    svg += `<text x="${left}" y="${height - 4}" fill="var(--monitor-muted)" font-size="11">${clock(start)}</text><text x="${right}" y="${height - 4}" text-anchor="end" fill="var(--monitor-muted)" font-size="11">${clock(end)}</text></svg>`;
    plot.querySelector('.curve-svg').innerHTML = svg;
    tooltip.hidden = timeline.cursor === null || Boolean(this.drag);
    if (!tooltip.hidden) {
      tooltip.innerHTML = selected
        ? `<strong>${new Date(selected.time).toLocaleString('zh-CN', { hour12: false })}</strong><dl><dt>已测输出</dt><dd>${decimal(selected.measuredTps)} tok/s</dd><dt>生成中估算</dt><dd>${decimal(selected.estimatedTps)} tok/s</dd><dt>合计</dt><dd>${decimal(selected.measuredTps + selected.estimatedTps)} tok/s</dd></dl><span>1 秒速率采样; 无历史状态记录</span>`
        : '<span>该时刻无速率采样</span>';
      const position = x(timeline.cursor);
      tooltip.style.left = `${Math.max(0, Math.min(width - Math.min(220, width), position > width / 2 ? position - 228 : position + 8))}px`;
    }
    this.host.querySelector('.curve-range').textContent = `${Math.round((end - start) / 1000)} 秒`;
  }
}
