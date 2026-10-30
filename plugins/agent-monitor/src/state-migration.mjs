import { backup, DatabaseSync } from 'node:sqlite';
import { existsSync, linkSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';

export async function migrateLegacyState(stateDir, legacyStateDir) {
  if (!legacyStateDir || resolve(stateDir) === resolve(legacyStateDir)) return;
  const sourcePath = join(legacyStateDir, 'metrics.sqlite');
  const targetPath = join(stateDir, 'metrics.sqlite');
  if (!existsSync(legacyStateDir)) return;
  mkdirSync(stateDir, { recursive: true });
  if (!existsSync(targetPath) && existsSync(sourcePath)) {
    const temporary = mkdtempSync(join(stateDir, '.migration-'));
    let source;
    try {
      source = new DatabaseSync(sourcePath, { readOnly: true });
      // SQLite includes committed WAL records in this snapshot. Publish a complete
      // file exclusively so concurrent first starts cannot replace an existing DB.
      const snapshot = join(temporary, 'metrics.sqlite');
      await backup(source, snapshot);
      try { linkSync(snapshot, targetPath); }
      catch (error) { if (error.code !== 'EEXIST') throw error; }
    } finally {
      source?.close();
      rmSync(temporary, { recursive: true, force: true });
    }
  }
}
