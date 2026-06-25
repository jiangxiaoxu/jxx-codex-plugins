import type { FigmaReplSurface } from "./repl-script-runner.js";

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
  handleUpdates?: Record<string, string>;
  inlineResultLimit?: number;
}

export interface FigmaReplRunScriptFileArguments {
  [key: string]: unknown;
  title?: string;
  sessionId?: string;
  scriptPath?: string;
  inputFile?: string;
  strict?: boolean;
  surface?: FigmaReplSurface;
  targetPageId?: string;
  allowDangerousOperations?: boolean;
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
}

export interface FigmaReplApplyAssetManifestArguments {
  [key: string]: unknown;
  title?: string;
  sessionId?: string;
  assets?: FigmaReplAssetManifestAsset[];
  manifestPath?: string;
  validateTargets?: boolean;
}

export interface FigmaReplDownloadAssetsTarget {
  [key: string]: unknown;
  target?: unknown;
  name?: string;
  defaultFormat?: "png" | "jpg" | "svg" | "pdf";
  defaultScale?: number;
}

export interface FigmaReplDownloadAssetsArguments {
  [key: string]: unknown;
  title?: string;
  sessionId?: string;
  targets?: FigmaReplDownloadAssetsTarget[];
  manifestPath?: string;
  outputDir?: string;
}

export interface FigmaReplCaptureNodeArguments {
  [key: string]: unknown;
  title?: string;
  sessionId?: string;
  target: unknown;
  imageFile?: string;
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
}

export interface FigmaReplCallUpstreamToolArguments {
  [key: string]: unknown;
  title?: string;
  sessionId?: string;
  toolName: string;
  arguments?: Record<string, unknown>;
  refresh?: boolean;
  inlineResultLimit?: number;
}

export interface FigmaReplGetMetadataArguments {
  [key: string]: unknown;
  title?: string;
  sessionId?: string;
  file?: string;
  cwd?: string;
  dirName?: string;
  target?: unknown;
  nodeId?: string;
  refresh?: boolean;
  inlineResultLimit?: number;
  clientLanguages?: string;
  clientFrameworks?: string;
}

export interface FigmaReplSearchDesignSystemArguments {
  [key: string]: unknown;
  title?: string;
  sessionId?: string;
  file?: string;
  cwd?: string;
  dirName?: string;
  query: string;
  disableCodeConnect?: boolean;
  includeComponents?: boolean;
  includeVariables?: boolean;
  includeStyles?: boolean;
  includeLibraryKeys?: string[];
  refresh?: boolean;
  inlineResultLimit?: number;
}

export interface FigmaReplGetLibrariesArguments {
  [key: string]: unknown;
  title?: string;
  sessionId?: string;
  file?: string;
  cwd?: string;
  dirName?: string;
  offset?: number;
  refresh?: boolean;
  inlineResultLimit?: number;
}

export interface FigmaReplGetVariableDefsArguments {
  [key: string]: unknown;
  title?: string;
  sessionId?: string;
  file?: string;
  cwd?: string;
  dirName?: string;
  target?: unknown;
  refresh?: boolean;
  inlineResultLimit?: number;
  clientLanguages?: string;
  clientFrameworks?: string;
}

export interface FigmaReplLookupArguments {
  [key: string]: unknown;
  title?: string;
  kind: "docs" | "api";
  query?: string;
  symbol?: string;
  maxResults?: number;
  maxSnippetLines?: number;
}

export interface FigmaReplPrepareTaskArguments {
  [key: string]: unknown;
  title?: string;
  sessionId?: string;
  taskName?: string;
  file?: string;
  fileSlug?: string;
  cwd?: string;
  dirName?: string;
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
  surface?: FigmaReplSurface;
  workflow?: string;
  maxCards?: number;
}

export interface FigmaReplInspectArguments {
  [key: string]: unknown;
  title?: string;
  sessionId?: string;
  mode?: "inspect" | "validate" | "style";
  target?: string;
  depth?: number;
  handles?: string[];
}

const FIGMA_REPL_SURFACES = ["design", "figjam", "slides"] as const satisfies readonly FigmaReplSurface[];
const FIGMA_REPL_EVAL_MODES = ["read", "write"] as const;
const FIGMA_REPL_GUIDANCE_MODES = ["guidance", "plan", "card", "catalog"] as const;
const FIGMA_REPL_INSPECT_MODES = ["inspect", "validate", "style"] as const;
const FIGMA_REPL_LOOKUP_KINDS = ["docs", "api"] as const;
const FIGMA_REPL_DOWNLOAD_ASSET_FORMATS = ["png", "jpg", "svg", "pdf"] as const;

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

function assertRemovedDebugOutputArguments(record: Record<string, unknown>, fields: readonly string[]): void {
  const removed = fields.filter((field) => record[field] !== undefined);
  if (removed.length > 0) {
    throw new Error(
      `Tool argument "${removed.join("/")}" was removed. Debug files are generated on demand for failures, diagnostics, and inline omissions.`,
    );
  }
}

function assertRemovedRunScriptOutputLayoutArguments(record: Record<string, unknown>): void {
  const removed = ["outputDir", "diagnosticsFile", "summaryFile"].filter((field) => record[field] !== undefined);
  if (removed.length > 0) {
    throw new Error(
      `Tool argument "${removed.join("/")}" was removed for figma_repl_run_script_file. Debug files are generated on demand for failures, diagnostics, and inline omissions; diagnostics are included in outputFiles.debugFile.`,
    );
  }
}

export function asOpenArgs(args: unknown): FigmaReplOpenArguments {
  const record = parseToolArgs<FigmaReplOpenArguments>(args);
  assertRemovedFileReferenceFields(record);
  assertRemovedArguments(record, ["expectedSurface"], "surface");
  assertRemovedArguments(record, ["upstreamTool", "upstreamArgument", "upstreamArguments"], "fixed use_figma execution");
  assertRemovedArguments(record, ["refresh"], "figma-repl://upstream-tools");
  assertOptionalStringFields(record, [
    "sessionId",
    "label",
    "file",
    "cwd",
    "dirName",
    "currentPageId",
  ]);
  assertOptionalEnum(record, "surface", FIGMA_REPL_SURFACES);
  assertOptionalRecord(record, "handles");
  return record;
}

export function asEvalArgs(args: unknown): FigmaReplEvalArguments {
  const record = parseToolArgs<FigmaReplEvalArguments>(args);
  assertRemovedArguments(record, ["expectedSurface"], "surface");
  assertRemovedArguments(record, ["upstreamTool", "upstreamArgument", "upstreamArguments"], "fixed use_figma execution");
  assertRemovedDebugOutputArguments(record, ["outputFile", "resultFile"]);
  assertOptionalStringFields(record, [
    "code",
    "sessionId",
  ]);
  assertOptionalEnum(record, "mode", FIGMA_REPL_EVAL_MODES);
  assertOptionalEnum(record, "surface", FIGMA_REPL_SURFACES);
  assertOptionalRecord(record, "handleUpdates");
  return record;
}

export function asRunScriptFileArgs(args: unknown): FigmaReplRunScriptFileArguments {
  const record = parseToolArgs<FigmaReplRunScriptFileArguments>(args);
  assertRemovedArguments(record, ["expectedSurface"], "surface");
  assertRemovedArguments(record, ["dryRun"], "figma_repl_run_script_file without dryRun; preflight runs automatically");
  assertRemovedDebugOutputArguments(record, ["outputFile", "resultFile"]);
  assertRemovedRunScriptOutputLayoutArguments(record);
  assertRemovedArguments(record, ["upstreamTool", "upstreamArgument", "upstreamArguments"], "fixed use_figma execution");
  assertOptionalStringFields(record, [
    "sessionId",
    "scriptPath",
    "inputFile",
    "targetPageId",
  ]);
  assertOptionalEnum(record, "surface", FIGMA_REPL_SURFACES);
  return record;
}

export function asApplyAssetManifestArgs(args: unknown): FigmaReplApplyAssetManifestArguments {
  const record = parseToolArgs<FigmaReplApplyAssetManifestArguments>(args);
  assertRemovedArguments(record, ["argumentsTemplate", "toolName", "arguments", "refresh"], "figma_repl_call_upstream_tool");
  assertRemovedDebugOutputArguments(record, ["outputFile", "resultFile"]);
  assertOptionalStringFields(record, [
    "sessionId",
    "manifestPath",
  ]);
  assertOptionalAssets(record);
  return record;
}

export function asDownloadAssetsArgs(args: unknown): FigmaReplDownloadAssetsArguments {
  const record = parseToolArgs<FigmaReplDownloadAssetsArguments>(args);
  assertRemovedArguments(record, ["target"], "targets");
  assertRemovedArguments(record, ["assets"], "targets");
  assertRemovedArguments(record, ["toolName", "arguments", "refresh", "download"], "figma_repl_call_upstream_tool");
  assertRemovedDebugOutputArguments(record, ["outputFile", "resultFile"]);
  assertOptionalStringFields(record, [
    "sessionId",
    "manifestPath",
    "outputDir",
  ]);
  const targets = assertOptionalDownloadAssetTargets(record);
  if (targets) {
    record.targets = targets;
  }
  return record;
}

export function asCaptureNodeArgs(args: unknown): FigmaReplCaptureNodeArguments {
  const record = parseToolArgs<FigmaReplCaptureNodeArguments>(args);
  assertRemovedArguments(record, ["nodeId", "targetNodeId", "handle"], "target");
  assertRemovedArguments(record, ["outputFile"], "imageFile");
  assertRemovedArguments(record, ["resultFile"], "imageFile");
  assertRemovedArguments(record, ["metadataFile"], "figma_repl_call_upstream_tool");
  assertRemovedArguments(record, ["argumentsTemplate", "toolName", "arguments", "refresh"], "figma_repl_call_upstream_tool");
  assertOptionalStringFields(record, [
    "sessionId",
    "imageFile",
  ]);
  assertOptionalCaptureTargetValue(record.target, "target");
  return record;
}

export function asRunTaskPlanArgs(args: unknown): FigmaReplRunTaskPlanArguments {
  const record = parseToolArgs<FigmaReplRunTaskPlanArguments>(args);
  assertRemovedDebugOutputArguments(record, ["outputFile", "resultFile"]);
  assertOptionalStringFields(record, [
    "sessionId",
    "planPath",
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
  assertRemovedArguments(record, ["intent", "goal", "task"], "taskName");
  assertRemovedArguments(record, ["taskSlug"], "taskName");
  assertRemovedArguments(record, ["taskDir"], "workspaceDir");
  assertRemovedArguments(record, ["scriptName"], "fileName");
  assertRemovedArguments(record, ["expectedSurface"], "surface");
  assertOptionalStringFields(record, [
    "sessionId",
    "taskName",
    "file",
    "fileSlug",
    "cwd",
    "dirName",
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
  assertRemovedArguments(record, ["intent", "goal", "task"], "query");
  assertRemovedArguments(record, ["expectedSurface"], "surface");
  assertOptionalStringFields(record, ["card", "query", "workflow"]);
  assertOptionalEnum(record, "mode", FIGMA_REPL_GUIDANCE_MODES);
  assertOptionalEnum(record, "surface", FIGMA_REPL_SURFACES);
  return record;
}

export function asInspectArgs(args: unknown): FigmaReplInspectArguments {
  const record = parseToolArgs<FigmaReplInspectArguments>(args);
  assertRemovedArguments(record, ["upstreamTool", "upstreamArgument", "upstreamArguments"], "fixed use_figma execution");
  assertOptionalStringFields(record, [
    "sessionId",
    "target",
  ]);
  assertOptionalEnum(record, "mode", FIGMA_REPL_INSPECT_MODES);
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
  assertRemovedDebugOutputArguments(record, ["outputFile", "resultFile"]);
  assertOptionalStringFields(record, ["sessionId", "toolName"]);
  assertOptionalRecord(record, "arguments");
  return record;
}

export function asGetMetadataArgs(args: unknown): FigmaReplGetMetadataArguments {
  const record = parseToolArgs<FigmaReplGetMetadataArguments>(args);
  assertRemovedFileReferenceFields(record);
  assertRemovedDebugOutputArguments(record, ["outputFile", "resultFile", "metadataFile"]);
  assertOptionalStringFields(record, [
    "sessionId",
    "file",
    "cwd",
    "dirName",
    "nodeId",
    "clientLanguages",
    "clientFrameworks",
  ]);
  return record;
}

export function asSearchDesignSystemArgs(args: unknown): FigmaReplSearchDesignSystemArguments {
  const record = parseToolArgs<FigmaReplSearchDesignSystemArguments>(args);
  assertRemovedFileReferenceFields(record);
  assertRemovedDebugOutputArguments(record, ["outputFile", "resultFile"]);
  assertOptionalStringFields(record, [
    "sessionId",
    "file",
    "cwd",
    "dirName",
    "query",
  ]);
  assertOptionalBooleanFields(record, [
    "disableCodeConnect",
    "includeComponents",
    "includeVariables",
    "includeStyles",
  ]);
  assertOptionalStringArray(record, "includeLibraryKeys");
  return record;
}

export function asGetLibrariesArgs(args: unknown): FigmaReplGetLibrariesArguments {
  const record = parseToolArgs<FigmaReplGetLibrariesArguments>(args);
  assertRemovedFileReferenceFields(record);
  assertRemovedDebugOutputArguments(record, ["outputFile", "resultFile"]);
  assertOptionalStringFields(record, [
    "sessionId",
    "file",
    "cwd",
    "dirName",
  ]);
  assertOptionalNonNegativeInteger(record, "offset");
  return record;
}

export function asGetVariableDefsArgs(args: unknown): FigmaReplGetVariableDefsArguments {
  const record = parseToolArgs<FigmaReplGetVariableDefsArguments>(args);
  assertRemovedFileReferenceFields(record);
  assertRemovedDebugOutputArguments(record, ["outputFile", "resultFile"]);
  assertOptionalStringFields(record, [
    "sessionId",
    "file",
    "cwd",
    "dirName",
    "clientLanguages",
    "clientFrameworks",
  ]);
  assertOptionalTargetValue(record.target, "target");
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

function assertOptionalBooleanFields(record: Record<string, unknown>, keys: readonly string[]): void {
  for (const key of keys) {
    const value = record[key];
    if (value === undefined) {
      continue;
    }
    if (typeof value !== "boolean") {
      throw new Error(`Tool argument "${key}" must be a boolean.`);
    }
  }
}

function assertOptionalStringArray(record: Record<string, unknown>, key: string): void {
  const values = assertOptionalArray(record, key);
  if (!values) {
    return;
  }
  values.forEach((value, index) => {
    if (typeof value !== "string") {
      throw new Error(`Tool argument "${key}[${index}]" must be a string.`);
    }
  });
}

function assertOptionalNonNegativeInteger(record: Record<string, unknown>, key: string): void {
  const value = record[key];
  if (value === undefined) {
    return;
  }
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    throw new Error(`Tool argument "${key}" must be a non-negative integer.`);
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
    ]);
    assertRemovedArguments(asset, ["toolName", "arguments"], "figma_repl_call_upstream_tool", `${assetName}.toolName/arguments`);
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
  });
}

function assertOptionalDownloadAssetTargets(record: Record<string, unknown>): FigmaReplDownloadAssetsTarget[] | undefined {
  const targets = assertOptionalArray(record, "targets");
  if (!targets) {
    return undefined;
  }
  return targets.map((target, index) => {
    const targetName = `targets[${index}]`;
    if (!isRecord(target)) {
      throw new Error(`Tool argument "${targetName}" must be an object.`);
    }
    assertRemovedArguments(
      target,
      ["nodeId", "targetNodeId", "targetHandle", "targetId"],
      "target",
      `${targetName}.nodeId/targetNodeId/targetHandle/targetId`,
    );
    assertOptionalStringFieldsWithPrefix(target, targetName, ["name"]);
    assertOptionalTargetValue(target.target, `${targetName}.target`);
    const defaultFormat = target.defaultFormat;
    if (defaultFormat !== undefined && (typeof defaultFormat !== "string" || !FIGMA_REPL_DOWNLOAD_ASSET_FORMATS.includes(defaultFormat as never))) {
      throw new Error(`Tool argument "${targetName}.defaultFormat" must be one of: ${FIGMA_REPL_DOWNLOAD_ASSET_FORMATS.join(", ")}.`);
    }
    const defaultScale = target.defaultScale;
    if (defaultScale !== undefined && (typeof defaultScale !== "number" || !Number.isFinite(defaultScale) || defaultScale < 0.01 || defaultScale > 4)) {
      throw new Error(`Tool argument "${targetName}.defaultScale" must be a number from 0.01 to 4.`);
    }
    return {
      target: target.target,
      name: target.name as string | undefined,
      defaultFormat: defaultFormat as FigmaReplDownloadAssetsTarget["defaultFormat"],
      defaultScale: defaultScale as number | undefined,
    };
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

function assertOptionalCaptureTargetValue(value: unknown, displayName: string): void {
  if (value === undefined || typeof value === "string") {
    return;
  }
  if (!isRecord(value)) {
    throw new Error(`Tool argument "${displayName}" must be a string or object.`);
  }
  assertOptionalStringFieldsWithPrefix(value, displayName, [
    "fileKey",
    "handle",
    "targetHandle",
    "nodeId",
    "targetNodeId",
    "target",
    "id",
    "url",
    "nodeUrl",
  ]);
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

export function withDefaultTitle<T extends Record<string, unknown>>(
  args: T,
  _title: string,
): T {
  if (!isRecord(args)) {
    throw new Error("Tool arguments must be an object.");
  }
  if (args.title !== undefined && typeof args.title !== "string") {
    throw new Error('Tool argument "title" must be a string.');
  }
  return args;
}
