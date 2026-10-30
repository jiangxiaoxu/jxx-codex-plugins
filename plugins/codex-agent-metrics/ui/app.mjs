import { App, applyDocumentTheme, applyHostStyleVariables } from '@modelcontextprotocol/ext-apps';
import {
  DisplayRates, SnapshotHealth, StableCounts, ThreadList, createVisiblePoller, dateGroup, phasePresentation,
} from './state.mjs';
import { RateChart, rateChartHtml } from './rate-chart.mjs';

const root = document.getElementById('monitor');
const element = id => document.getElementById(id);
const app = new App({ name: 'Codex Agent Metrics', version: '0.1.8' }, {});
const rows = new ThreadList();
const health = new SnapshotHealth();
const threadRateChart = new RateChart();
const globalRateChart = new RateChart();
const displayRates = new DisplayRates();
const stableCounts = new StableCounts();
let displayedCounts = null;
let displayedModelTierRates = null;
const modelTierRateFields = ['model', 'serviceTier', 'measuredTps', 'sampleCount', 'activeDurationMs', 'lastSampleAt'];
document.getElementById('global-rate-chart').innerHTML = rateChartHtml({ id: 'global-rate-timeline', label: '全局输出速率时间线' });
globalRateChart.update(document.getElementById('global-rate-timeline'), 'monitored-set', []);
const state = {
  snapshot: null, order: 'recent', scope: 'all', view: 'live', nextThreadCursor: null, threadPrefixCount: 10,
  openThreadId: null, threadData: null, history: null, listEpoch: 0, selectionEpoch: 0,
  globalTimelineMinutes: 5, threadTimelineMinutes: new Map(),
  loadingThreads: false, connected: false, inViewport: true, detailError: null,
  diagnostics: null, clientEvents: [],
  backgroundEnabled: null, backgroundPending: false, backgroundRequested: false, backgroundError: null,
  lastRefreshDurationMs: null,
};
let freshnessTimer = null;
const seriesColors = ['var(--monitor-blue)', 'var(--monitor-purple)', 'var(--monitor-green)', 'var(--monitor-orange)'];
const tierLabels = { fast: 'Fast', priority: 'Fast', ultrafast: 'Ultrafast', standard: 'Standard', default: 'Standard' };

const escapeHtml = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
const finite = value => typeof value === 'number' && Number.isFinite(value);
const number = (value, digits = 0) => finite(value) ? value.toLocaleString('en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits }) : '-';
const tps = value => number(value, 1);
const displayedRate = item => item ? displayRates.read(`thread:${item.id}`, item.rate, item.rate) : null;
const outputTps = item => displayedRate(item)?.outputTps ?? null;
const panelVisible = () => state.inViewport && document.visibilityState !== 'hidden';

function clearSelection() {
  state.selectionEpoch++;
  state.openThreadId = null;
  state.threadData = null;
  state.detailError = null;
}

function setNotice(message, error = false) {
  element('notice').textContent = message;
  element('notice').hidden = !message;
  element('notice').dataset.error = String(error);
}

function renderHealth() {
  if (!panelVisible()) return;
  const current = health.inspect();
  const visible = panelVisible();
  root.dataset.health = current.kind;
  if (state.connected) element('connection').textContent = !visible ? '显示已暂停'
    : current.collectionState === 'paused' ? '采集已暂停 / 正在恢复'
      : current.kind === 'live' ? '自动更新' : current.kind === 'stale' ? '数据已过期 / 正在重试' : '等待成功采样 / 正在重试';
  const freshness = current.lastSuccessAt
    ? `${current.kind === 'stale' ? '数据已过期 / ' : ''}最后成功采样 ${new Date(current.lastSuccessAt).toLocaleString('zh-CN', { hour12: false })} / ${Math.floor(current.ageMs / 1000)} 秒前`
    : '尚无成功采样 / 数值暂不可用';
  element('connection').title = freshness;
  element('data-freshness').hidden = current.kind === 'live';
  element('data-freshness').textContent = current.kind === 'stale' ? '数据已过期' : '等待采样';
  element('data-freshness').title = freshness;
  const warnings = state.snapshot?.collection?.warnings;
  if (current.kind !== 'live') setNotice(`${current.issue || '正在读取日志'}. ${health.snapshot ? '保留最后成功数据.' : '尚无可用数据.'} 将自动重试.`, current.kind === 'stale' || current.collectionState === 'error');
  else if (state.backgroundError) setNotice(`后台采集设置失败: ${state.backgroundError}.`, true);
  else if (state.detailError) setNotice(`部分详情数据已过期: ${state.detailError}. 将自动重试.`, true);
  else if (Array.isArray(warnings) && warnings.length) setNotice(warnings.join(' / '));
  else setNotice('');
  if (!rows.items.length) {
    element('thread-empty').hidden = false;
    element('thread-empty').textContent = current.kind === 'live' ? '没有符合范围的 Working / Ready 会话' : current.collectionState === 'scanning' ? '正在读取运行中的线程' : '等待采集恢复';
  }
  if (state.view === 'diagnostics') renderDiagnostics();
}

function reportSnapshotError(error) {
  recordClientError('snapshot', error);
  health.fail(error);
  renderHealth();
}

function reportDetailError(error) {
  recordClientError(state.view, error);
  state.detailError = error.message;
  renderHealth();
}

function recordClientError(area, error) {
  state.clientEvents.push({ time: new Date().toISOString(), area, message: String(error.message ?? error).slice(0, 2000) });
  if (state.clientEvents.length > 100) state.clientEvents.splice(0, state.clientEvents.length - 100);
}

function renderDiagnostics() {
  const data = state.diagnostics;
  const current = health.inspect();
  element('diagnostics-path').textContent = data?.logPath || '尚未取得';
  element('diagnostics-version').textContent = `${data?.version || '-'} / ${data?.level || '-'}`;
  element('diagnostics-write').textContent = data?.writeFailed === true ? '写入失败' : data?.writeFailed === false ? '正常' : '-';
  element('diagnostics-skipped').textContent = number(state.snapshot?.collection?.skippedCompressedFiles);
  element('diagnostics-clock').textContent = JSON.stringify({
    state: current.kind,
    lastGoodCollectorAt: current.lastSuccessAt,
    latestReaderSuccessAt: current.reportedLastSuccessAt,
    latestQueryAt: current.querySampledAt,
    lastGoodUiReceivedAt: health.receivedAt === null ? null : new Date(health.receivedAt).toISOString(),
    ageMs: current.ageMs,
    lastRefreshDurationMs: state.lastRefreshDurationMs,
    refreshIntervalMs: 250,
    coverage: state.snapshot?.collection?.coverage ?? null,
    partialHistoryFiles: state.snapshot?.collection?.partialHistoryFiles ?? null,
    source: state.snapshot?.collection?.source ?? null,
    excluded: state.snapshot?.collection?.excluded ?? null,
    skippedCompressedFiles: state.snapshot?.collection?.skippedCompressedFiles ?? null,
    skippedUnavailableThreads: state.snapshot?.collection?.skippedUnavailableThreads ?? null,
    loadedThreadCount: rows.items.length,
    threadPrefixCount: state.threadPrefixCount,
    visible: panelVisible(),
  }, null, 2);
  const client = element('diagnostics-client');
  const backend = element('diagnostics-backend');
  const clientScroll = client.scrollTop, backendScroll = backend.scrollTop;
  client.textContent = state.clientEvents.length ? state.clientEvents.map(event => JSON.stringify(event)).join('\n') : '暂无错误';
  backend.textContent = Array.isArray(data?.events) ? data.events.map(event => JSON.stringify(event)).join('\n') || '暂无后端事件' : '尚未取得后端诊断';
  client.scrollTop = clientScroll;
  backend.scrollTop = backendScroll;
}

function relativeTime(timestamp) {
  const time = Date.parse(timestamp ?? '');
  if (!Number.isFinite(time)) return '更新时间未知';
  const seconds = Math.max(0, Math.floor((Date.now() - time) / 1000));
  if (seconds < 60) return seconds < 3 ? '刚刚更新' : `${seconds} 秒前更新`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)} 分钟前更新`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)} 小时前更新`;
  return new Date(time).toLocaleDateString('zh-CN');
}

async function callTool(name, args = {}) {
  const result = await app.callServerTool({ name, arguments: args });
  if (result.isError) {
    const message = result.content?.find(item => item.type === 'text')?.text;
    throw new Error(message || '监视工具返回错误');
  }
  if (!result.structuredContent || typeof result.structuredContent !== 'object') {
    throw new Error('监视工具未返回结构化数据');
  }
  return result.structuredContent;
}

function applyHostContext(context) {
  if (context?.theme) applyDocumentTheme(context.theme);
  if (context?.styles?.variables) applyHostStyleVariables(context.styles.variables);
  if (context?.safeAreaInsets) {
    const insets = context.safeAreaInsets;
    root.style.padding = ['top', 'right', 'bottom', 'left']
      .map(side => `${finite(insets[side]) ? Math.max(0, insets[side]) : 0}px`).join(' ');
  }
}

function updateOverview() {
  const snapshot = state.snapshot;
  if (!snapshot) return;
  const totals = snapshot.totals;
  const rate = displayRates.read('global', totals, totals);
  element('host-name').textContent = snapshot.hostName || '当前插件宿主';
  element('total-rate').textContent = tps(rate?.outputTps);
  element('activity-summary').textContent = `Working ${number(totals.workingThreadCount)} / Ready ${number(totals.readyThreadCount)}`;
  element('activity-summary').title = `${number(totals.threadCount)} 个根会话; 用量为已采样累计.`;
  element('total-rate').title = `已测 ${tps(rate?.measuredTps)} / 估算 ${tps(rate?.estimatedTps)} tok/s`;
  updateAgentCounts(snapshot.agentCounts);
  updateModelTierRates(snapshot.modelTierRates);
  drawGlobalChart();
  renderHealth();
}

function updateAgentCounts(counts) {
  if (!counts) return;
  const stable = stableCounts.update(counts);
  if (stable === displayedCounts) return;
  displayedCounts = stable;
  const evidence = (sources, labels) => labels.filter(([key]) => sources?.[key] > 0).map(([key, label]) => `${label} ${number(sources[key])}`).join(' / ');
  element('model-counts').innerHTML = (stable.combinations ?? []).map(item => {
    const modelEvidence = evidence(item.modelSources, [['turn_context', '执行记录'], ['runtime_config', '当前配置'], ['log_metadata', '日志元数据'], ['unknown', '未知']]);
    const tierEvidence = evidence(item.tierSources, [['selected', '已选择'], ['recorded', '请求记录'], ['unknown', '未知']]);
    return `<span class="agent-count" title="${escapeHtml(`模型: ${modelEvidence}; 档位: ${tierEvidence}`)}">${escapeHtml(item.model || '未知模型')} / ${escapeHtml(tierLabels[item.serviceTier] || '未知档位')} <b>×${number(item.count)}</b></span>`;
  }).join('') || '<span class="muted">无活跃代理</span>';
}

function updateModelTierRates(rates) {
  const values = Array.isArray(rates) ? rates : [];
  if (displayedModelTierRates?.length === values.length && values.every((sample, index) =>
    modelTierRateFields.every((key, field) => Object.is(sample?.[key], displayedModelTierRates[index][field])))) return;
  displayedModelTierRates = values.map(sample => modelTierRateFields.map(key => sample?.[key]));
  const samples = values.filter(sample => finite(sample?.measuredTps)
    && sample.measuredTps >= 0 && Number.isFinite(Date.parse(sample.lastSampleAt)));
  element('model-rate-row').hidden = samples.length === 0;
  element('model-rates').innerHTML = samples.map(sample => {
    const date = new Date(sample.lastSampleAt);
    const time = date.toLocaleTimeString('zh-CN', { hour12: false });
    const details = `${number(sample.sampleCount)} 个请求 / ${number(sample.activeDurationMs / 1000, 1)} 秒有效运行; 最近样本 ${date.toLocaleString('zh-CN', { hour12: false })}`;
    return `<span class="model-rate" title="${escapeHtml(details)}">${escapeHtml(sample.model || '未知模型')} / ${escapeHtml(tierLabels[sample.serviceTier] || '未知档位')} <b>${tps(sample.measuredTps)}</b> tok/s <time datetime="${escapeHtml(sample.lastSampleAt)}">· ${escapeHtml(time)}</time></span>`;
  }).join('');
}

function drawGlobalChart() {
  globalRateChart.update(element('global-rate-timeline'), 'monitored-set', state.snapshot?.history ?? [], state.snapshot?.historyGroups, state.snapshot?.historySampleMs, state.snapshot?.timelineMinutes);
}

function threadMeta(thread) {
  return `${phasePresentation(thread.status)} / ${number(thread.agentCount)} 个代理 / ${relativeTime(thread.recencyAt ?? thread.updatedAt)}`;
}

function threadHtml(thread) {
  const expanded = thread.id === state.openThreadId;
  return `<section class="thread-row" data-thread-row="${escapeHtml(thread.id)}">
    <button type="button" class="thread-toggle" data-thread="${escapeHtml(thread.id)}" aria-expanded="${expanded}">
      <span><span class="thread-name">${escapeHtml(thread.title || thread.id)}</span><span class="thread-meta">${escapeHtml(threadMeta(thread))}</span></span>
      <span class="thread-rate"><b>${tps(outputTps(thread))}</b> <small>tok/s</small></span><span aria-hidden="true">${expanded ? '-' : '+'}</span>
    </button>${expanded ? detailHtml() : ''}</section>`;
}

function detailHtml() {
  return `<div class="thread-detail" aria-label="线程详情">
    <dl class="facts metric-grid"><div><dt>输出 tok/s</dt><dd id="thread-total-rate">-</dd></div><div><dt>已测 / 估算</dt><dd id="thread-rate-parts">-</dd></div><div title="当前监视范围内的代理"><dt>代理 / Working / Ready</dt><dd><span id="thread-agent-count">-</span> / <span id="thread-agent-statuses">-</span></dd></div><div title="已采样累计, 非完整会话用量"><dt>输出 tokens</dt><dd id="thread-output">-</dd></div><div><dt>输入 / 缓存</dt><dd id="thread-input">-</dd></div><div title="已包含于输出 tokens"><dt>Reasoning</dt><dd id="thread-reasoning">-</dd></div></dl>
    ${rateChartHtml({ id: 'thread-rate-timeline', label: '线程汇总输出速率与代理贡献时间线' })}
  </div>`;
}

function renderThreadList() {
  const container = element('thread-list');
  const scroll = container.scrollTop;
  const anchor = scroll > 0 ? [...container.querySelectorAll('[data-thread-row]')]
    .find(row => row.getBoundingClientRect().bottom > container.getBoundingClientRect().top) : null;
  const anchorOffset = anchor ? anchor.getBoundingClientRect().top - container.getBoundingClientRect().top : null;
  const focusedThread = document.activeElement?.dataset?.thread;
  const { priority, recent } = rows.sections();
  let html = priority.length ? `<div class="group-heading">Working</div>${priority.map(threadHtml).join('')}` : '';
  let group = null;
  for (const thread of recent) {
    const nextGroup = dateGroup(thread.recencyAt ?? thread.updatedAt ?? thread.createdAt);
    if (nextGroup !== group) html += `<div class="group-heading">${state.order === 'priority' ? 'Ready' : '最近交互'} / ${escapeHtml(nextGroup)}</div>`;
    group = nextGroup;
    html += threadHtml(thread);
  }
  if (state.nextThreadCursor) html += '<div class="load-sentinel" id="thread-sentinel">向下滚动载入更多会话</div>';
  container.innerHTML = html;
  container.scrollTop = scroll;
  if (anchor) {
    const nextAnchor = [...container.querySelectorAll('[data-thread-row]')].find(row => row.dataset.threadRow === anchor.dataset.threadRow);
    if (nextAnchor) container.scrollTop += nextAnchor.getBoundingClientRect().top - container.getBoundingClientRect().top - anchorOffset;
  }
  if (focusedThread) [...container.querySelectorAll('[data-thread]')].find(button => button.dataset.thread === focusedThread)?.focus({ preventScroll: true });
  element('thread-empty').hidden = rows.items.length > 0 || state.snapshot?.collection?.state === 'scanning';
  element('thread-count').textContent = `已显示 ${rows.items.length} 个根会话${state.nextThreadCursor ? ' / 继续滚动载入' : ''}`;
  updateThreadRows();
  drawThreadChart();
}

function updateThreadRows() {
  const byId = new Map(rows.items.map(thread => [thread.id, thread]));
  for (const row of element('thread-list').querySelectorAll('[data-thread-row]')) {
    const thread = byId.get(row.dataset.threadRow);
    if (!thread) continue;
    row.querySelector('.thread-name').textContent = thread.title || thread.id;
    row.querySelector('.thread-meta').textContent = threadMeta(thread);
    row.querySelector('.thread-rate b').textContent = tps(outputTps(thread));
  }
  const thread = state.threadData?.thread ?? byId.get(state.openThreadId);
  if (thread && element('thread-total-rate')) {
    element('thread-total-rate').textContent = tps(outputTps(thread));
    const rate = displayedRate(thread);
    element('thread-rate-parts').textContent = `${tps(rate?.measuredTps)} / ${tps(rate?.estimatedTps)}`;
    element('thread-agent-count').textContent = number(thread.agentCount);
    element('thread-agent-statuses').textContent = `${number(thread.activeAgentCount)} / ${number(finite(thread.agentCount) && finite(thread.activeAgentCount) ? thread.agentCount - thread.activeAgentCount : null)}`;
    element('thread-output').textContent = number(thread.tokens?.output);
    element('thread-input').textContent = `${number(thread.tokens?.input)} / ${number(thread.tokens?.cachedInput)}`;
    element('thread-reasoning').textContent = number(thread.tokens?.reasoning);
  }
}

function drawThreadChart() {
  threadRateChart.update(element('thread-rate-timeline'), state.openThreadId, state.threadData?.history ?? [], state.threadData?.historyGroups, state.threadData?.historySampleMs, state.threadData?.timelineMinutes);
}

function acceptSnapshot(snapshot, { complete = false } = {}) {
  if (!Array.isArray(snapshot.threads)) throw new Error('会话数据格式不完整');
  if (typeof snapshot.collection?.backgroundEnabled === 'boolean') state.backgroundEnabled = snapshot.collection.backgroundEnabled;
  renderBackgroundControl();
  if (!health.accept(snapshot)) {
    renderHealth();
    return false;
  }
  const oldLayout = threadLayout();
  const oldCursor = state.nextThreadCursor;
  state.snapshot = snapshot;
  state.nextThreadCursor = snapshot.nextCursor ?? null;
  rows.merge(snapshot.threads, { complete, preserveIds: [state.openThreadId] });
  updateOverview();
  if (oldLayout !== threadLayout() || oldCursor !== state.nextThreadCursor) renderThreadList();
  else updateThreadRows();
  return true;
}

function threadLayout() {
  return rows.items.map(thread => `${thread.id}:${state.order === 'priority' && thread.status === 'working' ? 'working' : dateGroup(thread.recencyAt ?? thread.updatedAt)}`).join('\n');
}

async function refreshSnapshot() {
  if (!state.connected || !panelVisible()) return false;
  const epoch = state.listEpoch;
  const count = state.threadPrefixCount;
  const collected = new Map();
  const cursors = new Set();
  let snapshot;
  let cursor = null;
  do {
    const page = await callTool('monitor_snapshot', { limit: Math.min(100, count - collected.size), cursor, order: state.order, scope: state.scope, timelineMinutes: state.globalTimelineMinutes });
    if (epoch !== state.listEpoch || !state.connected || !panelVisible()) return false;
    snapshot = page;
    for (const thread of page.threads ?? []) collected.set(thread.id, thread);
    cursor = page.nextCursor ?? null;
    if (cursor && cursors.has(cursor)) throw new Error('会话游标未向前推进');
    if (cursor) cursors.add(cursor);
  } while (cursor && collected.size < count);
  return acceptSnapshot({ ...snapshot, threads: [...collected.values()], nextCursor: cursor }, { complete: true });
}

async function refreshSelection() {
  const threadId = state.openThreadId;
  const epoch = state.selectionEpoch;
  if (!threadId || !state.connected || !panelVisible() || health.inspect().kind !== 'live') return false;
  const data = await callTool('monitor_thread', { threadId, limit: 1, timelineMinutes: state.threadTimelineMinutes.get(threadId) ?? 5 });
  if (epoch !== state.selectionEpoch || threadId !== state.openThreadId || !state.connected || !panelVisible() || health.inspect().kind !== 'live') return false;
  if (data.thread === null) {
    rows.items = rows.items.filter(thread => thread.id !== threadId);
    clearSelection();
    renderThreadList();
    renderHealth();
    return false;
  }
  const oldLayout = threadLayout();
  state.threadData = data;
  if (data.thread) rows.merge([data.thread]);
  if (oldLayout !== threadLayout()) renderThreadList();
  else { updateThreadRows(); drawThreadChart(); }
  state.detailError = null;
  renderHealth();
  return true;
}

async function loadMoreThreads() {
  if (!state.nextThreadCursor || state.loadingThreads || !panelVisible()) return;
  state.loadingThreads = true;
  const epoch = state.listEpoch;
  try {
    const data = await callTool('monitor_snapshot', { limit: 10, cursor: state.nextThreadCursor, order: state.order, scope: state.scope, timelineMinutes: state.globalTimelineMinutes });
    if (epoch === state.listEpoch && panelVisible() && acceptSnapshot(data)) state.threadPrefixCount += 10;
  } catch (error) {
    reportSnapshotError(error);
  } finally {
    state.loadingThreads = false;
  }
}

function nearEnd(container) {
  return container.scrollTop + container.clientHeight >= container.scrollHeight - 45;
}

function drawHistory() {
  const days = Array.isArray(state.history?.days) ? state.history.days : [];
  const sorted = [...days].sort((a, b) => a.day.localeCompare(b.day));
  const total = sorted.reduce((sum, day) => sum + (day.outputTokens ?? 0), 0);
  element('history-summary').textContent = sorted.length ? `${sorted.length} 天 · ${number(total)} 输出 tokens` : '尚无历史用量';
  const partial = state.history?.coverage === 'sampled' || state.history?.historyComplete === false;
  element('history-coverage').textContent = partial ? '按日采样 · 含 reasoning' : '按日聚合 · 含 reasoning';
  element('history-coverage').title = partial ? '包含既有采样记录, 不代表会话完整用量; 输出已包含 reasoning.' : '输出已包含 reasoning.';
  element('history-rows').innerHTML = [...sorted].reverse().map(day => `<tr><td>${escapeHtml(day.day)}</td><td>${number(day.inputTokens)}</td><td>${number(day.outputTokens)}</td><td>${number(day.requests)}</td><td>${tps(day.averageTps)}</td></tr>`).join('');
  const container = element('history-chart');
  if (!sorted.length) {
    container.innerHTML = '';
    return;
  }
  const width = Math.max(260, container.clientWidth - 28), height = 132, left = 52, right = width - 8, top = 12, bottom = 108;
  const max = Math.max(1, ...sorted.map(day => day.outputTokens ?? 0));
  const step = (right - left) / sorted.length;
  const barWidth = Math.max(1, Math.min(28, step * .72));
  const maximumLabel = new Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 1 }).format(max);
  let svg = `<svg viewBox="0 0 ${width} ${height}" role="img" aria-label="每日输出 token 用量"><text x="${left - 7}" y="12" text-anchor="end" fill="var(--monitor-muted)" font-size="11">${maximumLabel}</text><text x="${left - 7}" y="${bottom}" text-anchor="end" fill="var(--monitor-muted)" font-size="11">0</text><line x1="${left}" x2="${right}" y1="${bottom}" y2="${bottom}" stroke="var(--monitor-line)"/>`;
  sorted.forEach((day, index) => {
    const barHeight = (day.outputTokens ?? 0) / max * (bottom - top);
    const x = left + step * (index + .5) - barWidth / 2;
    svg += `<rect x="${x}" y="${bottom - barHeight}" width="${barWidth}" height="${barHeight}" fill="var(--monitor-blue)"><title>${escapeHtml(day.day)}: ${number(day.outputTokens)} tokens</title></rect>`;
  });
  svg += `<text x="${left}" y="129" fill="var(--monitor-muted)" font-size="11">${escapeHtml(sorted[0].day)}</text><text x="${right}" y="129" text-anchor="end" fill="var(--monitor-muted)" font-size="11">${escapeHtml(sorted.at(-1).day)}</text></svg>`;
  container.innerHTML = svg;
}

async function refreshHistory() {
  if (!state.connected || !panelVisible() || health.inspect().kind !== 'live') return;
  const history = await callTool('monitor_history');
  if (state.view === 'history' && panelVisible() && health.inspect().kind === 'live') {
    state.history = history;
    drawHistory();
    state.detailError = null;
    renderHealth();
  }
}

async function refreshDiagnostics() {
  if (!state.connected || !panelVisible()) return;
  const data = await callTool('monitor_diagnostics');
  if (state.view === 'diagnostics' && panelVisible()) {
    state.diagnostics = data;
    state.detailError = null;
    renderHealth();
  }
}

async function refreshVisible() {
  if (!state.connected || !panelVisible()) return;
  const started = performance.now();
  try {
    if (state.view === 'diagnostics') {
      const [sample, diagnostic] = await Promise.allSettled([refreshSnapshot(), refreshDiagnostics()]);
      if (sample.status === 'rejected') reportSnapshotError(sample.reason);
      if (diagnostic.status === 'rejected') reportDetailError(diagnostic.reason);
      return;
    }
    const accepted = await refreshSnapshot();
    if (accepted && panelVisible()) {
      try {
        await (state.view === 'history' ? refreshHistory() : refreshSelection());
      } catch (error) {
        reportDetailError(error);
      }
    }
  } finally {
    state.lastRefreshDurationMs = Math.round((performance.now() - started) * 10) / 10;
    renderHealth();
  }
}

const poller = createVisiblePoller(refreshVisible, { onError: reportSnapshotError });

globalRateChart.onWindowChange = async minutes => {
  const previous = globalRateChart.windowMinutes;
  state.globalTimelineMinutes = minutes;
  state.listEpoch++;
  try {
    const accepted = await refreshSnapshot();
    if (!accepted && state.globalTimelineMinutes === minutes && globalRateChart.windowMinutes !== minutes) {
      state.globalTimelineMinutes = previous;
      state.listEpoch++;
    }
  } catch (error) {
    if (state.globalTimelineMinutes === minutes && globalRateChart.windowMinutes !== minutes) {
      state.globalTimelineMinutes = previous;
      state.listEpoch++;
    }
    reportSnapshotError(error);
  }
};
threadRateChart.onWindowChange = async minutes => {
  if (!state.openThreadId) return;
  const threadId = state.openThreadId;
  const previous = state.threadTimelineMinutes.get(threadId) ?? 5;
  state.threadTimelineMinutes.set(threadId, minutes);
  state.selectionEpoch++;
  try {
    const accepted = await refreshSelection();
    if (!accepted && state.threadTimelineMinutes.get(threadId) === minutes
      && !(state.threadData?.thread?.id === threadId && state.threadData.timelineMinutes === minutes)) {
      state.threadTimelineMinutes.set(threadId, previous);
      if (state.openThreadId === threadId) state.selectionEpoch++;
    }
  } catch (error) {
    if (state.threadTimelineMinutes.get(threadId) === minutes
      && !(state.threadData?.thread?.id === threadId && state.threadData.timelineMinutes === minutes)) {
      state.threadTimelineMinutes.set(threadId, previous);
      if (state.openThreadId === threadId) state.selectionEpoch++;
    }
    reportDetailError(error);
  }
};

function renderBackgroundControl() {
  const control = element('background-enabled');
  control.disabled = state.backgroundPending || state.backgroundEnabled === null;
  control.checked = state.backgroundPending ? state.backgroundRequested : state.backgroundEnabled === true;
  element('background-status').textContent = state.backgroundPending ? '正在设置'
    : state.backgroundEnabled === null ? '正在读取' : state.backgroundEnabled ? '当前后台进程 / 已开启' : '隐藏后暂停';
}

element('background-enabled').addEventListener('change', async event => {
  if (state.backgroundPending) return;
  state.backgroundRequested = event.target.checked;
  state.backgroundPending = true;
  state.backgroundError = null;
  renderBackgroundControl();
  try {
    const result = await callTool('monitor_background', { enabled: state.backgroundRequested });
    if (typeof result.backgroundEnabled !== 'boolean') throw new Error('后台采集状态无效');
    state.backgroundEnabled = result.backgroundEnabled;
  } catch (error) {
    state.backgroundError = String(error.message ?? error);
    recordClientError('background', error);
  } finally {
    state.backgroundPending = false;
    renderBackgroundControl();
    renderHealth();
  }
});

function updateVisibility() {
  const visible = state.connected && panelVisible();
  if (!visible) { globalRateChart.suspend(); threadRateChart.suspend(); }
  poller.setVisible(visible);
  if (visible && freshnessTimer === null) freshnessTimer = setInterval(renderHealth, 1000);
  else if (!visible && freshnessTimer !== null) {
    clearInterval(freshnessTimer);
    freshnessTimer = null;
  }
  renderHealth();
}

function resetThreadList() {
  state.listEpoch++;
  state.selectionEpoch++;
  rows.reset(state.order);
  state.nextThreadCursor = null;
  state.threadPrefixCount = 10;
  state.openThreadId = null;
  state.threadData = null;
  state.detailError = null;
  renderThreadList();
  void refreshSnapshot().catch(reportSnapshotError);
}

element('thread-order').addEventListener('change', event => {
  state.order = event.target.value;
  resetThreadList();
});
element('thread-scope').addEventListener('change', event => {
  state.scope = event.target.value;
  resetThreadList();
});

element('thread-list').addEventListener('click', event => {
  const threadButton = event.target.closest('[data-thread]');
  if (!threadButton) return;
  state.selectionEpoch++;
  state.openThreadId = state.openThreadId === threadButton.dataset.thread ? null : threadButton.dataset.thread;
  state.threadData = null;
  renderThreadList();
  void refreshSelection().catch(reportDetailError);
});

element('thread-list').addEventListener('scroll', event => {
  if (event.target.id === 'thread-list' && nearEnd(event.target)) void loadMoreThreads();
}, true);

function setView(view) {
  state.view = view;
  for (const name of ['live', 'history', 'diagnostics']) {
    element(`${name}-tab`).setAttribute('aria-selected', String(view === name));
    element(`${name}-view`).hidden = view !== name;
  }
  for (const control of root.querySelectorAll('.live-control')) control.hidden = view !== 'live';
  if (view === 'history') void refreshHistory().catch(reportDetailError);
  if (view === 'diagnostics') {
    renderDiagnostics();
    void refreshDiagnostics().catch(reportDetailError);
  }
}
element('live-tab').addEventListener('click', () => setView('live'));
element('history-tab').addEventListener('click', () => setView('history'));
element('diagnostics-tab').addEventListener('click', () => setView('diagnostics'));

const visibilityObserver = new IntersectionObserver(entries => {
  state.inViewport = entries.some(entry => entry.isIntersecting);
  updateVisibility();
}, { threshold: 0 });
visibilityObserver.observe(root);
document.addEventListener('visibilitychange', updateVisibility);
const resizeObserver = new ResizeObserver(() => {
  if (!panelVisible()) return;
  drawGlobalChart();
  drawThreadChart();
  if (state.view === 'history') drawHistory();
});
resizeObserver.observe(root);

function stop() {
  globalRateChart.detach();
  threadRateChart.detach();
  state.connected = false;
  state.inViewport = false;
  poller.stop();
  clearInterval(freshnessTimer);
  freshnessTimer = null;
  visibilityObserver.disconnect();
  resizeObserver.disconnect();
}
window.addEventListener('pagehide', stop, { once: true });
app.onteardown = async () => { stop(); return {}; };
app.onhostcontextchanged = applyHostContext;
app.ontoolresult = result => {
  if (result.structuredContent?.schemaVersion === 1 && !state.snapshot) {
    try { acceptSnapshot(result.structuredContent); }
    catch (error) { reportSnapshotError(error); }
  }
};

async function start() {
  await app.connect();
  state.connected = true;
  applyHostContext(app.getHostContext());
  updateVisibility();
}
start().catch(error => {
  element('connection').textContent = '无法连接宿主';
  reportSnapshotError(new Error(`MCP App 连接失败: ${error.message}`));
});
