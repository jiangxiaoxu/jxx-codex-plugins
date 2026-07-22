import { readFile, writeFile } from "node:fs/promises";
import type {
  ListResourceTemplatesResult,
  ListResourcesResult,
  ListToolsResult,
} from "@modelcontextprotocol/sdk/types.js";

export const FIGMA_UPSTREAM_CONTRACT_SNAPSHOT_SCHEMA_VERSION = 2;

export interface FigmaUpstreamContractClient {
  connect(): Promise<void>;
  listTools(): Promise<ListToolsResult>;
  listResources(): Promise<ListResourcesResult>;
  listResourceTemplates(): Promise<ListResourceTemplatesResult>;
}

export interface FigmaUpstreamContractSnapshot {
  schemaVersion: typeof FIGMA_UPSTREAM_CONTRACT_SNAPSHOT_SCHEMA_VERSION;
  source: string;
  generatedAt: string;
  tools: Record<string, unknown>;
  resources: unknown[];
  resourceTemplates: unknown[];
}

export interface FigmaUpstreamContractDrift {
  path: string;
  expected: unknown;
  actual: unknown;
}

export async function createFigmaUpstreamContractSnapshot(
  client: FigmaUpstreamContractClient,
  options: {
    generatedAt?: string;
    source?: string;
  } = {},
): Promise<FigmaUpstreamContractSnapshot> {
  await client.connect();
  const [toolsResult, resourcesResult, resourceTemplatesResult] = await Promise.all([
    client.listTools(),
    client.listResources(),
    client.listResourceTemplates(),
  ]);
  return normalizeFigmaUpstreamContractSnapshot({
    schemaVersion: FIGMA_UPSTREAM_CONTRACT_SNAPSHOT_SCHEMA_VERSION,
    source: options.source ?? "Official Figma remote MCP live contract.",
    generatedAt: options.generatedAt ?? new Date().toISOString(),
    tools: Object.fromEntries(
      normalizeNamedEntries(toolsResult.tools ?? [], "name").map((tool) => [
        stringKey(tool, "name"),
        tool,
      ]),
    ),
    resources: normalizeNamedEntries(resourcesResult.resources ?? [], "uri"),
    resourceTemplates: normalizeNamedEntries(
      resourceTemplatesResult.resourceTemplates ?? [],
      "uriTemplate",
    ),
  });
}

export function normalizeFigmaUpstreamContractSnapshot(
  snapshot: FigmaUpstreamContractSnapshot,
): FigmaUpstreamContractSnapshot {
  return {
    schemaVersion: FIGMA_UPSTREAM_CONTRACT_SNAPSHOT_SCHEMA_VERSION,
    source: snapshot.source,
    generatedAt: snapshot.generatedAt,
    tools: sortRecordByKey(snapshot.tools),
    resources: normalizeNamedEntries(snapshot.resources, "uri"),
    resourceTemplates: normalizeNamedEntries(snapshot.resourceTemplates, "uriTemplate"),
  };
}

export async function readFigmaUpstreamContractSnapshotFile(
  snapshotPath: string,
): Promise<FigmaUpstreamContractSnapshot> {
  const parsed = JSON.parse(await readFile(snapshotPath, "utf8")) as FigmaUpstreamContractSnapshot;
  return normalizeFigmaUpstreamContractSnapshot(parsed);
}

export async function writeFigmaUpstreamContractSnapshotFile(
  snapshotPath: string,
  snapshot: FigmaUpstreamContractSnapshot,
): Promise<void> {
  await writeFile(
    snapshotPath,
    `${JSON.stringify(normalizeFigmaUpstreamContractSnapshot(snapshot), null, 2)}\n`,
    "utf8",
  );
}

export function diffFigmaUpstreamContractSnapshots(
  expected: FigmaUpstreamContractSnapshot,
  actual: FigmaUpstreamContractSnapshot,
): FigmaUpstreamContractDrift[] {
  return diffJson(
    normalizeFigmaUpstreamContractSnapshot(expected),
    normalizeFigmaUpstreamContractSnapshot(actual),
    "$",
  );
}

export function formatFigmaUpstreamContractDrift(
  drift: readonly FigmaUpstreamContractDrift[],
  options: {
    snapshotPath: string;
    refreshCommand: string;
    maxDetails?: number;
  },
): string {
  if (drift.length === 0) {
    return `Official Figma MCP upstream contract matches ${options.snapshotPath}.`;
  }
  const maxDetails = options.maxDetails ?? 40;
  const shown = drift.slice(0, maxDetails).map((entry) => {
    return [
      `- ${entry.path}`,
      `  expected: ${compactJson(entry.expected)}`,
      `  actual: ${compactJson(entry.actual)}`,
    ].join("\n");
  });
  const remaining = drift.length > shown.length
    ? `\n- ... ${drift.length - shown.length} more drift item(s) omitted.`
    : "";
  return [
    `Official Figma MCP upstream contract drift detected against ${options.snapshotPath}.`,
    `Review wrapper coverage and refresh intentionally with \`${options.refreshCommand}\` if the live contract is accepted.`,
    ...shown,
  ].join("\n") + remaining;
}

export function formatFigmaUpstreamContractElapsedTime(elapsedMs: number): string {
  const roundedMs = Number.isFinite(elapsedMs) && elapsedMs > 0
    ? Math.round(elapsedMs)
    : 0;
  if (roundedMs < 1000) {
    return `${roundedMs} ms`;
  }
  if (roundedMs < 60_000) {
    const seconds = roundedMs / 1000;
    return `${seconds.toFixed(seconds < 10 ? 2 : 1)} s (${roundedMs} ms)`;
  }
  const minutes = Math.floor(roundedMs / 60_000);
  const seconds = Math.round((roundedMs % 60_000) / 1000);
  return `${minutes} min ${seconds} s (${roundedMs} ms)`;
}

function normalizeNamedEntries(entries: readonly unknown[], key: string): unknown[] {
  return entries
    .map((entry) => stableJson(entry))
    .sort((left, right) => stringKey(left, key).localeCompare(stringKey(right, key)));
}

function stringKey(value: unknown, key: string): string {
  if (isRecord(value) && typeof value[key] === "string") {
    return value[key];
  }
  return "";
}

function sortRecordByKey(record: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(record)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, value]) => [key, stableJson(value)]),
  );
}

function stableJson(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => stableJson(item));
  }
  if (isRecord(value)) {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([, entryValue]) => entryValue !== undefined)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, entryValue]) => [key, stableJson(entryValue)]),
    );
  }
  return value;
}

function diffJson(expected: unknown, actual: unknown, path: string): FigmaUpstreamContractDrift[] {
  if (Object.is(expected, actual)) {
    return [];
  }
  if (Array.isArray(expected) || Array.isArray(actual)) {
    if (!Array.isArray(expected) || !Array.isArray(actual)) {
      return [{ path, expected, actual }];
    }
    const drift: FigmaUpstreamContractDrift[] = [];
    const maxLength = Math.max(expected.length, actual.length);
    for (let index = 0; index < maxLength; index += 1) {
      drift.push(...diffJson(expected[index], actual[index], `${path}[${index}]`));
    }
    return drift;
  }
  if (isRecord(expected) || isRecord(actual)) {
    if (!isRecord(expected) || !isRecord(actual)) {
      return [{ path, expected, actual }];
    }
    const keys = new Set([...Object.keys(expected), ...Object.keys(actual)]);
    return [...keys].sort().flatMap((key) =>
      diffJson(expected[key], actual[key], `${path}.${key}`)
    );
  }
  return [{ path, expected, actual }];
}

function compactJson(value: unknown): string {
  const json = JSON.stringify(value);
  if (json === undefined) {
    return "undefined";
  }
  return json.length > 500 ? `${json.slice(0, 497)}...` : json;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
