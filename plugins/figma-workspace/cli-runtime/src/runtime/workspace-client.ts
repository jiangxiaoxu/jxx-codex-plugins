import { randomUUID } from "node:crypto";
import { AsyncLocalStorage } from "node:async_hooks";
import { tmpdir } from "node:os";
import { createReadStream } from "node:fs";
import { lstat, open, readFile, stat, type FileHandle } from "node:fs/promises";
import type { Stats } from "node:fs";
import { dirname, extname, isAbsolute, relative, resolve } from "node:path";
import { Transform } from "node:stream";
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
  readFigmaWorkspacePluginApiDeclaration,
  type FigmaWorkspacePluginApiDeclaration,
  type ReferenceSearchResult,
  type ReferenceSearchSnippetBudget,
  normalizeLookupQuery,
  normalizeLookupRankingQuery,
  searchReferenceFiles,
} from "./doc-search.js";
import {
  findWrapperLookupProfile,
} from "./guidance-catalog.js";
import { resolveTaskRoute, type TaskRouteResult } from "./task-routing.js";
import type { FigmaWorkspacePublicCommandId } from "./public-command-registry.js";
import {
  compileFigmaWorkspaceScriptFile,
  createFigmaWorkspaceRepairPlan,
  diagnoseWrappedScriptSize,
  getFigmaWorkspaceTypescriptRuntimeInfo,
  type FigmaWorkspaceDiagnostic,
  type FigmaWorkspaceDiagnosticSeverity,
  type FigmaWorkspaceFileDiagnostic,
  type FigmaWorkspaceRepairPlan,
  type FigmaWorkspaceSurface,
} from "./script-runner.js";
import {
  asApplyAssetManifestArgs,
  asCallUpstreamToolArgs,
  asCaptureNodeArgs,
  asDownloadAssetsArgs,
  asDocsArgs,
  asDoctorArgs,
  asGetDesignContextArgs,
  asGetLibrariesArgs,
  asGetMetadataArgs,
  asGetMotionContextArgs,
  asGetVariableDefsArgs,
  asInspectArgs,
  asLookupArgs,
  asRunArgs,
  asSearchDesignSystemArgs,
  asUpstreamToolsArgs,
  DOCS_CATALOG_LIMIT_MAX,
  DOCS_CATALOG_LIMIT_MIN,
  INLINE_RESULT_LIMIT_MAX,
  INLINE_RESULT_LIMIT_MIN,
  LOOKUP_RESULTS_MIN,
  LOOKUP_SNIPPET_LINES_MIN,
  withDefaultTitle,
} from "../contract/tool-args.js";
import { isCompositeCapableFigmaNodeId, isFigmaFileKey, isSimpleFigmaNodeId } from "../contract/figma-target.js";
import type {
  FigmaWorkspaceApplyAssetManifestArguments,
  FigmaWorkspaceCallUpstreamToolArguments,
  FigmaWorkspaceCaptureNodeArguments,
  FigmaWorkspaceDownloadAssetsArguments,
  FigmaWorkspaceDownloadAssetsTarget,
  FigmaWorkspaceDocsArguments,
  FigmaWorkspaceDoctorArguments,
  FigmaWorkspaceGetDesignContextArguments,
  FigmaWorkspaceGetLibrariesArguments,
  FigmaWorkspaceGetMetadataArguments,
  FigmaWorkspaceGetMotionContextArguments,
  FigmaWorkspaceGetVariableDefsArguments,
  FigmaWorkspaceInspectArguments,
  FigmaWorkspaceLookupArguments,
  FigmaWorkspaceRunArguments,
  FigmaWorkspaceSearchDesignSystemArguments,
  FigmaWorkspaceUpstreamToolsArguments,
} from "../contract/tool-args.js";
import {
  getFigmaWorkspaceProjectDocsRuntimeInfo,
  listFigmaWorkspaceProjectDocs,
  readFigmaWorkspaceProjectDoc,
} from "./project-docs.js";
import { isLocalWorkspaceToolName, type LocalWorkspaceToolName } from "../contract/tool-registry.js";
import {
  FIGMA_WORKSPACE_NODE_SCOPED_TARGET_DESCRIPTION,
  FIGMA_WORKSPACE_UPSTREAM_ESCAPE_HATCH_GUIDANCE,
  FIGMA_WORKSPACE_WRAPPER_CONTRACTS,
  getFigmaWorkspaceCoveredUpstreamToolNames,
  requireFigmaWorkspaceWrapperContract,
  type FigmaWorkspaceWrapperContract,
} from "../contract/wrapper-contracts.js";
import {
  captureImageOutputFilePath,
  assertInvocationManagedInputFile,
  createInvocationWorkspace,
  createRunOutputWriter,
  ensureInvocationWorkspaceDirectory,
  isMissingFileError,
  isMissingFileError as isFigmaWorkspaceMissingFileErrorForTesting,
  resolveInvocationAwareFile,
  resolveScriptInputPath,
  resolveWorkspaceFile,
  writeCaptureOutputFile,
  writeJsonFile,
  type FigmaWorkspaceInvocationWorkspace,
} from "./workspace-files.js";
import {
  atomicWriteManagedBinaryFile,
  atomicWriteManagedStreamFile,
} from "./managed-files.js";

/**
 * @internal Missing-file matcher used by cleanup regression tests.
 * This is not a stable package API.
 */
export { isFigmaWorkspaceMissingFileErrorForTesting };

/**
 * @internal Internal wrapper contract registry used by parity tests.
 * This is not a stable MCP tool input or response contract.
 */
export const FIGMA_WORKSPACE_INTERNAL_WRAPPER_CONTRACTS = FIGMA_WORKSPACE_WRAPPER_CONTRACTS;
export type {
  FigmaWorkspaceDiagnostic,
  FigmaWorkspaceDiagnosticSeverity,
  FigmaWorkspaceFileDiagnostic,
  FigmaWorkspaceSurface,
};
export type { FigmaWorkspaceInvocationWorkspace } from "./workspace-files.js";
export type {
  FigmaWorkspaceApplyAssetManifestArguments,
  FigmaWorkspaceAssetManifestAsset,
  FigmaWorkspaceCallUpstreamToolArguments,
  FigmaWorkspaceCaptureNodeArguments,
  FigmaWorkspaceDownloadAssetsArguments,
  FigmaWorkspaceDownloadAssetsTarget,
  FigmaWorkspaceGetDesignContextArguments,
  FigmaWorkspaceGetLibrariesArguments,
  FigmaWorkspaceGetMetadataArguments,
  FigmaWorkspaceGetMotionContextArguments,
  FigmaWorkspaceGetVariableDefsArguments,
  FigmaWorkspaceInspectArguments,
  FigmaWorkspaceLookupArguments,
  FigmaWorkspaceRunArguments,
  FigmaWorkspaceSearchDesignSystemArguments,
} from "../contract/tool-args.js";

const DEFAULT_EVAL_CONTRACT = requireFigmaWorkspaceWrapperContract("figma_workspace_run");
const DEFAULT_EVAL_TOOL_NAME = requireWrapperUpstreamToolName(DEFAULT_EVAL_CONTRACT);
const DEFAULT_EVAL_ARGUMENT_NAME = requireWrapperUpstreamProperty(DEFAULT_EVAL_CONTRACT, "code");
const DEFAULT_EVAL_DESCRIPTION = "Figma Workspace Plugin API execution";
const DEFAULT_INLINE_RESULT_LIMIT = 2_048;
const MAX_QUEUED_CAPTURE_REQUESTS = 8;
const MAX_MANIFEST_ITEMS = 64;
const MAX_MANIFEST_FILE_BYTES = 256 * 1024;
const MAX_SINGLE_ASSET_BYTES = 16 * 1024 * 1024;
const MAX_COMMAND_DATA_PLANE_BYTES = 64 * 1024 * 1024;
const NETWORK_REQUEST_TOTAL_TIMEOUT_MS = 5 * 60 * 1000;
const NETWORK_REQUEST_IDLE_TIMEOUT_MS = 60 * 1000;
const QUEUED_CAPTURE_ERROR_MESSAGE_BYTES = 600;
const QUEUED_CAPTURE_DIAGNOSTIC_FIELD_BYTES = 300;
const QUEUED_CAPTURE_FAILURE_RETRY_GUIDANCE = "Script execution succeeded and may have mutated Figma. Do not rerun it just because capture post-processing failed; retry the affected node with figma:capture.";
const UNKNOWN_EXECUTION_RETRY_GUIDANCE = "The execution request was dispatched, but Figma completion could not be confirmed. Do not rerun the mutation blindly. Inspect or read back the target and reconcile the observed state before deciding whether any retry is safe.";
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

class DataPlaneResourceBudget {
  #usedBytes = 0;

  get remainingBytes(): number {
    return MAX_COMMAND_DATA_PLANE_BYTES - this.#usedBytes;
  }

  assertCanConsume(bytes: number, label: string): void {
    if (!Number.isSafeInteger(bytes) || bytes < 0) {
      throw resourceLimitError(`${label} reported an invalid byte length.`);
    }
    if (bytes > this.remainingBytes) {
      throw resourceLimitError(
        `${label} would exceed the ${formatDataPlaneLimit(MAX_COMMAND_DATA_PLANE_BYTES)} per-command data-plane limit.`,
      );
    }
  }

  consume(bytes: number, label: string): void {
    this.assertCanConsume(bytes, label);
    this.#usedBytes += bytes;
  }
}

interface CommandResourceContext {
  resourceBudget: DataPlaneResourceBudget;
}

const COMMAND_RESOURCE_CONTEXT = new AsyncLocalStorage<CommandResourceContext>();

function runWithCommandResourceContext<T>(operation: () => Promise<T>): Promise<T> {
  return COMMAND_RESOURCE_CONTEXT.run(
    { resourceBudget: new DataPlaneResourceBudget() },
    operation,
  );
}

function commandResourceBudget(): DataPlaneResourceBudget {
  return COMMAND_RESOURCE_CONTEXT.getStore()?.resourceBudget ?? new DataPlaneResourceBudget();
}

class NetworkRequestDeadline {
  readonly controller = new AbortController();
  #totalTimer: NodeJS.Timeout;
  #idleTimer: NodeJS.Timeout | undefined;

  constructor(
    private readonly label: string,
    options: { idleTimeout?: boolean } = {},
  ) {
    this.#totalTimer = setTimeout(() => {
      this.controller.abort(networkTimeoutError(`${this.label} exceeded the 5-minute total timeout.`));
    }, NETWORK_REQUEST_TOTAL_TIMEOUT_MS);
    this.#totalTimer.unref?.();
    if (options.idleTimeout !== false) this.touch();
  }

  touch(): void {
    if (this.#idleTimer) clearTimeout(this.#idleTimer);
    this.#idleTimer = setTimeout(() => {
      this.controller.abort(networkTimeoutError(`${this.label} had no data activity for 60 seconds.`));
    }, NETWORK_REQUEST_IDLE_TIMEOUT_MS);
    this.#idleTimer.unref?.();
  }

  dispose(): void {
    clearTimeout(this.#totalTimer);
    if (this.#idleTimer) clearTimeout(this.#idleTimer);
  }
}

async function awaitUpstreamOperation<T>(
  label: string,
  operation: (signal: AbortSignal) => Promise<T>,
  options: { countResponse: boolean },
): Promise<T> {
  const deadline = new NetworkRequestDeadline(label, { idleTimeout: false });
  let rejectOnAbort: ((reason: unknown) => void) | undefined;
  const aborted = new Promise<never>((_resolve, reject) => {
    rejectOnAbort = reject;
  });
  const handleAbort = (): void => {
    rejectOnAbort?.(deadline.controller.signal.reason ?? networkTimeoutError(`${label} timed out.`));
  };
  deadline.controller.signal.addEventListener("abort", handleAbort, { once: true });
  try {
    const result = await Promise.race([operation(deadline.controller.signal), aborted]);
    if (options.countResponse) {
      const serialized = JSON.stringify(result);
      if (serialized === undefined) {
        throw new PostResponseResourceError(
          resourceLimitError(`${label} returned a non-JSON-serializable response.`),
          result,
        );
      }
      try {
        commandResourceBudget().consume(Buffer.byteLength(serialized, "utf8"), `${label} response`);
      } catch (error) {
        throw new PostResponseResourceError(error, result);
      }
    }
    return result;
  } finally {
    deadline.controller.signal.removeEventListener("abort", handleAbort);
    deadline.dispose();
  }
}

class PostResponseResourceError extends Error {
  readonly code = "FIGMA_WORKSPACE_RESOURCE_LIMIT_EXCEEDED";
  constructor(readonly cause: unknown, readonly response: unknown) {
    super(errorMessage(cause), { cause });
    this.name = "PostResponseResourceError";
  }
}

async function connectUpstream(client: FigmaUpstreamMcpProxyClient, label: string): Promise<void> {
  await awaitUpstreamOperation(`${label} connection`, () => client.connect(), { countResponse: false });
}

async function listUpstreamToolsWithLimits(
  client: FigmaUpstreamMcpProxyClient,
  label: string,
): Promise<unknown> {
  return awaitUpstreamOperation(
    `${label} tool discovery`,
    (signal) => client.listTools(signal),
    { countResponse: true },
  );
}

async function callUpstreamToolWithLimits(
  client: FigmaUpstreamMcpProxyClient,
  toolName: string,
  args: Record<string, unknown>,
): Promise<unknown> {
  return awaitUpstreamOperation(
    `Upstream tool ${toolName}`,
    (signal) => client.callTool(toolName, args, signal),
    { countResponse: true },
  );
}

function resourceLimitError(message: string): Error {
  return Object.assign(new Error(message), { code: "FIGMA_WORKSPACE_RESOURCE_LIMIT_EXCEEDED" });
}

function networkTimeoutError(message: string): Error {
  return Object.assign(new Error(message), { code: "FIGMA_WORKSPACE_NETWORK_TIMEOUT" });
}

function formatDataPlaneLimit(bytes: number): string {
  if (bytes % (1024 * 1024) === 0) return `${bytes / (1024 * 1024)} MiB`;
  if (bytes % 1024 === 0) return `${bytes / 1024} KiB`;
  return `${bytes} bytes`;
}

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
    message: `The command skipped optional upstream argument "${options.property}" because the live official ${options.upstreamKind} capability does not advertise inputSchema.properties.${options.property}.`,
    suggestion: "No local repair is required unless the upstream call needed this optional behavior; run npm run upstream:contract:check from plugins/figma-workspace/cli-runtime to audit official schema drift.",
    docsHint: "Prefer first-class figma:* commands for covered workflows; use figma:upstream:call for uncovered official capabilities.",
  };
}

export interface FigmaWorkspaceUpstreamClient {
  connect(): Promise<void>;
  close(): Promise<void>;
  listTools(signal?: AbortSignal): Promise<unknown>;
  callTool(name: string, args?: Record<string, unknown>, signal?: AbortSignal): Promise<unknown>;
}

type FigmaUpstreamMcpProxyClient = FigmaWorkspaceUpstreamClient;

export interface FigmaWorkspaceClientOptions extends RemoteMcpClientOptions {
  client?: FigmaWorkspaceUpstreamClient;
  invocationId?: string;
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

export interface FigmaWorkspaceToolResultBase {
  [key: string]: unknown;
  ok: boolean;
}

export interface FigmaWorkspaceUpstreamBackedResult extends FigmaWorkspaceToolResultBase {
  upstream: FigmaWorkspaceUpstreamEnvelope;
  upstreamError?: FigmaWorkspacePublicUpstreamError;
}

export type FigmaWorkspaceExecutionOutcome = "not_started" | "succeeded" | "outcome_unknown";

export interface FigmaWorkspaceCompactScriptMetadata {
  [key: string]: unknown;
  scriptPath?: string;
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

export interface FigmaWorkspaceRunResult extends FigmaWorkspaceToolResultBase {
  phase: "preflight" | "execute";
  executionOutcome: FigmaWorkspaceExecutionOutcome;
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
  name?: string;
  validation?: unknown;
  upstreamError?: FigmaWorkspacePublicUpstreamError;
}

export interface FigmaWorkspaceApplyAssetManifestResult extends FigmaWorkspaceToolResultBase {
  assets: FigmaWorkspaceAssetManifestItem[];
  diagnostics?: FigmaWorkspaceDiagnostic[];
  validation?: unknown;
  failures?: Array<Record<string, unknown>>;
  outputFiles?: FigmaWorkspaceOutputFiles;
}

export interface FigmaWorkspaceDownloadedAssetFile extends FigmaWorkspaceFilePointer {
  [key: string]: unknown;
  kind: DownloadAssetKind;
  sourceUrl?: string;
  mimeType?: string;
  format?: string;
}

export interface FigmaWorkspaceDownloadAssetsTargetResult {
  [key: string]: unknown;
  ok: boolean;
  targetNodeId: string;
  name?: string;
  outputDir: string;
  downloadedFiles: FigmaWorkspaceDownloadedAssetFile[];
  upstreamError?: FigmaWorkspacePublicUpstreamError;
  downloadError?: FigmaWorkspacePublicUpstreamError;
}

export interface FigmaWorkspaceDownloadAssetsResult extends FigmaWorkspaceToolResultBase {
  outputDir: string;
  targets: FigmaWorkspaceDownloadAssetsTargetResult[];
  failures?: Array<Record<string, unknown>>;
  outputFiles?: FigmaWorkspaceOutputFiles;
}

export interface FigmaWorkspaceCaptureNodeResult extends FigmaWorkspaceToolResultBase {
  imageFile?: string;
  nodeId: string;
  bytes?: number;
  width?: number;
  height?: number;
  upstreamError?: FigmaWorkspacePublicUpstreamError;
}

export interface FigmaWorkspaceNextAction {
  commandId: FigmaWorkspacePublicCommandId;
  args: Record<string, string | number | boolean>;
  reason: string;
  priority: number;
}

export interface FigmaWorkspaceInspectResult extends FigmaWorkspaceToolResultBase {
  diagnostics?: FigmaWorkspaceDiagnostic[];
  upstreamError?: FigmaWorkspacePublicUpstreamError;
}

export interface FigmaWorkspaceCallUpstreamToolResult extends FigmaWorkspaceUpstreamBackedResult {
  toolName: string;
  outputFiles?: FigmaWorkspaceOutputFiles;
  inlineResultLimit?: FigmaWorkspaceInlineResultLimit;
}

export interface FigmaWorkspaceSearchDesignSystemResult extends FigmaWorkspaceUpstreamBackedResult {
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
  fileKey: string;
  nodeId: string;
  guidanceRef?: FigmaWorkspaceWrapperGuidanceRef;
  outputFiles?: FigmaWorkspaceOutputFiles;
  inlineResultLimit?: FigmaWorkspaceInlineResultLimit;
}

export interface FigmaWorkspaceGetMotionContextResult extends FigmaWorkspaceUpstreamBackedResult {
  fileKey: string;
  nodeId: string;
  guidanceRef?: FigmaWorkspaceWrapperGuidanceRef;
  outputFiles?: FigmaWorkspaceOutputFiles;
  inlineResultLimit?: FigmaWorkspaceInlineResultLimit;
}


export interface FigmaWorkspaceGetLibrariesResult extends FigmaWorkspaceUpstreamBackedResult {
  fileKey: string;
  offset?: number;
  outputFiles?: FigmaWorkspaceOutputFiles;
  inlineResultLimit?: FigmaWorkspaceInlineResultLimit;
}

export interface FigmaWorkspaceGetVariableDefsResult extends FigmaWorkspaceUpstreamBackedResult {
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
const FIGMA_ASSET_APPLICATION_BATCH_SIZE = 80;
const FIGMA_ASSET_VALIDATION_BATCH_SIZE = 80;

interface FigmaWorkspaceMetadataEnrichmentSummary {
  ok: boolean;
  source: "native-plugin-api";
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
  source: "figma:metadata";
  fileKey: string;
  nodeId?: string;
  nodeCount: number;
  root?: FigmaWorkspaceMetadataTreeNode;
}

export interface FigmaWorkspaceGetMetadataResult extends FigmaWorkspaceToolResultBase {
  fileKey: string;
  nodeId?: string;
  metadata: {
    [key: string]: unknown;
    format: "figma-metadata-tree";
    source: "figma:metadata";
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

interface FigmaWorkspaceLookupResultBase extends FigmaWorkspaceToolResultBase {
  guidance: string;
  diagnostics?: FigmaWorkspaceDiagnostic[];
  runtime?: Record<string, unknown>;
}

export interface FigmaWorkspaceLookupSearchResult extends FigmaWorkspaceLookupResultBase {
  ok: true;
  mode: "search";
  requestedScope?: "auto" | "active" | "conditional" | "router" | "examples" | "all";
  effectiveScopes?: string[];
  route?: TaskRouteResult;
  results: ReferenceSearchResult[];
  snippetBudget?: ReferenceSearchSnippetBudget;
  parameterAdjustments?: FigmaWorkspaceLookupParameterAdjustment[];
  nextActions?: FigmaWorkspaceNextAction[];
}

export interface FigmaWorkspaceLookupReadResult extends FigmaWorkspaceLookupResultBase {
  ok: true;
  mode: "read";
  declaration: FigmaWorkspacePluginApiDeclaration;
}

export interface FigmaWorkspaceLookupFailureResult extends FigmaWorkspaceLookupResultBase {
  ok: false;
  mode: "search" | "read";
  results?: [];
}

export type FigmaWorkspaceLookupResult =
  | FigmaWorkspaceLookupSearchResult
  | FigmaWorkspaceLookupReadResult
  | FigmaWorkspaceLookupFailureResult;

export interface FigmaWorkspaceIntegerParameterAdjustment<
  Option extends string = string,
> {
  option: Option;
  requested: number;
  applied: number;
  range: [number, number];
}

export type FigmaWorkspaceLookupParameterAdjustment = FigmaWorkspaceIntegerParameterAdjustment<
  "--limit" | "--snippet-lines"
>;

export type FigmaWorkspaceDocsParameterAdjustment = FigmaWorkspaceIntegerParameterAdjustment<
  "--limit"
>;

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
  parameterAdjustments?: FigmaWorkspaceDocsParameterAdjustment[];
}

export interface FigmaWorkspaceDoctorResult extends FigmaWorkspaceToolResultBase {
  runtime: {
    projectDocs: ReturnType<typeof getFigmaWorkspaceProjectDocsRuntimeInfo>;
    lookup: ReturnType<typeof getFigmaWorkspaceLookupRuntimeInfo>;
    typescript: ReturnType<typeof getFigmaWorkspaceTypescriptRuntimeInfo>;
  };
  guidance: string[];
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
  connect(): Promise<void>;
  close(): Promise<void>;
  run(args: FigmaWorkspaceRunArguments): Promise<FigmaWorkspaceRunResult>;
  applyAssetManifest(args: FigmaWorkspaceApplyAssetManifestArguments): Promise<FigmaWorkspaceApplyAssetManifestResult>;
  downloadAssets(args: FigmaWorkspaceDownloadAssetsArguments): Promise<FigmaWorkspaceDownloadAssetsResult>;
  captureNode(args: FigmaWorkspaceCaptureNodeArguments): Promise<FigmaWorkspaceCaptureNodeResult>;
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
  upstreamTools(args?: FigmaWorkspaceUpstreamToolsArguments): Promise<FigmaWorkspaceUpstreamToolsResult>;
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
  mimeType: RasterAssetMimeType;
  targetNodeId: string;
  fileKey?: string;
  nodeUrl?: string;
  scaleMode?: string;
  name?: string;
  metadata?: Record<string, unknown>;
}

interface OpenedAssetInput {
  asset: NormalizedAssetManifestAsset;
  handle: FileHandle;
  stats: Stats;
}

interface NormalizedDownloadAssetsManifest {
  targets: NormalizedDownloadAssetsTarget[];
}

interface NormalizedDownloadAssetsTarget {
  targetNodeId: string;
  fileKey?: string;
  name?: string;
  defaultFormat?: "png" | "jpg" | "svg" | "pdf";
  defaultScale?: number;
}

type RasterAssetMimeType = "image/png" | "image/jpeg" | "image/gif" | "image/webp";
type DownloadAssetKind = "exported" | "raw" | "svg";
const SVG_CONTENT_SNIFF_BYTES = 64 * 1024;

interface DownloadAssetLink {
  kind: DownloadAssetKind;
  url: string;
  format?: string;
  name?: string;
}

interface DownloadAssetLinkCollection {
  links: DownloadAssetLink[];
  unsupportedSvgAssetCount: number;
}

interface FigmaWorkspaceRuntime {
  client: FigmaWorkspaceUpstreamClient;
  upstreamToolCache: ReturnType<typeof createUpstreamToolCache>;
  invocationId?: string;
}

interface FigmaWorkspaceInvocationContext {
  invocationId: string;
  slug: string;
  cwd: string;
  outputRoot: string;
  fileUrl?: string;
  fileKey?: string;
  surface?: FigmaWorkspaceSurface;
  lastDiagnostics: FigmaWorkspaceDiagnostic[];
  workspace?: FigmaWorkspaceInvocationWorkspace;
}

const INVOCATION_CONTEXT = new AsyncLocalStorage<FigmaWorkspaceInvocationContext>();

function currentInvocationContext(): FigmaWorkspaceInvocationContext {
  const invocation = INVOCATION_CONTEXT.getStore();
  if (!invocation) {
    throw new Error("Figma Workspace operation is missing its invocation context.");
  }
  return invocation;
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
  const upstreamToolCache = createUpstreamToolCache(client);

  return { client, upstreamToolCache, invocationId: options.invocationId };
}

async function prepareStatelessInvocation(
  args: { file?: string; surface?: FigmaWorkspaceSurface; outputDir?: string },
  runtime: FigmaWorkspaceRuntime,
): Promise<FigmaWorkspaceInvocationContext> {
  const invocationId = runtime.invocationId ?? randomUUID();
  const session: FigmaWorkspaceInvocationContext = {
    invocationId,
    slug: slugifyTaskName(invocationId),
    cwd: process.cwd(),
    outputRoot: resolve(tmpdir(), "figma-workspace", invocationId),
    lastDiagnostics: [],
  };
  applyInvocationFileReference(session, args.file);
  const parsedFile = parseFigmaFileReference(args.file);
  session.surface = args.surface ?? parsedFile.surface;
  if (args.outputDir) {
    const outputRoot = resolve(session.cwd, args.outputDir);
    session.outputRoot = outputRoot;
    session.workspace = createInvocationWorkspace({ outputDir: outputRoot });
    await ensureInvocationWorkspaceDirectory(session.workspace);
  }
  return session;
}

async function runWithStatelessInvocation<T>(
  args: { file?: string; surface?: FigmaWorkspaceSurface; outputDir?: string },
  runtime: FigmaWorkspaceRuntime,
  operation: () => Promise<T>,
): Promise<T> {
  const invocation = await prepareStatelessInvocation(args, runtime);
  return INVOCATION_CONTEXT.run(invocation, operation);
}

function requireExplicitSurfaceForRawFile(
  args: { file?: string; surface?: FigmaWorkspaceSurface },
  command: string,
): void {
  if (args.file && !parseFigmaFileReference(args.file).fileUrl && !args.surface) {
    throw new Error(`${command} requires explicit "surface" (design, figjam, or slides) when "file" is a raw Figma file key because it uses native Plugin API execution.`);
  }
}

export function createFigmaWorkspaceClient(
  options: FigmaWorkspaceClientOptions = {},
): FigmaWorkspaceClient {
  const runtime = createFigmaWorkspaceRuntime(options);
  return {
    client: runtime.client,
    connect: () => runWithCommandResourceContext(
      async () => connectUpstream(runtime.client, "Connect Figma Workspace client"),
    ),
    close: () => runtime.client.close(),
    run: async (args) => runWithCommandResourceContext(async () => {
      const parsed = asRunArgs(withDefaultTitle(args, "Run Figma TypeScript file"));
      requireExplicitSurfaceForRawFile(parsed, "figma:run");
      return runWithStatelessInvocation(parsed, runtime, () =>
        executeRun(parsed, runtime) as Promise<FigmaWorkspaceRunResult>);
    }),
    applyAssetManifest: async (args) => runWithCommandResourceContext(async () => {
      const parsed = asApplyAssetManifestArgs(withDefaultTitle(args, "Apply Figma asset manifest"));
      requireExplicitSurfaceForRawFile(parsed, "figma:assets:apply");
      return runWithStatelessInvocation(parsed, runtime, () =>
        executeApplyAssetManifest(parsed, runtime) as Promise<FigmaWorkspaceApplyAssetManifestResult>);
    }),
    downloadAssets: async (args) => runWithCommandResourceContext(async () => {
      const parsed = asDownloadAssetsArgs(withDefaultTitle(args, "Download Figma assets"));
      return runWithStatelessInvocation(parsed, runtime, () =>
        executeDownloadAssets(parsed, runtime) as Promise<FigmaWorkspaceDownloadAssetsResult>);
    }),
    captureNode: async (args) => runWithCommandResourceContext(async () => {
      const parsed = asCaptureNodeArgs(withDefaultTitle(args, "Capture Figma node"));
      return runWithStatelessInvocation(parsed, runtime, () =>
        executeCaptureNode(parsed, runtime) as Promise<FigmaWorkspaceCaptureNodeResult>);
    }),
    inspect: async (args = {}) => runWithCommandResourceContext(async () => {
      const parsed = asInspectArgs(withDefaultTitle(args, "Inspect Figma Workspace target"));
      requireExplicitSurfaceForRawFile(parsed, "figma:inspect");
      return runWithStatelessInvocation(parsed, runtime, async () =>
        parseJsonToolResult<FigmaWorkspaceInspectResult>(await handleInspect(parsed, runtime)));
    }),
    getMetadata: async (args) => runWithCommandResourceContext(async () => {
      const parsed = asGetMetadataArgs(withDefaultTitle(args, "Read Figma metadata as JSON"));
      return runWithStatelessInvocation(parsed, runtime, () =>
        executeGetMetadata(parsed, runtime) as Promise<FigmaWorkspaceGetMetadataResult>);
    }),
    getDesignContext: async (args) => runWithCommandResourceContext(async () => {
      const parsed = asGetDesignContextArgs(withDefaultTitle(args, "Get Figma design context"));
      return runWithStatelessInvocation(parsed, runtime, () =>
        executeGetDesignContext(parsed, runtime) as Promise<FigmaWorkspaceGetDesignContextResult>);
    }),
    getMotionContext: async (args) => runWithCommandResourceContext(async () => {
      const parsed = asGetMotionContextArgs(withDefaultTitle(args, "Get Figma motion context"));
      return runWithStatelessInvocation(parsed, runtime, () =>
        executeGetMotionContext(parsed, runtime) as Promise<FigmaWorkspaceGetMotionContextResult>);
    }),
    searchDesignSystem: async (args) => runWithCommandResourceContext(async () => {
      const parsed = asSearchDesignSystemArgs(withDefaultTitle(args, "Search Figma design system"));
      return runWithStatelessInvocation(parsed, runtime, () =>
        executeSearchDesignSystem(parsed, runtime) as Promise<FigmaWorkspaceSearchDesignSystemResult>);
    }),
    getLibraries: async (args = {}) => runWithCommandResourceContext(async () => {
      const parsed = asGetLibrariesArgs(withDefaultTitle(args, "Get Figma libraries"));
      return runWithStatelessInvocation(parsed, runtime, () =>
        executeGetLibraries(parsed, runtime) as Promise<FigmaWorkspaceGetLibrariesResult>);
    }),
    getVariableDefs: async (args) => runWithCommandResourceContext(async () => {
      const parsed = asGetVariableDefsArgs(withDefaultTitle(args, "Get Figma variable definitions"));
      return runWithStatelessInvocation(parsed, runtime, () =>
        executeGetVariableDefs(parsed, runtime) as Promise<FigmaWorkspaceGetVariableDefsResult>);
    }),
    callUpstreamTool: async (args) => runWithCommandResourceContext(async () => {
      const parsed = asCallUpstreamToolArgs(withDefaultTitle(args, "Call upstream Figma MCP tool"));
      return runWithStatelessInvocation(parsed, runtime, () =>
        executeCallUpstreamTool(parsed, runtime) as Promise<FigmaWorkspaceCallUpstreamToolResult>);
    }),
    lookup: async (args) =>
      parseJsonToolResult<FigmaWorkspaceLookupResult>(
        await handleLookup(asLookupArgs(withDefaultTitle(args, "Look up Figma Workspace reference"))),
      ),
    docs: async (args) => handleDocs(asDocsArgs(args)),
    doctor: async (args = {}) => handleDoctor(asDoctorArgs(args)),
    upstreamTools: async (args = {}) => runWithCommandResourceContext(
      async () => handleUpstreamTools(asUpstreamToolsArgs(args), runtime.upstreamToolCache),
    ),
  };
}

function handleDocs(args: FigmaWorkspaceDocsArguments): FigmaWorkspaceDocsResult {
  if (args.mode === "list") {
    return { ok: true, mode: "list", topics: listFigmaWorkspaceProjectDocs() };
  }
  if (args.mode === "catalog") {
    const parameterAdjustments: FigmaWorkspaceDocsParameterAdjustment[] = [];
    const limit = clampIntegerParameter({
      option: "--limit",
      requested: args.limit,
      fallback: DOCS_CATALOG_LIMIT_MAX,
      min: DOCS_CATALOG_LIMIT_MIN,
      max: DOCS_CATALOG_LIMIT_MAX,
      parameterAdjustments,
    });
    const catalog = listFigmaWorkspaceCanonicalCatalog({
      taskFamily: args.taskFamily,
      surface: args.surface,
      classification: args.classification,
      limit,
    });
    return args.taskFamily === undefined
      ? {
        ok: true,
        mode: "catalog",
        taskFamilies: catalog,
        ...(parameterAdjustments.length > 0 ? { parameterAdjustments } : {}),
      }
      : {
        ok: true,
        mode: "catalog",
        records: catalog,
        ...(parameterAdjustments.length > 0 ? { parameterAdjustments } : {}),
      };
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
      guidance: "Prefer a first-class figma:* command when available; use figma:upstream:call for uncovered official behavior.",
    };
  }
  return {
    ok: true,
    tools: tools.map(upstreamToolDirectoryEntry),
    categories: [...UPSTREAM_TOOL_DIRECTORY_CATEGORY_ORDER],
    guidance: "Use a first-class figma:* command when available; read the schema with figma:upstream:read before figma:upstream:call.",
  };
}
async function writeCallUpstreamResultFiles(options: {
  toolName: string;
  wrapperToolName: string;
  session: FigmaWorkspaceInvocationContext;
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
  session: FigmaWorkspaceInvocationContext;
  metadata: FigmaWorkspaceMetadataJson;
}): Promise<FigmaWorkspaceFilePointer> {
  const metadataFile = metadataResultFilePath(options.session);
  return responseFilePointer(await writeJsonFile(metadataFile, options.metadata));
}

function metadataResultFilePath(session: FigmaWorkspaceInvocationContext): string {
  const timestamp = new Date().toISOString().replace(/[^\dTZ]/gu, "");
  const fileName = `metadata-${timestamp}.metadata.json`;
  if (session.workspace) {
    return resolveWorkspaceFile(session.workspace.outputDir, fileName, "metadataFile");
  }
  return resolveWorkspaceFile(session.outputRoot, fileName, "metadataFile");
}

function resolveCallUpstreamOutputFile(toolName: string, session: FigmaWorkspaceInvocationContext): string {
  const timestamp = new Date().toISOString().replace(/[^\dTZ]/gu, "");
  const fileName = `upstream-${slugifyTaskName(toolName || "tool")}-${timestamp}.result.json`;
  if (session.workspace) {
    return resolveWorkspaceFile(session.workspace.outputDir, fileName, "debugFile");
  }
  return resolveWorkspaceFile(session.outputRoot, fileName, "debugFile");
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
  session: FigmaWorkspaceInvocationContext;
  ok: boolean;
  fields?: Record<string, unknown>;
}): Record<string, unknown> {
  return removeUndefined({
    kind: "figma-cli-result",
    ok: options.ok,
    tool: options.tool,
    invocationId: options.session.invocationId,
    generatedAt: new Date().toISOString(),
    ...options.fields,
  }) as Record<string, unknown>;
}

function createUpstreamBackedResultFilePayload(options: {
  tool: string;
  session: FigmaWorkspaceInvocationContext;
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
  session: FigmaWorkspaceInvocationContext;
  resultPayload: Record<string, unknown>;
  diagnostics: FigmaWorkspaceDiagnostic[];
  parsed?: ParsedUpstreamToolResult;
  upstream?: Record<string, unknown>;
}): Record<string, unknown> {
  const script = asRecord(options.resultPayload.script);
  return createUpstreamBackedResultFilePayload({
    tool: "figma:run",
    session: options.session,
    resultPayload: options.resultPayload,
    upstream: options.upstream,
    fields: {
      phase: asOptionalString(options.resultPayload.phase),
      executionOutcome: asOptionalString(options.resultPayload.executionOutcome),
      diagnosticsCount: options.diagnostics.length,
      fatalDiagnostics: options.diagnostics.filter((item) => item.severity === "fatal").length,
      warningDiagnostics: options.diagnostics.filter((item) => item.severity === "warning").length,
      diagnostics: options.diagnostics.length > 0 ? options.diagnostics : undefined,
      repairPlan: options.resultPayload.repairPlan,
      script,
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

async function executeRun(
  args: FigmaWorkspaceRunArguments,
  runtime: {
    client: FigmaUpstreamMcpProxyClient;
    upstreamToolCache: ReturnType<typeof createUpstreamToolCache>;
  },
): Promise<Record<string, unknown>> {
  const session = currentInvocationContext();
  const inlineSource = asOptionalString(args.source);
  const scriptPath = inlineSource
    ? resolveWorkspaceFile(session.outputRoot, "stdin.figma.ts", "scriptPath")
    : resolveScriptInputPath(args);
  const outputWriter = createRunOutputWriter(args, session);
  await outputWriter.cleanupCompiledScriptFile();
  const inlineResultLimit = normalizeInlineResultLimit(args.inlineResultLimit ?? DEFAULT_INLINE_RESULT_LIMIT);
  let source: string;
  try {
    if (inlineSource) {
      source = inlineSource;
    } else {
      await assertInvocationManagedInputFile(scriptPath, session);
      source = await readFile(scriptPath, "utf8");
      await assertInvocationManagedInputFile(scriptPath, session);
    }
  } catch (error) {
    if (!isMissingFileError(error)) {
      throw error;
    }
    const diagnostics: FigmaWorkspaceFileDiagnostic[] = [
      {
        code: "FIGMA_WORKSPACE_INPUT_FILE_MISSING",
        severity: "fatal",
        message: `Figma Workspace script file was not found: ${scriptPath}`,
        suggestion: "Create the .figma.ts file at the reported path or pass the correct --script path.",
        docsHint: "Use figma:run with exactly one of --script <path> or --source -.",
        source: { scriptPath },
      },
    ];
    session.lastDiagnostics = diagnostics;
    const resultPayload = removeUndefined({
      ok: false,
      phase: "preflight",
      executionOutcome: "not_started",
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

  const compiled = compileFigmaWorkspaceScriptFile({
    scriptPath,
    source,
    targetPageId: args.targetPageId,
    expectedSurface,
  });
  const wrappedScript = buildFigmaEvalScript({
    session,
    code: compiled.code,
  });
  const diagnostics = [
    ...compiled.diagnostics,
    ...diagnoseWrappedScriptSize(scriptPath, wrappedScript),
  ];
  session.lastDiagnostics = diagnostics;
  const scriptMetadata = {
    ...compiled.metadata,
    compiledScriptBytes: Buffer.byteLength(wrappedScript, "utf8"),
  };
  const responseScript = responseScriptMetadata(scriptMetadata);
  const successScript = responseRunSuccessMetadata(args);
  const fatalDiagnostics = diagnostics.filter((diagnostic) => diagnostic.severity === "fatal");

  if (fatalDiagnostics.length > 0) {
    const resultPayload = removeUndefined({
      ok: false,
      phase: "preflight",
      executionOutcome: "not_started",
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

  let evalSettings: EvalSettings;
  try {
    evalSettings = await resolveEvalSettings(session, args as Record<string, unknown>, runtime);
  } catch (error) {
    const upstreamError = normalizeCaughtUpstreamError(error);
    const resultPayload = removeUndefined({
      ok: false,
      phase: "preflight",
      executionOutcome: "not_started",
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
  const attempt = await attemptUpstreamEval(runtime.client, evalSettings, wrappedScript);
  if (attempt.error) {
    const resultPayload = removeUndefined({
      ok: false,
      phase: attempt.requestDispatched ? "execute" : "preflight",
      executionOutcome: attempt.requestDispatched ? "outcome_unknown" : "not_started",
      retryGuidance: attempt.requestDispatched ? UNKNOWN_EXECUTION_RETRY_GUIDANCE : undefined,
      diagnostics: diagnosticsForResponse(diagnostics),
      repairPlan: repairPlanForResponse(diagnostics),
      script: responseScript,
      upstreamError: responseUpstreamError(attempt.error),
    }) as Record<string, unknown>;
    const payloadWithOutputFiles = await attachPostExecutionOutputFiles({
      resultPayload,
      stage: "scriptResultSidecars",
      write: () => outputWriter.write({
        result: createRunScriptResultFilePayload({
          session,
          resultPayload,
          diagnostics,
        }),
        compiledScript: wrappedScript,
        writeResult: true,
      }),
    });
    return limitInlineScriptResult(
      payloadWithOutputFiles,
      inlineResultLimit,
      [],
    );
  }
  const upstream = attempt.upstream;
  let parsed: ParsedUpstreamToolResult;
  try {
    parsed = parseUpstreamToolResult(upstream);
  } catch (error) {
    const upstreamError = normalizeCaughtUpstreamError(error);
    const resultPayload = removeUndefined({
      ok: false,
      phase: "execute",
      executionOutcome: "outcome_unknown",
      retryGuidance: UNKNOWN_EXECUTION_RETRY_GUIDANCE,
      diagnostics: diagnosticsForResponse(diagnostics),
      repairPlan: repairPlanForResponse(diagnostics),
      script: responseScript,
      upstreamError: responseUpstreamError(upstreamError),
    }) as Record<string, unknown>;
    const payloadWithOutputFiles = await attachPostExecutionOutputFiles({
      resultPayload,
      stage: "scriptResultSidecars",
      write: () => outputWriter.write({
        result: createRunScriptResultFilePayload({
          session,
          resultPayload,
          diagnostics,
        }),
        compiledScript: wrappedScript,
        writeResult: true,
      }),
    });
    return limitInlineScriptResult(
      payloadWithOutputFiles,
      inlineResultLimit,
      [],
    );
  }
  if (attempt.postResponseError) {
    const upstreamFailed = parsed.upstreamError !== undefined;
    const resultPayload = removeUndefined({
      ok: false,
      phase: "execute",
      executionOutcome: upstreamFailed ? "outcome_unknown" : "succeeded",
      retryGuidance: upstreamFailed ? UNKNOWN_EXECUTION_RETRY_GUIDANCE : undefined,
      diagnostics: diagnosticsForResponse(diagnostics),
      repairPlan: repairPlanForResponse(diagnostics),
      script: responseScript,
      upstreamError: parsed.upstreamError ? responseUpstreamError(parsed.upstreamError) : undefined,
    }) as Record<string, unknown>;
    return limitInlineScriptResult(
      localPostprocessingFailure(
        resultPayload,
        "upstreamResponseBudget",
        attempt.postResponseError,
      ),
      inlineResultLimit,
      [],
    );
  }
  if (parsed.upstreamError) {
    const upstreamResult = upstreamEnvelope(parsed);
    const resultPayload = removeUndefined({
      ok: false,
      phase: "execute",
      executionOutcome: "outcome_unknown",
      retryGuidance: UNKNOWN_EXECUTION_RETRY_GUIDANCE,
      diagnostics: diagnosticsForResponse(diagnostics),
      repairPlan: repairPlanForResponse(diagnostics),
      script: responseScript,
      ...runUpstreamFields(parsed),
      ...runUpstreamFailureFields(parsed),
    }) as Record<string, unknown>;
    const payloadWithOutputFiles = await attachPostExecutionOutputFiles({
      resultPayload,
      stage: "scriptResultSidecars",
      write: async () => addUpstreamSidecar(
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
      ),
    });
    const payload = {
      ...limitInlineScriptResult(
        payloadWithOutputFiles,
        inlineResultLimit,
        ["upstream.result", "upstream.text"],
      ),
    };
    return payload;
  }
  const captureBatch = await executeQueuedCaptureRequests({
    parsedJson: parsed.json,
    session,
    runtime,
  });
  const resultPayload = removeUndefined({
    ok: captureBatch.ok,
    phase: "execute",
    executionOutcome: "succeeded",
    captureProcessingSucceeded: captureBatch.requested ? captureBatch.ok : undefined,
    retryGuidance: !captureBatch.ok ? QUEUED_CAPTURE_FAILURE_RETRY_GUIDANCE : undefined,
    captures: captureBatch.captures,
    diagnostics: optionalDiagnosticsForResponse(diagnostics),
    repairPlan: repairPlanForResponse(diagnostics),
    script: successScript,
    ...runUpstreamFields(parsed),
  }) as Record<string, unknown>;
  const upstreamResult = upstreamEnvelope(parsed);
  const limitedPayload = limitInlineScriptResult(
    resultPayload,
    inlineResultLimit,
    ["upstream.result", "upstream.text"],
  );
  const needsOutputFile = diagnostics.length > 0 || !captureBatch.ok || isRecord(limitedPayload.inlineResultLimit);
  return attachPostExecutionOutputFiles({
    resultPayload: limitedPayload,
    stage: "scriptResultSidecars",
    write: async () => needsOutputFile
      ? addUpstreamSidecar(await outputWriter.write({
        result: createRunScriptResultFilePayload({
          session,
          resultPayload,
          diagnostics,
          parsed,
          upstream: upstreamResult,
        }),
        writeResult: true,
      }), outputWriter.files.resultFile, upstreamResult)
      : outputWriter.write({
        result: createRunScriptResultFilePayload({
          session,
          resultPayload,
          diagnostics,
          parsed,
          upstream: upstreamResult,
        }),
        writeResult: false,
      }),
  });
}

async function executeApplyAssetManifest(
  args: FigmaWorkspaceApplyAssetManifestArguments,
  runtime: FigmaWorkspaceRuntime,
): Promise<Record<string, unknown>> {
  const session = currentInvocationContext();
  const resourceBudget = commandResourceBudget();
  let manifest: NormalizedAssetManifest;
  let assetInputs: OpenedAssetInput[];
  try {
    manifest = await loadAssetManifest(args, session, resourceBudget);
    assetInputs = await openAssetInputs(manifest.assets, session, resourceBudget);
  } catch (error) {
    if (error instanceof AssetManifestLoadError) {
      const diagnostics = [assetManifestLoadDiagnostic(error)];
      session.lastDiagnostics = diagnostics;
      return {
        ok: false,
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
  try {
  const tools = await runtime.upstreamToolCache.list(false);
  const uploadKind = requireWrapperUpstreamKind(APPLY_ASSET_MANIFEST_CONTRACT);
  const tool = selectRequiredUpstreamTool(tools, UPLOAD_ASSETS_TOOL_NAME, uploadKind);
  assertUpstreamToolHasProperties(tool, [...(APPLY_ASSET_MANIFEST_CONTRACT.requiredUpstreamProperties ?? [])], uploadKind);
  const failures: Array<Record<string, unknown>> = [];
  const assetResults: Array<Record<string, unknown>> = [];
  const assetDetails: Array<Record<string, unknown>> = [];
  await connectUpstream(runtime.client, "Apply Figma asset manifest");

  for (const [assetIndex, asset] of manifest.assets.entries()) {
    const upstreamArguments = buildAssetManifestUpstreamArguments({
      asset,
      tool,
    });
    const startedAt = new Date().toISOString();
    try {
      const upstream = await callUpstreamToolWithLimits(runtime.client, tool.name, upstreamArguments);
      const parsed = parseUpstreamToolResult(upstream);
      const upstreamError = parsed.upstreamError ? responseUpstreamError(parsed.upstreamError) : undefined;
      const upload = parsed.upstreamError
        ? undefined
        : await submitLocalAssetUploadIfAvailable(assetInputs[assetIndex], parsed, resourceBudget);
      const ok = !parsed.upstreamError && upload?.ok !== false;
      const uploadSummary = compactUploadSummary(upload);
      const entry = {
        ok,
        path: asset.path,
        targetNodeId: asset.targetNodeId,
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
    assetDetails,
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
    assets: assetResults,
    application,
    validation,
    failures: failures.length > 0 ? failures : undefined,
  };
  if (!ok) {
    files.debugFile = responseFilePointer(await writeJsonFile(resolveAssetManifestDebugFile(args, session), createResultFileEnvelope({
      tool: "figma:assets:apply",
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
  const response = {
    ...payload,
    outputFiles: Object.keys(files).length > 0 ? files : undefined,
  };
  return response;
  } finally {
    await Promise.allSettled(assetInputs.map(({ handle }) => handle.close()));
  }
}

function isAssetManifestValidationIndeterminate(validation: Record<string, unknown>): boolean {
  if (validation.skipped === true) {
    return false;
  }
  return validation.ok === undefined && Number(validation.expectedCount ?? 0) > 0;
}

function resolveAssetManifestDebugFile(args: FigmaWorkspaceApplyAssetManifestArguments, session: FigmaWorkspaceInvocationContext): string {
  const slug = "asset-manifest";
  const fileName = `${slug}.assets.result.json`;
  if (session.workspace) {
    return resolveWorkspaceFile(session.workspace.outputDir, fileName, "debugFile");
  }
  return resolveWorkspaceFile(session.outputRoot, fileName, "debugFile");
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

async function executeDownloadAssets(
  args: FigmaWorkspaceDownloadAssetsArguments,
  runtime: FigmaWorkspaceRuntime,
): Promise<Record<string, unknown>> {
  const session = currentInvocationContext();
  const resourceBudget = commandResourceBudget();
  const manifest = await loadDownloadAssetsManifest(args, session, resourceBudget);
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
  await connectUpstream(runtime.client, "Download Figma assets");

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
      const upstream = await callUpstreamToolWithLimits(runtime.client, tool.name, upstreamArguments);
      const parsed = parseUpstreamToolResult(upstream);
      const upstreamError = parsed.upstreamError ? responseUpstreamError(parsed.upstreamError) : undefined;
      const collected = parsed.upstreamError
        ? { links: [], unsupportedSvgAssetCount: 0 }
        : collectDownloadAssetLinks(parsed.json);
      const links = collected.links;
      const downloadedFiles = parsed.upstreamError
        ? []
        : await downloadAssetLinks(links, targetOutputDir, resourceBudget);
      const downloadFailures = downloadedFiles.filter((file) => file.ok === false);
      const unsupportedSvgAssetError = collected.unsupportedSvgAssetCount > 0
        ? {
            message: `Upstream download_assets returned ${collected.unsupportedSvgAssetCount} svgAssets ${collected.unsupportedSvgAssetCount === 1 ? "entry" : "entries"} without a supported downloadable URL. The response shape was not guessed or silently ignored.`,
          }
        : undefined;
      if (unsupportedSvgAssetError) {
        diagnostics.push({
          code: "FIGMA_WORKSPACE_DOWNLOAD_SVG_ASSET_SHAPE_UNSUPPORTED",
          severity: "fatal",
          message: unsupportedSvgAssetError.message,
          suggestion: "Inspect outputFiles.debugFile and the live download_assets description before adapting the parser to a new response shape.",
          docsHint: "Figma Workspace CLI: figma:upstream:read download_assets",
        });
      }
      const ok = !parsed.upstreamError
        && links.length > 0
        && downloadFailures.length === 0
        && !unsupportedSvgAssetError;
      const downloadError = downloadFailures[0]?.error
        ? responseUpstreamError(normalizeCaughtUpstreamError(downloadFailures[0].error))
        : unsupportedSvgAssetError
          ? unsupportedSvgAssetError
          : links.length === 0 && !parsed.upstreamError
            ? { message: "Upstream download_assets returned no downloadable URLs." }
            : undefined;
      const entry = removeUndefined({
        ok,
        targetNodeId: target.targetNodeId,
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
        name: target.name,
        outputDir: targetOutputDir,
        upstreamError: responseError,
      }) as Record<string, unknown>);
    }
  }

  const ok = failures.length === 0;
  const payload = removeUndefined({
    ok,
    outputDir: paths.outputDir,
    targets: targetResults,
    diagnostics: diagnostics.length > 0 ? diagnosticsForResponse(dedupeDiagnostics(diagnostics)) : undefined,
    failures: failures.length > 0 ? failures : undefined,
  }) as Record<string, unknown>;
  const outputFiles: FigmaWorkspaceOutputFiles = {};
  if (!ok) {
    outputFiles.debugFile = responseFilePointer(await writeJsonFile(paths.resultFile, createResultFileEnvelope({
      tool: "figma:assets:download",
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
  const response = {
    ...payload,
    outputFiles: Object.keys(outputFiles).length > 0 ? outputFiles : undefined,
  };
  return response;
}

async function loadDownloadAssetsManifest(
  args: FigmaWorkspaceDownloadAssetsArguments,
  session: FigmaWorkspaceInvocationContext,
  resourceBudget: DataPlaneResourceBudget,
): Promise<NormalizedDownloadAssetsManifest> {
  const inlineTargets = Array.isArray(args.targets) ? args.targets : undefined;
  const manifestPath = resolveInvocationAwareFile(args.manifestPath, session, "manifestPath");
  if (inlineTargets && manifestPath) {
    throw new Error('Pass either "targets" or "manifestPath", not both.');
  }
  const manifestValue = manifestPath
    ? JSON.parse((await readManagedWorkspaceFile({
      path: manifestPath,
      session,
      limitBytes: MAX_MANIFEST_FILE_BYTES,
      resourceBudget,
      label: "Download manifest",
    })).toString("utf8"))
    : undefined;
  const manifestRecord = asRecord(manifestValue);
  if (manifestRecord.assets !== undefined) {
    throw new Error('Download manifest field "assets" is not supported. Use "targets".');
  }
  const rawTargets = inlineTargets ?? (Array.isArray(manifestRecord.targets) ? manifestRecord.targets : undefined);
  if (!rawTargets || rawTargets.length === 0) {
    throw new Error('Tool argument "targets" or "manifestPath" with targets is required.');
  }
  assertManifestItemCount(rawTargets.length, "Download manifest");
  return {
    targets: rawTargets.map((target, index) => normalizeDownloadAssetTarget(target, index, session)),
  };
}

function normalizeDownloadAssetTarget(
  value: FigmaWorkspaceDownloadAssetsTarget | unknown,
  index: number,
  session: FigmaWorkspaceInvocationContext,
): NormalizedDownloadAssetsTarget {
  const record = asRecord(value);
  const targetResolution = resolveRequestScopedTarget({
    target: record.target,
    session,
    toolName: "figma:assets:download",
  });
  const targetNodeId = targetResolution.nodeId;
  if (!targetNodeId) {
    throw new Error(`Download target ${index} requires target.`);
  }
  const fileKey = targetResolution.fileKey;
  if (!fileKey) {
    throw new Error(`Download target ${index} requires a Figma file key. Pass --file or include fileKey in the structured target.`);
  }
  const defaultFormat = asOptionalDownloadAssetFormat(record.defaultFormat);
  const defaultScale = typeof record.defaultScale === "number" && Number.isFinite(record.defaultScale)
    ? record.defaultScale
    : undefined;
  return {
    targetNodeId,
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

function resolveDownloadAssetsOutputPaths(
  args: FigmaWorkspaceDownloadAssetsArguments,
  session: FigmaWorkspaceInvocationContext,
): { outputDir: string; resultFile: string } {
  const slug = "download-assets";
  const explicitOutputDir = resolveInvocationAwareFile(args.outputDir, session, "outputDir");
  let outputDir = explicitOutputDir;
  if (!outputDir) {
    outputDir = session.workspace
      ? resolveWorkspaceFile(session.workspace.outputDir, `${slug}.downloads`, "outputDir")
      : resolveDownloadAssetsTempPath(session, `${slug}.downloads`);
  }
  const resultFile = session.workspace
    ? resolveWorkspaceFile(session.workspace.outputDir, `${slug}.downloads.result.json`, "debugFile")
    : resolveDownloadAssetsTempPath(session, `${slug}.downloads.result.json`);
  return { outputDir, resultFile };
}

function resolveDownloadAssetsTempPath(session: FigmaWorkspaceInvocationContext, fileName: string): string {
  return resolveWorkspaceFile(session.outputRoot, fileName, "outputFile");
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
  const base = slugifyTaskName(target.name || target.targetNodeId || `target-${index + 1}`);
  let candidate = base || `target-${index + 1}`;
  let suffix = 2;
  while (used.has(candidate)) {
    candidate = `${base}-${suffix}`;
    suffix += 1;
  }
  used.add(candidate);
  return candidate;
}

function collectDownloadAssetLinks(value: unknown): DownloadAssetLinkCollection {
  const links = new Map<string, DownloadAssetLink>();
  let unsupportedSvgAssetCount = 0;
  const visit = (item: unknown, path: string[], forcedKind?: DownloadAssetKind): boolean => {
    if (Array.isArray(item)) {
      return item.reduce(
        (found, child, index) => visit(child, [...path, String(index)], forcedKind) || found,
        false,
      );
    }
    if (typeof item === "string" && looksLikeDownloadUrl(item, path)) {
      const kind = forcedKind ?? inferDownloadAssetKind(path);
      const mapKey = `${kind}:${item}`;
      if (!links.has(mapKey)) {
        links.set(mapKey, {
          kind,
          url: item,
          format: kind === "svg" ? "svg" : extensionFromUrl(item),
        });
      }
      return true;
    }
    if (!isRecord(item)) {
      return false;
    }
    let found = false;
    for (const [key, child] of Object.entries(item)) {
      const childPath = [...path, key];
      if (key.toLowerCase() === "svgassets") {
        if (Array.isArray(child)) {
          for (const [index, svgAsset] of child.entries()) {
            const entryFound = visit(svgAsset, [...childPath, String(index)], "svg");
            found = entryFound || found;
            if (!entryFound) {
              unsupportedSvgAssetCount += 1;
            }
          }
        } else {
          const entryFound = visit(child, childPath, "svg");
          found = entryFound || found;
          if (!entryFound) {
            unsupportedSvgAssetCount += 1;
          }
        }
        continue;
      }
      if (typeof child === "string" && looksLikeDownloadUrl(child, childPath)) {
        const kind = forcedKind ?? inferDownloadAssetKind(childPath);
        const format = kind === "svg" ? "svg" : inferDownloadAssetFormat(item, child);
        const mapKey = `${kind}:${child}`;
        if (!links.has(mapKey)) {
          links.set(mapKey, {
            kind,
            url: child,
            format,
            name: asOptionalString(item.name) ?? asOptionalString(item.fileName) ?? asOptionalString(item.filename),
          });
        }
        found = true;
      }
      found = visit(child, childPath, forcedKind) || found;
    }
    return found;
  };
  visit(value, []);
  return { links: [...links.values()], unsupportedSvgAssetCount };
}

function looksLikeDownloadUrl(value: string, path: string[] = []): boolean {
  if (!/^https?:\/\//iu.test(value)) {
    return false;
  }
  const field = path.at(-1) ?? "";
  return /\.(?:png|jpe?g|webp|gif|svg|pdf)(?:[?#].*)?$/iu.test(value)
    || /(?:download|export|render|image|asset|file|url)/iu.test(value)
    || /(?:download|export|render|image|asset|file)?url$/iu.test(field);
}

function inferDownloadAssetKind(path: string[]): Exclude<DownloadAssetKind, "svg"> {
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
  resourceBudget: DataPlaneResourceBudget,
): Promise<Array<Record<string, unknown>>> {
  const rawIndexes = new Map<DownloadAssetKind, number>();
  const results: Array<Record<string, unknown>> = [];
  for (const link of links) {
    const index = (rawIndexes.get(link.kind) ?? 0) + 1;
    rawIndexes.set(link.kind, index);
    const deadline = new NetworkRequestDeadline(`Asset download ${link.url}`);
    let response: Response | undefined;
    try {
      response = await fetch(link.url, { signal: deadline.controller.signal });
      const mimeType = contentTypeWithoutParameters(response.headers.get("content-type")) ?? undefined;
      const format = sanitizeFileExtension(link.format)
        ?? extensionFromContentType(mimeType)
        ?? extensionFromUrl(link.url)
        ?? "bin";
      const baseName = link.kind === "exported"
        ? index === 1 ? "exported" : `exported-${index}`
        : `${link.kind}-${index}`;
      const path = resolve(outputDir, `${baseName}.${format}`);
      if (!response.ok) {
        await response.body?.cancel();
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
      const written = await atomicWriteManagedStreamFile({
        root: outputDir,
        path,
        overwrite: true,
      }, boundedResponseBodyChunks({
        response,
        itemLimitBytes: MAX_SINGLE_ASSET_BYTES,
        resourceBudget,
        deadline,
        label: `Downloaded asset ${link.url}`,
      }));
      results.push(removeUndefined({
        ok: true,
        kind: link.kind,
        sourceUrl: link.url,
        path,
        bytes: written.bytes,
        lineCount: 0,
        mimeType,
        format,
      }) as Record<string, unknown>);
    } catch (error) {
      deadline.controller.abort(error);
      await response?.body?.cancel(error).catch(() => undefined);
      const upstreamError = normalizeCaughtUpstreamError(error);
      results.push(removeUndefined({
        ok: false,
        kind: link.kind,
        sourceUrl: link.url,
        error: responseUpstreamError(upstreamError),
      }) as Record<string, unknown>);
    } finally {
      deadline.dispose();
    }
  }
  return results;
}

async function readBoundedResponseBody(options: {
  response: Response;
  itemLimitBytes: number;
  resourceBudget: DataPlaneResourceBudget;
  deadline: NetworkRequestDeadline;
  label: string;
}): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let itemBytes = 0;
  for await (const chunk of boundedResponseBodyChunks(options)) {
    const buffer = Buffer.from(chunk);
    itemBytes += buffer.byteLength;
    chunks.push(buffer);
  }
  return Buffer.concat(chunks, itemBytes);
}

async function* boundedResponseBodyChunks(options: {
  response: Response;
  itemLimitBytes: number;
  resourceBudget: DataPlaneResourceBudget;
  deadline: NetworkRequestDeadline;
  label: string;
}): AsyncGenerator<Uint8Array> {
  const contentLength = parseContentLength(options.response.headers.get("content-length"));
  if (contentLength !== undefined) {
    try {
      assertSingleItemLimit(contentLength, options.itemLimitBytes, options.label);
      options.resourceBudget.assertCanConsume(contentLength, options.label);
    } catch (error) {
      options.deadline.controller.abort(error);
      await options.response.body?.cancel(error).catch(() => undefined);
      throw error;
    }
  }
  if (!options.response.body) return;

  let itemBytes = 0;
  const reader = options.response.body.getReader();
  let completed = false;
  let failure: unknown;
  try {
    while (true) {
      const item = await reader.read();
      if (item.done) break;
      options.deadline.touch();
      const chunk = Buffer.from(item.value);
      itemBytes += chunk.byteLength;
      assertSingleItemLimit(itemBytes, options.itemLimitBytes, options.label);
      options.resourceBudget.consume(chunk.byteLength, options.label);
      yield chunk;
    }
    completed = true;
  } catch (error) {
    failure = error;
    options.deadline.controller.abort(error);
    throw error;
  } finally {
    if (!completed) {
      const reason = failure ?? new Error(`${options.label} response consumption was cancelled.`);
      options.deadline.controller.abort(reason);
      await reader.cancel(reason).catch(() => undefined);
    }
    reader.releaseLock();
  }
}

async function readBoundedLocalFile(
  path: string,
  limitBytes: number,
  resourceBudget: DataPlaneResourceBudget,
  label: string,
): Promise<Buffer> {
  const fileStats = await stat(path);
  assertSingleItemLimit(fileStats.size, limitBytes, label);
  resourceBudget.assertCanConsume(fileStats.size, label);
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const rawChunk of createReadStream(path)) {
    const chunk = Buffer.isBuffer(rawChunk) ? rawChunk : Buffer.from(rawChunk);
    bytes += chunk.byteLength;
    assertSingleItemLimit(bytes, limitBytes, label);
    resourceBudget.consume(chunk.byteLength, label);
    chunks.push(chunk);
  }
  return Buffer.concat(chunks, bytes);
}

async function readManagedWorkspaceFile(options: {
  path: string;
  session: FigmaWorkspaceInvocationContext;
  limitBytes: number;
  resourceBudget: DataPlaneResourceBudget;
  label: string;
}): Promise<Buffer> {
  await assertInvocationManagedInputFile(options.path, options.session);
  const result = await readBoundedLocalFile(
    options.path,
    options.limitBytes,
    options.resourceBudget,
    options.label,
  );
  await assertInvocationManagedInputFile(options.path, options.session);
  return result;
}

async function openAssetInputs(
  assets: NormalizedAssetManifestAsset[],
  session: FigmaWorkspaceInvocationContext,
  resourceBudget: DataPlaneResourceBudget,
): Promise<OpenedAssetInput[]> {
  const opened: OpenedAssetInput[] = [];
  try {
    for (const asset of assets) {
      const input = await openManagedAssetInput(asset, session);
      assertSingleItemLimit(input.stats.size, MAX_SINGLE_ASSET_BYTES, `Asset upload ${asset.path}`);
      opened.push(input);
      await assertRasterAssetContent(input);
    }
    const totalBytes = opened.reduce((sum, input) => sum + input.stats.size, 0);
    resourceBudget.assertCanConsume(totalBytes, "Asset upload inputs");
    return opened;
  } catch (error) {
    await Promise.allSettled(opened.map(({ handle }) => handle.close()));
    throw error;
  }
}

async function assertRasterAssetContent(input: OpenedAssetInput): Promise<void> {
  const prefixLength = Math.min(input.stats.size, SVG_CONTENT_SNIFF_BYTES);
  if (prefixLength === 0) {
    return;
  }
  const prefix = Buffer.allocUnsafe(prefixLength);
  const { bytesRead } = await input.handle.read(prefix, 0, prefixLength, 0);
  const content = prefix.subarray(0, bytesRead);
  if (hasKnownRasterSignature(content) || !hasSvgDocumentRoot(content)) {
    return;
  }
  throw new Error(
    `Asset manifest input contains an SVG document even though its path uses a raster extension. SVG is not supported by figma:assets:apply because official SVG uploads create editable vector node trees instead of filling the explicit target; use figma:run for that workflow: ${input.asset.path}`,
  );
}

function hasKnownRasterSignature(content: Buffer): boolean {
  return content.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
    || (content.length >= 3 && content[0] === 0xff && content[1] === 0xd8 && content[2] === 0xff)
    || content.subarray(0, 6).equals(Buffer.from("GIF87a", "ascii"))
    || content.subarray(0, 6).equals(Buffer.from("GIF89a", "ascii"))
    || (
      content.subarray(0, 4).equals(Buffer.from("RIFF", "ascii"))
      && content.subarray(8, 12).equals(Buffer.from("WEBP", "ascii"))
    );
}

function hasSvgDocumentRoot(content: Buffer): boolean {
  if (content.includes(0)) {
    return false;
  }
  const source = content.toString("utf8");
  let offset = source.charCodeAt(0) === 0xfeff ? 1 : 0;
  const skipWhitespace = (): void => {
    while (offset < source.length && /\s/u.test(source[offset])) {
      offset += 1;
    }
  };
  skipWhitespace();
  if (source.slice(offset, offset + 5).toLowerCase() === "<?xml") {
    const declarationEnd = source.indexOf("?>", offset + 5);
    if (declarationEnd < 0) {
      return false;
    }
    offset = declarationEnd + 2;
    skipWhitespace();
  }
  let doctypeSeen = false;
  while (true) {
    if (source.startsWith("<!--", offset)) {
      const commentEnd = source.indexOf("-->", offset + 4);
      if (commentEnd < 0) {
        return false;
      }
      offset = commentEnd + 3;
      skipWhitespace();
      continue;
    }
    if (!doctypeSeen && source.slice(offset, offset + 9).toLowerCase() === "<!doctype") {
      const doctype = scanSvgDoctype(source, offset);
      if (doctype.kind === "non-svg") {
        return false;
      }
      if (doctype.kind === "incomplete-svg") {
        return true;
      }
      offset = doctype.endOffset;
      doctypeSeen = true;
      skipWhitespace();
      continue;
    }
    break;
  }
  return /^<svg(?:[\s/>])/u.test(source.slice(offset));
}

type SvgDoctypeScanResult =
  | { kind: "complete-svg"; endOffset: number }
  | { kind: "incomplete-svg" }
  | { kind: "non-svg" };

function scanSvgDoctype(source: string, startOffset: number): SvgDoctypeScanResult {
  let offset = startOffset + 9;
  if (!/\s/u.test(source[offset] ?? "")) {
    return { kind: "non-svg" };
  }
  while (offset < source.length && /\s/u.test(source[offset])) {
    offset += 1;
  }
  const nameStart = offset;
  while (offset < source.length && /[^\s[>]/u.test(source[offset])) {
    offset += 1;
  }
  if (source.slice(nameStart, offset) !== "svg") {
    return { kind: "non-svg" };
  }

  let quote: "\"" | "'" | undefined;
  let internalSubsetDepth = 0;
  for (; offset < source.length; offset += 1) {
    const character = source[offset];
    if (quote) {
      if (character === quote) {
        quote = undefined;
      }
      continue;
    }
    if (character === "\"" || character === "'") {
      quote = character;
      continue;
    }
    if (character === "[") {
      internalSubsetDepth += 1;
      continue;
    }
    if (character === "]" && internalSubsetDepth > 0) {
      internalSubsetDepth -= 1;
      continue;
    }
    if (character === ">" && internalSubsetDepth === 0) {
      return { kind: "complete-svg", endOffset: offset + 1 };
    }
  }
  return { kind: "incomplete-svg" };
}

async function openManagedAssetInput(
  asset: NormalizedAssetManifestAsset,
  session: FigmaWorkspaceInvocationContext,
): Promise<OpenedAssetInput> {
  const path = await assertInvocationManagedInputFile(asset.path, session);
  const before = await lstat(path);
  assertRegularAssetInput(before, path);
  const handle = await open(path, "r");
  try {
    const handleStats = await handle.stat();
    assertRegularAssetInput(handleStats, path);
    const current = await lstat(path);
    assertRegularAssetInput(current, path);
    await assertInvocationManagedInputFile(path, session);
    if (!sameFileIdentity(before, handleStats) || !sameFileIdentity(handleStats, current)) {
      throw new Error(`Asset input changed while it was being opened: ${path}`);
    }
    return { asset, handle, stats: handleStats };
  } catch (error) {
    await handle.close().catch(() => undefined);
    throw error;
  }
}

function assertRegularAssetInput(stats: Stats, path: string): void {
  if (stats.isSymbolicLink() || !stats.isFile()) {
    throw new Error(`Asset input must be a real regular file, not a symlink, junction, reparse target, or directory: ${path}`);
  }
}

function sameFileIdentity(left: Stats, right: Stats): boolean {
  if (left.dev !== 0 || left.ino !== 0 || right.dev !== 0 || right.ino !== 0) {
    return left.dev === right.dev && left.ino === right.ino;
  }
  return left.mode === right.mode
    && left.size === right.size
    && left.birthtimeMs === right.birthtimeMs
    && left.ctimeMs === right.ctimeMs;
}

function parseContentLength(value: string | null): number | undefined {
  if (value === null || !/^\d+$/u.test(value.trim())) return undefined;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : undefined;
}

function assertSingleItemLimit(bytes: number, limitBytes: number, label: string): void {
  if (!Number.isSafeInteger(bytes) || bytes < 0 || bytes > limitBytes) {
    throw resourceLimitError(`${label} exceeds the ${formatDataPlaneLimit(limitBytes)} per-item limit.`);
  }
}

function assertManifestItemCount(count: number, label: string): void {
  if (count > MAX_MANIFEST_ITEMS) {
    throw resourceLimitError(`${label} contains ${count} items; at most ${MAX_MANIFEST_ITEMS} are allowed.`);
  }
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

async function executeCaptureNode(
  args: FigmaWorkspaceCaptureNodeArguments,
  runtime: FigmaWorkspaceRuntime,
): Promise<Record<string, unknown>> {
  return executeCaptureNodeForTool(args, runtime);
}

async function executeCaptureNodeForTool(
  args: FigmaWorkspaceCaptureNodeArguments,
  runtime: FigmaWorkspaceRuntime,
  resourceBudget = commandResourceBudget(),
): Promise<Record<string, unknown>> {
  rejectRemovedCaptureMediaArguments(args);
  const session = currentInvocationContext();
  const requested = resolveWrapperNodeTarget({
    args: { target: args.target },
    session,
    toolName: "figma_workspace_capture_node",
    requireNode: true,
    targetError: 'Tool argument "target" is required.',
    fileKeyError: 'Tool argument "target" requires a fileKey for official get_screenshot. Pass a node URL or target:{ fileKey, nodeId }, or provide --file with a raw node id.',
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
  await connectUpstream(runtime.client, "Capture Figma node");
  const upstream = await callUpstreamToolWithLimits(runtime.client, tool.name, upstreamArguments);
  const parsed = parseUpstreamToolResult(upstream);
  if (parsed.upstreamError) {
    const payload = {
      ok: false,
      nodeId,
      diagnostics: filtered.diagnostics.length > 0 ? diagnosticsForResponse(filtered.diagnostics) : undefined,
      upstreamError: responseUpstreamError(parsed.upstreamError),
    };
    return payload;
  }
  let saved: Awaited<ReturnType<typeof writeCaptureOutputFile>>;
  try {
    const boundedUpstream = await prepareBoundedCapturePayload(upstream, parsed, resourceBudget);
    saved = await writeCaptureOutputFile(requestedOutputFile, boundedUpstream, parsed);
  } catch (error) {
    const payload = {
      ok: false,
      nodeId,
      diagnostics: filtered.diagnostics.length > 0 ? diagnosticsForResponse(filtered.diagnostics) : undefined,
      upstreamError: normalizeCaughtUpstreamError(error),
    };
    return payload;
  }
  const payload = {
    ok: true,
    imageFile: saved.path,
    nodeId,
    bytes: saved.bytes,
    width: saved.width,
    height: saved.height,
    diagnostics: filtered.diagnostics.length > 0 ? diagnosticsForResponse(filtered.diagnostics) : undefined,
  };
  return payload;
}

async function prepareBoundedCapturePayload(
  upstream: unknown,
  parsed: ParsedUpstreamToolResult,
  resourceBudget: DataPlaneResourceBudget,
): Promise<unknown> {
  const content = Array.isArray(asRecord(upstream).content)
    ? (asRecord(upstream).content as unknown[]).filter(isRecord)
    : [];
  const inlineImage = content.find((item) => item.type === "image" && typeof item.data === "string");
  if (inlineImage && typeof inlineImage.data === "string") {
    const compactBase64 = inlineImage.data.replace(/\s/gu, "");
    const estimatedBytes = Math.floor((compactBase64.length * 3) / 4)
      - (compactBase64.endsWith("==") ? 2 : compactBase64.endsWith("=") ? 1 : 0);
    assertSingleItemLimit(estimatedBytes, MAX_SINGLE_ASSET_BYTES, "Capture image payload");
    resourceBudget.assertCanConsume(estimatedBytes, "Capture image payload");
    const decoded = Buffer.from(compactBase64, "base64");
    assertSingleItemLimit(decoded.byteLength, MAX_SINGLE_ASSET_BYTES, "Capture image payload");
    resourceBudget.consume(decoded.byteLength, "Capture image payload");
    return upstream;
  }

  const sourceUrl = findCaptureImageUrlForResourceLimit(upstream, parsed.json);
  if (!sourceUrl) return upstream;
  const deadline = new NetworkRequestDeadline(`Capture download ${sourceUrl}`);
  try {
    const response = await fetch(sourceUrl, { signal: deadline.controller.signal });
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error(
        `Unable to download captured node image from ${sourceUrl}: ${response.status} ${response.statusText}`,
      );
    }
    const bytes = await readBoundedResponseBody({
      response,
      itemLimitBytes: MAX_SINGLE_ASSET_BYTES,
      resourceBudget,
      deadline,
      label: "Capture image payload",
    });
    return {
      content: [{
        type: "image",
        mimeType: contentTypeWithoutParameters(response.headers.get("content-type")) ?? "image/png",
        data: bytes.toString("base64"),
      }],
    };
  } finally {
    deadline.dispose();
  }
}

function findCaptureImageUrlForResourceLimit(upstream: unknown, parsedJson: unknown): string | undefined {
  const content = Array.isArray(asRecord(upstream).content)
    ? (asRecord(upstream).content as unknown[]).filter(isRecord)
    : [];
  for (const item of content) {
    if (item.type !== "image") continue;
    for (const value of [item.url, item.imageUrl, item.image_url, item.screenshotUrl, item.downloadUrl]) {
      const url = asHttpUrl(value);
      if (url) return url;
    }
  }
  return findHttpUrlInCaptureValue(parsedJson, 0) ?? findHttpUrlInCaptureValue(upstream, 0);
}

function findHttpUrlInCaptureValue(value: unknown, depth: number): string | undefined {
  if (depth > 6) return undefined;
  const direct = asHttpUrl(value);
  if (direct) return direct;
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findHttpUrlInCaptureValue(item, depth + 1);
      if (found) return found;
    }
    return undefined;
  }
  if (!isRecord(value)) return undefined;
  const priorityKeys = ["imageUrl", "image_url", "screenshotUrl", "downloadUrl", "url", "src", "href"];
  for (const key of priorityKeys) {
    const found = findHttpUrlInCaptureValue(value[key], depth + 1);
    if (found) return found;
  }
  for (const [key, item] of Object.entries(value)) {
    if (priorityKeys.includes(key)) continue;
    const found = findHttpUrlInCaptureValue(item, depth + 1);
    if (found) return found;
  }
  return undefined;
}

function asHttpUrl(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:" ? url.href : undefined;
  } catch {
    return undefined;
  }
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
    throw new Error('Input "metadataFile" was removed. Use figma:upstream:call only for explicit upstream debugging.');
  }
}

function resolveCaptureOutputFile(args: FigmaWorkspaceCaptureNodeArguments, session: FigmaWorkspaceInvocationContext): string {
  const explicit = resolveInvocationAwareFile(args.imageFile, session, "imageFile");
  if (explicit) {
    return explicit;
  }
  const fileName = `capture-${new Date().toISOString().replace(/[^\dTZ]/gu, "")}`;
  if (session.workspace) {
    return resolveWorkspaceFile(session.workspace.outputDir, fileName, "imageFile");
  }
  return resolveWorkspaceFile(session.outputRoot, fileName, "imageFile");
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
  session: FigmaWorkspaceInvocationContext;
  runtime: FigmaWorkspaceRuntime;
}): Promise<FigmaWorkspaceQueuedCaptureBatchResult> {
  let requests: FigmaWorkspaceQueuedCaptureRequest[];
  try {
    requests = extractQueuedCaptureRequests(options.parsedJson, options.session);
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
  const resourceBudget = commandResourceBudget();
  for (const [index, request] of requests.entries()) {
    try {
      const imageFile = resolveQueuedCaptureOutputFile(
        options.session,
        request.requestId,
        index,
        request.imageFile,
      );
      const result = await executeCaptureNodeForTool({
        target: request.nodeId,
        imageFile,
        maxDimension: request.maxDimension,
        contentsOnly: request.contentsOnly,
      }, options.runtime, resourceBudget);
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
  session: Pick<FigmaWorkspaceInvocationContext, "invocationId">,
): FigmaWorkspaceQueuedCaptureRequest[] {
  if (!isRecord(value) || value.ok !== true || !Object.prototype.hasOwnProperty.call(value, "__figmaWorkspace")) {
    return [];
  }
  const repl = value.__figmaWorkspace;
  if (!isRecord(repl) || repl.invocationId !== session.invocationId) {
    throw new Error("Queued capture envelope did not match the active Figma Workspace invocation.");
  }
  if (!Object.prototype.hasOwnProperty.call(repl, "captureRequests")) {
    return [];
  }
  if (!Array.isArray(repl.captureRequests)) {
    throw new Error("Queued capture envelope captureRequests must be an array.");
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
    if (!nodeId || nodeId.startsWith("$") || nodeId.length > 512 || /[\u0000-\u001f\u007f]/u.test(nodeId)) {
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
  session: FigmaWorkspaceInvocationContext,
  requestId: string,
  index: number,
  requestedImageFile?: string,
): string {
  const timestamp = new Date().toISOString().replace(/[^\dTZ]/gu, "");
  const uniqueSuffix = randomUUID().slice(0, 8);
  const fileName = `capture-${timestamp}-${index + 1}-${requestId}-${uniqueSuffix}`;
  const selectedFileName = requestedImageFile ?? fileName;
  if (session.workspace) {
    return resolveWorkspaceFile(session.workspace.outputDir, selectedFileName, "imageFile");
  }
  return resolveWorkspaceFile(session.outputRoot, selectedFileName, "imageFile");
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
async function handleInspect(
  args: FigmaWorkspaceInspectArguments,
  runtime: {
    client: FigmaUpstreamMcpProxyClient;
    upstreamToolCache: ReturnType<typeof createUpstreamToolCache>;
  },
): Promise<Record<string, unknown>> {
  if (args.mode === "style") {
    return makeJsonToolResult(await executeInspectStyle(args, runtime));
  }
  const session = currentInvocationContext();
  const targetResolution = resolveRequestScopedTarget({
    target: args.target,
    session,
    toolName: "figma:inspect",
  });
  if (!targetResolution.fileKey) {
    throw new Error('figma:inspect requires file context. Pass --file with a raw node id, or pass a full Figma node URL.');
  }
  const target = targetResolution.nodeId as string;
  const depth = normalizePositiveInteger(args.depth, 2);
  const code = [
    `const __target = ${literal(target)};`,
    `const __depth = ${literal(depth)};`,
    "const __value = await __figmaWorkspaceResolveNode(__target, 'figma:inspect target');",
    "return {",
    "  target: __target,",
    "  mode: 'inspect',",
    "  summary: Array.isArray(__value) ? __value.map((node) => __figmaWorkspaceSummarizeNode(node, __depth)) : __figmaWorkspaceSummarizeNode(__value, __depth),",
    "};",
  ].join("\n");
  const evalSettings = await resolveEvalSettings(session, args as Record<string, unknown>, runtime, targetResolution.fileKey);
  const upstream = await callUpstreamEval(
    runtime.client,
    evalSettings,
    buildFigmaEvalScript({ session, code }),
  );
  const parsed = parseUpstreamToolResult(upstream);
  if (!targetResolution.crossFile) {
  }
  const payload = {
    ok: !parsed.upstreamError,
    diagnostics: optionalDiagnosticsForResponse(session.lastDiagnostics),
    ...inspectInlineResultFields(parsed, "inspect"),
  };
  return makeJsonToolResult(payload);
}

async function executeInspectStyle(
  args: FigmaWorkspaceInspectArguments,
  runtime: {
    client: FigmaUpstreamMcpProxyClient;
    upstreamToolCache: ReturnType<typeof createUpstreamToolCache>;
  },
): Promise<Record<string, unknown>> {
  const session = currentInvocationContext();
  const targetResolution = resolveRequestScopedTarget({
    target: args.target,
    session,
    toolName: "figma:inspect",
  });
  if (!targetResolution.fileKey) {
    throw new Error('figma:inspect requires file context. Pass --file with a raw node id, or pass a full Figma node URL.');
  }
  const target = targetResolution.nodeId as string;
  const depth = normalizePositiveInteger(args.depth, 1);
  const code = buildInspectStyleCode({
    target,
    depth,
    includeSummary: true,
  });
  const diagnostics: FigmaWorkspaceDiagnostic[] = [];
  session.lastDiagnostics = diagnostics;
  const evalSettings = await resolveEvalSettings(session, args, runtime, targetResolution.fileKey);
  const parsed = await readInspectStyleWithAdaptiveBatches({
    target,
    depth,
    session,
    client: runtime.client,
    evalSettings,
  });
  if (!targetResolution.crossFile) {
  }
  const payload = {
    ok: !parsed.upstreamError,
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
}): string {
  const limitLiteral = options.limit === undefined ? "undefined" : literal(options.limit);
  return [
    `const __target = ${literal(options.target)};`,
    `const __depth = ${literal(options.depth)};`,
    `const __offset = ${literal(options.offset ?? 0)};`,
    `const __limit = ${limitLiteral};`,
    `const __includeSummary = ${literal(options.includeSummary)};`,
    "const __value = await __figmaWorkspaceResolveNode(__target, 'figma:inspect target');",
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
    "if (__includeSummary) __result.summary = Array.isArray(__value) ? __value.map((node) => __figmaWorkspaceSummarizeNode(node, __depth)) : __figmaWorkspaceSummarizeNode(__value, __depth);",
    "return __result;",
  ].join("\n");
}

async function readInspectStyleWithAdaptiveBatches(options: {
  target: string;
  depth: number;
  session: FigmaWorkspaceInvocationContext;
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
      }),
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
  session: FigmaWorkspaceInvocationContext;
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
      }),
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


async function executeGetMetadata(
  args: FigmaWorkspaceGetMetadataArguments,
  runtime: {
    client: FigmaUpstreamMcpProxyClient;
    upstreamToolCache: ReturnType<typeof createUpstreamToolCache>;
  },
): Promise<Record<string, unknown>> {
  const session = currentInvocationContext();
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
  await connectUpstream(runtime.client, "Read Figma metadata");
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
  const upstream = await callUpstreamToolWithLimits(runtime.client, GET_METADATA_TOOL_NAME, upstreamArgs);
  const parsed = parseUpstreamToolResult(upstream);
  const upstreamResult = upstreamEnvelope(parsed, { includePayload: false });
  const xml = metadataXmlFromParsedResult(parsed);
  const metadata = xml && !parsed.upstreamError
    ? metadataJsonFromXml(xml, requested.fileKey, requested.nodeId)
    : undefined;
  const enrichment = metadata?.root
    ? await enrichMetadataJson(metadata, requested.fileKey, session, runtime)
    : emptyMetadataEnrichment();
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
    fileKey: requested.fileKey,
    nodeId: requested.nodeId,
    metadata: {
      format: "figma-metadata-tree",
      source: "figma:metadata",
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
  session: FigmaWorkspaceInvocationContext,
  _runtime: {
    client: FigmaUpstreamMcpProxyClient;
    upstreamToolCache: ReturnType<typeof createUpstreamToolCache>;
  },
): Promise<{ fileKey: string; nodeId?: string; crossFile: boolean }> {
  const requested = resolveWrapperNodeTarget({
    args,
    session,
    toolName: "figma:metadata",
    targetFallback: args.nodeId,
    fileKeyError: 'figma:metadata requires a Figma file key. Pass "file" explicitly.',
  });
  return { fileKey: requested.fileKey, nodeId: requested.nodeId, crossFile: requested.crossFile };
}


async function executeGetDesignContext(
  args: FigmaWorkspaceGetDesignContextArguments,
  runtime: {
    client: FigmaUpstreamMcpProxyClient;
    upstreamToolCache: ReturnType<typeof createUpstreamToolCache>;
  },
): Promise<Record<string, unknown>> {
  const session = currentInvocationContext();
  const requested = resolveRequiredNodeScopedRequest(args, session, "figma:design-context");
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


async function executeGetMotionContext(
  args: FigmaWorkspaceGetMotionContextArguments,
  runtime: {
    client: FigmaUpstreamMcpProxyClient;
    upstreamToolCache: ReturnType<typeof createUpstreamToolCache>;
  },
): Promise<Record<string, unknown>> {
  const session = currentInvocationContext();
  const requested = resolveRequiredNodeScopedRequest(args, session, "figma:motion-context");
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


async function executeSearchDesignSystem(
  args: FigmaWorkspaceSearchDesignSystemArguments,
  runtime: {
    client: FigmaUpstreamMcpProxyClient;
    upstreamToolCache: ReturnType<typeof createUpstreamToolCache>;
  },
): Promise<Record<string, unknown>> {
  if (typeof args.query !== "string" || args.query.trim().length === 0) {
    throw new Error('Tool argument "query" is required and must be a non-empty string.');
  }
  const session = prepareFileScopedInvocation(args);
  const fileKey = resolveRequiredFileKey(args, session, "figma:design-system");
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


async function executeGetLibraries(
  args: FigmaWorkspaceGetLibrariesArguments,
  runtime: {
    client: FigmaUpstreamMcpProxyClient;
    upstreamToolCache: ReturnType<typeof createUpstreamToolCache>;
  },
): Promise<Record<string, unknown>> {
  const session = prepareFileScopedInvocation(args);
  const fileKey = resolveRequiredFileKey(args, session, "figma:libraries");
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


async function executeGetVariableDefs(
  args: FigmaWorkspaceGetVariableDefsArguments,
  runtime: {
    client: FigmaUpstreamMcpProxyClient;
    upstreamToolCache: ReturnType<typeof createUpstreamToolCache>;
  },
): Promise<Record<string, unknown>> {
  const session = currentInvocationContext();
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

function prepareFileScopedInvocation(
  _args: { file?: string },
): FigmaWorkspaceInvocationContext {
  return currentInvocationContext();
}

function resolveRequiredFileKey(
  args: { file?: string },
  session: FigmaWorkspaceInvocationContext,
  toolName: string,
): string {
  const fileReference = parseFigmaFileReference(args.file);
  const fileKey = fileReference.fileKey ?? session.fileKey ?? extractFigmaFileKey(session.fileUrl);
  if (!fileKey) {
    throw new Error(`${toolName} requires a Figma file key. Pass "file" explicitly.`);
  }
  return fileKey;
}

function resolveRequiredNodeScopedRequest(
  args: { file?: string; target?: unknown },
  session: FigmaWorkspaceInvocationContext,
  toolName: LocalWorkspaceToolName | FigmaWorkspacePublicCommandId,
): { fileKey: string; nodeId: string } {
  const requested = resolveWrapperNodeTarget({
    args,
    session,
    toolName,
    requireNode: true,
  });
  const nodeId = requested.nodeId;
  if (!nodeId) {
    throw new Error(`${toolName} requires "target". Pass a raw node id, node URL, or { fileKey, nodeId } target.`);
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
  session: FigmaWorkspaceInvocationContext,
): { fileKey: string; nodeId: string } {
  return resolveRequiredNodeScopedRequest(args, session, "figma:variables");
}

async function executeDedicatedUpstreamTool(options: {
  args: { refresh?: boolean; inlineResultLimit?: number };
  contract: FigmaWorkspaceWrapperContract;
  runtime: {
    client: FigmaUpstreamMcpProxyClient;
    upstreamToolCache: ReturnType<typeof createUpstreamToolCache>;
  };
  session: FigmaWorkspaceInvocationContext;
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
  await connectUpstream(options.runtime.client, `Execute ${options.contract.toolName}`);
  let upstream = await callUpstreamToolWithLimits(options.runtime.client, upstreamToolName, upstreamArguments);
  let parsed = parseUpstreamToolResult(upstream);
  const recoveryDiagnostics: FigmaWorkspaceDiagnostic[] = [];
  if (shouldRetrySelectionDependentWrapper(options.contract, parsed, options.nodeIds)) {
    const recovery = await selectNodeForSelectionDependentWrapper({
      runtime: options.runtime,
      session: options.session,
      nodeId: options.nodeIds[0],
      fileKey: asOptionalString(options.upstreamArguments.fileKey),
    });
    recoveryDiagnostics.push(...recovery.diagnostics);
    if (recovery.selected) {
      upstream = await callUpstreamToolWithLimits(options.runtime.client, upstreamToolName, upstreamArguments);
      parsed = parseUpstreamToolResult(upstream);
    }
  }
  const resultPayload = removeUndefined({
    ok: !parsed.upstreamError,
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
  session: FigmaWorkspaceInvocationContext;
  nodeId: string;
  fileKey?: string;
}): Promise<{ selected: boolean; diagnostics: FigmaWorkspaceDiagnostic[] }> {
  const evalSettings = await resolveEvalSettings(options.session, {}, options.runtime, options.fileKey);
  const script = buildFigmaEvalScript({
    session: options.session,
    code: [
      `const __nodeId = ${literal(options.nodeId)};`,
      "const __node = await __figmaWorkspaceGetNodeById(__nodeId);",
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
        suggestion: "Use a smaller child node target, or call figma:metadata first to discover a selectable frame/component node.",
        docsHint: "Figma Workspace CLI: figma:design-context --help",
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
      suggestion: "Pass a smaller selectable child node, such as a frame/component inside the page, or call figma:metadata on the page first and choose a child target.",
      docsHint: "Figma Workspace CLI: figma:design-context --help",
    }],
  };
}

async function executeCallUpstreamTool(
  args: FigmaWorkspaceCallUpstreamToolArguments,
  runtime: {
    client: FigmaUpstreamMcpProxyClient;
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
  await connectUpstream(runtime.client, "Call upstream Figma MCP tool");
  const upstream = await callUpstreamToolWithLimits(runtime.client, args.toolName, upstreamArgs);
  const parsed = parseUpstreamToolResult(upstream);
  const session = currentInvocationContext();
  const resultPayload = {
    ok: !parsed.upstreamError,
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
      wrapperToolName: "figma:upstream:call",
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
    if (args.kind === "api" && args.apiId !== undefined) {
      return makeJsonToolResult({
        ok: true,
        mode: "read",
        declaration: readFigmaWorkspacePluginApiDeclaration(args.apiId),
        guidance: "Use the exact bundled declaration for Plugin API typing decisions, then execute changes through figma:run.",
      });
    }
    if (args.kind === "docs") {
      const normalized = normalizeLookupParameters(args, {
        maxResults: DEFAULT_DOCS_SEARCH_MAX_RESULTS,
        maxSnippetLines: DEFAULT_DOCS_SEARCH_SNIPPET_LINES,
      });
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
        maxResults: normalized.maxResults,
        maxSnippetLines: normalized.maxSnippetLines,
      });
      const payload = {
        ok: true,
        mode: "search",
        requestedScope,
        effectiveScopes,
        route,
        results: matches.results,
        ...(matches.snippetBudget ? { snippetBudget: matches.snippetBudget } : {}),
        ...(normalized.parameterAdjustments.length > 0
          ? { parameterAdjustments: normalized.parameterAdjustments }
          : {}),
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
    const normalized = normalizeLookupParameters(args, {
      maxResults: 5,
      maxSnippetLines: 5,
    });
    const matches = await searchReferenceFiles({
      query: symbol,
      maxResults: normalized.maxResults,
      maxSnippetLines: normalized.maxSnippetLines,
      exactSymbol: true,
      corpus: "api",
    });
    const apiId = matches.results.find((result) => result.apiId !== undefined)?.apiId;
    const payload = {
      ok: true,
      mode: "search",
      normalizedSymbol: matches.normalizedSymbol,
      ownerHint: matches.ownerHint,
      results: matches.results,
      ...(matches.snippetBudget ? { snippetBudget: matches.snippetBudget } : {}),
      ...(normalized.parameterAdjustments.length > 0
        ? { parameterAdjustments: normalized.parameterAdjustments }
        : {}),
      ...(apiId
        ? {
          nextActions: [{
            commandId: "figma:api:read" as const,
            args: { id: apiId },
            reason: "Read the exact declaration record in full.",
            priority: 1,
          }],
        }
        : {}),
      guidance:
        "Results are compact declarations from the generated bundled typings index. Use figma:api:read with a returned apiId for the complete declaration record.",
    };
    return makeJsonToolResult(payload);
  } catch (error) {
    if (error instanceof FigmaWorkspaceLookupCorpusUnavailableError) {
      const mode = args.kind === "api" && args.apiId !== undefined ? "read" : "search";
      return makeJsonToolResult({
        ok: false,
        mode,
        ...(mode === "search" ? { results: [] } : {}),
        diagnostics: diagnosticsForResponse([lookupCorpusDiagnostic(error)]),
        guidance: "A canonical docs or generated Plugin API lookup asset is unavailable in this CLI process. Rebuild the cli-runtime dist after confirming those bundled assets exist, then start a new CLI command.",
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
  const needsCatalogFirst = options.route.status !== "matched" ||
    options.route.confidence === "low" ||
    options.route.confidence === "none";
  if (needsCatalogFirst) {
    const taskFamily = options.route.candidateTaskFamilies[0];
    actions.push({
      commandId: "figma:docs:catalog",
      args: taskFamily ? { taskFamily } : {},
      reason: "Choose an exact canonical task family before reading a full document.",
      priority: 1,
    });
  }
  const firstDocId = options.results.find((result) =>
    result.docId?.startsWith("project:") || result.docId?.startsWith("canonical:"))?.docId;
  if (firstDocId) {
    actions.push({
      commandId: "figma:docs:read",
      args: { id: firstDocId },
      reason: "Read the top document in full.",
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
    suggestion: "Rebuild the cli-runtime dist if canonical docs or generated Plugin API index assets are missing, then rerun the same figma:* command with the same explicit target.",
    docsHint: "Figma Workspace CLI: lookup --help",
  };
}

async function callUpstreamEval(
  client: FigmaUpstreamMcpProxyClient,
  evalSettings: EvalSettings,
  script: string,
): Promise<unknown> {
  await connectUpstream(client, "Figma Plugin API execution");
  return callUpstreamToolWithLimits(client, evalSettings.toolName, {
    ...evalSettings.upstreamArguments,
    [evalSettings.argumentName]: script,
  });
}

type UpstreamEvalAttempt =
  | {
      requestDispatched: boolean;
      error: FigmaWorkspaceUpstreamError;
      upstream?: never;
    }
  | {
      requestDispatched: true;
      error?: never;
      upstream: unknown;
      postResponseError?: PostResponseResourceError;
    };

async function attemptUpstreamEval(
  client: FigmaUpstreamMcpProxyClient,
  evalSettings: EvalSettings,
  script: string,
): Promise<UpstreamEvalAttempt> {
  try {
    await connectUpstream(client, "Figma Plugin API execution");
  } catch (error) {
    return {
      requestDispatched: false,
      error: normalizeCaughtUpstreamError(error),
    };
  }

  let requestDispatched = false;
  try {
    return {
      requestDispatched: true,
      upstream: await awaitUpstreamOperation(
        `Upstream tool ${evalSettings.toolName}`,
        (signal) => {
          const request = client.callTool(evalSettings.toolName, {
            ...evalSettings.upstreamArguments,
            [evalSettings.argumentName]: script,
          }, signal);
          requestDispatched = true;
          return request;
        },
        { countResponse: true },
      ),
    };
  } catch (error) {
    if (error instanceof PostResponseResourceError) {
      return {
        requestDispatched: true,
        upstream: error.response,
        postResponseError: error,
      };
    }
    return {
      requestDispatched,
      error: normalizeCaughtUpstreamError(error),
    };
  }
}

function createUpstreamToolCache(client: FigmaUpstreamMcpProxyClient) {
  let cached: UpstreamToolInfo[] | undefined;
  return {
    async list(refresh = false): Promise<UpstreamToolInfo[]> {
      if (cached && !refresh) {
        return cached;
      }
      await connectUpstream(client, "Discover upstream Figma MCP tools");
      const result = asRecord(await listUpstreamToolsWithLimits(client, "Discover upstream Figma MCP tools"));
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
  list_file_components_for_code_connect: "code-connect",
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

const PUBLIC_HISTORY_COMMAND_IDS: Readonly<Record<string, FigmaWorkspacePublicCommandId>> = {
  figma_workspace_eval: "figma:run",
  figma_workspace_run_script_file: "figma:run",
  figma_workspace_apply_asset_manifest: "figma:assets:apply",
  figma_workspace_download_assets: "figma:assets:download",
  figma_workspace_capture_node: "figma:capture",
  figma_workspace_inspect: "figma:inspect",
  figma_workspace_get_metadata: "figma:metadata",
  figma_workspace_get_design_context: "figma:design-context",
  figma_workspace_get_motion_context: "figma:motion-context",
  figma_workspace_search_design_system: "figma:design-system",
  figma_workspace_get_libraries: "figma:libraries",
  figma_workspace_get_variable_defs: "figma:variables",
  figma_workspace_call_upstream_tool: "figma:upstream:call",
};

const PUBLIC_HISTORY_KINDS: Readonly<Partial<Record<FigmaWorkspacePublicCommandId, string>>> = {
  "figma:run": "execution",
  "figma:assets:apply": "assets",
  "figma:assets:download": "assets",
  "figma:capture": "capture",
  "figma:inspect": "inspection",
  "figma:metadata": "read",
  "figma:design-context": "read",
  "figma:motion-context": "read",
  "figma:design-system": "read",
  "figma:libraries": "read",
  "figma:variables": "read",
  "figma:upstream:call": "upstream",
};

async function resolveEvalSettings(
  session: FigmaWorkspaceInvocationContext,
  args: Record<string, unknown>,
  runtime: {
    upstreamToolCache: ReturnType<typeof createUpstreamToolCache>;
  },
  requestFileKey?: string,
): Promise<EvalSettings> {
  const toolName = DEFAULT_EVAL_TOOL_NAME;
  const tools = await runtime.upstreamToolCache.list(false);
  const tool = tools.find((item) => item.name === toolName);
  if (!tool) {
    throw new Error(
      "The required native Plugin API execution capability was not found. This may indicate upstream contract drift; use figma:upstream:list or figma:upstream:read before figma:upstream:call.",
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
  const fileKey = requestFileKey ?? session.fileKey ?? extractFigmaFileKey(session.fileUrl);
  if (
    typeof upstreamArguments.fileKey !== "string" ||
    upstreamArguments.fileKey.length === 0
  ) {
    if (fileKey) {
      upstreamArguments.fileKey = fileKey;
    }
  }
  if (requiredUpstreamProperties.has("fileKey") && typeof upstreamArguments.fileKey !== "string") {
    throw new Error("Native Plugin API execution requires a file key. Pass --file explicitly.");
  }
  return { toolName, argumentName, upstreamArguments };
}

function upstreamToolRequiredProperties(tool: UpstreamToolInfo): Set<string> {
  const schema = isRecord(tool.inputSchema) ? tool.inputSchema : undefined;
  const required = Array.isArray(schema?.required) ? schema.required : [];
  return new Set(required.filter((value): value is string => typeof value === "string"));
}

/**
 * @internal Internal wrapper builder used by the Figma Workspace CLI runtime and tests.
 * This is not a stable CLI input contract; callers should use figma:run.
 */
export function buildFigmaEvalScript(options: {
  session: Pick<FigmaWorkspaceInvocationContext, "invocationId">;
  code: string;
}): string {
  return `${createFigmaWorkspacePrelude(options.session)}
async function __figmaWorkspaceUserMain() {
${options.code}
}

const __figmaWorkspaceResult = await __figmaWorkspaceUserMain();
return {
  ok: true,
  __figmaWorkspace: {
    invocationId: __figmaWorkspace.invocationId,
    captureRequests: __figmaWorkspace.captureRequests
  },
  result: __figmaWorkspaceResult
};`;
}

function createFigmaWorkspacePrelude(
  session: Pick<FigmaWorkspaceInvocationContext, "invocationId">,
): string {
  return `const __figmaWorkspace = {
  invocationId: ${literal(session.invocationId)},
  captureRequests: []
};

async function __figmaWorkspaceGetNodeById(id) {
  if (typeof id !== "string" || !id || id.startsWith("$")) {
    throw new Error("Expected a raw Figma node id.");
  }
  const node = typeof figma.getNodeByIdAsync === "function"
    ? await figma.getNodeByIdAsync(id)
    : figma.getNodeById(id);
  if (!node) {
    throw new Error("Figma node not found: " + id);
  }
  return node;
}

async function __figmaWorkspaceResolveNode(value, label) {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    if (typeof value.id !== "string" || !value.id || typeof value.type !== "string") {
      throw new Error(label + " must be a real Figma node or raw node id.");
    }
    return __figmaWorkspaceGetNodeById(value.id);
  }
  if (typeof value !== "string" || !value || value.startsWith("$")) {
    throw new Error(label + " must be a real Figma node or raw node id.");
  }
  return __figmaWorkspaceGetNodeById(value);
}

function __figmaWorkspaceSummarizeNode(node, depth = 1) {
  if (!node) return null;
  if (Array.isArray(node)) return node.map((child) => __figmaWorkspaceSummarizeNode(child, depth));
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
    summary.children = node.children.slice(0, 30).map((child) => __figmaWorkspaceSummarizeNode(child, depth - 1));
  }
  return summary;
}

function __figmaWorkspaceFontName(font) {
  if (!font || typeof font !== "object" || Array.isArray(font)) {
    throw new Error("$.text font must be an object.");
  }
  if (Object.keys(font).some((key) => key !== "family" && key !== "style")) {
    throw new Error("$.text font supports only family and style.");
  }
  if (typeof font.family !== "string" || !font.family || typeof font.style !== "string" || !font.style) {
    throw new Error("$.text font requires non-empty family and style.");
  }
  return { family: font.family, style: font.style };
}

async function __figmaWorkspaceText(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new Error("$.text requires one options object.");
  }
  const allowedKeys = new Set(["target", "parent", "text", "font"]);
  if (Object.keys(input).some((key) => !allowedKeys.has(key))) {
    throw new Error("$.text supports only target, parent, text, and font.");
  }
  if (!Object.prototype.hasOwnProperty.call(input, "text") || typeof input.text !== "string") {
    throw new Error("$.text requires text as a string.");
  }
  if (input.target !== undefined && input.parent !== undefined) {
    throw new Error("$.text target and parent are mutually exclusive.");
  }

  let node;
  if (input.target !== undefined) {
    node = await __figmaWorkspaceResolveNode(input.target, "$.text target");
    if (node.type !== "TEXT") {
      throw new Error("$.text target must resolve to a TEXT node.");
    }
  } else {
    node = figma.createText();
    if (input.parent !== undefined) {
      const parent = await __figmaWorkspaceResolveNode(input.parent, "$.text parent");
      if (!parent || typeof parent.appendChild !== "function") {
        throw new Error("$.text parent must support appendChild().");
      }
      parent.appendChild(node);
    } else {
      figma.currentPage.appendChild(node);
    }
  }

  if (input.font !== undefined) {
    const font = __figmaWorkspaceFontName(input.font);
    await figma.loadFontAsync(font);
    node.fontName = font;
  } else {
    const font = node.fontName;
    if (!font || typeof font === "symbol" || typeof font !== "object" || Array.isArray(font)) {
      throw new Error("$.text cannot update mixed fonts without an explicit font.");
    }
    await figma.loadFontAsync(font);
  }
  node.characters = input.text;
  return node;
}

async function __figmaWorkspaceCapture(target, options = {}) {
  const node = await __figmaWorkspaceResolveNode(target, "$.capture target");
  if (!node || node.type === "DOCUMENT" || node.type === "PAGE") {
    throw new Error("$.capture target must resolve to a scene node.");
  }
  if (!options || typeof options !== "object" || Array.isArray(options)) {
    throw new Error("$.capture options must be an object.");
  }
  const allowedKeys = new Set(["imageFile", "maxDimension", "contentsOnly"]);
  if (Object.keys(options).some((key) => !allowedKeys.has(key))) {
    throw new Error("$.capture options support only imageFile, maxDimension, and contentsOnly.");
  }
  if (__figmaWorkspace.captureRequests.length >= ${MAX_QUEUED_CAPTURE_REQUESTS}) {
    throw new Error("$.capture supports at most ${MAX_QUEUED_CAPTURE_REQUESTS} requests per execution.");
  }
  const request = {
    requestId: "capture-" + String(__figmaWorkspace.captureRequests.length + 1),
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
  __figmaWorkspace.captureRequests.push(request);
  return { requestId: request.requestId, nodeId: request.nodeId };
}

const $ = Object.freeze({
  text: __figmaWorkspaceText,
  capture: __figmaWorkspaceCapture,
});`;
}
async function loadAssetManifest(
  args: FigmaWorkspaceApplyAssetManifestArguments,
  session: FigmaWorkspaceInvocationContext,
  resourceBudget: DataPlaneResourceBudget,
): Promise<NormalizedAssetManifest> {
  const manifestPath = resolveInvocationAwareFile(args.manifestPath, session, "manifestPath");
  const manifestValue = manifestPath ? await readAssetManifestValue(manifestPath, resourceBudget, session) : undefined;
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
  assertManifestItemCount(rawAssets.length, "Asset manifest");
  const baseDir = manifestPath ? dirname(manifestPath) : session.cwd;
  if (manifestRecord.argumentsTemplate !== undefined) {
    throw new Error('Asset manifest field "argumentsTemplate" was removed. Use figma:upstream:call only for explicit upstream capabilities.');
  }
  if (manifestRecord.toolName !== undefined || manifestRecord.arguments !== undefined || manifestRecord.refresh !== undefined) {
    throw new Error('Asset manifest fields "toolName/arguments/refresh" were removed. Use figma:upstream:call only for explicit upstream capabilities.');
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

async function readAssetManifestValue(
  manifestPath: string,
  resourceBudget: DataPlaneResourceBudget,
  session?: FigmaWorkspaceInvocationContext,
): Promise<unknown> {
  try {
    const bytes = session
      ? await readManagedWorkspaceFile({
        path: manifestPath,
        session,
        limitBytes: MAX_MANIFEST_FILE_BYTES,
        resourceBudget,
        label: "Asset manifest",
      })
      : await readBoundedLocalFile(
        manifestPath,
        MAX_MANIFEST_FILE_BYTES,
        resourceBudget,
        "Asset manifest",
      );
    return JSON.parse(bytes.toString("utf8")) as unknown;
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
    docsHint: "Figma Workspace CLI: figma:assets:apply --help",
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function normalizeManifestAsset(
  value: unknown,
  index: number,
  baseDir: string | undefined,
  session: FigmaWorkspaceInvocationContext,
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
  const targetResolution = resolveRequestScopedTarget({
    target: record.target,
    session,
    toolName: "figma:assets:apply",
  });
  const resolvedTargetNodeId = targetResolution.nodeId;
  if (!resolvedTargetNodeId) {
    throw new Error(`Asset manifest entry ${index} requires target.`);
  }
  return {
    path,
    mimeType: mimeTypeForRasterAssetPath(path),
    targetNodeId: resolvedTargetNodeId,
    fileKey: targetResolution.fileKey,
    nodeUrl: asOptionalString(record.nodeUrl) ?? asOptionalString(record.url) ?? buildFigmaNodeUrlForFileKey(targetResolution.fileKey, resolvedTargetNodeId),
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
  if (record.toolName !== undefined || record.arguments !== undefined || record.refresh !== undefined) {
    throw new Error(`Asset manifest entry ${index} fields "toolName/arguments/refresh" were removed. Use figma:upstream:call only for explicit upstream capabilities.`);
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
      `The required official ${kind} capability was not found. This may indicate upstream contract drift; use figma:upstream:list or figma:upstream:read before figma:upstream:call.`,
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
    `Required official upstream Figma MCP ${kind} capability no longer advertises inputSchema.properties.${propertyName}. This may indicate upstream contract drift; use figma:upstream:call for explicit upstream debugging.`,
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
    "The official asset upload/fill capability was not available. This may indicate upstream contract drift; use figma:upstream:call for explicit upstream debugging.",
  );
}

function buildUploadAssetsArguments(asset: NormalizedAssetManifestAsset): Record<string, unknown> {
  if (!asset.fileKey) {
    throw new Error(
      `Asset manifest entry for "${asset.path}" needs a file key. Pass --file explicitly or include fileKey in the manifest target.`,
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
    "The official node capture capability was not available. This may indicate upstream contract drift; use figma:upstream:call for explicit upstream debugging.",
  );
}

async function applyUploadedAssetFillsIfAvailable(options: {
  session: FigmaWorkspaceInvocationContext;
  runtime: {
    client: FigmaUpstreamMcpProxyClient;
    upstreamToolCache: ReturnType<typeof createUpstreamToolCache>;
  };
  tools: UpstreamToolInfo[];
  assetResults: Array<Record<string, unknown>>;
  assetDetails: Array<Record<string, unknown>>;
}): Promise<Record<string, unknown>> {
  const candidates = options.assetResults
    .map((asset, index): AssetManifestApplicationCandidate | undefined => {
      const targetNodeId = asOptionalString(asset.targetNodeId);
      const imageHash = extractAssetUploadImageHash(asset.upload);
      if (!targetNodeId || !imageHash) {
        return undefined;
      }
      const detail = options.assetDetails[index];
      const args = asRecord(detail?.arguments);
      return {
        targetNodeId,
        fileKey: asOptionalString(args.fileKey),
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
    const groupedCandidates = groupByFileKey(candidates, options.session);
    const applicationResults: AssetManifestApplicationBatchResult[] = [];
    for (const [fileKey, fileCandidates] of groupedCandidates) {
      const evalSettings = await resolveEvalSettings(options.session, {}, options.runtime, fileKey);
      const groupResult = await applyAssetManifestApplicationsInBatches({
        candidates: fileCandidates,
        session: options.session,
        client: options.runtime.client,
        evalSettings,
      });
      if (groupResult.upstreamError) {
        return {
          ok: false,
          error: responseUpstreamError(groupResult.upstreamError),
          primaryFix: groupResult.primaryFix,
        };
      }
      applicationResults.push(groupResult);
    }
    const applicationResult: AssetManifestApplicationBatchResult = {
      found: applicationResults.every((result) => result.found),
      applicationSource: applicationResults.length > 1 ? "file-key-groups" : applicationResults[0]?.applicationSource,
      applications: applicationResults.flatMap((result) => result.applications),
    };
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
  fileKey?: string;
  imageHash: string;
  scaleMode: string;
}

function groupByFileKey<T extends { fileKey?: string }>(
  values: readonly T[],
  session: FigmaWorkspaceInvocationContext,
): Map<string, T[]> {
  const sessionFileKey = session.fileKey ?? extractFigmaFileKey(session.fileUrl);
  const groups = new Map<string, T[]>();
  for (const value of values) {
    const fileKey = value.fileKey ?? sessionFileKey;
    if (!fileKey) {
      throw new Error("A request-scoped Figma file key is required for native node processing.");
    }
    const group = groups.get(fileKey) ?? [];
    group.push(value);
    groups.set(fileKey, group);
  }
  return groups;
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
  session: FigmaWorkspaceInvocationContext;
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
  session: FigmaWorkspaceInvocationContext;
  client: FigmaUpstreamMcpProxyClient;
  evalSettings: EvalSettings;
}): Promise<AssetManifestApplicationBatchResult> {
  const upstream = await callUpstreamEval(
    options.client,
    options.evalSettings,
    buildFigmaEvalScript({
      session: options.session,
      code: buildAssetManifestApplicationCode(options.candidates),
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
    const node = await __figmaWorkspaceGetNodeById(asset.targetNodeId);
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
    if (priorityKeys.includes(key) || key === "__figmaWorkspace") {
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
  session: FigmaWorkspaceInvocationContext;
  runtime: {
    client: FigmaUpstreamMcpProxyClient;
    upstreamToolCache: ReturnType<typeof createUpstreamToolCache>;
  };
  tools: UpstreamToolInfo[];
  assetResults: Array<Record<string, unknown>>;
  assetDetails: Array<Record<string, unknown>>;
}): Promise<Record<string, unknown>> {
  if (options.args.validateTargets === false) {
    return { ok: undefined, skipped: true, reason: "validateTargets=false" };
  }
  const targets = options.assetDetails.flatMap((detail) => {
    const targetNodeId = asOptionalString(detail.targetNodeId);
    if (!targetNodeId) return [];
    return [{
      targetNodeId,
      fileKey: asOptionalString(asRecord(detail.arguments).fileKey),
    }];
  });
  const targetNodeIds = Array.from(new Set(targets.map((target) => target.targetNodeId)));
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
    const groupedTargets = groupByFileKey(targets, options.session);
    const validationResults: AssetManifestTargetValidationBatchResult[] = [];
    for (const [fileKey, fileTargets] of groupedTargets) {
      const evalSettings = await resolveEvalSettings(options.session, {}, options.runtime, fileKey);
      const groupResult = await readAssetManifestTargetValidationsInBatches({
        targetNodeIds: fileTargets.map((target) => target.targetNodeId),
        session: options.session,
        client: options.runtime.client,
        evalSettings,
      });
      if (groupResult.upstreamError) {
        return {
          ok: false,
          error: responseUpstreamError(groupResult.upstreamError),
          primaryFix: groupResult.primaryFix,
        };
      }
      validationResults.push(groupResult);
    }
    const validationResult: AssetManifestTargetValidationBatchResult = {
      found: validationResults.every((result) => result.found),
      validationSource: validationResults.length > 1 ? "file-key-groups" : validationResults[0]?.validationSource,
      validations: validationResults.flatMap((result) => result.validations),
    };
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
  session: FigmaWorkspaceInvocationContext;
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
  session: FigmaWorkspaceInvocationContext;
  client: FigmaUpstreamMcpProxyClient;
  evalSettings: EvalSettings;
}): Promise<AssetManifestTargetValidationBatchResult> {
  const upstream = await callUpstreamEval(
    options.client,
    options.evalSettings,
    buildFigmaEvalScript({
      session: options.session,
      code: buildAssetManifestTargetValidationCode(options.targetNodeIds),
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
    const node = await __figmaWorkspaceGetNodeById(targetNodeId);
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
    if (priorityKeys.includes(key) || key === "__figmaWorkspace") {
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
  input: OpenedAssetInput,
  parsed: ParsedUpstreamToolResult,
  resourceBudget: DataPlaneResourceBudget,
): Promise<Record<string, unknown> | undefined> {
  const { asset, handle, stats: fileStats } = input;
  const submitUrl = extractAssetSubmitUrl(parsed.json);
  if (!submitUrl) {
    return undefined;
  }
  assertSingleItemLimit(fileStats.size, MAX_SINGLE_ASSET_BYTES, `Asset upload ${asset.path}`);
  resourceBudget.assertCanConsume(fileStats.size, `Asset upload ${asset.path}`);
  const mimeType = asset.mimeType;
  const deadline = new NetworkRequestDeadline(`Asset upload ${asset.path}`);
  const source = handle.createReadStream({ autoClose: false, start: 0 });
  let uploadedBytes = 0;
  const countedBody = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      try {
        const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        uploadedBytes += bytes.byteLength;
        assertSingleItemLimit(uploadedBytes, MAX_SINGLE_ASSET_BYTES, `Asset upload ${asset.path}`);
        resourceBudget.consume(bytes.byteLength, `Asset upload ${asset.path}`);
        deadline.touch();
        callback(null, bytes);
      } catch (error) {
        callback(error instanceof Error ? error : new Error(String(error)));
      }
    },
  });
  const abortSource = (): void => {
    source.destroy(deadline.controller.signal.reason instanceof Error
      ? deadline.controller.signal.reason
      : new Error("Asset upload aborted."));
  };
  deadline.controller.signal.addEventListener("abort", abortSource, { once: true });
  try {
    const response = await fetch(submitUrl, {
      method: "POST",
      headers: {
        "Content-Type": mimeType,
        "Content-Length": String(fileStats.size),
      },
      body: source.pipe(countedBody) as unknown as BodyInit,
      duplex: "half",
      signal: deadline.controller.signal,
    } as RequestInit & { duplex: "half" });
    const responseBytes = await readBoundedResponseBody({
      response,
      itemLimitBytes: MAX_SINGLE_ASSET_BYTES,
      resourceBudget,
      deadline,
      label: `Asset upload response for ${asset.path}`,
    });
    const text = responseBytes.toString("utf8");
    const json = parseJsonLenient(text);
    if (!response.ok) {
      return {
        ok: false,
        status: response.status,
        statusText: response.statusText,
        mimeType,
        bytes: uploadedBytes,
        response: summarizeUploadResponse(text, json),
      };
    }
    return {
      ok: true,
      status: response.status,
      statusText: response.statusText,
      mimeType,
      bytes: uploadedBytes,
      response: summarizeUploadResponse(text, json),
    };
  } finally {
    deadline.controller.signal.removeEventListener("abort", abortSource);
    source.destroy();
    countedBody.destroy();
    deadline.dispose();
  }
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

function mimeTypeForRasterAssetPath(path: string): RasterAssetMimeType {
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
  if (lower.endsWith(".png")) {
    return "image/png";
  }
  throw new Error(
    `Asset manifest path must reference a raster PNG, JPG, JPEG, GIF, or WebP file. SVG is not supported by figma:assets:apply because official SVG uploads create editable vector node trees instead of filling the explicit target; use figma:run for that workflow: ${path}`,
  );
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
  requestFileKey: string,
  session: FigmaWorkspaceInvocationContext,
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
    const evalSettings = await resolveEvalSettings(session, {}, runtime, requestFileKey);
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
        source: "native-plugin-api",
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
      source: "native-plugin-api",
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
        docsHint: "figma:metadata enrichment",
      },
    ],
  };
}

async function readMetadataNativeFieldsInBatches(options: {
  nodeIds: string[];
  session: FigmaWorkspaceInvocationContext;
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
  session: FigmaWorkspaceInvocationContext;
  client: FigmaUpstreamMcpProxyClient;
  evalSettings: EvalSettings;
}): Promise<Map<string, FigmaWorkspaceMetadataNativeFields>> {
  const upstream = await callUpstreamEval(
    options.client,
    options.evalSettings,
    buildFigmaEvalScript({
      session: options.session,
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
    source: "figma:metadata",
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
  if (
    !Number.isSafeInteger(number)
    || number < INLINE_RESULT_LIMIT_MIN
    || number > INLINE_RESULT_LIMIT_MAX
  ) {
    throw new Error(`Tool argument "inlineResultLimit" must be an integer from ${INLINE_RESULT_LIMIT_MIN} to ${INLINE_RESULT_LIMIT_MAX} bytes (${formatBytesHuman(INLINE_RESULT_LIMIT_MAX)} maximum).`);
  }
  return number;
}

function formatBytesHuman(bytes: number): string {
  if (bytes < 1_000) {
    return `${bytes} bytes`;
  }
  const kb = bytes / 1_000;
  const rounded = Number.isInteger(kb) ? String(kb) : kb.toFixed(1);
  return `${rounded} KB`;
}

function applyInvocationFileReference(session: FigmaWorkspaceInvocationContext, file: unknown): void {
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
    return "Run npm run login:figma-http from the figma-workspace plugin root, complete browser OAuth, then retry the same figma:* command.";
  }
  if (error.code === "FIGMA_UPSTREAM_OAUTH_REGISTRATION_REJECTED") {
    return "Use a Figma-supported OAuth client for this runtime or seed registered client metadata in .figma-workspace-oauth.json, then retry.";
  }
  if (error.code === "FIGMA_UPSTREAM_OAUTH_CALLBACK_TIMEOUT") {
    return "Rerun npm run login:figma-http, complete the browser OAuth callback before the timeout, then retry.";
  }
  if (error.code === "FIGMA_UPSTREAM_OAUTH_CANCELLED") {
    return "Restart the same figma:* command or run npm run login:figma-http, complete browser OAuth, then retry.";
  }
  if (error.code === "FIGMA_UPSTREAM_OAUTH_CALLBACK_PORT_IN_USE") {
    const callbackPort = isRecord(error.details) && typeof error.details.callbackPort === "number"
      ? ` ${error.details.callbackPort}`
      : "";
    return `Free OAuth callback port${callbackPort} or configure this runtime with a different callback port, then rerun npm run login:figma-http.`;
  }
  if (error.code === "FIGMA_UPSTREAM_OAUTH_CALLBACK_STARTUP_FAILED") {
    return "Free or change the OAuth callback host/port, then rerun npm run login:figma-http and retry the same figma:* command.";
  }
  if (error.code === "FIGMA_UPSTREAM_OAUTH_CALLBACK_FAILED") {
    return "Rerun npm run login:figma-http and complete a successful browser OAuth callback, then retry.";
  }
  if (error.code === "FIGMA_UPSTREAM_OAUTH_TOKEN_EXCHANGE_FAILED") {
    return "Rerun npm run login:figma-http to refresh the OAuth token exchange, then retry the same figma:* command.";
  }
  if (error.code === "FIGMA_UPSTREAM_FAILED") {
    return "Check the upstream Figma MCP connection and retry the same figma:* command after the upstream issue is resolved.";
  }
  const message = error.message.toLowerCase();
  if (message.includes("font") || message.includes("characters")) {
    return "Load the target font with figma.loadFontAsync or use $.text before changing TextNode characters.";
  }
  return "Open the paired .figma.ts file, repair the upstream Plugin API error, then rerun the same script; strict preflight always applies.";
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

function responseScriptMetadata(
  metadata: Record<string, unknown>,
): FigmaWorkspaceCompactScriptMetadata {
  return removeUndefined({
    scriptPath: metadata.scriptPath,
    expectedSurface: metadata.expectedSurface,
    compiledScriptBytes: metadata.compiledScriptBytes,
  }) as FigmaWorkspaceCompactScriptMetadata;
}

function responseRunSuccessMetadata(
  args: FigmaWorkspaceRunArguments,
): FigmaWorkspaceCompactScriptMetadata | undefined {
  const scriptPath = asOptionalString(args.scriptPath);
  return scriptPath ? responseScriptMetadata({ scriptPath }) : undefined;
}

function upstreamResultFields(options: {
  parsed: ParsedUpstreamToolResult;
  upstream?: unknown;
}): Record<string, unknown> {
  return {
    upstream: upstreamEnvelope(options.parsed),
  };
}

function runUpstreamFields(parsed: ParsedUpstreamToolResult): Record<string, unknown> {
  return {
    upstream: upstreamEnvelope(parsed),
  };
}

function runUpstreamFailureFields(parsed: ParsedUpstreamToolResult): Record<string, unknown> {
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
  try {
    return {
      ...limitedPayload,
      outputFiles: await options.writeOutputFiles(upstreamEnvelope(options.parsed)),
    };
  } catch (error) {
    return localPostprocessingFailure(limitedPayload, "backendSidecars", error);
  }
}

function localPostprocessingFailure(
  resultPayload: Record<string, unknown>,
  stage: string,
  error: unknown,
  outputFiles?: object,
): Record<string, unknown> {
  const executionOutcome = asOptionalString(resultPayload.executionOutcome);
  const existingGuidance = asOptionalString(resultPayload.retryGuidance);
  const localGuidance = executionOutcome === "succeeded"
    ? "The remote operation succeeded and may have mutated Figma. Do not rerun it; repair only the failed local post-processing step."
    : executionOutcome === "outcome_unknown"
      ? "The remote outcome is unknown and local recovery output also failed. Inspect or read back Figma and reconcile state before any retry."
      : "Inspect the returned business result and repair the failed local post-processing step before retrying.";
  return removeUndefined({
    ...resultPayload,
    ok: false,
    retryGuidance: existingGuidance ? `${existingGuidance} ${localGuidance}` : localGuidance,
    postProcessing: {
      ...asRecord(resultPayload.postProcessing),
      [stage]: {
        status: "failed",
        message: errorMessage(error),
        code: asOptionalString(asRecord(error).code),
      },
    },
    outputFiles: outputFiles && Object.keys(outputFiles).length > 0 ? outputFiles : resultPayload.outputFiles,
  }) as Record<string, unknown>;
}

async function attachPostExecutionOutputFiles(options: {
  resultPayload: Record<string, unknown>;
  stage: string;
  write: () => Promise<object>;
}): Promise<Record<string, unknown>> {
  try {
    const outputFiles = await options.write();
    return {
      ...options.resultPayload,
      outputFiles: Object.keys(outputFiles).length > 0 ? outputFiles : undefined,
    };
  } catch (error) {
    return localPostprocessingFailure(options.resultPayload, options.stage, error);
  }
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
  if (!Object.prototype.hasOwnProperty.call(record, "__figmaWorkspace")) {
    return consumeTopLevelOk(value);
  }
  if (Object.prototype.hasOwnProperty.call(record, "result")) {
    return consumeTopLevelOk(record.result);
  }
  const result: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(record)) {
    if (key !== "__figmaWorkspace" && key !== "ok") {
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
}function sortedUnique(values: string[]): string[] {
  return [...new Set(values)].sort((a, b) => a.localeCompare(b));
}

interface FigmaWorkspaceResolvedRequestTarget {
  fileKey?: string;
  nodeId?: string;
  kind: "none" | "raw-node-id" | "node-url" | "structured";
  displayTarget?: string;
  targetFileKey?: string;
  sessionFileKey?: string;
  crossFile: boolean;
}

function resolveWrapperNodeTarget(options: {
  args: { file?: string; target?: unknown };
  session: FigmaWorkspaceInvocationContext;
  toolName: LocalWorkspaceToolName | FigmaWorkspacePublicCommandId;
  targetFallback?: unknown;
  requireNode?: boolean;
  fileKeyError?: string;
  targetError?: string;
}): FigmaWorkspaceResolvedRequestTarget & { fileKey: string } {
  const allowCompositeNodeId = allowsCompositeNodeId(options.toolName);
  const targetInput = options.args.target ?? options.targetFallback ?? extractFigmaNodeId(options.args.file, allowCompositeNodeId);
  const target = resolveRequestScopedTarget({
    target: targetInput,
    explicitFile: options.args.file,
    session: options.session,
    toolName: options.toolName,
    allowCompositeNodeId,
  });
  if (!target.fileKey) {
    throw new Error(options.fileKeyError ?? `${options.toolName} requires a Figma file key. Pass "file" explicitly.`);
  }
  if (options.requireNode && !target.nodeId) {
    throw new Error(options.targetError ?? `${options.toolName} requires "target". Pass a raw node id, node URL, or { fileKey, nodeId } target.`);
  }
  return { ...target, fileKey: target.fileKey };
}

function resolveRequestScopedTarget(options: {
  target: unknown;
  explicitFile?: string;
  session: FigmaWorkspaceInvocationContext;
  toolName: string;
  allowCompositeNodeId?: boolean;
}): FigmaWorkspaceResolvedRequestTarget {
  const nodeIdIsValid = options.allowCompositeNodeId ? isCompositeCapableFigmaNodeId : isSimpleFigmaNodeId;
  const sessionFileKey = options.session.fileKey ?? extractFigmaFileKey(options.session.fileUrl);
  const explicitFileKey = parseFigmaFileReference(options.explicitFile).fileKey;
  let kind: FigmaWorkspaceResolvedRequestTarget["kind"] = "none";
  let nodeId: string | undefined;
  let targetFileKey: string | undefined;
  let displayTarget: string | undefined;

  if (isRecord(options.target)) {
    const allowedKeys = new Set(["fileKey", "nodeId"]);
    if (Object.keys(options.target).some((key) => !allowedKeys.has(key))) {
      throw new Error('Structured node targets support only { fileKey, nodeId }.');
    }
    targetFileKey = asOptionalString(options.target.fileKey);
    nodeId = asOptionalString(options.target.nodeId);
    if (!targetFileKey || !isFigmaFileKey(targetFileKey) || !nodeId || !nodeIdIsValid(nodeId)) {
      throw new Error('Structured node targets require an official Figma fileKey and nodeId.');
    }
    kind = "structured";
    displayTarget = nodeId;
  } else {
    const value = asOptionalString(options.target)?.trim();
    if (value) {
      displayTarget = value;
      if (value.startsWith("$")) {
        throw new Error(`${options.toolName} does not accept dynamic selectors. Pass a stable raw node id or Figma node URL.`);
      } else {
        const looksLikeUrl = /^[a-z][a-z0-9+.-]*:\/\//iu.test(value);
        const parsedUrl = looksLikeUrl ? parseUrl(value) : undefined;
        if (looksLikeUrl && !parsedUrl) {
          throw new Error(`${options.toolName} target URL is malformed.`);
        }
        if (parsedUrl) {
          if (parsedUrl.protocol !== "https:" || (parsedUrl.hostname !== "figma.com" && !parsedUrl.hostname.endsWith(".figma.com"))) {
            throw new Error(`${options.toolName} target URL must use an https://*.figma.com Figma URL.`);
          }
          const fromUrl = extractFigmaNodeId(value, options.allowCompositeNodeId);
          if (!fromUrl) {
            throw new Error(`${options.toolName} node URL must include a node-id query parameter.`);
          }
          kind = "node-url";
          nodeId = fromUrl;
          targetFileKey = extractFigmaFileKey(value);
          if (!targetFileKey) {
            throw new Error(`${options.toolName} node URL must include a valid Figma file key.`);
          }
        } else {
          if (!nodeIdIsValid(value)) {
            throw new Error(`${options.toolName} target must be an official Figma node id or Figma node URL.`);
          }
          kind = "raw-node-id";
          nodeId = value;
        }
      }
    }
  }

  if (explicitFileKey && targetFileKey && explicitFileKey !== targetFileKey) {
    throw new Error(
      `${options.toolName} received conflicting file contexts: explicit file ${explicitFileKey} and target file ${targetFileKey}.`,
    );
  }
  const fileKey = targetFileKey ?? explicitFileKey ?? sessionFileKey;
  return {
    fileKey,
    nodeId,
    kind,
    displayTarget,
    targetFileKey,
    sessionFileKey,
    crossFile: Boolean(
      fileKey &&
      fileKey !== sessionFileKey &&
      (targetFileKey || explicitFileKey),
    ),
  };
}

function parseUrl(value: string): URL | undefined {
  try {
    return new URL(value);
  } catch {
    return undefined;
  }
}

function buildFigmaNodeUrlForFileKey(fileKey: string | undefined, nodeId: string): string | undefined {
  const nodeParam = encodeURIComponent(nodeId.replace(/:/gu, "-"));
  return fileKey ? `https://www.figma.com/design/${fileKey}/?node-id=${nodeParam}` : undefined;
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
    const parsed = parseStrictFigmaFileUrl(value);
    return {
      fileUrl: value,
      fileKey: parsed.fileKey,
      fileSlug: parsed.fileSlug,
      surface: parsed.surface,
    };
  } catch {
    if (/^[a-z][a-z0-9+.-]*:\/\//iu.test(value)) {
      throw new Error('Tool argument "file" must use an https://*.figma.com Design, FigJam, or Slides file URL with a file key.');
    }
    if (!isSimpleFigmaFileKey(value)) {
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
    return parseStrictFigmaFileUrl(fileUrl).fileKey;
  } catch {
    return undefined;
  }
}

function extractFigmaNodeId(value: string | undefined, allowCompositeNodeId = false): string | undefined {
  if (!value) {
    return undefined;
  }
  try {
    const url = new URL(value);
    const nodeId = url.searchParams.get("node-id") ?? url.searchParams.get("node_id");
    const nodeIdIsValid = allowCompositeNodeId ? isCompositeCapableFigmaNodeId : isSimpleFigmaNodeId;
    return nodeId && nodeIdIsValid(nodeId) ? nodeId.replace(/-/gu, ":") : undefined;
  } catch {
    return undefined;
  }
}

function extractFigmaFileSlug(fileUrl: string | undefined): string | undefined {
  if (!fileUrl) {
    return undefined;
  }
  try {
    return parseStrictFigmaFileUrl(fileUrl).fileSlug;
  } catch {
    return undefined;
  }
}

function inferFigmaSurface(fileUrl: string | undefined): FigmaWorkspaceSurface | undefined {
  if (!fileUrl) {
    return undefined;
  }
  try {
    return parseStrictFigmaFileUrl(fileUrl).surface;
  } catch {
    return undefined;
  }
}

function parseStrictFigmaFileUrl(value: string): {
  fileKey: string;
  fileSlug?: string;
  surface: FigmaWorkspaceSurface;
} {
  const url = new URL(value);
  if (url.protocol !== "https:" || (url.hostname !== "figma.com" && !url.hostname.endsWith(".figma.com"))) {
    throw new Error("Figma file URLs must use https://*.figma.com.");
  }
  const parts = url.pathname.split("/").filter(Boolean);
  const kind = parts[0];
  const fileKey = parts[1];
  if (!FIGMA_FILE_URL_KINDS.includes(kind as typeof FIGMA_FILE_URL_KINDS[number]) || !fileKey || !isSimpleFigmaFileKey(fileKey)) {
    throw new Error("Figma file URLs must include a valid Design, FigJam, or Slides path and file key.");
  }
  const nodeId = url.searchParams.get("node-id") ?? url.searchParams.get("node_id");
  if (nodeId !== null && !isCompositeCapableFigmaNodeId(nodeId)) {
    throw new Error("Figma file URLs must include a valid official Figma node id when node-id is present.");
  }
  const surface: FigmaWorkspaceSurface = kind === "design" || kind === "file"
    ? "design"
    : kind === "figjam" || kind === "board"
      ? "figjam"
      : "slides";
  const name = parts[2];
  return {
    fileKey,
    fileSlug: name ? slugifyTaskName(decodeURIComponent(name)) : undefined,
    surface,
  };
}

function isSimpleFigmaFileKey(value: string): boolean {
  return isFigmaFileKey(value);
}

function allowsCompositeNodeId(toolName: string): boolean {
  return toolName === "figma:metadata"
    || toolName === "figma:design-context"
    || toolName === "figma_workspace_get_metadata"
    || toolName === "figma_workspace_get_design_context";
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

function normalizeLookupParameters(
  args: Pick<FigmaWorkspaceLookupArguments, "maxResults" | "maxSnippetLines">,
  defaults: { maxResults: number; maxSnippetLines: number },
): {
  maxResults: number;
  maxSnippetLines: number;
  parameterAdjustments: FigmaWorkspaceLookupParameterAdjustment[];
} {
  const parameterAdjustments: FigmaWorkspaceLookupParameterAdjustment[] = [];
  const maxResults = clampIntegerParameter({
    option: "--limit",
    requested: args.maxResults,
    fallback: defaults.maxResults,
    min: LOOKUP_RESULTS_MIN,
    max: MAX_DOCS_SEARCH_RESULTS,
    parameterAdjustments,
  });
  const maxSnippetLines = clampIntegerParameter({
    option: "--snippet-lines",
    requested: args.maxSnippetLines,
    fallback: defaults.maxSnippetLines,
    min: LOOKUP_SNIPPET_LINES_MIN,
    max: MAX_DOCS_SEARCH_SNIPPET_LINES,
    parameterAdjustments,
  });
  return { maxResults, maxSnippetLines, parameterAdjustments };
}

function clampIntegerParameter<Option extends string>(options: {
  option: Option;
  requested: number | undefined;
  fallback: number;
  min: number;
  max: number;
  parameterAdjustments: FigmaWorkspaceIntegerParameterAdjustment<Option>[];
}): number {
  if (options.requested === undefined) return options.fallback;
  const applied = Math.min(Math.max(options.requested, options.min), options.max);
  if (applied !== options.requested) {
    options.parameterAdjustments.push({
      option: options.option,
      requested: options.requested,
      applied,
      range: [options.min, options.max],
    });
  }
  return applied;
}

function literal(value: unknown): string {
  return JSON.stringify(value);
}
