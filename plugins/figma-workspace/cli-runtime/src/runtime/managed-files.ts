import { randomBytes } from "node:crypto";
import {
  link,
  lstat,
  mkdir,
  open,
  realpath,
  rename,
  unlink,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import type { Stats } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";

export interface ManagedFileHandle {
  chmod(mode: number): Promise<void>;
  close(): Promise<void>;
  sync(): Promise<void>;
  write(
    buffer: Uint8Array,
    offset?: number,
    length?: number,
    position?: number | null,
  ): Promise<{ bytesWritten: number }>;
  writeFile(data: string | Uint8Array, options?: { encoding?: BufferEncoding }): Promise<void>;
}

export interface ManagedFileSystemOperations {
  link(existingPath: string, newPath: string): Promise<void>;
  lstat(path: string): Promise<Stats>;
  mkdir(path: string): Promise<void>;
  open(path: string, flags: string, mode: number): Promise<ManagedFileHandle>;
  realpath(path: string): Promise<string>;
  rename(oldPath: string, newPath: string): Promise<void>;
  unlink(path: string): Promise<void>;
}

export interface ManagedAtomicWriteOptions {
  root: string;
  path: string;
  overwrite?: boolean;
  operations?: Partial<ManagedFileSystemOperations>;
}

export interface ManagedAtomicWriteResult {
  path: string;
  bytes: number;
}

interface PathFingerprint {
  path: string;
  realPath: string;
  dev: number | bigint;
  ino: number | bigint;
  mode: number;
  birthtimeMs: number;
}

interface ManagedDirectoryContext {
  root: string;
  directory: string;
  rootRealPath: string;
  fingerprints: PathFingerprint[];
}

const DEFAULT_OPERATIONS: ManagedFileSystemOperations = {
  link,
  lstat,
  mkdir: (path) => mkdir(path),
  open,
  realpath,
  rename,
  unlink,
};

export async function ensureManagedDirectory(options: {
  root: string;
  directory: string;
  operations?: Partial<ManagedFileSystemOperations>;
}): Promise<void> {
  await prepareManagedDirectory(options.root, options.directory, mergeOperations(options.operations));
}

export async function assertManagedFilePath(options: {
  root: string;
  path: string;
  operations?: Partial<ManagedFileSystemOperations>;
}): Promise<string> {
  const operations = mergeOperations(options.operations);
  const target = resolveManagedTarget(options.root, options.path);
  const context = await inspectManagedDirectory(options.root, dirname(target), operations);
  const targetFingerprint = await inspectManagedFile(target, context, operations);
  await revalidateDirectoryContext(context, operations);
  await revalidateFingerprint(targetFingerprint, "managed file", operations);
  return target;
}

export async function removeManagedFile(options: {
  root: string;
  path: string;
  allowMissing?: boolean;
  operations?: Partial<ManagedFileSystemOperations>;
}): Promise<void> {
  const operations = mergeOperations(options.operations);
  const target = resolveManagedTarget(options.root, options.path);
  let context: ManagedDirectoryContext;
  try {
    context = await inspectManagedDirectory(options.root, dirname(target), operations);
  } catch (error) {
    if (options.allowMissing && hasErrorCode(error, "ENOENT")) return;
    throw error;
  }
  let targetFingerprint: PathFingerprint;
  try {
    targetFingerprint = await inspectManagedFile(target, context, operations);
  } catch (error) {
    if (options.allowMissing && hasErrorCode(error, "ENOENT")) return;
    throw error;
  }
  await revalidateDirectoryContext(context, operations);
  await revalidateFingerprint(targetFingerprint, "managed file", operations);
  await operations.unlink(target);
  await revalidateDirectoryContext(context, operations);
}

export async function atomicWriteManagedTextFile(
  options: ManagedAtomicWriteOptions,
  content: string,
): Promise<ManagedAtomicWriteResult> {
  return atomicWriteManagedFile(options, content, Buffer.byteLength(content, "utf8"));
}

export async function atomicWriteManagedJsonFile(
  options: ManagedAtomicWriteOptions,
  value: unknown,
): Promise<ManagedAtomicWriteResult> {
  const serialized = JSON.stringify(value, null, 2);
  if (serialized === undefined) {
    throw new TypeError("Managed JSON output must be JSON-serializable.");
  }
  const content = `${serialized}\n`;
  return atomicWriteManagedTextFile(options, content);
}

export async function atomicWriteManagedBinaryFile(
  options: ManagedAtomicWriteOptions,
  content: Uint8Array,
): Promise<ManagedAtomicWriteResult> {
  return atomicWriteManagedFile(options, content, content.byteLength);
}

export async function atomicWriteManagedStreamFile(
  options: ManagedAtomicWriteOptions,
  content: AsyncIterable<Uint8Array>,
): Promise<ManagedAtomicWriteResult> {
  return atomicWriteManagedFile(options, content);
}

async function atomicWriteManagedFile(
  options: ManagedAtomicWriteOptions,
  content: string | Uint8Array | AsyncIterable<Uint8Array>,
  expectedBytes?: number,
): Promise<ManagedAtomicWriteResult> {
  const operations = mergeOperations(options.operations);
  const target = resolveManagedTarget(options.root, options.path);
  const context = await prepareManagedDirectory(options.root, dirname(target), operations);
  const initialTarget = await inspectOptionalManagedFile(target, context, operations);
  if (!options.overwrite && initialTarget) {
    throw refusingToOverwriteError(target);
  }

  const temporaryPath = await createTemporaryFilePath(target, operations);
  let handle: ManagedFileHandle | undefined;
  let committed = false;
  try {
    handle = await operations.open(temporaryPath, "wx", 0o600);
    await handle.chmod(0o600);
    const bytes = isAsyncIterable(content)
      ? await writeManagedChunks(handle, content)
      : await writeManagedValue(handle, content);
    if (expectedBytes !== undefined && bytes !== expectedBytes) {
      throw new Error(`Managed file write produced ${bytes} bytes; expected ${expectedBytes}: ${target}`);
    }
    await handle.sync();
    await handle.close();
    handle = undefined;

    const temporaryFingerprint = await inspectManagedFile(temporaryPath, context, operations);
    await revalidateDirectoryContext(context, operations);
    await revalidateOptionalTarget(target, initialTarget, context, operations, !options.overwrite);

    if (options.overwrite) {
      await operations.rename(temporaryPath, target);
    } else {
      try {
        await operations.link(temporaryPath, target);
      } catch (error) {
        if (hasErrorCode(error, "EEXIST")) {
          throw refusingToOverwriteError(target);
        }
        throw error;
      }
      await operations.unlink(temporaryPath);
    }
    committed = true;

    await revalidateDirectoryContext(context, operations);
    const committedFingerprint = await inspectManagedFile(target, context, operations);
    if (!sameIdentity(temporaryFingerprint, committedFingerprint)) {
      throw new Error(`Managed file target was replaced while committing the write: ${target}`);
    }
    return { path: target, bytes };
  } finally {
    if (handle) {
      try {
        await handle.close();
      } catch {
        // Preserve the original write failure.
      }
    }
    if (!committed) {
      try {
        await operations.unlink(temporaryPath);
      } catch (error) {
        if (!hasErrorCode(error, "ENOENT")) {
          // Cleanup failure must not replace the actionable write failure.
        }
      }
    }
  }
}

async function writeManagedValue(handle: ManagedFileHandle, content: string | Uint8Array): Promise<number> {
  await handle.writeFile(content, typeof content === "string" ? { encoding: "utf8" } : undefined);
  return typeof content === "string" ? Buffer.byteLength(content, "utf8") : content.byteLength;
}

async function writeManagedChunks(
  handle: ManagedFileHandle,
  content: AsyncIterable<Uint8Array>,
): Promise<number> {
  let position = 0;
  for await (const rawChunk of content) {
    const chunk = Buffer.from(rawChunk);
    let offset = 0;
    while (offset < chunk.byteLength) {
      const { bytesWritten } = await handle.write(
        chunk,
        offset,
        chunk.byteLength - offset,
        position,
      );
      if (!Number.isSafeInteger(bytesWritten) || bytesWritten <= 0) {
        throw new Error("Managed stream write made no forward progress.");
      }
      offset += bytesWritten;
      position += bytesWritten;
    }
  }
  return position;
}

function isAsyncIterable(value: unknown): value is AsyncIterable<Uint8Array> {
  return typeof value === "object"
    && value !== null
    && Symbol.asyncIterator in value
    && typeof (value as AsyncIterable<Uint8Array>)[Symbol.asyncIterator] === "function";
}

async function createTemporaryFilePath(
  target: string,
  operations: ManagedFileSystemOperations,
): Promise<string> {
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const candidate = join(
      dirname(target),
      `.${basename(target)}.${process.pid}.${randomBytes(12).toString("hex")}.tmp`,
    );
    try {
      await operations.lstat(candidate);
    } catch (error) {
      if (hasErrorCode(error, "ENOENT")) return candidate;
      throw error;
    }
  }
  throw new Error(`Unable to allocate a unique sibling temporary file for ${target}.`);
}

async function prepareManagedDirectory(
  rootValue: string,
  directoryValue: string,
  operations: ManagedFileSystemOperations,
): Promise<ManagedDirectoryContext> {
  const { root, target: directory } = resolveManagedPair(rootValue, directoryValue);
  const rootContext = await ensureManagedRoot(root, operations);
  const fingerprints = [rootContext.fingerprint];
  let current = root;
  let expectedRealPath = rootContext.fingerprint.realPath;
  const rel = relative(root, directory);
  const segments = rel === "" ? [] : rel.split(/[\\/]+/u);
  for (const segment of segments) {
    await revalidateFingerprints(fingerprints, operations);
    current = join(current, segment);
    expectedRealPath = join(expectedRealPath, segment);
    try {
      await operations.mkdir(current);
    } catch (error) {
      if (!hasErrorCode(error, "EEXIST")) throw error;
    }
    const fingerprint = await inspectDirectory(current, operations, expectedRealPath);
    fingerprints.push(fingerprint);
  }
  await revalidateFingerprints(fingerprints, operations);
  return { root, directory, rootRealPath: rootContext.fingerprint.realPath, fingerprints };
}

async function inspectManagedDirectory(
  rootValue: string,
  directoryValue: string,
  operations: ManagedFileSystemOperations,
): Promise<ManagedDirectoryContext> {
  const { root, target: directory } = resolveManagedPair(rootValue, directoryValue);
  const rootFingerprint = await inspectDirectory(root, operations);
  const fingerprints = [rootFingerprint];
  let current = root;
  let expectedRealPath = rootFingerprint.realPath;
  const rel = relative(root, directory);
  const segments = rel === "" ? [] : rel.split(/[\\/]+/u);
  for (const segment of segments) {
    current = join(current, segment);
    expectedRealPath = join(expectedRealPath, segment);
    fingerprints.push(await inspectDirectory(current, operations, expectedRealPath));
  }
  await revalidateFingerprints(fingerprints, operations);
  return { root, directory, rootRealPath: rootFingerprint.realPath, fingerprints };
}

async function ensureManagedRoot(
  root: string,
  operations: ManagedFileSystemOperations,
): Promise<{ fingerprint: PathFingerprint }> {
  await assertManagedRootAncestors(root, operations);
  try {
    return { fingerprint: await inspectDirectory(root, operations) };
  } catch (error) {
    if (!hasErrorCode(error, "ENOENT")) throw error;
  }

  const missing: string[] = [];
  let existing = root;
  while (true) {
    try {
      const existingFingerprint = await inspectDirectory(existing, operations);
      let parentFingerprint = existingFingerprint;
      for (const child of missing.reverse()) {
        await revalidateFingerprint(parentFingerprint, "managed directory", operations);
        try {
          await operations.mkdir(child);
        } catch (error) {
          if (!hasErrorCode(error, "EEXIST")) throw error;
        }
        parentFingerprint = await inspectDirectory(
          child,
          operations,
          join(parentFingerprint.realPath, basename(child)),
        );
      }
      return { fingerprint: parentFingerprint };
    } catch (error) {
      if (!hasErrorCode(error, "ENOENT")) throw error;
      const parent = dirname(existing);
      if (parent === existing) throw error;
      missing.push(existing);
      existing = parent;
    }
  }
}

async function assertManagedRootAncestors(
  root: string,
  operations: ManagedFileSystemOperations,
): Promise<void> {
  const trustedTempRoot = resolve(tmpdir());
  let current = root;
  while (true) {
    try {
      const metadata = await operations.lstat(current);
      if (metadata.isSymbolicLink() && !isAncestorPath(current, trustedTempRoot)) {
        throw new Error(`Managed root traverses a symlink, junction, or reparse point: ${current}`);
      }
    } catch (error) {
      if (!hasErrorCode(error, "ENOENT")) throw error;
    }
    const parent = dirname(current);
    if (parent === current) return;
    current = parent;
  }
}

function isAncestorPath(ancestor: string, value: string): boolean {
  const rel = relative(resolve(ancestor), resolve(value));
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

async function inspectDirectory(
  path: string,
  operations: ManagedFileSystemOperations,
  expectedRealPath?: string,
): Promise<PathFingerprint> {
  const stats = await operations.lstat(path);
  if (stats.isSymbolicLink() || !stats.isDirectory()) {
    throw new Error(`Managed directory must be a real directory, not a symlink, junction, reparse target, or file: ${path}`);
  }
  const actualRealPath = await operations.realpath(path);
  if (expectedRealPath && !samePath(actualRealPath, expectedRealPath)) {
    throw new Error(`Managed directory traverses a symlink, junction, or reparse point: ${path}`);
  }
  return fingerprint(path, actualRealPath, stats);
}

async function inspectManagedFile(
  path: string,
  context: ManagedDirectoryContext,
  operations: ManagedFileSystemOperations,
): Promise<PathFingerprint> {
  const stats = await operations.lstat(path);
  if (stats.isSymbolicLink() || !stats.isFile()) {
    throw new Error(`Managed file target must be a regular file, not a symlink, junction, reparse target, or directory: ${path}`);
  }
  const actualRealPath = await operations.realpath(path);
  const parentRealPath = context.fingerprints.at(-1)?.realPath ?? context.rootRealPath;
  const expectedRealPath = join(parentRealPath, basename(path));
  if (!samePath(actualRealPath, expectedRealPath)) {
    throw new Error(`Managed file target traverses a symlink, junction, or reparse point: ${path}`);
  }
  return fingerprint(path, actualRealPath, stats);
}

async function inspectOptionalManagedFile(
  path: string,
  context: ManagedDirectoryContext,
  operations: ManagedFileSystemOperations,
): Promise<PathFingerprint | undefined> {
  try {
    return await inspectManagedFile(path, context, operations);
  } catch (error) {
    if (hasErrorCode(error, "ENOENT")) return undefined;
    throw error;
  }
}

async function revalidateOptionalTarget(
  path: string,
  initial: PathFingerprint | undefined,
  context: ManagedDirectoryContext,
  operations: ManagedFileSystemOperations,
  refuseIfCreated: boolean,
): Promise<void> {
  const current = await inspectOptionalManagedFile(path, context, operations);
  if (!initial && !current) return;
  if (!initial && current && refuseIfCreated) {
    throw refusingToOverwriteError(path);
  }
  if (!initial || !current || !sameIdentity(initial, current)) {
    throw new Error(`Managed file target changed while preparing the write: ${path}`);
  }
}

async function revalidateDirectoryContext(
  context: ManagedDirectoryContext,
  operations: ManagedFileSystemOperations,
): Promise<void> {
  await revalidateFingerprints(context.fingerprints, operations);
}

async function revalidateFingerprints(
  fingerprints: PathFingerprint[],
  operations: ManagedFileSystemOperations,
): Promise<void> {
  for (const item of fingerprints) {
    await revalidateFingerprint(item, "managed directory", operations);
  }
}

async function revalidateFingerprint(
  original: PathFingerprint,
  label: string,
  operations: ManagedFileSystemOperations,
): Promise<void> {
  const stats = await operations.lstat(original.path);
  const actualRealPath = await operations.realpath(original.path);
  const current = fingerprint(original.path, actualRealPath, stats);
  if (stats.isSymbolicLink() || !samePath(original.realPath, actualRealPath) || !sameIdentity(original, current)) {
    throw new Error(`${label} was replaced during a filesystem operation: ${original.path}`);
  }
}

function resolveManagedTarget(rootValue: string, targetValue: string): string {
  return resolveManagedPair(rootValue, targetValue).target;
}

function resolveManagedPair(rootValue: string, targetValue: string): { root: string; target: string } {
  if (!isAbsolute(rootValue)) {
    throw new Error(`Managed root must be an absolute path: ${rootValue}`);
  }
  if (!isAbsolute(targetValue)) {
    throw new Error(`Managed target must be an absolute path: ${targetValue}`);
  }
  const root = resolve(rootValue);
  const target = resolve(targetValue);
  const rel = relative(root, target);
  if (rel === ".." || rel.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) || isAbsolute(rel)) {
    throw new Error(`Managed target must stay inside its managed root: ${target}`);
  }
  return { root, target };
}

function fingerprint(path: string, realPath: string, stats: Stats): PathFingerprint {
  return {
    path,
    realPath,
    dev: stats.dev,
    ino: stats.ino,
    mode: stats.mode,
    birthtimeMs: stats.birthtimeMs,
  };
}

function sameIdentity(left: PathFingerprint, right: PathFingerprint): boolean {
  if (left.dev !== 0 || left.ino !== 0 || right.dev !== 0 || right.ino !== 0) {
    return left.dev === right.dev && left.ino === right.ino;
  }
  return left.mode === right.mode && left.birthtimeMs === right.birthtimeMs;
}

function samePath(left: string, right: string): boolean {
  const normalizedLeft = resolve(left);
  const normalizedRight = resolve(right);
  return process.platform === "win32"
    ? normalizedLeft.toLowerCase() === normalizedRight.toLowerCase()
    : normalizedLeft === normalizedRight;
}

function mergeOperations(
  operations: Partial<ManagedFileSystemOperations> | undefined,
): ManagedFileSystemOperations {
  return { ...DEFAULT_OPERATIONS, ...operations };
}

function refusingToOverwriteError(path: string): Error {
  const error = new Error(`Refusing to overwrite existing file without overwrite=true: ${path}`);
  Object.assign(error, { code: "EEXIST" });
  return error;
}

function hasErrorCode(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}
