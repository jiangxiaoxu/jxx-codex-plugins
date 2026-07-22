import assert from "node:assert/strict";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";
import { stageFigmaPluginApiIndex } from "../scripts/build.mjs";

const packageRoot = resolve(import.meta.dirname, "..");
const pluginRoot = resolve(packageRoot, "..");
const temporaryRoot = await mkdtemp(resolve(tmpdir(), "figma-doc-search-runtime-"));
const runtimeRoot = resolve(temporaryRoot, "runtime");
const apiIndexRoot = resolve(runtimeRoot, "figma-plugin-api-index");
const typingsRoot = resolve(runtimeRoot, "figma-plugin-typings");
const referenceRoot = resolve(temporaryRoot, "skills/figma-workspace/references");
const compiledFile = resolve(runtimeRoot, "doc-search.mjs");
const compiledGuidanceFile = resolve(runtimeRoot, "guidance-catalog.mjs");
const pluginTypingsRoot = resolve(packageRoot, "node_modules/@figma/plugin-typings");

await mkdir(apiIndexRoot, { recursive: true });
await mkdir(typingsRoot, { recursive: true });
await mkdir(referenceRoot, { recursive: true });
await cp(resolve(pluginRoot, "skills/figma-workspace/references"), referenceRoot, { recursive: true });
await Promise.all([
  cp(resolve(pluginTypingsRoot, "index.d.ts"), resolve(typingsRoot, "index.d.ts")),
  cp(resolve(pluginTypingsRoot, "plugin-api.d.ts"), resolve(typingsRoot, "plugin-api.d.ts")),
]);
await stageFigmaPluginApiIndex(pluginTypingsRoot, apiIndexRoot);
await build({
  entryPoints: [resolve(packageRoot, "src/runtime/doc-search.ts")],
  outfile: compiledFile,
  bundle: true,
  format: "esm",
  platform: "node",
  target: "node20",
});
await build({
  entryPoints: [resolve(packageRoot, "src/runtime/guidance-catalog.ts")],
  outfile: compiledGuidanceFile,
  bundle: true,
  format: "esm",
  platform: "node",
  target: "node20",
});

const docs = await import(pathToFileURL(compiledFile).href);
const guidance = await import(pathToFileURL(compiledGuidanceFile).href);

test.after(async () => {
  await rm(temporaryRoot, { recursive: true, force: true });
});

test("canonical v2 catalog closes the exact id read loop", () => {
  const families = docs.listFigmaWorkspaceCanonicalCatalog();
  assert.equal(families.length, 12);
  assert.deepEqual([...families].map((entry) => entry.taskFamily).sort(), families.map((entry) => entry.taskFamily));

  const allRecords = families.flatMap((family) => docs.listFigmaWorkspaceCanonicalCatalog({
    taskFamily: family.taskFamily,
    limit: 100,
  }));
  assert.equal(allRecords.length, 87);
  assert.deepEqual(new Set(allRecords.map((record) => record.classification)), new Set([
    "active",
    "conditional",
    "router",
    "examples",
  ]));
  for (const summary of allRecords) {
    const record = docs.readFigmaWorkspaceCanonicalDoc(summary.id);
    assert.equal(record.id, summary.id);
    assert.equal(record.kind, "canonical");
    assert.equal(record.content.length > 0, true);
    assert.equal(record.nonExecutable, summary.classification === "examples");
  }

  const examples = docs.listFigmaWorkspaceCanonicalCatalog({
    taskFamily: "library-generation",
    classification: "examples",
  });
  assert.equal(examples.length, 9);
  for (const summary of examples) {
    assert.match(summary.id, /^canonical:/u);
    const record = docs.readFigmaWorkspaceCanonicalDoc(summary.id);
    assert.equal(record.id, summary.id);
    assert.equal(record.kind, "canonical");
    assert.equal(record.nonExecutable, true);
    assert.ok(record.content.length > 0);
  }

  for (const invalidId of [
    "figma-generate-library/examples/create-variable-collection.md",
    "canonical:../manifest.json",
    "canonical:figma-use/SKILL.md#md-0",
    "canonical:C:/manifest.json",
    "canonical:figma-use/SKILL.js",
  ]) {
    assert.throws(
      () => docs.readFigmaWorkspaceCanonicalDoc(invalidId),
      /figma:docs:catalog/u,
    );
  }
});

test("auto docs search hard-filters family and surface and emits compact unique records", async () => {
  const matches = await docs.searchReferenceFiles({
    query: "swiftui design to code",
    scope: "auto",
    surface: "design",
    taskFamily: "swiftui",
    effectiveScopes: ["active", "conditional", "router", "examples"],
    maxResults: 10,
    maxSnippetLines: 8,
  });
  assert.ok(matches.results.length > 0);
  assert.equal(new Set(matches.results.map((result) => result.docId)).size, matches.results.length);
  for (const result of matches.results) {
    assert.ok(Buffer.byteLength(result.snippet, "utf8") <= 1200);
    assert.equal(Object.hasOwn(result, "text"), false);
    assert.equal(Object.hasOwn(result, "contentSha256"), false);
    assert.equal(Object.hasOwn(result, "sourceContentSha256"), false);
    if (result.docId.startsWith("canonical:")) {
      assert.equal(result.taskFamily, "swiftui");
      assert.deepEqual(result.surfaces, ["design"]);
      assert.notEqual(result.classification, "examples");
    }
  }

  const explicit = await docs.searchReferenceFiles({
    query: "workflow design",
    scope: "active",
    surface: "design",
    taskFamily: "design-editing",
    maxResults: 10,
    maxSnippetLines: 4,
  });
  assert.ok(explicit.results.length > 0);
  assert.ok(explicit.results.every((result) => result.docId.startsWith("canonical:")));
  assert.ok(explicit.results.every((result) => result.taskFamily === "design-editing"));
  assert.ok(explicit.results.every((result) => result.surfaces.includes("design")));
});

test("Markdown search ranks labels and prose without indexing link destinations", async () => {
  const safetyPath = resolve(referenceRoot, "figma-workspace-safety.md");
  const sessionsPath = resolve(referenceRoot, "figma-workspace-sessions.md");
  const [originalSafety, originalSessions] = await Promise.all([
    readFile(safetyPath, "utf8"),
    readFile(sessionsPath, "utf8"),
  ]);
  const safetyFixture = (destination) => [
    "# Safety fixture",
    `rankingneedle [visible label](${destination})`,
    "[outer [inner]](canonical:nesteddestinationonlyneedle)",
    String.raw`[escaped \] label](canonical:escapeddestinationonlyneedle)`,
    "[balanced destination](canonical:path(nesteddestinationonlyneedle(inner)))",
    "[reference label][destinationonlyneedle]",
    "[destinationonlyneedle]: canonical:destinationonlyneedle",
    '<a href="canonical:destinationonlyneedle">HTML label</a>',
    "`inlinecodekeepneedle`",
    "```text",
    "fencedcodekeepneedle",
    ...Array.from({ length: 24 }, (_, index) => `fenced filler ${index}`),
    "[code label](canonical:crosschunkcodekeepneedle)",
    "```",
  ].join("\n");
  try {
    await Promise.all([
      writeFile(safetyPath, safetyFixture("canonical:neutral-destination"), "utf8"),
      writeFile(sessionsPath, "# Sessions fixture\nrankingneedle rankingneedle\n", "utf8"),
    ]);
    const baseline = await docs.searchReferenceFiles({
      query: "rankingneedle",
      files: ["figma-workspace-safety.md", "figma-workspace-sessions.md"],
      maxResults: 10,
      maxSnippetLines: 3,
    });

    await writeFile(
      safetyPath,
      safetyFixture(`canonical:inlinedestinationonlyneedle-${Array.from({ length: 20 }, () => "rankingneedle").join("-")}`),
      "utf8",
    );
    const pollutedDestination = await docs.searchReferenceFiles({
      query: "rankingneedle",
      files: ["figma-workspace-safety.md", "figma-workspace-sessions.md"],
      maxResults: 10,
      maxSnippetLines: 3,
    });
    assert.deepEqual(
      pollutedDestination.results.map((result) => result.docId),
      baseline.results.map((result) => result.docId),
    );
    assert.deepEqual(baseline.results.map((result) => result.docId), ["project:sessions", "project:safety"]);

    for (const query of [
      "destinationonlyneedle",
      "inlinedestinationonlyneedle",
      "nesteddestinationonlyneedle",
      "escapeddestinationonlyneedle",
    ]) {
      const destinationOnly = await docs.searchReferenceFiles({
        query,
        files: ["figma-workspace-safety.md"],
        maxResults: 10,
        maxSnippetLines: 3,
      });
      assert.deepEqual(destinationOnly.results, [], query);
    }
    for (const query of [
      "visible label",
      "outer inner",
      "escaped label",
      "balanced destination",
      "reference label",
      "HTML label",
      "inlinecodekeepneedle",
      "fencedcodekeepneedle",
      "crosschunkcodekeepneedle",
    ]) {
      const searchableContent = await docs.searchReferenceFiles({
        query,
        files: ["figma-workspace-safety.md"],
        maxResults: 10,
        maxSnippetLines: 3,
      });
      assert.deepEqual(searchableContent.results.map((result) => result.docId), ["project:safety"], query);
    }

    await Promise.all([
      writeFile(safetyPath, "# Safety fixture\ngenericboostalpha\n", "utf8"),
      writeFile(sessionsPath, "# Sessions fixture\ngenericboostbeta\n", "utf8"),
    ]);
    const genericDocsWithoutPreferredFamily = await docs.searchReferenceFiles({
      query: "genericboostalpha genericboostbeta",
      files: ["figma-workspace-safety.md", "figma-workspace-sessions.md"],
      maxResults: 10,
      maxSnippetLines: 3,
    });
    assert.equal(genericDocsWithoutPreferredFamily.results.length, 2);
    assert.ok(genericDocsWithoutPreferredFamily.results.every((result) => result.confidence === "low"));
  } finally {
    await Promise.all([
      writeFile(safetyPath, originalSafety, "utf8"),
      writeFile(sessionsPath, originalSessions, "utf8"),
    ]);
  }

  const linkedDoc = docs.readFigmaWorkspaceCanonicalDoc("canonical:figma-use-slides/SKILL.md");
  assert.match(linkedDoc.content, /\]\(canonical:figma-use-slides\/references\//u);
  const logicalPathOnly = await docs.searchReferenceFiles({
    query: "canonical:figma-use-slides",
    scope: "all",
    maxResults: 10,
    maxSnippetLines: 3,
  });
  assert.deepEqual(logicalPathOnly.results, []);
});

test("Plugin API lookup supports qualified aliases without blind unknown-owner exact matches", async () => {
  for (const [query, normalizedSymbol] of [
    ["createFrame", "createFrame"],
    ["figma.createFrame()", "createFrame"],
    ["PluginAPI.createFrame", "createFrame"],
    ["ComponentNode.createInstance", "createInstance"],
    ["figma.variables.createVariableCollection", "createVariableCollection"],
  ]) {
    const matches = await docs.searchReferenceFiles({
      query,
      corpus: "api",
      exactSymbol: true,
      maxResults: 5,
      maxSnippetLines: 8,
    });
    assert.equal(matches.normalizedSymbol, normalizedSymbol);
    const exact = matches.results.find((result) => result.matchType === "exact-symbol");
    assert.ok(exact, query);
    if (query.includes(".")) assert.equal(exact.ownerMatch, true, query);
    assert.ok(Buffer.byteLength(exact.snippet, "utf8") <= 1200);
  }

  for (const [query, expectedTitle] of [
    ["figma.createFrame()", "PluginAPI.createFrame"],
    ["PluginAPI.createFrame", "PluginAPI.createFrame"],
    ["ComponentNode.createInstance", "ComponentNode.createInstance"],
    ["figma.variables.createVariableCollection", "VariablesAPI.createVariableCollection"],
  ]) {
    const matches = await docs.searchReferenceFiles({
      query,
      corpus: "api",
      exactSymbol: true,
      maxResults: 5,
      maxSnippetLines: 5,
    });
    assert.deepEqual(matches.results.map((result) => result.title), [expectedTitle], query);
    assert.equal(matches.results[0].matchType, "exact-symbol", query);
    assert.equal(matches.results[0].ownerMatch, true, query);
  }

  const unknownOwner = await docs.searchReferenceFiles({
    query: "UnknownOwner.createFrame",
    corpus: "api",
    exactSymbol: true,
    maxResults: 5,
    maxSnippetLines: 5,
  });
  assert.equal(unknownOwner.normalizedSymbol, "createFrame");
  assert.equal(unknownOwner.results.some((result) => result.matchType === "exact-symbol"), false);

  const knownOwnerFallback = await docs.searchReferenceFiles({
    query: "SceneNode.clone",
    corpus: "api",
    exactSymbol: true,
    maxResults: 5,
    maxSnippetLines: 5,
  });
  const fallbackExact = knownOwnerFallback.results.find((result) => result.matchType === "exact-symbol");
  assert.ok(fallbackExact);
  assert.equal(fallbackExact.ownerMatch, false);
  assert.equal(fallbackExact.confidence, "medium");
  assert.ok(knownOwnerFallback.results
    .filter((result) => result.matchType === "exact-symbol")
    .every((result) => result.ownerMatch === false && result.confidence !== "high"));

  const caseMismatch = await docs.searchReferenceFiles({
    query: "CreateFrame",
    corpus: "api",
    exactSymbol: true,
    maxResults: 5,
    maxSnippetLines: 5,
  });
  assert.equal(caseMismatch.results.some((result) => result.matchType === "exact-symbol"), false);

  const memberAsOwner = await docs.searchReferenceFiles({
    query: "createFrame.createRectangle",
    corpus: "api",
    exactSymbol: true,
    maxResults: 5,
    maxSnippetLines: 5,
  });
  assert.equal(memberAsOwner.results.some((result) => result.matchType === "exact-symbol"), false);

  const missingDeclaration = await docs.searchReferenceFiles({
    query: "SceneNode.screenshot",
    corpus: "api",
    exactSymbol: true,
    maxResults: 5,
    maxSnippetLines: 5,
  });
  assert.equal(missingDeclaration.normalizedSymbol, "screenshot");
  assert.equal(missingDeclaration.results.some((result) => result.matchType === "exact-symbol"), false);
});

test("every guidance Plugin API lookup query resolves to a declaration", async () => {
  const queries = new Set(guidance.FIGMA_WORKSPACE_API_CARDS.flatMap((card) =>
    card.apiReferences.map((reference) => reference.lookupQuery)));
  assert.ok(queries.size > 0);
  for (const query of queries) {
    const matches = await docs.searchReferenceFiles({
      query,
      corpus: "api",
      exactSymbol: true,
      maxResults: 5,
      maxSnippetLines: 3,
    });
    assert.ok(matches.results.some((result) => result.matchType === "exact-symbol"), query);
  }
});
