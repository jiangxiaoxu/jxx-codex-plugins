import { createHash, randomUUID } from "node:crypto";
import {
  chmod,
  link,
  mkdir,
  open,
  readFile,
  rename,
  rm,
  stat,
} from "node:fs/promises";
import { dirname, resolve } from "node:path";

const DEFAULT_LOCK_TIMEOUT_MS = 60_000;
const DEFAULT_LOCK_RETRY_MS = 25;
const INCOMPLETE_LOCK_GRACE_MS = 5_000;

const processQueues = new Map<string, Promise<void>>();

export interface CredentialSnapshot<T extends Record<string, unknown>> {
  exists: boolean;
  fingerprint?: string;
  bytes?: Uint8Array;
  state: T;
}

export interface CredentialStoreOptions<T extends Record<string, unknown>> {
  empty: () => T;
  parse: (json: string) => T;
  lockTimeoutMs?: number;
  lockRetryMs?: number;
  now?: () => number;
  lockOpen?: typeof open;
  platform?: NodeJS.Platform;
}

export interface LockedCredentialStore<T extends Record<string, unknown>> {
  read(): Promise<T>;
  readSnapshot(): Promise<CredentialSnapshot<T>>;
  write(state: T): Promise<void>;
  writeBytes(bytes: Uint8Array): Promise<void>;
  update(update: (state: T) => T): Promise<T>;
  clear(expectedFingerprint?: string): Promise<boolean>;
}

interface LockOwner {
  pid: number;
  nonce: string;
  createdAt: number;
}

export class AtomicCredentialStore<T extends Record<string, unknown>> {
  readonly path: string;
  readonly lockPath: string;
  private readonly options: Required<Omit<CredentialStoreOptions<T>, "empty" | "parse">> &
    Pick<CredentialStoreOptions<T>, "empty" | "parse">;

  constructor(path: string, options: CredentialStoreOptions<T>) {
    this.path = resolve(path);
    this.lockPath = `${this.path}.lock`;
    this.options = {
      ...options,
      lockTimeoutMs: options.lockTimeoutMs ?? DEFAULT_LOCK_TIMEOUT_MS,
      lockRetryMs: options.lockRetryMs ?? DEFAULT_LOCK_RETRY_MS,
      now: options.now ?? Date.now,
      lockOpen: options.lockOpen ?? open,
      platform: options.platform ?? process.platform,
    };
  }

  async read(): Promise<T> {
    return (await this.readSnapshot()).state;
  }

  async readSnapshot(): Promise<CredentialSnapshot<T>> {
    return this.readSnapshotUnlocked();
  }

  async write(state: T): Promise<void> {
    await this.withLock((locked) => locked.write(state));
  }

  async writeBytes(bytes: Uint8Array): Promise<void> {
    await this.withLock((locked) => locked.writeBytes(bytes));
  }

  async update(update: (state: T) => T): Promise<T> {
    return this.withLock((locked) => locked.update(update));
  }

  async clear(expectedFingerprint?: string): Promise<boolean> {
    return this.withLock((locked) => locked.clear(expectedFingerprint));
  }

  async withLock<R>(
    operation: (store: LockedCredentialStore<T>) => R | Promise<R>,
  ): Promise<R> {
    return withProcessQueue(this.lockPath, async () => {
      const owner = await this.acquireLock();
      try {
        return await operation(this.lockedStore());
      } finally {
        await this.releaseLock(owner);
      }
    });
  }

  private lockedStore(): LockedCredentialStore<T> {
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
        if (expectedFingerprint !== undefined) {
          const current = await this.readSnapshotUnlocked();
          if (current.fingerprint !== expectedFingerprint) {
            return false;
          }
        }
        await rm(this.path, { force: true });
        return true;
      },
    };
  }

  private async readSnapshotUnlocked(): Promise<CredentialSnapshot<T>> {
    try {
      const bytes = await readFile(this.path);
      return {
        exists: true,
        bytes,
        fingerprint: fingerprint(bytes),
        state: this.options.parse(bytes.toString("utf8")),
      };
    } catch (error) {
      if (errorCode(error) === "ENOENT") {
        return { exists: false, state: this.options.empty() };
      }
      throw error;
    }
  }

  private async writeUnlocked(state: T): Promise<void> {
    await this.writeBytesUnlocked(Buffer.from(`${JSON.stringify(state, null, 2)}\n`, "utf8"));
  }

  private async writeBytesUnlocked(bytes: Uint8Array): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true });
    const temporaryPath = `${this.path}.${process.pid}.${randomUUID()}.tmp`;
    let handle: Awaited<ReturnType<typeof open>> | undefined;
    try {
      handle = await open(temporaryPath, "wx", 0o600);
      await handle.writeFile(bytes);
      await handle.sync();
      await handle.close();
      handle = undefined;
      await rename(temporaryPath, this.path);
      if (process.platform !== "win32") {
        await chmod(this.path, 0o600);
      }
    } catch (error) {
      await handle?.close().catch(() => undefined);
      await rm(temporaryPath, { force: true }).catch(() => undefined);
      throw error;
    }
  }

  private async acquireLock(): Promise<LockOwner> {
    await mkdir(dirname(this.path), { recursive: true });
    const deadline = this.options.now() + this.options.lockTimeoutMs;
    while (true) {
      const owner: LockOwner = {
        pid: process.pid,
        nonce: randomUUID(),
        createdAt: this.options.now(),
      };
      let handle: Awaited<ReturnType<typeof open>> | undefined;
      try {
        handle = await this.options.lockOpen(this.lockPath, "wx", 0o600);
        await handle.writeFile(`${JSON.stringify(owner)}\n`, "utf8");
        await handle.sync();
        await handle.close();
        return owner;
      } catch (error) {
        const createdLock = handle !== undefined;
        await handle?.close().catch(() => undefined);
        if (createdLock) {
          await rm(this.lockPath, { force: true }).catch(() => undefined);
        }
        if (!(await this.isLockContention(error))) {
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

  private async isLockContention(error: unknown): Promise<boolean> {
    const code = errorCode(error);
    if (code === "EEXIST") {
      return true;
    }
    if (
      this.options.platform !== "win32" ||
      (code !== "EPERM" && code !== "EBUSY")
    ) {
      return false;
    }

    const errno = error as NodeJS.ErrnoException;
    if (errno.syscall !== "open" || errno.path !== this.lockPath) {
      return false;
    }

    // Windows can report an existing, concurrently opened lock as access denied
    // or a sharing violation. Require the canonical regular file to be observable
    // so unrelated permission failures remain fatal.
    try {
      return (await stat(this.lockPath)).isFile();
    } catch {
      return false;
    }
  }

  private async tryReclaimDeadLock(): Promise<boolean> {
    let observedText: string | undefined;
    let observedMtimeMs = 0;
    try {
      [observedText, observedMtimeMs] = await Promise.all([
        readFile(this.lockPath, "utf8"),
        stat(this.lockPath).then((value) => value.mtimeMs),
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

    let movedText: string;
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

  private async releaseLock(owner: LockOwner): Promise<void> {
    let current: LockOwner | undefined;
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
}

export async function restoreQuarantinedCredentialLock(
  quarantinePath: string,
  canonicalLockPath: string,
): Promise<void> {
  try {
    await link(quarantinePath, canonicalLockPath);
  } catch (error) {
    if (errorCode(error) === "EEXIST") {
      throw new Error(
        `OAuth credential lock changed during reclaim; refusing to overwrite the canonical lock: ${canonicalLockPath}`,
        { cause: error },
      );
    }
    throw new Error(
      `OAuth credential lock changed during reclaim and exclusive hard-link restore failed: ${canonicalLockPath}`,
      { cause: error },
    );
  }

  try {
    await rm(quarantinePath);
  } catch (error) {
    throw new Error(
      `OAuth credential lock was restored but its quarantine link could not be removed: ${quarantinePath}`,
      { cause: error },
    );
  }
}

function parseLockOwner(value: string): LockOwner | undefined {
  try {
    const parsed: unknown = JSON.parse(value);
    if (
      !parsed ||
      typeof parsed !== "object" ||
      Array.isArray(parsed) ||
      typeof (parsed as Record<string, unknown>).pid !== "number" ||
      typeof (parsed as Record<string, unknown>).nonce !== "string" ||
      typeof (parsed as Record<string, unknown>).createdAt !== "number"
    ) {
      return undefined;
    }
    return parsed as unknown as LockOwner;
  } catch {
    return undefined;
  }
}

function isProcessAlive(pid: number): boolean {
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

function fingerprint(value: Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function errorCode(error: unknown): string | undefined {
  return error && typeof error === "object" && "code" in error
    ? String((error as NodeJS.ErrnoException).code)
    : undefined;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
}

async function withProcessQueue<R>(path: string, operation: () => Promise<R>): Promise<R> {
  const previous = processQueues.get(path) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolvePromise) => {
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
