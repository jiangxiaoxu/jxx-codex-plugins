import type {
  FigmaReplHelperProfile,
  FigmaReplSurface,
} from "./repl-script-runner.js";

const TOOL_TITLE_ARGUMENT = "title";

export interface FigmaReplOpenArguments {
  [key: string]: unknown;
  title?: string;
  sessionId?: string;
  label?: string;
  fileUrl?: string;
  expectedSurface?: FigmaReplSurface;
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
  expectedSurface?: FigmaReplSurface;
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
  helperProfile?: FigmaReplHelperProfile;
  dryRun?: boolean;
  strict?: boolean;
  expectedSurface?: FigmaReplSurface;
  targetPageId?: string;
  allowDangerousOperations?: boolean;
  upstreamTool?: string;
  upstreamArgument?: string;
  upstreamArguments?: Record<string, unknown>;
  outputDir?: string;
  outputFile?: string;
  resultFile?: string;
  diagnosticsFile?: string;
  summaryFile?: string;
  inlineResultLimit?: number;
}

export interface FigmaReplAssetManifestAsset {
  [key: string]: unknown;
  path?: string;
  filePath?: string;
  localPath?: string;
  targetNodeId?: string;
  nodeId?: string;
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
  argumentsTemplate?: Record<string, unknown>;
  validateTargets?: boolean;
  refresh?: boolean;
  resultFile?: string;
  outputFile?: string;
  inlineResultLimit?: number;
}

export interface FigmaReplCaptureNodeArguments {
  [key: string]: unknown;
  title?: string;
  sessionId?: string;
  nodeId?: string;
  targetNodeId?: string;
  outputFile?: string;
  resultFile?: string;
  toolName?: string;
  arguments?: Record<string, unknown>;
  argumentsTemplate?: Record<string, unknown>;
  refresh?: boolean;
  inlineResultLimit?: number;
}

export interface FigmaReplTaskPlanStep {
  [key: string]: unknown;
  id?: string;
  type?: string;
  tool?: string;
  args?: Record<string, unknown>;
  arguments?: Record<string, unknown>;
}

export interface FigmaReplRunTaskPlanArguments {
  [key: string]: unknown;
  title?: string;
  sessionId?: string;
  planPath?: string;
  steps?: FigmaReplTaskPlanStep[];
  stopOnFailure?: boolean;
  resultFile?: string;
  outputFile?: string;
  inlineResultLimit?: number;
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
  intent?: string;
  task?: string;
  fileUrl?: string;
  fileKey?: string;
  fileSlug?: string;
  cwd?: string;
  dirName?: string;
  goal?: string;
  taskSlug?: string;
  taskName?: string;
  taskDir?: string;
  fileName?: string;
  taskRoot?: string;
  workspaceDir?: string;
  scriptName?: string;
  expectedSurface?: FigmaReplSurface;
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
  intent?: string;
  goal?: string;
  surface?: FigmaReplSurface;
  workflow?: string;
  expectedSurface?: FigmaReplSurface;
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
const FIGMA_REPL_HELPER_PROFILES = ["auto", "minimal", "asset", "clone", "full"] as const satisfies readonly FigmaReplHelperProfile[];
const FIGMA_REPL_GUIDANCE_MODES = ["guidance", "plan", "card", "catalog"] as const;
const FIGMA_REPL_INSPECT_MODES = ["inspect", "validate"] as const;
const FIGMA_REPL_LOOKUP_KINDS = ["docs", "api"] as const;

export function asEvalArgs(args: unknown): FigmaReplEvalArguments {
  const record = parseToolArgs<FigmaReplEvalArguments>(args);
  assertOptionalStringFields(record, [
    "code",
    "sessionId",
    "upstreamTool",
    "upstreamArgument",
  ]);
  assertOptionalEnum(record, "mode", FIGMA_REPL_EVAL_MODES);
  assertOptionalEnum(record, "expectedSurface", FIGMA_REPL_SURFACES);
  assertOptionalRecord(record, "upstreamArguments");
  assertOptionalRecord(record, "handleUpdates");
  return record;
}

export function asRunScriptFileArgs(args: unknown): FigmaReplRunScriptFileArguments {
  const record = parseToolArgs<FigmaReplRunScriptFileArguments>(args);
  assertOptionalStringFields(record, [
    "sessionId",
    "scriptPath",
    "inputFile",
    "targetPageId",
    "upstreamTool",
    "upstreamArgument",
    "outputDir",
    "outputFile",
    "resultFile",
    "diagnosticsFile",
    "summaryFile",
  ]);
  assertOptionalEnum(record, "helperProfile", FIGMA_REPL_HELPER_PROFILES);
  assertOptionalEnum(record, "expectedSurface", FIGMA_REPL_SURFACES);
  assertOptionalRecord(record, "upstreamArguments");
  return record;
}

export function asApplyAssetManifestArgs(args: unknown): FigmaReplApplyAssetManifestArguments {
  const record = parseToolArgs<FigmaReplApplyAssetManifestArguments>(args);
  assertOptionalStringFields(record, [
    "sessionId",
    "manifestPath",
    "toolName",
    "resultFile",
    "outputFile",
  ]);
  assertOptionalRecord(record, "arguments");
  assertOptionalRecord(record, "argumentsTemplate");
  assertOptionalAssets(record);
  return record;
}

export function asCaptureNodeArgs(args: unknown): FigmaReplCaptureNodeArguments {
  const record = parseToolArgs<FigmaReplCaptureNodeArguments>(args);
  assertOptionalStringFields(record, [
    "sessionId",
    "nodeId",
    "targetNodeId",
    "outputFile",
    "resultFile",
    "toolName",
  ]);
  assertOptionalRecord(record, "arguments");
  assertOptionalRecord(record, "argumentsTemplate");
  return record;
}

export function asRunTaskPlanArgs(args: unknown): FigmaReplRunTaskPlanArguments {
  const record = parseToolArgs<FigmaReplRunTaskPlanArguments>(args);
  assertOptionalStringFields(record, [
    "sessionId",
    "planPath",
    "resultFile",
    "outputFile",
  ]);
  assertOptionalTaskPlanSteps(record);
  return record;
}

export function asPrepareTaskArgs(args: unknown): FigmaReplPrepareTaskArguments {
  const record = parseToolArgs<FigmaReplPrepareTaskArguments>(args);
  assertOptionalStringFields(record, [
    "sessionId",
    "intent",
    "task",
    "fileUrl",
    "fileKey",
    "fileSlug",
    "cwd",
    "dirName",
    "goal",
    "taskSlug",
    "taskName",
    "taskDir",
    "workspaceDir",
    "fileName",
    "scriptName",
    "taskRoot",
    "targetPageId",
    "template",
  ]);
  assertOptionalEnum(record, "expectedSurface", FIGMA_REPL_SURFACES);
  return record;
}

export function asGuidanceArgs(args: unknown): FigmaReplGuidanceArguments {
  const record = parseToolArgs<FigmaReplGuidanceArguments>(args);
  assertOptionalStringFields(record, ["card", "query", "task", "intent", "goal", "workflow"]);
  assertOptionalEnum(record, "mode", FIGMA_REPL_GUIDANCE_MODES);
  assertOptionalEnum(record, "surface", FIGMA_REPL_SURFACES);
  assertOptionalEnum(record, "expectedSurface", FIGMA_REPL_SURFACES);
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
      "filePath",
      "localPath",
      "targetNodeId",
      "nodeId",
      "name",
      "toolName",
    ]);
    assertOptionalRecord(asset, "metadata", `${assetName}.metadata`);
    assertOptionalRecord(asset, "arguments", `${assetName}.arguments`);
  });
}

function assertOptionalTaskPlanSteps(record: Record<string, unknown>): void {
  const steps = assertOptionalArray(record, "steps");
  if (!steps) {
    return;
  }
  steps.forEach((step, index) => {
    const stepName = `steps[${index}]`;
    if (!isRecord(step)) {
      throw new Error(`Tool argument "${stepName}" must be an object.`);
    }
    assertOptionalStringFieldsWithPrefix(step, stepName, ["id", "type", "tool"]);
    assertOptionalRecord(step, "args", `${stepName}.args`);
    assertOptionalRecord(step, "arguments", `${stepName}.arguments`);
  });
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
  return {
    ...args,
    title: typeof args.title === "string" ? args.title : title,
  };
}
