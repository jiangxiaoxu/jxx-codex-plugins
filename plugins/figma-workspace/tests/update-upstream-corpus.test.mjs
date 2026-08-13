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
import { pathToFileURL } from "node:url";
import test from "node:test";
import {
  inspectCommittedUpstreamDrift,
  parseCliInvocation,
  refreshUpstreamChanges,
  runCli,
  updateUpstreamSnapshot,
} from "../scripts/update-upstream-corpus.mjs";

const generatedAt = "2026-07-14T04:05:06.000Z";

test("CLI exposes separate snapshot update and canonical build commands", () => {
  assert.deepEqual(parseCliInvocation(["update-upstream-snapshot"]), {
    command: "update-upstream-snapshot",
    requestedRef: "main",
  });
  assert.deepEqual(parseCliInvocation(["update-upstream-snapshot", "--ref", "release/v1"]), {
    command: "update-upstream-snapshot",
    requestedRef: "release/v1",
  });
  assert.deepEqual(parseCliInvocation(["build-canonical-corpus"]), {
    command: "build-canonical-corpus",
  });
  assert.deepEqual(parseCliInvocation(["refresh-upstream-changes"]), {
    command: "refresh-upstream-changes",
  });
  assert.deepEqual(
    parseCliInvocation([
      "refresh-upstream-changes",
      "--from-report",
      "report-0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef.json",
    ]),
    {
      command: "refresh-upstream-changes",
      fromReportFile: "report-0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef.json",
    },
  );
  assert.throws(() => parseCliInvocation([]), /Expected command/u);
  assert.throws(
    () => parseCliInvocation(["update-upstream-snapshot", "--ref", "main", "--ref", "next"]),
    /Duplicate option/u,
  );
  assert.throws(() => parseCliInvocation(["build-canonical-corpus", "--ref", "main"]), /Unknown/u);
  assert.throws(() => parseCliInvocation(["refresh-upstream-changes", "--ref", "main"]), /Unknown/u);
  assert.throws(
    () => parseCliInvocation(["refresh-upstream-changes", "--from-report", "../report.json"]),
    /content-addressed/u,
  );
});

test("refreshing upstream changes reuses the archived snapshot and current policy", async () => {
  const fixture = await createRepositoryFixture();
  const snapshotRoot = join(fixture.root, "dev/upstream-snapshot");
  const changesRoot = join(fixture.root, "dev/upstream-changes");
  try {
    await updateUpstreamSnapshot({
      repository: fixture.repository,
      snapshotRoot,
      changesRoot,
      policyRoot: fixture.policyRoot,
      expectedPolicyFragmentCount: 2,
      generatedAt,
    });
    await writeFile(join(fixture.worktree, "skills/alpha/SKILL.md"), "# Alpha revised\n", "utf8");
    commitFixture(fixture, "upstream drift");
    const drifted = await updateUpstreamSnapshot({
      repository: fixture.repository,
      snapshotRoot,
      changesRoot,
      policyRoot: fixture.policyRoot,
      expectedPolicyFragmentCount: 2,
      generatedAt: "2026-07-15T04:05:06.000Z",
    });
    await updateUpstreamSnapshot({
      repository: fixture.repository,
      snapshotRoot,
      changesRoot,
      policyRoot: fixture.policyRoot,
      expectedPolicyFragmentCount: 2,
      generatedAt: "2026-07-15T05:05:06.000Z",
    });
    const snapshotManifestBefore = await readFile(join(snapshotRoot, "manifest.json"), "utf8");
    const snapshotFilesBefore = (await readdir(snapshotRoot)).sort();

    await writeAcceptedPolicies(fixture.policyRoot, {
      "alpha/SKILL.md": ["# Alpha revised\n", "router"],
      "alpha/references/guide.md": ["# Guide\n", "active"],
      "alpha/scripts/example.js": ["export const value = 1;\n", "examples"],
      "alpha/scripts/example.ts": ["export const value: number = 1;\n", "api"],
      "zeta/SKILL.md": ["# Zeta\nsecond line\n", "router"],
    });

    const refreshed = await refreshUpstreamChanges({
      snapshotRoot,
      changesRoot,
      policyRoot: fixture.policyRoot,
      expectedPolicyFragmentCount: 2,
      generatedAt: "2026-07-16T04:05:06.000Z",
      fromReportFile: drifted.changeManifest.report.file,
    });
    assert.deepEqual(refreshed.report.summary, drifted.report.summary);
    assert.deepEqual(refreshed.report.changes, drifted.report.changes);
    assert.deepEqual(refreshed.report.from, drifted.report.from);
    assert.deepEqual(refreshed.report.adaptation, {
      readyCount: 5,
      pendingCount: 0,
      retiredCount: 0,
      pendingRecords: [],
      retiredRecords: [],
    });
    assert.equal(await readFile(join(snapshotRoot, "manifest.json"), "utf8"), snapshotManifestBefore);
    assert.deepEqual((await readdir(snapshotRoot)).sort(), snapshotFilesBefore);
    await inspectCommittedUpstreamDrift({
      snapshotRoot,
      changesRoot,
      policyRoot: fixture.policyRoot,
      expectedPolicyFragmentCount: 2,
    });
    const corruptReportFile = `report-${"0".repeat(64)}.json`;
    await writeFile(join(changesRoot, corruptReportFile), "{}\n", "utf8");
    await assert.rejects(
      refreshUpstreamChanges({
        snapshotRoot,
        changesRoot,
        policyRoot: fixture.policyRoot,
        expectedPolicyFragmentCount: 2,
        fromReportFile: corruptReportFile,
      }),
      /failed whole-file integrity/u,
    );

    const sourceStdout = { text: "", write(value) { this.text += value; } };
    await runCli([
      "refresh-upstream-changes",
      "--from-report",
      drifted.changeManifest.report.file,
    ], {
      refreshChangesOptions: {
        snapshotRoot,
        changesRoot,
        policyRoot: fixture.policyRoot,
        expectedPolicyFragmentCount: 2,
        generatedAt: "2026-07-17T04:05:06.000Z",
      },
      stdout: sourceStdout,
      stderr: { write() {} },
    });
    assert.match(sourceStdout.text, /refreshed upstream change report for 5 archived snapshot records/u);
    const restored = await inspectCommittedUpstreamDrift({
      snapshotRoot,
      changesRoot,
      policyRoot: fixture.policyRoot,
      expectedPolicyFragmentCount: 2,
    });
    assert.deepEqual(restored.report.summary, drifted.report.summary);
    assert.equal(await readFile(join(snapshotRoot, "manifest.json"), "utf8"), snapshotManifestBefore);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("updater publishes a complete dev snapshot and a content-addressed change report", async () => {
  const fixture = await createRepositoryFixture();
  const snapshotRoot = join(fixture.root, "dev/upstream-snapshot");
  const changesRoot = join(fixture.root, "dev/upstream-changes");
  try {
    const result = await updateUpstreamSnapshot({
      repository: fixture.repository,
      requestedRef: "main",
      snapshotRoot,
      changesRoot,
      policyRoot: fixture.policyRoot,
      expectedPolicyFragmentCount: 2,
      generatedAt,
    });
    assert.equal(result.records.length, 5);
    assert.equal(result.manifest.upstream.resolvedCommit, fixture.commit);
    assert.equal(result.manifest.corpus.contract.includes("Development-only"), true);
    assert.deepEqual(result.manifest.includedSkills, ["alpha", "zeta"]);
    assert.deepEqual(result.manifest.outOfScopeSkills.map(({ skill }) => skill), [
      "generate-project-plan",
      "video-interaction-mapper",
    ]);
    assert.deepEqual(result.report.summary, {
      newCount: 5,
      changedCount: 0,
      deletedCount: 0,
      unchangedCount: 0,
    });
    assert.deepEqual(result.report.adaptation, {
      readyCount: 5,
      pendingCount: 0,
      retiredCount: 0,
      pendingRecords: [],
      retiredRecords: [],
    });
    assert.equal(result.report.from, null);
    assert.equal(result.report.changes.new.some((record) => "text" in record), false);

    const snapshotManifest = JSON.parse(await readFile(join(snapshotRoot, "manifest.json"), "utf8"));
    const snapshotText = await readFile(join(snapshotRoot, snapshotManifest.corpus.file), "utf8");
    assert.equal(sha256(snapshotText), snapshotManifest.corpus.sha256);
    const records = parseJsonl(snapshotText);
    assert.equal(records.find((record) => record.id === "zeta/SKILL.md").text, "# Zeta\nsecond line\n");

    const changesManifest = JSON.parse(await readFile(join(changesRoot, "manifest.json"), "utf8"));
    const reportText = await readFile(join(changesRoot, changesManifest.report.file), "utf8");
    assert.equal(sha256(reportText), changesManifest.report.sha256);
    assert.deepEqual(JSON.parse(reportText), result.report);
    assert.deepEqual(changesManifest.adaptation, result.report.adaptation);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("committed drift inspection fails closed on malformed evidence and policy", async (suite) => {
  await suite.test("snapshot corpus hash mismatch", async () => {
    const fixture = await createPublishedInspectionFixture();
    try {
      const manifest = JSON.parse(await readFile(join(fixture.snapshotRoot, "manifest.json"), "utf8"));
      await writeFile(join(fixture.snapshotRoot, manifest.corpus.file), "corrupt\n", "utf8");
      await assert.rejects(
        inspectCommittedUpstreamDrift(fixture),
        /snapshot failed whole-file integrity/u,
      );
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  });

  await suite.test("change report hash mismatch", async () => {
    const fixture = await createPublishedInspectionFixture();
    try {
      const manifest = JSON.parse(await readFile(join(fixture.changesRoot, "manifest.json"), "utf8"));
      await writeFile(join(fixture.changesRoot, manifest.report.file), "corrupt\n", "utf8");
      await assert.rejects(
        inspectCommittedUpstreamDrift(fixture),
        /change report failed whole-file integrity/u,
      );
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  });

  await suite.test("malformed content-addressed change report", async () => {
    const fixture = await createPublishedInspectionFixture();
    try {
      const manifestPath = join(fixture.changesRoot, "manifest.json");
      const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
      const invalidReport = "{\n";
      const reportSha256 = sha256(invalidReport);
      manifest.report.file = `report-${reportSha256}.json`;
      manifest.report.sha256 = reportSha256;
      await writeFile(join(fixture.changesRoot, manifest.report.file), invalidReport, "utf8");
      await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
      await assert.rejects(
        inspectCommittedUpstreamDrift(fixture),
        /change report is not valid JSON/u,
      );
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  });

  await suite.test("unknown snapshot record field with recomputed corpus hash", async () => {
    const fixture = await createPublishedInspectionFixture();
    try {
      const manifestPath = join(fixture.snapshotRoot, "manifest.json");
      const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
      const corpusPath = join(fixture.snapshotRoot, manifest.corpus.file);
      const records = parseJsonl(await readFile(corpusPath, "utf8"));
      records[0].unexpected = true;
      const corpusText = `${records.map((record) => JSON.stringify(record)).join("\n")}\n`;
      const corpusSha256 = sha256(corpusText);
      manifest.corpus.file = `corpus-${corpusSha256}.jsonl`;
      manifest.corpus.sha256 = corpusSha256;
      await writeFile(join(fixture.snapshotRoot, manifest.corpus.file), corpusText, "utf8");
      await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
      await assert.rejects(
        inspectCommittedUpstreamDrift(fixture),
        /snapshot record must contain exactly/u,
      );
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  });

  await suite.test("unknown change report root field with recomputed report hash", async () => {
    const fixture = await createPublishedInspectionFixture();
    try {
      await rewriteChangeReport(fixture, (report) => {
        report.unexpected = true;
      });
      await assert.rejects(
        inspectCommittedUpstreamDrift(fixture),
        /change report must contain exactly/u,
      );
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  });

  await suite.test("unknown nested change record field with recomputed report hash", async () => {
    const fixture = await createPublishedInspectionFixture();
    try {
      await rewriteChangeReport(fixture, (report) => {
        report.changes.new[0].unexpected = true;
      });
      await assert.rejects(
        inspectCommittedUpstreamDrift(fixture),
        /change report new record must contain exactly/u,
      );
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  });

  await suite.test("missing nested report field with recomputed report hash", async () => {
    const fixture = await createPublishedInspectionFixture();
    try {
      await rewriteChangeReport(fixture, (report) => {
        delete report.summary.unchangedCount;
      });
      await assert.rejects(
        inspectCommittedUpstreamDrift(fixture),
        /change report summary must contain exactly/u,
      );
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  });

  await suite.test("fabricated deleted record with recomputed report and manifest hashes", async () => {
    const fixture = await createPublishedInspectionFixture();
    try {
      await rewriteChangeReport(fixture, (report, manifest) => {
        report.changes.deleted.push({
          id: "ghost/SKILL.md",
          skill: "ghost",
          format: "markdown",
          contentSha256: "0".repeat(64),
        });
        report.summary.deletedCount += 1;
        manifest.report.deletedCount += 1;
      });
      await assert.rejects(
        inspectCommittedUpstreamDrift(fixture),
        /does not match its retained from corpus/u,
      );
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  });

  await suite.test("missing retained from corpus", async () => {
    const fixture = await createDriftedInspectionFixture();
    try {
      const report = await readCommittedChangeReport(fixture);
      await rm(join(fixture.snapshotRoot, `corpus-${report.from.corpusSha256}.jsonl`));
      await assert.rejects(
        inspectCommittedUpstreamDrift(fixture),
        /retained from corpus could not be read/u,
      );
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  });

  await suite.test("retained from corpus hash mismatch", async () => {
    const fixture = await createDriftedInspectionFixture();
    try {
      const report = await readCommittedChangeReport(fixture);
      await writeFile(
        join(fixture.snapshotRoot, `corpus-${report.from.corpusSha256}.jsonl`),
        "corrupt\n",
        "utf8",
      );
      await assert.rejects(
        inspectCommittedUpstreamDrift(fixture),
        /retained from corpus failed whole-file integrity/u,
      );
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  });

  await suite.test("missing from pointer field with recomputed report hash", async () => {
    const fixture = await createDriftedInspectionFixture();
    try {
      await rewriteChangeReport(fixture, (report) => {
        delete report.from.recordCount;
      });
      await assert.rejects(
        inspectCommittedUpstreamDrift(fixture),
        /change report from pointer must contain exactly/u,
      );
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  });

  await suite.test("adaptation manifest mismatch", async () => {
    const fixture = await createPublishedInspectionFixture();
    try {
      const manifestPath = join(fixture.changesRoot, "manifest.json");
      const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
      manifest.adaptation.pendingCount += 1;
      await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
      await assert.rejects(
        inspectCommittedUpstreamDrift(fixture),
        /changes manifest adaptation contains invalid counts/u,
      );
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  });

  await suite.test("duplicate policy record id", async () => {
    const fixture = await createPublishedInspectionFixture();
    try {
      const policyPath = join(fixture.policyRoot, "alpha.json");
      const fragment = JSON.parse(await readFile(policyPath, "utf8"));
      fragment.records.push({ ...fragment.records[0] });
      await writeFile(policyPath, `${JSON.stringify(fragment, null, 2)}\n`, "utf8");
      await assert.rejects(
        inspectCommittedUpstreamDrift(fixture),
        /Duplicate canonical policy record id/u,
      );
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  });
});

test("new, changed, and deleted upstream files warn without failing or changing canonical output", async () => {
  const fixture = await createRepositoryFixture();
  const snapshotRoot = join(fixture.root, "dev/upstream-snapshot");
  const changesRoot = join(fixture.root, "dev/upstream-changes");
  const canonicalSentinel = join(fixture.root, "skills/figma-workspace/references/canonical-corpus/manifest.json");
  try {
    await mkdir(dirname(canonicalSentinel), { recursive: true });
    await writeFile(canonicalSentinel, "canonical-sentinel\n", "utf8");
    const first = await updateUpstreamSnapshot({
      repository: fixture.repository,
      snapshotRoot,
      changesRoot,
      policyRoot: fixture.policyRoot,
      expectedPolicyFragmentCount: 2,
      generatedAt,
    });
    await writeFile(join(fixture.worktree, "skills/alpha/SKILL.md"), "# Alpha revised\n", "utf8");
    await rm(join(fixture.worktree, "skills/alpha/scripts/example.js"));
    await writeFile(join(fixture.worktree, "skills/alpha/references/new.md"), "# New\n", "utf8");
    commitFixture(fixture, "upstream drift");

    const updateOptions = {
      repository: fixture.repository,
      snapshotRoot,
      changesRoot,
      policyRoot: fixture.policyRoot,
      expectedPolicyFragmentCount: 2,
      generatedAt: "2026-07-15T04:05:06.000Z",
    };
    const cliScript = [
      `import { runCli } from ${JSON.stringify(new URL("../scripts/update-upstream-corpus.mjs", import.meta.url).href)};`,
      `await runCli(["update-upstream-snapshot"], { updateOptions: ${JSON.stringify(updateOptions)} });`,
    ].join("\n");
    const cliResult = spawnSync(process.execPath, ["--input-type=module", "--eval", cliScript], {
      encoding: "utf8",
      windowsHide: true,
    });
    assert.equal(cliResult.status, 0, cliResult.stderr);
    assert.match(cliResult.stdout, /wrote 5 development snapshot records/u);
    assert.match(cliResult.stderr, /warning: upstream drift has 2 pending canonical adaptation record\(s\)/u);
    assert.match(cliResult.stderr, /alpha\/SKILL\.md \(changed\)/u);
    assert.match(cliResult.stderr, /alpha\/references\/new\.md \(new\)/u);
    assert.match(cliResult.stderr, /warning: upstream drift has 1 retired canonical policy record\(s\)/u);
    assert.match(cliResult.stderr, /alpha\/scripts\/example\.js/u);
    const second = await inspectCommittedUpstreamDrift({
      snapshotRoot,
      changesRoot,
      policyRoot: fixture.policyRoot,
      expectedPolicyFragmentCount: 2,
    });
    assert.deepEqual(second.report.summary, {
      newCount: 1,
      changedCount: 1,
      deletedCount: 1,
      unchangedCount: 3,
    });
    assert.deepEqual(second.report.changes.new.map(({ id }) => id), ["alpha/references/new.md"]);
    assert.deepEqual(second.report.changes.changed.map(({ id }) => id), ["alpha/SKILL.md"]);
    assert.deepEqual(second.report.changes.deleted.map(({ id }) => id), ["alpha/scripts/example.js"]);
    assert.deepEqual(
      second.report.adaptation.pendingRecords.map(({ id, drift }) => ({ id, drift })),
      [
        { id: "alpha/SKILL.md", drift: "changed" },
        { id: "alpha/references/new.md", drift: "new" },
      ],
    );
    assert.deepEqual(
      second.report.adaptation.retiredRecords.map(({ id }) => id),
      ["alpha/scripts/example.js"],
    );
    assert.deepEqual(second.changesManifest.adaptation, second.report.adaptation);
    assert.equal(second.report.from.resolvedCommit, first.manifest.upstream.resolvedCommit);
    assert.equal(await readFile(canonicalSentinel, "utf8"), "canonical-sentinel\n");

    assert.deepEqual(second.warnings, cliResult.stderr.trimEnd().split("\n"));
    assert.equal(
      (await readdir(snapshotRoot)).includes(first.manifest.corpus.file),
      true,
      "older content-addressed snapshot must be retained",
    );

    const repeated = await updateUpstreamSnapshot({
      repository: fixture.repository,
      snapshotRoot,
      changesRoot,
      policyRoot: fixture.policyRoot,
      expectedPolicyFragmentCount: 2,
      generatedAt: "2026-07-16T04:05:06.000Z",
    });
    assert.deepEqual(repeated.report.summary, {
      newCount: 0,
      changedCount: 0,
      deletedCount: 0,
      unchangedCount: 5,
    });
    assert.deepEqual(repeated.report.adaptation, second.report.adaptation);

    await writeAcceptedPolicies(fixture.policyRoot, {
      "alpha/SKILL.md": ["# Alpha revised\n", "router"],
      "alpha/references/guide.md": ["# Guide\n", "active"],
      "alpha/references/new.md": ["# New\n", "conditional"],
      "alpha/scripts/example.ts": ["export const value: number = 1;\n", "api"],
      "zeta/SKILL.md": ["# Zeta\nsecond line\n", "router"],
    });
    const adapted = await updateUpstreamSnapshot({
      repository: fixture.repository,
      snapshotRoot,
      changesRoot,
      policyRoot: fixture.policyRoot,
      expectedPolicyFragmentCount: 2,
      generatedAt: "2026-07-17T04:05:06.000Z",
    });
    assert.deepEqual(adapted.report.adaptation, {
      readyCount: 5,
      pendingCount: 0,
      retiredCount: 0,
      pendingRecords: [],
      retiredRecords: [],
    });
    assert.equal(await readFile(canonicalSentinel, "utf8"), "canonical-sentinel\n");
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("change-report failure restores the previous snapshot manifest and cleans temporaries", async () => {
  const fixture = await createRepositoryFixture();
  const snapshotRoot = join(fixture.root, "dev/upstream-snapshot");
  const changesRoot = join(fixture.root, "dev/upstream-changes");
  try {
    await updateUpstreamSnapshot({
      repository: fixture.repository,
      snapshotRoot,
      changesRoot,
      policyRoot: fixture.policyRoot,
      expectedPolicyFragmentCount: 2,
      generatedAt,
    });
    const oldSnapshotManifest = await readFile(join(snapshotRoot, "manifest.json"), "utf8");
    await writeFile(join(fixture.worktree, "skills/alpha/SKILL.md"), "# Changed\n", "utf8");
    commitFixture(fixture, "change");

    await assert.rejects(
      updateUpstreamSnapshot({
        repository: fixture.repository,
        snapshotRoot,
        changesRoot,
        policyRoot: fixture.policyRoot,
        expectedPolicyFragmentCount: 2,
        generatedAt: "2026-07-15T04:05:06.000Z",
        async changesRenameFile(source, target) {
          if (target === join(changesRoot, "manifest.json")) {
            throw new Error("injected change manifest failure");
          }
          await rename(source, target);
        },
      }),
      /injected change manifest failure/u,
    );
    assert.equal(await readFile(join(snapshotRoot, "manifest.json"), "utf8"), oldSnapshotManifest);
    assert.equal((await readdir(snapshotRoot)).some((file) => file.endsWith(".tmp")), false);
    assert.equal((await readdir(changesRoot)).some((file) => file.endsWith(".tmp")), false);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("directory sync failure after change manifest rename rolls back both manifests", async () => {
  const fixture = await createRepositoryFixture();
  const snapshotRoot = join(fixture.root, "dev/upstream-snapshot");
  const changesRoot = join(fixture.root, "dev/upstream-changes");
  try {
    await updateUpstreamSnapshot({
      repository: fixture.repository,
      snapshotRoot,
      changesRoot,
      policyRoot: fixture.policyRoot,
      expectedPolicyFragmentCount: 2,
      generatedAt,
    });
    const oldSnapshotManifest = await readFile(join(snapshotRoot, "manifest.json"), "utf8");
    const oldChangesManifest = await readFile(join(changesRoot, "manifest.json"), "utf8");
    await writeFile(join(fixture.worktree, "skills/alpha/SKILL.md"), "# Changed\n", "utf8");
    commitFixture(fixture, "change");

    let changesSyncCount = 0;
    await assert.rejects(
      updateUpstreamSnapshot({
        repository: fixture.repository,
        snapshotRoot,
        changesRoot,
        policyRoot: fixture.policyRoot,
        expectedPolicyFragmentCount: 2,
        generatedAt: "2026-07-15T04:05:06.000Z",
        async changesSyncDirectoryFn() {
          changesSyncCount += 1;
          if (changesSyncCount === 2) {
            throw new Error("injected post-manifest directory sync failure");
          }
        },
      }),
      /injected post-manifest directory sync failure/u,
    );
    assert.equal(changesSyncCount, 2);
    assert.equal(await readFile(join(snapshotRoot, "manifest.json"), "utf8"), oldSnapshotManifest);
    assert.equal(await readFile(join(changesRoot, "manifest.json"), "utf8"), oldChangesManifest);
    assert.equal((await readdir(snapshotRoot)).some((file) => file.endsWith(".tmp")), false);
    assert.equal((await readdir(changesRoot)).some((file) => file.endsWith(".tmp")), false);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

async function rewriteChangeReport(fixture, mutate) {
  const manifestPath = join(fixture.changesRoot, "manifest.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  const report = JSON.parse(await readFile(join(fixture.changesRoot, manifest.report.file), "utf8"));
  mutate(report, manifest);
  const reportText = `${JSON.stringify(report, null, 2)}\n`;
  const reportSha256 = sha256(reportText);
  manifest.report.file = `report-${reportSha256}.json`;
  manifest.report.sha256 = reportSha256;
  await writeFile(join(fixture.changesRoot, manifest.report.file), reportText, "utf8");
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
}

async function readCommittedChangeReport(fixture) {
  const manifest = JSON.parse(await readFile(join(fixture.changesRoot, "manifest.json"), "utf8"));
  return JSON.parse(await readFile(join(fixture.changesRoot, manifest.report.file), "utf8"));
}

async function createDriftedInspectionFixture() {
  const fixture = await createRepositoryFixture();
  const snapshotRoot = join(fixture.root, "dev/upstream-snapshot");
  const changesRoot = join(fixture.root, "dev/upstream-changes");
  await updateUpstreamSnapshot({
    repository: fixture.repository,
    snapshotRoot,
    changesRoot,
    policyRoot: fixture.policyRoot,
    expectedPolicyFragmentCount: 2,
    generatedAt,
  });
  await writeFile(join(fixture.worktree, "skills/alpha/SKILL.md"), "# Alpha revised\n", "utf8");
  commitFixture(fixture, "drifted inspection fixture");
  await updateUpstreamSnapshot({
    repository: fixture.repository,
    snapshotRoot,
    changesRoot,
    policyRoot: fixture.policyRoot,
    expectedPolicyFragmentCount: 2,
    generatedAt: "2026-07-15T04:05:06.000Z",
  });
  return {
    root: fixture.root,
    snapshotRoot,
    changesRoot,
    policyRoot: fixture.policyRoot,
    expectedPolicyFragmentCount: 2,
  };
}

async function createPublishedInspectionFixture() {
  const fixture = await createRepositoryFixture();
  const snapshotRoot = join(fixture.root, "dev/upstream-snapshot");
  const changesRoot = join(fixture.root, "dev/upstream-changes");
  await updateUpstreamSnapshot({
    repository: fixture.repository,
    snapshotRoot,
    changesRoot,
    policyRoot: fixture.policyRoot,
    expectedPolicyFragmentCount: 2,
    generatedAt,
  });
  return {
    root: fixture.root,
    snapshotRoot,
    changesRoot,
    policyRoot: fixture.policyRoot,
    expectedPolicyFragmentCount: 2,
  };
}

async function createRepositoryFixture() {
  const root = await mkdtemp(join(tmpdir(), "figma-upstream-snapshot-fixture-"));
  const worktree = join(root, "repository");
  await mkdir(worktree);
  git(worktree, ["init", "--quiet", "--initial-branch=main"]);
  git(worktree, ["config", "user.name", "Snapshot Test"]);
  git(worktree, ["config", "user.email", "snapshot-test@example.invalid"]);
  git(worktree, ["config", "core.autocrlf", "false"]);
  const files = {
    "skills/zeta/SKILL.md": "# Zeta\r\nsecond line\r\n",
    "skills/alpha/SKILL.md": "# Alpha\n",
    "skills/alpha/references/guide.md": "# Guide\n",
    "skills/alpha/scripts/example.ts": "export const value: number = 1;\n",
    "skills/alpha/scripts/example.js": "export const value = 1;\n",
    "workflow-skills/video-interaction-mapper/SKILL.md": "# Video\n",
    "workflow-skills/generate-project-plan/SKILL.md": "# Plan\n",
  };
  for (const [path, content] of Object.entries(files)) {
    const target = join(worktree, ...path.split("/"));
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, content, "utf8");
  }
  git(worktree, ["add", "--all"]);
  git(worktree, ["commit", "--quiet", "-m", "fixture"]);
  const remote = join(root, "remote.git");
  git(root, ["init", "--bare", "--quiet", remote]);
  const repository = pathToFileURL(remote).href;
  git(worktree, ["remote", "add", "origin", repository]);
  git(worktree, ["push", "--quiet", "origin", "main"]);
  const policyRoot = join(root, "canonical-policy");
  await writeAcceptedPolicies(policyRoot, {
    "alpha/SKILL.md": ["# Alpha\n", "router"],
    "alpha/references/guide.md": ["# Guide\n", "active"],
    "alpha/scripts/example.js": ["export const value = 1;\n", "examples"],
    "alpha/scripts/example.ts": ["export const value: number = 1;\n", "api"],
    "zeta/SKILL.md": ["# Zeta\nsecond line\n", "router"],
  });
  return {
    root,
    repository,
    worktree,
    policyRoot,
    commit: git(worktree, ["rev-parse", "HEAD"]).stdout.trim(),
  };
}

function commitFixture(fixture, message) {
  git(fixture.worktree, ["add", "--all"]);
  git(fixture.worktree, ["commit", "--quiet", "-m", message]);
  git(fixture.worktree, ["push", "--quiet", "origin", "main"]);
}

async function writeAcceptedPolicies(policyRoot, records) {
  await mkdir(policyRoot, { recursive: true });
  const bySkill = new Map();
  for (const [id, [source, classification]] of Object.entries(records)) {
    const skill = id.split("/")[0];
    const skillRecords = bySkill.get(skill) ?? [];
    skillRecords.push({
      id,
      sourceContentSha256: sha256(source),
      classification,
    });
    bySkill.set(skill, skillRecords);
  }
  const existing = await readdir(policyRoot);
  await Promise.all(existing.map((file) => rm(join(policyRoot, file), { force: true })));
  for (const [skill, skillRecords] of bySkill) {
    await writeFile(join(policyRoot, `${skill}.json`), `${JSON.stringify({
      schemaVersion: 1,
      skill,
      records: skillRecords,
    }, null, 2)}\n`, "utf8");
  }
}

function git(cwd, args) {
  const result = spawnSync("git", args, { cwd, encoding: "utf8", windowsHide: true });
  assert.equal(result.status, 0, result.stderr || `git ${args.join(" ")} failed`);
  return result;
}

function parseJsonl(text) {
  return text.trimEnd().split("\n").filter(Boolean).map((line) => JSON.parse(line));
}

function sha256(value) {
  return createHash("sha256").update(value, "utf8").digest("hex");
}
