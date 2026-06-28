export type ReplToolDescriptionOptions = {
    taskWorkspaceRootEnv: string;
    defaultDocsSearchMaxResults: number;
    maxDocsSearchResults: number;
    defaultDocsSearchSnippetLines: number;
    maxDocsSearchSnippetLines: number;
    maxLookupQueryLength: number;
};
export declare function createReplToolDescriptions(options: ReplToolDescriptionOptions): Record<string, unknown>[];
