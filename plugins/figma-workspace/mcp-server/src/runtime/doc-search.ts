import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  FIGMA_WORKSPACE_PROJECT_DOC_FILES,
  getFigmaWorkspaceProjectDocSearchRecords,
} from "./project-docs.js";
import {
  parseTaskRoutingCatalog,
  type TaskFamily,
  type TaskRouteDefinition,
  type TaskSurface,
} from "./task-routing.js";
import type {
  FigmaWorkspaceDocsLookupScope,
  FigmaWorkspaceTaskFamily,
} from "../contract/tool-args.js";

export const DEFAULT_DOCS_SEARCH_MAX_RESULTS = 5;
export const DEFAULT_DOCS_SEARCH_SNIPPET_LINES = 3;
export const MAX_DOCS_SEARCH_RESULTS = 10;
export const MAX_DOCS_SEARCH_SNIPPET_LINES = 8;
export const DEFAULT_REFERENCE_CONTEXT_SNIPPETS = 2;
export const MAX_LOOKUP_QUERY_LENGTH = 120;

const MAX_REFERENCE_CHUNK_LINES = 24;
const REFERENCE_CHUNK_OVERLAP_LINES = 4;
const MAX_PUBLIC_SNIPPET_BYTES = 1200;

export const BRIDGE_DOCS_SEARCH_FILES = [
  "bridge/guidance-ref.md",
  "bridge/wrapper-profiles.md",
  "bridge/helper-profiles.md",
  "bridge/workflow-graph.md",
];

const STATIC_DOCS_SEARCH_FILES = [
  ...FIGMA_WORKSPACE_PROJECT_DOC_FILES,
  ...BRIDGE_DOCS_SEARCH_FILES,
];

export interface ReferenceSearchResult {
  lineStart: number;
  lineEnd: number;
  matchType: "exact-symbol" | "phrase" | "token";
  confidence: "high" | "medium" | "low";
  snippet: string;
  classification?: CanonicalClassification | "api";
  docId?: string;
  apiId?: string;
  title?: string;
  taskFamily?: TaskFamily;
  surfaces?: TaskSurface[];
  nonExecutable?: boolean;
  ownerMatch?: boolean;
}

interface RankedReferenceSearchResult extends ReferenceSearchResult {
  score: number;
}

type CanonicalClassification = "active" | "conditional" | "router" | "examples";

interface ReferenceRecordMetadata {
  classification: CanonicalClassification | "api";
  publicId: string;
  title: string;
  taskFamily?: TaskFamily;
  surfaces?: TaskSurface[];
  nonExecutable?: boolean;
  indexedSymbol?: string;
  ownerSymbol?: string;
  declarationKind?: PluginApiDeclarationKind;
  qualifiedAliases?: string[];
}

interface ReferenceChunk {
  id: string;
  file: string;
  title?: string;
  lineStart: number;
  lineEnd: number;
  text: string;
  lines: string[];
  tokens: string[];
  tokenCounts: Map<string, number>;
  metadata: ReferenceRecordMetadata;
  preferredLineIndex?: number;
}

interface CanonicalCorpusManifest {
  schemaVersion: 2;
  generatedAt?: string;
  source?: {
    repository: string;
    resolvedCommit: string;
  };
  corpus: { file: string; recordCount: number; sha256: string };
  routeCatalog: { file: string; schemaVersion: 1; routeCount: number; sha256: string };
  inventories: {
    classifications: Record<CanonicalClassification, number>;
    surfaces: Record<TaskSurface, number>;
    taskFamilies: Record<TaskFamily, number>;
  };
  integrity: {
    algorithm: "sha256";
    contentHashes: Record<string, string>;
  };
}

interface CanonicalCorpusRecord extends ReferenceRecordMetadata {
  schemaVersion: 2;
  id: string;
  publicId: string;
  title: string;
  summary: string;
  classification: CanonicalClassification;
  taskFamily: TaskFamily;
  surfaces: TaskSurface[];
  format: "markdown";
  mappingProfile: CanonicalMappingProfile;
  sourceRecordId: string;
  sourceContract: string;
  targetContract: string;
  sanitized: true;
  contentSha256: string;
  text: string;
}

interface CanonicalCorpus {
  root: string;
  manifest: CanonicalCorpusManifest;
  routes: TaskRouteDefinition[];
  records: Map<string, CanonicalCorpusRecord>;
}

interface PluginApiIndexManifest {
  schemaVersion: 2;
  source: {
    package: "@figma/plugin-typings";
    version: string;
    files: Array<{ file: string; sha256: string }>;
  };
  index: { file: string; recordCount: number; sha256: string };
  integrity: { algorithm: "sha256"; contentHashes: Record<string, string> };
}

interface PluginApiIndexRecord {
  schemaVersion: 2;
  id: string;
  symbol: string;
  ownerSymbol: string | null;
  declarationKind: PluginApiDeclarationKind;
  qualifiedAliases: string[];
  sourceFile: string;
  declarationLine: number;
  lineStart: number;
  lineEnd: number;
  contentSha256: string;
  text: string;
}

type PluginApiDeclarationKind =
  | "interface"
  | "type-alias"
  | "class"
  | "enum"
  | "enum-member"
  | "namespace"
  | "function"
  | "variable"
  | "method"
  | "property"
  | "getter"
  | "setter";

type CanonicalMappingProfile =
  | "canonical-typescript-example"
  | "code-connect"
  | "design-to-code"
  | "exact-plugin-api"
  | "figjam"
  | "motion"
  | "plugin-api"
  | "slides"
  | "upstream-capability";

export interface FigmaWorkspaceCanonicalTaskFamilySummary {
  taskFamily: TaskFamily;
  skill: string;
  surfaces: TaskSurface[];
  canonicalQuery: string;
  aliases: string[];
  recordCount: number;
}

export interface FigmaWorkspaceCanonicalRecordSummary {
  id: string;
  title: string;
  summary: string;
  classification: CanonicalClassification;
  taskFamily: TaskFamily;
  surfaces: TaskSurface[];
  mappingProfile: CanonicalMappingProfile;
  nonExecutable: boolean;
}

export interface FigmaWorkspaceCanonicalDoc extends FigmaWorkspaceCanonicalRecordSummary {
  kind: "canonical";
  content: string;
}

interface PluginApiIndex {
  root: string;
  manifest: PluginApiIndexManifest;
  records: Map<string, PluginApiIndexRecord>;
}

export interface FigmaWorkspaceLookupCorpusFailure {
  ok: false;
  message: string;
  moduleDir: string;
  cwd: string;
  argv1?: string;
  packageVersion?: string;
  attemptedPaths: string[];
}

export type FigmaWorkspaceLookupRuntimeInfo =
  | {
    ok: true;
    moduleDir: string;
    cwd: string;
    argv1?: string;
    packageVersion?: string;
    canonical: {
      root: string;
      recordCount: number;
      corpusSha256: string;
      inventories: CanonicalCorpusManifest["inventories"];
      routeCount: number;
      repository?: string;
      resolvedCommit?: string;
    };
    api: {
      root: string;
      recordCount: number;
      indexSha256: string;
      package: "@figma/plugin-typings";
      version: string;
    };
  }
  | FigmaWorkspaceLookupCorpusFailure;

export class FigmaWorkspaceLookupCorpusUnavailableError extends Error {
  readonly failure: FigmaWorkspaceLookupCorpusFailure;

  constructor(failure: FigmaWorkspaceLookupCorpusFailure) {
    super(failure.message);
    this.name = "FigmaWorkspaceLookupCorpusUnavailableError";
    this.failure = failure;
  }
}

interface ScoredReferenceChunk {
  chunk: ReferenceChunk;
  score: number;
  matchType: "exact-symbol" | "phrase" | "token";
  confidence: "high" | "medium" | "low";
  ownerMatch?: boolean;
}

interface PluginApiLookupQuery {
  normalizedInput: string;
  normalizedSymbol: string;
  ownerHint?: string;
  ownerKnown: boolean;
}

const canonicalClassifications = ["active", "conditional", "router", "examples"] as const;
const canonicalSurfaces = ["design", "figjam", "slides"] as const;
const canonicalTaskFamilies = [
  "code-connect",
  "create-file",
  "design-editing",
  "design-generation",
  "design-to-code",
  "diagram",
  "figjam",
  "library-generation",
  "motion",
  "motion-implementation",
  "slides",
  "swiftui",
] as const satisfies readonly TaskFamily[];
const canonicalMappingProfiles = [
  "canonical-typescript-example",
  "code-connect",
  "design-to-code",
  "exact-plugin-api",
  "figjam",
  "motion",
  "plugin-api",
  "slides",
  "upstream-capability",
] as const;
const pluginApiDeclarationKinds = [
  "interface",
  "type-alias",
  "class",
  "enum",
  "enum-member",
  "namespace",
  "function",
  "variable",
  "method",
  "property",
  "getter",
  "setter",
] as const;
const canonicalCorpusState = readCanonicalCorpusState();
const pluginApiIndexState = readPluginApiIndexState();

export const DOCS_SEARCH_ALLOWLIST = docsSearchFilesForScope("active");

export function docsSearchFilesForScope(
  scope: FigmaWorkspaceDocsLookupScope,
  filters: {
    surface?: TaskSurface;
    taskFamily?: FigmaWorkspaceTaskFamily;
    effectiveScopes?: readonly CanonicalClassification[];
  } = {},
): string[] {
  const effectiveScopeSet = scope === "auto"
    ? new Set<CanonicalClassification>(
      (filters.effectiveScopes ?? ["active"]).filter((classification) => classification !== "examples"),
    )
    : undefined;
  const includeStaticDocs = scope === "auto"
    || ((scope === "active" || scope === "all")
      && filters.surface === undefined
      && filters.taskFamily === undefined);
  if (!canonicalCorpusState.ok) {
    return includeStaticDocs
      ? [...STATIC_DOCS_SEARCH_FILES]
      : [];
  }
  const records = [...canonicalCorpusState.corpus.records.values()];
  const selected = records.filter((record) => {
    const scopeMatches = scope === "all"
      || (scope === "auto" ? effectiveScopeSet?.has(record.classification) === true : record.classification === scope);
    return scopeMatches
      && (filters.surface === undefined || record.surfaces?.includes(filters.surface))
      && (filters.taskFamily === undefined || record.taskFamily === filters.taskFamily);
  });
  return [
    ...(includeStaticDocs ? STATIC_DOCS_SEARCH_FILES : []),
    ...selected.map((record) => record.id),
  ];
}

export function getFigmaWorkspaceCanonicalTaskRoutes(): readonly TaskRouteDefinition[] {
  return loadCanonicalCorpus().routes.map((route) => ({
    ...route,
    surfaces: [...route.surfaces],
    aliases: [...route.aliases],
  }));
}

export function listFigmaWorkspaceCanonicalCatalog(options: {
  taskFamily?: TaskFamily;
  surface?: TaskSurface;
  classification?: CanonicalClassification;
  limit?: number;
} = {}): FigmaWorkspaceCanonicalTaskFamilySummary[] | FigmaWorkspaceCanonicalRecordSummary[] {
  const corpus = loadCanonicalCorpus();
  const limit = normalizeCatalogLimit(options.limit);
  if (options.taskFamily === undefined) {
    return corpus.routes
      .filter((route) => options.surface === undefined || route.surfaces.includes(options.surface))
      .map((route) => ({
        taskFamily: route.taskFamily,
        skill: route.skill,
        surfaces: [...route.surfaces],
        canonicalQuery: route.canonicalQuery,
        aliases: [...route.aliases],
        recordCount: [...corpus.records.values()].filter((record) =>
          record.taskFamily === route.taskFamily
          && (options.surface === undefined || record.surfaces?.includes(options.surface))
          && (options.classification === undefined || record.classification === options.classification)).length,
      }))
      .filter((summary) => options.classification === undefined || summary.recordCount > 0)
      .slice(0, limit);
  }
  return [...corpus.records.values()]
    .filter((record) => record.taskFamily === options.taskFamily)
    .filter((record) => options.surface === undefined || record.surfaces?.includes(options.surface))
    .filter((record) => options.classification === undefined || record.classification === options.classification)
    .sort((left, right) => compareAscii(left.id, right.id))
    .slice(0, limit)
    .map(canonicalRecordSummary);
}

export function readFigmaWorkspaceCanonicalDoc(id: string): FigmaWorkspaceCanonicalDoc {
  if (!/^canonical:[^\\/:]+(?:\/[^\\/:]+)*$/u.test(id) || id.includes("..") || id.includes("#")) {
    throw unknownCanonicalDocId(id);
  }
  const recordId = id.slice("canonical:".length);
  const record = loadCanonicalCorpus().records.get(recordId);
  if (!record) {
    throw unknownCanonicalDocId(id);
  }
  return {
    ...canonicalRecordSummary(record),
    kind: "canonical",
    content: record.text,
  };
}

export function getFigmaWorkspaceLookupRuntimeInfo(): FigmaWorkspaceLookupRuntimeInfo {
  if (!canonicalCorpusState.ok) {
    return { ...canonicalCorpusState.failure };
  }
  if (!pluginApiIndexState.ok) {
    return { ...pluginApiIndexState.failure };
  }
  const canonicalManifest = canonicalCorpusState.corpus.manifest;
  const apiManifest = pluginApiIndexState.index.manifest;
  return {
    ok: true,
    moduleDir: canonicalCorpusState.moduleDir,
    cwd: canonicalCorpusState.cwd,
    argv1: canonicalCorpusState.argv1,
    packageVersion: canonicalCorpusState.packageVersion,
    canonical: {
      root: canonicalCorpusState.corpus.root,
      recordCount: canonicalManifest.corpus.recordCount,
      corpusSha256: canonicalManifest.corpus.sha256,
      inventories: {
        classifications: { ...canonicalManifest.inventories.classifications },
        surfaces: { ...canonicalManifest.inventories.surfaces },
        taskFamilies: { ...canonicalManifest.inventories.taskFamilies },
      },
      routeCount: canonicalManifest.routeCatalog.routeCount,
      repository: canonicalManifest.source?.repository,
      resolvedCommit: canonicalManifest.source?.resolvedCommit,
    },
    api: {
      root: pluginApiIndexState.index.root,
      recordCount: apiManifest.index.recordCount,
      indexSha256: apiManifest.index.sha256,
      package: apiManifest.source.package,
      version: apiManifest.source.version,
    },
  };
}

export async function searchReferenceFiles(options: {
  query: string;
  files?: string[];
  maxResults: number;
  maxSnippetLines: number;
  exactSymbol?: boolean;
  corpus?: "docs" | "api";
  scope?: FigmaWorkspaceDocsLookupScope;
  surface?: TaskSurface;
  taskFamily?: TaskFamily;
  effectiveScopes?: readonly CanonicalClassification[];
}): Promise<{
  maxResults: number;
  maxSnippetLines: number;
  normalizedSymbol?: string;
  ownerHint?: string;
  results: ReferenceSearchResult[];
}> {
  const useApiCorpus = options.corpus === "api";
  const canonicalCorpus = useApiCorpus ? undefined : loadCanonicalCorpus();
  const apiIndex = useApiCorpus ? loadPluginApiIndex() : undefined;
  const projectDocsRecords = getFigmaWorkspaceProjectDocSearchRecords();
  const apiQuery = useApiCorpus ? parsePluginApiLookupQuery(options.query, apiIndex) : undefined;
  const rankingQuery = apiQuery?.normalizedSymbol ?? options.query;
  const queryTokens = tokenizeQuery(rankingQuery);
  const chunks: ReferenceChunk[] = [];
  if (apiIndex) {
    for (const record of apiIndex.records.values()) {
      chunks.push(buildPluginApiReferenceChunk(record));
    }
  }
  const files = options.files ?? (useApiCorpus
    ? []
    : docsSearchFilesForScope(options.scope ?? "auto", {
      surface: options.surface,
      taskFamily: options.taskFamily,
      effectiveScopes: options.effectiveScopes,
    }));
  for (const file of files) {
    const projectDocRecord = projectDocsRecords.get(file);
    if (projectDocRecord) {
      chunks.push(...buildReferenceChunks(projectDocRecord.id, projectDocRecord.text, staticReferenceMetadata(projectDocRecord.id, projectDocRecord.text)));
      continue;
    }
    const bridgeRecord = BRIDGE_DOCS_RECORDS.get(file);
    if (bridgeRecord) {
      chunks.push(...buildReferenceChunks(bridgeRecord.id, bridgeRecord.text, staticReferenceMetadata(bridgeRecord.id, bridgeRecord.text)));
      continue;
    }
    const canonicalRecord = canonicalCorpus?.records.get(file);
    if (canonicalRecord) {
      chunks.push(...buildReferenceChunks(
        canonicalRecord.id,
        canonicalRecord.text,
        canonicalReferenceMetadata(canonicalRecord),
      ));
      continue;
    }
  }
  const results = scoreReferenceChunks({
    chunks,
    query: rankingQuery,
    queryTokens,
    maxSnippetLines: options.maxSnippetLines,
    exactSymbol: Boolean(options.exactSymbol),
    apiQuery,
  });
  results.sort((left, right) =>
    right.score - left.score
    || compareAscii(left.taskFamily ?? "", right.taskFamily ?? "")
    || compareAscii(referenceResultId(left), referenceResultId(right))
    || left.lineStart - right.lineStart);
  const deduplicated = deduplicateResultsByPublicRecord(results);
  return {
    maxResults: options.maxResults,
    maxSnippetLines: options.maxSnippetLines,
    normalizedSymbol: apiQuery?.normalizedSymbol,
    ownerHint: apiQuery?.ownerHint,
    results: deduplicated.slice(0, options.maxResults).map(({ score: _score, ...result }) => result),
  };
}

export function normalizeLookupQuery(value: unknown, name: string): string {
  if (typeof value !== "string") {
    throw new Error(`Tool argument "${name}" is required and must be a string.`);
  }
  const query = value.trim();
  if (!query) {
    throw new Error(`Tool argument "${name}" must not be empty.`);
  }
  if (query.length > MAX_LOOKUP_QUERY_LENGTH) {
    throw new Error(`Tool argument "${name}" must be ${MAX_LOOKUP_QUERY_LENGTH} characters or fewer.`);
  }
  return query;
}

export function normalizeLookupRankingQuery(value: unknown, name: string): string {
  if (typeof value !== "string") {
    throw new Error(`Tool argument "${name}" is required and must be a string.`);
  }
  const query = value.trim();
  if (!query) {
    throw new Error(`Tool argument "${name}" must not be empty.`);
  }
  return query.slice(0, MAX_LOOKUP_QUERY_LENGTH).trimEnd();
}

const BRIDGE_DOCS_RECORDS = createBridgeDocsRecords();

function createBridgeDocsRecords(): Map<string, { id: string; text: string }> {
  const wrapperTools = "get-design-context, get-motion-context";
  const upstreamTools = "get_design_context, get_motion_context, export_video, list_shader_effects, get_shader_effect, list_shader_fills, get_shader_fill";
  const workflowIds = "design-implementation-context, motion-implementation, video-export";
  const helperCategories = "selection: $.select, $.inspect; text: $.text; placement: $.placeNode, $.findFreeSlot; assets: $.imageAsset; capture: $.capture; repair: $.checkpoint, $.remember, $.forget; clone: $.cloneNodeTree, $.replaceGeneratedFrame";
  const helperHardRules = "Use static helper references only: $.text(...), $[\"text\"](...), or explicit destructuring such as const { text } = $. Do not use dynamic $[name], alias $, object rest destructuring, or local $ declarations. Native Figma Plugin API remains valid for advanced work. $.imageAsset is only for small inline PNG/JPEG; larger files use asset manifest/upload flow.";
  return new Map([
    [
      "bridge/guidance-ref.md",
      {
        id: "bridge/guidance-ref.md",
        text: [
          "# guidanceRef",
          "Thin upstream-backed wrapper results expose a compact `guidanceRef` pointer instead of inline wrapper guidance.",
          "`guidanceRef.source` is `guidance`; pass `guidanceRef.query` to the `guidance` CLI command to retrieve matching `wrapperProfiles` and `workflowGraph` entries.",
          "`guidanceRef.workflowIds` narrows the workflow graph nodes that apply to the wrapper result.",
          "The wrapper result shape stays upstream-shaped: keep the generic `upstream` envelope and do not derive bridge-owned normalized fields from `upstream.result`.",
        ].join("\n"),
      },
    ],
    [
      "bridge/wrapper-profiles.md",
      {
        id: "bridge/wrapper-profiles.md",
        text: [
          "# Wrapper profiles",
          "The `guidance` CLI command's `wrapperProfiles` field is the detailed runtime-owned source for first-class wrapper follow-up guidance.",
          "Profiles include local tool, upstream tool, workflow ids, intents, suggested docs/API lookups, suggested tools, and next steps.",
          `Local wrapper tools: ${wrapperTools}.`,
          `Upstream tools: ${upstreamTools}.`,
          "Use wrapper profiles to choose design context, motion context, or official export_video upstream sequencing before falling back to upstream tools without local wrappers.",
        ].join("\n"),
      },
    ],
    [
      "bridge/helper-profiles.md",
      {
        id: "bridge/helper-profiles.md",
        text: [
          "# Helper profiles",
          "The `guidance` CLI command's `helperProfiles` field returns on-demand `$` helper guidance with useWhen, avoidWhen, allowedPatterns, forbiddenPatterns, API symbols, lookup hints, and compact examples.",
          `Helper categories: ${helperCategories}.`,
          `Hard rules: ${helperHardRules}`,
          "Use helper profiles for helper selection and static-reference rules; native Figma Plugin API remains valid for advanced work when helpers are too narrow.",
        ].join("\n"),
      },
    ],
    [
      "bridge/workflow-graph.md",
      {
        id: "bridge/workflow-graph.md",
        text: [
          "# Workflow graph",
          "The `guidance` CLI command's workflowGraph exposes compact executable sequencing hints for wrapper workflows.",
          `Workflow ids: ${workflowIds}.`,
          "The graph covers design implementation context, motion implementation, video export sequencing, and shader lookup flows.",
          "Use workflow graph nodes with wrapper profiles to order calls; use the `lookup` CLI command with kind=docs only for compact snippets and exact bridge-native explanations.",
        ].join("\n"),
      },
    ],
  ]);
}

function tokenizeQuery(query: string): string[] {
  return query
    .toLowerCase()
    .split(/[^a-z0-9_$:.-]+/u)
    .map((token) => token.trim())
    .filter((token) => token.length >= 2);
}

function staticReferenceMetadata(id: string, text: string): ReferenceRecordMetadata {
  const heading = /^#\s+(.+)$/mu.exec(text)?.[1]?.trim();
  return {
    classification: "active",
    publicId: id.startsWith("project:") ? id : `bridge:${id.slice("bridge/".length).replace(/\.md$/u, "")}`,
    title: heading ?? id,
  };
}

function pluginApiReferenceMetadata(record: PluginApiIndexRecord): ReferenceRecordMetadata {
  return {
    classification: "api",
    publicId: `api:${record.id}`,
    title: record.ownerSymbol ? `${record.ownerSymbol}.${record.symbol}` : record.symbol,
    indexedSymbol: record.symbol,
    ownerSymbol: record.ownerSymbol ?? undefined,
    declarationKind: record.declarationKind,
    qualifiedAliases: [...record.qualifiedAliases],
  };
}

function canonicalReferenceMetadata(record: CanonicalCorpusRecord): ReferenceRecordMetadata {
  return {
    classification: record.classification,
    publicId: `canonical:${record.id}`,
    title: record.title,
    taskFamily: record.taskFamily,
    surfaces: [...record.surfaces],
    nonExecutable: record.nonExecutable ? true : undefined,
  };
}

function buildPluginApiReferenceChunk(record: PluginApiIndexRecord): ReferenceChunk {
  const lines = record.text.split(/\r?\n/u);
  const text = lines.join("\n");
  const tokens = tokenizeReferenceText(text);
  return {
    id: record.id,
    file: record.id,
    title: record.symbol,
    lineStart: record.lineStart,
    lineEnd: record.lineEnd,
    text,
    lines,
    tokens,
    tokenCounts: countTokens(tokens),
    metadata: pluginApiReferenceMetadata(record),
    preferredLineIndex: record.declarationLine - record.lineStart,
  };
}

function buildReferenceChunks(file: string, text: string, metadata: ReferenceRecordMetadata): ReferenceChunk[] {
  const lines = text.split(/\r?\n/u);
  if (metadata.classification === "api" || file.endsWith(".d.ts")) {
    return buildDtsReferenceChunks(file, lines, metadata);
  }
  return buildMarkdownReferenceChunks(file, lines, metadata);
}

function buildMarkdownReferenceChunks(file: string, lines: string[], metadata: ReferenceRecordMetadata): ReferenceChunk[] {
  const sections: Array<{ title?: string; start: number; end: number }> = [];
  let sectionStart = 0;
  let sectionTitle: string | undefined;
  for (let index = 0; index < lines.length; index += 1) {
    const heading = /^(#{1,6})\s+(.+)\s*$/u.exec(lines[index]);
    if (!heading) {
      continue;
    }
    if (index > sectionStart) {
      sections.push({ title: sectionTitle, start: sectionStart, end: index });
    }
    sectionStart = index;
    sectionTitle = heading[2].trim();
  }
  if (sectionStart < lines.length) {
    sections.push({ title: sectionTitle, start: sectionStart, end: lines.length });
  }
  if (sections.length === 0) {
    sections.push({ start: 0, end: lines.length });
  }
  return sections.flatMap((section, sectionIndex) =>
    createWindowedReferenceChunks({
      file,
      lines,
      start: section.start,
      end: section.end,
      title: section.title,
      idPrefix: `md-${sectionIndex}`,
      metadata,
    }),
  );
}

function buildDtsReferenceChunks(file: string, lines: string[], metadata: ReferenceRecordMetadata): ReferenceChunk[] {
  const chunks: ReferenceChunk[] = [];
  const seen = new Set<string>();
  for (let index = 0; index < lines.length; index += 1) {
    if (!isDtsSymbolLine(lines[index])) {
      continue;
    }
    const start = findDtsChunkStart(lines, index);
    const end = findDtsChunkEnd(lines, index);
    const key = `${start}:${end}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    const title = extractDtsChunkTitle(lines[index]);
    chunks.push(createReferenceChunk({
      file,
      lines,
      start,
      end,
      title,
      id: `dts-${chunks.length}`,
      metadata,
    }));
  }
  return chunks;
}

function createWindowedReferenceChunks(options: {
  file: string;
  lines: string[];
  start: number;
  end: number;
  title?: string;
  idPrefix: string;
  metadata: ReferenceRecordMetadata;
}): ReferenceChunk[] {
  const chunks: ReferenceChunk[] = [];
  const size = Math.max(1, MAX_REFERENCE_CHUNK_LINES);
  const step = Math.max(1, size - REFERENCE_CHUNK_OVERLAP_LINES);
  for (let start = options.start; start < options.end; start += step) {
    const end = Math.min(options.end, start + size);
    chunks.push(createReferenceChunk({
      file: options.file,
      lines: options.lines,
      start,
      end,
      title: options.title,
      id: `${options.idPrefix}-${chunks.length}`,
      metadata: options.metadata,
    }));
    if (end >= options.end) {
      break;
    }
  }
  return chunks;
}

function createReferenceChunk(options: {
  file: string;
  lines: string[];
  start: number;
  end: number;
  title?: string;
  id: string;
  metadata: ReferenceRecordMetadata;
}): ReferenceChunk {
  const chunkLines = options.lines.slice(options.start, options.end);
  const titlePrefix = options.title ? `${options.title}\n` : "";
  const text = `${titlePrefix}${chunkLines.join("\n")}`;
  const tokens = tokenizeReferenceText(text);
  return {
    id: `${options.file}:${options.id}`,
    file: options.file,
    title: options.title,
    lineStart: options.start + 1,
    lineEnd: options.end,
    text,
    lines: chunkLines,
    tokens,
    tokenCounts: countTokens(tokens),
    metadata: options.metadata,
  };
}

function isDtsSymbolLine(line: string): boolean {
  return /^\s*(?:export\s+)?(?:declare\s+)?(?:interface|type|class|enum|namespace)\s+[$A-Z_a-z][$\w]*/u.test(line) ||
    /^\s*(?:readonly\s+)?[$A-Z_a-z][$\w]*\??\s*(?:\(|:)/u.test(line);
}

function findDtsChunkStart(lines: string[], symbolIndex: number): number {
  let start = symbolIndex;
  for (let index = symbolIndex - 1; index >= Math.max(0, symbolIndex - 18); index -= 1) {
    const line = lines[index].trim();
    if (line === "" || line.startsWith("*") || line.startsWith("/**") || line.startsWith("*/")) {
      start = index;
      continue;
    }
    break;
  }
  return start;
}

function findDtsChunkEnd(lines: string[], symbolIndex: number): number {
  let end = Math.min(lines.length, symbolIndex + 1);
  for (let index = symbolIndex + 1; index < Math.min(lines.length, symbolIndex + 10); index += 1) {
    const line = lines[index].trim();
    end = index + 1;
    if (line === "" || isDtsSymbolLine(lines[index])) {
      break;
    }
  }
  return end;
}

function extractDtsChunkTitle(line: string): string | undefined {
  const normalized = line.trim().replace(/\s+/gu, " ");
  const match = /^(?:export\s+)?(?:declare\s+)?(?:(interface|type|class|enum|namespace)\s+([$A-Z_a-z][$\w]*)|(?:readonly\s+)?([$A-Z_a-z][$\w]*)\??\s*(?:\(|:))/u.exec(normalized);
  return match ? (match[2] ?? match[3]) : undefined;
}

function parsePluginApiLookupQuery(query: string, index: PluginApiIndex | undefined): PluginApiLookupQuery {
  const normalizedInput = query.trim().replace(/;\s*$/u, "").replace(/\(\s*\)\s*$/u, "").trim();
  const segments = normalizedInput.split(".");
  if (
    segments.length === 0
    || segments.some((segment) => !/^[$A-Z_a-z][$\w]*$/u.test(segment))
  ) {
    return {
      normalizedInput,
      normalizedSymbol: normalizedInput,
      ownerKnown: false,
    };
  }
  const normalizedSymbol = segments.at(-1) ?? normalizedInput;
  const ownerHint = segments.length > 1 ? segments.slice(0, -1).join(".") : undefined;
  const knownOwners = new Set<string>();
  for (const record of index?.records.values() ?? []) {
    if (["interface", "type-alias", "class", "enum", "namespace"].includes(record.declarationKind)) {
      knownOwners.add(record.symbol);
    }
    if (record.ownerSymbol) knownOwners.add(record.ownerSymbol);
    for (const alias of record.qualifiedAliases) {
      const owner = alias.slice(0, -(record.symbol.length + 1));
      if (owner) knownOwners.add(owner);
    }
  }
  return {
    normalizedInput,
    normalizedSymbol,
    ownerHint,
    ownerKnown: ownerHint !== undefined && knownOwners.has(ownerHint),
  };
}

function pluginApiExactMatch(
  metadata: ReferenceRecordMetadata,
  query: PluginApiLookupQuery,
): { exact: boolean; ownerMatch?: boolean } {
  if (metadata.classification !== "api" || metadata.indexedSymbol !== query.normalizedSymbol) {
    return { exact: false };
  }
  if (query.ownerHint === undefined) {
    return { exact: true };
  }
  const directOwnerMatch = metadata.ownerSymbol === query.ownerHint
    || metadata.qualifiedAliases?.includes(query.normalizedInput) === true;
  if (directOwnerMatch) {
    return { exact: true, ownerMatch: true };
  }
  return query.ownerKnown
    ? { exact: true, ownerMatch: false }
    : { exact: false };
}

function scoreReferenceChunks(options: {
  chunks: ReferenceChunk[];
  query: string;
  queryTokens: string[];
  maxSnippetLines: number;
  exactSymbol: boolean;
  apiQuery?: PluginApiLookupQuery;
}): RankedReferenceSearchResult[] {
  if (options.queryTokens.length === 0 || options.chunks.length === 0) {
    return [];
  }
  const documentFrequencies = new Map<string, number>();
  for (const chunk of options.chunks) {
    for (const token of new Set(chunk.tokens)) {
      documentFrequencies.set(token, (documentFrequencies.get(token) ?? 0) + 1);
    }
  }
  const averageLength = options.chunks.reduce((sum, chunk) => sum + chunk.tokens.length, 0) / options.chunks.length;
  const lowerQuery = options.query.toLowerCase();
  const exactPattern = options.exactSymbol
    ? new RegExp(`\\b${escapeRegExp(options.query)}\\b`, "iu")
    : undefined;
  const scored = options.chunks
    .map((chunk): ScoredReferenceChunk | undefined => {
      const lowerText = chunk.text.toLowerCase();
      const apiExact = options.apiQuery
        ? pluginApiExactMatch(chunk.metadata, options.apiQuery)
        : undefined;
      const exactHit = options.exactSymbol
        ? options.apiQuery ? apiExact?.exact === true : chunk.metadata.indexedSymbol === options.query
        : exactPattern?.test(chunk.text) ?? false;
      const phraseHit = lowerText.includes(lowerQuery);
      const tokenHits = options.queryTokens.filter((token) => chunk.tokenCounts.has(token));
      if (!exactHit && !phraseHit && tokenHits.length === 0) {
        return undefined;
      }
      const bm25 = calculateBm25Score({
        chunk,
        queryTokens: options.queryTokens,
        documentFrequencies,
        documentCount: options.chunks.length,
        averageLength,
      });
      const score =
        bm25 +
        (exactHit ? (apiExact?.ownerMatch === true ? 18 : 12) : 0) +
        (phraseHit ? 4 : 0) +
        (chunk.file.endsWith(".d.ts") && exactHit ? 2 : 0);
      const matchType = exactHit ? "exact-symbol" : phraseHit ? "phrase" : "token";
      return {
        chunk,
        score,
        matchType,
        confidence: confidenceForReferenceScore(score, matchType),
        ownerMatch: apiExact?.ownerMatch,
      };
    })
    .filter((entry): entry is ScoredReferenceChunk => entry !== undefined);
  return scored.map((entry) => scoredChunkToResult(entry, {
    query: options.query,
    queryTokens: options.queryTokens,
    maxSnippetLines: options.maxSnippetLines,
    exactPattern,
  }));
}

function calculateBm25Score(options: {
  chunk: ReferenceChunk;
  queryTokens: string[];
  documentFrequencies: Map<string, number>;
  documentCount: number;
  averageLength: number;
}): number {
  const k1 = 1.5;
  const b = 0.75;
  let score = 0;
  for (const token of options.queryTokens) {
    const frequency = options.chunk.tokenCounts.get(token) ?? 0;
    if (frequency === 0) {
      continue;
    }
    const documentFrequency = options.documentFrequencies.get(token) ?? 0;
    const idf = Math.log(1 + (options.documentCount - documentFrequency + 0.5) / (documentFrequency + 0.5));
    const lengthRatio = options.averageLength > 0 ? options.chunk.tokens.length / options.averageLength : 1;
    score += idf * ((frequency * (k1 + 1)) / (frequency + k1 * (1 - b + b * lengthRatio)));
  }
  return score;
}

function scoredChunkToResult(entry: ScoredReferenceChunk, options: {
  query: string;
  queryTokens: string[];
  maxSnippetLines: number;
  exactPattern?: RegExp;
}): RankedReferenceSearchResult {
  const bestLine = entry.matchType === "exact-symbol" && entry.chunk.preferredLineIndex !== undefined
    ? entry.chunk.preferredLineIndex
    : findBestSnippetLine(entry.chunk, options);
  const contextBefore = Math.floor((options.maxSnippetLines - 1) / 2);
  const start = Math.max(0, bestLine - contextBefore);
  const end = Math.min(entry.chunk.lines.length, start + options.maxSnippetLines);
  const snippet = truncateUtf8(entry.chunk.lines.slice(start, end).join("\n"), MAX_PUBLIC_SNIPPET_BYTES);
  const metadata = entry.chunk.metadata;
  return {
    lineStart: entry.chunk.lineStart + start,
    lineEnd: entry.chunk.lineStart + end - 1,
    score: Number(entry.score.toFixed(3)),
    matchType: entry.matchType,
    confidence: entry.confidence,
    snippet,
    classification: metadata.classification,
    title: metadata.title,
    ...(metadata.classification === "api"
      ? {
        apiId: metadata.publicId,
        ownerMatch: entry.ownerMatch,
      }
      : {
        docId: metadata.publicId,
        title: metadata.title,
        taskFamily: metadata.taskFamily,
        surfaces: metadata.surfaces === undefined ? undefined : [...metadata.surfaces],
        nonExecutable: metadata.nonExecutable,
      }),
  };
}

function findBestSnippetLine(chunk: ReferenceChunk, options: {
  query: string;
  queryTokens: string[];
  exactPattern?: RegExp;
}): number {
  const lowerQuery = options.query.toLowerCase();
  let bestIndex = 0;
  let bestScore = -1;
  for (let index = 0; index < chunk.lines.length; index += 1) {
    const line = chunk.lines[index];
    const lowerLine = line.toLowerCase();
    const score =
      (options.exactPattern?.test(line) ? 20 : 0) +
      (lowerLine.includes(lowerQuery) ? 8 : 0) +
      options.queryTokens.filter((token) => lowerLine.includes(token)).length;
    if (score > bestScore) {
      bestScore = score;
      bestIndex = index;
    }
  }
  return bestIndex;
}

function confidenceForReferenceScore(score: number, matchType: ReferenceSearchResult["matchType"]): ReferenceSearchResult["confidence"] {
  if (matchType === "exact-symbol" || score >= 8) {
    return "high";
  }
  if (score >= 3) {
    return "medium";
  }
  return "low";
}

function tokenizeReferenceText(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9_$:.-]+/u)
    .map((token) => token.trim())
    .filter((token) => token.length >= 2);
}

function countTokens(tokens: string[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const token of tokens) {
    counts.set(token, (counts.get(token) ?? 0) + 1);
  }
  return counts;
}

function deduplicateResultsByPublicRecord(results: readonly RankedReferenceSearchResult[]): RankedReferenceSearchResult[] {
  const seen = new Set<string>();
  return results.filter((result) => {
    const id = referenceResultId(result);
    if (seen.has(id)) return false;
    seen.add(id);
    return true;
  });
}

function referenceResultId(result: ReferenceSearchResult): string {
  return result.docId ?? result.apiId ?? "";
}

function compareAscii(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function truncateUtf8(value: string, maximumBytes: number): string {
  if (Buffer.byteLength(value, "utf8") <= maximumBytes) return value;
  let result = "";
  let bytes = 0;
  for (const character of value) {
    const characterBytes = Buffer.byteLength(character, "utf8");
    if (bytes + characterBytes > maximumBytes) break;
    result += character;
    bytes += characterBytes;
  }
  return result;
}

function normalizeCatalogLimit(value: number | undefined): number {
  if (value === undefined) return 100;
  if (!Number.isSafeInteger(value) || value < 1 || value > 100) {
    throw new Error("Canonical catalog limit must be an integer from 1 to 100.");
  }
  return value;
}

function canonicalRecordSummary(record: CanonicalCorpusRecord): FigmaWorkspaceCanonicalRecordSummary {
  return {
    id: `canonical:${record.id}`,
    title: record.title,
    summary: record.summary,
    classification: record.classification,
    taskFamily: record.taskFamily,
    surfaces: [...record.surfaces],
    mappingProfile: record.mappingProfile,
    nonExecutable: record.nonExecutable === true,
  };
}

function unknownCanonicalDocId(id: string): Error {
  return new Error(
    `Unknown canonical Figma doc id "${id}". Use figma:docs:catalog to discover exact canonical:<record-id> values.`,
  );
}

function loadCanonicalCorpus(): CanonicalCorpus {
  if (!canonicalCorpusState.ok) {
    throw new FigmaWorkspaceLookupCorpusUnavailableError(canonicalCorpusState.failure);
  }
  return canonicalCorpusState.corpus;
}

function loadPluginApiIndex(): PluginApiIndex {
  if (!pluginApiIndexState.ok) {
    throw new FigmaWorkspaceLookupCorpusUnavailableError(pluginApiIndexState.failure);
  }
  return pluginApiIndexState.index;
}

function readCanonicalCorpusState():
  | {
    ok: true;
    corpus: CanonicalCorpus;
    moduleDir: string;
    cwd: string;
    argv1?: string;
    packageVersion?: string;
  }
  | {
    ok: false;
    failure: FigmaWorkspaceLookupCorpusFailure;
  } {
  const moduleDir = dirname(fileURLToPath(import.meta.url));
  const cwd = safeProcessCwd(moduleDir);
  const argv1 = safeProcessArgv1();
  const packageVersion = readNearestPackageVersion(moduleDir);
  const candidates = canonicalCorpusRootCandidates(moduleDir, cwd);
  try {
    const root = resolveAssetRoot(candidates, "canonical corpus");
    const manifest = parseCanonicalCorpusManifest(readFileSync(resolve(root, "manifest.json"), "utf8"));
    const corpus = readCanonicalCorpus(root, manifest);
    return { ok: true, corpus, moduleDir, cwd, argv1, packageVersion };
  } catch (error) {
    return {
      ok: false,
      failure: {
        ok: false,
        message: `Unable to load the canonical Figma docs corpus for CLI lookup: ${errorMessage(error)}`,
        moduleDir,
        cwd,
        argv1,
        packageVersion,
        attemptedPaths: candidates,
      },
    };
  }
}

function readCanonicalCorpus(root: string, manifest: CanonicalCorpusManifest): CanonicalCorpus {
  const routeCatalogText = readFileSync(resolve(root, manifest.routeCatalog.file), "utf8");
  if (sha256(routeCatalogText) !== manifest.routeCatalog.sha256) {
    throw new Error("Canonical Figma route catalog SHA-256 does not match its manifest.");
  }
  const routeCatalogValue: unknown = JSON.parse(routeCatalogText);
  const routes = parseTaskRoutingCatalog(routeCatalogValue).routes;
  if (routes.length !== manifest.routeCatalog.routeCount) {
    throw new Error("Canonical Figma route count does not match its manifest.");
  }
  const corpusText = normalizeLineEndings(readFileSync(resolve(root, manifest.corpus.file), "utf8"));
  if (sha256(corpusText) !== manifest.corpus.sha256) {
    throw new Error("Canonical Figma corpus SHA-256 does not match its manifest.");
  }
  const records = new Map<string, CanonicalCorpusRecord>();
  for (const line of corpusText.split("\n")) {
    if (!line.trim()) {
      continue;
    }
    const record = parseCanonicalCorpusRecord(line);
    if (records.has(record.id)) {
      throw new Error(`Duplicate canonical Figma corpus record: ${record.id}`);
    }
    const expectedHash = manifest.integrity.contentHashes[record.id];
    if (expectedHash !== record.contentSha256 || sha256(record.text) !== record.contentSha256) {
      throw new Error(`Canonical Figma corpus record SHA-256 mismatch: ${record.id}`);
    }
    records.set(record.id, record);
  }
  if (
    records.size !== manifest.corpus.recordCount ||
    Object.keys(manifest.integrity.contentHashes).length !== records.size
  ) {
    throw new Error("Canonical Figma corpus record count does not match its manifest.");
  }
  const actualCounts = countCanonicalClassifications(records.values());
  for (const classification of canonicalClassifications) {
    if (actualCounts[classification] !== manifest.inventories.classifications[classification]) {
      throw new Error("Canonical Figma corpus classification inventory does not match its manifest.");
    }
  }
  const actualSurfaces = countCanonicalSurfaces(records.values());
  for (const surface of canonicalSurfaces) {
    if (actualSurfaces[surface] !== manifest.inventories.surfaces[surface]) {
      throw new Error("Canonical Figma corpus surface inventory does not match its manifest.");
    }
  }
  const actualTaskFamilies = countCanonicalTaskFamilies(records.values());
  for (const taskFamily of canonicalTaskFamilies) {
    if (actualTaskFamilies[taskFamily] !== manifest.inventories.taskFamilies[taskFamily]) {
      throw new Error("Canonical Figma corpus task-family inventory does not match its manifest.");
    }
  }
  return { root, manifest, routes, records };
}

function canonicalCorpusRootCandidates(moduleDir: string, cwd: string): string[] {
  return [
    resolve(moduleDir, "../skills/figma-workspace/references/canonical-corpus"),
    resolve(moduleDir, "../../skills/figma-workspace/references/canonical-corpus"),
    resolve(moduleDir, "../../../skills/figma-workspace/references/canonical-corpus"),
    resolve(cwd, "skills/figma-workspace/references/canonical-corpus"),
    resolve(cwd, "plugins/figma-workspace/skills/figma-workspace/references/canonical-corpus"),
    resolve(cwd, "../skills/figma-workspace/references/canonical-corpus"),
  ];
}

function resolveAssetRoot(candidates: string[], label: string): string {
  for (const candidate of candidates) {
    try {
      readFileSync(resolve(candidate, "manifest.json"), "utf8");
      return candidate;
    } catch {
      // Try the next runtime layout.
    }
  }
  throw new Error(
    `no candidate contained a ${label} manifest.json`,
  );
}

function parseCanonicalCorpusManifest(text: string): CanonicalCorpusManifest {
  const value: unknown = JSON.parse(text);
  if (
    !isObject(value) ||
    value.schemaVersion !== 2 ||
    !isObject(value.corpus) ||
    !isObject(value.routeCatalog) ||
    !isObject(value.inventories) ||
    !isObject(value.inventories.classifications) ||
    !isObject(value.inventories.surfaces) ||
    !isObject(value.inventories.taskFamilies) ||
    !isObject(value.integrity) ||
    !isObject(value.integrity.contentHashes)
  ) {
    throw new Error("Invalid canonical Figma corpus manifest.");
  }
  const corpus = value.corpus;
  const routeCatalog = value.routeCatalog;
  const source = value.source;
  const classifications = value.inventories.classifications;
  const surfaces = value.inventories.surfaces;
  const taskFamilies = value.inventories.taskFamilies;
  const integrity = value.integrity;
  const contentHashesValue = integrity.contentHashes;
  if (!isObject(contentHashesValue)) {
    throw new Error("Invalid canonical Figma corpus manifest.");
  }
  if (
    typeof corpus.file !== "string" ||
    !isNonNegativeInteger(corpus.recordCount) ||
    typeof corpus.sha256 !== "string" ||
    !isSha256(corpus.sha256) ||
    corpus.file !== `corpus-${corpus.sha256}.jsonl` ||
    routeCatalog.file !== "routes.json" ||
    routeCatalog.schemaVersion !== 1 ||
    !isPositiveInteger(routeCatalog.routeCount) ||
    typeof routeCatalog.sha256 !== "string" ||
    !isSha256(routeCatalog.sha256) ||
    integrity.algorithm !== "sha256"
  ) {
    throw new Error("Invalid canonical Figma corpus manifest.");
  }
  if (source !== undefined && (
    !isObject(source) ||
    typeof source.repository !== "string" ||
    typeof source.resolvedCommit !== "string" ||
    !isGitCommitSha(source.resolvedCommit)
  )) {
    throw new Error("Invalid canonical Figma corpus provenance.");
  }
  if (
    !isExactNonNegativeInventory(classifications, canonicalClassifications) ||
    !isExactNonNegativeInventory(surfaces, canonicalSurfaces) ||
    !isExactNonNegativeInventory(taskFamilies, canonicalTaskFamilies)
  ) {
    throw new Error("Invalid canonical Figma corpus inventories.");
  }
  const contentHashes = Object.fromEntries(
    Object.entries(contentHashesValue).filter(
      (entry): entry is [string, string] => typeof entry[1] === "string" && isSha256(entry[1]),
    ),
  );
  if (Object.keys(contentHashes).length !== Object.keys(contentHashesValue).length) {
    throw new Error("Invalid canonical Figma corpus manifest.");
  }
  return {
    schemaVersion: 2,
    generatedAt: typeof value.generatedAt === "string" ? value.generatedAt : undefined,
    source: isObject(source) ? {
      repository: source.repository as string,
      resolvedCommit: source.resolvedCommit as string,
    } : undefined,
    corpus: {
      file: corpus.file,
      recordCount: corpus.recordCount,
      sha256: corpus.sha256,
    },
    routeCatalog: {
      file: routeCatalog.file,
      schemaVersion: 1,
      routeCount: routeCatalog.routeCount,
      sha256: routeCatalog.sha256,
    },
    inventories: {
      classifications: pickInventory(classifications, canonicalClassifications),
      surfaces: pickInventory(surfaces, canonicalSurfaces),
      taskFamilies: pickInventory(taskFamilies, canonicalTaskFamilies),
    },
    integrity: {
      algorithm: "sha256",
      contentHashes,
    },
  };
}

function parseCanonicalCorpusRecord(line: string): CanonicalCorpusRecord {
  const value: unknown = JSON.parse(line);
  if (
    !isObject(value) ||
    value.schemaVersion !== 2 ||
    typeof value.id !== "string" || !isSafeCanonicalRecordId(value.id) ||
    typeof value.title !== "string" || !value.title.trim() || Array.from(value.title).length > 120 ||
    typeof value.summary !== "string" || !value.summary.trim() || Array.from(value.summary).length > 240 ||
    !isCanonicalClassification(value.classification) ||
    !isTaskFamily(value.taskFamily) ||
    !isCanonicalSurfaceArray(value.surfaces) ||
    !isCanonicalMappingProfile(value.mappingProfile) ||
    value.format !== "markdown" ||
    value.sanitized !== true ||
    typeof value.sourceRecordId !== "string" || !value.sourceRecordId ||
    typeof value.sourceContract !== "string" || !value.sourceContract ||
    typeof value.targetContract !== "string" || !value.targetContract ||
    typeof value.contentSha256 !== "string" || !isSha256(value.contentSha256) ||
    typeof value.text !== "string"
  ) {
    throw new Error("Invalid canonical Figma corpus JSONL record.");
  }
  if (
    (value.classification === "examples" && value.nonExecutable !== true) ||
    (value.classification !== "examples" && value.nonExecutable !== undefined)
  ) {
    throw new Error("Invalid canonical Figma corpus record contract.");
  }
  return {
    schemaVersion: 2,
    id: value.id,
    publicId: `canonical:${value.id}`,
    title: value.title,
    summary: value.summary,
    sourceRecordId: value.sourceRecordId,
    classification: value.classification,
    taskFamily: value.taskFamily,
    surfaces: [...value.surfaces],
    mappingProfile: value.mappingProfile,
    format: value.format,
    sourceContract: value.sourceContract,
    targetContract: value.targetContract,
    sanitized: true,
    nonExecutable: value.nonExecutable === true,
    contentSha256: value.contentSha256,
    text: value.text,
  };
}

function countCanonicalClassifications(records: Iterable<CanonicalCorpusRecord>): Record<CanonicalClassification, number> {
  const counts: Record<CanonicalClassification, number> = { active: 0, conditional: 0, router: 0, examples: 0 };
  for (const record of records) {
    counts[record.classification as CanonicalClassification] += 1;
  }
  return counts;
}

function countCanonicalSurfaces(records: Iterable<CanonicalCorpusRecord>): Record<TaskSurface, number> {
  const counts: Record<TaskSurface, number> = { design: 0, figjam: 0, slides: 0 };
  for (const record of records) {
    for (const surface of record.surfaces) counts[surface] += 1;
  }
  return counts;
}

function countCanonicalTaskFamilies(records: Iterable<CanonicalCorpusRecord>): Record<TaskFamily, number> {
  const counts = Object.fromEntries(canonicalTaskFamilies.map((family) => [family, 0])) as Record<TaskFamily, number>;
  for (const record of records) counts[record.taskFamily] += 1;
  return counts;
}

function isCanonicalClassification(value: unknown): value is CanonicalClassification {
  return value === "active" || value === "conditional" || value === "router" || value === "examples";
}

function isTaskFamily(value: unknown): value is TaskFamily {
  return typeof value === "string" && (canonicalTaskFamilies as readonly string[]).includes(value);
}

function isCanonicalSurfaceArray(value: unknown): value is TaskSurface[] {
  return Array.isArray(value)
    && value.length > 0
    && value.every((surface) => typeof surface === "string" && (canonicalSurfaces as readonly string[]).includes(surface))
    && new Set(value).size === value.length;
}

function isCanonicalMappingProfile(value: unknown): value is CanonicalMappingProfile {
  return typeof value === "string" && (canonicalMappingProfiles as readonly string[]).includes(value);
}

function isSafeCanonicalRecordId(value: string): boolean {
  return !value.startsWith("/")
    && !value.includes("\\")
    && !value.includes("#")
    && value.split("/").every((segment) => segment.length > 0 && segment !== "." && segment !== "..");
}

function readPluginApiIndexState():
  | { ok: true; index: PluginApiIndex }
  | { ok: false; failure: FigmaWorkspaceLookupCorpusFailure } {
  const moduleDir = dirname(fileURLToPath(import.meta.url));
  const cwd = safeProcessCwd(moduleDir);
  const argv1 = safeProcessArgv1();
  const packageVersion = readNearestPackageVersion(moduleDir);
  const candidates = pluginApiIndexRootCandidates(moduleDir, cwd);
  try {
    const root = resolveAssetRoot(candidates, "Plugin API symbol index");
    const manifest = parsePluginApiIndexManifest(readFileSync(resolve(root, "manifest.json"), "utf8"));
    return { ok: true, index: readPluginApiIndex(root, manifest) };
  } catch (error) {
    return {
      ok: false,
      failure: {
        ok: false,
        message: `Unable to load the generated Figma Plugin API symbol index: ${errorMessage(error)}`,
        moduleDir,
        cwd,
        argv1,
        packageVersion,
        attemptedPaths: candidates,
      },
    };
  }
}

function pluginApiIndexRootCandidates(moduleDir: string, cwd: string): string[] {
  return [
    resolve(moduleDir, "figma-plugin-api-index"),
    resolve(moduleDir, "../runtime/figma-plugin-api-index"),
    resolve(cwd, "dist/runtime/figma-plugin-api-index"),
    resolve(cwd, "mcp-server/dist/runtime/figma-plugin-api-index"),
    resolve(cwd, "plugins/figma-workspace/mcp-server/dist/runtime/figma-plugin-api-index"),
  ];
}

function readPluginApiIndex(root: string, manifest: PluginApiIndexManifest): PluginApiIndex {
  for (const source of manifest.source.files) {
    const sourceText = normalizeLineEndings(readFileSync(resolve(root, "../figma-plugin-typings", source.file), "utf8"));
    if (sha256(sourceText) !== source.sha256) {
      throw new Error(`Bundled Figma Plugin API typings SHA-256 mismatch: ${source.file}`);
    }
  }
  const indexText = normalizeLineEndings(readFileSync(resolve(root, manifest.index.file), "utf8"));
  if (sha256(indexText) !== manifest.index.sha256) {
    throw new Error("Generated Figma Plugin API index SHA-256 does not match its manifest.");
  }
  const records = new Map<string, PluginApiIndexRecord>();
  for (const line of indexText.split("\n")) {
    if (!line.trim()) continue;
    const record = parsePluginApiIndexRecord(line);
    if (records.has(record.id)) throw new Error(`Duplicate Figma Plugin API index record: ${record.id}`);
    if (manifest.integrity.contentHashes[record.id] !== record.contentSha256 || sha256(record.text) !== record.contentSha256) {
      throw new Error(`Figma Plugin API index record SHA-256 mismatch: ${record.id}`);
    }
    records.set(record.id, record);
  }
  if (records.size !== manifest.index.recordCount || Object.keys(manifest.integrity.contentHashes).length !== records.size) {
    throw new Error("Figma Plugin API index record count does not match its manifest.");
  }
  return { root, manifest, records };
}

function parsePluginApiIndexManifest(text: string): PluginApiIndexManifest {
  const value: unknown = JSON.parse(text);
  if (
    !isObject(value) ||
    value.schemaVersion !== 2 ||
    !isObject(value.source) ||
    value.source.package !== "@figma/plugin-typings" ||
    typeof value.source.version !== "string" ||
    !Array.isArray(value.source.files) ||
    !isObject(value.index) ||
    !isObject(value.integrity) ||
    value.integrity.algorithm !== "sha256" ||
    !isObject(value.integrity.contentHashes)
  ) {
    throw new Error("Invalid generated Figma Plugin API index manifest.");
  }
  const sourceFiles = value.source.files.filter((entry): entry is { file: string; sha256: string } =>
    isObject(entry)
    && (entry.file === "index.d.ts" || entry.file === "plugin-api.d.ts")
    && typeof entry.sha256 === "string"
    && isSha256(entry.sha256));
  if (
    sourceFiles.length !== value.source.files.length ||
    sourceFiles.length !== 2 ||
    new Set(sourceFiles.map((entry) => entry.file)).size !== sourceFiles.length ||
    typeof value.index.file !== "string" ||
    !isNonNegativeInteger(value.index.recordCount) ||
    typeof value.index.sha256 !== "string" ||
    !isSha256(value.index.sha256) ||
    value.index.file !== `index-${value.index.sha256}.jsonl`
  ) {
    throw new Error("Invalid generated Figma Plugin API index manifest.");
  }
  return {
    schemaVersion: 2,
    source: {
      package: "@figma/plugin-typings",
      version: value.source.version,
      files: sourceFiles,
    },
    index: {
      file: value.index.file,
      recordCount: value.index.recordCount,
      sha256: value.index.sha256,
    },
    integrity: {
      algorithm: "sha256",
      contentHashes: parseHashInventory(value.integrity.contentHashes, "API index"),
    },
  };
}

function parsePluginApiIndexRecord(line: string): PluginApiIndexRecord {
  const value: unknown = JSON.parse(line);
  if (
    !isObject(value) ||
    value.schemaVersion !== 2 ||
    typeof value.id !== "string" ||
    typeof value.symbol !== "string" || !isPluginApiIdentifier(value.symbol) ||
    (value.ownerSymbol !== null && (typeof value.ownerSymbol !== "string" || !isPluginApiIdentifier(value.ownerSymbol))) ||
    !isPluginApiDeclarationKind(value.declarationKind) ||
    !Array.isArray(value.qualifiedAliases) ||
    value.qualifiedAliases.some((alias) =>
      typeof alias !== "string"
      || !alias.endsWith(`.${value.symbol}`)
      || alias.split(".").some((segment) => !isPluginApiIdentifier(segment))) ||
    new Set(value.qualifiedAliases).size !== value.qualifiedAliases.length ||
    typeof value.sourceFile !== "string" ||
    !isPositiveInteger(value.declarationLine) ||
    !isPositiveInteger(value.lineStart) ||
    !isPositiveInteger(value.lineEnd) ||
    value.declarationLine < value.lineStart ||
    value.declarationLine > value.lineEnd ||
    value.lineEnd < value.lineStart ||
    typeof value.contentSha256 !== "string" ||
    !isSha256(value.contentSha256) ||
    typeof value.text !== "string"
  ) {
    throw new Error("Invalid generated Figma Plugin API index JSONL record.");
  }
  return {
    schemaVersion: 2,
    id: value.id,
    symbol: value.symbol,
    ownerSymbol: value.ownerSymbol,
    declarationKind: value.declarationKind,
    qualifiedAliases: [...value.qualifiedAliases],
    sourceFile: value.sourceFile,
    declarationLine: value.declarationLine,
    lineStart: value.lineStart,
    lineEnd: value.lineEnd,
    contentSha256: value.contentSha256,
    text: value.text,
  };
}

function parseHashInventory(value: Record<string, unknown>, label: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [id, hash] of Object.entries(value)) {
    if (typeof hash !== "string" || !isSha256(hash)) {
      throw new Error(`Invalid derived Figma active ${label} hash inventory.`);
    }
    result[id] = hash;
  }
  return result;
}

function isPluginApiDeclarationKind(value: unknown): value is PluginApiDeclarationKind {
  return typeof value === "string" && (pluginApiDeclarationKinds as readonly string[]).includes(value);
}

function isPluginApiIdentifier(value: string): boolean {
  return /^[$A-Z_a-z][$\w]*$/u.test(value);
}

function isExactNonNegativeInventory<const Key extends string>(
  value: Record<string, unknown>,
  keys: readonly Key[],
): boolean {
  return Object.keys(value).length === keys.length
    && keys.every((key) => isNonNegativeInteger(value[key]));
}

function pickInventory<const Key extends string>(
  value: Record<string, unknown>,
  keys: readonly Key[],
): Record<Key, number> {
  return Object.fromEntries(keys.map((key) => [key, value[key] as number])) as Record<Key, number>;
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function normalizeLineEndings(value: string): string {
  return value.replace(/\r\n/gu, "\n");
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function isSha256(value: string): boolean {
  return /^[a-f0-9]{64}$/u.test(value);
}

function isGitCommitSha(value: string): boolean {
  return /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u.test(value);
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

function readNearestPackageVersion(startDir: string): string | undefined {
  for (const candidate of packageJsonCandidates(startDir)) {
    try {
      const value: unknown = JSON.parse(readFileSync(candidate, "utf8"));
      if (isObject(value) && typeof value.version === "string") {
        return value.version;
      }
    } catch {
      // Try the next package.json candidate.
    }
  }
  return undefined;
}

function packageJsonCandidates(startDir: string): string[] {
  return [
    resolve(startDir, "../package.json"),
    resolve(startDir, "../../package.json"),
    resolve(startDir, "../../../package.json"),
    resolve(startDir, "../../../../package.json"),
  ];
}

function safeProcessCwd(fallback: string): string {
  try {
    return typeof process !== "undefined" && typeof process.cwd === "function"
      ? process.cwd()
      : fallback;
  } catch {
    return fallback;
  }
}

function safeProcessArgv1(): string | undefined {
  return typeof process !== "undefined" && Array.isArray(process.argv) ? process.argv[1] : undefined;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
