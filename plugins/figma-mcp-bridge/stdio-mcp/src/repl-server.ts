import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve } from "node:path";
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
  throwIfFatalDiagnostics,
  type FigmaReplDiagnostic,
  type FigmaReplDiagnosticsOptions,
  type FigmaReplDiagnosticSeverity,
  type FigmaReplFileDiagnostic,
  type FigmaReplHelperProfile,
  type FigmaReplSurface,
} from "./repl-script-runner.js";
import {
  assertRequiredTitleArgument,
  asApplyAssetManifestArgs,
  asCallUpstreamToolArgs,
  asCaptureNodeArgs,
  asEvalArgs,
  asGuidanceArgs,
  asInspectArgs,
  asLookupArgs,
  asPrepareTaskArgs,
  asRunScriptFileArgs,
  asRunTaskPlanArgs,
  withDefaultTitle,
} from "./repl-tool-args.js";
import type {
  FigmaReplApplyAssetManifestArguments,
  FigmaReplCallUpstreamToolArguments,
  FigmaReplCaptureNodeArguments,
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
export type {
  FigmaReplDiagnostic,
  FigmaReplDiagnosticsOptions,
  FigmaReplDiagnosticSeverity,
  FigmaReplFileDiagnostic,
  FigmaReplHelperProfile,
  FigmaReplSurface,
};
export type { FigmaReplSessionWorkspace } from "./repl-workspace-files.js";
export type {
  FigmaReplApplyAssetManifestArguments,
  FigmaReplAssetManifestAsset,
  FigmaReplCallUpstreamToolArguments,
  FigmaReplCaptureNodeArguments,
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
const DEFAULT_EVAL_ARGUMENT_CANDIDATES = [
  "code",
  "script",
  "javascript",
  "js",
  "command",
];
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
  "inspect",
  "screenshot",
  "imageAsset",
  "checkpoint",
] as const;

type FigmaReplEvalCommonHelperName = (typeof FIGMA_REPL_EVAL_COMMON_HELPER_NAMES)[number];
type FigmaReplEvalHelperPath = "$" | `$.${FigmaReplEvalCommonHelperName}`;

const DEFAULT_HISTORY_LIMIT = 50;
const DEFAULT_INLINE_RESULT_LIMIT = 4_000;
const MAX_INLINE_RESULT_LIMIT = 1_000_000;
const DEFAULT_ASSET_TOOL_CANDIDATES = [
  "upload_assets",
  "upload_asset",
  "set_image_fill",
  "apply_image_asset",
];
const DEFAULT_SCREENSHOT_TOOL_CANDIDATES = [
  "get_screenshot",
  "capture_node_screenshot",
  "take_screenshot",
  "screenshot",
];
export interface FigmaReplMcpServerOptions extends RemoteMcpClientOptions {
  client?: FigmaMcpProxyClient;
  name?: string;
  version?: string;
  defaultSessionId?: string;
  evalToolName?: string;
  evalToolArgument?: string;
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

export interface FigmaReplClient {
  readonly client: FigmaMcpProxyClient;
  readonly sessions: FigmaReplSessionStore;
  connect(): Promise<void>;
  close(): Promise<void>;
  open(args?: FigmaReplOpenArguments): Promise<unknown>;
  eval(args: FigmaReplEvalArguments): Promise<unknown>;
  runScriptFile(args: FigmaReplRunScriptFileArguments): Promise<unknown>;
  applyAssetManifest(args: FigmaReplApplyAssetManifestArguments): Promise<unknown>;
  captureNode(args: FigmaReplCaptureNodeArguments): Promise<unknown>;
  runTaskPlan(args: FigmaReplRunTaskPlanArguments): Promise<unknown>;
  prepareTask(args: FigmaReplPrepareTaskArguments): Promise<unknown>;
  guidance(args: FigmaReplGuidanceArguments): Promise<unknown>;
  inspect(args?: FigmaReplInspectArguments): Promise<unknown>;
  callUpstreamTool(args: FigmaReplCallUpstreamToolArguments): Promise<unknown>;
  lookup(args: FigmaReplLookupArguments): Promise<unknown>;
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
  evalToolName?: string;
  evalToolArgument?: string;
  upstreamArguments: Record<string, unknown>;
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
  toolName?: string;
  argumentsTemplate?: Record<string, unknown>;
}

interface NormalizedAssetManifestAsset {
  path: string;
  targetNodeId: string;
  name?: string;
  metadata?: Record<string, unknown>;
  toolName?: string;
  arguments?: Record<string, unknown>;
}

interface FigmaReplRuntime {
  client: FigmaMcpProxyClient;
  sessions: FigmaReplSessionStore;
  upstreamToolCache: ReturnType<typeof createUpstreamToolCache>;
  config: { evalToolName: string; evalToolArgument?: string };
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
      upstreamArguments: {},
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
  const config = {
    evalToolName:
      options.evalToolName ?? process.env.FIGMA_REPL_EVAL_TOOL ?? DEFAULT_EVAL_TOOL_NAME,
    evalToolArgument:
      options.evalToolArgument ?? process.env.FIGMA_REPL_EVAL_TOOL_ARGUMENT,
  };

  return { client, sessions, upstreamToolCache, config };
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
      parseJsonToolResult(
        await handleOpen(withDefaultTitle(args, "Open Figma REPL session"), runtime),
      ),
    eval: async (args) =>
      parseJsonToolResult(
        await handleEval(
          asEvalArgs(withDefaultTitle(args, "Run Figma REPL JavaScript")),
          runtime,
        ),
      ),
    runScriptFile: async (args) =>
      executeRunScriptFile(
        asRunScriptFileArgs(withDefaultTitle(args, "Run Figma JavaScript file")),
        runtime,
      ),
    applyAssetManifest: async (args) =>
      executeApplyAssetManifest(
        asApplyAssetManifestArgs(withDefaultTitle(args, "Apply Figma asset manifest")),
        runtime,
      ),
    captureNode: async (args) =>
      executeCaptureNode(
        asCaptureNodeArgs(withDefaultTitle(args, "Capture Figma node")),
        runtime,
      ),
    runTaskPlan: async (args) =>
      executeRunTaskPlan(
        asRunTaskPlanArgs(withDefaultTitle(args, "Run Figma REPL task plan")),
        runtime,
      ),
    prepareTask: async (args) =>
      parseJsonToolResult(
        await handlePrepareTask(
          asPrepareTaskArgs(withDefaultTitle(args, "Prepare Figma REPL task")),
          { sessions: runtime.sessions },
        ),
      ),
    guidance: async (args) =>
      parseJsonToolResult(
        await handleGuidance(asGuidanceArgs(withDefaultTitle(args, "Read Figma REPL guidance"))),
      ),
    inspect: async (args = {}) =>
      parseJsonToolResult(
        await handleInspect(asInspectArgs(withDefaultTitle(args, "Inspect Figma REPL target")), runtime),
      ),
    callUpstreamTool: async (args) =>
      executeCallUpstreamTool(
        asCallUpstreamToolArgs(withDefaultTitle(args, "Call upstream Figma MCP tool")),
        runtime,
      ),
    lookup: async (args) =>
      parseJsonToolResult(
        await handleLookup(asLookupArgs(withDefaultTitle(args, "Look up Figma REPL reference"))),
      ),
  };
}

export function createFigmaReplMcpServer(
  options: FigmaReplMcpServerOptions = {},
): {
  server: Server;
  client: FigmaMcpProxyClient;
  sessions: FigmaReplSessionStore;
} {
  const runtime = createFigmaReplRuntime(options);
  const { client, sessions, upstreamToolCache, config } = runtime;

  const server = new Server(
    {
      name: options.name ?? "figma-repl-mcp",
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
    const args = asRecord(rawArgs);
    switch (request.params.name) {
      case "figma_repl_open":
        return handleOpen(args, { sessions, upstreamToolCache, config });
      case "figma_repl_eval":
        return handleEval(asEvalArgs(rawArgs), { client, sessions, upstreamToolCache, config });
      case "figma_repl_run_script_file":
        return handleRunScriptFile(asRunScriptFileArgs(rawArgs), {
          client,
          sessions,
          upstreamToolCache,
          config,
        });
      case "figma_repl_apply_asset_manifest":
        return handleApplyAssetManifest(asApplyAssetManifestArgs(rawArgs), {
          client,
          sessions,
          upstreamToolCache,
          config,
        });
      case "figma_repl_capture_node":
        return handleCaptureNode(asCaptureNodeArgs(rawArgs), {
          client,
          sessions,
          upstreamToolCache,
          config,
        });
      case "figma_repl_run_task_plan":
        return handleRunTaskPlan(asRunTaskPlanArgs(rawArgs), {
          client,
          sessions,
          upstreamToolCache,
          config,
        });
      case "figma_repl_prepare_task":
        return handlePrepareTask(asPrepareTaskArgs(rawArgs), { sessions });
      case "figma_repl_guidance":
        return handleGuidance(asGuidanceArgs(rawArgs));
      case "figma_repl_inspect":
        return handleInspect(asInspectArgs(rawArgs), { client, sessions, upstreamToolCache, config });
      case "figma_repl_call_upstream_tool":
        return handleCallUpstreamTool(asCallUpstreamToolArgs(rawArgs), {
          client,
          sessions,
          upstreamToolCache,
        });
      case "figma_repl_lookup":
        return handleLookup(asLookupArgs(rawArgs));
      default:
        throw new Error(`Unknown figma-repl-mcp tool: ${request.params.name}`);
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
          description: "Read only when you need discovery for explicit uncovered official upstream Figma MCP capabilities.",
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
    config: { evalToolName: string; evalToolArgument?: string };
  },
): Promise<Record<string, unknown>> {
  assertRequiredTitleArgument(args);
  const session = truthy(args.reset)
    ? runtime.sessions.reset(asOptionalString(args.sessionId))
    : runtime.sessions.getOrCreate(asOptionalString(args.sessionId));

  assignOptionalString(session, "label", args.label);
  assignOptionalString(session, "fileUrl", args.fileUrl);
  assignOptionalString(session, "currentPageId", args.currentPageId);
  assignOptionalString(session, "evalToolName", args.upstreamTool);
  assignOptionalString(session, "evalToolArgument", args.upstreamArgument);
  const fileKey = extractFigmaFileKey(session.fileUrl);
  if (fileKey) {
    session.fileKey = fileKey;
  }
  const expectedSurface = normalizeSurface(args.expectedSurface);
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
  if (isRecord(args.upstreamArguments)) {
    session.upstreamArguments = {
      ...session.upstreamArguments,
      ...args.upstreamArguments,
    };
  }
  if (isStringRecord(args.handles)) {
    mergeHandles(session, args.handles);
  }
  touchSession(session);

  let upstreamTools: UpstreamToolInfo[] | undefined;
  if (args.connect !== false) {
    upstreamTools = await runtime.upstreamToolCache.list(Boolean(args.refresh));
    const evalSettings = await resolveEvalSettings(session, args as Record<string, unknown>, runtime);
    session.evalToolName = evalSettings.toolName;
    session.evalToolArgument = evalSettings.argumentName;
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
    config: { evalToolName: string; evalToolArgument?: string };
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
    expectedSurface: normalizeSurface(args.expectedSurface) ?? session.surface,
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
  return makeJsonToolResult({
    ok: !parsed.upstreamError,
    session: responseSession(session),
    ...responseEvalSettingsFields(evalSettings),
    diagnostics: diagnosticsForResponse(diagnostics),
    ...upstreamResultFields({
      parsed,
      upstream,
    }),
    ...upstreamFailureFields(parsed),
  });
}

async function handleRunScriptFile(
  args: FigmaReplRunScriptFileArguments,
  runtime: FigmaReplRuntime,
): Promise<Record<string, unknown>> {
  return makeJsonToolResult(await executeRunScriptFile(args, runtime));
}

async function executeRunScriptFile(
  args: FigmaReplRunScriptFileArguments,
  runtime: {
    client: FigmaMcpProxyClient;
    sessions: FigmaReplSessionStore;
    upstreamToolCache: ReturnType<typeof createUpstreamToolCache>;
    config: { evalToolName: string; evalToolArgument?: string };
  },
): Promise<Record<string, unknown>> {
  assertRequiredTitleArgument(args);
  const session = runtime.sessions.getOrCreate(args.sessionId);
  const scriptPath = resolveScriptInputPath(args, session);
  const source = await readFile(scriptPath, "utf8");
  const expectedSurface = normalizeSurface(args.expectedSurface) ?? session.surface;
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
    helperProfile: args.helperProfile,
  });
  const wrappedScript = buildFigmaEvalScript({
    session,
    code: compiled.code,
    mode: "write",
    includeEvalHelpers: false,
  });
  const diagnostics = [
    ...compiled.diagnostics,
    ...diagnoseWrappedScriptSize(scriptPath, wrappedScript, Boolean(args.strict)),
  ];
  session.lastDiagnostics = diagnostics;
  throwIfFatalDiagnostics(diagnostics);
  const outputWriter = createScriptOutputWriter(args, session, formatScriptRunSummaryMarkdown);
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
      session: responseSession(session),
      ...responseEvalSettingsFields(evalSettings),
      diagnostics: diagnosticsForResponse(diagnostics),
      script: responseScript,
      upstreamError,
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
        ["upstreamError"],
      ),
    };
  }
  if (parsed.upstreamError) {
    const resultPayload = {
      ok: false,
      session: responseSession(session),
      ...responseEvalSettingsFields(evalSettings),
      diagnostics: diagnosticsForResponse(diagnostics),
      script: responseScript,
      ...upstreamResultFields({
        parsed,
        upstream,
      }),
      ...upstreamFailureFields(parsed),
    };
    const outputFiles = await outputWriter.write({
      result: withResultFileRaw(resultPayload, parsed),
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
    });
    return {
      ...limitInlineScriptResult(
        {
          ...resultPayload,
          outputFiles,
        },
        inlineResultLimit,
        ["result", "text", "upstreamError"],
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
    session: responseSession(session),
    ...responseEvalSettingsFields(evalSettings),
    diagnostics: diagnosticsForResponse(diagnostics),
    script: responseScript,
    ...upstreamResultFields({
      parsed,
      upstream,
    }),
  };
  const outputFiles = await outputWriter.write({
    result: withResultFileRaw(resultPayload, parsed),
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
  });
  return {
    ...limitInlineScriptResult(
      {
        ...resultPayload,
        outputFiles,
      },
      inlineResultLimit,
      ["result", "text"],
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
  const tools = await runtime.upstreamToolCache.list(Boolean(args.refresh));
  const failures: Array<Record<string, unknown>> = [];
  const assetResults: Array<Record<string, unknown>> = [];
  await runtime.client.connect();

  for (const asset of manifest.assets) {
    const tool = selectUpstreamTool({
      tools,
      explicitToolName: asset.toolName ?? manifest.toolName,
      candidates: DEFAULT_ASSET_TOOL_CANDIDATES,
      kind: "asset upload/fill",
    });
      const upstreamArguments = buildAssetManifestUpstreamArguments({
        asset,
        tool,
        template: asset.arguments ?? manifest.argumentsTemplate,
      });
      const startedAt = new Date().toISOString();
      try {
        const upstream = await runtime.client.callTool(tool.name, upstreamArguments);
        const parsed = parseUpstreamToolResult(upstream);
        const fullResult = {
          ...upstreamResultFields({ parsed, upstream }),
          ...upstreamFailureFields(parsed),
        };
        const upload = parsed.upstreamError
          ? undefined
          : await submitLocalAssetUploadIfAvailable(asset, parsed);
        const ok = !parsed.upstreamError && upload?.ok !== false;
        const entry = {
          ok,
          path: asset.path,
          targetNodeId: asset.targetNodeId,
          name: asset.name,
          metadata: asset.metadata,
          toolName: tool.name,
          arguments: upstreamArguments,
          result: upload ? { ...fullResult, upload } : fullResult,
          startedAt,
          finishedAt: new Date().toISOString(),
        };
      assetResults.push(entry);
      if (!ok) {
        failures.push({
          path: asset.path,
          targetNodeId: asset.targetNodeId,
          toolName: tool.name,
          error: parsed.upstreamError,
        });
      }
    } catch (error) {
      const upstreamError = normalizeCaughtUpstreamError(error);
      const entry = {
        ok: false,
        path: asset.path,
        targetNodeId: asset.targetNodeId,
        name: asset.name,
        metadata: asset.metadata,
        toolName: tool.name,
        arguments: upstreamArguments,
        error: upstreamError,
        startedAt,
        finishedAt: new Date().toISOString(),
      };
      assetResults.push(entry);
      failures.push({
        path: asset.path,
        targetNodeId: asset.targetNodeId,
        toolName: tool.name,
        error: upstreamError,
      });
    }
  }

  const resultFile = resolveWorkspaceAwareFile(args.resultFile ?? args.outputFile, session, "resultFile/outputFile");
  const files: Record<string, unknown> = {};
  const validation = await validateAssetManifestTargetsIfAvailable({
    args,
    session,
    runtime,
    tools,
    assetResults,
  });
  const ok = failures.length === 0 && validation.ok !== false;
  const payload = {
    ok,
    assets: assetResults,
    validation,
    failures: failures.length > 0 ? failures : undefined,
  };
  if (resultFile) {
    files.resultFile = await writeJsonFile(resultFile, payload);
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

async function handleCaptureNode(
  args: FigmaReplCaptureNodeArguments,
  runtime: FigmaReplRuntime,
): Promise<Record<string, unknown>> {
  return makeJsonToolResult(await executeCaptureNode(args, runtime));
}

async function executeCaptureNode(
  args: FigmaReplCaptureNodeArguments,
  runtime: FigmaReplRuntime,
): Promise<Record<string, unknown>> {
  assertRequiredTitleArgument(args);
  const nodeId = asOptionalString(args.nodeId) ?? asOptionalString(args.targetNodeId);
  if (!nodeId) {
    throw new Error('Tool argument "nodeId" or "targetNodeId" is required and must be a string.');
  }
  const session = runtime.sessions.getOrCreate(args.sessionId);
  const outputFile = resolveRequiredWorkspaceAwareFile(args.outputFile, session, "outputFile");
  const resultFile = resolveWorkspaceAwareFile(args.resultFile, session, "resultFile");
  const tools = await runtime.upstreamToolCache.list(Boolean(args.refresh));
  const tool = selectUpstreamTool({
    tools,
    explicitToolName: args.toolName,
    candidates: DEFAULT_SCREENSHOT_TOOL_CANDIDATES,
    kind: "node screenshot",
  });
  const upstreamArguments = buildCaptureUpstreamArguments({
    nodeId,
    template: args.arguments ?? args.argumentsTemplate,
    tool,
  });
  await runtime.client.connect();
  const upstream = await runtime.client.callTool(tool.name, upstreamArguments);
  const parsed = parseUpstreamToolResult(upstream);
  if (parsed.upstreamError) {
    const outputFiles: Record<string, unknown> = {};
    const payload = {
      ok: false,
      file: outputFile,
      nodeId,
      toolName: tool.name,
      ...upstreamResultFields({ parsed, upstream }),
      ...upstreamFailureFields(parsed),
    };
    if (resultFile) {
      outputFiles.resultFile = await writeJsonFile(resultFile, payload);
    }
    return {
      ...payload,
      outputFiles: Object.keys(outputFiles).length > 0 ? outputFiles : undefined,
    };
  }
  const saved = await writeCaptureOutputFile(outputFile, upstream, parsed);
  const outputFileMetadata = {
    path: outputFile,
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
    summary: `Captured node ${nodeId} to ${outputFile}.`,
    nodeIds: [nodeId],
  });
  const payload = {
    ok: true,
    file: outputFile,
    nodeId,
    toolName: tool.name,
    kind: saved.kind,
    mimeType: saved.mimeType,
    bytes: saved.bytes,
    lineCount: saved.lineCount,
    width: saved.width,
    height: saved.height,
    sourceUrl: saved.sourceUrl,
    qa: createCaptureQa(saved),
    ...upstreamResultFields({ parsed, upstream }),
  };
  if (resultFile) {
    outputFiles.resultFile = await writeJsonFile(resultFile, payload);
  }
  return {
    ...payload,
    outputFiles,
  };
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
        runtime,
      });
      const ok = taskPlanStepSucceeded(result);
      const status = ok ? "completed" : "failed";
      steps.push({
        id,
        index,
        type,
        status,
        ok,
        summary: summarizeTaskPlanStepResult(result),
        finishedAt: new Date().toISOString(),
        startedAt,
      });
      if (!ok && stopOnFailure) {
        stopped = true;
        break;
      }
    } catch (error) {
      const upstreamError = normalizeCaughtUpstreamError(error);
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
    stopped,
    stopOnFailure,
    steps,
    failures: failures.length > 0 ? failures : undefined,
  };
  const outputFiles = {
    resultFile: await writeJsonFile(resultFile, payload),
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
  applyWorkspaceFileContextArgs(session, args);
  const intentSlug = deriveIntentSlug(args, "figma-task");
  const fileSlug = deriveFileSlug(args, session);
  const workspace = resolvePrepareTaskWorkspace(args, intentSlug, fileSlug, session);
  if (session) {
    session.workspace = workspace;
    touchSession(session);
  }
  const workspaceDir = workspace.fileDir;
  const scriptName = normalizeTaskScriptName(args.fileName ?? args.scriptName ?? workspace.files.script, intentSlug);
  const scriptPath = resolveWorkspaceFile(workspace.sessionDir, scriptName, "fileName/scriptName");
  const resultFile = resolveWorkspaceFile(workspace.sessionDir, resultFileNameForScript(scriptName), "resultFile");

  await ensureWorkspaceDirectories(workspace);
  await writeTaskFile(scriptPath, createTaskScriptTemplate(intentSlug, args), Boolean(args.overwrite));
  const resultFileMetadata = await writeTaskFile(resultFile, JSON.stringify({
    ok: null,
    status: "pending",
    sessionId: session?.id,
    fileKey: session?.fileKey ?? workspace.fileKey,
    fileContext: workspace.fileContext,
    intentSlug,
    scriptFile: scriptName,
    goal: args.goal,
  }, null, 2) + "\n", Boolean(args.overwrite));
  return makeJsonToolResult({
    ok: true,
    session: session ? responseSession(session) : undefined,
    task: {
      slug: intentSlug,
      intentSlug,
      fileContext: workspace.fileContext,
      fileDir: workspace.fileDir,
      workspaceDir,
      taskDir: workspaceDir,
      workspace,
      scriptPath,
      resultFile: resultFileMetadata,
      overwritten: Boolean(args.overwrite),
    },
    next: [
      "Edit the .figma.js file in this task folder.",
      "Dry-run with figma_repl_run_script_file before upstream execution.",
      "Read the paired .result.json file for diagnostics, summaries, and large results.",
    ],
  });
}

function resolvePrepareTaskWorkspace(
  args: FigmaReplPrepareTaskArguments,
  intentSlug: string,
  fileSlug: string,
  session: FigmaReplSession | undefined,
): FigmaReplSessionWorkspace {
  if (typeof args.cwd === "string" && args.cwd.length > 0) {
    if (!isAbsolute(args.cwd)) {
      throw new Error('Tool argument "cwd" must be an absolute path.');
    }
    return createSessionWorkspace({
      cwd: args.cwd,
      dirName: args.dirName,
      fileKey: session?.fileKey ?? args.fileKey,
      fileSlug,
      intentSlug,
    });
  }
  const hasFileContext = Boolean(args.fileUrl || args.fileKey || args.fileSlug || args.dirName);
  const hasExplicitTaskWorkspace = Boolean(args.taskDir || args.workspaceDir || args.taskRoot);
  if (hasFileContext && !session?.workspace && !hasExplicitTaskWorkspace) {
    return createSessionWorkspace({
      cwd: process.cwd(),
      dirName: args.dirName,
      fileKey: session?.fileKey ?? args.fileKey,
      fileSlug,
      intentSlug,
    });
  }
  return resolvePreparedTaskWorkspace({
    args,
    taskSlug: intentSlug,
    fileSlug,
    session,
  });
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
        "Call figma_repl_run_script_file with dryRun=true, strict=true, expectedSurface, inputFile, and inlineResultLimit.",
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
): { name: "intent" | "task" | "goal"; value: string } | undefined {
  if (typeof args.intent === "string") {
    return { name: "intent", value: args.intent };
  }
  if (typeof args.task === "string") {
    return { name: "task", value: args.task };
  }
  if (typeof args.goal === "string") {
    return { name: "goal", value: args.goal };
  }
  return undefined;
}

async function handleInspect(
  args: FigmaReplInspectArguments,
  runtime: {
    client: FigmaMcpProxyClient;
    sessions: FigmaReplSessionStore;
    upstreamToolCache: ReturnType<typeof createUpstreamToolCache>;
    config: { evalToolName: string; evalToolArgument?: string };
  },
): Promise<Record<string, unknown>> {
  assertRequiredTitleArgument(args);
  if (args.mode === "validate") {
    return makeJsonToolResult(await executeValidateHandles(args, runtime));
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

async function executeValidateHandles(
  args: FigmaReplInspectArguments,
  runtime: {
    client: FigmaMcpProxyClient;
    sessions: FigmaReplSessionStore;
    upstreamToolCache: ReturnType<typeof createUpstreamToolCache>;
    config: { evalToolName: string; evalToolArgument?: string };
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
      `Refusing to proxy local figma-repl-mcp tool "${args.toolName}". Call it directly instead.`,
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
  return {
    ok: !parsed.upstreamError,
    toolName: args.toolName,
    ...upstreamResultFields({
      parsed,
      upstream,
    }),
    ...upstreamFailureFields(parsed),
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
    config: { evalToolName: string; evalToolArgument?: string };
  },
): Promise<EvalSettings> {
  const toolName =
    asOptionalString(args.upstreamTool) ??
    session.evalToolName ??
    runtime.config.evalToolName;
  const tools = await runtime.upstreamToolCache.list(false);
  const tool = tools.find((item) => item.name === toolName);
  if (!tool) {
    throw new Error(
      `Upstream Figma MCP tool "${toolName}" was not found. Available tools: ${tools.map((item) => item.name).join(", ")}`,
    );
  }
  const argumentName =
    asOptionalString(args.upstreamArgument) ??
    session.evalToolArgument ??
    runtime.config.evalToolArgument ??
    inferEvalArgumentName(tool) ??
    "code";
  const upstreamArguments = {
    ...session.upstreamArguments,
    ...(isRecord(args.upstreamArguments) ? args.upstreamArguments : {}),
  };
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
  session.evalToolName = toolName;
  session.evalToolArgument = argumentName;
  session.upstreamArguments = upstreamArguments;
  touchSession(session);
  return { toolName, argumentName, upstreamArguments };
}

function inferEvalArgumentName(tool: UpstreamToolInfo): string | undefined {
  const schema = isRecord(tool.inputSchema) ? tool.inputSchema : undefined;
  const properties = isRecord(schema?.properties) ? schema?.properties : undefined;
  if (!properties) {
    return undefined;
  }
  for (const candidate of DEFAULT_EVAL_ARGUMENT_CANDIDATES) {
    if (candidate in properties) {
      return candidate;
    }
  }
  const stringProperty = Object.entries(properties).find(([, value]) => {
    const schemaValue = isRecord(value) ? value : undefined;
    return schemaValue?.type === "string";
  });
  return stringProperty?.[0];
}

export function buildFigmaEvalScript(options: {
  session: Pick<FigmaReplSession, "id" | "handles" | "currentPageId" | "fileUrl" | "fileKey" | "surface" | "knownPages">;
  code: string;
  mode?: "read" | "write";
  includeEvalHelpers?: boolean;
}): string {
  return `${createFigmaReplPrelude(options.session, options.mode ?? "write", options.includeEvalHelpers !== false)}
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
): string {
  return `const __figmaRepl = {
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
  return {
    assets: rawAssets.map((asset, index) => normalizeManifestAsset(asset, index, baseDir)),
    toolName: asOptionalString(args.toolName) ?? asOptionalString(manifestRecord.toolName),
    argumentsTemplate: recordFromUnknown(
      args.argumentsTemplate ??
      args.arguments ??
      manifestRecord.argumentsTemplate ??
      manifestRecord.arguments,
    ),
  };
}

function normalizeManifestAsset(
  value: unknown,
  index: number,
  baseDir: string | undefined,
): NormalizedAssetManifestAsset {
  const record = asRecord(value);
  const rawPath =
    asOptionalString(record.path) ??
    asOptionalString(record.filePath) ??
    asOptionalString(record.localPath);
  if (!rawPath) {
    throw new Error(`Asset manifest entry ${index} requires path, filePath, or localPath.`);
  }
  const path = isAbsolute(rawPath)
    ? rawPath
    : baseDir
      ? resolve(baseDir, rawPath)
      : undefined;
  if (!path) {
    throw new Error(`Asset manifest entry ${index} path must be absolute unless manifestPath is used.`);
  }
  const targetNodeId =
    asOptionalString(record.targetNodeId) ??
    asOptionalString(record.nodeId);
  if (!targetNodeId) {
    throw new Error(`Asset manifest entry ${index} requires targetNodeId or nodeId.`);
  }
  return {
    path,
    targetNodeId,
    name: asOptionalString(record.name),
    metadata: recordFromUnknown(record.metadata),
    toolName: asOptionalString(record.toolName),
    arguments: recordFromUnknown(record.arguments),
  };
}

function selectUpstreamTool(options: {
  tools: UpstreamToolInfo[];
  explicitToolName?: string;
  candidates: string[];
  kind: string;
}): UpstreamToolInfo {
  if (options.explicitToolName) {
    const tool = options.tools.find((item) => item.name === options.explicitToolName);
    if (!tool) {
      throw new Error(
        `Upstream Figma MCP ${options.kind} tool "${options.explicitToolName}" was not found. Available tools: ${options.tools.map((item) => item.name).join(", ")}`,
      );
    }
    return tool;
  }
  const tool = options.candidates
    .map((name) => options.tools.find((item) => item.name === name))
    .find((item): item is UpstreamToolInfo => item !== undefined);
  if (!tool) {
    throw new Error(
      `Tool argument "toolName" is required because no recognizable upstream ${options.kind} tool was advertised. Available tools: ${options.tools.map((item) => item.name).join(", ")}`,
    );
  }
  return tool;
}

function buildAssetManifestUpstreamArguments(options: {
  asset: NormalizedAssetManifestAsset;
  tool: UpstreamToolInfo;
  template?: Record<string, unknown>;
}): Record<string, unknown> {
  const context = createAssetTemplateContext(options.asset);
  if (options.template) {
    return expandTemplateObject(options.template, context);
  }
  const properties = inputSchemaProperties(options.tool.inputSchema);
  if (properties.assets) {
    return {
      assets: [
        {
          path: options.asset.path,
          filePath: options.asset.path,
          targetNodeId: options.asset.targetNodeId,
          nodeId: options.asset.targetNodeId,
          name: options.asset.name,
          metadata: options.asset.metadata,
        },
      ],
    };
  }
  const result: Record<string, unknown> = {};
  assignFirstKnownProperty(result, properties, ["path", "filePath", "localPath"], options.asset.path);
  assignFirstKnownProperty(result, properties, ["targetNodeId", "nodeId", "target", "targetId"], options.asset.targetNodeId);
  assignFirstKnownProperty(result, properties, ["name"], options.asset.name);
  assignFirstKnownProperty(result, properties, ["metadata"], options.asset.metadata);
  if (Object.keys(result).length >= 2) {
    return result;
  }
  throw new Error(
    `Asset manifest entry for "${options.asset.path}" needs an arguments template because upstream tool "${options.tool.name}" input schema is not recognizable.`,
  );
}

function buildCaptureUpstreamArguments(options: {
  nodeId: string;
  template?: Record<string, unknown>;
  tool: UpstreamToolInfo;
}): Record<string, unknown> {
  const context = {
    nodeId: options.nodeId,
    targetNodeId: options.nodeId,
  };
  if (options.template) {
    return expandTemplateObject(options.template, context);
  }
  const properties = inputSchemaProperties(options.tool.inputSchema);
  const result: Record<string, unknown> = {};
  assignFirstKnownProperty(result, properties, ["nodeId", "targetNodeId", "target", "id"], options.nodeId);
  if (Object.keys(result).length > 0) {
    return result;
  }
  throw new Error(
    `Screenshot capture needs an arguments template because upstream tool "${options.tool.name}" input schema is not recognizable.`,
  );
}

function createAssetTemplateContext(asset: NormalizedAssetManifestAsset): Record<string, unknown> {
  return {
    path: asset.path,
    filePath: asset.path,
    localPath: asset.path,
    targetNodeId: asset.targetNodeId,
    nodeId: asset.targetNodeId,
    name: asset.name,
    metadata: asset.metadata,
    asset,
  };
}

function expandTemplateObject(
  template: Record<string, unknown>,
  context: Record<string, unknown>,
): Record<string, unknown> {
  return expandTemplateValue(template, context) as Record<string, unknown>;
}

function expandTemplateValue(value: unknown, context: Record<string, unknown>): unknown {
  if (typeof value === "string") {
    const exact = /^\{\{\s*([^}]+?)\s*\}\}$/u.exec(value);
    if (exact) {
      return readTemplatePath(context, exact[1].trim());
    }
    return value.replace(/\{\{\s*([^}]+?)\s*\}\}/gu, (_match, path: string) => {
      const resolved = readTemplatePath(context, path.trim());
      if (resolved === undefined || resolved === null) {
        return "";
      }
      return typeof resolved === "string" ? resolved : JSON.stringify(resolved);
    });
  }
  if (Array.isArray(value)) {
    return value.map((item) => expandTemplateValue(item, context));
  }
  if (isRecord(value)) {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, expandTemplateValue(item, context)]),
    );
  }
  return value;
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

function inputSchemaProperties(inputSchema: unknown): Record<string, unknown> {
  return asRecord(asRecord(inputSchema).properties);
}

function assignFirstKnownProperty(
  target: Record<string, unknown>,
  properties: Record<string, unknown>,
  names: string[],
  value: unknown,
): void {
  if (value === undefined) {
    return;
  }
  const name = names.find((candidate) => properties[candidate] !== undefined);
  if (name) {
    target[name] = value;
  }
}

async function validateAssetManifestTargetsIfAvailable(options: {
  args: FigmaReplApplyAssetManifestArguments;
  session: FigmaReplSession;
  runtime: {
    client: FigmaMcpProxyClient;
    sessions: FigmaReplSessionStore;
    upstreamToolCache: ReturnType<typeof createUpstreamToolCache>;
    config: { evalToolName: string; evalToolArgument?: string };
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
  const preferredEvalTool = options.session.evalToolName ?? options.runtime.config.evalToolName ?? DEFAULT_EVAL_TOOL_NAME;
  const hasEvalTool = options.tools.some((tool) => tool.name === preferredEvalTool || tool.name === DEFAULT_EVAL_TOOL_NAME);
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
        error: parsed.upstreamError,
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
      error: normalizeCaughtUpstreamError(error),
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
  runtime: {
    client: FigmaMcpProxyClient;
    sessions: FigmaReplSessionStore;
    upstreamToolCache: ReturnType<typeof createUpstreamToolCache>;
    config: { evalToolName: string; evalToolArgument?: string };
  };
}): Promise<Record<string, unknown>> {
  const rawStepArgs = taskPlanStepArguments(options.step);
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
  return {
    ...Object.fromEntries(
      Object.entries(step).filter(([key]) =>
        !["id", "type", "tool", "args"].includes(key),
      ),
    ),
    ...asRecord(step.args),
  };
}

function normalizeTaskPlanStepType(step: FigmaReplTaskPlanStep): string {
  const value = asOptionalString(step.type) ?? asOptionalString(step.tool);
  return normalizeTaskPlanStepTypeAlias(value);
}

function taskPlanStepSucceeded(result: Record<string, unknown>): boolean {
  if (result.ok === false) {
    return false;
  }
  const nestedResult = asRecord(result.result);
  if (nestedResult.ok === false) {
    return false;
  }
  return true;
}

function summarizeTaskPlanStepResult(result: Record<string, unknown>): Record<string, unknown> {
  return {
    ok: result.ok !== false,
    file: result.file,
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
    upstreamError: options.upstreamError,
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
  const omitted: Array<{ field: string; bytes: number; limit: number }> = [];
  for (const field of fields) {
    if (result[field] === undefined) {
      continue;
    }
    const bytes = Buffer.byteLength(JSON.stringify(removeUndefined(result[field])), "utf8");
    if (bytes > limit) {
      delete result[field];
      omitted.push({ field, bytes, limit });
    }
  }
  if (omitted.length > 0) {
    result.inlineResultLimit = {
      limit,
      omitted,
      guidance: "Read the paired result file or resultFile output when inline fields are omitted.",
    };
  }
  return result;
}

function normalizeInlineResultLimit(value: unknown): number | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  const number = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(number) || number < 0) {
    throw new Error('Tool argument "inlineResultLimit" must be a non-negative number.');
  }
  return Math.min(Math.floor(number), MAX_INLINE_RESULT_LIMIT);
}

function applyWorkspaceFileContextArgs(
  session: FigmaReplSession | undefined,
  args: { fileUrl?: string; fileKey?: string; expectedSurface?: FigmaReplSurface },
): void {
  if (!session) {
    return;
  }
  assignOptionalString(session, "fileUrl", args.fileUrl);
  assignOptionalString(session, "fileKey", args.fileKey);
  const derivedFileKey = extractFigmaFileKey(session.fileUrl);
  if (!session.fileKey && derivedFileKey) {
    session.fileKey = derivedFileKey;
  }
  const expectedSurface = normalizeSurface(args.expectedSurface);
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
  args: { fileUrl?: string; fileKey?: string; fileSlug?: string },
  session?: FigmaReplSession,
): string {
  return slugifyTaskName(
    args.fileSlug ??
    args.fileKey ??
    extractFigmaFileKey(args.fileUrl) ??
    session?.fileKey ??
    extractFigmaFileSlug(args.fileUrl ?? session?.fileUrl) ??
    session?.slug ??
    "figma-file",
  );
}

function deriveIntentSlug(
  args: {
    intent?: string;
    task?: string;
    title?: string;
    sessionId?: string;
    taskSlug?: string;
    taskName?: string;
    goal?: string;
  },
  fallback: string,
): string {
  return slugifyTaskName(
    args.intent ??
    args.task ??
    args.taskSlug ??
    args.taskName ??
    args.title ??
    args.sessionId ??
    args.goal ??
    fallback,
  );
}

function createTaskScriptTemplate(taskSlug: string, args: FigmaReplPrepareTaskArguments): string {
  return [
    `// ${taskSlug}.figma.js`,
    "// Async Figma Plugin API body for figma_repl_run_script_file.",
    "// Use $ helpers plus native Figma Plugin API calls and return compact JSON.",
    args.goal ? `// Goal: ${String(args.goal)}` : undefined,
    args.expectedSurface ? `// Expected surface: ${String(args.expectedSurface)}` : undefined,
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
    workspaceLayout: "<cwd>/figma-mcp/<fileKey-or-fileSlug>/<intentSlug>.figma.js + <intentSlug>.result.json",
    outputFiles: ["inputFile", "outputFile", "inlineResultLimit"],
    workflowTools: ["figma_repl_apply_asset_manifest", "figma_repl_capture_node", "figma_repl_run_task_plan"],
    helpers: createEvalHelperPathList(),
    defaultTaskRoot: `${TASK_WORKSPACE_ROOT_ENV}, then OS temp figma-repl-mcp/tasks/<slug>`,
    guidance: [
      "Keep non-trivial Plugin API work in local .figma.js files.",
      "Initialize a file workspace once, then keep intent script/result pairs in that file-context folder.",
      "Run dryRun first for file-aware diagnostics without upstream calls.",
      "Keep each .figma.js transaction below the upstream code payload limit; split large screens into skeleton, asset-target, upload-fill, and fix scripts.",
      "helperProfile defaults to auto: common helpers are always available, while heavy $.imageAsset and $.cloneNodeTree helpers are injected only when the script source uses them.",
      "Use $ helpers for common edits and native Figma Plugin API calls for advanced work.",
      "Use $.imageAsset({ base64, parent, size, position, as }) for small generated PNG/JPEG assets. For large assets, create target rectangles in .figma.js and route through official upload_assets/upstream asset fill workflow to avoid MCP payload limits.",
      "Use figma_repl_apply_asset_manifest for target-rectangle plus local-file asset upload/fill orchestration when large assets should stay out of script payloads; target image fills are validated when upstream eval is available.",
      "Use figma_repl_capture_node to write final visual QA captures to a local file; it returns bytes, MIME, dimensions when detectable, sourceUrl, and QA warnings.",
      "Use figma_repl_run_task_plan for sequential file-plan workflows that combine dry-runs, script execution, manifest application, captures, and upstream calls; initialized workspaces get default step output files.",
      "Use $.cloneNodeTree for side-by-side copy workflows that need outer-to-inner cloning and preserved instance subtrees.",
      "Use <intentSlug>.result.json as the default complete output. Only pass diagnosticsFile or summaryFile when a task explicitly needs split files.",
      "Responses use the fixed structured shape: parsed upstream JSON stays in result, non-JSON upstream output falls back to text, diagnostics are arrays, and file pointers stay in outputFiles.",
      "When non-dry-run upstream execution fails, outputFiles.compiledScriptFile points to the compiled JavaScript wrapper for line-aware repair; normal dry-runs and successful executions do not return compiledScript.",
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

function createCapabilitiesPayload(): Record<string, unknown> {
  return {
    guide: {
      purpose: "Unified Figma-facing MCP facade for agents after OAuth registration. Stay inside figma-repl-mcp; it keeps local session metadata/handles and can bridge to upstream Figma MCP tools through explicit REPL tools.",
      preferredFlow: [
        "Read figma-repl://capabilities to choose the facade path",
        "figma_repl_prepare_task with an absolute cwd, fileUrl or fileKey, and an intent for repairable .figma.js workspaces",
        "figma_repl_guidance with mode=plan for workflow planning or mode=guidance/card/catalog for compact local API cards",
        "figma_repl_open with fileUrl and expectedSurface for stateful Plugin API work",
        "figma_repl_inspect with mode=inspect or mode=validate before mutation",
        "figma_repl_run_script_file with inputFile and dryRun=true for primary .figma.js workflows, output files, and line-aware repair",
        "figma_repl_apply_asset_manifest for large generated assets: create target rectangles in script, then upload/fill from local files through a manifest",
        "figma_repl_capture_node for final visual QA captures saved to local files",
        "figma_repl_run_task_plan for sequential file plans that combine script dry-runs/exec, asset manifests, captures, and upstream tool calls",
        "figma_repl_call_upstream_tool when a task explicitly needs an upstream Figma MCP tool",
      ],
      handles: "Use stable local handles like $card instead of carrying JS object references between calls.",
      upstreamBridge: "The REPL can call upstream tools through figma_repl_call_upstream_tool while keeping the agent on the figma-repl-mcp interface.",
      responseShape: "Fixed structured payloads without session.history; parsed upstream JSON is returned as result, text is returned only when JSON is unavailable, and raw upstream payloads are written only to output/result files with metadata pointers.",
    },
    patterns: {
      text: "Use $.text, or call figma.loadFontAsync before mutating characters/fontName in native Plugin API code.",
      createUi: "Use $.create for common Design nodes and native Plugin API calls for advanced construction.",
      transaction: "Use dryRun=true first, then execute the same .figma.js file; add $.checkpoint calls before/after meaningful batches to return handle and node summaries.",
      clone: "Use $.cloneNodeTree to copy a node to the side; it clones outer-to-inner and preserves instance subtrees whole when children cannot be rebuilt.",
      designSystem: "Use native Plugin API calls in .figma.js for variables/styles/components; use explicit REPL upstream calls only when a task requires them.",
      query: "Use figma_repl_guidance first for natural-language tasks; it returns recommendedCards, queryHints, apiSymbols, avoid, and compact referenceContext. Prefer findOne/query scoped to currentPage or a handle; figma.root.findAll is blocked.",
      pages: "Use targetPageId or one setCurrentPageAsync call; direct figma.currentPage assignment is blocked.",
      selection: "Use $.select instead of direct figma.currentPage.selection access in repairable scripts.",
      validation: "Use figma_repl_inspect mode=validate before mutating cached handles from an earlier call.",
    },
    safety: {
      fatalDiagnosticsBlock: true,
      warningsReturnWithResult: true,
      allowDangerousOperations: "Bypasses only dynamic/destructive guards. It does not bypass API contract, surface, or read-mode guards.",
      diagnosticShape: "{ code, severity, message, suggestion, docsHint }",
      upstreamFailureShape: "{ ok:false, upstreamError:{ message, code?, details?, text?, parsed? }, primaryFix }",
    },
    scriptWorkflow: {
      primaryTool: "figma_repl_run_script_file",
      scriptShape: "Write an async function body in a local .figma.js file. The runner injects Figma REPL prelude plus $ helpers before upstream use_figma execution.",
      requiredArguments: ["title", "scriptPath or inputFile"],
      options: {
        scriptPath: "Absolute path escape hatch. Prefer inputFile after figma_repl_prepare_task.",
        inputFile: "File name inside <cwd>/figma-mcp/<fileKey-or-fileSlug>/ after workspace initialization.",
        dryRun: "Read, diagnose, inject helpers, and return script metadata without calling upstream Figma.",
        strict: "Promote warnings to fatal diagnostics.",
        expectedSurface: "design, figjam, or slides; blocks obvious wrong-surface API usage.",
        targetPageId: "Switch once to a known page before the script body runs.",
        allowDangerousOperations: "Bypasses only dynamic/destructive guards after exact file review.",
        helperProfile: "auto, minimal, asset, clone, or full. Defaults to auto to keep upstream payloads smaller while injecting heavy helpers only when source uses them.",
        outputFile: "File name inside the initialized file-context folder. Defaults to the input script basename plus .result.json.",
        outputDir: "Advanced absolute directory escape hatch for split output files.",
        resultFile: "Advanced absolute file path, outputDir-relative JSON path, or file-context-folder file name for complete structured result output.",
        diagnosticsFile: "Advanced optional JSON file when diagnostics must be split out of the paired result file.",
        summaryFile: "Advanced optional Markdown file when a separate summary is required.",
        inlineResultLimit: "Non-negative byte cap for large inline fields; omitted fields stay available in the paired result file.",
      },
      helpers: createEvalHelperDescriptionsPayload(),
    },
    fileWorkflow: createFileWorkflowPayload(),
    workflowTools: {
      resource: "figma-repl://workflow-tools",
      assetManifest: {
        tool: "figma_repl_apply_asset_manifest",
        purpose: "Apply local generated image files to pre-created target nodes through configurable upstream asset/upload tools.",
        assetShape: "{ path|filePath|localPath, targetNodeId|nodeId, name?, metadata?, toolName?, arguments? }",
        defaults: "Uses explicit toolName/arguments templates when provided; otherwise selects an advertised asset-like upstream tool and only infers arguments from recognizable input schema fields.",
        validation: "validateTargets defaults on; when upstream eval is available, target nodes are checked for IMAGE fills after upload.",
      },
      capture: {
        tool: "figma_repl_capture_node",
        purpose: "Call an upstream screenshot/capture tool and save image, screenshot URL payload, or text response to outputFile for final visual QA.",
        defaulting: "Uses explicit toolName/arguments templates when provided; otherwise selects an advertised screenshot-like upstream tool and infers node id only from recognizable schema fields.",
        metadata: "Returns kind, mimeType, bytes, width/height when detectable, sourceUrl when downloaded, qa warnings, and optional resultFile metadata.",
      },
      taskPlan: {
        tool: "figma_repl_run_task_plan",
        stepTypes: ["script-file", "asset-manifest", "screenshot-capture", "upstream-tool"],
        defaultFailureMode: "stopOnFailure=true",
        result: "Writes a compact plan result JSON and returns per-step status summaries. In initialized workspaces, missing step outputs default to <step-id>.result.json, <step-id>.assets.result.json, and <step-id>.png plus <step-id>.capture.result.json.",
      },
    },
    queryStrategy: {
      tool: "figma_repl_guidance",
      resource: "figma-repl://intents",
      searchAnchors: FIGMA_REPL_QUERY_SEARCH_ANCHORS,
      flow: [
        "Describe the user task in task or intent.",
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
      "Keep the agent on figma-repl-mcp; use figma_repl_call_upstream_tool only for explicit upstream-tool calls.",
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
            tools,
            guidance: "Read-only discovery for official upstream Figma MCP tools. Call figma_repl_call_upstream_tool only for an explicit uncovered upstream capability.",
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
    return "Use $.cloneNodeTree({ source, placement: 'right' }) so instance subtrees are preserved whole instead of manually removing/rebuilding their children.";
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

function responseScriptMetadata(
  metadata: Record<string, unknown>,
): Record<string, unknown> {
  return metadata;
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
  const fields: Record<string, unknown> = {};
  if (options.parsed.json !== undefined) {
    fields.result = options.parsed.json;
  }
  if (options.parsed.json === undefined) {
    fields.text = options.parsed.text || undefined;
  }
  return fields;
}

function withResultFileRaw(
  payload: Record<string, unknown>,
  parsed: ParsedUpstreamToolResult,
): Record<string, unknown> {
  return {
    ...payload,
    raw: parsed.json !== undefined ? parsed.json : parsed.text,
  };
}

function upstreamFailureFields(parsed: ParsedUpstreamToolResult): Record<string, unknown> {
  return {
    upstreamError: parsed.upstreamError,
    primaryFix: parsed.primaryFix,
  };
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
    evalToolName: session.evalToolName,
    evalToolArgument: session.evalToolArgument,
    upstreamArguments: session.upstreamArguments,
    handles: session.handles,
    workspace: session.workspace,
    lastDiagnostics: session.lastDiagnostics,
    history: includeHistory ? session.history.slice(-historyLimit) : undefined,
  };
}

function cloneSession(session: FigmaReplSession): FigmaReplSession {
  return {
    ...session,
    knownPages: { ...session.knownPages },
    upstreamArguments: { ...session.upstreamArguments },
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

function makeJsonToolResult(value: unknown): Record<string, unknown> {
  const structuredContent = removeUndefined(value);
  return {
    structuredContent,
    content: [
      {
        type: "text",
        text: summarizeToolResult(structuredContent),
      },
    ],
  };
}

function parseJsonToolResult(result: Record<string, unknown>): unknown {
  if (result.structuredContent !== undefined) {
    return result.structuredContent;
  }
  const content = Array.isArray(result.content) ? result.content : [];
  const firstText = content
    .map((item) => asRecord(item).text)
    .find((item): item is string => typeof item === "string");
  if (firstText === undefined) {
    return result;
  }
  return JSON.parse(firstText);
}

function summarizeToolResult(value: unknown): string {
  const record = asRecord(value);
  if (record.ok === false) {
    return "Figma REPL tool failed.";
  }
  return "Figma REPL tool completed.";
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

function extractFigmaFileKey(fileUrl: string | undefined): string | undefined {
  if (!fileUrl) {
    return undefined;
  }
  try {
    const url = new URL(fileUrl);
    const parts = url.pathname.split("/").filter(Boolean);
    const kindIndex = parts.findIndex((part) =>
      ["design", "board", "slides"].includes(part),
    );
    return kindIndex >= 0 ? parts[kindIndex + 1] : undefined;
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
    const kindIndex = parts.findIndex((part) =>
      ["design", "board", "slides"].includes(part),
    );
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
    if (first === "design") return "design";
    if (first === "board") return "figjam";
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
