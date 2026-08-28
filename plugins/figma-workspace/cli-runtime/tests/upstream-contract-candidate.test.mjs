import assert from "node:assert/strict";
import { mkdtemp, readFile, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";
import {
  captureFigmaUpstreamContractCandidate,
  checkFigmaUpstreamContractCandidate,
  createFigmaUpstreamContractSemanticReport,
  inspectFigmaUpstreamWrapperCoverage,
  promoteFigmaUpstreamContractCandidate,
  reportFigmaUpstreamContractCandidate,
  serializeFigmaUpstreamContractSnapshot,
} from "../dist/upstream/node-upstream-client.js";

test("semantic report aligns resources and templates by stable identity", () => {
  const baseline = snapshot({
    resources: [{ uri: "figma://b", title: "before" }, { uri: "figma://c", title: "same" }],
    resourceTemplates: [{ uriTemplate: "figma://{b}", title: "before" }],
  });
  const candidate = snapshot({
    resources: [
      { uri: "figma://a", title: "added" },
      { uri: "figma://b", title: "after" },
      { uri: "figma://c", title: "same" },
    ],
    resourceTemplates: [
      { uriTemplate: "figma://{a}", title: "added" },
      { uriTemplate: "figma://{b}", title: "before" },
    ],
  });
  const report = createFigmaUpstreamContractSemanticReport({
    candidateId: "stable-identity",
    baselineSha256: "a".repeat(64),
    candidateSnapshotSha256: "b".repeat(64),
    baseline,
    candidate,
  });
  assert.deepEqual(
    report.entities.map(({ kind, id, status }) => ({ kind, id, status })),
    [
      { kind: "resource", id: "figma://a", status: "added" },
      { kind: "resource", id: "figma://b", status: "changed" },
      { kind: "resourceTemplate", id: "figma://{a}", status: "added" },
    ],
  );
});

test("wrapper coverage requires every declared property to have one valid parameter-matrix classification", () => {
  const upstream = snapshot({
    tools: {
      example: {
        name: "example",
        inputSchema: { properties: { optionalFlag: { type: "boolean" } } },
      },
    },
  });
  const contract = {
    toolName: "figma_workspace_get_metadata",
    category: "thin-wrapper",
    upstreamToolName: "example",
    optionalUpstreamProperties: ["optionalFlag"],
    parameterMatrix: {
      requiredUpstream: [],
      publicPassthrough: [],
      derivedUpstream: [],
      fixedUpstream: [],
      passthroughOptional: [],
      hiddenUpstreamOptional: [],
    },
    targetSupport: "none",
    outputPolicy: { inlineLimitFields: [], debugFiles: [], upstreamEnvelope: false },
  };
  assert.deepEqual(
    inspectFigmaUpstreamWrapperCoverage(upstream, [contract], ["example"])
      .map((issue) => issue.code),
    ["wrapper-optional-classification-invalid", "wrapper-property-unclassified"],
  );
  contract.parameterMatrix.hiddenUpstreamOptional.push("optionalFlag");
  assert.deepEqual(inspectFigmaUpstreamWrapperCoverage(upstream, [contract], ["example"]), []);
});

test("wrapper coverage enforces per-wrapper public nodeId pattern parity", () => {
  const simpleNodeIdPattern = "^\\d+[:-]\\d+$";
  const compositeNodeIdPattern = "^(?:\\d+[:-]\\d+|[IT]\\d+[:-]\\d+(?:;\\d+[:-]\\d+)*)$";
  const upstream = (nodeIdPattern) => snapshot({
    tools: {
      example: {
        name: "example",
        inputSchema: {
          required: ["fileKey", "nodeId"],
          properties: {
            fileKey: { type: "string", pattern: "^[0-9a-zA-Z]{22,128}$" },
            nodeId: { type: "string", pattern: nodeIdPattern },
          },
        },
      },
    },
  });
  const contract = (toolName) => ({
    toolName,
    category: "thin-wrapper",
    upstreamToolName: "example",
    requiredUpstreamProperties: ["fileKey", "nodeId"],
    parameterMatrix: {
      requiredUpstream: ["fileKey", "nodeId"],
      publicPassthrough: [],
      derivedUpstream: ["fileKey", "nodeId"],
      fixedUpstream: [],
      passthroughOptional: [],
      hiddenUpstreamOptional: [],
    },
    targetSupport: "node-scoped",
    outputPolicy: { inlineLimitFields: [], debugFiles: [], upstreamEnvelope: false },
  });
  const mismatch = (snapshotValue, toolName) =>
    inspectFigmaUpstreamWrapperCoverage(snapshotValue, [contract(toolName)], ["example"])
      .filter((issue) => issue.code === "wrapper-constraint-mismatch");

  assert.deepEqual(
    mismatch(upstream(compositeNodeIdPattern), "figma_workspace_get_motion_context")
      .map(({ property, upstreamValue, publicValue }) => ({ property, upstreamValue, publicValue })),
    [{ property: "nodeId", upstreamValue: compositeNodeIdPattern, publicValue: simpleNodeIdPattern }],
  );
  assert.deepEqual(
    mismatch(upstream(simpleNodeIdPattern), "figma_workspace_get_metadata")
      .map(({ property, upstreamValue, publicValue }) => ({ property, upstreamValue, publicValue })),
    [{ property: "nodeId", upstreamValue: simpleNodeIdPattern, publicValue: compositeNodeIdPattern }],
  );
  assert.deepEqual(
    mismatch(upstream(simpleNodeIdPattern), "figma_workspace_get_motion_context"),
    [],
  );
  assert.deepEqual(
    mismatch(upstream(compositeNodeIdPattern), "figma_workspace_get_metadata"),
    [],
  );
});

test("design-context wrapper coverage classifies upstream skillNames as hidden", () => {
  const upstream = snapshot({
    tools: {
      get_design_context: {
        name: "get_design_context",
        inputSchema: {
          type: "object",
          required: ["fileKey", "nodeId"],
          properties: Object.fromEntries([
            "fileKey", "nodeId", "clientLanguages", "clientFrameworks", "forceCode",
            "disableCodeConnect", "excludeScreenshot", "skillNames",
          ].map((property) => [property, { type: "string" }])),
        },
      },
    },
  });
  assert.deepEqual(
    inspectFigmaUpstreamWrapperCoverage(upstream)
      .filter((issue) => issue.wrapperToolName === "figma_workspace_get_design_context"),
    [],
  );
});

test("candidate wrapper coverage remains complete after upload_assets nodeIds adaptation", () => {
  assert.deepEqual(inspectFigmaUpstreamWrapperCoverage(wrapperCompatibleSnapshot()), []);
});

test("required and enum reorder are set-equivalent while type and unknown drift stay blocking", () => {
  const baseline = snapshot({
    tools: {
      example: {
        name: "example",
        inputSchema: {
          required: ["b", "a"],
          properties: { mode: { type: "string", enum: ["z", "a"] } },
        },
        annotations: { custom: "before" },
      },
    },
  });
  const reordered = structuredClone(baseline);
  reordered.tools.example.inputSchema.required = ["a", "b"];
  reordered.tools.example.inputSchema.properties.mode.enum = ["a", "z"];
  const reorderedReport = createFigmaUpstreamContractSemanticReport({
    candidateId: "set-reorder",
    baselineSha256: "a".repeat(64),
    candidateSnapshotSha256: "b".repeat(64),
    baseline,
    candidate: reordered,
  });
  assert.equal(reorderedReport.entities.length, 0);

  const changed = structuredClone(reordered);
  changed.tools.example.inputSchema.properties.mode.type = "number";
  changed.tools.example.annotations.custom = "after";
  const changedReport = createFigmaUpstreamContractSemanticReport({
    candidateId: "blocking-classes",
    baselineSha256: "a".repeat(64),
    candidateSnapshotSha256: "b".repeat(64),
    baseline,
    candidate: changed,
  });
  assert.deepEqual(
    changedReport.entities[0].changes.map((change) => [change.class, change.behaviorBlocking]),
    [["unclassified", true], ["type", true]],
  );
  assert.equal(changedReport.summary.unresolvedChanges, 2);
});

test("candidate report and check preserve accepted snapshot until guarded promotion", async () => {
  const root = await mkdtemp(resolve(tmpdir(), "figma-contract-candidate-"));
  const acceptedSnapshotPath = resolve(root, "accepted.json");
  const candidateRoot = resolve(root, "candidates");
  try {
    const accepted = wrapperCompatibleSnapshot();
    const candidate = structuredClone(accepted);
    candidate.tools.get_metadata.description = "Candidate metadata description.";
    const acceptedSource = serializeFigmaUpstreamContractSnapshot(accepted);
    await writeFile(acceptedSnapshotPath, acceptedSource, "utf8");
    await captureFigmaUpstreamContractCandidate({
      candidateRoot,
      candidateId: "metadata-adaptation",
      acceptedSnapshotPath,
      snapshot: candidate,
    });
    const report = await reportFigmaUpstreamContractCandidate({
      candidateRoot,
      candidateId: "metadata-adaptation",
      acceptedSnapshotPath,
    });
    assert.equal(report.summary.changed, 1);
    assert.equal(report.summary.wrapperCoverageBlockers, 0);
    assert.ok(report.summary.unresolvedChanges > 0);
    assert.equal(await readFile(acceptedSnapshotPath, "utf8"), acceptedSource);
    await assert.rejects(
      checkFigmaUpstreamContractCandidate({
        candidateRoot,
        candidateId: "metadata-adaptation",
        acceptedSnapshotPath,
      }),
      /unresolved semantic change/iu,
    );
    const dispositions = {
      schemaVersion: 1,
      candidateId: "metadata-adaptation",
      dispositions: report.entities.flatMap((entity) => entity.changes.map((change) => ({
        changeId: change.changeId,
        decision: "adapted-wrapper",
        rationale: "Removed unsupported metadata passthrough.",
      }))),
    };
    const disposedReport = await reportFigmaUpstreamContractCandidate({
      candidateRoot,
      candidateId: "metadata-adaptation",
      acceptedSnapshotPath,
      dispositions,
    });
    assert.equal(disposedReport.summary.unresolvedChanges, 0);
    await checkFigmaUpstreamContractCandidate({
      candidateRoot,
      candidateId: "metadata-adaptation",
      acceptedSnapshotPath,
    });
    await promoteFigmaUpstreamContractCandidate({
      candidateRoot,
      candidateId: "metadata-adaptation",
      acceptedSnapshotPath,
    });
    assert.equal(
      await readFile(acceptedSnapshotPath, "utf8"),
      serializeFigmaUpstreamContractSnapshot(candidate),
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("candidate re-report preserves stored dispositions and rejects invalid replacements", async () => {
  const root = await mkdtemp(resolve(tmpdir(), "figma-contract-dispositions-"));
  const acceptedSnapshotPath = resolve(root, "accepted.json");
  const candidateRoot = resolve(root, "candidates");
  const candidateId = "preserve-dispositions";
  try {
    const accepted = wrapperCompatibleSnapshot();
    const candidate = structuredClone(accepted);
    candidate.tools.get_metadata.description = "Candidate metadata description.";
    await writeFile(acceptedSnapshotPath, serializeFigmaUpstreamContractSnapshot(accepted), "utf8");
    await captureFigmaUpstreamContractCandidate({
      candidateRoot,
      candidateId,
      acceptedSnapshotPath,
      snapshot: candidate,
    });
    const initialReport = await reportFigmaUpstreamContractCandidate({
      candidateRoot,
      candidateId,
      acceptedSnapshotPath,
    });
    const disposition = initialReport.entities[0].changes[0];
    const storedDispositions = {
      schemaVersion: 1,
      candidateId,
      dispositions: [{
        changeId: disposition.changeId,
        decision: "adapted-wrapper",
        rationale: "Reviewed and adapted in the wrapper contract.",
      }],
    };
    await reportFigmaUpstreamContractCandidate({
      candidateRoot,
      candidateId,
      acceptedSnapshotPath,
      dispositions: storedDispositions,
    });
    const preservedReport = await reportFigmaUpstreamContractCandidate({
      candidateRoot,
      candidateId,
      acceptedSnapshotPath,
    });
    assert.equal(preservedReport.summary.unresolvedChanges, 0);
    assert.equal(
      preservedReport.entities[0].changes[0].disposition.decision,
      "adapted-wrapper",
    );

    const replacementDispositions = {
      ...storedDispositions,
      dispositions: [{
        ...storedDispositions.dispositions[0],
        decision: "accepted-upstream",
      }],
    };
    await reportFigmaUpstreamContractCandidate({
      candidateRoot,
      candidateId,
      acceptedSnapshotPath,
      dispositions: replacementDispositions,
    });
    assert.equal(
      (await reportFigmaUpstreamContractCandidate({
        candidateRoot,
        candidateId,
        acceptedSnapshotPath,
      })).entities[0].changes[0].disposition.decision,
      "accepted-upstream",
    );

    await assert.rejects(
      reportFigmaUpstreamContractCandidate({
        candidateRoot,
        candidateId,
        acceptedSnapshotPath,
        dispositions: { ...replacementDispositions, schemaVersion: 2 },
      }),
      /Disposition file .* invalid/iu,
    );
    await assert.rejects(
      reportFigmaUpstreamContractCandidate({
        candidateRoot,
        candidateId,
        acceptedSnapshotPath,
        dispositions: {
          ...replacementDispositions,
          dispositions: [{
            ...replacementDispositions.dispositions[0],
            changeId: "a".repeat(24),
          }],
        },
      }),
      /unknown or stale semantic change/iu,
    );
    assert.equal(
      (await reportFigmaUpstreamContractCandidate({
        candidateRoot,
        candidateId,
        acceptedSnapshotPath,
      })).entities[0].changes[0].disposition.decision,
      "accepted-upstream",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("promotion lock serializes final baseline check and atomic rename", async () => {
  const root = await mkdtemp(resolve(tmpdir(), "figma-contract-race-"));
  const acceptedSnapshotPath = resolve(root, "accepted.json");
  const candidateRoot = resolve(root, "candidates");
  try {
    const accepted = wrapperCompatibleSnapshot();
    const firstCandidate = structuredClone(accepted);
    firstCandidate.tools.get_metadata.description = "First candidate metadata description.";
    const secondCandidate = structuredClone(firstCandidate);
    secondCandidate.tools.get_metadata.description += " Concurrent candidate.";
    const acceptedSource = serializeFigmaUpstreamContractSnapshot(accepted);
    await writeFile(acceptedSnapshotPath, acceptedSource, "utf8");
    for (const [candidateId, candidate] of [
      ["first-promoter", firstCandidate],
      ["second-promoter", secondCandidate],
    ]) {
      await captureFigmaUpstreamContractCandidate({
        candidateRoot,
        candidateId,
        acceptedSnapshotPath,
        snapshot: candidate,
      });
      const initialReport = await reportFigmaUpstreamContractCandidate({
        candidateRoot,
        candidateId,
        acceptedSnapshotPath,
      });
      await reportFigmaUpstreamContractCandidate({
        candidateRoot,
        candidateId,
        acceptedSnapshotPath,
        dispositions: dispositionsFor(initialReport, candidateId),
      });
    }

    let releaseFirstRename;
    let reportFirstRename;
    const firstRenameReached = new Promise((resolveReached) => {
      reportFirstRename = resolveReached;
    });
    const firstRenameGate = new Promise((resolveGate) => {
      releaseFirstRename = resolveGate;
    });
    const firstPromotion = promoteFigmaUpstreamContractCandidate({
      candidateRoot,
      candidateId: "first-promoter",
      acceptedSnapshotPath,
      fileSystemOperations: {
        rename: async (temporaryPath, targetPath) => {
          reportFirstRename();
          await firstRenameGate;
          await rename(temporaryPath, targetPath);
        },
      },
    });
    await firstRenameReached;
    const secondPromotion = promoteFigmaUpstreamContractCandidate({
      candidateRoot,
      candidateId: "second-promoter",
      acceptedSnapshotPath,
    });
    await new Promise((resolveWait) => setTimeout(resolveWait, 50));
    assert.equal(await readFile(acceptedSnapshotPath, "utf8"), acceptedSource);
    releaseFirstRename();
    await firstPromotion;
    await assert.rejects(
      secondPromotion,
      /baseline changed while promoting/iu,
    );
    assert.equal(
      await readFile(acceptedSnapshotPath, "utf8"),
      serializeFigmaUpstreamContractSnapshot(firstCandidate),
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("candidate validation refuses linked artifacts", async (context) => {
  const root = await mkdtemp(resolve(tmpdir(), "figma-contract-link-"));
  const acceptedSnapshotPath = resolve(root, "accepted.json");
  const candidateRoot = resolve(root, "candidates");
  try {
    const accepted = snapshot();
    await writeFile(acceptedSnapshotPath, serializeFigmaUpstreamContractSnapshot(accepted), "utf8");
    await captureFigmaUpstreamContractCandidate({
      candidateRoot,
      candidateId: "linked-artifact",
      acceptedSnapshotPath,
      snapshot: accepted,
    });
    const candidateDirectory = resolve(candidateRoot, "linked-artifact");
    const realCandidateDirectory = resolve(root, "real-candidate");
    await rename(candidateDirectory, realCandidateDirectory);
    try {
      await symlink(realCandidateDirectory, candidateDirectory, "junction");
    } catch (error) {
      if (error?.code === "EPERM") {
        context.skip("Junction creation is unavailable on this Windows host.");
        return;
      }
      throw error;
    }
    await assert.rejects(
      reportFigmaUpstreamContractCandidate({
        candidateRoot,
        candidateId: "linked-artifact",
        acceptedSnapshotPath,
      }),
      /symlink|reparse|real file/iu,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("candidate validation rejects snapshot tampering and baseline replacement", async () => {
  const root = await mkdtemp(resolve(tmpdir(), "figma-contract-guard-"));
  const acceptedSnapshotPath = resolve(root, "accepted.json");
  const candidateRoot = resolve(root, "candidates");
  try {
    const accepted = snapshot();
    await writeFile(acceptedSnapshotPath, serializeFigmaUpstreamContractSnapshot(accepted), "utf8");
    await captureFigmaUpstreamContractCandidate({
      candidateRoot,
      candidateId: "tamper-check",
      acceptedSnapshotPath,
      snapshot: accepted,
    });
    const candidateSnapshotPath = resolve(candidateRoot, "tamper-check", "snapshot.json");
    await writeFile(candidateSnapshotPath, "{}\n", "utf8");
    await assert.rejects(
      reportFigmaUpstreamContractCandidate({
        candidateRoot,
        candidateId: "tamper-check",
        acceptedSnapshotPath,
      }),
      /snapshot digest/iu,
    );
    await writeFile(acceptedSnapshotPath, "{}\n", "utf8");
    await assert.rejects(
      reportFigmaUpstreamContractCandidate({
        candidateRoot,
        candidateId: "tamper-check",
        acceptedSnapshotPath,
      }),
      /baseline changed/iu,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

function snapshot({ tools = {}, resources = [], resourceTemplates = [] } = {}) {
  return {
    schemaVersion: 2,
    source: "test",
    generatedAt: "2026-07-30T00:00:00.000Z",
    tools,
    resources,
    resourceTemplates,
  };
}

function dispositionsFor(report, candidateId) {
  return {
    schemaVersion: 1,
    candidateId,
    dispositions: report.entities.flatMap((entity) => entity.changes.map((change) => ({
      changeId: change.changeId,
      decision: "adapted-wrapper",
      rationale: "Reviewed and adapted in the wrapper contract.",
    }))),
  };
}

function wrapperCompatibleSnapshot() {
  const fileKey = () => ({ type: "string", pattern: "^[0-9a-zA-Z]{22,128}$" });
  const simpleNodeId = () => ({ type: "string", pattern: "^\\d+[:-]\\d+$" });
  const compositeNodeId = () => ({
    type: "string",
    pattern: "^(?:\\d+[:-]\\d+|[IT]\\d+[:-]\\d+(?:;\\d+[:-]\\d+)*)$",
  });
  const properties = (...names) =>
    Object.fromEntries(names.map((name) => [name, { type: "string" }]));
  const tool = (name, required, toolProperties) => ({
    name,
    description: "Synthetic " + name + " contract.",
    inputSchema: {
      type: "object",
      required,
      properties: toolProperties,
    },
  });
  return snapshot({
    tools: {
      use_figma: tool("use_figma", ["code", "description", "fileKey"], {
        ...properties("code", "description", "skillNames"),
        fileKey: fileKey(),
      }),
      get_metadata: tool("get_metadata", ["fileKey"], {
        fileKey: fileKey(),
        nodeId: compositeNodeId(),
      }),
      get_screenshot: tool("get_screenshot", ["fileKey", "nodeId"], {
        ...properties("maxDimension", "contentsOnly", "enableBase64Response"),
        fileKey: fileKey(),
        nodeId: simpleNodeId(),
      }),
      upload_assets: tool("upload_assets", ["fileKey"], {
        ...properties("count", "scaleMode", "batchCommit"),
        fileKey: fileKey(),
        nodeId: simpleNodeId(),
        nodeIds: { type: "array", items: simpleNodeId(), minItems: 1, maxItems: 60 },
      }),
      download_assets: tool("download_assets", ["fileKey", "nodeId"], {
        ...properties("defaultFormat", "defaultScale"),
        fileKey: fileKey(),
        nodeId: simpleNodeId(),
      }),
      get_design_context: tool("get_design_context", ["fileKey", "nodeId"], {
        ...properties(
          "clientLanguages",
          "clientFrameworks",
          "forceCode",
          "disableCodeConnect",
          "excludeScreenshot",
          "skillNames",
        ),
        fileKey: fileKey(),
        nodeId: compositeNodeId(),
      }),
      get_motion_context: tool("get_motion_context", ["fileKey", "nodeId"], {
        ...properties("recursive", "clientLanguages", "clientFrameworks"),
        fileKey: fileKey(),
        nodeId: simpleNodeId(),
      }),
      search_design_system: tool("search_design_system", ["fileKey", "query"], {
        ...properties(
          "query",
          "disableCodeConnect",
          "includeComponents",
          "includeVariables",
          "includeStyles",
          "includeLibraryKeys",
        ),
        fileKey: fileKey(),
      }),
      get_libraries: tool("get_libraries", ["fileKey"], {
        ...properties("offset"),
        fileKey: fileKey(),
      }),
      get_variable_defs: tool("get_variable_defs", ["fileKey", "nodeId"], {
        fileKey: fileKey(),
        nodeId: simpleNodeId(),
      }),
      list_file_components_for_code_connect: tool("list_file_components_for_code_connect", ["fileKey"], {
        fileKey: fileKey(),
      }),
      get_context_for_code_connect: tool("get_context_for_code_connect", ["fileKey", "nodeId"], {
        fileKey: fileKey(),
        nodeId: simpleNodeId(),
      }),
      get_code_connect_suggestions: tool("get_code_connect_suggestions", ["fileKey", "nodeId"], {
        ...properties("excludeMappingPrompt"),
        fileKey: fileKey(),
        nodeId: simpleNodeId(),
      }),
      get_code_connect_map: tool("get_code_connect_map", ["fileKey", "nodeId"], {
        ...properties("codeConnectLabel"),
        fileKey: fileKey(),
        nodeId: simpleNodeId(),
      }),
      send_code_connect_mappings: tool("send_code_connect_mappings", ["fileKey", "nodeId", "mappings"], {
        ...properties("clientLanguages", "clientFrameworks", "mappings"),
        fileKey: fileKey(),
        nodeId: simpleNodeId(),
      }),
    },
  });
}
