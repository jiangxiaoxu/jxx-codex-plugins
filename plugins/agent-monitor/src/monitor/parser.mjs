import path from 'node:path';

const MAX_TOKENS = Number.MAX_SAFE_INTEGER;
const tokenFields = ['input_tokens', 'cached_input_tokens', 'output_tokens', 'reasoning_output_tokens', 'total_tokens'];

export function tokenCount(value) {
  return typeof value === 'number' && Number.isFinite(value) ? Math.min(MAX_TOKENS, Math.max(0, Math.trunc(value))) : 0;
}

export function normalizeTokens(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || !tokenFields.some(key => typeof value[key] === 'number' && Number.isFinite(value[key]))) return null;
  return { input: tokenCount(value.input_tokens), cachedInput: tokenCount(value.cached_input_tokens), output: tokenCount(value.output_tokens), reasoning: tokenCount(value.reasoning_output_tokens) };
}

export function normalizeMode(value) {
  if (typeof value !== 'string' || !value.trim()) return null;
  return ({ default: 'standard', priority: 'fast' })[value] ?? value;
}

function ordinal(raw, key) {
  const match = raw.match(new RegExp(`"${key}"\\s*:\\s*(0|[1-9][0-9]*)(?=\\s*[,}])`));
  if (!match) return null;
  const value = BigInt(match[1]);
  return value <= 9223372036854775807n ? value : null;
}

function projectName(cwd) {
  if (typeof cwd !== 'string') return null;
  return cwd.includes('\\') ? path.win32.basename(cwd) : path.basename(cwd);
}

export class RolloutParser {
  constructor(filePath, onResponse, configuredMode = null) {
    this.filePath = filePath;
    this.onResponse = onResponse;
    this.id = filePath;
    this.parentId = null;
    this.isSubagent = false;
    this.title = null;
    this.nickname = null;
    this.project = null;
    this.model = null;
    this.reasoningEffort = null;
    this.turnModel = null;
    this.turnReasoningEffort = null;
    this.sessionMode = null;
    this.turnMode = null;
    this.agentPath = '/root';
    this.createdMs = null;
    this.lastMs = null;
    this.phase = 'unknown';
    this.attention = null;
    this.pendingStartMs = null;
    this.streaming = false;
    this.modern = false;
    this.previousLegacy = null;
    this.startOrdinal = null;
    this.seenKeys = new Set();
    this.malformed = 0;
    this.mode = { configured: configuredMode, selected: null, recorded: null, served: null, evidence: null };
  }

  apply(raw) {
    let row;
    try { row = JSON.parse(raw); } catch { this.malformed++; return; }
    if (!row || typeof row !== 'object' || Array.isArray(row)) return;
    const ts = Date.parse(row.timestamp);
    if (!Number.isFinite(ts)) return;
    const p = row.payload;
    if (!p || typeof p !== 'object' || Array.isArray(p)) return;
    if (row.type === 'session_meta') {
      if (this.createdMs !== null) return;
      this.createdMs = ts;
      this.lastMs = ts;
      this.startOrdinal = Object.hasOwn(p, 'subagent_history_start_ordinal') ? ordinal(raw, 'subagent_history_start_ordinal') : null;
      this.id = typeof p.id === 'string' && p.id ? p.id : this.filePath;
      const spawn = p.source?.subagent?.thread_spawn ?? p.source?.subagent?.spawn;
      this.parentId = typeof p.parent_thread_id === 'string' ? p.parent_thread_id : typeof spawn?.parent_thread_id === 'string' ? spawn.parent_thread_id : null;
      this.isSubagent = !!this.parentId || p.thread_source === 'subagent' || p.source?.subagent != null;
      this.agentPath = p.agent_path ?? spawn?.agent_path ?? '/root';
      this.nickname = typeof p.agent_nickname === 'string' ? p.agent_nickname : typeof spawn?.agent_nickname === 'string' ? spawn.agent_nickname : null;
      this.title = typeof p.title === 'string' && p.title.trim() ? p.title : null;
      this.project = projectName(p.cwd);
      this.model = typeof p.model === 'string' ? p.model : null;
      return;
    }
    if (this.createdMs !== null && ts < this.createdMs - 2000) return;
    const ownOrdinal = Object.hasOwn(row, 'ordinal') ? ordinal(raw, 'ordinal') : null;
    if (this.startOrdinal !== null && ownOrdinal !== null && ownOrdinal < this.startOrdinal) return;
    this.lastMs = Math.max(this.lastMs ?? ts, ts);
    if (row.type === 'turn_context') {
      this.mode.recorded = null;
      this.turnModel = typeof p.model === 'string' ? p.model : null;
      if (typeof p.model === 'string') this.model = p.model;
      if (typeof p.cwd === 'string') this.project = projectName(p.cwd);
      const effort = p.effort ?? p.reasoning_effort ?? p.collaboration_mode?.settings?.reasoning_effort;
      this.turnReasoningEffort = typeof effort === 'string' ? effort : null;
      if (typeof effort === 'string') this.reasoningEffort = effort;
      this.turnMode = normalizeMode(p.service_tier);
      this.mode.selected = this.turnMode ?? this.sessionMode;
      this.mode.evidence = this.turnMode ? 'turn_context' : this.sessionMode ? 'thread_settings_applied' : null;
      return;
    }
    if (row.type === 'token_usage_record') {
      const tokens = normalizeTokens(p.usage);
      if (!tokens) { this.malformed++; return; }
      this.modern = true;
      const key = typeof p.response_id === 'string' && p.response_id ? p.response_id : `codex:${p.thread_id ?? this.id}:${ts}`;
      this.emit(key, tokens, ts, normalizeMode(p.service_tier));
      return;
    }
    if (row.type === 'response_item') {
      const type = typeof p.type === 'string' ? p.type : '';
      if (type === 'agent_message') {
        if (p.recipient === this.agentPath && !this.streaming) { this.pendingStartMs = ts; this.mode.recorded = null; }
      } else if (type.endsWith('_output') || (type === 'message' && ['user', 'developer', 'system'].includes(p.role))) {
        this.input(ts);
        this.attention = null;
      } else if (type === 'reasoning' || type.endsWith('_call') || (type === 'message' && p.role === 'assistant')) {
        if (!this.streaming) this.mode.recorded = null;
        this.streaming = true;
        this.phase = 'generating';
        this.pendingStartMs ??= ts;
        if (p.name === 'request_user_input') this.attention = 'input';
      }
      return;
    }
    if (row.type !== 'event_msg') return;
    if (p.type === 'thread_settings_applied') {
      const settings = p.thread_settings ?? {};
      if (Object.hasOwn(settings, 'service_tier')) {
        this.sessionMode = normalizeMode(settings.service_tier);
        this.mode.selected = this.turnMode ?? this.sessionMode;
        this.mode.evidence = this.turnMode ? 'turn_context' : this.sessionMode ? 'thread_settings_applied' : null;
      }
      if (Object.hasOwn(settings, 'reasoning_effort')) this.reasoningEffort = typeof settings.reasoning_effort === 'string' ? settings.reasoning_effort : null;
      if (typeof settings.model === 'string') this.model = settings.model;
    } else if (['task_started', 'user_message'].includes(p.type)) {
      this.input(ts);
      this.attention = null;
    } else if (['task_complete', 'turn_complete', 'turn_aborted'].includes(p.type)) {
      this.phase = 'completed';
      this.pendingStartMs = null;
      this.streaming = false;
      this.attention = null;
    } else if (p.type === 'error') {
      this.phase = 'error'; this.attention = 'error'; this.pendingStartMs = null;
    } else if (['exec_approval_request', 'apply_patch_approval_request'].includes(p.type)) {
      this.attention = 'approval'; this.phase = 'tools';
    } else if (p.type === 'request_user_input') {
      this.attention = 'input'; this.phase = 'tools';
    } else if (p.type === 'token_count') {
      if (this.modern) {
        if (this.streaming) this.afterUsage(ts);
        return;
      }
      if (!p.info || typeof p.info !== 'object' || !p.info.total_token_usage) return;
      const total = p.info.total_token_usage;
      let usage = p.info.last_token_usage ?? total;
      if (this.previousLegacy) {
        const delta = Object.fromEntries(tokenFields.map(k => [k, tokenCount(total[k]) - tokenCount(this.previousLegacy[k])]));
        if (delta.total_tokens === 0) return;
        usage = Object.values(delta).some(n => n < 0) ? p.info.last_token_usage ?? {} : delta;
      }
      const tokens = normalizeTokens(usage);
      if (!tokens) { this.malformed++; return; }
      this.previousLegacy = Object.fromEntries(tokenFields.map(k => [k, tokenCount(total[k])]));
      this.emit(`codex-legacy:${this.id}:${tokenCount(total.total_tokens)}`, tokens, ts, null);
    }
  }

  input(ts) {
    if (this.streaming) return;
    this.mode.recorded = null;
    this.pendingStartMs = ts;
    this.phase = 'generating';
  }

  emit(key, tokens, endMs, recordedMode) {
    if (this.seenKeys.has(key)) return;
    const duration = this.pendingStartMs === null ? null : endMs - this.pendingStartMs;
    const valid = duration !== null && duration >= 0 && duration <= 900000;
    const startMs = valid ? endMs - Math.max(500, duration) : null;
    const accepted = this.onResponse({ key, agentId: this.id, model: this.turnModel ?? this.model, startMs, endMs, tokens });
    this.seenKeys.add(key);
    if (!accepted) return;
    this.mode.recorded = recordedMode;
    this.afterUsage(endMs);
  }

  afterUsage(ts) {
    this.pendingStartMs = ts;
    this.streaming = false;
    this.phase = 'tools';
  }
}
