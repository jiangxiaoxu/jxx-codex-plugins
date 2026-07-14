import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  FIGMA_WORKSPACE_PROJECT_DOC_FILES,
  getFigmaWorkspaceProjectDocSearchRecords,
} from "./project-docs.js";
import type { FigmaWorkspaceDocsLookupScope } from "../contract/tool-args.js";

export const DEFAULT_DOCS_SEARCH_MAX_RESULTS = 5;
export const DEFAULT_DOCS_SEARCH_SNIPPET_LINES = 3;
export const MAX_DOCS_SEARCH_RESULTS = 10;
export const MAX_DOCS_SEARCH_SNIPPET_LINES = 8;
export const DEFAULT_REFERENCE_CONTEXT_SNIPPETS = 2;
export const MAX_LOOKUP_QUERY_LENGTH = 120;

const MAX_REFERENCE_CHUNK_LINES = 24;
const REFERENCE_CHUNK_OVERLAP_LINES = 4;

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

export const API_LOOKUP_FILES = [
  "figma-use/references/plugin-api-standalone.d.ts",
];

export interface ReferenceSearchResult {
  sourceId: string;
  lineStart: number;
  lineEnd: number;
  score: number;
  matchType: "exact-symbol" | "phrase" | "token";
  confidence: "high" | "medium" | "low";
  chunkTitle?: string;
  snippet: string;
  classification?: UpstreamActiveClassification;
  sourceRecordId?: string;
  sourceContract?: string;
  targetContract?: string;
  sanitized?: boolean;
  sourceContentSha256?: string;
  derivedContentSha256?: string;
  nonExecutable?: boolean;
}

type UpstreamActiveClassification = "active" | "conditional" | "router" | "examples" | "api";

interface ReferenceRecordMetadata {
  classification: UpstreamActiveClassification;
  sourceRecordId: string;
  sourceContract: string;
  targetContract: string;
  sanitized: boolean;
  sourceContentSha256: string;
  derivedContentSha256: string;
  nonExecutable?: boolean;
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
}

interface UpstreamCorpusManifest {
  schemaVersion: 2;
  upstream: {
    repository: string;
    requestedRef: string;
    resolvedCommit: string;
    sourcePath: string;
    termsUrl: string;
  };
  corpus: {
    file: string;
    recordCount: number;
    sha256: string;
    contract: string;
  };
  includedSkills: string[];
  outOfScopeSkills: Array<{ skill: string; reason: string }>;
  integrity: {
    algorithm: "sha256";
    textNormalization: "crlf-to-lf";
    contentHashes: Record<string, string>;
  };
}

interface UpstreamCorpusRecord {
  schemaVersion: 2;
  id: string;
  skill: string;
  kind: string;
  format: "javascript" | "markdown" | "typescript";
  sourcePath: string;
  lineCount: number;
  contentSha256: string;
  text: string;
}

interface UpstreamCorpus {
  root: string;
  manifest: UpstreamCorpusManifest;
  records: Map<string, UpstreamCorpusRecord>;
}

interface UpstreamActiveManifest {
  schemaVersion: 1;
  generatedAt: string;
  parent: {
    repository: string;
    resolvedCommit: string;
    corpus: { file: string; recordCount: number; sha256: string };
  };
  corpus: { file: string; recordCount: number; sha256: string };
  queryableRecordCount: number;
  pendingCount: number;
  retiredCount: number;
  classificationCounts: Record<UpstreamActiveClassification, number>;
  pendingRecords: Array<Record<string, unknown>>;
  retiredRecords: Array<Record<string, unknown>>;
  integrity: {
    algorithm: "sha256";
    sourceContentHashes: Record<string, string>;
    derivedContentHashes: Record<string, string>;
  };
}

interface UpstreamActiveRecord extends ReferenceRecordMetadata {
  schemaVersion: 1;
  id: string;
  format: "javascript" | "markdown";
  nonExecutable: boolean;
  text: string;
}

interface UpstreamActiveCorpus {
  root: string;
  manifest: UpstreamActiveManifest;
  records: Map<string, UpstreamActiveRecord>;
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
    root: string;
    moduleDir: string;
    cwd: string;
    argv1?: string;
    packageVersion?: string;
    recordCount: number;
    repository: string;
    requestedRef: string;
    resolvedCommit: string;
    corpusSha256: string;
    raw: {
      root: string;
      recordCount: number;
      corpusSha256: string;
    };
    active: {
      root: string;
      recordCount: number;
      queryableRecordCount: number;
      corpusSha256: string;
      parentResolvedCommit: string;
      parentCorpusSha256: string;
      classificationCounts: Record<UpstreamActiveClassification, number>;
      pendingCount: number;
      staleCount: number;
      retiredCount: number;
      pendingRecords: Array<Record<string, unknown>>;
      retiredRecords: Array<Record<string, unknown>>;
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
}

const upstreamCorpusState = readUpstreamCorpusState();
const upstreamActiveCorpusState = readUpstreamActiveCorpusState(upstreamCorpusState);

export const DOCS_SEARCH_ALLOWLIST = docsSearchFilesForScope("active");

export function docsSearchFilesForScope(scope: FigmaWorkspaceDocsLookupScope): string[] {
  if (!upstreamActiveCorpusState.ok) {
    return scope === "active" || scope === "all" ? [...STATIC_DOCS_SEARCH_FILES] : [];
  }
  const records = [...upstreamActiveCorpusState.corpus.records.values()];
  const selected = records.filter((record) => {
    if (scope === "all") {
      return true;
    }
    return record.classification === scope;
  });
  return [
    ...(scope === "active" || scope === "all" ? STATIC_DOCS_SEARCH_FILES : []),
    ...selected.map((record) => record.id),
  ];
}

export function getFigmaWorkspaceLookupRuntimeInfo(): FigmaWorkspaceLookupRuntimeInfo {
  if (!upstreamCorpusState.ok) {
    return { ...upstreamCorpusState.failure };
  }
  if (!upstreamActiveCorpusState.ok) {
    return { ...upstreamActiveCorpusState.failure };
  }
  const activeManifest = upstreamActiveCorpusState.corpus.manifest;
  return {
    ok: true,
    root: upstreamCorpusState.corpus.root,
    moduleDir: upstreamCorpusState.moduleDir,
    cwd: upstreamCorpusState.cwd,
    argv1: upstreamCorpusState.argv1,
    packageVersion: upstreamCorpusState.packageVersion,
    recordCount: upstreamCorpusState.corpus.records.size,
    repository: upstreamCorpusState.corpus.manifest.upstream.repository,
    requestedRef: upstreamCorpusState.corpus.manifest.upstream.requestedRef,
    resolvedCommit: upstreamCorpusState.corpus.manifest.upstream.resolvedCommit,
    corpusSha256: upstreamCorpusState.corpus.manifest.corpus.sha256,
    raw: {
      root: upstreamCorpusState.corpus.root,
      recordCount: upstreamCorpusState.corpus.records.size,
      corpusSha256: upstreamCorpusState.corpus.manifest.corpus.sha256,
    },
    active: {
      root: upstreamActiveCorpusState.corpus.root,
      recordCount: activeManifest.corpus.recordCount,
      queryableRecordCount: activeManifest.queryableRecordCount,
      corpusSha256: activeManifest.corpus.sha256,
      parentResolvedCommit: activeManifest.parent.resolvedCommit,
      parentCorpusSha256: activeManifest.parent.corpus.sha256,
      classificationCounts: { ...activeManifest.classificationCounts },
      pendingCount: activeManifest.pendingCount,
      staleCount: activeManifest.pendingRecords.filter((record) => record.drift === "changed").length,
      retiredCount: activeManifest.retiredCount,
      pendingRecords: activeManifest.pendingRecords.map((record) => ({ ...record })),
      retiredRecords: activeManifest.retiredRecords.map((record) => ({ ...record })),
    },
  };
}

export async function searchReferenceFiles(options: {
  query: string;
  files: string[];
  maxResults: number;
  maxSnippetLines: number;
  exactSymbol?: boolean;
  corpus?: "docs" | "api";
}): Promise<{
  maxResults: number;
  maxSnippetLines: number;
  results: ReferenceSearchResult[];
}> {
  const useApiCorpus = options.corpus === "api";
  const corpus = useApiCorpus ? loadUpstreamCorpus() : undefined;
  const activeCorpus = loadUpstreamActiveCorpus();
  const projectDocsRecords = getFigmaWorkspaceProjectDocSearchRecords();
  const queryTokens = tokenizeQuery(options.query);
  const chunks: ReferenceChunk[] = [];
  for (const file of options.files) {
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
    const activeRecord = activeCorpus.records.get(file);
    if (activeRecord) {
      chunks.push(...buildReferenceChunks(activeRecord.id, activeRecord.text, activeRecord));
      continue;
    }
    const record = corpus?.records.get(file);
    if (!record) {
      continue;
    }
    if (activeCorpus.manifest.integrity.sourceContentHashes[record.id] !== record.contentSha256) {
      continue;
    }
    chunks.push(...buildReferenceChunks(record.id, record.text, rawReferenceMetadata(record)));
  }
  const results = scoreReferenceChunks({
    chunks,
    query: options.query,
    queryTokens,
    maxSnippetLines: options.maxSnippetLines,
    exactSymbol: Boolean(options.exactSymbol),
  });
  results.sort((left, right) => right.score - left.score || left.sourceId.localeCompare(right.sourceId) || left.lineStart - right.lineStart);
  return {
    maxResults: options.maxResults,
    maxSnippetLines: options.maxSnippetLines,
    results: results.slice(0, options.maxResults),
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
  const helperCategories = "selection: $.select, $.inspect; text: $.text; placement: $.placeNode, $.findFreeSlot; assets: $.imageAsset; capture: $.screenshot; repair: $.checkpoint, $.remember, $.forget; clone: $.cloneNodeTree, $.replaceGeneratedFrame";
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
  const contentSha256 = sha256(normalizeLineEndings(text));
  return {
    classification: "active",
    sourceRecordId: id,
    sourceContract: "figma-workspace-docs",
    targetContract: "figma-workspace-cli",
    sanitized: false,
    sourceContentSha256: contentSha256,
    derivedContentSha256: contentSha256,
  };
}

function rawReferenceMetadata(record: UpstreamCorpusRecord): ReferenceRecordMetadata {
  return {
    classification: "api",
    sourceRecordId: record.id,
    sourceContract: "figma-mcp",
    targetContract: "figma-workspace-cli",
    sanitized: false,
    sourceContentSha256: record.contentSha256,
    derivedContentSha256: record.contentSha256,
  };
}

function buildReferenceChunks(file: string, text: string, metadata: ReferenceRecordMetadata): ReferenceChunk[] {
  const lines = text.split(/\r?\n/u);
  if (file.endsWith(".d.ts")) {
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

function scoreReferenceChunks(options: {
  chunks: ReferenceChunk[];
  query: string;
  queryTokens: string[];
  maxSnippetLines: number;
  exactSymbol: boolean;
}): ReferenceSearchResult[] {
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
      const exactHit = exactPattern?.test(chunk.text) ?? false;
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
        (exactHit ? 12 : 0) +
        (phraseHit ? 4 : 0) +
        (chunk.file.endsWith(".d.ts") && exactHit ? 2 : 0);
      const matchType = exactHit ? "exact-symbol" : phraseHit ? "phrase" : "token";
      return {
        chunk,
        score,
        matchType,
        confidence: confidenceForReferenceScore(score, matchType),
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
}): ReferenceSearchResult {
  const bestLine = findBestSnippetLine(entry.chunk, options);
  const contextBefore = Math.floor((options.maxSnippetLines - 1) / 2);
  const start = Math.max(0, bestLine - contextBefore);
  const end = Math.min(entry.chunk.lines.length, start + options.maxSnippetLines);
  const snippet = entry.chunk.lines.slice(start, end).join("\n").slice(0, 2400);
  return {
    sourceId: publicReferenceSourceId(entry.chunk.file, entry.chunk.id),
    lineStart: entry.chunk.lineStart + start,
    lineEnd: entry.chunk.lineStart + end - 1,
    score: Number(entry.score.toFixed(3)),
    matchType: entry.matchType,
    confidence: entry.confidence,
    chunkTitle: entry.chunk.title,
    snippet,
    ...entry.chunk.metadata,
  };
}

function publicReferenceSourceId(file: string, chunkId: string): string {
  if (file.startsWith("project:")) {
    const chunk = chunkId.split(":").pop() ?? "chunk";
    return `${file}#${chunk}`;
  }
  const normalized = file
    .replace(/\/references\//gu, "/")
    .replace(/\/SKILL\.md$/u, "/skill")
    .replace(/\.(?:md|d\.ts)$/u, "")
    .replace(/[^A-Za-z0-9_:/.-]+/gu, "-");
  const chunk = chunkId.split(":").pop() ?? "chunk";
  return `internal:${normalized}#${chunk}`;
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

function loadUpstreamCorpus(): UpstreamCorpus {
  if (!upstreamCorpusState.ok) {
    throw new FigmaWorkspaceLookupCorpusUnavailableError(upstreamCorpusState.failure);
  }
  return upstreamCorpusState.corpus;
}

function loadUpstreamActiveCorpus(): UpstreamActiveCorpus {
  if (!upstreamActiveCorpusState.ok) {
    throw new FigmaWorkspaceLookupCorpusUnavailableError(upstreamActiveCorpusState.failure);
  }
  return upstreamActiveCorpusState.corpus;
}

function readUpstreamActiveCorpusState(
  rawState: ReturnType<typeof readUpstreamCorpusState>,
):
  | {
    ok: true;
    corpus: UpstreamActiveCorpus;
  }
  | {
    ok: false;
    failure: FigmaWorkspaceLookupCorpusFailure;
  } {
  if (!rawState.ok) {
    return rawState;
  }
  const candidates = upstreamActiveCorpusRootCandidates(
    rawState.corpus.root,
    rawState.moduleDir,
    rawState.cwd,
  );
  try {
    const root = resolveUpstreamCorpusRoot(candidates);
    const manifest = parseUpstreamActiveManifest(readFileSync(resolve(root, "manifest.json"), "utf8"));
    const corpus = readUpstreamActiveCorpus(root, manifest, rawState.corpus);
    return { ok: true, corpus };
  } catch (error) {
    return {
      ok: false,
      failure: {
        ok: false,
        message: `Unable to locate the derived Figma active index for CLI docs lookup: ${errorMessage(error)}`,
        moduleDir: rawState.moduleDir,
        cwd: rawState.cwd,
        argv1: rawState.argv1,
        packageVersion: rawState.packageVersion,
        attemptedPaths: candidates,
      },
    };
  }
}

function readUpstreamActiveCorpus(
  root: string,
  manifest: UpstreamActiveManifest,
  rawCorpus: UpstreamCorpus,
): UpstreamActiveCorpus {
  if (
    manifest.parent.repository !== rawCorpus.manifest.upstream.repository ||
    manifest.parent.resolvedCommit !== rawCorpus.manifest.upstream.resolvedCommit ||
    manifest.parent.corpus.file !== rawCorpus.manifest.corpus.file ||
    manifest.parent.corpus.recordCount !== rawCorpus.manifest.corpus.recordCount ||
    manifest.parent.corpus.sha256 !== rawCorpus.manifest.corpus.sha256
  ) {
    throw new Error("Derived Figma active index parent does not match the bundled raw snapshot.");
  }
  const corpusText = normalizeLineEndings(readFileSync(resolve(root, manifest.corpus.file), "utf8"));
  if (sha256(corpusText) !== manifest.corpus.sha256) {
    throw new Error("Derived Figma active corpus SHA-256 does not match its manifest.");
  }
  const records = new Map<string, UpstreamActiveRecord>();
  for (const line of corpusText.split("\n")) {
    if (!line.trim()) {
      continue;
    }
    const record = parseUpstreamActiveRecord(line);
    if (records.has(record.id)) {
      throw new Error(`Duplicate derived Figma active record: ${record.id}`);
    }
    const source = rawCorpus.records.get(record.sourceRecordId);
    if (
      !source ||
      source.id !== record.id ||
      source.contentSha256 !== record.sourceContentSha256 ||
      manifest.integrity.sourceContentHashes[record.id] !== record.sourceContentSha256
    ) {
      throw new Error(`Derived Figma active source integrity mismatch: ${record.id}`);
    }
    if (
      manifest.integrity.derivedContentHashes[record.id] !== record.derivedContentSha256 ||
      sha256(record.text) !== record.derivedContentSha256
    ) {
      throw new Error(`Derived Figma active content integrity mismatch: ${record.id}`);
    }
    if (record.format === "markdown") {
      if (source.format !== "markdown" || !record.sanitized || record.nonExecutable) {
        throw new Error(`Derived Figma Markdown record contract mismatch: ${record.id}`);
      }
    } else if (
      source.format !== "javascript" ||
      record.classification !== "examples" ||
      record.sanitized ||
      !record.nonExecutable
    ) {
      throw new Error(`Derived Figma example record contract mismatch: ${record.id}`);
    }
    records.set(record.id, record);
  }
  if (
    records.size !== manifest.corpus.recordCount ||
    records.size !== manifest.queryableRecordCount ||
    Object.keys(manifest.integrity.derivedContentHashes).length !== records.size
  ) {
    throw new Error("Derived Figma active corpus record count does not match its manifest.");
  }
  const classifiedRecordCount = Object.values(manifest.classificationCounts)
    .reduce((sum, count) => sum + count, 0);
  if (classifiedRecordCount !== rawCorpus.records.size + manifest.retiredCount) {
    throw new Error("Derived Figma active classification inventory does not match its parent snapshot.");
  }
  for (const [id, sourceHash] of Object.entries(manifest.integrity.sourceContentHashes)) {
    if (!isSha256(sourceHash) || rawCorpus.records.get(id)?.contentSha256 !== sourceHash) {
      throw new Error(`Derived Figma active source hash inventory mismatch: ${id}`);
    }
  }
  return { root, manifest, records };
}

function upstreamActiveCorpusRootCandidates(rawRoot: string, moduleDir: string, cwd: string): string[] {
  return [
    resolve(rawRoot, "../upstream-active"),
    resolve(moduleDir, "../skills/figma-workspace/references/upstream-active"),
    resolve(moduleDir, "../../skills/figma-workspace/references/upstream-active"),
    resolve(moduleDir, "../../../skills/figma-workspace/references/upstream-active"),
    resolve(cwd, "skills/figma-workspace/references/upstream-active"),
    resolve(cwd, "plugins/figma-workspace/skills/figma-workspace/references/upstream-active"),
    resolve(cwd, "../skills/figma-workspace/references/upstream-active"),
  ];
}

function readUpstreamCorpusState():
  | {
    ok: true;
    corpus: UpstreamCorpus;
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
  const candidates = upstreamCorpusRootCandidates(moduleDir, cwd);
  try {
    const root = resolveUpstreamCorpusRoot(candidates);
    const manifest = parseUpstreamCorpusManifest(readFileSync(resolve(root, "manifest.json"), "utf8"));
    const corpus = readUpstreamCorpus(root, manifest);
    return { ok: true, corpus, moduleDir, cwd, argv1, packageVersion };
  } catch (error) {
    return {
      ok: false,
      failure: {
        ok: false,
        message: `Unable to locate the internal Figma corpus for CLI docs/API lookup: ${errorMessage(error)}`,
        moduleDir,
        cwd,
        argv1,
        packageVersion,
        attemptedPaths: candidates,
      },
    };
  }
}

function readUpstreamCorpus(root: string, manifest: UpstreamCorpusManifest): UpstreamCorpus {
  const corpusText = normalizeLineEndings(readFileSync(resolve(root, manifest.corpus.file), "utf8"));
  if (sha256(corpusText) !== manifest.corpus.sha256) {
    throw new Error("Internal Figma upstream corpus SHA-256 does not match its manifest.");
  }
  const records = new Map<string, UpstreamCorpusRecord>();
  for (const line of corpusText.split("\n")) {
    if (!line.trim()) {
      continue;
    }
    const record = parseUpstreamCorpusRecord(line);
    if (records.has(record.id)) {
      throw new Error(`Duplicate internal Figma upstream corpus record: ${record.id}`);
    }
    const expectedHash = manifest.integrity.contentHashes[record.id];
    if (expectedHash !== record.contentSha256 || sha256(record.text) !== record.contentSha256) {
      throw new Error(`Internal Figma upstream corpus record SHA-256 mismatch: ${record.id}`);
    }
    records.set(record.id, record);
  }
  if (
    records.size !== manifest.corpus.recordCount ||
    Object.keys(manifest.integrity.contentHashes).length !== records.size
  ) {
    throw new Error("Internal Figma upstream corpus record count does not match its manifest.");
  }
  const actualSkills = [...new Set([...records.values()].map((record) => record.skill))].sort();
  if (actualSkills.join("\n") !== [...manifest.includedSkills].sort().join("\n")) {
    throw new Error("Internal Figma upstream corpus skill inventory does not match its manifest.");
  }
  return { root, manifest, records };
}

function upstreamCorpusRootCandidates(moduleDir: string, cwd: string): string[] {
  return [
    resolve(moduleDir, "../skills/figma-workspace/references/upstream-corpus"),
    resolve(moduleDir, "../../skills/figma-workspace/references/upstream-corpus"),
    resolve(moduleDir, "../../../skills/figma-workspace/references/upstream-corpus"),
    resolve(cwd, "skills/figma-workspace/references/upstream-corpus"),
    resolve(cwd, "plugins/figma-workspace/skills/figma-workspace/references/upstream-corpus"),
    resolve(cwd, "../skills/figma-workspace/references/upstream-corpus"),
  ];
}

function resolveUpstreamCorpusRoot(candidates: string[]): string {
  for (const candidate of candidates) {
    try {
      readFileSync(resolve(candidate, "manifest.json"), "utf8");
      return candidate;
    } catch {
      // Try the next runtime layout.
    }
  }
  throw new Error(
    "no candidate contained an upstream corpus manifest.json",
  );
}

function parseUpstreamCorpusManifest(text: string): UpstreamCorpusManifest {
  const value: unknown = JSON.parse(text);
  if (
    !isObject(value) ||
    value.schemaVersion !== 2 ||
    !isObject(value.upstream) ||
    !isObject(value.corpus) ||
    !isObject(value.integrity) ||
    !isObject(value.integrity.contentHashes)
  ) {
    throw new Error("Invalid internal Figma upstream corpus manifest.");
  }
  const upstream = value.upstream;
  const corpus = value.corpus;
  const integrity = value.integrity;
  const contentHashesValue = integrity.contentHashes;
  if (!isObject(contentHashesValue)) {
    throw new Error("Invalid internal Figma upstream corpus manifest.");
  }
  if (
    typeof upstream.repository !== "string" ||
    typeof upstream.requestedRef !== "string" ||
    typeof upstream.resolvedCommit !== "string" ||
    !isGitCommitSha(upstream.resolvedCommit) ||
    typeof upstream.sourcePath !== "string" ||
    typeof upstream.termsUrl !== "string" ||
    typeof corpus.file !== "string" ||
    typeof corpus.recordCount !== "number" ||
    !Number.isSafeInteger(corpus.recordCount) ||
    corpus.recordCount < 1 ||
    typeof corpus.sha256 !== "string" ||
    !isSha256(corpus.sha256) ||
    corpus.file !== `corpus-${corpus.sha256}.jsonl` ||
    typeof corpus.contract !== "string" ||
    integrity.algorithm !== "sha256" ||
    integrity.textNormalization !== "crlf-to-lf"
  ) {
    throw new Error("Invalid internal Figma upstream corpus manifest.");
  }
  const contentHashes = Object.fromEntries(
    Object.entries(contentHashesValue).filter(
      (entry): entry is [string, string] => typeof entry[1] === "string" && isSha256(entry[1]),
    ),
  );
  if (Object.keys(contentHashes).length !== Object.keys(contentHashesValue).length) {
    throw new Error("Invalid internal Figma upstream corpus manifest.");
  }
  const includedSkills = Array.isArray(value.includedSkills)
    ? value.includedSkills.filter((item): item is string => typeof item === "string")
    : [];
  const outOfScopeSkills = Array.isArray(value.outOfScopeSkills)
    ? value.outOfScopeSkills.filter((item): item is { skill: string; reason: string } =>
      isObject(item) && typeof item.skill === "string" && typeof item.reason === "string")
    : [];
  return {
    schemaVersion: 2,
    upstream: {
      repository: upstream.repository,
      requestedRef: upstream.requestedRef,
      resolvedCommit: upstream.resolvedCommit,
      sourcePath: upstream.sourcePath,
      termsUrl: upstream.termsUrl,
    },
    corpus: {
      file: corpus.file,
      recordCount: corpus.recordCount,
      sha256: corpus.sha256,
      contract: corpus.contract,
    },
    includedSkills,
    outOfScopeSkills,
    integrity: {
      algorithm: "sha256",
      textNormalization: "crlf-to-lf",
      contentHashes,
    },
  };
}

function parseUpstreamCorpusRecord(line: string): UpstreamCorpusRecord {
  const value: unknown = JSON.parse(line);
  if (
    !isObject(value) ||
    value.schemaVersion !== 2 ||
    typeof value.id !== "string" ||
    typeof value.skill !== "string" ||
    typeof value.kind !== "string" ||
    (value.format !== "javascript" && value.format !== "markdown" && value.format !== "typescript") ||
    typeof value.sourcePath !== "string" ||
    typeof value.lineCount !== "number" ||
    typeof value.contentSha256 !== "string" ||
    !isSha256(value.contentSha256) ||
    typeof value.text !== "string"
  ) {
    throw new Error("Invalid internal Figma upstream corpus JSONL record.");
  }
  return {
    schemaVersion: 2,
    id: value.id,
    skill: value.skill,
    kind: value.kind,
    format: value.format,
    sourcePath: value.sourcePath,
    lineCount: value.lineCount,
    contentSha256: value.contentSha256,
    text: value.text,
  };
}

function parseUpstreamActiveManifest(text: string): UpstreamActiveManifest {
  const value: unknown = JSON.parse(text);
  if (
    !isObject(value) ||
    value.schemaVersion !== 1 ||
    typeof value.generatedAt !== "string" ||
    !isObject(value.parent) ||
    !isObject(value.parent.corpus) ||
    !isObject(value.corpus) ||
    !isObject(value.classificationCounts) ||
    !Array.isArray(value.pendingRecords) ||
    !Array.isArray(value.retiredRecords) ||
    value.pendingRecords.some((record) => !isObject(record)) ||
    value.retiredRecords.some((record) => !isObject(record)) ||
    !isObject(value.integrity) ||
    !isObject(value.integrity.sourceContentHashes) ||
    !isObject(value.integrity.derivedContentHashes)
  ) {
    throw new Error("Invalid derived Figma active manifest.");
  }
  const parent = value.parent;
  const parentCorpus = parent.corpus as Record<string, unknown>;
  const corpus = value.corpus;
  const classificationCountsValue = value.classificationCounts;
  const integrity = value.integrity;
  if (
    typeof parent.repository !== "string" ||
    typeof parent.resolvedCommit !== "string" ||
    !isGitCommitSha(parent.resolvedCommit) ||
    typeof parentCorpus.file !== "string" ||
    !isNonNegativeInteger(parentCorpus.recordCount) ||
    typeof parentCorpus.sha256 !== "string" ||
    !isSha256(parentCorpus.sha256) ||
    typeof corpus.file !== "string" ||
    !isNonNegativeInteger(corpus.recordCount) ||
    typeof corpus.sha256 !== "string" ||
    !isSha256(corpus.sha256) ||
    corpus.file !== `corpus-${corpus.sha256}.jsonl` ||
    !isNonNegativeInteger(value.queryableRecordCount) ||
    !isNonNegativeInteger(value.pendingCount) ||
    !isNonNegativeInteger(value.retiredCount) ||
    value.pendingCount !== value.pendingRecords.length ||
    value.retiredCount !== value.retiredRecords.length ||
    integrity.algorithm !== "sha256"
  ) {
    throw new Error("Invalid derived Figma active manifest.");
  }
  const classifications: UpstreamActiveClassification[] = ["active", "conditional", "router", "examples", "api"];
  if (
    Object.keys(classificationCountsValue).length !== classifications.length ||
    classifications.some((classification) => !isNonNegativeInteger(classificationCountsValue[classification]))
  ) {
    throw new Error("Invalid derived Figma active classification counts.");
  }
  const sourceContentHashes = parseHashInventory(
    integrity.sourceContentHashes as Record<string, unknown>,
    "source",
  );
  const derivedContentHashes = parseHashInventory(
    integrity.derivedContentHashes as Record<string, unknown>,
    "derived",
  );
  return {
    schemaVersion: 1,
    generatedAt: value.generatedAt,
    parent: {
      repository: parent.repository,
      resolvedCommit: parent.resolvedCommit,
      corpus: {
        file: parentCorpus.file,
        recordCount: parentCorpus.recordCount,
        sha256: parentCorpus.sha256,
      },
    },
    corpus: {
      file: corpus.file,
      recordCount: corpus.recordCount,
      sha256: corpus.sha256,
    },
    queryableRecordCount: value.queryableRecordCount,
    pendingCount: value.pendingCount,
    retiredCount: value.retiredCount,
    classificationCounts: Object.fromEntries(
      classifications.map((classification) => [classification, classificationCountsValue[classification]]),
    ) as Record<UpstreamActiveClassification, number>,
    pendingRecords: value.pendingRecords.filter(isObject),
    retiredRecords: value.retiredRecords.filter(isObject),
    integrity: {
      algorithm: "sha256",
      sourceContentHashes,
      derivedContentHashes,
    },
  };
}

function parseUpstreamActiveRecord(line: string): UpstreamActiveRecord {
  const value: unknown = JSON.parse(line);
  if (
    !isObject(value) ||
    value.schemaVersion !== 1 ||
    typeof value.id !== "string" ||
    typeof value.sourceRecordId !== "string" ||
    !isUpstreamActiveClassification(value.classification) ||
    value.classification === "api" ||
    (value.format !== "javascript" && value.format !== "markdown") ||
    typeof value.sourceContract !== "string" ||
    value.sourceContract !== "figma-mcp" ||
    typeof value.targetContract !== "string" ||
    value.targetContract !== "figma-workspace-cli" ||
    typeof value.sanitized !== "boolean" ||
    typeof value.nonExecutable !== "boolean" ||
    typeof value.sourceContentSha256 !== "string" ||
    !isSha256(value.sourceContentSha256) ||
    typeof value.derivedContentSha256 !== "string" ||
    !isSha256(value.derivedContentSha256) ||
    typeof value.text !== "string"
  ) {
    throw new Error("Invalid derived Figma active JSONL record.");
  }
  if (
    value.format === "markdown" &&
    value.classification !== "active" &&
    value.classification !== "conditional" &&
    value.classification !== "router"
  ) {
    throw new Error("Invalid derived Figma Markdown classification.");
  }
  return {
    schemaVersion: 1,
    id: value.id,
    sourceRecordId: value.sourceRecordId,
    classification: value.classification,
    format: value.format,
    sourceContract: value.sourceContract,
    targetContract: value.targetContract,
    sanitized: value.sanitized,
    nonExecutable: value.nonExecutable,
    sourceContentSha256: value.sourceContentSha256,
    derivedContentSha256: value.derivedContentSha256,
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

function isUpstreamActiveClassification(value: unknown): value is UpstreamActiveClassification {
  return value === "active" || value === "conditional" || value === "router" || value === "examples" || value === "api";
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
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
