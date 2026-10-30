import { App, applyDocumentTheme, applyHostStyleVariables } from '@modelcontextprotocol/ext-apps';
import {
  DisplayRates, SnapshotHealth, StableCounts, ThreadList, compareAgents, createVisiblePoller, dateGroup, mergeStableItems,
  modePresentation, modelPresentation, phasePresentation,
} from './state.mjs';
import { RateChart, rateChartHtml } from './rate-chart.mjs';

const root = document.getElementById('monitor');
const element = id => document.getElementById(id);
const app = new App({ name: 'Agent Monitor', version: '0.1.4' }, {});
const rows = new ThreadList();
const health = new SnapshotHealth();
const rateChart = new RateChart();
const globalRateChart = new RateChart();
const displayRates = new DisplayRates();
const stableCounts = new StableCounts();
let displayedCounts = null;
document.getElementById('global-rate-chart').innerHTML = rateChartHtml({ id: 'global-rate-timeline', label: '全局输出速率时间线' });
globalRateChart.update(document.getElementById('global-rate-timeline'), 'monitored-set', []);
const state = {
  snapshot: null, order: 'recent', scope: 'all', view: 'live', nextThreadCursor: null, threadPrefixCount: 10,
  openThreadId: null, selectedAgentId: null, threadData: null, agents: [], agentData: null,
  nextAgentCursor: null, agentScope: 'all', agentPrefixCount: 10, history: null, listEpoch: 0, selectionEpoch: 0,
  loadingThreads: false, loadingAgents: false, connected: false, inViewport: true, detailError: null,
  diagnostics: null, clientEvents: [],
  backgroundEnabled: null, backgroundPending: false, backgroundRequested: false, backgroundError: null,
  lastRefreshDurationMs: null,
};
let freshnessTimer = null;
const seriesColors = ['var(--monitor-blue)', 'var(--monitor-purple)', 'var(--monitor-green)', 'var(--monitor-orange)'];

const escapeHtml = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
const finite = value => typeof value === 'number' && Number.isFinite(value);
const number = (value, digits = 0) => finite(value) ? value.toLocaleString('en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits }) : '-';
const tps = value => number(value, 1);
const displayedRate = item => item ? displayRates.read(`${item.role ? 'agent' : 'thread'}:${item.id}`, item.rate, item.rate) : null;
const outputTps = item => displayedRate(item)?.outputTps ?? null;
const isMain = agent => agent.role === 'main' || agent.id === state.openThreadId;
const panelVisible = () => state.inViewport && document.visibilityState !== 'hidden';

function clearSelection() {
  state.selectionEpoch++;
  state.openThreadId = null;
  state.selectedAgentId = null;
  state.threadData = null;
  state.agents = [];
  state.agentData = null;
  state.nextAgentCursor = null;
  state.agentPrefixCount = 10;
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
  element('data-freshness').textContent = current.lastSuccessAt
    ? `${current.kind === 'stale' ? '数据已过期 / ' : ''}最后成功采样 ${new Date(current.lastSuccessAt).toLocaleString('zh-CN', { hour12: false })} / ${Math.floor(current.ageMs / 1000)} 秒前`
    : '尚无成功采样 / 数值暂不可用';
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
    loadedAgentCount: state.agents.length,
    agentPrefixCount: state.agentPrefixCount,
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
  element('activity-summary').textContent = `Working ${number(totals.workingThreadCount)} / Ready ${number(totals.readyThreadCount)} / ${number(totals.threadCount)} 个根会话`;
  const partial = snapshot.collection?.coverage === 'sampled' || snapshot.collection?.historyComplete === false;
  element('sample-coverage').hidden = !partial;
  element('sample-coverage').textContent = partial ? 'Token 和历史为已采样累计, 不代表会话完整用量.' : '';
  element('rate-parts').textContent = `已测 ${tps(rate?.measuredTps)} / 估算 ${tps(rate?.estimatedTps)} tok/s`;
  updateAgentCounts(snapshot.agentCounts);
  drawGlobalChart();
  renderHealth();
}

function updateAgentCounts(counts) {
  if (!counts) return;
  const stable = stableCounts.update(counts);
  if (stable === displayedCounts) return;
  displayedCounts = stable;
  const evidence = (sources, labels) => labels.filter(([key]) => sources?.[key] > 0).map(([key, label]) => `${label} ${number(sources[key])}`).join(' / ');
  element('model-counts').innerHTML = (stable.models ?? []).map(item => `<span class="agent-count" title="${escapeHtml(evidence(item.sources, [['turn_context', '执行记录'], ['runtime_config', '当前配置'], ['log_metadata', '日志元数据'], ['unknown', '未知']]))}">${escapeHtml(item.model || '未知模型')} <b>×${number(item.count)}</b></span>`).join('') || '<span class="muted">暂无代理</span>';
  const tierLabels = { fast: 'Fast', ultrafast: 'Ultrafast', standard: 'Standard' };
  element('tier-counts').innerHTML = (stable.serviceTiers ?? []).map(item => `<span class="agent-count" title="${escapeHtml(evidence(item.sources, [['selected', '已选择'], ['recorded', '请求记录'], ['unknown', '未知']]))}">${escapeHtml(tierLabels[item.tier] || '未知档位')} <b>×${number(item.count)}</b></span>`).join('') || '<span class="muted">暂无代理</span>';
}

function drawGlobalChart() {
  globalRateChart.update(element('global-rate-timeline'), 'monitored-set', state.snapshot?.history ?? []);
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

function agentHtml(agent) {
  const mode = modePresentation(agent.mode);
  const model = modelPresentation(agent);
  const activity = phasePresentation(agent.activity);
  const name = isMain(agent) ? `主代理${agent.name && agent.name !== agent.id ? ` / ${agent.name}` : ''}`
    : agent.name && agent.name !== agent.id ? agent.name : `子代理 ${agent.id.slice(0, 8)}`;
  return `<button type="button" class="agent-row" data-agent="${escapeHtml(agent.id)}" aria-pressed="${agent.id === state.selectedAgentId}">
    <span><span class="agent-name">${escapeHtml(name)}</span><span class="agent-meta">${escapeHtml(model.label)} / ${escapeHtml(mode.label)}</span></span>
    <span class="agent-rate"><b>${tps(outputTps(agent))}</b><span title="${escapeHtml(phasePresentation(agent.phase))}">${escapeHtml(activity)}</span></span>
  </button>`;
}

function detailHtml() {
  const main = state.agents.find(isMain);
  const children = state.agents.filter(agent => !isMain(agent));
  const scopeOptions = [['all', 'Working + Ready'], ['working', 'Working'], ['ready', 'Ready']]
    .map(([value, label]) => `<option value="${value}"${value === state.agentScope ? ' selected' : ''}>${label}</option>`).join('');
  return `<div class="thread-detail">
    <div class="agent-layout"><div class="agent-column">
      <button type="button" class="agent-row thread-overview-row" data-overview aria-pressed="${state.selectedAgentId === null}"><span><span class="agent-name">线程总览</span><span class="agent-meta" id="thread-overview-meta">正在读取线程</span></span><span class="agent-rate"><b id="thread-overview-rate">-</b><span>合计 tok/s</span></span></button>
      <div class="agent-section-label">主代理</div>
      <div class="main-agent">${main ? agentHtml(main) : `<span class="muted">${state.threadData ? '主代理不在当前监视范围' : '正在读取主代理'}</span>`}</div>
      <div class="sub-head"><span>子代理 / 最近交互</span><select id="agent-scope" aria-label="子代理范围">${scopeOptions}</select></div>
      <div class="agent-list" id="agent-list">${children.map(agentHtml).join('')}<div class="load-sentinel" id="agent-sentinel">${state.nextAgentCursor ? '向下滚动载入更多' : `${children.length} 个子代理`}</div></div>
    </div><aside class="inspector" aria-label="线程与代理详情">
      <div id="thread-inspector"${state.selectedAgentId === null ? '' : ' hidden'}>
        <div class="inspector-head"><strong>线程总览</strong><span class="muted" id="thread-overview-status"></span></div>
        <div class="inspector-model" id="thread-overview-title"></div>
        <dl class="facts"><dt>合计输出</dt><dd id="thread-total-rate">-</dd><dt>已测 / 估算</dt><dd id="thread-rate-parts">-</dd><dt>监视中的代理</dt><dd id="thread-agent-count">-</dd><dt>Working / Ready</dt><dd id="thread-agent-statuses">-</dd><dt>已采样输出</dt><dd id="thread-output">-</dd><dt>已采样输入 / 缓存</dt><dd id="thread-input">-</dd><dt>其中 reasoning</dt><dd id="thread-reasoning">-</dd></dl>
        <div class="agent-section-label">模型输出贡献</div><div class="thread-models" id="thread-models"></div>
        <p class="inspector-note">汇总线程全部可监视代理, 包含未加载的列表行. Token 为已采样累计.</p>
      </div>
      <div id="agent-inspector"${state.selectedAgentId === null ? ' hidden' : ''}>
      <div class="inspector-head"><strong id="agent-name">${state.selectedAgentId || !state.threadData ? '正在读取代理' : '请选择代理'}</strong><span class="muted" id="agent-phase"></span></div>
      <div class="inspector-model" id="agent-model"></div>
      <div class="inspector-configuration" id="agent-configuration" hidden></div>
      <dl class="facts"><dt>当前输出</dt><dd id="agent-rate">-</dd><dt>加速模式</dt><dd id="agent-mode">-</dd><dt>模式依据</dt><dd id="agent-mode-evidence">-</dd><dt>父代理</dt><dd id="agent-parent">-</dd><dt>已采样输出</dt><dd id="agent-output">-</dd><dt>已采样输入 / 缓存</dt><dd id="agent-input">-</dd></dl>
      ${rateChartHtml({ id: 'agent-rate-timeline', label: '所选代理输出速率时间线' })}
      </div>
    </aside></div>
  </div>`;
}

function renderThreadList() {
  const container = element('thread-list');
  const oldAgentList = element('agent-list');
  const scroll = container.scrollTop;
  const subScroll = oldAgentList?.scrollTop ?? 0;
  const anchor = scroll > 0 ? [...container.querySelectorAll('[data-thread-row]')]
    .find(row => row.getBoundingClientRect().bottom > container.getBoundingClientRect().top) : null;
  const anchorOffset = anchor ? anchor.getBoundingClientRect().top - container.getBoundingClientRect().top : null;
  const subAnchor = subScroll > 0 ? [...oldAgentList.querySelectorAll('[data-agent]')]
    .find(row => row.getBoundingClientRect().bottom > oldAgentList.getBoundingClientRect().top) : null;
  const subAnchorOffset = subAnchor ? subAnchor.getBoundingClientRect().top - oldAgentList.getBoundingClientRect().top : null;
  const focus = document.activeElement;
  const focusedThread = focus?.dataset?.thread;
  const focusedAgent = focus?.dataset?.agent;
  const focusedOverview = focus?.hasAttribute('data-overview');
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
  const nextAgentList = element('agent-list');
  if (nextAgentList) {
    nextAgentList.scrollTop = subScroll;
    if (subAnchor) {
      const nextAnchor = [...nextAgentList.querySelectorAll('[data-agent]')].find(row => row.dataset.agent === subAnchor.dataset.agent);
      if (nextAnchor) nextAgentList.scrollTop += nextAnchor.getBoundingClientRect().top - nextAgentList.getBoundingClientRect().top - subAnchorOffset;
    }
  }
  if (focusedThread || focusedAgent) {
    const buttons = container.querySelectorAll(focusedThread ? '[data-thread]' : '[data-agent]');
    const next = [...buttons].find(button => focusedThread ? button.dataset.thread === focusedThread : button.dataset.agent === focusedAgent);
    next?.focus({ preventScroll: true });
  }
  if (focusedOverview) container.querySelector('[data-overview]')?.focus({ preventScroll: true });
  element('thread-empty').hidden = rows.items.length > 0 || state.snapshot?.collection?.state === 'scanning';
  element('thread-count').textContent = `已显示 ${rows.items.length} 个根会话${state.nextThreadCursor ? ' / 继续滚动载入' : ''}`;
  updateThreadRows();
  updateInspector();
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
  const agents = new Map(state.agents.map(agent => [agent.id, agent]));
  for (const button of element('thread-list').querySelectorAll('[data-agent]')) {
    const agent = agents.get(button.dataset.agent);
    if (!agent) continue;
    const mode = modePresentation(agent.mode);
    const model = modelPresentation(agent);
    button.setAttribute('aria-pressed', String(agent.id === state.selectedAgentId));
    button.querySelector('.agent-name').textContent = isMain(agent) ? `主代理${agent.name && agent.name !== agent.id ? ` / ${agent.name}` : ''}`
      : agent.name && agent.name !== agent.id ? agent.name : `子代理 ${agent.id.slice(0, 8)}`;
    button.querySelector('.agent-meta').textContent = `${model.label} / ${mode.label}`;
    button.querySelector('.agent-rate b').textContent = tps(outputTps(agent));
    button.querySelector('.agent-rate span').textContent = phasePresentation(agent.activity);
    button.querySelector('.agent-rate span').title = phasePresentation(agent.phase);
  }
  const thread = byId.get(state.openThreadId) ?? state.threadData?.thread;
  const overview = element('thread-list').querySelector('[data-overview]');
  overview?.setAttribute('aria-pressed', String(state.selectedAgentId === null));
  if (thread && overview) {
    element('thread-overview-meta').textContent = `${phasePresentation(thread.status)} / ${number(thread.agentCount)} 个代理`;
    element('thread-overview-rate').textContent = tps(outputTps(thread));
    element('thread-overview-title').textContent = thread.title || thread.id;
    element('thread-overview-status').textContent = phasePresentation(thread.status);
    element('thread-total-rate').textContent = `${tps(outputTps(thread))} tok/s`;
    const rate = displayedRate(thread);
    element('thread-rate-parts').textContent = `${tps(rate?.measuredTps)} / ${tps(rate?.estimatedTps)} tok/s`;
    element('thread-agent-count').textContent = number(thread.agentCount);
    element('thread-agent-statuses').textContent = `${number(thread.activeAgentCount)} / ${number(finite(thread.agentCount) && finite(thread.activeAgentCount) ? thread.agentCount - thread.activeAgentCount : null)}`;
    element('thread-output').textContent = `${number(thread.tokens?.output)} tokens`;
    element('thread-input').textContent = `${number(thread.tokens?.input)} / ${number(thread.tokens?.cachedInput)}`;
    element('thread-reasoning').textContent = `${number(thread.tokens?.reasoning)} tokens`;
  }
  if (element('thread-models') && thread) {
    const models = Array.isArray(thread.modelRates) ? thread.modelRates : [];
    element('thread-models').textContent = models.map(model => `${model.model || '未知模型'} ${tps(displayRates.read(`thread-model:${thread.id}:${model.model}`, model, model)?.outputTps)} tok/s`).join(' / ')
      || `当前会话合计 ${tps(outputTps(thread))} tok/s`;
  }
}

function drawAgentChart(history = []) {
  rateChart.update(element('agent-rate-timeline'), state.selectedAgentId, history);
}

function updateInspector() {
  if (element('thread-inspector')) element('thread-inspector').hidden = state.selectedAgentId !== null;
  if (element('agent-inspector')) element('agent-inspector').hidden = state.selectedAgentId === null;
  const agent = state.agentData?.agent ?? state.agents.find(item => item.id === state.selectedAgentId);
  if (!element('agent-name') || !agent) return;
  const mode = modePresentation(agent.mode);
  const model = modelPresentation(agent);
  element('agent-name').textContent = isMain(agent) ? `主代理${agent.name && agent.name !== agent.id ? ` / ${agent.name}` : ''}`
    : agent.name && agent.name !== agent.id ? agent.name : `子代理 ${agent.id.slice(0, 8)}`;
  const phase = phasePresentation(agent.phase);
  const activity = phasePresentation(agent.activity);
  element('agent-phase').textContent = `${activity}${phase !== activity ? ` / ${phase}${agent.phaseSource === 'log' ? ' (日志)' : ''}` : ''}`;
  element('agent-model').textContent = `${model.label} / ${model.effortLabel}`;
  element('agent-configuration').hidden = !model.configuration;
  element('agent-configuration').textContent = model.configuration || '';
  element('agent-rate').textContent = `${tps(outputTps(agent))} tok/s${agent.rate?.estimatedTps > 0 ? ' / 含估算' : ''}`;
  element('agent-mode').textContent = mode.label;
  element('agent-mode-evidence').textContent = mode.evidence;
  element('agent-parent').textContent = agent.parentId ? agent.parentId.slice(0, 12) : '-';
  element('agent-parent').title = agent.parentId || '根会话';
  element('agent-output').textContent = `${number(agent.tokens?.output)} tokens`;
  element('agent-input').textContent = `${number(agent.tokens?.input)} / ${number(agent.tokens?.cachedInput)}`;
  drawAgentChart(state.agentData?.history ?? []);
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
    const page = await callTool('monitor_snapshot', { limit: Math.min(100, count - collected.size), cursor, order: state.order, scope: state.scope });
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
  if (!threadId || !state.connected || !panelVisible() || health.inspect().kind !== 'live') return;
  const count = state.agentPrefixCount;
  const collected = new Map();
  const cursors = new Set();
  let data;
  let cursor = null;
  do {
    const page = await callTool('monitor_thread', { threadId, limit: Math.min(100, count - collected.size), cursor, scope: state.agentScope });
    if (epoch !== state.selectionEpoch || threadId !== state.openThreadId || !state.connected || !panelVisible()) {
      return;
    }
    if (page.thread === null) {
      rows.items = rows.items.filter(thread => thread.id !== threadId);
      clearSelection();
      renderThreadList();
      renderHealth();
      return;
    }
    data ??= page;
    for (const agent of page.agents ?? []) collected.set(agent.id, agent);
    cursor = page.nextCursor ?? null;
    if (cursor && cursors.has(cursor)) throw new Error('代理游标未向前推进');
    if (cursor) cursors.add(cursor);
  } while (cursor && collected.size < count);
  data = { ...data, agents: [...collected.values()], nextCursor: cursor };
  if (epoch !== state.selectionEpoch || threadId !== state.openThreadId || !panelVisible() || health.inspect().kind !== 'live') return;
  const previousIds = state.agents.map(agent => agent.id).join('\n');
  const oldLayout = threadLayout();
  const oldCursor = state.nextAgentCursor;
  state.threadData = data;
  state.agents = mergeStableItems(state.agents, Array.isArray(data.agents) ? data.agents : [], {
    complete: true, preserveIds: [state.selectedAgentId],
  }).sort(compareAgents);
  if (data.thread) rows.merge([data.thread]);
  state.nextAgentCursor = data.nextCursor ?? null;
  if (state.selectedAgentId && !state.agents.some(agent => agent.id === state.selectedAgentId)) {
    state.selectedAgentId = null;
    state.agentData = null;
  }
  if (oldLayout !== threadLayout() || previousIds !== state.agents.map(agent => agent.id).join('\n') || oldCursor !== state.nextAgentCursor) renderThreadList();
  else updateThreadRows();
  updateInspector();
  if (state.selectedAgentId) {
    const agentId = state.selectedAgentId;
    const detail = await callTool('monitor_agent', { agentId });
    if (epoch !== state.selectionEpoch || threadId !== state.openThreadId || !panelVisible() || health.inspect().kind !== 'live') return;
    if (detail.agent === null) {
      state.selectionEpoch++;
      state.agents = state.agents.filter(agent => agent.id !== agentId);
      state.selectedAgentId = null;
      state.agentData = null;
      state.detailError = null;
      renderThreadList();
      renderHealth();
      return;
    }
    const oldIds = state.agents.map(agent => agent.id).join('\n');
    state.agentData = detail;
    if (detail.agent) state.agents = mergeStableItems(state.agents, [detail.agent]).sort(compareAgents);
    if (oldIds !== state.agents.map(agent => agent.id).join('\n')) renderThreadList();
    else updateInspector();
  }
  state.detailError = null;
  renderHealth();
}

async function loadMoreThreads() {
  if (!state.nextThreadCursor || state.loadingThreads || !panelVisible()) return;
  state.loadingThreads = true;
  const epoch = state.listEpoch;
  try {
    const data = await callTool('monitor_snapshot', { limit: 10, cursor: state.nextThreadCursor, order: state.order, scope: state.scope });
    if (epoch === state.listEpoch && panelVisible() && acceptSnapshot(data)) state.threadPrefixCount += 10;
  } catch (error) {
    reportSnapshotError(error);
  } finally {
    state.loadingThreads = false;
  }
}

async function loadMoreAgents() {
  if (!state.openThreadId || !state.nextAgentCursor || state.loadingAgents || !panelVisible() || health.inspect().kind !== 'live') return;
  state.loadingAgents = true;
  const epoch = state.selectionEpoch;
  const threadId = state.openThreadId;
  try {
    const data = await callTool('monitor_thread', { threadId, limit: 10, cursor: state.nextAgentCursor, scope: state.agentScope });
    if (epoch !== state.selectionEpoch || !panelVisible() || health.inspect().kind !== 'live') return;
    if (data.thread === null) {
      rows.items = rows.items.filter(thread => thread.id !== threadId);
      clearSelection();
      renderThreadList();
      renderHealth();
      return;
    }
    state.agents = mergeStableItems(state.agents, data.agents ?? []).sort(compareAgents);
    state.nextAgentCursor = data.nextCursor ?? null;
    state.agentPrefixCount += 10;
    renderThreadList();
  } catch (error) {
    reportDetailError(error);
  } finally {
    state.loadingAgents = false;
  }
}

function nearEnd(container) {
  return container.scrollTop + container.clientHeight >= container.scrollHeight - 45;
}

function drawHistory() {
  const days = Array.isArray(state.history?.days) ? state.history.days : [];
  const sorted = [...days].sort((a, b) => a.day.localeCompare(b.day));
  const total = sorted.reduce((sum, day) => sum + (day.outputTokens ?? 0), 0);
  element('history-summary').textContent = sorted.length ? `${sorted.length} 天 / 已记录输出 ${number(total)} tokens` : '尚无历史用量';
  const partial = state.history?.coverage === 'sampled' || state.history?.historyComplete === false;
  element('history-coverage').textContent = partial
    ? '已采样数据按日聚合, 含既有记录; 非会话完整用量. 输出包含 reasoning.'
    : '按日聚合 / 仅未压缩日志及既有采样 / 输出包含 reasoning';
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
  state.selectedAgentId = null;
  state.threadData = null;
  state.agents = [];
  state.agentData = null;
  state.agentPrefixCount = 10;
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
  if (threadButton) {
    state.selectionEpoch++;
    state.openThreadId = state.openThreadId === threadButton.dataset.thread ? null : threadButton.dataset.thread;
    state.selectedAgentId = null;
    state.threadData = null;
    state.agents = [];
    state.agentData = null;
    state.nextAgentCursor = null;
    state.agentPrefixCount = 10;
    state.agentScope = 'all';
    renderThreadList();
    void refreshSelection().catch(reportDetailError);
    return;
  }
  if (event.target.closest('[data-overview]')) {
    state.selectionEpoch++;
    state.selectedAgentId = null;
    state.agentData = null;
    updateThreadRows();
    updateInspector();
    return;
  }
  const agentButton = event.target.closest('[data-agent]');
  if (agentButton) {
    state.selectionEpoch++;
    state.selectedAgentId = agentButton.dataset.agent;
    state.agentData = null;
    updateThreadRows();
    updateInspector();
    void refreshSelection().catch(reportDetailError);
  }
});

element('thread-list').addEventListener('change', event => {
  if (event.target.id !== 'agent-scope') return;
  state.selectionEpoch++;
  state.agentScope = event.target.value;
  state.agents = state.agents.filter(agent => isMain(agent) || agent.id === state.selectedAgentId);
  state.nextAgentCursor = null;
  state.agentPrefixCount = 10;
  renderThreadList();
  void refreshSelection().catch(reportDetailError);
});

element('thread-list').addEventListener('scroll', event => {
  if (!nearEnd(event.target)) return;
  if (event.target.id === 'thread-list') void loadMoreThreads();
  else if (event.target.id === 'agent-list') void loadMoreAgents();
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
  drawAgentChart(state.agentData?.history ?? []);
  if (state.view === 'history') drawHistory();
});
resizeObserver.observe(root);

function stop() {
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
