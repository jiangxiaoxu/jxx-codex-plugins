import { LOCAL_WORKSPACE_TOOL_NAMES, type LocalWorkspaceToolName } from "./tool-registry.js";
import {
  CAPTURE_MAX_DIMENSION_MAX,
  CAPTURE_MAX_DIMENSION_MIN,
  DOCS_CATALOG_LIMIT_MAX,
  DOCS_CATALOG_LIMIT_MIN,
  FIGMA_WORKSPACE_INSPECT_DETAIL_FIELDS,
  INLINE_RESULT_LIMIT_MAX,
  INLINE_RESULT_LIMIT_MIN,
  INSPECT_DEPTH_MAX,
  INSPECT_DEPTH_MIN,
  LIBRARIES_OFFSET_MAX,
  LIBRARIES_OFFSET_MIN,
  LOOKUP_RESULTS_MAX,
  LOOKUP_RESULTS_MIN,
  LOOKUP_SNIPPET_LINES_MAX,
  LOOKUP_SNIPPET_LINES_MIN,
  MAX_MANIFEST_ITEMS,
} from "./tool-args.js";
import {
  schemaAssetManifestAsset,
  schemaBoolean,
  schemaClampedInteger,
  schemaDesignFileReference,
  schemaDesignNodeTarget,
  schemaDesignSurface,
  schemaFileKey,
  schemaInteger,
  schemaInvocation,
  schemaNodeId,
  schemaNodeTarget,
  schemaObject,
  schemaString,
  schemaSurface,
  schemaDesignSystemQueries,
} from "./json-command-contracts.js";
import type { JsonSchema } from "./json-command-contracts.js";

export interface ReplToolDescriptionOptions {
  taskWorkspaceRootEnv: string;
  defaultDocsSearchMaxResults: number;
  maxDocsSearchResults: number;
  defaultDocsSearchSnippetLines: number;
  maxDocsSearchSnippetLines: number;
  maxLookupQueryLength: number;
}

const string = schemaString;
const fileKey = (description: string): JsonSchema => schemaFileKey(description);
const nodeId = schemaNodeId;
const boolean = schemaBoolean;
const integer = schemaInteger;
const clampedInteger = schemaClampedInteger;
const surface = schemaSurface;
const designSurface = schemaDesignSurface;
const nodeTarget = schemaNodeTarget;
const invocation = schemaInvocation;
const designFileReference = schemaDesignFileReference;
const designNodeTarget = schemaDesignNodeTarget;
const designSystemQueries = schemaDesignSystemQueries;
const objectSchema = schemaObject;
const resultOutputFilesSchema: JsonSchema = {
  type: "object",
  properties: {
    resultFile: {
      type: "object",
      description: "The single complete JSON result file, created when inline output is insufficient or diagnostics require persistence. Business artifacts have their own pointers.",
      properties: {
        path: schemaString("Absolute path to the JSON result file."),
        bytes: schemaInteger("UTF-8 file size."),
        lineCount: schemaInteger("Formatted JSON line count."),
        jq: {
          type: "object",
          properties: {
            full: schemaString("jq filter for the complete file."),
            data: schemaString("jq filter for this command's result data."),
            status: schemaString("jq filter for execution status and diagnostics."),
          },
          required: ["full", "data", "status"],
          additionalProperties: { type: "string" },
        },
      },
      required: ["path", "bytes", "lineCount", "jq"],
      additionalProperties: false,
    },
  },
  additionalProperties: true,
};

const resultSchema = (properties: Record<string, JsonSchema> = {}): JsonSchema => ({
  type: "object",
  properties: {
    ok: schemaBoolean("Whether the operation completed successfully."),
    invocation: { type: "object", description: "Request-scoped invocation identity, Figma target, surface, and output root." },
    error: { type: "object", description: "Compact command-level error details for a local or nested batch failure." },
    upstreamError: { type: "object", description: "Compact top-level upstream error details when Figma cannot complete the request." },
    primaryFix: schemaString("Primary recovery action for the reported error."),
    outputFiles: resultOutputFilesSchema,
    ...properties,
  },
  required: ["ok"],
  additionalProperties: true,
});

export function createReplToolDescriptions(_options: ReplToolDescriptionOptions): Record<string, unknown>[] {
  const descriptions = new Map<LocalWorkspaceToolName, Record<string, unknown>>([
    ["figma_workspace_run", {
      name: "figma_workspace_run",
      description: "Execute one strict .figma.ts file or stdin TypeScript source against an explicitly identified Figma file. This is the only Plugin API mutation entrypoint. A direct returned use_figma script error reports executionOutcome=failed_atomic, so repair and retry safely; response loss remains outcome_unknown.",
      inputSchema: objectSchema({ ...invocation(), scriptPath: string("Absolute or cwd-resolved regular non-symlink .figma.ts file."), source: string("TypeScript source read from --source -."), targetPageId: nodeId("Optional PAGE node id.") }, ["file"], [{ required: ["scriptPath"] }, { required: ["source"] }]),
      outputSchema: resultSchema({ phase: string("preflight or execute."), executionOutcome: { type: "string", enum: ["not_started", "failed_atomic", "succeeded", "outcome_unknown"], description: "failed_atomic confirms a returned use_figma script error made no changes and can be retried after repair; succeeded confirms remote execution; outcome_unknown requires read-back and reconciliation before retry." }, upstreamError: { type: "object", description: "Compact upstream error details for failure diagnosis." }, retryGuidance: string("Safe recovery direction for the reported execution outcome."), captures: { type: "array" }, diagnostics: { type: "array" }, outputFiles: resultOutputFilesSchema }),
    }],
    ["figma_workspace_apply_asset_manifest", {
      name: "figma_workspace_apply_asset_manifest", description: "Apply local raster image assets as fills on explicit Figma node targets. SVG input is not accepted because SVG upload placement has different semantics.",
      inputSchema: objectSchema({ ...invocation(), assets: { type: "array", minItems: 1, maxItems: MAX_MANIFEST_ITEMS, items: schemaAssetManifestAsset(), description: "Raster asset entries." }, validateTargets: boolean("Validate target fills after upload.") }, ["file", "assets"]), outputSchema: resultSchema({ assets: { type: "array" }, failures: { type: "array" } }),
    }],
    ["figma_workspace_download_assets", {
      name: "figma_workspace_download_assets", description: "Download the official whole-node export, original raster source images, and vector-layer SVG assets to an explicit or invocation temp output directory.",
      inputSchema: objectSchema({ ...invocation(), target: nodeTarget(), defaultFormat: { type: "string", enum: ["png", "jpg", "svg", "pdf"], description: "Preferred whole-node export format." }, defaultScale: { type: "number", minimum: 0.01, maximum: 4, description: "Preferred whole-node export scale." } }, ["target"]), outputSchema: resultSchema({ targetNodeId: string("Downloaded node id."), outputDir: string("Absolute download directory."), downloadedFiles: { type: "array" }, upstreamError: { type: "object" }, downloadError: { type: "object" } }),
    }],
    ["figma_workspace_capture_node", {
      name: "figma_workspace_capture_node", description: "Capture one stable Figma node target as PNG.",
      inputSchema: objectSchema({ ...invocation(), target: nodeTarget(), nodeId: nodeId("Raw node id alias used with file."), imageFile: string("Optional PNG output path."), maxDimension: integer("Maximum screenshot dimension.", CAPTURE_MAX_DIMENSION_MIN, CAPTURE_MAX_DIMENSION_MAX), contentsOnly: boolean("Capture node contents only.") }, [], [{ required: ["target"] }, { required: ["file", "nodeId"] }]), outputSchema: resultSchema({ imageFile: string("Absolute PNG path."), nodeId: string("Captured node id."), bytes: integer("PNG bytes.") }),
    }],
    ["figma_workspace_inspect", {
      ...nodeReadDescription("figma_workspace_inspect", "Read one explicit page of Plugin API nodes, or aggregate styles. Each inspect page is a live read, not a file snapshot.", {
        mode: { type: "string", enum: ["inspect", "style"] },
        depth: integer("Maximum descendant depth; zero reads only the target. Style mode requires a positive depth. Omit on continuation to use the cursor's depth.", INSPECT_DEPTH_MIN, INSPECT_DEPTH_MAX),
        cursor: string("Opaque nextCursor from the preceding inspect page for the same file and node. Not accepted in style mode."),
        fields: { type: "array", minItems: 1, uniqueItems: true, items: { type: "string", enum: [...FIGMA_WORKSPACE_INSPECT_DETAIL_FIELDS] }, description: "Selected detail fields for inspect mode. All are included by default; structural fields are always returned. Omit on continuation to reuse the cursor's fields." },
      }),
      outputSchema: resultSchema({ nodes: { type: "array", description: "One depth-first page. Each node includes id, type, parentId, depth, childCount, and selected detail fields." }, hasMore: boolean("Whether this live traversal has another page."), nextCursor: string("Pass to the next explicit inspect invocation when hasMore is true."), readConsistency: { type: "string", enum: ["live"], description: "Changes between pages can cause repeated or omitted nodes; this is not a snapshot." } }),
    }],
    ["figma_workspace_get_metadata", {
      name: "figma_workspace_get_metadata",
      description: "Read broad official metadata from a Design file. FigJam and Slides structure must be inspected with a read-only figma:run script.",
      inputSchema: objectSchema({ ...invocation(), file: designFileReference("Design file URL or raw key; raw keys require surface design."), surface: designSurface(), target: designNodeTarget(), nodeId: nodeId("Raw Figma node id.", true), refresh: boolean("Refresh upstream discovery.") }, [], [{ required: ["target"] }, { required: ["file"] }]),
      outputSchema: resultSchema({ upstream: { type: "object" }, outputFiles: resultOutputFilesSchema }),
    }],
    ["figma_workspace_get_design_context", nodeReadDescription("figma_workspace_get_design_context", "Read official design implementation context.", { forceCode: boolean("Force code generation."), disableCodeConnect: boolean("Disable Code Connect."), excludeScreenshot: boolean("Exclude screenshot context.") }, true, true)],
    ["figma_workspace_get_motion_context", nodeReadDescription("figma_workspace_get_motion_context", "Read official motion context.", { recursive: boolean("Read recursively.") })],
    ["figma_workspace_get_variable_defs", nodeReadDescription("figma_workspace_get_variable_defs", "Read official variable definitions.")],
    ["figma_workspace_search_design_system", {
      name: "figma_workspace_search_design_system", description: "Search components, variables, and styles in one explicit Figma file with an ordered batch of entity-specific queries.",
      inputSchema: objectSchema({ ...invocation(), queries: designSystemQueries(), disableCodeConnect: boolean("Disable Code Connect."), includeLibraryKeys: { type: "array", items: { type: "string" } }, refresh: boolean("Refresh upstream discovery.") }, ["file", "queries"]), outputSchema: resultSchema({ fileKey: string("Resolved Figma file key."), queries: designSystemQueries(), upstream: { type: "object" } }),
    }],
    ["figma_workspace_get_libraries", {
      name: "figma_workspace_get_libraries", description: "List libraries for one explicit Figma file.", inputSchema: objectSchema({ ...invocation(), offset: integer("Pagination offset.", LIBRARIES_OFFSET_MIN, LIBRARIES_OFFSET_MAX), refresh: boolean("Refresh upstream discovery.") }, ["file"]), outputSchema: resultSchema({ upstream: { type: "object" } }),
    }],
    ["figma_workspace_call_upstream_tool", {
      name: "figma_workspace_call_upstream_tool", description: "Call any official Figma MCP capability through its live schema. Covered first-class commands add local validation and result handling but do not block direct calls.", inputSchema: objectSchema({ ...invocation(), toolName: string("Exact official tool name."), arguments: { type: "object", additionalProperties: true, description: "Arguments for the selected live upstream schema." }, refresh: boolean("Refresh upstream discovery.") }, ["toolName"]), outputSchema: resultSchema({ toolName: string("Called official tool name."), phase: { type: "string", enum: ["preflight", "execute"] }, executionOutcome: { type: "string", enum: ["not_started", "failed_atomic", "succeeded", "outcome_unknown"] }, retryGuidance: string("Safe recovery direction when execution completion is not confirmed."), upstream: { type: "object" }, outputFiles: resultOutputFilesSchema }),
    }],
    ["figma_workspace_lookup", {
      name: "figma_workspace_lookup", description: "Search canonical workflow docs, search generated Plugin API declarations, or read declarations selected by a readable Plugin API selector locally.", inputSchema: objectSchema({ kind: { type: "string", enum: ["docs", "api"] }, mode: { type: "string", enum: ["search", "read"], description: "Required for API lookup. Docs lookup does not accept mode." }, scope: { type: "string", enum: ["auto", "active", "conditional", "router", "examples", "all"] }, surface: surface(), taskFamily: string("Canonical task family."), query: string("Docs query."), symbol: string("Docs query alias."), selector: string("One bare, qualified, or call-shaped Plugin API selector. API read requires a unique owner; use a qualified selector when a bare symbol is ambiguous."), maxResults: clampedInteger("Maximum results for API or docs search.", LOOKUP_RESULTS_MIN, LOOKUP_RESULTS_MAX), maxSnippetLines: clampedInteger("Maximum snippet lines for API or docs search.", LOOKUP_SNIPPET_LINES_MIN, LOOKUP_SNIPPET_LINES_MAX) }, ["kind"]), outputSchema: resultSchema({ mode: { type: "string", enum: ["search", "read"] }, results: { type: "array" }, declarations: { type: "array", description: "Complete declarations for the selected API owner, including all overloads." }, parameterAdjustments: { type: "array" }, snippetBudget: { type: "object" } }),
    }],
    ["figma_workspace_docs", {
      name: "figma_workspace_docs", description: "List, catalog, or read canonical local workflow documentation.", inputSchema: objectSchema({ mode: { type: "string", enum: ["list", "catalog", "read"] }, id: string("project: or canonical: document id."), taskFamily: string("Task family filter."), surface: surface(), classification: string("Classification filter."), limit: clampedInteger("Catalog result limit.", DOCS_CATALOG_LIMIT_MIN, DOCS_CATALOG_LIMIT_MAX) }, ["mode"]), outputSchema: resultSchema({ parameterAdjustments: { type: "array" } }),
    }],
    ["figma_workspace_doctor", {
      name: "figma_workspace_doctor", description: "Diagnose bundled canonical docs, Plugin API index, and TypeScript runtime assets.", inputSchema: objectSchema({}), outputSchema: resultSchema({ runtime: { type: "object" } }),
    }],
    ["figma_workspace_upstream_tools", {
      name: "figma_workspace_upstream_tools", description: "List official upstream tools or read one exact live schema. Coverage is advisory: a first-class command adds local validation and result handling, while direct calls remain available.", inputSchema: objectSchema({ name: string("Exact upstream tool name."), refresh: boolean("Refresh discovery.") }), outputSchema: resultSchema({ tools: { type: "array" }, title: string("Official tool title."), description: string("Official tool description."), inputSchema: {}, outputSchema: {}, coverage: { type: "object" } }),
    }],
  ]);
  for (const name of LOCAL_WORKSPACE_TOOL_NAMES) if (!descriptions.has(name)) throw new Error(`Missing Figma Workspace tool description: ${name}`);
  return LOCAL_WORKSPACE_TOOL_NAMES.map((name) => descriptions.get(name)!);
}

function nodeReadDescription(name: LocalWorkspaceToolName, description: string, extra: Record<string, JsonSchema> = {}, requireNode = true, allowComposite = false): Record<string, unknown> {
  return {
    name, description,
    inputSchema: objectSchema({ ...invocation(), target: nodeTarget(allowComposite), nodeId: nodeId("Raw node id alias used with file.", allowComposite), refresh: boolean("Refresh upstream discovery."), ...extra }, [], requireNode ? [{ required: ["target"] }, { required: ["file", "nodeId"] }] : undefined),
    outputSchema: resultSchema({ upstream: { type: "object" }, outputFiles: resultOutputFilesSchema }),
  };
}
