import { spawn } from 'node:child_process';
import { access, stat } from 'node:fs/promises';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { Duplex } from 'node:stream';
import WebSocket from 'ws';
import packageInfo from '../../package.json' with { type: 'json' };

const REQUEST_TIMEOUT_MS = 4000;
const ALLOWED_REQUESTS = new Set(['initialize', 'thread/loaded/list', 'thread/read']);
const metadataFields = ['id', 'sessionId', 'parentThreadId', 'path', 'cwd', 'name', 'createdAt', 'updatedAt', 'recencyAt', 'model', 'reasoningEffort', 'agentNickname', 'agentRole'];

function metadata(thread) {
  if (!thread || typeof thread.id !== 'string' || typeof thread.status?.type !== 'string') throw new Error('Invalid App Server thread metadata');
  const result = Object.fromEntries(metadataFields.map(key => [key, thread[key] ?? null]));
  result.status = { type: thread.status.type, activeFlags: Array.isArray(thread.status.activeFlags) ? [...thread.status.activeFlags] : [] };
  // SessionSource's subagent payload can contain more than identity metadata.
  result.source = typeof thread.source === 'string' ? thread.source : thread.source?.subagent ? 'subagent' : null;
  return result;
}

export class RuntimeClient {
  constructor({ codexHome, diagnostics, command = null, socketPath = process.env.AGENT_MONITOR_APP_SERVER_SOCKET } = {}) {
    this.codexHome = codexHome;
    this.socketPath = socketPath || path.join(codexHome, 'app-server-control', 'app-server-control.sock');
    this.command = command;
    this.diagnostics = diagnostics;
    this.connection = null;
    this.connecting = null;
    this.pending = new Map();
    this.threads = new Map();
    this.dirty = new Map();
    this.nextId = 1;
    this.lastListedAt = 0;
    this.nextConnectAt = 0;
    this.lastError = null;
    this.catalogDb = null;
    this.stateDbPath = process.env.AGENT_MONITOR_STATE_DB || path.join(codexHome, 'state_5.sqlite');
    this.eligible = new Set();
    this.lastMetadataAt = 0;
    this.skippedCompressedFiles = 0;
    this.exclusions = { compressed: 0, missingMetadata: 0, missingLog: 0, unsupportedPath: 0 };
  }

  async list() {
    await this.connect();
    const connection = this.connection;
    const now = Date.now();
    if (now - this.lastListedAt >= 1000) {
      const startedAt = performance.now();
      const ids = new Set();
      let cursor = null;
      do {
        const page = await this.request('thread/loaded/list', { cursor, limit: 200 });
        if (!Array.isArray(page?.data) || page.data.some(id => typeof id !== 'string')) throw new Error('Invalid App Server loaded thread list');
        for (const id of page.data) ids.add(id);
        cursor = page.nextCursor ?? null;
      } while (cursor);
      this.eligible = await this.plainRollouts(ids);
      for (const id of this.threads.keys()) if (!this.eligible.has(id)) this.threads.delete(id);
      for (const id of this.dirty.keys()) if (!this.eligible.has(id)) this.dirty.delete(id);
      for (const id of this.eligible) if (!this.threads.has(id) || now - this.lastMetadataAt >= 10000) this.dirty.set(id, {});
      if (now - this.lastMetadataAt >= 10000) this.lastMetadataAt = now;
      this.lastListedAt = now;
      this.diagnostics?.write('debug', 'runtime.catalog', { loaded: ids.size, plainCandidates: this.eligible.size, ...this.exclusions, durationMs: Math.round(performance.now() - startedAt) });
    }
    const pendingIds = [...this.dirty].filter(([id]) => this.eligible.has(id));
    // Limit simultaneous metadata reads on the daemon. No turns are requested.
    for (let index = 0; index < pendingIds.length; index += 8) {
      await Promise.all(pendingIds.slice(index, index + 8).map(async ([id, revision]) => {
        let result;
        try { result = await this.request('thread/read', { threadId: id, includeTurns: false }); }
        catch (error) {
          this.assertConnected();
          if (!this.dirty.has(id)) return;
          if (typeof error.code !== 'number') throw error;
          const loaded = new Set();
          let cursor = null;
          do {
            const page = await this.request('thread/loaded/list', { cursor, limit: 200 });
            for (const loadedId of page.data) loaded.add(loadedId);
            cursor = page.nextCursor ?? null;
          } while (cursor);
          if (loaded.has(id)) throw error;
          this.threads.delete(id);
          this.dirty.delete(id);
          this.eligible.delete(id);
          return;
        }
        const current = this.dirty.get(id);
        if (!current) return;
        const thread = metadata(result.thread);
        if (current !== revision) {
          if (current.status && current.status !== revision.status) thread.status = current.status;
          this.threads.set(id, thread);
        } else {
          this.threads.set(id, thread);
          this.dirty.delete(id);
        }
      }));
    }
    this.assertConnected();
    if (this.connection !== connection) throw new Error('App Server connection changed during catalog read');
    return [...this.threads.values()];
  }

  assertConnected() {
    if (!this.connection?.ready) throw this.lastError || new Error('App Server is disconnected');
  }

  async plainRollouts(ids) {
    if (!this.catalogDb) this.catalogDb = new DatabaseSync(this.stateDbPath, { readOnly: true });
    const paths = new Map();
    const values = [...ids];
    for (let index = 0; index < values.length; index += 200) {
      const batch = values.slice(index, index + 200);
      const rows = this.catalogDb.prepare(`SELECT id, rollout_path FROM threads WHERE id IN (${batch.map(() => '?').join(',')})`).all(...batch);
      for (const row of rows) paths.set(row.id, row.rollout_path);
    }
    const eligible = new Set();
    const excluded = { compressed: 0, missingMetadata: 0, missingLog: 0, unsupportedPath: 0 };
    for (const id of ids) {
      const filePath = paths.get(id);
      if (typeof filePath !== 'string') { excluded.missingMetadata++; continue; }
      if (filePath.endsWith('.zst')) { excluded.compressed++; continue; }
      if (!filePath.endsWith('.jsonl')) { excluded.unsupportedPath++; continue; }
      try { await stat(filePath); eligible.add(id); }
      catch (error) {
        if (error.code !== 'ENOENT') throw error;
        try { await stat(`${filePath}.zst`); excluded.compressed++; }
        catch (compressedError) {
          if (compressedError.code !== 'ENOENT') throw compressedError;
          excluded.missingLog++;
        }
      }
    }
    this.exclusions = excluded;
    this.skippedCompressedFiles = excluded.compressed;
    return eligible;
  }

  async connect() {
    if (this.connection?.ready) return;
    if (this.connecting) return this.connecting;
    if (Date.now() < this.nextConnectAt) throw this.lastError;
    this.connecting = this.open();
    try { await this.connecting; }
    catch (error) {
      this.lastError = error;
      this.nextConnectAt = Date.now() + 1000;
      this.close();
      throw error;
    } finally { this.connecting = null; }
  }

  async open() {
    await access(this.socketPath);
    let command = this.command;
    if (!command) {
      const configured = process.env.AGENT_MONITOR_CODEX_BIN;
      const managed = path.join(this.codexHome, 'packages', 'app-server-daemon', 'current', 'bin', process.platform === 'win32' ? 'codex.exe' : 'codex');
      if (configured) command = [configured];
      else {
        try { await access(managed); command = [managed]; }
        catch { command = ['codex']; }
      }
    }
    const child = spawn(command[0], [...command.slice(1), 'app-server', 'proxy', '--sock', this.socketPath], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    const stream = Duplex.from({ readable: child.stdout, writable: child.stdin });
    // This virtual HTTP URL is carried only through the stdio proxy, never TCP.
    const ws = new WebSocket('ws://localhost/', { createConnection: () => stream, perMessageDeflate: false, maxPayload: 32 * 1024 * 1024 });
    const connection = { child, ws, stream, ready: false, expectedClose: false, stderrBytes: 0 };
    this.connection = connection;
    child.stderr.on('data', chunk => { connection.stderrBytes += chunk.length; });
    child.on('error', error => this.disconnected(connection, Object.assign(new Error(`App Server proxy unavailable (${error.code ?? 'spawn error'})`), { code: error.code })));
    child.on('exit', (code, signal) => this.disconnected(connection, new Error(`App Server proxy exited (${code ?? signal ?? 'unknown'})`)));
    ws.on('message', bytes => this.receive(connection, bytes));
    ws.on('error', () => this.disconnected(connection, new Error('App Server WebSocket failed')));
    ws.on('close', () => this.disconnected(connection, new Error('App Server connection closed')));
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('App Server handshake timed out')), REQUEST_TIMEOUT_MS);
      const opened = () => { cleanup(); resolve(); };
      const failed = () => { cleanup(); reject(new Error('App Server handshake failed')); };
      const cleanup = () => { clearTimeout(timer); ws.off('open', opened); ws.off('error', failed); ws.off('close', failed); };
      ws.once('open', opened);
      ws.once('error', failed);
      ws.once('close', failed);
    });
    const initialized = await this.request('initialize', {
      // Codex's non-originating backend identity avoids changing the shared
      // daemon's global originator, user-agent suffix or automatic-login policy.
      clientInfo: { name: 'codex-backend', title: 'Agent Monitor', version: packageInfo.version },
      capabilities: { experimentalApi: false },
    });
    if (initialized.codexHome && path.relative(this.codexHome, initialized.codexHome) !== '') throw new Error('App Server CODEX_HOME differs from the monitored home');
    ws.send(JSON.stringify({ method: 'initialized' }));
    connection.ready = true;
    this.lastListedAt = 0;
    this.lastMetadataAt = 0;
    this.threads.clear();
    this.dirty.clear();
    this.eligible.clear();
    this.lastError = null;
    this.diagnostics?.write('info', 'runtime.connected', { transport: 'stdio-proxy', serverVersion: initialized.userAgent?.match(/\/(\d+\.\d+\.\d+[^\s;)]*)/)?.[1] ?? null });
  }

  request(method, params) {
    if (!ALLOWED_REQUESTS.has(method)) throw new Error('App Server request is outside the monitor read-only boundary');
    const connection = this.connection;
    if (!connection || connection.ws.readyState !== WebSocket.OPEN) return Promise.reject(new Error('App Server is disconnected'));
    const id = this.nextId++;
    const startedAt = performance.now();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`App Server request timed out (${method})`));
        this.disconnected(connection, new Error('App Server request timed out'));
      }, REQUEST_TIMEOUT_MS);
      this.pending.set(id, { resolve, reject, timer, method, startedAt });
      connection.ws.send(JSON.stringify({ id, method, params }), error => {
        if (error) this.disconnected(connection, new Error('App Server request could not be sent'));
      });
    });
  }

  receive(connection, bytes) {
    if (this.connection !== connection) return;
    let message;
    try { message = JSON.parse(bytes.toString()); }
    catch { this.disconnected(connection, new Error('Invalid App Server JSON')); return; }
    if (!message || typeof message !== 'object' || Array.isArray(message)) { this.disconnected(connection, new Error('Invalid App Server message')); return; }
    if (Object.hasOwn(message, 'id') && !message.method) {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      clearTimeout(pending.timer);
      this.diagnostics?.write('debug', 'runtime.request', { method: pending.method, durationMs: Math.round(performance.now() - pending.startedAt), errorCode: message.error?.code ?? null });
      if (message.error) pending.reject(Object.assign(new Error(`App Server request failed (${pending.method}, ${message.error.code})`), { code: message.error.code }));
      else pending.resolve(message.result);
      return;
    }
    if (Object.hasOwn(message, 'id')) {
      this.disconnected(connection, new Error('App Server requested an interactive operation from the monitor'));
      return;
    }
    const params = message.params;
    if (message.method === 'thread/status/changed' && typeof params?.threadId === 'string') {
      const known = this.threads.get(params.threadId);
      if (typeof params.status?.type !== 'string') return;
      const status = { type: params.status.type, activeFlags: Array.isArray(params.status.activeFlags) ? [...params.status.activeFlags] : [] };
      if (known) known.status = status;
      this.dirty.set(params.threadId, { status });
    } else if (message.method === 'thread/started' && params?.thread) {
      this.lastListedAt = 0;
    } else if (message.method === 'thread/closed' && typeof params?.threadId === 'string') {
      this.threads.delete(params.threadId);
      this.dirty.delete(params.threadId);
      this.eligible.delete(params.threadId);
    } else if (message.method === 'thread/name/updated' && typeof params?.threadId === 'string') {
      this.dirty.set(params.threadId, { ...this.dirty.get(params.threadId) });
    }
  }

  disconnected(connection, error) {
    if (this.connection !== connection || connection.expectedClose) return;
    this.lastError = error;
    this.nextConnectAt = Date.now() + 1000;
    this.diagnostics?.write('warn', 'runtime.disconnected', { message: error.message, stderrBytes: connection.stderrBytes });
    this.close();
  }

  close() {
    const connection = this.connection;
    this.connection = null;
    if (connection) {
      connection.expectedClose = true;
      connection.ws.terminate();
      connection.stream.destroy();
      connection.child.kill();
      this.diagnostics?.write('info', 'runtime.closed', { stderrBytes: connection.stderrBytes });
    }
    for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(new Error('App Server connection closed')); }
    this.pending.clear();
    this.catalogDb?.close();
    this.catalogDb = null;
  }
}
