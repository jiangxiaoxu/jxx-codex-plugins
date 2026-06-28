export type FigmaWorkspaceApiCardSurface = "design" | "figjam" | "slides" | "any";
export interface FigmaWorkspaceApiCard {
    id: string;
    title: string;
    intents: string[];
    surface: FigmaWorkspaceApiCardSurface;
    helpers: string[];
    pluginApi: string[];
    apiSymbols: string[];
    queryHints: string[];
    avoid: string[];
    pitfalls: string[];
}
export interface FigmaWorkspaceWrapperLookupProfile {
    tool: string;
    upstreamTool: string;
    workflowIds: string[];
    intents: string[];
    docsQueries: string[];
    apiSymbols: string[];
    suggestedTools: string[];
    nextSteps: string[];
}
export interface FigmaWorkspaceWrapperWorkflow {
    id: string;
    title: string;
    intents: string[];
    tools: string[];
    sequence: string[];
    guardrails: string[];
}
export interface FigmaWorkspaceHelperCategory {
    id: string;
    title: string;
    helpers: string[];
    lookupHints: string[];
}
export interface FigmaWorkspaceHelperProfile {
    id: string;
    category: string;
    helpers: string[];
    useWhen: string[];
    avoidWhen: string[];
    allowedPatterns: string[];
    forbiddenPatterns: string[];
    apiSymbols: string[];
    lookupHints: string[];
    example?: string;
}
export declare const FIGMA_WORKSPACE_QUERY_SEARCH_ANCHORS: string[];
export declare const FIGMA_WORKSPACE_QUERY_OUTPUT_FIELDS: string[];
export declare const FIGMA_WORKSPACE_COMMON_TASK_LABELS: string[];
export declare const FIGMA_WORKSPACE_INTENT_EXAMPLE_QUERIES: string[];
export declare const FIGMA_WORKSPACE_HELPER_HARD_RULES: string[];
export declare const FIGMA_WORKSPACE_HELPER_CATEGORIES: FigmaWorkspaceHelperCategory[];
export declare const FIGMA_WORKSPACE_HELPER_PROFILES: FigmaWorkspaceHelperProfile[];
export declare const FIGMA_WORKSPACE_WRAPPER_LOOKUP_PROFILES: FigmaWorkspaceWrapperLookupProfile[];
export declare const FIGMA_WORKSPACE_WRAPPER_WORKFLOW_GRAPH: FigmaWorkspaceWrapperWorkflow[];
export declare const FIGMA_WORKSPACE_API_CARDS: FigmaWorkspaceApiCard[];
export declare function searchApiCards(query: string, maxCards: number): FigmaWorkspaceApiCard[];
export declare function chooseApiCardsForIntent(intent: string, maxCards: number): FigmaWorkspaceApiCard[];
export declare function findWrapperLookupProfile(tool: string): FigmaWorkspaceWrapperLookupProfile | undefined;
export declare function chooseWrapperLookupProfilesForIntent(intent: string | undefined, maxProfiles: number): FigmaWorkspaceWrapperLookupProfile[];
export declare function chooseHelperProfilesForIntent(intent: string | undefined, maxProfiles: number): FigmaWorkspaceHelperProfile[];
export declare function selectWrapperWorkflowGraph(workflowIds: string[] | undefined, maxWorkflows: number): FigmaWorkspaceWrapperWorkflow[];
export declare function uniqueStrings(values: string[], maxItems: number): string[];
