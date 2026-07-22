import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  CANONICAL_SURFACES,
  CANONICAL_TASK_FAMILIES,
} from "../scripts/lib/canonical-corpus.mjs";
import { inspectCommittedUpstreamDrift } from "../scripts/update-upstream-corpus.mjs";

const pluginRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const sourceRoot = join(pluginRoot, "dev", "canonical-corpus-source");
const skillsRoot = join(pluginRoot, "skills");
const canonicalRoot = join(
  pluginRoot,
  "skills",
  "figma-workspace",
  "references",
  "canonical-corpus",
);

test("committed upstream inventory is valid while pending and retired drift remains non-blocking", async () => {
  const inspection = await inspectCommittedUpstreamDrift();
  for (const warning of inspection.warnings) process.stderr.write(`${warning}\n`);
  const rawRecords = inspection.snapshotRecords;
  const policyRecords = inspection.acceptedPolicies;
  assert.equal(policyRecords.length, 88);
  assert.deepEqual(classificationCounts(policyRecords), {
    active: 46,
    conditional: 20,
    router: 12,
    examples: 9,
    api: 1,
  });
  assert.equal(
    inspection.report.adaptation.readyCount + inspection.report.adaptation.pendingCount,
    rawRecords.length,
  );
  assert.equal(
    inspection.report.adaptation.readyCount
      + inspection.report.adaptation.pendingRecords.filter((record) => record.drift === "changed").length
      + inspection.report.adaptation.retiredCount,
    policyRecords.length,
  );
});

test("shared route catalog maps all policy skills to the fixed task families", async () => {
  const routeText = await readFile(join(canonicalRoot, "routes.json"), "utf8");
  const catalog = JSON.parse(routeText);
  assert.equal(catalog.schemaVersion, 1);
  assert.deepEqual(
    catalog.routes.map((route) => route.taskFamily).sort(),
    [...CANONICAL_TASK_FAMILIES].sort(),
  );
  const policyFiles = (await readdir(join(sourceRoot, "policy")))
    .filter((file) => file.endsWith(".json"))
    .sort();
  const fragments = await Promise.all(policyFiles.map(async (file) =>
    JSON.parse(await readFile(join(sourceRoot, "policy", file), "utf8"))));
  assert.deepEqual(
    catalog.routes.map((route) => route.skill).sort(),
    fragments.map((fragment) => fragment.skill).sort(),
  );
  const aliases = new Set();
  for (const route of catalog.routes) {
    assert.match(route.taskFamily, /^[a-z0-9]+(?:-[a-z0-9]+)*$/u);
    assert.ok(route.aliases.length > 0, route.taskFamily);
    assert.match(route.canonicalQuery, /^[\x20-\x7e]+$/u);
    for (const alias of route.aliases) {
      assert.match(alias, /^[\x20-\x7e]+$/u);
      const normalized = alias.toLocaleLowerCase("en-US");
      assert.equal(aliases.has(normalized), false, alias);
      aliases.add(normalized);
    }
    const fragment = fragments.find((candidate) => candidate.skill === route.skill);
    const policySurfaces = [...new Set(fragment.records.flatMap((record) => record.surfaces))]
      .sort();
    assert.deepEqual([...route.surfaces].sort(), policySurfaces, route.skill);
    assert.ok(route.surfaces.every((surface) => CANONICAL_SURFACES.includes(surface)));
  }
});

test("committed canonical corpus is schema v2 with complete routing metadata", async () => {
  const manifest = JSON.parse(await readFile(join(canonicalRoot, "manifest.json"), "utf8"));
  const routeText = await readFile(join(canonicalRoot, "routes.json"), "utf8");
  const records = parseJsonl(await readFile(join(canonicalRoot, manifest.corpus.file), "utf8"));
  assert.equal(manifest.schemaVersion, 2);
  assert.deepEqual(manifest.routeCatalog, {
    file: "routes.json",
    schemaVersion: 1,
    routeCount: 12,
    sha256: sha256(routeText),
  });
  assert.equal(records.length, 87);
  assert.deepEqual(manifest.inventories.classifications, {
    active: 46,
    conditional: 20,
    examples: 9,
    router: 12,
  });
  assert.deepEqual(
    manifest.inventories.taskFamilies,
    countValues(records, "taskFamily", CANONICAL_TASK_FAMILIES),
  );
  assert.deepEqual(
    manifest.inventories.surfaces,
    countSurfaces(records),
  );
  for (const record of records) {
    assert.equal(record.schemaVersion, 2, record.id);
    assert.ok(CANONICAL_TASK_FAMILIES.includes(record.taskFamily), record.id);
    assert.ok(record.surfaces.length > 0, record.id);
    assert.ok(record.surfaces.every((surface) => CANONICAL_SURFACES.includes(surface)), record.id);
    assert.equal(typeof record.mappingProfile, "string", record.id);
    assert.ok(record.title.length > 0 && record.title.length <= 120, record.id);
    assert.ok(record.summary.length > 0 && record.summary.length <= 240, record.id);
    assert.equal(record.contentSha256, sha256(record.text), record.id);
  }
  const rootCorpusFiles = (await readdir(canonicalRoot))
    .filter((file) => /^corpus-[0-9a-f]{64}\.jsonl$/u.test(file));
  assert.deepEqual(rootCorpusFiles, [manifest.corpus.file]);
});

test("all 87 canonical mirrors are adapted, CLI-compatible Markdown", async () => {
  const policyFiles = (await readdir(join(sourceRoot, "policy")))
    .filter((file) => file.endsWith(".json"));
  const policyRecords = (
    await Promise.all(policyFiles.map(async (file) =>
      JSON.parse(await readFile(join(sourceRoot, "policy", file), "utf8")).records))
  ).flat();
  const markdownRecords = policyRecords.filter((record) => record.mirrorPath);
  assert.equal(markdownRecords.length, 87);
  assert.equal(markdownRecords.filter((record) => record.classification === "examples").length, 9);
  const forbiddenRouting = /skillNames|resource:|mcpServers|ToolSearch|MUST invoke|MANDATORY prerequisite|use_figma|get_metadata|get_design_context|get_motion_context|get_variable_defs|get_libraries|search_design_system|generate_diagram|create_new_file|figma-workspace:\/\/|figma:\/\//iu;
  const invalidCliExample = /figma:(?:libraries|design-system|metadata|assets:apply)\s*\(|^\s*figma:(?:libraries|design-system|metadata|assets:apply)\s+--|--node-id\b/mu;
  const mandatorySkillRouting = /must be loaded alongside|load (?:the|those) skills?\b|load (?:the )?figma-[a-z0-9-]+ skill\b|follow (?:that|the) skill instead/iu;
  const brokenInlineCode = /`a local `\.figma\.ts`|your a local `\.figma\.ts`|the a local `\.figma\.ts`/u;
  const brokenAnchor = /\]\(#[^)]*(?:\s|`)[^)]*\)/u;
  const uncoveredCodeConnect = /\b(?:add|remove|get|send)_code_connect_(?:map|mappings)\b/iu;
  const canonicalIds = new Set();
  for (const record of markdownRecords) {
    const text = await readFile(join(sourceRoot, ...record.mirrorPath.split("/")), "utf8");
    const canonicalId = record.mirrorPath.slice("docs/".length);
    assert.equal(canonicalIds.has(canonicalId), false, canonicalId);
    canonicalIds.add(canonicalId);
    assert.doesNotMatch(text, forbiddenRouting, record.id);
    assert.doesNotMatch(text, invalidCliExample, record.id);
    assert.doesNotMatch(text, mandatorySkillRouting, record.id);
    assert.doesNotMatch(text, brokenInlineCode, record.id);
    assert.doesNotMatch(text, brokenAnchor, record.id);
    assert.equal(text.startsWith("---\n"), false, `${record.id} retains YAML frontmatter`);
    if (uncoveredCodeConnect.test(text)) {
      assert.match(text, /figma:upstream:(?:list|read)/u, `${record.id} lacks live schema discovery`);
      assert.match(text, /figma:upstream:call/u, `${record.id} lacks the CLI escape hatch`);
    }
    if (record.classification === "examples") {
      assert.match(record.id, /\.js$/u);
      assert.match(record.mirrorPath, /\.md$/u);
      assert.notEqual(canonicalId, record.id);
      assert.equal(record.mappingProfile, "canonical-typescript-example");
      assert.match(text, /```(?:ts|typescript)\b/u);
    }
  }
});

test("plugin skills tree exposes only the Figma Workspace router skill", async () => {
  const skillFiles = (await readdir(skillsRoot, { recursive: true }))
    .map((path) => path.replaceAll("\\", "/"))
    .filter((path) => path === "SKILL.md" || path.endsWith("/SKILL.md"))
    .sort();
  assert.deepEqual(skillFiles, ["figma-workspace/SKILL.md"]);
});

function parseJsonl(text) {
  return text.trimEnd().split(/\r?\n/u).map((line) => JSON.parse(line));
}

function classificationCounts(records) {
  const result = { active: 0, conditional: 0, router: 0, examples: 0, api: 0 };
  for (const record of records) {
    result[record.classification] += 1;
  }
  return result;
}

function countValues(records, key, values) {
  const counts = Object.fromEntries([...values].sort().map((value) => [value, 0]));
  for (const record of records) counts[record[key]] += 1;
  return counts;
}

function countSurfaces(records) {
  const counts = Object.fromEntries([...CANONICAL_SURFACES].sort().map((surface) => [surface, 0]));
  for (const record of records) {
    for (const surface of record.surfaces) counts[surface] += 1;
  }
  return counts;
}

function sha256(value) {
  return createHash("sha256").update(value, "utf8").digest("hex");
}
