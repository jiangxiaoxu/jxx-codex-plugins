export type FigmaReplSurface = "design" | "figjam" | "slides";
export type FigmaReplDiagnosticSeverity = "fatal" | "warning";
export interface FigmaReplDiagnostic {
    code: string;
    severity: FigmaReplDiagnosticSeverity;
    message: string;
    suggestion: string;
    docsHint: string;
    location?: {
        line?: number;
        column?: number;
    };
}
export interface FigmaReplFileDiagnostic extends FigmaReplDiagnostic {
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
export interface FigmaReplRepairOccurrence {
    scriptPath?: string;
    line?: number;
    column?: number;
    label?: string;
}
export interface FigmaReplRepairStep {
    code: string;
    severity: FigmaReplDiagnosticSeverity;
    message: string;
    suggestion: string;
    docsHint: string;
    occurrences: FigmaReplRepairOccurrence[];
}
export interface FigmaReplRepairPlan {
    status: "ok" | "parse_error" | "blocked" | "warning";
    summary: string;
    steps: FigmaReplRepairStep[];
}
export interface FigmaReplDiagnosticsOptions {
    allowDangerousOperations?: boolean;
    mode?: "read" | "write";
    generatedCode?: boolean;
    expectedSurface?: FigmaReplSurface;
    strict?: boolean;
}
export type FigmaReplScriptHelperName = "select" | "findAll" | "find" | "text" | "layout" | "create" | "findFreeSlot" | "placeNode" | "replaceGeneratedFrame" | "imageAsset" | "inspect" | "screenshot" | "cloneNodeTree" | "checkpoint";
export interface FigmaReplScriptHelperSelection {
    helperNames: Set<FigmaReplScriptHelperName>;
    baseProperties: Set<string>;
    injectedHelpers: string[];
    helperUsage: FigmaReplScriptHelperUsageReport;
}
export interface FigmaReplScriptHelperUsageReport {
    direct: string[];
    transitive: string[];
    runtimeBase: string[];
    injected: string[];
}
export interface CompiledFigmaReplScriptFile {
    code: string;
    diagnostics: FigmaReplFileDiagnostic[];
    metadata: {
        scriptPath: string;
        sourceBytes: number;
        sourceLineCount: number;
        helperApiVersion: string;
        injectedHelpers: string[];
        helperUsage: FigmaReplScriptHelperUsageReport;
        targetPageId?: string;
        expectedSurface?: FigmaReplSurface;
    };
}
export declare function compileFigmaReplScriptFile(options: {
    scriptPath: string;
    source: string;
    targetPageId?: string;
    expectedSurface?: FigmaReplSurface;
    allowDangerousOperations?: boolean;
    strict?: boolean;
}): CompiledFigmaReplScriptFile;
/**
 * @internal Internal helper-selection utility used by the REPL compiler.
 * This reports injected helper metadata; it is not an MCP caller configuration surface.
 */
export declare function resolveFigmaReplScriptHelperSelection(source: string): FigmaReplScriptHelperSelection;
export declare function assertSafeFigmaReplCode(code: string, options?: FigmaReplDiagnosticsOptions): void;
export declare function diagnoseFigmaReplCode(code: string, options?: FigmaReplDiagnosticsOptions): FigmaReplDiagnostic[];
export declare function diagnoseWrappedScriptSize(scriptPath: string, wrappedScript: string, strict: boolean): FigmaReplFileDiagnostic[];
export declare function throwIfFatalDiagnostics(diagnostics: FigmaReplDiagnostic[]): void;
export declare function createFigmaReplRepairPlan(diagnostics: FigmaReplFileDiagnostic[] | undefined): FigmaReplRepairPlan;
export declare function toFigmaReplFileDiagnostics(scriptPath: string, source: string, diagnostics: FigmaReplDiagnostic[], options: FigmaReplDiagnosticsOptions): FigmaReplFileDiagnostic[];
export declare function diagnoseFigmaReplContext(options: {
    expectedSurface?: FigmaReplSurface;
    derivedSurface?: FigmaReplSurface;
    fileUrl?: string;
}): FigmaReplDiagnostic[];
