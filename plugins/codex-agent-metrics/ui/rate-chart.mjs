import { RateTimeline } from './timeline.mjs';

export const rateChartHtml = ({ id, label }) => `<div class="rate-timeline" id="${id}">
  <div class="curve-controls" aria-label="时间线控制">
    <label>最近 <select class="curve-window" aria-label="时间线范围"><option value="5">5 min</option><option value="10">10 min</option><option value="30">30 min</option><option value="60">60 min</option></select><span class="curve-loading" role="status" hidden></span></label>
    <span class="curve-help" id="${id}-help">悬浮查看 · 点击固定</span>
  </div>
  <div class="agent-curve" tabindex="0" role="group" aria-label="${label}" aria-describedby="${id}-help ${id}-keyboard ${id}-detail"><div class="curve-svg"></div><div class="curve-tooltip" id="${id}-detail" hidden></div></div>
  <div class="curve-foot"><span>tok/s</span><span class="curve-range"></span></div>
  <div class="sr-only" id="${id}-keyboard">可轻点固定详情. 键盘方向键逐点查看, Escape 关闭详情.</div>
</div>`;

const clock = time => new Date(time).toLocaleTimeString('zh-CN', { hour12: false });
const decimal = value => value.toLocaleString('en-US', { minimumFractionDigits: 1, maximumFractionDigits: 1 });
const escapeHtml = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
const tierLabels = { fast: 'Fast', priority: 'Fast', ultrafast: 'Ultrafast', standard: 'Standard', default: 'Standard' };
const tierOrder = { Standard: 0, Fast: 1, Ultrafast: 2 };

function groupHtml(groups) {
  if (!Array.isArray(groups)) return '';
  if (!groups.length) return '<div class="curve-contributors-empty">此刻无输出贡献</div>';
  const models = new Map();
  for (const item of groups) {
    const model = item.model || '未知模型';
    if (!models.has(model)) models.set(model, []);
    models.get(model).push(item);
  }
  return `<div class="curve-contributors" aria-label="模型与档位速率构成">${[...models].map(([model, tiers]) => `<div class="curve-model">
    <strong class="contributor-label">${escapeHtml(model)}</strong>
    <div class="curve-tiers">${tiers.sort((a, b) => (tierOrder[tierLabels[a.serviceTier]] ?? 3) - (tierOrder[tierLabels[b.serviceTier]] ?? 3)).map(item => `<span class="curve-tier" title="${escapeHtml(tierLabels[item.serviceTier] || '')}${tierLabels[item.serviceTier] ? ' / ' : ''}${item.agentCount} 个代理 / ${decimal(item.measuredTps)} tok/s"><span>${tierLabels[item.serviceTier] || ''} <b>×${item.agentCount}</b></span><b class="contributor-rate">${decimal(item.measuredTps)}</b></span>`).join('')}</div>
  </div>`).join('')}</div>`;
}

function sameTooltipSample(previous, current) {
  if (previous === current) return true;
  if (!previous || !current || previous.time !== current.time || previous.measuredTps !== current.measuredTps) return false;
  const before = previous.groups, after = current.groups;
  return before === after || Array.isArray(before) && Array.isArray(after) && before.length === after.length
    && before.every((item, index) => ['model', 'serviceTier', 'agentCount', 'measuredTps'].every(key => item[key] === after[index][key]));
}

export class RateChart {
  constructor() {
    this.timeline = new RateTimeline();
    this.host = null;
    this.press = null;
    this.windowMinutes = 5;
    this.pendingWindowMinutes = null;
    this.windowRequest = 0;
    this.onWindowChange = null;
    this.pinned = false;
    this.frame = null;
    this.pendingPointer = null;
    this.geometry = null;
    this.tooltipSample = undefined;
    this.tooltipHeight = 0;
    this.events = null;
  }

  update(host, agentId, history = [], groups, sampleMs = 1000, windowMinutes = 5) {
    if (agentId !== this.timeline.agentId) {
      this.pinned = false; this.press = null;
      this.pendingWindowMinutes = null; this.windowRequest++;
    }
    this.windowMinutes = windowMinutes;
    if (sampleMs !== this.timeline.sampleMs) this.tooltipSample = undefined;
    this.timeline.update(agentId, history, groups, sampleMs);
    if (this.timeline.cursor === null) this.pinned = false;
    if (!host) { this.detach(); return; }
    if (host !== this.host) {
      this.detach();
      this.host = host;
      this.press = null;
      this.bind();
    }
    this.draw();
  }

  get plot() { return this.host.querySelector('.agent-curve'); }

  timeAt(event) {
    const rect = this.plot.getBoundingClientRect();
    return this.timeAtX(event.clientX, rect);
  }

  timeAtX(clientX, rect) {
    const width = this.geometry?.width ?? Math.max(220, this.plot.clientWidth);
    const fraction = Math.max(0, Math.min(1, ((clientX - rect.left) / Math.max(1, rect.width) * width - 38) / (width - 46)));
    const [start, end] = this.timeline.view;
    return start + fraction * (end - start);
  }

  bind() {
    const plot = this.plot;
    this.events = new AbortController();
    const on = (target, name, handler) => target.addEventListener(name, handler, { signal: this.events.signal });
    on(this.host, 'change', async event => {
      if (!event.target.matches('.curve-window')) return;
      const minutes = Number(event.target.value);
      if (![5, 10, 30, 60].includes(minutes) || minutes === this.windowMinutes || this.pendingWindowMinutes !== null) return;
      const request = ++this.windowRequest;
      this.pendingWindowMinutes = minutes;
      this.pinned = false;
      this.timeline.cursor = null;
      this.tooltipSample = undefined;
      this.drawWindowControl();
      this.drawOverlay();
      try { await this.onWindowChange?.(minutes); }
      finally {
        if (request === this.windowRequest) {
          this.pendingWindowMinutes = null;
          this.drawWindowControl();
        }
      }
    });
    on(plot, 'pointerdown', event => {
      if (event.target.closest('.curve-tooltip')) return;
      if (!this.timeline.view || event.button !== 0) return;
      const time = this.timeAt(event);
      this.press = { id: event.pointerId, x: event.clientX };
      plot.setPointerCapture(event.pointerId);
      plot.focus({ preventScroll: true });
      this.timeline.cursor = time;
      this.drawOverlay();
    });
    on(plot, 'pointermove', event => {
      if (event.target.closest('.curve-tooltip') || !this.timeline.view || (this.pinned && !this.press)) return;
      this.pendingPointer = event.clientX;
      this.scheduleOverlay();
    });
    on(plot, 'pointerup', event => {
      if (!this.press || this.press.id !== event.pointerId) return;
      const press = this.press;
      this.cancelFrame();
      this.press = null;
      this.timeline.cursor = this.timeAt(event);
      this.pinned = Math.abs(event.clientX - press.x) < 8;
      plot.releasePointerCapture(event.pointerId);
      this.drawOverlay();
    });
    on(plot, 'pointercancel', () => { this.cancelFrame(); this.press = null; this.drawOverlay(); });
    on(plot, 'pointerleave', () => {
      if (!this.press && !this.pinned) { this.cancelFrame(); this.timeline.cursor = null; this.drawOverlay(); }
    });
    on(plot, 'keydown', event => {
      if (event.target.closest('.curve-tooltip')) return;
      if (!['ArrowLeft', 'ArrowRight', 'Escape', 'Home', 'End'].includes(event.key)) return;
      event.preventDefault();
      this.press = null;
      if (event.key === 'Escape') { this.timeline.cursor = null; this.pinned = false; }
      else if (event.key === 'Home' || event.key === 'End') {
        this.timeline.cursor = this.timeline.view?.[event.key === 'Home' ? 0 : 1] ?? null;
        this.pinned = true;
      } else { this.timeline.step(event.key === 'ArrowLeft' ? -1 : 1); this.pinned = true; }
      this.drawOverlay();
    });
  }

  cancelFrame() {
    if (this.frame !== null) cancelAnimationFrame(this.frame);
    this.frame = null;
    this.pendingPointer = null;
  }

  scheduleOverlay() {
    if (this.frame !== null) return;
    this.frame = requestAnimationFrame(() => {
      this.frame = null;
      if (!this.host?.isConnected || document.visibilityState === 'hidden') { this.pendingPointer = null; return; }
      const rect = this.plot.getBoundingClientRect();
      if (this.pendingPointer !== null) {
        const time = this.timeAtX(this.pendingPointer, rect);
        this.timeline.cursor = time;
        this.pendingPointer = null;
      }
      this.drawOverlay(rect);
    });
  }

  detach() {
    this.cancelFrame();
    this.events?.abort();
    this.events = null;
    this.host = null;
    this.geometry = null;
    this.baseData = null;
    this.tooltipSample = undefined;
  }

  suspend() {
    this.cancelFrame();
    if (this.host) this.host.querySelector('.curve-tooltip').hidden = true;
  }

  drawWindowControl() {
    if (!this.host) return;
    const select = this.host.querySelector('.curve-window');
    select.value = String(this.windowMinutes);
    select.disabled = this.pendingWindowMinutes !== null;
    const loading = this.host.querySelector('.curve-loading');
    loading.hidden = this.pendingWindowMinutes === null;
    loading.textContent = loading.hidden ? '' : `加载 ${this.pendingWindowMinutes} min`;
  }

  draw() {
    this.cancelFrame();
    const timeline = this.timeline, plot = this.plot;
    const tooltip = this.host.querySelector('.curve-tooltip');
    const view = timeline.view;
    this.drawWindowControl();
    if (!view) {
      plot.querySelector('.curve-svg').innerHTML = '<div class="curve-empty">尚无速率历史</div>';
      tooltip.hidden = true;
      this.geometry = null;
      this.host.querySelector('.curve-range').textContent = '';
      return;
    }
    const width = Math.max(220, plot.clientWidth), height = Math.max(110, plot.clientHeight || 140);
    if (this.baseData === timeline.data && this.geometry?.width === width && this.geometry?.height === height
      && this.baseView?.[0] === view[0] && this.baseView?.[1] === view[1]) { this.drawOverlay(); return; }
    this.baseData = timeline.data;
    this.baseView = [...view];
    this.tooltipHeight = 0;
    const left = 38, right = width - 8, top = 12, bottom = height - 25;
    const [start, end] = view;
    const visible = timeline.data.filter(point => point.time >= start && point.time <= end);
    const max = Math.max(1, ...visible.map(point => point.measuredTps)) * 1.1;
    const x = time => left + (time - start) / Math.max(1, end - start) * (right - left);
    const y = value => bottom - value / max * (bottom - top);
    this.geometry = { width, height, left, right, top, bottom, x, y };
    const path = key => visible.map((point, index) => `${!index || point.time - visible[index - 1].time > timeline.sampleMs * 1.5 ? 'M' : 'L'}${x(point.time).toFixed(2)},${y(point[key]).toFixed(2)}`).join(' ');
    let svg = `<svg viewBox="0 0 ${width} ${height}" aria-hidden="true">`;
    for (const value of [0, max / 2, max]) svg += `<line x1="${left}" x2="${right}" y1="${y(value)}" y2="${y(value)}" stroke="var(--monitor-line)"/><text x="${left - 5}" y="${y(value) + 4}" text-anchor="end" fill="var(--monitor-muted)" font-size="11">${Math.round(value)}</text>`;
    svg += `<path d="${path('measuredTps')}" fill="none" stroke="var(--monitor-blue)" stroke-width="1.6"/>`;
    svg += `<g class="curve-cursor" visibility="hidden"><line y1="${top}" y2="${bottom}" stroke="var(--monitor-muted)" stroke-dasharray="2 2"/><circle r="3" fill="var(--monitor-blue)"/></g>`;
    svg += `<text x="${left}" y="${height - 4}" fill="var(--monitor-muted)" font-size="11">${clock(start)}</text><text x="${right}" y="${height - 4}" text-anchor="end" fill="var(--monitor-muted)" font-size="11">${clock(end)}</text></svg>`;
    plot.querySelector('.curve-svg').innerHTML = svg;
    this.cursorElement = plot.querySelector('.curve-cursor');
    this.drawOverlay();
    this.host.querySelector('.curve-range').textContent = `${timeline.sampleMs / 1000} 秒/点`;
  }

  drawOverlay(rect) {
    if (!this.geometry || !this.host) return;
    const timeline = this.timeline, plot = this.plot, tooltip = this.host.querySelector('.curve-tooltip');
    const { width, height, x, y } = this.geometry;
    const plotRect = rect ?? plot.getBoundingClientRect();
    const frame = plot.closest('.thread-list')?.getBoundingClientRect();
    const frameTop = Math.max(0, frame?.top ?? 0) + 4;
    const frameBottom = Math.min(window.innerHeight, frame?.bottom ?? window.innerHeight) - 4;
    const selected = timeline.cursor === null ? null : timeline.nearest(timeline.cursor);
    this.cursorElement.setAttribute('visibility', selected ? 'visible' : 'hidden');
    if (selected) {
      const pos = x(selected.time), line = this.cursorElement.firstElementChild, circle = this.cursorElement.lastElementChild;
      line.setAttribute('x1', pos); line.setAttribute('x2', pos);
      circle.setAttribute('cx', pos); circle.setAttribute('cy', y(selected.measuredTps));
    }
    tooltip.hidden = timeline.cursor === null;
    tooltip.classList.toggle('is-pinned', this.pinned);
    if (!tooltip.hidden) {
      const changed = !sameTooltipSample(this.tooltipSample, selected);
      this.tooltipSample = selected;
      if (changed) {
        const content = selected
          ? `<strong>${new Date(selected.time).toLocaleString('zh-CN', { hour12: false })}</strong><div class="curve-details"><dl><dt>${clock(selected.time - timeline.sampleMs)}–${clock(selected.time)} · ${timeline.sampleMs / 1000} 秒均速</dt><dd>${decimal(selected.measuredTps)} tok/s</dd></dl>${groupHtml(selected.groups)}</div>`
          : '<span>该时刻无速率采样</span>';
        const scroll = tooltip.querySelector('.curve-details')?.scrollTop ?? 0;
        tooltip.innerHTML = content;
        const list = tooltip.querySelector('.curve-details');
        if (list) { list.tabIndex = 0; list.scrollTop = scroll; }
      }
      const hasDetails = Array.isArray(selected?.groups);
      tooltip.classList.toggle('has-contributors', hasDetails);
      const position = x(timeline.cursor);
      const maxHeight = Math.max(60, frameBottom - frameTop);
      const constraintsChanged = this.tooltipMaxHeight !== maxHeight;
      this.tooltipMaxHeight = maxHeight;
      tooltip.style.maxHeight = `${maxHeight}px`;
      if (changed || constraintsChanged || this.tooltipHeight === 0) {
        this.tooltipHeight = tooltip.offsetHeight;
        this.tooltipWidth = tooltip.offsetWidth;
      }
      const tooltipWidth = this.tooltipWidth;
      const visibleLeft = Math.max(0, -plotRect.left, (frame?.left ?? plotRect.left) - plotRect.left);
      const visibleRight = Math.min(width, window.innerWidth - plotRect.left, (frame?.right ?? plotRect.right) - plotRect.left);
      const rightPosition = position + 8;
      const preferredLeft = rightPosition + tooltipWidth <= visibleRight ? rightPosition : position - tooltipWidth - 8;
      tooltip.style.left = `${Math.max(visibleLeft, Math.min(visibleRight - tooltipWidth, preferredLeft))}px`;
      tooltip.style.top = `${Math.max(frameTop - plotRect.top, Math.min(height - 25 - this.tooltipHeight, frameBottom - plotRect.top - this.tooltipHeight))}px`;
    }
  }
}
