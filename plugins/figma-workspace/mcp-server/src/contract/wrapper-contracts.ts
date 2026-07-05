import type { LocalWorkspaceToolName } from "./tool-registry.js";

export type FigmaWorkspaceWrapperCategory =
  | "fixed-execution"
  | "enhanced-wrapper"
  | "thin-wrapper"
  | "asset-capture-workflow"
  | "upstream-escape-hatch";

export type FigmaWorkspaceWrapperTargetSupport =
  | "none"
  | "string-only"
  | "node-scoped"
  | "node-scoped-list"
  | "freeform-upstream";

export interface FigmaWorkspaceWrapperOutputPolicy {
  inlineLimitFields: readonly string[];
  debugFiles: readonly string[];
  upstreamEnvelope: boolean;
}

export interface FigmaWorkspaceWrapperContract {
  toolName: LocalWorkspaceToolName;
  category: FigmaWorkspaceWrapperCategory;
  upstreamToolName?: string;
  upstreamKind?: string;
  requiredUpstreamProperties?: readonly string[];
  optionalUpstreamProperties?: readonly string[];
  targetSupport: FigmaWorkspaceWrapperTargetSupport;
  outputPolicy: FigmaWorkspaceWrapperOutputPolicy;
  guidanceProfile?: {
    workflowIds: readonly string[];
  };
}

const UPSTREAM_INLINE_FIELDS = ["upstream.result", "upstream.text"] as const;

export const FIGMA_WORKSPACE_NODE_SCOPED_TARGET_DESCRIPTION =
  "Accepts string raw node id, string node URL, string local handle like $hero, { handle:\"$hero\" }, or { fileKey, nodeId }. Raw node id and handle strings require an open/prepare file-context session; node URL and { fileKey, nodeId } can supply file context directly.";

export const FIGMA_WORKSPACE_COVERED_UPSTREAM_TOOL_NAMES = [
  "use_figma",
  "get_metadata",
  "get_screenshot",
  "upload_assets",
  "download_assets",
  "get_design_context",
  "get_motion_context",
  "export_video",
  "search_design_system",
  "get_libraries",
  "get_variable_defs",
] as const;

export const FIGMA_WORKSPACE_UPSTREAM_ESCAPE_HATCH_GUIDANCE =
  "Use figma_workspace_call_upstream_tool only for explicit official upstream capabilities without a local wrapper.";

export const FIGMA_WORKSPACE_WRAPPER_CONTRACTS = [
  {
    toolName: "figma_workspace_eval",
    category: "fixed-execution",
    upstreamToolName: "use_figma",
    upstreamKind: "execution",
    requiredUpstreamProperties: ["code"],
    targetSupport: "none",
    outputPolicy: {
      inlineLimitFields: UPSTREAM_INLINE_FIELDS,
      debugFiles: ["debugFile", "upstreamFile"],
      upstreamEnvelope: true,
    },
  },
  {
    toolName: "figma_workspace_run_script_file",
    category: "fixed-execution",
    upstreamToolName: "use_figma",
    upstreamKind: "execution",
    requiredUpstreamProperties: ["code"],
    targetSupport: "none",
    outputPolicy: {
      inlineLimitFields: UPSTREAM_INLINE_FIELDS,
      debugFiles: ["debugFile", "upstreamFile", "compiledScriptFile"],
      upstreamEnvelope: true,
    },
  },
  {
    toolName: "figma_workspace_inspect",
    category: "fixed-execution",
    upstreamToolName: "use_figma",
    upstreamKind: "inspection",
    requiredUpstreamProperties: ["code"],
    targetSupport: "string-only",
    outputPolicy: {
      inlineLimitFields: [],
      debugFiles: [],
      upstreamEnvelope: false,
    },
  },
  {
    toolName: "figma_workspace_get_metadata",
    category: "enhanced-wrapper",
    upstreamToolName: "get_metadata",
    upstreamKind: "metadata read",
    requiredUpstreamProperties: ["fileKey"],
    optionalUpstreamProperties: ["nodeId", "clientLanguages", "clientFrameworks"],
    targetSupport: "node-scoped",
    outputPolicy: {
      inlineLimitFields: ["metadata.json"],
      debugFiles: ["metadataFile"],
      upstreamEnvelope: true,
    },
    guidanceProfile: {
      workflowIds: ["inspection-and-qa"],
    },
  },
  {
    toolName: "figma_workspace_get_design_context",
    category: "thin-wrapper",
    upstreamToolName: "get_design_context",
    upstreamKind: "design context read",
    requiredUpstreamProperties: ["fileKey", "nodeId"],
    optionalUpstreamProperties: ["clientLanguages", "clientFrameworks"],
    targetSupport: "node-scoped",
    outputPolicy: {
      inlineLimitFields: UPSTREAM_INLINE_FIELDS,
      debugFiles: ["debugFile", "upstreamFile"],
      upstreamEnvelope: true,
    },
    guidanceProfile: {
      workflowIds: ["implementation-context"],
    },
  },
  {
    toolName: "figma_workspace_get_motion_context",
    category: "thin-wrapper",
    upstreamToolName: "get_motion_context",
    upstreamKind: "motion context read",
    requiredUpstreamProperties: ["fileKey", "nodeId"],
    optionalUpstreamProperties: ["recursive"],
    targetSupport: "node-scoped",
    outputPolicy: {
      inlineLimitFields: UPSTREAM_INLINE_FIELDS,
      debugFiles: ["debugFile", "upstreamFile"],
      upstreamEnvelope: true,
    },
    guidanceProfile: {
      workflowIds: ["motion-implementation"],
    },
  },
  {
    toolName: "figma_workspace_export_video",
    category: "thin-wrapper",
    upstreamToolName: "export_video",
    upstreamKind: "video export",
    requiredUpstreamProperties: ["fileKey"],
    optionalUpstreamProperties: ["nodeId", "jobId", "quality"],
    targetSupport: "node-scoped",
    outputPolicy: {
      inlineLimitFields: UPSTREAM_INLINE_FIELDS,
      debugFiles: ["debugFile", "upstreamFile"],
      upstreamEnvelope: true,
    },
    guidanceProfile: {
      workflowIds: ["motion-implementation"],
    },
  },
  {
    toolName: "figma_workspace_search_design_system",
    category: "thin-wrapper",
    upstreamToolName: "search_design_system",
    upstreamKind: "design system search",
    requiredUpstreamProperties: ["fileKey", "query"],
    optionalUpstreamProperties: [
      "disableCodeConnect",
      "includeComponents",
      "includeVariables",
      "includeStyles",
      "includeLibraryKeys",
    ],
    targetSupport: "none",
    outputPolicy: {
      inlineLimitFields: UPSTREAM_INLINE_FIELDS,
      debugFiles: ["debugFile", "upstreamFile"],
      upstreamEnvelope: true,
    },
    guidanceProfile: {
      workflowIds: ["design-system"],
    },
  },
  {
    toolName: "figma_workspace_get_libraries",
    category: "thin-wrapper",
    upstreamToolName: "get_libraries",
    upstreamKind: "library read",
    requiredUpstreamProperties: ["fileKey"],
    optionalUpstreamProperties: ["offset"],
    targetSupport: "none",
    outputPolicy: {
      inlineLimitFields: UPSTREAM_INLINE_FIELDS,
      debugFiles: ["debugFile", "upstreamFile"],
      upstreamEnvelope: true,
    },
    guidanceProfile: {
      workflowIds: ["design-system"],
    },
  },
  {
    toolName: "figma_workspace_get_variable_defs",
    category: "thin-wrapper",
    upstreamToolName: "get_variable_defs",
    upstreamKind: "variable definition read",
    requiredUpstreamProperties: ["fileKey", "nodeId"],
    optionalUpstreamProperties: ["clientLanguages", "clientFrameworks"],
    targetSupport: "node-scoped",
    outputPolicy: {
      inlineLimitFields: UPSTREAM_INLINE_FIELDS,
      debugFiles: ["debugFile", "upstreamFile"],
      upstreamEnvelope: true,
    },
    guidanceProfile: {
      workflowIds: ["design-system"],
    },
  },
  {
    toolName: "figma_workspace_apply_asset_manifest",
    category: "asset-capture-workflow",
    upstreamToolName: "upload_assets",
    upstreamKind: "asset upload/fill",
    requiredUpstreamProperties: ["fileKey", "count", "nodeId", "scaleMode"],
    targetSupport: "node-scoped-list",
    outputPolicy: {
      inlineLimitFields: [],
      debugFiles: ["debugFile"],
      upstreamEnvelope: false,
    },
  },
  {
    toolName: "figma_workspace_download_assets",
    category: "asset-capture-workflow",
    upstreamToolName: "download_assets",
    upstreamKind: "asset download",
    requiredUpstreamProperties: ["fileKey", "nodeId"],
    optionalUpstreamProperties: ["defaultFormat", "defaultScale"],
    targetSupport: "node-scoped-list",
    outputPolicy: {
      inlineLimitFields: [],
      debugFiles: ["debugFile"],
      upstreamEnvelope: false,
    },
  },
  {
    toolName: "figma_workspace_capture_node",
    category: "asset-capture-workflow",
    upstreamToolName: "get_screenshot",
    upstreamKind: "node screenshot",
    requiredUpstreamProperties: ["fileKey", "nodeId"],
    targetSupport: "node-scoped",
    outputPolicy: {
      inlineLimitFields: [],
      debugFiles: [],
      upstreamEnvelope: false,
    },
  },
  {
    toolName: "figma_workspace_run_task_plan",
    category: "asset-capture-workflow",
    targetSupport: "none",
    outputPolicy: {
      inlineLimitFields: [],
      debugFiles: ["debugFile"],
      upstreamEnvelope: false,
    },
  },
  {
    toolName: "figma_workspace_call_upstream_tool",
    category: "upstream-escape-hatch",
    targetSupport: "freeform-upstream",
    outputPolicy: {
      inlineLimitFields: UPSTREAM_INLINE_FIELDS,
      debugFiles: ["debugFile", "upstreamFile"],
      upstreamEnvelope: true,
    },
  },
] as const satisfies readonly FigmaWorkspaceWrapperContract[];

const WRAPPER_CONTRACTS_BY_TOOL = new Map<LocalWorkspaceToolName, FigmaWorkspaceWrapperContract>(
  FIGMA_WORKSPACE_WRAPPER_CONTRACTS.map((contract) => [contract.toolName, contract]),
);

export function getFigmaWorkspaceWrapperContract(
  toolName: LocalWorkspaceToolName,
): FigmaWorkspaceWrapperContract | undefined {
  return WRAPPER_CONTRACTS_BY_TOOL.get(toolName);
}

export function requireFigmaWorkspaceWrapperContract(
  toolName: LocalWorkspaceToolName,
): FigmaWorkspaceWrapperContract {
  const contract = getFigmaWorkspaceWrapperContract(toolName);
  if (!contract) {
    throw new Error(`Missing internal Figma Workspace wrapper contract for ${toolName}.`);
  }
  return contract;
}

export function getFigmaWorkspaceCoveredUpstreamToolNames(): string[] {
  return [...FIGMA_WORKSPACE_COVERED_UPSTREAM_TOOL_NAMES];
}
