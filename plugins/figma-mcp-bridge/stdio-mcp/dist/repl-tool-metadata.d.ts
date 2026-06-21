export type ReplToolDescriptionOptions = {
    taskWorkspaceRootEnv: string;
    defaultDocsSearchMaxResults: number;
    maxDocsSearchResults: number;
    defaultDocsSearchSnippetLines: number;
    maxDocsSearchSnippetLines: number;
};
export declare function createReplToolDescriptions(options: ReplToolDescriptionOptions): Record<string, unknown>[];
