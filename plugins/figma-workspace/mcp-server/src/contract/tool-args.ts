import type { FigmaWorkspaceSurface } from "../runtime/script-runner.js";

export class FigmaWorkspaceToolArgumentError extends Error {
  readonly name = "FigmaWorkspaceToolArgumentError";
}

export interface FigmaWorkspaceExplicitNodeTarget {
  fileKey: string;
  nodeId: string;
}

export type FigmaWorkspaceNodeTarget = string | FigmaWorkspaceExplicitNodeTarget;

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
}

export interface FigmaWorkspaceEvalArguments {
  [key: string]: unknown;
  title?: string;
  sessionId?: string;
  code: string;
  typescript?: boolean;
  surface?: FigmaWorkspaceSurface;
  inlineResultLimit?: number;
}

export interface FigmaWorkspaceRunScriptFileArguments {
  [key: string]: unknown;
  title?: string;
  sessionId?: string;
  scriptPath?: string;
  inputFile?: string;
  surface?: FigmaWorkspaceSurface;
  targetPageId?: string;
  inlineResultLimit?: number;
}

export interface FigmaWorkspaceAssetManifestAsset {
  [key: string]: unknown;
  path?: string;
  target?: FigmaWorkspaceNodeTarget;
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
  target?: FigmaWorkspaceNodeTarget;
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
  target: FigmaWorkspaceNodeTarget;
  imageFile?: string;
  maxDimension?: number;
  contentsOnly?: boolean;
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
  target?: FigmaWorkspaceNodeTarget;
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
  target?: FigmaWorkspaceNodeTarget;
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
  target?: FigmaWorkspaceNodeTarget;
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
  target?: FigmaWorkspaceNodeTarget;
  refresh?: boolean;
  inlineResultLimit?: number;
}

export type FigmaWorkspaceDocsLookupScope = "auto" | "active" | "conditional" | "router" | "examples" | "all";

export type FigmaWorkspaceTaskFamily =
  | "code-connect"
  | "create-file"
  | "design-to-code"
  | "design-generation"
  | "diagram"
  | "library-generation"
  | "motion-implementation"
  | "swiftui"
  | "figjam"
  | "motion"
  | "slides"
  | "design-editing";

export type FigmaWorkspaceGuidanceWorkflow =
  | "design-implementation-context"
  | "motion-implementation";

export interface FigmaWorkspaceLookupArguments {
  [key: string]: unknown;
  title?: string;
  kind: "docs" | "api";
  scope?: FigmaWorkspaceDocsLookupScope;
  surface?: FigmaWorkspaceSurface;
  taskFamily?: FigmaWorkspaceTaskFamily;
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

export type FigmaWorkspaceDocsArguments =
  | { [key: string]: unknown; mode: "list" }
  | {
    [key: string]: unknown;
    mode: "catalog";
    taskFamily?: FigmaWorkspaceTaskFamily;
    surface?: FigmaWorkspaceSurface;
    classification?: Exclude<FigmaWorkspaceDocsLookupScope, "auto" | "all">;
    limit?: number;
  }
  | { [key: string]: unknown; mode: "read"; id: string };

export interface FigmaWorkspaceDoctorArguments {
  [key: string]: unknown;
}

export interface FigmaWorkspaceSessionsArguments {
  [key: string]: unknown;
  sessionId?: string;
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
  query: string;
  surface?: FigmaWorkspaceSurface;
  workflow?: FigmaWorkspaceGuidanceWorkflow;
  maxCards?: number;
}

export interface FigmaWorkspaceInspectArguments {
  [key: string]: unknown;
  title?: string;
  sessionId?: string;
  mode?: "inspect" | "style";
  target?: string;
  depth?: number;
}

const FIGMA_WORKSPACE_SURFACES = ["design", "figjam", "slides"] as const satisfies readonly FigmaWorkspaceSurface[];
const FIGMA_WORKSPACE_GUIDANCE_WORKFLOWS = ["design-implementation-context", "motion-implementation"] as const satisfies readonly FigmaWorkspaceGuidanceWorkflow[];
const FIGMA_WORKSPACE_INSPECT_MODES = ["inspect", "style"] as const;
const FIGMA_WORKSPACE_LOOKUP_KINDS = ["docs", "api"] as const;
const FIGMA_WORKSPACE_DOCS_LOOKUP_SCOPES = [
  "auto",
  "active",
  "conditional",
  "router",
  "examples",
  "all",
] as const satisfies readonly FigmaWorkspaceDocsLookupScope[];
const FIGMA_WORKSPACE_TASK_FAMILIES = [
  "code-connect",
  "create-file",
  "design-to-code",
  "design-generation",
  "diagram",
  "library-generation",
  "motion-implementation",
  "swiftui",
  "figjam",
  "motion",
  "slides",
  "design-editing",
] as const satisfies readonly FigmaWorkspaceTaskFamily[];
const FIGMA_WORKSPACE_DOCS_MODES = ["list", "catalog", "read"] as const;
const FIGMA_WORKSPACE_DOCS_CLASSIFICATIONS = ["active", "conditional", "router", "examples"] as const;
const FIGMA_WORKSPACE_DOWNLOAD_ASSET_FORMATS = ["png", "jpg", "svg", "pdf"] as const;
const MAX_ASSET_MANIFEST_ITEMS = 64;
const MAX_INLINE_RESULT_LIMIT = 10_000;
const MAX_GUIDANCE_CARDS = 8;
const MAX_LOOKUP_RESULTS = 10;
const MAX_LOOKUP_SNIPPET_LINES = 8;

function assertRemovedFileReferenceFields(record: Record<string, unknown>): void {
  const removed = ["fileUrl", "fileKey"].filter((field) => record[field] !== undefined);
  if (removed.length > 0) {
    throw new FigmaWorkspaceToolArgumentError(`Tool argument "${removed.join("/")}" was removed. Use "file" with a Figma URL or file key.`);
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
    throw new FigmaWorkspaceToolArgumentError(`Tool argument "${displayName ?? removed.join("/")}" was removed. Use "${replacement}".`);
  }
}

function assertRemovedDebugOutputArguments(record: Record<string, unknown>, fields: readonly string[]): void {
  const removed = fields.filter((field) => record[field] !== undefined);
  if (removed.length > 0) {
    throw new FigmaWorkspaceToolArgumentError(
      `Tool argument "${removed.join("/")}" was removed. Debug files are generated on demand for failures, diagnostics, and inline omissions.`,
    );
  }
}

function assertRemovedRunScriptOutputLayoutArguments(record: Record<string, unknown>): void {
  const removed = ["outputDir", "diagnosticsFile", "summaryFile"].filter((field) => record[field] !== undefined);
  if (removed.length > 0) {
    throw new FigmaWorkspaceToolArgumentError(
      `Input "${removed.join("/")}" was removed for figma:script:run. Debug files are generated on demand for failures, diagnostics, and inline omissions; diagnostics are included in outputFiles.debugFile.`,
    );
  }
}

export function asOpenArgs(args: unknown): FigmaWorkspaceOpenArguments {
  const record = parseToolArgs<FigmaWorkspaceOpenArguments>(args);
  assertRemovedFileReferenceFields(record);
  assertRemovedArguments(record, ["expectedSurface"], "surface");
  assertRemovedArguments(record, ["upstreamTool", "upstreamArgument", "upstreamArguments"], "fixed native Plugin API execution");
  assertRemovedArguments(record, ["refresh"], "figma:upstream:call");
  assertRemovedArguments(record, ["cwd", "workspaceCwd", "dirName"], "workspaceDir");
  assertOptionalStringFields(record, [
    "sessionId",
    "label",
    "file",
    "workspaceDir",
    "currentPageId",
  ]);
  assertOptionalEnum(record, "surface", FIGMA_WORKSPACE_SURFACES);
  assertOptionalBooleanFields(record, ["reset", "connect"]);
  assertRemovedHandleArguments(record, ["handles"]);
  assertAllowedToolFields(record, ["title", "sessionId", "label", "file", "workspaceDir", "surface", "currentPageId", "reset", "connect"]);
  return record;
}

export function asEvalArgs(args: unknown): FigmaWorkspaceEvalArguments {
  const record = parseToolArgs<FigmaWorkspaceEvalArguments>(args);
  assertRemovedArguments(record, ["expectedSurface"], "surface");
  assertRemovedArguments(record, ["upstreamTool", "upstreamArgument", "upstreamArguments"], "fixed native Plugin API execution");
  assertRemovedDebugOutputArguments(record, ["outputFile", "resultFile"]);
  assertOptionalStringFields(record, [
    "code",
    "sessionId",
  ]);
  assertRemovedHandleArguments(record, ["handleUpdates"]);
  assertRemovedArgumentsWithoutReplacement(record, ["mode", "allowDangerousOperations"]);
  assertOptionalEnum(record, "surface", FIGMA_WORKSPACE_SURFACES);
  assertOptionalBooleanFields(record, ["typescript"]);
  assertOptionalIntegerRange(record, "inlineResultLimit", 0, MAX_INLINE_RESULT_LIMIT);
  assertAllowedToolFields(record, ["title", "sessionId", "code", "typescript", "surface", "inlineResultLimit"]);
  return record;
}

export function asRunScriptFileArgs(args: unknown): FigmaWorkspaceRunScriptFileArguments {
  const record = parseToolArgs<FigmaWorkspaceRunScriptFileArguments>(args);
  assertRemovedArguments(record, ["expectedSurface"], "surface");
  assertRemovedArguments(record, ["dryRun"], "figma:script:run without dryRun; preflight runs automatically");
  assertRemovedDebugOutputArguments(record, ["outputFile", "resultFile"]);
  assertRemovedRunScriptOutputLayoutArguments(record);
  assertRemovedArguments(record, ["upstreamTool", "upstreamArgument", "upstreamArguments"], "fixed native Plugin API execution");
  assertRemovedArgumentsWithoutReplacement(record, ["allowDangerousOperations", "strict"]);
  assertOptionalStringFields(record, [
    "sessionId",
    "scriptPath",
    "inputFile",
    "targetPageId",
  ]);
  assertOptionalEnum(record, "surface", FIGMA_WORKSPACE_SURFACES);
  assertOptionalIntegerRange(record, "inlineResultLimit", 0, MAX_INLINE_RESULT_LIMIT);
  assertAllowedToolFields(record, ["title", "sessionId", "scriptPath", "inputFile", "surface", "targetPageId", "inlineResultLimit"]);
  return record;
}

export function asApplyAssetManifestArgs(args: unknown): FigmaWorkspaceApplyAssetManifestArguments {
  const record = parseToolArgs<FigmaWorkspaceApplyAssetManifestArguments>(args);
  assertRemovedArguments(record, ["argumentsTemplate", "toolName", "arguments", "refresh"], "figma:upstream:call");
  assertRemovedArguments(record, ["batchCommit"], "figma:upstream:call");
  assertRemovedDebugOutputArguments(record, ["outputFile", "resultFile"]);
  assertOptionalStringFields(record, [
    "sessionId",
    "manifestPath",
  ]);
  assertOptionalAssets(record);
  assertOptionalBooleanFields(record, ["validateTargets"]);
  assertAllowedToolFields(record, ["title", "sessionId", "assets", "manifestPath", "validateTargets"]);
  return record;
}

export function asDownloadAssetsArgs(args: unknown): FigmaWorkspaceDownloadAssetsArguments {
  const record = parseToolArgs<FigmaWorkspaceDownloadAssetsArguments>(args);
  assertRemovedArguments(record, ["target"], "targets");
  assertRemovedArguments(record, ["assets"], "targets");
  assertRemovedArguments(record, ["toolName", "arguments", "refresh", "download"], "figma:upstream:call");
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
  assertAllowedToolFields(record, ["title", "sessionId", "targets", "manifestPath", "outputDir"]);
  return record;
}

export function asCaptureNodeArgs(args: unknown): FigmaWorkspaceCaptureNodeArguments {
  const record = parseToolArgs<FigmaWorkspaceCaptureNodeArguments>(args);
  assertRemovedArguments(record, ["nodeId", "targetNodeId", "handle"], "target");
  assertRemovedArguments(record, ["outputFile"], "imageFile");
  assertRemovedArguments(record, ["resultFile"], "imageFile");
  assertRemovedArguments(record, ["metadataFile"], "figma:upstream:call");
  assertRemovedArguments(record, ["argumentsTemplate", "toolName", "arguments", "refresh"], "figma:upstream:call");
  assertRemovedArguments(record, ["enableBase64Response"], "figma:upstream:call");
  assertOptionalStringFields(record, [
    "sessionId",
    "imageFile",
  ]);
  assertOptionalIntegerRange(record, "maxDimension", 1, 65536);
  assertOptionalBooleanFields(record, ["contentsOnly"]);
  assertOptionalCaptureTargetValue(record.target, "target");
  assertAllowedToolFields(record, ["title", "sessionId", "target", "imageFile", "maxDimension", "contentsOnly"]);
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
  assertOptionalBooleanFields(record, ["overwrite"]);
  assertAllowedToolFields(record, ["title", "sessionId", "taskName", "file", "fileSlug", "fileName", "workspaceDir", "surface", "targetPageId", "template", "overwrite"]);
  return record;
}

export function asGuidanceArgs(args: unknown): FigmaWorkspaceGuidanceArguments {
  const record = parseToolArgs<FigmaWorkspaceGuidanceArguments>(args);
  assertRemovedArguments(record, ["intent", "goal", "task"], "query");
  assertRemovedArguments(record, ["expectedSurface"], "surface");
  assertRemovedArgumentsWithoutReplacement(record, ["mode", "card"]);
  if (typeof record.query !== "string" || record.query.trim() === "") {
    throw new FigmaWorkspaceToolArgumentError('Tool argument "query" must be a non-empty string.');
  }
  assertOptionalEnum(record, "surface", FIGMA_WORKSPACE_SURFACES);
  assertOptionalEnum(record, "workflow", FIGMA_WORKSPACE_GUIDANCE_WORKFLOWS);
  assertOptionalIntegerRange(record, "maxCards", 1, MAX_GUIDANCE_CARDS);
  assertAllowedToolFields(record, ["title", "query", "surface", "workflow", "maxCards"]);
  return record;
}

export function asInspectArgs(args: unknown): FigmaWorkspaceInspectArguments {
  const record = parseToolArgs<FigmaWorkspaceInspectArguments>(args);
  assertRemovedArguments(record, ["upstreamTool", "upstreamArgument", "upstreamArguments"], "fixed native Plugin API execution");
  assertOptionalStringFields(record, [
    "sessionId",
  ]);
  assertOptionalInspectTarget(record.target);
  assertOptionalEnum(record, "mode", FIGMA_WORKSPACE_INSPECT_MODES);
  assertOptionalIntegerRange(record, "depth", 1, Number.MAX_SAFE_INTEGER);
  assertRemovedHandleArguments(record, ["handles"]);
  assertAllowedToolFields(record, ["title", "sessionId", "mode", "target", "depth"]);
  return record;
}

function assertOptionalInspectTarget(value: unknown): void {
  if (value === undefined) {
    return;
  }
  if (typeof value !== "string" || value.trim() === "") {
    throw new FigmaWorkspaceToolArgumentError('Tool argument "target" must be $selection, $currentPage, a raw node id, or a node URL string.');
  }
  if (value.startsWith("$") && value !== "$selection" && value !== "$currentPage") {
    throw new FigmaWorkspaceToolArgumentError('Tool argument "target" no longer accepts local handles. Use $selection, $currentPage, a raw node id, or a node URL.');
  }
}

export function asCallUpstreamToolArgs(args: unknown): FigmaWorkspaceCallUpstreamToolArguments {
  const record = parseToolArgs<FigmaWorkspaceCallUpstreamToolArguments>(args);
  assertRemovedDebugOutputArguments(record, ["outputFile", "resultFile"]);
  assertOptionalStringFields(record, ["sessionId", "toolName"]);
  assertOptionalRecord(record, "arguments");
  assertOptionalBooleanFields(record, ["refresh"]);
  assertOptionalIntegerRange(record, "inlineResultLimit", 0, MAX_INLINE_RESULT_LIMIT);
  assertAllowedToolFields(record, ["title", "sessionId", "toolName", "arguments", "refresh", "inlineResultLimit"]);
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
  assertOptionalBooleanFields(record, ["refresh"]);
  assertOptionalIntegerRange(record, "inlineResultLimit", 0, MAX_INLINE_RESULT_LIMIT);
  assertAllowedToolFields(record, [
    "title", "sessionId", "file", "workspaceDir", "target", "nodeId", "refresh",
    "inlineResultLimit", "clientLanguages", "clientFrameworks",
  ]);
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
    "refresh",
  ]);
  assertOptionalTargetValue(record.target, "target");
  assertOptionalIntegerRange(record, "inlineResultLimit", 0, MAX_INLINE_RESULT_LIMIT);
  assertAllowedToolFields(record, [
    "title", "sessionId", "file", "workspaceDir", "target", "refresh", "inlineResultLimit",
    "clientLanguages", "clientFrameworks", "forceCode", "disableCodeConnect", "excludeScreenshot",
  ]);
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
  assertOptionalBooleanFields(record, ["recursive", "refresh"]);
  assertOptionalTargetValue(record.target, "target");
  assertOptionalIntegerRange(record, "inlineResultLimit", 0, MAX_INLINE_RESULT_LIMIT);
  assertAllowedToolFields(record, [
    "title", "sessionId", "file", "workspaceDir", "target", "recursive", "clientLanguages",
    "clientFrameworks", "refresh", "inlineResultLimit",
  ]);
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
    "refresh",
  ]);
  assertOptionalStringArray(record, "includeLibraryKeys");
  assertOptionalIntegerRange(record, "inlineResultLimit", 0, MAX_INLINE_RESULT_LIMIT);
  assertAllowedToolFields(record, [
    "title", "sessionId", "file", "workspaceDir", "query", "disableCodeConnect",
    "includeComponents", "includeVariables", "includeStyles", "includeLibraryKeys", "refresh",
    "inlineResultLimit",
  ]);
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
  assertOptionalBooleanFields(record, ["refresh"]);
  assertOptionalIntegerRange(record, "inlineResultLimit", 0, MAX_INLINE_RESULT_LIMIT);
  assertAllowedToolFields(record, [
    "title", "sessionId", "file", "workspaceDir", "offset", "refresh", "inlineResultLimit",
  ]);
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
    "figma:design-context",
    "clientLanguages/clientFrameworks",
  );
  assertOptionalStringFields(record, [
    "sessionId",
    "file",
    "workspaceDir",
  ]);
  assertOptionalTargetValue(record.target, "target");
  assertOptionalBooleanFields(record, ["refresh"]);
  assertOptionalIntegerRange(record, "inlineResultLimit", 0, MAX_INLINE_RESULT_LIMIT);
  assertAllowedToolFields(record, [
    "title", "sessionId", "file", "workspaceDir", "target", "refresh", "inlineResultLimit",
  ]);
  return record;
}

export function asLookupArgs(args: unknown): FigmaWorkspaceLookupArguments {
  const record = parseToolArgs<FigmaWorkspaceLookupArguments>(args);
  assertOptionalEnum(record, "kind", FIGMA_WORKSPACE_LOOKUP_KINDS);
  assertOptionalEnum(record, "scope", FIGMA_WORKSPACE_DOCS_LOOKUP_SCOPES);
  if (record.scope !== undefined && record.kind !== "docs") {
    throw new FigmaWorkspaceToolArgumentError('Tool argument "scope" is only allowed when "kind" is "docs".');
  }
  if (record.kind === "docs" && record.scope === undefined) {
    record.scope = "auto";
  }
  if (record.kind !== "docs" && (record.surface !== undefined || record.taskFamily !== undefined)) {
    throw new FigmaWorkspaceToolArgumentError('Tool arguments "surface" and "taskFamily" are only allowed when "kind" is "docs".');
  }
  assertOptionalEnum(record, "surface", FIGMA_WORKSPACE_SURFACES);
  assertOptionalEnum(record, "taskFamily", FIGMA_WORKSPACE_TASK_FAMILIES);
  assertOptionalStringFields(record, ["query", "symbol"]);
  assertOptionalIntegerRange(record, "maxResults", 1, MAX_LOOKUP_RESULTS);
  assertOptionalIntegerRange(record, "maxSnippetLines", 1, MAX_LOOKUP_SNIPPET_LINES);
  assertAllowedToolFields(record, [
    "title", "kind", "scope", "surface", "taskFamily", "query", "symbol", "maxResults",
    "maxSnippetLines",
  ]);
  return record;
}

export function asDocsArgs(args: unknown): FigmaWorkspaceDocsArguments {
  const record = parseToolArgs<Record<string, unknown>>(args);
  assertOptionalEnum(record, "mode", FIGMA_WORKSPACE_DOCS_MODES);
  assertAllowedToolFields(record, ["mode", "id", "taskFamily", "surface", "classification", "limit"]);
  if (record.mode === "list") {
    return record as FigmaWorkspaceDocsArguments;
  }
  if (record.mode === "catalog") {
    assertOptionalEnum(record, "taskFamily", FIGMA_WORKSPACE_TASK_FAMILIES);
    assertOptionalEnum(record, "surface", FIGMA_WORKSPACE_SURFACES);
    assertOptionalEnum(record, "classification", FIGMA_WORKSPACE_DOCS_CLASSIFICATIONS);
    assertOptionalIntegerRange(record, "limit", 1, 100);
    return record as FigmaWorkspaceDocsArguments;
  }
  if (record.mode === "read") {
    assertOptionalStringFields(record, ["id"]);
    if (typeof record.id !== "string" || record.id.trim().length === 0) {
      throw new FigmaWorkspaceToolArgumentError('Tool argument "id" is required when docs mode is "read".');
    }
    return record as FigmaWorkspaceDocsArguments;
  }
  throw new FigmaWorkspaceToolArgumentError('Tool argument "mode" must be one of: list, catalog, read.');
}

export function asDoctorArgs(args: unknown): FigmaWorkspaceDoctorArguments {
  const record = parseToolArgs<FigmaWorkspaceDoctorArguments>(args);
  assertAllowedToolFields(record, []);
  return record;
}

export function asSessionsArgs(args: unknown): FigmaWorkspaceSessionsArguments {
  const record = parseToolArgs<FigmaWorkspaceSessionsArguments>(args);
  assertOptionalStringFields(record, ["sessionId"]);
  assertRemovedHandleArguments(record, ["includeHandles"]);
  assertOptionalBooleanFields(record, ["includeHistory"]);
  assertAllowedToolFields(record, ["sessionId", "includeHistory"]);
  return record;
}

export function asUpstreamToolsArgs(args: unknown): FigmaWorkspaceUpstreamToolsArguments {
  const record = parseToolArgs<FigmaWorkspaceUpstreamToolsArguments>(args);
  assertOptionalStringFields(record, ["name"]);
  assertOptionalBooleanFields(record, ["refresh"]);
  assertAllowedToolFields(record, ["name", "refresh"]);
  return record;
}

function parseToolArgs<T extends Record<string, unknown>>(value: unknown): T {
  if (value === undefined) {
    return {} as T;
  }
  if (!isRecord(value)) {
    throw new FigmaWorkspaceToolArgumentError("Tool arguments must be an object.");
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
    throw new FigmaWorkspaceToolArgumentError(`Tool argument "${key}" must be one of: ${values.join(", ")}.`);
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
    throw new FigmaWorkspaceToolArgumentError(`Tool argument "${displayName}" must be an object.`);
  }
}

function assertOptionalArray(record: Record<string, unknown>, key: string): unknown[] | undefined {
  const value = record[key];
  if (value === undefined) {
    return undefined;
  }
  if (!Array.isArray(value)) {
    throw new FigmaWorkspaceToolArgumentError(`Tool argument "${key}" must be an array.`);
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
      throw new FigmaWorkspaceToolArgumentError(`Tool argument "${key}" must be a string.`);
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
      throw new FigmaWorkspaceToolArgumentError(`Tool argument "${key}" must be a boolean.`);
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
      throw new FigmaWorkspaceToolArgumentError(`Tool argument "${key}[${index}]" must be a string.`);
    }
  });
}

function assertOptionalNonNegativeInteger(record: Record<string, unknown>, key: string): void {
  const value = record[key];
  if (value === undefined) {
    return;
  }
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    throw new FigmaWorkspaceToolArgumentError(`Tool argument "${key}" must be a non-negative integer.`);
  }
}

function assertOptionalAssets(record: Record<string, unknown>): void {
  const assets = assertOptionalArray(record, "assets");
  if (!assets) {
    return;
  }
  if (assets.length > MAX_ASSET_MANIFEST_ITEMS) {
    throw new FigmaWorkspaceToolArgumentError(`Tool argument "assets" must contain at most ${MAX_ASSET_MANIFEST_ITEMS} items.`);
  }
  assets.forEach((asset, index) => {
    const assetName = `assets[${index}]`;
    if (!isRecord(asset)) {
      throw new FigmaWorkspaceToolArgumentError(`Tool argument "${assetName}" must be an object.`);
    }
    assertOptionalStringFieldsWithPrefix(asset, assetName, [
      "path",
      "name",
    ]);
    assertRemovedArguments(asset, ["toolName", "arguments"], "figma:upstream:call", `${assetName}.toolName/arguments`);
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
    assertAllowedToolFields(asset, ["path", "target", "name", "metadata"], assetName);
  });
}

function assertOptionalDownloadAssetTargets(record: Record<string, unknown>): FigmaWorkspaceDownloadAssetsTarget[] | undefined {
  const targets = assertOptionalArray(record, "targets");
  if (!targets) {
    return undefined;
  }
  if (targets.length > MAX_ASSET_MANIFEST_ITEMS) {
    throw new FigmaWorkspaceToolArgumentError(`Tool argument "targets" must contain at most ${MAX_ASSET_MANIFEST_ITEMS} items.`);
  }
  return targets.map((target, index) => {
    const targetName = `targets[${index}]`;
    if (!isRecord(target)) {
      throw new FigmaWorkspaceToolArgumentError(`Tool argument "${targetName}" must be an object.`);
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
      throw new FigmaWorkspaceToolArgumentError(`Tool argument "${targetName}.defaultFormat" must be one of: ${FIGMA_WORKSPACE_DOWNLOAD_ASSET_FORMATS.join(", ")}.`);
    }
    const defaultScale = target.defaultScale;
    if (defaultScale !== undefined && (typeof defaultScale !== "number" || !Number.isFinite(defaultScale) || defaultScale < 0.01 || defaultScale > 4)) {
      throw new FigmaWorkspaceToolArgumentError(`Tool argument "${targetName}.defaultScale" must be a number from 0.01 to 4.`);
    }
    assertAllowedToolFields(target, ["target", "name", "defaultFormat", "defaultScale"], targetName);
    return {
      target: target.target as FigmaWorkspaceNodeTarget | undefined,
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
    assertNodeTargetString(value, displayName);
    return;
  }
  if (!isRecord(value)) {
    throw new FigmaWorkspaceToolArgumentError(`Tool argument "${displayName}" must be a raw node id, node URL, or { fileKey, nodeId }.`);
  }
  assertExplicitNodeTarget(value, displayName);
}

function assertOptionalIntegerRange(record: Record<string, unknown>, key: string, min: number, max: number): void {
  const value = record[key];
  if (value === undefined) {
    return;
  }
  if (typeof value !== "number" || !Number.isInteger(value) || value < min || value > max) {
    throw new FigmaWorkspaceToolArgumentError(`Tool argument "${key}" must be an integer from ${min} to ${max}.`);
  }
}

function assertOptionalExportVideoConstraint(value: unknown): void {
  if (value === undefined) {
    return;
  }
  if (!isRecord(value)) {
    throw new FigmaWorkspaceToolArgumentError('Tool argument "constraint" must be an object with type and value.');
  }
  const type = value.type;
  const constraintValue = value.value;
  if (type !== "SCALE" && type !== "WIDTH" && type !== "HEIGHT") {
    throw new FigmaWorkspaceToolArgumentError('Tool argument "constraint.type" must be one of: SCALE, WIDTH, HEIGHT.');
  }
  if (typeof constraintValue !== "number" || !Number.isFinite(constraintValue) || constraintValue <= 0) {
    throw new FigmaWorkspaceToolArgumentError('Tool argument "constraint.value" must be a positive number.');
  }
  const keys = Object.keys(value);
  const extra = keys.filter((key) => key !== "type" && key !== "value");
  if (extra.length > 0) {
    throw new FigmaWorkspaceToolArgumentError(`Tool argument "constraint" does not allow extra fields: ${extra.join(", ")}.`);
  }
}

function assertOptionalCaptureTargetValue(value: unknown, displayName: string): void {
  if (value === undefined) {
    return;
  }
  if (typeof value === "string") {
    assertNodeTargetString(value, displayName);
    return;
  }
  if (!isRecord(value)) {
    throw new FigmaWorkspaceToolArgumentError(`Tool argument "${displayName}" must be a raw node id, node URL, or { fileKey, nodeId }.`);
  }
  assertExplicitNodeTarget(value, displayName);
}

function assertNodeTargetString(value: string, displayName: string): void {
  if (value.trim() === "") {
    throw new FigmaWorkspaceToolArgumentError(`Tool argument "${displayName}" must not be empty.`);
  }
  if (value.startsWith("$")) {
    throw new FigmaWorkspaceToolArgumentError(`Tool argument "${displayName}" no longer accepts local handles. Use a raw node id, node URL, or { fileKey, nodeId }.`);
  }
}

function assertExplicitNodeTarget(value: Record<string, unknown>, displayName: string): asserts value is Record<string, unknown> & FigmaWorkspaceExplicitNodeTarget {
  const fields = Object.keys(value);
  const extraFields = fields.filter((field) => field !== "fileKey" && field !== "nodeId");
  if (extraFields.length > 0
    || typeof value.fileKey !== "string"
    || value.fileKey.trim() === ""
    || typeof value.nodeId !== "string"
    || value.nodeId.trim() === "") {
    throw new FigmaWorkspaceToolArgumentError(`Tool argument "${displayName}" object must contain exactly non-empty string fileKey and nodeId fields.`);
  }
}

function assertRemovedHandleArguments(record: Record<string, unknown>, fields: readonly string[]): void {
  const removed = fields.filter((field) => record[field] !== undefined);
  if (removed.length > 0) {
    throw new FigmaWorkspaceToolArgumentError(`Tool argument "${removed.join("/")}" was removed because local handles are no longer supported.`);
  }
}

function assertRemovedArgumentsWithoutReplacement(record: Record<string, unknown>, fields: readonly string[]): void {
  const removed = fields.filter((field) => record[field] !== undefined);
  if (removed.length > 0) {
    throw new FigmaWorkspaceToolArgumentError(`Tool argument "${removed.join("/")}" was removed.`);
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
      throw new FigmaWorkspaceToolArgumentError(`Tool argument "${prefix}.${key}" must be a string.`);
    }
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function assertAllowedToolFields(
  record: Record<string, unknown>,
  allowedFields: readonly string[],
  displayName = "command input",
): void {
  const allowed = new Set(allowedFields);
  const unknownFields = Object.keys(record).filter((field) => !allowed.has(field));
  if (unknownFields.length > 0) {
    throw new FigmaWorkspaceToolArgumentError(
      `Tool argument "${displayName}" does not allow unknown field${unknownFields.length === 1 ? "" : "s"}: ${unknownFields.join(", ")}.`,
    );
  }
}

export function withDefaultTitle<T extends Record<string, unknown>>(
  args: T,
  _title: string,
): T {
  if (!isRecord(args)) {
    throw new FigmaWorkspaceToolArgumentError("Tool arguments must be an object.");
  }
  if (args.title !== undefined && typeof args.title !== "string") {
    throw new FigmaWorkspaceToolArgumentError('Tool argument "title" must be a string.');
  }
  return args;
}
