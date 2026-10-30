const runningStates = new Set(['generating', 'running', 'tools', 'tool', 'active']);

export function isRunning(item) {
  return runningStates.has(item?.status ?? item?.phase);
}

export function priorityRank(item) {
  if (['input', 'approval', 'error', 'waiting'].includes(item?.attention)) return 0;
  if (item?.attention === 'unread') return 1;
  return isRunning(item) ? 2 : 3;
}

export function recency(item) {
  const value = Date.parse(item?.recencyAt ?? item?.updatedAt ?? item?.createdAt ?? '');
  return Number.isFinite(value) ? value : 0;
}

export function compareThreads(a, b, order = 'priority') {
  return (order === 'priority' ? priorityRank(a) - priorityRank(b) : 0)
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
  constructor(order = 'priority') {
    this.order = order;
    this.items = [];
    this.groups = new Map();
  }

  reset(order = this.order) {
    this.order = order;
    this.items = [];
    this.groups.clear();
  }

  merge(incoming, options) {
    const ordered = [...incoming].sort((a, b) => compareThreads(a, b, this.order));
    this.items = mergeStableItems(this.items, ordered, options);
    const present = new Set(this.items.map(item => item.id));
    for (const id of this.groups.keys()) if (!present.has(id)) this.groups.delete(id);
    for (const item of ordered) {
      if (!this.groups.has(item.id)) {
        this.groups.set(item.id, this.order === 'priority' && priorityRank(item) < 3 ? 'priority' : 'recent');
      }
    }
    return this.items;
  }

  sections() {
    return {
      priority: this.items.filter(item => this.groups.get(item.id) === 'priority'),
      recent: this.items.filter(item => this.groups.get(item.id) !== 'priority'),
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

export function phasePresentation(value) {
  return ({
    generating: '生成中', running: '运行中', active: '运行中', tools: '执行工具', tool: '执行工具',
    waiting: '等待中', waiting_input: '等待输入', waiting_approval: '等待审批',
    idle: '空闲', completed: '已结束', error: '异常', unknown: '未知',
  })[value] ?? '未知';
}

export function threadPresentation(item) {
  return ({ input: '等待输入', approval: '等待审批', error: '异常', waiting: '等待回应', unread: '未读结果' })[item.attention]
    ?? phasePresentation(item.status);
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
        : collection.state === 'scanning' ? '采集器正在扫描日志'
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

export function createVisiblePoller(task, {
  intervalMs = 1000,
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
    pending = true;
    try {
      await task();
    } catch (error) {
      onError(error);
    } finally {
      pending = false;
      if (visible && !stopped) timer = setTimer(run, intervalMs);
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
