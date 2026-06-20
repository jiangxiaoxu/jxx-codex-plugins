import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { type RemoteMcpClientOptions } from "./client.js";
import type { FigmaMcpProxyClient } from "./stdio-server.js";
export declare const FIGMA_REPL_DEFAULT_SESSION_ID = "default";
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
export type FigmaReplHelperProfile = "auto" | "minimal" | "asset" | "clone" | "full";
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
export declare function buildFigmaEvalScript(options: {
    session: Pick<FigmaReplSession, "id" | "handles" | "currentPageId" | "fileUrl" | "fileKey" | "surface" | "knownPages">;
    code: string;
    mode?: "read" | "write";
}): string;
export declare function assertSafeFigmaReplCode(code: string, options?: FigmaReplDiagnosticsOptions): void;
export declare function diagnoseFigmaReplCode(code: string, options?: FigmaReplDiagnosticsOptions): FigmaReplDiagnostic[];
