import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";

const distRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../dist");

test("runtime accepts CRLF corpus checkout after normalized integrity validation", async () => {
  await withCopiedRuntime(async (fixture) => {
    await writeFile(fixture.corpusFile, fixture.corpusText.replace(/\n/gu, "\r\n"), "utf8");
    const result = runDoctor(fixture.root);

    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /^Status: succeeded$/mu);
    assert.doesNotMatch(result.stdout, /SHA-256|record count|skill inventory/u);
  });
});

test("runtime accepts CRLF derived active corpus checkout", async () => {
  await withCopiedRuntime(async (fixture) => {
    await writeFile(fixture.activeCorpusFile, fixture.activeCorpusText.replace(/\n/gu, "\r\n"), "utf8");
    const result = runDoctor(fixture.root);

    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /^Status: succeeded$/mu);
    assert.doesNotMatch(result.stdout, /active corpus SHA-256|active content integrity/u);
  });
});

test("runtime rejects whole-corpus integrity mismatch", async () => {
  await withCopiedRuntime(async (fixture) => {
    await writeFile(fixture.corpusFile, `${fixture.corpusText} `, "utf8");
    assertDoctorFailure(fixture.root, /corpus SHA-256 does not match/u);
  });
});

test("runtime rejects derived active whole-corpus integrity mismatch", async () => {
  await withCopiedRuntime(async (fixture) => {
    await writeFile(fixture.activeCorpusFile, `${fixture.activeCorpusText} `, "utf8");
    assertDoctorFailure(fixture.root, /active corpus SHA-256 does not match/u);
  });
});

test("runtime rejects derived record integrity mismatch after whole-corpus hash passes", async () => {
  await withCopiedRuntime(async (fixture) => {
    const records = parseRecords(fixture.activeCorpusText);
    records[0].text += "tampered";
    await writeActiveCorpusAndManifest(fixture, records);
    assertDoctorFailure(fixture.root, /active content integrity mismatch/u);
  });
});

test("runtime rejects active index with a mismatched raw parent", async () => {
  await withCopiedRuntime(async (fixture) => {
    fixture.activeManifest.parent.resolvedCommit = "0".repeat(40);
    await writeFile(
      fixture.activeManifestFile,
      `${JSON.stringify(fixture.activeManifest, null, 2)}\n`,
      "utf8",
    );
    assertDoctorFailure(fixture.root, /active index parent does not match/u);
  });
});

test("API drift remains pending and cannot enter api search", async () => {
  await withCopiedRuntime(async (fixture) => {
    const apiId = "figma-use/references/plugin-api-standalone.d.ts";
    const records = parseRecords(fixture.corpusText);
    const apiRecord = records.find((record) => record.id === apiId);
    assert.ok(apiRecord);
    const previousHash = apiRecord.contentSha256;
    apiRecord.text += "\ninterface PendingOnlyApiSymbol {}\n";
    apiRecord.contentSha256 = sha256(apiRecord.text);
    fixture.manifest.integrity.contentHashes[apiId] = apiRecord.contentSha256;
    fixture.manifest.upstream.resolvedCommit = "b".repeat(40);
    await writeRawContentAddressedCorpusAndManifest(fixture, records);

    fixture.activeManifest.parent.resolvedCommit = fixture.manifest.upstream.resolvedCommit;
    fixture.activeManifest.parent.corpus = {
      file: fixture.manifest.corpus.file,
      recordCount: fixture.manifest.corpus.recordCount,
      sha256: fixture.manifest.corpus.sha256,
    };
    delete fixture.activeManifest.integrity.sourceContentHashes[apiId];
    fixture.activeManifest.pendingCount = 1;
    fixture.activeManifest.pendingRecords = [{
      id: apiId,
      skill: "figma-use",
      classification: "api",
      state: "pending",
      drift: "changed",
      sourceContentSha256: apiRecord.contentSha256,
      policySourceContentSha256: previousHash,
    }];
    await writeFile(
      fixture.activeManifestFile,
      `${JSON.stringify(fixture.activeManifest, null, 2)}\n`,
      "utf8",
    );

    const lookup = runLookup(fixture.root, {
      kind: "api",
      symbol: "PendingOnlyApiSymbol",
      maxResults: 5,
      maxSnippetLines: 5,
    });
    assert.equal(lookup.status, 0, lookup.stderr);
    assert.match(lookup.stdout, /^Status: succeeded$/mu);
    assert.match(lookup.stdout, /## Results\s+- none/iu);

    const doctor = runDoctor(fixture.root);
    assert.match(doctor.stdout, /^Status: observed unhealthy$/mu);
    assert.match(doctor.stdout, /Pending Count:\s+1/iu);
  });
});

test("runtime rejects record integrity mismatch after whole-corpus hash passes", async () => {
  await withCopiedRuntime(async (fixture) => {
    const records = parseRecords(fixture.corpusText);
    records[0].text += "tampered";
    await writeCorpusAndManifest(fixture, records);
    assertDoctorFailure(fixture.root, /record SHA-256 mismatch/u);
  });
});

test("runtime rejects duplicate records", async () => {
  await withCopiedRuntime(async (fixture) => {
    const records = parseRecords(fixture.corpusText);
    records.push(records[0]);
    fixture.manifest.corpus.recordCount += 1;
    await writeCorpusAndManifest(fixture, records);
    assertDoctorFailure(fixture.root, /Duplicate internal Figma upstream corpus record/u);
  });
});

test("runtime rejects manifest record-count and skill-inventory drift", async () => {
  await withCopiedRuntime(async (fixture) => {
    fixture.manifest.corpus.recordCount += 1;
    await writeFile(fixture.manifestFile, `${JSON.stringify(fixture.manifest, null, 2)}\n`, "utf8");
    assertDoctorFailure(fixture.root, /record count does not match/u);
  });

  await withCopiedRuntime(async (fixture) => {
    fixture.manifest.includedSkills = fixture.manifest.includedSkills.slice(1);
    await writeFile(fixture.manifestFile, `${JSON.stringify(fixture.manifest, null, 2)}\n`, "utf8");
    assertDoctorFailure(fixture.root, /skill inventory does not match/u);
  });
});

async function withCopiedRuntime(run) {
  const root = await mkdtemp(join(tmpdir(), "figma-corpus-integrity-"));
  try {
    const copiedDist = join(root, "dist");
    await cp(distRoot, copiedDist, { recursive: true });
    const corpusDir = join(copiedDist, "skills", "figma-workspace", "references", "upstream-corpus");
    const manifestFile = join(corpusDir, "manifest.json");
    const manifest = JSON.parse(await readFile(manifestFile, "utf8"));
    const corpusFile = join(corpusDir, manifest.corpus.file);
    const corpusText = (await readFile(corpusFile, "utf8")).replace(/\r\n/gu, "\n");
    const activeDir = join(copiedDist, "skills", "figma-workspace", "references", "upstream-active");
    const activeManifestFile = join(activeDir, "manifest.json");
    const activeManifest = JSON.parse(await readFile(activeManifestFile, "utf8"));
    const activeCorpusFile = join(activeDir, activeManifest.corpus.file);
    const activeCorpusText = (await readFile(activeCorpusFile, "utf8")).replace(/\r\n/gu, "\n");
    await run({
      root,
      manifest,
      manifestFile,
      corpusFile,
      corpusText,
      activeDir,
      activeManifest,
      activeManifestFile,
      activeCorpusFile,
      activeCorpusText,
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function writeActiveCorpusAndManifest(fixture, records) {
  const corpusText = `${records.map((record) => JSON.stringify(record)).join("\n")}\n`;
  const corpusHash = sha256(corpusText);
  fixture.activeManifest.corpus.file = `corpus-${corpusHash}.jsonl`;
  fixture.activeManifest.corpus.sha256 = corpusHash;
  fixture.activeCorpusFile = join(fixture.activeDir, fixture.activeManifest.corpus.file);
  await writeFile(fixture.activeCorpusFile, corpusText, "utf8");
  await writeFile(
    fixture.activeManifestFile,
    `${JSON.stringify(fixture.activeManifest, null, 2)}\n`,
    "utf8",
  );
}

async function writeCorpusAndManifest(fixture, records) {
  const corpusText = `${records.map((record) => JSON.stringify(record)).join("\n")}\n`;
  const corpusHash = sha256(corpusText);
  fixture.manifest.corpus.file = `corpus-${corpusHash}.jsonl`;
  fixture.manifest.corpus.sha256 = corpusHash;
  fixture.corpusFile = join(dirname(fixture.manifestFile), fixture.manifest.corpus.file);
  await writeFile(fixture.corpusFile, corpusText, "utf8");
  await writeFile(fixture.manifestFile, `${JSON.stringify(fixture.manifest, null, 2)}\n`, "utf8");
}

async function writeRawContentAddressedCorpusAndManifest(fixture, records) {
  const corpusText = `${records.map((record) => JSON.stringify(record)).join("\n")}\n`;
  const corpusHash = sha256(corpusText);
  fixture.manifest.corpus.file = `corpus-${corpusHash}.jsonl`;
  fixture.manifest.corpus.sha256 = corpusHash;
  fixture.corpusFile = join(dirname(fixture.manifestFile), fixture.manifest.corpus.file);
  await writeFile(fixture.corpusFile, corpusText, "utf8");
  await writeFile(fixture.manifestFile, `${JSON.stringify(fixture.manifest, null, 2)}\n`, "utf8");
}

function parseRecords(corpusText) {
  return corpusText.trimEnd().split("\n").map((line) => JSON.parse(line));
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
    "--session-file",
    join(root, "state.json"),
    "--inline-result-limit",
    "10000",
  ], {
    cwd: root,
    input: JSON.stringify(input),
    encoding: "utf8",
    windowsHide: true,
  });
}

function assertDoctorFailure(root, expected) {
  const result = runDoctor(root);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /^Status: observed unhealthy$/mu);
  assert.match(result.stdout, expected);
}

function sha256(value) {
  return createHash("sha256").update(value, "utf8").digest("hex");
}
