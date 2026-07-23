export const FIGMA_WORKSPACE_PUBLIC_COMMAND_IDS = [
  "figma:api:search",
  "figma:assets:apply",
  "figma:assets:download",
  "figma:capture",
  "figma:design-context",
  "figma:design-system",
  "figma:docs:catalog",
  "figma:docs:list",
  "figma:docs:read",
  "figma:docs:search",
  "figma:doctor",
  "figma:inspect",
  "figma:libraries",
  "figma:metadata",
  "figma:motion-context",
  "figma:run",
  "figma:upstream:call",
  "figma:upstream:list",
  "figma:upstream:read",
  "figma:variables",
] as const;

export type FigmaWorkspacePublicCommandId = (typeof FIGMA_WORKSPACE_PUBLIC_COMMAND_IDS)[number];

const FIGMA_WORKSPACE_PUBLIC_COMMAND_ID_SET: ReadonlySet<string> = new Set(
  FIGMA_WORKSPACE_PUBLIC_COMMAND_IDS,
);

export function isFigmaWorkspacePublicCommandId(value: string): value is FigmaWorkspacePublicCommandId {
  return FIGMA_WORKSPACE_PUBLIC_COMMAND_ID_SET.has(value);
}
