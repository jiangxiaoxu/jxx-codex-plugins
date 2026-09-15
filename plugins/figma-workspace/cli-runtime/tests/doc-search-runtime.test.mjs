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

test("Plugin API index reads qualified selectors without exposing index implementation details", async () => {
  const matches = await docs.searchReferenceFiles({
    query: "ShapeWithTextNode.shapeType",
    corpus: "api",
    exactSymbol: true,
    maxResults: 5,
    maxSnippetLines: 5,
  });
  assert.deepEqual(matches.results.map((result) => result.selector), ["ShapeWithTextNode.shapeType"]);
  const [declaration] = docs.readFigmaWorkspacePluginApiDeclarations("ShapeWithTextNode.shapeType");
  assert.equal(declaration.selector, "ShapeWithTextNode.shapeType");
  assert.equal(declaration.kind, "api");
  assert.match(declaration.content, /shapeType:/u);
  assert.match(declaration.content, /'INTERNAL_STORAGE'/u);
  assert.doesNotMatch(declaration.content, /readonly text: TextSublayerNode/u);
  assert.equal(declaration.source.package, "@figma/plugin-typings");
  assert.equal(typeof declaration.source.version, "string");
  for (const value of [...matches.results, declaration, declaration.source]) {
    assert.equal(Object.hasOwn(value, "apiId"), false);
    assert.equal(Object.hasOwn(value, "ownerHint"), false);
    assert.equal(Object.hasOwn(value, "ownerMatch"), false);
    assert.equal(Object.hasOwn(value, "ownerSymbol"), false);
    assert.equal(Object.hasOwn(value, "qualifiedAliases"), false);
    assert.equal(Object.hasOwn(value, "contentSha256"), false);
    assert.equal(Object.hasOwn(value, "file"), false);
    assert.equal(Object.hasOwn(value, "declarationLine"), false);
    assert.equal(Object.hasOwn(value, "lineStart"), false);
    assert.equal(Object.hasOwn(value, "lineEnd"), false);
  }

  for (const invalidSelector of [
    "api:@figma/plugin-typings/plugin-api.d.ts:1:createFrame",
    "../plugin-api.d.ts",
    "figma.createFrame(value)",
  ]) {
    assert.throws(
      () => docs.readFigmaWorkspacePluginApiDeclarations(invalidSelector),
      (error) => error?.code === "FIGMA_WORKSPACE_API_SELECTOR_INVALID",
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
  assert.ok(
    matches.results.reduce((total, result) => total + Buffer.byteLength(result.snippet, "utf8"), 0) <= 12_000,
  );
  for (const result of matches.results) {
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
  const artifactsPath = resolve(referenceRoot, "figma-workspace-artifacts.md");
  const [originalSafety, originalArtifacts] = await Promise.all([
    readFile(safetyPath, "utf8"),
    readFile(artifactsPath, "utf8"),
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
      writeFile(artifactsPath, "# Local artifacts fixture\nrankingneedle rankingneedle\n", "utf8"),
    ]);
    const baseline = await docs.searchReferenceFiles({
      query: "rankingneedle",
      files: ["figma-workspace-safety.md", "figma-workspace-artifacts.md"],
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
      files: ["figma-workspace-safety.md", "figma-workspace-artifacts.md"],
      maxResults: 10,
      maxSnippetLines: 3,
    });
    assert.deepEqual(
      pollutedDestination.results.map((result) => result.docId),
      baseline.results.map((result) => result.docId),
    );
    assert.deepEqual(baseline.results.map((result) => result.docId), ["project:artifacts", "project:safety"]);

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
      writeFile(artifactsPath, "# Local artifacts fixture\ngenericboostbeta\n", "utf8"),
    ]);
    const genericDocsWithoutPreferredFamily = await docs.searchReferenceFiles({
      query: "genericboostalpha genericboostbeta",
      files: ["figma-workspace-safety.md", "figma-workspace-artifacts.md"],
      maxResults: 10,
      maxSnippetLines: 3,
    });
    assert.equal(genericDocsWithoutPreferredFamily.results.length, 2);
    assert.ok(genericDocsWithoutPreferredFamily.results.every((result) => result.confidence === "low"));
  } finally {
    await Promise.all([
      writeFile(safetyPath, originalSafety, "utf8"),
      writeFile(artifactsPath, originalArtifacts, "utf8"),
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

test("Plugin API lookup exposes readable selectors and resolves aliases, ambiguity, and overloads", async () => {
  for (const [query, expectedSelector] of [
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
    assert.deepEqual(matches.results.map((result) => result.selector), [expectedSelector], query);
    assert.equal(matches.results[0].matchType, "exact-symbol", query);
  }

  const ambiguous = await docs.searchReferenceFiles({
    query: "fontName",
    corpus: "api",
    exactSymbol: true,
    maxResults: 10,
    maxSnippetLines: 5,
  });
  assert.deepEqual(
    [...new Set(ambiguous.results.map((result) => result.selector))].sort(),
    [
      "BaseNonResizableTextMixin.fontName",
      "Font.fontName",
      "StyledTextSegment.fontName",
      "TextStyle.fontName",
    ].sort(),
  );
  assert.equal(new Set(ambiguous.results.map((result) => result.selector)).size, ambiguous.results.length);
  for (const result of ambiguous.results) {
    assert.equal(typeof result.selector, "string");
    assert.match(result.selector, /\.fontName$/u);
    assert.equal(typeof result.declarationKind, "string");
    assert.equal(Object.hasOwn(result, "lineStart"), false);
    assert.equal(Object.hasOwn(result, "lineEnd"), false);
    assert.equal(Object.hasOwn(result, "title"), false);
    assert.equal(Object.hasOwn(result, "classification"), false);
  }

  const overloads = docs.readFigmaWorkspacePluginApiDeclarations("PluginAPI.on()");
  assert.ok(overloads.length > 1);
  assert.ok(overloads.every((declaration) => declaration.selector === "PluginAPI.on"));

  assert.throws(
    () => docs.readFigmaWorkspacePluginApiDeclarations("fontName"),
    (error) => error?.code === "FIGMA_WORKSPACE_API_SELECTOR_AMBIGUOUS"
      && error.candidates?.includes("BaseNonResizableTextMixin.fontName")
      && error.candidates?.every((candidate) => !candidate.includes(":")),
  );
  assert.throws(
    () => docs.readFigmaWorkspacePluginApiDeclarations("UnknownOwner.createFrame"),
    (error) => error?.code === "FIGMA_WORKSPACE_API_SELECTOR_NOT_FOUND",
  );
  await assert.rejects(
    docs.searchReferenceFiles({
      query: "UnknownOwner.createFrame",
      corpus: "api",
      exactSymbol: true,
      maxResults: 5,
      maxSnippetLines: 5,
    }),
    (error) => error?.code === "FIGMA_WORKSPACE_API_SELECTOR_NOT_FOUND",
  );
});

test("search applies one 12 KB UTF-8 snippet budget without a per-result byte cap", async () => {
  const safetyPath = resolve(referenceRoot, "figma-workspace-safety.md");
  const artifactsPath = resolve(referenceRoot, "figma-workspace-artifacts.md");
  const [originalSafety, originalArtifacts] = await Promise.all([
    readFile(safetyPath, "utf8"),
    readFile(artifactsPath, "utf8"),
  ]);
  try {
    await Promise.all([
      writeFile(safetyPath, `# Safety budget fixture\nbudgetneedle ${"仙".repeat(2_500)}\n`, "utf8"),
      writeFile(artifactsPath, `# Artifacts budget fixture\nbudgetneedle ${"侠".repeat(2_500)}\n`, "utf8"),
    ]);
    const matches = await docs.searchReferenceFiles({
      query: "budgetneedle",
      files: ["figma-workspace-safety.md", "figma-workspace-artifacts.md"],
      maxResults: 10,
      maxSnippetLines: 16,
    });
    assert.equal(matches.results.length, 2);
    const resultBytes = matches.results.map((result) => Buffer.byteLength(result.snippet, "utf8"));
    const returnedBytes = resultBytes.reduce((total, bytes) => total + bytes, 0);
    assert.ok(resultBytes[0] > 1_200);
    assert.ok(resultBytes[1] > 1_200);
    assert.ok(returnedBytes <= 12_000);
    assert.equal(matches.results[0].snippetTruncated, undefined);
    assert.equal(matches.results[1].snippetTruncated, true);
    assert.equal(matches.snippetBudget.limitBytes, 12_000);
    assert.ok(matches.snippetBudget.originalBytes > 12_000);
    assert.equal(matches.snippetBudget.returnedBytes, returnedBytes);
    assert.equal(matches.snippetBudget.selectedResultCount, 2);
    assert.equal(matches.snippetBudget.returnedResultCount, 2);
    assert.equal(matches.snippetBudget.truncated, true);
  } finally {
    await Promise.all([
      writeFile(safetyPath, originalSafety, "utf8"),
      writeFile(artifactsPath, originalArtifacts, "utf8"),
    ]);
  }
});

test("guidance Plugin API lookup queries keep search and read selector resolution consistent", async () => {
  const queries = new Set(guidance.FIGMA_WORKSPACE_API_CARDS.flatMap((card) =>
    card.apiReferences.map((reference) => reference.lookupQuery)));
  assert.ok(queries.size > 0);
  for (const query of queries) {
    const options = {
      query,
      corpus: "api",
      exactSymbol: true,
      maxResults: 5,
      maxSnippetLines: 3,
    };
    let matches;
    try {
      matches = await docs.searchReferenceFiles(options);
    } catch (error) {
      assert.equal(error?.code, "FIGMA_WORKSPACE_API_SELECTOR_NOT_FOUND", query);
      assert.throws(
        () => docs.readFigmaWorkspacePluginApiDeclarations(query),
        (readError) => readError?.code === "FIGMA_WORKSPACE_API_SELECTOR_NOT_FOUND",
        query,
      );
      continue;
    }
    const declarations = docs.readFigmaWorkspacePluginApiDeclarations(query);
    assert.ok(declarations.length > 0, query);
    assert.ok(
      matches.results.some((result) => result.selector === declarations[0].selector),
      query,
    );
  }
});
