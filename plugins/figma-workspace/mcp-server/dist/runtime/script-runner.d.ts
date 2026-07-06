export type FigmaWorkspaceSurface = "design" | "figjam" | "slides";
export type FigmaWorkspaceDiagnosticSeverity = "fatal" | "warning";
export interface FigmaWorkspaceDiagnostic {
    code: string;
    severity: FigmaWorkspaceDiagnosticSeverity;
    message: string;
    suggestion: string;
    docsHint: string;
    location?: {
        line?: number;
        column?: number;
    };
}
export interface FigmaWorkspaceFileDiagnostic extends FigmaWorkspaceDiagnostic {
    source: {
        scriptPath: string;
        line?: number;
        column?: number;
        occurrences?: Array<{
            line: number;
            column: number;
        }>;
    };
}
export interface FigmaWorkspaceRepairOccurrence {
    scriptPath?: string;
    line?: number;
    column?: number;
    label?: string;
}
export interface FigmaWorkspaceRepairStep {
    code: string;
    severity: FigmaWorkspaceDiagnosticSeverity;
    message: string;
    suggestion: string;
    docsHint: string;
    occurrences: FigmaWorkspaceRepairOccurrence[];
}
export interface FigmaWorkspaceRepairPlan {
    status: "ok" | "parse_error" | "blocked" | "warning";
    summary: string;
    steps: FigmaWorkspaceRepairStep[];
}
export interface FigmaWorkspaceDiagnosticsOptions {
    allowDangerousOperations?: boolean;
    mode?: "read" | "write";
    generatedCode?: boolean;
    expectedSurface?: FigmaWorkspaceSurface;
    strict?: boolean;
}
export type FigmaWorkspaceScriptHelperName = "select" | "text" | "findFreeSlot" | "placeNode" | "replaceGeneratedFrame" | "imageAsset" | "inspect" | "screenshot" | "cloneNodeTree" | "checkpoint";
export interface FigmaWorkspaceScriptHelperSelection {
    helperNames: Set<FigmaWorkspaceScriptHelperName>;
    baseProperties: Set<string>;
    injectedHelpers: string[];
    helperUsage: FigmaWorkspaceScriptHelperUsageReport;
}
export interface FigmaWorkspaceScriptHelperUsageReport {
    direct: string[];
    transitive: string[];
    runtimeBase: string[];
    injected: string[];
}
export interface CompiledFigmaWorkspaceScriptFile {
    code: string;
    diagnostics: FigmaWorkspaceFileDiagnostic[];
    metadata: {
        scriptPath: string;
        sourceBytes: number;
        sourceLineCount: number;
        helperApiVersion: string;
        injectedHelpers: string[];
        helperUsage: FigmaWorkspaceScriptHelperUsageReport;
        targetPageId?: string;
        expectedSurface?: FigmaWorkspaceSurface;
    };
}
export interface CompiledFigmaWorkspaceEvalCode {
    code: string;
    diagnostics: FigmaWorkspaceFileDiagnostic[];
}
interface FigmaWorkspaceTypescriptRuntimeAssetFailure {
    ok: false;
    moduleDir: string;
    cwd: string;
    argv1?: string;
    packageVersion?: string;
    attemptedPaths: string[];
    message: string;
}
export type FigmaWorkspaceTypescriptRuntimeInfo = {
    ok: true;
    moduleDir: string;
    cwd: string;
    argv1?: string;
    packageVersion?: string;
    helperDeclarationsPath: string;
    figmaPluginTypingsPath: string;
    typescriptLibDir: string;
    typescriptLibCount: number;
} | FigmaWorkspaceTypescriptRuntimeAssetFailure;
export declare function getFigmaWorkspaceTypescriptRuntimeInfo(): FigmaWorkspaceTypescriptRuntimeInfo;
export declare function compileFigmaWorkspaceScriptFile(options: {
    scriptPath: string;
    source: string;
    targetPageId?: string;
    expectedSurface?: FigmaWorkspaceSurface;
    allowDangerousOperations?: boolean;
    strict?: boolean;
}): CompiledFigmaWorkspaceScriptFile;
export declare function compileFigmaWorkspaceEvalCode(options: {
    code: string;
}): CompiledFigmaWorkspaceEvalCode;
/**
 * @internal Internal helper-selection utility used by the workspace compiler.
 * This reports injected helper metadata; it is not an MCP caller configuration surface.
 */
export declare function resolveFigmaWorkspaceScriptHelperSelection(source: string): FigmaWorkspaceScriptHelperSelection;
export declare function assertSafeFigmaWorkspaceCode(code: string, options?: FigmaWorkspaceDiagnosticsOptions): void;
export declare function diagnoseFigmaWorkspaceCode(code: string, options?: FigmaWorkspaceDiagnosticsOptions): FigmaWorkspaceDiagnostic[];
export declare function diagnoseWrappedScriptSize(scriptPath: string, wrappedScript: string, strict: boolean): FigmaWorkspaceFileDiagnostic[];
export declare function throwIfFatalDiagnostics(diagnostics: FigmaWorkspaceDiagnostic[]): void;
export declare function createFigmaWorkspaceRepairPlan(diagnostics: FigmaWorkspaceFileDiagnostic[] | undefined): FigmaWorkspaceRepairPlan;
export declare function toFigmaWorkspaceFileDiagnostics(scriptPath: string, source: string, diagnostics: FigmaWorkspaceDiagnostic[], options: FigmaWorkspaceDiagnosticsOptions): FigmaWorkspaceFileDiagnostic[];
export declare function diagnoseFigmaWorkspaceContext(options: {
    expectedSurface?: FigmaWorkspaceSurface;
    derivedSurface?: FigmaWorkspaceSurface;
    fileUrl?: string;
}): FigmaWorkspaceDiagnostic[];
export {};
