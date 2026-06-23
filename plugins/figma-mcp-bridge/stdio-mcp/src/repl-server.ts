import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, extname, isAbsolute, relative, resolve } from "node:path";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  CallToolRequestSchema,
  ListResourceTemplatesRequestSchema,
  ListResourcesRequestSchema,
  ListToolsRequestSchema,
  ReadResourceRequestSchema,
  type CallToolRequest,
  type ListResourceTemplatesRequest,
  type ListResourcesRequest,
  type ListToolsRequest,
  type ReadResourceRequest,
} from "@modelcontextprotocol/sdk/types.js";
import {
  createRemoteMcpClient,
  type RemoteMcpClientOptions,
} from "./client.js";
import {
  API_LOOKUP_FILES,
  DEFAULT_DOCS_SEARCH_MAX_RESULTS,
  DEFAULT_DOCS_SEARCH_SNIPPET_LINES,
  DEFAULT_REFERENCE_CONTEXT_SNIPPETS,
  DOCS_SEARCH_ALLOWLIST,
  MAX_DOCS_SEARCH_RESULTS,
  MAX_DOCS_SEARCH_SNIPPET_LINES,
  MAX_LOOKUP_QUERY_LENGTH,
  type ReferenceSearchResult,
  normalizeLookupQuery,
  normalizeLookupRankingQuery,
  searchReferenceFiles,
} from "./repl-doc-search.js";
import {
  FIGMA_REPL_API_CARDS,
  FIGMA_REPL_COMMON_TASK_LABELS,
  FIGMA_REPL_INTENT_EXAMPLE_QUERIES,
  FIGMA_REPL_QUERY_OUTPUT_FIELDS,
  FIGMA_REPL_QUERY_SEARCH_ANCHORS,
  chooseApiCardsForIntent,
  searchApiCards,
  uniqueStrings,
} from "./repl-guidance-catalog.js";
import {
  assertSafeFigmaReplCode,
  compileFigmaReplScriptFile,
  diagnoseFigmaReplCode,
  diagnoseFigmaReplContext,
  diagnoseWrappedScriptSize,
  resolveFigmaReplScriptHelperSelection as resolveFigmaReplScriptHelperSelectionInternal,
  throwIfFatalDiagnostics,
  type FigmaReplDiagnostic,
  type FigmaReplDiagnosticsOptions,
  type FigmaReplDiagnosticSeverity,
  type FigmaReplFileDiagnostic,
  type FigmaReplSurface,
} from "./repl-script-runner.js";
import {
  assertRequiredTitleArgument,
  asApplyAssetManifestArgs,
  asCallUpstreamToolArgs,
  asCaptureNodeArgs,
  asDownloadAssetsArgs,
  asEvalArgs,
  asGuidanceArgs,
  asInspectArgs,
  asLookupArgs,
  asOpenArgs,
  asPrepareTaskArgs,
  asRunScriptFileArgs,
  asRunTaskPlanArgs,
  withDefaultTitle,
} from "./repl-tool-args.js";
import type {
  FigmaReplApplyAssetManifestArguments,
  FigmaReplCallUpstreamToolArguments,
  FigmaReplCaptureNodeArguments,
  FigmaReplDownloadAssetsArguments,
  FigmaReplDownloadAssetsTarget,
  FigmaReplEvalArguments,
  FigmaReplGuidanceArguments,
  FigmaReplInspectArguments,
  FigmaReplLookupArguments,
  FigmaReplOpenArguments,
  FigmaReplPrepareTaskArguments,
  FigmaReplRunScriptFileArguments,
  FigmaReplRunTaskPlanArguments,
  FigmaReplTaskPlanStep,
} from "./repl-tool-args.js";
import { createReplToolDescriptions } from "./repl-tool-metadata.js";
import {
  isLocalReplToolName,
  normalizeTaskPlanStepType as normalizeTaskPlanStepTypeAlias,
} from "./repl-tool-registry.js";
import {
  DEFAULT_WORKSPACE_DIR_NAME,
  TASK_WORKSPACE_ROOT_ENV,
  captureImageOutputFilePath,
  createCapturePreviewImage,
  createScriptOutputWriter,
  createSessionWorkspace,
  effectiveInlineResultLimit,
  ensureWorkspaceDirectories,
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
  type FigmaReplSessionWorkspace,
} from "./repl-workspace-files.js";
import type { FigmaMcpProxyClient } from "./stdio-server.js";

export const FIGMA_REPL_DEFAULT_SESSION_ID = "default";

export {
  assertSafeFigmaReplCode,
  diagnoseFigmaReplCode,
};

/**
 * @internal Internal-facing helper-selection utility for tests and payload debugging.
 * This is not a stable MCP tool input contract, and callers cannot use it to configure helper injection.
 */
export const resolveFigmaReplScriptHelperSelection = resolveFigmaReplScriptHelperSelectionInternal;
export type {
  FigmaReplDiagnostic,
  FigmaReplDiagnosticsOptions,
  FigmaReplDiagnosticSeverity,
  FigmaReplFileDiagnostic,
  FigmaReplSurface,
};
export type { FigmaReplSessionWorkspace } from "./repl-workspace-files.js";
export type {
  FigmaReplApplyAssetManifestArguments,
  FigmaReplAssetManifestAsset,
  FigmaReplCallUpstreamToolArguments,
  FigmaReplCaptureNodeArguments,
  FigmaReplDownloadAssetsArguments,
  FigmaReplDownloadAssetsTarget,
  FigmaReplEvalArguments,
  FigmaReplGuidanceArguments,
  FigmaReplInspectArguments,
  FigmaReplLookupArguments,
  FigmaReplOpenArguments,
  FigmaReplPrepareTaskArguments,
  FigmaReplRunScriptFileArguments,
  FigmaReplRunTaskPlanArguments,
  FigmaReplTaskPlanStep,
} from "./repl-tool-args.js";

const DEFAULT_EVAL_TOOL_NAME = "use_figma";
const DEFAULT_EVAL_ARGUMENT_NAME = "code";
export const FIGMA_REPL_EVAL_COMMON_HELPER_NAMES = [
  "remember",
  "forget",
  "resolveId",
  "node",
  "select",
  "cloneNodeTree",
  "findAll",
  "find",
  "text",
  "layout",
  "create",
  "findFreeSlot",
  "placeNode",
  "replaceGeneratedFrame",
  "inspect",
  "screenshot",
  "imageAsset",
  "checkpoint",
] as const;

type FigmaReplEvalCommonHelperName = (typeof FIGMA_REPL_EVAL_COMMON_HELPER_NAMES)[number];
type FigmaReplEvalHelperPath = "$" | `$.${FigmaReplEvalCommonHelperName}`;

const DEFAULT_HISTORY_LIMIT = 50;
const DEFAULT_INLINE_RESULT_LIMIT = 4_000;
const MAX_INLINE_RESULT_LIMIT = 30_000;
const UPLOAD_ASSETS_TOOL_NAME = "upload_assets";
const DOWNLOAD_ASSETS_TOOL_NAME = "download_assets";
const SCREENSHOT_TOOL_NAME = "get_screenshot";
export interface FigmaReplMcpServerOptions extends RemoteMcpClientOptions {
  client?: FigmaMcpProxyClient;
  name?: string;
  version?: string;
  defaultSessionId?: string;
  historyLimit?: number;
  useBridgeOAuthCache?: boolean;
  openBrowser?: boolean;
}

export interface FigmaReplClientOptions extends FigmaReplMcpServerOptions {
  /**
   * Absolute path to the shared figma-mcp-bridge OAuth cache file.
   * This is a Node REPL-friendly alias for statePath.
   */
  oauthCachePath?: string;
}

export interface FigmaReplUpstreamEnvelope {
  [key: string]: unknown;
  kind: "json" | "text";
  ok: boolean;
  payload?: unknown;
  text?: string;
}

export interface FigmaReplPublicUpstreamError {
  [key: string]: unknown;
  message: string;
  code?: string;
  details?: unknown;
}

export interface FigmaReplFilePointer {
  [key: string]: unknown;
  path: string;
  bytes: number;
  lineCount: number;
}

interface FigmaReplImageContent {
  [key: string]: unknown;
  type: "image";
  data: string;
  mimeType: string;
}

export interface FigmaReplOutputFiles {
  [key: string]: unknown;
  diagnosticsFile?: FigmaReplFilePointer;
  summaryFile?: FigmaReplFilePointer;
  compiledScriptFile?: FigmaReplFilePointer;
  outputFile?: FigmaReplFilePointer;
  upstreamFile?: FigmaReplFilePointer;
  metadataFile?: FigmaReplFilePointer;
}

export interface FigmaReplPublicWorkspace {
  [key: string]: unknown;
  root: string;
  fileDir: string;
  fileContext: string;
  fileKey?: string;
  fileSlug: string;
  taskSlug: string;
  sessionDir: string;
  scriptPath: string;
  outputFilePath: string;
  files: {
    inputFile: string;
    outputFile: string;
  };
}

export interface FigmaReplPublicSession {
  [key: string]: unknown;
  id: string;
  slug: string;
  createdAt: string;
  updatedAt: string;
  label?: string;
  fileUrl?: string;
  fileKey?: string;
  surface?: FigmaReplSurface;
  knownPages: Record<string, string>;
  currentPageId?: string;
  handles: Record<string, string>;
  lastDiagnostics: FigmaReplDiagnostic[];
  workspace?: FigmaReplPublicWorkspace;
}

export interface FigmaReplToolResultBase {
  [key: string]: unknown;
  ok: boolean;
  session?: FigmaReplPublicSession;
}

export interface FigmaReplOpenResult extends FigmaReplToolResultBase {
  session: FigmaReplPublicSession;
  diagnostics: FigmaReplDiagnostic[];
  upstreamTools?: string[];
}

export interface FigmaReplUpstreamBackedResult extends FigmaReplToolResultBase {
  upstream: FigmaReplUpstreamEnvelope;
  upstreamError?: FigmaReplPublicUpstreamError;
  primaryFix?: string;
}

export interface FigmaReplEvalResult extends FigmaReplUpstreamBackedResult {
  session: FigmaReplPublicSession;
  upstreamTool: string;
  upstreamArgument: string;
  diagnostics: FigmaReplDiagnostic[];
  outputFiles?: FigmaReplOutputFiles;
  inlineResultLimit?: FigmaReplInlineResultLimit;
}

export interface FigmaReplScriptMetadata {
  [key: string]: unknown;
  scriptPath: string;
  targetPageId?: string;
  expectedSurface?: FigmaReplSurface;
  injectedHelpers: string[];
  helperUsage?: Record<string, unknown>;
  compiledScriptBytes: number;
}

export interface FigmaReplInlineResultLimit {
  [key: string]: unknown;
  limit: number;
  limitBytes: number;
  limitHuman: string;
  omitted: Array<{ field: string; bytes: number; limit: number; bytesHuman: string; limitHuman: string }>;
  guidance?: string;
}

export interface FigmaReplRunScriptFileResult extends FigmaReplToolResultBase {
  dryRun: boolean;
  session: FigmaReplPublicSession;
  diagnostics: FigmaReplDiagnostic[];
  script: FigmaReplScriptMetadata;
  outputFiles?: FigmaReplOutputFiles;
  upstream?: FigmaReplUpstreamEnvelope;
  upstreamError?: FigmaReplPublicUpstreamError;
  primaryFix?: string;
  inlineResultLimit?: FigmaReplInlineResultLimit;
}

export interface FigmaReplAssetManifestItem {
  [key: string]: unknown;
  ok: boolean;
  path: string;
  targetNodeId: string;
  handle?: string;
  name?: string;
  toolName: string;
  upload?: unknown;
  validation?: unknown;
  error?: FigmaReplPublicUpstreamError;
  upstreamSummary?: string;
}

export interface FigmaReplApplyAssetManifestResult extends FigmaReplToolResultBase {
  session: FigmaReplPublicSession;
  assets: FigmaReplAssetManifestItem[];
  validation?: unknown;
  failures?: Array<Record<string, unknown>>;
  outputFiles?: FigmaReplOutputFiles;
}

export interface FigmaReplDownloadedAssetFile extends FigmaReplFilePointer {
  [key: string]: unknown;
  kind: "exported" | "raw";
  sourceUrl: string;
  mimeType?: string;
  format?: string;
}

export interface FigmaReplDownloadAssetsTargetResult {
  [key: string]: unknown;
  ok: boolean;
  targetNodeId: string;
  handle?: string;
  name?: string;
  outputDir: string;
  downloadedFiles: FigmaReplDownloadedAssetFile[];
  upstreamSummary?: string;
  error?: FigmaReplPublicUpstreamError;
}

export interface FigmaReplDownloadAssetsResult extends FigmaReplToolResultBase {
  session: FigmaReplPublicSession;
  outputDir: string;
  targets: FigmaReplDownloadAssetsTargetResult[];
  failures?: Array<Record<string, unknown>>;
  outputFiles: FigmaReplOutputFiles;
}

export interface FigmaReplCaptureQaResult {
  [key: string]: unknown;
  ok: boolean;
  warnings: string[];
}

export interface FigmaReplCapturePreviewResult {
  [key: string]: unknown;
  enabled: boolean;
  kind?: "mcp-image";
  mimeType?: string;
  width?: number;
  height?: number;
  bytes?: number;
  source?: string;
  omittedReason?: string;
}

export interface FigmaReplCaptureNodeResult extends FigmaReplUpstreamBackedResult {
  session: FigmaReplPublicSession;
  outputFile?: string;
  plannedOutputFile?: string;
  nodeId: string;
  handle?: string;
  toolName: string;
  kind?: string;
  mimeType?: string;
  bytes?: number;
  lineCount?: number;
  width?: number;
  height?: number;
  sourceUrl?: string;
  qa?: FigmaReplCaptureQaResult;
  preview?: FigmaReplCapturePreviewResult;
  outputFiles?: FigmaReplOutputFiles;
}

export interface FigmaReplTaskPlanStepResult {
  [key: string]: unknown;
  id: string;
  index: number;
  type: string;
  status: string;
  ok: boolean;
  summary?: Record<string, unknown>;
  outputReferences?: Record<string, unknown>;
  error?: FigmaReplPublicUpstreamError;
  startedAt?: string;
  finishedAt?: string;
}

export interface FigmaReplRunTaskPlanResult extends FigmaReplToolResultBase {
  session: FigmaReplPublicSession;
  stopped: boolean;
  stopOnFailure: boolean;
  steps: FigmaReplTaskPlanStepResult[];
  outputReferences?: Record<string, unknown>;
  outputFiles: FigmaReplOutputFiles;
  failures?: FigmaReplTaskPlanStepResult[];
}

export interface FigmaReplPreparedTask {
  [key: string]: unknown;
  taskSlug: string;
  fileContext: string;
  inputFile: string;
  outputFile: string;
  workspace: FigmaReplPublicWorkspace;
  scriptPath: string;
  overwritten: boolean;
}

export interface FigmaReplPrepareTaskResult extends FigmaReplToolResultBase {
  task: FigmaReplPreparedTask;
  outputFiles: FigmaReplOutputFiles;
  next: string[];
}

export interface FigmaReplGuidanceResult extends FigmaReplToolResultBase {
  mode: string;
  workflow?: Record<string, unknown>;
  steps?: string[];
  recommendedTools?: string[];
  suggestedCards?: string[];
  cards?: Array<Record<string, unknown>>;
  recommendedCards?: string[];
  queryHints?: string[];
  apiSymbols?: string[];
  avoid?: string[];
  suggestions?: Record<string, unknown>;
}

export interface FigmaReplInspectResult extends FigmaReplUpstreamBackedResult {
  session: FigmaReplPublicSession;
  diagnostics: FigmaReplDiagnostic[];
}

export interface FigmaReplCallUpstreamToolResult extends FigmaReplUpstreamBackedResult {
  session: FigmaReplPublicSession;
  toolName: string;
  outputFiles?: FigmaReplOutputFiles;
  inlineResultLimit?: FigmaReplInlineResultLimit;
}

export interface FigmaReplLookupResult extends FigmaReplToolResultBase {
  kind: "docs" | "api";
  query?: string;
  symbol?: string;
  maxResults: number;
  maxSnippetLines: number;
  results: ReferenceSearchResult[];
  guidance: string;
}

export interface FigmaReplClient {
  readonly client: FigmaMcpProxyClient;
  readonly sessions: FigmaReplSessionStore;
  connect(): Promise<void>;
  close(): Promise<void>;
  open(args?: FigmaReplOpenArguments): Promise<FigmaReplOpenResult>;
  eval(args: FigmaReplEvalArguments): Promise<FigmaReplEvalResult>;
  runScriptFile(args: FigmaReplRunScriptFileArguments): Promise<FigmaReplRunScriptFileResult>;
  applyAssetManifest(args: FigmaReplApplyAssetManifestArguments): Promise<FigmaReplApplyAssetManifestResult>;
  downloadAssets(args: FigmaReplDownloadAssetsArguments): Promise<FigmaReplDownloadAssetsResult>;
  captureNode(args: FigmaReplCaptureNodeArguments): Promise<FigmaReplCaptureNodeResult>;
  runTaskPlan(args: FigmaReplRunTaskPlanArguments): Promise<FigmaReplRunTaskPlanResult>;
  prepareTask(args: FigmaReplPrepareTaskArguments): Promise<FigmaReplPrepareTaskResult>;
  guidance(args: FigmaReplGuidanceArguments): Promise<FigmaReplGuidanceResult>;
  inspect(args?: FigmaReplInspectArguments): Promise<FigmaReplInspectResult>;
  callUpstreamTool(args: FigmaReplCallUpstreamToolArguments): Promise<FigmaReplCallUpstreamToolResult>;
  lookup(args: FigmaReplLookupArguments): Promise<FigmaReplLookupResult>;
}

export interface FigmaReplSession {
  id: string;
  slug: string;
  createdAt: string;
  updatedAt: string;
  label?: string;
  fileUrl?: string;
  fileKey?: string;
  surface?: FigmaReplSurface;
  knownPages: Record<string, string>;
  currentPageId?: string;
  handles: Record<string, string>;
  lastDiagnostics: FigmaReplDiagnostic[];
  history: FigmaReplHistoryEntry[];
  workspace?: FigmaReplSessionWorkspace;
}

export interface FigmaReplHistoryEntry {
  id: string;
  at: string;
  tool: string;
  title?: string;
  mode?: string;
  summary: string;
  nodeIds: string[];
}

export interface FigmaReplSessionStore {
  defaultSessionId: string;
  getOrCreate(sessionId?: string): FigmaReplSession;
  get(sessionId?: string): FigmaReplSession | undefined;
  list(): FigmaReplSession[];
  reset(sessionId?: string): FigmaReplSession;
  rememberHistory(session: FigmaReplSession, entry: FigmaReplHistoryEntry): void;
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
  upstreamError?: FigmaReplUpstreamError;
  primaryFix?: string;
}

interface FigmaReplUpstreamError {
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

interface FigmaReplRuntime {
  client: FigmaMcpProxyClient;
  sessions: FigmaReplSessionStore;
  upstreamToolCache: ReturnType<typeof createUpstreamToolCache>;
}

export function createFigmaReplSessionStore(options: {
  defaultSessionId?: string;
  historyLimit?: number;
} = {}): FigmaReplSessionStore {
  const defaultSessionId = sanitizeSessionId(
    options.defaultSessionId ?? FIGMA_REPL_DEFAULT_SESSION_ID,
  );
  const historyLimit = normalizePositiveInteger(options.historyLimit, DEFAULT_HISTORY_LIMIT);
  const sessions = new Map<string, FigmaReplSession>();

  const create = (sessionId?: string) => {
    const id = sanitizeSessionId(sessionId ?? defaultSessionId);
    const now = new Date().toISOString();
    const session: FigmaReplSession = {
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
    rememberHistory(session: FigmaReplSession, entry: FigmaReplHistoryEntry) {
      session.history.push(entry);
      if (session.history.length > historyLimit) {
        session.history.splice(0, session.history.length - historyLimit);
      }
      touchSession(session);
    },
  };
}

function createFigmaReplRuntime(
  options: FigmaReplClientOptions = {},
): FigmaReplRuntime {
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
  const sessions = createFigmaReplSessionStore({
    defaultSessionId: options.defaultSessionId,
    historyLimit: options.historyLimit,
  });
  const upstreamToolCache = createUpstreamToolCache(client);

  return { client, sessions, upstreamToolCache };
}

export function createFigmaReplClient(
  options: FigmaReplClientOptions = {},
): FigmaReplClient {
  const runtime = createFigmaReplRuntime(options);
  return {
    client: runtime.client,
    sessions: runtime.sessions,
    connect: () => runtime.client.connect(),
    close: () => runtime.client.close(),
    open: async (args = {}) =>
      parseJsonToolResult<FigmaReplOpenResult>(
        await handleOpen(asOpenArgs(withDefaultTitle(args, "Open Figma REPL session")), runtime),
      ),
    eval: async (args) =>
      parseJsonToolResult<FigmaReplEvalResult>(
        await handleEval(
          asEvalArgs(withDefaultTitle(args, "Run Figma REPL JavaScript")),
          runtime,
        ),
      ),
    runScriptFile: async (args) =>
      executeRunScriptFile(
        asRunScriptFileArgs(withDefaultTitle(args, "Run Figma JavaScript file")),
        runtime,
      ) as Promise<FigmaReplRunScriptFileResult>,
    applyAssetManifest: async (args) =>
      executeApplyAssetManifest(
        asApplyAssetManifestArgs(withDefaultTitle(args, "Apply Figma asset manifest")),
        runtime,
      ) as Promise<FigmaReplApplyAssetManifestResult>,
    downloadAssets: async (args) =>
      executeDownloadAssets(
        asDownloadAssetsArgs(withDefaultTitle(args, "Download Figma assets")),
        runtime,
      ) as Promise<FigmaReplDownloadAssetsResult>,
    captureNode: async (args) =>
      executeCaptureNode(
        asCaptureNodeArgs(withDefaultTitle(args, "Capture Figma node")),
        runtime,
      ) as Promise<FigmaReplCaptureNodeResult>,
    runTaskPlan: async (args) =>
      executeRunTaskPlan(
        asRunTaskPlanArgs(withDefaultTitle(args, "Run Figma REPL task plan")),
        runtime,
      ) as Promise<FigmaReplRunTaskPlanResult>,
    prepareTask: async (args) =>
      parseJsonToolResult<FigmaReplPrepareTaskResult>(
        await handlePrepareTask(
          asPrepareTaskArgs(withDefaultTitle(args, "Prepare Figma REPL task")),
          { sessions: runtime.sessions },
        ),
      ),
    guidance: async (args) =>
      parseJsonToolResult<FigmaReplGuidanceResult>(
        await handleGuidance(asGuidanceArgs(withDefaultTitle(args, "Read Figma REPL guidance"))),
      ),
    inspect: async (args = {}) =>
      parseJsonToolResult<FigmaReplInspectResult>(
        await handleInspect(asInspectArgs(withDefaultTitle(args, "Inspect Figma REPL target")), runtime),
      ),
    callUpstreamTool: async (args) =>
      executeCallUpstreamTool(
        asCallUpstreamToolArgs(withDefaultTitle(args, "Call upstream Figma MCP tool")),
        runtime,
      ) as Promise<FigmaReplCallUpstreamToolResult>,
    lookup: async (args) =>
      parseJsonToolResult<FigmaReplLookupResult>(
        await handleLookup(asLookupArgs(withDefaultTitle(args, "Look up Figma REPL reference"))),
      ),
  };
}

function withMcpDefaultTitle(args: unknown, title: string): Record<string, unknown> & { title: string } {
  if (args === undefined) {
    return { title };
  }
  return withDefaultTitle(args as Record<string, unknown>, title);
}

export function createFigmaReplMcpServer(
  options: FigmaReplMcpServerOptions = {},
): {
  server: Server;
  client: FigmaMcpProxyClient;
  sessions: FigmaReplSessionStore;
} {
  const runtime = createFigmaReplRuntime(options);
  const { client, sessions, upstreamToolCache } = runtime;

  const server = new Server(
    {
      name: options.name ?? "figma_repl_mcp",
      version: options.version ?? "0.1.0",
    },
    {
      capabilities: {
        tools: {},
        resources: {},
      },
      instructions: [
        "Stateful REPL-style MCP proxy for the official Figma MCP server.",
        "Use figma_repl_prepare_task and figma_repl_run_script_file for repairable .figma.js workflows, figma_repl_eval for small batched Plugin API JavaScript, and figma-repl://sessions resources to inspect local state.",
        "The proxy stores only local session metadata and node-id handles; Figma execution still happens through the upstream use_figma tool.",
      ].join(" "),
    },
  );

  server.setRequestHandler(ListToolsRequestSchema, async (_request: ListToolsRequest) => ({
    tools: createReplToolDescriptions({
      taskWorkspaceRootEnv: TASK_WORKSPACE_ROOT_ENV,
      defaultDocsSearchMaxResults: DEFAULT_DOCS_SEARCH_MAX_RESULTS,
      maxDocsSearchResults: MAX_DOCS_SEARCH_RESULTS,
      defaultDocsSearchSnippetLines: DEFAULT_DOCS_SEARCH_SNIPPET_LINES,
      maxDocsSearchSnippetLines: MAX_DOCS_SEARCH_SNIPPET_LINES,
      maxLookupQueryLength: MAX_LOOKUP_QUERY_LENGTH,
    }),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request: CallToolRequest) => {
    const rawArgs = request.params.arguments;
    switch (request.params.name) {
      case "figma_repl_open":
        return handleOpen(
          asOpenArgs(withMcpDefaultTitle(rawArgs, "Open Figma REPL session")),
          { sessions, upstreamToolCache },
        );
      case "figma_repl_eval":
        return handleEval(
          asEvalArgs(withMcpDefaultTitle(rawArgs, "Run Figma REPL JavaScript")),
          { client, sessions, upstreamToolCache },
        );
      case "figma_repl_run_script_file":
        return handleRunScriptFile(asRunScriptFileArgs(withMcpDefaultTitle(rawArgs, "Run Figma JavaScript file")), {
          client,
          sessions,
          upstreamToolCache,
        });
      case "figma_repl_apply_asset_manifest":
        return handleApplyAssetManifest(asApplyAssetManifestArgs(withMcpDefaultTitle(rawArgs, "Apply Figma asset manifest")), {
          client,
          sessions,
          upstreamToolCache,
        });
      case "figma_repl_download_assets":
        return handleDownloadAssets(asDownloadAssetsArgs(withMcpDefaultTitle(rawArgs, "Download Figma assets")), {
          client,
          sessions,
          upstreamToolCache,
        });
      case "figma_repl_capture_node":
        return handleCaptureNode(asCaptureNodeArgs(withMcpDefaultTitle(rawArgs, "Capture Figma node")), {
          client,
          sessions,
          upstreamToolCache,
        });
      case "figma_repl_run_task_plan":
        return handleRunTaskPlan(asRunTaskPlanArgs(withMcpDefaultTitle(rawArgs, "Run Figma REPL task plan")), {
          client,
          sessions,
          upstreamToolCache,
        });
      case "figma_repl_prepare_task":
        return handlePrepareTask(
          asPrepareTaskArgs(withMcpDefaultTitle(rawArgs, "Prepare Figma REPL task")),
          { sessions },
        );
      case "figma_repl_guidance":
        return handleGuidance(asGuidanceArgs(withMcpDefaultTitle(rawArgs, "Read Figma REPL guidance")));
      case "figma_repl_inspect":
        return handleInspect(
          asInspectArgs(withMcpDefaultTitle(rawArgs, "Inspect Figma REPL target")),
          { client, sessions, upstreamToolCache },
        );
      case "figma_repl_call_upstream_tool":
        return handleCallUpstreamTool(asCallUpstreamToolArgs(withMcpDefaultTitle(rawArgs, "Call upstream Figma MCP tool")), {
          client,
          sessions,
          upstreamToolCache,
        });
      case "figma_repl_lookup":
        return handleLookup(asLookupArgs(withMcpDefaultTitle(rawArgs, "Look up Figma REPL reference")));
      default:
        throw new Error(`Unknown figma_repl_mcp tool: ${request.params.name}`);
    }
  });

  server.setRequestHandler(
    ListResourcesRequestSchema,
    async (_request: ListResourcesRequest) => ({
      resources: [
        {
          uri: "figma-repl://capabilities",
          name: "Figma REPL aggregate capabilities",
          description: "Read first to choose the Figma REPL facade path, available tools, workflow resources, and lookup strategy.",
          mimeType: "application/json",
        },
        {
          uri: "figma-repl://guide",
          name: "Figma REPL agent guide",
          description: "Read when you need the compact agent-facing guide for preferred flow, delegation boundaries, and examples.",
          mimeType: "application/json",
        },
        {
          uri: "figma-repl://patterns",
          name: "Figma REPL usage patterns",
          description: "Read when you need practical usage patterns for common Figma REPL tasks before choosing tools.",
          mimeType: "application/json",
        },
        {
          uri: "figma-repl://scripts",
          name: "Figma REPL script file workflow",
          description: "Read when you need the small-script figma_repl_eval versus file-based figma_repl_run_script_file workflow details.",
          mimeType: "application/json",
        },
        {
          uri: "figma-repl://file-workflow",
          name: "Figma REPL .figma.js file workflow",
          description: "Read when you need to create or repair local .figma.js workspace files with figma_repl_prepare_task and figma_repl_run_script_file.",
          mimeType: "application/json",
        },
        {
          uri: "figma-repl://workflow-tools",
          name: "Figma REPL workflow tools for plans, assets, and captures",
          description: "Read when you need supporting workflow tools for asset manifests, captures, and task plans.",
          mimeType: "application/json",
        },
        {
          uri: "figma-repl://api-cards",
          name: "Figma REPL compact API cards",
          description: "Read when you need compact Plugin API cards before asking figma_repl_guidance or figma_repl_lookup for specifics.",
          mimeType: "application/json",
        },
        {
          uri: "figma-repl://intents",
          name: "Figma REPL intent to API guidance",
          description: "Read when you need to map a user intent to recommended guidance cards, query hints, and API symbols.",
          mimeType: "application/json",
        },
        {
          uri: "figma-repl://safety",
          name: "Figma REPL safety and diagnostics",
          description: "Read when you need safety, diagnostics, payload, or surface guardrails for Figma REPL execution.",
          mimeType: "application/json",
        },
        {
          uri: "figma-repl://docs",
          name: "Figma REPL compact documentation lookup guide",
          description: "Read when you need the compact documentation lookup route for internal corpus snippets via figma_repl_lookup.",
          mimeType: "application/json",
        },
        {
          uri: "figma-repl://api",
          name: "Figma REPL Plugin API lookup guide",
          description: "Read when you need the Plugin API lookup route for exact symbols via figma_repl_lookup.",
          mimeType: "application/json",
        },
        {
          uri: "figma-repl://upstream-tools",
          name: "Figma upstream MCP tools",
          description: "Read only when you need the compact directory of explicit uncovered official upstream Figma MCP capabilities.",
          mimeType: "application/json",
        },
        {
          uri: "figma-repl://sessions",
          name: "Figma REPL sessions",
          description: "Read when you need the list of active REPL sessions and their ids before reading a specific session.",
          mimeType: "application/json",
        },
        ...sessions.list().map((session) => ({
          uri: `figma-repl://sessions/${encodeURIComponent(session.id)}`,
          name: `Figma REPL session ${session.id}`,
          description: "Read when you need public state for this specific active REPL session.",
          mimeType: "application/json",
        })),
      ],
    }),
  );

  server.setRequestHandler(
    ListResourceTemplatesRequestSchema,
    async (_request: ListResourceTemplatesRequest) => ({
      resourceTemplates: [
        {
          uriTemplate: "figma-repl://sessions/{id}",
          name: "Figma REPL session by id",
          description: "Read when you need full public state for a known REPL session id, including remembered handles, workspace files, file context, and recent call history.",
          mimeType: "application/json",
        },
        {
          uriTemplate: "figma-repl://upstream-tools/{name}",
          name: "Figma upstream MCP tool by name",
          description: "Read only after figma-repl://upstream-tools when you need the full upstream tool description and inputSchema for one official tool.",
          mimeType: "application/json",
        },
      ],
    }),
  );

  server.setRequestHandler(
    ReadResourceRequestSchema,
    async (request: ReadResourceRequest) => readReplResource(request.params.uri, {
      sessions,
      upstreamToolCache,
    }),
  );

  return { server, client, sessions };
}

async function handleOpen(
  args: Record<string, unknown>,
  runtime: {
    sessions: FigmaReplSessionStore;
    upstreamToolCache: ReturnType<typeof createUpstreamToolCache>;
  },
): Promise<Record<string, unknown>> {
  assertRequiredTitleArgument(args);
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
  const openDiagnostics = diagnoseFigmaReplContext({
    expectedSurface,
    derivedSurface,
    fileUrl: session.fileUrl,
  });
  session.lastDiagnostics = openDiagnostics;
  if (isStringRecord(args.handles)) {
    mergeHandles(session, args.handles);
  }
  bindOpenWorkspaceIfAvailable(session, args);
  touchSession(session);

  let upstreamTools: UpstreamToolInfo[] | undefined;
  if (args.connect !== false) {
    upstreamTools = await runtime.upstreamToolCache.list(Boolean(args.refresh));
    await resolveEvalSettings(session, args as Record<string, unknown>, runtime);
  }
  return makeJsonToolResult({
    ok: true,
    session: responseSession(session),
    diagnostics: diagnosticsForResponse(session.lastDiagnostics),
    upstreamTools: upstreamTools?.map((tool) => tool.name),
  });
}

async function handleEval(
  args: FigmaReplEvalArguments,
  runtime: {
    client: FigmaMcpProxyClient;
    sessions: FigmaReplSessionStore;
    upstreamToolCache: ReturnType<typeof createUpstreamToolCache>;
  },
): Promise<Record<string, unknown>> {
  if (!args.code || typeof args.code !== "string") {
    throw new Error('Tool argument "code" is required and must be a string.');
  }
  assertRequiredTitleArgument(args);
  const session = runtime.sessions.getOrCreate(args.sessionId);
  if (isStringRecord(args.handleUpdates)) {
    mergeHandles(session, args.handleUpdates);
  }
  const mode = args.mode ?? "write";
  const diagnostics = diagnoseFigmaReplCode(args.code, {
    allowDangerousOperations: Boolean(args.allowDangerousOperations),
    mode,
    expectedSurface: normalizeSurface(args.surface) ?? session.surface,
  });
  session.lastDiagnostics = diagnostics;
  throwIfFatalDiagnostics(diagnostics);

  const evalSettings = await resolveEvalSettings(session, args as Record<string, unknown>, runtime);
  const script = buildFigmaEvalScript({
    session,
    code: args.code,
    mode,
  });
  const upstream = await callUpstreamEval(runtime.client, evalSettings, script);
  const parsed = parseUpstreamToolResult(upstream);
  updateSessionFromParsedResult(session, parsed.json);
  runtime.sessions.rememberHistory(session, {
    id: randomUUID(),
    at: new Date().toISOString(),
    tool: "figma_repl_eval",
    title: args.title,
    mode,
    summary: summarizeParsedResult(parsed),
    nodeIds: collectNodeIds(parsed.json),
  });
  const resultPayload = {
    ok: !parsed.upstreamError,
    session: responseSession(session),
    ...responseEvalSettingsFields(evalSettings),
    diagnostics: diagnosticsForResponse(diagnostics),
    ...upstreamResultFields({
      parsed,
      upstream,
    }),
    ...upstreamFailureFields(parsed),
  };
  const inlineResultLimit = normalizeInlineResultLimit(args.inlineResultLimit ?? DEFAULT_INLINE_RESULT_LIMIT);
  const limitedPayload = limitInlineScriptResult(resultPayload, inlineResultLimit, ["upstream.payload", "upstream.text"]);
  const needsOutputFile = args.outputFile !== undefined || isRecord(limitedPayload.inlineResultLimit);
  if (!needsOutputFile) {
    return makeJsonToolResult(limitedPayload);
  }
  const outputFiles = await writeEvalResultFiles({
    args,
    session,
    resultPayload,
    upstream: upstreamEnvelope(parsed),
  });
  return makeJsonToolResult({
    ...limitedPayload,
    outputFiles,
  });
}

async function handleRunScriptFile(
  args: FigmaReplRunScriptFileArguments,
  runtime: FigmaReplRuntime,
): Promise<Record<string, unknown>> {
  return makeJsonToolResult(await executeRunScriptFile(args, runtime));
}

async function writeEvalResultFiles(options: {
  args: FigmaReplEvalArguments;
  session: FigmaReplSession;
  resultPayload: Record<string, unknown>;
  upstream: Record<string, unknown>;
}): Promise<FigmaReplOutputFiles> {
  const outputFile = resolveEvalOutputFile(options.args, options.session);
  const outputFiles: FigmaReplOutputFiles = {
    outputFile: responseFilePointer(await writeJsonFile(outputFile, options.resultPayload)),
  };
  outputFiles.upstreamFile = responseFilePointer(await writeJsonFile(upstreamFilePathForResultFile(outputFile), options.upstream));
  return outputFiles;
}

function resolveEvalOutputFile(args: FigmaReplEvalArguments, session: FigmaReplSession): string {
  const explicit = asOptionalString(args.outputFile);
  if (explicit) {
    const resolved = resolveWorkspaceAwareFile(explicit, session, "outputFile");
    if (!resolved) {
      throw new Error('Tool argument "outputFile" is required when provided.');
    }
    return resolved;
  }
  const fileName = `eval-${new Date().toISOString().replace(/[^\dTZ]/gu, "")}.result.json`;
  if (session.workspace) {
    return resolveWorkspaceFile(session.workspace.sessionDir, fileName, "outputFile");
  }
  const root = process.env[TASK_WORKSPACE_ROOT_ENV] ?? resolve(tmpdir(), "figma-repl-mcp", "tasks");
  if (!isAbsolute(root)) {
    throw new Error(`Tool argument "taskRoot" and ${TASK_WORKSPACE_ROOT_ENV} must be absolute paths when provided.`);
  }
  return resolve(root, "eval-results", session.slug, fileName);
}

async function writeCallUpstreamResultFiles(options: {
  args: FigmaReplCallUpstreamToolArguments;
  session: FigmaReplSession;
  resultPayload: Record<string, unknown>;
  upstream: Record<string, unknown>;
}): Promise<FigmaReplOutputFiles> {
  const outputFile = resolveCallUpstreamOutputFile(options.args, options.session);
  const outputFiles: FigmaReplOutputFiles = {
    outputFile: responseFilePointer(await writeJsonFile(outputFile, options.resultPayload)),
  };
  outputFiles.upstreamFile = responseFilePointer(await writeJsonFile(upstreamFilePathForResultFile(outputFile), options.upstream));
  return outputFiles;
}

function resolveCallUpstreamOutputFile(args: FigmaReplCallUpstreamToolArguments, session: FigmaReplSession): string {
  const explicit = asOptionalString(args.outputFile);
  if (explicit) {
    const resolved = resolveWorkspaceAwareFile(explicit, session, "outputFile");
    if (!resolved) {
      throw new Error('Tool argument "outputFile" is required when provided.');
    }
    return resolved;
  }
  const timestamp = new Date().toISOString().replace(/[^\dTZ]/gu, "");
  const fileName = `upstream-${slugifyTaskName(args.toolName || "tool")}-${timestamp}.result.json`;
  if (session.workspace) {
    return resolveWorkspaceFile(session.workspace.sessionDir, fileName, "outputFile");
  }
  const root = process.env[TASK_WORKSPACE_ROOT_ENV] ?? resolve(tmpdir(), "figma-repl-mcp", "tasks");
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

function responseFilePointer(pointer: { path: string; bytes: number; lineCount: number }): FigmaReplFilePointer {
  return {
    path: pointer.path,
    bytes: pointer.bytes,
    lineCount: pointer.lineCount,
  };
}

async function executeRunScriptFile(
  args: FigmaReplRunScriptFileArguments,
  runtime: {
    client: FigmaMcpProxyClient;
    sessions: FigmaReplSessionStore;
    upstreamToolCache: ReturnType<typeof createUpstreamToolCache>;
  },
): Promise<Record<string, unknown>> {
  assertRequiredTitleArgument(args);
  const session = runtime.sessions.getOrCreate(args.sessionId);
  const scriptPath = resolveScriptInputPath(args, session);
  const source = await readFile(scriptPath, "utf8");
  const expectedSurface = normalizeSurface(args.surface) ?? session.surface;
  if (expectedSurface) {
    session.surface = expectedSurface;
  }
  if (typeof args.targetPageId === "string" && args.targetPageId.length > 0) {
    session.currentPageId = args.targetPageId;
  }

  const compiled = compileFigmaReplScriptFile({
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
  const outputWriter = createScriptOutputWriter(args, session, formatScriptRunSummaryMarkdown);
  await outputWriter.cleanupCompiledScriptFile();
  throwIfFatalDiagnostics(diagnostics);
  const inlineResultLimit = effectiveInlineResultLimit(args.inlineResultLimit, outputWriter.files, DEFAULT_INLINE_RESULT_LIMIT);
  const scriptMetadata = {
    ...compiled.metadata,
    diagnosticsCount: diagnostics.length,
    compiledScriptBytes: Buffer.byteLength(wrappedScript, "utf8"),
    dryRun: Boolean(args.dryRun),
    executed: !args.dryRun,
  };
  const responseScript = responseScriptMetadata(scriptMetadata);

  if (args.dryRun) {
    touchSession(session);
    const resultPayload = {
      ok: true,
      dryRun: true,
      session: responseSession(session),
      diagnostics: diagnosticsForResponse(diagnostics),
      script: responseScript,
    };
    const outputFiles = await outputWriter.write({
      result: resultPayload,
      diagnostics,
      summary: createScriptRunSummary({
        ok: true,
        dryRun: true,
        session,
        script: scriptMetadata,
        diagnostics,
      }),
    });
    return {
      ...limitInlineScriptResult(resultPayload, inlineResultLimit, []),
      outputFiles,
    };
  }

  const evalSettings = await resolveEvalSettings(session, args as Record<string, unknown>, runtime);
  let upstream: unknown;
  let parsed: ParsedUpstreamToolResult;
  try {
    upstream = await callUpstreamEval(runtime.client, evalSettings, wrappedScript);
    parsed = parseUpstreamToolResult(upstream);
  } catch (error) {
    const upstreamError = normalizeCaughtUpstreamError(error);
    const resultPayload = {
      ok: false,
      dryRun: false,
      session: responseSession(session),
      ...responseEvalSettingsFields(evalSettings),
      diagnostics: diagnosticsForResponse(diagnostics),
      script: responseScript,
      upstreamError: responseUpstreamError(upstreamError),
      primaryFix: primaryFixForUpstreamError(upstreamError),
    };
    const outputFiles = await outputWriter.write({
      result: resultPayload,
      diagnostics,
      compiledScript: wrappedScript,
      summary: createScriptRunSummary({
        ok: false,
        dryRun: false,
        session,
        script: scriptMetadata,
        diagnostics,
        upstreamTool: evalSettings.toolName,
        upstreamArgument: evalSettings.argumentName,
        upstreamError,
        primaryFix: resultPayload.primaryFix,
      }),
    });
    return {
      ...limitInlineScriptResult(
        {
          ...resultPayload,
          outputFiles,
        },
        inlineResultLimit,
        [],
      ),
    };
  }
  if (parsed.upstreamError) {
    const resultPayload = {
      ok: false,
      dryRun: false,
      session: responseSession(session),
      ...responseEvalSettingsFields(evalSettings),
      diagnostics: diagnosticsForResponse(diagnostics),
      script: responseScript,
      ...runScriptUpstreamFields(parsed),
      ...runScriptUpstreamFailureFields(parsed),
    };
    const outputFiles = await addUpstreamSidecar(
      await outputWriter.write({
        result: resultPayload,
        diagnostics,
        compiledScript: wrappedScript,
        summary: createScriptRunSummary({
          ok: false,
          dryRun: false,
          session,
          script: scriptMetadata,
          diagnostics,
          upstreamTool: evalSettings.toolName,
          upstreamArgument: evalSettings.argumentName,
          parsed,
          upstreamError: parsed.upstreamError,
          primaryFix: parsed.primaryFix,
        }),
      }),
      outputWriter.files.resultFile,
      upstreamEnvelope(parsed),
    );
    return {
      ...limitInlineScriptResult(
        {
          ...resultPayload,
          outputFiles,
        },
        inlineResultLimit,
        ["upstream.payload", "upstream.text"],
      ),
    };
  }
  updateSessionFromParsedResult(session, parsed.json);
  runtime.sessions.rememberHistory(session, {
    id: randomUUID(),
    at: new Date().toISOString(),
    tool: "figma_repl_run_script_file",
    title: args.title,
    mode: "write",
    summary: `Ran Figma script file ${scriptPath}.`,
    nodeIds: collectNodeIds(parsed.json),
  });

  const resultPayload = {
    ok: true,
    dryRun: false,
    session: responseSession(session),
    ...responseEvalSettingsFields(evalSettings),
    diagnostics: diagnosticsForResponse(diagnostics),
    script: responseScript,
    ...runScriptUpstreamFields(parsed),
  };
  const outputFiles = await addUpstreamSidecar(
    await outputWriter.write({
      result: resultPayload,
      diagnostics,
      summary: createScriptRunSummary({
        ok: true,
        dryRun: false,
        session,
        script: scriptMetadata,
        diagnostics,
        upstreamTool: evalSettings.toolName,
        upstreamArgument: evalSettings.argumentName,
        parsed,
      }),
    }),
    outputWriter.files.resultFile,
    upstreamEnvelope(parsed),
  );
  return {
    ...limitInlineScriptResult(
      {
        ...resultPayload,
        outputFiles,
      },
      inlineResultLimit,
      ["upstream.payload", "upstream.text"],
    ),
  };
}

async function handleApplyAssetManifest(
  args: FigmaReplApplyAssetManifestArguments,
  runtime: FigmaReplRuntime,
): Promise<Record<string, unknown>> {
  return makeJsonToolResult(await executeApplyAssetManifest(args, runtime));
}

async function executeApplyAssetManifest(
  args: FigmaReplApplyAssetManifestArguments,
  runtime: FigmaReplRuntime,
): Promise<Record<string, unknown>> {
  assertRequiredTitleArgument(args);
  const session = runtime.sessions.getOrCreate(args.sessionId);
  const manifest = await loadAssetManifest(args, session);
  const tools = await runtime.upstreamToolCache.list(false);
  const tool = selectRequiredUpstreamTool(tools, UPLOAD_ASSETS_TOOL_NAME, "asset upload/fill");
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
      const entry = {
        ok,
        path: asset.path,
        targetNodeId: asset.targetNodeId,
        handle: asset.handle,
        name: asset.name,
        toolName: tool.name,
        upload: compactUploadSummary(upload),
        error: upstreamError,
        upstreamSummary: parsed.upstreamError ? parsed.upstreamError.message : summarizeParsedResult(parsed),
      };
      const detail = {
        ...entry,
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
          toolName: tool.name,
          error: upstreamError,
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
        toolName: tool.name,
        error: responseError,
        upstreamSummary: upstreamError.message,
      };
      const detail = {
        ...entry,
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
        toolName: tool.name,
        error: responseError,
      });
    }
  }

  const resultFile = resolveWorkspaceAwareFile(args.outputFile, session, "outputFile");
  const files: Record<string, unknown> = {};
  const validation = await validateAssetManifestTargetsIfAvailable({
    args,
    session,
    runtime,
    tools,
    assetResults,
  });
  const ok = failures.length === 0 && validation.ok !== false;
  for (const detail of assetDetails) {
    const targetNodeId = asOptionalString(detail.targetNodeId);
    const asset = assetResults.find((item) => item.targetNodeId === targetNodeId);
    if (asset?.validation !== undefined) {
      detail.validation = asset.validation;
    }
  }
  const payload = {
    ok,
    session: responseSession(session),
    assets: assetResults,
    validation,
    failures: failures.length > 0 ? failures : undefined,
  };
  if (resultFile) {
    files.outputFile = await writeJsonFile(resultFile, {
      ...payload,
      assetDetails,
    });
  }
  runtime.sessions.rememberHistory(session, {
    id: randomUUID(),
    at: new Date().toISOString(),
    tool: "figma_repl_apply_asset_manifest",
    title: args.title,
    mode: "upstream-assets",
    summary: `Applied ${assetResults.length} asset manifest entries with ${failures.length} failures.`,
    nodeIds: assetResults
      .map((asset) => asOptionalString(asset.targetNodeId))
      .filter((nodeId): nodeId is string => nodeId !== undefined),
  });
  return {
    ...payload,
    outputFiles: Object.keys(files).length > 0 ? files : undefined,
  };
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
  }) as Record<string, unknown>;
}

async function handleDownloadAssets(
  args: FigmaReplDownloadAssetsArguments,
  runtime: FigmaReplRuntime,
): Promise<Record<string, unknown>> {
  return makeJsonToolResult(await executeDownloadAssets(args, runtime));
}

async function executeDownloadAssets(
  args: FigmaReplDownloadAssetsArguments,
  runtime: FigmaReplRuntime,
): Promise<Record<string, unknown>> {
  assertRequiredTitleArgument(args);
  const session = runtime.sessions.getOrCreate(args.sessionId);
  const manifest = await loadDownloadAssetsManifest(args, session);
  const paths = resolveDownloadAssetsOutputPaths(args, session);
  const tools = await runtime.upstreamToolCache.list(false);
  const tool = tools.find((item) => item.name === DOWNLOAD_ASSETS_TOOL_NAME);
  if (!tool) {
    throw new Error(
      `Upstream Figma MCP tool "${DOWNLOAD_ASSETS_TOOL_NAME}" was not found. Available tools: ${tools.map((item) => item.name).join(", ")}`,
    );
  }
  const targetResults: Array<Record<string, unknown>> = [];
  const targetDetails: Array<Record<string, unknown>> = [];
  const failures: Array<Record<string, unknown>> = [];
  const usedSlugs = new Set<string>();
  await runtime.client.connect();

  for (const [index, target] of manifest.targets.entries()) {
    const startedAt = new Date().toISOString();
    const targetSlug = uniqueDownloadTargetSlug(target, index, usedSlugs);
    const targetOutputDir = resolve(paths.outputDir, targetSlug);
    const upstreamArguments = buildDownloadAssetsUpstreamArguments(target);
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
      const entry = removeUndefined({
        ok,
        targetNodeId: target.targetNodeId,
        handle: target.handle,
        name: target.name,
        outputDir: targetOutputDir,
        downloadedFiles: compactDownloadedFiles(downloadedFiles),
        upstreamSummary: parsed.upstreamError ? parsed.upstreamError.message : summarizeParsedResult(parsed),
        error: upstreamError,
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
          error: upstreamError ?? downloadFailures[0]?.error ?? {
            message: links.length === 0 ? "Upstream download_assets returned no downloadable URLs." : "One or more asset downloads failed.",
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
        upstreamSummary: upstreamError.message,
        error: responseError,
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
        error: responseError,
      }) as Record<string, unknown>);
    }
  }

  const ok = failures.length === 0;
  const payload = removeUndefined({
    ok,
    session: responseSession(session),
    outputDir: paths.outputDir,
    targets: targetResults,
    failures: failures.length > 0 ? failures : undefined,
  }) as Record<string, unknown>;
  const outputFiles: FigmaReplOutputFiles = {
    outputFile: responseFilePointer(await writeJsonFile(paths.outputFile, {
      ...payload,
      toolName: tool.name,
      targetDetails,
    })),
  };
  runtime.sessions.rememberHistory(session, {
    id: randomUUID(),
    at: new Date().toISOString(),
    tool: "figma_repl_download_assets",
    title: args.title,
    mode: "download-assets",
    summary: `Downloaded assets for ${targetResults.length} target(s) with ${failures.length} failures.`,
    nodeIds: manifest.targets.map((target) => target.targetNodeId),
  });
  return {
    ...payload,
    outputFiles,
  };
}

async function loadDownloadAssetsManifest(
  args: FigmaReplDownloadAssetsArguments,
  session: FigmaReplSession,
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
  value: FigmaReplDownloadAssetsTarget | unknown,
  index: number,
  session: FigmaReplSession,
): NormalizedDownloadAssetsTarget {
  const record = asRecord(value);
  const targetResolution = resolveSessionTargetInput(record.target, session);
  const targetNodeId = targetResolution.nodeId;
  if (!targetNodeId) {
    throw new Error(`Download target ${index} requires target.`);
  }
  const fileKey = session.fileKey ?? extractFigmaFileKey(session.fileUrl) ?? extractFigmaFileKeyFromTargetInput(record.target);
  if (!fileKey) {
    throw new Error(`Download target ${index} requires a session fileKey. Call figma_repl_open or figma_repl_prepare_task with a Figma file URL first.`);
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
  args: FigmaReplDownloadAssetsArguments,
  session: FigmaReplSession,
): { outputDir: string; outputFile: string } {
  const slug = slugifyTaskName(args.title || "download-assets");
  const explicitOutputDir = resolveWorkspaceAwareFile(args.outputDir, session, "outputDir");
  const explicitOutputFile = resolveWorkspaceAwareFile(args.outputFile, session, "outputFile");
  let outputDir = explicitOutputDir;
  let outputFile = explicitOutputFile;
  if (!outputDir) {
    outputDir = session.workspace
      ? resolveWorkspaceFile(session.workspace.sessionDir, `${slug}.downloads`, "outputDir")
      : resolveDownloadAssetsTempPath(session, `${slug}.downloads`);
  }
  if (!outputFile) {
    outputFile = session.workspace
      ? resolveWorkspaceFile(session.workspace.sessionDir, `${slug}.downloads.result.json`, "outputFile")
      : resolveDownloadAssetsTempPath(session, `${slug}.downloads.result.json`);
  }
  return { outputDir, outputFile };
}

function resolveDownloadAssetsTempPath(session: FigmaReplSession, fileName: string): string {
  const root = process.env[TASK_WORKSPACE_ROOT_ENV] ?? resolve(tmpdir(), "figma-repl-mcp", "tasks");
  if (!isAbsolute(root)) {
    throw new Error(`Tool argument "taskRoot" and ${TASK_WORKSPACE_ROOT_ENV} must be absolute paths when provided.`);
  }
  return resolve(root, "download-results", session.slug, fileName);
}

function buildDownloadAssetsUpstreamArguments(target: NormalizedDownloadAssetsTarget): Record<string, unknown> {
  return removeUndefined({
    fileKey: target.fileKey,
    nodeId: target.targetNodeId,
    defaultFormat: target.defaultFormat,
    defaultScale: target.defaultScale,
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
  args: FigmaReplCaptureNodeArguments,
  runtime: FigmaReplRuntime,
): Promise<Record<string, unknown>> {
  const result = await executeCaptureNodeForTool(args, runtime);
  return makeJsonToolResult(result.payload, result.previewContent ? [result.previewContent] : undefined);
}

async function executeCaptureNode(
  args: FigmaReplCaptureNodeArguments,
  runtime: FigmaReplRuntime,
): Promise<Record<string, unknown>> {
  return (await executeCaptureNodeForTool(args, runtime)).payload;
}

async function executeCaptureNodeForTool(
  args: FigmaReplCaptureNodeArguments,
  runtime: FigmaReplRuntime,
): Promise<{ payload: Record<string, unknown>; previewContent?: FigmaReplImageContent }> {
  assertRequiredTitleArgument(args);
  const session = runtime.sessions.getOrCreate(args.sessionId);
  const targetResolution = resolveSessionTargetInput(args.target, session);
  const nodeId = targetResolution.nodeId;
  if (!nodeId) {
    throw new Error('Tool argument "target" is required.');
  }
  const requestedOutputFile = resolveCaptureOutputFile(args, session);
  const plannedImageOutputFile = captureImageOutputFilePath(requestedOutputFile);
  const metadataFile = resolveWorkspaceAwareFile(args.metadataFile, session, "metadataFile");
  const tools = await runtime.upstreamToolCache.list(false);
  const tool = selectRequiredUpstreamTool(tools, SCREENSHOT_TOOL_NAME, "node screenshot");
  const upstreamArguments = buildCaptureUpstreamArguments({
    nodeId,
    tool,
  });
  await runtime.client.connect();
  const upstream = await runtime.client.callTool(tool.name, upstreamArguments);
  const parsed = parseUpstreamToolResult(upstream);
  if (parsed.upstreamError) {
    const outputFiles: Record<string, unknown> = {};
    const payload = {
      ok: false,
      session: responseSession(session),
      plannedOutputFile: plannedImageOutputFile,
      nodeId,
      handle: targetResolution.handle,
      toolName: tool.name,
      upstream: upstreamEnvelope(parsed, { includePayload: false }),
      ...upstreamFailureFields(parsed),
    };
    if (metadataFile) {
      outputFiles.metadataFile = await writeJsonFile(metadataFile, {
        ...payload,
        upstream: upstreamEnvelope(parsed),
      });
    }
    return {
      payload: {
        ...payload,
        outputFiles: Object.keys(outputFiles).length > 0 ? outputFiles : undefined,
      },
    };
  }
  const saved = await writeCaptureOutputFile(requestedOutputFile, upstream, parsed);
  const outputFileMetadata = {
    path: saved.path,
    bytes: saved.bytes,
    lineCount: saved.lineCount,
  };
  const outputFiles: Record<string, unknown> = {
    outputFile: outputFileMetadata,
  };
  runtime.sessions.rememberHistory(session, {
    id: randomUUID(),
    at: new Date().toISOString(),
    tool: "figma_repl_capture_node",
    title: args.title,
    mode: "capture",
    summary: `Captured node ${nodeId} to ${saved.path}.`,
    nodeIds: [nodeId],
  });
  const preview = await maybeCreateCapturePreview(saved, args.preview === true);
  const payload = {
    ok: true,
    session: responseSession(session),
    outputFile: saved.path,
    nodeId,
    handle: targetResolution.handle,
    toolName: tool.name,
    kind: saved.kind,
    mimeType: saved.mimeType,
    bytes: saved.bytes,
    lineCount: saved.lineCount,
    width: saved.width,
    height: saved.height,
    sourceUrl: saved.sourceUrl,
    qa: createCaptureQa(saved),
    preview: preview.metadata,
    upstream: upstreamEnvelope(parsed, { includePayload: false }),
  };
  if (metadataFile) {
    outputFiles.metadataFile = await writeJsonFile(metadataFile, {
      ...payload,
      upstream: upstreamEnvelope(parsed),
    });
  }
  return {
    payload: {
      ...payload,
      outputFiles,
    },
    previewContent: preview.content,
  };
}

function resolveCaptureOutputFile(args: FigmaReplCaptureNodeArguments, session: FigmaReplSession): string {
  const explicit = resolveWorkspaceAwareFile(args.outputFile, session, "outputFile");
  if (explicit) {
    return explicit;
  }
  const fileName = `capture-${new Date().toISOString().replace(/[^\dTZ]/gu, "")}`;
  if (session.workspace) {
    return resolveWorkspaceFile(session.workspace.sessionDir, fileName, "outputFile");
  }
  const root = process.env[TASK_WORKSPACE_ROOT_ENV] ?? resolve(tmpdir(), "figma-repl-mcp", "tasks");
  if (!isAbsolute(root)) {
    throw new Error(`Tool argument "taskRoot" and ${TASK_WORKSPACE_ROOT_ENV} must be absolute paths when provided.`);
  }
  return resolve(root, "capture-results", session.slug, fileName);
}

async function maybeCreateCapturePreview(
  saved: { path: string; kind: "image" | "text"; mimeType: string },
  enabled: boolean,
): Promise<{ metadata?: FigmaReplCapturePreviewResult; content?: FigmaReplImageContent }> {
  if (!enabled) {
    return {};
  }
  if (saved.kind !== "image") {
    return {
      metadata: {
        enabled: true,
        omittedReason: "not-image",
      },
    };
  }
  try {
    const preview = await createCapturePreviewImage(saved.path);
    return {
      metadata: {
        enabled: true,
        kind: "mcp-image",
        mimeType: preview.mimeType,
        width: preview.width,
        height: preview.height,
        bytes: preview.bytes,
        source: "outputFile",
      },
      content: {
        type: "image",
        data: preview.data.toString("base64"),
        mimeType: preview.mimeType,
      },
    };
  } catch (error) {
    return {
      metadata: {
        enabled: true,
        omittedReason: "generation-failed",
        error: error instanceof Error ? error.message : String(error),
      },
    };
  }
}

async function handleRunTaskPlan(
  args: FigmaReplRunTaskPlanArguments,
  runtime: FigmaReplRuntime,
): Promise<Record<string, unknown>> {
  return makeJsonToolResult(await executeRunTaskPlan(args, runtime));
}

async function executeRunTaskPlan(
  args: FigmaReplRunTaskPlanArguments,
  runtime: FigmaReplRuntime,
): Promise<Record<string, unknown>> {
  assertRequiredTitleArgument(args);
  const session = runtime.sessions.getOrCreate(args.sessionId);
  const plan = await loadTaskPlan(args, session);
  const resultFile = resolveTaskPlanResultFile(args, plan.planPath, session);
  const stopOnFailure = args.stopOnFailure !== false;
  const steps: Array<Record<string, unknown>> = [];
  const outputReferences: Record<string, unknown> = {};
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
        title: `${args.title}: ${id}`,
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
      references.outputs[id] = asRecord(reference).outputFiles ?? {};
      references.last = reference;
      if (asRecord(reference).outputFiles !== undefined) {
        outputReferences[id] = asRecord(reference).outputFiles;
      }
      steps.push({
        id,
        index,
        type,
        status,
        ok,
        summary: summarizeTaskPlanStepResult(result),
        outputReferences: asRecord(reference).outputFiles,
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

  const failures = steps.filter((step) => step.ok === false);
  const payload = {
    ok: failures.length === 0,
    session: responseSession(session),
    stopped,
    stopOnFailure,
    steps,
    outputReferences: Object.keys(outputReferences).length > 0 ? outputReferences : undefined,
    failures: failures.length > 0 ? failures : undefined,
  };
  const outputFiles = {
    outputFile: await writeJsonFile(resultFile, payload),
  };
  runtime.sessions.rememberHistory(session, {
    id: randomUUID(),
    at: new Date().toISOString(),
    tool: "figma_repl_run_task_plan",
    title: args.title,
    mode: "task-plan",
    summary: `Ran ${steps.length}/${plan.steps.length} task-plan steps with ${failures.length} failures.`,
    nodeIds: [],
  });
  return {
    ...payload,
    outputFiles,
  };
}

async function handlePrepareTask(
  args: FigmaReplPrepareTaskArguments,
  runtime?: { sessions: FigmaReplSessionStore },
): Promise<Record<string, unknown>> {
  assertRequiredTitleArgument(args);
  const session = runtime?.sessions.getOrCreate(args.sessionId);
  const previousTask = session?.workspace ? taskChangeSnapshot(session.workspace) : undefined;
  applyWorkspaceFileContextArgs(session, args);
  const taskSlug = deriveTaskSlug(args, "figma-task");
  const fileSlug = deriveFileSlug(args, session);
  const workspace = resolvePrepareTaskWorkspace(args, taskSlug, fileSlug, session);
  if (session) {
    session.workspace = workspace;
    touchSession(session);
  }
  const scriptName = normalizeTaskScriptName(args.fileName ?? workspace.files.script, taskSlug);
  const outputFile = resultFileNameForScript(scriptName);
  const scriptPath = resolveWorkspaceFile(workspace.sessionDir, scriptName, "fileName");
  const resultFile = resolveWorkspaceFile(workspace.sessionDir, outputFile, "outputFile");

  await ensureWorkspaceDirectories(workspace);
  await writeTaskFile(scriptPath, createTaskScriptTemplate(taskSlug, args), Boolean(args.overwrite));
  const outputFilePointer = await writeTaskFile(resultFile, JSON.stringify({
    ok: null,
    status: "pending",
    sessionId: session?.id,
    fileKey: session?.fileKey ?? workspace.fileKey,
    fileContext: workspace.fileContext,
    taskSlug,
    inputFile: scriptName,
    outputFile,
  }, null, 2) + "\n", Boolean(args.overwrite));
  const outputFiles = { outputFile: outputFilePointer };
  return makeJsonToolResult({
    ok: true,
    session: session ? responseSession(session) : undefined,
    task: {
      taskSlug,
      fileContext: workspace.fileContext,
      inputFile: scriptName,
      outputFile,
      workspace: responseWorkspace(workspace),
      scriptPath,
      overwritten: Boolean(args.overwrite),
    },
    taskChange: {
      previous: previousTask,
      current: taskChangeSnapshot(workspace, scriptName, outputFile),
      changed: !previousTask || previousTask.taskSlug !== workspace.intentSlug ||
        previousTask.inputFile !== scriptName ||
        previousTask.outputFile !== outputFile ||
        previousTask.sessionDir !== workspace.sessionDir,
    },
    outputFiles,
    next: [
      "Edit the .figma.js file in this task folder.",
      "Dry-run with figma_repl_run_script_file before upstream execution.",
      "Read the paired .result.json file for diagnostics, summaries, and large results.",
    ],
  });
}

function resolvePrepareTaskWorkspace(
  args: FigmaReplPrepareTaskArguments,
  taskSlug: string,
  fileSlug: string,
  session: FigmaReplSession | undefined,
): FigmaReplSessionWorkspace {
  const parsedFile = parseFigmaFileReference(args.file);
  const fileKey = session?.fileKey ?? parsedFile.fileKey;
  if (typeof args.cwd === "string" && args.cwd.length > 0) {
    if (!isAbsolute(args.cwd)) {
      throw new Error('Tool argument "cwd" must be an absolute path.');
    }
    return createSessionWorkspace({
      cwd: args.cwd,
      dirName: args.dirName,
      fileKey,
      fileSlug,
      intentSlug: taskSlug,
    });
  }
  const hasFileContext = Boolean(args.file || args.fileSlug || args.dirName);
  const hasExplicitTaskWorkspace = Boolean(args.workspaceDir || args.taskRoot);
  if (hasFileContext && !session?.workspace && !hasExplicitTaskWorkspace) {
    return createSessionWorkspace({
      cwd: process.cwd(),
      dirName: args.dirName,
      fileKey,
      fileSlug,
      intentSlug: taskSlug,
    });
  }
  return resolvePreparedTaskWorkspace({
    args,
    taskSlug,
    fileSlug,
    session,
  });
}

function taskChangeSnapshot(
  workspace: FigmaReplSessionWorkspace,
  inputFile = workspace.files.script,
  outputFile = workspace.files.result,
): Record<string, unknown> {
  return {
    taskSlug: workspace.intentSlug,
    inputFile,
    outputFile,
    sessionDir: workspace.sessionDir,
  };
}

async function handleGuidance(args: FigmaReplGuidanceArguments): Promise<Record<string, unknown>> {
  assertRequiredTitleArgument(args);
  const intentSource = guidanceIntentSource(args);
  const cardSource = args.card ?? args.query;
  const maxCards = normalizeBoundedInteger(args.maxCards, 4, 8);
  const mode = args.mode ?? (cardSource ? "card" : intentSource ? "guidance" : "catalog");
  if (mode === "plan") {
    const planIntent = intentSource
      ? normalizeLookupRankingQuery(intentSource.value, intentSource.name)
      : "figma file task";
    return makeJsonToolResult({
      ok: true,
      mode: "plan",
      workflow: createFileWorkflowPayload(),
      steps: [
        "Prepare or reuse a task workspace with figma_repl_prepare_task.",
        "Write the transaction in a local .figma.js file using $ helpers and native Figma Plugin API calls.",
        "Call figma_repl_run_script_file with dryRun=true, strict=true, surface, inputFile, and inlineResultLimit.",
        "Repair local file/line diagnostics, then execute the same script file against upstream Figma.",
        "Inspect the paired .result.json file first when inline results are capped.",
      ],
      recommendedTools: [
        "figma_repl_prepare_task",
        "figma_repl_guidance",
        "figma_repl_run_script_file",
        "figma_repl_inspect",
      ],
      suggestedCards: chooseApiCardsForIntent(planIntent, 4).map((card) => card.id),
    });
  }
  const intent = intentSource
    ? normalizeLookupRankingQuery(intentSource.value, intentSource.name)
    : undefined;
  const cardQuery = typeof cardSource === "string"
    ? normalizeLookupQuery(cardSource, "card or query")
    : undefined;
  const cards = mode === "catalog"
    ? FIGMA_REPL_API_CARDS.slice(0, maxCards)
    : cardQuery
    ? searchApiCards(cardQuery, maxCards)
    : intent
      ? chooseApiCardsForIntent(intent, maxCards)
      : FIGMA_REPL_API_CARDS.slice(0, maxCards);
  const context = intent
    ? await searchReferenceFiles({
        query: intent,
        files: DOCS_SEARCH_ALLOWLIST,
        maxResults: DEFAULT_REFERENCE_CONTEXT_SNIPPETS,
        maxSnippetLines: 4,
        exactSymbol: false,
      })
    : { results: [] };
  const suggestions = createIntentSuggestions(intent ?? cardQuery ?? "common figma workflow", maxCards, context.results);
  return makeJsonToolResult({
    ok: true,
    mode,
    cards,
    catalogSize: FIGMA_REPL_API_CARDS.length,
    guidance: "Use this compact guidance before broader docs/API lookup; each card exposes queryHints, apiSymbols, avoid, and pitfalls for .figma.js file workflows.",
    recommendedCards: cards.map((card) => card.id),
    queryHints: uniqueStrings(cards.flatMap((card) => card.queryHints), 12),
    apiSymbols: uniqueStrings(cards.flatMap((card) => card.apiSymbols), 16),
    avoid: uniqueStrings(cards.flatMap((card) => card.avoid), 12),
    suggestions,
  });
}

function guidanceIntentSource(
  args: FigmaReplGuidanceArguments,
): { name: "task"; value: string } | undefined {
  if (typeof args.task === "string") {
    return { name: "task", value: args.task };
  }
  return undefined;
}

async function handleInspect(
  args: FigmaReplInspectArguments,
  runtime: {
    client: FigmaMcpProxyClient;
    sessions: FigmaReplSessionStore;
    upstreamToolCache: ReturnType<typeof createUpstreamToolCache>;
  },
): Promise<Record<string, unknown>> {
  assertRequiredTitleArgument(args);
  if (args.mode === "validate") {
    return makeJsonToolResult(await executeValidateHandles(args, runtime));
  }
  if (args.mode === "style") {
    return makeJsonToolResult(await executeInspectStyle(args, runtime));
  }
  const session = runtime.sessions.getOrCreate(asOptionalString(args.sessionId));
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
    "  summary: Array.isArray(__value) ? __value.map((node) => summarizeNode(node, __depth)) : summarizeNode(__value, __depth),",
    "  handles: __figmaRepl.handles,",
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
    tool: "figma_repl_inspect",
    title: asOptionalString(args.title),
    mode: "read",
    summary: `Inspected ${target}.`,
    nodeIds: collectNodeIds(parsed.json),
  });
  return makeJsonToolResult({
    ok: !parsed.upstreamError,
    session: responseSession(session),
    diagnostics: diagnosticsForResponse(session.lastDiagnostics),
    ...upstreamResultFields({
      parsed,
      upstream,
    }),
    ...upstreamFailureFields(parsed),
  });
}

async function executeInspectStyle(
  args: FigmaReplInspectArguments,
  runtime: {
    client: FigmaMcpProxyClient;
    sessions: FigmaReplSessionStore;
    upstreamToolCache: ReturnType<typeof createUpstreamToolCache>;
  },
): Promise<Record<string, unknown>> {
  assertRequiredTitleArgument(args);
  const session = runtime.sessions.getOrCreate(asOptionalString(args.sessionId));
  const target = asOptionalString(args.target) ?? "$selection";
  const depth = normalizePositiveInteger(args.depth, 1);
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
    "function __hex(__color) {",
    "  const __r = Math.max(0, Math.min(255, Math.round((__color.r || 0) * 255)));",
    "  const __g = Math.max(0, Math.min(255, Math.round((__color.g || 0) * 255)));",
    "  const __b = Math.max(0, Math.min(255, Math.round((__color.b || 0) * 255)));",
    "  return '#' + [__r, __g, __b].map((__v) => __v.toString(16).padStart(2, '0')).join('');",
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
    "const __colorCounts = {};",
    "const __imageNodes = [];",
    "const __textStyles = [];",
    "const __strokes = [];",
    "const __effects = [];",
    "for (const __node of __nodes) {",
    "  if ('fills' in __node && Array.isArray(__node.fills)) {",
    "    for (const __fill of __node.fills) {",
    "      const __summary = __paint(__fill);",
    "      if (__summary && __summary.color) __colorCounts[__summary.color] = (__colorCounts[__summary.color] || 0) + 1;",
    "      if (__summary && __summary.stops) {",
    "        for (const __stop of __summary.stops) __colorCounts[__stop.color] = (__colorCounts[__stop.color] || 0) + 1;",
    "      }",
    "      if (__summary && __summary.image && __imageNodes.length < 20) __imageNodes.push({ id: __node.id, name: __node.name, type: __node.type, x: __node.x, y: __node.y, width: __node.width, height: __node.height });",
    "    }",
    "  }",
    "  if (__node.type === 'TEXT' && __textStyles.length < 24) {",
    "    const __fills = Array.isArray(__node.fills) ? __node.fills.map(__paint).filter(Boolean).slice(0, 3) : [];",
    "    __textStyles.push({ id: __node.id, name: __node.name, characters: __node.characters, font: __fontName(__node), fontSize: __node.fontSize, fills: __fills });",
    "  }",
    "  if ('strokes' in __node && Array.isArray(__node.strokes) && __node.strokes.length && __strokes.length < 24) {",
    "    __strokes.push({ id: __node.id, name: __node.name, type: __node.type, strokes: __node.strokes.map(__paint).filter(Boolean).slice(0, 3), strokeWeight: __node.strokeWeight });",
    "  }",
    "  if ('effects' in __node && Array.isArray(__node.effects) && __node.effects.length && __effects.length < 16) {",
    "    __effects.push({ id: __node.id, name: __node.name, type: __node.type, effects: __node.effects.slice(0, 4).map((__effect) => ({ type: __effect.type, visible: __effect.visible !== false, radius: __effect.radius, color: __effect.color ? __hex(__effect.color) : undefined })) });",
    "  }",
    "}",
    "const __topColors = Object.entries(__colorCounts).sort((__a, __b) => __b[1] - __a[1]).slice(0, 16).map(([color, count]) => ({ color, count }));",
    "return {",
    "  target: __target,",
    "  mode: 'style',",
    "  nodeCount: __nodes.length,",
    "  summary: Array.isArray(__value) ? __value.map((node) => summarizeNode(node, __depth)) : summarizeNode(__value, __depth),",
    "  style: { topColors: __topColors, textStyles: __textStyles, imageNodes: __imageNodes, strokes: __strokes, effects: __effects, caps: { topColors: 16, textStyles: 24, imageNodes: 20, strokes: 24, effects: 16 } },",
    "  handles: __figmaRepl.handles,",
    "};",
  ].join("\n");
  const diagnostics = diagnoseFigmaReplCode(code, {
    mode: "read",
    generatedCode: true,
    expectedSurface: session.surface,
  });
  session.lastDiagnostics = diagnostics;
  throwIfFatalDiagnostics(diagnostics);
  const evalSettings = await resolveEvalSettings(session, args, runtime);
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
    tool: "figma_repl_inspect",
    title: asOptionalString(args.title),
    mode: "style",
    summary: `Inspected style tokens for ${target}.`,
    nodeIds: collectNodeIds(parsed.json),
  });
  return {
    ok: !parsed.upstreamError,
    session: responseSession(session),
    diagnostics: diagnosticsForResponse(diagnostics),
    ...upstreamResultFields({
      parsed,
      upstream,
    }),
    ...upstreamFailureFields(parsed),
  };
}

async function executeValidateHandles(
  args: FigmaReplInspectArguments,
  runtime: {
    client: FigmaMcpProxyClient;
    sessions: FigmaReplSessionStore;
    upstreamToolCache: ReturnType<typeof createUpstreamToolCache>;
  },
): Promise<Record<string, unknown>> {
  assertRequiredTitleArgument(args);
  const session = runtime.sessions.getOrCreate(asOptionalString(args.sessionId));
  const requested = Array.isArray(args.handles)
    ? args.handles.filter((item): item is string => typeof item === "string" && item.length > 0)
    : Object.keys(session.handles);
  const code = [
    `const __requestedHandles = ${literal(requested)};`,
    `const __knownHandles = ${literal(session.handles)};`,
    "const __validations = [];",
    "for (const __name of __requestedHandles) {",
    "  const __isHandle = typeof __name === 'string' && __name.startsWith('$');",
    "  if (__isHandle && !__knownHandles[__name]) {",
    "    __validations.push({ handle: __name, status: 'missing' });",
    "    continue;",
    "  }",
    "  try {",
    "    const __node = await $(__name);",
    "    __validations.push({ handle: __name, status: 'valid', id: __node.id, type: __node.type, name: __node.name });",
    "  } catch (__error) {",
    "    __validations.push({ handle: __name, status: 'stale', error: String(__error && __error.message ? __error.message : __error) });",
    "  }",
    "}",
    "return { validations: __validations, validatedNodeIds: __validations.filter((item) => item.status === 'valid').map((item) => item.id) };",
  ].join("\n");
  const diagnostics = diagnoseFigmaReplCode(code, {
    mode: "read",
    generatedCode: true,
    expectedSurface: session.surface,
  });
  session.lastDiagnostics = diagnostics;
  throwIfFatalDiagnostics(diagnostics);
  const evalSettings = await resolveEvalSettings(session, args, runtime);
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
    tool: "figma_repl_inspect",
    title: asOptionalString(args.title),
    mode: "validate",
    summary: `Validated ${requested.length} Figma REPL handle(s).`,
    nodeIds: collectNodeIds(parsed.json),
  });
  return {
    ok: !parsed.upstreamError,
    session: responseSession(session),
    diagnostics: diagnosticsForResponse(diagnostics),
    ...upstreamResultFields({
      parsed,
      upstream,
    }),
    ...upstreamFailureFields(parsed),
  };
}

async function handleCallUpstreamTool(
  args: FigmaReplCallUpstreamToolArguments,
  runtime: {
    client: FigmaMcpProxyClient;
    sessions: FigmaReplSessionStore;
    upstreamToolCache: ReturnType<typeof createUpstreamToolCache>;
  },
): Promise<Record<string, unknown>> {
  return makeJsonToolResult(await executeCallUpstreamTool(args, runtime));
}

async function executeCallUpstreamTool(
  args: FigmaReplCallUpstreamToolArguments,
  runtime: {
    client: FigmaMcpProxyClient;
    sessions: FigmaReplSessionStore;
    upstreamToolCache: ReturnType<typeof createUpstreamToolCache>;
  },
): Promise<Record<string, unknown>> {
  assertRequiredTitleArgument(args);
  if (!args.toolName || typeof args.toolName !== "string") {
    throw new Error('Tool argument "toolName" is required and must be a string.');
  }
  if (isLocalReplToolName(args.toolName)) {
    throw new Error(
      `Refusing to proxy local figma_repl_mcp tool "${args.toolName}". Call it directly instead.`,
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
    tool: "figma_repl_call_upstream_tool",
    title: args.title,
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
  const inlineResultLimit = normalizeInlineResultLimit(args.inlineResultLimit ?? DEFAULT_INLINE_RESULT_LIMIT);
  const limitedPayload = limitInlineScriptResult(resultPayload, inlineResultLimit, ["upstream.payload", "upstream.text"]);
  const needsOutputFile = args.outputFile !== undefined || isRecord(limitedPayload.inlineResultLimit);
  if (!needsOutputFile) {
    return limitedPayload;
  }
  const outputFiles = await writeCallUpstreamResultFiles({
    args,
    session,
    resultPayload,
    upstream: upstreamEnvelope(parsed),
  });
  return {
    ...limitedPayload,
    outputFiles,
  };
}

async function handleLookup(
  args: FigmaReplLookupArguments,
): Promise<Record<string, unknown>> {
  assertRequiredTitleArgument(args);
  if (args.kind === "docs") {
    const query = normalizeLookupQuery(args.query ?? args.symbol, "query");
    const matches = await searchReferenceFiles({
      query,
      files: DOCS_SEARCH_ALLOWLIST,
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
    return makeJsonToolResult({
      ok: true,
      kind: "docs",
      query,
      maxResults: matches.maxResults,
      maxSnippetLines: matches.maxSnippetLines,
      results: matches.results,
      guidance:
        "Use these capped BM25-ranked chunks as compact context. Run a narrower figma_repl_lookup query or kind=api lookup when more detail is needed.",
    });
  }
  if (args.kind !== "api") {
    throw new Error('Tool argument "kind" must be one of: docs, api.');
  }
  const symbol = normalizeLookupQuery(args.symbol ?? args.query, "symbol");
  const matches = await searchReferenceFiles({
    query: symbol,
    files: API_LOOKUP_FILES,
    maxResults: normalizeBoundedInteger(args.maxResults, 5, MAX_DOCS_SEARCH_RESULTS),
    maxSnippetLines: normalizeBoundedInteger(args.maxSnippetLines, 5, MAX_DOCS_SEARCH_SNIPPET_LINES),
    exactSymbol: true,
  });
  return makeJsonToolResult({
    ok: true,
    kind: "api",
    symbol,
    maxResults: matches.maxResults,
    maxSnippetLines: matches.maxSnippetLines,
    results: matches.results,
    guidance:
      "Results are capped BM25-ranked Plugin API chunks with opaque source ids, matchType, and confidence. Exact symbol matches are boosted. Bundled corpus files are not returned as documents.",
  });
}

async function callUpstreamEval(
  client: FigmaMcpProxyClient,
  evalSettings: EvalSettings,
  script: string,
): Promise<unknown> {
  await client.connect();
  return client.callTool(evalSettings.toolName, {
    ...evalSettings.upstreamArguments,
    [evalSettings.argumentName]: script,
  });
}

function createUpstreamToolCache(client: FigmaMcpProxyClient) {
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

async function resolveEvalSettings(
  session: FigmaReplSession,
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
      `Required official upstream Figma MCP execution tool "${toolName}" was not found. This may indicate upstream contract drift; use "figma_repl_call_upstream_tool" for explicit upstream debugging. Available tools: ${tools.map((item) => item.name).join(", ")}`,
    );
  }
  const argumentName = DEFAULT_EVAL_ARGUMENT_NAME;
  assertUpstreamToolHasProperty(tool, argumentName, "execution");
  const upstreamArguments: Record<string, unknown> = {};
  if (
    typeof upstreamArguments.fileKey !== "string" ||
    upstreamArguments.fileKey.length === 0
  ) {
    const fileKey = extractFigmaFileKey(session.fileUrl);
    if (fileKey) {
      upstreamArguments.fileKey = fileKey;
    }
  }
  if (
    typeof upstreamArguments.description !== "string" ||
    upstreamArguments.description.length === 0
  ) {
    const title = asOptionalString(args.title);
    if (title) {
      upstreamArguments.description = title;
    }
  }
  touchSession(session);
  return { toolName, argumentName, upstreamArguments };
}

/**
 * @internal Internal wrapper builder used by the Figma REPL server and tests.
 * This is not a stable MCP tool input contract; MCP callers should use figma_repl_eval or figma_repl_run_script_file.
 */
export function buildFigmaEvalScript(options: {
  session: Pick<FigmaReplSession, "id" | "handles" | "currentPageId" | "fileUrl" | "fileKey" | "surface" | "knownPages">;
  code: string;
  mode?: "read" | "write";
  includeEvalHelpers?: boolean;
  scriptInjectedHelpers?: readonly string[];
}): string {
  const includeEvalHelpers = options.includeEvalHelpers !== false;
  const evalInjectedHelpers = includeEvalHelpers
    ? resolveFigmaReplScriptHelperSelection(options.code).injectedHelpers
    : undefined;
  return `${createFigmaReplPrelude(
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
    mode: __figmaRepl.mode
  },
  result: __figmaReplResult
};`;
}

function createFigmaReplPrelude(
  session: Pick<FigmaReplSession, "id" | "handles" | "currentPageId" | "fileUrl" | "fileKey" | "surface" | "knownPages">,
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
  handles: ${literal(session.handles ?? {})}
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
  if (input.dryRun) {
    return {
      dryRun: true,
      name,
      matches: existingFrames.map((node) => summarizeNode(node, input.depth || 0)),
    };
  }
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

function createHelperNode(type) {
  switch (type) {
    case "FRAME":
      return figma.createFrame();
    case "TEXT":
      return figma.createText();
    case "RECTANGLE":
      return figma.createRectangle();
    case "ELLIPSE":
      return figma.createEllipse();
    case "LINE":
      return figma.createLine();
    case "COMPONENT":
      if (typeof figma.createComponent !== "function") {
        throw new Error("figma.createComponent is not available on this surface.");
      }
      return figma.createComponent();
    default:
      throw new Error("Unsupported createNode type: " + type);
  }
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

function applyAutoLayout(node, layout) {
  if (!layout || typeof layout !== "object") return;
  const assign = (name) => {
    if (layout[name] !== undefined) node[name] = layout[name];
  };
  assign("layoutMode");
  assign("primaryAxisSizingMode");
  assign("counterAxisSizingMode");
  assign("primaryAxisAlignItems");
  assign("counterAxisAlignItems");
  assign("itemSpacing");
  assign("paddingLeft");
  assign("paddingRight");
  assign("paddingTop");
  assign("paddingBottom");
  assign("layoutWrap");
  assign("counterAxisSpacing");
}

function queryNodes(root, criteria) {
  const limit = Number(criteria && criteria.limit ? criteria.limit : 50);
  const matches = [];
  const visit = (node) => {
    if (!node || matches.length >= limit) return;
    if (node !== root) {
      const nameMatches = !criteria.name || node.name === criteria.name || (typeof node.name === "string" && node.name.includes(criteria.name));
      const typeMatches = !criteria.type || node.type === String(criteria.type).toUpperCase();
      const visibleMatches = criteria.includeInvisible || node.visible !== false;
      if (nameMatches && typeMatches && visibleMatches) {
        matches.push(node);
      }
    }
    if ("children" in node && Array.isArray(node.children)) {
      for (const child of node.children) visit(child);
    }
  };
  visit(root);
  return matches;
}

function setNodeProperties(node, properties) {
  const allowed = new Set([
    "name",
    "visible",
    "opacity",
    "x",
    "y",
    "rotation",
    "layoutMode",
    "primaryAxisSizingMode",
    "counterAxisSizingMode",
    "primaryAxisAlignItems",
    "counterAxisAlignItems",
    "itemSpacing",
    "paddingLeft",
    "paddingRight",
    "paddingTop",
    "paddingBottom",
    "layoutWrap",
    "counterAxisSpacing",
    "fontSize",
  ]);
  for (const [key, value] of Object.entries(properties || {})) {
    if (!allowed.has(key)) {
      throw new Error("set op does not allow property: " + key);
    }
    node[key] = value;
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
    layoutMode: read("layoutMode"),
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
$.findAll = async function findAll(criteria = {}) {
  const input = typeof criteria === "string" ? { name: criteria } : (criteria || {});
  const root = input.within ? await $(input.within) : figma.currentPage;
  const matches = queryNodes(root, {
    name: input.name,
    type: input.type,
    includeInvisible: input.includeInvisible,
    limit: input.limit || 50,
  });
  if (input.as && matches[0]) remember(input.as, matches[0]);
  return matches;
};
$.find = async function find(criteria = {}) {
  const input = typeof criteria === "string" ? { name: criteria } : (criteria || {});
  const matches = await $.findAll({ ...input, limit: input.limit || 1 });
  const node = matches[0] || null;
  if (!node && input.required !== false) {
    throw new Error("No Figma node matched $.find criteria.");
  }
  if (node && input.as) remember(input.as, node);
  return node;
};
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
$.layout = async function layout(target, layoutOptions = {}) {
  const node = await $(target);
  applyAutoLayout(node, layoutOptions);
  return node;
};
$.create = async function create(options = {}) {
  const type = String(options.type || "FRAME").toUpperCase();
  const node = createHelperNode(type);
  if (options.name !== undefined) node.name = String(options.name);
  if (type === "TEXT") {
    await applyTextHelper(node, { text: options.text || "", font: options.font, style: options.style });
    if (options.appearance !== undefined) applyAppearance(node, options.appearance);
  } else if (options.size !== undefined) {
    setNodeSizeFromInput(node, options.size);
  }
  if (options.layout !== undefined) applyAutoLayout(node, options.layout);
  if (options.appearance !== undefined && type !== "TEXT") applyAppearance(node, options.appearance);
  if (options.parent) {
    const parent = await $(options.parent);
    parent.appendChild(node);
  } else {
    figma.currentPage.appendChild(node);
  }
  if (options.as) remember(options.as, node);
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
$.screenshot = async function screenshot(target, options = {}) {
  const node = await $(target);
  if (!node || typeof node.screenshot !== "function") {
    throw new Error("$.screenshot target does not support node.screenshot().");
  }
  return await node.screenshot(options);
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
    prelude = stripFigmaReplPreludeEvalHelperAssignments(prelude);
    if (scriptInjectedHelpers) {
      prelude = stripFigmaReplPreludeForScriptHelpers(prelude, new Set(scriptInjectedHelpers));
    }
  } else if (evalInjectedHelpers) {
    prelude = stripFigmaReplPreludeForEvalHelpers(prelude, new Set(evalInjectedHelpers));
  }
  return prelude;
}

function stripFigmaReplPreludeEvalHelperAssignments(source: string): string {
  return replaceDelimitedSource(
    source,
    "const __figmaReplEvalCheckpoints = [];",
    "$.checkpoints = __figmaReplEvalCheckpoints;",
    "",
    { includeEndMarker: true },
  );
}

function stripFigmaReplPreludeForEvalHelpers(source: string, injectedHelpers: Set<string>): string {
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
  const needsReadFiniteNumber = has("text") || has("create") || has("imageAsset") || needsPlacement || needsClone;
  const needsSizeInput = has("text") || has("create") || has("imageAsset") || needsReplaceGeneratedFrame;
  const needsPositionInput = has("text") || has("imageAsset") || needsReplaceGeneratedFrame || needsClone;
  const needsAppearance = has("text") || has("create");
  const needsText = has("text") || has("create");
  const needsAutoLayout = has("layout") || has("create");
  const needsQuery = has("find") || has("findAll");
  const needsResolveHandleId = has("resolveId") || needsText;

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
  if (!needsResolveHandleId) prelude = replaceDelimitedSource(prelude, "function resolveHandleId", "function createHelperNode", "");
  if (!has("create")) prelude = replaceDelimitedSource(prelude, "function createHelperNode", "function readFiniteNumber", "");
  if (!needsReadFiniteNumber) prelude = replaceDelimitedSource(prelude, "function readFiniteNumber", "function setNodeSizeFromInput", "");
  if (!needsSizeInput) prelude = replaceDelimitedSource(prelude, "function setNodeSizeFromInput", "function setNodePositionFromInput", "");
  if (!needsPositionInput) prelude = replaceDelimitedSource(prelude, "function setNodePositionFromInput", "function applyAppearance", "");
  if (!needsAppearance) prelude = replaceDelimitedSource(prelude, "function applyAppearance", "function applyConstraints", "");
  prelude = replaceDelimitedSource(prelude, "function applyConstraints", "function fontFromHelperInput", "");
  if (!needsText) {
    prelude = replaceDelimitedSource(prelude, "function fontFromHelperInput", "function applyAutoLayout", "");
  } else if (!has("create")) {
    prelude = replaceDelimitedSource(prelude, "async function applyTextHelper", "function applyAutoLayout", "");
  }
  if (!needsAutoLayout) prelude = replaceDelimitedSource(prelude, "function applyAutoLayout", "function queryNodes", "");
  if (!needsQuery) prelude = replaceDelimitedSource(prelude, "function queryNodes", "function setNodeProperties", "");
  prelude = replaceDelimitedSource(prelude, "function setNodeProperties", "function setNodeSize", "");
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
  if (!has("findAll")) prelude = replaceDelimitedSource(prelude, "$.findAll = async function findAll", "$.find = async function find", "");
  if (!has("find")) prelude = replaceDelimitedSource(prelude, "$.find = async function find", "$.text = async function text", "");
  if (!has("text")) prelude = replaceDelimitedSource(prelude, "$.text = async function text", "$.layout = async function layout", "");
  if (!has("layout")) prelude = replaceDelimitedSource(prelude, "$.layout = async function layout", "$.create = async function create", "");
  if (!has("create")) prelude = replaceDelimitedSource(prelude, "$.create = async function create", "function __figmaReplDecodeBase64", "");
  if (!has("imageAsset")) prelude = replaceDelimitedSource(prelude, "function __figmaReplDecodeBase64", "$.inspect = async function inspect", "");
  if (!has("inspect")) prelude = replaceDelimitedSource(prelude, "$.inspect = async function inspect", "$.screenshot = async function screenshot", "");
  if (!has("screenshot")) prelude = replaceDelimitedSource(prelude, "$.screenshot = async function screenshot", "$.checkpoint = async function checkpoint", "");
  if (!has("checkpoint")) {
    prelude = prelude.replace("const __figmaReplEvalCheckpoints = [];\n", "");
    prelude = replaceDelimitedSource(prelude, "$.checkpoint = async function checkpoint", "$.checkpoints = __figmaReplEvalCheckpoints;", "", { includeEndMarker: true });
  }
  return prelude;
}

function stripFigmaReplPreludeForScriptHelpers(source: string, injectedHelpers: Set<string>): string {
  let prelude = source;
  const has = (helper: string) => injectedHelpers.has(`$.${helper}`);
  const needsSummary = has("select") || has("inspect") || has("cloneNodeTree") || has("checkpoint") || has("replaceGeneratedFrame");
  const needsReadFiniteNumber = has("text") || has("create") || has("imageAsset") || has("cloneNodeTree") || has("placeNode") || has("findFreeSlot") || has("replaceGeneratedFrame");
  const needsSizeInput = has("text") || has("create") || has("imageAsset") || has("replaceGeneratedFrame");
  const needsPositionInput = has("text") || has("imageAsset") || has("cloneNodeTree") || has("replaceGeneratedFrame");
  const needsAppearance = has("text") || has("create");
  const needsText = has("text") || has("create");
  const needsAutoLayout = has("layout") || has("create");
  const needsQuery = has("find") || has("findAll");
  const needsResolveHandleId = injectedHelpers.has("$.resolveId") || needsText;

  prelude = replaceDelimitedSource(prelude, "async function selectNodesForRepl", "function solidPaint", "");
  if (!needsAppearance) prelude = replaceDelimitedSource(prelude, "function solidPaint", "function resolveHandleId", "");
  else prelude = replaceDelimitedSource(prelude, "function normalizeRgba", "function resolveHandleId", "");
  if (!needsResolveHandleId) prelude = replaceDelimitedSource(prelude, "function resolveHandleId", "function createHelperNode", "");
  if (!has("create")) prelude = replaceDelimitedSource(prelude, "function createHelperNode", "function readFiniteNumber", "");
  if (!needsReadFiniteNumber) prelude = replaceDelimitedSource(prelude, "function readFiniteNumber", "function setNodeSizeFromInput", "");
  if (!needsSizeInput) prelude = replaceDelimitedSource(prelude, "function setNodeSizeFromInput", "function setNodePositionFromInput", "");
  if (!needsPositionInput) prelude = replaceDelimitedSource(prelude, "function setNodePositionFromInput", "function applyAppearance", "");
  if (!needsAppearance) prelude = replaceDelimitedSource(prelude, "function applyAppearance", "function applyConstraints", "");
  prelude = replaceDelimitedSource(prelude, "function applyConstraints", "function fontFromHelperInput", "");
  if (!needsText) {
    prelude = replaceDelimitedSource(prelude, "function fontFromHelperInput", "function applyAutoLayout", "");
  } else if (!has("create")) {
    prelude = replaceDelimitedSource(prelude, "async function applyTextHelper", "function applyAutoLayout", "");
  }
  if (!needsAutoLayout) prelude = replaceDelimitedSource(prelude, "function applyAutoLayout", "function queryNodes", "");
  if (!needsQuery) prelude = replaceDelimitedSource(prelude, "function queryNodes", "function setNodeProperties", "");
  prelude = replaceDelimitedSource(prelude, "function setNodeProperties", "function setNodeSize", "");
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
  args: FigmaReplApplyAssetManifestArguments,
  session: FigmaReplSession,
): Promise<NormalizedAssetManifest> {
  const manifestPath = resolveWorkspaceAwareFile(args.manifestPath, session, "manifestPath");
  const manifestValue = manifestPath
    ? JSON.parse(await readFile(manifestPath, "utf8"))
    : undefined;
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
    throw new Error('Asset manifest field "argumentsTemplate" was removed. Use "figma_repl_call_upstream_tool".');
  }
  if (manifestRecord.toolName !== undefined || manifestRecord.arguments !== undefined || manifestRecord.refresh !== undefined) {
    throw new Error('Asset manifest fields "toolName/arguments/refresh" were removed. Use "figma_repl_call_upstream_tool".');
  }
  return {
    assets: rawAssets.map((asset, index) => normalizeManifestAsset(asset, index, baseDir, session)),
  };
}

function normalizeManifestAsset(
  value: unknown,
  index: number,
  baseDir: string | undefined,
  session: FigmaReplSession,
): NormalizedAssetManifestAsset {
  const record = asRecord(value);
  assertRemovedManifestAssetFields(record, index);
  const rawPath = asOptionalString(record.path);
  if (!rawPath) {
    throw new Error(`Asset manifest entry ${index} requires path.`);
  }
  const path = isAbsolute(rawPath)
    ? rawPath
    : baseDir
      ? resolve(baseDir, rawPath)
      : undefined;
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
    throw new Error(`Asset manifest entry ${index} fields "toolName/arguments/refresh" were removed. Use "figma_repl_call_upstream_tool".`);
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
      `Required official upstream Figma MCP ${kind} tool "${toolName}" was not found. This may indicate upstream contract drift; use "figma_repl_call_upstream_tool" for explicit upstream debugging. Available tools: ${tools.map((item) => item.name).join(", ")}`,
    );
  }
  return tool;
}

function assertUpstreamToolHasProperty(
  tool: UpstreamToolInfo,
  propertyName: string,
  kind: string,
): void {
  const schema = isRecord(tool.inputSchema) ? tool.inputSchema : undefined;
  const properties = isRecord(schema?.properties) ? schema.properties : undefined;
  if (!properties || !(propertyName in properties)) {
    throw new Error(
      `Required official upstream Figma MCP ${kind} tool "${tool.name}" no longer advertises inputSchema.properties.${propertyName}. This may indicate upstream contract drift; use "figma_repl_call_upstream_tool" for explicit upstream debugging.`,
    );
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
    `Required official upstream Figma MCP asset upload/fill tool "${UPLOAD_ASSETS_TOOL_NAME}" was not available. This may indicate upstream contract drift; use "figma_repl_call_upstream_tool" for explicit upstream debugging.`,
  );
}

function buildUploadAssetsArguments(asset: NormalizedAssetManifestAsset): Record<string, unknown> {
  if (!asset.fileKey) {
    throw new Error(
      `Asset manifest entry for "${asset.path}" needs a fileKey for upload_assets. Open the session with file or use "figma_repl_call_upstream_tool" for explicit upstream debugging.`,
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
  nodeId: string;
  tool: UpstreamToolInfo;
}): Record<string, unknown> {
  if (options.tool.name === "get_screenshot") {
    return { nodeId: options.nodeId };
  }
  throw new Error(
    `Required official upstream Figma MCP node screenshot tool "${SCREENSHOT_TOOL_NAME}" was not available. This may indicate upstream contract drift; use "figma_repl_call_upstream_tool" for explicit upstream debugging.`,
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

async function validateAssetManifestTargetsIfAvailable(options: {
  args: FigmaReplApplyAssetManifestArguments;
  session: FigmaReplSession;
  runtime: {
    client: FigmaMcpProxyClient;
    sessions: FigmaReplSessionStore;
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
    const code = `const targetNodeIds = ${literal(targetNodeIds)};
const validations = [];
for (const targetNodeId of targetNodeIds) {
  try {
    const node = await getNodeById(targetNodeId);
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
    const upstream = await callUpstreamEval(
      options.runtime.client,
      evalSettings,
      buildFigmaEvalScript({
        session: options.session,
        code,
        mode: "read",
      }),
    );
    const parsed = parseUpstreamToolResult(upstream);
    if (parsed.upstreamError) {
      return {
        ok: false,
        error: responseUpstreamError(parsed.upstreamError),
        primaryFix: parsed.primaryFix,
      };
    }
    const result = asRecord(asRecord(parsed.json).result);
    const validations = Array.isArray(result.validations)
      ? result.validations.filter(isRecord)
      : [];
    const invalidCount = Number(result.invalidCount ?? validations.filter((item) => item.status !== "valid").length);
    for (const asset of options.assetResults) {
      const targetNodeId = asOptionalString(asset.targetNodeId);
      const validation = validations.find((item) => item.targetNodeId === targetNodeId);
      if (validation) {
        asset.validation = validation;
      }
    }
    return {
      ok: invalidCount === 0,
      validCount: Number(result.validCount ?? validations.length - invalidCount),
      invalidCount,
      validations,
    };
  } catch (error) {
    return {
      ok: false,
      error: responseUpstreamError(normalizeCaughtUpstreamError(error)),
    };
  }
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

function createCaptureQa(saved: {
  kind: "image" | "text";
  mimeType: string;
  bytes: number;
  width?: number;
  height?: number;
}): Record<string, unknown> {
  const warnings: string[] = [];
  if (saved.bytes === 0) {
    warnings.push("capture output is empty");
  }
  if (saved.kind !== "image") {
    warnings.push("capture output is text, not an image");
  }
  if (saved.kind === "image" && (!saved.width || !saved.height)) {
    warnings.push("image dimensions could not be detected");
  }
  if (saved.kind === "image" && saved.bytes < 256) {
    warnings.push("image payload is very small");
  }
  if (saved.width !== undefined && saved.height !== undefined && (saved.width < 16 || saved.height < 16)) {
    warnings.push("image dimensions are very small");
  }
  return {
    ok: warnings.length === 0,
    warnings,
  };
}

async function runTaskPlanStep(options: {
  id: string;
  step: FigmaReplTaskPlanStep;
  type: string;
  title: string;
  sessionId?: string;
  references?: TaskPlanReferenceContext;
  runtime: {
    client: FigmaMcpProxyClient;
    sessions: FigmaReplSessionStore;
    upstreamToolCache: ReturnType<typeof createUpstreamToolCache>;
  };
}): Promise<Record<string, unknown>> {
  const rawStepArgs = expandTaskPlanStepReferences(
    taskPlanStepArguments(options.step),
    options.references,
  );
  const commonArgs = {
    title: asOptionalString(rawStepArgs.title) ?? options.title,
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
  throw new Error(`Unsupported figma_repl_run_task_plan step type "${options.type}".`);
}

function taskPlanStepArguments(step: FigmaReplTaskPlanStep): Record<string, unknown> {
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
  return upstream.kind === "json" ? upstream.payload : undefined;
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
    outputFile: options.result.outputFile,
    plannedOutputFile: options.result.plannedOutputFile,
    outputFiles: Object.keys(outputFiles).length > 0 ? outputFiles : undefined,
    outputFilePath: asRecord(outputFiles.outputFile).path,
  };
}

function normalizeTaskPlanStepType(step: FigmaReplTaskPlanStep): string {
  const value = asOptionalString(step.type);
  return normalizeTaskPlanStepTypeAlias(value);
}

function taskPlanStepSucceeded(result: Record<string, unknown>): boolean {
  if (result.ok === false) {
    return false;
  }
  const nestedResult = asRecord(runScriptUpstreamPayload(result));
  if (nestedResult.ok === false) {
    return false;
  }
  return true;
}

function summarizeTaskPlanStepResult(result: Record<string, unknown>): Record<string, unknown> {
  return {
    ok: result.ok !== false,
    outputFile: result.outputFile,
    plannedOutputFile: result.plannedOutputFile,
    files: result.files ?? result.outputFiles,
    toolName: result.toolName,
    upstreamTool: result.upstreamTool,
    failures: Array.isArray(result.failures) ? result.failures.length : undefined,
    diagnostics: Array.isArray(result.diagnostics) ? result.diagnostics.length : undefined,
  };
}

function createScriptRunSummary(options: {
  ok: boolean;
  dryRun: boolean;
  session: FigmaReplSession;
  script: Record<string, unknown>;
  diagnostics: FigmaReplDiagnostic[];
  upstreamTool?: string;
  upstreamArgument?: string;
  parsed?: ParsedUpstreamToolResult;
  upstreamError?: FigmaReplUpstreamError;
  primaryFix?: string;
}): Record<string, unknown> {
  return {
    ok: options.ok,
    dryRun: options.dryRun,
    sessionId: options.session.id,
    script: options.script,
    diagnosticsCount: options.diagnostics.length,
    fatalDiagnostics: options.diagnostics.filter((item) => item.severity === "fatal").length,
    warningDiagnostics: options.diagnostics.filter((item) => item.severity === "warning").length,
    upstreamTool: options.upstreamTool,
    upstreamArgument: options.upstreamArgument,
    upstreamError: options.upstreamError ? responseUpstreamError(options.upstreamError) : undefined,
    primaryFix: options.primaryFix,
    resultSummary: options.parsed ? summarizeParsedResult(options.parsed) : undefined,
    nodeIds: options.parsed ? collectNodeIds(options.parsed.json) : [],
  };
}

function formatScriptRunSummaryMarkdown(summary: Record<string, unknown>): string {
  const lines = [
    "# Figma REPL Script Summary",
    "",
    `- ok: ${String(summary.ok)}`,
    `- dryRun: ${String(summary.dryRun)}`,
    `- sessionId: ${String(summary.sessionId ?? "")}`,
    `- diagnostics: ${String(summary.diagnosticsCount ?? 0)}`,
    `- fatalDiagnostics: ${String(summary.fatalDiagnostics ?? 0)}`,
    `- warningDiagnostics: ${String(summary.warningDiagnostics ?? 0)}`,
  ];
  if (summary.upstreamTool) {
    lines.push(`- upstreamTool: ${String(summary.upstreamTool)}`);
  }
  if (summary.resultSummary) {
    lines.push(`- resultSummary: ${String(summary.resultSummary)}`);
  }
  if (isRecord(summary.upstreamError)) {
    lines.push(`- upstreamError: ${String(summary.upstreamError.message ?? "")}`);
  }
  if (summary.primaryFix) {
    lines.push(`- primaryFix: ${String(summary.primaryFix)}`);
  }
  if (Array.isArray(summary.nodeIds) && summary.nodeIds.length > 0) {
    lines.push(`- nodeIds: ${summary.nodeIds.map((item) => String(item)).join(", ")}`);
  }
  lines.push("");
  return lines.join("\n");
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
  const omitted: Array<{ field: string; bytes: number; limit: number; bytesHuman: string; limitHuman: string }> = [];
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
        limit,
        bytesHuman: formatBytesHuman(bytes),
        limitHuman: formatBytesHuman(limit),
      });
    }
  }
  if (omitted.length > 0) {
    result.inlineResultLimit = {
      limit,
      limitBytes: limit,
      limitHuman: formatBytesHuman(limit),
      omitted,
      guidance: "Read the paired outputFile result when inline fields are omitted.",
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
  session: FigmaReplSession | undefined,
  args: { file?: string; surface?: FigmaReplSurface },
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
  session.lastDiagnostics = diagnoseFigmaReplContext({
    expectedSurface,
    derivedSurface,
    fileUrl: session.fileUrl,
  });
}

function deriveFileSlug(
  args: { file?: string; fileSlug?: string },
  session?: FigmaReplSession,
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

function applySessionFileReference(session: FigmaReplSession, file: unknown): void {
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
  session: FigmaReplSession,
  args: { cwd?: string; dirName?: string },
): void {
  if (!session.fileKey && !session.fileUrl) {
    return;
  }
  if (typeof args.cwd === "string" && args.cwd.length > 0 && !isAbsolute(args.cwd)) {
    throw new Error('Tool argument "cwd" must be an absolute path.');
  }
  const fileSlug = slugifyTaskName(
    session.fileKey ??
    extractFigmaFileSlug(session.fileUrl) ??
    session.slug ??
    "figma-file",
  );
  session.workspace = createSessionWorkspace({
    cwd: typeof args.cwd === "string" && args.cwd.length > 0 ? args.cwd : process.cwd(),
    dirName: args.dirName,
    fileKey: session.fileKey,
    fileSlug,
    intentSlug: session.slug,
  });
}

function deriveTaskSlug(
  args: {
    task?: string;
    title?: string;
    sessionId?: string;
    taskSlug?: string;
  },
  fallback: string,
): string {
  return slugifyTaskName(
    args.taskSlug ??
    args.task ??
    args.title ??
    args.sessionId ??
    fallback,
  );
}

function createTaskScriptTemplate(taskSlug: string, args: FigmaReplPrepareTaskArguments): string {
  return [
    `// ${taskSlug}.figma.js`,
    "// Async Figma Plugin API body for figma_repl_run_script_file.",
    "// Use $ helpers plus native Figma Plugin API calls and return compact JSON.",
    args.task ? `// Task: ${String(args.task)}` : undefined,
    args.surface ? `// Surface: ${String(args.surface)}` : undefined,
    args.targetPageId ? `// Suggested targetPageId: ${String(args.targetPageId)}` : undefined,
    "",
    "const checkpoint = await $.checkpoint('start', ['$currentPage'], { depth: 0 });",
    "return { checkpoint, handles: $.handles };",
    "",
  ].filter((line): line is string => line !== undefined).join("\n");
}

const FIGMA_REPL_EVAL_HELPER_DESCRIPTIONS: Record<FigmaReplEvalHelperPath, string> = {
  "$": "Resolve a cached handle like $card, $selection, $currentPage, or a raw Figma node id.",
  "$.remember": "Store a handle name for a node or node id in the current REPL session.",
  "$.forget": "Remove a stored handle from the current REPL session.",
  "$.resolveId": "Resolve a cached handle or raw node id string to a Figma node id.",
  "$.node": "Resolve a cached handle or raw node id to the Figma node.",
  "$.select": "Resolve handles/node ids, validate selectable scene nodes, update selection, and optionally zoom.",
  "$.cloneNodeTree": "Copy a source node beside itself with outer-to-inner cloning and instance-subtree preservation.",
  "$.findAll": "Find matching nodes by scoped criteria.",
  "$.find": "Find one node by { name, type, within, as, required } and optionally remember it.",
  "$.text": "Create or update a text node with font loading and optional handle storage.",
  "$.layout": "Apply auto-layout properties to a target node.",
  "$.create": "Create a common Design node with optional parent, size, layout, appearance, and handle.",
  "$.findFreeSlot": "Find a non-overlapping slot in one parent using a preferred x/y, fixed size, gap, and direction.",
  "$.placeNode": "Move a node to an explicit or non-overlapping generated slot and return placement metadata.",
  "$.replaceGeneratedFrame": "Safely replace generated top-level FRAME nodes whose names match a guarded prefix, with dry-run support.",
  "$.inspect": "Resolve a handle or node id and return a compact node summary.",
  "$.screenshot": "Attempt a target node screenshot when upstream supports node.screenshot(); fall back to official screenshot tools for final QA if no image payload is returned.",
  "$.imageAsset": "Create or update an image-fill rectangle from small generated PNG/JPEG base64 or byte arrays; use upload_assets/upstream asset fill workflow for large files.",
  "$.checkpoint": "Return handle and node summaries at repair-friendly points.",
};

function evalHelperPath(name: FigmaReplEvalCommonHelperName): FigmaReplEvalHelperPath {
  return `$.${name}` as FigmaReplEvalHelperPath;
}

function createEvalHelperPathList(): FigmaReplEvalHelperPath[] {
  return ["$", ...FIGMA_REPL_EVAL_COMMON_HELPER_NAMES.map(evalHelperPath)];
}

function createEvalHelperDescriptionsPayload(): Record<FigmaReplEvalHelperPath, string> {
  return Object.fromEntries(
    createEvalHelperPathList().map((name) => [name, FIGMA_REPL_EVAL_HELPER_DESCRIPTIONS[name]]),
  ) as Record<FigmaReplEvalHelperPath, string>;
}

function createFileWorkflowPayload(): Record<string, unknown> {
  return {
    primaryTool: "figma_repl_run_script_file",
    fileExtension: ".figma.js",
    prepareTool: "figma_repl_prepare_task",
    planTool: "figma_repl_guidance",
    workspaceLayout: "<cwd>/figma-mcp/<fileKey-or-fileSlug>/<taskSlug>.figma.js + <taskSlug>.result.json",
    outputFiles: ["inputFile", "outputFile", "upstreamFile", "inlineResultLimit"],
    workflowTools: ["figma_repl_apply_asset_manifest", "figma_repl_download_assets", "figma_repl_capture_node", "figma_repl_run_task_plan"],
    helpers: createEvalHelperPathList(),
    defaultTaskRoot: `${TASK_WORKSPACE_ROOT_ENV}, then OS temp figma-repl-mcp/tasks/<slug>`,
    guidance: [
      "Keep non-trivial Plugin API work in local .figma.js files.",
      "Initialize a file workspace once, then keep task script/result pairs in that file-context folder.",
      "Run dryRun first for file-aware diagnostics without upstream calls.",
      "Keep each .figma.js transaction below the upstream code payload limit; split large screens into skeleton, asset-target, upload-fill, and fix scripts.",
      "The runner and eval wrapper parse JavaScript ASTs and inject only referenced $ helpers plus required dependencies; scripts that use only native Plugin API avoid the helper runtime. File-script metadata includes helperUsage.direct/transitive/runtimeBase for audit.",
      "Dynamic $ helper access is disabled because helper injection must be statically knowable: avoid $[name] / $name-style helper lookup, const { ...rest } = $, aliasing $, or declaring a local $; use static $.helper(...), literal $['helper'](...), or explicit const { helper } = $ destructuring.",
      "Use $ helpers for common edits and native Figma Plugin API calls for advanced work.",
      "Use $.imageAsset({ base64, parent, size, position, as }) for small generated PNG/JPEG assets. For large assets, create target rectangles in .figma.js and route through official upload_assets/upstream asset fill workflow to avoid MCP payload limits.",
      "Use figma_repl_apply_asset_manifest for target-rectangle plus local-file asset upload/fill orchestration when large assets should stay out of script payloads; target fields accept local handles and official upload_assets is adapted when advertised.",
      "Use figma_repl_download_assets for official download_assets workflows that save exported renders and raw/source images for one or more targets into local per-target folders.",
      "Use figma_repl_capture_node to write final visual QA captures to local image files; default and recommended image output is WebP, while explicit .png/.jpg/.jpeg outputFile extensions are preserved. Pass preview=true only when the MCP response should include a WebP image preview. Pass metadataFile when you need the complete upstream capture envelope.",
      "Use figma_repl_run_task_plan for sequential file-plan workflows that combine dry-runs, script execution, manifest/upload_assets application, download_assets, captures, and upstream calls; initialized workspaces get default step output files and later steps can reference {{outputs.stepId.outputFile.path}}.",
      "Use $.cloneNodeTree for side-by-side copy workflows that need outer-to-inner cloning and preserved instance subtrees.",
      "Use $.findFreeSlot, $.placeNode, and $.replaceGeneratedFrame for predictable generated-frame placement and guarded replacement without raw remove().",
      "Use <taskSlug>.result.json as the default complete output. Only pass diagnosticsFile or summaryFile when a task explicitly needs split files.",
      "Tool responses are structured-first: JSON data is in structuredContent, while content is reserved for MCP media items such as capture preview images. File-script parsed upstream JSON stays in upstream.payload, non-JSON upstream output stays in upstream.text, diagnostics are arrays, file pointers stay in outputFiles, and upstream sidecars use outputFiles.upstreamFile.",
      "When non-dry-run upstream execution fails, outputFiles.compiledScriptFile points to a *.failure.compiled.js wrapper with a failure header for line-aware repair; normal dry-runs and successful executions do not return compiledScript, and each run deletes the prior failure compiled file for the same output context before continuing.",
    ],
  };
}

function createIntentSuggestions(
  intent: string,
  maxCards: number,
  referenceContext: ReferenceSearchResult[] = [],
): Record<string, unknown> {
  const cards = chooseApiCardsForIntent(intent, maxCards);
  const recommendedCards = cards.map((card) => card.id);
  return {
    cards,
    recommendedCards,
    queryHints: uniqueStrings(cards.flatMap((card) => card.queryHints), 12),
    apiSymbols: uniqueStrings(cards.flatMap((card) => card.apiSymbols), 16),
    avoid: uniqueStrings(cards.flatMap((card) => card.avoid), 12),
    matchType: cards.length > 0 ? "api-card" : "bm25",
    confidence: cards.length > 0 ? "high" : "medium",
    referenceContext,
    workflow: createFileWorkflowPayload(),
    toolOrder: [
      "figma_repl_prepare_task",
      "figma_repl_guidance",
      "figma_repl_lookup(kind=api)",
      "figma_repl_run_script_file(dryRun=true)",
      "figma_repl_run_script_file",
      "figma_repl_inspect",
    ],
    referenceGuidance: "Use cards first for common intent; use BM25 snippets as compact context and run a narrower figma_repl_lookup kind=api query when exact API details are still missing.",
  };
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
      tools: ["figma_repl_prepare_task", "figma_repl_run_script_file", "figma_repl_inspect", "figma_repl_capture_node"],
      order: [
        "figma_repl_prepare_task",
        "figma_repl_guidance",
        "figma_repl_lookup",
        "figma_repl_run_script_file(dryRun=true)",
        "figma_repl_run_script_file",
        "figma_repl_inspect",
        "figma_repl_capture_node",
      ],
    },
    contextAndLookup: {
      summary: "Use to plan, bind lightweight session context, or fetch compact docs/API context.",
      tools: ["figma_repl_open", "figma_repl_guidance", "figma_repl_lookup"],
    },
    workflowAddOns: {
      summary: "Use when the primary script workflow needs generated assets, downloaded Figma assets, or repeatable multi-step orchestration.",
      tools: ["figma_repl_apply_asset_manifest", "figma_repl_download_assets", "figma_repl_run_task_plan"],
    },
    advancedEscapeHatches: {
      summary: "Use only for short ephemeral calls or explicit uncovered upstream-only capabilities.",
      tools: ["figma_repl_eval", "figma_repl_call_upstream_tool"],
    },
  };
}

function createToolArgumentGuidancePayload(): Record<string, unknown> {
  return {
    title: {
      optional: true,
      preferSupplying: true,
      schemaDescription: "One concise sentence-style line for UI/log display.",
      guidance: "Prefer supplying title on normal calls. Describe what this call is doing in plain language; keep it specific and avoid bare labels or tool names. If omitted, the runtime uses a generic default title.",
      examples: [
        "Capture the hero variant for visual QA",
        "Dry-run the token audit script",
        "Apply generated assets to product cards",
      ],
    },
    prepareTask: {
      tool: "figma_repl_prepare_task",
      tier: "normalPath",
      recommendedCalls: {
        workspaceFromFile: { title: "Prepare the token audit workspace", file: "<figma file URL or file key>", task: "<task>", surface: "design" },
      },
      advancedArguments: ["cwd", "fileSlug", "dirName", "taskSlug", "workspaceDir", "fileName", "taskRoot", "template", "overwrite"],
      avoidUnless: {
        cwd: "Omit cwd for the MCP server process cwd; pass it only when the server cwd is not the intended project directory.",
        workspaceOverrides: "Use workspaceDir/taskRoot only when deliberately bypassing the default <cwd>/figma-mcp/<fileKey-or-fileSlug> layout.",
        fileName: "Use fileName only when the generated <taskSlug>.figma.js name is unsuitable.",
        overwrite: "Use only after deciding that replacing an existing script/result pair is intended.",
      },
    },
    open: {
      tool: "figma_repl_open",
      tier: "contextAndLookup",
      recommendedCalls: {
        session: { title: "Open the design file session", sessionId: "<session>", file: "<figma file URL or file key>", surface: "design" },
      },
      advancedArguments: ["cwd", "dirName", "connect", "refresh", "handles"],
      avoidUnless: {
        cwd: "Omit cwd for the MCP server process cwd; pass it only when the server cwd is not the intended project directory.",
        dirName: "Omit dirName for the default figma-mcp workspace directory.",
        connect: "Leave at the default true unless intentionally updating only local metadata.",
        refresh: "Use only for upstream tool-cache debug.",
        handles: "Use only when importing known node ids into a new session; prefer $.remember from scripts.",
      },
    },
    eval: {
      tool: "figma_repl_eval",
      tier: "advancedEscapeHatches",
      guidance: "Use only for small ephemeral calls. Use prepare_task + figma_repl_run_script_file for repairable scripts, multi-step work, and large structured results.",
      recommendedCalls: {
        read: { title: "Inspect selected layout metadata", sessionId: "<session>", code: "<return compact JSON>", mode: "read", surface: "design" },
        write: { title: "Apply the selected node updates", sessionId: "<session>", code: "<return compact JSON>", mode: "write", surface: "design" },
      },
      advancedArguments: ["outputFile", "inlineResultLimit", "allowDangerousOperations", "handleUpdates"],
      avoidUnless: {
        outputFile: "Use when you want a full eval result file even for compact results; large upstream.payload/text auto-writes outputFile and upstreamFile.",
        inlineResultLimit: "Use only for inline payload-size control in bytes. Defaults to 4 KB and is capped at 30 KB; it does not bypass upstream Figma payload limits.",
        allowDangerousOperations: "Use only after reviewing the exact code; it does not bypass API contract, surface, or read-mode guards.",
        handleUpdates: "Use only for handle import/repair; prefer $.remember inside code.",
      },
    },
    inspect: {
      tool: "figma_repl_inspect",
      tier: "normalPath",
      recommendedCalls: {
        inspectTarget: { title: "Inspect the current selection", sessionId: "<session>", target: "$selection" },
        inspectStyle: { title: "Inspect visual style tokens", sessionId: "<session>", mode: "style", target: "$selection" },
        validateHandles: { title: "Validate cached node handles", sessionId: "<session>", mode: "validate" },
      },
      advancedArguments: ["handles"],
      avoidUnless: {
        handles: "Pass handles only to validate a subset; omit to validate all cached handles.",
      },
    },
    assetManifest: {
      tool: "figma_repl_apply_asset_manifest",
      tier: "workflowAddOns",
      recommendedCalls: {
        applyManifest: { title: "Apply generated assets to target rectangles", sessionId: "<session>", manifestPath: "<assets>.json", outputFile: "<assets>.result.json" },
      },
      advancedArguments: ["assets"],
      avoidUnless: {
        assets: "Prefer manifestPath for repeatable local-file workflows; inline assets are for generated one-off plans.",
      },
    },
    downloadAssets: {
      tool: "figma_repl_download_assets",
      tier: "workflowAddOns",
      recommendedCalls: {
        downloadTargets: { title: "Download source assets from targets", sessionId: "<session>", targets: [{ target: "$target", defaultFormat: "png" }], outputDir: "<downloads>", outputFile: "<downloads>.result.json" },
      },
      preferredArguments: ["targets", "manifestPath", "outputDir", "outputFile"],
      avoidUnless: {
        manifestPath: "Use only for repeatable batch files shaped as { targets: [...] }; inline targets are clearer for one-off calls.",
        outputDir: "Omit for the default <slug>.downloads directory unless downstream steps need a specific path.",
        outputFile: "Omit for the default <slug>.downloads.result.json unless downstream steps need a specific path.",
      },
    },
    captureNode: {
      tool: "figma_repl_capture_node",
      tier: "normalPath",
      recommendedCalls: {
        capture: { title: "Capture the target node for visual QA", sessionId: "<session>", target: "$target", outputFile: "<capture>.webp", preview: true },
      },
      advancedArguments: ["metadataFile"],
      avoidUnless: {
        metadataFile: "Use when you need the complete upstream capture envelope separate from the saved screenshot/text output.",
      },
    },
    taskPlan: {
      tool: "figma_repl_run_task_plan",
      tier: "workflowAddOns",
      recommendedCalls: {
        filePlan: { title: "Run the repeatable asset QA plan", sessionId: "<session>", planPath: "<plan>.json", outputFile: "<plan>.result.json" },
      },
      advancedArguments: ["steps"],
      avoidUnless: {
        steps: "Prefer planPath for repeatable workflows; inline steps are for generated one-off plans.",
        stepArgs: "Each step must use { type, args }; put tool-specific fields inside args, not at the step top level.",
      },
    },
    guidance: {
      tool: "figma_repl_guidance",
      tier: "contextAndLookup",
      preferredArguments: ["task", "mode", "surface"],
    },
    lookup: {
      tool: "figma_repl_lookup",
      tier: "contextAndLookup",
      preferredArguments: { docs: ["kind=docs", "query"], api: ["kind=api", "symbol"] },
      resultSizeControls: ["maxResults", "maxSnippetLines"],
    },
    callUpstreamTool: {
      tool: "figma_repl_call_upstream_tool",
      tier: "advancedEscapeHatches",
      guidance: "Explicit upstream escape hatch only for uncovered official Figma MCP capabilities. Read figma-repl://upstream-tools, then figma-repl://upstream-tools/{name}, and do not use for use_figma/get_screenshot/upload_assets/download_assets wrappers.",
      recommendedCalls: {
        explicit: { title: "Call the upstream-only Figma tool", sessionId: "<session>", toolName: "<uncovered official upstream tool>", arguments: {} },
      },
      advancedArguments: ["outputFile", "inlineResultLimit", "refresh"],
      avoidUnless: {
        outputFile: "Use when you want a full upstream-tool result file even for compact results; large upstream.payload/text auto-writes outputFile and upstreamFile.",
        inlineResultLimit: "Use only for inline payload-size control in bytes. Defaults to 4 KB and is capped at 30 KB; it does not bypass upstream Figma payload limits.",
        refresh: "Use only for upstream tool-cache debug.",
      },
    },
  };
}

function createCapabilitiesPayload(): Record<string, unknown> {
  return {
    guide: {
      purpose: "Unified Figma-facing MCP facade for agents after OAuth registration. Stay inside figma_repl_mcp; it keeps local session metadata/handles and can bridge to upstream Figma MCP tools through explicit REPL tools.",
      preferredFlow: [
        "Read figma-repl://capabilities to choose the facade path",
        "figma_repl_prepare_task with file and task for repairable .figma.js workspaces; cwd is an optional override",
        "figma_repl_guidance with mode=plan for workflow planning or mode=guidance/card/catalog for compact local API cards",
        "figma_repl_lookup only when exact docs/API snippets are still needed after guidance",
        "figma_repl_run_script_file with inputFile and dryRun=true for primary .figma.js workflows, output files, and line-aware repair",
        "figma_repl_run_script_file without dryRun to execute the reviewed file workflow",
        "figma_repl_inspect with mode=inspect, mode=style, or mode=validate before mutation and after generated work",
        "figma_repl_apply_asset_manifest for large generated assets: create target rectangles in script, then upload/fill from local files through official upload_assets",
        "figma_repl_download_assets for official download_assets: pass targets:[{ target }] to save exported renders and raw/source files locally",
        "figma_repl_capture_node for final visual QA captures saved as local image files, WebP by default and PNG/JPEG when the outputFile extension requests it; add preview=true for a WebP MCP image preview",
        "figma_repl_open only for lightweight session/context binding when a prepared task is not needed; start new file tasks with figma_repl_prepare_task",
        "figma_repl_run_task_plan only for repeatable multi-step plans",
        "figma_repl_eval only for small ephemeral calls; prefer run_script_file for repairable work",
        "figma_repl_call_upstream_tool only when a task explicitly needs an uncovered upstream Figma MCP tool",
      ],
      handles: "Use stable local handles like $card instead of carrying JS object references between calls.",
      upstreamBridge: "The REPL can call uncovered official upstream tools through figma_repl_call_upstream_tool after reading figma-repl://upstream-tools and figma-repl://upstream-tools/{name}; dedicated wrappers cover use_figma, get_screenshot, upload_assets, and download_assets.",
      responseShape: "Structured-first payloads without session.history. JSON data is returned in structuredContent; content is empty except for MCP protocol media items such as capture preview images. Tool metadata exposes machine-readable defaults, caps, file pointers, upstream envelopes, helperUsage, and preview schemas for stable fields while keeping payloads extensible. Upstream-backed eval/script/call_upstream tools return JSON in upstream.payload or non-JSON output in upstream.text, omit oversized inline fields with inlineResultLimit metadata, and write outputFiles.upstreamFile sidecars when a full result file is written. Asset manifests and download_assets keep compact inline entries and complete per-target upstream/download details in explicit result files.",
    },
    toolTiers: createToolTierPayload(),
    patterns: {
      text: "Use $.text, or call figma.loadFontAsync before mutating characters/fontName in native Plugin API code.",
      createUi: "Use $.create for common Design nodes and native Plugin API calls for advanced construction.",
      transaction: "Use dryRun=true first, then execute the same .figma.js file; add $.checkpoint calls before/after meaningful batches to return handle and node summaries.",
      clone: "Use $.cloneNodeTree to copy a node to the side; it clones outer-to-inner and preserves instance subtrees whole when children cannot be rebuilt.",
      generatedFrame: "Use $.findFreeSlot or $.placeNode for predictable non-overlapping placement and $.replaceGeneratedFrame when replacing a guarded generated FRAME.",
      designSystem: "Use native Plugin API calls in .figma.js for variables/styles/components; use explicit REPL upstream calls only when a task requires them.",
      query: "Use figma_repl_guidance first for natural-language tasks; it returns recommendedCards, queryHints, apiSymbols, avoid, and compact referenceContext. Prefer findOne/query scoped to currentPage or a handle; figma.root.findAll is blocked.",
      pages: "Use targetPageId or one setCurrentPageAsync call; direct figma.currentPage assignment is blocked.",
      selection: "Use $.select instead of direct figma.currentPage.selection access in repairable scripts.",
      styleAudit: "Use figma_repl_inspect mode=style for compact visual-token audits before asking agents to match a layer style.",
      validation: "Use figma_repl_inspect mode=validate before mutating cached handles from an earlier call.",
    },
    safety: {
      fatalDiagnosticsBlock: true,
      warningsReturnWithResult: true,
      allowDangerousOperations: "Bypasses only dynamic/destructive guards. It does not bypass API contract, surface, or read-mode guards.",
      diagnosticShape: "{ code, severity, message, suggestion, docsHint }",
      upstreamFailureShape: "{ ok:false, upstreamError:{ message, code?, details? }, primaryFix }",
    },
    scriptWorkflow: {
      primaryTool: "figma_repl_run_script_file",
      scriptShape: "Write an async function body in a local .figma.js file. The runner injects Figma REPL prelude plus $ helpers before upstream use_figma execution.",
      requiredArguments: ["inputFile after figma_repl_prepare_task; scriptPath is an advanced absolute-path escape hatch"],
      recommendedCalls: {
        dryRun: { title: "Dry-run the token audit script", sessionId: "<session>", inputFile: "<task>.figma.js", dryRun: true, strict: true, surface: "design" },
        execute: { title: "Execute the token audit script", sessionId: "<session>", inputFile: "<task>.figma.js", outputFile: "<task>.result.json" },
      },
      advancedArguments: [
        "scriptPath",
        "outputDir",
        "diagnosticsFile",
        "summaryFile",
        "inlineResultLimit",
      ],
      avoidUnless: {
        scriptPath: "Use only for absolute-path escape hatches outside an initialized workspace; prefer inputFile.",
        outputDir: "Use only when writing outside the workspace file-context folder.",
        diagnosticsFile: "Use only when a separate diagnostics JSON file is explicitly needed.",
        summaryFile: "Use only when a separate Markdown summary file is explicitly needed.",
        inlineResultLimit: "Use only for inline payload-size control in bytes. Defaults to 4 KB and is capped at 30 KB; it does not bypass upstream Figma payload limits.",
      },
      options: {
        scriptPath: "Advanced absolute-path escape hatch. Prefer inputFile after figma_repl_prepare_task.",
        inputFile: "Recommended file name inside <cwd>/figma-mcp/<fileKey-or-fileSlug>/ after workspace initialization.",
        dryRun: "Read, diagnose, inject helpers, and return script metadata without calling upstream Figma.",
        strict: "Promote warnings to fatal diagnostics.",
        surface: "design, figjam, or slides; blocks obvious wrong-surface API usage.",
        targetPageId: "Switch once to a known page before the script body runs.",
        allowDangerousOperations: "Bypasses only dynamic/destructive guards after exact file review.",
        outputFile: "Recommended normal result file name inside the initialized file-context folder. Defaults to the input script basename plus .result.json.",
        outputDir: "Advanced absolute directory escape hatch. Defaults to result.json only; pass diagnosticsFile or summaryFile for split files.",
        diagnosticsFile: "Advanced opt-in JSON file when diagnostics must be split out of the paired result file.",
        summaryFile: "Advanced opt-in Markdown file when a separate summary is required.",
        inlineResultLimit: "Advanced payload-size control in bytes for large inline fields. Defaults to 4 KB and is capped at 30 KB; omitted fields stay available in the paired result file and outputFiles.upstreamFile.",
      },
      responseExamples: {
        jsonSuccess: { ok: true, dryRun: false, upstream: { kind: "json", ok: true, payload: { ok: true, result: {} } } },
        textOutput: { ok: true, dryRun: false, upstream: { kind: "text", ok: true, text: "..." } },
        inlinePayloadOmitted: {
          ok: true,
          dryRun: false,
          upstream: { kind: "json", ok: true },
          inlineResultLimit: {
            limit: 4000,
            limitBytes: 4000,
            limitHuman: "4 KB",
            omitted: [{ field: "upstream.payload", bytes: 12000, limit: 4000, bytesHuman: "12 KB", limitHuman: "4 KB" }],
          },
        },
      },
      helpers: createEvalHelperDescriptionsPayload(),
    },
    toolArgumentGuidance: createToolArgumentGuidancePayload(),
    fileWorkflow: createFileWorkflowPayload(),
    workflowTools: {
      resource: "figma-repl://workflow-tools",
      assetManifest: {
        tool: "figma_repl_apply_asset_manifest",
        purpose: "Apply local generated image files to pre-created target nodes through official upstream upload_assets.",
        assetShape: "{ path, target, nodeUrl?, name?, metadata? }",
        defaults: "Requires advertised official upload_assets, resolves target handles, and sends fileKey/count/nodeId/scaleMode upstream. If the official contract drifts, use figma_repl_call_upstream_tool for explicit upstream debugging.",
        result: "Inline assets are compact: ok, path, targetNodeId, handle, name, toolName, compact upload summary, validation, error, upstreamSummary. Explicit outputFile writes assetDetails with full per-asset upstream envelopes, upload details, and arguments.",
        validation: "validateTargets defaults on; when upstream eval is available, target nodes are checked for IMAGE fills after upload.",
      },
      downloadAssets: {
        tool: "figma_repl_download_assets",
        purpose: "Call official upstream download_assets for one or more Figma targets and save exported renders plus raw/source image URLs locally.",
        targetShape: "{ target, name?, defaultFormat?, defaultScale? }; target accepts a node id, node URL, local handle like $hero, or { handle: \"$hero\" }.",
        defaults: "Use targets for inline calls or manifestPath pointing to { targets: [...] }. outputDir defaults to <slug>.downloads and outputFile defaults to <slug>.downloads.result.json in initialized workspaces.",
        result: "Inline targets are compact: ok, targetNodeId, handle, name, outputDir, downloaded file pointers, upstreamSummary, and error. outputFile writes targetDetails with per-target upstream envelopes, arguments, discovered URLs, and download details.",
      },
      capture: {
        tool: "figma_repl_capture_node",
        purpose: "Call official upstream get_screenshot and save image, screenshot URL payload, or text response to outputFile for final visual QA.",
        defaulting: "Requires advertised official get_screenshot and sends { nodeId } upstream. If the official contract drifts, use figma_repl_call_upstream_tool for explicit upstream debugging.",
        metadata: "Returns outputFile on success, plannedOutputFile on upstream failure, kind, saved image MIME for image captures, bytes, width/height, sourceUrl when downloaded, qa warnings, compact inline upstream, optional WebP preview metadata when preview=true, and optional metadataFile with the full upstream capture envelope.",
      },
      taskPlan: {
        tool: "figma_repl_run_task_plan",
        stepShape: "{ id?, type?, args? }; put all tool-specific inputs inside args.",
        stepTypes: ["script-file", "asset-manifest", "upload_assets", "download-assets", "download_assets", "screenshot-capture", "upstream-tool"],
        defaultFailureMode: "stopOnFailure=true",
        references: "Later step arguments can reference prior outputs with {{outputs.stepId.outputFile.path}} or {{steps.stepId.outputFiles.outputFile.path}}; upstream JSON is available at {{steps.stepId.upstream.payload}}, downloads expose {{steps.stepId.downloadOutputDir}} and {{steps.stepId.downloadTargets}}, captures expose {{steps.stepId.outputFile}}, and failed captures expose {{steps.stepId.plannedOutputFile}}.",
        result: "Writes a compact plan result JSON and returns per-step status summaries plus outputReferences. In initialized workspaces, missing step outputs default to <step-id>.result.json, <step-id>.assets.result.json, <step-id>.downloads.result.json plus <step-id>.downloads, <step-id>.webp for image captures, and <step-id>.capture.result.json.",
      },
    },
    queryStrategy: {
      tool: "figma_repl_guidance",
      resource: "figma-repl://intents",
      searchAnchors: FIGMA_REPL_QUERY_SEARCH_ANCHORS,
      flow: [
        "Describe the user task in task.",
        "Use recommendedCards to choose compact cards before broad docs lookup.",
        "Use queryHints as narrower follow-up searches when card guidance is insufficient.",
        "Use apiSymbols for exact figma_repl_lookup kind=api calls.",
        "Treat avoid as task-specific guardrails before writing .figma.js.",
      ],
      commonCards: FIGMA_REPL_API_CARDS.map((card) => card.id),
      outputFields: FIGMA_REPL_QUERY_OUTPUT_FIELDS,
    },
    apiCards: {
      tool: "figma_repl_guidance",
      resource: "figma-repl://api-cards",
      cards: FIGMA_REPL_API_CARDS.map((card) => ({
        id: card.id,
        title: card.title,
        intents: card.intents,
        surface: card.surface,
        queryHints: card.queryHints,
        apiSymbols: card.apiSymbols,
      })),
    },
    intents: {
      tool: "figma_repl_guidance",
      resource: "figma-repl://intents",
      examples: ["create responsive card UI", "update text styles", "make component variants", "validate stale handles"],
      returns: ["recommendedCards", "queryHints", "apiSymbols", "avoid", "workflow", "referenceContext"],
    },
    facadeRoutingDelegationBoundaries: [
      "Keep the agent on figma_repl_mcp; use figma_repl_call_upstream_tool only for explicit uncovered upstream-tool calls after reading figma-repl://upstream-tools/{name}.",
      "For small generated local PNG/JPEG assets in .figma.js, use $.imageAsset({ base64, parent, size, position, as }); for large assets, create target rectangles then route through an upstream official upload_assets workflow when available.",
      "Do not use PluginData APIs for agent state; use local session handles or a dedicated storage workflow.",
      "Use compact docs/API lookup as the exposed documentation surface; bundled corpus files stay internal.",
    ],
    docsLookup: {
      lookupTool: "figma_repl_lookup",
      docsResource: "figma-repl://docs",
      apiResource: "figma-repl://api",
      guidanceTool: "figma_repl_guidance",
      ranking: "Internal corpus files are chunked by Markdown headings/windows or d.ts symbol-ish blocks, then ranked with BM25; API lookup boosts exact symbols.",
      guardrail: "All lookup output is capped and confidence-labeled; bundled corpus files are not returned as agent-readable documents.",
    },
    examples: [
      {
        title: "Run a repairable text edit",
        tool: "figma_repl_run_script_file",
        arguments: {
          title: "Update title text",
          sessionId: "main",
          inputFile: "update-title.figma.js",
          dryRun: true,
          strict: true,
        },
      },
      {
        title: "Inspect and cache one node in a script",
        tool: "figma_repl_run_script_file",
        scriptBody: "const primaryButton = await $.find({ name: 'Primary button', type: 'FRAME', as: '$primaryButton' });\nreturn await $.checkpoint('found-primary-button', [primaryButton]);",
      },
      {
        title: "Create a simple UI section in a script",
        tool: "figma_repl_run_script_file",
        scriptBody: "const section = await $.create({ type: 'FRAME', as: '$section', name: 'Settings section', size: { width: 360, height: 160 }, layout: { layoutMode: 'VERTICAL', itemSpacing: 12 } });\nawait $.text({ parent: section, as: '$sectionTitle', text: 'Settings', font: { family: 'Inter', style: 'Bold', size: 20 } });\nreturn await $.checkpoint('section-created', ['$section'], { depth: 1 });",
      },
    ],
  };
}

function readStaticReplResource(uri: string): Record<string, unknown> | undefined {
  const payload = createCapabilitiesPayload();
  const resources: Record<string, unknown> = {
    "figma-repl://capabilities": payload,
    "figma-repl://guide": payload.guide,
    "figma-repl://patterns": payload.patterns,
    "figma-repl://scripts": payload.scriptWorkflow,
    "figma-repl://file-workflow": payload.fileWorkflow,
    "figma-repl://workflow-tools": payload.workflowTools,
    "figma-repl://api-cards": {
      tool: "figma_repl_guidance",
      cards: FIGMA_REPL_API_CARDS,
      queryStrategy: payload.queryStrategy,
      guidance: "Curated compact cards for common .figma.js tasks; use figma_repl_guidance to map natural-language intent to recommendedCards, queryHints, apiSymbols, and avoid before broader lookup.",
    },
    "figma-repl://intents": {
      tool: "figma_repl_guidance",
      queryStrategy: payload.queryStrategy,
      workflow: createFileWorkflowPayload(),
      commonTasks: FIGMA_REPL_COMMON_TASK_LABELS,
      examples: FIGMA_REPL_INTENT_EXAMPLE_QUERIES.map((query) => createIntentSuggestions(query, 3)),
    },
    "figma-repl://safety": {
      safety: payload.safety,
      facadeRoutingDelegationBoundaries: payload.facadeRoutingDelegationBoundaries,
      diagnostics: [
        "FIGMA_REPL_TEXT_MUTATION_NEEDS_FONT",
        "FIGMA_REPL_NODE_REMOVAL",
        "FIGMA_REPL_DIRECT_SELECTION_ACCESS",
        "FIGMA_REPL_CURRENT_PAGE_ASSIGNMENT",
        "FIGMA_REPL_MULTIPLE_PAGE_SWITCH",
        "FIGMA_REPL_ROOT_FIND_ALL",
        "FIGMA_REPL_PLUGIN_DATA",
        "FIGMA_REPL_IMAGE_CREATION",
      ],
    },
    "figma-repl://docs": {
      purpose: "Compact searchable facade guidance from the internal Figma corpus.",
      tool: "figma_repl_lookup",
      kind: "docs",
      workflow: [
        "Search with kind=docs and a narrow query.",
        "Use matchType, confidence, and capped BM25 snippets.",
        "Run a narrower search instead of reading bundled corpus files.",
      ],
      ranking: "Markdown references are chunked by headings and compact windows before BM25 scoring.",
      allowlistSize: DOCS_SEARCH_ALLOWLIST.length,
      maxResults: MAX_DOCS_SEARCH_RESULTS,
      maxSnippetLines: MAX_DOCS_SEARCH_SNIPPET_LINES,
    },
    "figma-repl://api": {
      purpose: "Targeted Figma Plugin API symbol lookup from the internal corpus.",
      tool: "figma_repl_lookup",
      kind: "api",
      workflow: [
        "Search kind=api exact symbols such as createFrame, loadFontAsync, VariableCollection, or SceneNode.",
        "Use snippets with matchType and confidence.",
        "For broader usage guidance, use figma_repl_lookup kind=docs.",
      ],
      ranking: "API references are chunked by Markdown headings/windows and d.ts symbol-ish blocks; exact symbols are boosted over broad token matches.",
      guardrail: "Bundled declaration files are internal corpus and are never returned as full documents.",
      maxResults: MAX_DOCS_SEARCH_RESULTS,
      maxSnippetLines: MAX_DOCS_SEARCH_SNIPPET_LINES,
    },
  };
  const content = resources[uri];
  if (content === undefined) {
    return undefined;
  }
  return {
    contents: [
      {
        uri,
        mimeType: "application/json",
        text: JSON.stringify(content, null, 2),
      },
    ],
  };
}

async function readReplResource(
  uri: string,
  runtime: {
    sessions: FigmaReplSessionStore;
    upstreamToolCache: ReturnType<typeof createUpstreamToolCache>;
  },
): Promise<Record<string, unknown>> {
  const staticResource = readStaticReplResource(uri);
  if (staticResource) {
    return staticResource;
  }
  if (uri === "figma-repl://upstream-tools") {
    const tools = await runtime.upstreamToolCache.list(false);
    return {
      contents: [
        {
          uri,
          mimeType: "application/json",
          text: JSON.stringify({
            tools: tools.map((tool) => upstreamToolDirectoryEntry(tool)),
            detailTemplate: "figma-repl://upstream-tools/{name}",
            categories: ["capture", "design-context", "execution", "assets", "code-connect", "libraries", "figjam", "generation", "account", "other"],
            guidance: "Compact read-only directory for official upstream Figma MCP tools. Each entry has name, category, and curated short description. Read figma-repl://upstream-tools/{name} for one tool's full description and inputSchema. Call figma_repl_call_upstream_tool only for an explicit uncovered upstream capability; use dedicated figma_repl_* wrappers for use_figma, get_screenshot, upload_assets, and download_assets.",
          }, null, 2),
        },
      ],
    };
  }
  const upstreamToolPrefix = "figma-repl://upstream-tools/";
  if (uri.startsWith(upstreamToolPrefix)) {
    const toolName = decodeURIComponent(uri.slice(upstreamToolPrefix.length));
    const tools = await runtime.upstreamToolCache.list(false);
    const tool = tools.find((item) => item.name === toolName);
    if (!tool) {
      throw new Error(`Upstream Figma MCP tool not found: ${toolName}`);
    }
    return {
      contents: [
        {
          uri,
          mimeType: "application/json",
          text: JSON.stringify({
            name: tool.name,
            description: tool.description,
            inputSchema: tool.inputSchema,
            callTool: "figma_repl_call_upstream_tool",
            guidance: "Full upstream tool contract. Use figma_repl_call_upstream_tool only for explicit uncovered official upstream capabilities; prefer dedicated figma_repl_* workflow tools when available.",
          }, null, 2),
        },
      ],
    };
  }
  if (uri === "figma-repl://sessions") {
    return {
      contents: [
        {
          uri,
          mimeType: "application/json",
          text: JSON.stringify({ sessions: runtime.sessions.list().map((session) => publicSession(session)) }, null, 2),
        },
      ],
    };
  }
  const prefix = "figma-repl://sessions/";
  if (uri.startsWith(prefix)) {
    const sessionId = decodeURIComponent(uri.slice(prefix.length));
    const session = runtime.sessions.get(sessionId);
    if (!session) {
      throw new Error(`Figma REPL session not found: ${sessionId}`);
    }
    return {
      contents: [
        {
          uri,
          mimeType: "application/json",
          text: JSON.stringify(publicSession(session), null, 2),
        },
      ],
    };
  }
  throw new Error(`Unknown figma-repl resource URI: ${uri}`);
}

function upstreamToolDirectoryEntry(tool: UpstreamToolInfo): Record<string, unknown> {
  return {
    name: tool.name,
    category: upstreamToolDirectoryCategory(tool),
    description: upstreamToolDirectoryDescription(tool),
  };
}

type UpstreamToolDirectoryCategory =
  | "capture"
  | "design-context"
  | "execution"
  | "assets"
  | "code-connect"
  | "libraries"
  | "figjam"
  | "generation"
  | "account"
  | "other";

const UPSTREAM_TOOL_DIRECTORY_CATEGORIES: Record<string, UpstreamToolDirectoryCategory> = {
  get_screenshot: "capture",
  get_design_context: "design-context",
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
};

const UPSTREAM_TOOL_DIRECTORY_DESCRIPTIONS: Record<string, string> = {
  get_screenshot: "Capture a screenshot for a selected or specified Figma node.",
  get_design_context: "Get design-to-code context, screenshot, and metadata for a node.",
  get_metadata: "Read XML metadata for a node or page when full design context is unnecessary.",
  get_variable_defs: "List variable definitions referenced by a node.",
  get_figjam: "Generate UI code or context for a FigJam node.",
  generate_figma_design: "Import a URL or HTML into an existing Figma design file.",
  generate_diagram: "Create Mermaid-based diagrams in FigJam.",
  get_code_connect_map: "Read existing Code Connect mappings for Figma nodes.",
  whoami: "Check the authenticated Figma user and permission context.",
  add_code_connect_map: "Map one Figma node to a code component.",
  get_code_connect_suggestions: "Suggest Code Connect mappings for a Figma node.",
  send_code_connect_mappings: "Save approved Code Connect mappings in bulk.",
  get_context_for_code_connect: "Get component metadata needed for Code Connect mapping.",
  use_figma: "Run Plugin API JavaScript to create, inspect, or edit Figma content.",
  get_libraries: "List subscribed and available libraries for a Figma file.",
  search_design_system: "Search library components, variables, and styles by text query.",
  create_new_file: "Create a new blank Figma file.",
  upload_assets: "Get upload URLs for image assets before applying them in Figma.",
  download_assets: "Download exported renders and source images for one Figma node.",
};

function upstreamToolDirectoryCategory(tool: UpstreamToolInfo): UpstreamToolDirectoryCategory {
  return UPSTREAM_TOOL_DIRECTORY_CATEGORIES[tool.name] ?? "other";
}

function upstreamToolDirectoryDescription(tool: UpstreamToolInfo): string | undefined {
  return UPSTREAM_TOOL_DIRECTORY_DESCRIPTIONS[tool.name] ?? compactUpstreamToolDescription(tool.description);
}

function compactUpstreamToolDescription(description: string | undefined): string | undefined {
  const normalized = description?.replace(/\s+/gu, " ").trim();
  if (!normalized) {
    return undefined;
  }
  return normalized.length <= 96
    ? normalized
    : `${normalized.slice(0, 93)}...`;
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
): FigmaReplUpstreamError | undefined {
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

function extractFigmaDebugUuid(text: string): string | undefined {
  const match = /Figma Debug UUID:\s*([0-9a-fA-F-]+)/u.exec(text);
  return match?.[1];
}

function normalizeCaughtUpstreamError(error: unknown): FigmaReplUpstreamError {
  if (error instanceof Error) {
    return {
      message: error.message,
      code: typeof (error as { code?: unknown }).code === "string"
        ? (error as { code?: string }).code
        : undefined,
      details: error.stack,
    };
  }
  return {
    message: stringFromUnknown(error) ?? "Upstream Figma execution failed.",
    details: error,
  };
}

function primaryFixForUpstreamError(error: FigmaReplUpstreamError): string {
  const message = error.message.toLowerCase();
  if (message.includes("remove") && (message.includes("instance") || message.includes("children") || message.includes("subtree"))) {
    return "Use $.replaceGeneratedFrame({ name, dryRun: true }) for guarded generated-frame replacement, or $.cloneNodeTree({ source, placement: 'right' }) for copy/rebuild workflows.";
  }
  if (message.includes("font") || message.includes("characters")) {
    return "Load the target font with figma.loadFontAsync or use $.text before changing TextNode characters.";
  }
  if (message.includes("selection")) {
    return "Use $.select([...]) or explicit node ids/handles instead of direct figma.currentPage.selection access.";
  }
  return "Open the paired .figma.js file, repair the upstream Plugin API error, dry-run with strict=true, then rerun the same script.";
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

function updateSessionFromParsedResult(session: FigmaReplSession, value: unknown): void {
  const record = asRecord(value);
  const repl = asRecord(record.__figmaRepl);
  const result = asRecord(record.result);
  if (isStringRecord(repl.handles)) {
    mergeHandles(session, repl.handles);
  }
  if (isStringRecord(result.handles)) {
    mergeHandles(session, result.handles);
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
  return "Figma REPL command completed.";
}

function diagnosticsForResponse(
  diagnostics: FigmaReplDiagnostic[] | undefined,
): FigmaReplDiagnostic[] {
  return diagnostics ?? [];
}

function responseSession(session: FigmaReplSession): Record<string, unknown> {
  return publicSession(session, { includeHistory: false });
}

function responseWorkspace(workspace: FigmaReplSessionWorkspace): FigmaReplPublicWorkspace {
  return {
    root: workspace.root,
    fileDir: workspace.fileDir,
    fileContext: workspace.fileContext,
    fileKey: workspace.fileKey,
    fileSlug: workspace.fileSlug,
    taskSlug: workspace.intentSlug,
    sessionDir: workspace.sessionDir,
    scriptPath: workspace.scriptPath,
    outputFilePath: workspace.resultFile,
    files: {
      inputFile: workspace.files.script,
      outputFile: workspace.files.result,
    },
  };
}

function responseScriptMetadata(
  metadata: Record<string, unknown>,
): Record<string, unknown> {
  return removeUndefined({
    scriptPath: metadata.scriptPath,
    targetPageId: metadata.targetPageId,
    expectedSurface: metadata.expectedSurface,
    injectedHelpers: metadata.injectedHelpers,
    helperUsage: metadata.helperUsage,
    compiledScriptBytes: metadata.compiledScriptBytes,
  }) as Record<string, unknown>;
}

function responseEvalSettingsFields(
  evalSettings: EvalSettings,
): Record<string, unknown> {
  return {
    upstreamTool: evalSettings.toolName,
    upstreamArgument: evalSettings.argumentName,
  };
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
    primaryFix: parsed.primaryFix,
  };
}

function responseUpstreamError(error: FigmaReplUpstreamError): Record<string, unknown> {
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

function upstreamEnvelope(
  parsed: ParsedUpstreamToolResult,
  options: { includePayload?: boolean } = {},
): Record<string, unknown> {
  const includePayload = options.includePayload ?? true;
  const ok = !parsed.upstreamError;
  if (parsed.json !== undefined) {
    return includePayload
      ? { kind: "json", ok, payload: parsed.json }
      : { kind: "json", ok };
  }
  return includePayload
    ? { kind: "text", ok, text: parsed.text || undefined }
    : { kind: "text", ok };
}

function publicSession(
  session: FigmaReplSession,
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

function cloneSession(session: FigmaReplSession): FigmaReplSession {
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

function mergeHandles(session: FigmaReplSession, handles: Record<string, string>): void {
  for (const [name, id] of Object.entries(handles)) {
    if (typeof id === "string" && id.length > 0) {
      session.handles[normalizeLocalHandleName(name)] = id;
    }
  }
  touchSession(session);
}

function normalizeLocalHandleName(name: string): string {
  return name.startsWith("$") ? name : `$${name}`;
}

function resolveSessionNodeInput(input: string | undefined, session: FigmaReplSession): string | undefined {
  return resolveSessionTargetInput(input, session).nodeId;
}

function resolveSessionTargetInput(input: unknown, session: FigmaReplSession): { nodeId?: string; handle?: string } {
  if (isRecord(input)) {
    const explicitHandle = asOptionalString(input.handle) ?? asOptionalString(input.targetHandle);
    const nodeValue =
      explicitHandle ??
      asOptionalString(input.nodeId) ??
      asOptionalString(input.targetNodeId) ??
      asOptionalString(input.target) ??
      asOptionalString(input.id) ??
      asOptionalString(input.url) ??
      asOptionalString(input.nodeUrl);
    return resolveSessionTargetInput(nodeValue, session);
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
    return { nodeId: fromUrl };
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

function buildFigmaNodeUrl(session: FigmaReplSession, nodeId: string): string | undefined {
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

function touchSession(session: FigmaReplSession): void {
  session.updatedAt = new Date().toISOString();
}

function sanitizeSessionId(sessionId: string): string {
  const value = sessionId.trim();
  if (!value) {
    return FIGMA_REPL_DEFAULT_SESSION_ID;
  }
  return value.slice(0, 120);
}

function makeJsonToolResult(value: unknown, extraContent: Array<Record<string, unknown>> = []): Record<string, unknown> {
  const structuredContent = removeUndefined(value);
  return {
    structuredContent,
    content: extraContent,
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
  surface?: FigmaReplSurface;
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

function inferFigmaSurface(fileUrl: string | undefined): FigmaReplSurface | undefined {
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

function normalizeSurface(value: unknown): FigmaReplSurface | undefined {
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
