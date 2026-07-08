type FigmaWorkspaceTypescriptDiagnosticSeverity = "fatal" | "warning";
export interface FigmaWorkspaceTypescriptFileDiagnostic {
    code: string;
    severity: FigmaWorkspaceTypescriptDiagnosticSeverity;
    message: string;
    suggestion: string;
    docsHint: string;
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
export interface FigmaWorkspaceTypescriptCompiledSource {
    source: string;
    diagnostics: FigmaWorkspaceTypescriptFileDiagnostic[];
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
export declare function compileFigmaWorkspaceTypescriptSource(scriptPath: string, source: string, strict: boolean, extraDeclarations?: string): FigmaWorkspaceTypescriptCompiledSource;
export {};
