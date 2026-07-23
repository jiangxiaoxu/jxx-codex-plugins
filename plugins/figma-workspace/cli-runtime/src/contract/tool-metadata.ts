import { LOCAL_WORKSPACE_TOOL_NAMES, type LocalWorkspaceToolName } from "./tool-registry.js";

export interface ReplToolDescriptionOptions {
  taskWorkspaceRootEnv: string;
  defaultDocsSearchMaxResults: number;
  maxDocsSearchResults: number;
  defaultDocsSearchSnippetLines: number;
  maxDocsSearchSnippetLines: number;
  maxLookupQueryLength: number;
}

type JsonSchema = Record<string, unknown>;

const string = (description: string): JsonSchema => ({ type: "string", description });
const boolean = (description: string): JsonSchema => ({ type: "boolean", description });
const integer = (description: string, minimum = 0, maximum?: number): JsonSchema => ({ type: "integer", minimum, ...(maximum === undefined ? {} : { maximum }), description });
const surface = (): JsonSchema => ({ type: "string", enum: ["design", "figjam", "slides"], description: "Explicit surface. Required with a raw file key for Plugin API execution." });
const nodeTarget = (): JsonSchema => ({
  description: "Stable node target: raw node id (with file), Figma node URL, or exact { fileKey, nodeId }.",
  oneOf: [
    { type: "string", minLength: 1, pattern: "^(?!\\$)(?=.*\\S)" },
    { type: "object", properties: { fileKey: string("Figma file key."), nodeId: string("Figma node id.") }, required: ["fileKey", "nodeId"], additionalProperties: false },
  ],
});
const invocation = (): Record<string, JsonSchema> => ({
  title: string("Optional display label."),
  file: string("Figma file URL or raw file key."),
  surface: surface(),
  outputDir: string("Optional absolute local output root; omitted outputs use one invocation temp directory."),
  inlineResultLimit: integer("Maximum inline result bytes from 0 to 10000.", 0, 10_000),
});
const objectSchema = (properties: Record<string, JsonSchema>, required: readonly string[] = [], anyOf?: readonly JsonSchema[]): JsonSchema => ({ type: "object", properties, required: [...required], ...(anyOf ? { anyOf } : {}), additionalProperties: false });
const resultSchema = (properties: Record<string, JsonSchema> = {}): JsonSchema => ({ type: "object", properties: { ok: boolean("Whether the operation completed successfully."), invocation: { type: "object", description: "Request-scoped invocation identity, Figma target, surface, and output root." }, ...properties }, required: ["ok"], additionalProperties: true });

export function createReplToolDescriptions(_options: ReplToolDescriptionOptions): Record<string, unknown>[] {
  const descriptions = new Map<LocalWorkspaceToolName, Record<string, unknown>>([
    ["figma_workspace_run", {
      name: "figma_workspace_run",
      description: "Execute one strict .figma.ts file or stdin TypeScript source against an explicitly identified Figma file. This is the only Plugin API mutation entrypoint.",
      inputSchema: objectSchema({ ...invocation(), scriptPath: string("Absolute or cwd-resolved regular non-symlink .figma.ts file."), source: string("TypeScript source read from --source -."), targetPageId: string("Optional PAGE node id.") }, ["file"], [{ required: ["scriptPath"] }, { required: ["source"] }]),
      outputSchema: resultSchema({ phase: string("preflight or execute."), executionOutcome: { type: "string", enum: ["not_started", "succeeded", "outcome_unknown"] }, captures: { type: "array" }, diagnostics: { type: "array" }, outputFiles: { type: "object" } }),
    }],
    ["figma_workspace_apply_asset_manifest", {
      name: "figma_workspace_apply_asset_manifest", description: "Apply local image assets to explicit Figma node targets.",
      inputSchema: objectSchema({ ...invocation(), assets: { type: "array", maxItems: 64 }, manifestPath: string("Asset manifest path."), validateTargets: boolean("Validate target fills after upload.") }, ["file"], [{ required: ["assets"] }, { required: ["manifestPath"] }]), outputSchema: resultSchema({ assets: { type: "array" }, failures: { type: "array" } }),
    }],
    ["figma_workspace_download_assets", {
      name: "figma_workspace_download_assets", description: "Download official Figma assets to an explicit or invocation temp output directory.",
      inputSchema: objectSchema({ ...invocation(), targets: { type: "array", maxItems: 64 }, manifestPath: string("Download manifest path.") }, [], [{ required: ["targets"] }, { required: ["manifestPath"] }]), outputSchema: resultSchema({ targets: { type: "array" }, outputDir: string("Absolute download directory.") }),
    }],
    ["figma_workspace_capture_node", {
      name: "figma_workspace_capture_node", description: "Capture one stable Figma node target as PNG.",
      inputSchema: objectSchema({ ...invocation(), target: nodeTarget(), nodeId: string("Raw node id alias used with file."), imageFile: string("Optional PNG output path."), maxDimension: integer("Maximum screenshot dimension.", 1, 65536), contentsOnly: boolean("Capture node contents only.") }, [], [{ required: ["target"] }, { required: ["file", "nodeId"] }]), outputSchema: resultSchema({ imageFile: string("Absolute PNG path."), nodeId: string("Captured node id."), bytes: integer("PNG bytes.") }),
    }],
    ["figma_workspace_inspect", nodeReadDescription("figma_workspace_inspect", "Run a compact Plugin API inspection.", { mode: { type: "string", enum: ["inspect", "style"] }, depth: integer("Traversal depth.", 1) })],
    ["figma_workspace_get_metadata", nodeReadDescription("figma_workspace_get_metadata", "Read broad official Figma metadata.", { clientLanguages: string("Client language hint."), clientFrameworks: string("Client framework hint.") }, false)],
    ["figma_workspace_get_design_context", nodeReadDescription("figma_workspace_get_design_context", "Read official design implementation context.", { forceCode: boolean("Force code generation."), disableCodeConnect: boolean("Disable Code Connect."), excludeScreenshot: boolean("Exclude screenshot context.") })],
    ["figma_workspace_get_motion_context", nodeReadDescription("figma_workspace_get_motion_context", "Read official motion context.", { recursive: boolean("Read recursively.") })],
    ["figma_workspace_get_variable_defs", nodeReadDescription("figma_workspace_get_variable_defs", "Read official variable definitions.")],
    ["figma_workspace_search_design_system", {
      name: "figma_workspace_search_design_system", description: "Search components, variables, and styles in one explicit Figma file.",
      inputSchema: objectSchema({ ...invocation(), query: string("Search query."), disableCodeConnect: boolean("Disable Code Connect."), includeComponents: boolean("Include components."), includeVariables: boolean("Include variables."), includeStyles: boolean("Include styles."), includeLibraryKeys: { type: "array", items: { type: "string" } }, refresh: boolean("Refresh upstream discovery.") }, ["file", "query"]), outputSchema: resultSchema({ upstream: { type: "object" } }),
    }],
    ["figma_workspace_get_libraries", {
      name: "figma_workspace_get_libraries", description: "List libraries for one explicit Figma file.", inputSchema: objectSchema({ ...invocation(), offset: integer("Pagination offset."), refresh: boolean("Refresh upstream discovery.") }, ["file"]), outputSchema: resultSchema({ upstream: { type: "object" } }),
    }],
    ["figma_workspace_call_upstream_tool", {
      name: "figma_workspace_call_upstream_tool", description: "Call an uncovered official Figma MCP capability.", inputSchema: objectSchema({ ...invocation(), toolName: string("Exact official tool name."), arguments: { type: "object" }, refresh: boolean("Refresh upstream discovery.") }, ["toolName"]), outputSchema: resultSchema({ toolName: string("Called official tool name."), upstream: { type: "object" } }),
    }],
    ["figma_workspace_lookup", {
      name: "figma_workspace_lookup", description: "Search canonical workflow docs or generated Plugin API declarations locally.", inputSchema: objectSchema({ kind: { type: "string", enum: ["docs", "api"] }, scope: { type: "string", enum: ["auto", "active", "conditional", "router", "examples", "all"] }, surface: surface(), taskFamily: string("Canonical task family."), query: string("Docs query."), symbol: string("Plugin API symbol."), maxResults: integer("Maximum results.", 1, 10), maxSnippetLines: integer("Maximum snippet lines.", 1, 8) }, ["kind"]), outputSchema: resultSchema({ results: { type: "array" } }),
    }],
    ["figma_workspace_docs", {
      name: "figma_workspace_docs", description: "List, catalog, or read canonical local workflow documentation.", inputSchema: objectSchema({ mode: { type: "string", enum: ["list", "catalog", "read"] }, id: string("project: or canonical: document id."), taskFamily: string("Task family filter."), surface: surface(), classification: string("Classification filter."), limit: integer("Catalog result limit.", 1, 100) }, ["mode"]), outputSchema: resultSchema(),
    }],
    ["figma_workspace_doctor", {
      name: "figma_workspace_doctor", description: "Diagnose bundled canonical docs, Plugin API index, and TypeScript runtime assets.", inputSchema: objectSchema({}), outputSchema: resultSchema({ runtime: { type: "object" } }),
    }],
    ["figma_workspace_upstream_tools", {
      name: "figma_workspace_upstream_tools", description: "List official upstream tools or read one exact schema.", inputSchema: objectSchema({ name: string("Exact upstream tool name."), refresh: boolean("Refresh discovery.") }), outputSchema: resultSchema({ tools: { type: "array" }, inputSchema: {} }),
    }],
  ]);
  for (const name of LOCAL_WORKSPACE_TOOL_NAMES) if (!descriptions.has(name)) throw new Error(`Missing Figma Workspace tool description: ${name}`);
  return LOCAL_WORKSPACE_TOOL_NAMES.map((name) => descriptions.get(name)!);
}

function nodeReadDescription(name: LocalWorkspaceToolName, description: string, extra: Record<string, JsonSchema> = {}, requireNode = true): Record<string, unknown> {
  return {
    name, description,
    inputSchema: objectSchema({ ...invocation(), target: nodeTarget(), nodeId: string("Raw node id alias used with file."), refresh: boolean("Refresh upstream discovery."), ...extra }, [], requireNode ? [{ required: ["target"] }, { required: ["file", "nodeId"] }] : undefined),
    outputSchema: resultSchema({ upstream: { type: "object" }, outputFiles: { type: "object" } }),
  };
}
