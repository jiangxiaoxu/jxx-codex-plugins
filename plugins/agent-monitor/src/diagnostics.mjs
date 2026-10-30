import { closeSync, existsSync, mkdirSync, openSync, renameSync, unlinkSync, writeSync } from 'node:fs';
import path from 'node:path';

const levels = { debug: 10, info: 20, warn: 30, error: 40 };
const allowedFields = new Set([
  'operation', 'method', 'tool', 'toolName', 'stage', 'source', 'file', 'fileName', 'filePath', 'path',
  'state', 'status', 'phase', 'phaseSource', 'reason', 'code', 'error', 'threadId', 'agentId', 'rootThreadId',
  'requestId', 'attempt', 'count', 'files', 'filesRead', 'filesDiscovered', 'fileCount', 'records', 'recordsRead',
  'recordCount', 'requests', 'requestCount', 'bytes', 'bytesRead', 'byteCount', 'agents', 'agentCount', 'threads',
  'threadCount', 'models', 'modelCount', 'warnings', 'warningCount', 'malformed', 'malformedRecords',
  'nodeVersion', 'hostName', 'skippedCompressedFiles', 'newFiles', 'removedFiles', 'changedFiles', 'failedFiles', 'newResponses',
  'durationMs', 'elapsedMs', 'latencyMs', 'lastSuccessAt', 'sampledAt', 'startedAt', 'finishedAt',
  'active', 'completed', 'success', 'inFlight', 'visible', 'connected', 'inputTokens', 'outputTokens',
  'reasoningTokens', 'measuredTps', 'estimatedTps', 'outputTps', 'counts', 'rate', 'collection', 'timing'
]);
const privateKeys = /prompt|content|messages?|arguments?|args|result|responsebody|body|secret|password|credential|authorization|cookie|api[_-]?key|access[_-]?token|refresh[_-]?token/i;

function redact(value, maxLength = 4096) {
  return String(value)
    .replace(/\b(?:https?|wss?):\/\/[^\s<>"']+/gi, (match) => {
      try {
        const url = new URL(match);
        if (url.username) url.username = '[REDACTED]';
        if (url.password) url.password = '[REDACTED]';
        for (const key of url.searchParams.keys()) url.searchParams.set(key, '[REDACTED]');
        if (url.hash) url.hash = '[REDACTED]';
        return url.href;
      } catch { return '[REDACTED URL]'; }
    })
    .replace(/\b(?:authorization|proxy-authorization)\s*[:=]\s*["']?(?:Bearer|Basic)\s+[^\s"',;]+["']?/gi, 'authorization: [REDACTED]')
    .replace(/\b(?:Bearer|Basic)\s+[A-Za-z0-9._~+/=-]+/gi, '[REDACTED AUTHORIZATION]')
    .replace(/\b(?:cookie|set-cookie)\s*:\s*[^\r\n]+/gi, 'cookie: [REDACTED]')
    .replace(/\b(?:token|access[_-]?token|refresh[_-]?token|api[_-]?key|secret|password)\b["']?\s*[:=]\s*(?:"[^"]*"|'[^']*'|[^\s,;]+)/gi, '[REDACTED CREDENTIAL]')
    .replace(/\b(?:sk-[A-Za-z0-9_-]{16,}|gh[pousr]_[A-Za-z0-9_]{16,})\b/g, '[REDACTED KEY]')
    .slice(0, maxLength);
}

function errorFields(error) {
  if (!error || typeof error !== 'object') return { message: redact(error) };
  const fields = {};
  const parsingError = error.name === 'SyntaxError' || error.code === -32700 || error.code === 'PARSE_ERROR';
  if (parsingError) {
    const message = typeof error.message === 'string' ? error.message : '';
    const locations = [];
    const location = message.match(/\bat position (\d{1,12})(?: \(line (\d{1,12}) column (\d{1,12})\))?\s*$/i);
    if (location) {
      locations.push(`position ${location[1]}`);
      if (location[2]) locations.push(`line ${location[2]}`, `column ${location[3]}`);
    }
    fields.name = redact(error.name || 'SyntaxError');
    if (typeof error.code === 'string' || typeof error.code === 'number') fields.code = redact(error.code);
    fields.message = `Input parsing failed${locations.length ? ` (${locations.join(', ')})` : ''}`;
    const stack = typeof error.stack === 'string' ? error.stack : '';
    const header = `${error.name}: ${message}`;
    const frames = stack.startsWith(header) ? stack.slice(header.length).split(/\r?\n/).filter((line) => /^\s+at\s/.test(line)) : [];
    if (frames.length) fields.stack = redact(frames.join('\n'), 12288);
    return fields;
  }
  for (const key of ['name', 'code', 'message', 'stack']) {
    const value = error[key];
    if (typeof value === 'string' || typeof value === 'number') fields[key] = redact(value, key === 'stack' ? 12288 : 4096);
  }
  return fields;
}

function projectFields(fields, depth = 0, seen = new Set()) {
  if (!fields || typeof fields !== 'object' || depth > 3 || seen.has(fields)) return {};
  seen.add(fields);
  if (fields instanceof Error) return { error: errorFields(fields) };
  const output = {};
  if (!Object.hasOwn(fields, 'error') && (Object.hasOwn(fields, 'message') || Object.hasOwn(fields, 'stack'))) {
    output.error = errorFields(fields);
  }
  for (const [key, value] of Object.entries(fields)) {
    if (!allowedFields.has(key) || privateKeys.test(key)) continue;
    if (key === 'error') output.error = errorFields(value);
    else if (typeof value === 'string') output[key] = redact(value);
    else if (typeof value === 'number') { if (Number.isFinite(value)) output[key] = value; }
    else if (typeof value === 'boolean' || value === null) output[key] = value;
    else if (typeof value === 'bigint') output[key] = value.toString();
    else if (Array.isArray(value)) output[key] = value.slice(0, 20).flatMap((item) => {
      if (typeof item === 'string') return [redact(item)];
      if (typeof item === 'number' && Number.isFinite(item)) return [item];
      return [];
    });
    else if (value && typeof value === 'object') output[key] = projectFields(value, depth + 1, seen);
  }
  return output;
}

export class Diagnostics {
  constructor({ stateDir, version, level = process.env.AGENT_MONITOR_LOG_LEVEL || 'info', limitBytes = 5 * 1024 * 1024, keepFiles = 3 } = {}) {
    this.level = Object.hasOwn(levels, level) ? level : 'info';
    this.version = redact(version ?? 'unknown', 64);
    this.limitBytes = Math.max(512, Number.isFinite(limitBytes) ? Math.floor(limitBytes) : 5 * 1024 * 1024);
    this.keepFiles = Math.max(1, Math.min(20, Number.isInteger(keepFiles) ? keepFiles : 3));
    this.events = [];
    this.bytes = 0;
    this.fd = null;
    this.closed = false;
    this.failureReported = false;
    this.logPath = null;
    try {
      const directory = path.join(stateDir, 'logs');
      mkdirSync(directory, { recursive: true });
      const timestamp = `${new Date().toISOString().replace(/[:.]/g, '-')}-${process.hrtime.bigint()}`;
      this.logPath = path.join(directory, `agent-monitor-${process.pid}-${timestamp}.jsonl`);
      this.fd = openSync(this.logPath, 'ax');
    } catch { this.reportFailure(); }
  }

  reportFailure() {
    if (this.failureReported) return;
    this.failureReported = true;
    try { writeSync(2, '[agent-monitor] error diagnostics.write_failed\n'); } catch { /* Closed stderr cannot become a second failure. */ }
  }

  rotate() {
    closeSync(this.fd);
    this.fd = null;
    const archive = (index) => this.logPath.replace(/\.jsonl$/, `.${index}.jsonl`);
    if (this.keepFiles === 1) unlinkSync(this.logPath);
    else {
      const oldest = archive(this.keepFiles - 1);
      if (existsSync(oldest)) unlinkSync(oldest);
      for (let index = this.keepFiles - 1; index >= 1; index--) {
        const source = index === 1 ? this.logPath : archive(index - 1);
        if (existsSync(source)) renameSync(source, archive(index));
      }
    }
    this.fd = openSync(this.logPath, 'ax');
    this.bytes = 0;
  }

  write(level, event, fields = {}) {
    if (this.closed || !Object.hasOwn(levels, level) || levels[level] < levels[this.level]) return false;
    let record;
    try {
      record = { timestamp: new Date().toISOString(), pid: process.pid, version: this.version, level, event: redact(event, 96), fields: projectFields(fields) };
      this.events.push(record);
      if (this.events.length > 100) this.events.shift();
      let line = JSON.stringify(record) + '\n';
      if (Buffer.byteLength(line) > this.limitBytes) line = JSON.stringify({ ...record, fields: { truncated: true } }) + '\n';
      if (this.fd !== null) {
        if (this.bytes && this.bytes + Buffer.byteLength(line) > this.limitBytes) this.rotate();
        this.bytes += writeSync(this.fd, line);
      }
      if (level === 'warn' || level === 'error') {
        try { writeSync(2, `[agent-monitor] ${level} ${record.event} ${JSON.stringify(record.fields)}\n`); } catch { this.reportFailure(); }
      }
      return true;
    } catch {
      if (this.fd !== null) { try { closeSync(this.fd); } catch {} this.fd = null; }
      this.reportFailure();
      return false;
    }
  }

  snapshot() {
    return { version: this.version, logPath: this.logPath, level: this.level, events: structuredClone(this.events), writeFailed: this.failureReported };
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    if (this.fd !== null) {
      try { closeSync(this.fd); } catch { this.reportFailure(); }
      this.fd = null;
    }
  }
}
