import type { FigmaWorkspaceSurface } from "../runtime/script-runner.js";

export interface FigmaWorkspaceOpenArguments {
  [key: string]: unknown;
  title?: string;
  sessionId?: string;
  label?: string;
  file?: string;
  workspaceDir?: string;
  surface?: FigmaWorkspaceSurface;
  currentPageId?: string;
  reset?: boolean;
  connect?: boolean;
  handles?: Record<string, string>;
}

export interface FigmaWorkspaceEvalArguments {
  [key: string]: unknown;
  title?: string;
  sessionId?: string;
  code: string;
  typescript?: boolean;
  mode?: "read" | "write";
  surface?: FigmaWorkspaceSurface;
  allowDangerousOperations?: boolean;
  handleUpdates?: Record<string, string>;
  inlineResultLimit?: number;
}

export interface FigmaWorkspaceRunScriptFileArguments {
  [key: string]: unknown;
  title?: string;
  sessionId?: string;
  scriptPath?: string;
  inputFile?: string;
  strict?: boolean;
  surface?: FigmaWorkspaceSurface;
  targetPageId?: string;
  allowDangerousOperations?: boolean;
  inlineResultLimit?: number;
}

export interface FigmaWorkspaceAssetManifestAsset {
  [key: string]: unknown;
  path?: string;
  target?: unknown;
  nodeUrl?: string;
  url?: string;
  name?: string;
  metadata?: Record<string, unknown>;
}

export interface FigmaWorkspaceApplyAssetManifestArguments {
  [key: string]: unknown;
  title?: string;
  sessionId?: string;
  assets?: FigmaWorkspaceAssetManifestAsset[];
  manifestPath?: string;
  validateTargets?: boolean;
}

export interface FigmaWorkspaceDownloadAssetsTarget {
  [key: string]: unknown;
  target?: unknown;
  name?: string;
  defaultFormat?: "png" | "jpg" | "svg" | "pdf";
  defaultScale?: number;
}

export interface FigmaWorkspaceDownloadAssetsArguments {
  [key: string]: unknown;
  title?: string;
  sessionId?: string;
  targets?: FigmaWorkspaceDownloadAssetsTarget[];
  manifestPath?: string;
  outputDir?: string;
}

export interface FigmaWorkspaceCaptureNodeArguments {
  [key: string]: unknown;
  title?: string;
  sessionId?: string;
  target: unknown;
  imageFile?: string;
  maxDimension?: number;
  contentsOnly?: boolean;
}

export interface FigmaWorkspaceTaskPlanStep {
  id?: string;
  type?: string;
  args?: Record<string, unknown>;
}

export interface FigmaWorkspaceRunTaskPlanArguments {
  [key: string]: unknown;
  title?: string;
  sessionId?: string;
  planPath?: string;
  steps?: FigmaWorkspaceTaskPlanStep[];
  stopOnFailure?: boolean;
}

export interface FigmaWorkspaceCallUpstreamToolArguments {
  [key: string]: unknown;
  title?: string;
  sessionId?: string;
  toolName: string;
  arguments?: Record<string, unknown>;
  refresh?: boolean;
  inlineResultLimit?: number;
}

export interface FigmaWorkspaceGetMetadataArguments {
  [key: string]: unknown;
  title?: string;
  sessionId?: string;
  file?: string;
  workspaceDir?: string;
  target?: unknown;
  nodeId?: string;
  refresh?: boolean;
  inlineResultLimit?: number;
  clientLanguages?: string;
  clientFrameworks?: string;
}

export interface FigmaWorkspaceGetDesignContextArguments {
  [key: string]: unknown;
  title?: string;
  sessionId?: string;
  file?: string;
  workspaceDir?: string;
  target?: unknown;
  refresh?: boolean;
  inlineResultLimit?: number;
  clientLanguages?: string;
  clientFrameworks?: string;
  forceCode?: boolean;
  disableCodeConnect?: boolean;
  excludeScreenshot?: boolean;
}

export interface FigmaWorkspaceGetMotionContextArguments {
  [key: string]: unknown;
  title?: string;
  sessionId?: string;
  file?: string;
  workspaceDir?: string;
  target?: unknown;
  recursive?: boolean;
  clientLanguages?: string;
  clientFrameworks?: string;
  refresh?: boolean;
  inlineResultLimit?: number;
}



export interface FigmaWorkspaceSearchDesignSystemArguments {
  [key: string]: unknown;
  title?: string;
  sessionId?: string;
  file?: string;
  workspaceDir?: string;
  query: string;
  disableCodeConnect?: boolean;
  includeComponents?: boolean;
  includeVariables?: boolean;
  includeStyles?: boolean;
  includeLibraryKeys?: string[];
  refresh?: boolean;
  inlineResultLimit?: number;
}

export interface FigmaWorkspaceGetLibrariesArguments {
  [key: string]: unknown;
  title?: string;
  sessionId?: string;
  file?: string;
  workspaceDir?: string;
  offset?: number;
  refresh?: boolean;
  inlineResultLimit?: number;
}

export interface FigmaWorkspaceGetVariableDefsArguments {
  [key: string]: unknown;
  title?: string;
  sessionId?: string;
  file?: string;
  workspaceDir?: string;
  target?: unknown;
  refresh?: boolean;
  inlineResultLimit?: number;
}

export interface FigmaWorkspaceLookupArguments {
  [key: string]: unknown;
  title?: string;
  kind: "docs" | "api";
  query?: string;
  symbol?: string;
  maxResults?: number;
  maxSnippetLines?: number;
}

export interface FigmaWorkspacePrepareTaskArguments {
  [key: string]: unknown;
  title?: string;
  sessionId?: string;
  taskName: string;
  file?: string;
  fileSlug?: string;
  fileName?: string;
  workspaceDir: string;
  surface?: FigmaWorkspaceSurface;
  targetPageId?: string;
  template?: string;
  overwrite?: boolean;
}

export interface FigmaWorkspaceDocsArguments {
  [key: string]: unknown;
  topic?: string;
}

export interface FigmaWorkspaceDoctorArguments {
  [key: string]: unknown;
}

export interface FigmaWorkspaceSessionsArguments {
  [key: string]: unknown;
  sessionId?: string;
  includeHandles?: boolean;
  includeHistory?: boolean;
}

export interface FigmaWorkspaceUpstreamToolsArguments {
  [key: string]: unknown;
  name?: string;
  refresh?: boolean;
}

export interface FigmaWorkspaceGuidanceArguments {
  [key: string]: unknown;
  title?: string;
  mode?: "guidance" | "plan" | "card" | "catalog";
  card?: string;
  query?: string;
  surface?: FigmaWorkspaceSurface;
  workflow?: string;
  maxCards?: number;
}

export interface FigmaWorkspaceInspectArguments {
  [key: string]: unknown;
  title?: string;
  sessionId?: string;
  mode?: "inspect" | "validate" | "style";
  target?: string;
  depth?: number;
  handles?: string[];
}

const FIGMA_WORKSPACE_SURFACES = ["design", "figjam", "slides"] as const satisfies readonly FigmaWorkspaceSurface[];
const FIGMA_WORKSPACE_EVAL_MODES = ["read", "write"] as const;
const FIGMA_WORKSPACE_GUIDANCE_MODES = ["guidance", "plan", "card", "catalog"] as const;
const FIGMA_WORKSPACE_INSPECT_MODES = ["inspect", "validate", "style"] as const;
const FIGMA_WORKSPACE_LOOKUP_KINDS = ["docs", "api"] as const;
const FIGMA_WORKSPACE_DOWNLOAD_ASSET_FORMATS = ["png", "jpg", "svg", "pdf"] as const;

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
      `Input "${removed.join("/")}" was removed for run-script-file. Debug files are generated on demand for failures, diagnostics, and inline omissions; diagnostics are included in outputFiles.debugFile.`,
    );
  }
}

export function asOpenArgs(args: unknown): FigmaWorkspaceOpenArguments {
  const record = parseToolArgs<FigmaWorkspaceOpenArguments>(args);
  assertRemovedFileReferenceFields(record);
  assertRemovedArguments(record, ["expectedSurface"], "surface");
  assertRemovedArguments(record, ["upstreamTool", "upstreamArgument", "upstreamArguments"], "fixed use_figma execution");
  assertRemovedArguments(record, ["refresh"], "the call-upstream-tool CLI command");
  assertRemovedArguments(record, ["cwd", "workspaceCwd", "dirName"], "workspaceDir");
  assertOptionalStringFields(record, [
    "sessionId",
    "label",
    "file",
    "workspaceDir",
    "currentPageId",
  ]);
  assertOptionalEnum(record, "surface", FIGMA_WORKSPACE_SURFACES);
  assertOptionalRecord(record, "handles");
  return record;
}

export function asEvalArgs(args: unknown): FigmaWorkspaceEvalArguments {
  const record = parseToolArgs<FigmaWorkspaceEvalArguments>(args);
  assertRemovedArguments(record, ["expectedSurface"], "surface");
  assertRemovedArguments(record, ["upstreamTool", "upstreamArgument", "upstreamArguments"], "fixed use_figma execution");
  assertRemovedDebugOutputArguments(record, ["outputFile", "resultFile"]);
  assertOptionalStringFields(record, [
    "code",
    "sessionId",
  ]);
  assertOptionalEnum(record, "mode", FIGMA_WORKSPACE_EVAL_MODES);
  assertOptionalEnum(record, "surface", FIGMA_WORKSPACE_SURFACES);
  assertOptionalBooleanFields(record, ["typescript"]);
  assertOptionalRecord(record, "handleUpdates");
  return record;
}

export function asRunScriptFileArgs(args: unknown): FigmaWorkspaceRunScriptFileArguments {
  const record = parseToolArgs<FigmaWorkspaceRunScriptFileArguments>(args);
  assertRemovedArguments(record, ["expectedSurface"], "surface");
  assertRemovedArguments(record, ["dryRun"], "run-script-file without dryRun; preflight runs automatically");
  assertRemovedDebugOutputArguments(record, ["outputFile", "resultFile"]);
  assertRemovedRunScriptOutputLayoutArguments(record);
  assertRemovedArguments(record, ["upstreamTool", "upstreamArgument", "upstreamArguments"], "fixed use_figma execution");
  assertOptionalStringFields(record, [
    "sessionId",
    "scriptPath",
    "inputFile",
    "targetPageId",
  ]);
  assertOptionalEnum(record, "surface", FIGMA_WORKSPACE_SURFACES);
  return record;
}

export function asApplyAssetManifestArgs(args: unknown): FigmaWorkspaceApplyAssetManifestArguments {
  const record = parseToolArgs<FigmaWorkspaceApplyAssetManifestArguments>(args);
  assertRemovedArguments(record, ["argumentsTemplate", "toolName", "arguments", "refresh"], "figma_workspace_call_upstream_tool");
  assertRemovedArguments(record, ["batchCommit"], "figma_workspace_call_upstream_tool");
  assertRemovedDebugOutputArguments(record, ["outputFile", "resultFile"]);
  assertOptionalStringFields(record, [
    "sessionId",
    "manifestPath",
  ]);
  assertOptionalAssets(record);
  return record;
}

export function asDownloadAssetsArgs(args: unknown): FigmaWorkspaceDownloadAssetsArguments {
  const record = parseToolArgs<FigmaWorkspaceDownloadAssetsArguments>(args);
  assertRemovedArguments(record, ["target"], "targets");
  assertRemovedArguments(record, ["assets"], "targets");
  assertRemovedArguments(record, ["toolName", "arguments", "refresh", "download"], "figma_workspace_call_upstream_tool");
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

export function asCaptureNodeArgs(args: unknown): FigmaWorkspaceCaptureNodeArguments {
  const record = parseToolArgs<FigmaWorkspaceCaptureNodeArguments>(args);
  assertRemovedArguments(record, ["nodeId", "targetNodeId", "handle"], "target");
  assertRemovedArguments(record, ["outputFile"], "imageFile");
  assertRemovedArguments(record, ["resultFile"], "imageFile");
  assertRemovedArguments(record, ["metadataFile"], "figma_workspace_call_upstream_tool");
  assertRemovedArguments(record, ["argumentsTemplate", "toolName", "arguments", "refresh"], "figma_workspace_call_upstream_tool");
  assertRemovedArguments(record, ["enableBase64Response"], "figma_workspace_call_upstream_tool");
  assertOptionalStringFields(record, [
    "sessionId",
    "imageFile",
  ]);
  assertOptionalIntegerRange(record, "maxDimension", 1, 65536);
  assertOptionalBooleanFields(record, ["contentsOnly"]);
  assertOptionalCaptureTargetValue(record.target, "target");
  return record;
}

export function asRunTaskPlanArgs(args: unknown): FigmaWorkspaceRunTaskPlanArguments {
  const record = parseToolArgs<FigmaWorkspaceRunTaskPlanArguments>(args);
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

export function asPrepareTaskArgs(args: unknown): FigmaWorkspacePrepareTaskArguments {
  const record = parseToolArgs<FigmaWorkspacePrepareTaskArguments>(args);
  assertRemovedFileReferenceFields(record);
  assertRemovedArguments(record, ["intent", "goal", "task"], "taskName");
  assertRemovedArguments(record, ["taskSlug"], "taskName");
  assertRemovedArguments(record, ["taskDir", "taskRoot"], "workspaceDir");
  assertRemovedArguments(record, ["cwd", "workspaceCwd", "dirName"], "workspaceDir");
  assertRemovedArguments(record, ["scriptName"], "fileName");
  assertRemovedArguments(record, ["expectedSurface"], "surface");
  assertOptionalStringFields(record, [
    "sessionId",
    "taskName",
    "file",
    "fileSlug",
    "workspaceDir",
    "fileName",
    "targetPageId",
    "template",
  ]);
  assertOptionalEnum(record, "surface", FIGMA_WORKSPACE_SURFACES);
  return record;
}

export function asGuidanceArgs(args: unknown): FigmaWorkspaceGuidanceArguments {
  const record = parseToolArgs<FigmaWorkspaceGuidanceArguments>(args);
  assertRemovedArguments(record, ["intent", "goal", "task"], "query");
  assertRemovedArguments(record, ["expectedSurface"], "surface");
  assertOptionalStringFields(record, ["card", "query", "workflow"]);
  assertOptionalEnum(record, "mode", FIGMA_WORKSPACE_GUIDANCE_MODES);
  assertOptionalEnum(record, "surface", FIGMA_WORKSPACE_SURFACES);
  return record;
}

export function asInspectArgs(args: unknown): FigmaWorkspaceInspectArguments {
  const record = parseToolArgs<FigmaWorkspaceInspectArguments>(args);
  assertRemovedArguments(record, ["upstreamTool", "upstreamArgument", "upstreamArguments"], "fixed use_figma execution");
  assertOptionalStringFields(record, [
    "sessionId",
  ]);
  assertOptionalInspectTarget(record.target);
  assertOptionalEnum(record, "mode", FIGMA_WORKSPACE_INSPECT_MODES);
  const handles = assertOptionalArray(record, "handles");
  handles?.forEach((handle, index) => {
    if (typeof handle !== "string") {
      throw new Error(`Tool argument "handles[${index}]" must be a string.`);
    }
  });
  return record;
}

function assertOptionalInspectTarget(value: unknown): void {
  if (value === undefined || typeof value === "string") {
    return;
  }
  throw new Error('Tool argument "target" must be a string selector, handle, node id, or node URL. Do not pass { fileKey, nodeId } to figma_workspace_inspect.');
}

export function asCallUpstreamToolArgs(args: unknown): FigmaWorkspaceCallUpstreamToolArguments {
  const record = parseToolArgs<FigmaWorkspaceCallUpstreamToolArguments>(args);
  assertRemovedDebugOutputArguments(record, ["outputFile", "resultFile"]);
  assertOptionalStringFields(record, ["sessionId", "toolName"]);
  assertOptionalRecord(record, "arguments");
  return record;
}

export function asGetMetadataArgs(args: unknown): FigmaWorkspaceGetMetadataArguments {
  const record = parseToolArgs<FigmaWorkspaceGetMetadataArguments>(args);
  assertRemovedFileReferenceFields(record);
  assertRemovedDebugOutputArguments(record, ["outputFile", "resultFile", "metadataFile"]);
  assertRemovedArguments(record, ["cwd", "workspaceCwd", "dirName"], "workspaceDir");
  assertOptionalStringFields(record, [
    "sessionId",
    "file",
    "workspaceDir",
    "nodeId",
    "clientLanguages",
    "clientFrameworks",
  ]);
  assertOptionalTargetValue(record.target, "target");
  return record;
}

export function asGetDesignContextArgs(args: unknown): FigmaWorkspaceGetDesignContextArguments {
  const record = parseToolArgs<FigmaWorkspaceGetDesignContextArguments>(args);
  assertRemovedFileReferenceFields(record);
  assertRemovedDebugOutputArguments(record, ["outputFile", "resultFile"]);
  assertRemovedArguments(record, ["cwd", "workspaceCwd", "dirName"], "workspaceDir");
  assertOptionalStringFields(record, [
    "sessionId",
    "file",
    "workspaceDir",
    "clientLanguages",
    "clientFrameworks",
  ]);
  assertOptionalBooleanFields(record, [
    "forceCode",
    "disableCodeConnect",
    "excludeScreenshot",
  ]);
  assertOptionalTargetValue(record.target, "target");
  return record;
}

export function asGetMotionContextArgs(args: unknown): FigmaWorkspaceGetMotionContextArguments {
  const record = parseToolArgs<FigmaWorkspaceGetMotionContextArguments>(args);
  assertRemovedFileReferenceFields(record);
  assertRemovedDebugOutputArguments(record, ["outputFile", "resultFile"]);
  assertRemovedArguments(record, ["cwd", "workspaceCwd", "dirName"], "workspaceDir");
  assertOptionalStringFields(record, [
    "sessionId",
    "file",
    "workspaceDir",
    "clientLanguages",
    "clientFrameworks",
  ]);
  assertOptionalBooleanFields(record, ["recursive"]);
  assertOptionalTargetValue(record.target, "target");
  return record;
}

export function asSearchDesignSystemArgs(args: unknown): FigmaWorkspaceSearchDesignSystemArguments {
  const record = parseToolArgs<FigmaWorkspaceSearchDesignSystemArguments>(args);
  assertRemovedFileReferenceFields(record);
  assertRemovedDebugOutputArguments(record, ["outputFile", "resultFile"]);
  assertRemovedArguments(record, ["cwd", "workspaceCwd", "dirName"], "workspaceDir");
  assertOptionalStringFields(record, [
    "sessionId",
    "file",
    "workspaceDir",
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

export function asGetLibrariesArgs(args: unknown): FigmaWorkspaceGetLibrariesArguments {
  const record = parseToolArgs<FigmaWorkspaceGetLibrariesArguments>(args);
  assertRemovedFileReferenceFields(record);
  assertRemovedDebugOutputArguments(record, ["outputFile", "resultFile"]);
  assertRemovedArguments(record, ["cwd", "workspaceCwd", "dirName"], "workspaceDir");
  assertOptionalStringFields(record, [
    "sessionId",
    "file",
    "workspaceDir",
  ]);
  assertOptionalNonNegativeInteger(record, "offset");
  return record;
}

export function asGetVariableDefsArgs(args: unknown): FigmaWorkspaceGetVariableDefsArguments {
  const record = parseToolArgs<FigmaWorkspaceGetVariableDefsArguments>(args);
  assertRemovedFileReferenceFields(record);
  assertRemovedDebugOutputArguments(record, ["outputFile", "resultFile"]);
  assertRemovedArguments(record, ["cwd", "workspaceCwd", "dirName"], "workspaceDir");
  assertRemovedArguments(
    record,
    ["clientLanguages", "clientFrameworks"],
    "figma_workspace_get_design_context",
    "clientLanguages/clientFrameworks",
  );
  assertOptionalStringFields(record, [
    "sessionId",
    "file",
    "workspaceDir",
  ]);
  assertOptionalTargetValue(record.target, "target");
  return record;
}

export function asLookupArgs(args: unknown): FigmaWorkspaceLookupArguments {
  const record = parseToolArgs<FigmaWorkspaceLookupArguments>(args);
  assertOptionalEnum(record, "kind", FIGMA_WORKSPACE_LOOKUP_KINDS);
  assertOptionalStringFields(record, ["query", "symbol"]);
  return record;
}

export function asDocsArgs(args: unknown): FigmaWorkspaceDocsArguments {
  const record = parseToolArgs<FigmaWorkspaceDocsArguments>(args);
  assertOptionalStringFields(record, ["topic"]);
  return record;
}

export function asDoctorArgs(args: unknown): FigmaWorkspaceDoctorArguments {
  return parseToolArgs<FigmaWorkspaceDoctorArguments>(args);
}

export function asSessionsArgs(args: unknown): FigmaWorkspaceSessionsArguments {
  const record = parseToolArgs<FigmaWorkspaceSessionsArguments>(args);
  assertOptionalStringFields(record, ["sessionId"]);
  assertOptionalBooleanFields(record, ["includeHandles", "includeHistory"]);
  return record;
}

export function asUpstreamToolsArgs(args: unknown): FigmaWorkspaceUpstreamToolsArguments {
  const record = parseToolArgs<FigmaWorkspaceUpstreamToolsArguments>(args);
  assertOptionalStringFields(record, ["name"]);
  assertOptionalBooleanFields(record, ["refresh"]);
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
    assertRemovedArguments(asset, ["toolName", "arguments"], "figma_workspace_call_upstream_tool", `${assetName}.toolName/arguments`);
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

function assertOptionalDownloadAssetTargets(record: Record<string, unknown>): FigmaWorkspaceDownloadAssetsTarget[] | undefined {
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
    if (defaultFormat !== undefined && (typeof defaultFormat !== "string" || !FIGMA_WORKSPACE_DOWNLOAD_ASSET_FORMATS.includes(defaultFormat as never))) {
      throw new Error(`Tool argument "${targetName}.defaultFormat" must be one of: ${FIGMA_WORKSPACE_DOWNLOAD_ASSET_FORMATS.join(", ")}.`);
    }
    const defaultScale = target.defaultScale;
    if (defaultScale !== undefined && (typeof defaultScale !== "number" || !Number.isFinite(defaultScale) || defaultScale < 0.01 || defaultScale > 4)) {
      throw new Error(`Tool argument "${targetName}.defaultScale" must be a number from 0.01 to 4.`);
    }
    return {
      target: target.target,
      name: target.name as string | undefined,
      defaultFormat: defaultFormat as FigmaWorkspaceDownloadAssetsTarget["defaultFormat"],
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
    ["targetNodeId", "targetHandle", "targetId"],
    "{ fileKey, nodeId } or handle",
    `${displayName}.targetNodeId/targetHandle/targetId`,
  );
  assertOptionalStringFieldsWithPrefix(value, displayName, [
    "fileKey",
    "handle",
    "nodeId",
    "target",
    "id",
    "url",
    "nodeUrl",
  ]);
}

function assertOptionalIntegerRange(record: Record<string, unknown>, key: string, min: number, max: number): void {
  const value = record[key];
  if (value === undefined) {
    return;
  }
  if (typeof value !== "number" || !Number.isInteger(value) || value < min || value > max) {
    throw new Error(`Tool argument "${key}" must be an integer from ${min} to ${max}.`);
  }
}

function assertOptionalExportVideoConstraint(value: unknown): void {
  if (value === undefined) {
    return;
  }
  if (!isRecord(value)) {
    throw new Error('Tool argument "constraint" must be an object with type and value.');
  }
  const type = value.type;
  const constraintValue = value.value;
  if (type !== "SCALE" && type !== "WIDTH" && type !== "HEIGHT") {
    throw new Error('Tool argument "constraint.type" must be one of: SCALE, WIDTH, HEIGHT.');
  }
  if (typeof constraintValue !== "number" || !Number.isFinite(constraintValue) || constraintValue <= 0) {
    throw new Error('Tool argument "constraint.value" must be a positive number.');
  }
  const keys = Object.keys(value);
  const extra = keys.filter((key) => key !== "type" && key !== "value");
  if (extra.length > 0) {
    throw new Error(`Tool argument "constraint" does not allow extra fields: ${extra.join(", ")}.`);
  }
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

export function asTaskPlanSteps(value: unknown, displayName = "steps"): FigmaWorkspaceTaskPlanStep[] {
  if (!Array.isArray(value)) {
    throw new Error(`Tool argument "${displayName}" must be an array.`);
  }
  return value.map((step, index) => asTaskPlanStep(step, `${displayName}[${index}]`));
}

function assertOptionalTaskPlanSteps(record: Record<string, unknown>): FigmaWorkspaceTaskPlanStep[] | undefined {
  const steps = assertOptionalArray(record, "steps");
  if (!steps) {
    return undefined;
  }
  return asTaskPlanSteps(steps);
}

function asTaskPlanStep(value: unknown, displayName: string): FigmaWorkspaceTaskPlanStep {
  if (!isRecord(value)) {
    throw new Error(`Tool argument "${displayName}" must be an object.`);
  }
  assertRemovedArguments(value, ["tool"], "type", `${displayName}.tool`);
  assertRemovedArguments(value, ["arguments"], "args", `${displayName}.arguments`);
  assertOnlyTaskPlanStepFields(value, displayName);
  assertOptionalStringFieldsWithPrefix(value, displayName, ["id", "type"]);
  assertOptionalRecord(value, "args", `${displayName}.args`);
  const step: FigmaWorkspaceTaskPlanStep = {};
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
