import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const pluginRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const rawRoot = join(pluginRoot, "skills", "figma-workspace", "references", "upstream-corpus");
const activeRoot = join(pluginRoot, "skills", "figma-workspace", "references", "upstream-active");

test("committed policy classifies every raw snapshot record exactly once", async () => {
  const rawManifest = JSON.parse(await readFile(join(rawRoot, "manifest.json"), "utf8"));
  const rawRecords = parseJsonl(await readFile(join(rawRoot, rawManifest.corpus.file), "utf8"));
  const policyFiles = (await readdir(join(activeRoot, "policy")))
    .filter((file) => file.endsWith(".json"))
    .sort();
  assert.equal(policyFiles.length, 12);
  const policyRecords = (
    await Promise.all(policyFiles.map(async (file) => {
      const fragment = JSON.parse(await readFile(join(activeRoot, "policy", file), "utf8"));
      assert.equal(file, `${fragment.skill}.json`);
      return fragment.records;
    }))
  ).flat();
  assert.equal(policyRecords.length, 88);
  assert.deepEqual(
    [...new Set(policyRecords.map((record) => record.id))].sort(),
    rawRecords.map((record) => record.id).sort(),
  );
  assert.deepEqual(classificationCounts(policyRecords), {
    active: 46,
    conditional: 20,
    router: 12,
    examples: 9,
    api: 1,
  });
  const sourceHashes = new Map(rawRecords.map((record) => [record.id, record.contentSha256]));
  for (const record of policyRecords) {
    assert.equal(record.sourceContentSha256, sourceHashes.get(record.id), record.id);
  }
});

test("all Markdown mirrors are CLI-compatible and uncovered operations remain schema-gated", async () => {
  const policyFiles = (await readdir(join(activeRoot, "policy"))).filter((file) => file.endsWith(".json"));
  const policyRecords = (
    await Promise.all(policyFiles.map(async (file) =>
      JSON.parse(await readFile(join(activeRoot, "policy", file), "utf8")).records))
  ).flat();
  const markdownRecords = policyRecords.filter((record) => record.mirrorPath);
  assert.equal(markdownRecords.length, 78);
  const forbiddenRouting = /skillNames|resource:|mcpServers|ToolSearch|MUST invoke|MANDATORY prerequisite|use_figma|get_metadata|get_design_context|get_motion_context|get_variable_defs|get_libraries|search_design_system|generate_diagram|create_new_file|figma-workspace:\/\/|figma:\/\//iu;
  const invalidCliExample = /figma:(?:libraries|design-system|metadata|assets:apply)\s*\(|^\s*figma:(?:libraries|design-system|metadata|assets:apply)\s+--|--node-id\b/mu;
  const mandatorySkillRouting = /must be loaded alongside|load (?:the|those) skills?\b|load (?:the )?figma-[a-z0-9-]+ skill\b|follow (?:that|the) skill instead/iu;
  const brokenInlineCode = /`a local `\.figma\.ts`|your a local `\.figma\.ts`|the a local `\.figma\.ts`/u;
  const brokenAnchor = /\]\(#[^)]*(?:\s|`)[^)]*\)/u;
  const uncoveredCodeConnect = /\b(?:add|remove|get|send)_code_connect_(?:map|mappings)\b/iu;
  for (const record of markdownRecords) {
    const text = await readFile(join(activeRoot, ...record.mirrorPath.split("/")), "utf8");
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
  }
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
