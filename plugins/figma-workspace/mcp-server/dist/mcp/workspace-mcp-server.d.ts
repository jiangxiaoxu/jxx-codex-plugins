import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { type RemoteMcpClientOptions } from "../upstream/remote-mcp-client.js";
import { type ReferenceSearchResult } from "../runtime/doc-search.js";
import { assertSafeFigmaWorkspaceCode, diagnoseFigmaWorkspaceCode, resolveFigmaWorkspaceScriptHelperSelection as resolveFigmaWorkspaceScriptHelperSelectionInternal, type FigmaWorkspaceDiagnostic, type FigmaWorkspaceDiagnosticsOptions, type FigmaWorkspaceDiagnosticSeverity, type FigmaWorkspaceFileDiagnostic, type FigmaWorkspaceRepairPlan, type FigmaWorkspaceSurface } from "../runtime/script-runner.js";
import type { FigmaWorkspaceApplyAssetManifestArguments, FigmaWorkspaceCallUpstreamToolArguments, FigmaWorkspaceCaptureNodeArguments, FigmaWorkspaceDownloadAssetsArguments, FigmaWorkspaceEvalArguments, FigmaWorkspaceExportVideoArguments, FigmaWorkspaceGetDesignContextArguments, FigmaWorkspaceGetLibrariesArguments, FigmaWorkspaceGetMetadataArguments, FigmaWorkspaceGetMotionContextArguments, FigmaWorkspaceGetVariableDefsArguments, FigmaWorkspaceGuidanceArguments, FigmaWorkspaceInspectArguments, FigmaWorkspaceLookupArguments, FigmaWorkspaceOpenArguments, FigmaWorkspacePrepareTaskArguments, FigmaWorkspaceRunScriptFileArguments, FigmaWorkspaceRunTaskPlanArguments, FigmaWorkspaceSearchDesignSystemArguments } from "../contract/tool-args.js";
import { isMissingFileError as isFigmaWorkspaceMissingFileErrorForTesting, type FigmaWorkspaceSessionWorkspace } from "../runtime/workspace-files.js";
import type { FigmaUpstreamMcpProxyClient } from "../upstream/upstream-stdio-server.js";
export declare const FIGMA_WORKSPACE_DEFAULT_SESSION_ID = "default";
export { assertSafeFigmaWorkspaceCode, diagnoseFigmaWorkspaceCode, };
/**
 * @internal Missing-file matcher used by cleanup regression tests.
 * This is not a stable package API.
 */
export { isFigmaWorkspaceMissingFileErrorForTesting };
/**
 * @internal Internal-facing helper-selection utility for tests and payload debugging.
 * This is not a stable MCP tool input contract, and callers cannot use it to configure helper injection.
 */
export declare const resolveFigmaWorkspaceScriptHelperSelection: typeof resolveFigmaWorkspaceScriptHelperSelectionInternal;
export type { FigmaWorkspaceDiagnostic, FigmaWorkspaceDiagnosticsOptions, FigmaWorkspaceDiagnosticSeverity, FigmaWorkspaceFileDiagnostic, FigmaWorkspaceSurface, };
export type { FigmaWorkspaceSessionWorkspace } from "../runtime/workspace-files.js";
export type { FigmaWorkspaceApplyAssetManifestArguments, FigmaWorkspaceAssetManifestAsset, FigmaWorkspaceCallUpstreamToolArguments, FigmaWorkspaceCaptureNodeArguments, FigmaWorkspaceDownloadAssetsArguments, FigmaWorkspaceDownloadAssetsTarget, FigmaWorkspaceEvalArguments, FigmaWorkspaceExportVideoArguments, FigmaWorkspaceGetDesignContextArguments, FigmaWorkspaceGetLibrariesArguments, FigmaWorkspaceGetMetadataArguments, FigmaWorkspaceGetMotionContextArguments, FigmaWorkspaceGetVariableDefsArguments, FigmaWorkspaceGuidanceArguments, FigmaWorkspaceInspectArguments, FigmaWorkspaceLookupArguments, FigmaWorkspaceOpenArguments, FigmaWorkspacePrepareTaskArguments, FigmaWorkspaceRunScriptFileArguments, FigmaWorkspaceRunTaskPlanArguments, FigmaWorkspaceSearchDesignSystemArguments, FigmaWorkspaceTaskPlanStep, } from "../contract/tool-args.js";
export declare const FIGMA_WORKSPACE_EVAL_COMMON_HELPER_NAMES: readonly ["remember", "forget", "resolveId", "node", "select", "cloneNodeTree", "findAll", "find", "text", "layout", "create", "findFreeSlot", "placeNode", "replaceGeneratedFrame", "inspect", "screenshot", "imageAsset", "checkpoint"];
export interface FigmaWorkspaceMcpServerOptions extends RemoteMcpClientOptions {
    client?: FigmaUpstreamMcpProxyClient;
    name?: string;
    version?: string;
    defaultSessionId?: string;
    historyLimit?: number;
    useBridgeOAuthCache?: boolean;
    openBrowser?: boolean;
}
export interface FigmaWorkspaceClientOptions extends FigmaWorkspaceMcpServerOptions {
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
export interface FigmaWorkspaceResourceWorkspace {
    [key: string]: unknown;
    sessionDir: string;
}
export interface FigmaWorkspaceResourcePageSummary {
    [key: string]: unknown;
    id: string;
    name: string;
}
export interface FigmaWorkspaceResourcePageState {
    [key: string]: unknown;
    currentPageId?: string;
    currentPageName?: string;
    knownPages?: FigmaWorkspaceResourcePageSummary[];
}
export interface FigmaWorkspaceResourceSessionSummary {
    [key: string]: unknown;
    id: string;
    fileKey?: string;
    surface?: FigmaWorkspaceSurface;
    sessionDir?: string;
}
export interface FigmaWorkspaceResourceSessionDetail {
    [key: string]: unknown;
    id: string;
    fileKey?: string;
    surface?: FigmaWorkspaceSurface;
    handles: Record<string, string>;
    page?: FigmaWorkspaceResourcePageState;
    workspace?: FigmaWorkspaceResourceWorkspace;
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
    diagnostics: FigmaWorkspaceDiagnostic[];
}
export interface FigmaWorkspaceUpstreamBackedResult extends FigmaWorkspaceToolResultBase {
    upstream: FigmaWorkspaceUpstreamEnvelope;
    upstreamError?: FigmaWorkspacePublicUpstreamError;
}
export interface FigmaWorkspaceEvalResult extends FigmaWorkspaceUpstreamBackedResult {
    session: FigmaWorkspaceCompactSession;
    diagnostics: FigmaWorkspaceDiagnostic[];
    repairPlan?: FigmaWorkspaceRepairPlan;
    outputFiles?: FigmaWorkspaceOutputFiles;
    inlineResultLimit?: FigmaWorkspaceInlineResultLimit;
}
export interface FigmaWorkspaceCompactScriptMetadata {
    [key: string]: unknown;
    scriptPath: string;
    expectedSurface?: FigmaWorkspaceSurface;
    compiledScriptBytes: number;
}
/** @deprecated Use FigmaWorkspaceCompactScriptMetadata. */
export type FigmaWorkspaceScriptMetadata = FigmaWorkspaceCompactScriptMetadata;
export interface FigmaWorkspaceInlineResultLimit {
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
export interface FigmaWorkspaceRunScriptFileResult extends FigmaWorkspaceToolResultBase {
    phase: "preflight" | "execute";
    executed: boolean;
    session: FigmaWorkspaceCompactSession;
    diagnostics: FigmaWorkspaceDiagnostic[];
    script: FigmaWorkspaceCompactScriptMetadata;
    outputFiles?: FigmaWorkspaceOutputFiles;
    upstream?: FigmaWorkspaceUpstreamEnvelope;
    upstreamError?: FigmaWorkspacePublicUpstreamError;
    repairPlan: FigmaWorkspaceRepairPlan;
    inlineResultLimit?: FigmaWorkspaceInlineResultLimit;
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
    startedAt?: string;
    finishedAt?: string;
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
    outputReferences?: Record<string, unknown>;
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
    workflow?: Record<string, unknown>;
    steps?: string[];
    recommendedTools?: string[];
    suggestedCards?: string[];
    wrapperProfiles?: Array<Record<string, unknown>>;
    workflowGraph?: Array<Record<string, unknown>>;
    cards?: Array<Record<string, unknown>>;
    catalogSize?: number;
    guidance?: string;
    recommendedCards?: string[];
    queryHints?: string[];
    apiSymbols?: string[];
    guardrails?: string[];
    suggestions?: Record<string, unknown>;
}
export interface FigmaWorkspaceInspectResult extends FigmaWorkspaceToolResultBase {
    session: FigmaWorkspaceCompactSession;
    diagnostics: FigmaWorkspaceDiagnostic[];
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
    source: "figma_workspace_guidance";
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
export interface FigmaWorkspaceExportVideoResult extends FigmaWorkspaceUpstreamBackedResult {
    session: FigmaWorkspaceCompactSession;
    fileKey: string;
    nodeId?: string;
    jobId?: string;
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
        json?: FigmaWorkspaceMetadataJson;
    };
    upstream: FigmaWorkspaceUpstreamEnvelope;
    upstreamError?: FigmaWorkspacePublicUpstreamError;
    primaryFix?: string;
    outputFiles: FigmaWorkspaceOutputFiles;
    inlineResultLimit?: FigmaWorkspaceInlineResultLimit;
}
export interface FigmaWorkspaceLookupResult extends FigmaWorkspaceToolResultBase {
    results: ReferenceSearchResult[];
    guidance: string;
}
export interface FigmaWorkspaceClient {
    readonly client: FigmaUpstreamMcpProxyClient;
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
    exportVideo(args: FigmaWorkspaceExportVideoArguments): Promise<FigmaWorkspaceExportVideoResult>;
    searchDesignSystem(args: FigmaWorkspaceSearchDesignSystemArguments): Promise<FigmaWorkspaceSearchDesignSystemResult>;
    getLibraries(args?: FigmaWorkspaceGetLibrariesArguments): Promise<FigmaWorkspaceGetLibrariesResult>;
    getVariableDefs(args: FigmaWorkspaceGetVariableDefsArguments): Promise<FigmaWorkspaceGetVariableDefsResult>;
    callUpstreamTool(args: FigmaWorkspaceCallUpstreamToolArguments): Promise<FigmaWorkspaceCallUpstreamToolResult>;
    lookup(args: FigmaWorkspaceLookupArguments): Promise<FigmaWorkspaceLookupResult>;
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
export declare function createFigmaWorkspaceSessionStore(options?: {
    defaultSessionId?: string;
    historyLimit?: number;
}): FigmaWorkspaceSessionStore;
export declare function createFigmaWorkspaceClient(options?: FigmaWorkspaceClientOptions): FigmaWorkspaceClient;
export declare function createFigmaWorkspaceMcpServer(options?: FigmaWorkspaceMcpServerOptions): {
    server: Server;
    client: FigmaUpstreamMcpProxyClient;
    sessions: FigmaWorkspaceSessionStore;
};
/**
 * @internal Internal wrapper builder used by the Figma Workspace server and tests.
 * This is not a stable MCP tool input contract; MCP callers should use figma_workspace_eval or figma_workspace_run_script_file.
 */
export declare function buildFigmaEvalScript(options: {
    session: Pick<FigmaWorkspaceSession, "id" | "handles" | "currentPageId" | "fileUrl" | "fileKey" | "surface" | "knownPages">;
    code: string;
    mode?: "read" | "write";
    includeEvalHelpers?: boolean;
    scriptInjectedHelpers?: readonly string[];
}): string;
