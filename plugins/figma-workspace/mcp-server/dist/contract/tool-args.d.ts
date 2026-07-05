import type { FigmaWorkspaceSurface } from "../runtime/script-runner.js";
export interface FigmaWorkspaceOpenArguments {
    [key: string]: unknown;
    title?: string;
    sessionId?: string;
    label?: string;
    file?: string;
    cwd?: string;
    dirName?: string;
    surface?: FigmaWorkspaceSurface;
    currentPageId?: string;
    reset?: boolean;
    connect?: boolean;
    handles?: Record<string, string>;
}
export interface FigmaWorkspaceEvalArguments {
    [key: string]: unknown;
    title?: string;
    sessionId?: string;
    code: string;
    mode?: "read" | "write";
    surface?: FigmaWorkspaceSurface;
    allowDangerousOperations?: boolean;
    handleUpdates?: Record<string, string>;
    inlineResultLimit?: number;
}
export interface FigmaWorkspaceRunScriptFileArguments {
    [key: string]: unknown;
    title?: string;
    sessionId?: string;
    scriptPath?: string;
    inputFile?: string;
    strict?: boolean;
    surface?: FigmaWorkspaceSurface;
    targetPageId?: string;
    allowDangerousOperations?: boolean;
    inlineResultLimit?: number;
}
export interface FigmaWorkspaceAssetManifestAsset {
    [key: string]: unknown;
    path?: string;
    target?: unknown;
    nodeUrl?: string;
    url?: string;
    name?: string;
    metadata?: Record<string, unknown>;
}
export interface FigmaWorkspaceApplyAssetManifestArguments {
    [key: string]: unknown;
    title?: string;
    sessionId?: string;
    assets?: FigmaWorkspaceAssetManifestAsset[];
    manifestPath?: string;
    validateTargets?: boolean;
}
export interface FigmaWorkspaceDownloadAssetsTarget {
    [key: string]: unknown;
    target?: unknown;
    name?: string;
    defaultFormat?: "png" | "jpg" | "svg" | "pdf";
    defaultScale?: number;
}
export interface FigmaWorkspaceDownloadAssetsArguments {
    [key: string]: unknown;
    title?: string;
    sessionId?: string;
    targets?: FigmaWorkspaceDownloadAssetsTarget[];
    manifestPath?: string;
    outputDir?: string;
}
export interface FigmaWorkspaceCaptureNodeArguments {
    [key: string]: unknown;
    title?: string;
    sessionId?: string;
    target: unknown;
    imageFile?: string;
    maxDimension?: number;
    contentsOnly?: boolean;
}
export interface FigmaWorkspaceTaskPlanStep {
    id?: string;
    type?: string;
    args?: Record<string, unknown>;
}
export interface FigmaWorkspaceRunTaskPlanArguments {
    [key: string]: unknown;
    title?: string;
    sessionId?: string;
    planPath?: string;
    steps?: FigmaWorkspaceTaskPlanStep[];
    stopOnFailure?: boolean;
}
export interface FigmaWorkspaceCallUpstreamToolArguments {
    [key: string]: unknown;
    title?: string;
    sessionId?: string;
    toolName: string;
    arguments?: Record<string, unknown>;
    refresh?: boolean;
    inlineResultLimit?: number;
}
export interface FigmaWorkspaceGetMetadataArguments {
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
export interface FigmaWorkspaceGetDesignContextArguments {
    [key: string]: unknown;
    title?: string;
    sessionId?: string;
    file?: string;
    cwd?: string;
    dirName?: string;
    target?: unknown;
    refresh?: boolean;
    inlineResultLimit?: number;
    clientLanguages?: string;
    clientFrameworks?: string;
    forceCode?: boolean;
    disableCodeConnect?: boolean;
    excludeScreenshot?: boolean;
}
export interface FigmaWorkspaceGetMotionContextArguments {
    [key: string]: unknown;
    title?: string;
    sessionId?: string;
    file?: string;
    cwd?: string;
    dirName?: string;
    target?: unknown;
    recursive?: boolean;
    clientLanguages?: string;
    clientFrameworks?: string;
    refresh?: boolean;
    inlineResultLimit?: number;
}
export interface FigmaWorkspaceExportVideoArguments {
    [key: string]: unknown;
    title?: string;
    sessionId?: string;
    file?: string;
    cwd?: string;
    dirName?: string;
    target?: unknown;
    jobId?: string;
    quality?: "low" | "medium" | "high";
    fps?: number;
    constraint?: FigmaWorkspaceExportVideoConstraint;
    ttlSeconds?: number;
    refresh?: boolean;
    inlineResultLimit?: number;
}
export interface FigmaWorkspaceExportVideoConstraint {
    type: "SCALE" | "WIDTH" | "HEIGHT";
    value: number;
}
export interface FigmaWorkspaceSearchDesignSystemArguments {
    [key: string]: unknown;
    title?: string;
    sessionId?: string;
    file?: string;
    cwd?: string;
    dirName?: string;
    query: string;
    disableCodeConnect?: boolean;
    includeComponents?: boolean;
    includeVariables?: boolean;
    includeStyles?: boolean;
    includeLibraryKeys?: string[];
    refresh?: boolean;
    inlineResultLimit?: number;
}
export interface FigmaWorkspaceGetLibrariesArguments {
    [key: string]: unknown;
    title?: string;
    sessionId?: string;
    file?: string;
    cwd?: string;
    dirName?: string;
    offset?: number;
    refresh?: boolean;
    inlineResultLimit?: number;
}
export interface FigmaWorkspaceGetVariableDefsArguments {
    [key: string]: unknown;
    title?: string;
    sessionId?: string;
    file?: string;
    cwd?: string;
    dirName?: string;
    target?: unknown;
    refresh?: boolean;
    inlineResultLimit?: number;
}
export interface FigmaWorkspaceLookupArguments {
    [key: string]: unknown;
    title?: string;
    kind: "docs" | "api";
    query?: string;
    symbol?: string;
    maxResults?: number;
    maxSnippetLines?: number;
}
export interface FigmaWorkspacePrepareTaskArguments {
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
    surface?: FigmaWorkspaceSurface;
    targetPageId?: string;
    template?: string;
    overwrite?: boolean;
}
export interface FigmaWorkspaceGuidanceArguments {
    [key: string]: unknown;
    title?: string;
    mode?: "guidance" | "plan" | "card" | "catalog";
    card?: string;
    query?: string;
    surface?: FigmaWorkspaceSurface;
    workflow?: string;
    maxCards?: number;
}
export interface FigmaWorkspaceInspectArguments {
    [key: string]: unknown;
    title?: string;
    sessionId?: string;
    mode?: "inspect" | "validate" | "style";
    target?: string;
    depth?: number;
    handles?: string[];
}
export declare function asOpenArgs(args: unknown): FigmaWorkspaceOpenArguments;
export declare function asEvalArgs(args: unknown): FigmaWorkspaceEvalArguments;
export declare function asRunScriptFileArgs(args: unknown): FigmaWorkspaceRunScriptFileArguments;
export declare function asApplyAssetManifestArgs(args: unknown): FigmaWorkspaceApplyAssetManifestArguments;
export declare function asDownloadAssetsArgs(args: unknown): FigmaWorkspaceDownloadAssetsArguments;
export declare function asCaptureNodeArgs(args: unknown): FigmaWorkspaceCaptureNodeArguments;
export declare function asRunTaskPlanArgs(args: unknown): FigmaWorkspaceRunTaskPlanArguments;
export declare function asPrepareTaskArgs(args: unknown): FigmaWorkspacePrepareTaskArguments;
export declare function asGuidanceArgs(args: unknown): FigmaWorkspaceGuidanceArguments;
export declare function asInspectArgs(args: unknown): FigmaWorkspaceInspectArguments;
export declare function asCallUpstreamToolArgs(args: unknown): FigmaWorkspaceCallUpstreamToolArguments;
export declare function asGetMetadataArgs(args: unknown): FigmaWorkspaceGetMetadataArguments;
export declare function asGetDesignContextArgs(args: unknown): FigmaWorkspaceGetDesignContextArguments;
export declare function asGetMotionContextArgs(args: unknown): FigmaWorkspaceGetMotionContextArguments;
export declare function asExportVideoArgs(args: unknown): FigmaWorkspaceExportVideoArguments;
export declare function asSearchDesignSystemArgs(args: unknown): FigmaWorkspaceSearchDesignSystemArguments;
export declare function asGetLibrariesArgs(args: unknown): FigmaWorkspaceGetLibrariesArguments;
export declare function asGetVariableDefsArgs(args: unknown): FigmaWorkspaceGetVariableDefsArguments;
export declare function asLookupArgs(args: unknown): FigmaWorkspaceLookupArguments;
export declare function asTaskPlanSteps(value: unknown, displayName?: string): FigmaWorkspaceTaskPlanStep[];
export declare function withDefaultTitle<T extends Record<string, unknown>>(args: T, _title: string): T;
