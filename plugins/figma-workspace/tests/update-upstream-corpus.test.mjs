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
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";
import {
  DEFAULT_UPSTREAM_REF,
  FIGMA_DEVELOPER_TERMS_URL,
  OFFICIAL_UPSTREAM_REPOSITORY,
  parseCliArgs,
  updateUpstreamCorpus,
} from "../scripts/update-upstream-corpus.mjs";

const updaterScript = fileURLToPath(new URL("../scripts/update-upstream-corpus.mjs", import.meta.url));
const fixedGeneratedAt = "2026-07-14T01:02:03.000Z";

test("defaults pin the official GitHub repository and main ref", () => {
  assert.equal(OFFICIAL_UPSTREAM_REPOSITORY, "https://github.com/figma/mcp-server-guide.git");
  assert.equal(DEFAULT_UPSTREAM_REF, "main");
  assert.deepEqual(parseCliArgs([]), { requestedRef: "main" });
  assert.deepEqual(parseCliArgs(["--ref", "release/v2"]), { requestedRef: "release/v2" });
});

test("CLI parser rejects unknown, duplicate, missing, and malformed ref arguments", () => {
  for (const [args, expected] of [
    [["--unknown"], /Unknown argument/u],
    [["main"], /Unknown argument/u],
    [["--ref"], /requires a <git-ref>/u],
    [["--ref", "--other"], /requires a <git-ref>/u],
    [["--ref", "main", "--ref", "next"], /Duplicate option/u],
    [["--ref", "-main"], /Invalid git ref/u],
    [["--ref", "bad ref"], /Invalid git ref/u],
  ]) {
    assert.throws(() => parseCliArgs(args), expected, args.join(" "));
  }

  const subprocess = spawnSync(process.execPath, [updaterScript, "--unknown"], {
    encoding: "utf8",
  });
  assert.equal(subprocess.status, 1);
  assert.equal(subprocess.stdout, "");
  assert.match(subprocess.stderr, /Unknown argument/u);
});

test("Git refs and raw commit SHAs resolve to the fetched commit", async () => {
  const fixture = await createRepositoryFixture();
  const outputByRef = join(fixture.root, "output-ref");
  const outputBySha = join(fixture.root, "output-sha");
  try {
    git(fixture.repository, ["branch", "fixture-ref", fixture.commit]);

    const byRef = await updateUpstreamCorpus({
      buildActive: false,
      repository: fixture.repository,
      requestedRef: "fixture-ref",
      outputDir: outputByRef,
      generatedAt: fixedGeneratedAt,
    });
    const bySha = await updateUpstreamCorpus({
      buildActive: false,
      repository: fixture.repository,
      requestedRef: fixture.commit,
      outputDir: outputBySha,
      generatedAt: fixedGeneratedAt,
    });

    assert.equal(byRef.manifest.upstream.resolvedCommit, fixture.commit);
    assert.equal(byRef.manifest.upstream.requestedRef, "fixture-ref");
    assert.equal(bySha.manifest.upstream.resolvedCommit, fixture.commit);
    assert.equal(bySha.manifest.upstream.requestedRef, fixture.commit);
    assert.deepEqual(byRef.records, bySha.records);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("generation covers all regular source types with deterministic hashes and EOLs", async () => {
  const fixture = await createRepositoryFixture();
  const outputDir = join(fixture.root, "output");
  try {
    const result = await updateUpstreamCorpus({
      buildActive: false,
      repository: fixture.repository,
      requestedRef: fixture.commit,
      outputDir,
      generatedAt: fixedGeneratedAt,
    });
    const manifestText = await readFile(join(outputDir, "manifest.json"), "utf8");
    const manifest = JSON.parse(manifestText);
    const corpusText = await readFile(join(outputDir, manifest.corpus.file), "utf8");
    const records = corpusText.trimEnd().split("\n").map((line) => JSON.parse(line));

    assert.deepEqual(records.map((record) => record.id), [
      "alpha/SKILL.md",
      "alpha/references/guide.md",
      "alpha/scripts/example.js",
      "alpha/scripts/example.ts",
      "zeta/SKILL.md",
    ]);
    assert.deepEqual(records.map(({ id, kind, format }) => ({ id, kind, format })), [
      { id: "alpha/SKILL.md", kind: "skill", format: "markdown" },
      { id: "alpha/references/guide.md", kind: "reference", format: "markdown" },
      { id: "alpha/scripts/example.js", kind: "script", format: "javascript" },
      { id: "alpha/scripts/example.ts", kind: "script", format: "typescript" },
      { id: "zeta/SKILL.md", kind: "skill", format: "markdown" },
    ]);
    assert.ok(records.every((record) => record.schemaVersion === 2));
    assert.ok(records.every((record) => record.sourcePath === record.id));
    assert.deepEqual([...new Set(records.map((record) => record.skill))], ["alpha", "zeta"]);

    const zeta = records.find((record) => record.id === "zeta/SKILL.md");
    assert.equal(zeta.text, "# Zeta\nsecond line\n");
    assert.equal(zeta.lineCount, 3);
    assert.equal(zeta.contentSha256, sha256(zeta.text));
    assert.doesNotMatch(corpusText, /\r/u);
    for (const record of records) {
      assert.equal(record.contentSha256, sha256(record.text), record.id);
    }

    assert.deepEqual(manifest, {
      schemaVersion: 2,
      generatedAt: fixedGeneratedAt,
      upstream: {
        repository: fixture.repository,
        requestedRef: fixture.commit,
        resolvedCommit: fixture.commit,
        sourcePath: "skills",
        termsUrl: FIGMA_DEVELOPER_TERMS_URL,
      },
      corpus: {
        file: `corpus-${sha256(corpusText)}.jsonl`,
        recordCount: 5,
        sha256: sha256(corpusText),
        contract: "Internal lookup corpus only; agents use the guidance and lookup CLI commands instead of reading upstream files directly.",
      },
      includedSkills: ["alpha", "zeta"],
      outOfScopeSkills: [
        {
          skill: "generate-project-plan",
          reason: "Standalone workflow skill; excluded from the bundled upstream lookup corpus.",
        },
        {
          skill: "video-interaction-mapper",
          reason: "Standalone workflow skill; excluded from the bundled upstream lookup corpus.",
        },
      ],
      integrity: {
        algorithm: "sha256",
        textNormalization: "crlf-to-lf",
        contentHashes: Object.fromEntries(records.map((record) => [record.id, record.contentSha256])),
      },
    });
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("raw publication builds the sibling active index before returning", async () => {
  const fixture = await createRepositoryFixture();
  const outputDir = join(fixture.root, "upstream-corpus");
  const activeOutputDir = join(fixture.root, "upstream-active");
  try {
    const sourceById = {
      "alpha/SKILL.md": "# Alpha\n",
      "alpha/references/guide.md": "# Guide\n",
      "alpha/scripts/example.js": "export const value = 1;\n",
      "alpha/scripts/example.ts": "export const value: number = 1;\n",
      "zeta/SKILL.md": "# Zeta\nsecond line\n",
    };
    await mkdir(join(activeOutputDir, "policy"), { recursive: true });
    await mkdir(join(activeOutputDir, "docs"), { recursive: true });
    await writeFile(join(activeOutputDir, "docs/alpha-skill.md"), "# Safe Alpha\n", "utf8");
    await writeFile(join(activeOutputDir, "docs/guide.md"), "# Safe Guide\n", "utf8");
    await writeFile(join(activeOutputDir, "docs/zeta-skill.md"), "# Safe Zeta\n", "utf8");
    await writePolicyFragment(activeOutputDir, "alpha", [
      activePolicyRecord("alpha/SKILL.md", sourceById["alpha/SKILL.md"], "router", "docs/alpha-skill.md"),
      activePolicyRecord("alpha/references/guide.md", sourceById["alpha/references/guide.md"], "active", "docs/guide.md"),
      activePolicyRecord("alpha/scripts/example.js", sourceById["alpha/scripts/example.js"], "examples"),
      activePolicyRecord("alpha/scripts/example.ts", sourceById["alpha/scripts/example.ts"], "api"),
    ]);
    await writePolicyFragment(activeOutputDir, "zeta", [
      activePolicyRecord("zeta/SKILL.md", sourceById["zeta/SKILL.md"], "router", "docs/zeta-skill.md"),
    ]);

    const result = await updateUpstreamCorpus({
      repository: fixture.repository,
      requestedRef: fixture.commit,
      outputDir,
      activeOutputDir,
      expectedPolicyFragmentCount: 2,
      generatedAt: fixedGeneratedAt,
    });

    assert.equal(result.active.manifest.parent.corpus.sha256, result.manifest.corpus.sha256);
    assert.equal(result.active.manifest.queryableRecordCount, 4);
    assert.equal(result.active.manifest.classificationCounts.api, 1);
    assert.equal(result.active.manifest.pendingCount, 0);
    const activeManifest = JSON.parse(await readFile(join(activeOutputDir, "manifest.json"), "utf8"));
    assert.deepEqual(activeManifest, result.active.manifest);

    const alphaPolicyPath = join(activeOutputDir, "policy/alpha.json");
    const malformedPolicy = JSON.parse(await readFile(alphaPolicyPath, "utf8"));
    malformedPolicy.unexpected = true;
    await writeFile(alphaPolicyPath, `${JSON.stringify(malformedPolicy, null, 2)}\n`, "utf8");
    await assert.rejects(
      updateUpstreamCorpus({
        repository: fixture.repository,
        requestedRef: fixture.commit,
        outputDir,
        activeOutputDir,
        expectedPolicyFragmentCount: 2,
        generatedAt: fixedGeneratedAt,
      }),
      /policy fragment alpha\.json must contain exactly/u,
    );
    assert.deepEqual(
      JSON.parse(await readFile(join(outputDir, "manifest.json"), "utf8")),
      result.manifest,
      "raw publication remains valid even though malformed policy makes the update command fail",
    );
    assert.deepEqual(
      JSON.parse(await readFile(join(activeOutputDir, "manifest.json"), "utf8")),
      activeManifest,
      "active manifest is not replaced on policy validation failure",
    );

    delete malformedPolicy.unexpected;
    await writeFile(alphaPolicyPath, `${JSON.stringify(malformedPolicy, null, 2)}\n`, "utf8");
    await assert.rejects(
      updateUpstreamCorpus({
        repository: fixture.repository,
        requestedRef: fixture.commit,
        outputDir,
        activeOutputDir,
        expectedPolicyFragmentCount: 2,
        generatedAt: "2026-07-14T09:10:11.000Z",
        async activeRenameFile(source, target) {
          if (target === join(activeOutputDir, "manifest.json")) {
            throw new Error("injected active manifest rename failure");
          }
          await rename(source, target);
        },
      }),
      /injected active manifest rename failure/u,
    );
    assert.deepEqual(
      JSON.parse(await readFile(join(outputDir, "manifest.json"), "utf8")),
      result.manifest,
      "raw manifest rolls back when active publication cannot switch generations",
    );
    assert.deepEqual(
      JSON.parse(await readFile(join(activeOutputDir, "manifest.json"), "utf8")),
      activeManifest,
      "active manifest remains on the previous generation after a failed switch",
    );
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("unknown extensions fail before replacing an existing corpus", async () => {
  const fixture = await createRepositoryFixture({
    extraFiles: { "skills/alpha/references/data.json": "{}\n" },
  });
  const outputDir = join(fixture.root, "output");
  try {
    const oldPair = await seedOldPair(outputDir);

    await assert.rejects(
      updateUpstreamCorpus({
        buildActive: false,
        repository: fixture.repository,
        requestedRef: fixture.commit,
        outputDir,
        generatedAt: fixedGeneratedAt,
      }),
      /Unsupported file extension/u,
    );
    assert.equal(await readFile(join(outputDir, oldPair.corpusFile), "utf8"), oldPair.corpusText);
    assert.equal(await readFile(join(outputDir, "manifest.json"), "utf8"), oldPair.manifestText);
    assert.deepEqual((await readdir(outputDir)).sort(), [oldPair.corpusFile, "manifest.json"].sort());
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("a top-level skill without SKILL.md fails without creating output", async () => {
  const fixture = await createRepositoryFixture({
    extraFiles: { "skills/orphan/references/guide.md": "# Orphan\n" },
  });
  const outputDir = join(fixture.root, "output");
  try {
    await assert.rejects(
      updateUpstreamCorpus({
        buildActive: false,
        repository: fixture.repository,
        requestedRef: fixture.commit,
        outputDir,
        generatedAt: fixedGeneratedAt,
      }),
      /missing skills\/orphan\/SKILL\.md/u,
    );
    await assert.rejects(readFile(join(outputDir, "manifest.json")), { code: "ENOENT" });
    await assert.rejects(readdir(outputDir), { code: "ENOENT" });
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("manifest rename failure preserves the old readable pair without partial temp files", async () => {
  const fixture = await createRepositoryFixture();
  const outputDir = join(fixture.root, "output");
  try {
    const oldPair = await seedOldPair(outputDir);
    await assert.rejects(
      updateUpstreamCorpus({
        buildActive: false,
        repository: fixture.repository,
        requestedRef: fixture.commit,
        outputDir,
        generatedAt: fixedGeneratedAt,
        async renameFile(source, target) {
          if (target === join(outputDir, "manifest.json")) {
            throw new Error("injected manifest rename failure");
          }
          await rename(source, target);
        },
      }),
      /injected manifest rename failure/u,
    );

    assert.equal(await readFile(join(outputDir, "manifest.json"), "utf8"), oldPair.manifestText);
    assert.equal(await readFile(join(outputDir, oldPair.corpusFile), "utf8"), oldPair.corpusText);
    const files = await readdir(outputDir);
    assert.equal(files.some((file) => file.endsWith(".tmp")), false);
    const corpusFiles = files.filter((file) => /^corpus-[0-9a-f]{64}\.jsonl$/u.test(file));
    assert.equal(corpusFiles.length, 2, "the fully published new corpus may remain as a safe orphan");
    for (const corpusFile of corpusFiles) {
      const corpusText = await readFile(join(outputDir, corpusFile), "utf8");
      assert.equal(corpusFile, `corpus-${sha256(corpusText)}.jsonl`);
    }
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("successful manifest switch keeps the old corpus readable and syncs both directory renames", async () => {
  const fixture = await createRepositoryFixture();
  const outputDir = join(fixture.root, "output");
  try {
    const oldPair = await seedOldPair(outputDir);
    const syncedDirectories = [];
    const result = await updateUpstreamCorpus({
      buildActive: false,
      repository: fixture.repository,
      requestedRef: fixture.commit,
      outputDir,
      generatedAt: fixedGeneratedAt,
      async syncDirectoryFn(directory) {
        syncedDirectories.push(directory);
      },
    });

    const manifest = JSON.parse(await readFile(join(outputDir, "manifest.json"), "utf8"));
    assert.equal(manifest.corpus.file, result.manifest.corpus.file);
    assert.notEqual(manifest.corpus.file, oldPair.corpusFile);
    const corpusText = await readFile(join(outputDir, manifest.corpus.file), "utf8");
    assert.equal(manifest.corpus.sha256, sha256(corpusText));
    assert.equal(await readFile(join(outputDir, oldPair.corpusFile), "utf8"), oldPair.corpusText);
    assert.deepEqual(syncedDirectories, [outputDir, outputDir]);
    assert.deepEqual(
      (await readdir(outputDir)).sort(),
      [oldPair.corpusFile, manifest.corpus.file, "manifest.json"].sort(),
    );
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

async function createRepositoryFixture(options = {}) {
  const root = await mkdtemp(join(tmpdir(), "figma-corpus-fixture-"));
  const repository = join(root, "repository");
  await mkdir(repository);
  git(repository, ["init", "--quiet", "--initial-branch=main"]);
  git(repository, ["config", "user.name", "Corpus Test"]);
  git(repository, ["config", "user.email", "corpus-test@example.invalid"]);
  git(repository, ["config", "core.autocrlf", "false"]);

  const files = {
    "skills/zeta/SKILL.md": "# Zeta\r\nsecond line\r\n",
    "skills/alpha/SKILL.md": "# Alpha\n",
    "skills/alpha/references/guide.md": "# Guide\n",
    "skills/alpha/scripts/example.ts": "export const value: number = 1;\n",
    "skills/alpha/scripts/example.js": "export const value = 1;\n",
    "workflow-skills/video-interaction-mapper/SKILL.md": "# Video\n",
    "workflow-skills/generate-project-plan/SKILL.md": "# Plan\n",
    ...options.extraFiles,
  };
  for (const [path, content] of Object.entries(files)) {
    const target = join(repository, ...path.split("/"));
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, content, "utf8");
  }
  git(repository, ["add", "--all"]);
  git(repository, ["commit", "--quiet", "-m", "fixture"]);
  const commit = git(repository, ["rev-parse", "HEAD"]).stdout.trim();
  return { root, repository, commit };
}

function git(cwd, args) {
  const result = spawnSync("git", args, {
    cwd,
    encoding: "utf8",
    windowsHide: true,
  });
  assert.equal(result.status, 0, result.stderr || `git ${args.join(" ")} failed`);
  return result;
}

function sha256(value) {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

async function seedOldPair(outputDir) {
  const corpusText = `${JSON.stringify({ schemaVersion: 2, id: "old/SKILL.md", text: "# Old\n" })}\n`;
  const corpusFile = `corpus-${sha256(corpusText)}.jsonl`;
  const manifestText = `${JSON.stringify({
    schemaVersion: 2,
    corpus: {
      file: corpusFile,
      sha256: sha256(corpusText),
    },
  }, null, 2)}\n`;
  await mkdir(outputDir, { recursive: true });
  await writeFile(join(outputDir, corpusFile), corpusText, "utf8");
  await writeFile(join(outputDir, "manifest.json"), manifestText, "utf8");
  return { corpusFile, corpusText, manifestText };
}

async function writePolicyFragment(activeOutputDir, skill, records) {
  await writeFile(join(activeOutputDir, "policy", `${skill}.json`), `${JSON.stringify({
    schemaVersion: 1,
    skill,
    records,
  }, null, 2)}\n`, "utf8");
}

function activePolicyRecord(id, source, classification, mirrorPath) {
  return {
    id,
    sourceContentSha256: sha256(source),
    classification,
    state: "ready",
    ...(mirrorPath === undefined ? {} : { mirrorPath }),
    sourceContract: "figma-mcp",
    targetContract: "figma-workspace-cli",
    surfaces: [],
    mappingProfile: `${classification}-v1`,
  };
}
