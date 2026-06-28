export type FigmaReplApiCardSurface = "design" | "figjam" | "slides" | "any";
export interface FigmaReplApiCard {
    id: string;
    title: string;
    intents: string[];
    surface: FigmaReplApiCardSurface;
    helpers: string[];
    pluginApi: string[];
    apiSymbols: string[];
    queryHints: string[];
    avoid: string[];
    pitfalls: string[];
}
export interface FigmaReplWrapperLookupProfile {
    tool: string;
    upstreamTool: string;
    workflowIds: string[];
    intents: string[];
    docsQueries: string[];
    apiSymbols: string[];
    suggestedTools: string[];
    nextSteps: string[];
}
export interface FigmaReplWrapperWorkflow {
    id: string;
    title: string;
    intents: string[];
    tools: string[];
    sequence: string[];
    guardrails: string[];
}
export interface FigmaReplHelperCategory {
    id: string;
    title: string;
    helpers: string[];
    lookupHints: string[];
}
export interface FigmaReplHelperProfile {
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
export declare const FIGMA_REPL_QUERY_SEARCH_ANCHORS: string[];
export declare const FIGMA_REPL_QUERY_OUTPUT_FIELDS: string[];
export declare const FIGMA_REPL_COMMON_TASK_LABELS: string[];
export declare const FIGMA_REPL_INTENT_EXAMPLE_QUERIES: string[];
export declare const FIGMA_REPL_HELPER_HARD_RULES: string[];
export declare const FIGMA_REPL_HELPER_CATEGORIES: FigmaReplHelperCategory[];
export declare const FIGMA_REPL_HELPER_PROFILES: FigmaReplHelperProfile[];
export declare const FIGMA_REPL_WRAPPER_LOOKUP_PROFILES: FigmaReplWrapperLookupProfile[];
export declare const FIGMA_REPL_WRAPPER_WORKFLOW_GRAPH: FigmaReplWrapperWorkflow[];
export declare const FIGMA_REPL_API_CARDS: FigmaReplApiCard[];
export declare function searchApiCards(query: string, maxCards: number): FigmaReplApiCard[];
export declare function chooseApiCardsForIntent(intent: string, maxCards: number): FigmaReplApiCard[];
export declare function findWrapperLookupProfile(tool: string): FigmaReplWrapperLookupProfile | undefined;
export declare function chooseWrapperLookupProfilesForIntent(intent: string | undefined, maxProfiles: number): FigmaReplWrapperLookupProfile[];
export declare function chooseHelperProfilesForIntent(intent: string | undefined, maxProfiles: number): FigmaReplHelperProfile[];
export declare function selectWrapperWorkflowGraph(workflowIds: string[] | undefined, maxWorkflows: number): FigmaReplWrapperWorkflow[];
export declare function uniqueStrings(values: string[], maxItems: number): string[];
