import { readFile } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const DEFAULT_DOCS_SEARCH_MAX_RESULTS = 5;
export const DEFAULT_DOCS_SEARCH_SNIPPET_LINES = 3;
export const MAX_DOCS_SEARCH_RESULTS = 10;
export const MAX_DOCS_SEARCH_SNIPPET_LINES = 8;
export const DEFAULT_REFERENCE_CONTEXT_SNIPPETS = 2;
export const MAX_LOOKUP_QUERY_LENGTH = 120;

const MAX_REFERENCE_CHUNK_LINES = 24;
const REFERENCE_CHUNK_OVERLAP_LINES = 4;

export const DOCS_SEARCH_ALLOWLIST = [
  "official-figma-skills/figma-use/SKILL.source.md",
  "official-figma-skills/figma-use/references/api-reference.md",
  "official-figma-skills/figma-use/references/common-patterns.md",
  "official-figma-skills/figma-use/references/component-patterns.md",
  "official-figma-skills/figma-use/references/effect-style-patterns.md",
  "official-figma-skills/figma-use/references/gotchas.md",
  "official-figma-skills/figma-use/references/plugin-api-patterns.md",
  "official-figma-skills/figma-use/references/text-style-patterns.md",
  "official-figma-skills/figma-use/references/validation-and-recovery.md",
  "official-figma-skills/figma-use/references/variable-patterns.md",
  "official-figma-skills/figma-use/references/working-with-design-systems/wwds.md",
  "official-figma-skills/figma-use/references/working-with-design-systems/wwds-components.md",
  "official-figma-skills/figma-use/references/working-with-design-systems/wwds-variables.md",
  "official-figma-skills/figma-generate-library/SKILL.source.md",
  "official-figma-skills/figma-generate-library/references/component-creation.md",
  "official-figma-skills/figma-generate-library/references/discovery-phase.md",
  "official-figma-skills/figma-generate-library/references/token-creation.md",
  "official-figma-skills/figma-code-connect/SKILL.source.md",
  "official-figma-skills/figma-code-connect/references/api.md",
  "official-figma-skills/figma-use-figjam/SKILL.source.md",
  "official-figma-skills/figma-use-slides/SKILL.source.md",
];

export const API_LOOKUP_FILES = [
  "official-figma-skills/figma-use/references/plugin-api-standalone.index.md",
  "official-figma-skills/figma-use/references/api-reference.md",
  "official-figma-skills/figma-use/references/plugin-api-standalone.d.ts",
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
  const searchRoot = await resolveReferenceRoot();
  const queryTokens = tokenizeQuery(options.query);
  const chunks: ReferenceChunk[] = [];
  for (const file of options.files) {
    const path = resolve(searchRoot, file);
    if (!isPathInside(searchRoot, path)) {
      continue;
    }
    let text: string;
    try {
      text = await readFile(path, "utf8");
    } catch {
      continue;
    }
    chunks.push(...buildReferenceChunks(file, text));
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
    .replace(/^official-figma-skills\//u, "")
    .replace(/\/references\//gu, "/")
    .replace(/\/SKILL\.source\.md$/u, "/skill")
    .replace(/\.source\.md$/u, "")
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

async function resolveReferenceRoot(): Promise<string> {
  const moduleDir = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    resolve(moduleDir, "../skills/figma-router/references"),
    resolve(moduleDir, "../../skills/figma-router/references"),
    resolve(moduleDir, "../../../skills/figma-router/references"),
    resolve(process.cwd(), "skills/figma-router/references"),
    resolve(process.cwd(), "plugins/figma-mcp-bridge/skills/figma-router/references"),
    resolve(process.cwd(), "../skills/figma-router/references"),
  ];
  for (const candidate of candidates) {
    try {
      await readFile(resolve(candidate, "official-figma-skills/figma-use/SKILL.source.md"), "utf8");
      return candidate;
    } catch {
      // Try the next runtime layout.
    }
  }
  throw new Error(
    "Unable to locate internal Figma corpus for figma_repl_mcp docs/API lookup.",
  );
}

function isPathInside(root: string, path: string): boolean {
  const rel = relative(root, path);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}
