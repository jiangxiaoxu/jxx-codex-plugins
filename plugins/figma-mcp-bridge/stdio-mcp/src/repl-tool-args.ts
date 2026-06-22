import type { FigmaReplSurface } from "./repl-script-runner.js";

const TOOL_TITLE_ARGUMENT = "title";

export interface FigmaReplOpenArguments {
  [key: string]: unknown;
  title?: string;
  sessionId?: string;
  label?: string;
  file?: string;
  cwd?: string;
  dirName?: string;
  surface?: FigmaReplSurface;
  currentPageId?: string;
  reset?: boolean;
  connect?: boolean;
  refresh?: boolean;
  upstreamTool?: string;
  upstreamArgument?: string;
  upstreamArguments?: Record<string, unknown>;
  handles?: Record<string, string>;
}

export interface FigmaReplEvalArguments {
  [key: string]: unknown;
  title?: string;
  sessionId?: string;
  code: string;
  mode?: "read" | "write";
  surface?: FigmaReplSurface;
  allowDangerousOperations?: boolean;
  upstreamTool?: string;
  upstreamArgument?: string;
  upstreamArguments?: Record<string, unknown>;
  handleUpdates?: Record<string, string>;
}

export interface FigmaReplRunScriptFileArguments {
  [key: string]: unknown;
  title?: string;
  sessionId?: string;
  scriptPath?: string;
  inputFile?: string;
  dryRun?: boolean;
  strict?: boolean;
  surface?: FigmaReplSurface;
  targetPageId?: string;
  allowDangerousOperations?: boolean;
  upstreamTool?: string;
  upstreamArgument?: string;
  upstreamArguments?: Record<string, unknown>;
  outputDir?: string;
  outputFile?: string;
  diagnosticsFile?: string;
  summaryFile?: string;
  inlineResultLimit?: number;
}

export interface FigmaReplAssetManifestAsset {
  [key: string]: unknown;
  path?: string;
  target?: unknown;
  nodeUrl?: string;
  url?: string;
  name?: string;
  metadata?: Record<string, unknown>;
  toolName?: string;
  arguments?: Record<string, unknown>;
}

export interface FigmaReplApplyAssetManifestArguments {
  [key: string]: unknown;
  title?: string;
  sessionId?: string;
  assets?: FigmaReplAssetManifestAsset[];
  manifestPath?: string;
  toolName?: string;
  arguments?: Record<string, unknown>;
  validateTargets?: boolean;
  refresh?: boolean;
  outputFile?: string;
}

export interface FigmaReplCaptureNodeArguments {
  [key: string]: unknown;
  title?: string;
  sessionId?: string;
  target?: unknown;
  outputFile?: string;
  metadataFile?: string;
  toolName?: string;
  arguments?: Record<string, unknown>;
  refresh?: boolean;
}

export interface FigmaReplTaskPlanStep {
  id?: string;
  type?: string;
  args?: Record<string, unknown>;
}

export interface FigmaReplRunTaskPlanArguments {
  [key: string]: unknown;
  title?: string;
  sessionId?: string;
  planPath?: string;
  steps?: FigmaReplTaskPlanStep[];
  stopOnFailure?: boolean;
  outputFile?: string;
}

export interface FigmaReplCallUpstreamToolArguments {
  [key: string]: unknown;
  title?: string;
  sessionId?: string;
  toolName: string;
  arguments?: Record<string, unknown>;
  refresh?: boolean;
}

export interface FigmaReplLookupArguments {
  [key: string]: unknown;
  title?: string;
  kind?: "docs" | "api";
  query?: string;
  symbol?: string;
  maxResults?: number;
  maxSnippetLines?: number;
}

export interface FigmaReplPrepareTaskArguments {
  [key: string]: unknown;
  title?: string;
  sessionId?: string;
  task?: string;
  file?: string;
  fileSlug?: string;
  cwd?: string;
  dirName?: string;
  taskSlug?: string;
  fileName?: string;
  taskRoot?: string;
  workspaceDir?: string;
  surface?: FigmaReplSurface;
  targetPageId?: string;
  template?: string;
  overwrite?: boolean;
}

export interface FigmaReplGuidanceArguments {
  [key: string]: unknown;
  title?: string;
  mode?: "guidance" | "plan" | "card" | "catalog";
  card?: string;
  query?: string;
  task?: string;
  surface?: FigmaReplSurface;
  workflow?: string;
  maxCards?: number;
}

export interface FigmaReplInspectArguments {
  [key: string]: unknown;
  title?: string;
  sessionId?: string;
  mode?: "inspect" | "validate";
  target?: string;
  depth?: number;
  handles?: string[];
  upstreamTool?: string;
  upstreamArgument?: string;
  upstreamArguments?: Record<string, unknown>;
}

const FIGMA_REPL_SURFACES = ["design", "figjam", "slides"] as const satisfies readonly FigmaReplSurface[];
const FIGMA_REPL_EVAL_MODES = ["read", "write"] as const;
const FIGMA_REPL_GUIDANCE_MODES = ["guidance", "plan", "card", "catalog"] as const;
const FIGMA_REPL_INSPECT_MODES = ["inspect", "validate"] as const;
const FIGMA_REPL_LOOKUP_KINDS = ["docs", "api"] as const;

function assertRemovedFileReferenceFields(record: Record<string, unknown>): void {
  const removed = ["fileUrl", "fileKey"].filter((field) => record[field] !== undefined);
  if (removed.length > 0) {
    throw new Error(`Tool argument "${removed.join("/")}" was removed. Use "file" with a Figma URL or file key.`);
  }
}

function assertRemovedArguments(
  record: Record<string, unknown>,
  fields: readonly string[],
  replacement: string,
  displayName?: string,
): void {
  const removed = fields.filter((field) => record[field] !== undefined);
  if (removed.length > 0) {
    throw new Error(`Tool argument "${displayName ?? removed.join("/")}" was removed. Use "${replacement}".`);
  }
}

export function asOpenArgs(args: unknown): FigmaReplOpenArguments {
  const record = parseToolArgs<FigmaReplOpenArguments>(args);
  assertRemovedFileReferenceFields(record);
  assertRemovedArguments(record, ["expectedSurface"], "surface");
  assertOptionalStringFields(record, [
    "sessionId",
    "label",
    "file",
    "cwd",
    "dirName",
    "currentPageId",
    "upstreamTool",
    "upstreamArgument",
  ]);
  assertOptionalEnum(record, "surface", FIGMA_REPL_SURFACES);
  assertOptionalRecord(record, "upstreamArguments");
  assertOptionalRecord(record, "handles");
  return record;
}

export function asEvalArgs(args: unknown): FigmaReplEvalArguments {
  const record = parseToolArgs<FigmaReplEvalArguments>(args);
  assertRemovedArguments(record, ["expectedSurface"], "surface");
  assertOptionalStringFields(record, [
    "code",
    "sessionId",
    "upstreamTool",
    "upstreamArgument",
  ]);
  assertOptionalEnum(record, "mode", FIGMA_REPL_EVAL_MODES);
  assertOptionalEnum(record, "surface", FIGMA_REPL_SURFACES);
  assertOptionalRecord(record, "upstreamArguments");
  assertOptionalRecord(record, "handleUpdates");
  return record;
}

export function asRunScriptFileArgs(args: unknown): FigmaReplRunScriptFileArguments {
  const record = parseToolArgs<FigmaReplRunScriptFileArguments>(args);
  assertRemovedArguments(record, ["expectedSurface"], "surface");
  assertRemovedArguments(record, ["resultFile"], "outputFile");
  assertOptionalStringFields(record, [
    "sessionId",
    "scriptPath",
    "inputFile",
    "targetPageId",
    "upstreamTool",
    "upstreamArgument",
    "outputDir",
    "outputFile",
    "diagnosticsFile",
    "summaryFile",
  ]);
  assertOptionalEnum(record, "surface", FIGMA_REPL_SURFACES);
  assertOptionalRecord(record, "upstreamArguments");
  return record;
}

export function asApplyAssetManifestArgs(args: unknown): FigmaReplApplyAssetManifestArguments {
  const record = parseToolArgs<FigmaReplApplyAssetManifestArguments>(args);
  assertRemovedArguments(record, ["argumentsTemplate"], "arguments");
  assertRemovedArguments(record, ["resultFile"], "outputFile");
  assertOptionalStringFields(record, [
    "sessionId",
    "manifestPath",
    "toolName",
    "outputFile",
  ]);
  assertOptionalRecord(record, "arguments");
  assertOptionalAssets(record);
  return record;
}

export function asCaptureNodeArgs(args: unknown): FigmaReplCaptureNodeArguments {
  const record = parseToolArgs<FigmaReplCaptureNodeArguments>(args);
  assertRemovedArguments(record, ["nodeId", "targetNodeId", "handle"], "target");
  assertRemovedArguments(record, ["resultFile"], "metadataFile");
  assertRemovedArguments(record, ["argumentsTemplate"], "arguments");
  assertOptionalStringFields(record, [
    "sessionId",
    "outputFile",
    "metadataFile",
    "toolName",
  ]);
  assertOptionalRecord(record, "arguments");
  assertOptionalTargetValue(record.target, "target");
  return record;
}

export function asRunTaskPlanArgs(args: unknown): FigmaReplRunTaskPlanArguments {
  const record = parseToolArgs<FigmaReplRunTaskPlanArguments>(args);
  assertRemovedArguments(record, ["resultFile"], "outputFile");
  assertOptionalStringFields(record, [
    "sessionId",
    "planPath",
    "outputFile",
  ]);
  const steps = assertOptionalTaskPlanSteps(record);
  if (steps) {
    record.steps = steps;
  }
  return record;
}

export function asPrepareTaskArgs(args: unknown): FigmaReplPrepareTaskArguments {
  const record = parseToolArgs<FigmaReplPrepareTaskArguments>(args);
  assertRemovedFileReferenceFields(record);
  assertRemovedArguments(record, ["intent", "goal", "taskName"], "task");
  assertRemovedArguments(record, ["taskDir"], "workspaceDir");
  assertRemovedArguments(record, ["scriptName"], "fileName");
  assertRemovedArguments(record, ["expectedSurface"], "surface");
  assertOptionalStringFields(record, [
    "sessionId",
    "task",
    "file",
    "fileSlug",
    "cwd",
    "dirName",
    "taskSlug",
    "workspaceDir",
    "fileName",
    "taskRoot",
    "targetPageId",
    "template",
  ]);
  assertOptionalEnum(record, "surface", FIGMA_REPL_SURFACES);
  return record;
}

export function asGuidanceArgs(args: unknown): FigmaReplGuidanceArguments {
  const record = parseToolArgs<FigmaReplGuidanceArguments>(args);
  assertRemovedArguments(record, ["intent", "goal"], "task");
  assertRemovedArguments(record, ["expectedSurface"], "surface");
  assertOptionalStringFields(record, ["card", "query", "task", "workflow"]);
  assertOptionalEnum(record, "mode", FIGMA_REPL_GUIDANCE_MODES);
  assertOptionalEnum(record, "surface", FIGMA_REPL_SURFACES);
  return record;
}

export function asInspectArgs(args: unknown): FigmaReplInspectArguments {
  const record = parseToolArgs<FigmaReplInspectArguments>(args);
  assertOptionalStringFields(record, [
    "sessionId",
    "target",
    "upstreamTool",
    "upstreamArgument",
  ]);
  assertOptionalEnum(record, "mode", FIGMA_REPL_INSPECT_MODES);
  assertOptionalRecord(record, "upstreamArguments");
  const handles = assertOptionalArray(record, "handles");
  handles?.forEach((handle, index) => {
    if (typeof handle !== "string") {
      throw new Error(`Tool argument "handles[${index}]" must be a string.`);
    }
  });
  return record;
}

export function asCallUpstreamToolArgs(args: unknown): FigmaReplCallUpstreamToolArguments {
  const record = parseToolArgs<FigmaReplCallUpstreamToolArguments>(args);
  assertOptionalStringFields(record, ["sessionId", "toolName"]);
  assertOptionalRecord(record, "arguments");
  return record;
}

export function asLookupArgs(args: unknown): FigmaReplLookupArguments {
  const record = parseToolArgs<FigmaReplLookupArguments>(args);
  assertOptionalEnum(record, "kind", FIGMA_REPL_LOOKUP_KINDS);
  assertOptionalStringFields(record, ["query", "symbol"]);
  return record;
}

function parseToolArgs<T extends Record<string, unknown>>(value: unknown): T {
  if (value === undefined) {
    return {} as T;
  }
  if (!isRecord(value)) {
    throw new Error("Tool arguments must be an object.");
  }
  return { ...value } as T;
}

function assertOptionalEnum(
  record: Record<string, unknown>,
  key: string,
  values: readonly string[],
): void {
  const value = record[key];
  if (value === undefined) {
    return;
  }
  if (typeof value !== "string" || !values.includes(value)) {
    throw new Error(`Tool argument "${key}" must be one of: ${values.join(", ")}.`);
  }
}

function assertOptionalRecord(
  record: Record<string, unknown>,
  key: string,
  displayName = key,
): void {
  const value = record[key];
  if (value === undefined) {
    return;
  }
  if (!isRecord(value)) {
    throw new Error(`Tool argument "${displayName}" must be an object.`);
  }
}

function assertOptionalArray(record: Record<string, unknown>, key: string): unknown[] | undefined {
  const value = record[key];
  if (value === undefined) {
    return undefined;
  }
  if (!Array.isArray(value)) {
    throw new Error(`Tool argument "${key}" must be an array.`);
  }
  return value;
}

function assertOptionalStringFields(record: Record<string, unknown>, keys: readonly string[]): void {
  for (const key of keys) {
    const value = record[key];
    if (value === undefined) {
      continue;
    }
    if (typeof value !== "string") {
      throw new Error(`Tool argument "${key}" must be a string.`);
    }
  }
}

function assertOptionalAssets(record: Record<string, unknown>): void {
  const assets = assertOptionalArray(record, "assets");
  if (!assets) {
    return;
  }
  assets.forEach((asset, index) => {
    const assetName = `assets[${index}]`;
    if (!isRecord(asset)) {
      throw new Error(`Tool argument "${assetName}" must be an object.`);
    }
    assertOptionalStringFieldsWithPrefix(asset, assetName, [
      "path",
      "nodeUrl",
      "url",
      "scaleMode",
      "name",
      "toolName",
    ]);
    assertRemovedArguments(asset, ["filePath", "localPath"], "path", `${assetName}.filePath/localPath`);
    assertRemovedArguments(
      asset,
      ["targetNodeId", "nodeId", "targetHandle", "targetId"],
      "target",
      `${assetName}.targetNodeId/nodeId/targetHandle/targetId`,
    );
    const target = asset.target;
    assertOptionalTargetValue(target, `${assetName}.target`);
    assertOptionalRecord(asset, "metadata", `${assetName}.metadata`);
    assertOptionalRecord(asset, "arguments", `${assetName}.arguments`);
  });
}

function assertOptionalTargetValue(value: unknown, displayName: string): void {
  if (value === undefined) {
    return;
  }
  if (typeof value === "string") {
    return;
  }
  if (!isRecord(value)) {
    throw new Error(`Tool argument "${displayName}" must be a string or object.`);
  }
  assertRemovedArguments(
    value,
    ["nodeId", "targetNodeId", "targetHandle", "targetId"],
    "handle",
    `${displayName}.nodeId/targetNodeId/targetHandle/targetId`,
  );
  assertOptionalStringFieldsWithPrefix(value, displayName, ["handle"]);
}

export function asTaskPlanSteps(value: unknown, displayName = "steps"): FigmaReplTaskPlanStep[] {
  if (!Array.isArray(value)) {
    throw new Error(`Tool argument "${displayName}" must be an array.`);
  }
  return value.map((step, index) => asTaskPlanStep(step, `${displayName}[${index}]`));
}

function assertOptionalTaskPlanSteps(record: Record<string, unknown>): FigmaReplTaskPlanStep[] | undefined {
  const steps = assertOptionalArray(record, "steps");
  if (!steps) {
    return undefined;
  }
  return asTaskPlanSteps(steps);
}

function asTaskPlanStep(value: unknown, displayName: string): FigmaReplTaskPlanStep {
  if (!isRecord(value)) {
    throw new Error(`Tool argument "${displayName}" must be an object.`);
  }
  assertRemovedArguments(value, ["tool"], "type", `${displayName}.tool`);
  assertRemovedArguments(value, ["arguments"], "args", `${displayName}.arguments`);
  assertOnlyTaskPlanStepFields(value, displayName);
  assertOptionalStringFieldsWithPrefix(value, displayName, ["id", "type"]);
  assertOptionalRecord(value, "args", `${displayName}.args`);
  const step: FigmaReplTaskPlanStep = {};
  if (value.id !== undefined) {
    step.id = value.id as string;
  }
  if (value.type !== undefined) {
    step.type = value.type as string;
  }
  if (value.args !== undefined) {
    step.args = value.args as Record<string, unknown>;
  }
  return step;
}

function assertOnlyTaskPlanStepFields(record: Record<string, unknown>, displayName: string): void {
  for (const key of Object.keys(record)) {
    if (!["id", "type", "args"].includes(key)) {
      throw new Error(`Tool argument "${displayName}.${key}" is not supported. Put step tool inputs under "args".`);
    }
  }
}

function assertOptionalStringFieldsWithPrefix(
  record: Record<string, unknown>,
  prefix: string,
  keys: readonly string[],
): void {
  for (const key of keys) {
    const value = record[key];
    if (value === undefined) {
      continue;
    }
    if (typeof value !== "string") {
      throw new Error(`Tool argument "${prefix}.${key}" must be a string.`);
    }
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export function assertRequiredTitleArgument(args: Record<string, unknown>): void {
  if (typeof args[TOOL_TITLE_ARGUMENT] !== "string") {
    throw new Error('Tool argument "title" is required and must be a string.');
  }
}

export function withDefaultTitle<T extends Record<string, unknown>>(
  args: T,
  title: string,
): T & { title: string } {
  if (!isRecord(args)) {
    throw new Error("Tool arguments must be an object.");
  }
  if (args.title !== undefined && typeof args.title !== "string") {
    throw new Error('Tool argument "title" must be a string.');
  }
  return {
    ...args,
    title: args.title ?? title,
  };
}
