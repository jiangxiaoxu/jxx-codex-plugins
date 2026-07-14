import { createHash, randomUUID } from "node:crypto";
import {
  access,
  mkdir,
  open,
  readFile,
  readdir,
  rename,
  rm,
} from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";

const classifications = new Set(["active", "conditional", "router", "examples", "api"]);
const markdownClassifications = new Set(["active", "conditional", "router"]);
const expectedSourceContract = "figma-mcp";
const expectedTargetContract = "figma-workspace-cli";
const utf8Decoder = new TextDecoder("utf-8", { fatal: true });

export async function buildUpstreamActive(options) {
  const rawRoot = resolve(requiredString(options?.rawRoot, "rawRoot"));
  const activeRoot = resolve(requiredString(options?.activeRoot, "activeRoot"));
  const generatedAt = options.generatedAt ?? new Date().toISOString();
  const expectedPolicyFragmentCount = options.expectedPolicyFragmentCount ?? 12;
  if (!Number.isSafeInteger(expectedPolicyFragmentCount) || expectedPolicyFragmentCount < 1) {
    throw new Error("expectedPolicyFragmentCount must be a positive integer");
  }
  requiredString(generatedAt, "generatedAt");

  const parent = await readRawCorpus(rawRoot);
  const policyRecords = await readPolicies(activeRoot, expectedPolicyFragmentCount);
  const rawById = new Map(parent.records.map((record) => [record.id, record]));
  const policyById = new Map(policyRecords.map((record) => [record.id, record]));
  const mirrorTexts = new Map();
  for (const policy of policyRecords) {
    validatePolicyFormat(policy, inferFormatFromPath(policy.id));
    if (markdownClassifications.has(policy.classification)) {
      mirrorTexts.set(policy.id, await readMirror(activeRoot, policy));
    }
  }
  const derivedRecords = [];
  const pendingRecords = [];
  const retiredRecords = [];
  const classificationCounts = Object.fromEntries(
    [...classifications].map((classification) => [classification, 0]),
  );

  for (const policy of policyRecords) {
    classificationCounts[policy.classification] += 1;
    const source = rawById.get(policy.id);
    if (source === undefined) {
      retiredRecords.push({
        id: policy.id,
        skill: policy.skill,
        classification: policy.classification,
        state: "retired",
        sourceContentSha256: policy.sourceContentSha256,
      });
      continue;
    }
    validatePolicyFormat(policy, source.format);
    if (source.contentSha256 !== policy.sourceContentSha256) {
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

    if (policy.classification === "api") {
      continue;
    }
    if (markdownClassifications.has(policy.classification)) {
      const mirrorText = mirrorTexts.get(policy.id);
      derivedRecords.push(createDerivedRecord(policy, source, mirrorText, true, false));
      continue;
    }
    derivedRecords.push(createDerivedRecord(policy, source, source.text, false, true));
  }

  for (const source of parent.records) {
    if (policyById.has(source.id)) {
      continue;
    }
    const classification = inferNewClassification(source.format);
    classificationCounts[classification] += 1;
    pendingRecords.push({
      id: source.id,
      skill: source.skill,
      classification,
      state: "pending",
      drift: "new",
      sourceContentSha256: source.contentSha256,
    });
  }

  derivedRecords.sort(compareRecords);
  pendingRecords.sort(compareRecords);
  retiredRecords.sort(compareRecords);
  const corpusJsonl = derivedRecords.length === 0
    ? ""
    : `${derivedRecords.map((record) => JSON.stringify(record)).join("\n")}\n`;
  const corpusSha256 = sha256(corpusJsonl);
  const corpusFile = `corpus-${corpusSha256}.jsonl`;
  const manifest = {
    schemaVersion: 1,
    generatedAt,
    parent: {
      repository: parent.manifest.upstream.repository,
      resolvedCommit: parent.manifest.upstream.resolvedCommit,
      corpus: {
        file: parent.manifest.corpus.file,
        sha256: parent.manifest.corpus.sha256,
        recordCount: parent.manifest.corpus.recordCount,
      },
    },
    corpus: {
      file: corpusFile,
      sha256: corpusSha256,
      recordCount: derivedRecords.length,
    },
    queryableRecordCount: derivedRecords.length,
    pendingCount: pendingRecords.length,
    retiredCount: retiredRecords.length,
    classificationCounts,
    pendingRecords,
    retiredRecords,
    integrity: {
      algorithm: "sha256",
      sourceContentHashes: Object.fromEntries(
        policyRecords
          .filter((policy) => rawById.get(policy.id)?.contentSha256 === policy.sourceContentSha256)
          .map((policy) => [policy.id, policy.sourceContentSha256]),
      ),
      derivedContentHashes: Object.fromEntries(
        derivedRecords.map((record) => [record.id, record.derivedContentSha256]),
      ),
    },
  };
  const manifestJson = `${JSON.stringify(manifest, null, 2)}\n`;

  if (options.publish !== false) {
    await publishActiveCorpus(activeRoot, {
      corpusFile,
      corpusJsonl,
      corpusSha256,
      manifestJson,
      renameFile: options.renameFile ?? rename,
      syncDirectoryFn: options.syncDirectoryFn ?? syncDirectory,
    });
  }
  return { manifest, records: derivedRecords, activeRoot };
}

async function readRawCorpus(rawRoot) {
  const manifest = parseJson(
    await readUtf8File(join(rawRoot, "manifest.json"), "raw manifest"),
    "raw manifest",
  );
  requireExactKeys(manifest, [
    "schemaVersion",
    "generatedAt",
    "upstream",
    "corpus",
    "includedSkills",
    "outOfScopeSkills",
    "integrity",
  ], "raw manifest");
  if (manifest.schemaVersion !== 2) {
    throw new Error("Raw manifest schemaVersion must be 2");
  }
  if (!isObject(manifest.upstream) || !isObject(manifest.corpus) || !isObject(manifest.integrity)) {
    throw new Error("Raw manifest upstream, corpus, and integrity must be objects");
  }
  requireExactKeys(manifest.upstream, [
    "repository",
    "requestedRef",
    "resolvedCommit",
    "sourcePath",
    "termsUrl",
  ], "raw manifest upstream");
  requireExactKeys(manifest.corpus, [
    "file",
    "recordCount",
    "sha256",
    "contract",
  ], "raw manifest corpus");
  requireExactKeys(manifest.integrity, [
    "algorithm",
    "textNormalization",
    "contentHashes",
  ], "raw manifest integrity");
  const repository = requiredString(manifest.upstream.repository, "raw upstream.repository");
  const resolvedCommit = requiredString(manifest.upstream.resolvedCommit, "raw upstream.resolvedCommit");
  if (!/^[0-9a-f]{40,64}$/u.test(resolvedCommit)) {
    throw new Error("Raw upstream.resolvedCommit must be a hexadecimal Git object ID");
  }
  const corpusFile = requiredString(manifest.corpus.file, "raw corpus.file");
  const corpusSha256 = validateSha256(manifest.corpus.sha256, "raw corpus.sha256");
  if (corpusFile !== `corpus-${corpusSha256}.jsonl` || !isSafeRelativePath(corpusFile)) {
    throw new Error("Raw corpus.file must be content-addressed by corpus.sha256");
  }
  if (!Number.isSafeInteger(manifest.corpus.recordCount) || manifest.corpus.recordCount < 0) {
    throw new Error("Raw corpus.recordCount must be a non-negative integer");
  }
  if (manifest.integrity.algorithm !== "sha256" || !isObject(manifest.integrity.contentHashes)) {
    throw new Error("Raw manifest integrity must provide sha256 contentHashes");
  }

  const corpusText = await readUtf8File(join(rawRoot, corpusFile), "raw corpus");
  if (sha256(corpusText) !== corpusSha256) {
    throw new Error("Raw corpus failed whole-file integrity validation");
  }
  if (!corpusText.endsWith("\n")) {
    throw new Error("Raw corpus must end with a newline");
  }
  const lines = corpusText.length === 0 ? [] : corpusText.slice(0, -1).split("\n");
  const records = lines.map((line, index) => parseJson(line, `raw corpus line ${index + 1}`));
  if (records.length !== manifest.corpus.recordCount) {
    throw new Error("Raw corpus record count does not match its manifest");
  }
  const ids = new Set();
  for (const record of records) {
    validateRawRecord(record);
    if (ids.has(record.id)) {
      throw new Error(`Duplicate raw corpus id: ${record.id}`);
    }
    ids.add(record.id);
    if (manifest.integrity.contentHashes[record.id] !== record.contentSha256) {
      throw new Error(`Raw integrity hash does not match record: ${record.id}`);
    }
  }
  if (Object.keys(manifest.integrity.contentHashes).length !== records.length) {
    throw new Error("Raw integrity contentHashes must exactly cover the corpus records");
  }
  manifest.upstream.repository = repository;
  return { manifest, records };
}

function validateRawRecord(record) {
  if (!isObject(record) || record.schemaVersion !== 2) {
    throw new Error("Every raw corpus record must use schemaVersion 2");
  }
  requireExactKeys(record, [
    "schemaVersion",
    "id",
    "skill",
    "kind",
    "format",
    "sourcePath",
    "lineCount",
    "contentSha256",
    "text",
  ], `raw corpus record ${String(record.id)}`);
  const id = requiredSafePath(record.id, "raw record id");
  const skill = requiredString(record.skill, `raw record skill for ${id}`);
  if (id.split("/")[0] !== skill) {
    throw new Error(`Raw record skill does not match its id: ${id}`);
  }
  if (!new Set(["markdown", "javascript", "typescript"]).has(record.format)) {
    throw new Error(`Raw record has an unsupported format: ${id}`);
  }
  if (record.format !== inferFormatFromPath(id)) {
    throw new Error(`Raw record format does not match its extension: ${id}`);
  }
  const expectedKind = id.split("/").length === 2 && id.endsWith("/SKILL.md")
    ? "skill"
    : record.format === "markdown" ? "reference" : "script";
  if (record.kind !== expectedKind || record.sourcePath !== id) {
    throw new Error(`Raw record kind or sourcePath is invalid: ${id}`);
  }
  requiredString(record.text, `raw record text for ${id}`, true);
  if (record.lineCount !== record.text.split("\n").length) {
    throw new Error(`Raw record lineCount does not match its text: ${id}`);
  }
  const contentSha256 = validateSha256(record.contentSha256, `raw contentSha256 for ${id}`);
  if (sha256(record.text) !== contentSha256) {
    throw new Error(`Raw record content hash does not match its text: ${id}`);
  }
}

async function readPolicies(activeRoot, expectedCount) {
  const policyRoot = join(activeRoot, "policy");
  const entries = await readdir(policyRoot, { withFileTypes: true });
  if (entries.some((entry) => !entry.isFile() || !entry.name.endsWith(".json"))) {
    throw new Error("upstream-active/policy may contain only JSON policy fragments");
  }
  const files = entries.map((entry) => entry.name).sort(compareStrings);
  if (files.length !== expectedCount) {
    throw new Error(`Expected ${expectedCount} upstream active policy fragments, found ${files.length}`);
  }
  const skills = new Set();
  const ids = new Set();
  const records = [];
  for (const file of files) {
    const fragment = parseJson(
      await readUtf8File(join(policyRoot, file), `policy fragment ${file}`),
      `policy fragment ${file}`,
    );
    requireExactKeys(fragment, ["schemaVersion", "skill", "records"], `policy fragment ${file}`);
    if (fragment.schemaVersion !== 1) {
      throw new Error(`Policy fragment ${file} schemaVersion must be 1`);
    }
    const skill = requiredString(fragment.skill, `policy fragment skill in ${file}`);
    if (file !== `${skill}.json` || !isSafePathSegment(skill)) {
      throw new Error(`Policy fragment filename must match its skill: ${file}`);
    }
    if (skills.has(skill)) {
      throw new Error(`Duplicate policy skill: ${skill}`);
    }
    skills.add(skill);
    if (!Array.isArray(fragment.records) || fragment.records.length === 0) {
      throw new Error(`Policy fragment ${file} records must be a non-empty array`);
    }
    for (const record of fragment.records) {
      validatePolicyRecord(record, skill);
      if (ids.has(record.id)) {
        throw new Error(`Duplicate policy record id: ${record.id}`);
      }
      ids.add(record.id);
      records.push(record);
    }
  }
  return records.sort(compareRecords);
}

function validatePolicyRecord(record, skill) {
  if (!isObject(record)) {
    throw new Error(`Policy record in ${skill} must be an object`);
  }
  const expectsMirror = markdownClassifications.has(record.classification);
  requireExactKeys(record, [
    "id",
    "sourceContentSha256",
    "classification",
    "state",
    ...(expectsMirror ? ["mirrorPath"] : []),
    "sourceContract",
    "targetContract",
    "surfaces",
    "mappingProfile",
  ], `policy record ${String(record.id)}`);
  const id = requiredSafePath(record.id, "policy record id");
  if (id.split("/")[0] !== skill) {
    throw new Error(`Policy record id does not belong to fragment skill: ${id}`);
  }
  validateSha256(record.sourceContentSha256, `policy sourceContentSha256 for ${id}`);
  if (!classifications.has(record.classification)) {
    throw new Error(`Unknown policy classification for ${id}: ${String(record.classification)}`);
  }
  if (record.state !== "ready") {
    throw new Error(`Policy record state must be ready: ${id}`);
  }
  if (record.sourceContract !== expectedSourceContract || record.targetContract !== expectedTargetContract) {
    throw new Error(`Policy record contract mapping is invalid: ${id}`);
  }
  if (!Array.isArray(record.surfaces)) {
    throw new Error(`Policy record surfaces must be an array: ${id}`);
  }
  const surfaces = new Set();
  for (const surface of record.surfaces) {
    requiredString(surface, `policy surface for ${id}`);
    if (surfaces.has(surface)) {
      throw new Error(`Duplicate policy surface for ${id}: ${surface}`);
    }
    surfaces.add(surface);
  }
  requiredString(record.mappingProfile, `policy mappingProfile for ${id}`);
  if (expectsMirror) {
    const mirrorPath = requiredSafePath(record.mirrorPath, `policy mirrorPath for ${id}`);
    if (!mirrorPath.startsWith("docs/") || !mirrorPath.endsWith(".md")) {
      throw new Error(`Markdown policy mirrorPath must point under docs/: ${id}`);
    }
  }
}

function validatePolicyFormat(policy, format) {
  if (markdownClassifications.has(policy.classification) && format !== "markdown") {
    throw new Error(`Markdown policy classification does not match raw format: ${policy.id}`);
  }
  if (policy.classification === "examples" && format !== "javascript") {
    throw new Error(`examples policy classification requires JavaScript: ${policy.id}`);
  }
  if (policy.classification === "api" && format !== "typescript") {
    throw new Error(`api policy classification requires TypeScript: ${policy.id}`);
  }
}

async function readMirror(activeRoot, policy) {
  const mirrorPath = resolve(activeRoot, ...policy.mirrorPath.split("/"));
  if (!isWithin(activeRoot, mirrorPath)) {
    throw new Error(`Policy mirrorPath escapes upstream-active: ${policy.id}`);
  }
  return readUtf8File(mirrorPath, `mirror for ${policy.id}`);
}

function createDerivedRecord(policy, source, text, sanitized, nonExecutable) {
  return {
    schemaVersion: 1,
    id: policy.id,
    sourceRecordId: source.id,
    classification: policy.classification,
    format: source.format,
    sourceContract: policy.sourceContract,
    targetContract: policy.targetContract,
    sanitized,
    nonExecutable,
    sourceContentSha256: source.contentSha256,
    derivedContentSha256: sha256(text),
    text,
  };
}

function inferNewClassification(format) {
  if (format === "markdown") {
    return "conditional";
  }
  if (format === "javascript") {
    return "examples";
  }
  return "api";
}

function inferFormatFromPath(path) {
  if (path.endsWith(".md")) {
    return "markdown";
  }
  if (path.endsWith(".js")) {
    return "javascript";
  }
  if (path.endsWith(".ts")) {
    return "typescript";
  }
  throw new Error(`Policy record id has an unsupported extension: ${path}`);
}

async function publishActiveCorpus(activeRoot, options) {
  await mkdir(activeRoot, { recursive: true });
  const transactionId = `${process.pid}-${randomUUID()}`;
  const corpusPath = join(activeRoot, options.corpusFile);
  if (await pathExists(corpusPath)) {
    const existingCorpus = await readFile(corpusPath);
    if (sha256(existingCorpus) !== options.corpusSha256) {
      throw new Error(`Existing content-addressed active corpus failed integrity: ${options.corpusFile}`);
    }
  } else {
    const temporary = join(activeRoot, `.${options.corpusFile}.${transactionId}.tmp`);
    await writeSyncedFile(temporary, options.corpusJsonl);
    try {
      await options.renameFile(temporary, corpusPath);
      await options.syncDirectoryFn(activeRoot);
    } catch (error) {
      await removeFailedTemporary(temporary, error);
    }
  }

  const manifestPath = join(activeRoot, "manifest.json");
  const temporary = join(activeRoot, `.manifest.json.${transactionId}.tmp`);
  await writeSyncedFile(temporary, options.manifestJson);
  try {
    await options.renameFile(temporary, manifestPath);
    await options.syncDirectoryFn(activeRoot);
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

async function readUtf8File(path, label) {
  let bytes;
  try {
    bytes = await readFile(path);
  } catch (error) {
    const wrapped = new Error(`Unable to read ${label}: ${path}`);
    wrapped.cause = error;
    throw wrapped;
  }
  try {
    return utf8Decoder.decode(bytes);
  } catch {
    throw new Error(`${label} is not valid UTF-8: ${path}`);
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

function requireExactKeys(value, keys, label) {
  if (!isObject(value)) {
    throw new Error(`${label} must be an object`);
  }
  const actual = Object.keys(value).sort(compareStrings);
  const expected = [...keys].sort(compareStrings);
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw new Error(`${label} must contain exactly: ${expected.join(", ")}`);
  }
}

function requiredString(value, label, allowEmpty = false) {
  if (typeof value !== "string" || (!allowEmpty && value.length === 0)) {
    throw new Error(`${label} must be ${allowEmpty ? "a string" : "a non-empty string"}`);
  }
  return value;
}

function requiredSafePath(value, label) {
  const path = requiredString(value, label);
  if (!isSafeRelativePath(path)) {
    throw new Error(`${label} must be a safe POSIX relative path`);
  }
  return path;
}

function validateSha256(value, label) {
  if (typeof value !== "string" || !/^[0-9a-f]{64}$/u.test(value)) {
    throw new Error(`${label} must be a lowercase SHA-256 digest`);
  }
  return value;
}

function isSafeRelativePath(path) {
  return typeof path === "string"
    && path.length > 0
    && !path.startsWith("/")
    && !path.endsWith("/")
    && !path.includes("\\")
    && !/[\u0000-\u001f\u007f]/u.test(path)
    && path.split("/").every((segment) => isSafePathSegment(segment));
}

function isSafePathSegment(segment) {
  return typeof segment === "string"
    && segment.length > 0
    && segment !== "."
    && segment !== ".."
    && !segment.includes("/")
    && !segment.includes("\\")
    && !/[\u0000-\u001f\u007f]/u.test(segment);
}

function isWithin(root, target) {
  const path = relative(root, target);
  return path !== ".." && !path.startsWith(`..${sep}`) && !path.startsWith(sep);
}

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
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

function sha256(value) {
  return createHash("sha256")
    .update(value, typeof value === "string" ? "utf8" : undefined)
    .digest("hex");
}

function compareRecords(left, right) {
  return compareStrings(left.id, right.id);
}

function compareStrings(left, right) {
  return Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"));
}
