import type { FigmaReplHelperProfile, FigmaReplSurface } from "./repl-script-runner.js";
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
export interface FigmaReplGuidanceArguments {
    [key: string]: unknown;
    title?: string;
    card?: string;
    query?: string;
    task?: string;
    intent?: string;
    surface?: FigmaReplSurface;
    expectedSurface?: FigmaReplSurface;
    maxCards?: number;
}
export declare function asEvalArgs(args: unknown): FigmaReplEvalArguments;
export declare function asRunScriptFileArgs(args: unknown): FigmaReplRunScriptFileArguments;
export declare function asApplyAssetManifestArgs(args: unknown): FigmaReplApplyAssetManifestArguments;
export declare function asCaptureNodeArgs(args: unknown): FigmaReplCaptureNodeArguments;
export declare function asRunTaskPlanArgs(args: unknown): FigmaReplRunTaskPlanArguments;
export declare function asInitWorkspaceArgs(args: unknown): FigmaReplInitWorkspaceArguments;
export declare function asPrepareTaskArgs(args: unknown): FigmaReplPrepareTaskArguments;
export declare function asPlanTaskArgs(args: unknown): FigmaReplPlanTaskArguments;
export declare function asGuidanceArgs(args: unknown): FigmaReplGuidanceArguments;
export declare function asCallUpstreamToolArgs(args: unknown): FigmaReplCallUpstreamToolArguments;
export declare function asDocsSearchArgs(args: unknown): FigmaReplDocsSearchArguments;
export declare function asApiLookupArgs(args: unknown): FigmaReplApiLookupArguments;
export declare function assertRequiredTitleArgument(args: Record<string, unknown>): void;
export declare function withDefaultTitle<T extends Record<string, unknown>>(args: T, title: string): T & {
    title: string;
};
