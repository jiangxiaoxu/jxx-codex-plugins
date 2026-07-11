export const LOCAL_WORKSPACE_TOOL_NAMES = [
  "figma_workspace_open",
  "figma_workspace_eval",
  "figma_workspace_run_script_file",
  "figma_workspace_apply_asset_manifest",
  "figma_workspace_download_assets",
  "figma_workspace_capture_node",
  "figma_workspace_run_task_plan",
  "figma_workspace_prepare_task",
  "figma_workspace_guidance",
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
  "figma_workspace_sessions",
  "figma_workspace_upstream_tools",
] as const;

export type LocalWorkspaceToolName = (typeof LOCAL_WORKSPACE_TOOL_NAMES)[number];

const LOCAL_WORKSPACE_TOOL_NAME_SET: ReadonlySet<string> = new Set(LOCAL_WORKSPACE_TOOL_NAMES);

export function isLocalWorkspaceToolName(value: string): value is LocalWorkspaceToolName {
  return LOCAL_WORKSPACE_TOOL_NAME_SET.has(value);
}

export type FigmaWorkspaceTaskPlanStepType =
  | "script-file"
  | "asset-manifest"
  | "download-assets"
  | "screenshot-capture"
  | "upstream-tool";

export const TASK_PLAN_STEP_TYPE_ALIASES: Readonly<Record<string, FigmaWorkspaceTaskPlanStepType>> = {
  figma_workspace_run_script_file: "script-file",
  run_script_file: "script-file",
  script: "script-file",
  "script-file": "script-file",
  figma_workspace_apply_asset_manifest: "asset-manifest",
  apply_asset_manifest: "asset-manifest",
  asset_manifest: "asset-manifest",
  upload_assets: "asset-manifest",
  "asset-manifest": "asset-manifest",
  figma_workspace_download_assets: "download-assets",
  download_assets: "download-assets",
  download_assets_from_figma: "download-assets",
  "download-assets": "download-assets",
  figma_workspace_capture_node: "screenshot-capture",
  capture_node: "screenshot-capture",
  screenshot: "screenshot-capture",
  "screenshot-capture": "screenshot-capture",
  figma_workspace_call_upstream_tool: "upstream-tool",
  call_upstream_tool: "upstream-tool",
  upstream: "upstream-tool",
  "upstream-tool": "upstream-tool",
};

export function normalizeTaskPlanStepType(
  value: string | undefined,
): FigmaWorkspaceTaskPlanStepType | string {
  return value === undefined ? "script-file" : TASK_PLAN_STEP_TYPE_ALIASES[value] ?? value;
}
