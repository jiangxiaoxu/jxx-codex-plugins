import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { type RemoteMcpClientOptions } from "./client.js";
import { assertSafeFigmaReplCode, diagnoseFigmaReplCode, type FigmaReplDiagnostic, type FigmaReplDiagnosticsOptions, type FigmaReplDiagnosticSeverity, type FigmaReplFileDiagnostic, type FigmaReplHelperProfile, type FigmaReplSurface } from "./repl-script-runner.js";
import type { FigmaReplApplyAssetManifestArguments, FigmaReplCallUpstreamToolArguments, FigmaReplCaptureNodeArguments, FigmaReplEvalArguments, FigmaReplGuidanceArguments, FigmaReplInspectArguments, FigmaReplLookupArguments, FigmaReplOpenArguments, FigmaReplPrepareTaskArguments, FigmaReplRunScriptFileArguments, FigmaReplRunTaskPlanArguments } from "./repl-tool-args.js";
import { type FigmaReplSessionWorkspace } from "./repl-workspace-files.js";
import type { FigmaMcpProxyClient } from "./stdio-server.js";
export declare const FIGMA_REPL_DEFAULT_SESSION_ID = "default";
export { assertSafeFigmaReplCode, diagnoseFigmaReplCode, };
export type { FigmaReplDiagnostic, FigmaReplDiagnosticsOptions, FigmaReplDiagnosticSeverity, FigmaReplFileDiagnostic, FigmaReplHelperProfile, FigmaReplSurface, };
export type { FigmaReplSessionWorkspace } from "./repl-workspace-files.js";
export type { FigmaReplApplyAssetManifestArguments, FigmaReplAssetManifestAsset, FigmaReplCallUpstreamToolArguments, FigmaReplCaptureNodeArguments, FigmaReplEvalArguments, FigmaReplGuidanceArguments, FigmaReplInspectArguments, FigmaReplLookupArguments, FigmaReplOpenArguments, FigmaReplPrepareTaskArguments, FigmaReplResponseMode, FigmaReplRunScriptFileArguments, FigmaReplRunTaskPlanArguments, FigmaReplTaskPlanStep, } from "./repl-tool-args.js";
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
    prepareTask(args: FigmaReplPrepareTaskArguments): Promise<unknown>;
    guidance(args: FigmaReplGuidanceArguments): Promise<unknown>;
    inspect(args?: FigmaReplInspectArguments): Promise<unknown>;
    callUpstreamTool(args: FigmaReplCallUpstreamToolArguments): Promise<unknown>;
    lookup(args: FigmaReplLookupArguments): Promise<unknown>;
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
