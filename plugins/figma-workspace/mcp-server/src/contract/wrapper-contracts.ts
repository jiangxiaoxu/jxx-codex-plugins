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

export interface FigmaWorkspaceWrapperParameterMatrix {
  requiredUpstream: readonly string[];
  publicPassthrough: readonly string[];
  derivedUpstream: readonly string[];
  fixedUpstream: readonly string[];
  passthroughOptional: readonly string[];
  hiddenUpstreamOptional: readonly string[];
  localOnly: readonly string[];
  removedLegacy: readonly string[];
}

export interface FigmaWorkspaceWrapperContract {
  toolName: LocalWorkspaceToolName;
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
  localOnly: [],
  removedLegacy: [],
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
    localOnly: matrix.localOnly ?? EMPTY_PARAMETER_MATRIX.localOnly,
    removedLegacy: matrix.removedLegacy ?? EMPTY_PARAMETER_MATRIX.removedLegacy,
  };
}

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
  "search_design_system",
  "get_libraries",
  "get_variable_defs",
] as const;

export const FIGMA_WORKSPACE_UPSTREAM_ESCAPE_HATCH_GUIDANCE =
  "Prefer first-class figma_workspace_* wrappers when available; use figma_workspace_call_upstream_tool for raw upstream behavior or uncovered official capabilities.";

export const FIGMA_WORKSPACE_WRAPPER_CONTRACTS = [
  {
    toolName: "figma_workspace_eval",
    category: "fixed-execution",
    upstreamToolName: "use_figma",
    upstreamKind: "execution",
    requiredUpstreamProperties: ["code", "description", "fileKey"],
    optionalUpstreamProperties: ["skillNames"],
    parameterMatrix: parameterMatrix({
      requiredUpstream: ["code", "description", "fileKey"],
      publicPassthrough: ["code"],
      derivedUpstream: ["fileKey"],
      fixedUpstream: ["description"],
      hiddenUpstreamOptional: ["skillNames"],
      localOnly: ["title", "sessionId", "typescript", "mode", "surface", "allowDangerousOperations", "handleUpdates", "inlineResultLimit"],
      removedLegacy: ["outputFile", "resultFile", "upstreamTool", "upstreamArgument", "upstreamArguments"],
    }),
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
    requiredUpstreamProperties: ["code", "description", "fileKey"],
    optionalUpstreamProperties: ["skillNames"],
    parameterMatrix: parameterMatrix({
      requiredUpstream: ["code", "description", "fileKey"],
      derivedUpstream: ["code", "fileKey"],
      fixedUpstream: ["description"],
      hiddenUpstreamOptional: ["skillNames"],
      localOnly: ["title", "sessionId", "scriptPath", "inputFile", "strict", "surface", "targetPageId", "allowDangerousOperations", "inlineResultLimit"],
      removedLegacy: ["dryRun", "outputFile", "resultFile", "outputDir", "diagnosticsFile", "summaryFile", "upstreamTool", "upstreamArgument", "upstreamArguments"],
    }),
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
    requiredUpstreamProperties: ["code", "description", "fileKey"],
    optionalUpstreamProperties: ["skillNames"],
    parameterMatrix: parameterMatrix({
      requiredUpstream: ["code", "description", "fileKey"],
      derivedUpstream: ["fileKey"],
      fixedUpstream: ["code", "description"],
      hiddenUpstreamOptional: ["skillNames"],
      localOnly: ["title", "sessionId", "mode", "target", "depth", "handles"],
      removedLegacy: ["upstreamTool", "upstreamArgument", "upstreamArguments"],
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
    optionalUpstreamProperties: ["nodeId", "clientLanguages", "clientFrameworks"],
    parameterMatrix: parameterMatrix({
      requiredUpstream: ["fileKey"],
      publicPassthrough: ["nodeId", "clientLanguages", "clientFrameworks"],
      derivedUpstream: ["fileKey"],
      passthroughOptional: ["nodeId", "clientLanguages", "clientFrameworks"],
      localOnly: ["title", "sessionId", "file", "workspaceDir", "target", "refresh", "inlineResultLimit"],
      removedLegacy: ["outputFile", "resultFile", "metadataFile", "fileUrl", "fileKey"],
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
    optionalUpstreamProperties: ["clientLanguages", "clientFrameworks", "forceCode", "disableCodeConnect", "excludeScreenshot"],
    parameterMatrix: parameterMatrix({
      requiredUpstream: ["fileKey", "nodeId"],
      publicPassthrough: ["clientLanguages", "clientFrameworks", "forceCode", "disableCodeConnect", "excludeScreenshot"],
      derivedUpstream: ["fileKey", "nodeId"],
      passthroughOptional: ["clientLanguages", "clientFrameworks", "forceCode", "disableCodeConnect", "excludeScreenshot"],
      localOnly: ["title", "sessionId", "file", "workspaceDir", "target", "refresh", "inlineResultLimit"],
      removedLegacy: ["outputFile", "resultFile", "fileUrl", "fileKey"],
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
      localOnly: ["title", "sessionId", "file", "workspaceDir", "target", "refresh", "inlineResultLimit"],
      removedLegacy: ["outputFile", "resultFile", "fileUrl", "fileKey"],
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
      localOnly: ["title", "sessionId", "file", "workspaceDir", "refresh", "inlineResultLimit"],
      removedLegacy: ["outputFile", "resultFile", "fileUrl", "fileKey"],
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
      localOnly: ["title", "sessionId", "file", "workspaceDir", "refresh", "inlineResultLimit"],
      removedLegacy: ["outputFile", "resultFile", "fileUrl", "fileKey"],
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
      localOnly: ["title", "sessionId", "file", "workspaceDir", "target", "refresh", "inlineResultLimit"],
      removedLegacy: ["clientLanguages", "clientFrameworks", "outputFile", "resultFile", "fileUrl", "fileKey"],
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
    requiredUpstreamProperties: ["fileKey", "count", "nodeId", "scaleMode"],
    optionalUpstreamProperties: ["batchCommit"],
    parameterMatrix: parameterMatrix({
      requiredUpstream: ["fileKey"],
      derivedUpstream: ["fileKey", "nodeId", "scaleMode"],
      fixedUpstream: ["count"],
      hiddenUpstreamOptional: ["batchCommit"],
      localOnly: ["title", "sessionId", "assets", "manifestPath", "validateTargets"],
      removedLegacy: ["argumentsTemplate", "toolName", "arguments", "refresh", "outputFile", "resultFile"],
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
      localOnly: ["title", "sessionId", "targets", "manifestPath", "outputDir"],
      removedLegacy: ["target", "assets", "toolName", "arguments", "refresh", "download", "outputFile", "resultFile"],
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
      localOnly: ["title", "sessionId", "target", "imageFile"],
      removedLegacy: ["nodeId", "targetNodeId", "handle", "outputFile", "resultFile", "metadataFile", "argumentsTemplate", "toolName", "arguments", "refresh", "preview", "thumbnail", "thumbnailMaxSize"],
    }),
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
    parameterMatrix: parameterMatrix({
      localOnly: ["title", "sessionId", "planPath", "steps", "stopOnFailure"],
      removedLegacy: ["outputFile", "resultFile"],
    }),
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
    parameterMatrix: parameterMatrix({
      localOnly: ["title", "sessionId", "toolName", "arguments", "refresh", "inlineResultLimit"],
      removedLegacy: ["outputFile", "resultFile"],
    }),
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
