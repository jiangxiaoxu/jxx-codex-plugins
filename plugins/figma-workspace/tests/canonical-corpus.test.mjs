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
import { buildCanonicalCorpus } from "../scripts/lib/canonical-corpus.mjs";

const generatedAt = "2026-07-14T04:05:06.000Z";

test("builder publishes only self-contained mirrors with canonical identities", async () => {
  const fixture = await createFixture();
  try {
    const result = await buildFixture(fixture);
    const manifest = JSON.parse(await readFile(join(fixture.canonicalRoot, "manifest.json"), "utf8"));
    const corpusText = await readFile(join(fixture.canonicalRoot, manifest.corpus.file), "utf8");
    const records = parseJsonl(corpusText);
    assert.deepEqual(result.manifest, manifest);
    assert.deepEqual(records.map((record) => record.id), [
      "alpha/SKILL.md",
      "alpha/examples/create-card.md",
      "alpha/references/guide.md",
    ]);
    assert.deepEqual(records.map((record) => record.sourceRecordId), [
      "alpha/SKILL.md",
      "alpha/scripts/create-card.js",
      "alpha/references/guide.md",
    ]);
    assert.deepEqual(manifest.classificationCounts, {
      active: 1,
      conditional: 0,
      router: 1,
      examples: 1,
    });
    assert.deepEqual(manifest.reviewWarnings, []);
    assert.deepEqual(manifest.corpus, {
      file: `corpus-${sha256(corpusText)}.jsonl`,
      recordCount: 3,
      sha256: sha256(corpusText),
    });
    assert.deepEqual(manifest.source, {
      repository: "https://example.invalid/figma.git",
      resolvedCommit: "a".repeat(40),
    });
    assert.equal("parent" in manifest, false);
    assert.equal("pendingRecords" in manifest, false);
    assert.deepEqual(manifest.integrity.contentHashes, Object.fromEntries(
      records.map((record) => [record.id, record.contentSha256]),
    ));
    for (const record of records) {
      assert.equal(record.format, "markdown");
      assert.equal(record.sanitized, true);
      assert.equal(record.contentSha256, sha256(record.text));
      assert.equal("sourceContentSha256" in record, false);
    }
    const example = records.find((record) => record.classification === "examples");
    assert.equal(example.nonExecutable, true);
    assert.match(example.text, /```ts/u);
    assert.equal(example.text.includes("unsafe upstream JS"), false);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("arbitrary upstream snapshot drift cannot change canonical output", async () => {
  const fixture = await createFixture();
  try {
    const first = await buildFixture(fixture, { publish: false });
    const rawRoot = join(fixture.root, "dev/upstream-snapshot");
    await mkdir(rawRoot, { recursive: true });
    await writeFile(join(rawRoot, "manifest.json"), "changed, deleted, and new raw records\n", "utf8");
    const second = await buildFixture(fixture, { publish: false });
    assert.deepEqual(second.records, first.records);
    assert.equal(second.manifest.corpus.sha256, first.manifest.corpus.sha256);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("builder publishes but records a review warning for source-identical mirrors", async () => {
  const fixture = await createFixture();
  try {
    const policy = fixture.policyRecords.find((record) => record.classification === "active");
    const mirror = join(fixture.canonicalRoot, ...policy.mirrorPath.split("/"));
    const text = await readFile(mirror, "utf8");
    policy.sourceContentSha256 = sha256(text);
    await writePolicy(fixture);
    const result = await buildFixture(fixture);
    assert.deepEqual(result.manifest.reviewWarnings, [{
      code: "SOURCE_IDENTICAL",
      id: "alpha/references/guide.md",
      sourceRecordId: "alpha/references/guide.md",
      contentSha256: sha256(text),
    }]);
    assert.equal(result.records.length, 3);
    assert.deepEqual(
      JSON.parse(await readFile(join(fixture.canonicalRoot, "manifest.json"), "utf8"))
        .reviewWarnings,
      result.manifest.reviewWarnings,
    );
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("examples require an adapted Markdown mirror and never fall back to raw JS", async () => {
  const fixture = await createFixture();
  try {
    const example = fixture.policyRecords.find((record) => record.classification === "examples");
    delete example.mirrorPath;
    await writePolicy(fixture);
    await assert.rejects(buildFixture(fixture), /exactly.*mirrorPath|must contain exactly/u);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("canonical examples fail closed without a TypeScript code fence", async (t) => {
  for (const [name, text] of [
    ["JavaScript fence", "# Example\n\n```js\nfigma.createFrame();\n```\n"],
    ["no code fence", "# Example\n\nCreate a frame with the Plugin API.\n"],
  ]) {
    await t.test(name, async () => {
      const fixture = await createFixture();
      try {
        await writeFile(
          join(fixture.canonicalRoot, "docs/alpha/examples/create-card.md"),
          text,
          "utf8",
        );
        await assert.rejects(buildFixture(fixture), /must contain a TypeScript code fence/u);
        await assert.rejects(
          readFile(join(fixture.canonicalRoot, "manifest.json")),
          { code: "ENOENT" },
        );
      } finally {
        await rm(fixture.root, { recursive: true, force: true });
      }
    });
  }
});

test("policy and mirror errors fail closed", async (t) => {
  await t.test("duplicate canonical identity", async () => {
    const fixture = await createFixture();
    try {
      fixture.policyRecords[1].mirrorPath = fixture.policyRecords[0].mirrorPath;
      await writePolicy(fixture);
      await assert.rejects(buildFixture(fixture), /Duplicate canonical record id/u);
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  });

  await t.test("missing mirror", async () => {
    const fixture = await createFixture();
    try {
      await rm(join(fixture.canonicalRoot, "docs/alpha/references/guide.md"));
      await assert.rejects(buildFixture(fixture), /Unable to read canonical mirror/u);
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  });

  await t.test("invalid mirror UTF-8", async () => {
    const fixture = await createFixture();
    try {
      await writeFile(
        join(fixture.canonicalRoot, "docs/alpha/references/guide.md"),
        Buffer.from([0xc3, 0x28]),
      );
      await assert.rejects(buildFixture(fixture), /not valid UTF-8/u);
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  });
});

test("manifest-last publication retains old content and cleans failed temporaries", async () => {
  const fixture = await createFixture();
  try {
    const first = await buildFixture(fixture);
    const oldManifest = await readFile(join(fixture.canonicalRoot, "manifest.json"), "utf8");
    await writeFile(
      join(fixture.canonicalRoot, "docs/alpha/references/guide.md"),
      "# Revised canonical guide\n",
      "utf8",
    );
    await assert.rejects(
      buildFixture(fixture, {
        async renameFile(source, target) {
          if (target === join(fixture.canonicalRoot, "manifest.json")) {
            throw new Error("injected canonical manifest failure");
          }
          await rename(source, target);
        },
      }),
      /injected canonical manifest failure/u,
    );
    assert.equal(await readFile(join(fixture.canonicalRoot, "manifest.json"), "utf8"), oldManifest);
    const files = await readdir(fixture.canonicalRoot);
    assert.equal(files.some((file) => file.endsWith(".tmp")), false);
    assert.equal(files.includes(first.manifest.corpus.file), true);
    assert.equal(files.filter((file) => /^corpus-[0-9a-f]{64}\.jsonl$/u.test(file)).length, 2);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

async function createFixture() {
  const root = await mkdtemp(join(tmpdir(), "figma-canonical-corpus-"));
  const canonicalRoot = join(root, "canonical-corpus");
  const mirrors = {
    "docs/alpha/SKILL.md": "# Canonical router\n",
    "docs/alpha/references/guide.md": "# Canonical safe guide\n",
    "docs/alpha/examples/create-card.md": "# Create a card\n\n```ts\nconst card = figma.createFrame();\n```\n",
  };
  for (const [path, text] of Object.entries(mirrors)) {
    const target = join(canonicalRoot, ...path.split("/"));
    await mkdir(join(target, ".."), { recursive: true });
    await writeFile(target, text, "utf8");
  }
  const policyRecords = [
    policyRecord("alpha/SKILL.md", "# unsafe upstream router\n", "router", "docs/alpha/SKILL.md"),
    policyRecord(
      "alpha/references/guide.md",
      "# unsafe upstream guide\n",
      "active",
      "docs/alpha/references/guide.md",
    ),
    policyRecord(
      "alpha/scripts/create-card.js",
      "unsafe upstream JS\n",
      "examples",
      "docs/alpha/examples/create-card.md",
    ),
    policyRecord("alpha/references/api.d.ts", "export interface Api {}\n", "api"),
  ];
  const fixture = { root, canonicalRoot, policyRecords };
  await writePolicy(fixture);
  return fixture;
}

async function buildFixture(fixture, options = {}) {
  return buildCanonicalCorpus({
    canonicalRoot: fixture.canonicalRoot,
    generatedAt,
    expectedPolicyFragmentCount: 1,
    expectedPublishedRecordCount: 3,
    source: {
      repository: "https://example.invalid/figma.git",
      resolvedCommit: "a".repeat(40),
    },
    ...options,
  });
}

async function writePolicy(fixture) {
  const policyRoot = join(fixture.canonicalRoot, "policy");
  await mkdir(policyRoot, { recursive: true });
  await writeFile(join(policyRoot, "alpha.json"), `${JSON.stringify({
    schemaVersion: 1,
    skill: "alpha",
    records: fixture.policyRecords,
  }, null, 2)}\n`, "utf8");
}

function policyRecord(id, source, classification, mirrorPath) {
  return {
    id,
    sourceContentSha256: sha256(source),
    classification,
    state: "ready",
    ...(mirrorPath === undefined ? {} : { mirrorPath }),
    sourceContract: "figma-mcp",
    targetContract: "figma-workspace-cli",
    surfaces: [classification === "api" ? "api" : "docs"],
    mappingProfile: `${classification}-v1`,
  };
}

function parseJsonl(text) {
  return text.trimEnd().split("\n").filter(Boolean).map((line) => JSON.parse(line));
}

function sha256(value) {
  return createHash("sha256").update(value, "utf8").digest("hex");
}
