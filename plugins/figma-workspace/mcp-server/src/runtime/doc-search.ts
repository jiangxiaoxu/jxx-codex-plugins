import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

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

export const DOCS_SEARCH_ALLOWLIST = [
  ...BRIDGE_DOCS_SEARCH_FILES,
  "figma-use/SKILL.md",
  "figma-use/references/api-reference.md",
  "figma-use/references/common-patterns.md",
  "figma-use/references/component-patterns.md",
  "figma-use/references/effect-style-patterns.md",
  "figma-use/references/gotchas.md",
  "figma-use/references/plugin-api-patterns.md",
  "figma-use/references/text-style-patterns.md",
  "figma-use/references/validation-and-recovery.md",
  "figma-use/references/variable-patterns.md",
  "figma-use/references/working-with-design-systems/wwds.md",
  "figma-use/references/working-with-design-systems/wwds-components.md",
  "figma-use/references/working-with-design-systems/wwds-variables.md",
  "figma-generate-library/SKILL.md",
  "figma-generate-library/references/component-creation.md",
  "figma-generate-library/references/discovery-phase.md",
  "figma-generate-library/references/token-creation.md",
  "figma-code-connect/SKILL.md",
  "figma-code-connect/references/api.md",
  "figma-use-figjam/SKILL.md",
  "figma-use-slides/SKILL.md",
  "figma-use-motion/SKILL.md",
  "figma-use-motion/references/motion-easing.md",
  "figma-use-motion/references/motion-patterns.md",
  "figma-implement-motion/SKILL.md",
  "figma-implement-motion/references/examples-and-anti-examples.md",
  "figma-implement-motion/references/framework-recommendations.md",
  "figma-implement-motion/references/gotchas.md",
  "figma-implement-motion/references/motion-lint-rules.md",
  "figma-implement-motion/references/svg-and-path-motion.md",
  "figma-implement-motion/references/unsupported-and-fallbacks.md",
];

export const API_LOOKUP_FILES = [
  "figma-use/references/plugin-api-standalone.index.md",
  "figma-use/references/api-reference.md",
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
}

interface UpstreamCorpusManifest {
  schemaVersion: 1;
  corpus: {
    file: string;
    recordCount: number;
    contract: string;
  };
  includedSkills: string[];
  outOfScopeSkills: Array<{ skill: string; reason: string }>;
}

interface UpstreamCorpusRecord {
  schemaVersion: 1;
  id: string;
  skill: string;
  kind: string;
  format: "markdown" | "typescript";
  sourcePath: string;
  lineCount: number;
  text: string;
}

interface UpstreamCorpus {
  root: string;
  manifest: UpstreamCorpusManifest;
  records: Map<string, UpstreamCorpusRecord>;
}

interface ScoredReferenceChunk {
  chunk: ReferenceChunk;
  score: number;
  matchType: "exact-symbol" | "phrase" | "token";
  confidence: "high" | "medium" | "low";
}

export async function searchReferenceFiles(options: {
  query: string;
  files: string[];
  maxResults: number;
  maxSnippetLines: number;
  exactSymbol?: boolean;
}): Promise<{
  maxResults: number;
  maxSnippetLines: number;
  results: ReferenceSearchResult[];
}> {
  const corpus = await loadUpstreamCorpus();
  const queryTokens = tokenizeQuery(options.query);
  const chunks: ReferenceChunk[] = [];
  for (const file of options.files) {
    const bridgeRecord = BRIDGE_DOCS_RECORDS.get(file);
    if (bridgeRecord) {
      chunks.push(...buildReferenceChunks(bridgeRecord.id, bridgeRecord.text));
      continue;
    }
    const record = corpus.records.get(file);
    if (!record) {
      continue;
    }
    chunks.push(...buildReferenceChunks(record.id, record.text));
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
  const wrapperTools = "figma_workspace_get_design_context, figma_workspace_get_motion_context, figma_workspace_export_video";
  const upstreamTools = "get_design_context, get_motion_context, export_video, list_shader_effects, get_shader_effect, list_shader_fills, get_shader_fill";
  const workflowIds = "design-implementation-context, motion-implementation, video-export";
  const helperCategories = "selection: $.find, $.findAll, $.select, $.inspect; text: $.text; layout: $.create, $.layout, $.placeNode, $.findFreeSlot; assets: $.imageAsset; capture: $.screenshot; repair: $.checkpoint, $.remember, $.forget; clone: $.cloneNodeTree, $.replaceGeneratedFrame";
  const helperHardRules = "Use static helper references only: $.text(...), $[\"text\"](...), or explicit destructuring such as const { text } = $. Do not use dynamic $[name], alias $, object rest destructuring, or local $ declarations. Native Figma Plugin API remains valid for advanced work. $.imageAsset is only for small inline PNG/JPEG; larger files use asset manifest/upload flow.";
  return new Map([
    [
      "bridge/guidance-ref.md",
      {
        id: "bridge/guidance-ref.md",
        text: [
          "# guidanceRef",
          "Thin upstream-backed wrapper results expose a compact `guidanceRef` pointer instead of inline wrapper guidance.",
          "`guidanceRef.source` is `figma_workspace_guidance`; pass `guidanceRef.query` to that tool to retrieve matching `wrapperProfiles` and `workflowGraph` entries.",
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
          "`figma_workspace_guidance.wrapperProfiles` is the detailed runtime-owned source for first-class wrapper follow-up guidance.",
          "Profiles include local tool, upstream tool, workflow ids, intents, suggested docs/API lookups, suggested tools, and next steps.",
          `Local wrapper tools: ${wrapperTools}.`,
          `Upstream tools: ${upstreamTools}.`,
          "Use wrapper profiles to choose design context, motion context, or video export sequencing before falling back to upstream tools without local wrappers.",
        ].join("\n"),
      },
    ],
    [
      "bridge/helper-profiles.md",
      {
        id: "bridge/helper-profiles.md",
        text: [
          "# Helper profiles",
          "`figma_workspace_guidance.helperProfiles` returns on-demand `$` helper guidance with useWhen, avoidWhen, allowedPatterns, forbiddenPatterns, API symbols, lookup hints, and compact examples.",
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
          "`figma_workspace_guidance.workflowGraph` and `figma-workspace://lookup-index` expose compact executable sequencing hints for wrapper workflows.",
          `Workflow ids: ${workflowIds}.`,
          "The graph covers design implementation context, motion implementation, video export sequencing, and shader lookup flows.",
          "Use workflow graph nodes with wrapper profiles to order calls; use `figma_workspace_lookup(kind=docs)` only for compact snippets and exact bridge-native explanations.",
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

function buildReferenceChunks(file: string, text: string): ReferenceChunk[] {
  const lines = text.split(/\r?\n/u);
  if (file.endsWith(".d.ts")) {
    return buildDtsReferenceChunks(file, lines);
  }
  return buildMarkdownReferenceChunks(file, lines);
}

function buildMarkdownReferenceChunks(file: string, lines: string[]): ReferenceChunk[] {
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
    }),
  );
}

function buildDtsReferenceChunks(file: string, lines: string[]): ReferenceChunk[] {
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
  };
}

function publicReferenceSourceId(file: string, chunkId: string): string {
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

let upstreamCorpusCache: Promise<UpstreamCorpus> | undefined;

function loadUpstreamCorpus(): Promise<UpstreamCorpus> {
  upstreamCorpusCache ??= readUpstreamCorpus();
  return upstreamCorpusCache;
}

async function readUpstreamCorpus(): Promise<UpstreamCorpus> {
  const root = await resolveUpstreamCorpusRoot();
  const manifest = parseUpstreamCorpusManifest(await readFile(resolve(root, "manifest.json"), "utf8"));
  const corpusText = await readFile(resolve(root, manifest.corpus.file), "utf8");
  const records = new Map<string, UpstreamCorpusRecord>();
  for (const line of corpusText.split(/\r?\n/u)) {
    if (!line.trim()) {
      continue;
    }
    const record = parseUpstreamCorpusRecord(line);
    records.set(record.id, record);
  }
  return { root, manifest, records };
}

async function resolveUpstreamCorpusRoot(): Promise<string> {
  const moduleDir = dirname(fileURLToPath(import.meta.url));
  const cwd = typeof process !== "undefined" && typeof process.cwd === "function"
    ? process.cwd()
    : moduleDir;
  const candidates = [
    resolve(moduleDir, "../skills/figma-workspace-router/references/upstream-corpus"),
    resolve(moduleDir, "../../skills/figma-workspace-router/references/upstream-corpus"),
    resolve(moduleDir, "../../../skills/figma-workspace-router/references/upstream-corpus"),
    resolve(cwd, "skills/figma-workspace-router/references/upstream-corpus"),
    resolve(cwd, "plugins/figma-workspace/skills/figma-workspace-router/references/upstream-corpus"),
    resolve(cwd, "../skills/figma-workspace-router/references/upstream-corpus"),
  ];
  for (const candidate of candidates) {
    try {
      await readFile(resolve(candidate, "manifest.json"), "utf8");
      await readFile(resolve(candidate, "corpus.jsonl"), "utf8");
      return candidate;
    } catch {
      // Try the next runtime layout.
    }
  }
  throw new Error(
    "Unable to locate internal Figma corpus for figma_workspace_mcp docs/API lookup.",
  );
}

function parseUpstreamCorpusManifest(text: string): UpstreamCorpusManifest {
  const value: unknown = JSON.parse(text);
  if (!isObject(value) || value.schemaVersion !== 1 || !isObject(value.corpus)) {
    throw new Error("Invalid internal Figma upstream corpus manifest.");
  }
  const corpus = value.corpus;
  if (typeof corpus.file !== "string" || typeof corpus.recordCount !== "number" || typeof corpus.contract !== "string") {
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
    schemaVersion: 1,
    corpus: {
      file: corpus.file,
      recordCount: corpus.recordCount,
      contract: corpus.contract,
    },
    includedSkills,
    outOfScopeSkills,
  };
}

function parseUpstreamCorpusRecord(line: string): UpstreamCorpusRecord {
  const value: unknown = JSON.parse(line);
  if (
    !isObject(value) ||
    value.schemaVersion !== 1 ||
    typeof value.id !== "string" ||
    typeof value.skill !== "string" ||
    typeof value.kind !== "string" ||
    (value.format !== "markdown" && value.format !== "typescript") ||
    typeof value.sourcePath !== "string" ||
    typeof value.lineCount !== "number" ||
    typeof value.text !== "string"
  ) {
    throw new Error("Invalid internal Figma upstream corpus JSONL record.");
  }
  return {
    schemaVersion: 1,
    id: value.id,
    skill: value.skill,
    kind: value.kind,
    format: value.format,
    sourcePath: value.sourcePath,
    lineCount: value.lineCount,
    text: value.text,
  };
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}
