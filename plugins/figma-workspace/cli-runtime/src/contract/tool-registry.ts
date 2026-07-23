export const LOCAL_WORKSPACE_TOOL_NAMES = [
  "figma_workspace_run",
  "figma_workspace_apply_asset_manifest",
  "figma_workspace_download_assets",
  "figma_workspace_capture_node",
  "figma_workspace_inspect",
  "figma_workspace_get_metadata",
  "figma_workspace_get_design_context",
  "figma_workspace_get_motion_context",
  "figma_workspace_search_design_system",
  "figma_workspace_get_libraries",
  "figma_workspace_get_variable_defs",
  "figma_workspace_call_upstream_tool",
  "figma_workspace_lookup",
  "figma_workspace_docs",
  "figma_workspace_doctor",
  "figma_workspace_upstream_tools",
] as const;

export type LocalWorkspaceToolName = (typeof LOCAL_WORKSPACE_TOOL_NAMES)[number];

const LOCAL_WORKSPACE_TOOL_NAME_SET: ReadonlySet<string> = new Set(LOCAL_WORKSPACE_TOOL_NAMES);

export function isLocalWorkspaceToolName(value: string): value is LocalWorkspaceToolName {
  return LOCAL_WORKSPACE_TOOL_NAME_SET.has(value);
}
