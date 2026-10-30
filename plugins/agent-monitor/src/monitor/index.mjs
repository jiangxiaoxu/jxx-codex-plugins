import { createReadStream } from 'node:fs';
import { readdir, readFile, stat } from 'node:fs/promises';
import { hostname, homedir } from 'node:os';
import path from 'node:path';
import { RolloutParser, normalizeMode } from './parser.mjs';
import { MetricsStore, localDay } from './store.mjs';

const WINDOW_MS = 3000;
const HISTORY_MS = 300000;
const MAX_LINE_BYTES = 32 * 1024 * 1024;
const zeroTokens = () => ({ input: 0, cachedInput: 0, output: 0, reasoning: 0 });
const zeroRate = () => ({ measuredTps: 0, estimatedTps: 0, outputTps: 0 });
const date = ms => ms === null || ms === undefined ? null : new Date(ms).toISOString();
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
  constructor({ codexHome = process.env.CODEX_HOME || path.join(homedir(), '.codex'), stateDir = process.env.AGENT_MONITOR_STATE_DIR || path.join(homedir(), '.agent-monitor'), now = Date.now, diagnostics } = {}) {
    this.codexHome = path.resolve(codexHome);
    this.stateDir = path.resolve(stateDir);
    this.now = now;
    this.diagnostics = diagnostics;
    this.store = null;
    this.files = new Map();
    this.responses = new Map();
    this.tokens = new Map();
    this.estimates = new Map();
    this.names = new Map();
    this.indexFile = { offset: 0, buffer: Buffer.alloc(0), dropping: false, parser: { malformed: 0, apply: raw => {
      let entry;
      try { entry = JSON.parse(raw); } catch { return; }
      if (typeof entry.id !== 'string' || typeof entry.thread_name !== 'string') return;
      const updatedMs = Date.parse(entry.updated_at);
      if (!Number.isFinite(updatedMs)) return;
      const previous = this.names.get(entry.id);
      if (!previous || updatedMs >= previous.updatedMs) this.names.set(entry.id, { title: entry.thread_name, updatedMs });
    } } };
    this.warnings = new Set();
    this.collectionState = 'paused';
    this.lastSuccessAt = null;
    this.skippedCompressedFiles = 0;
    this.configuredMode = null;
    this.lastDiscovery = null;
    this.discovery = null;
    this.pendingFiles = null;
    this.pendingFileIndex = 0;
    this.running = false;
    this.continuous = false;
    this.activityDeadline = 0;
    this.closed = false;
    this.timer = null;
    this.refreshPromise = null;
    this.acceptedResponses = 0;
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
    const currentFile = this.pendingFiles?.[this.pendingFileIndex];
    this.diagnostics?.write('info', 'collection.pause', { files: this.files.size, pendingFiles: this.pendingFiles?.length ?? null, fileIndex: this.pendingFileIndex, file: currentFile ? path.basename(currentFile.path) : null, offset: currentFile?.offset ?? null, lastSuccessAt: this.lastSuccessAt });
  }

  schedule(delay = 1000) {
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
    if (!this.closed) { this.closed = true; this.store?.close(); }
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
      if (!this.pendingFiles) {
        if (!this.discovery && (this.lastDiscovery === null || now - this.lastDiscovery >= 10000)) {
          this.warnings.clear();
          await this.readConfig();
          this.discovery = { iterator: this.discoverRoots(), found: new Set(), skipped: 0 };
        }
        while (this.discovery) {
          if (this.running && !this.hasDemand()) { this.pause(); return; }
          const entry = await this.discovery.iterator.next();
          if (!entry.done) {
            if (entry.value.compressed) this.discovery.skipped++;
            else if (entry.value.path) this.discovery.found.add(entry.value.path);
            continue;
          }
          const found = this.discovery.found;
          const newFiles = [...found].filter(filePath => !this.files.has(filePath)).length;
          const removedFiles = [...this.files.keys()].filter(filePath => !found.has(filePath)).length;
          for (const filePath of found) if (!this.files.has(filePath)) this.files.set(filePath, this.newFile(filePath));
          for (const filePath of this.files.keys()) if (!found.has(filePath)) this.files.delete(filePath);
          this.skippedCompressedFiles = this.discovery.skipped;
          this.discovery = null;
          this.lastDiscovery = this.now();
          this.diagnostics?.write('info', 'collection.discovery', { files: found.size, newFiles, removedFiles, skippedCompressedFiles: this.skippedCompressedFiles, durationMs: Math.round(performance.now() - startedAt) });
        }
        this.pendingFiles = [...this.files.values()];
        this.pendingFileIndex = 0;
      }
      while (this.pendingFileIndex < this.pendingFiles.length) {
        if (this.running && !this.hasDemand()) { this.pause(); return; }
        const file = this.pendingFiles[this.pendingFileIndex];
        try {
          const changed = await this.readFile(file);
          if (changed === null) { this.pause(); return; }
          if (changed) changedFiles++;
        }
        catch (error) {
          if (error.code === 'ENOENT') this.files.delete(file.path);
          else {
            failedFiles++;
            this.warnings.add(`Unable to read ${path.basename(file.path)} (${error.code ?? 'invalid data'})`);
            this.diagnostics?.write('warn', 'collection.file_error', { file: path.basename(file.path), code: error.code, name: error.name, message: error.message, stack: error.stack });
          }
        }
        this.pendingFileIndex++;
      }
      if (this.running && !this.hasDemand()) { this.pause(); return; }
      if (!await this.readSessionIndex()) { this.pause(); return; }
      if (this.running && !this.hasDemand()) { this.pause(); return; }
      for (const [key, response] of this.responses) if (response.endMs < now - 1800000) this.responses.delete(key);
      const agents = this.agents();
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
      const measured = [...agents.values()].reduce((sum, agent) => sum + this.rate(agent, now).measuredTps, 0);
      this.store.peak(now, measured);
      this.collectionState = agents.size ? 'ready' : 'empty';
      this.lastSuccessAt = date(this.now());
      this.pendingFiles = null;
      this.pendingFileIndex = 0;
      if (initialScan || previousState === 'error') this.diagnostics?.write('info', initialScan ? 'collection.scan_complete' : 'collection.recovered', { durationMs: Math.round(performance.now() - startedAt), files: this.files.size, failedFiles, agents: agents.size, state: this.collectionState, lastSuccessAt: this.lastSuccessAt });
      this.diagnostics?.write('debug', 'collection.cycle', { durationMs: Math.round(performance.now() - startedAt), files: this.files.size, changedFiles, failedFiles, agents: agents.size, newResponses: this.acceptedResponses - responsesBefore, warnings: this.warnings.size, state: this.collectionState, lastSuccessAt: this.lastSuccessAt });
    } catch (error) {
      this.collectionState = 'error';
      this.pendingFiles = null;
      this.pendingFileIndex = 0;
      this.warnings.add(`Collection failed (${error.code ?? 'invalid data'})`);
      this.diagnostics?.write('error', 'collection.error', { durationMs: Math.round(performance.now() - startedAt), code: error.code, name: error.name, message: error.message, stack: error.stack, failedFiles, lastSuccessAt: this.lastSuccessAt });
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
    for (const file of this.files.values()) file.parser.mode.configured = this.configuredMode;
  }

  async readSessionIndex() {
    try {
      const indexPath = path.join(this.codexHome, 'session_index.jsonl');
      const info = await stat(indexPath);
      const file = this.indexFile;
      if (info.size < file.offset) { file.offset = 0; file.buffer = Buffer.alloc(0); this.names.clear(); }
      if (info.size > file.offset) {
        for await (const chunk of createReadStream(indexPath, { start: file.offset, end: info.size - 1 })) {
          if (this.running && !this.hasDemand()) return false;
          this.consume(file, chunk);
          file.offset += chunk.length;
        }
      }
    } catch (error) { if (error.code !== 'ENOENT') this.warnings.add('Unable to read session titles'); }
    return true;
  }

  async *discoverRoots() {
    for (const folder of ['sessions', 'archived_sessions']) yield* this.discover(path.join(this.codexHome, folder));
  }

  async *discover(folder) {
    let entries;
    try { entries = await readdir(folder, { withFileTypes: true }); }
    catch (error) { if (error.code !== 'ENOENT') this.warnings.add(`Unable to list ${path.basename(folder)} (${error.code ?? 'read error'})`); yield {}; return; }
    yield {};
    for (const entry of entries) {
      const fullPath = path.join(folder, entry.name);
      if (entry.isDirectory()) yield* this.discover(fullPath);
      else if (entry.name.endsWith('.zst')) yield { compressed: true };
      else if (entry.name.endsWith('.jsonl')) yield { path: fullPath };
      else yield {};
    }
  }

  newFile(filePath) {
    return { path: filePath, offset: 0, mtimeMs: null, ino: null, buffer: Buffer.alloc(0), dropping: false, parser: new RolloutParser(filePath, response => this.accept(response), this.configuredMode) };
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
    if (file.parser.malformed) {
      this.warnings.add(`Malformed log records skipped in ${path.basename(file.path)}`);
      this.diagnostics?.write('warn', 'collection.malformed_records', { file: path.basename(file.path), malformed: file.parser.malformed });
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
    for (const { parser } of this.files.values()) {
      if (parser.createdMs === null) continue;
      const previous = agents.get(parser.id);
      if (!previous || (parser.lastMs ?? 0) > (previous.lastMs ?? 0)) agents.set(parser.id, parser);
    }
    return agents;
  }

  phase(agent, now) {
    return ['generating', 'tools'].includes(agent.phase) && now - agent.lastMs > HISTORY_MS ? 'unknown' : agent.phase;
  }

  estimate(agent, now) {
    if (this.phase(agent, now) !== 'generating' || agent.pendingStartMs === null) return 0;
    const recent = [...this.responses.values()].filter(r => r.startMs !== null && r.endMs <= now && r.output > 0).sort((a, b) => b.endMs - a.endMs);
    let samples = recent.filter(r => r.agentId === agent.id && r.endMs >= now - 600000).slice(0, 3);
    if (!samples.length && agent.model) samples = recent.filter(r => r.model === agent.model && r.endMs >= now - 1800000).slice(0, 10);
    const duration = samples.reduce((n, r) => n + r.endMs - r.startMs, 0);
    const speed = duration > 0 ? samples.reduce((n, r) => n + r.output, 0) * 1000 / duration : 0;
    const share = Math.max(0, Math.min(WINDOW_MS, now - agent.pendingStartMs)) / WINDOW_MS;
    return speed * share;
  }

  rate(agent, now) {
    let measuredTps = 0;
    for (const response of this.responses.values()) if (response.agentId === agent.id) measuredTps += contribution(response, now - WINDOW_MS, now);
    const estimatedTps = this.estimate(agent, now);
    return { measuredTps, estimatedTps, outputTps: measuredTps + estimatedTps };
  }

  rootId(agent, agents) {
    const seen = new Set([agent.id]);
    let id = agent.id;
    let parentId = agent.parentId;
    while (parentId && !seen.has(parentId)) {
      id = parentId;
      seen.add(id);
      parentId = agents.get(id)?.parentId;
    }
    return id;
  }

  summarizeAgent(agent, agents, now) {
    const phase = this.phase(agent, now);
    return {
      id: agent.id, parentId: agent.parentId, rootThreadId: this.rootId(agent, agents), role: agent.isSubagent ? 'subagent' : 'main',
      name: agent.nickname ?? this.names.get(agent.id)?.title ?? agent.title ?? (agent.isSubagent ? `Agent ${agent.id.slice(0, 8)}` : `Thread ${agent.id.slice(0, 8)}`), model: agent.model,
      reasoningEffort: agent.reasoningEffort, phase, phaseSource: 'log', recencyAt: date(agent.lastMs),
      rate: this.rate(agent, now), tokens: this.tokens.get(agent.id) ?? zeroTokens(),
      mode: { ...agent.mode }, attention: phase === 'unknown' ? null : agent.attention,
    };
  }

  modelRates(agents, now) {
    const ids = new Set(agents.map(a => a.id));
    const rates = new Map();
    const add = (model, measured, estimated) => {
      const name = model || 'unknown';
      const previous = rates.get(name) ?? { model: name, measuredTps: 0, estimatedTps: 0, outputTps: 0 };
      rates.set(name, { model: name, measuredTps: previous.measuredTps + measured, estimatedTps: previous.estimatedTps + estimated, outputTps: previous.outputTps + measured + estimated });
    };
    for (const response of this.responses.values()) if (ids.has(response.agentId)) add(response.model, contribution(response, now - WINDOW_MS, now), 0);
    for (const agent of agents) add(agent.model, 0, this.estimate(agent, now));
    return [...rates.values()].sort((a, b) => b.outputTps - a.outputTps || a.model.localeCompare(b.model));
  }

  threads(agents, now) {
    const groups = new Map();
    for (const agent of agents.values()) {
      const id = this.rootId(agent, agents);
      if (!groups.has(id)) groups.set(id, []);
      groups.get(id).push(agent);
    }
    return [...groups].map(([id, members]) => {
      const main = agents.get(id);
      const summaries = members.map(a => this.summarizeAgent(a, agents, now));
      const phases = new Set(summaries.map(a => a.phase));
      const status = phases.has('generating') ? 'running' : phases.has('tools') ? 'tools' : phases.has('error') ? 'error' : phases.has('unknown') ? 'unknown' : 'completed';
      const attention = ['input', 'approval', 'error'].find(kind => summaries.some(a => a.attention === kind)) ?? null;
      const created = Math.min(...members.map(a => a.createdMs));
      const metadata = this.names.get(id);
      const updated = Math.max(metadata?.updatedMs ?? 0, main?.lastMs ?? Math.max(...members.map(a => a.lastMs)));
      return { id, title: metadata?.title ?? main?.title ?? `Thread ${id.slice(0, 8)}`, project: main?.project ?? members.find(a => a.project)?.project ?? null,
        createdAt: date(created), updatedAt: date(updated), recencyAt: date(updated), status, attention,
        rate: summaries.map(a => a.rate).reduce(sumRate, zeroRate()), tokens: summaries.map(a => a.tokens).reduce(sumTokens, zeroTokens()),
        agentCount: summaries.length, activeAgentCount: summaries.filter(a => ['generating', 'tools'].includes(a.phase)).length,
        modelRates: this.modelRates(members, now) };
    });
  }

  async getSnapshot({ limit = 10, cursor = null, order = 'priority', scope = 'all' } = {}) {
    const now = this.now();
    const agents = this.agents();
    const allThreads = this.threads(agents, now);
    const rank = t => t.attention ? 0 : ['running', 'tools'].includes(t.status) ? 2 : 3;
    const threads = allThreads.filter(t => scope === 'all' || ['running', 'tools'].includes(t.status)).sort((a, b) => (order === 'priority' ? rank(a) - rank(b) : 0) || Date.parse(b.recencyAt) - Date.parse(a.recencyAt) || a.id.localeCompare(b.id));
    const result = page(threads, limit, cursor, `${order}:${scope}`);
    const summaries = [...agents.values()].map(a => this.summarizeAgent(a, agents, now));
    const rate = summaries.map(a => a.rate).reduce(sumRate, zeroRate());
    return { schemaVersion: 1, sampledAt: date(now), hostName: hostname(), collection: { state: this.collectionState, lastSuccessAt: this.lastSuccessAt, skippedCompressedFiles: this.skippedCompressedFiles, warnings: [...this.warnings] },
      totals: { ...rate, ...(this.store?.today(now) ?? { inputTokens: 0, outputTokens: 0, reasoningTokens: 0 }), generatingCount: summaries.filter(a => a.phase === 'generating').length, toolCount: summaries.filter(a => a.phase === 'tools').length, threadCount: allThreads.length },
      models: this.modelRates([...agents.values()], now), threads: result.items, nextCursor: result.nextCursor };
  }

  async getThread({ threadId, limit = 20, cursor = null, scope = 'all' } = {}) {
    const now = this.now(), agents = this.agents();
    const thread = this.threads(agents, now).find(t => t.id === threadId);
    if (!thread) throw new Error('Thread not found');
    const members = [...agents.values()].filter(a => this.rootId(a, agents) === threadId).map(a => this.summarizeAgent(a, agents, now));
    const filtered = members.filter(a => a.id === threadId || scope === 'all' || (scope === 'completed' ? a.phase === 'completed' : ['generating', 'tools'].includes(a.phase)));
    filtered.sort((a, b) => Number(b.id === threadId) - Number(a.id === threadId) || Date.parse(b.recencyAt) - Date.parse(a.recencyAt) || a.id.localeCompare(b.id));
    const result = page(filtered, limit, cursor, `${threadId}:${scope}`);
    return { thread, agents: result.items, nextCursor: result.nextCursor, sampledAt: date(now) };
  }

  async getAgent({ agentId } = {}) {
    const now = this.now(), agents = this.agents(), agent = agents.get(agentId);
    if (!agent) throw new Error('Agent not found');
    const records = [...this.responses.values()].filter(r => r.agentId === agentId && r.endMs >= now - HISTORY_MS);
    const estimate = this.estimates.get(agentId);
    const history = Array.from({ length: 300 }, (_, index) => {
      const time = Math.floor(now / 1000) * 1000 - (299 - index) * 1000;
      const measuredTps = records.reduce((total, r) => total + contribution(r, time - 1000, time), 0);
      const estimatedTps = estimate?.points.get(time) ?? 0;
      return { time: date(time), measuredTps, estimatedTps, outputTps: measuredTps + estimatedTps };
    });
    return { agent: this.summarizeAgent(agent, agents, now), history, sampledAt: date(now) };
  }

  async getHistory({ from, to } = {}) {
    const now = this.now();
    const first = from ?? localDay(now - 6 * 86400000), last = to ?? localDay(now);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(first) || !/^\d{4}-\d{2}-\d{2}$/.test(last) || first > last) throw new Error('Invalid history date range');
    return { days: this.store?.history(first, last) ?? [], sampledAt: date(now) };
  }
}
