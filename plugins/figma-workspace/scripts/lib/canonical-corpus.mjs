import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { join, relative, resolve, sep } from "node:path";
import { publishContentAddressed } from "./content-addressed-publication.mjs";

const publishedClassifications = new Set(["active", "conditional", "router", "examples"]);
const allClassifications = new Set([...publishedClassifications, "api"]);
const expectedSourceContract = "figma-mcp";
const expectedTargetContract = "figma-workspace-cli";
const utf8Decoder = new TextDecoder("utf-8", { fatal: true });

export async function buildCanonicalCorpus(options = {}) {
  const canonicalRoot = resolve(requiredString(options.canonicalRoot, "canonicalRoot"));
  const generatedAt = options.generatedAt ?? new Date().toISOString();
  const expectedPolicyFragmentCount = options.expectedPolicyFragmentCount ?? 12;
  const expectedPublishedRecordCount = options.expectedPublishedRecordCount ?? 87;
  requiredString(generatedAt, "generatedAt");
  requirePositiveInteger(expectedPolicyFragmentCount, "expectedPolicyFragmentCount");
  requirePositiveInteger(expectedPublishedRecordCount, "expectedPublishedRecordCount");

  const policies = await readPolicies(canonicalRoot, expectedPolicyFragmentCount);
  const records = [];
  const canonicalIds = new Set();
  const reviewWarnings = [];
  const classificationCounts = {
    active: 0,
    conditional: 0,
    router: 0,
    examples: 0,
  };
  for (const policy of policies) {
    if (policy.classification === "api") {
      continue;
    }
    const text = await readMirror(canonicalRoot, policy);
    if (
      policy.classification === "examples"
      && !/(?:^|\n)```(?:ts|typescript)[ \t]*\n/u.test(text)
    ) {
      throw new Error(`Canonical example must contain a TypeScript code fence: ${policy.id}`);
    }
    const contentSha256 = sha256(text);
    if (contentSha256 === policy.sourceContentSha256) {
      reviewWarnings.push({
        code: "SOURCE_IDENTICAL",
        id: policy.mirrorPath.slice("docs/".length),
        sourceRecordId: policy.id,
        contentSha256,
      });
    }
    const id = policy.mirrorPath.slice("docs/".length);
    if (canonicalIds.has(id)) {
      throw new Error(`Duplicate canonical record id: ${id}`);
    }
    canonicalIds.add(id);
    classificationCounts[policy.classification] += 1;
    records.push({
      schemaVersion: 1,
      id,
      format: "markdown",
      classification: policy.classification,
      sourceRecordId: policy.id,
      sourceContract: policy.sourceContract,
      targetContract: policy.targetContract,
      sanitized: true,
      contentSha256,
      ...(policy.classification === "examples" ? { nonExecutable: true } : {}),
      text,
    });
  }
  if (records.length !== expectedPublishedRecordCount) {
    throw new Error(
      `Expected ${expectedPublishedRecordCount} canonical records, found ${records.length}`,
    );
  }
  records.sort(compareRecords);
  const corpusJsonl = `${records.map((record) => JSON.stringify(record)).join("\n")}\n`;
  const corpusSha256 = sha256(corpusJsonl);
  const corpusFile = `corpus-${corpusSha256}.jsonl`;
  const manifest = {
    schemaVersion: 1,
    generatedAt,
    corpus: {
      file: corpusFile,
      recordCount: records.length,
      sha256: corpusSha256,
    },
    classificationCounts,
    reviewWarnings,
    integrity: {
      algorithm: "sha256",
      contentHashes: Object.fromEntries(
        records.map((record) => [record.id, record.contentSha256]),
      ),
    },
    ...(options.source === undefined ? {} : { source: validateSource(options.source) }),
  };
  const manifestJson = `${JSON.stringify(manifest, null, 2)}\n`;

  if (options.publish !== false) {
    await publishContentAddressed({
      root: canonicalRoot,
      contentFile: corpusFile,
      content: corpusJsonl,
      contentSha256: corpusSha256,
      manifest: manifestJson,
      renameFile: options.renameFile,
      syncDirectoryFn: options.syncDirectoryFn,
    });
  }
  return { canonicalRoot, manifest, records };
}

async function readPolicies(canonicalRoot, expectedCount) {
  const policyRoot = join(canonicalRoot, "policy");
  const entries = await readdir(policyRoot, { withFileTypes: true });
  if (entries.some((entry) => !entry.isFile() || !entry.name.endsWith(".json"))) {
    throw new Error("canonical-corpus/policy may contain only JSON policy fragments");
  }
  const files = entries.map((entry) => entry.name).sort(compareStrings);
  if (files.length !== expectedCount) {
    throw new Error(`Expected ${expectedCount} canonical policy fragments, found ${files.length}`);
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
  const classification = record.classification;
  if (!allClassifications.has(classification)) {
    throw new Error(`Unknown policy classification for ${String(record.id)}: ${String(classification)}`);
  }
  const isPublished = publishedClassifications.has(classification);
  requireExactKeys(record, [
    "id",
    "sourceContentSha256",
    "classification",
    "state",
    ...(isPublished ? ["mirrorPath"] : []),
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
  if (publishedClassifications.has(classification) && classification !== "examples" && !id.endsWith(".md")) {
    throw new Error(`Canonical Markdown policy must track an upstream Markdown record: ${id}`);
  }
  if (classification === "examples" && !id.endsWith(".js")) {
    throw new Error(`Canonical examples policy must track an upstream JavaScript record: ${id}`);
  }
  if (classification === "api" && !id.endsWith(".ts")) {
    throw new Error(`Canonical API policy must track an upstream TypeScript record: ${id}`);
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
  if (isPublished) {
    const mirrorPath = requiredSafePath(record.mirrorPath, `policy mirrorPath for ${id}`);
    if (!mirrorPath.startsWith("docs/") || !mirrorPath.endsWith(".md")) {
      throw new Error(`Canonical mirrorPath must point to Markdown under docs/: ${id}`);
    }
  }
}

async function readMirror(canonicalRoot, policy) {
  const path = resolve(canonicalRoot, ...policy.mirrorPath.split("/"));
  if (!isWithin(canonicalRoot, path)) {
    throw new Error(`Policy mirrorPath escapes canonical-corpus: ${policy.id}`);
  }
  return readUtf8File(path, `canonical mirror for ${policy.id}`);
}

function validateSource(source) {
  requireExactKeys(source, ["repository", "resolvedCommit"], "canonical source");
  const repository = requiredString(source.repository, "canonical source.repository");
  const resolvedCommit = requiredString(source.resolvedCommit, "canonical source.resolvedCommit");
  if (!/^[0-9a-f]{40,64}$/u.test(resolvedCommit)) {
    throw new Error("canonical source.resolvedCommit must be a Git object ID");
  }
  return { repository, resolvedCommit };
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

function requirePositiveInteger(value, label) {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error(`${label} must be a positive integer`);
  }
}

function requiredString(value, label) {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${label} must be a non-empty string`);
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

function sha256(value) {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function compareRecords(left, right) {
  return compareStrings(left.id, right.id);
}

function compareStrings(left, right) {
  return Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"));
}
