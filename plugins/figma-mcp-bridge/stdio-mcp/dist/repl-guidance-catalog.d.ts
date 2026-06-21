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
export declare const FIGMA_REPL_QUERY_SEARCH_ANCHORS: string[];
export declare const FIGMA_REPL_QUERY_OUTPUT_FIELDS: string[];
export declare const FIGMA_REPL_COMMON_TASK_LABELS: string[];
export declare const FIGMA_REPL_INTENT_EXAMPLE_QUERIES: string[];
export declare const FIGMA_REPL_API_CARDS: FigmaReplApiCard[];
export declare function searchApiCards(query: string, maxCards: number): FigmaReplApiCard[];
export declare function chooseApiCardsForIntent(intent: string, maxCards: number): FigmaReplApiCard[];
export declare function uniqueStrings(values: string[], maxItems: number): string[];
