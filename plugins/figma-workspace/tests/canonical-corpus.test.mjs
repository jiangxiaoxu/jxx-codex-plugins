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
import { fileURLToPath } from "node:url";
import test from "node:test";
import {
  buildCanonicalCorpus,
  readCanonicalRouteCatalog,
} from "../scripts/lib/canonical-corpus.mjs";

const generatedAt = "2026-07-14T04:05:06.000Z";
const pluginRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

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
    assert.equal(manifest.schemaVersion, 2);
    assert.deepEqual(manifest.inventories, {
      classifications: {
        active: 1,
        conditional: 0,
        examples: 1,
        router: 1,
      },
      surfaces: {
        design: 3,
        figjam: 0,
        slides: 0,
      },
      taskFamilies: {
        "alpha-task": 3,
      },
    });
    assert.deepEqual(manifest.routeCatalog, {
      file: "routes.json",
      schemaVersion: 1,
      routeCount: 1,
      sha256: sha256(await readFile(join(fixture.canonicalRoot, "routes.json"), "utf8")),
    });
    assert.deepEqual(manifest.reviewWarnings, []);
    assert.deepEqual(manifest.corpus, {
      file: `corpus-${sha256(corpusText)}.jsonl`,
      recordCount: 3,
      sha256: sha256(corpusText),
    });
    assert.deepEqual((await readdir(fixture.canonicalRoot)).sort(), [
      manifest.corpus.file,
      "manifest.json",
      "routes.json",
    ].sort());
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
      assert.equal(record.schemaVersion, 2);
      assert.equal(record.format, "markdown");
      assert.equal(record.sanitized, true);
      assert.equal(record.contentSha256, sha256(record.text));
      assert.equal(record.taskFamily, "alpha-task");
      assert.deepEqual(record.surfaces, ["design"]);
      assert.equal(typeof record.mappingProfile, "string");
      assert.equal(typeof record.title, "string");
      assert.equal(typeof record.summary, "string");
      assert.ok(record.title.length > 0 && record.title.length <= 120);
      assert.ok(record.summary.length > 0 && record.summary.length <= 240);
      assert.equal("sourceContentSha256" in record, false);
    }
    assert.deepEqual(
      records.map(({ id, title, summary }) => ({ id, title, summary })),
      [
        {
          id: "alpha/SKILL.md",
          title: "Canonical router",
          summary: "Route Alpha tasks to the canonical workflow.",
        },
        {
          id: "alpha/examples/create-card.md",
          title: "Create a card",
          summary: "Create the card with the native Plugin API.",
        },
        {
          id: "alpha/references/guide.md",
          title: "Canonical safe guide",
          summary: "Use the safe canonical workflow.",
        },
      ],
    );
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
    await mkdir(join(rawRoot, "docs/alpha"), { recursive: true });
    await writeFile(
      join(rawRoot, "docs/alpha/SKILL.md"),
      "# Archived upstream\n\n[Relative](../missing.md) scriptExecutionSucceeded; failed scripts are atomic.\n",
      "utf8",
    );
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
    const mirror = join(fixture.sourceRoot, ...policy.mirrorPath.split("/"));
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
          join(fixture.sourceRoot, "docs/alpha/examples/create-card.md"),
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

test("canonical authoring validator accepts resolvable links and ignores code examples", async () => {
  const fixture = await createFixture();
  try {
    await writeFile(
      join(fixture.sourceRoot, "docs/alpha/references/guide.md"),
      [
        "# Canonical safe guide",
        "",
        "Use the [router](canonical:alpha/SKILL.md), the [recovery section](#details--recovery),",
        "and an [external reference](https://example.invalid/path_(one)).",
        "The [router reference][router] and <a href=\"canonical:alpha/SKILL.md\">raw link</a> are valid.",
        "",
        "[router]: canonical:alpha/SKILL.md",
        "",
        "## Details & Recovery",
        "",
        "Never blindly rerun a mutation; inspect, read back, and reconcile first.",
        "",
        "`[ignored relative link](../missing.md) failed scripts are atomic`",
        "`<a href=\"../ignored.md\">ignored raw link</a>`",
        "",
        "```md",
        "[ignored canonical link](canonical:missing.md)",
        "Immediately retry the mutation because failed scripts are atomic.",
        "```",
        "",
      ].join("\n"),
      "utf8",
    );
    const result = await buildFixture(fixture, { publish: false });
    assert.equal(result.records.length, 3);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("canonical authoring links fail closed before publication", async (t) => {
  for (const [name, text, pattern] of [
    [
      "unknown canonical record",
      "# Guide\n\nRead [missing](canonical:alpha/references/missing.md).\n",
      /targets an unknown record/u,
    ],
    [
      "relative cross-document link",
      "# Guide\n\nRead [router](..\/SKILL.md).\n",
      /must use canonical:<record-id>/u,
    ],
    [
      "unknown same-document anchor",
      "# Guide\n\nRead [missing](#not-a-heading).\n",
      /unknown same-document anchor/u,
    ],
    [
      "canonical record fragment",
      "# Guide\n\nRead [router section](canonical:alpha\/SKILL.md#workflow).\n",
      /must not include a fragment/u,
    ],
    [
      "reference-style relative link",
      "# Guide\n\nRead [router][target].\n\n[target]: ..\/SKILL.md\n",
      /must use canonical:<record-id>/u,
    ],
    [
      "reference-style unknown canonical record",
      "# Guide\n\nRead [missing][target].\n\n[target]: canonical:alpha\/missing.md\n",
      /targets an unknown record/u,
    ],
    [
      "nested label relative link",
      "# Guide\n\nRead [outer [inner label]](..\/SKILL.md).\n",
      /must use canonical:<record-id>/u,
    ],
    [
      "raw HTML relative href",
      "# Guide\n\n<a href=\"../SKILL.md\">Router</a>\n",
      /must use canonical:<record-id>/u,
    ],
    [
      "raw HTML unknown canonical href",
      "# Guide\n\n<a href='canonical:alpha/missing.md'>Missing</a>\n",
      /targets an unknown record/u,
    ],
  ]) {
    await t.test(name, async () => {
      const fixture = await createFixture();
      try {
        await writeFile(
          join(fixture.sourceRoot, "docs/alpha/references/guide.md"),
          text,
          "utf8",
        );
        await assert.rejects(buildFixture(fixture), pattern);
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

test("same-document heading anchors use globally occupied GitHub slug collisions", async () => {
  const fixture = await createFixture();
  try {
    await writeFile(
      join(fixture.sourceRoot, "docs/alpha/references/guide.md"),
      [
        "# Guide",
        "",
        "## Collision",
        "",
        "## Collision-1",
        "",
        "## Collision",
        "",
        "Read the [third collision](#collision-2).",
        "",
      ].join("\n"),
      "utf8",
    );
    const result = await buildFixture(fixture, { publish: false });
    assert.equal(result.records.length, 3);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("committed canonical corpus matches a publish-free rebuild", async () => {
  const sourceRoot = join(pluginRoot, "dev/canonical-corpus-source");
  const canonicalRoot = join(
    pluginRoot,
    "skills/figma-workspace/references/canonical-corpus",
  );
  const committedManifest = JSON.parse(
    await readFile(join(canonicalRoot, "manifest.json"), "utf8"),
  );
  const result = await buildCanonicalCorpus({
    sourceRoot,
    publishRoot: canonicalRoot,
    publish: false,
    generatedAt: committedManifest.generatedAt,
  });
  const rebuiltCorpus = `${result.records.map((record) => JSON.stringify(record)).join("\n")}\n`;
  assert.deepEqual(result.manifest.corpus, committedManifest.corpus);
  assert.deepEqual(result.manifest.integrity, committedManifest.integrity);
  assert.equal(
    await readFile(join(canonicalRoot, committedManifest.corpus.file), "utf8"),
    rebuiltCorpus,
  );
  assert.deepEqual(
    result.records.map((record) => record.id),
    Object.keys(committedManifest.integrity.contentHashes).sort(),
  );
});

test("canonical authoring legacy execution and retry guidance fail closed", async (t) => {
  for (const [name, statement, pattern] of [
    [
      "legacy execution field",
      "Capture reports `scriptExecutionSucceeded: true` after execution.",
      /legacy scriptExecutionSucceeded/u,
    ],
    [
      "legacy executed result field",
      "The result contains `executed: true` after execution.",
      /legacy executed result field/u,
    ],
    [
      "unsafe atomic claim",
      "Failed scripts are atomic, so nothing changes.",
      /unsafe atomic or direct-retry guidance/u,
    ],
    [
      "unsafe direct retry",
      "Retry the corrected script after any script error.",
      /unsafe atomic or direct-retry guidance/u,
    ],
    [
      "unsafe no-partial-effects claim",
      "Repair TypeScript diagnostics before rerunning; failed runs make no partial board edits.",
      /unsafe atomic or direct-retry guidance/u,
    ],
  ]) {
    await t.test(name, async () => {
      const fixture = await createFixture();
      try {
        await writeFile(
          join(fixture.sourceRoot, "docs/alpha/references/guide.md"),
          `# Guide\n\n${statement}\n`,
          "utf8",
        );
        await assert.rejects(buildFixture(fixture), pattern);
      } finally {
        await rm(fixture.root, { recursive: true, force: true });
      }
    });
  }
});

test("canonical authoring permits ordinary executed variable assignments", async () => {
  const fixture = await createFixture();
  try {
    await writeFile(
      join(fixture.sourceRoot, "docs/alpha/references/guide.md"),
      "# Guide\n\n```ts\nlet executed = true;\n```\n",
      "utf8",
    );
    await assert.doesNotReject(buildFixture(fixture));
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("policy and mirror errors fail closed", async (t) => {
  await t.test("source and publish roots overlap", async () => {
    const fixture = await createFixture();
    try {
      await assert.rejects(
        buildCanonicalCorpus({
          sourceRoot: fixture.canonicalRoot,
          publishRoot: fixture.canonicalRoot,
        }),
        /sourceRoot and publishRoot must be separate/u,
      );
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  });

  await t.test("publish root contains an authoring directory", async () => {
    const fixture = await createFixture();
    try {
      await mkdir(join(fixture.canonicalRoot, "docs"));
      await assert.rejects(buildFixture(fixture), /publishRoot must contain runtime files only/u);
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  });

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
      await rm(join(fixture.sourceRoot, "docs/alpha/references/guide.md"));
      await assert.rejects(buildFixture(fixture), /Unable to read canonical mirror/u);
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  });

  await t.test("invalid mirror UTF-8", async () => {
    const fixture = await createFixture();
    try {
      await writeFile(
        join(fixture.sourceRoot, "docs/alpha/references/guide.md"),
        Buffer.from([0xc3, 0x28]),
      );
      await assert.rejects(buildFixture(fixture), /not valid UTF-8/u);
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  });

  await t.test("unknown policy surface", async () => {
    const fixture = await createFixture();
    try {
      fixture.policyRecords[0].surfaces = ["whiteboard"];
      await writePolicy(fixture);
      await assert.rejects(buildFixture(fixture), /Unknown policy record .* surface/u);
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  });

  await t.test("route and policy surface mismatch", async () => {
    const fixture = await createFixture();
    try {
      fixture.route.routes[0].surfaces = ["figjam"];
      await writeRoutes(fixture);
      await assert.rejects(buildFixture(fixture), /route surfaces do not match policy surfaces/u);
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  });
});

test("route catalog schema and fixed task-family coverage fail closed", async (t) => {
  await t.test("old schema", async () => {
    const fixture = await createFixture();
    try {
      fixture.route.schemaVersion = 0;
      await writeRoutes(fixture);
      await assert.rejects(buildFixture(fixture), /schemaVersion must be 1/u);
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  });

  await t.test("unknown task family", async () => {
    const fixture = await createFixture();
    try {
      fixture.route.routes[0].taskFamily = "unknown-task";
      await writeRoutes(fixture);
      await assert.rejects(buildFixture(fixture), /Unknown canonical task family/u);
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  });

  await t.test("duplicate alias", async () => {
    const fixture = await createFixture();
    try {
      fixture.route.routes[0].aliases.push("alpha-task");
      await writeRoutes(fixture);
      await assert.rejects(buildFixture(fixture), /Duplicate canonical route alias/u);
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  });

  await t.test("non-English alias", async () => {
    const fixture = await createFixture();
    try {
      fixture.route.routes[0].aliases = ["alpha task", "设计"];
      await writeRoutes(fixture);
      await assert.rejects(buildFixture(fixture), /compact English ASCII text/u);
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  });

  await t.test("unsorted task families", async () => {
    const fixture = await createFixture();
    try {
      fixture.route.routes = [
        {
          taskFamily: "zeta-task",
          skill: "zeta",
          surfaces: ["design"],
          canonicalQuery: "complete a Zeta task",
          aliases: ["zeta task"],
        },
        fixture.route.routes[0],
      ];
      await writeRoutes(fixture);
      await assert.rejects(
        readCanonicalRouteCatalog(fixture.canonicalRoot, {
          expectedTaskFamilies: ["alpha-task", "zeta-task"],
        }),
        /strictly sorted by taskFamily/u,
      );
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  });
});

test("route catalog reader returns the validated shared route source", async () => {
  const fixture = await createFixture();
  try {
    assert.deepEqual(await readCanonicalRouteCatalog(fixture.canonicalRoot, {
      expectedTaskFamilies: ["alpha-task"],
    }), fixture.route);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("manifest-last publication retains old content and cleans failed temporaries", async () => {
  const fixture = await createFixture();
  try {
    const first = await buildFixture(fixture);
    const oldManifest = await readFile(join(fixture.canonicalRoot, "manifest.json"), "utf8");
    await writeFile(
      join(fixture.sourceRoot, "docs/alpha/references/guide.md"),
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

test("successful publication removes corpus files not referenced by the current manifest", async () => {
  const fixture = await createFixture();
  try {
    const first = await buildFixture(fixture);
    await writeFile(
      join(fixture.sourceRoot, "docs/alpha/references/guide.md"),
      "# Revised canonical guide\n\nUse the revised safe workflow.\n",
      "utf8",
    );
    const second = await buildFixture(fixture);
    assert.notEqual(first.manifest.corpus.file, second.manifest.corpus.file);
    const files = await readdir(fixture.canonicalRoot);
    assert.deepEqual(
      files.filter((file) => /^corpus-[0-9a-f]{64}\.jsonl$/u.test(file)),
      [second.manifest.corpus.file],
    );
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

async function createFixture() {
  const root = await mkdtemp(join(tmpdir(), "figma-canonical-corpus-"));
  const canonicalRoot = join(root, "canonical-corpus");
  const sourceRoot = join(root, "canonical-corpus-source");
  const mirrors = {
    "docs/alpha/SKILL.md": "# Canonical router\n\nRoute Alpha tasks to the canonical workflow.\n",
    "docs/alpha/references/guide.md": "# Canonical safe guide\n\nUse the safe canonical workflow.\n",
    "docs/alpha/examples/create-card.md": "# Create a card\n\nCreate the card with the native Plugin API.\n\n```ts\nconst card = figma.createFrame();\n```\n",
  };
  for (const [path, text] of Object.entries(mirrors)) {
    const target = join(sourceRoot, ...path.split("/"));
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
  const route = {
    schemaVersion: 1,
    routes: [{
      taskFamily: "alpha-task",
      skill: "alpha",
      surfaces: ["design"],
      canonicalQuery: "complete an Alpha task",
      aliases: ["alpha task"],
    }],
  };
  const fixture = { root, canonicalRoot, sourceRoot, policyRecords, route };
  await writeRoutes(fixture);
  await writePolicy(fixture);
  return fixture;
}

async function buildFixture(fixture, options = {}) {
  return buildCanonicalCorpus({
    sourceRoot: fixture.sourceRoot,
    publishRoot: fixture.canonicalRoot,
    generatedAt,
    expectedPolicyFragmentCount: 1,
    expectedPublishedRecordCount: 3,
    expectedTaskFamilies: ["alpha-task"],
    source: {
      repository: "https://example.invalid/figma.git",
      resolvedCommit: "a".repeat(40),
    },
    ...options,
  });
}

async function writeRoutes(fixture) {
  await mkdir(fixture.canonicalRoot, { recursive: true });
  await writeFile(
    join(fixture.canonicalRoot, "routes.json"),
    `${JSON.stringify(fixture.route, null, 2)}\n`,
    "utf8",
  );
}

async function writePolicy(fixture) {
  const policyRoot = join(fixture.sourceRoot, "policy");
  await mkdir(policyRoot, { recursive: true });
  await writeFile(join(policyRoot, "alpha.json"), `${JSON.stringify({
    schemaVersion: 1,
    skill: "alpha",
    records: fixture.policyRecords,
  }, null, 2)}\n`, "utf8");
}

function policyRecord(id, source, classification, mirrorPath) {
  const mappingProfile = classification === "examples"
    ? "canonical-typescript-example"
    : classification === "api"
      ? "exact-plugin-api"
      : "plugin-api";
  return {
    id,
    sourceContentSha256: sha256(source),
    classification,
    state: "ready",
    ...(mirrorPath === undefined ? {} : { mirrorPath }),
    sourceContract: "figma-mcp",
    targetContract: "figma-workspace-cli",
    surfaces: ["design"],
    mappingProfile,
  };
}

function parseJsonl(text) {
  return text.trimEnd().split("\n").filter(Boolean).map((line) => JSON.parse(line));
}

function sha256(value) {
  return createHash("sha256").update(value, "utf8").digest("hex");
}
