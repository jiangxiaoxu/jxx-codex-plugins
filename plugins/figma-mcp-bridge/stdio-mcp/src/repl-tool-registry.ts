export const LOCAL_REPL_TOOL_NAMES = [
  "figma_repl_capabilities",
  "figma_repl_open",
  "figma_repl_eval",
  "figma_repl_run_script_file",
  "figma_repl_apply_asset_manifest",
  "figma_repl_capture_node",
  "figma_repl_run_task_plan",
  "figma_repl_init_workspace",
  "figma_repl_prepare_task",
  "figma_repl_plan_task",
  "figma_repl_guidance",
  "figma_repl_inspect",
  "figma_repl_cache_get",
  "figma_repl_validate_handles",
  "figma_repl_list_upstream_tools",
  "figma_repl_call_upstream_tool",
  "figma_repl_docs_search",
  "figma_repl_api_lookup",
] as const;

export type LocalReplToolName = (typeof LOCAL_REPL_TOOL_NAMES)[number];

const LOCAL_REPL_TOOL_NAME_SET: ReadonlySet<string> = new Set(LOCAL_REPL_TOOL_NAMES);

export function isLocalReplToolName(value: string): value is LocalReplToolName {
  return LOCAL_REPL_TOOL_NAME_SET.has(value);
}

export type FigmaReplTaskPlanStepType =
  | "script-file"
  | "asset-manifest"
  | "screenshot-capture"
  | "upstream-tool";

export const TASK_PLAN_STEP_TYPE_ALIASES: Readonly<Record<string, FigmaReplTaskPlanStepType>> = {
  figma_repl_run_script_file: "script-file",
  run_script_file: "script-file",
  script: "script-file",
  "script-file": "script-file",
  figma_repl_apply_asset_manifest: "asset-manifest",
  apply_asset_manifest: "asset-manifest",
  asset_manifest: "asset-manifest",
  "asset-manifest": "asset-manifest",
  figma_repl_capture_node: "screenshot-capture",
  capture_node: "screenshot-capture",
  screenshot: "screenshot-capture",
  "screenshot-capture": "screenshot-capture",
  figma_repl_call_upstream_tool: "upstream-tool",
  call_upstream_tool: "upstream-tool",
  upstream: "upstream-tool",
  "upstream-tool": "upstream-tool",
};

export function normalizeTaskPlanStepType(
  value: string | undefined,
): FigmaReplTaskPlanStepType | string {
  return value === undefined ? "script-file" : TASK_PLAN_STEP_TYPE_ALIASES[value] ?? value;
}
