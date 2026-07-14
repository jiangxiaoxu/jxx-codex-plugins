import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { buildUpstreamActive } from "../scripts/lib/upstream-active.mjs";

const generatedAt = "2026-07-14T04:05:06.000Z";

test("builder publishes ready non-API records with classification and integrity counts", async () => {
  const fixture = await createFixture();
  try {
    const result = await buildFixture(fixture);
    const manifest = JSON.parse(await readFile(join(fixture.activeRoot, "manifest.json"), "utf8"));
    const corpusText = await readFile(join(fixture.activeRoot, manifest.corpus.file), "utf8");
    const records = parseJsonl(corpusText);

    assert.deepEqual(result.manifest, manifest);
    assert.deepEqual(records.map((record) => record.id), [
      "alpha/SKILL.md",
      "alpha/references/guide.md",
      "alpha/scripts/example.js",
    ]);
    assert.deepEqual(manifest.classificationCounts, {
      active: 1,
      conditional: 0,
      router: 1,
      examples: 1,
      api: 1,
    });
    assert.equal(manifest.queryableRecordCount, 3);
    assert.equal(manifest.pendingCount, 0);
    assert.equal(manifest.retiredCount, 0);
    assert.deepEqual(manifest.pendingRecords, []);
    assert.deepEqual(manifest.retiredRecords, []);
    assert.equal(manifest.parent.repository, "https://example.invalid/figma.git");
    assert.equal(manifest.parent.resolvedCommit, "a".repeat(40));
    assert.equal(manifest.corpus.sha256, sha256(corpusText));
    assert.equal(manifest.corpus.file, `corpus-${sha256(corpusText)}.jsonl`);

    const guide = records.find((record) => record.id.endsWith("guide.md"));
    assert.equal(guide.text, "# Safe guide\n");
    assert.equal(guide.sanitized, true);
    assert.equal(guide.nonExecutable, false);
    assert.equal(guide.derivedContentSha256, sha256(guide.text));
    assert.equal(manifest.integrity.derivedContentHashes[guide.id], sha256(guide.text));
    const example = records.find((record) => record.id.endsWith("example.js"));
    assert.equal(example.text, "export const example = 1;\n");
    assert.equal(example.sanitized, false);
    assert.equal(example.nonExecutable, true);
    assert.equal(manifest.integrity.sourceContentHashes[example.id], example.sourceContentSha256);
    assert.equal(records.some((record) => record.classification === "api"), false);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("new, changed, and deleted snapshot drift is non-fatal and excluded from queryable corpus", async () => {
  const fixture = await createFixture();
  try {
    fixture.rawRecords = fixture.rawRecords
      .filter((record) => record.id !== "alpha/scripts/example.js")
      .map((record) => record.id === "alpha/references/guide.md"
        ? rawRecord(record.id, "# Changed upstream\n", "markdown")
        : record);
    fixture.rawRecords.push(
      rawRecord("alpha/references/new.md", "# New\n", "markdown"),
      rawRecord("alpha/scripts/new.js", "export {};\n", "javascript"),
      rawRecord("alpha/references/new.d.ts", "export {};\n", "typescript"),
    );
    await writeRawCorpus(fixture.rawRoot, fixture.rawRecords);

    const { manifest, records } = await buildFixture(fixture);
    assert.deepEqual(records.map((record) => record.id), ["alpha/SKILL.md"]);
    assert.equal(manifest.queryableRecordCount, 1);
    assert.equal(manifest.pendingCount, 4);
    assert.equal(manifest.retiredCount, 1);
    assert.deepEqual(manifest.classificationCounts, {
      active: 1,
      conditional: 1,
      router: 1,
      examples: 2,
      api: 2,
    });
    assert.deepEqual(
      manifest.pendingRecords.map(({ id, classification, drift }) => ({ id, classification, drift })),
      [
        { id: "alpha/references/guide.md", classification: "active", drift: "changed" },
        { id: "alpha/references/new.d.ts", classification: "api", drift: "new" },
        { id: "alpha/references/new.md", classification: "conditional", drift: "new" },
        { id: "alpha/scripts/new.js", classification: "examples", drift: "new" },
      ],
    );
    assert.deepEqual(
      manifest.retiredRecords.map(({ id, classification, state }) => ({ id, classification, state })),
      [{ id: "alpha/scripts/example.js", classification: "examples", state: "retired" }],
    );
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("policy, source hash, mirror, and UTF-8 errors fail closed", async (t) => {
  await t.test("unknown classification", async () => {
    const fixture = await createFixture();
    try {
      fixture.policyRecords[0].classification = "unknown";
      await writePolicy(fixture);
      await assert.rejects(buildFixture(fixture), /exactly|Unknown policy classification/u);
      await assert.rejects(readFile(join(fixture.activeRoot, "manifest.json")), { code: "ENOENT" });
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  });

  await t.test("duplicate record", async () => {
    const fixture = await createFixture();
    try {
      fixture.policyRecords.push({ ...fixture.policyRecords[0] });
      await writePolicy(fixture);
      await assert.rejects(buildFixture(fixture), /Duplicate policy record id/u);
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  });

  await t.test("missing mirror", async () => {
    const fixture = await createFixture();
    try {
      await rm(join(fixture.activeRoot, "docs/guide.md"));
      await assert.rejects(buildFixture(fixture), /Unable to read mirror/u);
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  });

  await t.test("invalid mirror UTF-8", async () => {
    const fixture = await createFixture();
    try {
      await writeFile(join(fixture.activeRoot, "docs/guide.md"), Buffer.from([0xc3, 0x28]));
      await assert.rejects(buildFixture(fixture), /not valid UTF-8/u);
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  });

  await t.test("tampered source record", async () => {
    const fixture = await createFixture();
    try {
      const manifest = JSON.parse(await readFile(join(fixture.rawRoot, "manifest.json"), "utf8"));
      await writeFile(join(fixture.rawRoot, manifest.corpus.file), "tampered\n", "utf8");
      await assert.rejects(buildFixture(fixture), /whole-file integrity/u);
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  });

  await t.test("tampered existing active corpus", async () => {
    const fixture = await createFixture();
    try {
      const first = await buildFixture(fixture);
      await writeFile(
        join(fixture.activeRoot, first.manifest.corpus.file),
        "tampered active corpus\n",
        "utf8",
      );
      await assert.rejects(buildFixture(fixture), /active corpus failed integrity/u);
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  });
});

test("manifest-last publication retains old files and cleans failed temporaries", async () => {
  const fixture = await createFixture();
  try {
    const first = await buildFixture(fixture);
    const oldManifestText = await readFile(join(fixture.activeRoot, "manifest.json"), "utf8");
    const oldCorpusText = await readFile(join(fixture.activeRoot, first.manifest.corpus.file), "utf8");
    await writeFile(join(fixture.activeRoot, "docs/guide.md"), "# Revised safe guide\n", "utf8");

    await assert.rejects(
      buildFixture(fixture, {
        async renameFile(source, target) {
          if (target === join(fixture.activeRoot, "manifest.json")) {
            throw new Error("injected active manifest rename failure");
          }
          await rename(source, target);
        },
      }),
      /injected active manifest rename failure/u,
    );
    assert.equal(await readFile(join(fixture.activeRoot, "manifest.json"), "utf8"), oldManifestText);
    assert.equal(
      await readFile(join(fixture.activeRoot, first.manifest.corpus.file), "utf8"),
      oldCorpusText,
    );
    const files = await readdir(fixture.activeRoot);
    assert.equal(files.some((file) => file.endsWith(".tmp")), false);
    assert.equal(files.filter((file) => /^corpus-[0-9a-f]{64}\.jsonl$/u.test(file)).length, 2);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

async function createFixture() {
  const root = await mkdtemp(join(tmpdir(), "figma-upstream-active-"));
  const rawRoot = join(root, "upstream-corpus");
  const activeRoot = join(root, "upstream-active");
  const rawRecords = [
    rawRecord("alpha/SKILL.md", "# Router source\n", "markdown"),
    rawRecord("alpha/references/guide.md", "# Unsafe source\n", "markdown"),
    rawRecord("alpha/scripts/example.js", "export const example = 1;\n", "javascript"),
    rawRecord("alpha/references/api.d.ts", "export interface Api {}\n", "typescript"),
  ];
  await writeRawCorpus(rawRoot, rawRecords);
  await mkdir(join(activeRoot, "docs"), { recursive: true });
  await writeFile(join(activeRoot, "docs/router.md"), "# Safe router\n", "utf8");
  await writeFile(join(activeRoot, "docs/guide.md"), "# Safe guide\n", "utf8");
  const policyRecords = [
    policyRecord(rawRecords[0], "router", "docs/router.md"),
    policyRecord(rawRecords[1], "active", "docs/guide.md"),
    policyRecord(rawRecords[2], "examples"),
    policyRecord(rawRecords[3], "api"),
  ];
  const fixture = { root, rawRoot, activeRoot, rawRecords, policyRecords };
  await writePolicy(fixture);
  return fixture;
}

async function buildFixture(fixture, options = {}) {
  return buildUpstreamActive({
    rawRoot: fixture.rawRoot,
    activeRoot: fixture.activeRoot,
    generatedAt,
    expectedPolicyFragmentCount: 1,
    ...options,
  });
}

async function writePolicy(fixture) {
  const policyRoot = join(fixture.activeRoot, "policy");
  await mkdir(policyRoot, { recursive: true });
  await writeFile(join(policyRoot, "alpha.json"), `${JSON.stringify({
    schemaVersion: 1,
    skill: "alpha",
    records: fixture.policyRecords,
  }, null, 2)}\n`, "utf8");
}

function policyRecord(source, classification, mirrorPath) {
  return {
    id: source.id,
    sourceContentSha256: source.contentSha256,
    classification,
    state: "ready",
    ...(mirrorPath === undefined ? {} : { mirrorPath }),
    sourceContract: "figma-mcp",
    targetContract: "figma-workspace-cli",
    surfaces: [classification === "api" ? "api" : "docs"],
    mappingProfile: `${classification}-v1`,
  };
}

function rawRecord(id, text, format) {
  return {
    schemaVersion: 2,
    id,
    skill: id.split("/")[0],
    kind: id.endsWith("/SKILL.md")
      ? "skill"
      : format === "markdown" ? "reference" : "script",
    format,
    sourcePath: id,
    lineCount: text.split("\n").length,
    contentSha256: sha256(text),
    text,
  };
}

async function writeRawCorpus(rawRoot, records) {
  const sortedRecords = [...records]
    .sort((left, right) => Buffer.compare(Buffer.from(left.id), Buffer.from(right.id)));
  const corpusText = `${sortedRecords.map((record) => JSON.stringify(record)).join("\n")}\n`;
  const corpusSha256 = sha256(corpusText);
  const corpusFile = `corpus-${corpusSha256}.jsonl`;
  const manifest = {
    schemaVersion: 2,
    generatedAt,
    upstream: {
      repository: "https://example.invalid/figma.git",
      requestedRef: "main",
      resolvedCommit: "a".repeat(40),
      sourcePath: "skills",
      termsUrl: "https://example.invalid/terms",
    },
    corpus: {
      file: corpusFile,
      recordCount: sortedRecords.length,
      sha256: corpusSha256,
      contract: "raw fixture",
    },
    includedSkills: ["alpha"],
    outOfScopeSkills: [],
    integrity: {
      algorithm: "sha256",
      textNormalization: "crlf-to-lf",
      contentHashes: Object.fromEntries(sortedRecords.map((record) => [record.id, record.contentSha256])),
    },
  };
  await mkdir(rawRoot, { recursive: true });
  await writeFile(join(rawRoot, corpusFile), corpusText, "utf8");
  await writeFile(join(rawRoot, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
}

function parseJsonl(text) {
  return text.trimEnd().split("\n").filter(Boolean).map((line) => JSON.parse(line));
}

function sha256(value) {
  return createHash("sha256").update(value, "utf8").digest("hex");
}
