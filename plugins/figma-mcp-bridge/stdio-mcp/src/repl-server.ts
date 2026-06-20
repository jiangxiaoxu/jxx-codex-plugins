import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  CallToolRequestSchema,
  ListResourcesRequestSchema,
  ListToolsRequestSchema,
  ReadResourceRequestSchema,
  type CallToolRequest,
  type ListResourcesRequest,
  type ListToolsRequest,
  type ReadResourceRequest,
} from "@modelcontextprotocol/sdk/types.js";
import {
  createRemoteMcpClient,
  type RemoteMcpClientOptions,
} from "./client.js";
import type { FigmaMcpProxyClient } from "./stdio-server.js";

export const FIGMA_REPL_DEFAULT_SESSION_ID = "default";

const DEFAULT_EVAL_TOOL_NAME = "use_figma";
const DEFAULT_EVAL_ARGUMENT_CANDIDATES = [
  "code",
  "script",
  "javascript",
  "js",
  "command",
];
const DEFAULT_HISTORY_LIMIT = 50;
const TOOL_TITLE_ARGUMENT = "title";
const DEFAULT_DOCS_SEARCH_MAX_RESULTS = 5;
const DEFAULT_DOCS_SEARCH_SNIPPET_LINES = 3;
const MAX_DOCS_SEARCH_RESULTS = 10;
const MAX_DOCS_SEARCH_SNIPPET_LINES = 8;
const MAX_LOOKUP_QUERY_LENGTH = 120;
const DEFAULT_INLINE_RESULT_LIMIT = 4_000;
const MAX_INLINE_RESULT_LIMIT = 1_000_000;
const TASK_WORKSPACE_ROOT_ENV = "FIGMA_REPL_TASK_ROOT";
const DEFAULT_WORKSPACE_DIR_NAME = "figma-mcp";
const LOCAL_REPL_TOOL_NAMES = new Set([
  "figma_repl_capabilities",
  "figma_repl_open",
  "figma_repl_eval",
  "figma_repl_run_script_file",
  "figma_repl_apply_asset_manifest",
  "figma_repl_capture_node",
  "figma_repl_run_task_plan",
  "figma_repl_init_workspace",
  "figma_repl_prepare_task",
  "figma_repl_plan_task",
  "figma_repl_api_card",
  "figma_repl_suggest_api",
  "figma_repl_inspect",
  "figma_repl_cache_get",
  "figma_repl_validate_handles",
  "figma_repl_list_upstream_tools",
  "figma_repl_call_upstream_tool",
  "figma_repl_docs_search",
  "figma_repl_api_lookup",
]);
const DOCS_SEARCH_ALLOWLIST = [
  "figma-use.md",
  "figma-create-new-file.md",
  "figma-code-connect.md",
  "figma-generate-design.md",
  "figma-generate-diagram.md",
  "figma-generate-library.md",
  "figma-use-figjam.md",
  "figma-use-slides.md",
  "plugin-api-lookup.md",
  "plugin-api-standalone.md",
  "official-figma-skills/figma-use/SKILL.source.md",
  "official-figma-skills/figma-use/references/api-reference.md",
  "official-figma-skills/figma-use/references/common-patterns.md",
  "official-figma-skills/figma-use/references/component-patterns.md",
  "official-figma-skills/figma-use/references/effect-style-patterns.md",
  "official-figma-skills/figma-use/references/gotchas.md",
  "official-figma-skills/figma-use/references/plugin-api-patterns.md",
  "official-figma-skills/figma-use/references/text-style-patterns.md",
  "official-figma-skills/figma-use/references/validation-and-recovery.md",
  "official-figma-skills/figma-use/references/variable-patterns.md",
  "official-figma-skills/figma-use/references/working-with-design-systems/wwds.md",
  "official-figma-skills/figma-use/references/working-with-design-systems/wwds-components.md",
  "official-figma-skills/figma-use/references/working-with-design-systems/wwds-variables.md",
  "official-figma-skills/figma-generate-library/SKILL.source.md",
  "official-figma-skills/figma-generate-library/references/component-creation.md",
  "official-figma-skills/figma-generate-library/references/discovery-phase.md",
  "official-figma-skills/figma-generate-library/references/token-creation.md",
  "official-figma-skills/figma-code-connect/SKILL.source.md",
  "official-figma-skills/figma-code-connect/references/api.md",
  "official-figma-skills/figma-use-figjam/SKILL.source.md",
  "official-figma-skills/figma-use-slides/SKILL.source.md",
];
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
const API_LOOKUP_FILES = [
  "official-figma-skills/figma-use/references/plugin-api-standalone.index.md",
  "official-figma-skills/figma-use/references/api-reference.md",
  "official-figma-skills/figma-use/references/plugin-api-standalone.d.ts",
];
const FIGMA_REPL_API_CARDS: FigmaReplApiCard[] = [
  {
    id: "nodes",
    title: "Create and update Design nodes",
    intents: ["create", "frame", "rectangle", "ui", "layout"],
    surface: "design",
    helpers: ["$.create", "$.checkpoint"],
    pluginApi: ["figma.createFrame", "figma.createRectangle", "resize", "appendChild"],
    pitfalls: ["Set size before auto-layout if fixed dimensions matter.", "Remember handles with `as` for later repair."],
  },
  {
    id: "text",
    title: "Text and font-safe edits",
    intents: ["text", "font", "copy", "label", "typography"],
    surface: "design",
    helpers: ["$.text", "figma_repl_api_lookup"],
    pluginApi: ["figma.createText", "figma.loadFontAsync", "TextNode.characters"],
    pitfalls: ["Always load the target font before changing characters or fontName.", "Use text styles for reusable typography."],
  },
  {
    id: "auto-layout",
    title: "Auto layout",
    intents: ["layout", "spacing", "padding", "stack", "responsive"],
    surface: "design",
    helpers: ["$.layout", "$.create"],
    pluginApi: ["layoutMode", "itemSpacing", "paddingLeft", "primaryAxisSizingMode"],
    pitfalls: ["Use valid uppercase layout modes.", "Apply layout to frames, components, or component sets only."],
  },
  {
    id: "variables",
    title: "Variables and color tokens",
    intents: ["variable", "token", "color", "theme", "mode"],
    surface: "design",
    helpers: ["figma_repl_api_lookup", "figma_repl_run_script_file"],
    pluginApi: ["figma.variables.createVariableCollection", "figma.variables.createVariable", "setValueForMode"],
    pitfalls: ["Variable APIs require Design files.", "Use native Plugin API calls in .figma.js for token creation."],
  },
  {
    id: "styles",
    title: "Text and paint styles",
    intents: ["style", "paint", "typography", "library"],
    surface: "design",
    helpers: ["figma_repl_api_lookup", "figma_repl_run_script_file"],
    pluginApi: ["figma.createTextStyle", "figma.createPaintStyle", "TextNode.textStyleId", "fills"],
    pitfalls: ["Style creation is local to the file until published.", "Load fonts before setting text style font names."],
  },
  {
    id: "components",
    title: "Components and variants",
    intents: ["component", "variant", "instance", "design system"],
    surface: "design",
    helpers: ["$.create", "figma_repl_api_lookup"],
    pluginApi: ["figma.createComponent", "figma.combineAsVariants", "ComponentNode.createInstance"],
    pitfalls: ["Variant combining requires component nodes.", "Use handles for source components before creating instances."],
  },
  {
    id: "selection",
    title: "Selection, query, and inspection",
    intents: ["find", "select", "inspect", "query", "validate"],
    surface: "any",
    helpers: ["$.find", "$.findAll", "$.select", "$.inspect", "figma_repl_validate_handles"],
    pluginApi: ["figma.currentPage.selection", "findAll", "getNodeByIdAsync"],
    pitfalls: ["Avoid root-wide searches in large files.", "Use $.select instead of direct figma.currentPage.selection writes.", "Validate stale handles before mutation."],
  },
  {
    id: "clone",
    title: "Clone an existing node tree",
    intents: ["clone", "copy", "duplicate", "side by side", "preserve instance"],
    surface: "design",
    helpers: ["$.cloneNodeTree", "$.select", "$.checkpoint"],
    pluginApi: ["SceneNode.clone", "appendChild", "remove"],
    pitfalls: ["Clone outer-to-inner when rebuilding children.", "Preserve instance subtrees whole; Figma does not allow rebuilding internal instance children."],
  },
  {
    id: "pages",
    title: "Page targeting",
    intents: ["page", "surface", "current page", "navigation"],
    surface: "any",
    helpers: ["targetPageId", "figma_repl_open"],
    pluginApi: ["figma.setCurrentPageAsync", "PageNode"],
    pitfalls: ["Do not assign `figma.currentPage` directly.", "Use one page switch per transaction."],
  },
];

export type FigmaReplSurface = "design" | "figjam" | "slides";

export type FigmaReplDiagnosticSeverity = "fatal" | "warning";

export interface FigmaReplDiagnostic {
  code: string;
  severity: FigmaReplDiagnosticSeverity;
  message: string;
  suggestion: string;
  docsHint: string;
}

export interface FigmaReplFileDiagnostic extends FigmaReplDiagnostic {
  source: {
    scriptPath: string;
    line?: number;
    column?: number;
  };
}

export interface FigmaReplDiagnosticsOptions {
  allowDangerousOperations?: boolean;
  mode?: "read" | "write";
  generatedCode?: boolean;
  expectedSurface?: FigmaReplSurface;
  strict?: boolean;
}

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
  initWorkspace(args: FigmaReplInitWorkspaceArguments): Promise<unknown>;
  prepareTask(args: FigmaReplPrepareTaskArguments): Promise<unknown>;
  planTask(args: FigmaReplPlanTaskArguments): Promise<unknown>;
  apiCard(args: FigmaReplApiCardArguments): Promise<unknown>;
  suggestApi(args: FigmaReplSuggestApiArguments): Promise<unknown>;
  inspect(args?: Record<string, unknown>): Promise<unknown>;
  cacheGet(args?: Record<string, unknown>): Promise<unknown>;
  validateHandles(args?: Record<string, unknown>): Promise<unknown>;
  listUpstreamTools(args?: Record<string, unknown>): Promise<unknown>;
  callUpstreamTool(args: FigmaReplCallUpstreamToolArguments): Promise<unknown>;
  docsSearch(args: FigmaReplDocsSearchArguments): Promise<unknown>;
  apiLookup(args: FigmaReplApiLookupArguments): Promise<unknown>;
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

export interface FigmaReplSessionWorkspace {
  root: string;
  fileDir: string;
  fileContext: string;
  fileKey?: string;
  fileSlug: string;
  intentSlug: string;
  /**
   * Compatibility alias for the file-context directory.
   */
  sessionDir: string;
  scriptPath: string;
  resultFile: string;
  files: {
    script: string;
    result: string;
  };
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

export interface FigmaReplEvalArguments {
  [key: string]: unknown;
  title?: string;
  sessionId?: string;
  code: string;
  mode?: "read" | "write";
  expectedSurface?: FigmaReplSurface;
  returnMode?: "auto" | "json" | "text" | "raw";
  allowDangerousOperations?: boolean;
  upstreamTool?: string;
  upstreamArgument?: string;
  upstreamArguments?: Record<string, unknown>;
  handleUpdates?: Record<string, string>;
  includeRawUpstream?: boolean;
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
  includeRawUpstream?: boolean;
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

export interface FigmaReplInitWorkspaceArguments {
  [key: string]: unknown;
  title?: string;
  sessionId?: string;
  intent?: string;
  task?: string;
  fileUrl?: string;
  fileKey?: string;
  fileSlug?: string;
  cwd: string;
  dirName?: string;
  overwrite?: boolean;
}

export interface FigmaReplCallUpstreamToolArguments {
  [key: string]: unknown;
  title?: string;
  sessionId?: string;
  toolName: string;
  arguments?: Record<string, unknown>;
  refresh?: boolean;
  includeRawUpstream?: boolean;
}

export interface FigmaReplDocsSearchArguments {
  [key: string]: unknown;
  title?: string;
  query: string;
  maxResults?: number;
  maxSnippetLines?: number;
}

export interface FigmaReplApiLookupArguments {
  [key: string]: unknown;
  title?: string;
  symbol: string;
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

export interface FigmaReplPlanTaskArguments {
  [key: string]: unknown;
  title?: string;
  goal?: string;
  surface?: FigmaReplSurface;
  workflow?: string;
  task?: string;
  expectedSurface?: FigmaReplSurface;
  intent?: string;
}

export interface FigmaReplApiCardArguments {
  [key: string]: unknown;
  title?: string;
  card?: string;
  query?: string;
  maxCards?: number;
}

export interface FigmaReplSuggestApiArguments {
  [key: string]: unknown;
  title?: string;
  task?: string;
  intent: string;
  surface?: FigmaReplSurface;
  expectedSurface?: FigmaReplSurface;
  maxCards?: number;
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

interface ReferenceSearchResult {
  file: string;
  lineStart: number;
  lineEnd: number;
  score: number;
  snippet: string;
}

interface FigmaReplApiCard {
  id: string;
  title: string;
  intents: string[];
  surface: FigmaReplSurface | "any";
  helpers: string[];
  pluginApi: string[];
  pitfalls: string[];
}

interface ScriptOutputFilePaths {
  resultFile?: string;
  diagnosticsFile?: string;
  summaryFile?: string;
}

export type FigmaReplHelperProfile = "auto" | "minimal" | "asset" | "clone" | "full";

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
      parseJsonToolResult(
        await handleRunScriptFile(
          asRunScriptFileArgs(withDefaultTitle(args, "Run Figma JavaScript file")),
          runtime,
        ),
      ),
    applyAssetManifest: async (args) =>
      parseJsonToolResult(
        await handleApplyAssetManifest(
          asApplyAssetManifestArgs(withDefaultTitle(args, "Apply Figma asset manifest")),
          runtime,
        ),
      ),
    captureNode: async (args) =>
      parseJsonToolResult(
        await handleCaptureNode(
          asCaptureNodeArgs(withDefaultTitle(args, "Capture Figma node")),
          runtime,
        ),
      ),
    runTaskPlan: async (args) =>
      parseJsonToolResult(
        await handleRunTaskPlan(
          asRunTaskPlanArgs(withDefaultTitle(args, "Run Figma REPL task plan")),
          runtime,
        ),
      ),
    initWorkspace: async (args) =>
      parseJsonToolResult(
        await handleInitWorkspace(
          asInitWorkspaceArgs(withDefaultTitle(args, "Initialize Figma REPL workspace")),
          { sessions: runtime.sessions },
        ),
      ),
    prepareTask: async (args) =>
      parseJsonToolResult(
        await handlePrepareTask(
          asPrepareTaskArgs(withDefaultTitle(args, "Prepare Figma REPL task")),
          { sessions: runtime.sessions },
        ),
      ),
    planTask: async (args) =>
      parseJsonToolResult(
        handlePlanTask(asPlanTaskArgs(withDefaultTitle(args, "Plan Figma REPL task"))),
      ),
    apiCard: async (args) =>
      parseJsonToolResult(
        handleApiCard(asApiCardArgs(withDefaultTitle(args, "Read Figma REPL API card"))),
      ),
    suggestApi: async (args) =>
      parseJsonToolResult(
        handleSuggestApi(asSuggestApiArgs(withDefaultTitle(args, "Suggest Figma REPL API"))),
      ),
    inspect: async (args = {}) =>
      parseJsonToolResult(
        await handleInspect(withDefaultTitle(args, "Inspect Figma REPL target"), runtime),
      ),
    cacheGet: async (args = {}) =>
      parseJsonToolResult(
        handleCacheGet(withDefaultTitle(args, "Read Figma REPL cache"), runtime),
      ),
    validateHandles: async (args = {}) =>
      parseJsonToolResult(
        await handleValidateHandles(
          withDefaultTitle(args, "Validate Figma REPL handles"),
          runtime,
        ),
      ),
    listUpstreamTools: async (args = {}) =>
      parseJsonToolResult(
        await handleListUpstreamTools(
          withDefaultTitle(args, "List upstream Figma MCP tools"),
          runtime,
        ),
      ),
    callUpstreamTool: async (args) =>
      parseJsonToolResult(
        await handleCallUpstreamTool(
          asCallUpstreamToolArgs(withDefaultTitle(args, "Call upstream Figma MCP tool")),
          runtime,
        ),
      ),
    docsSearch: async (args) =>
      parseJsonToolResult(
        await handleDocsSearch(
          asDocsSearchArgs(withDefaultTitle(args, "Search Figma REPL documentation")),
        ),
      ),
    apiLookup: async (args) =>
      parseJsonToolResult(
        await handleApiLookup(
          asApiLookupArgs(withDefaultTitle(args, "Look up Figma Plugin API symbol")),
        ),
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
        "Use figma_repl_run_script_file for repairable .figma.js workflows, figma_repl_eval for small batched Plugin API JavaScript, and figma_repl_cache_get to reuse handles across calls.",
        "The proxy stores only local session metadata and node-id handles; Figma execution still happens through the upstream use_figma tool.",
      ].join(" "),
    },
  );

  server.setRequestHandler(ListToolsRequestSchema, async (_request: ListToolsRequest) => ({
    tools: createReplToolDescriptions(),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request: CallToolRequest) => {
    const args = asRecord(request.params.arguments);
    switch (request.params.name) {
      case "figma_repl_open":
        return handleOpen(args, { sessions, upstreamToolCache, config });
      case "figma_repl_eval":
        return handleEval(asEvalArgs(args), { client, sessions, upstreamToolCache, config });
      case "figma_repl_run_script_file":
        return handleRunScriptFile(asRunScriptFileArgs(args), {
          client,
          sessions,
          upstreamToolCache,
          config,
        });
      case "figma_repl_apply_asset_manifest":
        return handleApplyAssetManifest(asApplyAssetManifestArgs(args), {
          client,
          sessions,
          upstreamToolCache,
          config,
        });
      case "figma_repl_capture_node":
        return handleCaptureNode(asCaptureNodeArgs(args), {
          client,
          sessions,
          upstreamToolCache,
          config,
        });
      case "figma_repl_run_task_plan":
        return handleRunTaskPlan(asRunTaskPlanArgs(args), {
          client,
          sessions,
          upstreamToolCache,
          config,
        });
      case "figma_repl_init_workspace":
        return handleInitWorkspace(asInitWorkspaceArgs(args), { sessions });
      case "figma_repl_prepare_task":
        return handlePrepareTask(asPrepareTaskArgs(args), { sessions });
      case "figma_repl_plan_task":
        return handlePlanTask(asPlanTaskArgs(args));
      case "figma_repl_api_card":
        return handleApiCard(asApiCardArgs(args));
      case "figma_repl_suggest_api":
        return handleSuggestApi(asSuggestApiArgs(args));
      case "figma_repl_inspect":
        return handleInspect(args, { client, sessions, upstreamToolCache, config });
      case "figma_repl_cache_get":
        return handleCacheGet(args, { sessions });
      case "figma_repl_validate_handles":
        return handleValidateHandles(args, { client, sessions, upstreamToolCache, config });
      case "figma_repl_capabilities":
        return handleCapabilities(args);
      case "figma_repl_list_upstream_tools":
        return handleListUpstreamTools(args, { upstreamToolCache });
      case "figma_repl_call_upstream_tool":
        return handleCallUpstreamTool(asCallUpstreamToolArgs(args), {
          client,
          sessions,
          upstreamToolCache,
        });
      case "figma_repl_docs_search":
        return handleDocsSearch(asDocsSearchArgs(args));
      case "figma_repl_api_lookup":
        return handleApiLookup(asApiLookupArgs(args));
      default:
        throw new Error(`Unknown figma-repl-mcp tool: ${request.params.name}`);
    }
  });

  server.setRequestHandler(
    ListResourcesRequestSchema,
    async (_request: ListResourcesRequest) => ({
      resources: [
        {
          uri: "figma-repl://guide",
          name: "Figma REPL agent guide",
          mimeType: "application/json",
        },
        {
          uri: "figma-repl://patterns",
          name: "Figma REPL usage patterns",
          mimeType: "application/json",
        },
        {
          uri: "figma-repl://scripts",
          name: "Figma REPL script file workflow",
          mimeType: "application/json",
        },
        {
          uri: "figma-repl://file-workflow",
          name: "Figma REPL .figma.js file workflow",
          mimeType: "application/json",
        },
        {
          uri: "figma-repl://workflow-tools",
          name: "Figma REPL workflow tools for plans, assets, and captures",
          mimeType: "application/json",
        },
        {
          uri: "figma-repl://api-cards",
          name: "Figma REPL compact API cards",
          mimeType: "application/json",
        },
        {
          uri: "figma-repl://intents",
          name: "Figma REPL intent to API guidance",
          mimeType: "application/json",
        },
        {
          uri: "figma-repl://safety",
          name: "Figma REPL safety and diagnostics",
          mimeType: "application/json",
        },
        {
          uri: "figma-repl://docs",
          name: "Figma REPL compact documentation lookup guide",
          mimeType: "application/json",
        },
        {
          uri: "figma-repl://api",
          name: "Figma REPL Plugin API lookup guide",
          mimeType: "application/json",
        },
        {
          uri: "figma-repl://sessions",
          name: "Figma REPL sessions",
          mimeType: "application/json",
        },
        ...sessions.list().map((session) => ({
          uri: `figma-repl://sessions/${encodeURIComponent(session.id)}`,
          name: `Figma REPL session ${session.id}`,
          mimeType: "application/json",
        })),
      ],
    }),
  );

  server.setRequestHandler(
    ReadResourceRequestSchema,
    async (request: ReadResourceRequest) => readReplResource(request.params.uri, sessions),
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
    session: publicSession(session),
    diagnostics: session.lastDiagnostics,
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
    ok: true,
    session: publicSession(session),
    upstreamTool: evalSettings.toolName,
    upstreamArgument: evalSettings.argumentName,
    text: args.returnMode === "json" ? undefined : parsed.text,
    parsed: args.returnMode === "text" ? undefined : parsed.json,
    diagnostics,
    upstream: args.includeRawUpstream ? upstream : undefined,
  });
}

async function handleRunScriptFile(
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
  });
  const diagnostics = [
    ...compiled.diagnostics,
    ...diagnoseWrappedScriptSize(scriptPath, wrappedScript, Boolean(args.strict)),
  ];
  session.lastDiagnostics = diagnostics;
  throwIfFatalDiagnostics(diagnostics);
  const outputWriter = createScriptOutputWriter(args, session);
  const inlineResultLimit = effectiveInlineResultLimit(args.inlineResultLimit, outputWriter.files);
  const scriptMetadata = {
    ...compiled.metadata,
    diagnosticsCount: diagnostics.length,
    compiledScriptBytes: Buffer.byteLength(wrappedScript, "utf8"),
    dryRun: Boolean(args.dryRun),
    executed: !args.dryRun,
  };

  if (args.dryRun) {
    touchSession(session);
    const resultPayload = {
      ok: true,
      dryRun: true,
      session: publicSession(session),
      diagnostics,
      script: scriptMetadata,
      compiledScript: wrappedScript,
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
    return makeJsonToolResult({
      ...limitInlineScriptResult(resultPayload, inlineResultLimit, ["compiledScript"]),
      outputFiles,
    });
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
      session: publicSession(session),
      upstreamTool: evalSettings.toolName,
      upstreamArgument: evalSettings.argumentName,
      diagnostics,
      script: scriptMetadata,
      upstreamError,
      primaryFix: primaryFixForUpstreamError(upstreamError),
    };
    const outputFiles = await outputWriter.write({
      result: resultPayload,
      diagnostics,
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
    return makeJsonToolResult({
      ...limitInlineScriptResult(
        {
          ...resultPayload,
          outputFiles,
        },
        inlineResultLimit,
        ["upstreamError"],
      ),
    });
  }
  if (parsed.upstreamError) {
    const resultPayload = {
      ok: false,
      session: publicSession(session),
      upstreamTool: evalSettings.toolName,
      upstreamArgument: evalSettings.argumentName,
      diagnostics,
      script: scriptMetadata,
      parsed: parsed.json,
      text: parsed.text,
      upstreamError: parsed.upstreamError,
      primaryFix: parsed.primaryFix,
      upstream: args.includeRawUpstream ? upstream : undefined,
    };
    const outputFiles = await outputWriter.write({
      result: resultPayload,
      diagnostics,
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
    return makeJsonToolResult({
      ...limitInlineScriptResult(
        {
          ...resultPayload,
          outputFiles,
        },
        inlineResultLimit,
        ["parsed", "text", "upstream", "upstreamError"],
      ),
    });
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
    session: publicSession(session),
    upstreamTool: evalSettings.toolName,
    upstreamArgument: evalSettings.argumentName,
    diagnostics,
    script: scriptMetadata,
    parsed: parsed.json,
    text: parsed.text,
    upstream: args.includeRawUpstream ? upstream : undefined,
  };
  const outputFiles = await outputWriter.write({
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
  });
  return makeJsonToolResult({
    ...limitInlineScriptResult(
      {
        ...resultPayload,
        outputFiles,
      },
      inlineResultLimit,
      ["parsed", "text", "upstream"],
    ),
  });
}

async function handleApplyAssetManifest(
  args: FigmaReplApplyAssetManifestArguments,
  runtime: {
    client: FigmaMcpProxyClient;
    sessions: FigmaReplSessionStore;
    upstreamToolCache: ReturnType<typeof createUpstreamToolCache>;
    config: { evalToolName: string; evalToolArgument?: string };
  },
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
        const compactResult = compactParsedUpstreamResult(parsed);
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
          result: upload ? { ...compactResult, upload } : compactResult,
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
    files,
    failures,
  };
  if (resultFile) {
    await writeJsonFile(resultFile, payload);
    files.resultFile = resultFile;
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
  return makeJsonToolResult(payload);
}

async function handleCaptureNode(
  args: FigmaReplCaptureNodeArguments,
  runtime: {
    client: FigmaMcpProxyClient;
    sessions: FigmaReplSessionStore;
    upstreamToolCache: ReturnType<typeof createUpstreamToolCache>;
    config: { evalToolName: string; evalToolArgument?: string };
  },
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
    const payload = {
      ok: false,
      file: outputFile,
      nodeId,
      toolName: tool.name,
      upstreamError: parsed.upstreamError,
      primaryFix: parsed.primaryFix,
      files: resultFile ? { resultFile } : undefined,
    };
    if (resultFile) {
      await writeJsonFile(resultFile, payload);
    }
    return makeJsonToolResult(payload);
  }
  const saved = await writeCaptureOutputFile(outputFile, upstream, parsed);
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
    width: saved.width,
    height: saved.height,
    sourceUrl: saved.sourceUrl,
    qa: createCaptureQa(saved),
    files: resultFile ? { resultFile } : undefined,
  };
  if (resultFile) {
    await writeJsonFile(resultFile, payload);
  }
  return makeJsonToolResult(payload);
}

async function handleRunTaskPlan(
  args: FigmaReplRunTaskPlanArguments,
  runtime: {
    client: FigmaMcpProxyClient;
    sessions: FigmaReplSessionStore;
    upstreamToolCache: ReturnType<typeof createUpstreamToolCache>;
    config: { evalToolName: string; evalToolArgument?: string };
  },
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
    files: {
      resultFile,
    },
    failures,
  };
  await writeJsonFile(resultFile, payload);
  runtime.sessions.rememberHistory(session, {
    id: randomUUID(),
    at: new Date().toISOString(),
    tool: "figma_repl_run_task_plan",
    title: args.title,
    mode: "task-plan",
    summary: `Ran ${steps.length}/${plan.steps.length} task-plan steps with ${failures.length} failures.`,
    nodeIds: [],
  });
  return makeJsonToolResult(payload);
}

async function handlePrepareTask(
  args: FigmaReplPrepareTaskArguments,
  runtime?: { sessions: FigmaReplSessionStore },
): Promise<Record<string, unknown>> {
  assertRequiredTitleArgument(args);
  const session = runtime?.sessions.getOrCreate(args.sessionId);
  applyWorkspaceFileContextArgs(session, args);
  const intentSlug = deriveIntentSlug(args, "figma-task");
  const workspace = resolvePreparedTaskWorkspace(args, intentSlug, session);
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
  await writeTaskFile(resultFile, JSON.stringify({
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
    task: {
      slug: intentSlug,
      intentSlug,
      fileContext: workspace.fileContext,
      fileDir: workspace.fileDir,
      workspaceDir,
      taskDir: workspaceDir,
      workspace,
      scriptPath,
      resultFile,
      overwritten: Boolean(args.overwrite),
    },
    next: [
      "Edit the .figma.js file in this task folder.",
      "Dry-run with figma_repl_run_script_file before upstream execution.",
      "Read the paired .result.json file for diagnostics, summaries, and large results.",
    ],
  });
}

async function handleInitWorkspace(
  args: FigmaReplInitWorkspaceArguments,
  runtime: { sessions: FigmaReplSessionStore },
): Promise<Record<string, unknown>> {
  assertRequiredTitleArgument(args);
  if (!args.cwd || typeof args.cwd !== "string") {
    throw new Error('Tool argument "cwd" is required and must be a string.');
  }
  if (!isAbsolute(args.cwd)) {
    throw new Error('Tool argument "cwd" must be an absolute path.');
  }
  const session = runtime.sessions.getOrCreate(args.sessionId);
  applyWorkspaceFileContextArgs(session, args);
  const workspace = createSessionWorkspace({
    cwd: args.cwd,
    dirName: args.dirName,
    fileKey: session.fileKey,
    fileSlug: deriveFileSlug(args, session),
    intentSlug: deriveIntentSlug(args, session.id),
  });
  await ensureWorkspaceDirectories(workspace);
  session.workspace = workspace;
  touchSession(session);
  return makeJsonToolResult({
    ok: true,
    session: publicSession(session),
    workspace,
    files: workspace.files,
    next: [
      "Edit the .figma.js file inside this file-context folder.",
      "Run figma_repl_run_script_file with inputFile/outputFile names instead of absolute paths.",
      "Read the paired .result.json file when inline response is capped.",
    ],
  });
}

function handlePlanTask(args: FigmaReplPlanTaskArguments): Record<string, unknown> {
  assertRequiredTitleArgument(args);
  const surface = normalizeSurface(args.surface ?? args.expectedSurface) ?? "design";
  const intent = typeof args.intent === "string"
    ? args.intent
    : typeof args.goal === "string"
      ? args.goal
      : typeof args.task === "string"
        ? args.task
        : "";
  return makeJsonToolResult({
    ok: true,
    workflow: createFileWorkflowPayload(),
    plan: {
      surface,
      workflow: args.workflow ?? "script-file",
      intent,
      steps: [
        "Prepare or reuse a task workspace with figma_repl_prepare_task.",
        "Write the transaction in a local .figma.js file using $ helpers and native Figma Plugin API calls.",
        "Call figma_repl_run_script_file with dryRun=true, strict=true, expectedSurface, inputFile, and inlineResultLimit.",
        "Repair local file/line diagnostics, then execute the same script file against upstream Figma.",
        "Inspect the paired .result.json file first when inline results are capped.",
      ],
      recommendedTools: [
        "figma_repl_prepare_task",
        "figma_repl_api_card",
        "figma_repl_suggest_api",
        "figma_repl_run_script_file",
        "figma_repl_inspect",
      ],
      suggestedCards: chooseApiCardsForIntent(intent, 4).map((card) => card.id),
    },
  });
}

function handleApiCard(args: FigmaReplApiCardArguments): Record<string, unknown> {
  assertRequiredTitleArgument(args);
  const query = typeof args.card === "string" ? args.card : typeof args.query === "string" ? args.query : "";
  const maxCards = normalizeBoundedInteger(args.maxCards, 3, 8);
  const cards = query
    ? searchApiCards(query, maxCards)
    : FIGMA_REPL_API_CARDS.slice(0, maxCards);
  return makeJsonToolResult({
    ok: true,
    cards,
    catalogSize: FIGMA_REPL_API_CARDS.length,
    guidance: "Use these compact cards before broader docs/API lookup; they are curated for .figma.js file workflows.",
  });
}

function handleSuggestApi(args: FigmaReplSuggestApiArguments): Record<string, unknown> {
  assertRequiredTitleArgument(args);
  const intent = normalizeLookupQuery(args.intent ?? args.task, "intent");
  const maxCards = normalizeBoundedInteger(args.maxCards, 4, 8);
  return makeJsonToolResult({
    ok: true,
    intent,
    expectedSurface: normalizeSurface(args.surface ?? args.expectedSurface),
    suggestions: createIntentSuggestions(intent, maxCards),
  });
}

async function handleInspect(
  args: Record<string, unknown>,
  runtime: {
    client: FigmaMcpProxyClient;
    sessions: FigmaReplSessionStore;
    upstreamToolCache: ReturnType<typeof createUpstreamToolCache>;
    config: { evalToolName: string; evalToolArgument?: string };
  },
): Promise<Record<string, unknown>> {
  assertRequiredTitleArgument(args);
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
    ok: true,
    session: publicSession(session),
    diagnostics: session.lastDiagnostics,
    parsed: parsed.json,
    text: parsed.text,
  });
}

function handleCacheGet(
  args: Record<string, unknown>,
  runtime: { sessions: FigmaReplSessionStore },
): Record<string, unknown> {
  assertRequiredTitleArgument(args);
  const session = runtime.sessions.get(asOptionalString(args.sessionId));
  const includeHistory = args.includeHistory !== false;
  const historyLimit = normalizePositiveInteger(args.historyLimit, DEFAULT_HISTORY_LIMIT);
  return makeJsonToolResult({
    ok: true,
    session: session
      ? publicSession(session, { includeHistory, historyLimit })
      : undefined,
    sessions: runtime.sessions.list().map((item) => publicSession(item, { includeHistory: false })),
    lastDiagnostics: session?.lastDiagnostics,
  });
}

async function handleValidateHandles(
  args: Record<string, unknown>,
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
    tool: "figma_repl_validate_handles",
    title: asOptionalString(args.title),
    mode: "read",
    summary: `Validated ${requested.length} Figma REPL handle(s).`,
    nodeIds: collectNodeIds(parsed.json),
  });
  return makeJsonToolResult({
    ok: true,
    session: publicSession(session),
    diagnostics,
    parsed: parsed.json,
    text: parsed.text,
  });
}

function handleCapabilities(args: Record<string, unknown>): Record<string, unknown> {
  assertRequiredTitleArgument(args);
  return makeJsonToolResult({
    ok: true,
    ...createCapabilitiesPayload(),
  });
}

async function handleListUpstreamTools(
  args: Record<string, unknown>,
  runtime: { upstreamToolCache: ReturnType<typeof createUpstreamToolCache> },
): Promise<Record<string, unknown>> {
  assertRequiredTitleArgument(args);
  const tools = await runtime.upstreamToolCache.list(Boolean(args.refresh));
  return makeJsonToolResult({
    ok: true,
    tools,
  });
}

async function handleCallUpstreamTool(
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
  if (LOCAL_REPL_TOOL_NAMES.has(args.toolName)) {
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
  return makeJsonToolResult({
    ok: true,
    toolName: args.toolName,
    result: parsed.json,
    text: parsed.text,
    raw: args.includeRawUpstream ? upstream : undefined,
  });
}

async function handleDocsSearch(
  args: FigmaReplDocsSearchArguments,
): Promise<Record<string, unknown>> {
  assertRequiredTitleArgument(args);
  const query = normalizeLookupQuery(args.query, "query");
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
    query,
    searchRoot: matches.searchRoot,
    maxResults: matches.maxResults,
    maxSnippetLines: matches.maxSnippetLines,
    results: matches.results,
    guidance:
      "Use these capped snippets as routing/context. Run a narrower figma_repl_docs_search or figma_repl_api_lookup instead of reading the whole reference tree.",
  });
}

async function handleApiLookup(
  args: FigmaReplApiLookupArguments,
): Promise<Record<string, unknown>> {
  assertRequiredTitleArgument(args);
  const symbol = normalizeLookupQuery(args.symbol, "symbol");
  const matches = await searchReferenceFiles({
    query: symbol,
    files: API_LOOKUP_FILES,
    maxResults: normalizeBoundedInteger(args.maxResults, 5, MAX_DOCS_SEARCH_RESULTS),
    maxSnippetLines: normalizeBoundedInteger(args.maxSnippetLines, 5, MAX_DOCS_SEARCH_SNIPPET_LINES),
    exactSymbol: true,
  });
  return makeJsonToolResult({
    ok: true,
    symbol,
    searchRoot: matches.searchRoot,
    maxResults: matches.maxResults,
    maxSnippetLines: matches.maxSnippetLines,
    results: matches.results,
    guidance:
      "Results are capped Plugin API snippets with file/line evidence. This tool never returns the full plugin-api-standalone.d.ts file.",
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
}): string {
  return `${createFigmaReplPrelude(options.session, options.mode ?? "write")}
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

interface CompiledFigmaReplScriptFile {
  code: string;
  diagnostics: FigmaReplFileDiagnostic[];
  metadata: {
    scriptPath: string;
    sourceBytes: number;
    sourceLineCount: number;
    helperApiVersion: string;
    helperProfile: FigmaReplHelperProfile;
    helpersIncluded: string[];
    targetPageId?: string;
    expectedSurface?: FigmaReplSurface;
    diagnosticsCount: number;
  };
}

function compileFigmaReplScriptFile(options: {
  scriptPath: string;
  source: string;
  targetPageId?: string;
  expectedSurface?: FigmaReplSurface;
  allowDangerousOperations?: boolean;
  strict?: boolean;
  helperProfile?: unknown;
}): CompiledFigmaReplScriptFile {
  const helperProfile = resolveFigmaReplHelperProfile(options.helperProfile, options.source);
  const diagnostics = toFileDiagnostics(
    options.scriptPath,
    options.source,
    diagnoseFigmaReplCode(options.source, {
      allowDangerousOperations: options.allowDangerousOperations,
      expectedSurface: options.expectedSurface,
      mode: "write",
      strict: options.strict,
    }),
  );
  const lines = [createFigmaReplScriptHelperBootstrap(helperProfile)];
  if (options.targetPageId) {
    lines.push(`{ const __targetPage = await getNodeById(${literal(options.targetPageId)}); if (__targetPage.type !== "PAGE") throw new Error("targetPageId must resolve to a PAGE node."); await figma.setCurrentPageAsync(__targetPage); }`);
  }
  lines.push(`// figma_repl_run_script_file source: ${options.scriptPath}`);
  lines.push(options.source);
  return {
    code: lines.join("\n"),
    diagnostics,
    metadata: {
      scriptPath: options.scriptPath,
      sourceBytes: Buffer.byteLength(options.source, "utf8"),
      sourceLineCount: countLines(options.source),
      helperApiVersion: "1",
      helperProfile: helperProfile.profile,
      helpersIncluded: helperProfile.helpersIncluded,
      targetPageId: options.targetPageId,
      expectedSurface: options.expectedSurface,
      diagnosticsCount: diagnostics.length,
    },
  };
}

function resolveFigmaReplHelperProfile(
  value: unknown,
  source: string,
): { profile: FigmaReplHelperProfile; includeImageAsset: boolean; includeCloneNodeTree: boolean; helpersIncluded: string[] } {
  const requested = asOptionalString(value) as FigmaReplHelperProfile | undefined;
  const profile: FigmaReplHelperProfile = requested && ["auto", "minimal", "asset", "clone", "full"].includes(requested)
    ? requested
    : "auto";
  const includeImageAsset = profile === "full" || profile === "asset" || (profile === "auto" && /\$\.imageAsset\b/u.test(source));
  const includeCloneNodeTree = profile === "full" || profile === "clone" || (profile === "auto" && /\$\.cloneNodeTree\b/u.test(source));
  return {
    profile,
    includeImageAsset,
    includeCloneNodeTree,
    helpersIncluded: [
      "$",
      "$.find",
      "$.findAll",
      "$.text",
      "$.layout",
      "$.create",
      "$.select",
      "$.inspect",
      "$.screenshot",
      "$.checkpoint",
      includeImageAsset ? "$.imageAsset" : undefined,
      includeCloneNodeTree ? "$.cloneNodeTree" : undefined,
    ].filter((item): item is string => item !== undefined),
  };
}

function createFigmaReplScriptHelperBootstrap(options: {
  includeImageAsset: boolean;
  includeCloneNodeTree: boolean;
}): string {
  let bootstrap = `const __figmaReplScriptCheckpoints = [];
$.handles = __figmaRepl.handles;
$.remember = remember;
$.forget = forget;
$.resolveId = resolveHandleId;
$.node = $;
$.select = async function select(targets = "$selection", options = {}) {
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
};
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
  const node = await $(target);
  return summarizeNode(node, depth);
};
$.screenshot = async function screenshot(target, options = {}) {
  const node = await $(target);
  if (!node || typeof node.screenshot !== "function") {
    throw new Error("$.screenshot target does not support node.screenshot().");
  }
  return await node.screenshot(options);
};
$.cloneNodeTree = async function cloneNodeTree(targetOrOptions, maybeOptions = {}) {
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
  const selection = input.select === false ? undefined : await $.select([rootClone], { zoom: input.zoom !== false, depth: 0 });
  return {
    source: summarizeNode(source, input.depth || 0),
    clone: summarizeNode(rootClone, input.depth || 0),
    copiedNodeCount: cloneLog.length,
    order: cloneLog,
    fallbackWholeSubtrees,
    selectedNodeIds: selection ? selection.selectedNodeIds : [],
    handle: input.as,
  };
};
$.checkpoint = async function checkpoint(name, targets = [], options = {}) {
  const list = Array.isArray(targets) ? targets : [targets];
  const summaries = [];
  for (const target of list) {
    const node = await $(target);
    summaries.push({ target, summary: summarizeNode(node, options.depth || 1) });
  }
  const checkpoint = {
    name: String(name || "checkpoint"),
    handles: { ...__figmaRepl.handles },
    summaries,
  };
  __figmaReplScriptCheckpoints.push(checkpoint);
  return checkpoint;
};
$.checkpoints = __figmaReplScriptCheckpoints;`;
  if (!options.includeImageAsset) {
    bootstrap = replaceHelperBootstrapBlock(
      bootstrap,
      "function __figmaReplDecodeBase64(input) {",
      "$.inspect = async function inspect",
      '$.imageAsset = async function imageAsset() { throw new Error("$.imageAsset helper was not injected. Use helperProfile: \\"asset\\" or \\"full\\", or keep helperProfile:auto and include $.imageAsset in the script source."); };\n',
    );
  }
  if (!options.includeCloneNodeTree) {
    bootstrap = replaceHelperBootstrapBlock(
      bootstrap,
      "$.cloneNodeTree = async function cloneNodeTree",
      "$.checkpoint = async function checkpoint",
      '$.cloneNodeTree = async function cloneNodeTree() { throw new Error("$.cloneNodeTree helper was not injected. Use helperProfile: \\"clone\\" or \\"full\\", or keep helperProfile:auto and include $.cloneNodeTree in the script source."); };\n',
    );
  }
  return bootstrap;
}

function replaceHelperBootstrapBlock(
  source: string,
  startMarker: string,
  endMarker: string,
  replacement: string,
): string {
  const start = source.indexOf(startMarker);
  const end = source.indexOf(endMarker);
  if (start < 0 || end < 0 || end <= start) {
    return source;
  }
  return `${source.slice(0, start)}${replacement}${source.slice(end)}`;
}

function createFigmaReplPrelude(
  session: Pick<FigmaReplSession, "id" | "handles" | "currentPageId" | "fileUrl" | "fileKey" | "surface" | "knownPages">,
  mode: "read" | "write",
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
}`;
}

export function assertSafeFigmaReplCode(
  code: string,
  options: FigmaReplDiagnosticsOptions = {},
): void {
  throwIfFatalDiagnostics(diagnoseFigmaReplCode(code, options));
}

export function diagnoseFigmaReplCode(
  code: string,
  options: FigmaReplDiagnosticsOptions = {},
): FigmaReplDiagnostic[] {
  const diagnostics: FigmaReplDiagnostic[] = [];
  const add = (diagnostic: FigmaReplDiagnostic) => {
    diagnostics.push(options.strict && diagnostic.severity === "warning"
      ? { ...diagnostic, severity: "fatal" }
      : diagnostic);
  };
  const dangerousPatterns = options.generatedCode
    ? GENERATED_CODE_DANGEROUS_PATTERNS
    : RAW_CODE_DANGEROUS_PATTERNS;
  if (!options.allowDangerousOperations) {
    for (const pattern of dangerousPatterns) {
      if (pattern.re.test(code)) {
        add(createDiagnostic(pattern.code, "fatal", pattern.message, pattern.suggestion, pattern.docsHint));
      }
    }
  }
  for (const pattern of API_CONTRACT_PATTERNS) {
    if (pattern.re.test(code)) {
      add(createDiagnostic(pattern.code, "fatal", pattern.message, pattern.suggestion, pattern.docsHint));
    }
  }
  if ((code.match(/\bfigma\.setCurrentPageAsync\s*\(/gu) ?? []).length > 1) {
    add(createDiagnostic(
      "FIGMA_REPL_MULTIPLE_PAGE_SWITCH",
      "fatal",
      "Multiple figma.setCurrentPageAsync() calls in one transaction are error-prone.",
      "Use one targetPageId on figma_repl_run_script_file or split page changes into separate script files.",
      "figma-repl://safety#page-context",
    ));
  }
  if (!options.generatedCode && /\bfigma\.currentPage\.selection\b/u.test(code)) {
    add(createDiagnostic(
      "FIGMA_REPL_DIRECT_SELECTION_ACCESS",
      "warning",
      "Direct figma.currentPage.selection access is brittle in agent scripts.",
      "Use $.select([...]) for writes, $.inspect('$selection') for summaries, or resolve explicit node ids/handles.",
      "figma-repl://scripts#helpers",
    ));
  }
  if (options.mode === "read") {
    for (const pattern of READ_MODE_WRITE_PATTERNS) {
      if (pattern.re.test(code)) {
        add(createDiagnostic(pattern.code, "fatal", pattern.message, pattern.suggestion, pattern.docsHint));
      }
    }
  }
  if (TEXT_MUTATION_PATTERN.test(code) && !/\bfigma\.loadFontAsync\s*\(/u.test(code)) {
    add(createDiagnostic(
      "FIGMA_REPL_TEXT_MUTATION_NEEDS_FONT",
      "warning",
      "Text mutation usually requires figma.loadFontAsync() before changing characters or fontName.",
      "Use $.text, or await figma.loadFontAsync({ family, style }) before changing text.",
      "figma-repl://patterns#text",
    ));
  }
  for (const diagnostic of diagnoseInlineImageAssetSize(code)) {
    add(diagnostic);
  }
  if (CHECKPOINT_HANDLE_AS_NAME_PATTERN.test(code)) {
    add(createDiagnostic(
      "FIGMA_REPL_CHECKPOINT_HANDLE_AS_NAME",
      "warning",
      "$.checkpoint() appears to receive a handle as its first argument, but the first argument is the checkpoint name.",
      "Use $.checkpoint('meaningful-name', ['$handleOrNodeId'], { depth: 1 }).",
      "figma-repl://scripts#helpers",
    ));
  }
  for (const diagnostic of diagnoseSurfaceCode(code, options.expectedSurface)) {
    add(diagnostic);
  }
  return dedupeDiagnostics(diagnostics);
}

function diagnoseInlineImageAssetSize(code: string): FigmaReplDiagnostic[] {
  if (!code.includes("$.imageAsset")) {
    return [];
  }
  const diagnostics: FigmaReplDiagnostic[] = [];
  for (const match of code.matchAll(INLINE_IMAGE_ASSET_BASE64_PATTERN)) {
    const base64Length = String(match[2] || "").replace(/\s+/gu, "").length;
    if (base64Length > MAX_INLINE_IMAGE_ASSET_BASE64_CHARS) {
      diagnostics.push(createDiagnostic(
        "FIGMA_REPL_IMAGE_ASSET_INLINE_TOO_LARGE",
        "warning",
        `Inline $.imageAsset base64 is ${base64Length} characters and may exceed upstream MCP payload limits.`,
        "For large generated PNG/JPEG assets, create target rectangles in .figma.js and use the official upload_assets/upstream asset workflow to fill them.",
        "figma-repl://scripts#helpers",
      ));
      break;
    }
  }
  return diagnostics;
}

function diagnoseWrappedScriptSize(
  scriptPath: string,
  wrappedScript: string,
  strict: boolean,
): FigmaReplFileDiagnostic[] {
  const byteLength = Buffer.byteLength(wrappedScript, "utf8");
  if (byteLength < UPSTREAM_EVAL_CODE_WARNING_BYTES) {
    return [];
  }
  const overLimit = byteLength > UPSTREAM_EVAL_CODE_LIMIT_BYTES;
  return [{
    code: "FIGMA_REPL_SCRIPT_PAYLOAD_TOO_LARGE",
    severity: overLimit || strict ? "fatal" : "warning",
    message: `Compiled Figma script payload is ${byteLength} bytes; upstream use_figma accepts at most about ${UPSTREAM_EVAL_CODE_LIMIT_BYTES} characters.`,
    suggestion: "Split the work into smaller .figma.js files, for example skeleton, asset targets, upload fills, and visual fixes.",
    docsHint: "figma-repl://scripts#file-workflow",
    source: { scriptPath },
  }];
}

function throwIfFatalDiagnostics(diagnostics: FigmaReplDiagnostic[]): void {
  const fatal = diagnostics.filter((diagnostic) => diagnostic.severity === "fatal");
  if (fatal.length === 0) {
    return;
  }
  throw new Error(
    `Figma REPL diagnostics blocked execution: ${fatal.map((item) => item.code).join(", ")}. ${fatal[0]?.suggestion ?? ""}`,
  );
}

const RAW_CODE_DANGEROUS_PATTERNS = [
  {
    code: "FIGMA_REPL_DYNAMIC_EVAL",
    re: /\b(?:eval|Function)\s*\(/u,
    message: "Dynamic JavaScript evaluation is disabled by default.",
    suggestion: "Pass allowDangerousOperations=true only after reviewing the exact script.",
    docsHint: "figma-repl://safety#dynamic-code",
  },
  {
    code: "FIGMA_REPL_NETWORK_ACCESS",
    re: /\b(?:fetch|XMLHttpRequest|WebSocket)\b/u,
    message: "Network access from REPL code is disabled by default.",
    suggestion: "Fetch data outside Figma or pass allowDangerousOperations=true after review.",
    docsHint: "figma-repl://safety#network",
  },
  {
    code: "FIGMA_REPL_DYNAMIC_IMPORT",
    re: /\bimport\s*\(/u,
    message: "Dynamic import is disabled by default.",
    suggestion: "Inline the required logic or pass allowDangerousOperations=true after review.",
    docsHint: "figma-repl://safety#dynamic-code",
  },
  {
    code: "FIGMA_REPL_NODE_REMOVAL",
    re: /\.remove\s*\(/u,
    message: "Direct remove() is destructive and can break clone rebuilds, especially inside instance subtrees.",
    suggestion: "Use $.cloneNodeTree for copy/rebuild workflows; pass allowDangerousOperations=true only after reviewing exact cleanup semantics.",
    docsHint: "figma-repl://safety#destructive",
  },
  {
    code: "FIGMA_REPL_FIGMA_DELETE",
    re: /\bdelete\s+figma\./u,
    message: "Deleting properties on the figma object is not supported.",
    suggestion: "Use documented Plugin API calls only.",
    docsHint: "figma-repl://safety#api-contract",
  },
  {
    code: "FIGMA_REPL_DESTRUCTIVE_OPERATION",
    re: /\.(?:detachInstance|flatten)\s*\(/u,
    message: "Destructive Figma operation is disabled by default.",
    suggestion: "Pass allowDangerousOperations=true only after reviewing the exact effect.",
    docsHint: "figma-repl://safety#destructive",
  },
];

const GENERATED_CODE_DANGEROUS_PATTERNS = RAW_CODE_DANGEROUS_PATTERNS.filter(
  (pattern) => pattern.code !== "FIGMA_REPL_NODE_REMOVAL",
);

const READ_MODE_WRITE_PATTERNS = [
  {
    code: "FIGMA_REPL_READ_MODE_CREATE",
    re: /figma\.create[A-Z]/u,
    message: "read mode rejected node creation.",
    suggestion: "Use mode=write or figma_repl_run_script_file when mutation is intended.",
    docsHint: "figma-repl://safety#read-mode",
  },
  {
    code: "FIGMA_REPL_READ_MODE_APPEND",
    re: /\.(?:appendChild|insertChild)\s*\(/u,
    message: "read mode rejected child insertion.",
    suggestion: "Use mode=write or figma_repl_run_script_file when mutation is intended.",
    docsHint: "figma-repl://safety#read-mode",
  },
  {
    code: "FIGMA_REPL_READ_MODE_REMOVE",
    re: /\.remove\s*\(/u,
    message: "read mode rejected node removal.",
    suggestion: "Use mode=write with allowDangerousOperations only after review.",
    docsHint: "figma-repl://safety#read-mode",
  },
  {
    code: "FIGMA_REPL_READ_MODE_ASSIGNMENT",
    re: /\.(?:name|fills|strokes|characters|layoutMode|itemSpacing|paddingLeft|paddingRight|paddingTop|paddingBottom)\s*=/u,
    message: "read mode rejected a likely property assignment.",
    suggestion: "Use mode=write or a .figma.js script when mutation is intended.",
    docsHint: "figma-repl://safety#read-mode",
  },
  {
    code: "FIGMA_REPL_READ_MODE_RESIZE",
    re: /\.resize(?:WithoutConstraints)?\s*\(/u,
    message: "read mode rejected resize.",
    suggestion: "Use mode=write or a .figma.js script when mutation is intended.",
    docsHint: "figma-repl://safety#read-mode",
  },
];

const API_CONTRACT_PATTERNS = [
  {
    code: "FIGMA_REPL_CURRENT_PAGE_ASSIGNMENT",
    re: /\bfigma\.currentPage\s*=/u,
    message: "figma.currentPage is not assigned directly in the Plugin API.",
    suggestion: "Use await figma.setCurrentPageAsync(page) or figma_repl_run_script_file targetPageId.",
    docsHint: "figma-repl://safety#page-context",
  },
  {
    code: "FIGMA_REPL_ROOT_FIND_ALL",
    re: /\bfigma\.root\.findAll\s*\(/u,
    message: "figma.root.findAll() can scan the whole file and is not allowed through this layer.",
    suggestion: "Use $.find or $.findAll scoped to currentPage or a handle.",
    docsHint: "figma-repl://patterns#query",
  },
  {
    code: "FIGMA_REPL_PLUGIN_DATA",
    re: /\.(?:getPluginData|setPluginData|getSharedPluginData|setSharedPluginData)\s*\(/u,
    message: "Plugin data APIs are not a reliable agent-facing persistence layer for this REPL.",
    suggestion: "Use local handles/session metadata or a dedicated upstream workflow.",
    docsHint: "figma-repl://safety#facade-routing-delegation-boundaries",
  },
  {
    code: "FIGMA_REPL_IMAGE_CREATION",
    re: /\bfigma\.createImage(?:Async)?\s*\(/u,
    message: "Raw image creation is outside the supported script-file asset workflow.",
    suggestion: "Use $.imageAsset({ base64, parent, size, position, as }) in .figma.js, or route unusual asset uploads through an upstream official tool.",
    docsHint: "figma-repl://scripts#helpers",
  },
];

const TEXT_MUTATION_PATTERN = /(?:\.characters\s*=|\.fontName\s*=|figma\.createText\s*\()/u;
const MAX_INLINE_IMAGE_ASSET_BASE64_CHARS = 96 * 1024;
const INLINE_IMAGE_ASSET_BASE64_PATTERN = /\$\.imageAsset\s*\([\s\S]*?\bbase64\s*:\s*(["'`])([A-Za-z0-9+/=\s]+)\1/gu;
const CHECKPOINT_HANDLE_AS_NAME_PATTERN = /\$\.checkpoint\s*\(\s*(["'`])\$/u;
const UPSTREAM_EVAL_CODE_LIMIT_BYTES = 50_000;
const UPSTREAM_EVAL_CODE_WARNING_BYTES = 49_000;

function toFileDiagnostics(
  scriptPath: string,
  source: string,
  diagnostics: FigmaReplDiagnostic[],
): FigmaReplFileDiagnostic[] {
  return diagnostics.map((diagnostic) => ({
    ...diagnostic,
    source: {
      scriptPath,
      ...locateDiagnosticSource(source, diagnostic.code),
    },
  }));
}

function locateDiagnosticSource(
  source: string,
  code: string,
): { line?: number; column?: number } {
  const pattern = diagnosticPatternForCode(code);
  if (!pattern) {
    return {};
  }
  const match = pattern.exec(source);
  if (!match || match.index < 0) {
    return {};
  }
  return offsetToLineColumn(source, match.index);
}

function diagnosticPatternForCode(code: string): RegExp | undefined {
  const allPatterns = [
    ...RAW_CODE_DANGEROUS_PATTERNS,
    ...READ_MODE_WRITE_PATTERNS,
    ...API_CONTRACT_PATTERNS,
  ];
  const pattern = allPatterns.find((item) => item.code === code)?.re;
  if (pattern) {
    return new RegExp(pattern.source, pattern.flags.replace("g", ""));
  }
  if (code === "FIGMA_REPL_TEXT_MUTATION_NEEDS_FONT") {
    return new RegExp(TEXT_MUTATION_PATTERN.source, TEXT_MUTATION_PATTERN.flags.replace("g", ""));
  }
  if (code === "FIGMA_REPL_MULTIPLE_PAGE_SWITCH") {
    return /\bfigma\.setCurrentPageAsync\s*\(/u;
  }
  if (code === "FIGMA_REPL_DIRECT_SELECTION_ACCESS") {
    return /\bfigma\.currentPage\.selection\b/u;
  }
  if (code === "FIGMA_REPL_IMAGE_ASSET_INLINE_TOO_LARGE") {
    return /\$\.imageAsset\s*\(/u;
  }
  if (code === "FIGMA_REPL_CHECKPOINT_HANDLE_AS_NAME") {
    return /\$\.checkpoint\s*\(/u;
  }
  if (code === "FIGMA_REPL_SURFACE_FIGJAM_API_IN_DESIGN") {
    return /\bfigma\.create(?:Sticky|Connector|ShapeWithText|CodeBlock|Table)\s*\(/u;
  }
  if (code === "FIGMA_REPL_SURFACE_DESIGN_API_IN_FIGJAM") {
    return /\bfigma\.create(?:Frame|Component|ComponentSet|Instance)\s*\(/u;
  }
  if (code === "FIGMA_REPL_SURFACE_CANVAS_API_IN_SLIDES") {
    return /\bfigma\.create(?:Frame|Component|Sticky|Connector|ShapeWithText)\s*\(/u;
  }
  return undefined;
}

function offsetToLineColumn(source: string, offset: number): { line: number; column: number } {
  let line = 1;
  let column = 1;
  for (let index = 0; index < offset; index += 1) {
    if (source[index] === "\n") {
      line += 1;
      column = 1;
    } else {
      column += 1;
    }
  }
  return { line, column };
}

function countLines(source: string): number {
  if (source.length === 0) {
    return 0;
  }
  return source.split(/\r?\n/u).length;
}

function diagnoseSurfaceCode(
  code: string,
  expectedSurface: FigmaReplSurface | undefined,
): FigmaReplDiagnostic[] {
  if (!expectedSurface) {
    return [];
  }
  const diagnostics: FigmaReplDiagnostic[] = [];
  if (expectedSurface === "design" && /\bfigma\.create(?:Sticky|Connector|ShapeWithText|CodeBlock|Table)\s*\(/u.test(code)) {
    diagnostics.push(createDiagnostic(
      "FIGMA_REPL_SURFACE_FIGJAM_API_IN_DESIGN",
      "fatal",
      "FigJam creation APIs were used while the session expects a Design file.",
      "Use a FigJam-specific workflow or open the session with expectedSurface='figjam'.",
      "figma-repl://safety#surface",
    ));
  }
  if (expectedSurface === "figjam" && /\bfigma\.create(?:Frame|Component|ComponentSet|Instance)\s*\(/u.test(code)) {
    diagnostics.push(createDiagnostic(
      "FIGMA_REPL_SURFACE_DESIGN_API_IN_FIGJAM",
      "fatal",
      "Design canvas APIs were used while the session expects a FigJam board.",
      "Use FigJam-specific helpers for boards or open the session with expectedSurface='design'.",
      "figma-repl://safety#surface",
    ));
  }
  if (expectedSurface === "slides" && /\bfigma\.create(?:Frame|Component|Sticky|Connector|ShapeWithText)\s*\(/u.test(code)) {
    diagnostics.push(createDiagnostic(
      "FIGMA_REPL_SURFACE_CANVAS_API_IN_SLIDES",
      "fatal",
      "Canvas mutation APIs were used while the session expects Slides.",
      "Use the official Slides workflow rather than the REPL mutation layer.",
      "figma-repl://safety#surface",
    ));
  }
  return diagnostics;
}

function diagnoseFigmaReplContext(options: {
  expectedSurface?: FigmaReplSurface;
  derivedSurface?: FigmaReplSurface;
  fileUrl?: string;
}): FigmaReplDiagnostic[] {
  if (
    options.expectedSurface &&
    options.derivedSurface &&
    options.expectedSurface !== options.derivedSurface
  ) {
    return [
      createDiagnostic(
        "FIGMA_REPL_SURFACE_MISMATCH",
        "fatal",
        `Open expected ${options.expectedSurface} but the Figma URL looks like ${options.derivedSurface}.`,
        "Check the file URL or expectedSurface before running mutations.",
        "figma-repl://safety#surface",
      ),
    ];
  }
  return [];
}

function createDiagnostic(
  code: string,
  severity: FigmaReplDiagnosticSeverity,
  message: string,
  suggestion: string,
  docsHint: string,
): FigmaReplDiagnostic {
  return { code, severity, message, suggestion, docsHint };
}

function dedupeDiagnostics(diagnostics: FigmaReplDiagnostic[]): FigmaReplDiagnostic[] {
  const seen = new Set<string>();
  const result: FigmaReplDiagnostic[] = [];
  for (const diagnostic of diagnostics) {
    const key = `${diagnostic.code}:${diagnostic.severity}`;
    if (!seen.has(key)) {
      seen.add(key);
      result.push(diagnostic);
    }
  }
  return result;
}

function createScriptOutputWriter(args: FigmaReplRunScriptFileArguments, session?: FigmaReplSession): {
  files: ScriptOutputFilePaths;
  write(payload: {
    result: unknown;
    diagnostics: FigmaReplDiagnostic[];
    summary: Record<string, unknown>;
  }): Promise<ScriptOutputFilePaths>;
} {
  const files = resolveScriptOutputFiles(args, session);
  return {
    files,
    async write(payload) {
      const written: ScriptOutputFilePaths = {};
      if (files.resultFile) {
        await writeJsonFile(files.resultFile, payload.result);
        written.resultFile = files.resultFile;
      }
      if (files.diagnosticsFile) {
        await writeJsonFile(files.diagnosticsFile, {
          diagnostics: payload.diagnostics,
          count: payload.diagnostics.length,
        });
        written.diagnosticsFile = files.diagnosticsFile;
      }
      if (files.summaryFile) {
        await writeMarkdownFile(files.summaryFile, formatScriptRunSummaryMarkdown(payload.summary));
        written.summaryFile = files.summaryFile;
      }
      return written;
    },
  };
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

function compactParsedUpstreamResult(parsed: ParsedUpstreamToolResult): Record<string, unknown> {
  return {
    ok: !parsed.upstreamError,
    summary: summarizeParsedResult(parsed).slice(0, 240),
    nodeIds: collectNodeIds(parsed.json).slice(0, 20),
    error: parsed.upstreamError
      ? {
          message: parsed.upstreamError.message,
          code: parsed.upstreamError.code,
        }
      : undefined,
  };
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

function resolveRequiredWorkspaceAwareFile(
  value: unknown,
  session: FigmaReplSession,
  argumentName: string,
): string {
  const resolved = resolveWorkspaceAwareFile(value, session, argumentName);
  if (!resolved) {
    throw new Error(`Tool argument "${argumentName}" is required.`);
  }
  return resolved;
}

function resolveWorkspaceAwareFile(
  value: unknown,
  session: FigmaReplSession,
  argumentName: string,
): string | undefined {
  const raw = asOptionalString(value);
  if (!raw) {
    return undefined;
  }
  if (isAbsolute(raw)) {
    return raw;
  }
  if (!session.workspace) {
    throw new Error(
      `Tool argument "${argumentName}" must be an absolute path unless the session has an initialized file-context workspace.`,
    );
  }
  return resolveWorkspaceFile(session.workspace.sessionDir, raw, argumentName);
}

async function writeCaptureOutputFile(
  outputFile: string,
  upstream: unknown,
  parsed: ParsedUpstreamToolResult,
): Promise<{ kind: "image" | "text"; mimeType: string; bytes: number; width?: number; height?: number; sourceUrl?: string }> {
  const rawContent = asRecord(upstream).content;
  const content = Array.isArray(rawContent)
    ? rawContent.filter(isRecord)
    : [];
  const image = content.find((item) => item.type === "image" && typeof item.data === "string");
  await mkdir(dirname(outputFile), { recursive: true });
  if (image && typeof image.data === "string") {
    const buffer = Buffer.from(image.data, "base64");
    await writeFile(outputFile, buffer);
    const dimensions = imageDimensions(buffer, asOptionalString(image.mimeType) ?? "image/png");
    return {
      kind: "image",
      mimeType: asOptionalString(image.mimeType) ?? "image/png",
      bytes: buffer.byteLength,
      ...dimensions,
    };
  }
  const sourceUrl = extractCaptureImageUrl(upstream, parsed);
  if (sourceUrl) {
    const response = await fetch(sourceUrl);
    if (!response.ok) {
      throw new Error(
        `Unable to download captured node image from ${sourceUrl}: ${response.status} ${response.statusText}`,
      );
    }
    const buffer = Buffer.from(await response.arrayBuffer());
    await writeFile(outputFile, buffer);
    const mimeType = response.headers.get("content-type") ?? "image/png";
    const dimensions = imageDimensions(buffer, mimeType);
    return {
      kind: "image",
      mimeType,
      bytes: buffer.byteLength,
      ...dimensions,
      sourceUrl,
    };
  }
  const textItem = content.find((item) => item.type === "text" && typeof item.text === "string");
  const text = typeof textItem?.text === "string"
    ? textItem.text
    : parsed.text || JSON.stringify(removeUndefined(parsed.json ?? upstream), null, 2);
  await writeFile(outputFile, text, "utf8");
  return {
    kind: "text",
    mimeType: "text/plain",
    bytes: Buffer.byteLength(text, "utf8"),
  };
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

function imageDimensions(buffer: Buffer, mimeType: string): { width?: number; height?: number } {
  const lower = mimeType.toLowerCase();
  if ((lower.includes("png") || hasPngSignature(buffer)) && buffer.byteLength >= 24 && hasPngSignature(buffer)) {
    return {
      width: buffer.readUInt32BE(16),
      height: buffer.readUInt32BE(20),
    };
  }
  if ((lower.includes("jpeg") || lower.includes("jpg") || hasJpegSignature(buffer)) && hasJpegSignature(buffer)) {
    return jpegDimensions(buffer);
  }
  return {};
}

function hasPngSignature(buffer: Buffer): boolean {
  return buffer.byteLength >= 8 &&
    buffer[0] === 0x89 &&
    buffer[1] === 0x50 &&
    buffer[2] === 0x4e &&
    buffer[3] === 0x47 &&
    buffer[4] === 0x0d &&
    buffer[5] === 0x0a &&
    buffer[6] === 0x1a &&
    buffer[7] === 0x0a;
}

function hasJpegSignature(buffer: Buffer): boolean {
  return buffer.byteLength >= 2 && buffer[0] === 0xff && buffer[1] === 0xd8;
}

function jpegDimensions(buffer: Buffer): { width?: number; height?: number } {
  let offset = 2;
  while (offset + 9 < buffer.byteLength) {
    if (buffer[offset] !== 0xff) {
      offset += 1;
      continue;
    }
    const marker = buffer[offset + 1];
    const length = buffer.readUInt16BE(offset + 2);
    if (length < 2) return {};
    if (marker >= 0xc0 && marker <= 0xc3) {
      return {
        height: buffer.readUInt16BE(offset + 5),
        width: buffer.readUInt16BE(offset + 7),
      };
    }
    offset += 2 + length;
  }
  return {};
}

function extractCaptureImageUrl(
  upstream: unknown,
  parsed: ParsedUpstreamToolResult,
): string | undefined {
  const rawContent = asRecord(upstream).content;
  const content = Array.isArray(rawContent)
    ? rawContent.filter(isRecord)
    : [];
  for (const item of content) {
    if (item.type === "image") {
      const imageUrl = firstHttpUrl([
        item.url,
        item.imageUrl,
        item.image_url,
        item.screenshotUrl,
        item.downloadUrl,
      ]);
      if (imageUrl) return imageUrl;
    }
  }
  const candidates: unknown[] = [parsed.json, upstream];
  for (const item of content) {
    const text = asOptionalString(item.text);
    if (!text) continue;
    const textUrl = firstHttpUrl([text]);
    if (textUrl) return textUrl;
    candidates.push(parseJsonLenient(text));
  }
  return findCaptureImageUrl(candidates);
}

function findCaptureImageUrl(values: unknown[]): string | undefined {
  for (const value of values) {
    const found = findCaptureImageUrlInValue(value, 0);
    if (found) return found;
  }
  return undefined;
}

function findCaptureImageUrlInValue(value: unknown, depth: number): string | undefined {
  if (depth > 6) {
    return undefined;
  }
  if (typeof value === "string") {
    return firstHttpUrl([value]);
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findCaptureImageUrlInValue(item, depth + 1);
      if (found) return found;
    }
    return undefined;
  }
  if (!isRecord(value)) {
    return undefined;
  }
  const priorityKeys = [
    "url",
    "imageUrl",
    "image_url",
    "screenshotUrl",
    "screenshot_url",
    "downloadUrl",
    "download_url",
    "src",
  ];
  const priorityUrl = firstHttpUrl(priorityKeys.map((key) => value[key]));
  if (priorityUrl) {
    return priorityUrl;
  }
  for (const item of Object.values(value)) {
    const found = findCaptureImageUrlInValue(item, depth + 1);
    if (found) return found;
  }
  return undefined;
}

function firstHttpUrl(values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value !== "string") continue;
    const trimmed = value.trim();
    if (!trimmed) continue;
    const direct = normalizeHttpUrl(trimmed);
    if (direct) return direct;
    const match = /https?:\/\/[^\s"'<>]+/u.exec(trimmed);
    const matched = match ? normalizeHttpUrl(match[0]) : undefined;
    if (matched) return matched;
  }
  return undefined;
}

function normalizeHttpUrl(value: string): string | undefined {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:"
      ? url.toString()
      : undefined;
  } catch {
    return undefined;
  }
}

async function loadTaskPlan(
  args: FigmaReplRunTaskPlanArguments,
  session: FigmaReplSession,
): Promise<{
  planPath?: string;
  steps: FigmaReplTaskPlanStep[];
}> {
  const planPath = resolveWorkspaceAwareFile(args.planPath, session, "planPath");
  const planValue = planPath
    ? JSON.parse(await readFile(planPath, "utf8"))
    : undefined;
  const planRecord = asRecord(planValue);
  const steps = Array.isArray(args.steps)
    ? args.steps
    : Array.isArray(planValue)
      ? planValue
      : Array.isArray(planRecord.steps)
        ? planRecord.steps
        : undefined;
  if (!steps || steps.length === 0) {
    throw new Error('Tool argument "steps" or "planPath" with steps is required.');
  }
  return {
    planPath,
    steps: steps.map((step) => asRecord(step) as FigmaReplTaskPlanStep),
  };
}

function resolveTaskPlanResultFile(
  args: FigmaReplRunTaskPlanArguments,
  planPath: string | undefined,
  session: FigmaReplSession,
): string {
  const explicit = resolveWorkspaceAwareFile(args.resultFile ?? args.outputFile, session, "resultFile/outputFile");
  if (explicit) return explicit;
  if (planPath) {
    return planPath.replace(/\.json$/iu, ".result.json");
  }
  if (session.workspace) {
    return resolveWorkspaceFile(
      session.workspace.sessionDir,
      `${slugifyTaskName(args.title)}.plan.result.json`,
      "resultFile/outputFile",
    );
  }
  throw new Error('Tool argument "resultFile" or "outputFile" is required for inline task plans.');
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
    return parseJsonToolResult(
      await handleRunScriptFile(asRunScriptFileArgs({ ...commonArgs, ...stepArgs }), options.runtime),
    ) as Record<string, unknown>;
  }
  if (options.type === "asset-manifest") {
    return parseJsonToolResult(
      await handleApplyAssetManifest(asApplyAssetManifestArgs({ ...commonArgs, ...stepArgs }), options.runtime),
    ) as Record<string, unknown>;
  }
  if (options.type === "screenshot-capture") {
    return parseJsonToolResult(
      await handleCaptureNode(asCaptureNodeArgs({ ...commonArgs, ...stepArgs }), options.runtime),
    ) as Record<string, unknown>;
  }
  if (options.type === "upstream-tool") {
    return parseJsonToolResult(
      await handleCallUpstreamTool(asCallUpstreamToolArgs({ ...commonArgs, ...stepArgs }), options.runtime),
    ) as Record<string, unknown>;
  }
  throw new Error(`Unsupported figma_repl_run_task_plan step type "${options.type}".`);
}

function withTaskPlanDefaultFiles(
  stepArgs: Record<string, unknown>,
  type: string,
  id: string,
  session: FigmaReplSession,
): Record<string, unknown> {
  if (!session.workspace) {
    return stepArgs;
  }
  const stepSlug = slugifyTaskName(id || type || "step");
  const next = { ...stepArgs };
  const hasResultFile = asOptionalString(next.resultFile ?? next.outputFile) !== undefined;
  if (type === "script-file") {
    if (!hasResultFile) {
      next.resultFile = `${stepSlug}.result.json`;
    }
    return next;
  }
  if (type === "asset-manifest") {
    if (!hasResultFile) {
      next.resultFile = `${stepSlug}.assets.result.json`;
    }
    return next;
  }
  if (type === "screenshot-capture") {
    if (!asOptionalString(next.outputFile)) {
      next.outputFile = `${stepSlug}.png`;
    }
    if (!asOptionalString(next.resultFile)) {
      next.resultFile = `${stepSlug}.capture.result.json`;
    }
    return next;
  }
  return next;
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
  switch (value) {
    case "figma_repl_run_script_file":
    case "run_script_file":
    case "script":
    case "script-file":
      return "script-file";
    case "figma_repl_apply_asset_manifest":
    case "apply_asset_manifest":
    case "asset_manifest":
    case "asset-manifest":
      return "asset-manifest";
    case "figma_repl_capture_node":
    case "capture_node":
    case "screenshot":
    case "screenshot-capture":
      return "screenshot-capture";
    case "figma_repl_call_upstream_tool":
    case "call_upstream_tool":
    case "upstream":
    case "upstream-tool":
      return "upstream-tool";
    default:
      return value ?? "script-file";
  }
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

function resolveScriptOutputFiles(args: FigmaReplRunScriptFileArguments, session?: FigmaReplSession): ScriptOutputFilePaths {
  const outputDir = asOptionalString(args.outputDir);
  if (outputDir && !isAbsolute(outputDir)) {
    throw new Error('Tool argument "outputDir" must be an absolute path.');
  }
  if (!outputDir && session?.workspace) {
    const sessionDir = session.workspace.sessionDir;
    const inputFile = asOptionalString(args.inputFile);
    const defaultResult = inputFile ? resultFileNameForScript(inputFile) : session.workspace.files.result;
    return {
      resultFile: resolveWorkspaceOutputFile(args.resultFile ?? args.outputFile, sessionDir, defaultResult, "resultFile/outputFile"),
      diagnosticsFile: args.diagnosticsFile ? resolveWorkspaceOutputFile(args.diagnosticsFile, sessionDir, "diagnostics.json", "diagnosticsFile") : undefined,
      summaryFile: args.summaryFile ? resolveWorkspaceOutputFile(args.summaryFile, sessionDir, "summary.md", "summaryFile") : undefined,
    };
  }
  const hasOutputDir = Boolean(outputDir);
  return {
    resultFile: resolveOptionalOutputFile(args.resultFile ?? args.outputFile, outputDir, hasOutputDir ? "result.json" : undefined, "resultFile/outputFile"),
    diagnosticsFile: resolveOptionalOutputFile(args.diagnosticsFile, outputDir, hasOutputDir ? "diagnostics.json" : undefined, "diagnosticsFile"),
    summaryFile: resolveOptionalOutputFile(args.summaryFile, outputDir, hasOutputDir ? "summary.md" : undefined, "summaryFile"),
  };
}

function resolveScriptInputPath(args: FigmaReplRunScriptFileArguments, session: FigmaReplSession): string {
  const scriptPath = asOptionalString(args.scriptPath);
  if (scriptPath) {
    if (!isAbsolute(scriptPath)) {
      throw new Error('Tool argument "scriptPath" must be an absolute path. Use inputFile after figma_repl_init_workspace for workspace-relative files.');
    }
    return scriptPath;
  }
  const inputFile = asOptionalString(args.inputFile);
  if (!inputFile) {
    throw new Error('Tool argument "scriptPath" or "inputFile" is required.');
  }
  if (!session.workspace) {
    throw new Error("inputFile requires an initialized file-context workspace. Call figma_repl_init_workspace first.");
  }
  return resolveWorkspaceFile(session.workspace.sessionDir, inputFile, "inputFile");
}

function resolveWorkspaceOutputFile(
  value: unknown,
  baseDir: string,
  fallbackName: string,
  argumentName: string,
): string {
  const raw = asOptionalString(value) ?? fallbackName;
  return isAbsolute(raw) ? raw : resolveWorkspaceFile(baseDir, raw, argumentName);
}

function resolveOptionalOutputFile(
  value: unknown,
  outputDir: string | undefined,
  fallbackName: string | undefined,
  name: string,
): string | undefined {
  const raw = asOptionalString(value) ?? fallbackName;
  if (!raw) {
    return undefined;
  }
  if (isAbsolute(raw)) {
    return raw;
  }
  if (!outputDir) {
    throw new Error(`Tool argument "${name}" must be absolute unless outputDir is provided.`);
  }
  const resolved = resolve(outputDir, raw);
  if (!isPathInside(outputDir, resolved)) {
    throw new Error(`Tool argument "${name}" must stay inside outputDir when relative.`);
  }
  return resolved;
}

async function writeJsonFile(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(removeUndefined(value), null, 2)}\n`, "utf8");
}

async function writeMarkdownFile(path: string, value: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, value.endsWith("\n") ? value : `${value}\n`, "utf8");
}

function effectiveInlineResultLimit(value: unknown, files: ScriptOutputFilePaths): unknown {
  if (value !== undefined && value !== null) {
    return value;
  }
  return files.resultFile || files.diagnosticsFile || files.summaryFile
    ? DEFAULT_INLINE_RESULT_LIMIT
    : undefined;
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

function resolveTaskWorkspace(options: {
  taskSlug: string;
  taskRoot?: unknown;
  workspaceDir?: unknown;
}): string {
  const explicitWorkspace = asOptionalString(options.workspaceDir);
  if (explicitWorkspace) {
    if (!isAbsolute(explicitWorkspace)) {
      throw new Error('Tool argument "taskDir/workspaceDir" must be an absolute path.');
    }
    return explicitWorkspace;
  }
  const explicitRoot = asOptionalString(options.taskRoot);
  const root = explicitRoot ?? process.env[TASK_WORKSPACE_ROOT_ENV] ?? resolve(tmpdir(), "figma-repl-mcp", "tasks");
  if (!isAbsolute(root)) {
    throw new Error(`Tool argument "taskRoot" and ${TASK_WORKSPACE_ROOT_ENV} must be absolute paths when provided.`);
  }
  return resolve(root, options.taskSlug);
}

function createSessionWorkspace(options: {
  cwd: string;
  dirName?: unknown;
  fileKey?: string;
  fileSlug: string;
  intentSlug: string;
}): FigmaReplSessionWorkspace {
  const dirName = asOptionalString(options.dirName) ?? DEFAULT_WORKSPACE_DIR_NAME;
  if (isAbsolute(dirName) || dirName.includes("/") || dirName.includes("\\") || dirName.includes("..")) {
    throw new Error('Tool argument "dirName" must be a simple directory name.');
  }
  const root = resolve(options.cwd, dirName);
  const fileContext = normalizeFileContextDirectory(options.fileKey, options.fileSlug);
  const fileDir = resolve(root, fileContext);
  if (!isPathInside(root, fileDir)) {
    throw new Error("Resolved file workspace must stay inside the workspace root.");
  }
  const script = `${options.intentSlug}.figma.js`;
  const result = `${options.intentSlug}.result.json`;
  return {
    root,
    fileDir,
    fileContext,
    fileKey: options.fileKey,
    fileSlug: options.fileSlug,
    intentSlug: options.intentSlug,
    sessionDir: fileDir,
    scriptPath: resolve(fileDir, script),
    resultFile: resolve(fileDir, result),
    files: {
      script,
      result,
    },
  };
}

async function ensureWorkspaceDirectories(workspace: FigmaReplSessionWorkspace): Promise<void> {
  await mkdir(workspace.sessionDir, { recursive: true });
}

function resolvePreparedTaskWorkspace(
  args: FigmaReplPrepareTaskArguments,
  taskSlug: string,
  session?: FigmaReplSession,
): FigmaReplSessionWorkspace {
  if (session?.workspace && !args.taskDir && !args.workspaceDir && !args.taskRoot) {
    const fileSlug = deriveFileSlug(args, session);
    return createWorkspaceFromFileDir({
      root: session.workspace.root,
      fileDir: resolve(session.workspace.root, normalizeFileContextDirectory(session.fileKey, fileSlug)),
      fileKey: session.fileKey,
      fileSlug,
      intentSlug: taskSlug,
    });
  }
  const explicitWorkspaceDir = asOptionalString(args.taskDir ?? args.workspaceDir);
  if (explicitWorkspaceDir) {
    if (!isAbsolute(explicitWorkspaceDir)) {
      throw new Error('Tool argument "taskDir/workspaceDir" must be an absolute path.');
    }
    return createWorkspaceFromSessionDir(explicitWorkspaceDir, taskSlug);
  }
  const workspaceDir = resolveTaskWorkspace({
    taskSlug,
    taskRoot: args.taskRoot,
    workspaceDir: undefined,
  });
  return createWorkspaceFromSessionDir(workspaceDir, taskSlug);
}

function createWorkspaceFromSessionDir(sessionDir: string, taskSlug: string): FigmaReplSessionWorkspace {
  return createWorkspaceFromFileDir({
    root: dirname(sessionDir),
    fileDir: sessionDir,
    fileSlug: slugifyTaskName(basename(sessionDir)),
    intentSlug: taskSlug,
  });
}

function createWorkspaceFromFileDir(options: {
  root: string;
  fileDir: string;
  fileKey?: string;
  fileSlug: string;
  intentSlug: string;
}): FigmaReplSessionWorkspace {
  const script = `${options.intentSlug}.figma.js`;
  const result = `${options.intentSlug}.result.json`;
  if (!isPathInside(options.root, options.fileDir)) {
    throw new Error("Resolved file workspace must stay inside the workspace root.");
  }
  return {
    root: options.root,
    fileDir: options.fileDir,
    fileContext: normalizeFileContextDirectory(options.fileKey, options.fileSlug),
    fileKey: options.fileKey,
    fileSlug: options.fileSlug,
    intentSlug: options.intentSlug,
    sessionDir: options.fileDir,
    scriptPath: resolve(options.fileDir, script),
    resultFile: resolve(options.fileDir, result),
    files: {
      script,
      result,
    },
  };
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

function normalizeFileContextDirectory(fileKey: string | undefined, fileSlug: string): string {
  if (fileKey) {
    if (isAbsolute(fileKey) || fileKey.includes("/") || fileKey.includes("\\") || fileKey.includes("..")) {
      throw new Error('Tool argument "fileKey" must be a simple Figma file key.');
    }
    return fileKey;
  }
  return fileSlug;
}

function resultFileNameForScript(scriptName: string): string {
  if (scriptName.endsWith(".figma.js")) {
    return `${scriptName.slice(0, -".figma.js".length)}.result.json`;
  }
  if (scriptName.endsWith(".js")) {
    return `${scriptName.slice(0, -".js".length)}.result.json`;
  }
  return `${slugifyTaskName(scriptName)}.result.json`;
}

function resolveWorkspaceFile(baseDir: string, fileName: string, argumentName: string): string {
  if (isAbsolute(fileName) || fileName.includes("..") || /^[A-Za-z]:/u.test(fileName) || fileName.startsWith("\\\\")) {
    throw new Error(`Tool argument "${argumentName}" must be a workspace-relative file name.`);
  }
  const resolved = resolve(baseDir, fileName);
  if (!isPathInside(baseDir, resolved)) {
    throw new Error(`Tool argument "${argumentName}" must stay inside the file-context workspace.`);
  }
  return resolved;
}

function normalizeTaskScriptName(value: unknown, taskSlug: string): string {
  const scriptName = asOptionalString(value) ?? `${taskSlug}.figma.js`;
  if (isAbsolute(scriptName) || scriptName.includes("/") || scriptName.includes("\\")) {
    throw new Error('Tool argument "fileName/scriptName" must be a file name, not a path.');
  }
  if (!scriptName.endsWith(".figma.js")) {
    throw new Error('Tool argument "fileName/scriptName" must end with ".figma.js".');
  }
  return scriptName;
}

async function writeTaskFile(path: string, content: string, overwrite: boolean): Promise<void> {
  if (!overwrite) {
    try {
      await readFile(path, "utf8");
      throw new Error(`Refusing to overwrite existing file without overwrite=true: ${path}`);
    } catch (error) {
      if (error instanceof Error && error.message.startsWith("Refusing to overwrite")) {
        throw error;
      }
    }
  }
  await writeFile(path, content, "utf8");
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

function createFileWorkflowPayload(): Record<string, unknown> {
  return {
    primaryTool: "figma_repl_run_script_file",
    fileExtension: ".figma.js",
    initTool: "figma_repl_init_workspace",
    prepareTool: "figma_repl_prepare_task",
    planTool: "figma_repl_plan_task",
    workspaceLayout: "<cwd>/figma-mcp/<fileKey-or-fileSlug>/<intentSlug>.figma.js + <intentSlug>.result.json",
    outputFiles: ["inputFile", "outputFile", "inlineResultLimit"],
    workflowTools: ["figma_repl_apply_asset_manifest", "figma_repl_capture_node", "figma_repl_run_task_plan"],
    helpers: ["$", "$.find", "$.findAll", "$.create", "$.text", "$.layout", "$.imageAsset", "$.screenshot", "$.select", "$.cloneNodeTree", "$.checkpoint", "$.inspect"],
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
    ],
  };
}

function searchApiCards(query: string, maxCards: number): FigmaReplApiCard[] {
  const tokens = tokenizeQuery(query);
  return FIGMA_REPL_API_CARDS
    .map((card) => ({
      card,
      score: scoreApiCard(card, tokens, query.toLowerCase()),
    }))
    .filter((entry) => entry.score > 0)
    .sort((left, right) => right.score - left.score || left.card.id.localeCompare(right.card.id))
    .slice(0, maxCards)
    .map((entry) => entry.card);
}

function chooseApiCardsForIntent(intent: string, maxCards: number): FigmaReplApiCard[] {
  const cards = searchApiCards(intent, maxCards);
  return cards.length > 0 ? cards : FIGMA_REPL_API_CARDS.slice(0, maxCards);
}

function scoreApiCard(card: FigmaReplApiCard, tokens: string[], lowerQuery: string): number {
  const haystack = [
    card.id,
    card.title,
    card.surface,
    ...card.intents,
    ...card.helpers,
    ...card.pluginApi,
    ...card.pitfalls,
  ].join(" ").toLowerCase();
  return (
    (haystack.includes(lowerQuery) ? 50 : 0) +
    tokens.filter((token) => haystack.includes(token)).length * 10
  );
}

function createIntentSuggestions(intent: string, maxCards: number): Record<string, unknown> {
  const cards = chooseApiCardsForIntent(intent, maxCards);
  return {
    cards,
    workflow: createFileWorkflowPayload(),
    toolOrder: [
      "figma_repl_prepare_task",
      "figma_repl_api_card",
      "figma_repl_run_script_file(dryRun=true)",
      "figma_repl_run_script_file",
      "figma_repl_inspect",
    ],
    fallback: "Use figma_repl_docs_search or figma_repl_api_lookup when the curated card is insufficient.",
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
      purpose: "Unified Figma-facing MCP facade for agents after OAuth registration. Stay inside figma-repl-mcp first; it keeps local session metadata/handles and delegates to upstream official Figma MCP tools when the file workflow is not enough.",
      preferredFlow: [
        "figma_repl_capabilities to choose the facade path",
        "figma_repl_init_workspace with an absolute cwd, fileUrl or fileKey, and an intent",
        "figma_repl_prepare_task or figma_repl_plan_task for repairable .figma.js workspaces",
        "figma_repl_api_card or figma_repl_suggest_api for compact local guidance when needed",
        "figma_repl_open with fileUrl and expectedSurface for stateful Plugin API work",
        "figma_repl_inspect or figma_repl_validate_handles before mutation",
        "figma_repl_run_script_file with inputFile and dryRun=true for primary .figma.js workflows, output files, and line-aware repair",
        "figma_repl_apply_asset_manifest for large generated assets: create target rectangles in script, then upload/fill from local files through a manifest",
        "figma_repl_capture_node for final visual QA captures saved to local files",
        "figma_repl_run_task_plan for sequential file plans that combine script dry-runs/exec, asset manifests, captures, and upstream tool calls",
        "figma_repl_call_upstream_tool for official capabilities not covered by the file workflow",
      ],
      handles: "Use stable local handles like $card instead of carrying JS object references between calls.",
      upstreamDelegation: "The REPL can call upstream official tools through figma_repl_call_upstream_tool or return compact routing guidance from docs/API lookup.",
    },
    patterns: {
      text: "Use $.text, or call figma.loadFontAsync before mutating characters/fontName in native Plugin API code.",
      createUi: "Use $.create for common Design nodes and native Plugin API calls for advanced construction.",
      transaction: "Use dryRun=true first, then execute the same .figma.js file; add $.checkpoint calls before/after meaningful batches to return handle and node summaries.",
      clone: "Use $.cloneNodeTree to copy a node to the side; it clones outer-to-inner and preserves instance subtrees whole when children cannot be rebuilt.",
      designSystem: "Use native Plugin API calls in .figma.js for variables/styles/components; route full library publishing, FigJam, and Slides workflows through upstream tools.",
      query: "Prefer findOne/query scoped to currentPage or a handle; figma.root.findAll is blocked.",
      pages: "Use targetPageId or one setCurrentPageAsync call; direct figma.currentPage assignment is blocked.",
      selection: "Use $.select instead of direct figma.currentPage.selection access in repairable scripts.",
      validation: "Use figma_repl_validate_handles before mutating cached handles from an earlier call.",
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
        scriptPath: "Absolute path escape hatch. Prefer inputFile after figma_repl_init_workspace.",
        inputFile: "File name inside <cwd>/figma-mcp/<fileKey-or-fileSlug>/ after workspace initialization.",
        dryRun: "Read, diagnose, inject helpers, and return compiledScript without calling upstream Figma.",
        strict: "Promote warnings to fatal diagnostics.",
        expectedSurface: "design, figjam, or slides; blocks obvious wrong-surface API usage.",
        targetPageId: "Switch once to a known page before the script body runs.",
        allowDangerousOperations: "Bypasses only dynamic/destructive guards after exact file review.",
        helperProfile: "auto, minimal, asset, clone, or full. Defaults to auto to keep upstream payloads smaller while injecting heavy helpers only when source uses them.",
        outputFile: "File name inside the initialized file-context folder. Defaults to the input script basename plus .result.json.",
        outputDir: "Advanced absolute directory escape hatch for split output files.",
        resultFile: "Advanced absolute file path, outputDir-relative JSON path, or file-context-folder file name for full result output.",
        diagnosticsFile: "Advanced optional JSON file when diagnostics must be split out of the paired result file.",
        summaryFile: "Advanced optional Markdown file when a separate summary is required.",
        inlineResultLimit: "Non-negative byte cap for large inline fields; omitted fields stay available in the paired result file.",
      },
      helpers: {
        "$": "Resolve a cached handle like $card, $selection, $currentPage, or a raw Figma node id.",
        "$.find": "Find one node by { name, type, within, as, required } and optionally remember it.",
        "$.findAll": "Find matching nodes by scoped criteria.",
        "$.text": "Create or update a text node with font loading and optional handle storage.",
        "$.layout": "Apply auto-layout properties to a target node.",
        "$.create": "Create a common Design node with optional parent, size, layout, appearance, and handle.",
        "$.imageAsset": "Create or update an image-fill rectangle from small generated PNG/JPEG base64 or byte arrays; use upload_assets/upstream asset fill workflow for large files.",
        "$.screenshot": "Attempt a target node screenshot when upstream supports node.screenshot(); fall back to official screenshot tools for final QA if no image payload is returned.",
        "$.select": "Resolve handles/node ids, validate selectable scene nodes, update selection, and optionally zoom.",
        "$.cloneNodeTree": "Copy a source node beside itself with outer-to-inner cloning and instance-subtree preservation.",
        "$.checkpoint": "Return handle and node summaries at repair-friendly points.",
        "$.inspect": "Resolve a handle or node id and return a compact node summary.",
      },
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
    apiCards: {
      tool: "figma_repl_api_card",
      resource: "figma-repl://api-cards",
      cards: FIGMA_REPL_API_CARDS.map((card) => ({
        id: card.id,
        title: card.title,
        intents: card.intents,
        surface: card.surface,
      })),
    },
    intents: {
      tool: "figma_repl_suggest_api",
      resource: "figma-repl://intents",
      examples: ["create responsive card UI", "update text styles", "make component variants", "validate stale handles"],
    },
    facadeRoutingDelegationBoundaries: [
      "Keep the agent on figma-repl-mcp; for new-file or generation workflows, call the appropriate upstream official tool through figma_repl_call_upstream_tool or return compact routing guidance.",
      "For small generated local PNG/JPEG assets in .figma.js, use $.imageAsset({ base64, parent, size, position, as }); for large assets, create target rectangles then route through an upstream official upload_assets workflow when available.",
      "Do not use PluginData APIs for agent state; use local session handles or a dedicated storage workflow.",
      "For FigJam, Slides, Code Connect, or design-system generation semantics, keep the facade entrypoint and delegate to upstream official tools or compact docs/API lookup rather than asking agents to read the full reference tree.",
    ],
    docsLookup: {
      docsTool: "figma_repl_docs_search",
      apiTool: "figma_repl_api_lookup",
      docsResource: "figma-repl://docs",
      apiResource: "figma-repl://api",
      compactCardTool: "figma_repl_api_card",
      intentTool: "figma_repl_suggest_api",
      guardrail: "All lookup output is capped and line-evidenced; the facade does not dump plugin-api-standalone.d.ts.",
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
    "figma-repl://guide": payload.guide,
    "figma-repl://patterns": payload.patterns,
    "figma-repl://scripts": payload.scriptWorkflow,
    "figma-repl://file-workflow": payload.fileWorkflow,
    "figma-repl://workflow-tools": payload.workflowTools,
    "figma-repl://api-cards": {
      tool: "figma_repl_api_card",
      cards: FIGMA_REPL_API_CARDS,
      guidance: "Curated compact cards for common .figma.js tasks; use figma_repl_api_lookup only when exact API details are missing.",
    },
    "figma-repl://intents": {
      tool: "figma_repl_suggest_api",
      workflow: createFileWorkflowPayload(),
      examples: [
        createIntentSuggestions("create UI card with auto layout and text", 3),
        createIntentSuggestions("make component variants", 3),
        createIntentSuggestions("update color token", 3),
      ],
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
      purpose: "Compact searchable facade guidance for bundled Figma router skill/reference snippets.",
      tool: "figma_repl_docs_search",
      workflow: [
        "Search with a narrow query.",
        "Use file/line evidence from capped snippets.",
        "Run a narrower search instead of reading the full references tree.",
      ],
      allowlistSize: DOCS_SEARCH_ALLOWLIST.length,
      maxResults: MAX_DOCS_SEARCH_RESULTS,
      maxSnippetLines: MAX_DOCS_SEARCH_SNIPPET_LINES,
    },
    "figma-repl://api": {
      purpose: "Targeted Figma Plugin API symbol lookup without dumping the bundled declaration file.",
      tool: "figma_repl_api_lookup",
      workflow: [
        "Search exact symbols such as createFrame, loadFontAsync, VariableCollection, or SceneNode.",
        "Use snippets with file/line evidence.",
        "For broader usage guidance, use figma_repl_docs_search.",
      ],
      guardrail: "The full plugin-api-standalone.d.ts file is never returned as one response.",
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

function createReplToolDescriptions(): Record<string, unknown>[] {
  return [
    {
      name: "figma_repl_capabilities",
      description:
        "Return the compact unified facade guide, file workflow, docs/API lookup workflow, safety policy, routing/delegation boundaries, and examples for figma-repl-mcp.",
      inputSchema: objectSchema({
        title: titleProperty(),
      }, ["title"]),
    },
    {
      name: "figma_repl_open",
      description:
        "Create or update a local Figma REPL session. Records fileKey/surface/page context, local handles, and upstream use_figma settings.",
      inputSchema: objectSchema({
        title: titleProperty(),
        sessionId: stringProperty("Stable local session id. Defaults to 'default'."),
        label: stringProperty("Human-readable session label."),
        fileUrl: stringProperty("Optional Figma file URL stored in local session metadata."),
        expectedSurface: enumProperty(["design", "figjam", "slides"], "Expected Figma surface; blocks mismatched Design/FigJam/Slides usage later."),
        currentPageId: stringProperty("Optional current Figma page id stored in local session metadata."),
        reset: booleanProperty("Reset local handles and history for this session before opening."),
        connect: booleanProperty("Connect to upstream Figma MCP during open. Defaults to true."),
        refresh: booleanProperty("Refresh cached upstream tool list."),
        upstreamTool: stringProperty("Override upstream eval tool name. Defaults to use_figma."),
        upstreamArgument: stringProperty("Override upstream JavaScript argument name. Usually code."),
        upstreamArguments: objectProperty("Extra arguments merged into every upstream eval call for this session."),
        handles: objectProperty("Initial local handles, for example {\"$header\": \"12:34\"}."),
      }, ["title"]),
    },
    {
      name: "figma_repl_eval",
      description:
        "Run one batched JavaScript transaction through upstream use_figma. Diagnostics block unsafe API-contract/read-mode/surface mistakes before dispatch.",
      inputSchema: objectSchema({
        title: titleProperty(),
        sessionId: stringProperty("Local REPL session id. Defaults to 'default'."),
        code: stringProperty("JavaScript body executed inside an async function in the Figma Plugin API context. Use return to send structured output."),
        mode: enumProperty(["read", "write"], "Use read to reject likely mutations before dispatch. Defaults to write."),
        expectedSurface: enumProperty(["design", "figjam", "slides"], "Expected Figma surface for this call."),
        returnMode: enumProperty(["auto", "json", "text", "raw"], "Controls how much parsed/text upstream output is returned."),
        allowDangerousOperations: booleanProperty("Allow dynamic/destructive guarded patterns only; does not bypass API contract, surface, or read-mode diagnostics."),
        upstreamTool: stringProperty("Override upstream eval tool name for this call."),
        upstreamArgument: stringProperty("Override upstream JavaScript argument name for this call."),
        upstreamArguments: objectProperty("Extra arguments sent to the upstream tool for this call."),
        handleUpdates: objectProperty("Local handle updates merged before running code."),
        includeRawUpstream: booleanProperty("Include raw upstream MCP result in the response."),
      }, ["title", "code"]),
    },
    {
      name: "figma_repl_run_script_file",
      description:
        "Primary file-based JavaScript workflow for Figma REPL. Reads an absolute scriptPath or a session-workspace inputFile, injects $ helpers, writes output files, and optionally executes through upstream use_figma.",
      inputSchema: objectSchema({
        title: titleProperty(),
        sessionId: stringProperty("Local REPL session id or task name. Defaults to 'default'."),
        scriptPath: stringProperty("Absolute path to a local JavaScript file. Prefer inputFile after figma_repl_init_workspace."),
        inputFile: stringProperty("File name inside the initialized file-context directory. Defaults are created by figma_repl_prepare_task."),
        helperProfile: enumProperty(["auto", "minimal", "asset", "clone", "full"], "Controls injected $ helper size. auto injects heavy $.imageAsset/$.cloneNodeTree only when the script source uses them."),
        dryRun: booleanProperty("Read, diagnose, inject helpers, and return compiledScript/script metadata without calling upstream Figma."),
        strict: booleanProperty("Promote warning diagnostics to fatal and reject before upstream execution."),
        expectedSurface: enumProperty(["design", "figjam", "slides"], "Expected Figma surface for this script."),
        targetPageId: stringProperty("Optional PAGE node id used for one setCurrentPageAsync call before the script body runs."),
        allowDangerousOperations: booleanProperty("Allow dynamic/destructive guarded patterns only after reviewing the exact file."),
        upstreamTool: stringProperty("Override upstream eval tool name for this call."),
        upstreamArgument: stringProperty("Override upstream JavaScript argument name for this call."),
        upstreamArguments: objectProperty("Extra arguments sent to the upstream tool for this call."),
        includeRawUpstream: booleanProperty("Include raw upstream MCP result in the response."),
        outputDir: stringProperty("Advanced absolute directory escape hatch for split result.json, diagnostics.json, and summary.md output files."),
        outputFile: stringProperty("File name inside the initialized file-context directory. Defaults to the input script basename plus .result.json."),
        resultFile: stringProperty("Advanced absolute file path, outputDir-relative JSON path, or file-context file name for full result output."),
        diagnosticsFile: stringProperty("Advanced optional absolute file path or outputDir-relative JSON path when diagnostics should be split out of the paired result file."),
        summaryFile: stringProperty("Advanced optional absolute file path or outputDir-relative Markdown path when a separate summary is needed."),
        inlineResultLimit: numberProperty("Non-negative byte cap for large inline result fields. Use the paired result file for full payloads."),
      }, ["title"]),
    },
    {
      name: "figma_repl_apply_asset_manifest",
      description:
        "Apply a local asset manifest to Figma target nodes through configurable upstream asset/upload tools. Use for large generated images after .figma.js creates target rectangles.",
      inputSchema: objectSchema({
        title: titleProperty(),
        sessionId: stringProperty("Local REPL session id used for history. Defaults to 'default'."),
        manifestPath: stringProperty("Path to a JSON manifest. Accepts an absolute path or a file name inside the initialized file-context workspace. It may be an array of assets or an object with assets/toolName/argumentsTemplate."),
        assets: {
          type: "array",
          description: "Inline asset entries: { path|filePath|localPath, targetNodeId|nodeId, name?, metadata?, toolName?, arguments? }.",
          items: { type: "object", additionalProperties: true },
        },
        toolName: stringProperty("Default upstream asset/upload/fill tool. If omitted, the REPL selects an advertised asset-like tool and infers args only from recognizable schema fields."),
        arguments: objectProperty("Default upstream arguments template. Use {{path}}, {{targetNodeId}}, {{name}}, {{metadata.foo}}, or {{asset}} placeholders."),
        argumentsTemplate: objectProperty("Alias for arguments. Prefer this when mirroring fake or upstream schemas explicitly."),
        validateTargets: booleanProperty("Defaults true. When upstream eval is available, verify target nodes have IMAGE fills after upload."),
        refresh: booleanProperty("Refresh cached upstream tool list before dispatch."),
        resultFile: stringProperty("Optional compact manifest result JSON. Accepts an absolute path or a file name inside the initialized file-context workspace."),
        outputFile: stringProperty("Alias for resultFile."),
        inlineResultLimit: numberProperty("Reserved for compatibility with compact-result workflows; manifest responses are already compact."),
      }, ["title"]),
    },
    {
      name: "figma_repl_capture_node",
      description:
        "Capture one Figma node through a configurable upstream screenshot tool and save image bytes, screenshot URL payloads, or text responses to a local outputFile for final visual QA.",
      inputSchema: objectSchema({
        title: titleProperty(),
        sessionId: stringProperty("Local REPL session id used for history. Defaults to 'default'."),
        nodeId: stringProperty("Figma node id to capture."),
        targetNodeId: stringProperty("Alias for nodeId."),
        outputFile: stringProperty("Local file path where the screenshot image, downloaded URL payload, or text response is written. Accepts an absolute path or a file name inside the initialized file-context workspace."),
        resultFile: stringProperty("Optional compact capture metadata JSON. Accepts an absolute path or a file name inside the initialized file-context workspace."),
        toolName: stringProperty("Upstream screenshot/capture tool. If omitted, the REPL selects an advertised screenshot-like tool and infers node id only from recognizable schema fields."),
        arguments: objectProperty("Upstream arguments template. Use {{nodeId}} or {{targetNodeId}} placeholders."),
        argumentsTemplate: objectProperty("Alias for arguments."),
        refresh: booleanProperty("Refresh cached upstream tool list before dispatch."),
        inlineResultLimit: numberProperty("Reserved for compatibility with compact-result workflows; capture responses return only file metadata."),
      }, ["title", "outputFile"]),
    },
    {
      name: "figma_repl_run_task_plan",
      description:
        "Run a sequential local JSON task plan: script-file dryRun/execute, asset manifest application, screenshot capture, and generic upstream tool calls. Stops on first failure by default.",
      inputSchema: objectSchema({
        title: titleProperty(),
        sessionId: stringProperty("Default local REPL session id inherited by steps when omitted."),
        planPath: stringProperty("JSON plan path. Accepts an absolute path or a file name inside the initialized file-context workspace. It may be an array of steps or an object with steps."),
        steps: {
          type: "array",
          description: "Inline steps. Supported type/tool values: script-file, asset-manifest, screenshot-capture, upstream-tool.",
          items: { type: "object", additionalProperties: true },
        },
        stopOnFailure: booleanProperty("Stop after the first failed step. Defaults true."),
        resultFile: stringProperty("JSON result file. Accepts an absolute path or a file name inside the initialized file-context workspace. Defaults to <planPath>.result.json for file plans; required for inline plans."),
        outputFile: stringProperty("Alias for resultFile."),
        inlineResultLimit: numberProperty("Reserved for compatibility with compact-result workflows; plan responses are compact per-step statuses."),
      }, ["title"]),
    },
    {
      name: "figma_repl_init_workspace",
      description:
        "Initialize a file-context workspace at <cwd>/<dirName>/<fileKey-or-fileSlug>. Input .figma.js files and paired .result.json outputs live in that same folder.",
      inputSchema: objectSchema({
        title: titleProperty(),
        sessionId: stringProperty("Local REPL session id. Used as an intent fallback after intent/task/title."),
        intent: stringProperty("Human intent used to derive <intentSlug>.figma.js and <intentSlug>.result.json."),
        task: stringProperty("Alias for intent."),
        fileUrl: stringProperty("Figma file URL used to derive fileKey and surface/file context."),
        fileKey: stringProperty("Explicit Figma file key used as the file-context directory name."),
        fileSlug: stringProperty("Fallback file-context slug when no fileKey is available."),
        cwd: stringProperty("Absolute project directory where the figma-mcp workspace directory will be created."),
        dirName: stringProperty("Workspace directory name under cwd. Defaults to figma-mcp."),
        overwrite: booleanProperty("Reserved for compatibility; directories are created idempotently."),
      }, ["title", "cwd"]),
    },
    {
      name: "figma_repl_prepare_task",
      description:
        "Create or reuse an intent-specific .figma.js script and paired .result.json file in the file-context workspace.",
      inputSchema: objectSchema({
        title: titleProperty(),
        sessionId: stringProperty("Local REPL session id. If initialized, files are created under that session file-context workspace."),
        intent: stringProperty("Human intent used to derive <intentSlug>.figma.js and <intentSlug>.result.json."),
        task: stringProperty("Alias for intent."),
        fileUrl: stringProperty("Figma file URL used to derive fileKey/file context when preparing a workspace."),
        fileKey: stringProperty("Explicit Figma file key used as the file-context directory name."),
        fileSlug: stringProperty("Fallback file-context slug when no fileKey is available."),
        goal: stringProperty("Task goal copied into the generated .figma.js file and pending .result.json metadata."),
        taskSlug: stringProperty("Stable slug for the task directory. Defaults from taskName/title."),
        taskName: stringProperty("Human-readable task name used to derive a slug when taskSlug is omitted."),
        taskDir: stringProperty("Absolute task directory override. Preferred public name for workspaceDir."),
        fileName: stringProperty("File name ending in .figma.js. Preferred public name for scriptName."),
        taskRoot: stringProperty(`Absolute task root. Defaults to ${TASK_WORKSPACE_ROOT_ENV}, then OS temp figma-repl-mcp/tasks.`),
        workspaceDir: stringProperty("Alias for taskDir. Absolute workspace directory override."),
        scriptName: stringProperty("Alias for fileName. File name ending in .figma.js. Defaults to <slug>.figma.js."),
        expectedSurface: enumProperty(["design", "figjam", "slides"], "Expected Figma surface persisted on the session and copied into generated guidance."),
        targetPageId: stringProperty("Optional target page id copied into generated guidance."),
        template: stringProperty("Template hint copied into the generated .figma.js comments. V1 templates are curated guidance only."),
        overwrite: booleanProperty("Overwrite existing script/result pair. Defaults false."),
      }, ["title"]),
    },
    {
      name: "figma_repl_plan_task",
      description:
        "Return compact planning guidance for the preferred .figma.js file workflow without reading or writing files.",
      inputSchema: objectSchema({
        title: titleProperty(),
        goal: stringProperty("Natural-language task goal. Preferred public name for task/intent."),
        surface: enumProperty(["design", "figjam", "slides"], "Expected Figma surface. Preferred public name for expectedSurface."),
        workflow: stringProperty("Preferred workflow. Defaults to script-file."),
        task: stringProperty("Short task description."),
        intent: stringProperty("Intent phrase used to suggest compact API cards."),
        expectedSurface: enumProperty(["design", "figjam", "slides"], "Expected Figma surface."),
      }, ["title"]),
    },
    {
      name: "figma_repl_api_card",
      description:
        "Return curated compact API cards for common .figma.js workflow needs before broader docs/API lookup.",
      inputSchema: objectSchema({
        title: titleProperty(),
        card: stringProperty("Card id or topic, for example text, auto-layout, components, variables, pages."),
        query: stringProperty("Search query when card id is not known."),
        maxCards: numberProperty("Maximum cards to return, capped at 8. Defaults to 3."),
      }, ["title"]),
    },
    {
      name: "figma_repl_suggest_api",
      description:
        "Map a natural-language intent to compact API cards, helper choices, and the preferred file workflow.",
      inputSchema: objectSchema({
        title: titleProperty(),
        task: stringProperty("Natural-language task intent. Preferred public name for intent."),
        intent: stringProperty("Natural-language task intent, for example 'create a card with text and auto layout'."),
        surface: enumProperty(["design", "figjam", "slides"], "Expected Figma surface. Preferred public name for expectedSurface."),
        expectedSurface: enumProperty(["design", "figjam", "slides"], "Expected Figma surface."),
        maxCards: numberProperty("Maximum suggested cards, capped at 8. Defaults to 4."),
      }, ["title"]),
    },
    {
      name: "figma_repl_inspect",
      description:
        "Inspect $selection, $currentPage, a stored handle, or a Figma node id through one read-mode use_figma call.",
      inputSchema: objectSchema({
        title: titleProperty(),
        sessionId: stringProperty("Local REPL session id. Defaults to 'default'."),
        target: stringProperty("$selection, $currentPage, a stored handle like $header, or a raw node id. Defaults to $selection."),
        depth: numberProperty("Child summary depth. Defaults to 2."),
        upstreamTool: stringProperty("Override upstream eval tool name for this call."),
        upstreamArgument: stringProperty("Override upstream JavaScript argument name for this call."),
        upstreamArguments: objectProperty("Extra arguments sent to the upstream tool for this call."),
      }, ["title"]),
    },
    {
      name: "figma_repl_cache_get",
      description:
        "Return local REPL sessions, handles, recent command history, fileKey/surface/page context, and last diagnostics without calling Figma.",
      inputSchema: objectSchema({
        title: titleProperty(),
        sessionId: stringProperty("Optional session id to return."),
        includeHistory: booleanProperty("Include command history. Defaults to true."),
        historyLimit: numberProperty("Maximum history entries to return."),
      }, ["title"]),
    },
    {
      name: "figma_repl_validate_handles",
      description:
        "Resolve cached handles or raw node ids through one read-mode upstream eval and report valid, missing, or stale handles.",
      inputSchema: objectSchema({
        title: titleProperty(),
        sessionId: stringProperty("Local REPL session id. Defaults to 'default'."),
        handles: {
          type: "array",
          description: "Optional handle names or raw node ids to validate. Defaults to all cached handles.",
          items: { type: "string" },
        },
        upstreamTool: stringProperty("Override upstream eval tool name for this call."),
        upstreamArgument: stringProperty("Override upstream JavaScript argument name for this call."),
        upstreamArguments: objectProperty("Extra arguments sent to the upstream tool for this call."),
      }, ["title"]),
    },
    {
      name: "figma_repl_list_upstream_tools",
      description:
        "List tools exposed by the upstream official Figma MCP server through the shared OAuth-backed remote client.",
      inputSchema: objectSchema({
        title: titleProperty(),
        refresh: booleanProperty("Refresh cached upstream tool list."),
      }, ["title"]),
    },
    {
      name: "figma_repl_call_upstream_tool",
      description:
        "Proxy one official upstream Figma MCP tool call through figma-repl-mcp so agents can stay on the unified REPL facade for capabilities not covered by the file workflow.",
      inputSchema: objectSchema({
        title: titleProperty(),
        sessionId: stringProperty("Optional local session id used only for history. Defaults to 'default'."),
        toolName: stringProperty("Official upstream Figma MCP tool name to call. Local figma_repl_* tools are rejected."),
        arguments: objectProperty("Arguments sent to the upstream official Figma MCP tool."),
        refresh: booleanProperty("Refresh cached upstream tool list before dispatch."),
        includeRawUpstream: booleanProperty("Include the raw upstream MCP result as raw."),
      }, ["title", "toolName", "arguments"]),
    },
    {
      name: "figma_repl_docs_search",
      description:
        "Search compact, capped snippets from the local Figma router reference tree. Use before reading large bundled docs directly.",
      inputSchema: objectSchema({
        title: titleProperty(),
        query: stringProperty("Keyword query, for example 'component properties' or 'Slides lifecycle'."),
        maxResults: numberProperty(`Maximum results, capped at ${MAX_DOCS_SEARCH_RESULTS}. Defaults to ${DEFAULT_DOCS_SEARCH_MAX_RESULTS}.`),
        maxSnippetLines: numberProperty(`Lines per snippet, capped at ${MAX_DOCS_SEARCH_SNIPPET_LINES}. Defaults to ${DEFAULT_DOCS_SEARCH_SNIPPET_LINES}.`),
      }, ["title", "query"]),
    },
    {
      name: "figma_repl_api_lookup",
      description:
        "Look up a targeted Figma Plugin API symbol in the local API index/reference/d.ts snippets without dumping the full declaration file.",
      inputSchema: objectSchema({
        title: titleProperty(),
        symbol: stringProperty("Figma Plugin API symbol or method name, for example createFrame, loadFontAsync, VariableCollection."),
        maxResults: numberProperty(`Maximum results, capped at ${MAX_DOCS_SEARCH_RESULTS}. Defaults to 5.`),
        maxSnippetLines: numberProperty(`Lines per snippet, capped at ${MAX_DOCS_SEARCH_SNIPPET_LINES}. Defaults to 5.`),
      }, ["title", "symbol"]),
    },
  ];
}

function readReplResource(uri: string, sessions: FigmaReplSessionStore): Record<string, unknown> {
  const staticResource = readStaticReplResource(uri);
  if (staticResource) {
    return staticResource;
  }
  if (uri === "figma-repl://sessions") {
    return {
      contents: [
        {
          uri,
          mimeType: "application/json",
          text: JSON.stringify({ sessions: sessions.list().map((session) => publicSession(session)) }, null, 2),
        },
      ],
    };
  }
  const prefix = "figma-repl://sessions/";
  if (uri.startsWith(prefix)) {
    const sessionId = decodeURIComponent(uri.slice(prefix.length));
    const session = sessions.get(sessionId);
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

async function searchReferenceFiles(options: {
  query: string;
  files: string[];
  maxResults: number;
  maxSnippetLines: number;
  exactSymbol?: boolean;
}): Promise<{
  searchRoot: string;
  maxResults: number;
  maxSnippetLines: number;
  results: ReferenceSearchResult[];
}> {
  const searchRoot = await resolveReferenceRoot();
  const queryTokens = tokenizeQuery(options.query);
  const results: ReferenceSearchResult[] = [];
  for (const file of options.files) {
    const path = resolve(searchRoot, file);
    if (!isPathInside(searchRoot, path)) {
      continue;
    }
    let text: string;
    try {
      text = await readFile(path, "utf8");
    } catch {
      continue;
    }
    results.push(...searchReferenceText({
      file,
      text,
      query: options.query,
      queryTokens,
      maxSnippetLines: options.maxSnippetLines,
      exactSymbol: Boolean(options.exactSymbol),
    }));
  }
  results.sort((left, right) => right.score - left.score || left.file.localeCompare(right.file) || left.lineStart - right.lineStart);
  return {
    searchRoot,
    maxResults: options.maxResults,
    maxSnippetLines: options.maxSnippetLines,
    results: results.slice(0, options.maxResults),
  };
}

function searchReferenceText(options: {
  file: string;
  text: string;
  query: string;
  queryTokens: string[];
  maxSnippetLines: number;
  exactSymbol: boolean;
}): ReferenceSearchResult[] {
  const lines = options.text.split(/\r?\n/u);
  const results: ReferenceSearchResult[] = [];
  const symbolPattern = options.exactSymbol
    ? new RegExp(`\\b${escapeRegExp(options.query)}\\b`, "u")
    : undefined;
  const lowerQuery = options.query.toLowerCase();
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const lower = line.toLowerCase();
    const tokenHits = options.queryTokens.filter((token) => lower.includes(token)).length;
    const exactHit = symbolPattern?.test(line) ?? false;
    const phraseHit = lower.includes(lowerQuery);
    if (!exactHit && !phraseHit && tokenHits === 0) {
      continue;
    }
    const contextBefore = Math.floor((options.maxSnippetLines - 1) / 2);
    const start = Math.max(0, index - contextBefore);
    const end = Math.min(lines.length, start + options.maxSnippetLines);
    const snippetLines = lines.slice(start, end);
    results.push({
      file: options.file,
      lineStart: start + 1,
      lineEnd: end,
      score:
        (exactHit ? 100 : 0) +
        (phraseHit ? 50 : 0) +
        tokenHits * 10 +
        (options.file.endsWith(".d.ts") ? 5 : 0),
      snippet: snippetLines.join("\n").slice(0, 2400),
    });
  }
  return collapseOverlappingResults(results);
}

function collapseOverlappingResults(results: ReferenceSearchResult[]): ReferenceSearchResult[] {
  const collapsed: ReferenceSearchResult[] = [];
  for (const result of results) {
    const previous = collapsed.at(-1);
    if (previous && previous.file === result.file && result.lineStart <= previous.lineEnd) {
      previous.lineEnd = Math.max(previous.lineEnd, result.lineEnd);
      previous.score = Math.max(previous.score, result.score);
      continue;
    }
    collapsed.push(result);
  }
  return collapsed;
}

function tokenizeQuery(query: string): string[] {
  return query
    .toLowerCase()
    .split(/[^a-z0-9_$:.-]+/u)
    .map((token) => token.trim())
    .filter((token) => token.length >= 2);
}

function normalizeLookupQuery(value: unknown, name: string): string {
  if (typeof value !== "string") {
    throw new Error(`Tool argument "${name}" is required and must be a string.`);
  }
  const query = value.trim();
  if (!query) {
    throw new Error(`Tool argument "${name}" must not be empty.`);
  }
  if (query.length > MAX_LOOKUP_QUERY_LENGTH) {
    throw new Error(`Tool argument "${name}" must be ${MAX_LOOKUP_QUERY_LENGTH} characters or fewer.`);
  }
  return query;
}

async function resolveReferenceRoot(): Promise<string> {
  const moduleDir = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    resolve(moduleDir, "../skills/figma-router/references"),
    resolve(moduleDir, "../../skills/figma-router/references"),
    resolve(moduleDir, "../../../skills/figma-router/references"),
    resolve(process.cwd(), "skills/figma-router/references"),
    resolve(process.cwd(), "plugins/figma-mcp-bridge/skills/figma-router/references"),
    resolve(process.cwd(), "../skills/figma-router/references"),
  ];
  for (const candidate of candidates) {
    try {
      await readFile(resolve(candidate, "figma-use.md"), "utf8");
      return candidate;
    } catch {
      // Try the next runtime layout.
    }
  }
  throw new Error(
    "Unable to locate local Figma reference tree for figma-repl-mcp docs/API lookup.",
  );
}

function isPathInside(root: string, path: string): boolean {
  const rel = relative(root, path);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
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

function asEvalArgs(args: Record<string, unknown>): FigmaReplEvalArguments {
  return args as unknown as FigmaReplEvalArguments;
}

function asRunScriptFileArgs(args: Record<string, unknown>): FigmaReplRunScriptFileArguments {
  return args as unknown as FigmaReplRunScriptFileArguments;
}

function asApplyAssetManifestArgs(args: Record<string, unknown>): FigmaReplApplyAssetManifestArguments {
  return args as unknown as FigmaReplApplyAssetManifestArguments;
}

function asCaptureNodeArgs(args: Record<string, unknown>): FigmaReplCaptureNodeArguments {
  return args as unknown as FigmaReplCaptureNodeArguments;
}

function asRunTaskPlanArgs(args: Record<string, unknown>): FigmaReplRunTaskPlanArguments {
  return args as unknown as FigmaReplRunTaskPlanArguments;
}

function asInitWorkspaceArgs(args: Record<string, unknown>): FigmaReplInitWorkspaceArguments {
  return args as unknown as FigmaReplInitWorkspaceArguments;
}

function asPrepareTaskArgs(args: Record<string, unknown>): FigmaReplPrepareTaskArguments {
  return args as unknown as FigmaReplPrepareTaskArguments;
}

function asPlanTaskArgs(args: Record<string, unknown>): FigmaReplPlanTaskArguments {
  return args as unknown as FigmaReplPlanTaskArguments;
}

function asApiCardArgs(args: Record<string, unknown>): FigmaReplApiCardArguments {
  return args as unknown as FigmaReplApiCardArguments;
}

function asSuggestApiArgs(args: Record<string, unknown>): FigmaReplSuggestApiArguments {
  return args as unknown as FigmaReplSuggestApiArguments;
}

function asCallUpstreamToolArgs(args: Record<string, unknown>): FigmaReplCallUpstreamToolArguments {
  return args as unknown as FigmaReplCallUpstreamToolArguments;
}

function asDocsSearchArgs(args: Record<string, unknown>): FigmaReplDocsSearchArguments {
  return args as unknown as FigmaReplDocsSearchArguments;
}

function asApiLookupArgs(args: Record<string, unknown>): FigmaReplApiLookupArguments {
  return args as unknown as FigmaReplApiLookupArguments;
}

function sanitizeSessionId(sessionId: string): string {
  const value = sessionId.trim();
  if (!value) {
    return FIGMA_REPL_DEFAULT_SESSION_ID;
  }
  return value.slice(0, 120);
}

function assertRequiredTitleArgument(args: Record<string, unknown>): void {
  if (typeof args[TOOL_TITLE_ARGUMENT] !== "string") {
    throw new Error('Tool argument "title" is required and must be a string.');
  }
}

function objectSchema(
  properties: Record<string, unknown>,
  required: string[] = [],
): Record<string, unknown> {
  return {
    type: "object",
    properties,
    required,
    additionalProperties: false,
  };
}

function titleProperty(): Record<string, unknown> {
  return stringProperty("Human-readable title used when presenting output to the user.");
}

function stringProperty(description: string): Record<string, unknown> {
  return { type: "string", description };
}

function booleanProperty(description: string): Record<string, unknown> {
  return { type: "boolean", description };
}

function numberProperty(description: string): Record<string, unknown> {
  return { type: "number", description };
}

function objectProperty(description: string): Record<string, unknown> {
  return { type: "object", description, additionalProperties: true };
}

function enumProperty(values: string[], description: string): Record<string, unknown> {
  return { type: "string", enum: values, description };
}

function makeJsonToolResult(value: unknown): Record<string, unknown> {
  return {
    content: [
      {
        type: "text",
        text: JSON.stringify(removeUndefined(value), null, 2),
      },
    ],
  };
}

function parseJsonToolResult(result: Record<string, unknown>): unknown {
  const content = Array.isArray(result.content) ? result.content : [];
  const firstText = content
    .map((item) => asRecord(item).text)
    .find((item): item is string => typeof item === "string");
  if (firstText === undefined) {
    return result;
  }
  return JSON.parse(firstText);
}

function withDefaultTitle<T extends Record<string, unknown>>(
  args: T,
  title: string,
): T & { title: string } {
  return {
    ...args,
    title: typeof args.title === "string" ? args.title : title,
  };
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
