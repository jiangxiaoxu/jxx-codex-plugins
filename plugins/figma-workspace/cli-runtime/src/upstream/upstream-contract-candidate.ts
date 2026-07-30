import { createHash } from "node:crypto";
import { mkdir, readFile, rename } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import {
  FIGMA_WORKSPACE_COVERED_UPSTREAM_TOOL_NAMES,
  FIGMA_WORKSPACE_WRAPPER_CONTRACTS,
  type FigmaWorkspaceWrapperContract,
} from "../contract/wrapper-contracts.js";
import { createReplToolDescriptions } from "../contract/tool-metadata.js";
import {
  assertManagedFilePath,
  atomicWriteManagedTextFile,
  ensureManagedDirectory,
  type ManagedFileSystemOperations,
} from "../runtime/managed-files.js";
import { AtomicCredentialStore } from "../auth/credential-store.js";
import {
  normalizeFigmaUpstreamContractSnapshot,
  parseFigmaUpstreamContractSnapshot,
  serializeFigmaUpstreamContractSnapshot,
  type FigmaUpstreamContractDrift,
  type FigmaUpstreamContractSnapshot,
} from "./upstream-contract-snapshot.js";

export const FIGMA_UPSTREAM_CONTRACT_CANDIDATE_SCHEMA_VERSION = 1;
export const FIGMA_UPSTREAM_CONTRACT_REPORT_SCHEMA_VERSION = 1;

const SNAPSHOT_FILE = "snapshot.json";
const REPORT_JSON_FILE = "drift.json";
const REPORT_MARKDOWN_FILE = "report.md";
const DISPOSITIONS_FILE = "dispositions.json";
const MANIFEST_FILE = "manifest.json";
const CANDIDATE_ID_PATTERN = /^[a-z0-9](?:[a-z0-9._-]{0,126}[a-z0-9])?$/u;
const CANONICAL_PUBLIC_TOOL_DESCRIPTIONS = createReplToolDescriptions({
  taskWorkspaceRootEnv: "CODEX_TASK_WORKSPACE_ROOT",
  defaultDocsSearchMaxResults: 1,
  maxDocsSearchResults: 1,
  defaultDocsSearchSnippetLines: 1,
  maxDocsSearchSnippetLines: 1,
  maxLookupQueryLength: 1,
});

export interface FigmaUpstreamContractCandidateManifest {
  schemaVersion: typeof FIGMA_UPSTREAM_CONTRACT_CANDIDATE_SCHEMA_VERSION;
  candidateId: string;
  capturedAt: string;
  baseline: { sha256: string };
  snapshot: { file: typeof SNAPSHOT_FILE; sha256: string };
  report?: {
    jsonFile: typeof REPORT_JSON_FILE;
    jsonSha256: string;
    markdownFile: typeof REPORT_MARKDOWN_FILE;
    markdownSha256: string;
    dispositionsFile?: typeof DISPOSITIONS_FILE;
    dispositionsSha256?: string;
  };
}

export type FigmaUpstreamContractEntityKind = "tool" | "resource" | "resourceTemplate";
export type FigmaUpstreamContractEntityStatus = "added" | "removed" | "changed";

export type FigmaUpstreamContractChangeClass =
  | "entity-added"
  | "entity-removed"
  | "property-added"
  | "property-removed"
  | "required"
  | "type"
  | "enum"
  | "default"
  | "constraint"
  | "description"
  | "resource-content"
  | "unclassified";

export interface FigmaUpstreamContractSemanticChange extends FigmaUpstreamContractDrift {
  changeId: string;
  class: FigmaUpstreamContractChangeClass;
  behaviorBlocking: boolean;
  disposition?: FigmaUpstreamContractDisposition;
}

export interface FigmaUpstreamContractEntityDrift {
  kind: FigmaUpstreamContractEntityKind;
  id: string;
  status: FigmaUpstreamContractEntityStatus;
  changes: FigmaUpstreamContractSemanticChange[];
}

export type FigmaUpstreamContractDispositionDecision =
  | "accepted-upstream"
  | "adapted-wrapper"
  | "intentionally-unexposed";

export interface FigmaUpstreamContractDisposition {
  changeId: string;
  decision: FigmaUpstreamContractDispositionDecision;
  rationale: string;
}

export interface FigmaUpstreamContractDispositionFile {
  schemaVersion: 1;
  candidateId: string;
  dispositions: FigmaUpstreamContractDisposition[];
}

export type FigmaUpstreamWrapperCoverageIssueCode =
  | "covered-tool-without-wrapper-contract"
  | "wrapper-tool-not-declared-covered"
  | "upstream-tool-missing"
  | "upstream-input-schema-invalid"
  | "upstream-required-property-uncovered"
  | "wrapper-required-property-missing"
  | "upstream-optional-property-uncovered"
  | "wrapper-optional-property-missing"
  | "wrapper-property-unclassified"
  | "wrapper-property-multiply-classified"
  | "wrapper-optional-classification-invalid"
  | "wrapper-constraint-mismatch";

export interface FigmaUpstreamWrapperCoverageIssue {
  code: FigmaUpstreamWrapperCoverageIssueCode;
  upstreamToolName: string;
  wrapperToolName?: string;
  property?: string;
  constraint?: string;
  upstreamValue?: unknown;
  publicValue?: unknown;
}

export interface FigmaUpstreamContractSemanticReport {
  schemaVersion: typeof FIGMA_UPSTREAM_CONTRACT_REPORT_SCHEMA_VERSION;
  candidateId: string;
  baselineSha256: string;
  candidateSnapshotSha256: string;
  summary: {
    added: number;
    removed: number;
    changed: number;
    wrapperCoverageBlockers: number;
    unresolvedChanges: number;
  };
  entities: FigmaUpstreamContractEntityDrift[];
  wrapperCoverage: { blocking: FigmaUpstreamWrapperCoverageIssue[] };
}

export interface FigmaUpstreamContractCandidatePaths {
  directory: string;
  manifest: string;
  snapshot: string;
  reportJson: string;
  reportMarkdown: string;
  dispositions: string;
}

export async function captureFigmaUpstreamContractCandidate(options: {
  candidateRoot: string;
  candidateId: string;
  acceptedSnapshotPath: string;
  snapshot: FigmaUpstreamContractSnapshot;
}): Promise<FigmaUpstreamContractCandidateManifest> {
  assertCandidateId(options.candidateId);
  const paths = resolveCandidatePaths(options.candidateRoot, options.candidateId);
  await assertManagedFilePath({
    root: dirname(options.acceptedSnapshotPath),
    path: options.acceptedSnapshotPath,
  });
  const baselineSource = await readFile(options.acceptedSnapshotPath, "utf8");
  await assertManagedFilePath({
    root: dirname(options.acceptedSnapshotPath),
    path: options.acceptedSnapshotPath,
  });
  const snapshotSource = serializeFigmaUpstreamContractSnapshot(options.snapshot);
  const manifest: FigmaUpstreamContractCandidateManifest = {
    schemaVersion: FIGMA_UPSTREAM_CONTRACT_CANDIDATE_SCHEMA_VERSION,
    candidateId: options.candidateId,
    capturedAt: normalizeFigmaUpstreamContractSnapshot(options.snapshot).generatedAt,
    baseline: { sha256: sha256(baselineSource) },
    snapshot: { file: SNAPSHOT_FILE, sha256: sha256(snapshotSource) },
  };
  await ensureManagedDirectory({ root: options.candidateRoot, directory: options.candidateRoot });
  await mkdir(paths.directory);
  await ensureManagedDirectory({ root: options.candidateRoot, directory: paths.directory });
  await atomicWriteManagedTextFile({
    root: options.candidateRoot,
    path: paths.snapshot,
  }, snapshotSource);
  await atomicWriteManagedTextFile({
    root: options.candidateRoot,
    path: paths.manifest,
  }, serializeManifest(manifest));
  return manifest;
}

export async function reportFigmaUpstreamContractCandidate(options: {
  candidateRoot: string;
  candidateId: string;
  acceptedSnapshotPath: string;
  dispositions?: FigmaUpstreamContractDispositionFile;
}): Promise<FigmaUpstreamContractSemanticReport> {
  const validated = await validateCandidateCore(options, {
    replaceStoredDispositions: options.dispositions !== undefined,
  });
  const dispositionFile = options.dispositions ?? {
    schemaVersion: 1 as const,
    candidateId: options.candidateId,
    dispositions: [],
  };
  assertDispositionFile(dispositionFile, options.candidateId);
  const report = createFigmaUpstreamContractSemanticReport({
    candidateId: options.candidateId,
    baselineSha256: validated.manifest.baseline.sha256,
    candidateSnapshotSha256: validated.manifest.snapshot.sha256,
    baseline: validated.baseline,
    candidate: validated.candidate,
    dispositions: dispositionFile.dispositions,
  });
  const reportJsonSource = serializeFigmaUpstreamContractSemanticReport(report);
  const reportMarkdownSource = formatFigmaUpstreamContractSemanticReport(report);
  const dispositionsSource = JSON.stringify(dispositionFile, null, 2) + "\n";
  const manifest: FigmaUpstreamContractCandidateManifest = {
    ...validated.manifest,
    report: {
      jsonFile: REPORT_JSON_FILE,
      jsonSha256: sha256(reportJsonSource),
      markdownFile: REPORT_MARKDOWN_FILE,
      markdownSha256: sha256(reportMarkdownSource),
      dispositionsFile: DISPOSITIONS_FILE,
      dispositionsSha256: sha256(dispositionsSource),
    },
  };
  await atomicWriteManagedTextFile({
    root: options.candidateRoot,
    path: validated.paths.dispositions,
    overwrite: true,
  }, dispositionsSource);
  await atomicWriteManagedTextFile({
    root: options.candidateRoot,
    path: validated.paths.reportJson,
    overwrite: true,
  }, reportJsonSource);
  await atomicWriteManagedTextFile({
    root: options.candidateRoot,
    path: validated.paths.reportMarkdown,
    overwrite: true,
  }, reportMarkdownSource);
  await atomicWriteManagedTextFile({
    root: options.candidateRoot,
    path: validated.paths.manifest,
    overwrite: true,
  }, serializeManifest(manifest));
  return report;
}

export async function promoteFigmaUpstreamContractCandidate(options: {
  candidateRoot: string;
  candidateId: string;
  acceptedSnapshotPath: string;
  fileSystemOperations?: Partial<ManagedFileSystemOperations>;
}): Promise<FigmaUpstreamContractSemanticReport> {
  const ready = await validateCandidateForPromotion(options);
  const underlyingRename = options.fileSystemOperations?.rename ?? rename;
  const publicationOperations: Partial<ManagedFileSystemOperations> = {
    ...options.fileSystemOperations,
    rename: async (temporaryPath, targetPath) => {
      await assertManagedFilePath({
        root: dirname(options.acceptedSnapshotPath),
        path: options.acceptedSnapshotPath,
        operations: options.fileSystemOperations,
      });
      const currentBaseline = await readFile(options.acceptedSnapshotPath, "utf8");
      if (sha256(currentBaseline) !== ready.baselineSha256) {
        throw new Error("Accepted upstream contract baseline changed while promoting candidate "
          + options.candidateId + ".");
      }
      await underlyingRename(temporaryPath, targetPath);
    },
  };
  const publicationLock = new AtomicCredentialStore<Record<string, unknown>>(
    options.acceptedSnapshotPath,
    {
      empty: () => ({}),
      parse: (source) => {
        const value = JSON.parse(source) as unknown;
        if (!isRecord(value)) {
          throw new Error("Accepted upstream contract snapshot must be a JSON object.");
        }
        return value;
      },
    },
  );
  await publicationLock.withLock(async () => {
    await atomicWriteManagedTextFile({
      root: dirname(options.acceptedSnapshotPath),
      path: options.acceptedSnapshotPath,
      overwrite: true,
      operations: publicationOperations,
    }, ready.snapshotSource);
  });
  return ready.report;
}

export async function checkFigmaUpstreamContractCandidate(options: {
  candidateRoot: string;
  candidateId: string;
  acceptedSnapshotPath: string;
}): Promise<FigmaUpstreamContractSemanticReport> {
  return (await validateCandidateForPromotion(options)).report;
}

async function validateCandidateForPromotion(options: {
  candidateRoot: string;
  candidateId: string;
  acceptedSnapshotPath: string;
}): Promise<{
  report: FigmaUpstreamContractSemanticReport;
  snapshotSource: string;
  baselineSha256: string;
}> {
  const validated = await validateCandidateCore(options);
  const reportMetadata = validated.manifest.report;
  if (!reportMetadata) {
    throw new Error("Candidate " + options.candidateId + " has no report. Run upstream:contract:report first.");
  }
  const expectedReport = createFigmaUpstreamContractSemanticReport({
    candidateId: options.candidateId,
    baselineSha256: validated.manifest.baseline.sha256,
    candidateSnapshotSha256: validated.manifest.snapshot.sha256,
    baseline: validated.baseline,
    candidate: validated.candidate,
    dispositions: validated.dispositions.dispositions,
  });
  const expectedJson = serializeFigmaUpstreamContractSemanticReport(expectedReport);
  const expectedMarkdown = formatFigmaUpstreamContractSemanticReport(expectedReport);
  await Promise.all([
    assertManagedFilePath({
      root: options.candidateRoot,
      path: validated.paths.reportJson,
    }),
    assertManagedFilePath({
      root: options.candidateRoot,
      path: validated.paths.reportMarkdown,
    }),
  ]);
  const [actualJson, actualMarkdown] = await Promise.all([
    readFile(validated.paths.reportJson, "utf8"),
    readFile(validated.paths.reportMarkdown, "utf8"),
  ]);
  await Promise.all([
    assertManagedFilePath({
      root: options.candidateRoot,
      path: validated.paths.reportJson,
    }),
    assertManagedFilePath({
      root: options.candidateRoot,
      path: validated.paths.reportMarkdown,
    }),
  ]);
  assertArtifactIntegrity("drift report", actualJson, reportMetadata.jsonSha256, expectedJson);
  assertArtifactIntegrity("Markdown report", actualMarkdown, reportMetadata.markdownSha256, expectedMarkdown);
  if (expectedReport.wrapperCoverage.blocking.length > 0) {
    throw new Error(
      "Candidate " + options.candidateId + " has "
        + expectedReport.wrapperCoverage.blocking.length
        + " blocking wrapper coverage issue(s). Adapt wrapper contracts and regenerate the report before promotion.",
    );
  }
  if (expectedReport.summary.unresolvedChanges > 0) {
    throw new Error(
      "Candidate " + options.candidateId + " has " + expectedReport.summary.unresolvedChanges
        + " unresolved semantic change(s). Record explicit dispositions and regenerate the report.",
    );
  }
  return {
    report: expectedReport,
    snapshotSource: validated.snapshotSource,
    baselineSha256: validated.manifest.baseline.sha256,
  };
}

export function createFigmaUpstreamContractSemanticReport(options: {
  candidateId: string;
  baselineSha256: string;
  candidateSnapshotSha256: string;
  baseline: FigmaUpstreamContractSnapshot;
  candidate: FigmaUpstreamContractSnapshot;
  dispositions?: readonly FigmaUpstreamContractDisposition[];
}): FigmaUpstreamContractSemanticReport {
  assertCandidateId(options.candidateId);
  const unresolvedEntities = [
    ...diffEntityMap("tool", toolEntityMap(options.baseline), toolEntityMap(options.candidate)),
    ...diffEntityMap(
      "resource",
      namedEntityMap(options.baseline.resources, "uri"),
      namedEntityMap(options.candidate.resources, "uri"),
    ),
    ...diffEntityMap(
      "resourceTemplate",
      namedEntityMap(options.baseline.resourceTemplates, "uriTemplate"),
      namedEntityMap(options.candidate.resourceTemplates, "uriTemplate"),
    ),
  ];
  const dispositionMap = new Map<string, FigmaUpstreamContractDisposition>();
  for (const disposition of options.dispositions ?? []) {
    if (dispositionMap.has(disposition.changeId)) {
      throw new Error("Duplicate disposition for semantic change " + disposition.changeId + ".");
    }
    dispositionMap.set(disposition.changeId, disposition);
  }
  const knownChangeIds = new Set(
    unresolvedEntities.flatMap((entity) => entity.changes.map((change) => change.changeId)),
  );
  for (const changeId of dispositionMap.keys()) {
    if (!knownChangeIds.has(changeId)) {
      throw new Error("Disposition references unknown or stale semantic change " + changeId + ".");
    }
  }
  const entities = unresolvedEntities.map((entity) => ({
    ...entity,
    changes: entity.changes.map((change) => ({
      ...change,
      disposition: dispositionMap.get(change.changeId),
    })),
  }));
  const blocking = inspectFigmaUpstreamWrapperCoverage(options.candidate);
  return {
    schemaVersion: FIGMA_UPSTREAM_CONTRACT_REPORT_SCHEMA_VERSION,
    candidateId: options.candidateId,
    baselineSha256: options.baselineSha256,
    candidateSnapshotSha256: options.candidateSnapshotSha256,
    summary: {
      added: entities.filter((entry) => entry.status === "added").length,
      removed: entities.filter((entry) => entry.status === "removed").length,
      changed: entities.filter((entry) => entry.status === "changed").length,
      wrapperCoverageBlockers: blocking.length,
      unresolvedChanges: entities.flatMap((entry) => entry.changes)
        .filter((change) => !change.disposition).length,
    },
    entities,
    wrapperCoverage: { blocking },
  };
}

export function inspectFigmaUpstreamWrapperCoverage(
  snapshot: FigmaUpstreamContractSnapshot,
  contracts: readonly FigmaWorkspaceWrapperContract[] = FIGMA_WORKSPACE_WRAPPER_CONTRACTS,
  coveredToolNames: readonly string[] = FIGMA_WORKSPACE_COVERED_UPSTREAM_TOOL_NAMES,
  publicToolDescriptions: readonly Record<string, unknown>[] = CANONICAL_PUBLIC_TOOL_DESCRIPTIONS,
): FigmaUpstreamWrapperCoverageIssue[] {
  const covered = new Set(coveredToolNames);
  const contractToolNames = new Set(
    contracts.flatMap((contract) => contract.upstreamToolName ? [contract.upstreamToolName] : []),
  );
  const publicDescriptionsByName = new Map(
    publicToolDescriptions.flatMap((description) =>
      typeof description.name === "string" ? [[description.name, description] as const] : []),
  );
  const issues: FigmaUpstreamWrapperCoverageIssue[] = [];
  for (const upstreamToolName of [...covered].sort()) {
    if (!contractToolNames.has(upstreamToolName)) {
      issues.push({ code: "covered-tool-without-wrapper-contract", upstreamToolName });
    }
  }
  for (const contract of contracts) {
    if (!contract.upstreamToolName) continue;
    if (!covered.has(contract.upstreamToolName)) {
      issues.push({
        code: "wrapper-tool-not-declared-covered",
        upstreamToolName: contract.upstreamToolName,
        wrapperToolName: contract.toolName,
      });
    }
    inspectWrapperContract(
      snapshot,
      contract,
      publicDescriptionsByName.get(contract.toolName),
      issues,
    );
  }
  return issues.sort(compareCoverageIssue);
}

export function serializeFigmaUpstreamContractSemanticReport(
  report: FigmaUpstreamContractSemanticReport,
): string {
  return JSON.stringify(report, null, 2) + "\n";
}

export function formatFigmaUpstreamContractSemanticReport(
  report: FigmaUpstreamContractSemanticReport,
): string {
  const lines = [
    "# Figma upstream contract candidate " + report.candidateId,
    "",
    "Baseline SHA-256: " + report.baselineSha256,
    "Candidate SHA-256: " + report.candidateSnapshotSha256,
    "",
    "Drift: " + report.summary.added + " added, " + report.summary.removed
      + " removed, " + report.summary.changed + " changed.",
    "Blocking wrapper coverage issues: " + report.summary.wrapperCoverageBlockers + ".",
    "Unresolved semantic changes: " + report.summary.unresolvedChanges + ".",
  ];
  if (report.entities.length > 0) {
    lines.push("", "## Semantic drift", "");
    for (const entity of report.entities) {
      for (const change of entity.changes) {
        const disposition = change.disposition
          ? " -> " + change.disposition.decision
          : " -> unresolved";
        lines.push("- " + entity.kind + " " + entity.id + " " + change.path
          + " [" + change.class + "]" + disposition + " (" + change.changeId + ")");
      }
    }
  }
  if (report.wrapperCoverage.blocking.length > 0) {
    lines.push("", "## Blocking wrapper coverage", "");
    for (const issue of report.wrapperCoverage.blocking) {
      const wrapper = issue.wrapperToolName ? " via " + issue.wrapperToolName : "";
      const property = issue.property ? " property " + issue.property : "";
      lines.push("- " + issue.code + ": " + issue.upstreamToolName + wrapper + property);
    }
  }
  return lines.join("\n") + "\n";
}

export function createDefaultFigmaUpstreamContractCandidateId(now = new Date()): string {
  return now.toISOString().replaceAll(/[-:.]/gu, "").replace("Z", "z").toLowerCase();
}

export function resolveFigmaUpstreamContractCandidatePaths(
  candidateRoot: string,
  candidateId: string,
): FigmaUpstreamContractCandidatePaths {
  assertCandidateId(candidateId);
  return resolveCandidatePaths(candidateRoot, candidateId);
}

async function validateCandidateCore(options: {
  candidateRoot: string;
  candidateId: string;
  acceptedSnapshotPath: string;
}, validationOptions: {
  replaceStoredDispositions?: boolean;
} = {}): Promise<{
  manifest: FigmaUpstreamContractCandidateManifest;
  baseline: FigmaUpstreamContractSnapshot;
  candidate: FigmaUpstreamContractSnapshot;
  snapshotSource: string;
  paths: FigmaUpstreamContractCandidatePaths;
  dispositions: FigmaUpstreamContractDispositionFile;
}> {
  assertCandidateId(options.candidateId);
  const paths = resolveCandidatePaths(options.candidateRoot, options.candidateId);
  await Promise.all([
    assertManagedFilePath({
      root: dirname(options.acceptedSnapshotPath),
      path: options.acceptedSnapshotPath,
    }),
    assertManagedFilePath({
      root: options.candidateRoot,
      path: paths.manifest,
    }),
    assertManagedFilePath({
      root: options.candidateRoot,
      path: paths.snapshot,
    }),
  ]);
  const [manifestSource, baselineSource, snapshotSource] = await Promise.all([
    readFile(paths.manifest, "utf8"),
    readFile(options.acceptedSnapshotPath, "utf8"),
    readFile(paths.snapshot, "utf8"),
  ]);
  await Promise.all([
    assertManagedFilePath({
      root: dirname(options.acceptedSnapshotPath),
      path: options.acceptedSnapshotPath,
    }),
    assertManagedFilePath({
      root: options.candidateRoot,
      path: paths.manifest,
    }),
    assertManagedFilePath({
      root: options.candidateRoot,
      path: paths.snapshot,
    }),
  ]);
  const manifest = parseManifest(manifestSource, options.candidateId);
  if (sha256(baselineSource) !== manifest.baseline.sha256) {
    throw new Error("Accepted upstream contract baseline changed after candidate "
      + options.candidateId + " was captured.");
  }
  if (sha256(snapshotSource) !== manifest.snapshot.sha256) {
    throw new Error("Candidate " + options.candidateId + " snapshot digest does not match its manifest.");
  }
  const baseline = parseFigmaUpstreamContractSnapshot(baselineSource);
  const candidate = parseFigmaUpstreamContractSnapshot(snapshotSource);
  let dispositions: FigmaUpstreamContractDispositionFile = {
    schemaVersion: 1,
    candidateId: options.candidateId,
    dispositions: [],
  };
  if (manifest.report?.dispositionsFile && !validationOptions.replaceStoredDispositions) {
    await assertManagedFilePath({
      root: options.candidateRoot,
      path: paths.dispositions,
    });
    const dispositionSource = await readFile(paths.dispositions, "utf8");
    await assertManagedFilePath({
      root: options.candidateRoot,
      path: paths.dispositions,
    });
    if (sha256(dispositionSource) !== manifest.report.dispositionsSha256) {
      throw new Error("Candidate " + options.candidateId
        + " dispositions digest does not match its manifest.");
    }
    dispositions = JSON.parse(dispositionSource) as FigmaUpstreamContractDispositionFile;
    assertDispositionFile(dispositions, options.candidateId);
  }
  return { manifest, baseline, candidate, snapshotSource, paths, dispositions };
}

function parseManifest(source: string, candidateId: string): FigmaUpstreamContractCandidateManifest {
  const value = JSON.parse(source) as unknown;
  if (!isRecord(value)
    || value.schemaVersion !== FIGMA_UPSTREAM_CONTRACT_CANDIDATE_SCHEMA_VERSION
    || value.candidateId !== candidateId
    || typeof value.capturedAt !== "string"
    || !isDigestRecord(value.baseline)
    || !isRecord(value.snapshot)
    || value.snapshot.file !== SNAPSHOT_FILE
    || !isSha256(value.snapshot.sha256)) {
    throw new Error("Candidate " + candidateId + " manifest is invalid.");
  }
  if (value.report !== undefined && (!isRecord(value.report)
    || value.report.jsonFile !== REPORT_JSON_FILE
    || !isSha256(value.report.jsonSha256)
    || value.report.markdownFile !== REPORT_MARKDOWN_FILE
    || !isSha256(value.report.markdownSha256)
    || value.report.dispositionsFile !== DISPOSITIONS_FILE
    || !isSha256(value.report.dispositionsSha256))) {
    throw new Error("Candidate " + candidateId + " report manifest is invalid.");
  }
  return value as unknown as FigmaUpstreamContractCandidateManifest;
}

function inspectWrapperContract(
  snapshot: FigmaUpstreamContractSnapshot,
  contract: FigmaWorkspaceWrapperContract,
  publicToolDescription: Record<string, unknown> | undefined,
  issues: FigmaUpstreamWrapperCoverageIssue[],
): void {
  const upstreamToolName = contract.upstreamToolName;
  if (!upstreamToolName) return;
  const tool = snapshot.tools[upstreamToolName];
  if (!isRecord(tool)) {
    issues.push({ code: "upstream-tool-missing", upstreamToolName, wrapperToolName: contract.toolName });
    return;
  }
  const inputSchema = tool.inputSchema;
  if (!isRecord(inputSchema) || !isRecord(inputSchema.properties)
    || (inputSchema.required !== undefined && !isStringArray(inputSchema.required))) {
    issues.push({
      code: "upstream-input-schema-invalid",
      upstreamToolName,
      wrapperToolName: contract.toolName,
    });
    return;
  }
  const actualRequired = new Set(isStringArray(inputSchema.required) ? inputSchema.required : []);
  const actualProperties = new Set(Object.keys(inputSchema.properties));
  const declaredRequired = new Set(contract.requiredUpstreamProperties ?? []);
  const declaredOptional = new Set(contract.optionalUpstreamProperties ?? []);
  const declaredProperties = new Set([...declaredRequired, ...declaredOptional]);
  const handledRequired = new Set(contract.parameterMatrix.requiredUpstream);
  const sourceClassifications = [
    contract.parameterMatrix.publicPassthrough,
    contract.parameterMatrix.derivedUpstream,
    contract.parameterMatrix.fixedUpstream,
    contract.parameterMatrix.hiddenUpstreamOptional,
  ];
  for (const property of [...declaredProperties].sort()) {
    const sourceCount = sourceClassifications
      .filter((classification) => classification.includes(property)).length;
    if (sourceCount === 0) {
      issues.push({
        code: "wrapper-property-unclassified",
        upstreamToolName,
        wrapperToolName: contract.toolName,
        property,
      });
    } else if (sourceCount > 1) {
      issues.push({
        code: "wrapper-property-multiply-classified",
        upstreamToolName,
        wrapperToolName: contract.toolName,
        property,
      });
    }
    if (declaredOptional.has(property)) {
      const optionalCount = [
        contract.parameterMatrix.passthroughOptional,
        contract.parameterMatrix.hiddenUpstreamOptional,
      ].filter((classification) => classification.includes(property)).length;
      if (optionalCount !== 1) {
        issues.push({
          code: "wrapper-optional-classification-invalid",
          upstreamToolName,
          wrapperToolName: contract.toolName,
          property,
        });
      }
    }
  }
  const matrixProperties = new Set([
    ...contract.parameterMatrix.requiredUpstream,
    ...contract.parameterMatrix.publicPassthrough,
    ...contract.parameterMatrix.derivedUpstream,
    ...contract.parameterMatrix.fixedUpstream,
    ...contract.parameterMatrix.passthroughOptional,
    ...contract.parameterMatrix.hiddenUpstreamOptional,
  ]);
  for (const property of [...matrixProperties].filter((entry) => !declaredProperties.has(entry)).sort()) {
    issues.push({
      code: "wrapper-property-unclassified",
      upstreamToolName,
      wrapperToolName: contract.toolName,
      property,
    });
  }
  for (const property of [...actualProperties].filter((entry) => !declaredProperties.has(entry)).sort()) {
    issues.push({
      code: actualRequired.has(property)
        ? "upstream-required-property-uncovered"
        : "upstream-optional-property-uncovered",
      upstreamToolName,
      wrapperToolName: contract.toolName,
      property,
    });
  }
  for (const property of [...actualRequired].filter((entry) => !handledRequired.has(entry)).sort()) {
    issues.push({
      code: "upstream-required-property-uncovered",
      upstreamToolName,
      wrapperToolName: contract.toolName,
      property,
    });
  }
  for (const property of [...declaredRequired].filter((entry) => !actualProperties.has(entry)).sort()) {
    issues.push({
      code: "wrapper-required-property-missing",
      upstreamToolName,
      wrapperToolName: contract.toolName,
      property,
    });
  }
  for (const property of [...declaredOptional].filter((entry) => !actualProperties.has(entry)).sort()) {
    issues.push({
      code: "wrapper-optional-property-missing",
      upstreamToolName,
      wrapperToolName: contract.toolName,
      property,
    });
  }
  inspectPublicConstraintParity(
    inputSchema.properties,
    contract,
    publicToolDescription,
    issues,
  );
}

function inspectPublicConstraintParity(
  upstreamProperties: Record<string, unknown>,
  contract: FigmaWorkspaceWrapperContract,
  publicToolDescription: Record<string, unknown> | undefined,
  issues: FigmaUpstreamWrapperCoverageIssue[],
): void {
  if (!contract.upstreamToolName || !publicToolDescription) return;
  const publicInputSchema = publicToolDescription.inputSchema;
  if (!isRecord(publicInputSchema) || !isRecord(publicInputSchema.properties)) return;
  for (const property of ["fileKey", "nodeId"] as const) {
    const publicConstraint = publicIdentifierPattern(publicInputSchema.properties, property);
    if (!publicConstraint.exposed) continue;
    const upstreamProperty = upstreamProperties[property];
    const upstreamPattern = isRecord(upstreamProperty) && typeof upstreamProperty.pattern === "string"
      ? upstreamProperty.pattern
      : undefined;
    if (upstreamPattern !== undefined && upstreamPattern !== publicConstraint.pattern) {
      issues.push({
        code: "wrapper-constraint-mismatch",
        upstreamToolName: contract.upstreamToolName,
        wrapperToolName: contract.toolName,
        property,
        constraint: "pattern",
        upstreamValue: upstreamPattern,
        publicValue: publicConstraint.pattern,
      });
    }
  }
}

function publicIdentifierPattern(
  publicProperties: Record<string, unknown>,
  property: "fileKey" | "nodeId",
): { exposed: boolean; pattern?: string } {
  if (property === "nodeId") {
    const nodeIdSchema = publicProperties.nodeId;
    return {
      exposed: isRecord(nodeIdSchema),
      pattern: isRecord(nodeIdSchema) && typeof nodeIdSchema.pattern === "string"
        ? nodeIdSchema.pattern
        : undefined,
    };
  }
  const fileSchema = publicProperties.file;
  if (!isRecord(fileSchema)) return { exposed: false };
  if (typeof fileSchema.pattern === "string") {
    return { exposed: true, pattern: fileSchema.pattern };
  }
  const rawFileKeySchema = Array.isArray(fileSchema.oneOf)
    ? fileSchema.oneOf.find((entry) =>
      isRecord(entry)
      && typeof entry.pattern === "string"
      && entry.format !== "uri")
    : undefined;
  return {
    exposed: true,
    pattern: isRecord(rawFileKeySchema) && typeof rawFileKeySchema.pattern === "string"
      ? rawFileKeySchema.pattern
      : undefined,
  };
}

function diffEntityMap(
  kind: FigmaUpstreamContractEntityKind,
  baseline: ReadonlyMap<string, unknown>,
  candidate: ReadonlyMap<string, unknown>,
): FigmaUpstreamContractEntityDrift[] {
  const ids = [...new Set([...baseline.keys(), ...candidate.keys()])].sort();
  const result: FigmaUpstreamContractEntityDrift[] = [];
  for (const id of ids) {
    const before = baseline.get(id);
    const after = candidate.get(id);
    if (!baseline.has(id)) {
      result.push({
        kind,
        id,
        status: "added",
        changes: [createSemanticChange(kind, id, "$", undefined, after, "entity-added")],
      });
      continue;
    }
    if (!candidate.has(id)) {
      result.push({
        kind,
        id,
        status: "removed",
        changes: [createSemanticChange(kind, id, "$", before, undefined, "entity-removed")],
      });
      continue;
    }
    const changes = diffJson(
      normalizeSemanticSetValues(before),
      normalizeSemanticSetValues(after),
      "$",
    ).map((change) => createSemanticChange(
      kind,
      id,
      change.path,
      change.expected,
      change.actual,
      classifySemanticChange(kind, change),
    ));
    if (changes.length > 0) result.push({ kind, id, status: "changed", changes });
  }
  return result;
}

function toolEntityMap(snapshot: FigmaUpstreamContractSnapshot): Map<string, unknown> {
  return new Map(Object.entries(snapshot.tools));
}

function namedEntityMap(entries: readonly unknown[], key: "uri" | "uriTemplate"): Map<string, unknown> {
  const result = new Map<string, unknown>();
  for (const entry of entries) {
    if (!isRecord(entry) || typeof entry[key] !== "string" || entry[key].length === 0) {
      throw new Error("Upstream contract contains a " + key + " entry without a stable identity.");
    }
    if (result.has(entry[key])) {
      throw new Error("Upstream contract contains duplicate " + key + " identity " + entry[key] + ".");
    }
    result.set(entry[key], entry);
  }
  return result;
}

function createSemanticChange(
  kind: FigmaUpstreamContractEntityKind,
  id: string,
  path: string,
  expected: unknown,
  actual: unknown,
  changeClass: FigmaUpstreamContractChangeClass,
): FigmaUpstreamContractSemanticChange {
  const identity = JSON.stringify([
    kind,
    id,
    path,
    changeClass,
    encodeUndefined(expected),
    encodeUndefined(actual),
  ]);
  return {
    changeId: sha256(identity).slice(0, 24),
    path,
    class: changeClass,
    behaviorBlocking: changeClass !== "description",
    expected,
    actual,
  };
}

function classifySemanticChange(
  kind: FigmaUpstreamContractEntityKind,
  change: FigmaUpstreamContractDrift,
): FigmaUpstreamContractChangeClass {
  if (kind !== "tool") return "resource-content";
  if (/\.required(?:\[\d+\])?$/u.test(change.path)) return "required";
  if (/\.enum(?:\[\d+\])?$/u.test(change.path)) return "enum";
  if (/\.type$/u.test(change.path)) return "type";
  if (/\.default$/u.test(change.path)) return "default";
  if (/\.(?:minimum|maximum|exclusiveMinimum|exclusiveMaximum|minLength|maxLength|minItems|maxItems|pattern|format|multipleOf|uniqueItems)$/u.test(change.path)) {
    return "constraint";
  }
  if (/\.description$/u.test(change.path)) return "description";
  if (/\.inputSchema\.properties\.[^.]+$/u.test(change.path)) {
    if (change.expected === undefined) return "property-added";
    if (change.actual === undefined) return "property-removed";
  }
  return "unclassified";
}

function normalizeSemanticSetValues(value: unknown, key?: string): unknown {
  if (Array.isArray(value)) {
    const normalized = value.map((entry) => normalizeSemanticSetValues(entry));
    if (key === "required" || key === "enum") {
      return normalized.sort((left, right) =>
        JSON.stringify(left).localeCompare(JSON.stringify(right)));
    }
    return normalized;
  }
  if (isRecord(value)) {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([entryKey, entryValue]) => [
          entryKey,
          normalizeSemanticSetValues(entryValue, entryKey),
        ]),
    );
  }
  return value;
}

function encodeUndefined(value: unknown): unknown {
  return value === undefined ? { $undefined: true } : value;
}

function diffJson(expected: unknown, actual: unknown, path: string): FigmaUpstreamContractDrift[] {
  if (Object.is(expected, actual)) return [];
  if (Array.isArray(expected) || Array.isArray(actual)) {
    if (!Array.isArray(expected) || !Array.isArray(actual)) return [{ path, expected, actual }];
    const drift: FigmaUpstreamContractDrift[] = [];
    for (let index = 0; index < Math.max(expected.length, actual.length); index += 1) {
      drift.push(...diffJson(expected[index], actual[index], path + "[" + index + "]"));
    }
    return drift;
  }
  if (isRecord(expected) || isRecord(actual)) {
    if (!isRecord(expected) || !isRecord(actual)) return [{ path, expected, actual }];
    const keys = [...new Set([...Object.keys(expected), ...Object.keys(actual)])].sort();
    return keys.flatMap((key) => diffJson(expected[key], actual[key], path + "." + key));
  }
  return [{ path, expected, actual }];
}

function resolveCandidatePaths(candidateRoot: string, candidateId: string): FigmaUpstreamContractCandidatePaths {
  const directory = resolve(candidateRoot, candidateId);
  return {
    directory,
    manifest: resolve(directory, MANIFEST_FILE),
    snapshot: resolve(directory, SNAPSHOT_FILE),
    reportJson: resolve(directory, REPORT_JSON_FILE),
    reportMarkdown: resolve(directory, REPORT_MARKDOWN_FILE),
    dispositions: resolve(directory, DISPOSITIONS_FILE),
  };
}

function assertArtifactIntegrity(label: string, actual: string, digest: string, expected: string): void {
  if (sha256(actual) !== digest) {
    throw new Error("Candidate " + label + " digest does not match its manifest.");
  }
  if (actual !== expected) {
    throw new Error("Candidate " + label + " is stale or does not match the recomputed semantic report.");
  }
}

function serializeManifest(manifest: FigmaUpstreamContractCandidateManifest): string {
  return JSON.stringify(manifest, null, 2) + "\n";
}

function assertDispositionFile(
  value: FigmaUpstreamContractDispositionFile,
  candidateId: string,
): void {
  if (!isRecord(value)
    || value.schemaVersion !== 1
    || value.candidateId !== candidateId
    || !Array.isArray(value.dispositions)) {
    throw new Error("Disposition file for candidate " + candidateId + " is invalid.");
  }
  const seen = new Set<string>();
  for (const disposition of value.dispositions) {
    if (!isRecord(disposition)
      || !isSha256Prefix(disposition.changeId)
      || !["accepted-upstream", "adapted-wrapper", "intentionally-unexposed"].includes(
        String(disposition.decision),
      )
      || typeof disposition.rationale !== "string"
      || disposition.rationale.trim().length < 8
      || seen.has(disposition.changeId)) {
      throw new Error("Disposition file for candidate " + candidateId
        + " contains an invalid or duplicate disposition.");
    }
    seen.add(disposition.changeId);
  }
}

function assertCandidateId(candidateId: string): void {
  if (!CANDIDATE_ID_PATTERN.test(candidateId)) {
    throw new Error(
      "Candidate ID must be 1..128 lowercase alphanumeric, dot, underscore, or hyphen characters and must end with an alphanumeric character.",
    );
  }
}

function compareCoverageIssue(
  left: FigmaUpstreamWrapperCoverageIssue,
  right: FigmaUpstreamWrapperCoverageIssue,
): number {
  const leftKey = [left.upstreamToolName, left.wrapperToolName ?? "", left.code, left.property ?? ""].join("\u0000");
  const rightKey = [right.upstreamToolName, right.wrapperToolName ?? "", right.code, right.property ?? ""].join("\u0000");
  return leftKey.localeCompare(rightKey);
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function isDigestRecord(value: unknown): value is { sha256: string } {
  return isRecord(value) && isSha256(value.sha256);
}

function isSha256(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{64}$/u.test(value);
}

function isSha256Prefix(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{24}$/u.test(value);
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === "string");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
