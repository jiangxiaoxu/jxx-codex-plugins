export declare const DEFAULT_DOCS_SEARCH_MAX_RESULTS = 5;
export declare const DEFAULT_DOCS_SEARCH_SNIPPET_LINES = 3;
export declare const MAX_DOCS_SEARCH_RESULTS = 10;
export declare const MAX_DOCS_SEARCH_SNIPPET_LINES = 8;
export declare const DEFAULT_REFERENCE_CONTEXT_SNIPPETS = 2;
export declare const MAX_LOOKUP_QUERY_LENGTH = 120;
export declare const DOCS_SEARCH_ALLOWLIST: string[];
export declare const API_LOOKUP_FILES: string[];
export interface ReferenceSearchResult {
    sourceId: string;
    lineStart: number;
    lineEnd: number;
    score: number;
    matchType: "exact-symbol" | "phrase" | "token";
    confidence: "high" | "medium" | "low";
    chunkTitle?: string;
    snippet: string;
}
export declare function searchReferenceFiles(options: {
    query: string;
    files: string[];
    maxResults: number;
    maxSnippetLines: number;
    exactSymbol?: boolean;
}): Promise<{
    maxResults: number;
    maxSnippetLines: number;
    results: ReferenceSearchResult[];
}>;
export declare function normalizeLookupQuery(value: unknown, name: string): string;
export declare function normalizeLookupRankingQuery(value: unknown, name: string): string;
