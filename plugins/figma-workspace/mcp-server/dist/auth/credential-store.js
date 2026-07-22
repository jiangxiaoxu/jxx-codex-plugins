import { createRequire as __figmaWorkspaceCreateRequire } from "node:module";
import { fileURLToPath as __figmaWorkspaceFileURLToPath } from "node:url";
import { dirname as __figmaWorkspacePathDirname } from "node:path";
const require = __figmaWorkspaceCreateRequire(import.meta.url);
const __filename = __figmaWorkspaceFileURLToPath(import.meta.url);
const __dirname = __figmaWorkspacePathDirname(__filename);

// src/auth/credential-store.ts
import { createHash, randomUUID } from "node:crypto";
import {
  chmod,
  link,
  mkdir,
  open,
  readFile,
  rename,
  rm,
  stat
} from "node:fs/promises";
import { dirname, resolve } from "node:path";
var DEFAULT_LOCK_TIMEOUT_MS = 6e4;
var DEFAULT_LOCK_RETRY_MS = 25;
var INCOMPLETE_LOCK_GRACE_MS = 5e3;
var processQueues = /* @__PURE__ */ new Map();
var AtomicCredentialStore = class {
  path;
  lockPath;
  options;
  constructor(path, options) {
    this.path = resolve(path);
    this.lockPath = `${this.path}.lock`;
    this.options = {
      ...options,
      lockTimeoutMs: options.lockTimeoutMs ?? DEFAULT_LOCK_TIMEOUT_MS,
      lockRetryMs: options.lockRetryMs ?? DEFAULT_LOCK_RETRY_MS,
      now: options.now ?? Date.now,
      lockOpen: options.lockOpen ?? open,
      platform: options.platform ?? process.platform
    };
  }
  async read() {
    return (await this.readSnapshot()).state;
  }
  async readSnapshot() {
    return this.readSnapshotUnlocked();
  }
  async write(state) {
    await this.withLock((locked) => locked.write(state));
  }
  async writeBytes(bytes) {
    await this.withLock((locked) => locked.writeBytes(bytes));
  }
  async update(update) {
    return this.withLock((locked) => locked.update(update));
  }
  async clear(expectedFingerprint) {
    return this.withLock((locked) => locked.clear(expectedFingerprint));
  }
  async withLock(operation) {
    return withProcessQueue(this.lockPath, async () => {
      const owner = await this.acquireLock();
      try {
        return await operation(this.lockedStore());
      } finally {
        await this.releaseLock(owner);
      }
    });
  }
  lockedStore() {
    return {
      read: async () => (await this.readSnapshotUnlocked()).state,
      readSnapshot: () => this.readSnapshotUnlocked(),
      write: (state) => this.writeUnlocked(state),
      writeBytes: (bytes) => this.writeBytesUnlocked(bytes),
      update: async (update) => {
        const next = update((await this.readSnapshotUnlocked()).state);
        await this.writeUnlocked(next);
        return next;
      },
      clear: async (expectedFingerprint) => {
        if (expectedFingerprint !== void 0) {
          const current = await this.readSnapshotUnlocked();
          if (current.fingerprint !== expectedFingerprint) {
            return false;
          }
        }
        await rm(this.path, { force: true });
        return true;
      }
    };
  }
  async readSnapshotUnlocked() {
    try {
      const bytes = await readFile(this.path);
      return {
        exists: true,
        bytes,
        fingerprint: fingerprint(bytes),
        state: this.options.parse(bytes.toString("utf8"))
      };
    } catch (error) {
      if (errorCode(error) === "ENOENT") {
        return { exists: false, state: this.options.empty() };
      }
      throw error;
    }
  }
  async writeUnlocked(state) {
    await this.writeBytesUnlocked(Buffer.from(`${JSON.stringify(state, null, 2)}
`, "utf8"));
  }
  async writeBytesUnlocked(bytes) {
    await mkdir(dirname(this.path), { recursive: true });
    const temporaryPath = `${this.path}.${process.pid}.${randomUUID()}.tmp`;
    let handle;
    try {
      handle = await open(temporaryPath, "wx", 384);
      await handle.writeFile(bytes);
      await handle.sync();
      await handle.close();
      handle = void 0;
      await rename(temporaryPath, this.path);
      if (process.platform !== "win32") {
        await chmod(this.path, 384);
      }
    } catch (error) {
      await handle?.close().catch(() => void 0);
      await rm(temporaryPath, { force: true }).catch(() => void 0);
      throw error;
    }
  }
  async acquireLock() {
    await mkdir(dirname(this.path), { recursive: true });
    const deadline = this.options.now() + this.options.lockTimeoutMs;
    while (true) {
      const owner = {
        pid: process.pid,
        nonce: randomUUID(),
        createdAt: this.options.now()
      };
      let handle;
      try {
        handle = await this.options.lockOpen(this.lockPath, "wx", 384);
        await handle.writeFile(`${JSON.stringify(owner)}
`, "utf8");
        await handle.sync();
        await handle.close();
        return owner;
      } catch (error) {
        const createdLock = handle !== void 0;
        await handle?.close().catch(() => void 0);
        if (createdLock) {
          await rm(this.lockPath, { force: true }).catch(() => void 0);
        }
        if (!await this.isLockContention(error)) {
          throw error;
        }
      }
      if (await this.tryReclaimDeadLock()) {
        continue;
      }
      if (this.options.now() >= deadline) {
        throw new Error(`Timed out waiting for OAuth credential lock: ${this.lockPath}`);
      }
      await delay(this.options.lockRetryMs);
    }
  }
  async isLockContention(error) {
    const code = errorCode(error);
    if (code === "EEXIST") {
      return true;
    }
    if (this.options.platform !== "win32" || code !== "EPERM" && code !== "EBUSY") {
      return false;
    }
    const errno = error;
    if (errno.syscall !== "open" || errno.path !== this.lockPath) {
      return false;
    }
    try {
      return (await stat(this.lockPath)).isFile();
    } catch {
      return false;
    }
  }
  async tryReclaimDeadLock() {
    let observedText;
    let observedMtimeMs = 0;
    try {
      [observedText, observedMtimeMs] = await Promise.all([
        readFile(this.lockPath, "utf8"),
        stat(this.lockPath).then((value) => value.mtimeMs)
      ]);
    } catch (error) {
      if (errorCode(error) === "ENOENT") {
        return true;
      }
      throw error;
    }
    const owner = parseLockOwner(observedText);
    if (owner && isProcessAlive(owner.pid)) {
      return false;
    }
    if (!owner && this.options.now() - observedMtimeMs < INCOMPLETE_LOCK_GRACE_MS) {
      return false;
    }
    const quarantinePath = `${this.lockPath}.${process.pid}.${randomUUID()}.reclaim`;
    try {
      await rename(this.lockPath, quarantinePath);
    } catch (error) {
      if (errorCode(error) === "ENOENT") {
        return true;
      }
      throw error;
    }
    let movedText;
    try {
      movedText = await readFile(quarantinePath, "utf8");
    } catch (error) {
      if (errorCode(error) !== "ENOENT") {
        throw error;
      }
      return true;
    }
    if (movedText !== observedText) {
      await restoreQuarantinedCredentialLock(quarantinePath, this.lockPath);
      return false;
    }
    await rm(quarantinePath, { force: true });
    return true;
  }
  async releaseLock(owner) {
    let current;
    try {
      current = parseLockOwner(await readFile(this.lockPath, "utf8"));
    } catch (error) {
      if (errorCode(error) === "ENOENT") {
        throw new Error(`OAuth credential lock disappeared before release: ${this.lockPath}`);
      }
      throw error;
    }
    if (!current || current.nonce !== owner.nonce || current.pid !== owner.pid) {
      throw new Error(`OAuth credential lock ownership changed before release: ${this.lockPath}`);
    }
    await rm(this.lockPath);
  }
};
async function restoreQuarantinedCredentialLock(quarantinePath, canonicalLockPath) {
  try {
    await link(quarantinePath, canonicalLockPath);
  } catch (error) {
    if (errorCode(error) === "EEXIST") {
      throw new Error(
        `OAuth credential lock changed during reclaim; refusing to overwrite the canonical lock: ${canonicalLockPath}`,
        { cause: error }
      );
    }
    throw new Error(
      `OAuth credential lock changed during reclaim and exclusive hard-link restore failed: ${canonicalLockPath}`,
      { cause: error }
    );
  }
  try {
    await rm(quarantinePath);
  } catch (error) {
    throw new Error(
      `OAuth credential lock was restored but its quarantine link could not be removed: ${quarantinePath}`,
      { cause: error }
    );
  }
}
function parseLockOwner(value) {
  try {
    const parsed = JSON.parse(value);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed) || typeof parsed.pid !== "number" || typeof parsed.nonce !== "string" || typeof parsed.createdAt !== "number") {
      return void 0;
    }
    return parsed;
  } catch {
    return void 0;
  }
}
function isProcessAlive(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) {
    return false;
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return errorCode(error) === "EPERM";
  }
}
function fingerprint(value) {
  return createHash("sha256").update(value).digest("hex");
}
function errorCode(error) {
  return error && typeof error === "object" && "code" in error ? String(error.code) : void 0;
}
function delay(ms) {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
}
async function withProcessQueue(path, operation) {
  const previous = processQueues.get(path) ?? Promise.resolve();
  let release;
  const current = new Promise((resolvePromise) => {
    release = resolvePromise;
  });
  const tail = previous.then(() => current);
  processQueues.set(path, tail);
  await previous;
  try {
    return await operation();
  } finally {
    release();
    if (processQueues.get(path) === tail) {
      processQueues.delete(path);
    }
  }
}
export {
  AtomicCredentialStore,
  restoreQuarantinedCredentialLock
};
