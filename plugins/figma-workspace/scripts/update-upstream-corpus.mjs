import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { isDeepStrictEqual, promisify } from "node:util";
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
const defaultCanonicalSourceRoot = resolve(pluginRoot, "dev/canonical-corpus-source");
const defaultPolicyRoot = join(defaultCanonicalSourceRoot, "policy");
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
  if (command === "refresh-upstream-changes") {
    if (args.length === 1) {
      return { command };
    }
    if (args.length !== 3 || args[1] !== "--from-report") {
      throw new Error(`Unknown argument: ${args[1]}`);
    }
    return {
      command,
      fromReportFile: validateContentAddressedReportFile(args[2]),
    };
  }
  if (command !== "update-upstream-snapshot") {
    throw new Error(
      "Expected command: update-upstream-snapshot, refresh-upstream-changes, or build-canonical-corpus",
    );
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
    const changesManifest = createChangesManifest({
      snapshot,
      report,
      reportFile,
      reportSha256,
      generatedAt,
    });
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

export async function refreshUpstreamChanges(options = {}) {
  const snapshotRoot = resolve(options.snapshotRoot ?? defaultSnapshotRoot);
  const changesRoot = resolve(options.changesRoot ?? defaultChangesRoot);
  const policyRoot = resolve(options.policyRoot ?? defaultPolicyRoot);
  const generatedAt = options.generatedAt ?? new Date().toISOString();
  const expectedPolicyFragmentCount = options.expectedPolicyFragmentCount ?? 12;
  validateGenerationOptions({ repository: OFFICIAL_UPSTREAM_REPOSITORY, generatedAt });
  if (!Number.isSafeInteger(expectedPolicyFragmentCount) || expectedPolicyFragmentCount < 1) {
    throw new Error("expectedPolicyFragmentCount must be a positive integer");
  }

  const snapshotManifestText = await readRequiredUtf8(
    join(snapshotRoot, "manifest.json"),
    "Committed upstream snapshot manifest",
  );
  const snapshot = await readSnapshot(snapshotRoot, snapshotManifestText);
  const sourceReport = options.fromReportFile === undefined
    ? (await readCommittedUpstreamChangeEvidence({
      snapshotRoot,
      changesRoot,
      snapshot,
    })).report
    : await readArchivedUpstreamChangeReport({
      snapshotRoot,
      changesRoot,
      snapshot,
      reportFile: options.fromReportFile,
    });
  const acceptedPolicies = await readAcceptedPolicies(policyRoot, expectedPolicyFragmentCount);
  const previous = sourceReport.from === null
    ? undefined
    : {
      manifest: {
        upstream: { resolvedCommit: sourceReport.from.resolvedCommit },
        corpus: {
          sha256: sourceReport.from.corpusSha256,
          recordCount: sourceReport.from.recordCount,
        },
      },
      records: await readRetainedSnapshotCorpus(snapshotRoot, sourceReport.from),
    };
  const report = createChangeReport(previous, snapshot, generatedAt, acceptedPolicies);
  const reportJson = `${JSON.stringify(report, null, 2)}\n`;
  const reportSha256 = sha256(reportJson);
  const reportFile = `report-${reportSha256}.json`;
  const changesManifest = createChangesManifest({
    snapshot,
    report,
    reportFile,
    reportSha256,
    generatedAt,
  });
  await publishContentAddressed({
    root: changesRoot,
    contentFile: reportFile,
    content: reportJson,
    contentSha256: reportSha256,
    manifest: `${JSON.stringify(changesManifest, null, 2)}\n`,
    renameFile: options.changesRenameFile,
    syncDirectoryFn: options.changesSyncDirectoryFn,
  });
  return {
    snapshotRoot,
    changesRoot,
    policyRoot,
    manifest: snapshot.manifest,
    records: snapshot.records,
    changeManifest: changesManifest,
    report,
  };
}

export async function inspectCommittedUpstreamDrift(options = {}) {
  const snapshotRoot = resolve(options.snapshotRoot ?? defaultSnapshotRoot);
  const changesRoot = resolve(options.changesRoot ?? defaultChangesRoot);
  const policyRoot = resolve(options.policyRoot ?? defaultPolicyRoot);
  const expectedPolicyFragmentCount = options.expectedPolicyFragmentCount ?? 12;
  if (!Number.isSafeInteger(expectedPolicyFragmentCount) || expectedPolicyFragmentCount < 1) {
    throw new Error("expectedPolicyFragmentCount must be a positive integer");
  }

  const snapshotManifestText = await readRequiredUtf8(
    join(snapshotRoot, "manifest.json"),
    "Committed upstream snapshot manifest",
  );
  const snapshot = await readSnapshot(snapshotRoot, snapshotManifestText);
  const { changesManifest, report } = await readCommittedUpstreamChangeEvidence({
    snapshotRoot,
    changesRoot,
    snapshot,
  });

  const acceptedPolicies = await readAcceptedPolicies(policyRoot, expectedPolicyFragmentCount);
  const expectedAdaptation = createAdaptationStatus(snapshot.records, acceptedPolicies);
  if (!isDeepStrictEqual(report.adaptation, expectedAdaptation)) {
    throw new Error("Committed upstream adaptation report does not match snapshot and policy");
  }
  if (!isDeepStrictEqual(changesManifest.adaptation, report.adaptation)) {
    throw new Error("Committed upstream changes manifest adaptation does not match its report");
  }

  return {
    snapshotManifest: snapshot.manifest,
    snapshotRecords: snapshot.records,
    changesManifest,
    report,
    acceptedPolicies,
    warnings: formatUpstreamDriftWarnings(report.adaptation),
  };
}

function createChangesManifest({ snapshot, report, reportFile, reportSha256, generatedAt }) {
  return {
    schemaVersion: 1,
    generatedAt,
    upstream: {
      repository: snapshot.manifest.upstream.repository,
      requestedRef: snapshot.manifest.upstream.requestedRef,
      resolvedCommit: snapshot.manifest.upstream.resolvedCommit,
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
}

async function readCommittedUpstreamChangeEvidence({ snapshotRoot, changesRoot, snapshot }) {
  const changesManifest = parseJson(
    await readRequiredUtf8(
      join(changesRoot, "manifest.json"),
      "Committed upstream changes manifest",
    ),
    "Committed upstream changes manifest",
  );
  validateChangesManifest(changesManifest, snapshot.manifest);
  const reportText = await readRequiredUtf8(
    join(changesRoot, changesManifest.report.file),
    "Committed upstream change report",
  );
  if (sha256(reportText) !== changesManifest.report.sha256) {
    throw new Error("Committed upstream change report failed whole-file integrity");
  }
  const report = parseJson(reportText, "Committed upstream change report");
  await validateChangeReport(
    report,
    snapshot.manifest,
    snapshot.records,
    changesManifest,
    snapshotRoot,
  );
  return { changesManifest, report };
}

async function readArchivedUpstreamChangeReport({ snapshotRoot, changesRoot, snapshot, reportFile }) {
  validateContentAddressedReportFile(reportFile);
  const expectedSha256 = reportFile.slice("report-".length, -".json".length);
  const reportText = await readRequiredUtf8(
    join(changesRoot, reportFile),
    "Archived upstream change report",
  );
  if (sha256(reportText) !== expectedSha256) {
    throw new Error("Archived upstream change report failed whole-file integrity");
  }
  const report = parseJson(reportText, "Archived upstream change report");
  await validateChangeReport(
    report,
    snapshot.manifest,
    snapshot.records,
    { report: report.summary },
    snapshotRoot,
  );
  return report;
}

export function formatUpstreamDriftWarnings(adaptation) {
  const warnings = [];
  if (adaptation.pendingCount > 0) {
    const records = adaptation.pendingRecords
      .map((record) => `${record.id} (${record.drift})`)
      .join(", ");
    warnings.push(
      `warning: upstream drift has ${adaptation.pendingCount} pending canonical adaptation record(s): ${records}. Snapshot evidence was updated; canonical authoring and runtime corpus were not changed.`,
    );
  }
  if (adaptation.retiredCount > 0) {
    const records = adaptation.retiredRecords.map((record) => record.id).join(", ");
    warnings.push(
      `warning: upstream drift has ${adaptation.retiredCount} retired canonical policy record(s): ${records}. Review the archive evidence before changing canonical authoring or policy.`,
    );
  }
  return warnings;
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
  const diff = createSnapshotDiff(previous?.records ?? [], current.records);
  return {
    schemaVersion: 1,
    generatedAt,
    from: previous === undefined ? null : snapshotPointer(previous.manifest),
    to: snapshotPointer(current.manifest),
    summary: diff.summary,
    changes: diff.changes,
    adaptation: createAdaptationStatus(current.records, acceptedPolicies),
  };
}

function createSnapshotDiff(previousRecords, currentRecords) {
  const previousById = new Map(previousRecords.map((record) => [record.id, record]));
  const currentById = new Map(currentRecords.map((record) => [record.id, record]));
  const added = [];
  const changed = [];
  const deleted = [];
  let unchanged = 0;
  for (const record of currentRecords) {
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
  for (const record of previousRecords) {
    if (!currentById.has(record.id)) {
      deleted.push(snapshotIdentity(record));
    }
  }
  return {
    summary: {
      newCount: added.length,
      changedCount: changed.length,
      deletedCount: deleted.length,
      unchangedCount: unchanged,
    },
    changes: { new: added, changed, deleted },
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
  validateSnapshotManifestSchema(manifest);
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
    validateSnapshotRecord(record);
    if (ids.has(record.id)) {
      throw new Error(`Existing upstream snapshot contains a duplicate id: ${record.id}`);
    }
    ids.add(record.id);
    if (sha256(record.text) !== record.contentSha256) {
      throw new Error(`Existing upstream snapshot content hash mismatch: ${String(record.id)}`);
    }
  }
  const snapshot = { manifest, records };
  validateSnapshotManifestIntegrity(snapshot);
  return snapshot;
}

function validateSnapshotManifestSchema(manifest) {
  assertExactObject(manifest, [
    "schemaVersion",
    "generatedAt",
    "upstream",
    "corpus",
    "includedSkills",
    "outOfScopeSkills",
    "integrity",
  ], "Existing upstream snapshot manifest");
  assertExactObject(manifest.upstream, [
    "repository",
    "requestedRef",
    "resolvedCommit",
    "sourcePath",
    "termsUrl",
  ], "Existing upstream snapshot upstream pointer");
  assertExactObject(manifest.corpus, [
    "file",
    "recordCount",
    "sha256",
    "contract",
  ], "Existing upstream snapshot corpus pointer");
  assertExactObject(manifest.integrity, [
    "algorithm",
    "textNormalization",
    "contentHashes",
  ], "Existing upstream snapshot integrity");
  if (
    manifest.schemaVersion !== 2
    || typeof manifest.generatedAt !== "string"
    || manifest.generatedAt.length === 0
    || typeof manifest.upstream.repository !== "string"
    || manifest.upstream.repository.length === 0
    || typeof manifest.upstream.requestedRef !== "string"
    || manifest.upstream.requestedRef.length === 0
    || !/^[0-9a-f]{40,64}$/u.test(manifest.upstream.resolvedCommit)
    || manifest.upstream.sourcePath !== "skills"
    || manifest.upstream.termsUrl !== FIGMA_DEVELOPER_TERMS_URL
    || !isNonNegativeInteger(manifest.corpus.recordCount)
    || manifest.corpus.contract !== snapshotContract
    || !Array.isArray(manifest.includedSkills)
    || !Array.isArray(manifest.outOfScopeSkills)
    || manifest.integrity.algorithm !== "sha256"
    || manifest.integrity.textNormalization !== "crlf-to-lf"
    || !isPlainObject(manifest.integrity.contentHashes)
  ) {
    throw new Error("Existing upstream snapshot manifest contains invalid values");
  }
  for (const [index, skill] of manifest.includedSkills.entries()) {
    if (!isSafeSkillName(skill)) {
      throw new Error(`Existing upstream snapshot includedSkills[${index}] is invalid`);
    }
  }
  for (const [index, entry] of manifest.outOfScopeSkills.entries()) {
    assertExactObject(entry, ["skill", "reason"], `Existing upstream snapshot outOfScopeSkills[${index}]`);
    if (!isSafeSkillName(entry.skill) || entry.reason !== workflowSkillReason) {
      throw new Error(`Existing upstream snapshot outOfScopeSkills[${index}] contains invalid values`);
    }
  }
}

function validateSnapshotRecord(record) {
  assertExactObject(record, [
    "schemaVersion",
    "id",
    "skill",
    "kind",
    "format",
    "sourcePath",
    "lineCount",
    "contentSha256",
    "text",
  ], "Existing upstream snapshot record");
  if (typeof record.id === "string") validateSafePosixPath(record.id, "existing snapshot record");
  if (
    record.schemaVersion !== 2
    || typeof record.id !== "string"
    || !isSafeSkillName(record.skill)
    || record.skill !== record.id.split("/")[0]
    || record.kind !== getRecordKind(record.id)
    || record.format !== getRecordFormat(record.id)
    || record.sourcePath !== record.id
    || !Number.isSafeInteger(record.lineCount)
    || record.lineCount < 1
    || typeof record.text !== "string"
    || record.lineCount !== record.text.split("\n").length
    || !/^[0-9a-f]{64}$/u.test(record.contentSha256)
  ) {
    throw new Error(`Existing upstream snapshot contains an invalid record: ${String(record.id)}`);
  }
}

function validateSnapshotManifestIntegrity(snapshot) {
  const { manifest, records } = snapshot;
  const expectedHashes = Object.fromEntries(records.map((record) => [record.id, record.contentSha256]));
  if (!isDeepStrictEqual(manifest.integrity.contentHashes, expectedHashes)) {
    throw new Error("Committed upstream snapshot integrity hashes do not match its records");
  }
  const expectedSkills = [...new Set(records.map((record) => record.skill))].sort(compareStrings);
  if (!isDeepStrictEqual(manifest.includedSkills, expectedSkills)) {
    throw new Error("Committed upstream snapshot includedSkills do not match its records");
  }
  const outOfScopeSkills = manifest.outOfScopeSkills.map((entry) => entry.skill);
  if (
    new Set(outOfScopeSkills).size !== outOfScopeSkills.length
    || !isDeepStrictEqual(outOfScopeSkills, [...outOfScopeSkills].sort(compareStrings))
  ) {
    throw new Error("Committed upstream snapshot outOfScopeSkills must be unique and sorted");
  }
}

function validateChangesManifest(manifest, snapshotManifest) {
  assertExactObject(manifest, [
    "schemaVersion",
    "generatedAt",
    "upstream",
    "snapshot",
    "report",
    "adaptation",
  ], "Committed upstream changes manifest");
  assertExactObject(manifest.upstream, [
    "repository",
    "requestedRef",
    "resolvedCommit",
  ], "Committed upstream changes manifest upstream pointer");
  assertExactObject(manifest.snapshot, [
    "file",
    "sha256",
    "recordCount",
  ], "Committed upstream changes manifest snapshot pointer");
  assertExactObject(manifest.report, [
    "file",
    "sha256",
    "newCount",
    "changedCount",
    "deletedCount",
    "unchangedCount",
  ], "Committed upstream changes manifest report pointer");
  if (
    manifest.schemaVersion !== 1
    || typeof manifest.generatedAt !== "string"
    || manifest.generatedAt.length === 0
    || typeof manifest.upstream.repository !== "string"
    || manifest.upstream.repository.length === 0
    || typeof manifest.upstream.requestedRef !== "string"
    || manifest.upstream.requestedRef.length === 0
    || !/^[0-9a-f]{40,64}$/u.test(manifest.upstream.resolvedCommit)
    || typeof manifest.report.file !== "string"
    || !/^[0-9a-f]{64}$/u.test(manifest.report.sha256)
    || manifest.report.file !== `report-${manifest.report.sha256}.json`
    || !isNonNegativeInteger(manifest.report.newCount)
    || !isNonNegativeInteger(manifest.report.changedCount)
    || !isNonNegativeInteger(manifest.report.deletedCount)
    || !isNonNegativeInteger(manifest.report.unchangedCount)
  ) {
    throw new Error("Committed upstream changes manifest is invalid");
  }
  validateAdaptationStatus(manifest.adaptation, "Committed upstream changes manifest adaptation");
  const expectedSnapshot = {
    file: snapshotManifest.corpus.file,
    sha256: snapshotManifest.corpus.sha256,
    recordCount: snapshotManifest.corpus.recordCount,
  };
  if (!isDeepStrictEqual(manifest.snapshot, expectedSnapshot)) {
    throw new Error("Committed upstream changes manifest does not reference the current snapshot");
  }
  if (
    manifest?.upstream?.repository !== snapshotManifest?.upstream?.repository
    || manifest?.upstream?.requestedRef !== snapshotManifest?.upstream?.requestedRef
    || manifest?.upstream?.resolvedCommit !== snapshotManifest?.upstream?.resolvedCommit
  ) {
    throw new Error("Committed upstream changes manifest upstream pointer is inconsistent");
  }
}

async function validateChangeReport(
  report,
  snapshotManifest,
  snapshotRecords,
  changesManifest,
  snapshotRoot,
) {
  assertExactObject(report, [
    "schemaVersion",
    "generatedAt",
    "from",
    "to",
    "summary",
    "changes",
    "adaptation",
  ], "Committed upstream change report");
  assertExactObject(report.summary, [
    "newCount",
    "changedCount",
    "deletedCount",
    "unchangedCount",
  ], "Committed upstream change report summary");
  assertExactObject(report.changes, ["new", "changed", "deleted"], "Committed upstream change report changes");
  if (
    report.schemaVersion !== 1
    || typeof report.generatedAt !== "string"
    || report.generatedAt.length === 0
    || !Array.isArray(report.changes.new)
    || !Array.isArray(report.changes.changed)
    || !Array.isArray(report.changes.deleted)
    || !isNonNegativeInteger(report.summary.newCount)
    || !isNonNegativeInteger(report.summary.changedCount)
    || !isNonNegativeInteger(report.summary.deletedCount)
    || !isNonNegativeInteger(report.summary.unchangedCount)
    || report.summary.newCount !== report.changes.new.length
    || report.summary.changedCount !== report.changes.changed.length
    || report.summary.deletedCount !== report.changes.deleted.length
    || report.summary.newCount + report.summary.changedCount + report.summary.unchangedCount
      !== snapshotManifest.corpus.recordCount
  ) {
    throw new Error("Committed upstream change report summary is invalid");
  }
  validateAdaptationStatus(report.adaptation, "Committed upstream change report adaptation");
  const expectedTo = snapshotPointer(snapshotManifest);
  validateSnapshotPointer(report.to, "change report to pointer");
  if (!isDeepStrictEqual(report.to, expectedTo)) {
    throw new Error("Committed upstream change report does not point to the current snapshot");
  }
  const manifestSummary = {
    newCount: changesManifest.report.newCount,
    changedCount: changesManifest.report.changedCount,
    deletedCount: changesManifest.report.deletedCount,
    unchangedCount: changesManifest.report.unchangedCount,
  };
  if (!isDeepStrictEqual(report.summary, manifestSummary)) {
    throw new Error("Committed upstream changes manifest summary does not match its report");
  }
  const currentById = new Map(snapshotRecords.map((record) => [record.id, record]));
  const changedIds = new Set();
  for (const drift of ["new", "changed", "deleted"]) {
    const records = report.changes[drift];
    for (const record of records) {
      validateChangeRecord(record, drift);
      if (changedIds.has(record.id)) {
        throw new Error(`Committed upstream change report repeats record id: ${record.id}`);
      }
      changedIds.add(record.id);
      const current = currentById.get(record.id);
      if (drift === "deleted") {
        if (current !== undefined) {
          throw new Error(`Committed upstream deleted record still exists: ${record.id}`);
        }
      } else if (
        current === undefined
        || current.skill !== record.skill
        || current.format !== record.format
        || current.contentSha256 !== record.contentSha256
      ) {
        throw new Error(`Committed upstream ${drift} record does not match the snapshot: ${record.id}`);
      }
    }
  }
  let previousRecords = [];
  if (report.from !== null) {
    validateSnapshotPointer(report.from, "change report from pointer");
    previousRecords = await readRetainedSnapshotCorpus(snapshotRoot, report.from);
  }
  const expectedDiff = createSnapshotDiff(previousRecords, snapshotRecords);
  if (
    !isDeepStrictEqual(report.summary, expectedDiff.summary)
    || !isDeepStrictEqual(report.changes, expectedDiff.changes)
  ) {
    throw new Error("Committed upstream change report does not match its retained from corpus");
  }
}

async function readRetainedSnapshotCorpus(snapshotRoot, pointer) {
  const corpusFile = `corpus-${pointer.corpusSha256}.jsonl`;
  const corpusText = await readRequiredUtf8(
    join(snapshotRoot, corpusFile),
    "Committed upstream retained from corpus",
  );
  if (sha256(corpusText) !== pointer.corpusSha256) {
    throw new Error("Committed upstream retained from corpus failed whole-file integrity");
  }
  const records = parseJsonl(corpusText, "committed upstream retained from corpus");
  if (records.length !== pointer.recordCount) {
    throw new Error("Committed upstream retained from corpus record count does not match its pointer");
  }
  const ids = new Set();
  for (const record of records) {
    validateSnapshotRecord(record);
    if (ids.has(record.id)) {
      throw new Error(`Committed upstream retained from corpus contains a duplicate id: ${record.id}`);
    }
    ids.add(record.id);
    if (sha256(record.text) !== record.contentSha256) {
      throw new Error(`Committed upstream retained from corpus content hash mismatch: ${record.id}`);
    }
  }
  return records;
}

function validateChangeRecord(record, drift) {
  const expectedKeys = drift === "changed"
    ? ["id", "skill", "format", "contentSha256", "previousContentSha256"]
    : ["id", "skill", "format", "contentSha256"];
  assertExactObject(record, expectedKeys, `Committed upstream change report ${drift} record`);
  if (
    typeof record?.id !== "string"
    || !isSafeSkillName(record.skill)
    || record.skill !== record.id.split("/")[0]
    || record.format !== getRecordFormat(record.id)
    || !/^[0-9a-f]{64}$/u.test(record?.contentSha256)
    || (drift === "changed" && !/^[0-9a-f]{64}$/u.test(record?.previousContentSha256))
  ) {
    throw new Error(`Committed upstream change report contains an invalid ${drift} record`);
  }
  validateSafePosixPath(record.id, `committed upstream ${drift} record`);
}

function validateContentAddressedReportFile(value) {
  const match = /^report-([0-9a-f]{64})\.json$/u.exec(value ?? "");
  if (match === null) {
    throw new Error("--from-report must be a content-addressed report filename");
  }
  return value;
}

function validateSnapshotPointer(pointer, label) {
  assertExactObject(pointer, ["resolvedCommit", "corpusSha256", "recordCount"], `Committed upstream ${label}`);
  if (
    !/^[0-9a-f]{40,64}$/u.test(pointer?.resolvedCommit)
    || !/^[0-9a-f]{64}$/u.test(pointer?.corpusSha256)
    || !isNonNegativeInteger(pointer?.recordCount)
  ) {
    throw new Error(`Committed upstream ${label} is invalid`);
  }
}

function validateAdaptationStatus(adaptation, label) {
  assertExactObject(adaptation, [
    "readyCount",
    "pendingCount",
    "retiredCount",
    "pendingRecords",
    "retiredRecords",
  ], label);
  if (
    !isNonNegativeInteger(adaptation.readyCount)
    || !isNonNegativeInteger(adaptation.pendingCount)
    || !isNonNegativeInteger(adaptation.retiredCount)
    || !Array.isArray(adaptation.pendingRecords)
    || !Array.isArray(adaptation.retiredRecords)
    || adaptation.pendingCount !== adaptation.pendingRecords.length
    || adaptation.retiredCount !== adaptation.retiredRecords.length
  ) {
    throw new Error(`${label} contains invalid counts or record arrays`);
  }
  const ids = new Set();
  for (const [index, record] of adaptation.pendingRecords.entries()) {
    const expectedKeys = record?.drift === "changed"
      ? [
          "id",
          "skill",
          "classification",
          "state",
          "drift",
          "sourceContentSha256",
          "policySourceContentSha256",
        ]
      : ["id", "skill", "classification", "state", "drift", "sourceContentSha256"];
    const recordLabel = `${label} pendingRecords[${index}]`;
    assertExactObject(record, expectedKeys, recordLabel);
    validateAdaptationIdentity(record, recordLabel);
    if (
      record.state !== "pending"
      || (record.drift !== "new" && record.drift !== "changed")
      || !/^[0-9a-f]{64}$/u.test(record.sourceContentSha256)
      || (record.drift === "changed" && !/^[0-9a-f]{64}$/u.test(record.policySourceContentSha256))
    ) {
      throw new Error(`${recordLabel} contains invalid values`);
    }
    if (ids.has(record.id)) throw new Error(`${label} repeats record id: ${record.id}`);
    ids.add(record.id);
  }
  for (const [index, record] of adaptation.retiredRecords.entries()) {
    const recordLabel = `${label} retiredRecords[${index}]`;
    assertExactObject(record, [
      "id",
      "skill",
      "classification",
      "state",
      "policySourceContentSha256",
    ], recordLabel);
    validateAdaptationIdentity(record, recordLabel);
    if (record.state !== "retired" || !/^[0-9a-f]{64}$/u.test(record.policySourceContentSha256)) {
      throw new Error(`${recordLabel} contains invalid values`);
    }
    if (ids.has(record.id)) throw new Error(`${label} repeats record id: ${record.id}`);
    ids.add(record.id);
  }
}

function validateAdaptationIdentity(record, label) {
  if (typeof record.id === "string") validateSafePosixPath(record.id, label);
  if (
    typeof record.id !== "string"
    || !isSafeSkillName(record.skill)
    || record.skill !== record.id.split("/")[0]
    || !policyClassifications.has(record.classification)
  ) {
    throw new Error(`${label} contains an invalid identity`);
  }
}

function assertExactObject(value, expectedKeys, label) {
  if (!isPlainObject(value)) throw new Error(`${label} must be an object`);
  const actualKeys = Object.keys(value).sort(compareStrings);
  const sortedExpectedKeys = [...expectedKeys].sort(compareStrings);
  if (!isDeepStrictEqual(actualKeys, sortedExpectedKeys)) {
    throw new Error(`${label} must contain exactly: ${sortedExpectedKeys.join(", ")}`);
  }
}

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isSafeSkillName(value) {
  return typeof value === "string"
    && /^[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(value)
    && value !== "."
    && value !== "..";
}

async function readRequiredUtf8(path, label) {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    const wrapped = new Error(`${label} could not be read`);
    wrapped.cause = error;
    throw wrapped;
  }
}

function parseJson(text, label) {
  try {
    return JSON.parse(text);
  } catch (error) {
    const wrapped = new Error(`${label} is not valid JSON`);
    wrapped.cause = error;
    throw wrapped;
  }
}

function isNonNegativeInteger(value) {
  return Number.isSafeInteger(value) && value >= 0;
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

export async function runCli(args, options = {}) {
  const invocation = parseCliInvocation(args);
  const stdout = options.stdout ?? process.stdout;
  const stderr = options.stderr ?? process.stderr;
  if (invocation.command === "build-canonical-corpus") {
    const result = await buildCanonicalCorpus({
      sourceRoot: defaultCanonicalSourceRoot,
      publishRoot: defaultCanonicalRoot,
      ...options.canonicalBuildOptions,
    });
    stdout.write(`wrote ${result.records.length} canonical corpus records to ${result.publishRoot}\n`);
    if (result.manifest.reviewWarnings.length > 0) {
      stderr.write(
        `warning: ${result.manifest.reviewWarnings.length} canonical mirrors are byte-identical to their accepted upstream sources and require review\n`,
      );
    }
    return result;
  }
  if (invocation.command === "refresh-upstream-changes") {
    const result = await refreshUpstreamChanges({
      ...options.refreshChangesOptions,
      fromReportFile: invocation.fromReportFile,
    });
    stdout.write(
      `refreshed upstream change report for ${result.records.length} archived snapshot records at ${result.changesRoot}\n`,
    );
    for (const warning of formatUpstreamDriftWarnings(result.report.adaptation)) {
      stderr.write(`${warning}\n`);
    }
    return result;
  }
  const result = await updateUpstreamSnapshot({
    ...options.updateOptions,
    requestedRef: invocation.requestedRef,
  });
  stdout.write(
    `wrote ${result.records.length} development snapshot records and change report to ${result.snapshotRoot}\n`,
  );
  for (const warning of formatUpstreamDriftWarnings(result.report.adaptation)) {
    stderr.write(`${warning}\n`);
  }
  return result;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  runCli(process.argv.slice(2)).catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
