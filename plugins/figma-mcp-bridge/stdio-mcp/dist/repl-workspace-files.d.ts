import type { FigmaReplDiagnostic } from "./repl-script-runner.js";
import type { FigmaReplRunScriptFileArguments, FigmaReplRunTaskPlanArguments, FigmaReplTaskPlanStep } from "./repl-tool-args.js";
export declare const TASK_WORKSPACE_ROOT_ENV = "FIGMA_REPL_TASK_ROOT";
export declare const DEFAULT_WORKSPACE_DIR_NAME = "figma-mcp";
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
export interface ScriptOutputFilePaths {
    resultFile?: string;
    diagnosticsFile?: string;
    summaryFile?: string;
    compiledScriptFile?: string;
}
export interface FilePointerMetadata {
    path: string;
    bytes: number;
    lineCount: number;
    rawBytes?: number;
}
export interface ScriptOutputFileMetadata {
    resultFile?: FilePointerMetadata;
    diagnosticsFile?: FilePointerMetadata;
    summaryFile?: FilePointerMetadata;
    compiledScriptFile?: FilePointerMetadata;
}
export interface FigmaReplWorkspaceFileSession {
    workspace?: FigmaReplSessionWorkspace;
    fileKey?: string;
}
interface ParsedCaptureResult {
    text: string;
    json?: unknown;
}
export declare function createScriptOutputWriter(args: FigmaReplRunScriptFileArguments, session: FigmaReplWorkspaceFileSession | undefined, formatSummaryMarkdown: (summary: Record<string, unknown>) => string): {
    files: ScriptOutputFilePaths;
    write(payload: {
        result: unknown;
        diagnostics: FigmaReplDiagnostic[];
        summary: Record<string, unknown>;
        compiledScript?: string;
    }): Promise<ScriptOutputFileMetadata>;
};
export declare function resolveScriptInputPath(args: FigmaReplRunScriptFileArguments, session: FigmaReplWorkspaceFileSession): string;
export declare function resolveRequiredWorkspaceAwareFile(value: unknown, session: FigmaReplWorkspaceFileSession, argumentName: string): string;
export declare function resolveWorkspaceAwareFile(value: unknown, session: FigmaReplWorkspaceFileSession, argumentName: string): string | undefined;
export declare function writeCaptureOutputFile(outputFile: string, upstream: unknown, parsed: ParsedCaptureResult): Promise<{
    kind: "image" | "text";
    mimeType: string;
    bytes: number;
    lineCount: number;
    width?: number;
    height?: number;
    sourceUrl?: string;
}>;
export declare function loadTaskPlan(args: FigmaReplRunTaskPlanArguments, session: FigmaReplWorkspaceFileSession): Promise<{
    planPath?: string;
    steps: FigmaReplTaskPlanStep[];
}>;
export declare function resolveTaskPlanResultFile(args: FigmaReplRunTaskPlanArguments, planPath: string | undefined, session: FigmaReplWorkspaceFileSession): string;
export declare function withTaskPlanDefaultFiles(stepArgs: Record<string, unknown>, type: string, id: string, session: FigmaReplWorkspaceFileSession): Record<string, unknown>;
export declare function effectiveInlineResultLimit(value: unknown, files: ScriptOutputFilePaths, defaultInlineResultLimit: number): unknown;
export declare function writeJsonFile(path: string, value: unknown): Promise<FilePointerMetadata>;
export declare function createSessionWorkspace(options: {
    cwd: string;
    dirName?: unknown;
    fileKey?: string;
    fileSlug: string;
    intentSlug: string;
}): FigmaReplSessionWorkspace;
export declare function ensureWorkspaceDirectories(workspace: FigmaReplSessionWorkspace): Promise<void>;
export declare function resolvePreparedTaskWorkspace(options: {
    args: {
        taskDir?: unknown;
        workspaceDir?: unknown;
        taskRoot?: unknown;
    };
    taskSlug: string;
    fileSlug: string;
    session?: FigmaReplWorkspaceFileSession;
}): FigmaReplSessionWorkspace;
export declare function resolveWorkspaceFile(baseDir: string, fileName: string, argumentName: string): string;
export declare function normalizeTaskScriptName(value: unknown, taskSlug: string): string;
export declare function resultFileNameForScript(scriptName: string): string;
export declare function writeTaskFile(path: string, content: string, overwrite: boolean): Promise<FilePointerMetadata>;
export {};
