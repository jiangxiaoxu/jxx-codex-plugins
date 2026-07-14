import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { buildCanonicalCorpus } from "./lib/canonical-corpus.mjs";
import {
  publishContentAddressed,
  replaceManifest,
} from "./lib/content-addressed-publication.mjs";

export const OFFICIAL_UPSTREAM_REPOSITORY = "https://github.com/figma/mcp-server-guide.git";
export const DEFAULT_UPSTREAM_REF = "main";
export const FIGMA_DEVELOPER_TERMS_URL = "https://www.figma.com/legal/developer-terms/";

const execFileAsync = promisify(execFile);
const pluginRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const defaultSnapshotRoot = resolve(pluginRoot, "dev/upstream-snapshot");
const defaultChangesRoot = resolve(pluginRoot, "dev/upstream-changes");
const defaultCanonicalRoot = resolve(
  pluginRoot,
  "skills/figma-workspace/references/canonical-corpus",
);
const defaultPolicyRoot = join(defaultCanonicalRoot, "policy");
const policyClassifications = new Set(["active", "conditional", "router", "examples", "api"]);
const snapshotContract = "Development-only complete upstream snapshot; never packaged or read at runtime.";
const workflowSkillReason = "Standalone workflow skill; excluded from the tracked skills snapshot.";
const utf8Decoder = new TextDecoder("utf-8", { fatal: true });

export function parseCliInvocation(args) {
  const command = args[0];
  if (command === "build-canonical-corpus") {
    if (args.length !== 1) {
      throw new Error(`Unknown argument: ${args[1]}`);
    }
    return { command };
  }
  if (command !== "update-upstream-snapshot") {
    throw new Error("Expected command: update-upstream-snapshot or build-canonical-corpus");
  }
  let requestedRef = DEFAULT_UPSTREAM_REF;
  let sawRef = false;
  for (let index = 1; index < args.length; index += 1) {
    if (args[index] !== "--ref") {
      throw new Error(`Unknown argument: ${args[index]}`);
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
  return { command, requestedRef };
}

export async function updateUpstreamSnapshot(options = {}) {
  const repository = options.repository ?? OFFICIAL_UPSTREAM_REPOSITORY;
  const requestedRef = options.requestedRef ?? DEFAULT_UPSTREAM_REF;
  const snapshotRoot = resolve(options.snapshotRoot ?? defaultSnapshotRoot);
  const changesRoot = resolve(options.changesRoot ?? defaultChangesRoot);
  const policyRoot = resolve(options.policyRoot ?? defaultPolicyRoot);
  const generatedAt = options.generatedAt ?? new Date().toISOString();
  const expectedPolicyFragmentCount = options.expectedPolicyFragmentCount ?? 12;
  validateRequestedRef(requestedRef);
  validateGenerationOptions({ repository, generatedAt });
  if (!Number.isSafeInteger(expectedPolicyFragmentCount) || expectedPolicyFragmentCount < 1) {
    throw new Error("expectedPolicyFragmentCount must be a positive integer");
  }

  const previousManifestText = await readOptionalUtf8(join(snapshotRoot, "manifest.json"));
  const previousChangesManifestText = await readOptionalUtf8(join(changesRoot, "manifest.json"));
  const previous = previousManifestText === undefined
    ? undefined
    : await readSnapshot(snapshotRoot, previousManifestText);
  const acceptedPolicies = await readAcceptedPolicies(policyRoot, expectedPolicyFragmentCount);
  const gitDir = await mkdtemp(join(tmpdir(), "figma-upstream-snapshot-git-"));
  try {
    const acquired = await acquireSnapshot({ gitDir, repository, requestedRef });
    const snapshot = createSnapshot({
      repository,
      requestedRef,
      generatedAt,
      resolvedCommit: acquired.resolvedCommit,
      records: acquired.records,
      workflowSkills: acquired.workflowSkills,
    });
    const report = createChangeReport(previous, snapshot, generatedAt, acceptedPolicies);
    const reportJson = `${JSON.stringify(report, null, 2)}\n`;
    const reportSha256 = sha256(reportJson);
    const reportFile = `report-${reportSha256}.json`;
    const changesManifest = {
      schemaVersion: 1,
      generatedAt,
      upstream: {
        repository,
        requestedRef,
        resolvedCommit: acquired.resolvedCommit,
      },
      snapshot: {
        file: snapshot.manifest.corpus.file,
        sha256: snapshot.manifest.corpus.sha256,
        recordCount: snapshot.records.length,
      },
      report: {
        file: reportFile,
        sha256: reportSha256,
        ...report.summary,
      },
      adaptation: report.adaptation,
    };
    const changesManifestJson = `${JSON.stringify(changesManifest, null, 2)}\n`;

    let snapshotManifestSwitched = false;
    let changesManifestSwitched = false;
    let publicationPhase = "snapshot";
    try {
      await publishContentAddressed({
        root: snapshotRoot,
        contentFile: snapshot.manifest.corpus.file,
        content: snapshot.corpusJsonl,
        contentSha256: snapshot.manifest.corpus.sha256,
        manifest: snapshot.manifestJson,
        renameFile: options.snapshotRenameFile,
        syncDirectoryFn: options.snapshotSyncDirectoryFn,
      });
      snapshotManifestSwitched = true;
      publicationPhase = "changes";
      await publishContentAddressed({
        root: changesRoot,
        contentFile: reportFile,
        content: reportJson,
        contentSha256: reportSha256,
        manifest: changesManifestJson,
        renameFile: options.changesRenameFile,
        syncDirectoryFn: options.changesSyncDirectoryFn,
      });
      changesManifestSwitched = true;
    } catch (error) {
      if (error?.manifestSwitched === true) {
        if (publicationPhase === "snapshot") {
          snapshotManifestSwitched = true;
        } else {
          changesManifestSwitched = true;
        }
      }
      const rollbacks = [];
      if (snapshotManifestSwitched) {
        rollbacks.push(replaceManifest(snapshotRoot, previousManifestText, {
          renameFile: options.rollbackRenameFile,
          syncDirectoryFn: options.snapshotSyncDirectoryFn,
        }));
      }
      if (changesManifestSwitched) {
        rollbacks.push(replaceManifest(changesRoot, previousChangesManifestText, {
          renameFile: options.changesRollbackRenameFile ?? options.rollbackRenameFile,
          syncDirectoryFn: options.changesRollbackSyncDirectoryFn,
        }));
      }
      const rollbackResults = await Promise.allSettled(rollbacks);
      const rollbackErrors = rollbackResults
        .filter((result) => result.status === "rejected")
        .map((result) => result.reason);
      if (rollbackErrors.length > 0) {
        throw new AggregateError(
          [error, ...rollbackErrors],
          "Upstream publication failed and manifest rollback was incomplete",
        );
      }
      throw error;
    }
    return {
      snapshotRoot,
      changesRoot,
      policyRoot,
      manifest: snapshot.manifest,
      records: snapshot.records,
      changeManifest: changesManifest,
      report,
    };
  } finally {
    await rm(gitDir, { recursive: true, force: true });
  }
}

async function acquireSnapshot({ gitDir, repository, requestedRef }) {
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
    validateSnapshotEntry(entry);
    const bytes = await runGit(gitDir, ["cat-file", "blob", entry.objectId]);
    const text = decodeUtf8(bytes, entry.path).replace(/\r\n/gu, "\n");
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
  records.sort(compareRecords);
  validateSkills(records);
  return {
    resolvedCommit,
    records,
    workflowSkills: await readWorkflowSkills(gitDir, resolvedCommit),
  };
}

function createSnapshot({ repository, requestedRef, generatedAt, resolvedCommit, records, workflowSkills }) {
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
      contract: snapshotContract,
    },
    includedSkills: [...new Set(records.map((record) => record.skill))].sort(compareStrings),
    outOfScopeSkills: workflowSkills.map((skill) => ({
      skill,
      reason: workflowSkillReason,
    })),
    integrity: {
      algorithm: "sha256",
      textNormalization: "crlf-to-lf",
      contentHashes: Object.fromEntries(records.map((record) => [record.id, record.contentSha256])),
    },
  };
  return {
    records,
    corpusJsonl,
    manifest,
    manifestJson: `${JSON.stringify(manifest, null, 2)}\n`,
  };
}

function createChangeReport(previous, current, generatedAt, acceptedPolicies) {
  const previousById = new Map(previous?.records.map((record) => [record.id, record]) ?? []);
  const currentById = new Map(current.records.map((record) => [record.id, record]));
  const added = [];
  const changed = [];
  const deleted = [];
  let unchanged = 0;
  for (const record of current.records) {
    const prior = previousById.get(record.id);
    if (prior === undefined) {
      added.push(snapshotIdentity(record));
    } else if (prior.contentSha256 !== record.contentSha256) {
      changed.push({
        ...snapshotIdentity(record),
        previousContentSha256: prior.contentSha256,
      });
    } else {
      unchanged += 1;
    }
  }
  for (const record of previous?.records ?? []) {
    if (!currentById.has(record.id)) {
      deleted.push(snapshotIdentity(record));
    }
  }
  return {
    schemaVersion: 1,
    generatedAt,
    from: previous === undefined ? null : snapshotPointer(previous.manifest),
    to: snapshotPointer(current.manifest),
    summary: {
      newCount: added.length,
      changedCount: changed.length,
      deletedCount: deleted.length,
      unchangedCount: unchanged,
    },
    changes: { new: added, changed, deleted },
    adaptation: createAdaptationStatus(current.records, acceptedPolicies),
  };
}

function createAdaptationStatus(snapshotRecords, acceptedPolicies) {
  const snapshotById = new Map(snapshotRecords.map((record) => [record.id, record]));
  const policyById = new Map(acceptedPolicies.map((policy) => [policy.id, policy]));
  const pendingRecords = [];
  const retiredRecords = [];
  let readyCount = 0;

  for (const source of snapshotRecords) {
    const policy = policyById.get(source.id);
    if (policy === undefined) {
      pendingRecords.push({
        id: source.id,
        skill: source.skill,
        classification: inferPolicyClassification(source.format),
        state: "pending",
        drift: "new",
        sourceContentSha256: source.contentSha256,
      });
      continue;
    }
    if (policy.sourceContentSha256 !== source.contentSha256) {
      pendingRecords.push({
        id: source.id,
        skill: source.skill,
        classification: policy.classification,
        state: "pending",
        drift: "changed",
        sourceContentSha256: source.contentSha256,
        policySourceContentSha256: policy.sourceContentSha256,
      });
      continue;
    }
    readyCount += 1;
  }

  for (const policy of acceptedPolicies) {
    if (!snapshotById.has(policy.id)) {
      retiredRecords.push({
        id: policy.id,
        skill: policy.skill,
        classification: policy.classification,
        state: "retired",
        policySourceContentSha256: policy.sourceContentSha256,
      });
    }
  }
  pendingRecords.sort(compareRecords);
  retiredRecords.sort(compareRecords);
  return {
    readyCount,
    pendingCount: pendingRecords.length,
    retiredCount: retiredRecords.length,
    pendingRecords,
    retiredRecords,
  };
}

async function readAcceptedPolicies(policyRoot, expectedCount) {
  const entries = await readdir(policyRoot, { withFileTypes: true });
  if (entries.some((entry) => !entry.isFile() || !entry.name.endsWith(".json"))) {
    throw new Error("canonical policy directory may contain only JSON policy fragments");
  }
  const files = entries.map((entry) => entry.name).sort(compareStrings);
  if (files.length !== expectedCount) {
    throw new Error(`Expected ${expectedCount} canonical policy fragments, found ${files.length}`);
  }
  const ids = new Set();
  const skills = new Set();
  const policies = [];
  for (const file of files) {
    let fragment;
    try {
      fragment = JSON.parse(await readFile(join(policyRoot, file), "utf8"));
    } catch (error) {
      const wrapped = new Error(`Unable to read canonical policy fragment: ${file}`);
      wrapped.cause = error;
      throw wrapped;
    }
    if (
      fragment?.schemaVersion !== 1
      || typeof fragment.skill !== "string"
      || !Array.isArray(fragment.records)
    ) {
      throw new Error(`Canonical policy fragment is invalid: ${file}`);
    }
    const skill = fragment.skill;
    if (file !== `${skill}.json` || skill.includes("/") || skill.includes("\\")) {
      throw new Error(`Canonical policy fragment filename must match its skill: ${file}`);
    }
    if (skills.has(skill)) {
      throw new Error(`Duplicate canonical policy skill: ${skill}`);
    }
    skills.add(skill);
    for (const record of fragment.records) {
      if (
        typeof record?.id !== "string"
        || record.id.split("/")[0] !== skill
        || !policyClassifications.has(record.classification)
        || !/^[0-9a-f]{64}$/u.test(record.sourceContentSha256)
      ) {
        throw new Error(`Canonical policy record is invalid in ${file}`);
      }
      validateSafePosixPath(record.id, "canonical policy record");
      if (ids.has(record.id)) {
        throw new Error(`Duplicate canonical policy record id: ${record.id}`);
      }
      ids.add(record.id);
      policies.push({
        id: record.id,
        skill,
        classification: record.classification,
        sourceContentSha256: record.sourceContentSha256,
      });
    }
  }
  return policies.sort(compareRecords);
}

function inferPolicyClassification(format) {
  if (format === "markdown") return "conditional";
  if (format === "javascript") return "examples";
  return "api";
}

function snapshotIdentity(record) {
  return {
    id: record.id,
    skill: record.skill,
    format: record.format,
    contentSha256: record.contentSha256,
  };
}

function snapshotPointer(manifest) {
  return {
    resolvedCommit: manifest.upstream.resolvedCommit,
    corpusSha256: manifest.corpus.sha256,
    recordCount: manifest.corpus.recordCount,
  };
}

async function readSnapshot(root, manifestText) {
  let manifest;
  try {
    manifest = JSON.parse(manifestText);
  } catch (error) {
    const wrapped = new Error("Existing upstream snapshot manifest is not valid JSON");
    wrapped.cause = error;
    throw wrapped;
  }
  if (manifest?.schemaVersion !== 2 || typeof manifest?.corpus?.file !== "string") {
    throw new Error("Existing upstream snapshot manifest is not schemaVersion 2");
  }
  if (
    !/^[0-9a-f]{64}$/u.test(manifest.corpus.sha256)
    || manifest.corpus.file !== `corpus-${manifest.corpus.sha256}.jsonl`
  ) {
    throw new Error("Existing upstream snapshot corpus is not content-addressed");
  }
  const corpusText = await readFile(join(root, manifest.corpus.file), "utf8");
  if (sha256(corpusText) !== manifest.corpus.sha256) {
    throw new Error("Existing upstream snapshot failed whole-file integrity");
  }
  const records = parseJsonl(corpusText, "existing upstream snapshot");
  if (records.length !== manifest.corpus.recordCount) {
    throw new Error("Existing upstream snapshot record count does not match its manifest");
  }
  const ids = new Set();
  for (const record of records) {
    if (
      typeof record?.id !== "string"
      || typeof record?.text !== "string"
      || !/^[0-9a-f]{64}$/u.test(record?.contentSha256)
    ) {
      throw new Error("Existing upstream snapshot contains an invalid record");
    }
    validateSafePosixPath(record.id, "existing snapshot record");
    if (ids.has(record.id)) {
      throw new Error(`Existing upstream snapshot contains a duplicate id: ${record.id}`);
    }
    ids.add(record.id);
    if (sha256(record.text) !== record.contentSha256) {
      throw new Error(`Existing upstream snapshot content hash mismatch: ${String(record.id)}`);
    }
  }
  return { manifest, records };
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
    "ls-tree", "-z", "--full-tree", workflowTree,
  ]));
  const skills = [];
  for (const entry of entries) {
    validateSafePosixPath(entry.path, "workflow skill");
    if (entry.path.includes("/") || entry.type !== "tree" || entry.mode !== "040000") {
      throw new Error(`Invalid workflow-skills top-level entry: ${entry.path}`);
    }
    skills.push(entry.path);
  }
  return skills.sort(compareStrings);
}

function parseTreeEntries(output) {
  const entries = [];
  let start = 0;
  for (let index = 0; index < output.length; index += 1) {
    if (output[index] !== 0) continue;
    const rawEntry = output.subarray(start, index);
    start = index + 1;
    if (rawEntry.length === 0) continue;
    const tab = rawEntry.indexOf(9);
    if (tab === -1) throw new Error("Git returned a malformed tree entry");
    const metadata = decodeUtf8(rawEntry.subarray(0, tab), "Git tree metadata");
    const match = /^(\d{6}) (blob|tree|commit) ([0-9a-f]{40,64})$/u.exec(metadata);
    if (!match) throw new Error(`Git returned malformed tree metadata: ${metadata}`);
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

function validateSnapshotEntry(entry) {
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
  if (!/\.(?:md|ts|js)$/u.test(entry.path)) {
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
    || path.split("/").some((segment) => segment === "" || segment === "." || segment === "..")
  ) {
    throw new Error(`Invalid ${label} path: ${JSON.stringify(path)}`);
  }
}

function validateSkills(records) {
  const paths = new Set();
  const skills = new Set();
  for (const record of records) {
    if (paths.has(record.id)) throw new Error(`Duplicate skills path: ${record.id}`);
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
  if (path.split("/").length === 2 && path.endsWith("/SKILL.md")) return "skill";
  return path.endsWith(".md") ? "reference" : "script";
}

function getRecordFormat(path) {
  if (path.endsWith(".md")) return "markdown";
  return path.endsWith(".ts") ? "typescript" : "javascript";
}

function parseJsonl(text, label) {
  if (!text.endsWith("\n")) throw new Error(`${label} must end with a newline`);
  return text.slice(0, -1).split("\n").filter(Boolean).map((line, index) => {
    try {
      return JSON.parse(line);
    } catch (error) {
      const wrapped = new Error(`${label} line ${index + 1} is not valid JSON`);
      wrapped.cause = error;
      throw wrapped;
    }
  });
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

async function readOptionalUtf8(path) {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") return undefined;
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
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function compareRecords(left, right) {
  return compareStrings(left.id, right.id);
}

function compareStrings(left, right) {
  return Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"));
}

async function main() {
  const invocation = parseCliInvocation(process.argv.slice(2));
  if (invocation.command === "build-canonical-corpus") {
    const result = await buildCanonicalCorpus({ canonicalRoot: defaultCanonicalRoot });
    process.stdout.write(`wrote ${result.records.length} canonical corpus records to ${result.canonicalRoot}\n`);
    if (result.manifest.reviewWarnings.length > 0) {
      process.stderr.write(
        `warning: ${result.manifest.reviewWarnings.length} canonical mirrors are byte-identical to their accepted upstream sources and require review\n`,
      );
    }
    return;
  }
  const result = await updateUpstreamSnapshot({ requestedRef: invocation.requestedRef });
  process.stdout.write(
    `wrote ${result.records.length} development snapshot records and change report to ${result.snapshotRoot}\n`,
  );
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
