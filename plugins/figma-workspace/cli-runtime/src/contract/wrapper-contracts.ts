import type { LocalWorkspaceToolName } from "./tool-registry.js";

export type FigmaWorkspaceCodeConnectWorkflowStepContractName =
  | "figma_workspace_code_connect_inspect"
  | "figma_workspace_code_connect_plan_context"
  | "figma_workspace_code_connect_plan_suggestions"
  | "figma_workspace_code_connect_plan_mapping_read"
  | "figma_workspace_code_connect_apply_mapping_read"
  | "figma_workspace_code_connect_apply"
  | "figma_workspace_code_connect_verify_mapping_read";

export type FigmaWorkspaceWrapperContractName =
  | LocalWorkspaceToolName
  | FigmaWorkspaceCodeConnectWorkflowStepContractName;

export type FigmaWorkspaceWrapperCategory =
  | "fixed-execution"
  | "enhanced-wrapper"
  | "thin-wrapper"
  | "asset-capture-workflow"
  | "code-connect-workflow"
  | "upstream-escape-hatch";

export type FigmaWorkspaceWrapperTargetSupport =
  | "none"
  | "string-only"
  | "node-scoped"
  | "node-scoped-list"
  | "file-scoped"
  | "freeform-upstream";

export interface FigmaWorkspaceWrapperOutputPolicy {
  inlineLimitFields: readonly string[];
  debugFiles: readonly string[];
  upstreamEnvelope: boolean;
}

export interface FigmaWorkspaceWrapperParameterMatrix {
  requiredUpstream: readonly string[];
  publicPassthrough: readonly string[];
  derivedUpstream: readonly string[];
  fixedUpstream: readonly string[];
  passthroughOptional: readonly string[];
  hiddenUpstreamOptional: readonly string[];
}

export interface FigmaWorkspaceWrapperContract {
  toolName: FigmaWorkspaceWrapperContractName;
  category: FigmaWorkspaceWrapperCategory;
  upstreamToolName?: string;
  upstreamKind?: string;
  requiredUpstreamProperties?: readonly string[];
  optionalUpstreamProperties?: readonly string[];
  parameterMatrix: FigmaWorkspaceWrapperParameterMatrix;
  targetSupport: FigmaWorkspaceWrapperTargetSupport;
  outputPolicy: FigmaWorkspaceWrapperOutputPolicy;
  guidanceProfile?: {
    workflowIds: readonly string[];
  };
}

const UPSTREAM_INLINE_FIELDS = ["upstream.result", "upstream.text"] as const;
const EMPTY_PARAMETER_MATRIX = {
  requiredUpstream: [],
  publicPassthrough: [],
  derivedUpstream: [],
  fixedUpstream: [],
  passthroughOptional: [],
  hiddenUpstreamOptional: [],
} as const satisfies FigmaWorkspaceWrapperParameterMatrix;

function parameterMatrix(
  matrix: Partial<FigmaWorkspaceWrapperParameterMatrix>,
): FigmaWorkspaceWrapperParameterMatrix {
  return {
    requiredUpstream: matrix.requiredUpstream ?? EMPTY_PARAMETER_MATRIX.requiredUpstream,
    publicPassthrough: matrix.publicPassthrough ?? EMPTY_PARAMETER_MATRIX.publicPassthrough,
    derivedUpstream: matrix.derivedUpstream ?? EMPTY_PARAMETER_MATRIX.derivedUpstream,
    fixedUpstream: matrix.fixedUpstream ?? EMPTY_PARAMETER_MATRIX.fixedUpstream,
    passthroughOptional: matrix.passthroughOptional ?? EMPTY_PARAMETER_MATRIX.passthroughOptional,
    hiddenUpstreamOptional: matrix.hiddenUpstreamOptional ?? EMPTY_PARAMETER_MATRIX.hiddenUpstreamOptional,
  };
}

export const FIGMA_WORKSPACE_NODE_SCOPED_TARGET_DESCRIPTION =
  "Accepts a raw node id paired with file, a Figma node URL, or exact { fileKey, nodeId }. Dynamic selectors are not supported.";

export const FIGMA_WORKSPACE_COVERED_UPSTREAM_TOOL_NAMES = [
  "use_figma",
  "get_metadata",
  "get_screenshot",
  "upload_assets",
  "download_assets",
  "get_design_context",
  "get_motion_context",
  "search_design_system",
  "get_libraries",
  "get_variable_defs",
  "list_file_components_for_code_connect",
  "get_context_for_code_connect",
  "get_code_connect_suggestions",
  "get_code_connect_map",
  "send_code_connect_mappings",
] as const;

export const FIGMA_WORKSPACE_UPSTREAM_ESCAPE_HATCH_GUIDANCE =
  "Read the live schema before direct calls. A covered first-class command adds local validation and result handling, but figma:upstream:call remains available for every official tool.";

export const FIGMA_WORKSPACE_WRAPPER_CONTRACTS = [
  {
    toolName: "figma_workspace_run",
    category: "fixed-execution",
    upstreamToolName: "use_figma",
    upstreamKind: "execution",
    requiredUpstreamProperties: ["code", "description", "fileKey"],
    optionalUpstreamProperties: ["skillNames"],
    parameterMatrix: parameterMatrix({
      requiredUpstream: ["code", "description", "fileKey"],
      derivedUpstream: ["code", "fileKey"],
      fixedUpstream: ["description"],
      hiddenUpstreamOptional: ["skillNames"],
    }),
    targetSupport: "none",
    outputPolicy: {
      inlineLimitFields: UPSTREAM_INLINE_FIELDS,
      debugFiles: ["debugFile", "upstreamFile"],
      upstreamEnvelope: true,
    },
  },
  {
    toolName: "figma_workspace_inspect",
    category: "fixed-execution",
    upstreamToolName: "use_figma",
    upstreamKind: "inspection",
    requiredUpstreamProperties: ["code", "description", "fileKey"],
    optionalUpstreamProperties: ["skillNames"],
    parameterMatrix: parameterMatrix({
      requiredUpstream: ["code", "description", "fileKey"],
      derivedUpstream: ["fileKey"],
      fixedUpstream: ["code", "description"],
      hiddenUpstreamOptional: ["skillNames"],
    }),
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
    optionalUpstreamProperties: ["nodeId"],
    parameterMatrix: parameterMatrix({
      requiredUpstream: ["fileKey"],
      publicPassthrough: ["nodeId"],
      derivedUpstream: ["fileKey"],
      passthroughOptional: ["nodeId"],
    }),
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
    optionalUpstreamProperties: ["clientLanguages", "clientFrameworks", "forceCode", "disableCodeConnect", "excludeScreenshot", "skillNames"],
    parameterMatrix: parameterMatrix({
      requiredUpstream: ["fileKey", "nodeId"],
      publicPassthrough: ["clientLanguages", "clientFrameworks", "forceCode", "disableCodeConnect", "excludeScreenshot"],
      derivedUpstream: ["fileKey", "nodeId"],
      passthroughOptional: ["clientLanguages", "clientFrameworks", "forceCode", "disableCodeConnect", "excludeScreenshot"],
      hiddenUpstreamOptional: ["skillNames"],
    }),
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
    optionalUpstreamProperties: ["recursive", "clientLanguages", "clientFrameworks"],
    parameterMatrix: parameterMatrix({
      requiredUpstream: ["fileKey", "nodeId"],
      publicPassthrough: ["recursive", "clientLanguages", "clientFrameworks"],
      derivedUpstream: ["fileKey", "nodeId"],
      passthroughOptional: ["recursive", "clientLanguages", "clientFrameworks"],
    }),
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
    parameterMatrix: parameterMatrix({
      requiredUpstream: ["fileKey", "query"],
      publicPassthrough: ["query", "disableCodeConnect", "includeComponents", "includeVariables", "includeStyles", "includeLibraryKeys"],
      derivedUpstream: ["fileKey"],
      passthroughOptional: ["disableCodeConnect", "includeComponents", "includeVariables", "includeStyles", "includeLibraryKeys"],
    }),
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
    parameterMatrix: parameterMatrix({
      requiredUpstream: ["fileKey"],
      publicPassthrough: ["offset"],
      derivedUpstream: ["fileKey"],
      passthroughOptional: ["offset"],
    }),
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
    parameterMatrix: parameterMatrix({
      requiredUpstream: ["fileKey", "nodeId"],
      derivedUpstream: ["fileKey", "nodeId"],
    }),
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
    requiredUpstreamProperties: ["fileKey", "count", "nodeIds", "scaleMode"],
    optionalUpstreamProperties: ["batchCommit", "nodeId"],
    parameterMatrix: parameterMatrix({
      requiredUpstream: ["fileKey", "nodeIds"],
      derivedUpstream: ["fileKey", "nodeIds", "scaleMode"],
      fixedUpstream: ["count"],
      hiddenUpstreamOptional: ["batchCommit", "nodeId"],
    }),
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
    parameterMatrix: parameterMatrix({
      requiredUpstream: ["fileKey", "nodeId"],
      publicPassthrough: ["defaultFormat", "defaultScale"],
      derivedUpstream: ["fileKey", "nodeId"],
      passthroughOptional: ["defaultFormat", "defaultScale"],
    }),
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
    optionalUpstreamProperties: ["maxDimension", "contentsOnly", "enableBase64Response"],
    parameterMatrix: parameterMatrix({
      requiredUpstream: ["fileKey", "nodeId"],
      publicPassthrough: ["maxDimension", "contentsOnly"],
      derivedUpstream: ["fileKey", "nodeId"],
      passthroughOptional: ["maxDimension", "contentsOnly"],
      hiddenUpstreamOptional: ["enableBase64Response"],
    }),
    targetSupport: "node-scoped",
    outputPolicy: {
      inlineLimitFields: [],
      debugFiles: [],
      upstreamEnvelope: false,
    },
  },
  {
    toolName: "figma_workspace_code_connect_inspect",
    category: "code-connect-workflow",
    upstreamToolName: "list_file_components_for_code_connect",
    upstreamKind: "Code Connect component discovery",
    requiredUpstreamProperties: ["fileKey"],
    parameterMatrix: parameterMatrix({
      requiredUpstream: ["fileKey"],
      derivedUpstream: ["fileKey"],
    }),
    targetSupport: "file-scoped",
    outputPolicy: { inlineLimitFields: UPSTREAM_INLINE_FIELDS, debugFiles: ["debugFile", "upstreamFile"], upstreamEnvelope: true },
  },
  {
    toolName: "figma_workspace_code_connect_plan_context",
    category: "code-connect-workflow",
    upstreamToolName: "get_context_for_code_connect",
    upstreamKind: "Code Connect component context",
    requiredUpstreamProperties: ["fileKey", "nodeId"],
    parameterMatrix: parameterMatrix({
      requiredUpstream: ["fileKey", "nodeId"],
      derivedUpstream: ["fileKey", "nodeId"],
    }),
    targetSupport: "node-scoped",
    outputPolicy: { inlineLimitFields: UPSTREAM_INLINE_FIELDS, debugFiles: ["debugFile", "upstreamFile"], upstreamEnvelope: true },
  },
  {
    toolName: "figma_workspace_code_connect_plan_suggestions",
    category: "code-connect-workflow",
    upstreamToolName: "get_code_connect_suggestions",
    upstreamKind: "Code Connect suggestions",
    requiredUpstreamProperties: ["fileKey", "nodeId"],
    optionalUpstreamProperties: ["excludeMappingPrompt"],
    parameterMatrix: parameterMatrix({
      requiredUpstream: ["fileKey", "nodeId"],
      derivedUpstream: ["fileKey", "nodeId"],
      hiddenUpstreamOptional: ["excludeMappingPrompt"],
    }),
    targetSupport: "node-scoped",
    outputPolicy: { inlineLimitFields: UPSTREAM_INLINE_FIELDS, debugFiles: ["debugFile", "upstreamFile"], upstreamEnvelope: true },
  },
  {
    toolName: "figma_workspace_code_connect_plan_mapping_read",
    category: "code-connect-workflow",
    upstreamToolName: "get_code_connect_map",
    upstreamKind: "Code Connect mapping read",
    requiredUpstreamProperties: ["fileKey", "nodeId"],
    optionalUpstreamProperties: ["codeConnectLabel"],
    parameterMatrix: parameterMatrix({
      requiredUpstream: ["fileKey", "nodeId"],
      derivedUpstream: ["fileKey", "nodeId"],
      hiddenUpstreamOptional: ["codeConnectLabel"],
    }),
    targetSupport: "node-scoped",
    outputPolicy: { inlineLimitFields: UPSTREAM_INLINE_FIELDS, debugFiles: ["debugFile", "upstreamFile"], upstreamEnvelope: true },
  },
  {
    toolName: "figma_workspace_code_connect_apply_mapping_read",
    category: "code-connect-workflow",
    upstreamToolName: "get_code_connect_map",
    upstreamKind: "Code Connect mapping stale-plan read",
    requiredUpstreamProperties: ["fileKey", "nodeId"],
    optionalUpstreamProperties: ["codeConnectLabel"],
    parameterMatrix: parameterMatrix({
      requiredUpstream: ["fileKey", "nodeId"],
      derivedUpstream: ["fileKey", "nodeId"],
      hiddenUpstreamOptional: ["codeConnectLabel"],
    }),
    targetSupport: "node-scoped",
    outputPolicy: { inlineLimitFields: UPSTREAM_INLINE_FIELDS, debugFiles: ["debugFile", "upstreamFile"], upstreamEnvelope: true },
  },
  {
    toolName: "figma_workspace_code_connect_apply",
    category: "code-connect-workflow",
    upstreamToolName: "send_code_connect_mappings",
    upstreamKind: "Code Connect bulk mapping write",
    requiredUpstreamProperties: ["fileKey", "nodeId", "mappings"],
    optionalUpstreamProperties: ["clientLanguages", "clientFrameworks"],
    parameterMatrix: parameterMatrix({
      requiredUpstream: ["fileKey", "nodeId", "mappings"],
      derivedUpstream: ["fileKey", "nodeId", "mappings"],
      hiddenUpstreamOptional: ["clientLanguages", "clientFrameworks"],
    }),
    targetSupport: "node-scoped",
    outputPolicy: { inlineLimitFields: UPSTREAM_INLINE_FIELDS, debugFiles: ["debugFile", "upstreamFile"], upstreamEnvelope: true },
  },
  {
    toolName: "figma_workspace_code_connect_verify_mapping_read",
    category: "code-connect-workflow",
    upstreamToolName: "get_code_connect_map",
    upstreamKind: "Code Connect mapping verification read",
    requiredUpstreamProperties: ["fileKey", "nodeId"],
    optionalUpstreamProperties: ["codeConnectLabel"],
    parameterMatrix: parameterMatrix({
      requiredUpstream: ["fileKey", "nodeId"],
      derivedUpstream: ["fileKey", "nodeId"],
      hiddenUpstreamOptional: ["codeConnectLabel"],
    }),
    targetSupport: "node-scoped",
    outputPolicy: { inlineLimitFields: UPSTREAM_INLINE_FIELDS, debugFiles: ["debugFile", "upstreamFile"], upstreamEnvelope: true },
  },
  {
    toolName: "figma_workspace_call_upstream_tool",
    category: "upstream-escape-hatch",
    parameterMatrix: parameterMatrix({}),
    targetSupport: "freeform-upstream",
    outputPolicy: {
      inlineLimitFields: UPSTREAM_INLINE_FIELDS,
      debugFiles: ["debugFile", "upstreamFile"],
      upstreamEnvelope: true,
    },
  },
] as const satisfies readonly FigmaWorkspaceWrapperContract[];

const WRAPPER_CONTRACTS_BY_TOOL = new Map<FigmaWorkspaceWrapperContractName, FigmaWorkspaceWrapperContract>(
  FIGMA_WORKSPACE_WRAPPER_CONTRACTS.map((contract) => [contract.toolName, contract]),
);

export function getFigmaWorkspaceWrapperContract(
  toolName: FigmaWorkspaceWrapperContractName,
): FigmaWorkspaceWrapperContract | undefined {
  return WRAPPER_CONTRACTS_BY_TOOL.get(toolName);
}

export function requireFigmaWorkspaceWrapperContract(
  toolName: FigmaWorkspaceWrapperContractName,
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
