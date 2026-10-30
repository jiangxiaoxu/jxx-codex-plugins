export function recency(item) {
  const value = Date.parse(item?.recencyAt ?? item?.updatedAt ?? item?.createdAt ?? '');
  return Number.isFinite(value) ? value : 0;
}

export function compareThreads(a, b, order = 'recent') {
  return (order === 'priority' ? Number(b.status === 'working') - Number(a.status === 'working') : 0)
    || recency(b) - recency(a)
    || String(a.id).localeCompare(String(b.id));
}

export function compareAgents(a, b) {
  return Number(b.role === 'main') - Number(a.role === 'main')
    || recency(b) - recency(a)
    || String(a.id).localeCompare(String(b.id));
}

export function mergeStableItems(previous, incoming, { complete = false, preserveIds = [] } = {}) {
  const updates = new Map(incoming.filter(item => item?.id).map(item => [item.id, item]));
  const preserved = new Set(preserveIds);
  const result = previous.filter(item => !complete || updates.has(item.id) || preserved.has(item.id)).map(item => {
    const update = updates.get(item.id);
    updates.delete(item.id);
    return update ? { ...item, ...update } : item;
  });
  result.push(...updates.values());
  return result;
}

export class ThreadList {
  constructor(order = 'recent') {
    this.order = order;
    this.items = [];
  }

  reset(order = this.order) {
    this.order = order;
    this.items = [];
  }

  merge(incoming, options) {
    this.items = mergeStableItems(this.items, incoming, options).sort((a, b) => compareThreads(a, b, this.order));
    return this.items;
  }

  sections() {
    return {
      priority: this.order === 'priority' ? this.items.filter(item => item.status === 'working') : [],
      recent: this.items.filter(item => this.order !== 'priority' || item.status !== 'working'),
    };
  }
}

export function modePresentation(mode = {}) {
  const labels = { priority: 'Fast', fast: 'Fast', ultrafast: 'Ultrafast', default: 'Standard', standard: 'Standard' };
  const display = value => labels[String(value).toLowerCase()] ?? String(value);
  if (mode.selected) return { label: display(mode.selected), evidence: '已选择' };
  if (mode.recorded) return { label: display(mode.recorded), evidence: '最近完成请求记录' };
  return { label: '未知', evidence: mode.configured ? `默认配置 ${display(mode.configured)}` : '缺少模式记录' };
}

export function modelPresentation(agent = {}) {
  const suffixes = { runtime_config: ' (配置)', log_metadata: ' (日志)' };
  const label = agent.model ? `${agent.model}${suffixes[agent.modelSource] ?? ''}` : '未知模型';
  const effortLabel = agent.reasoningEffort ? `${agent.reasoningEffort}${suffixes[agent.reasoningEffortSource] ?? ''}` : '推理强度未知';
  const modelDiffers = agent.configuredModel && agent.configuredModel !== agent.model;
  const effortDiffers = agent.configuredReasoningEffort && agent.configuredReasoningEffort !== agent.reasoningEffort;
  const configuration = modelDiffers || effortDiffers
    ? `配置: ${agent.configuredModel || '未知模型'}${agent.configuredReasoningEffort ? ` / ${agent.configuredReasoningEffort}` : ''}`
    : null;
  return { label, effortLabel, configuration };
}

export function phasePresentation(value) {
  return ({
    generating: '生成中', tools: '执行工具', working: 'Working', ready: 'Ready', error: '异常', unknown: '未知',
  })[value] ?? '未知';
}

export function dateGroup(timestamp, now = new Date()) {
  const date = new Date(timestamp);
  if (!Number.isFinite(date.getTime())) return '时间未知';
  const key = value => `${value.getFullYear()}-${String(value.getMonth() + 1).padStart(2, '0')}-${String(value.getDate()).padStart(2, '0')}`;
  if (key(date) === key(now)) return '今天';
  const yesterday = new Date(now);
  yesterday.setDate(yesterday.getDate() - 1);
  return key(date) === key(yesterday) ? '昨天' : key(date);
}

export class SnapshotHealth {
  constructor({ now = Date.now, maxAgeMs = 5000 } = {}) {
    this.now = now;
    this.maxAgeMs = maxAgeMs;
    this.snapshot = null;
    this.receivedAt = null;
    this.collectorAgeMs = 0;
    this.collectionState = 'scanning';
    this.lastQueryAt = null;
    this.reportedLastSuccessAt = null;
    this.issue = null;
  }

  accept(snapshot) {
    const collection = snapshot?.collection ?? {};
    this.collectionState = collection.state ?? 'unknown';
    this.lastQueryAt = typeof snapshot?.sampledAt === 'string' ? snapshot.sampledAt : null;
    this.reportedLastSuccessAt = typeof collection.lastSuccessAt === 'string' ? collection.lastSuccessAt : null;
    if (!['ready', 'empty'].includes(collection.state)) {
      this.issue = collection.state === 'paused' ? '采集已暂停, 可见时将恢复'
        : collection.state === 'scanning' ? '正在读取运行中的线程'
        : (Array.isArray(collection.warnings) && collection.warnings.length ? collection.warnings.join(' / ') : '采集器尚未完成成功采样');
      return false;
    }
    const collectedAt = typeof collection.lastSuccessAt === 'string' ? Date.parse(collection.lastSuccessAt) : NaN;
    const queriedAt = typeof snapshot.sampledAt === 'string' ? Date.parse(snapshot.sampledAt) : NaN;
    const totals = snapshot.totals;
    const validRates = ['outputTps', 'measuredTps', 'estimatedTps']
      .every(key => typeof totals?.[key] === 'number' && Number.isFinite(totals[key]) && totals[key] >= 0);
    if (!Number.isFinite(collectedAt) || !Number.isFinite(queriedAt) || !validRates) {
      this.issue = '成功采样时间或速率数据不完整';
      return false;
    }
    const age = Math.max(0, queriedAt - collectedAt);
    if (age > this.maxAgeMs) {
      this.issue = '采集器尚未产生新的成功样本';
      return false;
    }
    this.snapshot = snapshot;
    this.receivedAt = this.now();
    this.collectorAgeMs = age;
    this.issue = null;
    return true;
  }

  fail(error) {
    this.issue = error instanceof Error ? error.message : String(error || '读取失败');
  }

  inspect() {
    const ageMs = this.snapshot ? this.collectorAgeMs + Math.max(0, this.now() - this.receivedAt) : null;
    const expired = ageMs !== null && ageMs > this.maxAgeMs;
    return {
      kind: !this.snapshot ? 'pending' : this.issue || expired ? 'stale' : 'live',
      ageMs,
      lastSuccessAt: this.snapshot?.collection?.lastSuccessAt ?? null,
      querySampledAt: this.lastQueryAt,
      reportedLastSuccessAt: this.reportedLastSuccessAt,
      collectionState: this.collectionState,
      issue: this.issue || (expired ? '未收到新的成功采样' : null),
    };
  }
}

export class StableCounts {
  constructor({ now = () => performance.now(), settleMs = 500, maxWaitMs = 1000 } = {}) {
    this.now = now;
    this.settleMs = settleMs;
    this.maxWaitMs = maxWaitMs;
    this.value = null;
    this.key = null;
    this.pendingKey = null;
    this.pendingSince = null;
    this.firstChangeAt = null;
  }

  update(value) {
    const key = JSON.stringify(value), now = this.now();
    if (this.value === null || key === this.key) {
      if (this.value === null) { this.value = value; this.key = key; }
      this.pendingKey = null;
      this.firstChangeAt = null;
      return this.value;
    }
    if (this.firstChangeAt === null) this.firstChangeAt = now;
    if (key !== this.pendingKey) { this.pendingKey = key; this.pendingSince = now; }
    if (now - this.pendingSince >= this.settleMs || now - this.firstChangeAt >= this.maxWaitMs) {
      this.value = value;
      this.key = key;
      this.pendingKey = null;
      this.firstChangeAt = null;
    }
    return this.value;
  }
}

export class DisplayRates {
  constructor({ now = () => performance.now(), smoothingMs = 500, resetAfterMs = 5000 } = {}) {
    this.now = now;
    this.smoothingMs = smoothingMs;
    this.resetAfterMs = resetAfterMs;
    this.values = new Map();
  }

  read(id, rate, sample) {
    if (!rate || !['measuredTps', 'estimatedTps'].every(key => Number.isFinite(rate[key]) && rate[key] >= 0)) return null;
    const now = this.now(), previous = this.values.get(id);
    if (previous?.sample === sample) return previous.rate;
    const elapsed = previous ? Math.max(0, now - previous.at) : Infinity;
    const alpha = elapsed >= this.resetAfterMs ? 1 : 1 - Math.exp(-elapsed / this.smoothingMs);
    const measuredTps = previous ? previous.rate.measuredTps + alpha * (rate.measuredTps - previous.rate.measuredTps) : rate.measuredTps;
    const estimatedTps = previous ? previous.rate.estimatedTps + alpha * (rate.estimatedTps - previous.rate.estimatedTps) : rate.estimatedTps;
    const displayed = { measuredTps, estimatedTps, outputTps: measuredTps + estimatedTps };
    this.values.set(id, { sample, at: now, rate: displayed });
    return displayed;
  }
}

export function createVisiblePoller(task, {
  intervalMs = 250,
  now = () => performance.now(),
  setTimer = setTimeout,
  clearTimer = clearTimeout,
  onError = () => {},
} = {}) {
  let visible = false;
  let stopped = false;
  let timer = null;
  let pending = false;

  const run = async () => {
    if (!visible || stopped || pending) return;
    timer = null;
    pending = true;
    const startedAt = now();
    try {
      await task();
    } catch (error) {
      onError(error);
    } finally {
      pending = false;
      if (visible && !stopped) timer = setTimer(run, Math.max(0, intervalMs - (now() - startedAt)));
    }
  };

  return {
    setVisible(value) {
      const next = Boolean(value) && !stopped;
      if (next === visible) return;
      visible = next;
      if (timer !== null) {
        clearTimer(timer);
        timer = null;
      }
      if (visible) void run();
    },
    stop() {
      stopped = true;
      visible = false;
      if (timer !== null) clearTimer(timer);
      timer = null;
    },
  };
}
