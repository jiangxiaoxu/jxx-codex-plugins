import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import path from 'node:path';

export function localDay(ms) {
  const date = new Date(ms);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

export class MetricsStore {
  constructor(stateDir) {
    mkdirSync(stateDir, { recursive: true });
    this.db = new DatabaseSync(path.join(stateDir, 'metrics.sqlite'));
    try {
      this.db.exec(`PRAGMA busy_timeout=2000;
      PRAGMA journal_mode=WAL;
      CREATE TABLE IF NOT EXISTS responses (
        response_key TEXT PRIMARY KEY, agent_id TEXT NOT NULL, model TEXT,
        start_ms REAL, end_ms REAL NOT NULL, day TEXT NOT NULL,
        input_tokens REAL NOT NULL, cached_tokens REAL NOT NULL,
        output_tokens REAL NOT NULL, reasoning_tokens REAL NOT NULL
      );
      CREATE INDEX IF NOT EXISTS response_end ON responses(end_ms);
      CREATE INDEX IF NOT EXISTS response_agent ON responses(agent_id, end_ms);
      CREATE INDEX IF NOT EXISTS response_day ON responses(day);
      CREATE TABLE IF NOT EXISTS peaks(day TEXT PRIMARY KEY, tps REAL NOT NULL);`);
      this.insert = this.db.prepare('INSERT OR IGNORE INTO responses VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?)');
    } catch (error) { this.db.close(); throw error; }
  }

  add(response) {
    const { key, agentId, model, startMs, endMs, tokens } = response;
    const result = this.insert.run(key, agentId, model, startMs, endMs, localDay(endMs), tokens.input, tokens.cachedInput, tokens.output, tokens.reasoning);
    return Number(result.changes) !== 0;
  }

  owner(key) {
    return this.db.prepare('SELECT agent_id AS id FROM responses WHERE response_key = ?').get(key)?.id ?? null;
  }

  readMetrics(afterRowId, nowMs) {
    this.db.exec('BEGIN');
    try {
      // Responses are append-only. Read the initial aggregates and append cursor
      // from one snapshot so another process cannot make a fact missing or counted twice.
      const initial = afterRowId === null;
      const cursor = this.db.prepare('SELECT COALESCE(MAX(rowid), 0) AS value FROM responses').get().value;
      const totals = initial ? new Map(this.db.prepare('SELECT agent_id AS id, SUM(input_tokens) AS input, SUM(cached_tokens) AS cachedInput, SUM(output_tokens) AS output, SUM(reasoning_tokens) AS reasoning FROM responses GROUP BY agent_id').all().map(row => [row.id, { input: row.input, cachedInput: row.cachedInput, output: row.output, reasoning: row.reasoning }])) : null;
      const rows = this.db.prepare(`SELECT rowid AS rowId, response_key AS key, agent_id AS agentId, model,
        start_ms AS startMs, end_ms AS endMs, input_tokens AS input, cached_tokens AS cachedInput,
        output_tokens AS output, reasoning_tokens AS reasoning FROM responses
        WHERE ${initial ? 'end_ms >= ?' : 'rowid > ?'} ORDER BY rowid`).all(initial ? nowMs - 1800000 : afterRowId);
      const responses = rows.map(({ input, cachedInput, output, reasoning, ...response }) => ({ ...response, output, tokens: { input, cachedInput, output, reasoning } }));
      const today = this.today(nowMs);
      this.db.exec('COMMIT');
      return { cursor, totals, responses, today };
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  today(nowMs) {
    return this.db.prepare('SELECT COALESCE(SUM(input_tokens), 0) AS inputTokens, COALESCE(SUM(output_tokens), 0) AS outputTokens, COALESCE(SUM(reasoning_tokens), 0) AS reasoningTokens FROM responses WHERE day = ?').get(localDay(nowMs));
  }

  peak(nowMs, measuredTps) {
    this.db.prepare('INSERT INTO peaks VALUES(?, ?) ON CONFLICT(day) DO UPDATE SET tps = MAX(peaks.tps, excluded.tps)').run(localDay(nowMs), measuredTps);
  }

  history(from, to) {
    return this.db.prepare(`SELECT day, SUM(input_tokens) AS inputTokens, SUM(output_tokens) AS outputTokens,
      SUM(reasoning_tokens) AS reasoningTokens, COUNT(*) AS requests,
      CASE WHEN SUM(CASE WHEN start_ms IS NOT NULL THEN end_ms-start_ms ELSE 0 END)>0
        THEN SUM(CASE WHEN start_ms IS NOT NULL THEN output_tokens ELSE 0 END)*1000.0 /
          SUM(CASE WHEN start_ms IS NOT NULL THEN end_ms-start_ms ELSE 0 END) ELSE NULL END AS averageTps,
      (SELECT tps FROM peaks WHERE peaks.day=responses.day) AS peakTps
      FROM responses WHERE day >= ? AND day <= ? GROUP BY day ORDER BY day`).all(from, to).map(row => ({ ...row }));
  }

  close() { this.db.close(); }
}
