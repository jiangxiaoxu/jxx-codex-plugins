export declare const LOCAL_REPL_TOOL_NAMES: readonly ["figma_repl_capabilities", "figma_repl_open", "figma_repl_eval", "figma_repl_run_script_file", "figma_repl_apply_asset_manifest", "figma_repl_capture_node", "figma_repl_run_task_plan", "figma_repl_init_workspace", "figma_repl_prepare_task", "figma_repl_plan_task", "figma_repl_api_card", "figma_repl_suggest_api", "figma_repl_inspect", "figma_repl_cache_get", "figma_repl_validate_handles", "figma_repl_list_upstream_tools", "figma_repl_call_upstream_tool", "figma_repl_docs_search", "figma_repl_api_lookup"];
export type LocalReplToolName = (typeof LOCAL_REPL_TOOL_NAMES)[number];
export declare function isLocalReplToolName(value: string): value is LocalReplToolName;
export type FigmaReplTaskPlanStepType = "script-file" | "asset-manifest" | "screenshot-capture" | "upstream-tool";
export declare const TASK_PLAN_STEP_TYPE_ALIASES: Readonly<Record<string, FigmaReplTaskPlanStepType>>;
export declare function normalizeTaskPlanStepType(value: string | undefined): FigmaReplTaskPlanStepType | string;
