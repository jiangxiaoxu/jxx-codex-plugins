import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { migrateLegacyState } from '../src/state-migration.mjs';

test('concurrent migration snapshots active WAL without changing the source', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'agent-monitor-migration-'));
  const legacy = join(directory, 'legacy'), target = join(directory, 'new');
  mkdirSync(join(legacy, 'logs'), { recursive: true });
  writeFileSync(join(legacy, 'logs', 'old.jsonl'), '{"event":"old"}\n');
  const source = new DatabaseSync(join(legacy, 'metrics.sqlite'));
  try {
    source.exec('PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0; CREATE TABLE facts(output); INSERT INTO facts VALUES(100)');
    assert.ok(existsSync(join(legacy, 'metrics.sqlite-wal')));
    await Promise.all([migrateLegacyState(target, legacy), migrateLegacyState(target, legacy)]);
    const migrated = new DatabaseSync(join(target, 'metrics.sqlite'));
    try {
      assert.equal(migrated.prepare('SELECT SUM(output) AS value FROM facts').get().value, 100);
      source.exec('INSERT INTO facts VALUES(200)');
      assert.equal(source.prepare('SELECT SUM(output) AS value FROM facts').get().value, 300);
      await migrateLegacyState(target, legacy);
      assert.equal(migrated.prepare('SELECT SUM(output) AS value FROM facts').get().value, 100);
    } finally { migrated.close(); }
    assert.equal(readFileSync(join(legacy, 'logs', 'old.jsonl'), 'utf8'), '{"event":"old"}\n');
    assert.equal(existsSync(join(target, 'logs')), false);
    assert.ok(existsSync(join(legacy, 'metrics.sqlite')));
    assert.deepEqual(readdirSync(target), ['metrics.sqlite']);
  } finally { source.close(); rmSync(directory, { recursive: true, force: true }); }
});

test('migration preserves existing destination data and does not run without a legacy source', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'agent-monitor-migration-'));
  const legacy = join(directory, 'legacy'), target = join(directory, 'new');
  try {
    mkdirSync(legacy, { recursive: true });
    mkdirSync(join(target, 'logs'), { recursive: true });
    writeFileSync(join(legacy, 'metrics.sqlite'), 'must not replace target');
    writeFileSync(join(target, 'metrics.sqlite'), 'existing database');
    writeFileSync(join(legacy, 'logs'), 'not a readable log directory');
    writeFileSync(join(target, 'logs', 'same.jsonl'), 'current log');
    await migrateLegacyState(target, legacy);
    assert.equal(readFileSync(join(target, 'metrics.sqlite'), 'utf8'), 'existing database');
    assert.equal(readFileSync(join(target, 'logs', 'same.jsonl'), 'utf8'), 'current log');
    const explicit = join(directory, 'explicit');
    await migrateLegacyState(explicit, null);
    assert.equal(existsSync(explicit), false);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('failed database migration leaves no published database and preserves the source', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'agent-monitor-migration-'));
  const legacy = join(directory, 'legacy'), target = join(directory, 'new');
  try {
    mkdirSync(legacy);
    writeFileSync(join(legacy, 'metrics.sqlite'), 'invalid SQLite');
    await assert.rejects(migrateLegacyState(target, legacy));
    assert.equal(existsSync(join(target, 'metrics.sqlite')), false);
    assert.deepEqual(readdirSync(target), []);
    assert.equal(readFileSync(join(legacy, 'metrics.sqlite'), 'utf8'), 'invalid SQLite');
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
