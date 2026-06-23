import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { type RemoteMcpClientOptions } from "./client.js";
import { type ReferenceSearchResult } from "./repl-doc-search.js";
import { assertSafeFigmaReplCode, diagnoseFigmaReplCode, resolveFigmaReplScriptHelperSelection as resolveFigmaReplScriptHelperSelectionInternal, type FigmaReplDiagnostic, type FigmaReplDiagnosticsOptions, type FigmaReplDiagnosticSeverity, type FigmaReplFileDiagnostic, type FigmaReplSurface } from "./repl-script-runner.js";
import type { FigmaReplApplyAssetManifestArguments, FigmaReplCallUpstreamToolArguments, FigmaReplCaptureNodeArguments, FigmaReplDownloadAssetsArguments, FigmaReplEvalArguments, FigmaReplGuidanceArguments, FigmaReplInspectArguments, FigmaReplLookupArguments, FigmaReplOpenArguments, FigmaReplPrepareTaskArguments, FigmaReplRunScriptFileArguments, FigmaReplRunTaskPlanArguments } from "./repl-tool-args.js";
import { type FigmaReplSessionWorkspace } from "./repl-workspace-files.js";
import type { FigmaMcpProxyClient } from "./stdio-server.js";
export declare const FIGMA_REPL_DEFAULT_SESSION_ID = "default";
export { assertSafeFigmaReplCode, diagnoseFigmaReplCode, };
/**
 * @internal Internal-facing helper-selection utility for tests and payload debugging.
 * This is not a stable MCP tool input contract, and callers cannot use it to configure helper injection.
 */
export declare const resolveFigmaReplScriptHelperSelection: typeof resolveFigmaReplScriptHelperSelectionInternal;
export type { FigmaReplDiagnostic, FigmaReplDiagnosticsOptions, FigmaReplDiagnosticSeverity, FigmaReplFileDiagnostic, FigmaReplSurface, };
export type { FigmaReplSessionWorkspace } from "./repl-workspace-files.js";
export type { FigmaReplApplyAssetManifestArguments, FigmaReplAssetManifestAsset, FigmaReplCallUpstreamToolArguments, FigmaReplCaptureNodeArguments, FigmaReplDownloadAssetsArguments, FigmaReplDownloadAssetsTarget, FigmaReplEvalArguments, FigmaReplGuidanceArguments, FigmaReplInspectArguments, FigmaReplLookupArguments, FigmaReplOpenArguments, FigmaReplPrepareTaskArguments, FigmaReplRunScriptFileArguments, FigmaReplRunTaskPlanArguments, FigmaReplTaskPlanStep, } from "./repl-tool-args.js";
export declare const FIGMA_REPL_EVAL_COMMON_HELPER_NAMES: readonly ["remember", "forget", "resolveId", "node", "select", "cloneNodeTree", "findAll", "find", "text", "layout", "create", "findFreeSlot", "placeNode", "replaceGeneratedFrame", "inspect", "screenshot", "imageAsset", "checkpoint"];
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
    omitted: Array<{
        field: string;
        bytes: number;
        limit: number;
        bytesHuman: string;
        limitHuman: string;
    }>;
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
export interface FigmaReplCaptureThumbnailResult {
    [key: string]: unknown;
    enabled: boolean;
    kind?: "mcp-image";
    mimeType?: string;
    path?: string;
    width?: number;
    height?: number;
    bytes?: number;
    maxSize?: number;
    source?: string;
    sourceWidth?: number;
    sourceHeight?: number;
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
    thumbnail?: FigmaReplCaptureThumbnailResult;
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
export declare function createFigmaReplSessionStore(options?: {
    defaultSessionId?: string;
    historyLimit?: number;
}): FigmaReplSessionStore;
export declare function createFigmaReplClient(options?: FigmaReplClientOptions): FigmaReplClient;
export declare function createFigmaReplMcpServer(options?: FigmaReplMcpServerOptions): {
    server: Server;
    client: FigmaMcpProxyClient;
    sessions: FigmaReplSessionStore;
};
/**
 * @internal Internal wrapper builder used by the Figma REPL server and tests.
 * This is not a stable MCP tool input contract; MCP callers should use figma_repl_eval or figma_repl_run_script_file.
 */
export declare function buildFigmaEvalScript(options: {
    session: Pick<FigmaReplSession, "id" | "handles" | "currentPageId" | "fileUrl" | "fileKey" | "surface" | "knownPages">;
    code: string;
    mode?: "read" | "write";
    includeEvalHelpers?: boolean;
    scriptInjectedHelpers?: readonly string[];
}): string;
