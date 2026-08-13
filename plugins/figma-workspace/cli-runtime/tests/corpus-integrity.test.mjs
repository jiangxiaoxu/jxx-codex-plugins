import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { compileFigmaWorkspaceTypescriptSource } from "../dist/runtime/typescript-compiler-runtime.js";

const distRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../dist");

test("all canonical examples pass the production strict TypeScript preflight", async () => {
  const canonicalRoot = join(distRoot, "skills", "figma-workspace", "references", "canonical-corpus");
  const manifest = JSON.parse(await readFile(join(canonicalRoot, "manifest.json"), "utf8"));
  const records = (await readFile(join(canonicalRoot, manifest.corpus.file), "utf8"))
    .trimEnd()
    .split(/\r?\n/u)
    .map((line) => JSON.parse(line));
  const examples = records.filter((record) => record.classification === "examples");
  assert.equal(examples.length, 9);

  for (const example of examples) {
    const fence = /```(?:ts|typescript)\s*\r?\n([\s\S]*?)\r?\n```/u.exec(example.text);
    assert.ok(fence, `${example.id} must contain a TypeScript fence`);
    const compiled = compileFigmaWorkspaceTypescriptSource(
      example.id.replace(/\.md$/u, ".figma.ts"),
      fence[1],
      true,
    );
    const fatal = compiled.diagnostics.filter((diagnostic) => diagnostic.severity === "fatal");
    assert.deepEqual(fatal, [], `${example.id}: ${fatal.map((diagnostic) => diagnostic.message).join("; ")}`);
  }
});

test("canonical agent docs publish only current runtime capabilities", async () => {
  const canonicalRoot = join(distRoot, "skills", "figma-workspace", "references", "canonical-corpus");
  const manifest = JSON.parse(await readFile(join(canonicalRoot, "manifest.json"), "utf8"));
  const corpus = await readFile(join(canonicalRoot, manifest.corpus.file), "utf8");
  assert.doesNotMatch(corpus, /\$\.screenshot|(?:node|frame)\.screenshot|SceneNode\.screenshot/u);
  assert.doesNotMatch(corpus, /Both APIs are available in `\.figma\.ts`/u);
  assert.doesNotMatch(corpus, /`getPluginData\(\)`\s*\/\s*`setPluginData\(\)`[^\n]{0,160}store values private to the executing plugin/iu);
  assert.doesNotMatch(corpus, /(?:do not|never) use[^\n]{0,120}(?:figma\.)?createImage/iu);
  assert.doesNotMatch(corpus, /never (?:scan|search)[^\n]{0,120}figma\.root/iu);
  assert.doesNotMatch(corpus, /(?:do not|never)[^\n]{0,120}switch[^\n]{0,80}page[^\n]{0,80}(?:more than once|multiple times)/iu);
  assert.doesNotMatch(corpus, /at most \d+ logical operations per/iu);
  assert.doesNotMatch(corpus, /id\/handle|\$handle|handle alias/iu);
  assert.match(corpus, /figma:capture/u);
  assert.match(corpus, /exportAsync/u);
  assert.match(corpus, /live host contract explicitly prohibits `setPluginData`; a direct host run separately rejected `getPluginData`/u);
  assert.match(corpus, /do not depend on shared PluginData as a required or assumed-supported recovery mechanism/u);
  assert.match(corpus, /one narrow transaction per selected page/u);
  assert.match(corpus, /Read-only transactions may fan out/u);
  assert.match(corpus, /runtime does not impose an operation-count policy/u);
  assert.match(corpus, /figma\.root\.findAll[^\n]{0,160}valid document-wide operations/u);
  assert.match(corpus, /`figma\.createImage\(data\)` remains the native byte-input API/u);
});

test("canonical runnable workflow snippets pass the production strict TypeScript preflight", async () => {
  const canonicalRoot = join(distRoot, "skills", "figma-workspace", "references", "canonical-corpus");
  const manifest = JSON.parse(await readFile(join(canonicalRoot, "manifest.json"), "utf8"));
  const records = new Map((await readFile(join(canonicalRoot, manifest.corpus.file), "utf8"))
    .trimEnd()
    .split(/\r?\n/u)
    .map((line) => JSON.parse(line))
    .map((record) => [record.id, record]));
  const runnableIds = [
    "figma-generate-design/references/componentization.md",
    "figma-use-figjam/references/batch-modify.md",
    "figma-use-figjam/references/create-label.md",
    "figma-use-figjam/references/create-section.md",
    "figma-use-figjam/references/create-sticky.md",
    "figma-use-figjam/references/create-table.md",
    "figma-use-figjam/references/figjam-colors.md",
    "figma-use-figjam/references/position-figjam-nodes.md",
    "figma-use-slides/references/slide-design.md",
    "figma-use/references/working-with-design-systems/wwds-components--creating.md",
  ];

  for (const id of runnableIds) {
    const record = records.get(id);
    assert.ok(record, `Missing canonical record: ${id}`);
    const fences = [...record.text.matchAll(/```(?:ts|typescript)\s*\r?\n([\s\S]*?)\r?\n```/gu)];
    assert.ok(fences.length > 0, `${id} must contain a TypeScript fence`);
    for (const [index, fence] of fences.entries()) {
      const compiled = compileFigmaWorkspaceTypescriptSource(`${id}#${index + 1}.figma.ts`, fence[1], true);
      const fatal = compiled.diagnostics.filter((diagnostic) => diagnostic.severity === "fatal");
      assert.deepEqual(fatal, [], `${id}#${index + 1}: ${fatal.map((diagnostic) => diagnostic.message).join("; ")}`);
    }
  }
});

test("runtime docs and API lookup succeed without any upstream raw snapshot", async () => {
  await withCopiedRuntime(async (fixture) => {
    const distFiles = (await readdir(fixture.dist, { recursive: true })).map(normalizePath);
    assert.equal(distFiles.some((file) => file.includes("upstream-corpus") || file.includes("upstream-active")), false);

    const poisonedRaw = join(fixture.root, "plugins", "figma-workspace", "dev", "upstream-snapshot");
    await mkdir(poisonedRaw, { recursive: true });
    await writeFile(join(poisonedRaw, "manifest.json"), "not json\n", "utf8");

    const docs = runLookup(fixture.root, { kind: "docs", query: "loadFontAsync", maxResults: 3 });
    assert.equal(docs.status, 0, docs.stderr);
    assert.match(docs.stdout, /^Status: succeeded$/mu);
    assert.match(docs.stdout, /loadFontAsync/u);

    const api = runLookup(fixture.root, { kind: "api", symbol: "createFrame", maxResults: 3 });
    assert.equal(api.status, 0, api.stderr);
    assert.match(api.stdout, /^Status: succeeded$/mu);
    assert.match(api.stdout, /@figma\/plugin-typings|createFrame/u);

    const doctor = runDoctor(fixture.root);
    assert.equal(doctor.status, 0, doctor.stderr);
    assert.match(doctor.stdout, /^Status: succeeded$/mu);
    assert.doesNotMatch(doctor.stdout, /pending|retired|raw snapshot/iu);
  });
});

test("examples scope returns only canonical Markdown templates", async () => {
  await withCopiedRuntime(async (fixture) => {
    const lookup = runLookup(fixture.root, {
      kind: "docs",
      scope: "examples",
      query: "external ledger exact ids",
      maxResults: 1,
      maxSnippetLines: 3,
    });
    assert.equal(lookup.status, 0, lookup.stderr);
    assert.match(lookup.stdout, /^Status: succeeded$/mu);
    assert.match(lookup.stdout, /figma-generate-library\/examples\/rehydrate-state/u);
    assert.doesNotMatch(lookup.stdout, /internal:figma-generate-library\/scripts\/cleanupOrphans\.js/u);
  });
});

test("runtime accepts CRLF canonical corpus and generated API index", async () => {
  await withCopiedRuntime(async (fixture) => {
    await writeFile(fixture.canonicalCorpusFile, fixture.canonicalCorpusText.replace(/\n/gu, "\r\n"), "utf8");
    await writeFile(fixture.apiIndexFile, fixture.apiIndexText.replace(/\n/gu, "\r\n"), "utf8");
    const result = runDoctor(fixture.root);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /^Status: succeeded$/mu);
  });
});

test("doctor reports canonical corpus integrity failures", async () => {
  await withCopiedRuntime(async (fixture) => {
    await writeFile(fixture.canonicalCorpusFile, `${fixture.canonicalCorpusText} `, "utf8");
    const result = runDoctor(fixture.root);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /^Status: observed unhealthy$/mu);
    assert.match(result.stdout, /Canonical Figma corpus SHA-256/u);
  });
});

test("doctor rejects route catalog top-level schema drift even when hashes match", async () => {
  await withCopiedRuntime(async (fixture) => {
    const routeFile = join(fixture.canonicalDir, fixture.canonicalManifest.routeCatalog.file);
    const routeCatalog = JSON.parse(await readFile(routeFile, "utf8"));
    routeCatalog.unexpected = true;
    const routeText = `${JSON.stringify(routeCatalog, null, 2)}\n`;
    fixture.canonicalManifest.routeCatalog.sha256 = sha256(routeText);
    await writeFile(routeFile, routeText, "utf8");
    await writeFile(fixture.canonicalManifestFile, `${JSON.stringify(fixture.canonicalManifest, null, 2)}\n`, "utf8");

    const result = runDoctor(fixture.root);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /^Status: observed unhealthy$/mu);
    assert.match(result.stdout, /route catalog must contain exactly/u);
  });
});

test("doctor reports generated API index integrity failures", async () => {
  await withCopiedRuntime(async (fixture) => {
    const records = parseRecords(fixture.apiIndexText);
    records[0].text += "tampered";
    const indexText = `${records.map((record) => JSON.stringify(record)).join("\n")}\n`;
    const indexHash = sha256(indexText);
    fixture.apiManifest.index.file = `index-${indexHash}.jsonl`;
    fixture.apiManifest.index.sha256 = indexHash;
    const changedIndexFile = join(fixture.apiIndexDir, fixture.apiManifest.index.file);
    await writeFile(changedIndexFile, indexText, "utf8");
    await writeFile(fixture.apiManifestFile, `${JSON.stringify(fixture.apiManifest, null, 2)}\n`, "utf8");

    const result = runDoctor(fixture.root);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /^Status: observed unhealthy$/mu);
    assert.match(result.stdout, /API index record SHA-256 mismatch/u);

    const searchFailure = runLookup(fixture.root, { kind: "api", symbol: "createFrame" });
    assert.equal(searchFailure.status, 1, searchFailure.stderr);
    assert.match(searchFailure.stdout, /"mode": "search"/u);
    assert.match(searchFailure.stdout, /"results": \[\]/u);

    const readFailure = runLookup(fixture.root, { kind: "api", apiId: `api:${records[0].id}` });
    assert.equal(readFailure.status, 1, readFailure.stderr);
    assert.match(readFailure.stdout, /"mode": "read"/u);
    assert.doesNotMatch(readFailure.stdout, /"results"/u);
  });
});

async function withCopiedRuntime(run) {
  const root = await mkdtemp(join(tmpdir(), "figma-canonical-runtime-"));
  try {
    const dist = join(root, "dist");
    await cp(distRoot, dist, { recursive: true });

    const canonicalDir = join(dist, "skills", "figma-workspace", "references", "canonical-corpus");
    const canonicalManifestFile = join(canonicalDir, "manifest.json");
    const canonicalManifest = JSON.parse(await readFile(canonicalManifestFile, "utf8"));
    const canonicalCorpusFile = join(canonicalDir, canonicalManifest.corpus.file);
    const canonicalCorpusText = normalizeLineEndings(await readFile(canonicalCorpusFile, "utf8"));

    const apiIndexDir = join(dist, "runtime", "figma-plugin-api-index");
    const apiManifestFile = join(apiIndexDir, "manifest.json");
    const apiManifest = JSON.parse(await readFile(apiManifestFile, "utf8"));
    const apiIndexFile = join(apiIndexDir, apiManifest.index.file);
    const apiIndexText = normalizeLineEndings(await readFile(apiIndexFile, "utf8"));

    await run({
      root,
      dist,
      canonicalDir,
      canonicalManifest,
      canonicalManifestFile,
      canonicalCorpusFile,
      canonicalCorpusText,
      apiIndexDir,
      apiManifest,
      apiManifestFile,
      apiIndexFile,
      apiIndexText,
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

function runDoctor(root) {
  return runCliCommand(root, "doctor", {});
}

function runLookup(root, input) {
  return runCliCommand(root, "lookup", input);
}

function runCliCommand(root, command, input) {
  return spawnSync(process.execPath, [
    join(root, "dist", "cli", "figma-workspace-cli.js"),
    command,
    "--input",
    "-",
  ], {
    cwd: root,
    input: JSON.stringify(input),
    encoding: "utf8",
    windowsHide: true,
  });
}

function parseRecords(corpusText) {
  return corpusText.trimEnd().split("\n").map((line) => JSON.parse(line));
}

function normalizeLineEndings(value) {
  return value.replace(/\r\n/gu, "\n");
}

function normalizePath(value) {
  return value.replaceAll("\\", "/");
}

function sha256(value) {
  return createHash("sha256").update(value, "utf8").digest("hex");
}
