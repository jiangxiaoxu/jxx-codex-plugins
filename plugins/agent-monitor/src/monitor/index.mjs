import { createReadStream } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import { hostname, homedir } from 'node:os';
import path from 'node:path';
import { RolloutParser, normalizeMode } from './parser.mjs';
import { MetricsStore, localDay } from './store.mjs';
import { RuntimeClient } from './runtime.mjs';

const WINDOW_MS = 3000;
const HISTORY_MS = 300000;
const MAX_LINE_BYTES = 32 * 1024 * 1024;
const zeroTokens = () => ({ input: 0, cachedInput: 0, output: 0, reasoning: 0 });
const zeroRate = () => ({ measuredTps: 0, estimatedTps: 0, outputTps: 0 });
const date = ms => ms === null || ms === undefined ? null : new Date(ms).toISOString();
const runtimeMs = seconds => typeof seconds === 'number' && Number.isFinite(seconds) ? seconds * 1000 : null;
const sumRate = (a, b) => ({ measuredTps: a.measuredTps + b.measuredTps, estimatedTps: a.estimatedTps + b.estimatedTps, outputTps: a.outputTps + b.outputTps });
const sumTokens = (a, b) => ({ input: a.input + b.input, cachedInput: a.cachedInput + b.cachedInput, output: a.output + b.output, reasoning: a.reasoning + b.reasoning });

function contribution(response, start, end) {
  if (response.startMs === null || response.startMs === undefined) return 0;
  const overlap = Math.min(response.endMs, end) - Math.max(response.startMs, start);
  return overlap > 0 ? response.output * overlap / (response.endMs - response.startMs) * 1000 / (end - start) : 0;
}

function page(items, limit, cursor, context) {
  if (!Number.isInteger(limit) || limit < 1 || limit > 200) throw new RangeError('limit must be between 1 and 200');
  let offset = 0;
  if (cursor !== null && cursor !== undefined) {
    try {
      const decoded = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
      if (decoded.context !== context || !Number.isInteger(decoded.offset) || decoded.offset < 0) throw new Error();
      offset = decoded.offset;
    } catch { throw new Error('Invalid monitor cursor'); }
  }
  const nextOffset = offset + limit;
  return { items: items.slice(offset, nextOffset), nextCursor: nextOffset < items.length ? Buffer.from(JSON.stringify({ offset: nextOffset, context })).toString('base64url') : null };
}

export class Monitor {
  constructor({ codexHome = process.env.CODEX_HOME || path.join(homedir(), '.codex'), stateDir = process.env.AGENT_MONITOR_STATE_DIR || path.join(homedir(), '.agent-monitor'), now = Date.now, diagnostics, runtime } = {}) {
    this.codexHome = path.resolve(codexHome);
    this.stateDir = path.resolve(stateDir);
    this.now = now;
    this.diagnostics = diagnostics;
    this.runtime = runtime ?? new RuntimeClient({ codexHome: this.codexHome, diagnostics });
    this.store = null;
    this.files = new Map();
    this.readers = new Map();
    this.responses = new Map();
    this.tokens = new Map();
    this.estimates = new Map();
    this.catalog = new Map();
    this.published = { agents: new Map(), responses: new Map(), tokens: new Map(), estimates: new Map(), catalog: new Map(), today: { inputTokens: 0, outputTokens: 0, reasoningTokens: 0 }, skippedCompressedFiles: 0, skippedUnavailableThreads: 0, excluded: {} };
    this.warnings = new Set();
    this.collectionState = 'paused';
    this.lastSuccessAt = null;
    this.skippedCompressedFiles = 0;
    this.skippedUnavailableThreads = 0;
    this.configuredMode = null;
    this.lastConfigRead = null;
    this.pendingFiles = null;
    this.pendingFileIndex = 0;
    this.running = false;
    this.continuous = false;
    this.activityDeadline = 0;
    this.closed = false;
    this.timer = null;
    this.refreshPromise = null;
    this.acceptedResponses = 0;
    this.lastError = null;
  }

  async start() {
    if (this.closed) return;
    this.continuous = true;
    clearTimeout(this.timer);
    this.running = true;
    this.collectionState = 'scanning';
    this.diagnostics?.write('info', 'collection.start', { state: this.collectionState });
    await this.refresh();
    this.schedule();
  }

  activate() {
    if (this.closed) return;
    this.activityDeadline = this.now() + 5000;
    if (this.running) return;
    this.running = true;
    this.collectionState = 'scanning';
    this.diagnostics?.write('info', 'collection.activate', { initialized: this.store !== null });
    this.schedule(0);
  }

  hasDemand() {
    return this.continuous || this.now() < this.activityDeadline;
  }

  pause() {
    this.running = false;
    this.continuous = false;
    this.activityDeadline = 0;
    clearTimeout(this.timer);
    this.collectionState = 'paused';
    this.runtime.close();
    const currentFile = this.pendingFiles?.[this.pendingFileIndex];
    this.diagnostics?.write('info', 'collection.pause', { files: this.files.size, pendingFiles: this.pendingFiles?.length ?? null, fileIndex: this.pendingFileIndex, file: currentFile ? path.basename(currentFile.path) : null, offset: currentFile?.offset ?? null, lastSuccessAt: this.lastSuccessAt });
  }

  schedule(delay = 250) {
    if (!this.running || this.closed) return;
    this.timer = setTimeout(async () => {
      if (!this.running || this.closed) return;
      if (!this.hasDemand()) { this.pause(); return; }
      try { await this.refresh(); }
      finally {
        if (!this.closed && this.hasDemand()) this.schedule();
        else if (!this.closed) this.pause();
      }
    }, delay);
    this.timer.unref?.();
  }

  async stop() {
    this.running = false;
    clearTimeout(this.timer);
    if (this.refreshPromise) await this.refreshPromise;
    if (!this.closed) { this.closed = true; this.runtime.close(); this.store?.close(); }
    this.diagnostics?.write('info', 'collection.stop', { files: this.files.size });
  }

  async refresh() {
    if (this.closed) return;
    if (this.refreshPromise) return this.refreshPromise;
    this.refreshPromise = this.readChanges();
    try { await this.refreshPromise; } finally { this.refreshPromise = null; }
  }

  async readChanges() {
    const now = this.now();
    const startedAt = performance.now();
    const responsesBefore = this.acceptedResponses;
    const previousState = this.collectionState;
    const initialScan = this.lastSuccessAt === null;
    let changedFiles = 0;
    let failedFiles = 0;
    try {
      if (!this.store) {
        const store = new MetricsStore(this.stateDir);
        try {
          const tokens = store.agentTotals();
          const responses = store.recent(now - 1800000);
          this.store = store;
          this.tokens = tokens;
          for (const response of responses) this.responses.set(response.key, response);
        } catch (error) { store.close(); throw error; }
      }
      const threads = await this.runtime.list();
      if (this.running && !this.hasDemand()) { this.pause(); return; }
      this.warnings.clear();
      if (this.lastConfigRead === null || now - this.lastConfigRead >= 10000) {
        await this.readConfig();
        this.lastConfigRead = now;
      }
      this.catalog = new Map(threads.map(thread => [thread.id, thread]));
      const files = new Map();
      const readers = new Map();
      const { missingMetadata = 0, missingLog = 0, unsupportedPath = 0 } = this.runtime.exclusions ?? {};
      let skippedCompressed = this.runtime.skippedCompressedFiles ?? 0, skippedUnavailable = missingMetadata + missingLog + unsupportedPath;
      for (const thread of threads) {
        const activity = thread.status?.type === 'idle' ? 'ready' : thread.status?.type === 'active' && !thread.status.activeFlags?.some(flag => ['waitingOnApproval', 'waitingOnUserInput'].includes(flag)) ? 'working' : null;
        if (thread.status?.type === 'notLoaded') continue;
        if (typeof thread.path !== 'string' || !thread.path) { skippedUnavailable++; continue; }
        if (thread.path.endsWith('.zst')) { skippedCompressed++; continue; }
        if (!thread.path.endsWith('.jsonl')) { skippedUnavailable++; continue; }
        const filePath = path.resolve(thread.path);
        const file = this.readers.get(filePath) ?? this.newFile(filePath);
        file.runtime = thread;
        file.activity = activity;
        file.parser.mode.configured = this.configuredMode;
        readers.set(filePath, file);
        if (activity) files.set(filePath, file);
      }
      const newFiles = [...files.keys()].filter(filePath => !this.files.has(filePath)).length;
      const removedFiles = [...this.files.keys()].filter(filePath => !files.has(filePath)).length;
      this.files = files;
      this.readers = readers;
      const loadedIds = new Set([...readers.values()].map(file => file.runtime.id));
      for (const id of this.estimates.keys()) if (!loadedIds.has(id)) this.estimates.delete(id);
      this.skippedCompressedFiles = skippedCompressed;
      this.skippedUnavailableThreads = skippedUnavailable;
      this.pendingFiles = [...files.values()];
      this.pendingFileIndex = 0;
      if (initialScan || newFiles || removedFiles) this.diagnostics?.write('info', 'collection.candidates', { loadedThreads: threads.length, files: files.size, newFiles, removedFiles, skippedCompressedFiles: skippedCompressed, skippedUnavailableThreads: skippedUnavailable });
      while (this.pendingFileIndex < this.pendingFiles.length) {
        if (this.running && !this.hasDemand()) { this.pause(); return; }
        const file = this.pendingFiles[this.pendingFileIndex];
        try {
          const changed = await this.readFile(file);
          if (changed === null) { this.pause(); return; }
          if (changed) changedFiles++;
          file.lastError = null;
          if (file.parser.malformed) this.warnings.add(`Malformed log records skipped in ${path.basename(file.path)}`);
        }
        catch (error) {
          if (error.code === 'ENOENT') {
            this.files.delete(file.path);
            this.readers.delete(file.path);
            try { await stat(`${file.path}.zst`); this.skippedCompressedFiles++; }
            catch (compressedError) {
              if (compressedError.code !== 'ENOENT') throw compressedError;
              this.skippedUnavailableThreads++;
            }
          }
          else {
            failedFiles++;
            this.warnings.add(`Unable to read ${path.basename(file.path)} (${error.code ?? 'invalid data'})`);
            const errorKey = `${error.code ?? error.name}:${error.message}`;
            this.diagnostics?.write(file.lastError === errorKey ? 'debug' : 'warn', 'collection.file_error', { file: path.basename(file.path), code: error.code, name: error.name, message: error.message, stack: error.stack });
            file.lastError = errorKey;
          }
        }
        this.pendingFileIndex++;
      }
      if (this.running && !this.hasDemand()) { this.pause(); return; }
      if (failedFiles) throw Object.assign(new Error('Some monitored rollouts could not be read'), { code: 'ROLLOUT_READ_FAILED' });
      this.runtime.assertConnected?.();
      for (const [key, response] of this.responses) if (response.endMs < now - 1800000) this.responses.delete(key);
      const agents = this.agents();
      const measured = [...agents.values()].reduce((sum, agent) => sum + this.rate(agent, now).measuredTps, 0);
      this.store.peak(now, measured);
      const today = this.store.today(now);
      const lastSuccessAt = date(this.now());
      // Publish only after every awaited read and fallible source/store check.
      // Queries keep the previous complete view while collection is in progress.
      for (const agent of agents.values()) {
        const phase = this.phase(agent, now);
        let bins = this.estimates.get(agent.id);
        if (phase !== 'generating') continue;
        if (!bins || bins.startMs !== agent.pendingStartMs) {
          bins = { startMs: agent.pendingStartMs, points: new Map() };
          this.estimates.set(agent.id, bins);
        }
        const estimate = this.estimate(agent, now);
        bins.points.set(Math.floor(now / 1000) * 1000, estimate);
        for (const time of bins.points.keys()) if (time < now - HISTORY_MS) bins.points.delete(time);
      }
      this.published = {
        agents: new Map([...agents].map(([id, agent]) => [id, { ...agent, mode: { ...agent.mode } }])),
        responses: new Map(this.responses),
        tokens: new Map([...agents.keys()].map(id => [id, this.tokens.get(id) ?? zeroTokens()])),
        estimates: new Map(this.estimates),
        catalog: new Map([...this.catalog].map(([id, thread]) => [id, { name: thread.name, parentThreadId: thread.parentThreadId, recencyAt: thread.recencyAt, updatedAt: thread.updatedAt }])),
        today, skippedCompressedFiles: this.skippedCompressedFiles, skippedUnavailableThreads: this.skippedUnavailableThreads, excluded: { ...this.runtime.exclusions },
      };
      this.collectionState = agents.size ? 'ready' : 'empty';
      this.lastSuccessAt = lastSuccessAt;
      this.lastError = null;
      this.pendingFiles = null;
      this.pendingFileIndex = 0;
      if (initialScan || previousState === 'error') this.diagnostics?.write('info', initialScan ? 'collection.scan_complete' : 'collection.recovered', { durationMs: Math.round(performance.now() - startedAt), files: this.files.size, failedFiles, agents: agents.size, state: this.collectionState, lastSuccessAt: this.lastSuccessAt });
      this.diagnostics?.write('debug', 'collection.cycle', { durationMs: Math.round(performance.now() - startedAt), files: this.files.size, changedFiles, failedFiles, agents: agents.size, newResponses: this.acceptedResponses - responsesBefore, warnings: this.warnings.size, state: this.collectionState, lastSuccessAt: this.lastSuccessAt });
    } catch (error) {
      this.collectionState = 'error';
      this.pendingFiles = null;
      this.pendingFileIndex = 0;
      this.warnings.add(`Collection failed (${error.code ?? 'invalid data'})`);
      const errorKey = `${error.code ?? error.name}:${error.message}`;
      this.diagnostics?.write(this.lastError === errorKey ? 'debug' : 'error', 'collection.error', { durationMs: Math.round(performance.now() - startedAt), code: error.code, name: error.name, message: error.message, stack: error.stack, failedFiles, lastSuccessAt: this.lastSuccessAt });
      this.lastError = errorKey;
    }
  }

  async readConfig() {
    this.configuredMode = null;
    try {
      const source = await readFile(path.join(this.codexHome, 'config.toml'), 'utf8');
      const root = source.split(/^\s*\[/m)[0];
      const match = root.match(/^\s*service_tier\s*=\s*(["'])([A-Za-z0-9._:-]+)\1\s*(?:#.*)?$/m);
      this.configuredMode = normalizeMode(match?.[2]);
    } catch (error) { if (error.code !== 'ENOENT') this.warnings.add('Unable to read Codex default mode'); }
    for (const file of this.readers.values()) file.parser.mode.configured = this.configuredMode;
  }

  newFile(filePath) {
    return { path: filePath, offset: 0, mtimeMs: null, ino: null, buffer: Buffer.alloc(0), dropping: false, malformedReported: 0, lastError: null, parser: new RolloutParser(filePath, response => this.accept(response), this.configuredMode) };
  }

  async readFile(file) {
    const startedAt = performance.now();
    const info = await stat(file.path);
    if (info.size === file.offset && info.mtimeMs === file.mtimeMs) return false;
    if (info.size <= file.offset || (file.ino !== null && info.ino !== file.ino)) Object.assign(file, this.newFile(file.path));
    const startOffset = file.offset;
    file.ino = info.ino;
    if (info.size > file.offset) {
      const stream = createReadStream(file.path, { start: file.offset, end: info.size - 1 });
      for await (const chunk of stream) {
        if (this.running && !this.hasDemand()) return null;
        const buffer = file.buffer;
        const dropping = file.dropping;
        try { this.consume(file, chunk); }
        catch (error) { file.buffer = buffer; file.dropping = dropping; throw error; }
        file.offset += chunk.length;
      }
    }
    file.mtimeMs = info.mtimeMs;
    file.ino = info.ino;
    this.diagnostics?.write('debug', 'collection.file_read', { file: path.basename(file.path), bytes: info.size - startOffset, durationMs: Math.round(performance.now() - startedAt) });
    if (file.parser.malformed > file.malformedReported) {
      this.diagnostics?.write('warn', 'collection.malformed_records', { file: path.basename(file.path), malformed: file.parser.malformed });
      file.malformedReported = file.parser.malformed;
    }
    return true;
  }

  consume(file, chunk) {
    let bytes = file.buffer.length ? Buffer.concat([file.buffer, chunk]) : chunk;
    file.buffer = Buffer.alloc(0);
    let start = 0;
    for (let end = bytes.indexOf(10); end !== -1; end = bytes.indexOf(10, start)) {
      const length = end - start;
      if (!file.dropping && length <= MAX_LINE_BYTES && length > 0) file.parser.apply(bytes.subarray(start, end).toString('utf8'));
      else if (length > MAX_LINE_BYTES) file.parser.malformed++;
      file.dropping = false;
      start = end + 1;
    }
    bytes = bytes.subarray(start);
    if (bytes.length > MAX_LINE_BYTES) { file.dropping = true; file.parser.malformed++; }
    else if (!file.dropping) file.buffer = Buffer.from(bytes);
  }

  accept(response) {
    const inserted = this.store.add(response);
    if (!inserted && this.store.owner(response.key) !== response.agentId) return false;
    if (inserted) {
      this.tokens.set(response.agentId, sumTokens(this.tokens.get(response.agentId) ?? zeroTokens(), response.tokens));
      this.acceptedResponses++;
    }
    if (inserted && response.endMs >= this.now() - 1800000) this.responses.set(response.key, { ...response, output: response.tokens.output });
    this.estimates.delete(response.agentId);
    return true;
  }

  agents() {
    const agents = new Map();
    for (const { parser, runtime, activity } of this.files.values()) {
      if (parser.createdMs === null) continue;
      const previous = agents.get(parser.id);
      if (!previous || (parser.lastMs ?? 0) > (previous.lastMs ?? 0)) agents.set(parser.id, {
        ...parser, activity,
        sessionId: typeof runtime.sessionId === 'string' && runtime.sessionId.trim() ? runtime.sessionId : null,
        parentId: runtime.parentThreadId ?? parser.parentId,
        isSubagent: !!(runtime.parentThreadId ?? parser.parentId) || parser.isSubagent,
        title: runtime.name || null,
        nickname: runtime.agentNickname ?? parser.nickname,
        model: activity === 'working' && parser.turnModel ? parser.turnModel : runtime.model ?? parser.model,
        modelSource: activity === 'working' && parser.turnModel ? 'turn_context' : runtime.model ? 'runtime_config' : parser.model ? 'log_metadata' : 'unknown',
        configuredModel: runtime.model ?? null,
        reasoningEffort: activity === 'working' && parser.turnReasoningEffort ? parser.turnReasoningEffort : runtime.reasoningEffort ?? parser.reasoningEffort,
        reasoningEffortSource: activity === 'working' && parser.turnReasoningEffort ? 'turn_context' : runtime.reasoningEffort ? 'runtime_config' : parser.reasoningEffort ? 'log_metadata' : 'unknown',
        configuredReasoningEffort: runtime.reasoningEffort ?? null,
        recencyMs: runtimeMs(runtime.recencyAt) ?? runtimeMs(runtime.updatedAt) ?? parser.createdMs,
        updatedMs: runtimeMs(runtime.updatedAt) ?? parser.createdMs,
      });
    }
    return agents;
  }

  phase(agent, now) {
    if (agent.activity === 'ready') return 'ready';
    if (!['generating', 'tools', 'unknown'].includes(agent.phase)) return 'working';
    return ['generating', 'tools'].includes(agent.phase) && now - agent.lastMs > HISTORY_MS ? 'unknown' : agent.phase;
  }

  estimate(agent, now, view = this) {
    if (this.phase(agent, now) !== 'generating' || agent.pendingStartMs === null || !agent.turnModel) return 0;
    const recent = [...view.responses.values()].filter(r => r.startMs !== null && r.endMs <= now && r.output > 0).sort((a, b) => b.endMs - a.endMs);
    let samples = recent.filter(r => r.agentId === agent.id && r.model === agent.model && r.endMs >= now - 600000).slice(0, 3);
    if (!samples.length) samples = recent.filter(r => r.model === agent.model && r.endMs >= now - 1800000).slice(0, 10);
    const duration = samples.reduce((n, r) => n + r.endMs - r.startMs, 0);
    const speed = duration > 0 ? samples.reduce((n, r) => n + r.output, 0) * 1000 / duration : 0;
    const share = Math.max(0, Math.min(WINDOW_MS, now - agent.pendingStartMs)) / WINDOW_MS;
    return speed * share;
  }

  rate(agent, now, view = this) {
    let measuredTps = 0;
    for (const response of view.responses.values()) if (response.agentId === agent.id) measuredTps += contribution(response, now - WINDOW_MS, now);
    const estimatedTps = this.estimate(agent, now, view);
    return { measuredTps, estimatedTps, outputTps: measuredTps + estimatedTps };
  }

  rootId(agent, agents, view = this) {
    if (agent.sessionId) return agent.sessionId;
    const seen = new Set([agent.id]);
    let id = agent.id;
    let parentId = agent.parentId;
    while (parentId && !seen.has(parentId)) {
      id = parentId;
      seen.add(id);
      parentId = agents.get(id)?.parentId ?? view.catalog.get(id)?.parentThreadId;
    }
    return id;
  }

  summarizeAgent(agent, agents, now, view = this) {
    const phase = this.phase(agent, now);
    return {
      id: agent.id, parentId: agent.parentId, rootThreadId: this.rootId(agent, agents, view), role: agent.isSubagent ? 'subagent' : 'main',
      name: agent.nickname ?? agent.title ?? (agent.isSubagent ? `Agent ${agent.id.slice(0, 8)}` : `Thread ${agent.id.slice(0, 8)}`), model: agent.model,
      reasoningEffort: agent.reasoningEffort, activity: agent.activity, phase, phaseSource: ['working', 'ready'].includes(phase) ? 'runtime' : 'log', recencyAt: date(agent.recencyMs),
      modelSource: agent.modelSource, configuredModel: agent.configuredModel, configuredReasoningEffort: agent.configuredReasoningEffort, reasoningEffortSource: agent.reasoningEffortSource,
      rate: this.rate(agent, now, view), tokens: view.tokens.get(agent.id) ?? zeroTokens(),
      mode: { ...agent.mode }, attention: null,
    };
  }

  modelRates(agents, now, view = this) {
    const ids = new Set(agents.map(a => a.id));
    const rates = new Map();
    const add = (model, measured, estimated) => {
      const name = model || 'unknown';
      const previous = rates.get(name) ?? { model: name, measuredTps: 0, estimatedTps: 0, outputTps: 0 };
      rates.set(name, { model: name, measuredTps: previous.measuredTps + measured, estimatedTps: previous.estimatedTps + estimated, outputTps: previous.outputTps + measured + estimated });
    };
    for (const response of view.responses.values()) if (ids.has(response.agentId)) add(response.model, contribution(response, now - WINDOW_MS, now), 0);
    for (const agent of agents) add(agent.model, 0, this.estimate(agent, now, view));
    return [...rates.values()].sort((a, b) => b.outputTps - a.outputTps || a.model.localeCompare(b.model));
  }

  threads(agents, now, view = this) {
    const groups = new Map();
    for (const agent of agents.values()) {
      const id = this.rootId(agent, agents, view);
      if (!groups.has(id)) groups.set(id, []);
      groups.get(id).push(agent);
    }
    return [...groups].map(([id, members]) => {
      const main = agents.get(id);
      const summaries = members.map(a => this.summarizeAgent(a, agents, now, view));
      const status = summaries.some(a => a.activity === 'working') ? 'working' : 'ready';
      const created = Math.min(...members.map(a => a.createdMs));
      const metadata = view.catalog.get(id);
      const updated = main?.updatedMs ?? runtimeMs(metadata?.updatedAt) ?? Math.max(...members.map(a => a.updatedMs));
      const recency = main?.recencyMs ?? runtimeMs(metadata?.recencyAt) ?? Math.max(...members.map(a => a.recencyMs));
      return { id, title: metadata?.name || main?.title || `Thread ${id.slice(0, 8)}`, project: main?.project ?? members.find(a => a.project)?.project ?? null,
        createdAt: date(created), updatedAt: date(updated), recencyAt: date(recency), status, attention: null,
        rate: summaries.map(a => a.rate).reduce(sumRate, zeroRate()), tokens: summaries.map(a => a.tokens).reduce(sumTokens, zeroTokens()),
        agentCount: summaries.length, activeAgentCount: summaries.filter(a => a.activity === 'working').length,
        modelRates: this.modelRates(members, now, view) };
    });
  }

  async getSnapshot({ limit = 10, cursor = null, order = 'recent', scope = 'all' } = {}) {
    const now = this.now(), view = this.published, agents = view.agents;
    const allThreads = this.threads(agents, now, view);
    const threads = allThreads.filter(t => scope === 'all' || t.status === scope).sort((a, b) => (order === 'priority' ? Number(b.status === 'working') - Number(a.status === 'working') : 0) || Date.parse(b.recencyAt) - Date.parse(a.recencyAt) || a.id.localeCompare(b.id));
    const result = page(threads, limit, cursor, `${order}:${scope}`);
    const summaries = [...agents.values()].map(a => this.summarizeAgent(a, agents, now, view));
    const rate = summaries.map(a => a.rate).reduce(sumRate, zeroRate());
    return { schemaVersion: 1, sampledAt: date(now), hostName: hostname(), collection: { state: this.collectionState, source: 'app-server', coverage: 'sampled', historyComplete: false, lastSuccessAt: this.lastSuccessAt, skippedCompressedFiles: view.skippedCompressedFiles, skippedUnavailableThreads: view.skippedUnavailableThreads, excluded: { ...view.excluded }, warnings: [...this.warnings] },
      totals: { ...rate, ...view.today, generatingCount: summaries.filter(a => a.phase === 'generating').length, toolCount: summaries.filter(a => a.phase === 'tools').length, threadCount: allThreads.length, workingThreadCount: allThreads.filter(thread => thread.status === 'working').length, readyThreadCount: allThreads.filter(thread => thread.status === 'ready').length },
      models: this.modelRates([...agents.values()], now, view), threads: result.items, nextCursor: result.nextCursor };
  }

  async getThread({ threadId, limit = 20, cursor = null, scope = 'all' } = {}) {
    const now = this.now(), view = this.published, agents = view.agents;
    const thread = this.threads(agents, now, view).find(t => t.id === threadId);
    if (!thread) return { thread: null, agents: [], nextCursor: null, coverage: 'sampled', historyComplete: false, sampledAt: date(now) };
    const members = [...agents.values()].filter(a => this.rootId(a, agents, view) === threadId).map(a => this.summarizeAgent(a, agents, now, view));
    const filtered = members.filter(a => a.id === threadId || scope === 'all' || a.activity === scope);
    filtered.sort((a, b) => Number(b.id === threadId) - Number(a.id === threadId) || Date.parse(b.recencyAt) - Date.parse(a.recencyAt) || a.id.localeCompare(b.id));
    const result = page(filtered, limit, cursor, `${threadId}:${scope}`);
    return { thread, agents: result.items, nextCursor: result.nextCursor, coverage: 'sampled', historyComplete: false, sampledAt: date(now) };
  }

  async getAgent({ agentId } = {}) {
    const now = this.now(), view = this.published, agents = view.agents, agent = agents.get(agentId);
    if (!agent) return { agent: null, history: [], coverage: 'sampled', historyComplete: false, sampledAt: date(now) };
    const records = [...view.responses.values()].filter(r => r.agentId === agentId && r.endMs >= now - HISTORY_MS);
    const estimate = view.estimates.get(agentId);
    const history = Array.from({ length: 300 }, (_, index) => {
      const time = Math.floor(now / 1000) * 1000 - (299 - index) * 1000;
      const measuredTps = records.reduce((total, r) => total + contribution(r, time - 1000, time), 0);
      const estimatedTps = estimate?.points.get(time) ?? 0;
      return { time: date(time), measuredTps, estimatedTps, outputTps: measuredTps + estimatedTps };
    });
    return { agent: this.summarizeAgent(agent, agents, now, view), history, coverage: 'sampled', historyComplete: false, sampledAt: date(now) };
  }

  async getHistory({ from, to } = {}) {
    const now = this.now();
    const first = from ?? localDay(now - 6 * 86400000), last = to ?? localDay(now);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(first) || !/^\d{4}-\d{2}-\d{2}$/.test(last) || first > last) throw new Error('Invalid history date range');
    return { days: this.store?.history(first, last) ?? [], coverage: 'sampled', historyComplete: false, sampledAt: date(now) };
  }
}
