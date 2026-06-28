import type { FigmaWorkspaceRunScriptFileArguments, FigmaWorkspaceRunTaskPlanArguments, FigmaWorkspaceTaskPlanStep } from "../contract/tool-args.js";
export declare const TASK_WORKSPACE_ROOT_ENV = "FIGMA_WORKSPACE_TASK_ROOT";
export declare const DEFAULT_WORKSPACE_DIR_NAME = "figma-workspace";
export interface FigmaWorkspaceSessionWorkspace {
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
    compiledScriptFile?: string;
}
export interface FilePointerMetadata {
    path: string;
    bytes: number;
    lineCount: number;
}
export interface ScriptOutputFileMetadata {
    debugFile?: FilePointerMetadata;
    compiledScriptFile?: FilePointerMetadata;
}
export interface FigmaWorkspaceWorkspaceFileSession {
    workspace?: FigmaWorkspaceSessionWorkspace;
    fileKey?: string;
}
interface ParsedCaptureResult {
    text: string;
    json?: unknown;
}
export declare function createScriptOutputWriter(args: FigmaWorkspaceRunScriptFileArguments, session: FigmaWorkspaceWorkspaceFileSession | undefined): {
    files: ScriptOutputFilePaths;
    cleanupCompiledScriptFile(): Promise<void>;
    write(payload: {
        result: unknown;
        compiledScript?: string;
        writeResult?: boolean;
    }): Promise<ScriptOutputFileMetadata>;
};
export declare function resolveScriptInputPath(args: FigmaWorkspaceRunScriptFileArguments, session: FigmaWorkspaceWorkspaceFileSession): string;
export declare function resolveRequiredWorkspaceAwareFile(value: unknown, session: FigmaWorkspaceWorkspaceFileSession, argumentName: string): string;
export declare function resolveWorkspaceAwareFile(value: unknown, session: FigmaWorkspaceWorkspaceFileSession, argumentName: string): string | undefined;
export declare function writeCaptureOutputFile(outputFile: string, upstream: unknown, parsed: ParsedCaptureResult): Promise<{
    path: string;
    bytes: number;
    lineCount: 0;
    width?: number;
    height?: number;
}>;
export declare function captureImageOutputFilePath(outputFile: string): string;
export declare function loadTaskPlan(args: FigmaWorkspaceRunTaskPlanArguments, session: FigmaWorkspaceWorkspaceFileSession): Promise<{
    planPath?: string;
    steps: FigmaWorkspaceTaskPlanStep[];
}>;
export declare function resolveTaskPlanResultFile(args: FigmaWorkspaceRunTaskPlanArguments, planPath: string | undefined, session: FigmaWorkspaceWorkspaceFileSession): string;
export declare function withTaskPlanDefaultFiles(stepArgs: Record<string, unknown>, type: string, id: string, session: FigmaWorkspaceWorkspaceFileSession): Record<string, unknown>;
export declare function effectiveInlineResultLimit(value: unknown, files: ScriptOutputFilePaths, defaultInlineResultLimit: number): unknown;
export declare function writeJsonFile(path: string, value: unknown): Promise<FilePointerMetadata>;
export declare function createSessionWorkspace(options: {
    cwd: string;
    dirName?: unknown;
    fileKey?: string;
    fileSlug: string;
    intentSlug: string;
}): FigmaWorkspaceSessionWorkspace;
export declare function ensureWorkspaceDirectories(workspace: FigmaWorkspaceSessionWorkspace): Promise<void>;
export declare function resolvePreparedTaskWorkspace(options: {
    args: {
        workspaceDir?: unknown;
        taskRoot?: unknown;
    };
    taskName: string;
    fileSlug: string;
    session?: FigmaWorkspaceWorkspaceFileSession;
}): FigmaWorkspaceSessionWorkspace;
export declare function resolveWorkspaceFile(baseDir: string, fileName: string, argumentName: string): string;
export declare function normalizeTaskScriptName(value: unknown, taskName: string): string;
export declare function resultFileNameForScript(scriptName: string): string;
export declare function writeTaskFile(path: string, content: string, overwrite: boolean): Promise<FilePointerMetadata>;
export declare function isMissingFileError(error: unknown): boolean;
export {};
