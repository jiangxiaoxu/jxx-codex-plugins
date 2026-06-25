export declare const LOCAL_REPL_TOOL_NAMES: readonly ["figma_repl_open", "figma_repl_eval", "figma_repl_run_script_file", "figma_repl_apply_asset_manifest", "figma_repl_download_assets", "figma_repl_capture_node", "figma_repl_run_task_plan", "figma_repl_prepare_task", "figma_repl_guidance", "figma_repl_inspect", "figma_repl_get_metadata", "figma_repl_search_design_system", "figma_repl_get_libraries", "figma_repl_get_variable_defs", "figma_repl_call_upstream_tool", "figma_repl_lookup"];
export type LocalReplToolName = (typeof LOCAL_REPL_TOOL_NAMES)[number];
export declare function isLocalReplToolName(value: string): value is LocalReplToolName;
export type FigmaReplTaskPlanStepType = "script-file" | "asset-manifest" | "download-assets" | "screenshot-capture" | "upstream-tool";
export declare const TASK_PLAN_STEP_TYPE_ALIASES: Readonly<Record<string, FigmaReplTaskPlanStepType>>;
export declare function normalizeTaskPlanStepType(value: string | undefined): FigmaReplTaskPlanStepType | string;
