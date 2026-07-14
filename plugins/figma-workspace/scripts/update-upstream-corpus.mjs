import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  access,
  mkdir,
  mkdtemp,
  open,
  readFile,
  rename,
  rm,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { buildUpstreamActive } from "./lib/upstream-active.mjs";

export const OFFICIAL_UPSTREAM_REPOSITORY = "https://github.com/figma/mcp-server-guide.git";
export const DEFAULT_UPSTREAM_REF = "main";
export const FIGMA_DEVELOPER_TERMS_URL = "https://www.figma.com/legal/developer-terms/";

const execFileAsync = promisify(execFile);
const pluginRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const defaultOutputDir = resolve(
  pluginRoot,
  "skills/figma-workspace/references/upstream-corpus",
);
const defaultActiveOutputDir = resolve(
  pluginRoot,
  "skills/figma-workspace/references/upstream-active",
);
const corpusContract = "Internal lookup corpus only; agents use the guidance and lookup CLI commands instead of reading upstream files directly.";
const workflowSkillReason = "Standalone workflow skill; excluded from the bundled upstream lookup corpus.";
const utf8Decoder = new TextDecoder("utf-8", { fatal: true });

export function parseCliArgs(args) {
  let requestedRef = DEFAULT_UPSTREAM_REF;
  let sawRef = false;

  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument !== "--ref") {
      throw new Error(`Unknown argument: ${argument}`);
    }
    if (sawRef) {
      throw new Error("Duplicate option: --ref");
    }
    const value = args[index + 1];
    if (value === undefined || value.startsWith("--")) {
      throw new Error("--ref requires a <git-ref> value");
    }
    validateRequestedRef(value);
    requestedRef = value;
    sawRef = true;
    index += 1;
  }

  return { requestedRef };
}

export async function updateUpstreamCorpus(options = {}) {
  const repository = options.repository ?? OFFICIAL_UPSTREAM_REPOSITORY;
  const requestedRef = options.requestedRef ?? DEFAULT_UPSTREAM_REF;
  const outputDir = resolve(options.outputDir ?? defaultOutputDir);
  const generatedAt = options.generatedAt ?? new Date().toISOString();
  validateRequestedRef(requestedRef);
  validateGenerationOptions({ repository, generatedAt });

  const gitDir = await mkdtemp(join(tmpdir(), "figma-upstream-corpus-git-"));
  try {
    await runGit(gitDir, ["init", "--quiet"]);
    await runGit(gitDir, ["remote", "add", "origin", repository]);
    await runGit(gitDir, [
      "-c",
      "protocol.file.allow=always",
      "fetch",
      "--quiet",
      "--no-tags",
      "--depth=1",
      "origin",
      requestedRef,
    ]);
    const resolvedCommit = (await runGitText(gitDir, [
      "rev-parse",
      "--verify",
      "FETCH_HEAD^{commit}",
    ])).trim();
    if (!/^[0-9a-f]{40,64}$/u.test(resolvedCommit)) {
      throw new Error(`Git resolved an invalid commit object ID: ${resolvedCommit}`);
    }

    const skillsTree = (await runGitText(gitDir, [
      "rev-parse",
      "--verify",
      `${resolvedCommit}:skills`,
    ])).trim();
    const entries = parseTreeEntries(await runGit(gitDir, [
      "ls-tree",
      "-rz",
      "--full-tree",
      skillsTree,
    ]));
    if (entries.length === 0) {
      throw new Error("The upstream skills/ tree contains no files");
    }

    const records = [];
    for (const entry of entries) {
      validateCorpusEntry(entry);
      const sourceBytes = await runGit(gitDir, ["cat-file", "blob", entry.objectId]);
      const text = decodeUtf8(sourceBytes, entry.path).replace(/\r\n/gu, "\n");
      const skill = entry.path.split("/")[0];
      records.push({
        schemaVersion: 2,
        id: entry.path,
        skill,
        kind: getRecordKind(entry.path),
        format: getRecordFormat(entry.path),
        sourcePath: entry.path,
        lineCount: text.split("\n").length,
        contentSha256: sha256(text),
        text,
      });
    }
    records.sort((left, right) => comparePosixPaths(left.id, right.id));
    validateSkills(records);

    const includedSkills = [...new Set(records.map((record) => record.skill))]
      .sort(comparePosixPaths);
    const workflowSkills = await readWorkflowSkills(gitDir, resolvedCommit);
    const outOfScopeSkills = workflowSkills.map((skill) => ({
      skill,
      reason: workflowSkillReason,
    }));
    const contentHashes = Object.fromEntries(
      records.map((record) => [record.id, record.contentSha256]),
    );
    const corpusJsonl = `${records.map((record) => JSON.stringify(record)).join("\n")}\n`;
    const corpusSha256 = sha256(corpusJsonl);
    const corpusFile = `corpus-${corpusSha256}.jsonl`;
    const manifest = {
      schemaVersion: 2,
      generatedAt,
      upstream: {
        repository,
        requestedRef,
        resolvedCommit,
        sourcePath: "skills",
        termsUrl: FIGMA_DEVELOPER_TERMS_URL,
      },
      corpus: {
        file: corpusFile,
        recordCount: records.length,
        sha256: corpusSha256,
        contract: corpusContract,
      },
      includedSkills,
      outOfScopeSkills,
      integrity: {
        algorithm: "sha256",
        textNormalization: "crlf-to-lf",
        contentHashes,
      },
    };
    const manifestJson = `${JSON.stringify(manifest, null, 2)}\n`;

    const activeOutputDir = resolve(options.activeOutputDir ?? defaultActiveOutputDir);
    if (options.buildActive !== false) {
      const previewRawRoot = join(gitDir, "raw-preview");
      await mkdir(previewRawRoot, { recursive: true });
      await writeSyncedFile(join(previewRawRoot, corpusFile), corpusJsonl);
      await writeSyncedFile(join(previewRawRoot, "manifest.json"), manifestJson);
      await buildUpstreamActive({
        rawRoot: previewRawRoot,
        activeRoot: activeOutputDir,
        generatedAt,
        expectedPolicyFragmentCount: options.expectedPolicyFragmentCount,
        publish: false,
      });
    }

    const previousRawManifest = await readOptionalUtf8(join(outputDir, "manifest.json"));

    await publishCorpus(outputDir, {
      corpusFile,
      corpusJsonl,
      corpusSha256,
      manifestJson,
      renameFile: options.renameFile ?? rename,
      syncDirectoryFn: options.syncDirectoryFn ?? syncDirectory,
    });
    let active;
    try {
      active = options.buildActive === false
        ? undefined
        : await buildUpstreamActive({
          rawRoot: outputDir,
          activeRoot: activeOutputDir,
          generatedAt,
          expectedPolicyFragmentCount: options.expectedPolicyFragmentCount,
          renameFile: options.activeRenameFile,
          syncDirectoryFn: options.activeSyncDirectoryFn,
        });
    } catch (error) {
      await restoreRawManifest(outputDir, previousRawManifest, {
        renameFile: options.rollbackRenameFile ?? rename,
        syncDirectoryFn: options.syncDirectoryFn ?? syncDirectory,
      });
      throw error;
    }
    return { manifest, records, outputDir, active };
  } finally {
    await rm(gitDir, { recursive: true, force: true });
  }
}

async function readWorkflowSkills(gitDir, resolvedCommit) {
  let workflowTree;
  try {
    workflowTree = (await runGitText(gitDir, [
      "rev-parse",
      "--verify",
      `${resolvedCommit}:workflow-skills`,
    ])).trim();
  } catch (error) {
    if (isMissingRevisionError(error)) {
      return [];
    }
    throw error;
  }

  const entries = parseTreeEntries(await runGit(gitDir, [
    "ls-tree",
    "-z",
    "--full-tree",
    workflowTree,
  ]));
  const skills = [];
  for (const entry of entries) {
    validateSafePosixPath(entry.path, "workflow skill");
    if (entry.path.includes("/") || entry.type !== "tree" || entry.mode !== "040000") {
      throw new Error(`Invalid workflow-skills top-level entry: ${entry.path}`);
    }
    skills.push(entry.path);
  }
  return skills.sort(comparePosixPaths);
}

function parseTreeEntries(output) {
  const entries = [];
  let start = 0;
  for (let index = 0; index < output.length; index += 1) {
    if (output[index] !== 0) {
      continue;
    }
    const rawEntry = output.subarray(start, index);
    start = index + 1;
    if (rawEntry.length === 0) {
      continue;
    }
    const tab = rawEntry.indexOf(9);
    if (tab === -1) {
      throw new Error("Git returned a malformed tree entry");
    }
    const metadata = decodeUtf8(rawEntry.subarray(0, tab), "Git tree metadata");
    const match = /^(\d{6}) (blob|tree|commit) ([0-9a-f]{40,64})$/u.exec(metadata);
    if (!match) {
      throw new Error(`Git returned malformed tree metadata: ${metadata}`);
    }
    entries.push({
      mode: match[1],
      type: match[2],
      objectId: match[3],
      path: decodeUtf8(rawEntry.subarray(tab + 1), "Git tree path"),
    });
  }
  if (start !== output.length) {
    throw new Error("Git returned a tree listing without a NUL terminator");
  }
  return entries;
}

function validateCorpusEntry(entry) {
  validateSafePosixPath(entry.path, "skills entry");
  if (entry.mode !== "100644" && entry.mode !== "100755") {
    throw new Error(`Unsupported Git mode ${entry.mode} for skills/${entry.path}`);
  }
  if (entry.type !== "blob") {
    throw new Error(`Unsupported Git object type ${entry.type} for skills/${entry.path}`);
  }
  if (!entry.path.includes("/")) {
    throw new Error(`A skills/ file must belong to a top-level skill: ${entry.path}`);
  }
  if (!entry.path.endsWith(".md") && !entry.path.endsWith(".ts") && !entry.path.endsWith(".js")) {
    throw new Error(`Unsupported file extension in skills/${entry.path}`);
  }
}

function validateSafePosixPath(path, label) {
  if (
    path.length === 0
    || path.startsWith("/")
    || path.endsWith("/")
    || path.includes("\\")
    || /[\u0000-\u001f\u007f]/u.test(path)
  ) {
    throw new Error(`Invalid ${label} path: ${JSON.stringify(path)}`);
  }
  const segments = path.split("/");
  if (segments.some((segment) => segment === "" || segment === "." || segment === "..")) {
    throw new Error(`Invalid ${label} path: ${JSON.stringify(path)}`);
  }
}

function validateSkills(records) {
  const paths = new Set();
  const skills = new Set();
  for (const record of records) {
    if (paths.has(record.id)) {
      throw new Error(`Duplicate skills path: ${record.id}`);
    }
    paths.add(record.id);
    skills.add(record.skill);
  }
  for (const skill of skills) {
    if (!paths.has(`${skill}/SKILL.md`)) {
      throw new Error(`Upstream skill is missing skills/${skill}/SKILL.md`);
    }
  }
}

function getRecordKind(path) {
  if (path.split("/").length === 2 && path.endsWith("/SKILL.md")) {
    return "skill";
  }
  return path.endsWith(".md") ? "reference" : "script";
}

function getRecordFormat(path) {
  if (path.endsWith(".md")) {
    return "markdown";
  }
  return path.endsWith(".ts") ? "typescript" : "javascript";
}

function validateRequestedRef(requestedRef) {
  if (
    typeof requestedRef !== "string"
    || requestedRef.length === 0
    || requestedRef.startsWith("-")
    || /[\u0000-\u0020\u007f]/u.test(requestedRef)
  ) {
    throw new Error(`Invalid git ref: ${JSON.stringify(requestedRef)}`);
  }
}

function validateGenerationOptions({ repository, generatedAt }) {
  if (typeof repository !== "string" || repository.length === 0 || /[\u0000\r\n]/u.test(repository)) {
    throw new Error("repository must be a non-empty Git repository location");
  }
  if (typeof generatedAt !== "string" || generatedAt.length === 0) {
    throw new Error("generatedAt must be a non-empty string");
  }
}

async function publishCorpus(outputDir, options) {
  await mkdir(outputDir, { recursive: true });
  const transactionId = `${process.pid}-${randomUUID()}`;
  const corpusPath = join(outputDir, options.corpusFile);

  if (await pathExists(corpusPath)) {
    const existingCorpus = await readFile(corpusPath);
    if (sha256(existingCorpus) !== options.corpusSha256) {
      throw new Error(`Existing content-addressed corpus failed integrity: ${options.corpusFile}`);
    }
  } else {
    const corpusTemporary = join(outputDir, `.${options.corpusFile}.${transactionId}.tmp`);
    await writeSyncedFile(corpusTemporary, options.corpusJsonl);
    try {
      await options.renameFile(corpusTemporary, corpusPath);
      await options.syncDirectoryFn(outputDir);
    } catch (error) {
      await removeFailedTemporary(corpusTemporary, error);
    }
  }

  const manifestPath = join(outputDir, "manifest.json");
  const manifestTemporary = join(outputDir, `.manifest.json.${transactionId}.tmp`);
  await writeSyncedFile(manifestTemporary, options.manifestJson);
  try {
    await options.renameFile(manifestTemporary, manifestPath);
    await options.syncDirectoryFn(outputDir);
  } catch (error) {
    await removeFailedTemporary(manifestTemporary, error);
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

async function readOptionalUtf8(path) {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") {
      return undefined;
    }
    throw error;
  }
}

async function restoreRawManifest(outputDir, previousManifest, options) {
  const manifestPath = join(outputDir, "manifest.json");
  if (previousManifest === undefined) {
    await rm(manifestPath, { force: true });
    await options.syncDirectoryFn(outputDir);
    return;
  }
  const temporary = join(outputDir, `.manifest.json.rollback-${process.pid}-${randomUUID()}.tmp`);
  await writeSyncedFile(temporary, previousManifest);
  try {
    await options.renameFile(temporary, manifestPath);
    await options.syncDirectoryFn(outputDir);
  } catch (error) {
    await removeFailedTemporary(temporary, error);
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
  // Node on Windows does not support opening a directory for fsync. Files are still fsynced before rename.
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

async function runGit(cwd, args) {
  try {
    const { stdout } = await execFileAsync("git", args, {
      cwd,
      encoding: "buffer",
      maxBuffer: 256 * 1024 * 1024,
      windowsHide: true,
    });
    return stdout;
  } catch (error) {
    const stderr = Buffer.isBuffer(error?.stderr)
      ? error.stderr.toString("utf8").trim()
      : String(error?.stderr ?? "").trim();
    const wrapped = new Error(stderr || `git ${args[0]} failed`);
    wrapped.cause = error;
    wrapped.gitStderr = stderr;
    throw wrapped;
  }
}

async function runGitText(cwd, args) {
  return decodeUtf8(await runGit(cwd, args), `git ${args[0]} output`);
}

function isMissingRevisionError(error) {
  return /unknown revision|bad revision|invalid object name|Needed a single revision|does not exist/iu
    .test(error?.gitStderr ?? error?.message ?? "");
}

function decodeUtf8(value, label) {
  try {
    return utf8Decoder.decode(value);
  } catch {
    throw new Error(`${label} is not valid UTF-8`);
  }
}

function sha256(value) {
  return createHash("sha256").update(value, typeof value === "string" ? "utf8" : undefined).digest("hex");
}

function comparePosixPaths(left, right) {
  return Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"));
}

async function main() {
  const { requestedRef } = parseCliArgs(process.argv.slice(2));
  const result = await updateUpstreamCorpus({ requestedRef });
  process.stdout.write(`wrote ${result.records.length} upstream corpus records to ${result.outputDir}\n`);
  if (result.active.manifest.pendingCount > 0 || result.active.manifest.retiredCount > 0) {
    process.stderr.write(
      `warning: upstream active index has ${result.active.manifest.pendingCount} pending and ${result.active.manifest.retiredCount} retired records\n`,
    );
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
