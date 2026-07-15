import { createHash } from "node:crypto";
import { readFile, readdir, rm } from "node:fs/promises";
import { join, relative, resolve, sep } from "node:path";
import { publishContentAddressed } from "./content-addressed-publication.mjs";

export const CANONICAL_TASK_FAMILIES = Object.freeze([
  "code-connect",
  "create-file",
  "design-editing",
  "design-generation",
  "design-to-code",
  "diagram",
  "figjam",
  "library-generation",
  "motion",
  "motion-implementation",
  "slides",
  "swiftui",
]);

export const CANONICAL_SURFACES = Object.freeze(["design", "figjam", "slides"]);

const publishedClassifications = new Set(["active", "conditional", "router", "examples"]);
const allClassifications = new Set([...publishedClassifications, "api"]);
const allowedSurfaces = new Set(CANONICAL_SURFACES);
const allowedMappingProfiles = new Set([
  "canonical-typescript-example",
  "code-connect",
  "design-to-code",
  "exact-plugin-api",
  "figjam",
  "motion",
  "plugin-api",
  "slides",
  "upstream-capability",
]);
const expectedSourceContract = "figma-mcp";
const expectedTargetContract = "figma-workspace-cli";
const routeCatalogFile = "routes.json";
const utf8Decoder = new TextDecoder("utf-8", { fatal: true });

export async function buildCanonicalCorpus(options = {}) {
  const canonicalRoot = resolve(requiredString(options.canonicalRoot, "canonicalRoot"));
  const generatedAt = options.generatedAt ?? new Date().toISOString();
  const expectedPolicyFragmentCount = options.expectedPolicyFragmentCount ?? 12;
  const expectedPublishedRecordCount = options.expectedPublishedRecordCount ?? 87;
  const expectedTaskFamilies = options.expectedTaskFamilies ?? CANONICAL_TASK_FAMILIES;
  requiredString(generatedAt, "generatedAt");
  requirePositiveInteger(expectedPolicyFragmentCount, "expectedPolicyFragmentCount");
  requirePositiveInteger(expectedPublishedRecordCount, "expectedPublishedRecordCount");
  validateExpectedTaskFamilies(expectedTaskFamilies);

  const routeCatalog = await readRouteCatalog(canonicalRoot, expectedTaskFamilies);
  const routeBySkill = new Map(routeCatalog.routes.map((route) => [route.skill, route]));
  const policies = await readPolicies(canonicalRoot, expectedPolicyFragmentCount);
  validatePolicyRouteMapping(policies, routeCatalog.routes);

  const records = [];
  const canonicalIds = new Set();
  const reviewWarnings = [];
  const classificationInventory = createCountInventory(
    ["active", "conditional", "router", "examples"],
  );
  const surfaceInventory = createCountInventory(CANONICAL_SURFACES);
  const taskFamilyInventory = createCountInventory(expectedTaskFamilies);
  for (const policy of policies) {
    if (policy.classification === "api") {
      continue;
    }
    const route = routeBySkill.get(policy.skill);
    if (route === undefined) {
      throw new Error(`Policy skill has no canonical route: ${policy.skill}`);
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
    classificationInventory[policy.classification] += 1;
    taskFamilyInventory[route.taskFamily] += 1;
    for (const surface of policy.surfaces) {
      surfaceInventory[surface] += 1;
    }
    const title = extractTitle(text, id);
    records.push({
      schemaVersion: 2,
      id,
      title,
      summary: extractSummary(text, title),
      format: "markdown",
      classification: policy.classification,
      taskFamily: route.taskFamily,
      surfaces: [...policy.surfaces],
      mappingProfile: policy.mappingProfile,
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
    schemaVersion: 2,
    generatedAt,
    corpus: {
      file: corpusFile,
      recordCount: records.length,
      sha256: corpusSha256,
    },
    routeCatalog: {
      file: routeCatalogFile,
      schemaVersion: routeCatalog.schemaVersion,
      routeCount: routeCatalog.routes.length,
      sha256: routeCatalog.sha256,
    },
    inventories: {
      classifications: classificationInventory,
      surfaces: surfaceInventory,
      taskFamilies: taskFamilyInventory,
    },
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
    await removeSupersededCorpusFiles(canonicalRoot, corpusFile);
  }
  return {
    canonicalRoot,
    manifest,
    records,
    routes: routeCatalog.routes,
  };
}

export async function readCanonicalRouteCatalog(canonicalRoot, options = {}) {
  const expectedTaskFamilies = options.expectedTaskFamilies ?? CANONICAL_TASK_FAMILIES;
  validateExpectedTaskFamilies(expectedTaskFamilies);
  const catalog = await readRouteCatalog(resolve(canonicalRoot), expectedTaskFamilies);
  return {
    schemaVersion: catalog.schemaVersion,
    routes: catalog.routes,
  };
}

async function readRouteCatalog(canonicalRoot, expectedTaskFamilies) {
  const raw = await readUtf8File(
    join(canonicalRoot, routeCatalogFile),
    "canonical route catalog",
  );
  const catalog = parseJson(raw, "canonical route catalog");
  requireExactKeys(catalog, ["schemaVersion", "routes"], "canonical route catalog");
  if (catalog.schemaVersion !== 1) {
    throw new Error("Canonical route catalog schemaVersion must be 1");
  }
  if (!Array.isArray(catalog.routes) || catalog.routes.length !== expectedTaskFamilies.length) {
    throw new Error(
      `Canonical route catalog must contain exactly ${expectedTaskFamilies.length} routes`,
    );
  }
  const expected = new Set(expectedTaskFamilies);
  const taskFamilies = new Set();
  const skills = new Set();
  const aliases = new Set();
  const routes = [];
  for (const value of catalog.routes) {
    requireExactKeys(
      value,
      ["taskFamily", "skill", "surfaces", "canonicalQuery", "aliases"],
      "canonical route",
    );
    const taskFamily = requiredKebabCase(value.taskFamily, "canonical route taskFamily");
    if (!expected.has(taskFamily)) {
      throw new Error(`Unknown canonical task family: ${taskFamily}`);
    }
    if (taskFamilies.has(taskFamily)) {
      throw new Error(`Duplicate canonical task family: ${taskFamily}`);
    }
    taskFamilies.add(taskFamily);
    const skill = requiredString(value.skill, `canonical route skill for ${taskFamily}`);
    if (!isSafePathSegment(skill)) {
      throw new Error(`Canonical route skill must be a safe path segment: ${skill}`);
    }
    if (skills.has(skill)) {
      throw new Error(`Duplicate canonical route skill: ${skill}`);
    }
    skills.add(skill);
    const surfaces = validateSurfaces(value.surfaces, `canonical route ${taskFamily}`);
    const canonicalQuery = requiredEnglishText(
      value.canonicalQuery,
      `canonical query for ${taskFamily}`,
      160,
    );
    if (!Array.isArray(value.aliases) || value.aliases.length === 0) {
      throw new Error(`Canonical route aliases must be a non-empty array: ${taskFamily}`);
    }
    const routeAliases = [];
    for (const aliasValue of value.aliases) {
      const alias = requiredEnglishText(
        aliasValue,
        `canonical route alias for ${taskFamily}`,
        80,
      );
      const normalizedAlias = normalizeEnglishRouteText(alias);
      if (aliases.has(normalizedAlias)) {
        throw new Error(`Duplicate canonical route alias: ${alias}`);
      }
      aliases.add(normalizedAlias);
      routeAliases.push(alias);
    }
    routes.push({ taskFamily, skill, surfaces, canonicalQuery, aliases: routeAliases });
  }
  const actualFamilies = [...taskFamilies].sort(compareStrings);
  const sortedExpected = [...expectedTaskFamilies].sort(compareStrings);
  if (actualFamilies.some((family, index) => family !== sortedExpected[index])) {
    throw new Error("Canonical route catalog does not cover the expected task families");
  }
  for (let index = 1; index < routes.length; index += 1) {
    if (compareStrings(routes[index - 1].taskFamily, routes[index].taskFamily) >= 0) {
      throw new Error("Canonical route catalog must be strictly sorted by taskFamily");
    }
  }
  return { schemaVersion: 1, routes, sha256: sha256(raw) };
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
      records.push({ ...record, skill });
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
  if (isPublished && classification !== "examples" && !id.endsWith(".md")) {
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
  validateSurfaces(record.surfaces, `policy record ${id}`);
  const mappingProfile = requiredString(record.mappingProfile, `policy mappingProfile for ${id}`);
  if (!allowedMappingProfiles.has(mappingProfile)) {
    throw new Error(`Unknown policy mappingProfile for ${id}: ${mappingProfile}`);
  }
  if (classification === "examples" && mappingProfile !== "canonical-typescript-example") {
    throw new Error(`Canonical example must use canonical-typescript-example mapping: ${id}`);
  }
  if (isPublished) {
    const mirrorPath = requiredSafePath(record.mirrorPath, `policy mirrorPath for ${id}`);
    if (!mirrorPath.startsWith("docs/") || !mirrorPath.endsWith(".md")) {
      throw new Error(`Canonical mirrorPath must point to Markdown under docs/: ${id}`);
    }
  }
}

function validatePolicyRouteMapping(policies, routes) {
  const policySurfacesBySkill = new Map();
  for (const policy of policies) {
    let surfaces = policySurfacesBySkill.get(policy.skill);
    if (surfaces === undefined) {
      surfaces = new Set();
      policySurfacesBySkill.set(policy.skill, surfaces);
    }
    for (const surface of policy.surfaces) {
      surfaces.add(surface);
    }
  }
  if (policySurfacesBySkill.size !== routes.length) {
    throw new Error("Canonical routes and policy fragments must have a one-to-one skill mapping");
  }
  for (const route of routes) {
    const policySurfaces = policySurfacesBySkill.get(route.skill);
    if (policySurfaces === undefined) {
      throw new Error(`Canonical route has no policy fragment: ${route.skill}`);
    }
    const actual = [...policySurfaces].sort(compareStrings);
    const expected = [...route.surfaces].sort(compareStrings);
    if (
      actual.length !== expected.length
      || actual.some((surface, index) => surface !== expected[index])
    ) {
      throw new Error(`Canonical route surfaces do not match policy surfaces: ${route.skill}`);
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

async function removeSupersededCorpusFiles(canonicalRoot, currentCorpusFile) {
  const entries = await readdir(canonicalRoot, { withFileTypes: true });
  await Promise.all(entries.map(async (entry) => {
    if (
      entry.isFile()
      && entry.name !== currentCorpusFile
      && /^corpus-[0-9a-f]{64}\.jsonl$/u.test(entry.name)
    ) {
      await rm(join(canonicalRoot, entry.name));
    }
  }));
}

function extractTitle(text, id) {
  let inFence = false;
  for (const line of text.split(/\r?\n/u)) {
    if (/^\s*```/u.test(line)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    const match = /^\s{0,3}#{1,6}[ \t]+(.+?)[ \t]*#*[ \t]*$/u.exec(line);
    if (match !== null) {
      const title = collapseWhitespace(match[1]);
      if (title.length > 0) return truncateCharacters(title, 120);
    }
  }
  const basename = id.split("/").at(-1)?.replace(/\.md$/u, "") ?? id;
  return truncateCharacters(collapseWhitespace(basename), 120);
}

function extractSummary(text, title) {
  const lines = text.split(/\r?\n/u);
  let inFence = false;
  let paragraph = [];
  const flush = () => {
    if (paragraph.length === 0) return undefined;
    const value = collapseWhitespace(paragraph.join(" "));
    paragraph = [];
    return value.length === 0 ? undefined : truncateCharacters(value, 240);
  };
  for (const line of lines) {
    if (/^\s*```/u.test(line)) {
      const value = flush();
      if (value !== undefined) return value;
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    if (line.trim().length === 0) {
      const value = flush();
      if (value !== undefined) return value;
      continue;
    }
    if (isMarkdownBlockLine(line)) {
      const value = flush();
      if (value !== undefined) return value;
      continue;
    }
    paragraph.push(line.trim());
  }
  return flush() ?? title;
}

function isMarkdownBlockLine(line) {
  return /^\s{0,3}(?:#{1,6}[ \t]|[-*_](?:[ \t]*[-*_]){2,}[ \t]*$|>|[-+*][ \t]|\d+[.)][ \t]|<|\|)/u
    .test(line);
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

function requiredKebabCase(value, label) {
  const result = requiredString(value, label);
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(result)) {
    throw new Error(`${label} must be lower-case kebab-case`);
  }
  return result;
}

function requiredEnglishText(value, label, maximumCharacters) {
  const result = requiredString(value, label);
  if (
    result !== collapseWhitespace(result)
    || !/[A-Za-z]/u.test(result)
    || !/^[\x20-\x7e]+$/u.test(result)
    || Array.from(result).length > maximumCharacters
  ) {
    throw new Error(`${label} must be compact English ASCII text up to ${maximumCharacters} characters`);
  }
  return result;
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

function validateExpectedTaskFamilies(value) {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error("expectedTaskFamilies must be a non-empty array");
  }
  const seen = new Set();
  for (const family of value) {
    requiredKebabCase(family, "expected task family");
    if (seen.has(family)) throw new Error(`Duplicate expected task family: ${family}`);
    seen.add(family);
  }
}

function validateSurfaces(value, label) {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error(`${label} surfaces must be a non-empty array`);
  }
  const surfaces = new Set();
  for (const surface of value) {
    if (!allowedSurfaces.has(surface)) {
      throw new Error(`Unknown ${label} surface: ${String(surface)}`);
    }
    if (surfaces.has(surface)) {
      throw new Error(`Duplicate ${label} surface: ${surface}`);
    }
    surfaces.add(surface);
  }
  return [...surfaces].sort(compareStrings);
}

function createCountInventory(values) {
  return Object.fromEntries([...values].sort(compareStrings).map((value) => [value, 0]));
}

function collapseWhitespace(value) {
  return value.replace(/\s+/gu, " ").trim();
}

function normalizeEnglishRouteText(value) {
  return value
    .toLocaleLowerCase("en-US")
    .replace(/[^a-z0-9]+/gu, " ")
    .trim()
    .replace(/\s+/gu, " ");
}

function truncateCharacters(value, maximumCharacters) {
  return Array.from(value).slice(0, maximumCharacters).join("");
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
