import type { FigmaReplSurface } from "./repl-script-runner.js";
export interface FigmaReplOpenArguments {
    [key: string]: unknown;
    title?: string;
    sessionId?: string;
    label?: string;
    file?: string;
    cwd?: string;
    dirName?: string;
    surface?: FigmaReplSurface;
    currentPageId?: string;
    reset?: boolean;
    connect?: boolean;
    handles?: Record<string, string>;
}
export interface FigmaReplEvalArguments {
    [key: string]: unknown;
    title?: string;
    sessionId?: string;
    code: string;
    mode?: "read" | "write";
    surface?: FigmaReplSurface;
    allowDangerousOperations?: boolean;
    handleUpdates?: Record<string, string>;
    inlineResultLimit?: number;
}
export interface FigmaReplRunScriptFileArguments {
    [key: string]: unknown;
    title?: string;
    sessionId?: string;
    scriptPath?: string;
    inputFile?: string;
    dryRun?: boolean;
    strict?: boolean;
    surface?: FigmaReplSurface;
    targetPageId?: string;
    allowDangerousOperations?: boolean;
    inlineResultLimit?: number;
}
export interface FigmaReplAssetManifestAsset {
    [key: string]: unknown;
    path?: string;
    target?: unknown;
    nodeUrl?: string;
    url?: string;
    name?: string;
    metadata?: Record<string, unknown>;
}
export interface FigmaReplApplyAssetManifestArguments {
    [key: string]: unknown;
    title?: string;
    sessionId?: string;
    assets?: FigmaReplAssetManifestAsset[];
    manifestPath?: string;
    validateTargets?: boolean;
}
export interface FigmaReplDownloadAssetsTarget {
    [key: string]: unknown;
    target?: unknown;
    name?: string;
    defaultFormat?: "png" | "jpg" | "svg" | "pdf";
    defaultScale?: number;
}
export interface FigmaReplDownloadAssetsArguments {
    [key: string]: unknown;
    title?: string;
    sessionId?: string;
    targets?: FigmaReplDownloadAssetsTarget[];
    manifestPath?: string;
    outputDir?: string;
}
export interface FigmaReplCaptureNodeArguments {
    [key: string]: unknown;
    title?: string;
    sessionId?: string;
    target: unknown;
    imageFile?: string;
}
export interface FigmaReplTaskPlanStep {
    id?: string;
    type?: string;
    args?: Record<string, unknown>;
}
export interface FigmaReplRunTaskPlanArguments {
    [key: string]: unknown;
    title?: string;
    sessionId?: string;
    planPath?: string;
    steps?: FigmaReplTaskPlanStep[];
    stopOnFailure?: boolean;
}
export interface FigmaReplCallUpstreamToolArguments {
    [key: string]: unknown;
    title?: string;
    sessionId?: string;
    toolName: string;
    arguments?: Record<string, unknown>;
    refresh?: boolean;
    inlineResultLimit?: number;
}
export interface FigmaReplGetMetadataArguments {
    [key: string]: unknown;
    title?: string;
    sessionId?: string;
    file?: string;
    cwd?: string;
    dirName?: string;
    target?: unknown;
    nodeId?: string;
    refresh?: boolean;
    inlineResultLimit?: number;
    clientLanguages?: string;
    clientFrameworks?: string;
}
export interface FigmaReplLookupArguments {
    [key: string]: unknown;
    title?: string;
    kind: "docs" | "api";
    query?: string;
    symbol?: string;
    maxResults?: number;
    maxSnippetLines?: number;
}
export interface FigmaReplPrepareTaskArguments {
    [key: string]: unknown;
    title?: string;
    sessionId?: string;
    taskName?: string;
    file?: string;
    fileSlug?: string;
    cwd?: string;
    dirName?: string;
    fileName?: string;
    taskRoot?: string;
    workspaceDir?: string;
    surface?: FigmaReplSurface;
    targetPageId?: string;
    template?: string;
    overwrite?: boolean;
}
export interface FigmaReplGuidanceArguments {
    [key: string]: unknown;
    title?: string;
    mode?: "guidance" | "plan" | "card" | "catalog";
    card?: string;
    query?: string;
    surface?: FigmaReplSurface;
    workflow?: string;
    maxCards?: number;
}
export interface FigmaReplInspectArguments {
    [key: string]: unknown;
    title?: string;
    sessionId?: string;
    mode?: "inspect" | "validate" | "style";
    target?: string;
    depth?: number;
    handles?: string[];
}
export declare function asOpenArgs(args: unknown): FigmaReplOpenArguments;
export declare function asEvalArgs(args: unknown): FigmaReplEvalArguments;
export declare function asRunScriptFileArgs(args: unknown): FigmaReplRunScriptFileArguments;
export declare function asApplyAssetManifestArgs(args: unknown): FigmaReplApplyAssetManifestArguments;
export declare function asDownloadAssetsArgs(args: unknown): FigmaReplDownloadAssetsArguments;
export declare function asCaptureNodeArgs(args: unknown): FigmaReplCaptureNodeArguments;
export declare function asRunTaskPlanArgs(args: unknown): FigmaReplRunTaskPlanArguments;
export declare function asPrepareTaskArgs(args: unknown): FigmaReplPrepareTaskArguments;
export declare function asGuidanceArgs(args: unknown): FigmaReplGuidanceArguments;
export declare function asInspectArgs(args: unknown): FigmaReplInspectArguments;
export declare function asCallUpstreamToolArgs(args: unknown): FigmaReplCallUpstreamToolArguments;
export declare function asGetMetadataArgs(args: unknown): FigmaReplGetMetadataArguments;
export declare function asLookupArgs(args: unknown): FigmaReplLookupArguments;
export declare function asTaskPlanSteps(value: unknown, displayName?: string): FigmaReplTaskPlanStep[];
export declare function withDefaultTitle<T extends Record<string, unknown>>(args: T, _title: string): T;
