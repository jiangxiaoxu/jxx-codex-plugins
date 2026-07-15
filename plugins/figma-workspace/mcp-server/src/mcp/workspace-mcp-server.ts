import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, extname, isAbsolute, relative, resolve } from "node:path";
import {
  createRemoteMcpClient,
  isRemoteMcpOAuthError,
  type RemoteMcpOAuthError,
  type RemoteMcpClientOptions,
} from "../upstream/remote-mcp-client.js";
import {
  DEFAULT_DOCS_SEARCH_MAX_RESULTS,
  DEFAULT_DOCS_SEARCH_SNIPPET_LINES,
  MAX_DOCS_SEARCH_RESULTS,
  MAX_DOCS_SEARCH_SNIPPET_LINES,
  MAX_LOOKUP_QUERY_LENGTH,
  FigmaWorkspaceLookupCorpusUnavailableError,
  getFigmaWorkspaceCanonicalTaskRoutes,
  getFigmaWorkspaceLookupRuntimeInfo,
  listFigmaWorkspaceCanonicalCatalog,
  readFigmaWorkspaceCanonicalDoc,
  type ReferenceSearchResult,
  normalizeLookupQuery,
  normalizeLookupRankingQuery,
  searchReferenceFiles,
} from "../runtime/doc-search.js";
import {
  FIGMA_WORKSPACE_API_CARDS,
  FIGMA_WORKSPACE_COMMON_TASK_LABELS,
  FIGMA_WORKSPACE_INTENT_EXAMPLE_QUERIES,
  chooseApiCardsForIntent,
  chooseHelperProfilesForIntent,
  chooseWrapperLookupProfilesForIntent,
  findWrapperLookupProfile,
  searchApiCards,
  selectWrapperWorkflowGraph,
  type FigmaWorkspaceApiCard,
  type FigmaWorkspaceHelperProfile,
  type FigmaWorkspacePluginApiReference,
  type FigmaWorkspaceWrapperLookupProfile,
  type FigmaWorkspaceWrapperWorkflow,
  uniqueStrings,
} from "../runtime/guidance-catalog.js";
import { resolveTaskRoute, type TaskRouteResult } from "../runtime/task-routing.js";
import type { FigmaWorkspacePublicCommandId } from "../runtime/public-command-registry.js";
import {
  assertSafeFigmaWorkspaceCode,
  compileFigmaWorkspaceEvalCode,
  compileFigmaWorkspaceScriptFile,
  createFigmaWorkspaceRepairPlan,
  diagnoseFigmaWorkspaceCode,
  diagnoseFigmaWorkspaceContext,
  diagnoseWrappedScriptSize,
  getFigmaWorkspaceTypescriptRuntimeInfo,
  resolveFigmaWorkspaceScriptHelperSelection as resolveFigmaWorkspaceScriptHelperSelectionInternal,
  throwIfFatalDiagnostics,
  toFigmaWorkspaceFileDiagnostics,
  type FigmaWorkspaceDiagnostic,
  type FigmaWorkspaceDiagnosticsOptions,
  type FigmaWorkspaceDiagnosticSeverity,
  type FigmaWorkspaceFileDiagnostic,
  type FigmaWorkspaceRepairPlan,
  type FigmaWorkspaceSurface,
} from "../runtime/script-runner.js";
import {
  asApplyAssetManifestArgs,
  asCallUpstreamToolArgs,
  asCaptureNodeArgs,
  asDownloadAssetsArgs,
  asDocsArgs,
  asDoctorArgs,
  asEvalArgs,
  asGetDesignContextArgs,
  asGetLibrariesArgs,
  asGetMetadataArgs,
  asGetMotionContextArgs,
  asGetVariableDefsArgs,
  asGuidanceArgs,
  asInspectArgs,
  asLookupArgs,
  asOpenArgs,
  asPrepareTaskArgs,
  asRunScriptFileArgs,
  asRunTaskPlanArgs,
  asSearchDesignSystemArgs,
  asSessionsArgs,
  asUpstreamToolsArgs,
  withDefaultTitle,
} from "../contract/tool-args.js";
import type {
  FigmaWorkspaceApplyAssetManifestArguments,
  FigmaWorkspaceCallUpstreamToolArguments,
  FigmaWorkspaceCaptureNodeArguments,
  FigmaWorkspaceDownloadAssetsArguments,
  FigmaWorkspaceDownloadAssetsTarget,
  FigmaWorkspaceDocsArguments,
  FigmaWorkspaceDoctorArguments,
  FigmaWorkspaceEvalArguments,
  FigmaWorkspaceGetDesignContextArguments,
  FigmaWorkspaceGetLibrariesArguments,
  FigmaWorkspaceGetMetadataArguments,
  FigmaWorkspaceGetMotionContextArguments,
  FigmaWorkspaceGetVariableDefsArguments,
  FigmaWorkspaceGuidanceArguments,
  FigmaWorkspaceInspectArguments,
  FigmaWorkspaceLookupArguments,
  FigmaWorkspaceOpenArguments,
  FigmaWorkspacePrepareTaskArguments,
  FigmaWorkspaceRunScriptFileArguments,
  FigmaWorkspaceRunTaskPlanArguments,
  FigmaWorkspaceSearchDesignSystemArguments,
  FigmaWorkspaceSessionsArguments,
  FigmaWorkspaceTaskPlanStep,
  FigmaWorkspaceUpstreamToolsArguments,
} from "../contract/tool-args.js";
import {
  getFigmaWorkspaceProjectDocsRuntimeInfo,
  listFigmaWorkspaceProjectDocs,
  readFigmaWorkspaceProjectDoc,
} from "../runtime/project-docs.js";
import {
  isLocalWorkspaceToolName,
  normalizeTaskPlanStepType as normalizeTaskPlanStepTypeAlias,
  type LocalWorkspaceToolName,
} from "../contract/tool-registry.js";
import {
  FIGMA_WORKSPACE_NODE_SCOPED_TARGET_DESCRIPTION,
  FIGMA_WORKSPACE_UPSTREAM_ESCAPE_HATCH_GUIDANCE,
  FIGMA_WORKSPACE_WRAPPER_CONTRACTS,
  getFigmaWorkspaceCoveredUpstreamToolNames,
  requireFigmaWorkspaceWrapperContract,
  type FigmaWorkspaceWrapperContract,
} from "../contract/wrapper-contracts.js";
import {
  TASK_WORKSPACE_ROOT_ENV,
  captureImageOutputFilePath,
  createScriptOutputWriter,
  createSessionWorkspace,
  ensureWorkspaceDirectories,
  isMissingFileError,
  isMissingFileError as isFigmaWorkspaceMissingFileErrorForTesting,
  loadTaskPlan,
  normalizeTaskScriptName,
  resolvePreparedTaskWorkspace,
  resolveRequiredWorkspaceAwareFile,
  resolveScriptInputPath,
  resolveTaskPlanResultFile,
  resolveWorkspaceAwareFile,
  resolveWorkspaceFile,
  resultFileNameForScript,
  withTaskPlanDefaultFiles,
  writeCaptureOutputFile,
  writeJsonFile,
  writeTaskFile,
  type FigmaWorkspaceSessionWorkspace,
} from "../runtime/workspace-files.js";

export const FIGMA_WORKSPACE_DEFAULT_SESSION_ID = "default";

function readProcessEnv(name: string): string | undefined {
  return typeof process === "undefined" ? undefined : process.env?.[name];
}

function defaultTaskWorkspaceRoot(): string {
  return readProcessEnv(TASK_WORKSPACE_ROOT_ENV) ?? resolve(tmpdir(), "figma-workspace", "tasks");
}

export {
  assertSafeFigmaWorkspaceCode,
  diagnoseFigmaWorkspaceCode,
};
/**
 * @internal Missing-file matcher used by cleanup regression tests.
 * This is not a stable package API.
 */
export { isFigmaWorkspaceMissingFileErrorForTesting };

/**
 * @internal Internal-facing helper-selection utility for tests and payload debugging.
 * This is not a stable MCP tool input contract, and callers cannot use it to configure helper injection.
 */
export const resolveFigmaWorkspaceScriptHelperSelection = resolveFigmaWorkspaceScriptHelperSelectionInternal;
/**
 * @internal Internal wrapper contract registry used by parity tests.
 * This is not a stable MCP tool input or response contract.
 */
export const FIGMA_WORKSPACE_INTERNAL_WRAPPER_CONTRACTS = FIGMA_WORKSPACE_WRAPPER_CONTRACTS;
export type {
  FigmaWorkspaceDiagnostic,
  FigmaWorkspaceDiagnosticsOptions,
  FigmaWorkspaceDiagnosticSeverity,
  FigmaWorkspaceFileDiagnostic,
  FigmaWorkspaceSurface,
};
export type { FigmaWorkspaceSessionWorkspace } from "../runtime/workspace-files.js";
export type {
  FigmaWorkspaceApplyAssetManifestArguments,
  FigmaWorkspaceAssetManifestAsset,
  FigmaWorkspaceCallUpstreamToolArguments,
  FigmaWorkspaceCaptureNodeArguments,
  FigmaWorkspaceDownloadAssetsArguments,
  FigmaWorkspaceDownloadAssetsTarget,
  FigmaWorkspaceEvalArguments,
  FigmaWorkspaceGetDesignContextArguments,
  FigmaWorkspaceGetLibrariesArguments,
  FigmaWorkspaceGetMetadataArguments,
  FigmaWorkspaceGetMotionContextArguments,
  FigmaWorkspaceGetVariableDefsArguments,
  FigmaWorkspaceGuidanceArguments,
  FigmaWorkspaceInspectArguments,
  FigmaWorkspaceLookupArguments,
  FigmaWorkspaceOpenArguments,
  FigmaWorkspacePrepareTaskArguments,
  FigmaWorkspaceRunScriptFileArguments,
  FigmaWorkspaceRunTaskPlanArguments,
  FigmaWorkspaceSearchDesignSystemArguments,
  FigmaWorkspaceTaskPlanStep,
} from "../contract/tool-args.js";

const DEFAULT_EVAL_CONTRACT = requireFigmaWorkspaceWrapperContract("figma_workspace_eval");
const DEFAULT_EVAL_TOOL_NAME = requireWrapperUpstreamToolName(DEFAULT_EVAL_CONTRACT);
const DEFAULT_EVAL_ARGUMENT_NAME = requireWrapperUpstreamProperty(DEFAULT_EVAL_CONTRACT, "code");
const DEFAULT_EVAL_DESCRIPTION = "Figma Workspace Plugin API execution";
export const FIGMA_WORKSPACE_EVAL_COMMON_HELPER_NAMES = [
  "remember",
  "forget",
  "resolveId",
  "node",
  "select",
  "cloneNodeTree",
  "text",
  "findFreeSlot",
  "placeNode",
  "replaceGeneratedFrame",
  "inspect",
  "capture",
  "imageAsset",
  "checkpoint",
] as const;

type FigmaWorkspaceEvalCommonHelperName = (typeof FIGMA_WORKSPACE_EVAL_COMMON_HELPER_NAMES)[number];
type FigmaWorkspaceEvalHelperPath = "$" | `$.${FigmaWorkspaceEvalCommonHelperName}`;

const DEFAULT_HISTORY_LIMIT = 50;
const DEFAULT_INLINE_RESULT_LIMIT = 4_000;
const MAX_INLINE_RESULT_LIMIT = 10_000;
const MAX_QUEUED_CAPTURE_REQUESTS = 8;
const QUEUED_CAPTURE_ERROR_MESSAGE_BYTES = 600;
const QUEUED_CAPTURE_DIAGNOSTIC_FIELD_BYTES = 300;
const QUEUED_CAPTURE_FAILURE_RETRY_GUIDANCE = "Script execution succeeded and may have mutated Figma. Do not rerun it just because capture post-processing failed; retry the affected node with figma:capture.";
const APPLY_ASSET_MANIFEST_CONTRACT = requireFigmaWorkspaceWrapperContract("figma_workspace_apply_asset_manifest");
const DOWNLOAD_ASSETS_CONTRACT = requireFigmaWorkspaceWrapperContract("figma_workspace_download_assets");
const CAPTURE_NODE_CONTRACT = requireFigmaWorkspaceWrapperContract("figma_workspace_capture_node");
const GET_METADATA_CONTRACT = requireFigmaWorkspaceWrapperContract("figma_workspace_get_metadata");
const GET_DESIGN_CONTEXT_CONTRACT = requireFigmaWorkspaceWrapperContract("figma_workspace_get_design_context");
const GET_MOTION_CONTEXT_CONTRACT = requireFigmaWorkspaceWrapperContract("figma_workspace_get_motion_context");
const SEARCH_DESIGN_SYSTEM_CONTRACT = requireFigmaWorkspaceWrapperContract("figma_workspace_search_design_system");
const GET_LIBRARIES_CONTRACT = requireFigmaWorkspaceWrapperContract("figma_workspace_get_libraries");
const GET_VARIABLE_DEFS_CONTRACT = requireFigmaWorkspaceWrapperContract("figma_workspace_get_variable_defs");
const CALL_UPSTREAM_TOOL_CONTRACT = requireFigmaWorkspaceWrapperContract("figma_workspace_call_upstream_tool");
const UPLOAD_ASSETS_TOOL_NAME = requireWrapperUpstreamToolName(APPLY_ASSET_MANIFEST_CONTRACT);
const DOWNLOAD_ASSETS_TOOL_NAME = requireWrapperUpstreamToolName(DOWNLOAD_ASSETS_CONTRACT);
const SCREENSHOT_TOOL_NAME = requireWrapperUpstreamToolName(CAPTURE_NODE_CONTRACT);
const GET_METADATA_TOOL_NAME = requireWrapperUpstreamToolName(GET_METADATA_CONTRACT);
const GET_DESIGN_CONTEXT_TOOL_NAME = requireWrapperUpstreamToolName(GET_DESIGN_CONTEXT_CONTRACT);
const GET_MOTION_CONTEXT_TOOL_NAME = requireWrapperUpstreamToolName(GET_MOTION_CONTEXT_CONTRACT);
const SEARCH_DESIGN_SYSTEM_TOOL_NAME = requireWrapperUpstreamToolName(SEARCH_DESIGN_SYSTEM_CONTRACT);
const GET_LIBRARIES_TOOL_NAME = requireWrapperUpstreamToolName(GET_LIBRARIES_CONTRACT);
const GET_VARIABLE_DEFS_TOOL_NAME = requireWrapperUpstreamToolName(GET_VARIABLE_DEFS_CONTRACT);
const COVERED_UPSTREAM_TOOL_NAMES_TEXT = getFigmaWorkspaceCoveredUpstreamToolNames().join(", ");

function requireWrapperUpstreamToolName(contract: FigmaWorkspaceWrapperContract): string {
  if (!contract.upstreamToolName) {
    throw new Error(`Internal wrapper contract ${contract.toolName} is missing an upstream tool name.`);
  }
  return contract.upstreamToolName;
}

function requireWrapperUpstreamKind(contract: FigmaWorkspaceWrapperContract): string {
  if (!contract.upstreamKind) {
    throw new Error(`Internal wrapper contract ${contract.toolName} is missing an upstream kind.`);
  }
  return contract.upstreamKind;
}

function requireWrapperUpstreamProperty(
  contract: FigmaWorkspaceWrapperContract,
  property: string,
): string {
  if (![...(contract.requiredUpstreamProperties ?? []), ...(contract.optionalUpstreamProperties ?? [])].includes(property)) {
    throw new Error(`Internal wrapper contract ${contract.toolName} is missing upstream property ${property}.`);
  }
  return property;
}

function collectContractPassthroughArguments(options: {
  args: object;
  contract: FigmaWorkspaceWrapperContract;
}): Record<string, unknown> {
  const upstreamArguments: Record<string, unknown> = {};
  for (const property of options.contract.parameterMatrix.passthroughOptional) {
    const value = property in options.args
      ? (options.args as Record<string, unknown>)[property]
      : undefined;
    if (value !== undefined) {
      upstreamArguments[property] = value;
    }
  }
  return upstreamArguments;
}

function filterAdvertisedUpstreamArguments(options: {
  upstreamArguments: Record<string, unknown>;
  contract: FigmaWorkspaceWrapperContract;
  tool: UpstreamToolInfo;
  upstreamKind: string;
}): {
  arguments: Record<string, unknown>;
  diagnostics: FigmaWorkspaceDiagnostic[];
} {
  const required = new Set(options.contract.requiredUpstreamProperties ?? []);
  const upstreamArguments: Record<string, unknown> = {};
  const diagnostics: FigmaWorkspaceDiagnostic[] = [];
  for (const [property, value] of Object.entries(options.upstreamArguments)) {
    if (value === undefined) {
      continue;
    }
    if (required.has(property) || upstreamToolHasProperty(options.tool, property)) {
      upstreamArguments[property] = value;
      continue;
    }
    diagnostics.push(createSkippedOptionalUpstreamDiagnostic({
      toolName: options.contract.toolName,
      upstreamToolName: options.tool.name,
      upstreamKind: options.upstreamKind,
      property,
    }));
  }
  return { arguments: upstreamArguments, diagnostics };
}

function createSkippedOptionalUpstreamDiagnostic(options: {
  toolName: LocalWorkspaceToolName;
  upstreamToolName: string;
  upstreamKind: string;
  property: string;
}): FigmaWorkspaceDiagnostic {
  return {
    code: "FIGMA_WORKSPACE_UPSTREAM_OPTIONAL_SKIPPED",
    severity: "warning",
    message: `${options.toolName} skipped optional upstream argument "${options.property}" because live official ${options.upstreamKind} tool "${options.upstreamToolName}" does not advertise inputSchema.properties.${options.property}.`,
    suggestion: "No local repair is required unless the upstream call needed this optional behavior; run npm run upstream:contract:check from plugins/figma-workspace/mcp-server to audit official schema drift.",
    docsHint: "Prefer first-class commands for covered workflows; use call-upstream-tool when raw upstream behavior or uncovered capability debugging is needed.",
  };
}

export interface FigmaWorkspaceUpstreamClient {
  connect(): Promise<void>;
  close(): Promise<void>;
  listTools(): Promise<unknown>;
  callTool(name: string, args?: Record<string, unknown>): Promise<unknown>;
}

type FigmaUpstreamMcpProxyClient = FigmaWorkspaceUpstreamClient;

export interface FigmaWorkspaceClientOptions extends RemoteMcpClientOptions {
  client?: FigmaWorkspaceUpstreamClient;
  defaultSessionId?: string;
  historyLimit?: number;
  initialSessions?: readonly FigmaWorkspaceSession[];
  useBridgeOAuthCache?: boolean;
  openBrowser?: boolean;
  /**
   * Absolute path to the shared figma-workspace OAuth cache file.
   * This is a Node runtime-friendly alias for statePath.
   */
  oauthCachePath?: string;
}

export interface FigmaWorkspaceUpstreamEnvelope {
  [key: string]: unknown;
  kind: "json" | "text";
  ok: boolean;
  result?: unknown;
  text?: string;
}

export interface FigmaWorkspacePublicUpstreamError {
  [key: string]: unknown;
  message: string;
  code?: string;
  details?: unknown;
}

export interface FigmaWorkspaceFilePointer {
  [key: string]: unknown;
  path: string;
  bytes: number;
  lineCount: number;
}

export interface FigmaWorkspaceOutputFiles {
  [key: string]: unknown;
  debugFile?: FigmaWorkspaceFilePointer;
  compiledScriptFile?: FigmaWorkspaceFilePointer;
  upstreamFile?: FigmaWorkspaceFilePointer;
  metadataFile?: FigmaWorkspaceFilePointer;
}

export interface FigmaWorkspacePublicWorkspace {
  [key: string]: unknown;
  root: string;
  fileDir: string;
  fileContext: string;
  fileKey?: string;
  fileSlug: string;
  taskName: string;
  sessionDir: string;
  scriptPath: string;
  files: {
    inputFile: string;
  };
}

export interface FigmaWorkspaceHandleChanges {
  updated: string[];
  removed: string[];
}

export interface FigmaWorkspacePublicSession {
  [key: string]: unknown;
  id: string;
  slug: string;
  createdAt: string;
  updatedAt: string;
  label?: string;
  fileUrl?: string;
  fileKey?: string;
  surface?: FigmaWorkspaceSurface;
  knownPages: Record<string, string>;
  currentPageId?: string;
  handles: Record<string, string>;
  lastDiagnostics: FigmaWorkspaceDiagnostic[];
  workspace?: FigmaWorkspacePublicWorkspace;
}

export interface FigmaWorkspaceCompactSession {
  [key: string]: unknown;
  id: string;
  fileKey?: string;
  surface?: FigmaWorkspaceSurface;
  sessionDir?: string;
  handleChanges: FigmaWorkspaceHandleChanges;
}

export interface FigmaWorkspaceToolResultBase {
  [key: string]: unknown;
  ok: boolean;
  session?: FigmaWorkspaceCompactSession;
}

export interface FigmaWorkspaceOpenResult extends FigmaWorkspaceToolResultBase {
  session: FigmaWorkspaceCompactSession;
  diagnostics?: FigmaWorkspaceDiagnostic[];
}

export interface FigmaWorkspaceUpstreamBackedResult extends FigmaWorkspaceToolResultBase {
  upstream: FigmaWorkspaceUpstreamEnvelope;
  upstreamError?: FigmaWorkspacePublicUpstreamError;
}

export interface FigmaWorkspaceEvalResult extends FigmaWorkspaceUpstreamBackedResult {
  session: FigmaWorkspaceCompactSession;
  scriptExecutionSucceeded?: boolean;
  captureProcessingSucceeded?: boolean;
  retryGuidance?: string;
  captures?: FigmaWorkspaceQueuedCaptureResult[];
  diagnostics?: FigmaWorkspaceDiagnostic[];
  repairPlan?: FigmaWorkspaceRepairPlan;
  outputFiles?: FigmaWorkspaceOutputFiles;
  inlineResultLimit?: FigmaWorkspaceInlineResultLimit;
}

export interface FigmaWorkspaceCompactScriptMetadata {
  [key: string]: unknown;
  scriptPath?: string;
  inputFile?: string;
  expectedSurface?: FigmaWorkspaceSurface;
  compiledScriptBytes?: number;
}

/** @deprecated Use FigmaWorkspaceCompactScriptMetadata. */
export type FigmaWorkspaceScriptMetadata = FigmaWorkspaceCompactScriptMetadata;

export interface FigmaWorkspaceInlineResultLimit {
  [key: string]: unknown;
  limitBytes: number;
  omitted: Array<{ field: string; bytes: number }>;
  guidance?: string;
}

export interface FigmaWorkspaceRunScriptFileResult extends FigmaWorkspaceToolResultBase {
  phase: "preflight" | "execute";
  executed: boolean;
  session: FigmaWorkspaceCompactSession;
  scriptExecutionSucceeded?: boolean;
  captureProcessingSucceeded?: boolean;
  retryGuidance?: string;
  captures?: FigmaWorkspaceQueuedCaptureResult[];
  diagnostics?: FigmaWorkspaceDiagnostic[];
  script?: FigmaWorkspaceCompactScriptMetadata;
  outputFiles?: FigmaWorkspaceOutputFiles;
  upstream?: FigmaWorkspaceUpstreamEnvelope;
  upstreamError?: FigmaWorkspacePublicUpstreamError;
  repairPlan?: FigmaWorkspaceRepairPlan;
  inlineResultLimit?: FigmaWorkspaceInlineResultLimit;
}

export interface FigmaWorkspaceQueuedCaptureResult {
  [key: string]: unknown;
  requestId: string;
  ok: boolean;
  nodeId?: string;
  imageFile?: string;
  bytes?: number;
  width?: number;
  height?: number;
  diagnostics?: FigmaWorkspaceDiagnostic[];
  upstreamError?: FigmaWorkspacePublicUpstreamError;
}

export interface FigmaWorkspaceAssetManifestItem {
  [key: string]: unknown;
  ok: boolean;
  path: string;
  targetNodeId: string;
  handle?: string;
  name?: string;
  validation?: unknown;
  upstreamError?: FigmaWorkspacePublicUpstreamError;
}

export interface FigmaWorkspaceApplyAssetManifestResult extends FigmaWorkspaceToolResultBase {
  session: FigmaWorkspaceCompactSession;
  assets: FigmaWorkspaceAssetManifestItem[];
  diagnostics?: FigmaWorkspaceDiagnostic[];
  validation?: unknown;
  failures?: Array<Record<string, unknown>>;
  outputFiles?: FigmaWorkspaceOutputFiles;
}

export interface FigmaWorkspaceDownloadedAssetFile extends FigmaWorkspaceFilePointer {
  [key: string]: unknown;
  kind: "exported" | "raw";
  sourceUrl: string;
  mimeType?: string;
  format?: string;
}

export interface FigmaWorkspaceDownloadAssetsTargetResult {
  [key: string]: unknown;
  ok: boolean;
  targetNodeId: string;
  handle?: string;
  name?: string;
  outputDir: string;
  downloadedFiles: FigmaWorkspaceDownloadedAssetFile[];
  upstreamError?: FigmaWorkspacePublicUpstreamError;
  downloadError?: FigmaWorkspacePublicUpstreamError;
}

export interface FigmaWorkspaceDownloadAssetsResult extends FigmaWorkspaceToolResultBase {
  session: FigmaWorkspaceCompactSession;
  outputDir: string;
  targets: FigmaWorkspaceDownloadAssetsTargetResult[];
  failures?: Array<Record<string, unknown>>;
  outputFiles?: FigmaWorkspaceOutputFiles;
}

export interface FigmaWorkspaceCaptureNodeResult extends FigmaWorkspaceToolResultBase {
  session: FigmaWorkspaceCompactSession;
  imageFile?: string;
  nodeId: string;
  bytes?: number;
  width?: number;
  height?: number;
  upstreamError?: FigmaWorkspacePublicUpstreamError;
}

export interface FigmaWorkspaceTaskPlanStepResult {
  [key: string]: unknown;
  id: string;
  index: number;
  type: string;
  status: string;
  ok: boolean;
  summary?: Record<string, unknown>;
  outputReferences?: Record<string, unknown>;
  error?: FigmaWorkspacePublicUpstreamError;
}

export interface FigmaWorkspaceTaskPlanFailure {
  [key: string]: unknown;
  id: string;
  index: number;
  type: string;
  status: string;
  error?: FigmaWorkspacePublicUpstreamError;
}

export interface FigmaWorkspaceRunTaskPlanResult extends FigmaWorkspaceToolResultBase {
  session: FigmaWorkspaceCompactSession;
  stopped: boolean;
  steps: FigmaWorkspaceTaskPlanStepResult[];
  outputFiles: FigmaWorkspaceOutputFiles;
  failures?: FigmaWorkspaceTaskPlanFailure[];
}

export interface FigmaWorkspacePreparedTask {
  [key: string]: unknown;
  taskName: string;
  fileContext: string;
  inputFile: string;
  workspace: FigmaWorkspacePublicWorkspace;
  scriptPath: string;
  overwritten: boolean;
}

export interface FigmaWorkspacePrepareTaskResult extends FigmaWorkspaceToolResultBase {
  task: FigmaWorkspacePreparedTask;
  next: string[];
}

export interface FigmaWorkspaceGuidanceResult extends FigmaWorkspaceToolResultBase {
  route?: TaskRouteResult;
  workflow?: Record<string, unknown>;
  steps?: string[];
  recommendedTools?: FigmaWorkspacePublicCommandId[];
  wrapperProfiles?: Array<Record<string, unknown>>;
  workflowGraph?: Array<Record<string, unknown>>;
  cards?: Array<Record<string, unknown>>;
  guidance?: string;
  queryHints?: string[];
  apiReferences?: FigmaWorkspacePluginApiReference[];
  guardrails?: string[];
  referenceContext?: ReferenceSearchResult[];
  nextActions?: FigmaWorkspaceNextAction[];
}

export interface FigmaWorkspaceNextAction {
  commandId: FigmaWorkspacePublicCommandId;
  args: Record<string, string | number | boolean>;
  reason: string;
  priority: number;
}

export interface FigmaWorkspaceInspectResult extends FigmaWorkspaceToolResultBase {
  session: FigmaWorkspaceCompactSession;
  diagnostics?: FigmaWorkspaceDiagnostic[];
  upstreamError?: FigmaWorkspacePublicUpstreamError;
}

export interface FigmaWorkspaceCallUpstreamToolResult extends FigmaWorkspaceUpstreamBackedResult {
  session: FigmaWorkspaceCompactSession;
  toolName: string;
  outputFiles?: FigmaWorkspaceOutputFiles;
  inlineResultLimit?: FigmaWorkspaceInlineResultLimit;
}

export interface FigmaWorkspaceSearchDesignSystemResult extends FigmaWorkspaceUpstreamBackedResult {
  session: FigmaWorkspaceCompactSession;
  fileKey: string;
  query: string;
  outputFiles?: FigmaWorkspaceOutputFiles;
  inlineResultLimit?: FigmaWorkspaceInlineResultLimit;
}

export interface FigmaWorkspaceWrapperGuidanceRef {
  source: "guidance";
  query: string;
  workflowIds: string[];
}

export interface FigmaWorkspaceGetDesignContextResult extends FigmaWorkspaceUpstreamBackedResult {
  session: FigmaWorkspaceCompactSession;
  fileKey: string;
  nodeId: string;
  guidanceRef?: FigmaWorkspaceWrapperGuidanceRef;
  outputFiles?: FigmaWorkspaceOutputFiles;
  inlineResultLimit?: FigmaWorkspaceInlineResultLimit;
}

export interface FigmaWorkspaceGetMotionContextResult extends FigmaWorkspaceUpstreamBackedResult {
  session: FigmaWorkspaceCompactSession;
  fileKey: string;
  nodeId: string;
  guidanceRef?: FigmaWorkspaceWrapperGuidanceRef;
  outputFiles?: FigmaWorkspaceOutputFiles;
  inlineResultLimit?: FigmaWorkspaceInlineResultLimit;
}


export interface FigmaWorkspaceGetLibrariesResult extends FigmaWorkspaceUpstreamBackedResult {
  session: FigmaWorkspaceCompactSession;
  fileKey: string;
  offset?: number;
  outputFiles?: FigmaWorkspaceOutputFiles;
  inlineResultLimit?: FigmaWorkspaceInlineResultLimit;
}

export interface FigmaWorkspaceGetVariableDefsResult extends FigmaWorkspaceUpstreamBackedResult {
  session: FigmaWorkspaceCompactSession;
  fileKey: string;
  nodeId: string;
  outputFiles?: FigmaWorkspaceOutputFiles;
  inlineResultLimit?: FigmaWorkspaceInlineResultLimit;
}

export interface FigmaWorkspaceMetadataTreeNode {
  [key: string]: unknown;
  nodeId?: string;
  type: string;
  name?: string;
  x?: number;
  y?: number;
  width?: number;
  height?: number;
  children?: FigmaWorkspaceMetadataTreeNode[];
}

const FIGMA_METADATA_ENRICHMENT_FIELDS = [
  "locked",
  "visible",
  "layoutPositioning",
  "layoutMode",
  "primaryAxisSizingMode",
  "counterAxisSizingMode",
  "primaryAxisAlignItems",
  "counterAxisAlignItems",
  "itemSpacing",
  "counterAxisSpacing",
  "paddingLeft",
  "paddingRight",
  "paddingTop",
  "paddingBottom",
  "layoutWrap",
] as const;

type FigmaWorkspaceMetadataEnrichmentField = typeof FIGMA_METADATA_ENRICHMENT_FIELDS[number];
type FigmaWorkspaceMetadataEnrichmentValue = string | number | boolean | null;
type FigmaWorkspaceMetadataNativeFields = Partial<Record<FigmaWorkspaceMetadataEnrichmentField, FigmaWorkspaceMetadataEnrichmentValue>>;

const FIGMA_METADATA_ENRICHMENT_BATCH_SIZE = 80;
const FIGMA_INSPECT_STYLE_BATCH_SIZE = 80;
const FIGMA_INSPECT_VALIDATE_BATCH_SIZE = 80;
const FIGMA_ASSET_APPLICATION_BATCH_SIZE = 80;
const FIGMA_ASSET_VALIDATION_BATCH_SIZE = 80;

interface FigmaWorkspaceMetadataEnrichmentSummary {
  ok: boolean;
  source: "use_figma";
  requestedNodeCount: number;
  enrichedNodeCount: number;
  fields: FigmaWorkspaceMetadataEnrichmentField[];
  warning?: Record<string, unknown>;
}

interface FigmaWorkspaceMetadataEnrichmentResult {
  summary?: FigmaWorkspaceMetadataEnrichmentSummary;
  diagnostics: FigmaWorkspaceDiagnostic[];
}

export interface FigmaWorkspaceMetadataJson {
  [key: string]: unknown;
  format: "figma-metadata-tree";
  source: "get_metadata";
  fileKey: string;
  nodeId?: string;
  nodeCount: number;
  root?: FigmaWorkspaceMetadataTreeNode;
}

export interface FigmaWorkspaceGetMetadataResult extends FigmaWorkspaceToolResultBase {
  session: FigmaWorkspaceCompactSession;
  fileKey: string;
  nodeId?: string;
  metadata: {
    [key: string]: unknown;
    format: "figma-metadata-tree";
    source: "get_metadata";
    nodeCount: number;
    jsonBytes: number;
    enrichment?: FigmaWorkspaceMetadataEnrichmentSummary;
    json?: FigmaWorkspaceMetadataJson;
  };
  diagnostics: FigmaWorkspaceDiagnostic[];
  upstream: FigmaWorkspaceUpstreamEnvelope;
  upstreamError?: FigmaWorkspacePublicUpstreamError;
  primaryFix?: string;
  outputFiles: FigmaWorkspaceOutputFiles;
  inlineResultLimit?: FigmaWorkspaceInlineResultLimit;
}

export interface FigmaWorkspaceLookupResult extends FigmaWorkspaceToolResultBase {
  requestedScope?: "auto" | "active" | "conditional" | "router" | "examples" | "all";
  effectiveScopes?: string[];
  route?: TaskRouteResult;
  results: ReferenceSearchResult[];
  nextActions?: FigmaWorkspaceNextAction[];
  diagnostics?: FigmaWorkspaceDiagnostic[];
  guidance: string;
  runtime?: Record<string, unknown>;
}

export interface FigmaWorkspaceDocsResult extends FigmaWorkspaceToolResultBase {
  mode: "list" | "catalog" | "read";
  topics?: ReturnType<typeof listFigmaWorkspaceProjectDocs>;
  taskFamilies?: ReturnType<typeof listFigmaWorkspaceCanonicalCatalog>;
  records?: ReturnType<typeof listFigmaWorkspaceCanonicalCatalog>;
  id?: string;
  kind?: "project" | "canonical";
  title?: string;
  description?: string;
  summary?: string;
  classification?: string;
  taskFamily?: string;
  surfaces?: string[];
  mappingProfile?: string;
  nonExecutable?: boolean;
  content?: string;
}

export interface FigmaWorkspaceDoctorResult extends FigmaWorkspaceToolResultBase {
  runtime: {
    projectDocs: ReturnType<typeof getFigmaWorkspaceProjectDocsRuntimeInfo>;
    lookup: ReturnType<typeof getFigmaWorkspaceLookupRuntimeInfo>;
    typescript: ReturnType<typeof getFigmaWorkspaceTypescriptRuntimeInfo>;
  };
  guidance: string[];
}

export interface FigmaWorkspaceSessionsResult {
  ok: boolean;
  sessions?: Array<Record<string, unknown>>;
  session?: Record<string, unknown>;
}

export interface FigmaWorkspaceUpstreamToolsResult extends FigmaWorkspaceToolResultBase {
  tools?: Array<Record<string, unknown>>;
  name?: string;
  description?: string;
  inputSchema?: unknown;
  categories?: string[];
  upstreamError?: Record<string, unknown>;
  primaryFix?: string;
  guidance: string;
}

export interface FigmaWorkspaceClient {
  readonly client: FigmaWorkspaceUpstreamClient;
  readonly sessions: FigmaWorkspaceSessionStore;
  connect(): Promise<void>;
  close(): Promise<void>;
  open(args?: FigmaWorkspaceOpenArguments): Promise<FigmaWorkspaceOpenResult>;
  eval(args: FigmaWorkspaceEvalArguments): Promise<FigmaWorkspaceEvalResult>;
  runScriptFile(args: FigmaWorkspaceRunScriptFileArguments): Promise<FigmaWorkspaceRunScriptFileResult>;
  applyAssetManifest(args: FigmaWorkspaceApplyAssetManifestArguments): Promise<FigmaWorkspaceApplyAssetManifestResult>;
  downloadAssets(args: FigmaWorkspaceDownloadAssetsArguments): Promise<FigmaWorkspaceDownloadAssetsResult>;
  captureNode(args: FigmaWorkspaceCaptureNodeArguments): Promise<FigmaWorkspaceCaptureNodeResult>;
  runTaskPlan(args: FigmaWorkspaceRunTaskPlanArguments): Promise<FigmaWorkspaceRunTaskPlanResult>;
  prepareTask(args: FigmaWorkspacePrepareTaskArguments): Promise<FigmaWorkspacePrepareTaskResult>;
  guidance(args: FigmaWorkspaceGuidanceArguments): Promise<FigmaWorkspaceGuidanceResult>;
  inspect(args?: FigmaWorkspaceInspectArguments): Promise<FigmaWorkspaceInspectResult>;
  getMetadata(args: FigmaWorkspaceGetMetadataArguments): Promise<FigmaWorkspaceGetMetadataResult>;
  getDesignContext(args: FigmaWorkspaceGetDesignContextArguments): Promise<FigmaWorkspaceGetDesignContextResult>;
  getMotionContext(args: FigmaWorkspaceGetMotionContextArguments): Promise<FigmaWorkspaceGetMotionContextResult>;
  searchDesignSystem(args: FigmaWorkspaceSearchDesignSystemArguments): Promise<FigmaWorkspaceSearchDesignSystemResult>;
  getLibraries(args?: FigmaWorkspaceGetLibrariesArguments): Promise<FigmaWorkspaceGetLibrariesResult>;
  getVariableDefs(args: FigmaWorkspaceGetVariableDefsArguments): Promise<FigmaWorkspaceGetVariableDefsResult>;
  callUpstreamTool(args: FigmaWorkspaceCallUpstreamToolArguments): Promise<FigmaWorkspaceCallUpstreamToolResult>;
  lookup(args: FigmaWorkspaceLookupArguments): Promise<FigmaWorkspaceLookupResult>;
  docs(args?: FigmaWorkspaceDocsArguments): Promise<FigmaWorkspaceDocsResult>;
  doctor(args?: FigmaWorkspaceDoctorArguments): Promise<FigmaWorkspaceDoctorResult>;
  sessionsInfo(args?: FigmaWorkspaceSessionsArguments): Promise<FigmaWorkspaceSessionsResult>;
  upstreamTools(args?: FigmaWorkspaceUpstreamToolsArguments): Promise<FigmaWorkspaceUpstreamToolsResult>;
}

export interface FigmaWorkspaceSession {
  id: string;
  slug: string;
  createdAt: string;
  updatedAt: string;
  label?: string;
  fileUrl?: string;
  fileKey?: string;
  surface?: FigmaWorkspaceSurface;
  knownPages: Record<string, string>;
  currentPageId?: string;
  handles: Record<string, string>;
  lastDiagnostics: FigmaWorkspaceDiagnostic[];
  history: FigmaWorkspaceHistoryEntry[];
  workspace?: FigmaWorkspaceSessionWorkspace;
}

export interface FigmaWorkspaceHistoryEntry {
  id: string;
  at: string;
  tool: string;
  mode?: string;
  summary: string;
  nodeIds: string[];
}

export interface FigmaWorkspaceSessionStore {
  defaultSessionId: string;
  getOrCreate(sessionId?: string): FigmaWorkspaceSession;
  get(sessionId?: string): FigmaWorkspaceSession | undefined;
  list(): FigmaWorkspaceSession[];
  reset(sessionId?: string): FigmaWorkspaceSession;
  rememberHistory(session: FigmaWorkspaceSession, entry: FigmaWorkspaceHistoryEntry): void;
}

interface UpstreamToolInfo {
  name: string;
  description?: string;
  inputSchema?: unknown;
}

interface EvalSettings {
  toolName: string;
  argumentName: string;
  upstreamArguments: Record<string, unknown>;
}

interface ParsedUpstreamToolResult {
  text: string;
  json?: unknown;
  upstreamError?: FigmaWorkspaceUpstreamError;
  primaryFix?: string;
}

interface FigmaWorkspaceUpstreamError {
  message: string;
  code?: string;
  details?: unknown;
  text?: string;
  parsed?: unknown;
}

interface NormalizedAssetManifest {
  assets: NormalizedAssetManifestAsset[];
}

interface NormalizedAssetManifestAsset {
  path: string;
  targetNodeId: string;
  handle?: string;
  fileKey?: string;
  nodeUrl?: string;
  scaleMode?: string;
  name?: string;
  metadata?: Record<string, unknown>;
}

interface NormalizedDownloadAssetsManifest {
  targets: NormalizedDownloadAssetsTarget[];
}

interface NormalizedDownloadAssetsTarget {
  targetNodeId: string;
  handle?: string;
  fileKey?: string;
  name?: string;
  defaultFormat?: "png" | "jpg" | "svg" | "pdf";
  defaultScale?: number;
}

interface DownloadAssetLink {
  kind: "exported" | "raw";
  url: string;
  format?: string;
  name?: string;
}

interface TaskPlanReferenceContext {
  steps: Record<string, unknown>;
  outputs: Record<string, unknown>;
  last?: unknown;
}

interface FigmaWorkspaceRuntime {
  client: FigmaWorkspaceUpstreamClient;
  sessions: FigmaWorkspaceSessionStore;
  upstreamToolCache: ReturnType<typeof createUpstreamToolCache>;
}

export function createFigmaWorkspaceSessionStore(options: {
  defaultSessionId?: string;
  historyLimit?: number;
  initialSessions?: readonly FigmaWorkspaceSession[];
} = {}): FigmaWorkspaceSessionStore {
  const defaultSessionId = sanitizeSessionId(
    options.defaultSessionId ?? FIGMA_WORKSPACE_DEFAULT_SESSION_ID,
  );
  const historyLimit = normalizePositiveInteger(options.historyLimit, DEFAULT_HISTORY_LIMIT);
  const sessions = new Map<string, FigmaWorkspaceSession>();

  for (const initialSession of options.initialSessions ?? []) {
    const session = cloneSession(initialSession);
    const id = sanitizeSessionId(session.id);
    if (id !== session.id) {
      throw new Error(`Invalid initial Figma Workspace session id: ${session.id}`);
    }
    if (sessions.has(id)) {
      throw new Error(`Duplicate Figma Workspace session id: ${id}`);
    }
    session.history = session.history.slice(-historyLimit);
    sessions.set(id, session);
  }

  const create = (sessionId?: string) => {
    const id = sanitizeSessionId(sessionId ?? defaultSessionId);
    const now = new Date().toISOString();
    const session: FigmaWorkspaceSession = {
      id,
      slug: slugifyTaskName(id),
      createdAt: now,
      updatedAt: now,
      knownPages: {},
      handles: {},
      lastDiagnostics: [],
      history: [],
    };
    sessions.set(id, session);
    return session;
  };

  return {
    defaultSessionId,
    getOrCreate(sessionId?: string) {
      const id = sanitizeSessionId(sessionId ?? defaultSessionId);
      return sessions.get(id) ?? create(id);
    },
    get(sessionId?: string) {
      return sessions.get(sanitizeSessionId(sessionId ?? defaultSessionId));
    },
    list() {
      return [...sessions.values()].map(cloneSession);
    },
    reset(sessionId?: string) {
      const id = sanitizeSessionId(sessionId ?? defaultSessionId);
      sessions.delete(id);
      return create(id);
    },
    rememberHistory(session: FigmaWorkspaceSession, entry: FigmaWorkspaceHistoryEntry) {
      session.history.push(entry);
      if (session.history.length > historyLimit) {
        session.history.splice(0, session.history.length - historyLimit);
      }
      touchSession(session);
    },
  };
}

function createFigmaWorkspaceRuntime(
  options: FigmaWorkspaceClientOptions = {},
): FigmaWorkspaceRuntime {
  const { client: providedClient, oauthCachePath, ...clientOptions } = options;
  const client =
    providedClient ??
    createRemoteMcpClient({
      ...clientOptions,
      statePath:
        oauthCachePath !== undefined
          ? normalizeOAuthCachePath(oauthCachePath)
          : clientOptions.statePath,
      useBridgeOAuthCache:
        oauthCachePath !== undefined
          ? false
          : clientOptions.useBridgeOAuthCache ?? true,
      openBrowser: clientOptions.openBrowser ?? false,
    });
  const sessions = createFigmaWorkspaceSessionStore({
    defaultSessionId: options.defaultSessionId,
    historyLimit: options.historyLimit,
    initialSessions: options.initialSessions,
  });
  const upstreamToolCache = createUpstreamToolCache(client);

  return { client, sessions, upstreamToolCache };
}

export function createFigmaWorkspaceClient(
  options: FigmaWorkspaceClientOptions = {},
): FigmaWorkspaceClient {
  const runtime = createFigmaWorkspaceRuntime(options);
  return {
    client: runtime.client,
    sessions: runtime.sessions,
    connect: () => runtime.client.connect(),
    close: () => runtime.client.close(),
    open: async (args = {}) =>
      parseJsonToolResult<FigmaWorkspaceOpenResult>(
        await handleOpen(asOpenArgs(withDefaultTitle(args, "Open Figma Workspace session")), runtime),
      ),
    eval: async (args) =>
      parseJsonToolResult<FigmaWorkspaceEvalResult>(
        await handleEval(
          asEvalArgs(withDefaultTitle(args, "Run Figma Workspace Plugin API")),
          runtime,
        ),
      ),
    runScriptFile: async (args) =>
      executeRunScriptFile(
        asRunScriptFileArgs(withDefaultTitle(args, "Run Figma TypeScript file")),
        runtime,
      ) as Promise<FigmaWorkspaceRunScriptFileResult>,
    applyAssetManifest: async (args) =>
      executeApplyAssetManifest(
        asApplyAssetManifestArgs(withDefaultTitle(args, "Apply Figma asset manifest")),
        runtime,
      ) as Promise<FigmaWorkspaceApplyAssetManifestResult>,
    downloadAssets: async (args) =>
      executeDownloadAssets(
        asDownloadAssetsArgs(withDefaultTitle(args, "Download Figma assets")),
        runtime,
      ) as Promise<FigmaWorkspaceDownloadAssetsResult>,
    captureNode: async (args) =>
      executeCaptureNode(
        asCaptureNodeArgs(withDefaultTitle(args, "Capture Figma node")),
        runtime,
      ) as Promise<FigmaWorkspaceCaptureNodeResult>,
    runTaskPlan: async (args) =>
      executeRunTaskPlan(
        asRunTaskPlanArgs(withDefaultTitle(args, "Run Figma Workspace task plan")),
        runtime,
      ) as Promise<FigmaWorkspaceRunTaskPlanResult>,
    prepareTask: async (args) =>
      parseJsonToolResult<FigmaWorkspacePrepareTaskResult>(
        await handlePrepareTask(
          asPrepareTaskArgs(withDefaultTitle(args, "Prepare Figma Workspace task")),
          { sessions: runtime.sessions },
        ),
      ),
    guidance: async (args) =>
      parseJsonToolResult<FigmaWorkspaceGuidanceResult>(
        await handleGuidance(asGuidanceArgs(withDefaultTitle(args, "Read Figma Workspace guidance"))),
      ),
    inspect: async (args = {}) =>
      parseJsonToolResult<FigmaWorkspaceInspectResult>(
        await handleInspect(asInspectArgs(withDefaultTitle(args, "Inspect Figma Workspace target")), runtime),
      ),
    getMetadata: async (args) =>
      executeGetMetadata(
        asGetMetadataArgs(withDefaultTitle(args, "Read Figma metadata as JSON")),
        runtime,
      ) as Promise<FigmaWorkspaceGetMetadataResult>,
    getDesignContext: async (args) =>
      executeGetDesignContext(
        asGetDesignContextArgs(withDefaultTitle(args, "Get Figma design context")),
        runtime,
      ) as Promise<FigmaWorkspaceGetDesignContextResult>,
    getMotionContext: async (args) =>
      executeGetMotionContext(
        asGetMotionContextArgs(withDefaultTitle(args, "Get Figma motion context")),
        runtime,
      ) as Promise<FigmaWorkspaceGetMotionContextResult>,
    searchDesignSystem: async (args) =>
      executeSearchDesignSystem(
        asSearchDesignSystemArgs(withDefaultTitle(args, "Search Figma design system")),
        runtime,
      ) as Promise<FigmaWorkspaceSearchDesignSystemResult>,
    getLibraries: async (args = {}) =>
      executeGetLibraries(
        asGetLibrariesArgs(withDefaultTitle(args, "Get Figma libraries")),
        runtime,
      ) as Promise<FigmaWorkspaceGetLibrariesResult>,
    getVariableDefs: async (args) =>
      executeGetVariableDefs(
        asGetVariableDefsArgs(withDefaultTitle(args, "Get Figma variable definitions")),
        runtime,
      ) as Promise<FigmaWorkspaceGetVariableDefsResult>,
    callUpstreamTool: async (args) =>
      executeCallUpstreamTool(
        asCallUpstreamToolArgs(withDefaultTitle(args, "Call upstream Figma MCP tool")),
        runtime,
      ) as Promise<FigmaWorkspaceCallUpstreamToolResult>,
    lookup: async (args) =>
      parseJsonToolResult<FigmaWorkspaceLookupResult>(
        await handleLookup(asLookupArgs(withDefaultTitle(args, "Look up Figma Workspace reference"))),
      ),
    docs: async (args) => handleDocs(asDocsArgs(args)),
    doctor: async (args = {}) => handleDoctor(asDoctorArgs(args)),
    sessionsInfo: async (args = {}) => handleSessions(asSessionsArgs(args), runtime.sessions),
    upstreamTools: async (args = {}) => handleUpstreamTools(asUpstreamToolsArgs(args), runtime.upstreamToolCache),
  };
}

function handleDocs(args: FigmaWorkspaceDocsArguments): FigmaWorkspaceDocsResult {
  if (args.mode === "list") {
    return { ok: true, mode: "list", topics: listFigmaWorkspaceProjectDocs() };
  }
  if (args.mode === "catalog") {
    const catalog = listFigmaWorkspaceCanonicalCatalog({
      taskFamily: args.taskFamily,
      surface: args.surface,
      classification: args.classification,
      limit: args.limit,
    });
    return args.taskFamily === undefined
      ? { ok: true, mode: "catalog", taskFamilies: catalog }
      : { ok: true, mode: "catalog", records: catalog };
  }
  const doc = args.id.startsWith("project:")
    ? readFigmaWorkspaceProjectDoc(args.id)
    : readFigmaWorkspaceCanonicalDoc(args.id);
  return { ok: true, mode: "read", ...doc };
}

function handleDoctor(_args: FigmaWorkspaceDoctorArguments): FigmaWorkspaceDoctorResult {
  const projectDocs = getFigmaWorkspaceProjectDocsRuntimeInfo();
  const lookup = getFigmaWorkspaceLookupRuntimeInfo();
  const typescript = getFigmaWorkspaceTypescriptRuntimeInfo();
  const ok = projectDocs.ok && lookup.ok && typescript.ok;
  return {
    ok,
    runtime: { projectDocs, lookup, typescript },
    guidance: ok
      ? ["Project docs, canonical docs corpus, generated Plugin API index, and TypeScript runtime assets are available."]
      : [
          "Compare attemptedPaths with the installed plugin cache, then rebuild or reinstall the Figma Workspace plugin if assets are missing.",
          "Reload the Codex app or CLI process after updating the plugin because runtime assets are loaded at process startup.",
        ],
  };
}

function handleSessions(
  args: FigmaWorkspaceSessionsArguments,
  sessions: FigmaWorkspaceSessionStore,
): FigmaWorkspaceSessionsResult {
  const sessionId = asOptionalString(args.sessionId);
  if (!sessionId) {
    return { ok: true, sessions: sessions.list().map(sessionDirectoryEntry) };
  }
  const session = sessions.get(sessionId);
  if (!session) {
    throw new Error(`Figma Workspace session not found: ${sessionId}`);
  }
  return {
    ok: true,
    session: sessionDetail(session, args.includeHandles === true, args.includeHistory === true),
  };
}

async function handleUpstreamTools(
  args: FigmaWorkspaceUpstreamToolsArguments,
  upstreamToolCache: ReturnType<typeof createUpstreamToolCache>,
): Promise<FigmaWorkspaceUpstreamToolsResult> {
  const name = asOptionalString(args.name);
  let tools: UpstreamToolInfo[];
  try {
    tools = await upstreamToolCache.list(args.refresh === true);
  } catch (error) {
    const upstreamError = normalizeCaughtUpstreamError(error);
    return {
      ok: false,
      upstreamError: responseUpstreamError(upstreamError),
      primaryFix: primaryFixForUpstreamError(upstreamError),
      guidance: "Retry after upstream authentication or tool discovery succeeds.",
    };
  }
  if (name) {
    const tool = tools.find((candidate) => candidate.name === name);
    if (!tool) {
      throw new Error(`Upstream Figma MCP tool not found: ${name}`);
    }
    return {
      ok: true,
      name: tool.name,
      description: tool.description,
      inputSchema: tool.inputSchema,
      guidance: "Prefer a first-class Figma Workspace command when available; use call-upstream-tool for uncovered or raw official behavior.",
    };
  }
  return {
    ok: true,
    tools: tools.map(upstreamToolDirectoryEntry),
    categories: [...UPSTREAM_TOOL_DIRECTORY_CATEGORY_ORDER],
    guidance: "Use a first-class Figma Workspace command when available; pass name for the full official inputSchema before call-upstream-tool.",
  };
}

async function handleOpen(
  args: Record<string, unknown>,
  runtime: {
    sessions: FigmaWorkspaceSessionStore;
    client?: FigmaWorkspaceUpstreamClient;
  },
): Promise<Record<string, unknown>> {
  const session = truthy(args.reset)
    ? runtime.sessions.reset(asOptionalString(args.sessionId))
    : runtime.sessions.getOrCreate(asOptionalString(args.sessionId));

  assignOptionalString(session, "label", args.label);
  applySessionFileReference(session, args.file);
  assignOptionalString(session, "currentPageId", args.currentPageId);
  const fileKey = extractFigmaFileKey(session.fileUrl);
  if (fileKey) {
    session.fileKey = fileKey;
  }
  const expectedSurface = normalizeSurface(args.surface);
  const derivedSurface = inferFigmaSurface(session.fileUrl);
  if (expectedSurface) {
    session.surface = expectedSurface;
  } else if (derivedSurface) {
    session.surface = derivedSurface;
  }
  const openDiagnostics = diagnoseFigmaWorkspaceContext({
    expectedSurface,
    derivedSurface,
    fileUrl: session.fileUrl,
  });
  session.lastDiagnostics = openDiagnostics;
  const handleChanges = isStringRecord(args.handles)
    ? updateSessionHandles(session, args.handles)
    : emptyHandleChanges();
  bindOpenWorkspaceIfAvailable(session, args);
  touchSession(session);

  if (args.connect !== false) {
    await runtime.client?.connect();
  }
  const payload = removeUndefined({
    ok: true,
    session: responseSession(session, handleChanges),
    diagnostics: diagnosticsForResponse(session.lastDiagnostics),
  }) as Record<string, unknown>;
  return makeJsonToolResult(payload);
}

async function handleEval(
  args: FigmaWorkspaceEvalArguments,
  runtime: {
    client: FigmaUpstreamMcpProxyClient;
    sessions: FigmaWorkspaceSessionStore;
    upstreamToolCache: ReturnType<typeof createUpstreamToolCache>;
  },
): Promise<Record<string, unknown>> {
  if (!args.code || typeof args.code !== "string") {
    throw new Error('Tool argument "code" is required and must be a string.');
  }
  const session = runtime.sessions.getOrCreate(args.sessionId);
  let handleChanges = isStringRecord(args.handleUpdates)
    ? updateSessionHandles(session, args.handleUpdates)
    : emptyHandleChanges();
  const mode = args.mode ?? "write";
  const expectedSurface = normalizeSurface(args.surface) ?? session.surface;
  if (expectedSurface) {
    session.surface = expectedSurface;
  }
  const diagnosticOptions: FigmaWorkspaceDiagnosticsOptions = {
    allowDangerousOperations: Boolean(args.allowDangerousOperations),
    mode,
    expectedSurface,
  };
  const preparedCode = args.typescript === true
    ? compileFigmaWorkspaceEvalCode({ code: args.code })
    : { code: args.code, diagnostics: [] };
  const hasParseError = preparedCode.diagnostics.some((diagnostic) => diagnostic.code === "FIGMA_WORKSPACE_PARSE_ERROR");
  const runtimeDiagnostics = hasParseError
    ? []
    : toFigmaWorkspaceFileDiagnostics(
      "<inline eval>",
      preparedCode.code,
      diagnoseFigmaWorkspaceCode(preparedCode.code, diagnosticOptions),
      diagnosticOptions,
    );
  const diagnostics = [...preparedCode.diagnostics, ...runtimeDiagnostics];
  session.lastDiagnostics = diagnostics;
  const fatalDiagnostics = diagnostics.filter((diagnostic) => diagnostic.severity === "fatal");
  if (fatalDiagnostics.length > 0) {
    touchSession(session);
    return makeJsonToolResult({
      ok: false,
      session: responseSession(session, handleChanges),
      diagnostics: diagnosticsForResponse(diagnostics),
      repairPlan: createFigmaWorkspaceRepairPlan(diagnostics),
    });
  }

  const evalSettings = await resolveEvalSettings(session, args as Record<string, unknown>, runtime);
  const captureRequestsAllowed = resolveFigmaWorkspaceScriptHelperSelection(preparedCode.code).helperNames.has("capture");
  const script = buildFigmaEvalScript({
    session,
    code: preparedCode.code,
    mode,
  });
  const upstream = await callUpstreamEval(runtime.client, evalSettings, script);
  const parsed = parseUpstreamToolResult(upstream);
  handleChanges = mergeHandleChanges(handleChanges, updateSessionFromParsedResult(session, parsed.json));
  const captureBatch = parsed.upstreamError
    ? { ok: true, requested: false } satisfies FigmaWorkspaceQueuedCaptureBatchResult
    : await executeQueuedCaptureRequests({
      parsedJson: parsed.json,
      session,
      runtime,
      captureRequestsAllowed,
    });
  runtime.sessions.rememberHistory(session, {
    id: randomUUID(),
    at: new Date().toISOString(),
    tool: "figma_workspace_eval",
    mode,
    summary: summarizeParsedResult(parsed),
    nodeIds: collectNodeIds(parsed.json),
  });
  const resultPayload = removeUndefined({
    ok: !parsed.upstreamError && captureBatch.ok,
    session: responseSession(session, handleChanges),
    scriptExecutionSucceeded: !parsed.upstreamError,
    captureProcessingSucceeded: captureBatch.requested ? captureBatch.ok : undefined,
    retryGuidance: !captureBatch.ok ? QUEUED_CAPTURE_FAILURE_RETRY_GUIDANCE : undefined,
    captures: captureBatch.captures,
    diagnostics: diagnosticsForResponse(diagnostics),
    repairPlan: repairPlanForResponse(diagnostics),
    ...upstreamResultFields({
      parsed,
      upstream,
    }),
    ...upstreamFailureFields(parsed),
  }) as Record<string, unknown>;
  const inlineResultLimit = normalizeInlineResultLimit(args.inlineResultLimit ?? DEFAULT_INLINE_RESULT_LIMIT);
  return makeJsonToolResult(await shapeUpstreamBackedResponse({
    contract: DEFAULT_EVAL_CONTRACT,
    parsed,
    resultPayload,
    inlineResultLimit: args.inlineResultLimit,
    forceOutputFile: !captureBatch.ok,
    writeOutputFiles: (upstreamEnvelopePayload) => writeEvalResultFiles({
      session,
      resultPayload,
      upstream: upstreamEnvelopePayload,
    }),
  }));
}

async function handleRunScriptFile(
  args: FigmaWorkspaceRunScriptFileArguments,
  runtime: FigmaWorkspaceRuntime,
): Promise<Record<string, unknown>> {
  return makeJsonToolResult(await executeRunScriptFile(args, runtime));
}

async function writeEvalResultFiles(options: {
  session: FigmaWorkspaceSession;
  resultPayload: Record<string, unknown>;
  upstream: Record<string, unknown>;
}): Promise<FigmaWorkspaceOutputFiles> {
  const outputFile = resolveEvalOutputFile(options.session);
  const outputFiles: FigmaWorkspaceOutputFiles = {
    debugFile: responseFilePointer(await writeJsonFile(
      outputFile,
      createUpstreamBackedResultFilePayload({
        tool: "figma_workspace_eval",
        session: options.session,
        resultPayload: options.resultPayload,
        upstream: options.upstream,
        fields: {
          diagnosticsCount: countArrayField(options.resultPayload.diagnostics),
          repairPlan: options.resultPayload.repairPlan,
          scriptExecutionSucceeded: options.resultPayload.scriptExecutionSucceeded,
          captureProcessingSucceeded: options.resultPayload.captureProcessingSucceeded,
          retryGuidance: options.resultPayload.retryGuidance,
          captures: options.resultPayload.captures,
        },
      }),
    )),
  };
  outputFiles.upstreamFile = responseFilePointer(await writeJsonFile(upstreamFilePathForResultFile(outputFile), options.upstream));
  return outputFiles;
}

function resolveEvalOutputFile(session: FigmaWorkspaceSession): string {
  const fileName = `eval-${new Date().toISOString().replace(/[^\dTZ]/gu, "")}.result.json`;
  if (session.workspace) {
    return resolveWorkspaceFile(session.workspace.sessionDir, fileName, "debugFile");
  }
  const root = defaultTaskWorkspaceRoot();
  if (!isAbsolute(root)) {
    throw new Error(`Tool argument "taskRoot" and ${TASK_WORKSPACE_ROOT_ENV} must be absolute paths when provided.`);
  }
  return resolve(root, "eval-results", session.slug, fileName);
}

async function writeCallUpstreamResultFiles(options: {
  toolName: string;
  wrapperToolName: string;
  session: FigmaWorkspaceSession;
  resultPayload: Record<string, unknown>;
  upstream: Record<string, unknown>;
}): Promise<FigmaWorkspaceOutputFiles> {
  const outputFile = resolveCallUpstreamOutputFile(options.toolName, options.session);
  const outputFiles: FigmaWorkspaceOutputFiles = {
    debugFile: responseFilePointer(await writeJsonFile(
      outputFile,
      createUpstreamBackedResultFilePayload({
        tool: options.wrapperToolName,
        session: options.session,
        resultPayload: options.resultPayload,
        upstream: options.upstream,
        fields: {
          upstreamToolName: options.toolName,
        },
      }),
    )),
  };
  outputFiles.upstreamFile = responseFilePointer(await writeJsonFile(upstreamFilePathForResultFile(outputFile), options.upstream));
  return outputFiles;
}

async function writeMetadataFile(options: {
  args: FigmaWorkspaceGetMetadataArguments;
  session: FigmaWorkspaceSession;
  metadata: FigmaWorkspaceMetadataJson;
}): Promise<FigmaWorkspaceFilePointer> {
  const metadataFile = metadataResultFilePath(options.session);
  return responseFilePointer(await writeJsonFile(metadataFile, options.metadata));
}

function metadataResultFilePath(session: FigmaWorkspaceSession): string {
  const timestamp = new Date().toISOString().replace(/[^\dTZ]/gu, "");
  const fileName = `metadata-${timestamp}.metadata.json`;
  if (session.workspace) {
    return resolveWorkspaceFile(session.workspace.sessionDir, fileName, "metadataFile");
  }
  const root = defaultTaskWorkspaceRoot();
  if (!isAbsolute(root)) {
    throw new Error(`Tool argument "taskRoot" and ${TASK_WORKSPACE_ROOT_ENV} must be absolute paths when provided.`);
  }
  return resolve(root, "metadata-results", session.slug, fileName);
}

function resolveCallUpstreamOutputFile(toolName: string, session: FigmaWorkspaceSession): string {
  const timestamp = new Date().toISOString().replace(/[^\dTZ]/gu, "");
  const fileName = `upstream-${slugifyTaskName(toolName || "tool")}-${timestamp}.result.json`;
  if (session.workspace) {
    return resolveWorkspaceFile(session.workspace.sessionDir, fileName, "debugFile");
  }
  const root = defaultTaskWorkspaceRoot();
  if (!isAbsolute(root)) {
    throw new Error(`Tool argument "taskRoot" and ${TASK_WORKSPACE_ROOT_ENV} must be absolute paths when provided.`);
  }
  return resolve(root, "upstream-results", session.slug, fileName);
}

function upstreamFilePathForResultFile(resultFile: string): string {
  if (resultFile.endsWith(".result.json")) {
    return `${resultFile.slice(0, -".result.json".length)}.upstream.json`;
  }
  if (resultFile.endsWith(".json")) {
    return `${resultFile.slice(0, -".json".length)}.upstream.json`;
  }
  return `${resultFile}.upstream.json`;
}

async function addUpstreamSidecar(
  outputFiles: object,
  resultFile: string | undefined,
  upstream: Record<string, unknown> | undefined,
): Promise<Record<string, unknown>> {
  if (!resultFile || !upstream) {
    return { ...outputFiles };
  }
  return {
    ...outputFiles,
    upstreamFile: responseFilePointer(await writeJsonFile(upstreamFilePathForResultFile(resultFile), upstream)),
  };
}

function responseFilePointer(pointer: { path: string; bytes: number; lineCount: number }): FigmaWorkspaceFilePointer {
  return {
    path: pointer.path,
    bytes: pointer.bytes,
    lineCount: pointer.lineCount,
  };
}

function createResultFileEnvelope(options: {
  tool: string;
  session: FigmaWorkspaceSession;
  ok: boolean;
  fields?: Record<string, unknown>;
}): Record<string, unknown> {
  return removeUndefined({
    kind: "figma_workspace_result",
    ok: options.ok,
    tool: options.tool,
    sessionId: options.session.id,
    generatedAt: new Date().toISOString(),
    ...options.fields,
  }) as Record<string, unknown>;
}

function createUpstreamBackedResultFilePayload(options: {
  tool: string;
  session: FigmaWorkspaceSession;
  resultPayload: Record<string, unknown>;
  upstream?: Record<string, unknown>;
  fields?: Record<string, unknown>;
}): Record<string, unknown> {
  return createResultFileEnvelope({
    tool: options.tool,
    session: options.session,
    ok: options.resultPayload.ok !== false,
    fields: {
      ...options.fields,
      upstreamKind: asOptionalString(options.upstream?.kind),
      upstreamOk: typeof options.upstream?.ok === "boolean" ? options.upstream.ok : undefined,
      upstreamError: isRecord(options.resultPayload.upstreamError) ? options.resultPayload.upstreamError : undefined,
    },
  });
}

function createRunScriptResultFilePayload(options: {
  session: FigmaWorkspaceSession;
  resultPayload: Record<string, unknown>;
  diagnostics: FigmaWorkspaceDiagnostic[];
  parsed?: ParsedUpstreamToolResult;
  upstream?: Record<string, unknown>;
}): Record<string, unknown> {
  const script = asRecord(options.resultPayload.script);
  return createUpstreamBackedResultFilePayload({
    tool: "figma_workspace_run_script_file",
    session: options.session,
    resultPayload: options.resultPayload,
    upstream: options.upstream,
    fields: {
      phase: asOptionalString(options.resultPayload.phase),
      executed: options.resultPayload.executed === true,
      diagnosticsCount: options.diagnostics.length,
      fatalDiagnostics: options.diagnostics.filter((item) => item.severity === "fatal").length,
      warningDiagnostics: options.diagnostics.filter((item) => item.severity === "warning").length,
      diagnostics: options.diagnostics.length > 0 ? options.diagnostics : undefined,
      repairPlan: options.resultPayload.repairPlan,
      script,
      scriptExecutionSucceeded: options.resultPayload.scriptExecutionSucceeded,
      captureProcessingSucceeded: options.resultPayload.captureProcessingSucceeded,
      retryGuidance: options.resultPayload.retryGuidance,
      captures: options.resultPayload.captures,
      resultSummary: options.parsed ? summarizeParsedResult(options.parsed) : undefined,
      nodeIds: options.parsed ? collectNodeIds(options.parsed.json) : undefined,
    },
  });
}

function countArrayField(value: unknown): number {
  return Array.isArray(value) ? value.length : 0;
}

async function executeRunScriptFile(
  args: FigmaWorkspaceRunScriptFileArguments,
  runtime: {
    client: FigmaUpstreamMcpProxyClient;
    sessions: FigmaWorkspaceSessionStore;
    upstreamToolCache: ReturnType<typeof createUpstreamToolCache>;
  },
): Promise<Record<string, unknown>> {
  const session = runtime.sessions.getOrCreate(args.sessionId);
  const scriptPath = resolveScriptInputPath(args, session);
  const outputWriter = createScriptOutputWriter(args, session);
  await outputWriter.cleanupCompiledScriptFile();
  const inlineResultLimit = normalizeInlineResultLimit(args.inlineResultLimit ?? DEFAULT_INLINE_RESULT_LIMIT);
  let source: string;
  try {
    source = await readFile(scriptPath, "utf8");
  } catch (error) {
    if (!isMissingFileError(error)) {
      throw error;
    }
    const diagnostics: FigmaWorkspaceFileDiagnostic[] = [
      {
        code: "FIGMA_WORKSPACE_INPUT_FILE_MISSING",
        severity: "fatal",
        message: `Figma Workspace script file was not found: ${scriptPath}`,
        suggestion: "Create the workspace script file or rerun prepare-task with overwrite=true before running it.",
        docsHint: "Use prepare-task to create the .figma.ts file, then run run-script-file with that inputFile.",
        source: { scriptPath },
      },
    ];
    session.lastDiagnostics = diagnostics;
    touchSession(session);
    const resultPayload = removeUndefined({
      ok: false,
      phase: "preflight",
      executed: false,
      session: responseSession(session),
      diagnostics: diagnosticsForResponse(diagnostics),
      repairPlan: repairPlanForResponse(diagnostics),
      script: responseScriptMetadata({ scriptPath }),
    }) as Record<string, unknown>;
    const outputFiles = await outputWriter.write({
      result: createRunScriptResultFilePayload({
        session,
        resultPayload,
        diagnostics,
      }),
      writeResult: true,
    });
    return {
      ...limitInlineScriptResult(resultPayload, inlineResultLimit, []),
      outputFiles: Object.keys(outputFiles).length > 0 ? outputFiles : undefined,
    };
  }
  const expectedSurface = normalizeSurface(args.surface) ?? session.surface;
  if (expectedSurface) {
    session.surface = expectedSurface;
  }
  if (typeof args.targetPageId === "string" && args.targetPageId.length > 0) {
    session.currentPageId = args.targetPageId;
  }

  const compiled = compileFigmaWorkspaceScriptFile({
    scriptPath,
    source,
    targetPageId: args.targetPageId,
    expectedSurface,
    allowDangerousOperations: Boolean(args.allowDangerousOperations),
    strict: Boolean(args.strict),
  });
  const wrappedScript = buildFigmaEvalScript({
    session,
    code: compiled.code,
    mode: "write",
    includeEvalHelpers: false,
    scriptInjectedHelpers: compiled.metadata.injectedHelpers,
  });
  const diagnostics = [
    ...compiled.diagnostics,
    ...diagnoseWrappedScriptSize(scriptPath, wrappedScript, Boolean(args.strict)),
  ];
  session.lastDiagnostics = diagnostics;
  const scriptMetadata = {
    ...compiled.metadata,
    compiledScriptBytes: Buffer.byteLength(wrappedScript, "utf8"),
  };
  const responseScript = responseScriptMetadata(scriptMetadata);
  const successScript = responseRunScriptSuccessMetadata(args);
  const fatalDiagnostics = diagnostics.filter((diagnostic) => diagnostic.severity === "fatal");

  if (fatalDiagnostics.length > 0) {
    touchSession(session);
    const resultPayload = removeUndefined({
      ok: false,
      phase: "preflight",
      executed: false,
      session: responseSession(session),
      diagnostics: diagnosticsForResponse(diagnostics),
      repairPlan: repairPlanForResponse(diagnostics),
      script: responseScript,
    }) as Record<string, unknown>;
    const limitedPayload = limitInlineScriptResult(resultPayload, inlineResultLimit, []);
    const outputFiles = await outputWriter.write({
      result: createRunScriptResultFilePayload({
        session,
        resultPayload,
        diagnostics,
      }),
      writeResult: true,
    });
    const payload = {
      ...limitedPayload,
      outputFiles: Object.keys(outputFiles).length > 0 ? outputFiles : undefined,
    };
    return payload;
  }

  const evalSettings = await resolveEvalSettings(session, args as Record<string, unknown>, runtime);
  let upstream: unknown;
  let parsed: ParsedUpstreamToolResult;
  try {
    upstream = await callUpstreamEval(runtime.client, evalSettings, wrappedScript);
    parsed = parseUpstreamToolResult(upstream);
  } catch (error) {
    const upstreamError = normalizeCaughtUpstreamError(error);
    const resultPayload = removeUndefined({
      ok: false,
      phase: "execute",
      executed: true,
      session: responseSession(session),
      diagnostics: diagnosticsForResponse(diagnostics),
      repairPlan: repairPlanForResponse(diagnostics),
      script: responseScript,
      upstreamError: responseUpstreamError(upstreamError),
    }) as Record<string, unknown>;
    const outputFiles = await outputWriter.write({
      result: createRunScriptResultFilePayload({
        session,
        resultPayload,
        diagnostics,
      }),
      compiledScript: wrappedScript,
      writeResult: true,
    });
    const nonEmptyOutputFiles = Object.keys(outputFiles).length > 0 ? outputFiles : undefined;
    const payload = {
      ...limitInlineScriptResult(
        {
          ...resultPayload,
          outputFiles: nonEmptyOutputFiles,
        },
        inlineResultLimit,
        [],
      ),
    };
    return payload;
  }
  if (parsed.upstreamError) {
    const upstreamResult = upstreamEnvelope(parsed);
    const resultPayload = removeUndefined({
      ok: false,
      phase: "execute",
      executed: true,
      session: responseSession(session),
      diagnostics: diagnosticsForResponse(diagnostics),
      repairPlan: repairPlanForResponse(diagnostics),
      script: responseScript,
      ...runScriptUpstreamFields(parsed),
      ...runScriptUpstreamFailureFields(parsed),
    }) as Record<string, unknown>;
    const outputFiles = await addUpstreamSidecar(
      await outputWriter.write({
        result: createRunScriptResultFilePayload({
        session,
        resultPayload,
        diagnostics,
        parsed,
        upstream: upstreamResult,
      }),
        compiledScript: wrappedScript,
        writeResult: true,
      }),
      outputWriter.files.resultFile,
      upstreamResult,
    );
    const nonEmptyOutputFiles = Object.keys(outputFiles).length > 0 ? outputFiles : undefined;
    const payload = {
      ...limitInlineScriptResult(
        {
          ...resultPayload,
          outputFiles: nonEmptyOutputFiles,
        },
        inlineResultLimit,
        ["upstream.result", "upstream.text"],
      ),
    };
    return payload;
  }
  const handleChanges = updateSessionFromParsedResult(session, parsed.json);
  const captureBatch = await executeQueuedCaptureRequests({
    parsedJson: parsed.json,
    session,
    runtime,
    captureRequestsAllowed: compiled.metadata.injectedHelpers.includes("$.capture"),
  });
  runtime.sessions.rememberHistory(session, {
    id: randomUUID(),
    at: new Date().toISOString(),
    tool: "figma_workspace_run_script_file",
    mode: "write",
    summary: `Ran Figma script file ${scriptPath}.`,
    nodeIds: collectNodeIds(parsed.json),
  });

  const resultPayload = removeUndefined({
    ok: captureBatch.ok,
    phase: "execute",
    executed: true,
    session: responseSession(session, handleChanges),
    scriptExecutionSucceeded: true,
    captureProcessingSucceeded: captureBatch.requested ? captureBatch.ok : undefined,
    retryGuidance: !captureBatch.ok ? QUEUED_CAPTURE_FAILURE_RETRY_GUIDANCE : undefined,
    captures: captureBatch.captures,
    diagnostics: optionalDiagnosticsForResponse(diagnostics),
    repairPlan: repairPlanForResponse(diagnostics),
    script: successScript,
    ...runScriptUpstreamFields(parsed),
  }) as Record<string, unknown>;
  const upstreamResult = upstreamEnvelope(parsed);
  const limitedPayload = limitInlineScriptResult(
    resultPayload,
    inlineResultLimit,
    ["upstream.result", "upstream.text"],
  );
  const needsOutputFile = diagnostics.length > 0 || !captureBatch.ok || isRecord(limitedPayload.inlineResultLimit);
  const outputFiles = needsOutputFile
    ? await addUpstreamSidecar(await outputWriter.write({
      result: createRunScriptResultFilePayload({
        session,
        resultPayload,
        diagnostics,
        parsed,
        upstream: upstreamResult,
      }),
      writeResult: true,
    }), outputWriter.files.resultFile, upstreamResult)
    : await outputWriter.write({
      result: createRunScriptResultFilePayload({
        session,
        resultPayload,
        diagnostics,
        parsed,
        upstream: upstreamResult,
      }),
      writeResult: false,
    });
  const payload = {
    ...limitedPayload,
    outputFiles: Object.keys(outputFiles).length > 0 ? outputFiles : undefined,
  };
  return payload;
}

async function handleApplyAssetManifest(
  args: FigmaWorkspaceApplyAssetManifestArguments,
  runtime: FigmaWorkspaceRuntime,
): Promise<Record<string, unknown>> {
  return makeJsonToolResult(await executeApplyAssetManifest(args, runtime));
}

async function executeApplyAssetManifest(
  args: FigmaWorkspaceApplyAssetManifestArguments,
  runtime: FigmaWorkspaceRuntime,
): Promise<Record<string, unknown>> {
  const session = runtime.sessions.getOrCreate(args.sessionId);
  let manifest: NormalizedAssetManifest;
  try {
    manifest = await loadAssetManifest(args, session);
  } catch (error) {
    if (error instanceof AssetManifestLoadError) {
      const diagnostics = [assetManifestLoadDiagnostic(error)];
      session.lastDiagnostics = diagnostics;
      return {
        ok: false,
        session: responseSession(session),
        assets: [],
        diagnostics: diagnosticsForResponse(diagnostics),
        failures: [{
          reason: "manifest-load-failed",
          manifestPath: error.manifestPath,
          message: error.message,
        }],
      };
    }
    throw error;
  }
  const tools = await runtime.upstreamToolCache.list(false);
  const uploadKind = requireWrapperUpstreamKind(APPLY_ASSET_MANIFEST_CONTRACT);
  const tool = selectRequiredUpstreamTool(tools, UPLOAD_ASSETS_TOOL_NAME, uploadKind);
  assertUpstreamToolHasProperties(tool, [...(APPLY_ASSET_MANIFEST_CONTRACT.requiredUpstreamProperties ?? [])], uploadKind);
  const failures: Array<Record<string, unknown>> = [];
  const assetResults: Array<Record<string, unknown>> = [];
  const assetDetails: Array<Record<string, unknown>> = [];
  await runtime.client.connect();

  for (const asset of manifest.assets) {
    const upstreamArguments = buildAssetManifestUpstreamArguments({
      asset,
      tool,
    });
    const startedAt = new Date().toISOString();
    try {
      const upstream = await runtime.client.callTool(tool.name, upstreamArguments);
      const parsed = parseUpstreamToolResult(upstream);
      const upstreamError = parsed.upstreamError ? responseUpstreamError(parsed.upstreamError) : undefined;
      const upload = parsed.upstreamError
        ? undefined
        : await submitLocalAssetUploadIfAvailable(asset, parsed);
      const ok = !parsed.upstreamError && upload?.ok !== false;
      const uploadSummary = compactUploadSummary(upload);
      const entry = {
        ok,
        path: asset.path,
        targetNodeId: asset.targetNodeId,
        handle: asset.handle,
        name: asset.name,
        upload: uploadSummary,
        upstreamError,
      };
      const detail = {
        ...entry,
        toolName: tool.name,
        upload,
        metadata: asset.metadata,
        arguments: upstreamArguments,
        upstream: upstreamEnvelope(parsed),
        upstreamError,
        primaryFix: parsed.primaryFix,
        startedAt,
        finishedAt: new Date().toISOString(),
      };
      assetResults.push(entry);
      assetDetails.push(detail);
      if (!ok) {
        failures.push({
          path: asset.path,
          targetNodeId: asset.targetNodeId,
          handle: asset.handle,
          upstreamError,
        });
      }
    } catch (error) {
      const upstreamError = normalizeCaughtUpstreamError(error);
      const responseError = responseUpstreamError(upstreamError);
      const entry = {
        ok: false,
        path: asset.path,
        targetNodeId: asset.targetNodeId,
        handle: asset.handle,
        name: asset.name,
        upstreamError: responseError,
      };
      const detail = {
        ...entry,
        toolName: tool.name,
        metadata: asset.metadata,
        arguments: upstreamArguments,
        upstreamError: responseError,
        primaryFix: primaryFixForUpstreamError(upstreamError),
        startedAt,
        finishedAt: new Date().toISOString(),
      };
      assetResults.push(entry);
      assetDetails.push(detail);
      failures.push({
        path: asset.path,
        targetNodeId: asset.targetNodeId,
        handle: asset.handle,
        upstreamError: responseError,
      });
    }
  }

  const files: Record<string, unknown> = {};
  const application = await applyUploadedAssetFillsIfAvailable({
    session,
    runtime,
    tools,
    assetResults,
    assetDetails,
  });
  const validation = await validateAssetManifestTargetsIfAvailable({
    args,
    session,
    runtime,
    tools,
    assetResults,
  });
  const validationIndeterminate = isAssetManifestValidationIndeterminate(validation);
  const ok = failures.length === 0 && application.ok !== false && validation.ok !== false && !validationIndeterminate;
  for (const detail of assetDetails) {
    const targetNodeId = asOptionalString(detail.targetNodeId);
    const asset = assetResults.find((item) => item.targetNodeId === targetNodeId);
    if (asset?.validation !== undefined) {
      detail.validation = asset.validation;
    }
    if (asset?.application !== undefined) {
      detail.application = asset.application;
    }
  }
  const payload = {
    ok,
    session: responseSession(session),
    assets: assetResults,
    application,
    validation,
    failures: failures.length > 0 ? failures : undefined,
  };
  if (!ok) {
    files.debugFile = responseFilePointer(await writeJsonFile(resolveAssetManifestDebugFile(args, session), createResultFileEnvelope({
      tool: "figma_workspace_apply_asset_manifest",
      session,
      ok,
      fields: {
        assetCount: assetResults.length,
        failureCount: failures.length,
        applicationOk: application.ok,
        applicationReason: application.reason,
        applicationSource: application.applicationSource,
        validationOk: validation.ok,
        validationReason: validation.reason,
        validationSource: validation.validationSource,
        validationExpectedCount: validation.expectedCount,
        validationMissingCount: validation.missingValidationCount,
        failures: failures.length > 0 ? failures : undefined,
        assetDetails,
      },
    })));
  }
  runtime.sessions.rememberHistory(session, {
    id: randomUUID(),
    at: new Date().toISOString(),
    tool: "figma_workspace_apply_asset_manifest",
    mode: "upstream-assets",
    summary: `Applied ${assetResults.length} asset manifest entries with ${failures.length} failures.`,
    nodeIds: assetResults
      .map((asset) => asOptionalString(asset.targetNodeId))
      .filter((nodeId): nodeId is string => nodeId !== undefined),
  });
  const response = {
    ...payload,
    outputFiles: Object.keys(files).length > 0 ? files : undefined,
  };
  return response;
}

function isAssetManifestValidationIndeterminate(validation: Record<string, unknown>): boolean {
  if (validation.skipped === true) {
    return false;
  }
  return validation.ok === undefined && Number(validation.expectedCount ?? 0) > 0;
}

function resolveAssetManifestDebugFile(args: FigmaWorkspaceApplyAssetManifestArguments, session: FigmaWorkspaceSession): string {
  const slug = "asset-manifest";
  const fileName = `${slug}.assets.result.json`;
  if (session.workspace) {
    return resolveWorkspaceFile(session.workspace.sessionDir, fileName, "debugFile");
  }
  const root = defaultTaskWorkspaceRoot();
  if (!isAbsolute(root)) {
    throw new Error(`Tool argument "taskRoot" and ${TASK_WORKSPACE_ROOT_ENV} must be absolute paths when provided.`);
  }
  return resolve(root, "asset-results", session.slug, fileName);
}

function compactUploadSummary(upload: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
  if (!upload) {
    return undefined;
  }
  return removeUndefined({
    ok: upload.ok,
    status: upload.status,
    statusText: upload.statusText,
    mimeType: upload.mimeType,
    bytes: upload.bytes,
    response: compactUploadResponse(upload.response),
  }) as Record<string, unknown>;
}

function compactUploadResponse(response: unknown): unknown {
  if (!isRecord(response)) {
    return response;
  }
  return removeUndefined({
    success: response.success,
    imageHash: response.imageHash,
    sizeBytes: response.sizeBytes,
    contentType: response.contentType,
    placedOnNodeId: response.placedOnNodeId,
    nodeId: response.nodeId,
    targetNodeId: response.targetNodeId,
  }) as Record<string, unknown>;
}

async function handleDownloadAssets(
  args: FigmaWorkspaceDownloadAssetsArguments,
  runtime: FigmaWorkspaceRuntime,
): Promise<Record<string, unknown>> {
  return makeJsonToolResult(await executeDownloadAssets(args, runtime));
}

async function executeDownloadAssets(
  args: FigmaWorkspaceDownloadAssetsArguments,
  runtime: FigmaWorkspaceRuntime,
): Promise<Record<string, unknown>> {
  const session = runtime.sessions.getOrCreate(args.sessionId);
  const manifest = await loadDownloadAssetsManifest(args, session);
  const paths = resolveDownloadAssetsOutputPaths(args, session);
  const tools = await runtime.upstreamToolCache.list(false);
  const downloadKind = requireWrapperUpstreamKind(DOWNLOAD_ASSETS_CONTRACT);
  const tool = selectRequiredUpstreamTool(tools, DOWNLOAD_ASSETS_TOOL_NAME, downloadKind);
  assertUpstreamToolHasProperties(tool, [...(DOWNLOAD_ASSETS_CONTRACT.requiredUpstreamProperties ?? [])], downloadKind);
  const targetResults: Array<Record<string, unknown>> = [];
  const targetDetails: Array<Record<string, unknown>> = [];
  const failures: Array<Record<string, unknown>> = [];
  const diagnostics: FigmaWorkspaceDiagnostic[] = [];
  const usedSlugs = new Set<string>();
  await runtime.client.connect();

  for (const [index, target] of manifest.targets.entries()) {
    const startedAt = new Date().toISOString();
    const targetSlug = uniqueDownloadTargetSlug(target, index, usedSlugs);
    const targetOutputDir = resolve(paths.outputDir, targetSlug);
    const passthrough = collectContractPassthroughArguments({
      args: target,
      contract: DOWNLOAD_ASSETS_CONTRACT,
    });
    const filtered = filterAdvertisedUpstreamArguments({
      upstreamArguments: buildDownloadAssetsUpstreamArguments(target, passthrough),
      contract: DOWNLOAD_ASSETS_CONTRACT,
      tool,
      upstreamKind: downloadKind,
    });
    diagnostics.push(...filtered.diagnostics);
    const upstreamArguments = filtered.arguments;
    try {
      const upstream = await runtime.client.callTool(tool.name, upstreamArguments);
      const parsed = parseUpstreamToolResult(upstream);
      const upstreamError = parsed.upstreamError ? responseUpstreamError(parsed.upstreamError) : undefined;
      const links = parsed.upstreamError ? [] : collectDownloadAssetLinks(parsed.json);
      const downloadedFiles = parsed.upstreamError
        ? []
        : await downloadAssetLinks(links, targetOutputDir);
      const downloadFailures = downloadedFiles.filter((file) => file.ok === false);
      const ok = !parsed.upstreamError && links.length > 0 && downloadFailures.length === 0;
      const downloadError = downloadFailures[0]?.error
        ? responseUpstreamError(normalizeCaughtUpstreamError(downloadFailures[0].error))
        : links.length === 0 && !parsed.upstreamError
          ? { message: "Upstream download_assets returned no downloadable URLs." }
          : undefined;
      const entry = removeUndefined({
        ok,
        targetNodeId: target.targetNodeId,
        handle: target.handle,
        name: target.name,
        outputDir: targetOutputDir,
        downloadedFiles: compactDownloadedFiles(downloadedFiles),
        upstreamError,
        downloadError,
      }) as Record<string, unknown>;
      const detail = removeUndefined({
        ...entry,
        toolName: tool.name,
        arguments: upstreamArguments,
        links,
        downloadedFiles,
        upstream: upstreamEnvelope(parsed),
        upstreamError,
        primaryFix: parsed.primaryFix,
        startedAt,
        finishedAt: new Date().toISOString(),
      }) as Record<string, unknown>;
      targetResults.push(entry);
      targetDetails.push(detail);
      if (!ok) {
        failures.push(removeUndefined({
          targetNodeId: target.targetNodeId,
          handle: target.handle,
          name: target.name,
          outputDir: targetOutputDir,
          upstreamError,
          downloadError: downloadError ?? {
            message: "One or more asset downloads failed.",
          },
        }) as Record<string, unknown>);
      }
    } catch (error) {
      const upstreamError = normalizeCaughtUpstreamError(error);
      const responseError = responseUpstreamError(upstreamError);
      const entry = removeUndefined({
        ok: false,
        targetNodeId: target.targetNodeId,
        handle: target.handle,
        name: target.name,
        outputDir: targetOutputDir,
        downloadedFiles: [],
        upstreamError: responseError,
      }) as Record<string, unknown>;
      const detail = removeUndefined({
        ...entry,
        toolName: tool.name,
        arguments: upstreamArguments,
        upstreamError: responseError,
        primaryFix: primaryFixForUpstreamError(upstreamError),
        startedAt,
        finishedAt: new Date().toISOString(),
      }) as Record<string, unknown>;
      targetResults.push(entry);
      targetDetails.push(detail);
      failures.push(removeUndefined({
        targetNodeId: target.targetNodeId,
        handle: target.handle,
        name: target.name,
        outputDir: targetOutputDir,
        upstreamError: responseError,
      }) as Record<string, unknown>);
    }
  }

  const ok = failures.length === 0;
  const payload = removeUndefined({
    ok,
    session: responseSession(session),
    outputDir: paths.outputDir,
    targets: targetResults,
    diagnostics: diagnostics.length > 0 ? diagnosticsForResponse(dedupeDiagnostics(diagnostics)) : undefined,
    failures: failures.length > 0 ? failures : undefined,
  }) as Record<string, unknown>;
  const outputFiles: FigmaWorkspaceOutputFiles = {};
  if (!ok) {
    outputFiles.debugFile = responseFilePointer(await writeJsonFile(paths.resultFile, createResultFileEnvelope({
      tool: "figma_workspace_download_assets",
      session,
      ok,
      fields: {
        upstreamToolName: tool.name,
        targetCount: targetResults.length,
        failureCount: failures.length,
        failures: failures.length > 0 ? failures : undefined,
        targetDetails,
      },
    })));
  }
  runtime.sessions.rememberHistory(session, {
    id: randomUUID(),
    at: new Date().toISOString(),
    tool: "figma_workspace_download_assets",
    mode: "download-assets",
    summary: `Downloaded assets for ${targetResults.length} target(s) with ${failures.length} failures.`,
    nodeIds: manifest.targets.map((target) => target.targetNodeId),
  });
  const response = {
    ...payload,
    outputFiles: Object.keys(outputFiles).length > 0 ? outputFiles : undefined,
  };
  return response;
}

async function loadDownloadAssetsManifest(
  args: FigmaWorkspaceDownloadAssetsArguments,
  session: FigmaWorkspaceSession,
): Promise<NormalizedDownloadAssetsManifest> {
  const inlineTargets = Array.isArray(args.targets) ? args.targets : undefined;
  const manifestPath = resolveWorkspaceAwareFile(args.manifestPath, session, "manifestPath");
  if (inlineTargets && manifestPath) {
    throw new Error('Pass either "targets" or "manifestPath", not both.');
  }
  const manifestValue = manifestPath
    ? JSON.parse(await readFile(manifestPath, "utf8"))
    : undefined;
  const manifestRecord = asRecord(manifestValue);
  if (manifestRecord.assets !== undefined) {
    throw new Error('Download manifest field "assets" is not supported. Use "targets".');
  }
  const rawTargets = inlineTargets ?? (Array.isArray(manifestRecord.targets) ? manifestRecord.targets : undefined);
  if (!rawTargets || rawTargets.length === 0) {
    throw new Error('Tool argument "targets" or "manifestPath" with targets is required.');
  }
  return {
    targets: rawTargets.map((target, index) => normalizeDownloadAssetTarget(target, index, session)),
  };
}

function normalizeDownloadAssetTarget(
  value: FigmaWorkspaceDownloadAssetsTarget | unknown,
  index: number,
  session: FigmaWorkspaceSession,
): NormalizedDownloadAssetsTarget {
  const record = asRecord(value);
  const targetResolution = resolveSessionTargetInput(record.target, session);
  const targetNodeId = targetResolution.nodeId;
  if (!targetNodeId) {
    throw new Error(`Download target ${index} requires target.`);
  }
  const fileKey = session.fileKey ?? extractFigmaFileKey(session.fileUrl) ?? extractFigmaFileKeyFromTargetInput(record.target);
  if (!fileKey) {
    throw new Error(`Download target ${index} requires a session fileKey. Call open or prepare-task with a Figma file URL first.`);
  }
  const defaultFormat = asOptionalDownloadAssetFormat(record.defaultFormat);
  const defaultScale = typeof record.defaultScale === "number" && Number.isFinite(record.defaultScale)
    ? record.defaultScale
    : undefined;
  return {
    targetNodeId,
    handle: targetResolution.handle,
    fileKey,
    name: asOptionalString(record.name),
    defaultFormat,
    defaultScale,
  };
}

function asOptionalDownloadAssetFormat(value: unknown): NormalizedDownloadAssetsTarget["defaultFormat"] {
  if (value === "png" || value === "jpg" || value === "svg" || value === "pdf") {
    return value;
  }
  return undefined;
}

function extractFigmaFileKeyFromTargetInput(input: unknown): string | undefined {
  if (isRecord(input)) {
    return extractFigmaFileKeyFromTargetInput(input.url)
      ?? extractFigmaFileKeyFromTargetInput(input.nodeUrl)
      ?? extractFigmaFileKeyFromTargetInput(input.target);
  }
  return extractFigmaFileKey(asOptionalString(input));
}

function resolveDownloadAssetsOutputPaths(
  args: FigmaWorkspaceDownloadAssetsArguments,
  session: FigmaWorkspaceSession,
): { outputDir: string; resultFile: string } {
  const slug = "download-assets";
  const explicitOutputDir = resolveWorkspaceAwareFile(args.outputDir, session, "outputDir");
  let outputDir = explicitOutputDir;
  if (!outputDir) {
    outputDir = session.workspace
      ? resolveWorkspaceFile(session.workspace.sessionDir, `${slug}.downloads`, "outputDir")
      : resolveDownloadAssetsTempPath(session, `${slug}.downloads`);
  }
  const resultFile = session.workspace
    ? resolveWorkspaceFile(session.workspace.sessionDir, `${slug}.downloads.result.json`, "debugFile")
    : resolveDownloadAssetsTempPath(session, `${slug}.downloads.result.json`);
  return { outputDir, resultFile };
}

function resolveDownloadAssetsTempPath(session: FigmaWorkspaceSession, fileName: string): string {
  const root = defaultTaskWorkspaceRoot();
  if (!isAbsolute(root)) {
    throw new Error(`Tool argument "taskRoot" and ${TASK_WORKSPACE_ROOT_ENV} must be absolute paths when provided.`);
  }
  return resolve(root, "download-results", session.slug, fileName);
}

function buildDownloadAssetsUpstreamArguments(
  target: NormalizedDownloadAssetsTarget,
  passthroughArguments: Record<string, unknown>,
): Record<string, unknown> {
  return removeUndefined({
    fileKey: target.fileKey,
    nodeId: target.targetNodeId,
    ...passthroughArguments,
  }) as Record<string, unknown>;
}

function uniqueDownloadTargetSlug(
  target: NormalizedDownloadAssetsTarget,
  index: number,
  used: Set<string>,
): string {
  const base = slugifyTaskName(target.name || target.handle || target.targetNodeId || `target-${index + 1}`);
  let candidate = base || `target-${index + 1}`;
  let suffix = 2;
  while (used.has(candidate)) {
    candidate = `${base}-${suffix}`;
    suffix += 1;
  }
  used.add(candidate);
  return candidate;
}

function collectDownloadAssetLinks(value: unknown): DownloadAssetLink[] {
  const links = new Map<string, DownloadAssetLink>();
  const visit = (item: unknown, path: string[]): void => {
    if (Array.isArray(item)) {
      item.forEach((child, index) => visit(child, [...path, String(index)]));
      return;
    }
    if (!isRecord(item)) {
      return;
    }
    for (const [key, child] of Object.entries(item)) {
      if (typeof child === "string" && looksLikeDownloadUrl(child)) {
        const kind = inferDownloadAssetKind([...path, key]);
        const format = inferDownloadAssetFormat(item, child);
        const mapKey = `${kind}:${child}`;
        if (!links.has(mapKey)) {
          links.set(mapKey, {
            kind,
            url: child,
            format,
            name: asOptionalString(item.name) ?? asOptionalString(item.fileName) ?? asOptionalString(item.filename),
          });
        }
      }
      visit(child, [...path, key]);
    }
  };
  visit(value, []);
  return [...links.values()];
}

function looksLikeDownloadUrl(value: string): boolean {
  if (!/^https?:\/\//iu.test(value)) {
    return false;
  }
  return /\.(?:png|jpe?g|webp|gif|svg|pdf)(?:[?#].*)?$/iu.test(value)
    || /(?:download|export|render|image|asset|file|url)/iu.test(value);
}

function inferDownloadAssetKind(path: string[]): "exported" | "raw" {
  const joined = path.join(".").toLowerCase();
  if (/(?:raw|source|original|fill|fills|image|images)/u.test(joined)) {
    return "raw";
  }
  return "exported";
}

function inferDownloadAssetFormat(record: Record<string, unknown>, url: string): string | undefined {
  return sanitizeFileExtension(
    asOptionalString(record.format)
      ?? asOptionalString(record.exportFormat)
      ?? asOptionalString(record.fileFormat)
      ?? extensionFromUrl(url),
  );
}

async function downloadAssetLinks(
  links: DownloadAssetLink[],
  outputDir: string,
): Promise<Array<Record<string, unknown>>> {
  await mkdir(outputDir, { recursive: true });
  const rawIndexes = new Map<"exported" | "raw", number>();
  const results: Array<Record<string, unknown>> = [];
  for (const link of links) {
    const index = (rawIndexes.get(link.kind) ?? 0) + 1;
    rawIndexes.set(link.kind, index);
    try {
      const response = await fetch(link.url);
      const bytes = Buffer.from(await response.arrayBuffer());
      const mimeType = contentTypeWithoutParameters(response.headers.get("content-type")) ?? undefined;
      const format = sanitizeFileExtension(link.format)
        ?? extensionFromContentType(mimeType)
        ?? extensionFromUrl(link.url)
        ?? "bin";
      const baseName = link.kind === "exported"
        ? index === 1 ? "exported" : `exported-${index}`
        : `raw-${index}`;
      const path = resolve(outputDir, `${baseName}.${format}`);
      if (!response.ok) {
        results.push(removeUndefined({
          ok: false,
          kind: link.kind,
          sourceUrl: link.url,
          path,
          mimeType,
          format,
          error: {
            message: `Download failed with HTTP ${response.status} ${response.statusText}`.trim(),
            code: `HTTP_${response.status}`,
          },
        }) as Record<string, unknown>);
        continue;
      }
      await writeFile(path, bytes);
      results.push(removeUndefined({
        ok: true,
        kind: link.kind,
        sourceUrl: link.url,
        path,
        bytes: bytes.byteLength,
        lineCount: 0,
        mimeType,
        format,
      }) as Record<string, unknown>);
    } catch (error) {
      const upstreamError = normalizeCaughtUpstreamError(error);
      results.push(removeUndefined({
        ok: false,
        kind: link.kind,
        sourceUrl: link.url,
        error: responseUpstreamError(upstreamError),
      }) as Record<string, unknown>);
    }
  }
  return results;
}

function compactDownloadedFiles(files: Array<Record<string, unknown>>): Array<Record<string, unknown>> {
  return files.map((file) => removeUndefined({
    ok: file.ok,
    kind: file.kind,
    path: file.path,
    bytes: file.bytes,
    lineCount: file.lineCount,
    mimeType: file.mimeType,
    format: file.format,
    error: file.error,
  }) as Record<string, unknown>);
}

function contentTypeWithoutParameters(value: string | null): string | undefined {
  if (!value) {
    return undefined;
  }
  return value.split(";")[0].trim().toLowerCase() || undefined;
}

function extensionFromContentType(mimeType: string | undefined): string | undefined {
  switch (mimeType) {
    case "image/png":
      return "png";
    case "image/jpeg":
      return "jpg";
    case "image/webp":
      return "webp";
    case "image/gif":
      return "gif";
    case "image/svg+xml":
      return "svg";
    case "application/pdf":
      return "pdf";
    default:
      return undefined;
  }
}

function extensionFromUrl(value: string): string | undefined {
  try {
    const extension = extname(new URL(value).pathname);
    return sanitizeFileExtension(extension);
  } catch {
    return sanitizeFileExtension(extname(value));
  }
}

function sanitizeFileExtension(value: string | undefined): string | undefined {
  if (!value) {
    return undefined;
  }
  const normalized = value.trim().replace(/^\./u, "").toLowerCase();
  return /^[a-z0-9]{1,8}$/u.test(normalized) ? normalized : undefined;
}

async function handleCaptureNode(
  args: FigmaWorkspaceCaptureNodeArguments,
  runtime: FigmaWorkspaceRuntime,
): Promise<Record<string, unknown>> {
  return makeJsonToolResult(await executeCaptureNodeForTool(args, runtime));
}

async function executeCaptureNode(
  args: FigmaWorkspaceCaptureNodeArguments,
  runtime: FigmaWorkspaceRuntime,
): Promise<Record<string, unknown>> {
  return executeCaptureNodeForTool(args, runtime);
}

async function executeCaptureNodeForTool(
  args: FigmaWorkspaceCaptureNodeArguments,
  runtime: FigmaWorkspaceRuntime,
): Promise<Record<string, unknown>> {
  rejectRemovedCaptureMediaArguments(args);
  const session = runtime.sessions.getOrCreate(args.sessionId);
  const requested = resolveWrapperNodeTarget({
    args: { target: args.target },
    session,
    toolName: "figma_workspace_capture_node",
    requireNode: true,
    targetError: 'Tool argument "target" is required.',
    fileKeyError: 'Tool argument "target" requires a fileKey for official get_screenshot. Pass a node URL, target:{ fileKey, nodeId }, or open the session with a Figma file URL first.',
  });
  const { fileKey, nodeId } = requested;
  if (!nodeId) {
    throw new Error('Tool argument "target" is required.');
  }
  const requestedOutputFile = resolveCaptureOutputFile(args, session);
  const tools = await runtime.upstreamToolCache.list(false);
  const tool = selectRequiredUpstreamTool(tools, SCREENSHOT_TOOL_NAME, requireWrapperUpstreamKind(CAPTURE_NODE_CONTRACT));
  assertUpstreamToolHasProperties(
    tool,
    [...(CAPTURE_NODE_CONTRACT.requiredUpstreamProperties ?? [])],
    requireWrapperUpstreamKind(CAPTURE_NODE_CONTRACT),
  );
  const passthrough = collectContractPassthroughArguments({
    args,
    contract: CAPTURE_NODE_CONTRACT,
  });
  const filtered = filterAdvertisedUpstreamArguments({
    upstreamArguments: buildCaptureUpstreamArguments({
      fileKey,
      nodeId,
      tool,
      passthroughArguments: passthrough,
    }),
    contract: CAPTURE_NODE_CONTRACT,
    tool,
    upstreamKind: requireWrapperUpstreamKind(CAPTURE_NODE_CONTRACT),
  });
  const upstreamArguments = filtered.arguments;
  await runtime.client.connect();
  const upstream = await runtime.client.callTool(tool.name, upstreamArguments);
  const parsed = parseUpstreamToolResult(upstream);
  if (parsed.upstreamError) {
    const payload = {
      ok: false,
      session: responseSession(session),
      nodeId,
      diagnostics: filtered.diagnostics.length > 0 ? diagnosticsForResponse(filtered.diagnostics) : undefined,
      upstreamError: responseUpstreamError(parsed.upstreamError),
    };
    return payload;
  }
  let saved: Awaited<ReturnType<typeof writeCaptureOutputFile>>;
  try {
    saved = await writeCaptureOutputFile(requestedOutputFile, upstream, parsed);
  } catch (error) {
    const payload = {
      ok: false,
      session: responseSession(session),
      nodeId,
      diagnostics: filtered.diagnostics.length > 0 ? diagnosticsForResponse(filtered.diagnostics) : undefined,
      upstreamError: normalizeCaughtUpstreamError(error),
    };
    return payload;
  }
  runtime.sessions.rememberHistory(session, {
    id: randomUUID(),
    at: new Date().toISOString(),
    tool: "figma_workspace_capture_node",
    mode: "capture",
    summary: `Captured node ${nodeId} to ${saved.path}.`,
    nodeIds: [nodeId],
  });
  const payload = {
    ok: true,
    session: responseSession(session),
    imageFile: saved.path,
    nodeId,
    bytes: saved.bytes,
    width: saved.width,
    height: saved.height,
    diagnostics: filtered.diagnostics.length > 0 ? diagnosticsForResponse(filtered.diagnostics) : undefined,
  };
  return payload;
}

function rejectRemovedCaptureMediaArguments(args: FigmaWorkspaceCaptureNodeArguments): void {
  if (Object.prototype.hasOwnProperty.call(args, "preview")) {
    throw new Error('Tool argument "preview" was removed. Capture results now return local file paths in structuredContent only.');
  }
  if (Object.prototype.hasOwnProperty.call(args, "thumbnail")) {
    throw new Error('Tool argument "thumbnail" was removed. Capture results now return local file paths in structuredContent only.');
  }
  if (Object.prototype.hasOwnProperty.call(args, "thumbnailMaxSize")) {
    throw new Error('Tool argument "thumbnailMaxSize" was removed. Capture results now return local file paths in structuredContent only.');
  }
  if (Object.prototype.hasOwnProperty.call(args, "metadataFile")) {
    throw new Error('Input "metadataFile" was removed. Use call-upstream-tool for full upstream get_screenshot debugging.');
  }
}

function resolveCaptureOutputFile(args: FigmaWorkspaceCaptureNodeArguments, session: FigmaWorkspaceSession): string {
  const explicit = resolveWorkspaceAwareFile(args.imageFile, session, "imageFile");
  if (explicit) {
    return explicit;
  }
  const fileName = `capture-${new Date().toISOString().replace(/[^\dTZ]/gu, "")}`;
  if (session.workspace) {
    return resolveWorkspaceFile(session.workspace.sessionDir, fileName, "imageFile");
  }
  const root = defaultTaskWorkspaceRoot();
  if (!isAbsolute(root)) {
    throw new Error(`Tool argument "taskRoot" and ${TASK_WORKSPACE_ROOT_ENV} must be absolute paths when provided.`);
  }
  return resolve(root, "capture-results", session.slug, fileName);
}

interface FigmaWorkspaceQueuedCaptureRequest {
  requestId: string;
  nodeId: string;
  imageFile?: string;
  maxDimension?: number;
  contentsOnly?: boolean;
}

interface FigmaWorkspaceQueuedCaptureBatchResult {
  ok: boolean;
  requested: boolean;
  captures?: FigmaWorkspaceQueuedCaptureResult[];
}

async function executeQueuedCaptureRequests(options: {
  parsedJson: unknown;
  session: FigmaWorkspaceSession;
  runtime: FigmaWorkspaceRuntime;
  captureRequestsAllowed: boolean;
}): Promise<FigmaWorkspaceQueuedCaptureBatchResult> {
  let requests: FigmaWorkspaceQueuedCaptureRequest[];
  try {
    requests = extractQueuedCaptureRequests(
      options.parsedJson,
      options.session,
      options.captureRequestsAllowed,
    );
  } catch (error) {
    return {
      ok: false,
      requested: true,
      captures: [{
        requestId: "capture-envelope",
        ok: false,
        upstreamError: responseUpstreamError({
          message: error instanceof Error ? error.message : String(error),
          code: "FIGMA_WORKSPACE_CAPTURE_REQUEST_INVALID",
        }) as FigmaWorkspacePublicUpstreamError,
      }],
    };
  }
  if (requests.length === 0) {
    return { ok: true, requested: false };
  }

  const captures: FigmaWorkspaceQueuedCaptureResult[] = [];
  for (const [index, request] of requests.entries()) {
    try {
      const imageFile = resolveQueuedCaptureOutputFile(
        options.session,
        request.requestId,
        index,
        request.imageFile,
      );
      const result = await executeCaptureNodeForTool({
        sessionId: options.session.id,
        target: request.nodeId,
        imageFile,
        maxDimension: request.maxDimension,
        contentsOnly: request.contentsOnly,
      }, options.runtime);
      captures.push(compactQueuedCaptureResult(request.requestId, result));
    } catch (error) {
      captures.push({
        requestId: request.requestId,
        ok: false,
        nodeId: request.nodeId,
        upstreamError: compactQueuedCaptureError(normalizeCaughtUpstreamError(error)),
      });
    }
  }
  return {
    ok: captures.every((capture) => capture.ok),
    requested: true,
    captures,
  };
}

function extractQueuedCaptureRequests(
  value: unknown,
  session: Pick<FigmaWorkspaceSession, "id">,
  captureRequestsAllowed: boolean,
): FigmaWorkspaceQueuedCaptureRequest[] {
  if (!isRecord(value) || value.ok !== true || !Object.prototype.hasOwnProperty.call(value, "__figmaRepl")) {
    return [];
  }
  const repl = value.__figmaRepl;
  if (!isRecord(repl) || repl.sessionId !== session.id) {
    throw new Error("Queued capture envelope did not match the active Figma Workspace session.");
  }
  if (!Object.prototype.hasOwnProperty.call(repl, "captureRequests")) {
    return [];
  }
  if (!Array.isArray(repl.captureRequests)) {
    throw new Error("Queued capture envelope captureRequests must be an array.");
  }
  if (!captureRequestsAllowed && repl.captureRequests.length > 0) {
    throw new Error("Queued capture envelope was not authorized by a statically selected $.capture helper.");
  }
  if (repl.captureRequests.length > MAX_QUEUED_CAPTURE_REQUESTS) {
    throw new Error(`Queued capture envelope exceeds the ${MAX_QUEUED_CAPTURE_REQUESTS}-request host limit.`);
  }

  const requests: FigmaWorkspaceQueuedCaptureRequest[] = [];
  for (const [index, value] of repl.captureRequests.entries()) {
    if (!isRecord(value)) {
      throw new Error(`Queued capture request ${index + 1} must be an object.`);
    }
    const allowedKeys = new Set(["requestId", "nodeId", "imageFile", "maxDimension", "contentsOnly"]);
    if (Object.keys(value).some((key) => !allowedKeys.has(key))) {
      throw new Error(`Queued capture request ${index + 1} contains unsupported fields.`);
    }
    const requestId = `capture-${index + 1}`;
    if (value.requestId !== requestId) {
      throw new Error(`Queued capture request ${index + 1} has an invalid requestId.`);
    }
    const nodeId = asOptionalString(value.nodeId);
    if (!nodeId || nodeId.length > 512 || /[\u0000-\u001f\u007f]/u.test(nodeId)) {
      throw new Error(`Queued capture request ${requestId} has an invalid nodeId.`);
    }
    const imageFile = value.imageFile;
    if (
      imageFile !== undefined
      && (
        typeof imageFile !== "string"
        || imageFile.length === 0
        || imageFile.length > 32_768
        || imageFile.includes("\0")
        || isAbsolute(imageFile)
        || imageFile.includes("..")
        || /^[A-Za-z]:/u.test(imageFile)
        || imageFile.startsWith("\\\\")
      )
    ) {
      throw new Error(`Queued capture request ${requestId} imageFile must be a safe workspace-relative path.`);
    }
    const maxDimension = value.maxDimension;
    if (
      maxDimension !== undefined
      && (!Number.isInteger(maxDimension) || (maxDimension as number) < 1 || (maxDimension as number) > 65_536)
    ) {
      throw new Error(`Queued capture request ${requestId} has an invalid maxDimension.`);
    }
    const contentsOnly = value.contentsOnly;
    if (contentsOnly !== undefined && typeof contentsOnly !== "boolean") {
      throw new Error(`Queued capture request ${requestId} has an invalid contentsOnly value.`);
    }
    requests.push(removeUndefined({
      requestId,
      nodeId,
      imageFile,
      maxDimension,
      contentsOnly,
    }) as unknown as FigmaWorkspaceQueuedCaptureRequest);
  }
  return requests;
}

function resolveQueuedCaptureOutputFile(
  session: FigmaWorkspaceSession,
  requestId: string,
  index: number,
  requestedImageFile?: string,
): string {
  const timestamp = new Date().toISOString().replace(/[^\dTZ]/gu, "");
  const uniqueSuffix = randomUUID().slice(0, 8);
  const fileName = `capture-${timestamp}-${index + 1}-${requestId}-${uniqueSuffix}`;
  const selectedFileName = requestedImageFile ?? fileName;
  if (session.workspace) {
    return resolveWorkspaceFile(session.workspace.sessionDir, selectedFileName, "imageFile");
  }
  const root = defaultTaskWorkspaceRoot();
  if (!isAbsolute(root)) {
    throw new Error(`Tool argument "taskRoot" and ${TASK_WORKSPACE_ROOT_ENV} must be absolute paths when provided.`);
  }
  return resolveWorkspaceFile(resolve(root, "capture-results", session.slug), selectedFileName, "imageFile");
}

function compactQueuedCaptureResult(
  requestId: string,
  result: Record<string, unknown>,
): FigmaWorkspaceQueuedCaptureResult {
  const upstreamError = isRecord(result.upstreamError) && typeof result.upstreamError.message === "string"
    ? compactQueuedCaptureError(result.upstreamError)
    : undefined;
  const diagnostics = compactQueuedCaptureDiagnostics(result.diagnostics);
  return removeUndefined({
    requestId,
    ok: result.ok === true,
    nodeId: asOptionalString(result.nodeId),
    imageFile: asOptionalString(result.imageFile),
    bytes: typeof result.bytes === "number" ? result.bytes : undefined,
    width: typeof result.width === "number" ? result.width : undefined,
    height: typeof result.height === "number" ? result.height : undefined,
    diagnostics,
    upstreamError,
  }) as unknown as FigmaWorkspaceQueuedCaptureResult;
}

function compactQueuedCaptureError(error: unknown): FigmaWorkspacePublicUpstreamError {
  const record = asRecord(error);
  return removeUndefined({
    message: truncateUtf8(asOptionalString(record.message) ?? "Queued capture failed.", QUEUED_CAPTURE_ERROR_MESSAGE_BYTES),
    code: asOptionalString(record.code)
      ? truncateUtf8(asOptionalString(record.code) as string, 120)
      : undefined,
  }) as FigmaWorkspacePublicUpstreamError;
}

function compactQueuedCaptureDiagnostics(value: unknown): FigmaWorkspaceDiagnostic[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const diagnostics = value
    .filter(isRecord)
    .slice(0, 2)
    .flatMap((diagnostic) => {
      const code = asOptionalString(diagnostic.code);
      const severity = diagnostic.severity === "fatal" || diagnostic.severity === "warning"
        ? diagnostic.severity
        : undefined;
      const message = asOptionalString(diagnostic.message);
      const suggestion = asOptionalString(diagnostic.suggestion);
      const docsHint = asOptionalString(diagnostic.docsHint);
      if (!code || !severity || !message || !suggestion || !docsHint) return [];
      return [{
        code: truncateUtf8(code, 120),
        severity,
        message: truncateUtf8(message, QUEUED_CAPTURE_DIAGNOSTIC_FIELD_BYTES),
        suggestion: truncateUtf8(suggestion, QUEUED_CAPTURE_DIAGNOSTIC_FIELD_BYTES),
        docsHint: truncateUtf8(docsHint, QUEUED_CAPTURE_DIAGNOSTIC_FIELD_BYTES),
      } satisfies FigmaWorkspaceDiagnostic];
    });
  return diagnostics.length > 0 ? diagnostics : undefined;
}

async function handleRunTaskPlan(
  args: FigmaWorkspaceRunTaskPlanArguments,
  runtime: FigmaWorkspaceRuntime,
): Promise<Record<string, unknown>> {
  return makeJsonToolResult(await executeRunTaskPlan(args, runtime));
}

async function executeRunTaskPlan(
  args: FigmaWorkspaceRunTaskPlanArguments,
  runtime: FigmaWorkspaceRuntime,
): Promise<Record<string, unknown>> {
  const session = runtime.sessions.getOrCreate(args.sessionId);
  const plan = await loadTaskPlan(args, session);
  const resultFile = resolveTaskPlanResultFile(args, plan.planPath, session);
  const stopOnFailure = args.stopOnFailure !== false;
  const steps: Array<Record<string, unknown>> = [];
  const references: TaskPlanReferenceContext = { steps: {}, outputs: {} };
  let stopped = false;

  for (const [index, step] of plan.steps.entries()) {
    const startedAt = new Date().toISOString();
    const id = asOptionalString(step.id) ?? `step-${index + 1}`;
    const type = normalizeTaskPlanStepType(step);
    try {
      const result = await runTaskPlanStep({
        id,
        step,
        type,
        sessionId: args.sessionId,
        references,
        runtime,
      });
      const ok = taskPlanStepSucceeded(result);
      const status = ok ? "completed" : "failed";
      const reference = createTaskPlanStepReference({
        id,
        index,
        type,
        status,
        ok,
        result,
      });
      references.steps[id] = reference;
      const referenceOutputs = taskPlanStepOutputReferences(reference);
      references.outputs[id] = referenceOutputs ?? {};
      references.last = reference;
      steps.push({
        id,
        index,
        type,
        status,
        ok,
        summary: summarizeTaskPlanStepResult(result),
        outputReferences: referenceOutputs,
        finishedAt: new Date().toISOString(),
        startedAt,
      });
      if (!ok && stopOnFailure) {
        stopped = true;
        break;
      }
    } catch (error) {
      const upstreamError = normalizeCaughtUpstreamError(error);
      const reference = {
        id,
        index,
        type,
        status: "failed",
        ok: false,
        error: upstreamError,
      };
      references.steps[id] = reference;
      references.last = reference;
      steps.push({
        id,
        index,
        type,
        status: "failed",
        ok: false,
        error: upstreamError,
        finishedAt: new Date().toISOString(),
        startedAt,
      });
      if (stopOnFailure) {
        stopped = true;
        break;
      }
    }
  }

  const failedSteps = steps.filter((step) => step.ok === false);
  const failures = failedSteps.map(compactTaskPlanFailure);
  const payload = {
    ok: failedSteps.length === 0,
    session: responseSession(session),
    stopped,
    steps: steps.map(compactTaskPlanInlineStep),
    failures: failures.length > 0 ? failures : undefined,
  };
  const outputFiles = {
    debugFile: await writeJsonFile(resultFile, createResultFileEnvelope({
      tool: "figma_workspace_run_task_plan",
      session,
      ok: failedSteps.length === 0,
      fields: {
        stopped,
        stepCount: steps.length,
        plannedStepCount: plan.steps.length,
        failureCount: failures.length,
        failures: failures.length > 0 ? failures : undefined,
        stepDetails: steps.map(compactTaskPlanStepDetail),
      },
    })),
  };
  runtime.sessions.rememberHistory(session, {
    id: randomUUID(),
    at: new Date().toISOString(),
    tool: "figma_workspace_run_task_plan",
    mode: "task-plan",
    summary: `Ran ${steps.length}/${plan.steps.length} task-plan steps with ${failedSteps.length} failures.`,
    nodeIds: [],
  });
  const response = {
    ...payload,
    outputFiles,
  };
  return response;
}

function compactTaskPlanInlineStep(step: Record<string, unknown>): Record<string, unknown> {
  return removeUndefined({
    id: asOptionalString(step.id) ?? "",
    index: typeof step.index === "number" ? step.index : undefined,
    type: asOptionalString(step.type) ?? "",
    status: asOptionalString(step.status) ?? "",
    ok: step.ok !== false,
    summary: isRecord(step.summary) ? step.summary : undefined,
    outputReferences: isRecord(step.outputReferences) ? step.outputReferences : undefined,
    error: isRecord(step.error) ? step.error : undefined,
  }) as Record<string, unknown>;
}

function compactTaskPlanFailure(step: Record<string, unknown>): Record<string, unknown> {
  return removeUndefined({
    id: asOptionalString(step.id) ?? "",
    index: typeof step.index === "number" ? step.index : undefined,
    type: asOptionalString(step.type) ?? "",
    status: asOptionalString(step.status) ?? "failed",
    error: isRecord(step.error) ? step.error : undefined,
  }) as Record<string, unknown>;
}

function compactTaskPlanStepDetail(step: Record<string, unknown>): Record<string, unknown> {
  const summary = asRecord(step.summary);
  return removeUndefined({
    id: asOptionalString(step.id) ?? "",
    index: typeof step.index === "number" ? step.index : undefined,
    type: asOptionalString(step.type) ?? "",
    status: asOptionalString(step.status) ?? "",
    ok: step.ok !== false,
    startedAt: asOptionalString(step.startedAt),
    finishedAt: asOptionalString(step.finishedAt),
    diagnostics: typeof summary.diagnostics === "number" ? summary.diagnostics : undefined,
    failures: typeof summary.failures === "number" ? summary.failures : undefined,
    error: isRecord(step.error) ? step.error : undefined,
  }) as Record<string, unknown>;
}

async function handlePrepareTask(
  args: FigmaWorkspacePrepareTaskArguments,
  runtime?: { sessions: FigmaWorkspaceSessionStore },
): Promise<Record<string, unknown>> {
  const session = runtime?.sessions.getOrCreate(args.sessionId);
  const sessionSnapshot = session ? snapshotPrepareTaskSessionState(session) : undefined;
  try {
    const previousTask = session?.workspace ? taskChangeSnapshot(session.workspace) : undefined;
    applyWorkspaceFileContextArgs(session, args);
    const taskName = deriveTaskName(args, "figma-task");
    const fileSlug = deriveFileSlug(args, session);
    const workspace = resolvePrepareTaskWorkspace(args, taskName, fileSlug, session);
    if (session) {
      session.workspace = workspace;
      touchSession(session);
    }
    const scriptName = normalizeTaskScriptName(args.fileName ?? workspace.files.script, taskName);
    const scriptPath = resolveWorkspaceFile(workspace.sessionDir, scriptName, "fileName");

    await ensureWorkspaceDirectories(workspace);
    await writeTaskFile(scriptPath, createTaskScriptTemplate(taskName, scriptName, args), Boolean(args.overwrite));
    const payload = {
      ok: true,
      session: session ? responseSession(session) : undefined,
      task: {
        taskName,
        fileContext: workspace.fileContext,
        inputFile: scriptName,
        workspace: responseWorkspace(workspace),
        scriptPath,
        overwritten: Boolean(args.overwrite),
      },
      taskChange: {
        previous: previousTask,
        current: taskChangeSnapshot(workspace, scriptName),
        changed: !previousTask || previousTask.taskName !== workspace.intentSlug ||
          previousTask.inputFile !== scriptName ||
          previousTask.sessionDir !== workspace.sessionDir,
      },
      next: [
        "Edit the .figma.ts file in this task folder.",
        "Run figma:script:run; it strict-checks TypeScript and preflights diagnostics before upstream execution.",
        "Debug JSON files are generated on demand for failures, diagnostics, and inline omissions.",
      ],
    };
    return makeJsonToolResult(payload);
  } catch (error) {
    if (session && sessionSnapshot) {
      restorePrepareTaskSessionState(session, sessionSnapshot);
    }
    throw error;
  }
}

interface PrepareTaskSessionSnapshot {
  fileUrl?: string;
  fileKey?: string;
  surface?: FigmaWorkspaceSurface;
  lastDiagnostics: FigmaWorkspaceDiagnostic[];
  updatedAt: string;
  workspace?: FigmaWorkspaceSessionWorkspace;
  hadFileUrl: boolean;
  hadFileKey: boolean;
  hadSurface: boolean;
  hadWorkspace: boolean;
}

function snapshotPrepareTaskSessionState(session: FigmaWorkspaceSession): PrepareTaskSessionSnapshot {
  return {
    fileUrl: session.fileUrl,
    fileKey: session.fileKey,
    surface: session.surface,
    lastDiagnostics: [...session.lastDiagnostics],
    updatedAt: session.updatedAt,
    workspace: session.workspace,
    hadFileUrl: Object.prototype.hasOwnProperty.call(session, "fileUrl"),
    hadFileKey: Object.prototype.hasOwnProperty.call(session, "fileKey"),
    hadSurface: Object.prototype.hasOwnProperty.call(session, "surface"),
    hadWorkspace: Object.prototype.hasOwnProperty.call(session, "workspace"),
  };
}

function restorePrepareTaskSessionState(
  session: FigmaWorkspaceSession,
  snapshot: PrepareTaskSessionSnapshot,
): void {
  restoreOptionalSessionProperty(session, "fileUrl", snapshot.fileUrl, snapshot.hadFileUrl);
  restoreOptionalSessionProperty(session, "fileKey", snapshot.fileKey, snapshot.hadFileKey);
  restoreOptionalSessionProperty(session, "surface", snapshot.surface, snapshot.hadSurface);
  restoreOptionalSessionProperty(session, "workspace", snapshot.workspace, snapshot.hadWorkspace);
  session.lastDiagnostics = [...snapshot.lastDiagnostics];
  session.updatedAt = snapshot.updatedAt;
}

function restoreOptionalSessionProperty<K extends "fileUrl" | "fileKey" | "surface" | "workspace">(
  session: FigmaWorkspaceSession,
  key: K,
  value: FigmaWorkspaceSession[K],
  hadValue: boolean,
): void {
  if (hadValue) {
    session[key] = value;
  } else {
    delete session[key];
  }
}

function resolvePrepareTaskWorkspace(
  args: FigmaWorkspacePrepareTaskArguments,
  taskName: string,
  fileSlug: string,
  session: FigmaWorkspaceSession | undefined,
): FigmaWorkspaceSessionWorkspace {
  const parsedFile = parseFigmaFileReference(args.file);
  const fileKey = session?.fileKey ?? parsedFile.fileKey;
  const workspaceDir = asOptionalString(args.workspaceDir);
  if (workspaceDir && (args.file !== undefined || args.fileSlug !== undefined || fileKey !== undefined)) {
    return createSessionWorkspace({
      workspaceDir,
      fileKey,
      fileSlug,
      intentSlug: taskName,
    });
  }
  return resolvePreparedTaskWorkspace({
    args,
    taskName,
    fileSlug,
    session,
  });
}

function taskChangeSnapshot(
  workspace: FigmaWorkspaceSessionWorkspace,
  inputFile = workspace.files.script,
): Record<string, unknown> {
  return {
    taskName: workspace.intentSlug,
    inputFile,
    sessionDir: workspace.sessionDir,
  };
}

async function handleGuidance(
  args: FigmaWorkspaceGuidanceArguments,
): Promise<Record<string, unknown>> {
  const querySource = guidanceQuerySource(args);
  const cardSource = args.card;
  const maxCards = normalizeBoundedInteger(args.maxCards, 4, 8);
  const mode = args.mode ?? (cardSource ? "card" : querySource ? "guidance" : "catalog");
  const intent = querySource
    ? normalizeLookupRankingQuery(querySource.value, querySource.name)
    : undefined;
  const cardQuery = typeof cardSource === "string"
    ? normalizeLookupQuery(cardSource, "card or query")
    : undefined;
  const routingQuery = intent ?? cardQuery ?? "";
  const route = resolveTaskRoute({
    query: routingQuery,
    routes: getFigmaWorkspaceCanonicalTaskRoutes(),
    requestedSurface: args.surface,
  });
  const effectiveSurface = args.surface ?? route.surface;
  const cards = mode === "catalog"
    ? FIGMA_WORKSPACE_API_CARDS
      .filter((card) => effectiveSurface === undefined || card.surface === "any" || card.surface === effectiveSurface)
      .slice(0, maxCards)
    : cardQuery
    ? searchApiCards(cardQuery, maxCards, effectiveSurface)
    : intent
      ? chooseApiCardsForIntent(intent, maxCards, effectiveSurface)
      : [];
  const context = intent
    ? await searchReferenceFiles({
        query: route.status === "matched" ? route.canonicalQuery ?? intent : intent,
        scope: "auto",
        surface: effectiveSurface,
        taskFamily: route.status === "matched" ? route.taskFamily : undefined,
        effectiveScopes: route.effectiveScopes,
        maxResults: 2,
        maxSnippetLines: 3,
        exactSymbol: false,
      })
    : { results: [] };
  let selectedWorkflows = args.workflow
    ? selectWrapperWorkflowGraph([args.workflow], 1)
    : undefined;
  if (args.workflow && selectedWorkflows?.length === 0) {
    throw new Error(`Unknown Figma Workspace guidance workflow "${args.workflow}".`);
  }
  let selectedWrapperProfiles = chooseWrapperLookupProfilesForIntent(intent ?? cardQuery, 3);
  if (args.workflow) {
    selectedWrapperProfiles = selectedWrapperProfiles.filter((profile) => profile.workflowIds.includes(args.workflow as string));
  }
  const wrapperProfiles = createPublicWrapperProfilePayloads(selectedWrapperProfiles);
  const helperProfiles = createPublicHelperProfilePayloads(
    chooseHelperProfilesForIntent(intent ?? cardQuery, 3),
  );
  if (!selectedWorkflows) {
    const selectedWorkflowIds = uniqueStrings(
      selectedWrapperProfiles.flatMap((profile) => profile.workflowIds),
      1,
    );
    selectedWorkflows = selectedWorkflowIds.length > 0
      ? selectWrapperWorkflowGraph(selectedWorkflowIds, 1)
      : [];
  }
  const apiReferences = uniqueApiReferences(cards.flatMap((card) => card.apiReferences), 8);
  const referenceContext = context.results.map((result) => ({
    ...result,
    snippet: truncateUtf8(result.snippet, 300),
  }));
  const nextActions = createGuidanceNextActions({
    query: intent ?? cardQuery ?? "figma workspace",
    route,
    referenceContext,
    apiReferences,
  });
  const payload = {
    ok: true,
    route,
    cards: cards.map(createPublicApiCardPayload),
    queryHints: uniqueStrings(cards.flatMap((card) => card.queryHints), 8),
    apiReferences,
    guardrails: uniqueStrings(cards.flatMap((card) => card.avoid), 6),
    helperProfiles,
    wrapperProfiles,
    workflowGraph: createPublicWrapperWorkflowPayloads(selectedWorkflows),
    referenceContext,
    nextActions,
    ...(mode === "plan" ? {
      workflow: createFileWorkflowPayload(),
      steps: [
        "Prepare or reuse a task workspace with figma:task:prepare.",
        "Write a small repairable .figma.ts transaction.",
        "Run figma:script:run with strict preflight and repair diagnostics before retrying.",
      ],
      recommendedTools: ["figma:task:prepare", "figma:guidance", "figma:script:run", "figma:inspect"] satisfies FigmaWorkspacePublicCommandId[],
    } : {}),
  };
  return makeJsonToolResult(payload);
}

function guidanceQuerySource(
  args: FigmaWorkspaceGuidanceArguments,
): { name: "query"; value: string } | undefined {
  if (typeof args.query === "string") {
    return { name: "query", value: args.query };
  }
  return undefined;
}

async function handleInspect(
  args: FigmaWorkspaceInspectArguments,
  runtime: {
    client: FigmaUpstreamMcpProxyClient;
    sessions: FigmaWorkspaceSessionStore;
    upstreamToolCache: ReturnType<typeof createUpstreamToolCache>;
  },
): Promise<Record<string, unknown>> {
  if (args.mode === "validate") {
    return makeJsonToolResult(await executeValidateHandles(args, runtime));
  }
  if (args.mode === "style") {
    return makeJsonToolResult(await executeInspectStyle(args, runtime));
  }
  const session = runtime.sessions.getOrCreate(asOptionalString(args.sessionId));
  assertInspectFileContext(session);
  const target = asOptionalString(args.target) ?? "$selection";
  const depth = normalizePositiveInteger(args.depth, 2);
  const code = [
    `const __target = ${literal(target)};`,
    `const __depth = ${literal(depth)};`,
    "let __value;",
    "if (__target === '$selection') {",
    "  __value = figma.currentPage.selection;",
    "} else if (__target === '$currentPage') {",
    "  __value = figma.currentPage;",
    "} else {",
    "  __value = await $(__target);",
    "}",
    "return {",
    "  target: __target,",
    "  mode: 'inspect',",
    "  summary: Array.isArray(__value) ? __value.map((node) => summarizeNode(node, __depth)) : summarizeNode(__value, __depth),",
    "};",
  ].join("\n");
  const evalSettings = await resolveEvalSettings(session, args as Record<string, unknown>, runtime);
  const upstream = await callUpstreamEval(
    runtime.client,
    evalSettings,
    buildFigmaEvalScript({ session, code, mode: "read" }),
  );
  const parsed = parseUpstreamToolResult(upstream);
  updateSessionFromParsedResult(session, parsed.json);
  runtime.sessions.rememberHistory(session, {
    id: randomUUID(),
    at: new Date().toISOString(),
    tool: "figma_workspace_inspect",
    mode: "read",
    summary: `Inspected ${target}.`,
    nodeIds: collectNodeIds(parsed.json),
  });
  const payload = {
    ok: !parsed.upstreamError,
    session: responseReadOnlySession(session),
    diagnostics: optionalDiagnosticsForResponse(session.lastDiagnostics),
    ...inspectInlineResultFields(parsed, "inspect"),
  };
  return makeJsonToolResult(payload);
}

async function executeInspectStyle(
  args: FigmaWorkspaceInspectArguments,
  runtime: {
    client: FigmaUpstreamMcpProxyClient;
    sessions: FigmaWorkspaceSessionStore;
    upstreamToolCache: ReturnType<typeof createUpstreamToolCache>;
  },
): Promise<Record<string, unknown>> {
  const session = runtime.sessions.getOrCreate(asOptionalString(args.sessionId));
  assertInspectFileContext(session);
  const target = asOptionalString(args.target) ?? "$selection";
  const depth = normalizePositiveInteger(args.depth, 1);
  const code = buildInspectStyleCode({
    target,
    depth,
    includeSummary: true,
    includeHandles: false,
  });
  const diagnostics = diagnoseFigmaWorkspaceCode(code, {
    mode: "read",
    generatedCode: true,
    expectedSurface: session.surface,
  });
  session.lastDiagnostics = diagnostics;
  throwIfFatalDiagnostics(diagnostics);
  const evalSettings = await resolveEvalSettings(session, args, runtime);
  const parsed = await readInspectStyleWithAdaptiveBatches({
    target,
    depth,
    session,
    client: runtime.client,
    evalSettings,
  });
  updateSessionFromParsedResult(session, parsed.json);
  runtime.sessions.rememberHistory(session, {
    id: randomUUID(),
    at: new Date().toISOString(),
    tool: "figma_workspace_inspect",
    mode: "style",
    summary: `Inspected style tokens for ${target}.`,
    nodeIds: collectNodeIds(parsed.json),
  });
  const payload = {
    ok: !parsed.upstreamError,
    session: responseReadOnlySession(session),
    diagnostics: optionalDiagnosticsForResponse(diagnostics),
    ...inspectInlineResultFields(parsed, "style"),
  };
  return payload;
}

function buildInspectStyleCode(options: {
  target: string;
  depth: number;
  offset?: number;
  limit?: number;
  includeSummary: boolean;
  includeHandles: boolean;
}): string {
  const limitLiteral = options.limit === undefined ? "undefined" : literal(options.limit);
  return [
    `const __target = ${literal(options.target)};`,
    `const __depth = ${literal(options.depth)};`,
    `const __offset = ${literal(options.offset ?? 0)};`,
    `const __limit = ${limitLiteral};`,
    `const __includeSummary = ${literal(options.includeSummary)};`,
    `const __includeHandles = ${literal(options.includeHandles)};`,
    "let __value;",
    "if (__target === '$selection') {",
    "  __value = figma.currentPage.selection;",
    "} else if (__target === '$currentPage') {",
    "  __value = figma.currentPage;",
    "} else {",
    "  __value = await $(__target);",
    "}",
    "function __hex(__color) {",
    "  const __r = Math.max(0, Math.min(255, Math.round((__color.r || 0) * 255)));",
    "  const __g = Math.max(0, Math.min(255, Math.round((__color.g || 0) * 255)));",
    "  const __b = Math.max(0, Math.min(255, Math.round((__color.b || 0) * 255)));",
    "  return '#' + [__r, __g, __b].map((__v) => __v.toString(16).padStart(2, '0')).join('');",
    "}",
    "function __compactName(__name) {",
    "  return typeof __name === 'string' && __name.length > 120 ? __name.slice(0, 117) + '...' : __name;",
    "}",
    "function __compactText(__text) {",
    "  return typeof __text === 'string' && __text.length > 240 ? __text.slice(0, 237) + '...' : __text;",
    "}",
    "function __targetSummary(__node) {",
    "  if (!__node || Array.isArray(__node)) return undefined;",
    "  return { id: __node.id, type: __node.type, name: __compactName(__node.name), visible: __node.visible !== false, x: __node.x, y: __node.y, width: __node.width, height: __node.height };",
    "}",
    "function __paint(__paint) {",
    "  if (!__paint) return undefined;",
    "  const __out = { type: __paint.type, visible: __paint.visible !== false, opacity: __paint.opacity == null ? 1 : Math.round(__paint.opacity * 1000) / 1000 };",
    "  if (__paint.color) __out.color = __hex(__paint.color);",
    "  if (__paint.gradientStops) __out.stops = __paint.gradientStops.slice(0, 6).map((__s) => ({ color: __hex(__s.color), opacity: Math.round((__s.color.a == null ? 1 : __s.color.a) * 1000) / 1000, position: Math.round(__s.position * 1000) / 1000 }));",
    "  if (__paint.imageHash) __out.image = true;",
    "  return __out;",
    "}",
    "function __fontName(__node) {",
    "  const __font = __node.fontName;",
    "  return typeof __font === 'symbol' ? String(__font) : __font;",
    "}",
    "const __nodes = [];",
    "function __walk(__node) {",
    "  if (!__node) return;",
    "  __nodes.push(__node);",
    "  if ('children' in __node) {",
    "    for (const __child of __node.children) __walk(__child);",
    "  }",
    "}",
    "if (Array.isArray(__value)) {",
    "  for (const __node of __value) __walk(__node);",
    "} else {",
    "  __walk(__value);",
    "}",
    "const __scanNodes = typeof __limit === 'number' ? __nodes.slice(__offset, __offset + __limit) : __nodes;",
    "const __colorCounts = {};",
    "const __imageNodes = [];",
    "const __textStyles = [];",
    "const __strokes = [];",
    "const __effects = [];",
    "let __imageNodeCount = 0;",
    "let __textStyleCount = 0;",
    "let __strokeCount = 0;",
    "let __effectCount = 0;",
    "for (const __node of __scanNodes) {",
    "  if ('fills' in __node && Array.isArray(__node.fills)) {",
    "    for (const __fill of __node.fills) {",
    "      const __summary = __paint(__fill);",
    "      if (__summary && __summary.color) __colorCounts[__summary.color] = (__colorCounts[__summary.color] || 0) + 1;",
    "      if (__summary && __summary.stops) {",
    "        for (const __stop of __summary.stops) __colorCounts[__stop.color] = (__colorCounts[__stop.color] || 0) + 1;",
    "      }",
    "      if (__summary && __summary.image) {",
    "        __imageNodeCount += 1;",
    "        if (__imageNodes.length < 20) __imageNodes.push({ id: __node.id, name: __compactName(__node.name), type: __node.type, x: __node.x, y: __node.y, width: __node.width, height: __node.height });",
    "      }",
    "    }",
    "  }",
    "  if (__node.type === 'TEXT') {",
    "    __textStyleCount += 1;",
    "    const __fills = Array.isArray(__node.fills) ? __node.fills.map(__paint).filter(Boolean).slice(0, 3) : [];",
    "    if (__textStyles.length < 24) __textStyles.push({ id: __node.id, name: __compactName(__node.name), characters: __compactText(__node.characters), font: __fontName(__node), fontSize: __node.fontSize, fills: __fills });",
    "  }",
    "  if ('strokes' in __node && Array.isArray(__node.strokes) && __node.strokes.length) {",
    "    __strokeCount += 1;",
    "    if (__strokes.length < 24) __strokes.push({ id: __node.id, name: __compactName(__node.name), type: __node.type, strokes: __node.strokes.map(__paint).filter(Boolean).slice(0, 3), strokeWeight: __node.strokeWeight });",
    "  }",
    "  if ('effects' in __node && Array.isArray(__node.effects) && __node.effects.length) {",
    "    __effectCount += 1;",
    "    if (__effects.length < 16) __effects.push({ id: __node.id, name: __compactName(__node.name), type: __node.type, effects: __node.effects.slice(0, 4).map((__effect) => ({ type: __effect.type, visible: __effect.visible !== false, radius: __effect.radius, color: __effect.color ? __hex(__effect.color) : undefined })) });",
    "  }",
    "}",
    "const __topColors = Object.entries(__colorCounts).sort((__a, __b) => __b[1] - __a[1]).slice(0, 16).map(([color, count]) => ({ color, count }));",
    "const __result = {",
    "  target: __target,",
    "  mode: 'style',",
    "  nodeCount: __nodes.length,",
    "  scannedNodeCount: __scanNodes.length,",
    "  offset: __offset,",
    "  limit: __limit,",
    "  targetSummary: __targetSummary(Array.isArray(__value) ? undefined : __value),",
    "  styleCounts: { topColors: Object.keys(__colorCounts).length, textStyles: __textStyleCount, imageNodes: __imageNodeCount, strokes: __strokeCount, effects: __effectCount },",
    "  style: { topColors: __topColors, textStyles: __textStyles, imageNodes: __imageNodes, strokes: __strokes, effects: __effects },",
    "};",
    "if (__includeSummary) __result.summary = Array.isArray(__value) ? __value.map((node) => summarizeNode(node, __depth)) : summarizeNode(__value, __depth);",
    "if (__includeHandles) __result.handles = __figmaRepl.handles;",
    "return __result;",
  ].join("\n");
}

async function readInspectStyleWithAdaptiveBatches(options: {
  target: string;
  depth: number;
  session: FigmaWorkspaceSession;
  client: FigmaUpstreamMcpProxyClient;
  evalSettings: EvalSettings;
}): Promise<ParsedUpstreamToolResult> {
  const upstream = await callUpstreamEval(
    options.client,
    options.evalSettings,
    buildFigmaEvalScript({
      session: options.session,
      code: buildInspectStyleCode({
        target: options.target,
        depth: options.depth,
        includeSummary: true,
        includeHandles: true,
      }),
      mode: "read",
    }),
  );
  const parsed = parseUpstreamToolResult(upstream);
  if (!parsed.upstreamError || parsed.upstreamError.code !== "FIGMA_UPSTREAM_TRUNCATED") {
    return parsed;
  }

  const chunks: Record<string, unknown>[] = [];
  let offset = 0;
  let expectedNodeCount: number | undefined;
  while (expectedNodeCount === undefined || offset < expectedNodeCount) {
    const limit = expectedNodeCount === undefined
      ? FIGMA_INSPECT_STYLE_BATCH_SIZE
      : Math.min(FIGMA_INSPECT_STYLE_BATCH_SIZE, expectedNodeCount - offset);
    const chunkResult = await readInspectStyleChunk({
      ...options,
      offset,
      limit,
      includeSummary: offset === 0,
    });
    if (chunkResult.upstreamError) {
      return {
        text: chunkResult.text ?? "",
        upstreamError: chunkResult.upstreamError,
        primaryFix: chunkResult.primaryFix,
      };
    }
    chunks.push(...chunkResult.chunks);
    expectedNodeCount = expectedNodeCount ?? inspectStyleNodeCount(chunkResult.chunks);
    if (expectedNodeCount === undefined) {
      const scannedCount = chunkResult.chunks.reduce((sum, chunk) => sum + (finiteNonNegativeNumber(asRecord(chunk).scannedNodeCount) ?? 0), 0);
      if (scannedCount === 0) {
        break;
      }
    }
    offset += limit;
  }

  const result = mergeInspectStyleChunks(options.target, chunks);
  const json = { result };
  return {
    text: JSON.stringify({ ok: true, result }),
    json,
  };
}

interface InspectStyleChunkResult {
  chunks: Record<string, unknown>[];
  upstreamError?: FigmaWorkspaceUpstreamError;
  primaryFix?: string;
  text?: string;
}

async function readInspectStyleChunk(options: {
  target: string;
  depth: number;
  session: FigmaWorkspaceSession;
  client: FigmaUpstreamMcpProxyClient;
  evalSettings: EvalSettings;
  offset: number;
  limit: number;
  includeSummary: boolean;
}): Promise<InspectStyleChunkResult> {
  const upstream = await callUpstreamEval(
    options.client,
    options.evalSettings,
    buildFigmaEvalScript({
      session: options.session,
      code: buildInspectStyleCode({
        target: options.target,
        depth: options.depth,
        offset: options.offset,
        limit: options.limit,
        includeSummary: options.includeSummary,
        includeHandles: false,
      }),
      mode: "read",
    }),
  );
  const parsed = parseUpstreamToolResult(upstream);
  if (parsed.upstreamError) {
    if (parsed.upstreamError.code === "FIGMA_UPSTREAM_TRUNCATED" && options.limit > 1) {
      const leftLimit = Math.ceil(options.limit / 2);
      const rightLimit = options.limit - leftLimit;
      const left = await readInspectStyleChunk({
        ...options,
        limit: leftLimit,
      });
      if (left.upstreamError) return left;
      const right = rightLimit > 0
        ? await readInspectStyleChunk({
          ...options,
          offset: options.offset + leftLimit,
          limit: rightLimit,
          includeSummary: false,
        })
        : { chunks: [] };
      if (right.upstreamError) return right;
      return { chunks: [...left.chunks, ...right.chunks] };
    }
    if (parsed.upstreamError.code === "FIGMA_UPSTREAM_TRUNCATED" && options.includeSummary) {
      return readInspectStyleChunk({ ...options, includeSummary: false });
    }
    return {
      chunks: [],
      upstreamError: parsed.upstreamError,
      primaryFix: parsed.primaryFix,
      text: parsed.text,
    };
  }
  const result = asRecord(asRecord(parsed.json).result);
  return { chunks: [result] };
}

function inspectStyleNodeCount(chunks: Record<string, unknown>[]): number | undefined {
  for (const chunk of chunks) {
    const nodeCount = finiteNonNegativeNumber(chunk.nodeCount);
    if (nodeCount !== undefined) {
      return nodeCount;
    }
  }
  return undefined;
}

function finiteNonNegativeNumber(value: unknown): number | undefined {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : undefined;
}

function finiteNumber(value: unknown): number | undefined {
  const number = Number(value);
  return Number.isFinite(number) ? number : undefined;
}

function mergeInspectStyleChunks(target: string, chunks: Record<string, unknown>[]): Record<string, unknown> {
  const caps = { topColors: 16, textStyles: 24, imageNodes: 20, strokes: 24, effects: 16 };
  const colorCounts = new Map<string, number>();
  const textStyles: Record<string, unknown>[] = [];
  const imageNodes: Record<string, unknown>[] = [];
  const strokes: Record<string, unknown>[] = [];
  const effects: Record<string, unknown>[] = [];
  const styleCounts = { topColors: 0, textStyles: 0, imageNodes: 0, strokes: 0, effects: 0 };
  let nodeCount = 0;
  let scannedNodeCount = 0;
  let targetSummary: unknown;
  for (const chunk of chunks) {
    nodeCount = Math.max(nodeCount, inspectStyleNodeCount([chunk]) ?? 0);
    scannedNodeCount += finiteNonNegativeNumber(chunk.scannedNodeCount) ?? 0;
    if (targetSummary === undefined) {
      targetSummary = chunk.targetSummary ?? targetSummaryFromSummary(chunk.summary);
    }
    const style = asRecord(chunk.style);
    const counts = asRecord(chunk.styleCounts);
    styleCounts.textStyles += finiteNonNegativeNumber(counts.textStyles) ?? countRecords(style.textStyles);
    styleCounts.imageNodes += finiteNonNegativeNumber(counts.imageNodes) ?? countRecords(style.imageNodes);
    styleCounts.strokes += finiteNonNegativeNumber(counts.strokes) ?? countRecords(style.strokes);
    styleCounts.effects += finiteNonNegativeNumber(counts.effects) ?? countRecords(style.effects);
    for (const color of Array.isArray(style.topColors) ? style.topColors.filter(isRecord) : []) {
      const name = asOptionalString(color.color);
      const count = finiteNonNegativeNumber(color.count) ?? 0;
      if (name) {
        colorCounts.set(name, (colorCounts.get(name) ?? 0) + count);
      }
    }
    appendCappedRecords(textStyles, style.textStyles, caps.textStyles);
    appendCappedRecords(imageNodes, style.imageNodes, caps.imageNodes);
    appendCappedRecords(strokes, style.strokes, caps.strokes);
    appendCappedRecords(effects, style.effects, caps.effects);
  }
  const topColors = [...colorCounts.entries()]
    .sort((left, right) => right[1] - left[1])
    .slice(0, caps.topColors)
    .map(([color, count]) => ({ color, count }));
  styleCounts.topColors = colorCounts.size;
  return removeUndefined({
    target,
    mode: "style",
    nodeCount,
    scannedNodeCount,
    targetSummary,
    styleCounts,
    style: {
      topColors,
      textStyles,
      imageNodes,
      strokes,
      effects,
    },
    batching: {
      source: "adaptive",
      chunkCount: chunks.length,
      batchSize: FIGMA_INSPECT_STYLE_BATCH_SIZE,
    },
  }) as Record<string, unknown>;
}

function appendCappedRecords(target: Record<string, unknown>[], value: unknown, cap: number): void {
  if (target.length >= cap || !Array.isArray(value)) {
    return;
  }
  for (const item of value) {
    if (target.length >= cap) {
      return;
    }
    if (isRecord(item)) {
      target.push(item);
    }
  }
}

async function executeValidateHandles(
  args: FigmaWorkspaceInspectArguments,
  runtime: {
    client: FigmaUpstreamMcpProxyClient;
    sessions: FigmaWorkspaceSessionStore;
    upstreamToolCache: ReturnType<typeof createUpstreamToolCache>;
  },
): Promise<Record<string, unknown>> {
  const session = runtime.sessions.getOrCreate(asOptionalString(args.sessionId));
  assertInspectFileContext(session);
  const requested = Array.isArray(args.handles)
    ? args.handles.filter((item): item is string => typeof item === "string" && item.length > 0)
    : Object.keys(session.handles);
  const diagnostics = diagnoseFigmaWorkspaceCode(buildInspectValidateHandlesCode(requested, session.handles), {
    mode: "read",
    generatedCode: true,
    expectedSurface: session.surface,
  });
  session.lastDiagnostics = diagnostics;
  throwIfFatalDiagnostics(diagnostics);
  const evalSettings = await resolveEvalSettings(session, args, runtime);
  const validationResult = await readInspectHandleValidationsInBatches({
    requested,
    knownHandles: session.handles,
    session,
    client: runtime.client,
    evalSettings,
  });
  updateSessionFromParsedResult(session, validationResult.parsedJson);
  runtime.sessions.rememberHistory(session, {
    id: randomUUID(),
    at: new Date().toISOString(),
    tool: "figma_workspace_inspect",
    mode: "validate",
    summary: `Validated ${requested.length} Figma Workspace handle(s).`,
    nodeIds: collectNodeIds(validationResult.parsedJson),
  });
  const payload = validationResult.upstreamError
    ? {
        ok: false,
        session: responseReadOnlySession(session),
        mode: "validate",
        diagnostics: optionalDiagnosticsForResponse(diagnostics),
        upstreamError: responseUpstreamError(validationResult.upstreamError),
      }
    : {
        ok: true,
        session: responseReadOnlySession(session),
        mode: "validate",
        diagnostics: optionalDiagnosticsForResponse(diagnostics),
        validations: validationResult.validations,
      };
  return payload;
}

interface InspectHandleValidationBatchResult {
  parsedJson: unknown;
  validations: Record<string, unknown>[];
  validatedNodeIds: string[];
  upstreamError?: FigmaWorkspaceUpstreamError;
}

async function readInspectHandleValidationsInBatches(options: {
  requested: string[];
  knownHandles: Record<string, string>;
  session: FigmaWorkspaceSession;
  client: FigmaUpstreamMcpProxyClient;
  evalSettings: EvalSettings;
}): Promise<InspectHandleValidationBatchResult> {
  const validations: Record<string, unknown>[] = [];
  const validatedNodeIds: string[] = [];
  for (const chunk of chunkArray(options.requested, FIGMA_INSPECT_VALIDATE_BATCH_SIZE)) {
    const chunkResult = await readInspectHandleValidationChunk({
      ...options,
      requested: chunk,
    });
    if (chunkResult.upstreamError) {
      return chunkResult;
    }
    validations.push(...chunkResult.validations);
    validatedNodeIds.push(...chunkResult.validatedNodeIds);
  }
  const parsedJson = { result: { validations, validatedNodeIds } };
  return { parsedJson, validations, validatedNodeIds };
}

async function readInspectHandleValidationChunk(options: {
  requested: string[];
  knownHandles: Record<string, string>;
  session: FigmaWorkspaceSession;
  client: FigmaUpstreamMcpProxyClient;
  evalSettings: EvalSettings;
}): Promise<InspectHandleValidationBatchResult> {
  const upstream = await callUpstreamEval(
    options.client,
    options.evalSettings,
    buildFigmaEvalScript({
      session: options.session,
      code: buildInspectValidateHandlesCode(options.requested, options.knownHandles),
      mode: "read",
    }),
  );
  const parsed = parseUpstreamToolResult(upstream);
  if (parsed.upstreamError) {
    if (parsed.upstreamError.code === "FIGMA_UPSTREAM_TRUNCATED" && options.requested.length > 1) {
      const midpoint = Math.ceil(options.requested.length / 2);
      const left = await readInspectHandleValidationChunk({ ...options, requested: options.requested.slice(0, midpoint) });
      if (left.upstreamError) return left;
      const right = await readInspectHandleValidationChunk({ ...options, requested: options.requested.slice(midpoint) });
      if (right.upstreamError) return right;
      const validations = [...left.validations, ...right.validations];
      const validatedNodeIds = [...left.validatedNodeIds, ...right.validatedNodeIds];
      return { parsedJson: { result: { validations, validatedNodeIds } }, validations, validatedNodeIds };
    }
    return { parsedJson: parsed.json, validations: [], validatedNodeIds: [], upstreamError: parsed.upstreamError };
  }
  const result = asRecord(asRecord(parsed.json).result);
  const validations = Array.isArray(result.validations) ? result.validations.filter(isRecord) : [];
  const validatedNodeIds = Array.isArray(result.validatedNodeIds)
    ? result.validatedNodeIds.filter((item): item is string => typeof item === "string")
    : validations.map((item) => asOptionalString(item.id)).filter((item): item is string => item !== undefined);
  return { parsedJson: parsed.json, validations, validatedNodeIds };
}

function buildInspectValidateHandlesCode(requested: string[], knownHandles: Record<string, string>): string {
  return [
    `const __requestedHandles = ${literal(requested)};`,
    `const __knownHandles = ${literal(knownHandles)};`,
    "const __validations = [];",
    "for (const __name of __requestedHandles) {",
    "  const __isHandle = typeof __name === 'string' && __name.startsWith('$');",
    "  if (__isHandle && !__knownHandles[__name]) {",
    "    __validations.push({ handle: __name, status: 'missing' });",
    "    continue;",
    "  }",
    "  try {",
    "    const __node = await $(__name);",
    "    __validations.push({ handle: __name, status: 'valid', id: __node.id, type: __node.type, name: __node.name, locked: 'locked' in __node ? __node.locked : undefined, layoutMode: 'layoutMode' in __node ? __node.layoutMode : undefined, layoutPositioning: 'layoutPositioning' in __node ? __node.layoutPositioning : undefined });",
    "  } catch (__error) {",
    "    __validations.push({ handle: __name, status: 'stale', error: String(__error && __error.message ? __error.message : __error) });",
    "  }",
    "}",
    "return { validations: __validations, validatedNodeIds: __validations.filter((item) => item.status === 'valid').map((item) => item.id) };",
  ].join("\n");
}

function assertInspectFileContext(session: FigmaWorkspaceSession): void {
  if (session.fileKey || extractFigmaFileKey(session.fileUrl)) {
    return;
  }
  throw new Error(
    'inspect requires file context. Call open or prepare-task first. target must be a string such as "$selection", "$currentPage", a stored handle, raw node id, or node URL; do not pass { fileKey, nodeId }.',
  );
}

async function handleCallUpstreamTool(
  args: FigmaWorkspaceCallUpstreamToolArguments,
  runtime: {
    client: FigmaUpstreamMcpProxyClient;
    sessions: FigmaWorkspaceSessionStore;
    upstreamToolCache: ReturnType<typeof createUpstreamToolCache>;
  },
): Promise<Record<string, unknown>> {
  return makeJsonToolResult(await executeCallUpstreamTool(args, runtime));
}

async function handleGetMetadata(
  args: FigmaWorkspaceGetMetadataArguments,
  runtime: {
    client: FigmaUpstreamMcpProxyClient;
    sessions: FigmaWorkspaceSessionStore;
    upstreamToolCache: ReturnType<typeof createUpstreamToolCache>;
  },
): Promise<Record<string, unknown>> {
  return makeJsonToolResult(await executeGetMetadata(args, runtime));
}

async function executeGetMetadata(
  args: FigmaWorkspaceGetMetadataArguments,
  runtime: {
    client: FigmaUpstreamMcpProxyClient;
    sessions: FigmaWorkspaceSessionStore;
    upstreamToolCache: ReturnType<typeof createUpstreamToolCache>;
  },
): Promise<Record<string, unknown>> {
  const session = runtime.sessions.getOrCreate(args.sessionId);
  applySessionFileReference(session, args.file);
  if (args.workspaceDir !== undefined || (args.file !== undefined && !session.workspace)) {
    bindOpenWorkspaceIfAvailable(session, args);
  }
  touchSession(session);
  const requested = await resolveGetMetadataRequest(args, session, runtime);
  const tools = await runtime.upstreamToolCache.list(Boolean(args.refresh));
  const tool = selectRequiredUpstreamTool(tools, GET_METADATA_TOOL_NAME, requireWrapperUpstreamKind(GET_METADATA_CONTRACT));
  assertUpstreamToolHasProperties(
    tool,
    [...(GET_METADATA_CONTRACT.requiredUpstreamProperties ?? [])],
    requireWrapperUpstreamKind(GET_METADATA_CONTRACT),
  );
  const passthrough = collectContractPassthroughArguments({
    args,
    contract: GET_METADATA_CONTRACT,
  });
  await runtime.client.connect();
  const filtered = filterAdvertisedUpstreamArguments({
    upstreamArguments: removeUndefined({
      fileKey: requested.fileKey,
      nodeId: requested.nodeId,
      ...passthrough,
    }) as Record<string, unknown>,
    contract: GET_METADATA_CONTRACT,
    tool,
    upstreamKind: requireWrapperUpstreamKind(GET_METADATA_CONTRACT),
  });
  const upstreamArgs = filtered.arguments;
  const upstream = await runtime.client.callTool(GET_METADATA_TOOL_NAME, upstreamArgs);
  const parsed = parseUpstreamToolResult(upstream);
  const upstreamResult = upstreamEnvelope(parsed, { includePayload: false });
  const xml = metadataXmlFromParsedResult(parsed);
  const metadata = xml && !parsed.upstreamError
    ? metadataJsonFromXml(xml, requested.fileKey, requested.nodeId)
    : undefined;
  const enrichment = metadata?.root
    ? await enrichMetadataJson(metadata, session, runtime)
    : emptyMetadataEnrichment();
  runtime.sessions.rememberHistory(session, {
    id: randomUUID(),
    at: new Date().toISOString(),
    tool: "figma_workspace_get_metadata",
    mode: "read",
    summary: `Read Figma metadata for ${requested.nodeId ?? requested.fileKey}.`,
    nodeIds: requested.nodeId ? [requested.nodeId] : [],
  });
  const jsonBytes = metadata ? Buffer.byteLength(JSON.stringify(removeUndefined(metadata)), "utf8") : 0;
  const metadataOk = Boolean(metadata?.root) && !parsed.upstreamError;
  const xmlParseError = !metadataOk && !parsed.upstreamError
    ? responseUpstreamError({
      message: "Upstream get_metadata did not return parseable XML metadata.",
      code: "FIGMA_METADATA_XML_PARSE_FAILED",
      text: parsed.text,
      parsed: parsed.json,
    })
    : undefined;
  const resultPayload = removeUndefined({
    ok: metadataOk,
    session: responseSession(session),
    fileKey: requested.fileKey,
    nodeId: requested.nodeId,
    metadata: {
      format: "figma-metadata-tree",
      source: "get_metadata",
      nodeCount: metadata?.nodeCount ?? 0,
      jsonBytes,
      json: metadata,
    },
    diagnostics: diagnosticsForResponse([...filtered.diagnostics, ...enrichment.diagnostics]),
    upstream: upstreamResult,
    ...upstreamFailureFields(parsed),
    upstreamError: parsed.upstreamError ? responseUpstreamError(parsed.upstreamError) : xmlParseError,
  }) as Record<string, unknown>;
  const inlineResultLimit = normalizeInlineResultLimit(args.inlineResultLimit ?? DEFAULT_INLINE_RESULT_LIMIT);
  const limitedPayload = limitInlineScriptResult(resultPayload, inlineResultLimit, ["metadata.json"]);
  if (metadataOk && metadata && isRecord(limitedPayload.inlineResultLimit)) {
    const outputFiles = asRecord(limitedPayload.outputFiles);
    outputFiles.metadataFile = await writeMetadataFile({ args, session, metadata });
    limitedPayload.outputFiles = outputFiles;
  }
  return limitedPayload;
}

async function resolveGetMetadataRequest(
  args: FigmaWorkspaceGetMetadataArguments,
  session: FigmaWorkspaceSession,
  runtime: {
    client: FigmaUpstreamMcpProxyClient;
    upstreamToolCache: ReturnType<typeof createUpstreamToolCache>;
  },
): Promise<{ fileKey: string; nodeId?: string }> {
  const requested = resolveWrapperNodeTarget({
    args,
    session,
    toolName: "figma_workspace_get_metadata",
    targetFallback: args.nodeId ?? extractFigmaNodeId(args.file),
    fileKeyError: 'get-metadata requires a Figma file key. Pass "file" or open a session with file context first.',
    allowDynamicSelectors: ["$currentPage", "$selection"],
  });
  const { fileKey, nodeId } = requested;
  if (nodeId?.startsWith("$")) {
    return resolveGetMetadataDynamicSelector({ fileKey, selector: nodeId, session, runtime });
  }
  return { fileKey, nodeId };
}

async function resolveGetMetadataDynamicSelector(options: {
  fileKey: string;
  selector: string;
  session: FigmaWorkspaceSession;
  runtime: {
    client: FigmaUpstreamMcpProxyClient;
    upstreamToolCache: ReturnType<typeof createUpstreamToolCache>;
  };
}): Promise<{ fileKey: string; nodeId: string }> {
  const { fileKey, selector, session, runtime } = options;
  if (selector !== "$currentPage" && selector !== "$selection") {
    throw new Error(`get-metadata cannot resolve target "${selector}" as a cached handle or supported dynamic selector. Pass a raw node id, node URL, cached handle, $currentPage, or a single-node $selection.`);
  }
  const code = [
    `const __selector = ${literal(selector)};`,
    "let __node;",
    "if (__selector === '$currentPage') {",
    "  __node = figma.currentPage;",
    "} else {",
    "  const __selection = figma.currentPage.selection;",
    "  if (__selection.length !== 1) {",
    "    throw new Error(`$selection must contain exactly one node for get-metadata; found ${__selection.length}.`);",
    "  }",
    "  __node = __selection[0];",
    "}",
    "return {",
    "  target: __selector,",
    "  nodeId: __node.id,",
    "  nodeType: __node.type,",
    "  name: __node.name,",
    "  handles: __figmaRepl.handles,",
    "};",
  ].join("\n");
  const evalSettings = await resolveEvalSettings(session, {}, runtime);
  const upstream = await callUpstreamEval(
    runtime.client,
    evalSettings,
    buildFigmaEvalScript({ session, code, mode: "read" }),
  );
  const parsed = parseUpstreamToolResult(upstream);
  updateSessionFromParsedResult(session, parsed.json);
  if (parsed.upstreamError) {
    throw new Error(`get-metadata failed to resolve dynamic selector "${selector}": ${parsed.upstreamError.message}`);
  }
  const parsedRecord = asRecord(parsed.json);
  const resultRecord = asRecord(parsedRecord.result);
  const resolvedNodeId = asOptionalString(resultRecord.nodeId);
  if (!resolvedNodeId) {
    throw new Error(`get-metadata failed to resolve dynamic selector "${selector}" to a node id.`);
  }
  return { fileKey, nodeId: resolvedNodeId };
}

async function handleGetDesignContext(
  args: FigmaWorkspaceGetDesignContextArguments,
  runtime: {
    client: FigmaUpstreamMcpProxyClient;
    sessions: FigmaWorkspaceSessionStore;
    upstreamToolCache: ReturnType<typeof createUpstreamToolCache>;
  },
): Promise<Record<string, unknown>> {
  return makeJsonToolResult(await executeGetDesignContext(args, runtime));
}

async function executeGetDesignContext(
  args: FigmaWorkspaceGetDesignContextArguments,
  runtime: {
    client: FigmaUpstreamMcpProxyClient;
    sessions: FigmaWorkspaceSessionStore;
    upstreamToolCache: ReturnType<typeof createUpstreamToolCache>;
  },
): Promise<Record<string, unknown>> {
  const session = prepareFileScopedSession(args, runtime.sessions);
  const requested = resolveRequiredNodeScopedRequest(args, session, "figma_workspace_get_design_context");
  return executeDedicatedUpstreamTool({
    args,
    contract: GET_DESIGN_CONTEXT_CONTRACT,
    runtime,
    session,
    upstreamArguments: removeUndefined({
      fileKey: requested.fileKey,
      nodeId: requested.nodeId,
    }) as Record<string, unknown>,
    responseFields: {
      fileKey: requested.fileKey,
      nodeId: requested.nodeId,
    },
    historySummary: `Read Figma design context for ${requested.nodeId}.`,
    nodeIds: [requested.nodeId],
  });
}

async function handleGetMotionContext(
  args: FigmaWorkspaceGetMotionContextArguments,
  runtime: {
    client: FigmaUpstreamMcpProxyClient;
    sessions: FigmaWorkspaceSessionStore;
    upstreamToolCache: ReturnType<typeof createUpstreamToolCache>;
  },
): Promise<Record<string, unknown>> {
  return makeJsonToolResult(await executeGetMotionContext(args, runtime));
}

async function executeGetMotionContext(
  args: FigmaWorkspaceGetMotionContextArguments,
  runtime: {
    client: FigmaUpstreamMcpProxyClient;
    sessions: FigmaWorkspaceSessionStore;
    upstreamToolCache: ReturnType<typeof createUpstreamToolCache>;
  },
): Promise<Record<string, unknown>> {
  const session = prepareFileScopedSession(args, runtime.sessions);
  const requested = resolveRequiredNodeScopedRequest(args, session, "figma_workspace_get_motion_context");
  return executeDedicatedUpstreamTool({
    args,
    contract: GET_MOTION_CONTEXT_CONTRACT,
    runtime,
    session,
    upstreamArguments: removeUndefined({
      fileKey: requested.fileKey,
      nodeId: requested.nodeId,
    }) as Record<string, unknown>,
    responseFields: {
      fileKey: requested.fileKey,
      nodeId: requested.nodeId,
    },
    historySummary: `Read Figma motion context for ${requested.nodeId}.`,
    nodeIds: [requested.nodeId],
  });
}

async function handleSearchDesignSystem(
  args: FigmaWorkspaceSearchDesignSystemArguments,
  runtime: {
    client: FigmaUpstreamMcpProxyClient;
    sessions: FigmaWorkspaceSessionStore;
    upstreamToolCache: ReturnType<typeof createUpstreamToolCache>;
  },
): Promise<Record<string, unknown>> {
  return makeJsonToolResult(await executeSearchDesignSystem(args, runtime));
}

async function executeSearchDesignSystem(
  args: FigmaWorkspaceSearchDesignSystemArguments,
  runtime: {
    client: FigmaUpstreamMcpProxyClient;
    sessions: FigmaWorkspaceSessionStore;
    upstreamToolCache: ReturnType<typeof createUpstreamToolCache>;
  },
): Promise<Record<string, unknown>> {
  if (typeof args.query !== "string" || args.query.trim().length === 0) {
    throw new Error('Tool argument "query" is required and must be a non-empty string.');
  }
  const session = prepareFileScopedSession(args, runtime.sessions);
  const fileKey = resolveRequiredFileKey(args, session, "figma_workspace_search_design_system");
  const query = args.query.trim();
  return executeDedicatedUpstreamTool({
    args,
    contract: SEARCH_DESIGN_SYSTEM_CONTRACT,
    runtime,
    session,
    upstreamArguments: removeUndefined({
      fileKey,
      query,
    }) as Record<string, unknown>,
    responseFields: { fileKey, query },
    historySummary: `Searched Figma design system for ${query}.`,
    nodeIds: [],
  });
}

async function handleGetLibraries(
  args: FigmaWorkspaceGetLibrariesArguments,
  runtime: {
    client: FigmaUpstreamMcpProxyClient;
    sessions: FigmaWorkspaceSessionStore;
    upstreamToolCache: ReturnType<typeof createUpstreamToolCache>;
  },
): Promise<Record<string, unknown>> {
  return makeJsonToolResult(await executeGetLibraries(args, runtime));
}

async function executeGetLibraries(
  args: FigmaWorkspaceGetLibrariesArguments,
  runtime: {
    client: FigmaUpstreamMcpProxyClient;
    sessions: FigmaWorkspaceSessionStore;
    upstreamToolCache: ReturnType<typeof createUpstreamToolCache>;
  },
): Promise<Record<string, unknown>> {
  const session = prepareFileScopedSession(args, runtime.sessions);
  const fileKey = resolveRequiredFileKey(args, session, "figma_workspace_get_libraries");
  return executeDedicatedUpstreamTool({
    args,
    contract: GET_LIBRARIES_CONTRACT,
    runtime,
    session,
    upstreamArguments: removeUndefined({
      fileKey,
    }) as Record<string, unknown>,
    responseFields: removeUndefined({ fileKey, offset: args.offset }) as Record<string, unknown>,
    historySummary: `Read Figma libraries for ${fileKey}.`,
    nodeIds: [],
  });
}

async function handleGetVariableDefs(
  args: FigmaWorkspaceGetVariableDefsArguments,
  runtime: {
    client: FigmaUpstreamMcpProxyClient;
    sessions: FigmaWorkspaceSessionStore;
    upstreamToolCache: ReturnType<typeof createUpstreamToolCache>;
  },
): Promise<Record<string, unknown>> {
  return makeJsonToolResult(await executeGetVariableDefs(args, runtime));
}

async function executeGetVariableDefs(
  args: FigmaWorkspaceGetVariableDefsArguments,
  runtime: {
    client: FigmaUpstreamMcpProxyClient;
    sessions: FigmaWorkspaceSessionStore;
    upstreamToolCache: ReturnType<typeof createUpstreamToolCache>;
  },
): Promise<Record<string, unknown>> {
  const session = prepareFileScopedSession(args, runtime.sessions);
  const requested = resolveGetVariableDefsRequest(args, session);
  return executeDedicatedUpstreamTool({
    args,
    contract: GET_VARIABLE_DEFS_CONTRACT,
    runtime,
    session,
    upstreamArguments: removeUndefined({
      fileKey: requested.fileKey,
      nodeId: requested.nodeId,
    }) as Record<string, unknown>,
    responseFields: {
      fileKey: requested.fileKey,
      nodeId: requested.nodeId,
    },
    historySummary: `Read Figma variable definitions for ${requested.nodeId}.`,
    nodeIds: [requested.nodeId],
  });
}

function prepareFileScopedSession(
  args: { sessionId?: string; file?: string; workspaceDir?: string },
  sessions: FigmaWorkspaceSessionStore,
): FigmaWorkspaceSession {
  const session = sessions.getOrCreate(args.sessionId);
  applySessionFileReference(session, args.file);
  if (args.workspaceDir !== undefined || (args.file !== undefined && !session.workspace)) {
    bindOpenWorkspaceIfAvailable(session, args);
  }
  touchSession(session);
  return session;
}

function resolveRequiredFileKey(
  args: { file?: string },
  session: FigmaWorkspaceSession,
  toolName: string,
): string {
  const fileReference = parseFigmaFileReference(args.file);
  const fileKey = fileReference.fileKey ?? session.fileKey ?? extractFigmaFileKey(session.fileUrl);
  if (!fileKey) {
    throw new Error(`${toolName} requires a Figma file key. Pass "file" or open a session with file context first.`);
  }
  return fileKey;
}

function resolveRequiredNodeScopedRequest(
  args: { file?: string; target?: unknown },
  session: FigmaWorkspaceSession,
  toolName: LocalWorkspaceToolName,
): { fileKey: string; nodeId: string } {
  const requested = resolveWrapperNodeTarget({
    args,
    session,
    toolName,
    requireNode: true,
  });
  const nodeId = requested.nodeId;
  if (!nodeId) {
    throw new Error(`${toolName} requires "target". Pass a raw node id, node URL, or cached handle.`);
  }
  return { fileKey: requested.fileKey, nodeId };
}

function normalizeRequiredString(value: unknown, field: string, toolName: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${toolName} requires "${field}" as a non-empty string.`);
  }
  return value.trim();
}

function resolveGetVariableDefsRequest(
  args: FigmaWorkspaceGetVariableDefsArguments,
  session: FigmaWorkspaceSession,
): { fileKey: string; nodeId: string } {
  return resolveRequiredNodeScopedRequest(args, session, "figma_workspace_get_variable_defs");
}

async function executeDedicatedUpstreamTool(options: {
  args: { refresh?: boolean; inlineResultLimit?: number };
  contract: FigmaWorkspaceWrapperContract;
  runtime: {
    client: FigmaUpstreamMcpProxyClient;
    sessions: FigmaWorkspaceSessionStore;
    upstreamToolCache: ReturnType<typeof createUpstreamToolCache>;
  };
  session: FigmaWorkspaceSession;
  upstreamArguments: Record<string, unknown>;
  responseFields: Record<string, unknown>;
  historySummary: string;
  nodeIds: string[];
}): Promise<Record<string, unknown>> {
  const upstreamToolName = requireWrapperUpstreamToolName(options.contract);
  const upstreamKind = requireWrapperUpstreamKind(options.contract);
  const tools = await options.runtime.upstreamToolCache.list(Boolean(options.args.refresh));
  const tool = selectRequiredUpstreamTool(tools, upstreamToolName, upstreamKind);
  assertUpstreamToolHasProperties(
    tool,
    [...(options.contract.requiredUpstreamProperties ?? [])],
    upstreamKind,
  );
  const passthrough = collectContractPassthroughArguments({
    args: options.args,
    contract: options.contract,
  });
  const filtered = filterAdvertisedUpstreamArguments({
    upstreamArguments: removeUndefined({
      ...options.upstreamArguments,
      ...passthrough,
    }) as Record<string, unknown>,
    contract: options.contract,
    tool,
    upstreamKind,
  });
  const upstreamArguments = filtered.arguments;
  await options.runtime.client.connect();
  let upstream = await options.runtime.client.callTool(upstreamToolName, upstreamArguments);
  let parsed = parseUpstreamToolResult(upstream);
  const recoveryDiagnostics: FigmaWorkspaceDiagnostic[] = [];
  if (shouldRetrySelectionDependentWrapper(options.contract, parsed, options.nodeIds)) {
    const recovery = await selectNodeForSelectionDependentWrapper({
      runtime: options.runtime,
      session: options.session,
      nodeId: options.nodeIds[0],
    });
    recoveryDiagnostics.push(...recovery.diagnostics);
    if (recovery.selected) {
      upstream = await options.runtime.client.callTool(upstreamToolName, upstreamArguments);
      parsed = parseUpstreamToolResult(upstream);
    }
  }
  options.runtime.sessions.rememberHistory(options.session, {
    id: randomUUID(),
    at: new Date().toISOString(),
    tool: options.contract.toolName,
    mode: "upstream",
    summary: options.historySummary,
    nodeIds: options.nodeIds,
  });
  const resultPayload = removeUndefined({
    ok: !parsed.upstreamError,
    session: responseSession(options.session),
    ...options.responseFields,
    diagnostics: filtered.diagnostics.length > 0 || recoveryDiagnostics.length > 0
      ? diagnosticsForResponse([...filtered.diagnostics, ...recoveryDiagnostics])
      : undefined,
    guidanceRef: createWrapperGuidanceRef(options.contract.toolName),
    ...upstreamResultFields({
      parsed,
      upstream,
    }),
    ...upstreamFailureFields(parsed),
  }) as Record<string, unknown>;
  return shapeUpstreamBackedResponse({
    contract: options.contract,
    parsed,
    resultPayload,
    inlineResultLimit: options.args.inlineResultLimit,
    writeOutputFiles: (upstreamEnvelopePayload) => writeCallUpstreamResultFiles({
      toolName: upstreamToolName,
      wrapperToolName: options.contract.toolName,
      session: options.session,
      resultPayload,
      upstream: upstreamEnvelopePayload,
    }),
  });
}

function shouldRetrySelectionDependentWrapper(
  contract: FigmaWorkspaceWrapperContract,
  parsed: ParsedUpstreamToolResult,
  nodeIds: string[],
): boolean {
  if (!parsed.upstreamError || nodeIds.length !== 1) {
    return false;
  }
  if (
    contract.toolName !== "figma_workspace_get_design_context" &&
    contract.toolName !== "figma_workspace_get_motion_context" &&
    contract.toolName !== "figma_workspace_get_variable_defs"
  ) {
    return false;
  }
  const message = `${parsed.upstreamError.message}
${parsed.upstreamError.text ?? ""}`;
  return /you currently have nothing selected/iu.test(message);
}

async function selectNodeForSelectionDependentWrapper(options: {
  runtime: {
    client: FigmaUpstreamMcpProxyClient;
    upstreamToolCache: ReturnType<typeof createUpstreamToolCache>;
  };
  session: FigmaWorkspaceSession;
  nodeId: string;
}): Promise<{ selected: boolean; diagnostics: FigmaWorkspaceDiagnostic[] }> {
  const evalSettings = await resolveEvalSettings(options.session, {}, options.runtime);
  const script = buildFigmaEvalScript({
    session: options.session,
    mode: "write",
    includeEvalHelpers: false,
    code: [
      `const __nodeId = ${literal(options.nodeId)};`,
      "const __node = await getNodeById(__nodeId);",
      "const __nodeType = __node && __node.type;",
      "if (__nodeType === 'PAGE' || __nodeType === 'DOCUMENT') {",
      "  return { selected: false, reason: 'unsupported-container-target', nodeId: __nodeId, nodeType: __nodeType, name: __node.name, childCount: Array.isArray(__node.children) ? __node.children.length : undefined };",
      "}",
      "let __page = __node.parent;",
      "while (__page && __page.type !== 'PAGE') __page = __page.parent;",
      "if (__page && figma.currentPage && figma.currentPage.id !== __page.id) {",
      "  await figma.setCurrentPageAsync(__page);",
      "}",
      "figma.currentPage.selection = [__node];",
      "return { selected: true, nodeId: __nodeId, nodeType: __nodeType, name: __node.name, pageId: figma.currentPage && figma.currentPage.id };",
    ].join("\n"),
  });
  const upstream = await callUpstreamEval(options.runtime.client, evalSettings, script);
  const parsed = parseUpstreamToolResult(upstream);
  if (parsed.upstreamError) {
    return {
      selected: false,
      diagnostics: [{
        code: "FIGMA_WORKSPACE_SELECTION_RECOVERY_FAILED",
        severity: "warning",
        message: `Could not select target ${options.nodeId} before retrying the official context wrapper.`,
        suggestion: "Use a smaller child node target, or call get-metadata first to discover a selectable frame/component node.",
        docsHint: "Figma Workspace CLI: get-design-context --help",
      }],
    };
  }
  const result = asRecord(asRecord(parsed.json).result);
  if (result.selected === true) {
    return { selected: true, diagnostics: [] };
  }
  const nodeType = asOptionalString(result.nodeType) ?? "unknown";
  return {
    selected: false,
    diagnostics: [{
      code: "FIGMA_WORKSPACE_CONTEXT_TARGET_NOT_SELECTABLE",
      severity: "fatal",
      message: `Official context wrapper target ${options.nodeId} resolved to non-selectable ${nodeType}.`,
      suggestion: "Pass a smaller selectable child node, such as a frame/component inside the page, or call get-metadata on the page first and choose a child target.",
      docsHint: "Figma Workspace CLI: get-design-context --help",
    }],
  };
}

async function executeCallUpstreamTool(
  args: FigmaWorkspaceCallUpstreamToolArguments,
  runtime: {
    client: FigmaUpstreamMcpProxyClient;
    sessions: FigmaWorkspaceSessionStore;
    upstreamToolCache: ReturnType<typeof createUpstreamToolCache>;
  },
): Promise<Record<string, unknown>> {
  if (!args.toolName || typeof args.toolName !== "string") {
    throw new Error('Tool argument "toolName" is required and must be a string.');
  }
  if (isLocalWorkspaceToolName(args.toolName)) {
    throw new Error(
      `Refusing to proxy Figma Workspace operation "${args.toolName}". Use the corresponding CLI command instead.`,
    );
  }
  const upstreamArgs = isRecord(args.arguments) ? args.arguments : {};
  const tools = await runtime.upstreamToolCache.list(Boolean(args.refresh));
  const tool = tools.find((item) => item.name === args.toolName);
  if (!tool) {
    throw new Error(
      `Upstream Figma MCP tool "${args.toolName}" was not found. Available tools: ${tools.map((item) => item.name).join(", ")}`,
    );
  }
  await runtime.client.connect();
  const upstream = await runtime.client.callTool(args.toolName, upstreamArgs);
  const parsed = parseUpstreamToolResult(upstream);
  const session = runtime.sessions.getOrCreate(args.sessionId);
  runtime.sessions.rememberHistory(session, {
    id: randomUUID(),
    at: new Date().toISOString(),
    tool: "figma_workspace_call_upstream_tool",
    mode: "upstream",
    summary: `Called upstream Figma MCP tool ${args.toolName}.`,
    nodeIds: collectNodeIds(parsed.json),
  });
  const resultPayload = {
    ok: !parsed.upstreamError,
    session: responseSession(session),
    toolName: args.toolName,
    ...upstreamResultFields({
      parsed,
      upstream,
    }),
    ...upstreamFailureFields(parsed),
  };
  return shapeUpstreamBackedResponse({
    contract: CALL_UPSTREAM_TOOL_CONTRACT,
    parsed,
    resultPayload,
    inlineResultLimit: args.inlineResultLimit,
    writeOutputFiles: (upstreamEnvelopePayload) => writeCallUpstreamResultFiles({
      toolName: args.toolName,
      wrapperToolName: "figma_workspace_call_upstream_tool",
      session,
      resultPayload,
      upstream: upstreamEnvelopePayload,
    }),
  });
}

async function handleLookup(
  args: FigmaWorkspaceLookupArguments,
): Promise<Record<string, unknown>> {
  try {
    if (args.kind === "docs") {
      const query = normalizeLookupQuery(args.query ?? args.symbol, "query");
      const requestedScope = args.scope ?? "auto";
      const route = resolveTaskRoute({
        query,
        routes: getFigmaWorkspaceCanonicalTaskRoutes(),
        requestedSurface: args.surface,
        explicitTaskFamily: args.taskFamily,
      });
      const effectiveScopes = requestedScope === "auto"
        ? route.effectiveScopes
        : requestedScope === "all"
          ? ["active", "conditional", "router", "examples"] as const
          : [requestedScope];
      const selectedTaskFamily = args.taskFamily ?? (route.status === "matched" ? route.taskFamily : undefined);
      const matches = await searchReferenceFiles({
        query,
        scope: requestedScope,
        surface: args.surface,
        taskFamily: selectedTaskFamily,
        effectiveScopes,
        maxResults: normalizeBoundedInteger(
          args.maxResults,
          DEFAULT_DOCS_SEARCH_MAX_RESULTS,
          MAX_DOCS_SEARCH_RESULTS,
        ),
        maxSnippetLines: normalizeBoundedInteger(
          args.maxSnippetLines,
          DEFAULT_DOCS_SEARCH_SNIPPET_LINES,
          MAX_DOCS_SEARCH_SNIPPET_LINES,
        ),
      });
      const payload = {
        ok: true,
        requestedScope,
        effectiveScopes,
        route,
        results: matches.results,
        nextActions: createDocsLookupNextActions({ query, route, results: matches.results }),
        guidance:
          "Use these compact routed snippets, then run figma:docs:read with an exact project: or canonical: id for complete context.",
      };
      return makeJsonToolResult(payload);
    }
    if (args.kind !== "api") {
      throw new Error('Tool argument "kind" must be one of: docs, api.');
    }
    const symbol = normalizeLookupQuery(args.symbol ?? args.query, "symbol");
    const matches = await searchReferenceFiles({
      query: symbol,
      maxResults: normalizeBoundedInteger(args.maxResults, 5, MAX_DOCS_SEARCH_RESULTS),
      maxSnippetLines: normalizeBoundedInteger(args.maxSnippetLines, 5, MAX_DOCS_SEARCH_SNIPPET_LINES),
      exactSymbol: true,
      corpus: "api",
    });
    const payload = {
      ok: true,
      normalizedSymbol: matches.normalizedSymbol,
      ownerHint: matches.ownerHint,
      results: matches.results,
      guidance:
        "Results are compact declarations from the generated bundled typings index. Qualified aliases and direct owner matches rank before bare-symbol fallbacks.",
    };
    return makeJsonToolResult(payload);
  } catch (error) {
    if (error instanceof FigmaWorkspaceLookupCorpusUnavailableError) {
      return makeJsonToolResult({
        ok: false,
        results: [],
        diagnostics: diagnosticsForResponse([lookupCorpusDiagnostic(error)]),
        guidance: "A canonical docs or generated Plugin API lookup asset is unavailable in this CLI process. Rebuild the mcp-server dist after confirming those bundled assets exist, then start a new CLI command.",
        runtime: error.failure,
      });
    }
    throw error;
  }
}

function createDocsLookupNextActions(options: {
  query: string;
  route: TaskRouteResult;
  results: ReferenceSearchResult[];
}): FigmaWorkspaceNextAction[] {
  const actions: FigmaWorkspaceNextAction[] = [];
  const firstDocId = options.results.find((result) =>
    result.docId?.startsWith("project:") || result.docId?.startsWith("canonical:"))?.docId;
  if (firstDocId) {
    actions.push({
      commandId: "figma:docs:read",
      args: { id: firstDocId },
      reason: "Read the top document in full.",
      priority: 1,
    });
  }
  if (options.route.status === "ambiguous" || options.route.status === "none") {
    const taskFamily = options.route.candidateTaskFamilies[0];
    actions.push({
      commandId: "figma:docs:catalog",
      args: taskFamily ? { taskFamily } : {},
      reason: "Choose an exact canonical task family.",
      priority: actions.length + 1,
    });
  }
  if (/\b(?:example|sample|template)\b/iu.test(options.query)) {
    actions.push({
      commandId: "figma:docs:search",
      args: {
        query: options.route.canonicalQuery ?? options.query,
        scope: "examples",
        ...(options.route.taskFamily ? { taskFamily: options.route.taskFamily } : {}),
      },
      reason: "Examples require an explicit examples scope.",
      priority: actions.length + 1,
    });
  }
  return actions.slice(0, 6);
}

function countRecords(value: unknown): number {
  return Array.isArray(value) ? value.filter(isRecord).length : 0;
}

function lookupCorpusDiagnostic(error: FigmaWorkspaceLookupCorpusUnavailableError): FigmaWorkspaceDiagnostic {
  const failure = error.failure;
  return {
    code: "FIGMA_WORKSPACE_LOOKUP_CORPUS_UNAVAILABLE",
    severity: "fatal",
    message: [
      failure.message,
      `moduleDir=${failure.moduleDir}`,
      `cwd=${failure.cwd}`,
      `argv1=${failure.argv1 ?? "<unset>"}`,
      `packageVersion=${failure.packageVersion ?? "<unknown>"}`,
      `attemptedPaths=${failure.attemptedPaths.join(" | ")}`,
    ].join("; "),
    suggestion: "Rebuild the mcp-server dist if canonical docs or generated Plugin API index assets are missing, then rerun the CLI command with the same --session-file.",
    docsHint: "Figma Workspace CLI: lookup --help",
  };
}

async function callUpstreamEval(
  client: FigmaUpstreamMcpProxyClient,
  evalSettings: EvalSettings,
  script: string,
): Promise<unknown> {
  await client.connect();
  return client.callTool(evalSettings.toolName, {
    ...evalSettings.upstreamArguments,
    [evalSettings.argumentName]: script,
  });
}

function createUpstreamToolCache(client: FigmaUpstreamMcpProxyClient) {
  let cached: UpstreamToolInfo[] | undefined;
  return {
    async list(refresh = false): Promise<UpstreamToolInfo[]> {
      if (cached && !refresh) {
        return cached;
      }
      await client.connect();
      const result = asRecord(await client.listTools());
      const tools = Array.isArray(result.tools) ? result.tools : [];
      cached = tools.filter(isRecord).map((tool) => ({
        name: String(tool.name ?? ""),
        description: asOptionalString(tool.description),
        inputSchema: tool.inputSchema,
      })).filter((tool) => tool.name.length > 0);
      return cached;
    },
  };
}

type UpstreamToolDirectoryCategory =
  | "capture"
  | "design-context"
  | "motion"
  | "video"
  | "execution"
  | "assets"
  | "code-connect"
  | "libraries"
  | "figjam"
  | "generation"
  | "shader"
  | "account"
  | "other";

const UPSTREAM_TOOL_DIRECTORY_CATEGORY_ORDER: UpstreamToolDirectoryCategory[] = [
  "capture", "design-context", "motion", "video", "execution", "assets",
  "code-connect", "libraries", "figjam", "generation", "shader", "account", "other",
];

const UPSTREAM_TOOL_DIRECTORY_CATEGORIES: Record<string, UpstreamToolDirectoryCategory> = {
  get_screenshot: "capture",
  get_design_context: "design-context",
  get_motion_context: "motion",
  get_metadata: "design-context",
  get_variable_defs: "design-context",
  get_figjam: "figjam",
  generate_figma_design: "generation",
  generate_diagram: "figjam",
  get_code_connect_map: "code-connect",
  whoami: "account",
  add_code_connect_map: "code-connect",
  get_code_connect_suggestions: "code-connect",
  send_code_connect_mappings: "code-connect",
  get_context_for_code_connect: "code-connect",
  use_figma: "execution",
  get_libraries: "libraries",
  search_design_system: "libraries",
  create_new_file: "generation",
  upload_assets: "assets",
  download_assets: "assets",
  export_video: "video",
  list_shader_effects: "shader",
  get_shader_effect: "shader",
  list_shader_fills: "shader",
  get_shader_fill: "shader",
};

function upstreamToolDirectoryEntry(tool: UpstreamToolInfo): Record<string, unknown> {
  const normalizedDescription = tool.description?.replace(/\s+/gu, " ").trim();
  return removeUndefined({
    name: tool.name,
    category: UPSTREAM_TOOL_DIRECTORY_CATEGORIES[tool.name] ?? "other",
    description: !normalizedDescription
      ? undefined
      : normalizedDescription.length <= 96
        ? normalizedDescription
        : `${normalizedDescription.slice(0, 93)}...`,
  }) as Record<string, unknown>;
}

function sessionDirectoryEntry(session: FigmaWorkspaceSession): Record<string, unknown> {
  return removeUndefined({
    id: session.id,
    label: session.label,
    fileKey: session.fileKey,
    surface: session.surface,
    sessionDir: session.workspace?.sessionDir,
    handleCount: Object.keys(session.handles).length,
    historyCount: session.history.length,
    updatedAt: session.updatedAt,
  }) as Record<string, unknown>;
}

function sessionDetail(
  session: FigmaWorkspaceSession,
  includeHandles: boolean,
  includeHistory: boolean,
): Record<string, unknown> {
  return removeUndefined({
    ...sessionDirectoryEntry(session),
    slug: session.slug,
    createdAt: session.createdAt,
    fileUrl: session.fileUrl,
    currentPageId: session.currentPageId,
    knownPages: session.knownPages,
    lastDiagnostics: session.lastDiagnostics,
    workspace: session.workspace,
    handles: includeHandles ? session.handles : undefined,
    history: includeHistory ? session.history : undefined,
  }) as Record<string, unknown>;
}

async function resolveEvalSettings(
  session: FigmaWorkspaceSession,
  args: Record<string, unknown>,
  runtime: {
    upstreamToolCache: ReturnType<typeof createUpstreamToolCache>;
  },
): Promise<EvalSettings> {
  const toolName = DEFAULT_EVAL_TOOL_NAME;
  const tools = await runtime.upstreamToolCache.list(false);
  const tool = tools.find((item) => item.name === toolName);
  if (!tool) {
    throw new Error(
      `Required official upstream Figma MCP execution tool "${toolName}" was not found. This may indicate upstream contract drift; use call-upstream-tool for explicit upstream debugging. Available tools: ${tools.map((item) => item.name).join(", ")}`,
    );
  }
  const argumentName = DEFAULT_EVAL_ARGUMENT_NAME;
  assertUpstreamToolHasProperty(tool, argumentName, "execution");
  const requiredUpstreamProperties = upstreamToolRequiredProperties(tool);
  if (requiredUpstreamProperties.has("description")) {
    assertUpstreamToolHasProperty(tool, "description", "execution");
  }
  if (requiredUpstreamProperties.has("fileKey")) {
    assertUpstreamToolHasProperty(tool, "fileKey", "execution");
  }
  const upstreamArguments: Record<string, unknown> = {};
  upstreamArguments.description = DEFAULT_EVAL_DESCRIPTION;
  const fileKey = session.fileKey ?? extractFigmaFileKey(session.fileUrl);
  if (
    typeof upstreamArguments.fileKey !== "string" ||
    upstreamArguments.fileKey.length === 0
  ) {
    if (fileKey) {
      upstreamArguments.fileKey = fileKey;
    }
  }
  if (requiredUpstreamProperties.has("fileKey") && typeof upstreamArguments.fileKey !== "string") {
    throw new Error('Required official upstream Figma MCP execution tool "use_figma" requires fileKey. Call open or prepare-task first.');
  }
  touchSession(session);
  return { toolName, argumentName, upstreamArguments };
}

function upstreamToolRequiredProperties(tool: UpstreamToolInfo): Set<string> {
  const schema = isRecord(tool.inputSchema) ? tool.inputSchema : undefined;
  const required = Array.isArray(schema?.required) ? schema.required : [];
  return new Set(required.filter((value): value is string => typeof value === "string"));
}

/**
 * @internal Internal wrapper builder used by the Figma Workspace server and tests.
 * This is not a stable CLI input contract; callers should use eval or run-script-file.
 */
export function buildFigmaEvalScript(options: {
  session: Pick<FigmaWorkspaceSession, "id" | "handles" | "currentPageId" | "fileUrl" | "fileKey" | "surface" | "knownPages">;
  code: string;
  mode?: "read" | "write";
  includeEvalHelpers?: boolean;
  scriptInjectedHelpers?: readonly string[];
}): string {
  const includeEvalHelpers = options.includeEvalHelpers !== false;
  const evalInjectedHelpers = includeEvalHelpers
    ? resolveFigmaWorkspaceScriptHelperSelection(options.code).injectedHelpers
    : undefined;
  return `${createFigmaWorkspacePrelude(
    options.session,
    options.mode ?? "write",
    includeEvalHelpers,
    options.scriptInjectedHelpers,
    evalInjectedHelpers,
  )}
async function __figmaReplUserMain() {
${options.code}
}

const __figmaReplResult = await __figmaReplUserMain();
return {
  ok: true,
  __figmaRepl: {
    sessionId: __figmaRepl.sessionId,
    handles: __figmaRepl.handles,
    fileKey: __figmaRepl.fileKey,
    surface: __figmaRepl.surface,
    currentPageId: figma.currentPage && figma.currentPage.id,
    knownPages: Object.fromEntries(figma.root.children.map((page) => [page.id, page.name])),
    mode: __figmaRepl.mode,
    captureRequests: __figmaRepl.captureRequests
  },
  result: __figmaReplResult
};`;
}

function createFigmaWorkspacePrelude(
  session: Pick<FigmaWorkspaceSession, "id" | "handles" | "currentPageId" | "fileUrl" | "fileKey" | "surface" | "knownPages">,
  mode: "read" | "write",
  includeEvalHelpers: boolean,
  scriptInjectedHelpers?: readonly string[],
  evalInjectedHelpers?: readonly string[],
): string {
  let prelude = `const __figmaRepl = {
  sessionId: ${literal(session.id)},
  mode: ${literal(mode)},
  fileUrl: ${literal(session.fileUrl)},
  fileKey: ${literal(session.fileKey)},
  surface: ${literal(session.surface)},
  currentPageId: ${literal(session.currentPageId)},
  knownPages: ${literal(session.knownPages ?? {})},
  handles: ${literal(session.handles ?? {})},
  captureRequests: []
};

function normalizeHandleName(name) {
  if (typeof name !== "string" || !name) {
    throw new Error("A non-empty handle name or Figma node id is required.");
  }
  return name.startsWith("$") ? name : "$" + name;
}

async function getNodeById(id) {
  const node = typeof figma.getNodeByIdAsync === "function"
    ? await figma.getNodeByIdAsync(id)
    : figma.getNodeById(id);
  if (!node) {
    throw new Error("Figma node not found: " + id);
  }
  return node;
}

async function $(nameOrId) {
  if (nameOrId === "$currentPage") return figma.currentPage;
  if (nameOrId === "$selection") return figma.currentPage.selection;
  if (nameOrId && typeof nameOrId === "object" && "type" in nameOrId && "id" in nameOrId) {
    return nameOrId;
  }
  const key = typeof nameOrId === "string" && nameOrId.startsWith("$")
    ? nameOrId
    : undefined;
  const id = key && __figmaRepl.handles[key] ? __figmaRepl.handles[key] : nameOrId;
  if (typeof id !== "string") {
    throw new Error("Expected a handle or Figma node id string.");
  }
  return getNodeById(id);
}

function remember(name, nodeOrId) {
  const key = normalizeHandleName(name);
  const id = typeof nodeOrId === "string" ? nodeOrId : nodeOrId && nodeOrId.id;
  if (typeof id !== "string") {
    throw new Error("remember(name, nodeOrId) requires a node or node id.");
  }
  __figmaRepl.handles[key] = id;
  return id;
}

function forget(name) {
  const key = normalizeHandleName(name);
  delete __figmaRepl.handles[key];
}

function pageForNode(node) {
  let current = node;
  while (current && current.type !== "PAGE" && current.parent) {
    current = current.parent;
  }
  return current && current.type === "PAGE" ? current : null;
}

async function selectNodesForRepl(targets = "$selection", options = {}) {
  const input = Array.isArray(targets) ? targets : [targets];
  const nodes = [];
  for (const target of input) {
    const resolved = target && typeof target === "object" && "type" in target ? target : await $(target);
    const list = Array.isArray(resolved) ? resolved : [resolved];
    for (const node of list) {
      if (!node || node.type === "DOCUMENT" || node.type === "PAGE") {
        throw new Error("$.select targets must resolve to selectable scene nodes.");
      }
      nodes.push(node);
    }
  }
  if (nodes.length === 0 && options.allowEmpty !== true) {
    throw new Error("$.select resolved no nodes; pass { allowEmpty: true } to intentionally clear selection.");
  }
  if (nodes.length === 0) {
    figma.currentPage.selection = [];
    return { selectedNodeIds: [], summaries: [] };
  }
  const targetPage = pageForNode(nodes[0]);
  if (!targetPage) {
    throw new Error("$.select target is not attached to a page.");
  }
  for (const node of nodes) {
    const page = pageForNode(node);
    if (!page || page.id !== targetPage.id) {
      throw new Error("$.select cannot select nodes from multiple pages at once.");
    }
  }
  if (figma.currentPage.id !== targetPage.id) {
    await figma.setCurrentPageAsync(targetPage);
  }
  figma.currentPage.selection = nodes;
  if (nodes.length > 0 && options.zoom !== false) figma.viewport.scrollAndZoomIntoView(nodes);
  return {
    selectedNodeIds: nodes.map((node) => node.id),
    summaries: nodes.map((node) => summarizeNode(node, options.depth || 0)),
  };
}

function resolveSceneNodeForPlacement(value, name) {
  if (!value) throw new Error(name + " is required.");
  if (typeof value === "object" && "type" in value) return value;
  return $(value);
}

function canPositionNode(node) {
  return node && "x" in node && "y" in node && "width" in node && "height" in node;
}

function readPlacementSize(input, fallback) {
  const source = input && typeof input === "object" ? input : {};
  return {
    width: readFiniteNumber(source.width ?? fallback.width, "size.width"),
    height: readFiniteNumber(source.height ?? fallback.height, "size.height"),
  };
}

function nodeBounds(node) {
  return { x: node.x, y: node.y, width: node.width, height: node.height };
}

function boundsIntersect(a, b) {
  return a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y;
}

async function resolvePlacementParent(inputParent, node) {
  if (inputParent) return await resolveSceneNodeForPlacement(inputParent, "placement.parent");
  return node && node.parent ? node.parent : figma.currentPage;
}

async function findFreeSlotForRepl(options = {}) {
  const input = options || {};
  const preferred = input.preferred || input.position || {};
  const parent = await resolvePlacementParent(input.parent);
  const size = readPlacementSize(input.size, { width: 1, height: 1 });
  const gap = input.gap === undefined ? 40 : readFiniteNumber(input.gap, "gap");
  const direction = String(input.direction || "down");
  let x = readFiniteNumber(preferred.x ?? 0, "preferred.x");
  let y = readFiniteNumber(preferred.y ?? 0, "preferred.y");
  let shiftedSlots = 0;
  let collidedNodeIds = [];
  const children = "children" in parent
    ? Array.from(parent.children).filter((child) => child.visible !== false && canPositionNode(child) && child !== input.exclude)
    : [];
  for (let attempt = 0; attempt < 500; attempt++) {
    const candidate = { x, y, width: size.width, height: size.height };
    const collisions = children.filter((child) => boundsIntersect(candidate, nodeBounds(child)));
    if (collisions.length === 0) {
      return { x, y, width: size.width, height: size.height, shiftedSlots, collidedNodeIds };
    }
    collidedNodeIds = collisions.map((child) => child.id);
    shiftedSlots += 1;
    if (direction === "right") x += size.width + gap;
    else if (direction === "left") x -= size.width + gap;
    else if (direction === "up") y -= size.height + gap;
    else y += size.height + gap;
  }
  throw new Error("$.findFreeSlot could not find a free slot after 500 attempts.");
}

async function placeNodeForRepl(target, options = {}) {
  const node = await resolveSceneNodeForPlacement(target, "$.placeNode target");
  if (!canPositionNode(node)) {
    throw new Error("$.placeNode target must resolve to a positionable scene node.");
  }
  const input = options || {};
  const preferred = input.preferred || input.position || { x: node.x, y: node.y };
  let placement = { x: preferred.x, y: preferred.y, shiftedSlots: 0, collidedNodeIds: [] };
  if (input.avoidOverlap) {
    placement = await findFreeSlotForRepl({ ...input, preferred, size: input.size || nodeBounds(node), parent: input.parent, exclude: node });
  }
  node.x = readFiniteNumber(placement.x, "placement.x");
  node.y = readFiniteNumber(placement.y, "placement.y");
  if (input.as) remember(input.as, node);
  return placement;
}

async function replaceGeneratedFrameForRepl(options = {}) {
  const input = options || {};
  const name = String(input.name || "");
  if (!name) throw new Error("$.replaceGeneratedFrame requires an exact name.");
  const guardPrefixes = input.guardPrefix ? [String(input.guardPrefix)] : ["Variant ", "Codex Generated ", "Generated "];
  if (!guardPrefixes.some((prefix) => name.startsWith(prefix))) {
    throw new Error("$.replaceGeneratedFrame name must start with guardPrefix or one of: Variant , Codex Generated , Generated .");
  }
  const parent = input.parent
    ? await resolveSceneNodeForPlacement(input.parent, "$.replaceGeneratedFrame parent")
    : figma.currentPage;
  if (!parent || !("appendChild" in parent)) {
    throw new Error("$.replaceGeneratedFrame requires a writable parent.");
  }
  const children = "children" in parent ? Array.from(parent.children) : [];
  const existingFrames = children.filter((child) => child.type === "FRAME" && child.name === name);
  const frame = figma.createFrame();
  frame.name = name;
  if (input.size !== undefined) setNodeSizeFromInput(frame, input.size);
  if (input.position !== undefined) setNodePositionFromInput(frame, input.position);
  const firstExisting = existingFrames[0];
  const insertIndex = firstExisting ? children.indexOf(firstExisting) : -1;
  if (firstExisting && input.size === undefined) frame.resize(firstExisting.width, firstExisting.height);
  if (firstExisting && input.position === undefined) {
    frame.x = firstExisting.x;
    frame.y = firstExisting.y;
  }
  if (insertIndex >= 0 && "insertChild" in parent) parent.insertChild(insertIndex, frame);
  else parent.appendChild(frame);
  for (const existing of existingFrames) existing.remove();
  if (input.placement && input.placement.avoidOverlap) {
    await placeNodeForRepl(frame, { ...input.placement, size: nodeBounds(frame), exclude: frame });
  }
  if (input.as) remember(input.as, frame);
  const selection = input.select === false ? undefined : await selectNodesForRepl([frame], { zoom: input.zoom !== false, depth: 0 });
  return {
    replaced: existingFrames.map((node) => node.id),
    frame: summarizeNode(frame, input.depth || 0),
    selectedNodeIds: selection ? selection.selectedNodeIds : [],
    handle: input.as,
  };
}

async function cloneNodeTreeForRepl(targetOrOptions, maybeOptions = {}) {
  const looksLikeOptions = targetOrOptions && typeof targetOrOptions === "object" && !Array.isArray(targetOrOptions) && !("type" in targetOrOptions);
  const input = looksLikeOptions ? targetOrOptions : { source: targetOrOptions, ...maybeOptions };
  const sourceValue = input.source || input.target;
  const source = sourceValue && typeof sourceValue === "object" && "type" in sourceValue ? sourceValue : await $(sourceValue);
  if (!source || source.type === "DOCUMENT" || source.type === "PAGE") {
    throw new Error("$.cloneNodeTree source must resolve to a scene node.");
  }
  const parent = input.parent ? await $(input.parent) : source.parent;
  if (!parent || !("appendChild" in parent)) {
    throw new Error("$.cloneNodeTree requires a writable parent.");
  }
  const cloneLog = [];
  const fallbackWholeSubtrees = [];
  const preserveInstanceSubtrees = input.preserveInstanceSubtrees !== false;
  function getChildren(node) {
    return "children" in node ? Array.from(node.children) : [];
  }
  function cloneOuterToInner(sourceNode, depth = 0) {
    const clone = sourceNode.clone();
    clone.name = sourceNode.name;
    cloneLog.push({
      depth,
      sourceId: sourceNode.id,
      sourceName: sourceNode.name,
      sourceType: sourceNode.type,
      cloneId: clone.id,
    });
    if (preserveInstanceSubtrees && sourceNode.type === "INSTANCE") {
      fallbackWholeSubtrees.push({
        sourceId: sourceNode.id,
        sourceName: sourceNode.name,
        sourceType: sourceNode.type,
        cloneId: clone.id,
        reason: "Preserved instance subtree whole; Figma does not allow safe rebuild of internal instance children.",
      });
      return clone;
    }
    if ("children" in clone) {
      try {
        for (const child of Array.from(clone.children)) child.remove();
      } catch (error) {
        fallbackWholeSubtrees.push({
          sourceId: sourceNode.id,
          sourceName: sourceNode.name,
          sourceType: sourceNode.type,
          cloneId: clone.id,
          reason: error instanceof Error ? error.message : String(error),
        });
        return clone;
      }
    }
    if ("appendChild" in clone) {
      for (const sourceChild of getChildren(sourceNode)) {
        clone.appendChild(cloneOuterToInner(sourceChild, depth + 1));
      }
    }
    return clone;
  }
  const rootClone = cloneOuterToInner(source, 0);
  parent.appendChild(rootClone);
  if (input.name !== undefined) rootClone.name = String(input.name);
  if (input.position !== undefined) {
    setNodePositionFromInput(rootClone, input.position);
  } else if (input.offset !== undefined && "x" in rootClone && "y" in rootClone) {
    rootClone.x = source.x + readFiniteNumber(input.offset.x || 0, "offset.x");
    rootClone.y = source.y + readFiniteNumber(input.offset.y || 0, "offset.y");
  } else if (input.placement !== "none" && "x" in rootClone && "y" in rootClone) {
    const gap = input.gap === undefined ? 80 : readFiniteNumber(input.gap, "gap");
    const placement = input.placement || "right";
    if (placement === "left") {
      rootClone.x = source.x - rootClone.width - gap;
      rootClone.y = source.y;
    } else if (placement === "below") {
      rootClone.x = source.x;
      rootClone.y = source.y + source.height + gap;
    } else if (placement === "above") {
      rootClone.x = source.x;
      rootClone.y = source.y - rootClone.height - gap;
    } else {
      rootClone.x = source.x + source.width + gap;
      rootClone.y = source.y;
    }
  }
  if (input.as) remember(input.as, rootClone);
  const selection = input.select === false ? undefined : await selectNodesForRepl([rootClone], { zoom: input.zoom !== false, depth: 0 });
  return {
    source: summarizeNode(source, input.depth || 0),
    clone: summarizeNode(rootClone, input.depth || 0),
    copiedNodeCount: cloneLog.length,
    order: cloneLog,
    fallbackWholeSubtrees,
    selectedNodeIds: selection ? selection.selectedNodeIds : [],
    handle: input.as,
  };
}

function solidPaint(input, opacity = 1) {
  const color = normalizeRgb(input);
  return {
    type: "SOLID",
    color,
    opacity,
  };
}

function normalizePaintList(value) {
  if (Array.isArray(value)) {
    return value;
  }
  return [solidPaint(value)];
}

function normalizeRgb(input) {
  if (typeof input === "string") {
    const hex = input.replace(/^#/, "");
    if (!/^[0-9a-fA-F]{6}$/.test(hex)) {
      throw new Error("Expected a #RRGGBB color string.");
    }
    return {
      r: parseInt(hex.slice(0, 2), 16) / 255,
      g: parseInt(hex.slice(2, 4), 16) / 255,
      b: parseInt(hex.slice(4, 6), 16) / 255,
    };
  }
  if (input && typeof input === "object") {
    const scale = Math.max(input.r ?? 0, input.g ?? 0, input.b ?? 0) > 1 ? 255 : 1;
    return {
      r: Number(input.r ?? 0) / scale,
      g: Number(input.g ?? 0) / scale,
      b: Number(input.b ?? 0) / scale,
    };
  }
  throw new Error("Expected a color string or RGB object.");
}

function normalizeRgba(input) {
  const rgb = normalizeRgb(input);
  const alpha = input && typeof input === "object" && input.a !== undefined
    ? Number(input.a)
    : 1;
  return { ...rgb, a: alpha };
}

function resolveHandleId(nameOrId) {
  if (typeof nameOrId === "string" && nameOrId.startsWith("$")) {
    const id = __figmaRepl.handles[nameOrId];
    if (typeof id !== "string") {
      throw new Error("Unknown local handle: " + nameOrId);
    }
    return id;
  }
  if (typeof nameOrId !== "string" || !nameOrId) {
    throw new Error("Expected a non-empty handle or id string.");
  }
  return nameOrId;
}

function readFiniteNumber(value, name) {
  const number = Number(value);
  if (!Number.isFinite(number)) {
    throw new Error(name + " must be a finite number.");
  }
  return number;
}

function setNodeSizeFromInput(node, size) {
  const input = size && typeof size === "object" ? size : {};
  setNodeSize(node, readFiniteNumber(input.width, "size.width"), readFiniteNumber(input.height, "size.height"));
}

function setNodePositionFromInput(node, position) {
  const input = position && typeof position === "object" ? position : {};
  if (input.x !== undefined) node.x = readFiniteNumber(input.x, "position.x");
  if (input.y !== undefined) node.y = readFiniteNumber(input.y, "position.y");
}

function applyAppearance(node, appearance) {
  if (!appearance || typeof appearance !== "object") return;
  if (appearance.fills !== undefined) node.fills = normalizePaintList(appearance.fills);
  if (appearance.fill !== undefined) node.fills = normalizePaintList(appearance.fill);
  if (appearance.color !== undefined) node.fills = normalizePaintList(appearance.color);
  if (appearance.strokes !== undefined) node.strokes = normalizePaintList(appearance.strokes);
  if (appearance.stroke !== undefined) node.strokes = normalizePaintList(appearance.stroke);
  if (appearance.opacity !== undefined) node.opacity = readFiniteNumber(appearance.opacity, "appearance.opacity");
  if (appearance.strokeWeight !== undefined) node.strokeWeight = readFiniteNumber(appearance.strokeWeight, "appearance.strokeWeight");
  if (appearance.cornerRadius !== undefined && "cornerRadius" in node) {
    node.cornerRadius = readFiniteNumber(appearance.cornerRadius, "appearance.cornerRadius");
  }
  for (const key of ["topLeftRadius", "topRightRadius", "bottomLeftRadius", "bottomRightRadius"]) {
    if (appearance[key] !== undefined && key in node) node[key] = readFiniteNumber(appearance[key], "appearance." + key);
  }
  if (appearance.effects !== undefined) node.effects = appearance.effects;
  if (appearance.blendMode !== undefined) node.blendMode = appearance.blendMode;
}

function applyConstraints(node, constraints) {
  if (!constraints || typeof constraints !== "object") return;
  if (!("constraints" in node)) {
    throw new Error("Node does not support constraints: " + node.id);
  }
  node.constraints = {
    horizontal: constraints.horizontal ?? node.constraints.horizontal,
    vertical: constraints.vertical ?? node.constraints.vertical,
  };
}

function fontFromHelperInput(font) {
  const input = font && typeof font === "object" ? font : {};
  return {
    family: typeof input.family === "string" ? input.family : "Inter",
    style: typeof input.style === "string" ? input.style : "Regular",
  };
}

async function applyTextHelper(node, options) {
  if (node.type !== "TEXT") {
    throw new Error("Text helper can only apply to TEXT nodes.");
  }
  const font = fontFromHelperInput(options && options.font);
  await loadFont(font);
  node.fontName = font;
  if (options && options.font && typeof options.font === "object" && options.font.size !== undefined) {
    node.fontSize = readFiniteNumber(options.font.size, "font.size");
  }
  node.characters = String(options && options.text !== undefined ? options.text : "");
  if (options && options.style) {
    await applyStyleReference(node, options.style);
  }
}

function setNodeSize(node, width, height) {
  if (typeof node.resizeWithoutConstraints === "function") {
    node.resizeWithoutConstraints(width, height);
  } else if (typeof node.resize === "function") {
    node.resize(width, height);
  } else {
    throw new Error("Node does not support resize(): " + node.id);
  }
}

async function loadFont(font) {
  await figma.loadFontAsync(font);
  return font;
}

async function loadNodeFont(node) {
  if (node.fontName && typeof node.fontName === "object" && !Array.isArray(node.fontName)) {
    await figma.loadFontAsync(node.fontName);
    return node.fontName;
  }
  const fallback = { family: "Inter", style: "Regular" };
  await figma.loadFontAsync(fallback);
  node.fontName = fallback;
  return fallback;
}

function applyCollectionModes(collection, modes) {
  const result = {};
  const requested = Array.isArray(modes) ? modes : [];
  if (requested.length === 0) {
    for (const mode of collection.modes || []) result[mode.name] = mode.modeId;
    return result;
  }
  requested.forEach((mode, index) => {
    const name = typeof mode === "string" ? mode : String(mode && mode.name ? mode.name : "Mode " + (index + 1));
    if (index === 0 && collection.modes && collection.modes[0]) {
      collection.renameMode(collection.modes[0].modeId, name);
      result[name] = collection.modes[0].modeId;
    } else {
      result[name] = collection.addMode(name);
    }
  });
  return result;
}

async function resolveVariableCollection(handleOrId) {
  const id = resolveHandleId(handleOrId);
  if (figma.variables && typeof figma.variables.getVariableCollectionByIdAsync === "function") {
    const collection = await figma.variables.getVariableCollectionByIdAsync(id);
    if (collection) return collection;
  }
  if (figma.variables && typeof figma.variables.getVariableCollectionById === "function") {
    const collection = figma.variables.getVariableCollectionById(id);
    if (collection) return collection;
  }
  throw new Error("Variable collection not found: " + id);
}

async function resolveVariable(handleOrId) {
  const id = resolveHandleId(handleOrId);
  if (figma.variables && typeof figma.variables.getVariableByIdAsync === "function") {
    const variable = await figma.variables.getVariableByIdAsync(id);
    if (variable) return variable;
  }
  if (figma.variables && typeof figma.variables.getVariableById === "function") {
    const variable = figma.variables.getVariableById(id);
    if (variable) return variable;
  }
  throw new Error("Variable not found: " + id);
}

function resolveCollectionModeId(collection, modeNameOrId) {
  const modes = collection.modes || [];
  if (typeof modeNameOrId === "string" && modeNameOrId) {
    const exact = modes.find((mode) => mode.modeId === modeNameOrId || mode.name === modeNameOrId);
    if (!exact) throw new Error("Variable collection mode not found: " + modeNameOrId);
    return exact.modeId;
  }
  if (!modes[0]) throw new Error("Variable collection has no modes: " + collection.id);
  return modes[0].modeId;
}

function bindVariableToNode(node, variable, binding) {
  const field = binding && binding.field ? String(binding.field) : undefined;
  const paint = binding && binding.paint ? String(binding.paint) : undefined;
  if (paint === "fills" || field === "fills" || field === "fill" || field === "color") {
    const basePaint = Array.isArray(node.fills) && node.fills[0] ? node.fills[0] : solidPaint("#000000");
    node.fills = [figma.variables.setBoundVariableForPaint(basePaint, "color", variable)];
    return;
  }
  if (paint === "strokes" || field === "strokes" || field === "stroke") {
    const basePaint = Array.isArray(node.strokes) && node.strokes[0] ? node.strokes[0] : solidPaint("#000000");
    node.strokes = [figma.variables.setBoundVariableForPaint(basePaint, "color", variable)];
    return;
  }
  if (!field) {
    throw new Error("bindVariable requires field or paint.");
  }
  if (typeof node.setBoundVariable !== "function") {
    throw new Error("Node does not support setBoundVariable: " + node.id);
  }
  node.setBoundVariable(field, variable);
}

async function applyTextStyleHelper(style, options) {
  const font = fontFromHelperInput(options && options.font);
  await loadFont(font);
  style.fontName = font;
  if (options && options.fontSize !== undefined) style.fontSize = readFiniteNumber(options.fontSize, "fontSize");
  if (options && options.lineHeight !== undefined) style.lineHeight = options.lineHeight;
  if (options && options.letterSpacing !== undefined) style.letterSpacing = options.letterSpacing;
  if (options && options.fills !== undefined) style.fills = normalizePaintList(options.fills);
}

async function applyStyleReference(node, style) {
  if (!style || typeof style !== "object") return;
  if (style.textStyle || style.textStyleId) {
    node.textStyleId = resolveHandleId(style.textStyle || style.textStyleId);
  }
  if (style.fillStyle || style.fillStyleId) {
    node.fillStyleId = resolveHandleId(style.fillStyle || style.fillStyleId);
  }
  if (style.strokeStyle || style.strokeStyleId) {
    node.strokeStyleId = resolveHandleId(style.strokeStyle || style.strokeStyleId);
  }
  if (style.effectStyle || style.effectStyleId) {
    node.effectStyleId = resolveHandleId(style.effectStyle || style.effectStyleId);
  }
}

function summarizeNode(node, depth = 1) {
  if (!node) return null;
  if (Array.isArray(node)) return node.map((child) => summarizeNode(child, depth));
  const read = (key) => key in node ? node[key] : undefined;
  const summary = {
    id: node.id,
    type: node.type,
    name: node.name,
    visible: read("visible"),
    x: read("x"),
    y: read("y"),
    width: read("width"),
    height: read("height"),
    locked: read("locked"),
    layoutMode: read("layoutMode"),
    layoutPositioning: read("layoutPositioning"),
    characters: typeof read("characters") === "string" ? read("characters") : undefined,
    children: undefined,
  };
  if (depth > 0 && "children" in node && Array.isArray(node.children)) {
    summary.children = node.children.slice(0, 30).map((child) => summarizeNode(child, depth - 1));
  }
  return summary;
}

const __figmaReplEvalCheckpoints = [];
$.handles = __figmaRepl.handles;
$.remember = remember;
$.forget = forget;
$.resolveId = resolveHandleId;
$.node = $;
$.select = selectNodesForRepl;
$.cloneNodeTree = cloneNodeTreeForRepl;
$.findFreeSlot = findFreeSlotForRepl;
$.placeNode = placeNodeForRepl;
$.replaceGeneratedFrame = replaceGeneratedFrameForRepl;
$.text = async function text(targetOrOptions, textValue, options = {}) {
  const input = targetOrOptions && typeof targetOrOptions === "object" && !Array.isArray(targetOrOptions)
    ? targetOrOptions
    : { target: targetOrOptions, text: textValue, ...options };
  let node;
  if (input.target) {
    node = await $(input.target);
    if (node.type !== "TEXT") throw new Error("$.text target must resolve to a TEXT node.");
  } else {
    node = figma.createText();
    if (input.parent) {
      const parent = await $(input.parent);
      parent.appendChild(node);
    } else {
      figma.currentPage.appendChild(node);
    }
  }
  const font = input.font || (input.fontFamily || input.fontStyle ? { family: input.fontFamily || "Inter", style: input.fontStyle || "Regular" } : undefined);
  if (font) {
    const fontName = fontFromHelperInput(font);
    await loadFont(fontName);
    node.fontName = fontName;
    if (font.size !== undefined) node.fontSize = readFiniteNumber(font.size, "font.size");
  } else {
    await loadNodeFont(node);
  }
  if (input.text !== undefined) node.characters = String(input.text);
  if (input.name !== undefined) node.name = String(input.name);
  if (input.appearance !== undefined) applyAppearance(node, input.appearance);
  if (input.position !== undefined) setNodePositionFromInput(node, input.position);
  if (input.size !== undefined) setNodeSizeFromInput(node, input.size);
  if (input.as) remember(input.as, node);
  return node;
};
${includeEvalHelpers ? `
function __figmaReplDecodeBase64(input) {
  const source = String(input || "").replace(/^data:[^,]+,/u, "").replace(/\\s+/gu, "");
  if (!source) throw new Error("$.imageAsset requires a non-empty base64 string or bytes array.");
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  const clean = source.replace(/=+$/u, "");
  const bytes = [];
  let buffer = 0;
  let bits = 0;
  for (const char of clean) {
    const value = alphabet.indexOf(char);
    if (value < 0) throw new Error("$.imageAsset received invalid base64 data.");
    buffer = (buffer << 6) | value;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      bytes.push((buffer >> bits) & 0xff);
    }
  }
  return new Uint8Array(bytes);
}
$.imageAsset = async function imageAsset(options = {}) {
  const input = typeof options === "string" ? { base64: options } : (options || {});
  const bytes = input.bytes instanceof Uint8Array
    ? input.bytes
    : Array.isArray(input.bytes)
      ? new Uint8Array(input.bytes)
      : __figmaReplDecodeBase64(input.base64);
  const image = figma.createImage(bytes);
  const node = input.target ? await $(input.target) : figma.createRectangle();
  if (!("fills" in node)) throw new Error("$.imageAsset target must support fills.");
  if (!input.target) {
    if (input.parent) {
      const parent = await $(input.parent);
      parent.appendChild(node);
    } else {
      figma.currentPage.appendChild(node);
    }
  }
  if (input.name !== undefined) node.name = String(input.name);
  if (input.size !== undefined) {
    setNodeSizeFromInput(node, input.size);
  } else if (!input.target) {
    node.resize(160, 160);
  }
  if (input.position !== undefined) setNodePositionFromInput(node, input.position);
  const scaleMode = String(input.scaleMode || input.fit || "FILL").toUpperCase();
  if (!["FILL", "FIT", "CROP", "TILE"].includes(scaleMode)) {
    throw new Error("$.imageAsset scaleMode must be FILL, FIT, CROP, or TILE.");
  }
  const paint = { type: "IMAGE", scaleMode, imageHash: image.hash };
  if (input.opacity !== undefined) paint.opacity = readFiniteNumber(input.opacity, "opacity");
  node.fills = [paint];
  if (input.as) remember(input.as, node);
  return node;
};
$.inspect = async function inspect(target, depth = 1) {
  return summarizeNode(await $(target), depth);
};
$.capture = async function capture(target, options = {}) {
  const node = await $(target);
  if (!node || node.type === "DOCUMENT" || node.type === "PAGE") {
    throw new Error("$.capture target must resolve to a scene node.");
  }
  if (!options || typeof options !== "object" || Array.isArray(options)) {
    throw new Error("$.capture options must be an object.");
  }
  if (__figmaRepl.captureRequests.length >= ${MAX_QUEUED_CAPTURE_REQUESTS}) {
    throw new Error("$.capture supports at most ${MAX_QUEUED_CAPTURE_REQUESTS} requests per execution.");
  }
  const request = {
    requestId: "capture-" + String(__figmaRepl.captureRequests.length + 1),
    nodeId: node.id,
  };
  if (options.imageFile !== undefined) {
    if (
      typeof options.imageFile !== "string"
      || !options.imageFile
      || options.imageFile.includes("..")
      || /^[A-Za-z]:/.test(options.imageFile)
      || options.imageFile.charCodeAt(0) === 47
      || options.imageFile.charCodeAt(0) === 92
    ) {
      throw new Error("$.capture imageFile must be a safe workspace-relative path.");
    }
    request.imageFile = options.imageFile;
  }
  if (options.maxDimension !== undefined) {
    if (!Number.isInteger(options.maxDimension) || options.maxDimension < 1 || options.maxDimension > 65536) {
      throw new Error("$.capture maxDimension must be an integer from 1 to 65536.");
    }
    request.maxDimension = options.maxDimension;
  }
  if (options.contentsOnly !== undefined) {
    if (typeof options.contentsOnly !== "boolean") {
      throw new Error("$.capture contentsOnly must be a boolean.");
    }
    request.contentsOnly = options.contentsOnly;
  }
  __figmaRepl.captureRequests.push(request);
  return { requestId: request.requestId, nodeId: request.nodeId };
};
` : ""}
$.checkpoint = async function checkpoint(name, targets = [], options = {}) {
  const input = Array.isArray(targets) ? targets : [targets];
  const summaries = [];
  for (const target of input) summaries.push(summarizeNode(await $(target), options.depth ?? 1));
  const entry = { name: String(name || "checkpoint"), summaries, handles: { ...__figmaRepl.handles } };
  __figmaReplEvalCheckpoints.push(entry);
  return entry;
};
$.checkpoints = __figmaReplEvalCheckpoints;`;
  if (!includeEvalHelpers) {
    prelude = stripFigmaWorkspacePreludeEvalHelperAssignments(prelude);
    if (scriptInjectedHelpers) {
      prelude = stripFigmaWorkspacePreludeForScriptHelpers(prelude, new Set(scriptInjectedHelpers));
    }
  } else if (evalInjectedHelpers) {
    prelude = stripFigmaWorkspacePreludeForEvalHelpers(prelude, new Set(evalInjectedHelpers));
  }
  return prelude;
}

function stripFigmaWorkspacePreludeEvalHelperAssignments(source: string): string {
  return replaceDelimitedSource(
    source,
    "const __figmaReplEvalCheckpoints = [];",
    "$.checkpoints = __figmaReplEvalCheckpoints;",
    "",
    { includeEndMarker: true },
  );
}

function stripFigmaWorkspacePreludeForEvalHelpers(source: string, injectedHelpers: Set<string>): string {
  let prelude = source;
  const has = (helper: string) => injectedHelpers.has(`$.${helper}`);
  const removeLine = (line: string) => {
    prelude = prelude.replace(`${line}\n`, "");
  };
  const needsSelect = has("select") || has("cloneNodeTree") || has("replaceGeneratedFrame");
  const needsPlacement = has("findFreeSlot") || has("placeNode") || has("replaceGeneratedFrame");
  const needsPlaceNode = has("placeNode") || has("replaceGeneratedFrame");
  const needsReplaceGeneratedFrame = has("replaceGeneratedFrame");
  const needsClone = has("cloneNodeTree");
  const needsReadFiniteNumber = has("text") || has("imageAsset") || needsPlacement || needsClone;
  const needsSizeInput = has("text") || has("imageAsset") || needsReplaceGeneratedFrame;
  const needsPositionInput = has("text") || has("imageAsset") || needsReplaceGeneratedFrame || needsClone;
  const needsAppearance = has("text");
  const needsText = has("text");
  const needsResolveHandleId = has("resolveId") || has("node") || needsText;

  if (!needsSelect) prelude = replaceDelimitedSource(prelude, "async function selectNodesForRepl", "function resolveSceneNodeForPlacement", "");
  if (!needsPlacement) {
    prelude = replaceDelimitedSource(prelude, "function resolveSceneNodeForPlacement", "async function cloneNodeTreeForRepl", "");
  } else {
    if (!needsPlaceNode) prelude = replaceDelimitedSource(prelude, "async function placeNodeForRepl", "async function replaceGeneratedFrameForRepl", "");
    if (!needsReplaceGeneratedFrame) prelude = replaceDelimitedSource(prelude, "async function replaceGeneratedFrameForRepl", "async function cloneNodeTreeForRepl", "");
  }
  if (!needsClone) prelude = replaceDelimitedSource(prelude, "async function cloneNodeTreeForRepl", "function solidPaint", "");
  if (!needsAppearance) prelude = replaceDelimitedSource(prelude, "function solidPaint", "function resolveHandleId", "");
  else prelude = replaceDelimitedSource(prelude, "function normalizeRgba", "function resolveHandleId", "");
  if (!needsResolveHandleId) prelude = replaceDelimitedSource(prelude, "function resolveHandleId", "function readFiniteNumber", "");
  if (!needsReadFiniteNumber) prelude = replaceDelimitedSource(prelude, "function readFiniteNumber", "function setNodeSizeFromInput", "");
  if (!needsSizeInput) prelude = replaceDelimitedSource(prelude, "function setNodeSizeFromInput", "function setNodePositionFromInput", "");
  if (!needsPositionInput) prelude = replaceDelimitedSource(prelude, "function setNodePositionFromInput", "function applyAppearance", "");
  if (!needsAppearance) prelude = replaceDelimitedSource(prelude, "function applyAppearance", "function applyConstraints", "");
  prelude = replaceDelimitedSource(prelude, "function applyConstraints", "function fontFromHelperInput", "");
  if (!needsText) {
    prelude = replaceDelimitedSource(prelude, "function fontFromHelperInput", "function setNodeSize", "");
  } else {
    prelude = replaceDelimitedSource(prelude, "async function applyTextHelper", "function setNodeSize", "");
  }
  if (!needsSizeInput) prelude = replaceDelimitedSource(prelude, "function setNodeSize", "async function loadFont", "");
  if (!needsText) prelude = replaceDelimitedSource(prelude, "async function loadFont", "function applyCollectionModes", "");
  prelude = replaceDelimitedSource(prelude, "function applyCollectionModes", "async function applyStyleReference", "");
  if (!needsText) prelude = replaceDelimitedSource(prelude, "async function applyStyleReference", "function summarizeNode", "");

  if (!has("handles")) removeLine("$.handles = __figmaRepl.handles;");
  if (!has("remember")) removeLine("$.remember = remember;");
  if (!has("forget")) removeLine("$.forget = forget;");
  if (!has("resolveId")) removeLine("$.resolveId = resolveHandleId;");
  if (!has("node")) removeLine("$.node = $;");
  if (!has("select")) removeLine("$.select = selectNodesForRepl;");
  if (!has("cloneNodeTree")) removeLine("$.cloneNodeTree = cloneNodeTreeForRepl;");
  if (!has("findFreeSlot")) removeLine("$.findFreeSlot = findFreeSlotForRepl;");
  if (!has("placeNode")) removeLine("$.placeNode = placeNodeForRepl;");
  if (!has("replaceGeneratedFrame")) removeLine("$.replaceGeneratedFrame = replaceGeneratedFrameForRepl;");
  if (!has("text")) prelude = replaceDelimitedSource(prelude, "$.text = async function text", "function __figmaReplDecodeBase64", "");
  if (!has("imageAsset")) prelude = replaceDelimitedSource(prelude, "function __figmaReplDecodeBase64", "$.inspect = async function inspect", "");
  if (!has("inspect")) prelude = replaceDelimitedSource(prelude, "$.inspect = async function inspect", "$.capture = async function capture", "");
  if (!has("capture")) prelude = replaceDelimitedSource(prelude, "$.capture = async function capture", "$.checkpoint = async function checkpoint", "");
  if (!has("checkpoint")) {
    prelude = prelude.replace("const __figmaReplEvalCheckpoints = [];\n", "");
    prelude = replaceDelimitedSource(prelude, "$.checkpoint = async function checkpoint", "$.checkpoints = __figmaReplEvalCheckpoints;", "", { includeEndMarker: true });
  }
  return prelude;
}

function stripFigmaWorkspacePreludeForScriptHelpers(source: string, injectedHelpers: Set<string>): string {
  let prelude = source;
  const has = (helper: string) => injectedHelpers.has(`$.${helper}`);
  const needsSummary = has("select") || has("inspect") || has("cloneNodeTree") || has("checkpoint") || has("replaceGeneratedFrame");
  const needsReadFiniteNumber = has("text") || has("imageAsset") || has("cloneNodeTree") || has("placeNode") || has("findFreeSlot") || has("replaceGeneratedFrame");
  const needsSizeInput = has("text") || has("imageAsset") || has("replaceGeneratedFrame");
  const needsPositionInput = has("text") || has("imageAsset") || has("cloneNodeTree") || has("replaceGeneratedFrame");
  const needsAppearance = has("text");
  const needsText = has("text");
  const needsResolveHandleId = has("resolveId") || has("node") || needsText;

  prelude = replaceDelimitedSource(prelude, "async function selectNodesForRepl", "function solidPaint", "");
  if (!needsAppearance) prelude = replaceDelimitedSource(prelude, "function solidPaint", "function resolveHandleId", "");
  else prelude = replaceDelimitedSource(prelude, "function normalizeRgba", "function resolveHandleId", "");
  if (!needsResolveHandleId) prelude = replaceDelimitedSource(prelude, "function resolveHandleId", "function readFiniteNumber", "");
  if (!needsReadFiniteNumber) prelude = replaceDelimitedSource(prelude, "function readFiniteNumber", "function setNodeSizeFromInput", "");
  if (!needsSizeInput) prelude = replaceDelimitedSource(prelude, "function setNodeSizeFromInput", "function setNodePositionFromInput", "");
  if (!needsPositionInput) prelude = replaceDelimitedSource(prelude, "function setNodePositionFromInput", "function applyAppearance", "");
  if (!needsAppearance) prelude = replaceDelimitedSource(prelude, "function applyAppearance", "function applyConstraints", "");
  prelude = replaceDelimitedSource(prelude, "function applyConstraints", "function fontFromHelperInput", "");
  if (!needsText) {
    prelude = replaceDelimitedSource(prelude, "function fontFromHelperInput", "function setNodeSize", "");
  } else {
    prelude = replaceDelimitedSource(prelude, "async function applyTextHelper", "function setNodeSize", "");
  }
  if (!needsSizeInput) prelude = replaceDelimitedSource(prelude, "function setNodeSize", "async function loadFont", "");
  if (!needsText) prelude = replaceDelimitedSource(prelude, "async function loadFont", "function applyCollectionModes", "");
  prelude = replaceDelimitedSource(prelude, "function applyCollectionModes", "async function applyStyleReference", "");
  if (!needsText) prelude = replaceDelimitedSource(prelude, "async function applyStyleReference", "function summarizeNode", "");
  if (!needsSummary) prelude = replaceDelimitedSource(prelude, "function summarizeNode", "", "", { removeToEnd: true });
  return prelude;
}

function replaceDelimitedSource(
  source: string,
  startMarker: string,
  endMarker: string,
  replacement: string,
  options: { includeEndMarker?: boolean; removeToEnd?: boolean } = {},
): string {
  const start = source.indexOf(startMarker);
  if (start < 0) return source;
  const end = options.removeToEnd ? source.length : source.indexOf(endMarker, start + startMarker.length);
  if (end < 0 || end < start) return source;
  const endOffset = options.includeEndMarker ? endMarker.length : 0;
  return `${source.slice(0, start)}${replacement}${source.slice(end + endOffset)}`;
}

async function loadAssetManifest(
  args: FigmaWorkspaceApplyAssetManifestArguments,
  session: FigmaWorkspaceSession,
): Promise<NormalizedAssetManifest> {
  const manifestPath = resolveWorkspaceAwareFile(args.manifestPath, session, "manifestPath");
  const manifestValue = manifestPath ? await readAssetManifestValue(manifestPath) : undefined;
  const manifestRecord = asRecord(manifestValue);
  const manifestAssets = Array.isArray(manifestValue)
    ? manifestValue
    : Array.isArray(manifestRecord.assets)
      ? manifestRecord.assets
      : undefined;
  const inlineAssets = Array.isArray(args.assets) ? args.assets : undefined;
  const rawAssets = inlineAssets ?? manifestAssets;
  if (!rawAssets || rawAssets.length === 0) {
    throw new Error('Tool argument "assets" or "manifestPath" with assets is required.');
  }
  const baseDir = manifestPath ? dirname(manifestPath) : session.workspace?.sessionDir;
  if (manifestRecord.argumentsTemplate !== undefined) {
    throw new Error('Asset manifest field "argumentsTemplate" was removed. Use call-upstream-tool.');
  }
  if (manifestRecord.toolName !== undefined || manifestRecord.arguments !== undefined || manifestRecord.refresh !== undefined) {
    throw new Error('Asset manifest fields "toolName/arguments/refresh" were removed. Use call-upstream-tool.');
  }
  return {
    assets: rawAssets.map((asset, index) => normalizeManifestAsset(asset, index, baseDir, session)),
  };
}

class AssetManifestLoadError extends Error {
  readonly manifestPath: string;

  constructor(manifestPath: string, cause: unknown) {
    super(`Unable to read asset manifest "${manifestPath}": ${errorMessage(cause)}`);
    this.name = "AssetManifestLoadError";
    this.manifestPath = manifestPath;
  }
}

async function readAssetManifestValue(manifestPath: string): Promise<unknown> {
  try {
    return JSON.parse(await readFile(manifestPath, "utf8")) as unknown;
  } catch (error) {
    throw new AssetManifestLoadError(manifestPath, error);
  }
}

function assetManifestLoadDiagnostic(error: AssetManifestLoadError): FigmaWorkspaceDiagnostic {
  return {
    code: "FIGMA_WORKSPACE_ASSET_MANIFEST_LOAD_FAILED",
    severity: "fatal",
    message: error.message,
    suggestion: "Create the manifest file at the reported path or pass inline assets for one-off uploads; relative manifestPath values are resolved inside the initialized workspace.",
    docsHint: "Figma Workspace CLI: apply-asset-manifest --help",
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function normalizeManifestAsset(
  value: unknown,
  index: number,
  baseDir: string | undefined,
  session: FigmaWorkspaceSession,
): NormalizedAssetManifestAsset {
  const record = asRecord(value);
  assertRemovedManifestAssetFields(record, index);
  const rawPath = asOptionalString(record.path);
  if (!rawPath) {
    throw new Error(`Asset manifest entry ${index} requires path.`);
  }
  const path = resolveManifestAssetPath(rawPath, index, baseDir);
  if (!path) {
    throw new Error(`Asset manifest entry ${index} path must be absolute unless manifestPath is used.`);
  }
  const targetResolution = resolveSessionTargetInput(record.target, session);
  const resolvedTargetNodeId = targetResolution.nodeId;
  if (!resolvedTargetNodeId) {
    throw new Error(`Asset manifest entry ${index} requires target.`);
  }
  return {
    path,
    targetNodeId: resolvedTargetNodeId,
    handle: targetResolution.handle,
    fileKey: session.fileKey ?? extractFigmaFileKey(session.fileUrl),
    nodeUrl: asOptionalString(record.nodeUrl) ?? asOptionalString(record.url) ?? buildFigmaNodeUrl(session, resolvedTargetNodeId),
    scaleMode: asOptionalString(record.scaleMode),
    name: asOptionalString(record.name),
    metadata: recordFromUnknown(record.metadata),
  };
}

function resolveManifestAssetPath(rawPath: string, index: number, baseDir: string | undefined): string | undefined {
  if (isAbsolute(rawPath)) {
    return rawPath;
  }
  if (!baseDir) {
    return undefined;
  }
  const path = resolve(baseDir, rawPath);
  const relativePath = relative(baseDir, path);
  if (relativePath === ".." || relativePath.startsWith("../") || relativePath.startsWith("..\\") || isAbsolute(relativePath)) {
    throw new Error(`Asset manifest entry ${index} path must stay inside manifest directory.`);
  }
  return path;
}

function assertRemovedManifestAssetFields(record: Record<string, unknown>, index: number): void {
  const pathAliases = ["filePath", "localPath"].filter((field) => record[field] !== undefined);
  if (pathAliases.length > 0) {
    throw new Error(`Asset manifest entry ${index} field "${pathAliases.join("/")}" was removed. Use "path".`);
  }
  const targetAliases = ["targetNodeId", "nodeId", "targetHandle", "targetId"].filter((field) => record[field] !== undefined);
  if (targetAliases.length > 0) {
    throw new Error(`Asset manifest entry ${index} field "${targetAliases.join("/")}" was removed. Use "target".`);
  }
  const targetRecord = isRecord(record.target) ? record.target : undefined;
  if (targetRecord) {
    const nestedAliases = ["nodeId", "targetNodeId", "targetHandle", "targetId"].filter((field) => targetRecord[field] !== undefined);
    if (nestedAliases.length > 0) {
      throw new Error(`Asset manifest entry ${index} target field "${nestedAliases.join("/")}" was removed. Use "handle".`);
    }
  }
  if (record.toolName !== undefined || record.arguments !== undefined || record.refresh !== undefined) {
    throw new Error(`Asset manifest entry ${index} fields "toolName/arguments/refresh" were removed. Use call-upstream-tool.`);
  }
}

function selectRequiredUpstreamTool(
  tools: UpstreamToolInfo[],
  toolName: string,
  kind: string,
): UpstreamToolInfo {
  const tool = tools.find((item) => item.name === toolName);
  if (!tool) {
    throw new Error(
      `Required official upstream Figma MCP ${kind} tool "${toolName}" was not found. This may indicate upstream contract drift; use call-upstream-tool for explicit upstream debugging. Available tools: ${tools.map((item) => item.name).join(", ")}`,
    );
  }
  return tool;
}

function assertUpstreamToolHasProperty(
  tool: UpstreamToolInfo,
  propertyName: string,
  kind: string,
): void {
  if (upstreamToolHasProperty(tool, propertyName)) {
    return;
  }
  throw new Error(
    `Required official upstream Figma MCP ${kind} tool "${tool.name}" no longer advertises inputSchema.properties.${propertyName}. This may indicate upstream contract drift; use call-upstream-tool for explicit upstream debugging.`,
  );
}

function upstreamToolHasProperty(
  tool: UpstreamToolInfo,
  propertyName: string,
): boolean {
  const schema = isRecord(tool.inputSchema) ? tool.inputSchema : undefined;
  const properties = isRecord(schema?.properties) ? schema.properties : undefined;
  return Boolean(properties && propertyName in properties);
}

function assertUpstreamToolHasProperties(
  tool: UpstreamToolInfo,
  propertyNames: string[],
  kind: string,
): void {
  for (const propertyName of propertyNames) {
    assertUpstreamToolHasProperty(tool, propertyName, kind);
  }
}

function buildAssetManifestUpstreamArguments(options: {
  asset: NormalizedAssetManifestAsset;
  tool: UpstreamToolInfo;
}): Record<string, unknown> {
  if (options.tool.name === "upload_assets") {
    return buildUploadAssetsArguments(options.asset);
  }
  throw new Error(
    `Required official upstream Figma MCP asset upload/fill tool "${UPLOAD_ASSETS_TOOL_NAME}" was not available. This may indicate upstream contract drift; use call-upstream-tool for explicit upstream debugging.`,
  );
}

function buildUploadAssetsArguments(asset: NormalizedAssetManifestAsset): Record<string, unknown> {
  if (!asset.fileKey) {
    throw new Error(
      `Asset manifest entry for "${asset.path}" needs a fileKey for upload_assets. Open the session with file or use call-upstream-tool for explicit upstream debugging.`,
    );
  }
  const scaleMode = normalizeImageScaleMode(asset.scaleMode ?? "FILL", "scaleMode");
  return {
    fileKey: asset.fileKey,
    count: 1,
    nodeId: asset.targetNodeId,
    scaleMode,
  };
}

function buildCaptureUpstreamArguments(options: {
  fileKey: string;
  nodeId: string;
  tool: UpstreamToolInfo;
  passthroughArguments: Record<string, unknown>;
}): Record<string, unknown> {
  if (options.tool.name === "get_screenshot") {
    return removeUndefined({
      fileKey: options.fileKey,
      nodeId: options.nodeId,
      ...options.passthroughArguments,
    }) as Record<string, unknown>;
  }
  throw new Error(
    `Required official upstream Figma MCP node screenshot tool "${SCREENSHOT_TOOL_NAME}" was not available. This may indicate upstream contract drift; use call-upstream-tool for explicit upstream debugging.`,
  );
}

function readTemplatePath(context: Record<string, unknown>, path: string): unknown {
  const parts = path.split(".").filter(Boolean);
  let current: unknown = context;
  for (const part of parts) {
    if (!isRecord(current)) {
      return undefined;
    }
    current = current[part];
  }
  return current;
}

async function applyUploadedAssetFillsIfAvailable(options: {
  session: FigmaWorkspaceSession;
  runtime: {
    client: FigmaUpstreamMcpProxyClient;
    sessions: FigmaWorkspaceSessionStore;
    upstreamToolCache: ReturnType<typeof createUpstreamToolCache>;
  };
  tools: UpstreamToolInfo[];
  assetResults: Array<Record<string, unknown>>;
  assetDetails: Array<Record<string, unknown>>;
}): Promise<Record<string, unknown>> {
  const candidates = options.assetResults
    .map((asset, index) => {
      const targetNodeId = asOptionalString(asset.targetNodeId);
      const imageHash = extractAssetUploadImageHash(asset.upload);
      if (!targetNodeId || !imageHash) {
        return undefined;
      }
      const detail = options.assetDetails[index];
      const args = asRecord(detail?.arguments);
      return {
        targetNodeId,
        imageHash,
        scaleMode: normalizeImageScaleMode(asOptionalString(args.scaleMode) ?? "FILL", "scaleMode"),
      };
    })
    .filter((asset): asset is AssetManifestApplicationCandidate => asset !== undefined);

  if (candidates.length === 0) {
    return { ok: undefined, skipped: true, reason: "no uploaded imageHash" };
  }
  const hasEvalTool = options.tools.some((tool) => tool.name === DEFAULT_EVAL_TOOL_NAME);
  if (!hasEvalTool) {
    return {
      ok: undefined,
      skipped: true,
      reason: "no upstream eval tool advertised",
    };
  }
  try {
    const evalSettings = await resolveEvalSettings(options.session, {}, options.runtime);
    const applicationResult = await applyAssetManifestApplicationsInBatches({
      candidates,
      session: options.session,
      client: options.runtime.client,
      evalSettings,
    });
    if (applicationResult.upstreamError) {
      return {
        ok: false,
        error: responseUpstreamError(applicationResult.upstreamError),
        primaryFix: applicationResult.primaryFix,
      };
    }
    if (!applicationResult.found) {
      return {
        ok: undefined,
        reason: "application result did not include target records",
        applicationSource: "not-found",
        expectedCount: candidates.length,
        appliedCount: 0,
        failedCount: 0,
        missingApplicationCount: candidates.length,
        applications: [],
      };
    }
    const applications = applicationResult.applications;
    const failedCount = applications.filter((item) => item.status !== "applied").length;
    const appliedTargetNodeIds = new Set(applications.map((item) => asOptionalString(item.targetNodeId)).filter((nodeId): nodeId is string => nodeId !== undefined));
    const missingApplicationCount = candidates.filter((asset) => !appliedTargetNodeIds.has(asset.targetNodeId)).length;
    for (const asset of options.assetResults) {
      const targetNodeId = asOptionalString(asset.targetNodeId);
      const application = applications.find((item) => item.targetNodeId === targetNodeId);
      if (application) {
        asset.application = application;
      }
    }
    return {
      ok: missingApplicationCount === 0 ? failedCount === 0 : failedCount > 0 ? false : undefined,
      reason: missingApplicationCount > 0 ? "application result did not include every target record" : undefined,
      applicationSource: applicationResult.applicationSource,
      expectedCount: candidates.length,
      appliedCount: applications.length - failedCount,
      failedCount,
      missingApplicationCount,
      applications,
    };
  } catch (error) {
    return {
      ok: false,
      error: responseUpstreamError(normalizeCaughtUpstreamError(error)),
    };
  }
}

interface AssetManifestApplicationCandidate {
  targetNodeId: string;
  imageHash: string;
  scaleMode: string;
}

interface AssetManifestApplicationBatchResult {
  found: boolean;
  applicationSource?: string;
  applications: Record<string, unknown>[];
  upstreamError?: FigmaWorkspaceUpstreamError;
  primaryFix?: string;
}

async function applyAssetManifestApplicationsInBatches(options: {
  candidates: AssetManifestApplicationCandidate[];
  session: FigmaWorkspaceSession;
  client: FigmaUpstreamMcpProxyClient;
  evalSettings: EvalSettings;
}): Promise<AssetManifestApplicationBatchResult> {
  const applications: Record<string, unknown>[] = [];
  let found = true;
  let applicationSource = "batched";
  for (const chunk of chunkArray(options.candidates, FIGMA_ASSET_APPLICATION_BATCH_SIZE)) {
    const chunkResult = await applyAssetManifestApplicationChunk({ ...options, candidates: chunk });
    if (chunkResult.upstreamError) {
      return chunkResult;
    }
    if (!chunkResult.found) {
      found = false;
      applicationSource = chunkResult.applicationSource ?? "not-found";
      continue;
    }
    applications.push(...chunkResult.applications);
    applicationSource = chunkResult.applicationSource ?? applicationSource;
  }
  return { found, applicationSource, applications };
}

async function applyAssetManifestApplicationChunk(options: {
  candidates: AssetManifestApplicationCandidate[];
  session: FigmaWorkspaceSession;
  client: FigmaUpstreamMcpProxyClient;
  evalSettings: EvalSettings;
}): Promise<AssetManifestApplicationBatchResult> {
  const upstream = await callUpstreamEval(
    options.client,
    options.evalSettings,
    buildFigmaEvalScript({
      session: options.session,
      code: buildAssetManifestApplicationCode(options.candidates),
      mode: "write",
    }),
  );
  const parsed = parseUpstreamToolResult(upstream);
  if (parsed.upstreamError) {
    if (parsed.upstreamError.code === "FIGMA_UPSTREAM_TRUNCATED" && options.candidates.length > 1) {
      const midpoint = Math.ceil(options.candidates.length / 2);
      const left = await applyAssetManifestApplicationChunk({
        ...options,
        candidates: options.candidates.slice(0, midpoint),
      });
      if (left.upstreamError) return left;
      const right = await applyAssetManifestApplicationChunk({
        ...options,
        candidates: options.candidates.slice(midpoint),
      });
      if (right.upstreamError) return right;
      return {
        found: left.found && right.found,
        applicationSource: "batched",
        applications: [...left.applications, ...right.applications],
      };
    }
    return {
      found: false,
      applications: [],
      upstreamError: parsed.upstreamError,
      primaryFix: parsed.primaryFix,
    };
  }
  const applicationResult = findAssetManifestApplicationResult(parsed.json);
  if (!applicationResult) {
    return { found: false, applicationSource: "not-found", applications: [] };
  }
  const applications = Array.isArray(applicationResult.result.applications)
    ? applicationResult.result.applications.filter(isRecord)
    : [];
  return { found: true, applicationSource: applicationResult.sourcePath, applications };
}

function buildAssetManifestApplicationCode(candidates: AssetManifestApplicationCandidate[]): string {
  return `const assetFills = ${literal(candidates)};
const applications = [];
function compactName(name) {
  return typeof name === "string" && name.length > 120 ? name.slice(0, 117) + "..." : name;
}
for (const asset of assetFills) {
  try {
    const node = await getNodeById(asset.targetNodeId);
    if (!node) {
      applications.push({
        targetNodeId: asset.targetNodeId,
        status: "missing",
        message: "Node was not found"
      });
      continue;
    }
    if (!("fills" in node)) {
      applications.push({
        targetNodeId: asset.targetNodeId,
        status: "unsupported",
        nodeId: node.id,
        nodeType: node.type,
        name: compactName(node.name),
        message: "Node does not support fills"
      });
      continue;
    }
    node.fills = [{
      type: "IMAGE",
      imageHash: asset.imageHash,
      scaleMode: asset.scaleMode || "FILL"
    }];
    applications.push({
      targetNodeId: asset.targetNodeId,
      status: "applied",
      nodeId: node.id,
      nodeType: node.type,
      name: compactName(node.name),
      imageHash: asset.imageHash,
      scaleMode: asset.scaleMode || "FILL"
    });
  } catch (error) {
    applications.push({
      targetNodeId: asset.targetNodeId,
      status: "failed",
      message: error instanceof Error ? error.message : String(error)
    });
  }
}
return {
  applications,
  appliedCount: applications.filter((item) => item.status === "applied").length,
  failedCount: applications.filter((item) => item.status !== "applied").length
};`;
}

function extractAssetUploadImageHash(upload: unknown): string | undefined {
  const uploadRecord = asRecord(upload);
  const response = asRecord(uploadRecord.response);
  return asOptionalString(response.imageHash);
}

function findAssetManifestApplicationResult(
  value: unknown,
  depth = 0,
  sourcePath = "parsed.json",
): { result: Record<string, unknown>; sourcePath: string } | undefined {
  if (depth > 3) {
    return undefined;
  }
  if (typeof value === "string") {
    const parsed = parseJsonLenient(value);
    if (parsed !== undefined && parsed !== value) {
      return findAssetManifestApplicationResult(parsed, depth + 1, `${sourcePath}(json)`);
    }
    return undefined;
  }
  if (Array.isArray(value)) {
    if (value.some(isAssetManifestApplicationRecord)) {
      return { result: { applications: value.filter(isRecord) }, sourcePath };
    }
    for (let index = 0; index < value.length; index += 1) {
      const nested = findAssetManifestApplicationResult(value[index], depth + 1, `${sourcePath}[${index}]`);
      if (nested) {
        return nested;
      }
    }
    return undefined;
  }
  const record = asRecord(value);
  if (
    Array.isArray(record.applications) ||
    record.appliedCount !== undefined ||
    record.failedCount !== undefined
  ) {
    return { result: record, sourcePath };
  }
  const priorityKeys = ["result", "payload", "data", "structuredContent", "response", "output", "content", "text", "json"];
  for (const key of priorityKeys) {
    if (record[key] !== undefined) {
      const nested = findAssetManifestApplicationResult(record[key], depth + 1, `${sourcePath}.${key}`);
      if (nested) {
        return nested;
      }
    }
  }
  for (const [key, item] of Object.entries(record)) {
    if (priorityKeys.includes(key) || key === "__figmaRepl") {
      continue;
    }
    const nested = findAssetManifestApplicationResult(item, depth + 1, `${sourcePath}.${key}`);
    if (nested) {
      return nested;
    }
  }
  return undefined;
}

function isAssetManifestApplicationRecord(value: unknown): boolean {
  const record = asRecord(value);
  return asOptionalString(record.targetNodeId) !== undefined && asOptionalString(record.status) !== undefined;
}

async function validateAssetManifestTargetsIfAvailable(options: {
  args: FigmaWorkspaceApplyAssetManifestArguments;
  session: FigmaWorkspaceSession;
  runtime: {
    client: FigmaUpstreamMcpProxyClient;
    sessions: FigmaWorkspaceSessionStore;
    upstreamToolCache: ReturnType<typeof createUpstreamToolCache>;
  };
  tools: UpstreamToolInfo[];
  assetResults: Array<Record<string, unknown>>;
}): Promise<Record<string, unknown>> {
  if (options.args.validateTargets === false) {
    return { ok: undefined, skipped: true, reason: "validateTargets=false" };
  }
  const targetNodeIds = Array.from(new Set(
    options.assetResults
      .map((asset) => asOptionalString(asset.targetNodeId))
      .filter((nodeId): nodeId is string => nodeId !== undefined),
  ));
  if (targetNodeIds.length === 0) {
    return { ok: undefined, skipped: true, reason: "no targetNodeIds" };
  }
  const hasEvalTool = options.tools.some((tool) => tool.name === DEFAULT_EVAL_TOOL_NAME);
  if (!hasEvalTool) {
    return {
      ok: undefined,
      skipped: true,
      reason: "no upstream eval tool advertised",
    };
  }
  try {
    const evalSettings = await resolveEvalSettings(options.session, {}, options.runtime);
    const validationResult = await readAssetManifestTargetValidationsInBatches({
      targetNodeIds,
      session: options.session,
      client: options.runtime.client,
      evalSettings,
    });
    if (validationResult.upstreamError) {
      return {
        ok: false,
        error: responseUpstreamError(validationResult.upstreamError),
        primaryFix: validationResult.primaryFix,
      };
    }
    if (!validationResult.found) {
      return {
        ok: undefined,
        skipped: true,
        reason: "validation result did not include target records",
        validationSource: "not-found",
        expectedCount: targetNodeIds.length,
        validCount: 0,
        invalidCount: 0,
        missingValidationCount: targetNodeIds.length,
        validations: [],
      };
    }
    const validations = validationResult.validations;
    const invalidCount = validations.filter((item) => item.status !== "valid").length;
    const validatedTargetNodeIds = new Set(validations.map((item) => asOptionalString(item.targetNodeId)).filter((nodeId): nodeId is string => nodeId !== undefined));
    const missingValidationCount = targetNodeIds.filter((targetNodeId) => !validatedTargetNodeIds.has(targetNodeId)).length;
    for (const asset of options.assetResults) {
      const targetNodeId = asOptionalString(asset.targetNodeId);
      const validation = validations.find((item) => item.targetNodeId === targetNodeId);
      if (validation) {
        asset.validation = validation;
      }
    }
    return {
      ok: missingValidationCount === 0 ? invalidCount === 0 : invalidCount > 0 ? false : undefined,
      reason: missingValidationCount > 0 ? "validation result did not include every target record" : undefined,
      validationSource: validationResult.validationSource,
      expectedCount: targetNodeIds.length,
      validCount: validations.length - invalidCount,
      invalidCount,
      missingValidationCount,
      validations,
    };
  } catch (error) {
    return {
      ok: false,
      error: responseUpstreamError(normalizeCaughtUpstreamError(error)),
    };
  }
}

interface AssetManifestTargetValidationBatchResult {
  found: boolean;
  validationSource?: string;
  validations: Record<string, unknown>[];
  upstreamError?: FigmaWorkspaceUpstreamError;
  primaryFix?: string;
}

async function readAssetManifestTargetValidationsInBatches(options: {
  targetNodeIds: string[];
  session: FigmaWorkspaceSession;
  client: FigmaUpstreamMcpProxyClient;
  evalSettings: EvalSettings;
}): Promise<AssetManifestTargetValidationBatchResult> {
  const validations: Record<string, unknown>[] = [];
  let found = true;
  let validationSource = "batched";
  for (const chunk of chunkArray(options.targetNodeIds, FIGMA_ASSET_VALIDATION_BATCH_SIZE)) {
    const chunkResult = await readAssetManifestTargetValidationChunk({ ...options, targetNodeIds: chunk });
    if (chunkResult.upstreamError) {
      return chunkResult;
    }
    if (!chunkResult.found) {
      found = false;
      validationSource = chunkResult.validationSource ?? "not-found";
      continue;
    }
    validations.push(...chunkResult.validations);
    validationSource = chunkResult.validationSource ?? validationSource;
  }
  return { found, validationSource, validations };
}

async function readAssetManifestTargetValidationChunk(options: {
  targetNodeIds: string[];
  session: FigmaWorkspaceSession;
  client: FigmaUpstreamMcpProxyClient;
  evalSettings: EvalSettings;
}): Promise<AssetManifestTargetValidationBatchResult> {
  const upstream = await callUpstreamEval(
    options.client,
    options.evalSettings,
    buildFigmaEvalScript({
      session: options.session,
      code: buildAssetManifestTargetValidationCode(options.targetNodeIds),
      mode: "read",
    }),
  );
  const parsed = parseUpstreamToolResult(upstream);
  if (parsed.upstreamError) {
    if (parsed.upstreamError.code === "FIGMA_UPSTREAM_TRUNCATED" && options.targetNodeIds.length > 1) {
      const midpoint = Math.ceil(options.targetNodeIds.length / 2);
      const left = await readAssetManifestTargetValidationChunk({ ...options, targetNodeIds: options.targetNodeIds.slice(0, midpoint) });
      if (left.upstreamError) return left;
      const right = await readAssetManifestTargetValidationChunk({ ...options, targetNodeIds: options.targetNodeIds.slice(midpoint) });
      if (right.upstreamError) return right;
      return {
        found: left.found && right.found,
        validationSource: "batched",
        validations: [...left.validations, ...right.validations],
      };
    }
    return { found: false, validations: [], upstreamError: parsed.upstreamError, primaryFix: parsed.primaryFix };
  }
  const validationResult = findAssetManifestValidationResult(parsed.json);
  if (!validationResult) {
    return { found: false, validationSource: "not-found", validations: [] };
  }
  const validations = Array.isArray(validationResult.result.validations)
    ? validationResult.result.validations.filter(isRecord)
    : [];
  return { found: true, validationSource: validationResult.sourcePath, validations };
}

function buildAssetManifestTargetValidationCode(targetNodeIds: string[]): string {
  return `const targetNodeIds = ${literal(targetNodeIds)};
const validations = [];
for (const targetNodeId of targetNodeIds) {
  try {
    const node = await getNodeById(targetNodeId);
    if (!node) {
      validations.push({
        targetNodeId,
        status: "missing",
        message: "Node was not found"
      });
      continue;
    }
    const fills = "fills" in node && Array.isArray(node.fills) ? node.fills : [];
    const imageFills = fills.filter((paint) => paint && paint.type === "IMAGE" && typeof paint.imageHash === "string" && paint.imageHash.length > 0);
    validations.push({
      targetNodeId,
      status: imageFills.length > 0 ? "valid" : "missing-image-fill",
      nodeId: node.id,
      nodeType: node.type,
      name: node.name,
      fillCount: fills.length,
      imageFillCount: imageFills.length
    });
  } catch (error) {
    validations.push({
      targetNodeId,
      status: "missing",
      message: error instanceof Error ? error.message : String(error)
    });
  }
}
return {
  validations,
  validCount: validations.filter((item) => item.status === "valid").length,
  invalidCount: validations.filter((item) => item.status !== "valid").length
};`;
}

function findAssetManifestValidationResult(
  value: unknown,
  depth = 0,
  sourcePath = "parsed.json",
): { result: Record<string, unknown>; sourcePath: string } | undefined {
  if (depth > 3) {
    return undefined;
  }
  if (typeof value === "string") {
    const parsed = parseJsonLenient(value);
    if (parsed !== undefined && parsed !== value) {
      return findAssetManifestValidationResult(parsed, depth + 1, `${sourcePath}(json)`);
    }
    return undefined;
  }
  if (Array.isArray(value)) {
    if (value.some(isAssetManifestValidationRecord)) {
      return { result: { validations: value.filter(isRecord) }, sourcePath };
    }
    for (let index = 0; index < value.length; index += 1) {
      const nested = findAssetManifestValidationResult(value[index], depth + 1, `${sourcePath}[${index}]`);
      if (nested) {
        return nested;
      }
    }
    return undefined;
  }
  const record = asRecord(value);
  if (
    Array.isArray(record.validations) ||
    record.validCount !== undefined ||
    record.invalidCount !== undefined
  ) {
    return { result: record, sourcePath };
  }
  const priorityKeys = ["result", "payload", "data", "structuredContent", "response", "output", "content", "text", "json"];
  for (const key of priorityKeys) {
    if (record[key] !== undefined) {
      const nested = findAssetManifestValidationResult(record[key], depth + 1, `${sourcePath}.${key}`);
      if (nested) {
        return nested;
      }
    }
  }
  for (const [key, item] of Object.entries(record)) {
    if (priorityKeys.includes(key) || key === "__figmaRepl") {
      continue;
    }
    const nested = findAssetManifestValidationResult(item, depth + 1, `${sourcePath}.${key}`);
    if (nested) {
      return nested;
    }
  }
  return undefined;
}

function isAssetManifestValidationRecord(value: unknown): boolean {
  const record = asRecord(value);
  return asOptionalString(record.targetNodeId) !== undefined && asOptionalString(record.status) !== undefined;
}

async function submitLocalAssetUploadIfAvailable(
  asset: NormalizedAssetManifestAsset,
  parsed: ParsedUpstreamToolResult,
): Promise<Record<string, unknown> | undefined> {
  const submitUrl = extractAssetSubmitUrl(parsed.json);
  if (!submitUrl) {
    return undefined;
  }
  const bytes = await readFile(asset.path);
  const mimeType = mimeTypeForAssetPath(asset.path);
  const response = await fetch(submitUrl, {
    method: "POST",
    headers: { "Content-Type": mimeType },
    body: bytes,
  });
  const text = await response.text();
  const json = parseJsonLenient(text);
  if (!response.ok) {
    return {
      ok: false,
      status: response.status,
      statusText: response.statusText,
      mimeType,
      bytes: bytes.byteLength,
      response: summarizeUploadResponse(text, json),
    };
  }
  return {
    ok: true,
    status: response.status,
    statusText: response.statusText,
    mimeType,
    bytes: bytes.byteLength,
    response: summarizeUploadResponse(text, json),
  };
}

function extractAssetSubmitUrl(value: unknown): string | undefined {
  const record = asRecord(value);
  if (isRecord(record.result)) {
    const nestedUrl = extractAssetSubmitUrl(record.result);
    if (nestedUrl) {
      return nestedUrl;
    }
  }
  const uploads = Array.isArray(record.uploads) ? record.uploads : [];
  for (const upload of uploads) {
    const uploadRecord = asRecord(upload);
    const submitUrl =
      asOptionalString(uploadRecord.submitUrl) ??
      asOptionalString(uploadRecord.uploadUrl) ??
      asOptionalString(uploadRecord.url);
    if (submitUrl) {
      return submitUrl;
    }
  }
  return undefined;
}

function mimeTypeForAssetPath(path: string): string {
  const lower = path.toLowerCase();
  if (lower.endsWith(".jpg") || lower.endsWith(".jpeg")) {
    return "image/jpeg";
  }
  if (lower.endsWith(".gif")) {
    return "image/gif";
  }
  if (lower.endsWith(".webp")) {
    return "image/webp";
  }
  return "image/png";
}

function normalizeImageScaleMode(value: string, name: string): string {
  const normalized = String(value || "FILL").toUpperCase();
  if (!["FILL", "FIT", "CROP", "TILE"].includes(normalized)) {
    throw new Error(`${name} must be FILL, FIT, CROP, or TILE.`);
  }
  return normalized;
}

function summarizeUploadResponse(text: string, json: unknown): unknown {
  if (json !== undefined) {
    return json;
  }
  return text.slice(0, 500);
}

async function runTaskPlanStep(options: {
  id: string;
  step: FigmaWorkspaceTaskPlanStep;
  type: string;
  sessionId?: string;
  references?: TaskPlanReferenceContext;
  runtime: FigmaWorkspaceRuntime;
}): Promise<Record<string, unknown>> {
  const rawStepArgs = expandTaskPlanStepReferences(
    taskPlanStepArguments(options.step),
    options.references,
  );
  const commonArgs = {
    sessionId: asOptionalString(rawStepArgs.sessionId) ?? options.sessionId,
  };
  const session = options.runtime.sessions.getOrCreate(commonArgs.sessionId);
  const stepArgs = withTaskPlanDefaultFiles(rawStepArgs, options.type, options.id, session);
  if (options.type === "script-file") {
    return executeRunScriptFile(
      asRunScriptFileArgs({ ...commonArgs, ...stepArgs }),
      options.runtime,
    );
  }
  if (options.type === "asset-manifest") {
    return executeApplyAssetManifest(
      asApplyAssetManifestArgs({ ...commonArgs, ...stepArgs }),
      options.runtime,
    );
  }
  if (options.type === "download-assets") {
    return executeDownloadAssets(
      asDownloadAssetsArgs({ ...commonArgs, ...stepArgs }),
      options.runtime,
    );
  }
  if (options.type === "screenshot-capture") {
    return executeCaptureNode(
      asCaptureNodeArgs({ ...commonArgs, ...stepArgs }),
      options.runtime,
    );
  }
  if (options.type === "upstream-tool") {
    return executeCallUpstreamTool(
      asCallUpstreamToolArgs({ ...commonArgs, ...stepArgs }),
      options.runtime,
    );
  }
  throw new Error(`Unsupported run-task-plan step type "${options.type}".`);
}

function taskPlanStepArguments(step: FigmaWorkspaceTaskPlanStep): Record<string, unknown> {
  return asRecord(step.args);
}

function expandTaskPlanStepReferences(
  args: Record<string, unknown>,
  references: TaskPlanReferenceContext | undefined,
): Record<string, unknown> {
  if (!references) {
    return args;
  }
  return expandTaskPlanReferenceValue(args, {
    steps: references.steps,
    outputs: references.outputs,
    last: references.last,
  }) as Record<string, unknown>;
}

function expandTaskPlanReferenceValue(value: unknown, context: Record<string, unknown>): unknown {
  if (typeof value === "string") {
    const exact = /^\{\{\s*([^}]+?)\s*\}\}$/u.exec(value);
    if (exact) {
      const path = exact[1].trim();
      return isTaskPlanReferencePath(path) ? readTemplatePath(context, path) : value;
    }
    return value.replace(/\{\{\s*([^}]+?)\s*\}\}/gu, (match, rawPath: string) => {
      const path = rawPath.trim();
      if (!isTaskPlanReferencePath(path)) {
        return match;
      }
      const resolved = readTemplatePath(context, path);
      if (resolved === undefined || resolved === null) {
        return "";
      }
      return typeof resolved === "string" ? resolved : JSON.stringify(resolved);
    });
  }
  if (Array.isArray(value)) {
    return value.map((item) => expandTaskPlanReferenceValue(item, context));
  }
  if (isRecord(value)) {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, expandTaskPlanReferenceValue(item, context)]),
    );
  }
  return value;
}

function isTaskPlanReferencePath(path: string): boolean {
  return /^(?:outputs|steps|last)(?:\.|$)/u.test(path);
}

function runScriptUpstreamPayload(result: Record<string, unknown>): unknown {
  const upstream = asRecord(result.upstream);
  return upstream.kind === "json" ? upstream.result : undefined;
}

function createTaskPlanStepReference(options: {
  id: string;
  index: number;
  type: string;
  status: string;
  ok: boolean;
  result: Record<string, unknown>;
}): Record<string, unknown> {
  const outputFiles = asRecord(options.result.outputFiles);
  const debugFile = asOptionalString(options.result.debugFile);
  const imageFile = asOptionalString(options.result.imageFile);
  const upstream = asRecord(options.result.upstream);
  const upstreamPayload = runScriptUpstreamPayload(options.result);
  const result = asRecord(upstreamPayload);
  const nestedResult = isRecord(result.result) ? asRecord(result.result) : result;
  const session = asRecord(options.result.session);
  const handles =
    isRecord(session.handles) ? session.handles :
      isRecord(result.handles) ? result.handles :
        isRecord(nestedResult.handles) ? nestedResult.handles :
          undefined;
  return {
    id: options.id,
    index: options.index,
    type: options.type,
    status: options.status,
    ok: options.ok,
    upstream: Object.keys(upstream).length > 0 ? upstream : undefined,
    nodeIds: collectNodeIds(options.result),
    handles,
    assets: options.result.assets,
    downloadTargets: options.result.targets,
    downloadOutputDir: options.result.outputDir,
    validation: options.result.validation,
    assetTargets: nestedResult.assetTargets,
    captureTarget: nestedResult.captureTarget,
    createdNodeId: nestedResult.createdNodeId,
    debugFile,
    imageFile,
    outputFiles: Object.keys(outputFiles).length > 0 ? outputFiles : undefined,
    debugFilePath: asOptionalString(asRecord(outputFiles.debugFile).path) ?? debugFile,
  };
}

function taskPlanStepOutputReferences(reference: Record<string, unknown>): Record<string, unknown> | undefined {
  const outputFiles = asRecord(reference.outputFiles);
  if (Object.keys(outputFiles).length > 0) {
    return outputFiles;
  }
  const debugFile = asOptionalString(reference.debugFile);
  if (debugFile) {
    return { debugFile };
  }
  const imageFile = asOptionalString(reference.imageFile);
  return imageFile ? { imageFile } : undefined;
}

function normalizeTaskPlanStepType(step: FigmaWorkspaceTaskPlanStep): string {
  const value = asOptionalString(step.type);
  return normalizeTaskPlanStepTypeAlias(value);
}

function taskPlanStepSucceeded(result: Record<string, unknown>): boolean {
  if (result.ok === false) {
    return false;
  }
  return true;
}

function summarizeTaskPlanStepResult(result: Record<string, unknown>): Record<string, unknown> {
  return {
    ok: result.ok !== false,
    debugFile: result.debugFile,
    imageFile: result.imageFile,
    files: result.files ?? result.outputFiles,
    failures: Array.isArray(result.failures) ? result.failures.length : undefined,
    diagnostics: Array.isArray(result.diagnostics) ? result.diagnostics.length : undefined,
  };
}

interface ParsedMetadataXmlElement {
  tag: string;
  attributes: Record<string, string>;
  children: ParsedMetadataXmlElement[];
}

function metadataXmlFromParsedResult(parsed: ParsedUpstreamToolResult): string | undefined {
  const text = parsed.text.trim();
  const start = text.indexOf("<");
  if (start < 0) {
    return undefined;
  }
  return text.slice(start);
}

async function enrichMetadataJson(
  metadata: FigmaWorkspaceMetadataJson,
  session: FigmaWorkspaceSession,
  runtime: {
    client: FigmaUpstreamMcpProxyClient;
    upstreamToolCache: ReturnType<typeof createUpstreamToolCache>;
  },
): Promise<FigmaWorkspaceMetadataEnrichmentResult> {
  const nodeIds = metadata.root ? collectMetadataTreeNodeIds(metadata.root) : [];
  if (nodeIds.length === 0) {
    return emptyMetadataEnrichment();
  }
  try {
    const evalSettings = await resolveEvalSettings(session, {}, runtime);
    const nativeFieldsByNodeId = await readMetadataNativeFieldsInBatches({
      nodeIds,
      session,
      client: runtime.client,
      evalSettings,
    });
    const enrichedNodeCount = metadata.root
      ? mergeMetadataNativeFields(metadata.root, nativeFieldsByNodeId)
      : 0;
    return {
      summary: {
        ok: true,
        source: "use_figma",
        requestedNodeCount: nodeIds.length,
        enrichedNodeCount,
        fields: [...FIGMA_METADATA_ENRICHMENT_FIELDS],
      },
      diagnostics: [],
    };
  } catch (error) {
    if (isFigmaWorkspaceUpstreamErrorLike(error)) {
      return failedMetadataEnrichment(
        nodeIds.length,
        error.message,
        error.code ?? "FIGMA_METADATA_ENRICHMENT_FAILED",
        responseUpstreamError(error),
      );
    }
    const message = error instanceof Error ? error.message : String(error);
    return failedMetadataEnrichment(nodeIds.length, message, "FIGMA_METADATA_ENRICHMENT_FAILED");
  }
}

function isFigmaWorkspaceUpstreamErrorLike(value: unknown): value is FigmaWorkspaceUpstreamError {
  return isRecord(value) && typeof value.message === "string";
}

function emptyMetadataEnrichment(): FigmaWorkspaceMetadataEnrichmentResult {
  return { diagnostics: [] };
}

function failedMetadataEnrichment(
  requestedNodeCount: number,
  message: string,
  code: string,
  details?: Record<string, unknown>,
): FigmaWorkspaceMetadataEnrichmentResult {
  const warning = removeUndefined({
    code,
    message,
    details,
  }) as Record<string, unknown>;
  return {
    summary: {
      ok: false,
      source: "use_figma",
      requestedNodeCount,
      enrichedNodeCount: 0,
      fields: [...FIGMA_METADATA_ENRICHMENT_FIELDS],
      warning,
    },
    diagnostics: [
      {
        code: "FIGMA_METADATA_ENRICHMENT_FAILED",
        severity: "warning",
        message: `Metadata XML conversion succeeded, but native layout-state enrichment failed: ${message}`,
        suggestion: "Use inspect or eval for targeted lock/layout readback if these fields are required.",
        docsHint: "get-metadata enrichment",
      },
    ],
  };
}

async function readMetadataNativeFieldsInBatches(options: {
  nodeIds: string[];
  session: FigmaWorkspaceSession;
  client: FigmaUpstreamMcpProxyClient;
  evalSettings: EvalSettings;
}): Promise<Map<string, FigmaWorkspaceMetadataNativeFields>> {
  const fieldsByNodeId = new Map<string, FigmaWorkspaceMetadataNativeFields>();
  for (const chunk of chunkArray(options.nodeIds, FIGMA_METADATA_ENRICHMENT_BATCH_SIZE)) {
    const chunkFields = await readMetadataNativeFieldsChunk({
      nodeIds: chunk,
      session: options.session,
      client: options.client,
      evalSettings: options.evalSettings,
    });
    for (const [nodeId, fields] of chunkFields) {
      fieldsByNodeId.set(nodeId, fields);
    }
  }
  return fieldsByNodeId;
}

async function readMetadataNativeFieldsChunk(options: {
  nodeIds: string[];
  session: FigmaWorkspaceSession;
  client: FigmaUpstreamMcpProxyClient;
  evalSettings: EvalSettings;
}): Promise<Map<string, FigmaWorkspaceMetadataNativeFields>> {
  const upstream = await callUpstreamEval(
    options.client,
    options.evalSettings,
    buildFigmaEvalScript({
      session: options.session,
      mode: "read",
      includeEvalHelpers: false,
      code: buildMetadataEnrichmentReadbackCode(options.nodeIds),
    }),
  );
  const parsed = parseUpstreamToolResult(upstream);
  if (!parsed.upstreamError) {
    return metadataNativeFieldsByNodeId(parsed.json);
  }
  if (parsed.upstreamError.code === "FIGMA_UPSTREAM_TRUNCATED" && options.nodeIds.length > 1) {
    const midpoint = Math.ceil(options.nodeIds.length / 2);
    const left = await readMetadataNativeFieldsChunk({
      ...options,
      nodeIds: options.nodeIds.slice(0, midpoint),
    });
    const right = await readMetadataNativeFieldsChunk({
      ...options,
      nodeIds: options.nodeIds.slice(midpoint),
    });
    return new Map([...left, ...right]);
  }
  throw parsed.upstreamError;
}

function chunkArray<T>(values: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let index = 0; index < values.length; index += size) {
    chunks.push(values.slice(index, index + size));
  }
  return chunks;
}

function buildMetadataEnrichmentReadbackCode(nodeIds: string[]): string {
  return [
    `const __metadataNodeIds = ${literal(nodeIds)};`,
    `const __metadataFields = ${literal([...FIGMA_METADATA_ENRICHMENT_FIELDS])};`,
    "async function __metadataGetNodeById(__id) {",
    "  if (figma && typeof figma.getNodeByIdAsync === 'function') return await figma.getNodeByIdAsync(__id);",
    "  if (figma && typeof figma.getNodeById === 'function') return figma.getNodeById(__id);",
    "  return null;",
    "}",
    "function __metadataReadSupportedFields(__node) {",
    "  const __out = {};",
    "  for (const __field of __metadataFields) {",
    "    if (!(__field in __node)) continue;",
    "    const __value = __node[__field];",
    "    if (__value === undefined || typeof __value === 'function' || typeof __value === 'symbol') continue;",
    "    if (__value === null || typeof __value === 'string' || typeof __value === 'number' || typeof __value === 'boolean') {",
    "      __out[__field] = __value;",
    "    }",
    "  }",
    "  return __out;",
    "}",
    "const __metadataNodes = {};",
    "for (const __id of __metadataNodeIds) {",
    "  const __node = await __metadataGetNodeById(__id);",
    "  if (!__node) continue;",
    "  const __fields = __metadataReadSupportedFields(__node);",
    "  if (Object.keys(__fields).length > 0) __metadataNodes[__id] = __fields;",
    "}",
    "return { enrichment: { requestedNodeCount: __metadataNodeIds.length, fields: __metadataFields, nodes: __metadataNodes } };",
  ].join("\n");
}

function collectMetadataTreeNodeIds(root: FigmaWorkspaceMetadataTreeNode): string[] {
  const ids = new Set<string>();
  const visit = (node: FigmaWorkspaceMetadataTreeNode) => {
    if (node.nodeId) {
      ids.add(node.nodeId);
    }
    for (const child of Array.isArray(node.children) ? node.children : []) {
      visit(child);
    }
  };
  visit(root);
  return [...ids];
}

function metadataNativeFieldsByNodeId(value: unknown): Map<string, FigmaWorkspaceMetadataNativeFields> {
  const record = asRecord(value);
  const result = asRecord(record.result);
  const enrichment = asRecord(result.enrichment ?? record.enrichment);
  const nodes = asRecord(enrichment.nodes);
  const fieldsByNodeId = new Map<string, FigmaWorkspaceMetadataNativeFields>();
  for (const [nodeId, nodeValue] of Object.entries(nodes)) {
    const nodeRecord = asRecord(nodeValue);
    const fields: FigmaWorkspaceMetadataNativeFields = {};
    for (const field of FIGMA_METADATA_ENRICHMENT_FIELDS) {
      const value = nodeRecord[field];
      if (isMetadataEnrichmentValue(value)) {
        fields[field] = value;
      }
    }
    if (Object.keys(fields).length > 0) {
      fieldsByNodeId.set(nodeId, fields);
    }
  }
  return fieldsByNodeId;
}

function mergeMetadataNativeFields(
  node: FigmaWorkspaceMetadataTreeNode,
  fieldsByNodeId: Map<string, FigmaWorkspaceMetadataNativeFields>,
): number {
  let enrichedNodeCount = 0;
  const fields = node.nodeId ? fieldsByNodeId.get(node.nodeId) : undefined;
  if (fields) {
    Object.assign(node, fields);
    enrichedNodeCount += 1;
  }
  for (const child of Array.isArray(node.children) ? node.children : []) {
    enrichedNodeCount += mergeMetadataNativeFields(child, fieldsByNodeId);
  }
  return enrichedNodeCount;
}

function isMetadataEnrichmentValue(value: unknown): value is FigmaWorkspaceMetadataEnrichmentValue {
  return value === null || typeof value === "string" || typeof value === "number" || typeof value === "boolean";
}

function metadataJsonFromXml(
  xml: string,
  fileKey: string,
  nodeId: string | undefined,
): FigmaWorkspaceMetadataJson {
  const root = parseMetadataXml(xml);
  const tree = root ? metadataTreeFromXmlElement(root) : undefined;
  const nodeCount = tree ? countMetadataTreeNodes(tree) : 0;
  return removeUndefined({
    format: "figma-metadata-tree",
    source: "get_metadata",
    fileKey,
    nodeId,
    nodeCount,
    root: tree,
  }) as FigmaWorkspaceMetadataJson;
}

function parseMetadataXml(xml: string): ParsedMetadataXmlElement | undefined {
  const stack: ParsedMetadataXmlElement[] = [];
  let root: ParsedMetadataXmlElement | undefined;
  const tagPattern = /<([^!?/>\s]+)([^<>]*?)(\/?)>|<\/([^>\s]+)\s*>/gu;
  for (const match of xml.matchAll(tagPattern)) {
    const closeTag = match[4];
    if (closeTag) {
      const last = stack[stack.length - 1];
      if (last?.tag === closeTag) {
        stack.pop();
      }
      if (root && stack.length === 0) {
        break;
      }
      continue;
    }
    const tag = match[1];
    if (!tag) {
      continue;
    }
    const element: ParsedMetadataXmlElement = {
      tag,
      attributes: parseMetadataXmlAttributes(match[2] ?? ""),
      children: [],
    };
    const parent = stack[stack.length - 1];
    if (parent) {
      parent.children.push(element);
    } else if (!root) {
      root = element;
    }
    if (match[3] !== "/") {
      stack.push(element);
    }
  }
  return root;
}

function parseMetadataXmlAttributes(source: string): Record<string, string> {
  const attributes: Record<string, string> = {};
  const attrPattern = /([A-Za-z_:][-A-Za-z0-9_:.]*)\s*=\s*"([^"]*)"/gu;
  for (const match of source.matchAll(attrPattern)) {
    const name = match[1];
    if (name) {
      attributes[name] = decodeXmlEntities(match[2] ?? "");
    }
  }
  return attributes;
}

function decodeXmlEntities(value: string): string {
  return value
    .replace(/&quot;/gu, '"')
    .replace(/&apos;/gu, "'")
    .replace(/&lt;/gu, "<")
    .replace(/&gt;/gu, ">")
    .replace(/&amp;/gu, "&");
}

function metadataTreeFromXmlElement(element: ParsedMetadataXmlElement): FigmaWorkspaceMetadataTreeNode {
  return removeUndefined({
    nodeId: element.attributes.id,
    type: element.tag,
    name: element.attributes.name,
    x: numberAttribute(element.attributes.x),
    y: numberAttribute(element.attributes.y),
    width: numberAttribute(element.attributes.width),
    height: numberAttribute(element.attributes.height),
    children: element.children.length > 0 ? element.children.map(metadataTreeFromXmlElement) : undefined,
  }) as FigmaWorkspaceMetadataTreeNode;
}

function numberAttribute(value: string | undefined): number | undefined {
  if (value === undefined || value.length === 0) {
    return undefined;
  }
  const number = Number(value);
  return Number.isFinite(number) ? number : undefined;
}

function countMetadataTreeNodes(node: FigmaWorkspaceMetadataTreeNode): number {
  const children = Array.isArray(node.children) ? node.children : [];
  return 1 + children.reduce((sum, child) => sum + countMetadataTreeNodes(child), 0);
}

function limitInlineScriptResult(
  payload: Record<string, unknown>,
  limitValue: unknown,
  fields: string[],
): Record<string, unknown> {
  const limit = normalizeInlineResultLimit(limitValue);
  if (limit === undefined) {
    return payload;
  }
  const result: Record<string, unknown> = { ...payload };
  const omitted: Array<{ field: string; bytes: number }> = [];
  for (const field of fields) {
    const target = inlineResultLimitTarget(result, field);
    if (!target || target.value === undefined) {
      continue;
    }
    const bytes = Buffer.byteLength(JSON.stringify(removeUndefined(target.value)), "utf8");
    if (bytes > limit) {
      delete target.parent[target.key];
      omitted.push({
        field,
        bytes,
      });
    }
  }
  if (omitted.length > 0) {
    result.inlineResultLimit = {
      limitBytes: limit,
      omitted,
      guidance: "Read the corresponding outputFiles pointer when inline fields are omitted.",
    };
  }
  return result;
}

function inlineResultLimitTarget(
  payload: Record<string, unknown>,
  field: string,
): { parent: Record<string, unknown>; key: string; value: unknown } | undefined {
  const parts = field.split(".");
  let parent = payload;
  for (const part of parts.slice(0, -1)) {
    const next = parent[part];
    if (!isRecord(next)) {
      return undefined;
    }
    const cloned = { ...next };
    parent[part] = cloned;
    parent = cloned;
  }
  const key = parts[parts.length - 1];
  if (!key) {
    return undefined;
  }
  return { parent, key, value: parent[key] };
}

function normalizeInlineResultLimit(value: unknown): number | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  const number = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(number) || number < 0) {
    throw new Error(`Tool argument "inlineResultLimit" must be a non-negative number of bytes up to ${MAX_INLINE_RESULT_LIMIT} bytes (${formatBytesHuman(MAX_INLINE_RESULT_LIMIT)}).`);
  }
  return Math.min(Math.floor(number), MAX_INLINE_RESULT_LIMIT);
}

function formatBytesHuman(bytes: number): string {
  if (bytes < 1_000) {
    return `${bytes} bytes`;
  }
  const kb = bytes / 1_000;
  const rounded = Number.isInteger(kb) ? String(kb) : kb.toFixed(1);
  return `${rounded} KB`;
}

function applyWorkspaceFileContextArgs(
  session: FigmaWorkspaceSession | undefined,
  args: { file?: string; surface?: FigmaWorkspaceSurface },
): void {
  if (!session) {
    return;
  }
  applySessionFileReference(session, args.file);
  const derivedFileKey = extractFigmaFileKey(session.fileUrl);
  if (!session.fileKey && derivedFileKey) {
    session.fileKey = derivedFileKey;
  }
  const expectedSurface = normalizeSurface(args.surface);
  const derivedSurface = inferFigmaSurface(session.fileUrl);
  if (expectedSurface) {
    session.surface = expectedSurface;
  } else if (derivedSurface) {
    session.surface = derivedSurface;
  }
  session.lastDiagnostics = diagnoseFigmaWorkspaceContext({
    expectedSurface,
    derivedSurface,
    fileUrl: session.fileUrl,
  });
}

function deriveFileSlug(
  args: { file?: string; fileSlug?: string },
  session?: FigmaWorkspaceSession,
): string {
  const parsedFile = parseFigmaFileReference(args.file);
  return slugifyTaskName(
    args.fileSlug ??
    parsedFile.fileKey ??
    session?.fileKey ??
    parsedFile.fileSlug ??
    extractFigmaFileSlug(session?.fileUrl) ??
    session?.slug ??
    "figma-file",
  );
}

function applySessionFileReference(session: FigmaWorkspaceSession, file: unknown): void {
  const parsed = parseFigmaFileReference(asOptionalString(file));
  if (!parsed.fileUrl && !parsed.fileKey) {
    return;
  }
  if (parsed.fileUrl) {
    session.fileUrl = parsed.fileUrl;
  } else {
    delete session.fileUrl;
  }
  if (parsed.fileKey) {
    session.fileKey = parsed.fileKey;
  }
}

function bindOpenWorkspaceIfAvailable(
  session: FigmaWorkspaceSession,
  args: { workspaceDir?: string },
): void {
  if (!session.fileKey && !session.fileUrl) {
    return;
  }
  const workspaceDir = asOptionalString(args.workspaceDir);
  if (!workspaceDir) {
    throw new Error('Tool argument "workspaceDir" is required when binding a file-context workspace. Pass a Git-ignored project-local .figma-workspace directory or an explicitly selected Figma task-artifact directory.');
  }
  const fileSlug = slugifyTaskName(
    session.fileKey ??
    extractFigmaFileSlug(session.fileUrl) ??
    session.slug ??
    "figma-file",
  );
  session.workspace = createSessionWorkspace({
    workspaceDir,
    fileKey: session.fileKey,
    fileSlug,
    intentSlug: session.slug,
  });
}

function deriveTaskName(
  args: {
    taskName?: string;
  },
  _fallback: string,
): string {
  if (typeof args.taskName !== "string") {
    throw new Error('Tool argument "taskName" is required and must be a slug-style string like "settings-panel-polish".');
  }
  const value = args.taskName.trim();
  if (value.length === 0 || slugifyTaskName(value) !== value) {
    throw new Error('Tool argument "taskName" must be a slug-style string like "settings-panel-polish".');
  }
  return value;
}

function createTaskScriptTemplate(taskName: string, scriptName: string, args: FigmaWorkspacePrepareTaskArguments): string {
  return [
    `// ${scriptName}`,
    "// Async Figma Plugin API body for the run-script-file command.",
    scriptName.endsWith(".figma.ts")
      ? "// TypeScript is strict-checked with Figma Plugin API typings before execution."
      : undefined,
    "// Use $ helpers plus native Figma Plugin API calls and return compact JSON.",
    args.taskName ? `// Task: ${String(args.taskName)}` : undefined,
    args.surface ? `// Surface: ${String(args.surface)}` : undefined,
    args.targetPageId ? `// Suggested targetPageId: ${String(args.targetPageId)}` : undefined,
    "",
    "const checkpoint = await $.checkpoint('start', ['$currentPage'], { depth: 0 });",
    "return { checkpoint, handles: $.handles };",
    "",
  ].filter((line): line is string => line !== undefined).join("\n");
}

const FIGMA_WORKSPACE_EVAL_HELPER_DESCRIPTIONS: Record<FigmaWorkspaceEvalHelperPath, string> = {
  "$": "Resolve a cached handle like $card, $selection, $currentPage, or a raw Figma node id.",
  "$.remember": "Store a handle name for a node or node id in the current workspace session.",
  "$.forget": "Remove a stored handle from the current workspace session.",
  "$.resolveId": "Resolve a cached handle or raw node id string to a Figma node id.",
  "$.node": "Resolve a cached handle or raw node id to the Figma node.",
  "$.select": "Resolve handles/node ids, validate selectable scene nodes, update selection, and optionally zoom.",
  "$.cloneNodeTree": "Copy a source node beside itself with outer-to-inner cloning and instance-subtree preservation.",
  "$.text": "Create or update a text node with font loading and optional handle storage.",
  "$.findFreeSlot": "Find a non-overlapping slot in one parent using a preferred x/y, fixed size, gap, and direction.",
  "$.placeNode": "Move a node to an explicit or non-overlapping generated slot and return placement metadata.",
  "$.replaceGeneratedFrame": "Safely replace generated top-level FRAME nodes whose names match a guarded prefix.",
  "$.inspect": "Resolve a handle or node id and return a compact node summary.",
  "$.capture": "Queue a scene-node capture for host-side figma:capture processing; returns a lightweight request ticket and the command result includes the local image path.",
  "$.imageAsset": "Create or update an image-fill rectangle from small generated PNG/JPEG base64 or byte arrays; use upload_assets/upstream asset fill workflow for large files.",
  "$.checkpoint": "Return handle and node summaries at repair-friendly points.",
};

function evalHelperPath(name: FigmaWorkspaceEvalCommonHelperName): FigmaWorkspaceEvalHelperPath {
  return `$.${name}` as FigmaWorkspaceEvalHelperPath;
}

function createEvalHelperPathList(): FigmaWorkspaceEvalHelperPath[] {
  return ["$", ...FIGMA_WORKSPACE_EVAL_COMMON_HELPER_NAMES.map(evalHelperPath)];
}

function createEvalHelperDescriptionsPayload(): Record<FigmaWorkspaceEvalHelperPath, string> {
  return Object.fromEntries(
    createEvalHelperPathList().map((name) => [name, FIGMA_WORKSPACE_EVAL_HELPER_DESCRIPTIONS[name]]),
  ) as Record<FigmaWorkspaceEvalHelperPath, string>;
}

function createFileWorkflowPayload(): Record<string, unknown> {
  return {
    primaryCommandId: "figma:script:run",
    fileExtension: ".figma.ts",
    commandOrder: ["figma:task:prepare", "figma:script:run", "figma:inspect", "figma:capture"],
    workspaceLayout: "<workspaceDir>/<fileKey-or-fileSlug>/<taskName>.figma.ts",
    workspaceDirGuidance: "Always pass an explicit absolute workspaceDir for prepare/open/file-scoped calls that need local workspace files. Prefer a Git-ignored <project>/.figma-workspace; otherwise choose an explicitly selected Figma task-artifact directory. Do not treat capability-specific output roots as generic task storage.",
    guidance: [
      "Keep non-trivial Plugin API work in local .figma.ts files.",
      "Run figma:script:run with strict preflight and repair every fatal diagnostic before retrying.",
      "Keep transactions small, return compact changed ids and handles, and finish with figma:capture plus visual inspection when content changed.",
    ],
  };
}

function createPublicHelperProfilePayloads(
  profiles: FigmaWorkspaceHelperProfile[],
): Array<Record<string, unknown>> {
  return profiles.map((profile) => ({
    id: profile.id,
    helpers: profile.helpers,
    publicCommandIds: profile.publicCommandIds,
    lookupHints: profile.lookupHints.slice(0, 1),
  }));
}

function createPublicWrapperProfilePayloads(
  profiles: FigmaWorkspaceWrapperLookupProfile[],
): Array<Record<string, unknown>> {
  return profiles.map((profile) => ({
    commandId: profile.commandId,
    upstreamTool: profile.upstreamTool,
    workflowIds: profile.workflowIds,
    suggestedCommandIds: profile.suggestedCommandIds,
    ...(profile.suggestedUpstreamTools.length > 0
      ? { suggestedUpstreamTools: profile.suggestedUpstreamTools }
      : {}),
  }));
}

function createPublicWrapperWorkflowPayloads(
  workflows: FigmaWorkspaceWrapperWorkflow[],
): Array<Record<string, unknown>> {
  return workflows.map((workflow) => ({
    id: workflow.id,
    commandIds: workflow.commandIds,
    upstreamTools: workflow.upstreamTools,
  }));
}

function createWrapperGuidanceRef(toolName: string): FigmaWorkspaceWrapperGuidanceRef | undefined {
  const commandId = toolName === "figma_workspace_get_design_context"
    ? "figma:design-context"
    : toolName === "figma_workspace_get_motion_context"
      ? "figma:motion-context"
      : undefined;
  const profile = commandId ? findWrapperLookupProfile(commandId) : undefined;
  if (!profile) {
    return undefined;
  }
  return {
    source: "guidance",
    query: [profile.commandId, profile.upstreamTool, ...profile.workflowIds].join(" "),
    workflowIds: profile.workflowIds,
  };
}

function createPublicApiCardPayload(card: FigmaWorkspaceApiCard): Record<string, unknown> {
  return {
    id: card.id,
    title: card.title,
    surface: card.surface,
  };
}

function uniqueApiReferences(
  references: FigmaWorkspaceApiCard["apiReferences"],
  maxItems: number,
): FigmaWorkspaceApiCard["apiReferences"] {
  const seen = new Set<string>();
  const results: FigmaWorkspaceApiCard["apiReferences"] = [];
  for (const reference of references) {
    if (seen.has(reference.lookupQuery)) continue;
    seen.add(reference.lookupQuery);
    results.push(reference);
    if (results.length >= maxItems) break;
  }
  return results;
}

function createGuidanceNextActions(options: {
  query: string;
  route: TaskRouteResult;
  referenceContext: ReferenceSearchResult[];
  apiReferences: FigmaWorkspacePluginApiReference[];
}): FigmaWorkspaceNextAction[] {
  const actions = createDocsLookupNextActions({
    query: options.query,
    route: options.route,
    results: options.referenceContext,
  });
  for (const reference of options.apiReferences.slice(0, 1)) {
    actions.push({
      commandId: "figma:api:search",
      args: { symbol: reference.lookupQuery },
      reason: `Read the exact declaration for ${reference.displayExpression}.`,
      priority: actions.length + 1,
    });
  }
  if (actions.length === 0) {
    actions.push({
      commandId: "figma:docs:search",
      args: {
        query: options.route.canonicalQuery ?? options.query,
        scope: "auto",
        ...(options.route.taskFamily ? { taskFamily: options.route.taskFamily } : {}),
      },
      reason: "Run a focused canonical docs search.",
      priority: 1,
    });
  }
  return actions.slice(0, 6).map((action, index) => ({ ...action, priority: index + 1 }));
}

function truncateUtf8(value: string, maxBytes: number): string {
  if (Buffer.byteLength(value, "utf8") <= maxBytes) return value;
  const suffix = "...";
  let result = "";
  for (const character of value) {
    if (Buffer.byteLength(result + character + suffix, "utf8") > maxBytes) break;
    result += character;
  }
  return `${result}${suffix}`;
}

function slugifyTaskName(value: unknown): string {
  const source = typeof value === "string" ? value : "figma-task";
  const slug = source
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/gu, "-")
    .replace(/^-+|-+$/gu, "")
    .slice(0, 80);
  return slug || "figma-task";
}

function createToolTierPayload(): Record<string, unknown> {
  return {
    normalPath: {
      summary: "Default path for non-trivial Figma work.",
      tools: ["prepare-task", "run-script-file", "get-metadata", "get-design-context", "get-motion-context", "search-design-system", "get-libraries", "get-variable-defs", "inspect", "capture-node"],
      order: [
        "prepare-task",
        "figma_workspace_guidance",
        "figma_workspace_lookup",
        "figma_workspace_get_metadata",
        "figma_workspace_get_design_context",
        "figma_workspace_get_motion_context",
        "figma_workspace_search_design_system",
        "figma_workspace_get_libraries",
        "figma_workspace_get_variable_defs",
        "run-script-file",
        "figma_workspace_inspect",
        "figma_workspace_capture_node",
      ],
    },
    contextAndLookup: {
      summary: "Use to plan, bind lightweight session context, or fetch compact docs/API context.",
      tools: ["figma_workspace_open", "figma_workspace_guidance", "figma_workspace_lookup", "figma_workspace_get_metadata", "figma_workspace_get_design_context", "figma_workspace_get_motion_context", "figma_workspace_search_design_system", "figma_workspace_get_libraries", "figma_workspace_get_variable_defs"],
    },
    workflowAddOns: {
      summary: "Use when the primary script workflow needs generated assets, downloaded Figma assets, or repeatable multi-step orchestration.",
      tools: ["figma_workspace_apply_asset_manifest", "figma_workspace_download_assets", "figma_workspace_run_task_plan"],
    },
    advancedEscapeHatches: {
      summary: "Use for short ephemeral calls, raw upstream behavior checks, or explicit upstream-only capabilities.",
      tools: ["figma_workspace_eval", "figma_workspace_call_upstream_tool"],
    },
  };
}

function createToolArgumentGuidancePayload(): Record<string, unknown> {
  const nodeScopedTargetGuidance = FIGMA_WORKSPACE_NODE_SCOPED_TARGET_DESCRIPTION;
  return {
    title: {
      optional: true,
      preferSupplying: false,
      schemaDescription: "Optional display label only; validated as a string but not saved, defaulted, or used for task/file naming.",
      guidance: "title is optional display-only call metadata for Codex/UI. The runtime validates it when supplied but does not store it, synthesize defaults from it, pass it upstream, or use it for task/file naming.",
      examples: [
        "Capture the hero variant for visual QA",
        "Run the token audit script",
        "Apply generated assets to product cards",
      ],
    },
    prepareTask: {
      tool: "prepare-task",
      tier: "normalPath",
      recommendedCalls: {
        workspaceFromFile: { file: "<figma file URL or file key>", taskName: "<task-name>", workspaceDir: "<Git-ignored project .figma-workspace or explicit Figma task-artifact dir>", surface: "design" },
      },
      advancedArguments: ["fileSlug", "fileName", "template", "overwrite"],
      requiredArguments: ["taskName", "workspaceDir"],
      avoidUnless: {
        workspaceDir: "Do not use the plugin install/cache path or a capability-specific output root. Prefer a Git-ignored <project>/.figma-workspace; otherwise choose an explicitly selected Figma task-artifact directory.",
        fileName: "Use fileName only when the generated <task>.figma.ts name is unsuitable.",
        overwrite: "Use only after deciding that replacing an existing script/result pair is intended.",
      },
    },
    open: {
      tool: "figma_workspace_open",
      tier: "contextAndLookup",
      recommendedCalls: {
        session: { sessionId: "<session>", file: "<figma file URL or file key>", workspaceDir: "<Git-ignored project .figma-workspace or explicit Figma task-artifact dir>", surface: "design" },
      },
      advancedArguments: ["connect", "handles"],
      requiredArguments: ["workspaceDir when file is present"],
      avoidUnless: {
        workspaceDir: "Do not use the plugin install/cache path or a capability-specific output root. Prefer a Git-ignored <project>/.figma-workspace; otherwise choose an explicitly selected Figma task-artifact directory.",
        connect: "Leave at the default true unless intentionally updating only local metadata; open connects without listing tools, and call-upstream-tool discovers official upstream tools when needed.",
        handles: "Use only when importing known node ids into a new session; prefer $.remember from scripts.",
      },
    },
    eval: {
      tool: "figma_workspace_eval",
      tier: "advancedEscapeHatches",
      guidance: "Use only for small ephemeral calls. Use prepare-task + run-script-file for repairable scripts, multi-step work, and large structured results.",
      recommendedCalls: {
        read: { sessionId: "<session>", code: "<return compact JSON>", mode: "read", surface: "design" },
        write: { sessionId: "<session>", code: "<return compact JSON>", mode: "write", surface: "design" },
      },
      advancedArguments: ["inlineResultLimit", "allowDangerousOperations", "handleUpdates"],
      avoidUnless: {
        debugFiles: "Do not request JSON result files; debug files are generated on demand for failures and inline omissions.",
        inlineResultLimit: "Use only for inline payload-size control in bytes. Defaults to 4 KB, capped at 10 KB, and 0 forces configurable inline fields to outputFiles only; it does not bypass upstream Figma payload limits.",
        allowDangerousOperations: "Use only after reviewing the exact code; it does not bypass API contract, surface, or read-mode guards.",
        handleUpdates: "Use only for pre-run handle import/repair. It is not read back from upstream.result.handleUpdates; persist script-created handles with $.remember(...) or by returning top-level handles.",
      },
    },
    inspect: {
      tool: "figma_workspace_inspect",
      tier: "normalPath",
      guidance: "Requires a file-context session because it executes upstream use_figma. Open or prepare with file first; target is string-only ($selection, $currentPage, handle, raw node id, or node URL), not { fileKey, nodeId }.",
      recommendedCalls: {
        inspectTarget: { sessionId: "<session>", target: "$selection" },
        inspectStyle: { sessionId: "<session>", mode: "style", target: "$selection" },
        validateHandles: { sessionId: "<session>", mode: "validate" },
      },
      advancedArguments: ["handles"],
      avoidUnless: {
        handles: "Pass handles only to validate a subset; omit to validate all cached handles.",
      },
    },
    getMetadata: {
      tool: "figma_workspace_get_metadata",
      tier: "contextAndLookup",
      guidance: `Use for broad recursive layer-tree discovery before detailed style/fill/text inspection. ${nodeScopedTargetGuidance} It calls official get_metadata, converts XML to compact JSON, enriches supported lock/layout-state fields with one read-only use_figma readback, returns small trees inline, and writes oversized trees to outputFiles.metadataFile.`,
      recommendedCalls: {
        fromSession: { sessionId: "<session>", target: "<raw node id, node URL, or $handle>" },
        fromCurrentPage: { sessionId: "<session>", target: "$currentPage" },
        fromSingleSelection: { sessionId: "<session>", target: "$selection" },
        fromFile: { file: "<figma file URL or file key>", workspaceDir: "<absolute workspace dir>", target: "<node id>" },
        fromHandleObject: { sessionId: "<session>", target: { handle: "$hero" } },
        fromObjectTarget: { target: { fileKey: "<figma file key>", nodeId: "<node id>" } },
      },
      advancedArguments: ["inlineResultLimit", "refresh", "clientLanguages", "clientFrameworks"],
      avoidUnless: {
        dynamicSelectors: "Use $currentPage or single-node $selection only when metadata should root at the live page or selected node; inspect first when selection may contain zero or multiple nodes.",
        inlineResultLimit: "Use only for converted metadata.json payload-size control in bytes. Defaults to 4 KB, capped at 10 KB, and 0 forces metadata.json to outputFiles.metadataFile only.",
        refresh: "Use only for upstream tool-cache debug.",
      },
    },
    designContext: {
      tool: "figma_workspace_get_design_context",
      tier: "contextAndLookup",
      guidance: `Use for official design-to-code context when implementation, parity review, Code Connect, or SwiftUI handoff needs upstream generated structure. ${nodeScopedTargetGuidance} The bridge preserves the official payload inside the generic upstream envelope.`,
      recommendedCalls: {
        fromSession: { sessionId: "<session>", target: "<raw node id, node URL, or $handle>" },
        fromFile: { file: "<figma file URL or file key>", workspaceDir: "<absolute workspace dir>", target: "<node id>" },
        fromKnownStack: { file: "<figma file URL or file key>", workspaceDir: "<absolute workspace dir>", target: "<node id>", clientLanguages: "typescript", clientFrameworks: "react" },
        fromHandleObject: { sessionId: "<session>", target: { handle: "$hero" } },
        fromObjectTarget: { target: { fileKey: "<figma file key>", nodeId: "<node id>" } },
      },
      advancedArguments: ["inlineResultLimit", "refresh", "file", "workspaceDir", "clientLanguages", "clientFrameworks", "forceCode", "disableCodeConnect", "excludeScreenshot"],
      avoidUnless: {
        inlineResultLimit: "Use only for inline payload-size control in bytes. Defaults to 4 KB, capped at 10 KB, and 0 forces configurable inline fields to outputFiles only.",
        refresh: "Use only for upstream tool-cache debug.",
        forceCode: "Use only when explicitly forcing upstream generated code output is useful for the task.",
        disableCodeConnect: "Use only when Code Connect mappings are known to be irrelevant or misleading for this read.",
        excludeScreenshot: "Use only when reducing upstream payload size matters more than screenshot context.",
      },
    },
    motionContext: {
      tool: "figma_workspace_get_motion_context",
      tier: "contextAndLookup",
      guidance: `Use for official animation/keyframe context. ${nodeScopedTargetGuidance} Pair with figma_workspace_get_design_context by node id; preserve upstream motion payloads as authoritative animation data.`,
      recommendedCalls: {
        fromSession: { sessionId: "<session>", target: "<raw node id, node URL, or $handle>", recursive: true },
        fromFile: { file: "<figma file URL or file key>", target: "<node id>", recursive: true },
        fromHandleObject: { sessionId: "<session>", target: { handle: "$hero" }, recursive: true },
        fromObjectTarget: { target: { fileKey: "<figma file key>", nodeId: "<node id>" }, recursive: true },
      },
      advancedArguments: ["inlineResultLimit", "refresh", "file", "workspaceDir", "recursive", "clientLanguages", "clientFrameworks"],
      avoidUnless: {
        recursive: "Use when descendant motion is needed; omit for a single-node motion read.",
        clientHints: "Pass clientLanguages/clientFrameworks only when the implementation target is known.",
        inlineResultLimit: "Use only for inline payload-size control in bytes. Defaults to 4 KB, capped at 10 KB, and 0 forces configurable inline fields to outputFiles only.",
        refresh: "Use only for upstream tool-cache debug.",
      },
    },
    designSystem: {
      tier: "contextAndLookup",
      guidance: `Use the dedicated design-system wrappers when a task needs official Figma design-system search, library listing, or variable definitions. Variable-def targets accept the same node-scoped shapes: ${nodeScopedTargetGuidance} They preserve the generic upstream envelope and minimal session summary.`,
      tools: ["figma_workspace_search_design_system", "figma_workspace_get_libraries", "figma_workspace_get_variable_defs"],
      recommendedCalls: {
        search: { sessionId: "<session>", query: "<component, variable, or token query>" },
        libraries: { sessionId: "<session>" },
        variableDefs: { sessionId: "<session>", target: "<raw node id, node URL, or $handle>" },
        variableDefsFromHandleObject: { sessionId: "<session>", target: { handle: "$hero" } },
        variableDefsFromObjectTarget: { target: { fileKey: "<figma file key>", nodeId: "<node id>" } },
      },
      advancedArguments: ["inlineResultLimit", "refresh", "file", "workspaceDir"],
      avoidUnless: {
        callUpstreamTool: FIGMA_WORKSPACE_UPSTREAM_ESCAPE_HATCH_GUIDANCE,
        inlineResultLimit: "Use only for inline payload-size control in bytes. Defaults to 4 KB, capped at 10 KB, and 0 forces configurable inline fields to outputFiles only.",
        refresh: "Use only for upstream tool-cache debug.",
      },
    },
    assetManifest: {
      tool: "figma_workspace_apply_asset_manifest",
      tier: "workflowAddOns",
      recommendedCalls: {
        applyManifest: { sessionId: "<session>", manifestPath: "<assets>.json" },
      },
      advancedArguments: ["assets"],
      avoidUnless: {
        assets: "Prefer manifestPath for repeatable local-file workflows; inline assets are for generated one-off plans.",
      },
    },
    downloadAssets: {
      tool: "figma_workspace_download_assets",
      tier: "workflowAddOns",
      recommendedCalls: {
        downloadTargets: { sessionId: "<session>", targets: [{ target: "$target", defaultFormat: "png" }], outputDir: "<downloads>" },
      },
      preferredArguments: ["targets", "manifestPath", "outputDir"],
      avoidUnless: {
        manifestPath: "Use only for repeatable batch files shaped as { targets: [...] }; inline targets are clearer for one-off calls.",
        outputDir: "Omit for the default <slug>.downloads directory unless downstream steps need a specific path.",
        debugFiles: "Do not request JSON result files; debug files are generated on demand for failures.",
      },
    },
    captureNode: {
      tool: "figma_workspace_capture_node",
      tier: "normalPath",
      guidance: "Use for final visual QA captures. Raw node id / $handle string targets require an open/prepare file-context session; node URL targets or target:{ fileKey, nodeId } can supply file context directly.",
      recommendedCalls: {
        captureFromSession: { sessionId: "<session>", target: "$target", imageFile: "<capture>.png" },
        captureFromNodeUrl: { target: "<figma node URL>", imageFile: "<capture>.png" },
        captureFromObjectTarget: { target: { fileKey: "<figma file key>", nodeId: "<node id>" }, imageFile: "<capture>.png", maxDimension: 1600, contentsOnly: true },
      },
      advancedArguments: ["maxDimension", "contentsOnly"],
    },
    taskPlan: {
      tool: "figma_workspace_run_task_plan",
      tier: "workflowAddOns",
      recommendedCalls: {
        filePlan: { sessionId: "<session>", planPath: "<plan>.json" },
      },
      advancedArguments: ["steps"],
      avoidUnless: {
        steps: "Prefer planPath for repeatable workflows; inline steps are for generated one-off plans.",
        stepArgs: "Each step must use { type, args }; put tool-specific fields inside args, not at the step top level.",
      },
    },
    guidance: {
      tool: "figma_workspace_guidance",
      tier: "contextAndLookup",
      preferredArguments: ["query", "mode", "surface"],
    },
    lookup: {
      tool: "figma_workspace_lookup",
      tier: "contextAndLookup",
      preferredArguments: { docs: ["kind=docs", "query"], api: ["kind=api", "symbol"] },
      resultSizeControls: ["maxResults", "maxSnippetLines"],
    },
    callUpstreamTool: {
      tool: "figma_workspace_call_upstream_tool",
      tier: "advancedEscapeHatches",
      guidance: `Explicit upstream escape hatch for official Figma MCP capabilities, including shader effect/fill reads and raw upstream behavior checks. Use call-upstream-tool --help for the command contract; prefer dedicated CLI commands for ${COVERED_UPSTREAM_TOOL_NAMES_TEXT}.`,
      recommendedCalls: {
        explicit: { sessionId: "<session>", toolName: "<uncovered official upstream tool>", arguments: {} },
      },
      advancedArguments: ["inlineResultLimit", "refresh"],
      avoidUnless: {
        debugFiles: "Do not request JSON result files; debug files are generated on demand for failures and inline omissions.",
        inlineResultLimit: "Use only for inline payload-size control in bytes. Defaults to 4 KB, capped at 10 KB, and 0 forces configurable inline fields to outputFiles only; it does not bypass upstream Figma payload limits.",
        refresh: "Use only for upstream tool-cache debug.",
      },
    },
  };
}

function isPathInside(root: string, path: string): boolean {
  const rel = relative(root, path);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

function parseUpstreamToolResult(value: unknown): ParsedUpstreamToolResult {
  const record = asRecord(value);
  const structured = record.structuredContent;
  if (structured !== undefined) {
    return annotateParsedUpstreamToolResult(JSON.stringify(structured), structured);
  }
  const text = Array.isArray(record.content)
    ? record.content
        .map((item) => asRecord(item).text)
        .filter((item): item is string => typeof item === "string")
        .join("\n")
    : JSON.stringify(value);
  if (isTruncatedUpstreamText(text)) {
    return annotateParsedUpstreamToolResult(text, undefined);
  }
  return annotateParsedUpstreamToolResult(text, parseJsonLenient(text));
}

function annotateParsedUpstreamToolResult(
  text: string,
  json: unknown,
): ParsedUpstreamToolResult {
  const upstreamError = extractParsedUpstreamError(text, json);
  return {
    text,
    json,
    upstreamError,
    primaryFix: upstreamError ? primaryFixForUpstreamError(upstreamError) : undefined,
  };
}

function extractParsedUpstreamError(
  text: string,
  json: unknown,
): FigmaWorkspaceUpstreamError | undefined {
  const truncation = extractUpstreamTruncationMarker(text);
  if (truncation) {
    return {
      message: `Upstream Figma output was truncated at ${truncation.size}.`,
      code: "FIGMA_UPSTREAM_TRUNCATED",
      details: { marker: truncation.marker, size: truncation.size },
      text,
      parsed: json,
    };
  }
  const record = asRecord(json);
  if (record.ok !== false) {
    const trimmed = text.trim();
    if (!/^Error:/u.test(trimmed) && !/Figma Debug UUID:/u.test(trimmed)) {
      return undefined;
    }
    return {
      message: trimmed.split(/\r?\n/u)[0] || "Upstream Figma execution failed.",
      code: "FIGMA_UPSTREAM_TEXT_ERROR",
      details: extractFigmaDebugUuid(trimmed)
        ? { debugUuid: extractFigmaDebugUuid(trimmed) }
        : undefined,
      text,
      parsed: json,
    };
  }
  const errorRecord = asRecord(record.error);
  const message = stringFromUnknown(record.error)
    ?? asOptionalString(errorRecord.message)
    ?? asOptionalString(record.message)
    ?? text.slice(0, 1_000)
    ?? "Upstream Figma execution failed.";
  return {
    message,
    code: asOptionalString(record.code) ?? asOptionalString(errorRecord.code),
    details: record.details ?? errorRecord.details,
    text,
    parsed: json,
  };
}

function isTruncatedUpstreamText(text: string): boolean {
  return Boolean(extractUpstreamTruncationMarker(text));
}

function extractUpstreamTruncationMarker(text: string): { marker: string; size: string } | undefined {
  const match = /(?:^|[\s/])((?:\/\/\s*)?truncated\s+to\s+([0-9]+(?:\.[0-9]+)?\s*(?:[kmgt]?b|bytes?)))\s*$/iu.exec(text);
  if (!match) {
    return undefined;
  }
  const marker = match[1]?.trim();
  const size = match[2]?.replace(/\s+/gu, "");
  return marker && size ? { marker, size } : undefined;
}

function extractFigmaDebugUuid(text: string): string | undefined {
  const match = /Figma Debug UUID:\s*([0-9a-fA-F-]+)/u.exec(text);
  return match?.[1];
}

function normalizeCaughtUpstreamError(error: unknown): FigmaWorkspaceUpstreamError {
  const oauthError = normalizeOAuthUpstreamError(error);
  if (oauthError) {
    return oauthError;
  }
  if (error instanceof Error) {
    return {
      message: error.message,
      code: typeof (error as { code?: unknown }).code === "string"
        ? (error as { code?: string }).code
        : "FIGMA_UPSTREAM_FAILED",
    };
  }
  return {
    message: stringFromUnknown(error) ?? "Upstream Figma execution failed.",
    code: "FIGMA_UPSTREAM_FAILED",
    details: error,
  };
}

function normalizeOAuthUpstreamError(error: unknown): FigmaWorkspaceUpstreamError | undefined {
  if (!isRemoteMcpOAuthError(error)) {
    return undefined;
  }
  return publicOAuthUpstreamError(error);
}

function publicOAuthUpstreamError(error: RemoteMcpOAuthError): FigmaWorkspaceUpstreamError {
  const details = isRecord(error.details)
    ? {
        ...error.details,
        loginCommand: error.details.loginCommand ?? "npm run login:figma-http",
        oauthCacheFile: error.details.oauthCacheFile ?? ".figma-workspace-oauth.json",
      }
    : {
        loginCommand: "npm run login:figma-http",
        oauthCacheFile: ".figma-workspace-oauth.json",
      };
  return {
    message: publicOAuthMessage(error.code),
    code: error.code,
    details,
  };
}

function publicOAuthMessage(code: RemoteMcpOAuthError["code"]): string {
  switch (code) {
    case "FIGMA_UPSTREAM_AUTH_REQUIRED":
      return "Figma MCP upstream authentication is required or incomplete.";
    case "FIGMA_UPSTREAM_OAUTH_REGISTRATION_REJECTED":
      return "Figma MCP OAuth client registration was rejected before authorization.";
    case "FIGMA_UPSTREAM_OAUTH_CALLBACK_TIMEOUT":
      return "Figma MCP OAuth browser authorization timed out.";
    case "FIGMA_UPSTREAM_OAUTH_CANCELLED":
      return "Figma MCP OAuth browser authorization was cancelled before completion.";
    case "FIGMA_UPSTREAM_OAUTH_CALLBACK_PORT_IN_USE":
      return "Figma MCP OAuth callback port is already in use.";
    case "FIGMA_UPSTREAM_OAUTH_CALLBACK_STARTUP_FAILED":
      return "Figma MCP OAuth callback listener failed to start.";
    case "FIGMA_UPSTREAM_OAUTH_CALLBACK_FAILED":
      return "Figma MCP OAuth browser authorization did not complete.";
    case "FIGMA_UPSTREAM_OAUTH_TOKEN_EXCHANGE_FAILED":
      return "Figma MCP OAuth token exchange failed after browser authorization.";
  }
}

function primaryFixForUpstreamError(error: FigmaWorkspaceUpstreamError): string {
  if (error.code === "FIGMA_UPSTREAM_AUTH_REQUIRED") {
    return "Run npm run login:figma-http from the figma-workspace plugin root, complete browser OAuth, then retry the Figma Workspace MCP call.";
  }
  if (error.code === "FIGMA_UPSTREAM_OAUTH_REGISTRATION_REJECTED") {
    return "Use a Figma-supported OAuth client for this runtime or seed registered client metadata in .figma-workspace-oauth.json, then retry.";
  }
  if (error.code === "FIGMA_UPSTREAM_OAUTH_CALLBACK_TIMEOUT") {
    return "Rerun npm run login:figma-http, complete the browser OAuth callback before the timeout, then retry.";
  }
  if (error.code === "FIGMA_UPSTREAM_OAUTH_CANCELLED") {
    return "Restart the Figma Workspace MCP call or npm run login:figma-http, complete browser OAuth, then retry.";
  }
  if (error.code === "FIGMA_UPSTREAM_OAUTH_CALLBACK_PORT_IN_USE") {
    const callbackPort = isRecord(error.details) && typeof error.details.callbackPort === "number"
      ? ` ${error.details.callbackPort}`
      : "";
    return `Free OAuth callback port${callbackPort} or configure this runtime with a different callback port, then rerun npm run login:figma-http.`;
  }
  if (error.code === "FIGMA_UPSTREAM_OAUTH_CALLBACK_STARTUP_FAILED") {
    return "Free or change the OAuth callback host/port, then rerun npm run login:figma-http and retry the Figma Workspace MCP call.";
  }
  if (error.code === "FIGMA_UPSTREAM_OAUTH_CALLBACK_FAILED") {
    return "Rerun npm run login:figma-http and complete a successful browser OAuth callback, then retry.";
  }
  if (error.code === "FIGMA_UPSTREAM_OAUTH_TOKEN_EXCHANGE_FAILED") {
    return "Rerun npm run login:figma-http to refresh the OAuth token exchange, then retry the Figma Workspace MCP call.";
  }
  if (error.code === "FIGMA_UPSTREAM_FAILED") {
    return "Check the upstream Figma MCP connection and retry the same Figma Workspace MCP call after the upstream issue is resolved.";
  }
  const message = error.message.toLowerCase();
  if (message.includes("remove") && (message.includes("instance") || message.includes("children") || message.includes("subtree"))) {
    return "Use $.replaceGeneratedFrame({ name }) for guarded generated-frame replacement, or $.cloneNodeTree({ source, placement: 'right' }) for copy/rebuild workflows.";
  }
  if (message.includes("font") || message.includes("characters")) {
    return "Load the target font with figma.loadFontAsync or use $.text before changing TextNode characters.";
  }
  if (message.includes("selection")) {
    return "Use $.select([...]) or explicit node ids/handles instead of direct figma.currentPage.selection access.";
  }
  return "Open the paired .figma.ts file, repair the upstream Plugin API error, then rerun the same script with strict=true.";
}

function stringFromUnknown(value: unknown): string | undefined {
  if (typeof value === "string" && value.length > 0) {
    return value;
  }
  if (isRecord(value)) {
    const message = asOptionalString(value.message);
    if (message) return message;
  }
  return undefined;
}

function parseJsonLenient(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    const slice = firstBalancedJsonSlice(text);
    if (!slice) return undefined;
    try {
      return JSON.parse(slice);
    } catch {
      return undefined;
    }
  }
}

function firstBalancedJsonSlice(text: string): string | undefined {
  const start = text.search(/[\[{]/u);
  if (start < 0) return undefined;
  const stack: string[] = [];
  let inString = false;
  let escape = false;
  for (let index = start; index < text.length; index += 1) {
    const char = text[index];
    if (inString) {
      if (escape) {
        escape = false;
      } else if (char === "\\") {
        escape = true;
      } else if (char === '"') {
        inString = false;
      }
      continue;
    }
    if (char === '"') {
      inString = true;
      continue;
    }
    if (char === "{" || char === "[") {
      stack.push(char === "{" ? "}" : "]");
      continue;
    }
    if (char === "}" || char === "]") {
      if (stack.pop() !== char) return undefined;
      if (stack.length === 0) {
        return text.slice(start, index + 1);
      }
    }
  }
  return undefined;
}

function updateSessionFromParsedResult(session: FigmaWorkspaceSession, value: unknown): FigmaWorkspaceHandleChanges {
  const record = asRecord(value);
  const repl = asRecord(record.__figmaRepl);
  const result = asRecord(record.result);
  let handleChanges = emptyHandleChanges();
  if (isStringRecord(repl.handles)) {
    handleChanges = mergeHandleChanges(handleChanges, replaceSessionHandles(session, repl.handles));
  }
  if (isStringRecord(result.handles)) {
    handleChanges = mergeHandleChanges(handleChanges, updateSessionHandles(session, result.handles));
  }
  if (isStringRecord(repl.knownPages)) {
    session.knownPages = { ...session.knownPages, ...repl.knownPages };
  }
  if (isStringRecord(result.knownPages)) {
    session.knownPages = { ...session.knownPages, ...result.knownPages };
  }
  assignOptionalString(session, "currentPageId", repl.currentPageId);
  assignOptionalString(session, "currentPageId", result.currentPageId);
  assignOptionalString(session, "fileKey", repl.fileKey);
  assignOptionalString(session, "fileKey", result.fileKey);
  const surface = normalizeSurface(repl.surface) ?? normalizeSurface(result.surface);
  if (surface) {
    session.surface = surface;
  }
  touchSession(session);
  return handleChanges;
}

function collectNodeIds(value: unknown): string[] {
  const ids = new Set<string>();
  const visit = (item: unknown) => {
    if (typeof item === "string" && /^\d+[:;]\d+/u.test(item)) {
      ids.add(item);
      return;
    }
    if (Array.isArray(item)) {
      item.forEach(visit);
      return;
    }
    if (isRecord(item)) {
      if (typeof item.id === "string") ids.add(item.id);
      for (const child of Object.values(item)) visit(child);
    }
  };
  visit(value);
  return [...ids];
}

function summarizeParsedResult(parsed: ParsedUpstreamToolResult): string {
  const record = asRecord(parsed.json);
  const result = record.result;
  if (isRecord(result)) {
    if (typeof result.summary === "string") return result.summary;
    if (typeof result.opCount === "number") return `Returned opCount=${result.opCount}.`;
  }
  if (typeof result === "string") return result.slice(0, 160);
  if (parsed.text) return parsed.text.slice(0, 160);
  return "Figma Workspace command completed.";
}

function diagnosticsForResponse(
  diagnostics: FigmaWorkspaceDiagnostic[] | undefined,
): FigmaWorkspaceDiagnostic[] | undefined {
  return diagnostics && diagnostics.length > 0 ? diagnostics : undefined;
}

function optionalDiagnosticsForResponse(
  diagnostics: FigmaWorkspaceDiagnostic[] | undefined,
): FigmaWorkspaceDiagnostic[] | undefined {
  return diagnosticsForResponse(diagnostics);
}

function repairPlanForResponse(
  diagnostics: FigmaWorkspaceFileDiagnostic[] | undefined,
): FigmaWorkspaceRepairPlan | undefined {
  return diagnostics && diagnostics.length > 0 ? createFigmaWorkspaceRepairPlan(diagnostics) : undefined;
}

function dedupeDiagnostics(diagnostics: FigmaWorkspaceDiagnostic[]): FigmaWorkspaceDiagnostic[] {
  const seen = new Set<string>();
  const result: FigmaWorkspaceDiagnostic[] = [];
  for (const diagnostic of diagnostics) {
    const key = `${diagnostic.code}\n${diagnostic.message}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    result.push(diagnostic);
  }
  return result;
}

function responseSession(
  session: FigmaWorkspaceSession,
  handleChanges: FigmaWorkspaceHandleChanges = emptyHandleChanges(),
): Record<string, unknown> {
  return removeUndefined({
    id: session.id,
    fileKey: session.fileKey,
    surface: session.surface,
    sessionDir: session.workspace?.sessionDir,
    handleChanges,
  }) as Record<string, unknown>;
}

function responseReadOnlySession(session: FigmaWorkspaceSession): Record<string, unknown> {
  return removeUndefined({
    id: session.id,
    fileKey: session.fileKey,
    surface: session.surface,
    sessionDir: session.workspace?.sessionDir,
  }) as Record<string, unknown>;
}

function responseWorkspace(workspace: FigmaWorkspaceSessionWorkspace): FigmaWorkspacePublicWorkspace {
  return {
    root: workspace.root,
    fileDir: workspace.fileDir,
    fileContext: workspace.fileContext,
    fileKey: workspace.fileKey,
    fileSlug: workspace.fileSlug,
    taskName: workspace.intentSlug,
    sessionDir: workspace.sessionDir,
    scriptPath: workspace.scriptPath,
    files: {
      inputFile: workspace.files.script,
    },
  };
}

function responseScriptMetadata(
  metadata: Record<string, unknown>,
): FigmaWorkspaceCompactScriptMetadata {
  return removeUndefined({
    scriptPath: metadata.scriptPath,
    inputFile: metadata.inputFile,
    expectedSurface: metadata.expectedSurface,
    compiledScriptBytes: metadata.compiledScriptBytes,
  }) as FigmaWorkspaceCompactScriptMetadata;
}

function responseRunScriptSuccessMetadata(
  args: FigmaWorkspaceRunScriptFileArguments,
): FigmaWorkspaceCompactScriptMetadata | undefined {
  const inputFile = asOptionalString(args.inputFile);
  return inputFile ? responseScriptMetadata({ inputFile }) : undefined;
}

function upstreamResultFields(options: {
  parsed: ParsedUpstreamToolResult;
  upstream?: unknown;
}): Record<string, unknown> {
  return {
    upstream: upstreamEnvelope(options.parsed),
  };
}

function runScriptUpstreamFields(parsed: ParsedUpstreamToolResult): Record<string, unknown> {
  return {
    upstream: upstreamEnvelope(parsed),
  };
}

function runScriptUpstreamFailureFields(parsed: ParsedUpstreamToolResult): Record<string, unknown> {
  return {
    upstreamError: parsed.upstreamError ? responseUpstreamError(parsed.upstreamError) : undefined,
  };
}

async function shapeUpstreamBackedResponse(options: {
  contract: FigmaWorkspaceWrapperContract;
  parsed: ParsedUpstreamToolResult;
  resultPayload: Record<string, unknown>;
  inlineResultLimit: unknown;
  forceOutputFile?: boolean;
  writeOutputFiles: (upstream: Record<string, unknown>) => Promise<FigmaWorkspaceOutputFiles>;
}): Promise<Record<string, unknown>> {
  const inlineResultLimit = normalizeInlineResultLimit(options.inlineResultLimit ?? DEFAULT_INLINE_RESULT_LIMIT);
  const limitedPayload = limitInlineScriptResult(
    options.resultPayload,
    inlineResultLimit,
    [...options.contract.outputPolicy.inlineLimitFields],
  );
  const needsOutputFile = options.forceOutputFile === true
    || options.parsed.upstreamError
    || isRecord(limitedPayload.inlineResultLimit);
  if (!needsOutputFile) {
    return limitedPayload;
  }
  return {
    ...limitedPayload,
    outputFiles: await options.writeOutputFiles(upstreamEnvelope(options.parsed)),
  };
}

function responseUpstreamError(error: FigmaWorkspaceUpstreamError): Record<string, unknown> {
  return {
    message: error.message,
    code: error.code,
    details: error.details,
  };
}

function upstreamFailureFields(parsed: ParsedUpstreamToolResult): Record<string, unknown> {
  return {
    upstreamError: parsed.upstreamError ? responseUpstreamError(parsed.upstreamError) : undefined,
    primaryFix: parsed.primaryFix,
  };
}

function inspectInlineResultFields(parsed: ParsedUpstreamToolResult, fallbackMode: "inspect" | "style"): Record<string, unknown> {
  if (parsed.upstreamError) {
    return {
      upstreamError: responseUpstreamError(parsed.upstreamError),
    };
  }
  const result = {
    ...asRecord(asRecord(parsed.json).result),
  };
  delete result.handles;
  if (fallbackMode === "inspect") {
    return removeUndefined({
      ...result,
      mode: asOptionalString(result.mode) ?? "inspect",
    }) as Record<string, unknown>;
  }
  const style = { ...asRecord(result.style) };
  delete style.caps;
  delete style.limits;
  const targetSummary = targetSummaryFromSummary(result.targetSummary ?? result.summary);
  const truncated = inspectStyleTruncated(style, asRecord(result.styleCounts));
  return removeUndefined({
    ...result,
    mode: "style",
    summary: undefined,
    handles: undefined,
    limit: undefined,
    styleCounts: undefined,
    targetSummary,
    style,
    truncated,
  }) as Record<string, unknown>;
}

function targetSummaryFromSummary(value: unknown): Record<string, unknown> | undefined {
  const source = Array.isArray(value) ? asRecord(value[0]) : asRecord(value);
  const result = removeUndefined({
    id: asOptionalString(source.id),
    type: asOptionalString(source.type),
    name: asOptionalString(source.name),
    visible: typeof source.visible === "boolean" ? source.visible : undefined,
    x: finiteNumber(source.x),
    y: finiteNumber(source.y),
    width: finiteNumber(source.width),
    height: finiteNumber(source.height),
  }) as Record<string, unknown>;
  return Object.keys(result).length > 0 ? result : undefined;
}

function inspectStyleTruncated(
  style: Record<string, unknown>,
  counts: Record<string, unknown>,
): Record<string, number> | undefined {
  const result: Record<string, number> = {};
  for (const key of ["topColors", "textStyles", "imageNodes", "strokes", "effects"]) {
    const total = finiteNonNegativeNumber(counts[key]);
    if (total === undefined) {
      continue;
    }
    const returned = Array.isArray(style[key]) ? style[key].length : 0;
    if (total > returned) {
      result[key] = total - returned;
    }
  }
  return Object.keys(result).length > 0 ? result : undefined;
}

function upstreamEnvelope(
  parsed: ParsedUpstreamToolResult,
  options: { includePayload?: boolean } = {},
): Record<string, unknown> {
  const includePayload = options.includePayload ?? true;
  const callOk = !parsed.upstreamError;
  if (parsed.json !== undefined) {
    const shaped = shapePublicUpstreamResult(parsed.json);
    const ok = callOk && shaped.consumedOk !== false;
    const failureSource = shaped.consumedOk === false
      ? "business"
      : callOk
        ? "business"
        : "call";
    const result = ok ? shaped.result : addFailureSourceToUpstreamResult(
      shaped.result ?? (parsed.upstreamError ? responseUpstreamError(parsed.upstreamError) : undefined),
      failureSource,
    );
    return includePayload
      ? { kind: "json", ok, result }
      : { kind: "json", ok };
  }
  const ok = callOk;
  return includePayload
    ? {
        kind: "text",
        ok,
        text: parsed.text || undefined,
        result: ok ? undefined : addFailureSourceToUpstreamResult(
          parsed.upstreamError ? responseUpstreamError(parsed.upstreamError) : undefined,
          "call",
        ),
      }
    : { kind: "text", ok };
}

function shapePublicUpstreamResult(value: unknown): { result: unknown; consumedOk?: boolean } {
  const record = asRecord(value);
  if (!Object.prototype.hasOwnProperty.call(record, "__figmaRepl")) {
    return consumeTopLevelOk(value);
  }
  if (Object.prototype.hasOwnProperty.call(record, "result")) {
    return consumeTopLevelOk(record.result);
  }
  const result: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(record)) {
    if (key !== "__figmaRepl" && key !== "ok") {
      result[key] = item;
    }
  }
  return { result: Object.keys(result).length > 0 ? result : undefined };
}

function consumeTopLevelOk(value: unknown): { result: unknown; consumedOk?: boolean } {
  if (!isRecord(value)) {
    return { result: value };
  }
  if (!Object.prototype.hasOwnProperty.call(value, "ok")) {
    return { result: value };
  }
  const { ok, ...rest } = value;
  return {
    result: Object.keys(rest).length > 0 ? rest : undefined,
    consumedOk: typeof ok === "boolean" ? ok : undefined,
  };
}

function addFailureSourceToUpstreamResult(
  result: unknown,
  source: "call" | "business",
): Record<string, unknown> {
  if (isRecord(result)) {
    return {
      ...result,
      source,
    };
  }
  return result === undefined
    ? { source }
    : { source, value: result };
}

function publicSession(
  session: FigmaWorkspaceSession,
  options: { includeHistory?: boolean; historyLimit?: number } = {},
): Record<string, unknown> {
  const includeHistory = options.includeHistory ?? true;
  const historyLimit = normalizePositiveInteger(options.historyLimit, DEFAULT_HISTORY_LIMIT);
  return {
    id: session.id,
    slug: session.slug,
    createdAt: session.createdAt,
    updatedAt: session.updatedAt,
    label: session.label,
    fileUrl: session.fileUrl,
    fileKey: session.fileKey,
    surface: session.surface,
    knownPages: session.knownPages,
    currentPageId: session.currentPageId,
    handles: session.handles,
    workspace: session.workspace ? responseWorkspace(session.workspace) : undefined,
    lastDiagnostics: session.lastDiagnostics,
    history: includeHistory ? session.history.slice(-historyLimit) : undefined,
  };
}

function cloneSession(session: FigmaWorkspaceSession): FigmaWorkspaceSession {
  return {
    ...session,
    knownPages: { ...session.knownPages },
    handles: { ...session.handles },
    workspace: session.workspace ? {
      ...session.workspace,
      files: { ...session.workspace.files },
    } : undefined,
    lastDiagnostics: session.lastDiagnostics.map((diagnostic) => ({ ...diagnostic })),
    history: session.history.map((entry) => ({
      ...entry,
      nodeIds: [...entry.nodeIds],
    })),
  };
}

function emptyHandleChanges(): FigmaWorkspaceHandleChanges {
  return { updated: [], removed: [] };
}

function mergeHandleChanges(
  left: FigmaWorkspaceHandleChanges,
  right: FigmaWorkspaceHandleChanges,
): FigmaWorkspaceHandleChanges {
  return {
    updated: sortedUnique([...left.updated, ...right.updated].filter((name) => !right.removed.includes(name))),
    removed: sortedUnique([...left.removed, ...right.removed].filter((name) => !right.updated.includes(name))),
  };
}

function updateSessionHandles(session: FigmaWorkspaceSession, handles: Record<string, string>): FigmaWorkspaceHandleChanges {
  const updated: string[] = [];
  for (const [name, id] of Object.entries(handles)) {
    if (typeof id === "string" && id.length > 0) {
      const handle = normalizeLocalHandleName(name);
      if (session.handles[handle] !== id) {
        session.handles[handle] = id;
        updated.push(handle);
      }
    }
  }
  if (updated.length > 0) {
    touchSession(session);
  }
  return { updated: sortedUnique(updated), removed: [] };
}

function replaceSessionHandles(session: FigmaWorkspaceSession, handles: Record<string, string>): FigmaWorkspaceHandleChanges {
  const nextHandles: Record<string, string> = {};
  for (const [name, id] of Object.entries(handles)) {
    if (typeof id === "string" && id.length > 0) {
      nextHandles[normalizeLocalHandleName(name)] = id;
    }
  }
  const updated = Object.entries(nextHandles)
    .filter(([name, id]) => session.handles[name] !== id)
    .map(([name]) => name);
  const removed = Object.keys(session.handles)
    .filter((name) => nextHandles[name] === undefined);
  if (updated.length > 0 || removed.length > 0) {
    session.handles = nextHandles;
    touchSession(session);
  }
  return {
    updated: sortedUnique(updated),
    removed: sortedUnique(removed),
  };
}

function sortedUnique(values: string[]): string[] {
  return [...new Set(values)].sort((a, b) => a.localeCompare(b));
}

function normalizeLocalHandleName(name: string): string {
  return name.startsWith("$") ? name : `$${name}`;
}

function resolveSessionNodeInput(input: string | undefined, session: FigmaWorkspaceSession): string | undefined {
  return resolveSessionTargetInput(input, session).nodeId;
}

function resolveWrapperNodeTarget(options: {
  args: { file?: string; target?: unknown };
  session: FigmaWorkspaceSession;
  toolName: LocalWorkspaceToolName;
  targetFallback?: unknown;
  requireNode?: boolean;
  allowDynamicSelectors?: readonly string[];
  fileKeyError?: string;
  targetError?: string;
}): { fileKey: string; nodeId?: string; handle?: string } {
  const fileReference = parseFigmaFileReference(options.args.file);
  const targetInput = options.args.target ?? options.targetFallback ?? extractFigmaNodeId(options.args.file);
  const target = resolveSessionTargetInput(targetInput, options.session);
  const fileKey =
    fileReference.fileKey ??
    target.fileKey ??
    options.session.fileKey ??
    extractFigmaFileKey(options.session.fileUrl);
  if (!fileKey) {
    throw new Error(options.fileKeyError ?? `${options.toolName} requires a Figma file key. Pass "file" or open a session with file context first.`);
  }
  const nodeId = target.nodeId;
  if (options.requireNode && !nodeId) {
    throw new Error(options.targetError ?? `${options.toolName} requires "target". Pass a raw node id, node URL, or cached handle.`);
  }
  if (nodeId?.startsWith("$") && !options.allowDynamicSelectors?.includes(nodeId)) {
    throw new Error(`${options.toolName} cannot resolve dynamic selector "${nodeId}". Pass a raw node id, node URL, or cached handle.`);
  }
  return { fileKey, nodeId, handle: target.handle };
}

function resolveSessionTargetInput(input: unknown, session: FigmaWorkspaceSession): { nodeId?: string; handle?: string; fileKey?: string } {
  if (isRecord(input)) {
    const explicitHandle = asOptionalString(input.handle) ?? asOptionalString(input.targetHandle);
    const explicitFileKey =
      asOptionalString(input.fileKey) ??
      extractFigmaFileKey(asOptionalString(input.url)) ??
      extractFigmaFileKey(asOptionalString(input.nodeUrl)) ??
      extractFigmaFileKey(asOptionalString(input.target));
    const nodeValue =
      explicitHandle ??
      asOptionalString(input.nodeId) ??
      asOptionalString(input.targetNodeId) ??
      asOptionalString(input.target) ??
      asOptionalString(input.id) ??
      asOptionalString(input.url) ??
      asOptionalString(input.nodeUrl);
    const resolved = resolveSessionTargetInput(nodeValue, session);
    return {
      ...resolved,
      fileKey: explicitFileKey ?? resolved.fileKey,
    };
  }
  const value = asOptionalString(input);
  if (!value) {
    return {};
  }
  const trimmed = value.trim();
  if (!trimmed) {
    return {};
  }
  if (trimmed.startsWith("$")) {
    const handle = normalizeLocalHandleName(trimmed);
    return {
      nodeId: session.handles[handle] ?? trimmed,
      handle,
    };
  }
  const fromUrl = extractFigmaNodeId(trimmed);
  if (fromUrl) {
    return { nodeId: fromUrl, fileKey: extractFigmaFileKey(trimmed) };
  }
  const handle = normalizeLocalHandleName(trimmed);
  if (session.handles[handle]) {
    return {
      nodeId: session.handles[handle],
      handle,
    };
  }
  return { nodeId: trimmed };
}

function buildFigmaNodeUrl(session: FigmaWorkspaceSession, nodeId: string): string | undefined {
  const fileUrl = session.fileUrl;
  const fileKey = session.fileKey ?? extractFigmaFileKey(fileUrl);
  const nodeParam = encodeURIComponent(nodeId.replace(/:/gu, "-"));
  if (fileUrl) {
    try {
      const url = new URL(fileUrl);
      url.searchParams.set("node-id", nodeId.replace(/:/gu, "-"));
      return url.toString();
    } catch {
      // Fall through to a file-key URL when available.
    }
  }
  return fileKey ? `https://www.figma.com/design/${fileKey}/?node-id=${nodeParam}` : undefined;
}

function touchSession(session: FigmaWorkspaceSession): void {
  session.updatedAt = new Date().toISOString();
}

function sanitizeSessionId(sessionId: string): string {
  const value = sessionId.trim();
  if (!value) {
    return FIGMA_WORKSPACE_DEFAULT_SESSION_ID;
  }
  return value.slice(0, 120);
}

function makeJsonToolResult(value: unknown): Record<string, unknown> {
  const structuredContent = removeUndefined(value);
  return {
    structuredContent,
    content: [],
  };
}

function parseJsonToolResult<T extends Record<string, unknown>>(result: Record<string, unknown>): T {
  if (result.structuredContent !== undefined) {
    return result.structuredContent as T;
  }
  const content = Array.isArray(result.content) ? result.content : [];
  const firstText = content
    .map((item) => asRecord(item).text)
    .find((item): item is string => typeof item === "string");
  if (firstText === undefined) {
    return result as T;
  }
  return JSON.parse(firstText) as T;
}

function normalizeOAuthCachePath(oauthCachePath: string): string {
  if (!isAbsolute(oauthCachePath)) {
    throw new Error("oauthCachePath must be an absolute path.");
  }
  return oauthCachePath;
}

function removeUndefined(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(removeUndefined);
  }
  if (!isRecord(value)) {
    return value;
  }
  return Object.fromEntries(
    Object.entries(value)
      .filter(([, item]) => item !== undefined)
      .map(([key, item]) => [key, removeUndefined(item)]),
  );
}

function asRecord(value: unknown): Record<string, unknown> {
  if (isRecord(value)) {
    return value;
  }
  return {};
}

function recordFromUnknown(value: unknown): Record<string, unknown> | undefined {
  return isRecord(value) ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isStringRecord(value: unknown): value is Record<string, string> {
  return isRecord(value) && Object.values(value).every((item) => typeof item === "string");
}

function asOptionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function truthy(value: unknown): boolean {
  return value === true || value === "true" || value === 1;
}

function assignOptionalString<T extends object, K extends keyof T>(
  target: T,
  key: K,
  value: unknown,
): void {
  if (typeof value === "string") {
    (target as Record<string, unknown>)[String(key)] = value;
  }
}

const FIGMA_FILE_URL_KINDS = ["design", "file", "figjam", "board", "slides"] as const;

function parseFigmaFileReference(file: string | undefined): {
  fileUrl?: string;
  fileKey?: string;
  fileSlug?: string;
  surface?: FigmaWorkspaceSurface;
} {
  if (!file) {
    return {};
  }
  const value = file.trim();
  if (value.length === 0) {
    return {};
  }
  try {
    const url = new URL(value);
    return {
      fileUrl: value,
      fileKey: extractFigmaFileKey(value),
      fileSlug: extractFigmaFileSlug(value),
      surface: inferFigmaSurface(value),
    };
  } catch {
    if (isAbsolute(value) || value.includes("/") || value.includes("\\") || value.includes("..")) {
      throw new Error('Tool argument "file" must be a Figma URL or a simple Figma file key.');
    }
    return { fileKey: value };
  }
}

function extractFigmaFileKey(fileUrl: string | undefined): string | undefined {
  if (!fileUrl) {
    return undefined;
  }
  try {
    const url = new URL(fileUrl);
    const parts = url.pathname.split("/").filter(Boolean);
    const kindIndex = parts.findIndex((part) => FIGMA_FILE_URL_KINDS.includes(part as typeof FIGMA_FILE_URL_KINDS[number]));
    return kindIndex >= 0 ? parts[kindIndex + 1] : undefined;
  } catch {
    return undefined;
  }
}

function extractFigmaNodeId(value: string | undefined): string | undefined {
  if (!value) {
    return undefined;
  }
  try {
    const url = new URL(value);
    const nodeId = url.searchParams.get("node-id") ?? url.searchParams.get("node_id");
    return nodeId ? nodeId.replace(/-/gu, ":") : undefined;
  } catch {
    return undefined;
  }
}

function extractFigmaFileSlug(fileUrl: string | undefined): string | undefined {
  if (!fileUrl) {
    return undefined;
  }
  try {
    const url = new URL(fileUrl);
    const parts = url.pathname.split("/").filter(Boolean);
    const kindIndex = parts.findIndex((part) => FIGMA_FILE_URL_KINDS.includes(part as typeof FIGMA_FILE_URL_KINDS[number]));
    const name = kindIndex >= 0 ? parts[kindIndex + 2] : undefined;
    return name ? slugifyTaskName(decodeURIComponent(name)) : undefined;
  } catch {
    return undefined;
  }
}

function inferFigmaSurface(fileUrl: string | undefined): FigmaWorkspaceSurface | undefined {
  if (!fileUrl) {
    return undefined;
  }
  try {
    const url = new URL(fileUrl);
    const first = url.pathname.split("/").filter(Boolean)[0];
    if (first === "design" || first === "file") return "design";
    if (first === "figjam" || first === "board") return "figjam";
    if (first === "slides") return "slides";
    return undefined;
  } catch {
    return undefined;
  }
}

function normalizeSurface(value: unknown): FigmaWorkspaceSurface | undefined {
  if (value === "design" || value === "figjam" || value === "slides") {
    return value;
  }
  return undefined;
}

function normalizePositiveInteger(value: unknown, fallback: number): number {
  const number = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(number) || number <= 0) {
    return fallback;
  }
  return Math.floor(number);
}

function normalizeBoundedInteger(value: unknown, fallback: number, max: number): number {
  return Math.min(normalizePositiveInteger(value, fallback), max);
}

function literal(value: unknown): string {
  return JSON.stringify(value);
}
