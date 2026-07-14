import { createHash, randomUUID } from "node:crypto";
import { access, mkdir, open, readFile, rename, rm } from "node:fs/promises";
import { join } from "node:path";

export async function publishContentAddressed(options) {
  const {
    root,
    contentFile,
    content,
    contentSha256,
    manifest,
    renameFile = rename,
    syncDirectoryFn = syncDirectory,
  } = options;
  await mkdir(root, { recursive: true });
  const transactionId = `${process.pid}-${randomUUID()}`;
  const contentPath = join(root, contentFile);

  if (await pathExists(contentPath)) {
    const existing = await readFile(contentPath);
    if (sha256Bytes(existing) !== contentSha256) {
      throw new Error(`Existing content-addressed file failed integrity: ${contentFile}`);
    }
  } else {
    const temporary = join(root, `.${contentFile}.${transactionId}.tmp`);
    await writeSyncedFile(temporary, content);
    try {
      await renameFile(temporary, contentPath);
      await syncDirectoryFn(root);
    } catch (error) {
      await removeFailedTemporary(temporary, error);
    }
  }

  const manifestPath = join(root, "manifest.json");
  const temporary = join(root, `.manifest.json.${transactionId}.tmp`);
  await writeSyncedFile(temporary, manifest);
  let manifestSwitched = false;
  try {
    await renameFile(temporary, manifestPath);
    manifestSwitched = true;
    await syncDirectoryFn(root);
  } catch (error) {
    const failure = error instanceof Error ? error : new Error(String(error));
    failure.manifestSwitched = manifestSwitched;
    await removeFailedTemporary(temporary, failure);
  }
  return { manifestSwitched: true };
}

export async function replaceManifest(root, manifest, options = {}) {
  await mkdir(root, { recursive: true });
  if (manifest === undefined) {
    await rm(join(root, "manifest.json"), { force: true });
    await (options.syncDirectoryFn ?? syncDirectory)(root);
    return;
  }
  const temporary = join(root, `.manifest.json.rollback-${process.pid}-${randomUUID()}.tmp`);
  await writeSyncedFile(temporary, manifest);
  try {
    await (options.renameFile ?? rename)(temporary, join(root, "manifest.json"));
    await (options.syncDirectoryFn ?? syncDirectory)(root);
  } catch (error) {
    await removeFailedTemporary(temporary, error);
  }
}

async function writeSyncedFile(path, content) {
  try {
    const handle = await open(path, "wx");
    try {
      await handle.writeFile(content, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
  } catch (error) {
    await removeFailedTemporary(path, error);
  }
}

async function removeFailedTemporary(path, originalError) {
  try {
    await rm(path, { force: true });
  } catch (cleanupError) {
    throw new AggregateError(
      [originalError, cleanupError],
      `Operation failed and temporary cleanup also failed: ${path}`,
    );
  }
  throw originalError;
}

async function syncDirectory(directory) {
  // Node on Windows cannot fsync directories. Files are still fsynced before rename.
  if (process.platform === "win32") {
    return;
  }
  const handle = await open(directory, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function pathExists(path) {
  try {
    await access(path);
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") {
      return false;
    }
    throw error;
  }
}

function sha256Bytes(value) {
  return createHash("sha256").update(value).digest("hex");
}
