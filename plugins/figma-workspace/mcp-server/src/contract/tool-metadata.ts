import {
  LOCAL_WORKSPACE_TOOL_NAMES,
  isLocalWorkspaceToolName,
  type LocalWorkspaceToolName,
} from "./tool-registry.js";
import {
  FIGMA_WORKSPACE_NODE_SCOPED_TARGET_DESCRIPTION,
  FIGMA_WORKSPACE_UPSTREAM_ESCAPE_HATCH_GUIDANCE,
  getFigmaWorkspaceCoveredUpstreamToolNames,
} from "./wrapper-contracts.js";

export type ReplToolDescriptionOptions = {
  taskWorkspaceRootEnv: string;
  defaultDocsSearchMaxResults: number;
  maxDocsSearchResults: number;
  defaultDocsSearchSnippetLines: number;
  maxDocsSearchSnippetLines: number;
  maxLookupQueryLength: number;
};

const DEFAULT_INLINE_RESULT_LIMIT_BYTES = 4_000;
const MAX_INLINE_RESULT_LIMIT_BYTES = 10_000;
const NODE_SCOPED_TARGET_SHAPES = FIGMA_WORKSPACE_NODE_SCOPED_TARGET_DESCRIPTION;
const COVERED_UPSTREAM_TOOLS = getFigmaWorkspaceCoveredUpstreamToolNames().join(", ");
const FIGMA_WORKSPACE_DOCS_SCOPES = ["auto", "active", "conditional", "router", "examples", "all"];
const FIGMA_WORKSPACE_DOCS_CLASSIFICATIONS = ["active", "conditional", "router", "examples"];
const FIGMA_WORKSPACE_TASK_FAMILIES = [
  "code-connect",
  "create-file",
  "design-to-code",
  "design-generation",
  "diagram",
  "library-generation",
  "motion-implementation",
  "swiftui",
  "figjam",
  "motion",
  "slides",
  "design-editing",
];

export function createReplToolDescriptions(
  options: ReplToolDescriptionOptions,
): Record<string, unknown>[] {
  const tools: Record<string, unknown>[] = [
    {
      name: "figma_workspace_open",
      description:
        "Context helper for creating or updating a local Figma Workspace session. Recommended input: { sessionId, file, surface }. Use prepare-task + run-script-file for the primary file workflow; use open for lightweight file binding or upstream auth connection without tool discovery.",
      inputSchema: objectSchema({
        title: titleProperty(),
        sessionId: stringProperty("Stable local session id. Defaults to 'default'."),
        label: stringProperty("Human-readable session label."),
        file: stringProperty("Optional Figma file URL or raw file key stored in local session metadata. When present, workspaceDir is required to bind a file-context workspace."),
        workspaceDir: stringProperty("Required absolute local workspace directory when file is present. Prefer a Git-ignored <project>/.figma-workspace; otherwise choose an explicitly selected Figma task-artifact directory. File-context files live under <workspaceDir>/<fileKey-or-fileSlug>."),
        surface: enumProperty(["design", "figjam", "slides"], "Figma surface stored in session metadata."),
        currentPageId: stringProperty("Optional current Figma page id stored in local session metadata."),
        reset: booleanProperty("Reset local history and task state for this session before opening."),
        connect: booleanProperty("Connect to upstream Figma MCP during open without listing tools. Defaults to true.", { default: true }),
      }),
    },
    {
      name: "figma_workspace_eval",
      description:
        "Small ephemeral JavaScript Plugin API call for quick reads or tightly scoped updates only. Recommended input: { sessionId, code, surface }. By default code is parsed and executed as JavaScript; pass typescript:true only when inline TypeScript annotations should be compiled first. Use await $.capture(target, options?) to queue local PNG files returned under captures[] after successful execution. Use prepare-task + run-script-file for repairable TypeScript scripts, multi-step work, and large structured results.",
      inputSchema: objectSchema({
        title: titleProperty(),
        sessionId: stringProperty("Local workspace session id. Defaults to 'default'."),
        code: stringProperty("JavaScript Plugin API body executed inside an async function in the Figma context. Use return to send structured output. TypeScript-only syntax requires typescript:true."),
        typescript: booleanProperty("Compile inline code as TypeScript before execution. Defaults false; leave unset for JavaScript eval.", { default: false }),
        surface: enumProperty(["design", "figjam", "slides"], "Figma surface associated with this call."),
        inlineResultLimit: inlineResultLimitInputProperty("Payload-size control in bytes for inline upstream.result/upstream.text. Defaults to 4 KB and is capped at 10 KB; 0 forces configurable inline fields to outputFiles only; complete upstream results stay in outputFiles.upstreamFile."),
      }, ["code"]),
    },
    {
      name: "figma_workspace_run_script_file",
      description:
        "Primary file-based TypeScript workflow for Figma Workspace. Recommended workspace call: { sessionId, inputFile, strict, surface }. The tool only accepts .figma.ts files, strict-checks them with Figma Plugin API typings, and compiles the upstream payload internally before execution. Use await $.capture(target, options?) to queue up to 8 local PNG files returned under captures[] after successful script execution. The tool always preflights diagnostics and compiled payload size before upstream execution; preflight failures return structured diagnostics without calling upstream Figma. Debug JSON files are generated on demand for failures, diagnostics, and inline omissions. Execution uses fixed upstream use_figma/code.",
      inputSchema: objectSchema({
        title: titleProperty(),
        sessionId: stringProperty("Local workspace session id or task name. Defaults to 'default'."),
        scriptPath: stringProperty("Advanced absolute .figma.ts path escape hatch only. Prefer inputFile after prepare-task creates a file-context workspace."),
        inputFile: stringProperty("Recommended workspace .figma.ts script file name after prepare-task; preferred over scriptPath for agents."),
        strict: booleanProperty("Request strict TypeScript preflight with bundled Figma Plugin API typings. TypeScript diagnostics reject execution."),
        surface: enumProperty(["design", "figjam", "slides"], "Figma surface associated with this script."),
        targetPageId: stringProperty("Optional PAGE node id used for one setCurrentPageAsync call before the script body runs."),
        inlineResultLimit: inlineResultLimitInputProperty("Advanced payload-size control in bytes for inline upstream.result/upstream.text only. Defaults to 4 KB and is capped at 10 KB; 0 forces configurable inline fields to outputFiles only; complete upstream results stay in outputFiles.upstreamFile."),
      }, { anyOf: [requiredBranch("scriptPath"), requiredBranch("inputFile")] }),
    },
    {
      name: "figma_workspace_apply_asset_manifest",
      description:
        `Workflow add-on for applying local generated assets to Figma target nodes through official upstream upload_assets. Recommended workspace call: { sessionId, manifestPath } after .figma.ts creates target rectangles. Debug JSON files are generated on demand for failures. ${FIGMA_WORKSPACE_UPSTREAM_ESCAPE_HATCH_GUIDANCE}`,
      inputSchema: objectSchema({
        title: titleProperty(),
        sessionId: stringProperty("Local workspace session id used for history. Defaults to 'default'."),
        manifestPath: stringProperty("Recommended manifest file path. Accepts an absolute path or a file name inside the initialized file-context workspace; may be an array of assets or an object with assets."),
        assets: {
          type: "array",
          description: "Advanced inline asset entries. Prefer manifestPath. Each entry uses { path, target }; target accepts a raw node id, node URL, or { fileKey, nodeId }.",
          items: {
            type: "object",
            properties: {
              path: stringProperty("Local asset path."),
              target: nodeScopedTargetProperty("Raw node id, node URL, or exact { fileKey, nodeId } target."),
              name: stringProperty("Optional asset display name."),
              metadata: objectProperty("Optional asset metadata."),
            },
            additionalProperties: true,
          },
        },
        validateTargets: booleanProperty("Defaults true. When upstream eval is available, verify target nodes have IMAGE fills after upload. Missing or incomplete validation records make the workflow fail with outputFiles.debugFile instead of silently succeeding.", { default: true }),
      }, { anyOf: [requiredBranch("manifestPath"), requiredBranch("assets")] }),
    },
    {
      name: "figma_workspace_download_assets",
      description:
        "Workflow add-on for official Figma asset downloads. Recommended call: { sessionId, targets:[{ target, name?, defaultFormat?, defaultScale? }], outputDir? }. Use manifestPath only for batch files shaped as { targets:[...] }; the tool always calls upstream download_assets, saves exported plus raw/source files locally, and writes debug JSON only on failure.",
      inputSchema: objectSchema({
        title: titleProperty(),
        sessionId: stringProperty("Local workspace session id used for fileKey, workspace defaults, and history. Defaults to 'default'."),
        targets: {
          type: "array",
          description: "Recommended target list. Single-target calls still use targets: [{ target }]. Mutually exclusive with manifestPath.",
          items: downloadAssetTargetProperty(),
        },
        manifestPath: stringProperty("Optional batch manifest path. Accepts an absolute path or a file name inside the initialized file-context workspace. Manifest shape is exactly { targets: [...] }; assets aliases are rejected."),
        outputDir: stringProperty("Optional output directory. Relative paths require an initialized workspace. Defaults to <slug>.downloads in the workspace, or a temp download-results directory without a workspace."),
      }, { anyOf: [requiredBranch("targets"), requiredBranch("manifestPath")] }),
    },
    {
      name: "figma_workspace_capture_node",
      description:
        "Capture one Figma node for final visual QA through official upstream get_screenshot. Recommended session input for raw string targets: { sessionId, target, imageFile? } after opening or preparing a file-context session. No-session calls may pass target as a node URL or { fileKey, nodeId }. Captures are saved as PNG; extensionless or non-.png imageFile values normalize to .png. Results return the local PNG path in imageFile.",
      inputSchema: objectSchema({
        title: titleProperty(),
        sessionId: stringProperty("Local workspace session id used for file context and history. Defaults to 'default'."),
        target: nodeScopedTargetProperty(`Target node to capture. ${NODE_SCOPED_TARGET_SHAPES}`),
        imageFile: stringProperty("Optional local PNG output path. Extensionless or non-.png values normalize to .png. Omitted imageFile auto-generates capture-<timestamp>.png."),
        maxDimension: numberProperty("Optional official get_screenshot maxDimension forwarded upstream when explicitly supplied.", { type: "integer", minimum: 1, maximum: 65536 }),
        contentsOnly: booleanProperty("Optional official get_screenshot contentsOnly flag forwarded upstream when explicitly supplied."),
      }, ["target"]),
    },
    {
      name: "figma_workspace_run_task_plan",
      description:
        "Workflow add-on for running a repeatable local JSON task plan. Recommended file-plan call: { sessionId, planPath }. Steps use only { id?, type?, args? }; put tool-specific inputs inside args. The plan-level debug file is generated automatically.",
      inputSchema: objectSchema({
        title: titleProperty(),
        sessionId: stringProperty("Default local workspace session id inherited by steps when omitted."),
        planPath: stringProperty("Recommended JSON plan path. Accepts an absolute path or a file name inside the initialized file-context workspace; may be an array of steps or an object with steps."),
        steps: {
          type: "array",
          description: "Advanced inline steps. Prefer planPath for repeatable workflows. Supported type values: script-file, asset-manifest/upload_assets, download-assets/download_assets, screenshot-capture, upstream-tool. Step arguments go under args.",
          items: taskPlanStepProperty("One task-plan step. Put tool-specific inputs under args."),
        },
        stopOnFailure: booleanProperty("Stop after the first failed step. Defaults true.", { default: true }),
      }, { anyOf: [requiredBranch("planPath"), requiredBranch("steps")] }),
    },
    {
      name: "figma_workspace_prepare_task",
      description:
        "Core workflow entrypoint for creating or reusing a task-specific .figma.ts script. It does not create a pending result stub; debug JSON files are generated later on demand. Recommended input: { file, taskName, workspaceDir, surface }. Follow with guidance, lookup, run-script-file, inspect, and capture-node.",
      inputSchema: objectSchema({
        title: titleProperty(),
        sessionId: stringProperty("Local workspace session id. If initialized, files are created under that session file-context workspace."),
        taskName: stringProperty("Required slug-style task/workspace name such as settings-panel-polish; used to derive <taskName>.figma.ts by default."),
        file: stringProperty("Recommended Figma file URL or raw file key used to derive the file context when preparing a workspace."),
        fileSlug: stringProperty("Advanced file-context slug override to use when file cannot derive a key."),
        workspaceDir: stringProperty("Required absolute local workspace directory. Prefer a Git-ignored <project>/.figma-workspace; otherwise choose an explicitly selected Figma task-artifact directory. The CLI runtime uses this exact root and does not append another figma-workspace segment; file-context tasks live under <workspaceDir>/<fileKey-or-fileSlug>."),
        fileName: stringProperty("Advanced script file-name override ending in .figma.ts."),
        surface: enumProperty(["design", "figjam", "slides"], "Recommended expected Figma surface persisted on the session and copied into generated guidance."),
        targetPageId: stringProperty("Optional target page id copied into generated guidance."),
        template: stringProperty("Template hint copied into the generated .figma.ts comments. V1 templates are curated guidance only."),
        overwrite: booleanProperty("Advanced destructive overwrite of an existing script/result pair. Defaults false."),
      }, ["taskName", "workspaceDir"]),
    },
    {
      name: "figma_workspace_guidance",
      description:
        "Planning and routing helper for compact workflow guidance, curated Plugin API cards, or catalog metadata. Recommended call: { query, surface }. surface is a hard Design/FigJam/Slides route filter, never a cross-surface fallback. In plan mode workflow must name a supported workflow and filters the returned workflow graph and wrapper profiles. Use English task keywords before writing .figma.ts; use figma:docs:search or figma:api:search only when exact reference context is still needed.",
      inputSchema: objectSchema({
        title: titleProperty(),
        mode: enumProperty(["guidance", "plan", "card", "catalog"], "Guidance mode. Defaults from card/query fields."),
        card: stringProperty(`Card id or topic, for example text.font, layout.auto, components.variants, variables.bind, surface.slides. Hard limit ${options.maxLookupQueryLength} characters.`),
        query: stringProperty(`English task keywords used for deterministic route resolution, for example text font loadFontAsync or components variants properties. Hard limit ${options.maxLookupQueryLength} characters.`),
        surface: enumProperty(["design", "figjam", "slides"], "Optional hard route filter. Results may use this surface or an explicitly surface-agnostic record only."),
        workflow: stringProperty("Optional exact supported workflow id for plan mode. An unknown id is a usage error; when supplied it filters workflowGraph and wrapperProfiles."),
        maxCards: numberProperty("Maximum cards to return, capped at 8. Defaults to 4."),
      }),
    },
    {
      name: "figma_workspace_inspect",
      description:
        "Core read-side inspection command for $selection, $currentPage, raw node ids, node URLs, and compact style audits. Requires a file-context session because it executes fixed upstream use_figma; call open or prepare-task first. Recommended inputs: { sessionId, target } or { sessionId, mode:\"style\", target }.",
      inputSchema: objectSchema({
        title: titleProperty(),
        sessionId: stringProperty("Local workspace session id with file context. Defaults to 'default'."),
        mode: enumProperty(["inspect", "style"], "Use inspect for target summaries or style for compact visual-token audits. Defaults to inspect."),
        target: inspectTargetProperty("String-only target: $selection, $currentPage, a raw node id, or a node URL. Defaults to $selection. Do not pass { fileKey, nodeId }."),
        depth: numberProperty("Child summary depth. Defaults to 2."),
      }),
    },
    {
      name: "figma_workspace_get_metadata",
      description:
        "Metadata-first read tool for broad Figma layer-tree discovery. Calls official upstream get_metadata, converts returned XML into a compact JSON node tree, then attempts one batched read-only use_figma readback to enrich nodes with supported lock/layout-state fields. Small converted JSON trees are returned inline; oversized trees are written to outputFiles.metadataFile. Recommended calls: { sessionId, target? } after opening/preparing file context, { file, target? }, or { target:{ fileKey, nodeId } }. Use inspect/eval afterward for fills, text, visual tokens, or targeted operation-state validation.",
      inputSchema: objectSchema({
        title: titleProperty(),
        sessionId: stringProperty("Local workspace session id used for file context, workspace defaults, and history. Defaults to 'default'."),
        file: stringProperty("Optional Figma file URL or raw file key. A node-id in the URL is used as the target when target/nodeId is omitted."),
        workspaceDir: stringProperty("Required absolute local workspace directory when file is supplied and the session does not already have file context. Prefer a Git-ignored <project>/.figma-workspace; otherwise choose an explicitly selected Figma task-artifact directory. File-context files live under <workspaceDir>/<fileKey-or-fileSlug>."),
        target: nodeScopedTargetProperty(`Optional metadata root. ${NODE_SCOPED_TARGET_SHAPES}`),
        nodeId: stringProperty("Optional raw Figma node id. Prefer target for node URLs or explicit { fileKey, nodeId } context."),
        clientLanguages: stringProperty("Optional official get_metadata clientLanguages hint. Sent upstream only when explicitly supplied."),
        clientFrameworks: stringProperty("Optional official get_metadata clientFrameworks hint. Sent upstream only when explicitly supplied."),
        refresh: booleanProperty("Refresh cached upstream tool list before dispatch."),
        inlineResultLimit: inlineResultLimitInputProperty("Payload-size control in bytes for converted metadata.json. Defaults to 4 KB and is capped at 10 KB; 0 forces metadata.json to outputFiles.metadataFile only."),
      }),
    },
    {
      name: "figma_workspace_get_design_context",
      description:
        "Thin first-class wrapper for official upstream get_design_context. Recommended calls: { sessionId, target } after opening or preparing file context, { file, target }, or { target:{ fileKey, nodeId } }. Returns the generic upstream envelope without normalizing official design-context payloads.",
      inputSchema: objectSchema({
        title: titleProperty(),
        sessionId: stringProperty("Local workspace session id used for file context, workspace defaults, and history. Defaults to 'default'."),
        file: stringProperty("Optional Figma file URL or raw file key. A node-id in the URL is used as the target when target is omitted."),
        workspaceDir: stringProperty("Required absolute local workspace directory when file is supplied and the session does not already have file context. Prefer a Git-ignored <project>/.figma-workspace; otherwise choose an explicitly selected Figma task-artifact directory. File-context files live under <workspaceDir>/<fileKey-or-fileSlug>."),
        target: nodeScopedTargetProperty(`Required target node. ${NODE_SCOPED_TARGET_SHAPES}`),
        clientLanguages: stringProperty("Optional official get_design_context clientLanguages hint. Sent upstream only when explicitly supplied."),
        clientFrameworks: stringProperty("Optional official get_design_context clientFrameworks hint. Sent upstream only when explicitly supplied."),
        forceCode: booleanProperty("Optional official get_design_context flag forwarded upstream when explicitly supplied."),
        disableCodeConnect: booleanProperty("Optional official get_design_context flag forwarded upstream when explicitly supplied."),
        excludeScreenshot: booleanProperty("Optional official get_design_context flag forwarded upstream when explicitly supplied."),
        refresh: booleanProperty("Refresh cached upstream tool list before dispatch."),
        inlineResultLimit: inlineResultLimitInputProperty("Payload-size control in bytes for inline upstream.result/upstream.text. Defaults to 4 KB and is capped at 10 KB; 0 forces configurable inline fields to outputFiles only; complete upstream results stay in outputFiles.upstreamFile."),
      }, { anyOf: [requiredBranch("target"), requiredBranch("file")] }),
    },
    {
      name: "figma_workspace_get_motion_context",
      description:
        "Thin first-class wrapper for official upstream get_motion_context. Recommended calls: { sessionId, target, recursive? } after opening or preparing file context, { file, target, recursive? }, or { target:{ fileKey, nodeId }, recursive? }. Returns keyframe/motion data through the generic upstream envelope without bridge-owned normalization.",
      inputSchema: objectSchema({
        title: titleProperty(),
        sessionId: stringProperty("Local workspace session id used for file context, workspace defaults, and history. Defaults to 'default'."),
        file: stringProperty("Optional Figma file URL or raw file key. A node-id in the URL is used as the target when target is omitted."),
        workspaceDir: stringProperty("Required absolute local workspace directory when file is supplied and the session does not already have file context. Prefer a Git-ignored <project>/.figma-workspace; otherwise choose an explicitly selected Figma task-artifact directory. File-context files live under <workspaceDir>/<fileKey-or-fileSlug>."),
        target: nodeScopedTargetProperty(`Required target node. ${NODE_SCOPED_TARGET_SHAPES}`),
        recursive: booleanProperty("Optional official get_motion_context flag for descendant motion data."),
        clientLanguages: stringProperty("Optional official get_motion_context clientLanguages hint. Sent upstream only when explicitly supplied."),
        clientFrameworks: stringProperty("Optional official get_motion_context clientFrameworks hint. Sent upstream only when explicitly supplied."),
        refresh: booleanProperty("Refresh cached upstream tool list before dispatch."),
        inlineResultLimit: inlineResultLimitInputProperty("Payload-size control in bytes for inline upstream.result/upstream.text. Defaults to 4 KB and is capped at 10 KB; 0 forces configurable inline fields to outputFiles only; complete upstream results stay in outputFiles.upstreamFile."),
      }, { anyOf: [requiredBranch("target"), requiredBranch("file")] }),
    },
    {
      name: "figma_workspace_search_design_system",
      description:
        "Thin first-class wrapper for official upstream search_design_system. Recommended call: { sessionId, query } after opening or preparing a session with file context. Returns the generic upstream envelope in upstream.result/upstream.text plus a minimal session summary.",
      inputSchema: objectSchema({
        title: titleProperty(),
        sessionId: stringProperty("Local workspace session id used for file context and history. Defaults to 'default'."),
        file: stringProperty("Optional Figma file URL or raw file key. Used when the session does not already have file context."),
        workspaceDir: stringProperty("Required absolute local workspace directory when file is supplied and the session does not already have file context. Prefer a Git-ignored <project>/.figma-workspace; otherwise choose an explicitly selected Figma task-artifact directory. File-context files live under <workspaceDir>/<fileKey-or-fileSlug>."),
        query: stringProperty("Required official search_design_system query."),
        disableCodeConnect: booleanProperty("Optional official search_design_system flag to disable Code Connect for search results."),
        includeComponents: booleanProperty("Optional official search_design_system flag. Defaults upstream to true."),
        includeVariables: booleanProperty("Optional official search_design_system flag. Defaults upstream to true."),
        includeStyles: booleanProperty("Optional official search_design_system flag. Defaults upstream to true."),
        includeLibraryKeys: stringArrayProperty("Optional library keys returned by get_libraries or previous search results; restricts search to those libraries."),
        refresh: booleanProperty("Refresh cached upstream tool list before dispatch."),
        inlineResultLimit: inlineResultLimitInputProperty("Payload-size control in bytes for inline upstream.result/upstream.text. Defaults to 4 KB and is capped at 10 KB; 0 forces configurable inline fields to outputFiles only; complete upstream results stay in outputFiles.upstreamFile."),
      }, ["query"]),
    },
    {
      name: "figma_workspace_get_libraries",
      description:
        "Thin first-class wrapper for official upstream get_libraries. Recommended call: { sessionId } after opening or preparing a session with file context. Returns the generic upstream envelope in upstream.result/upstream.text plus a minimal session summary.",
      inputSchema: objectSchema({
        title: titleProperty(),
        sessionId: stringProperty("Local workspace session id used for file context and history. Defaults to 'default'."),
        file: stringProperty("Optional Figma file URL or raw file key. Used when the session does not already have file context."),
        workspaceDir: stringProperty("Required absolute local workspace directory when file is supplied and the session does not already have file context. Prefer a Git-ignored <project>/.figma-workspace; otherwise choose an explicitly selected Figma task-artifact directory. File-context files live under <workspaceDir>/<fileKey-or-fileSlug>."),
        offset: numberProperty("Optional official get_libraries pagination offset."),
        refresh: booleanProperty("Refresh cached upstream tool list before dispatch."),
        inlineResultLimit: inlineResultLimitInputProperty("Payload-size control in bytes for inline upstream.result/upstream.text. Defaults to 4 KB and is capped at 10 KB; 0 forces configurable inline fields to outputFiles only; complete upstream results stay in outputFiles.upstreamFile."),
      }),
    },
    {
      name: "figma_workspace_get_variable_defs",
      description:
        "Thin first-class wrapper for official upstream get_variable_defs. Recommended calls: { sessionId, target } after opening or preparing file context, { file, target }, or { target:{ fileKey, nodeId } }. Returns the generic upstream envelope in upstream.result/upstream.text plus a minimal session summary.",
      inputSchema: objectSchema({
        title: titleProperty(),
        sessionId: stringProperty("Local workspace session id used for file context, workspace defaults, and history. Defaults to 'default'."),
        file: stringProperty("Optional Figma file URL or raw file key. A node-id in the URL is used as the target when target/nodeId is omitted."),
        workspaceDir: stringProperty("Required absolute local workspace directory when file is supplied and the session does not already have file context. Prefer a Git-ignored <project>/.figma-workspace; otherwise choose an explicitly selected Figma task-artifact directory. File-context files live under <workspaceDir>/<fileKey-or-fileSlug>."),
        target: nodeScopedTargetProperty(`Required target node. ${NODE_SCOPED_TARGET_SHAPES}`),
        refresh: booleanProperty("Refresh cached upstream tool list before dispatch."),
        inlineResultLimit: inlineResultLimitInputProperty("Payload-size control in bytes for inline upstream.result/upstream.text. Defaults to 4 KB and is capped at 10 KB; 0 forces configurable inline fields to outputFiles only; complete upstream results stay in outputFiles.upstreamFile."),
      }, { anyOf: [requiredBranch("target"), requiredBranch("file")] }),
    },
    {
      name: "figma_workspace_call_upstream_tool",
      description:
        `Explicit upstream escape hatch for one official Figma MCP tool call. Pass the exact official tool name and its arguments. Prefer dedicated local workflow commands for ${COVERED_UPSTREAM_TOOLS}; use this escape hatch when raw upstream behavior or an uncovered capability is needed.`,
      inputSchema: objectSchema({
        title: titleProperty(),
        sessionId: stringProperty("Optional local session id used only for history. Defaults to 'default'."),
        toolName: stringProperty("Official upstream Figma MCP tool name to call. Bundled Figma Workspace operation names are rejected."),
        arguments: objectProperty("Arguments sent to the upstream official Figma MCP tool."),
        refresh: booleanProperty("Refresh cached upstream tool list before dispatch."),
        inlineResultLimit: inlineResultLimitInputProperty("Payload-size control in bytes for inline upstream.result/upstream.text. Defaults to 4 KB and is capped at 10 KB; 0 forces configurable inline fields to outputFiles only; complete upstream results stay in outputFiles.upstreamFile."),
      }, ["toolName", "arguments"]),
    },
    {
      name: "figma_workspace_lookup",
      description:
        "Targeted lookup helper for compact canonical documentation snippets or exact bundled Figma Plugin API declarations. For kind=docs use English query with automatic task routing by default; for kind=api use symbol, including supported qualified expressions. Use after figma:guidance when exact docs/API context is still needed.",
      inputSchema: objectSchema({
        title: titleProperty(),
        kind: enumProperty(["docs", "api"], "Lookup corpus. Use docs for workflow snippets or api for exact Plugin API symbols."),
        scope: {
          ...enumProperty(
            FIGMA_WORKSPACE_DOCS_SCOPES,
            "Docs-only lookup scope. Defaults to auto, which resolves the task family and surface without including examples. An explicit scope is strict.",
          ),
          default: "auto",
        },
        surface: enumProperty(["design", "figjam", "slides"], "Docs-only hard surface filter. It is invalid with kind=api and never falls back across surfaces."),
        taskFamily: enumProperty(FIGMA_WORKSPACE_TASK_FAMILIES, "Docs-only hard canonical task-family filter. It is invalid with kind=api and takes precedence over inferred routing."),
        query: stringProperty(`Required for kind=docs. Use English task keywords, for example 'component properties' or 'Slides lifecycle'. Hard limit ${options.maxLookupQueryLength} characters.`),
        symbol: stringProperty(`Required for kind=api. Accepts bare or supported qualified Plugin API symbols, for example createFrame, figma.createFrame(), ExportMixin.exportAsync, or figma.variables.createVariableCollection. Hard limit ${options.maxLookupQueryLength} characters.`),
        maxResults: numberProperty(`Result-size control only. Maximum results, capped at ${options.maxDocsSearchResults}. Defaults to docs=${options.defaultDocsSearchMaxResults}, api=5.`),
        maxSnippetLines: numberProperty(`Result-size control only. Lines per snippet, capped at ${options.maxDocsSearchSnippetLines}. Defaults to docs=${options.defaultDocsSearchSnippetLines}, api=5.`),
      }, ["kind"]),
    },
    {
      name: "figma_workspace_docs",
      description:
        "Raw documentation contract behind figma:docs:list, figma:docs:catalog, and figma:docs:read. mode=list returns project-document summaries with project:<topic> ids. mode=catalog returns task-family summaries when unfiltered, or canonical record metadata when taskFamily is supplied; catalog accepts optional surface, classification, and limit filters. mode=read requires an exact namespaced id: project:<topic> or canonical:<record-id>.",
      inputSchema: objectSchema({
        mode: enumProperty(["list", "catalog", "read"], "Required documentation operation mode."),
        id: stringProperty("Required only for mode=read. Exact stable namespaced id returned by list/catalog: project:<topic> or canonical:<record-id>. Paths, chunk source ids, and legacy source ids are rejected."),
        taskFamily: enumProperty(FIGMA_WORKSPACE_TASK_FAMILIES, "Optional mode=catalog canonical task-family filter. Omit it to return task-family summaries."),
        surface: enumProperty(["design", "figjam", "slides"], "Optional mode=catalog hard surface filter."),
        classification: enumProperty(FIGMA_WORKSPACE_DOCS_CLASSIFICATIONS, "Optional mode=catalog canonical classification filter."),
        limit: numberProperty("Optional mode=catalog result limit from 1 through 100.", { type: "integer", minimum: 1, maximum: 100 }),
      }, ["mode"]),
    },
    {
      name: "figma_workspace_doctor",
      description:
        "Inspect local project docs, canonical docs corpus, generated Plugin API index, and TypeScript runtime availability. This command is read-only and does not create a session.",
      inputSchema: objectSchema({}),
    },
    {
      name: "figma_workspace_sessions",
      description:
        "Inspect persisted Figma Workspace sessions without mutating them. Omit sessionId for compact summaries; pass it for detail with optional history expansion.",
      inputSchema: objectSchema({
        sessionId: stringProperty("Optional exact session id. Omit to list compact summaries."),
        includeHistory: booleanProperty("Include full history entries for one selected session. Defaults to false.", { default: false }),
      }),
    },
    {
      name: "figma_workspace_upstream_tools",
      description:
        "Inspect the live official Figma MCP tool catalog. Omit name for the compact directory; pass one exact name for its full description and inputSchema.",
      inputSchema: objectSchema({
        name: stringProperty("Optional exact official upstream tool name. Omit to list the live directory."),
        refresh: booleanProperty("Refresh the cached upstream tool catalog before reading it. Defaults to false.", { default: false }),
      }),
    },
  ];
  return assertLocalWorkspaceToolDescriptions(tools);
}

const LOCAL_WORKSPACE_TOOL_OUTPUT_SCHEMAS = {
  figma_workspace_open: toolOutputSchema({
    session: objectProperty("Minimal local workspace session summary: id, fileKey, surface, and optional sessionDir."),
    diagnostics: arrayProperty("Session diagnostics when warnings or failures are present."),
  }),
  figma_workspace_eval: toolOutputSchema({
    session: objectProperty("Minimal local workspace session summary: id, fileKey, surface, and optional sessionDir."),
    scriptExecutionSucceeded: booleanProperty("True when the Plugin API script finished successfully before queued capture post-processing."),
    captureProcessingSucceeded: booleanProperty("Present when $.capture queued work. False means the script succeeded but at least one local PNG capture failed."),
    retryGuidance: stringProperty("Explicit recovery guidance when capture post-processing failed after successful script execution."),
    diagnostics: arrayProperty("Preflight diagnostics when warnings or failures are present."),
    repairPlan: jsonProperty("Agent-facing repair plan with status, summary, and deduplicated steps containing occurrences with line:column labels."),
    upstream: upstreamEnvelopeProperty("Upstream output envelope with JSON result or text fallback. upstream.ok reports effective upstream success and consumed top-level ok fields are removed from upstream.result. Bridge-internal __figmaWorkspace metadata is removed from public eval results."),
    upstreamError: objectProperty("Normalized upstream failure details when execution failed."),
    captures: arrayProperty("Compact queued capture results in request order. Successful entries include requestId, nodeId, and local imageFile; failed entries include upstreamError. Image bytes are never returned."),
    outputFiles: outputFilesProperty(
      "Debug files written on demand for failure or inline omissions, including minimal result envelope and upstream sidecar.",
      ["debugFile", "upstreamFile"],
    ),
    inlineResultLimit: inlineResultLimitProperty("Inline payload omission metadata when upstream.result or upstream.text exceeds the byte limit."),
  }),
  figma_workspace_run_script_file: toolOutputSchema({
    phase: enumProperty(["preflight", "execute"], "Execution phase represented by this result. preflight means diagnostics blocked upstream execution; execute means upstream Figma was called."),
    executed: booleanProperty("Whether upstream Figma execution was attempted."),
    session: objectProperty("Minimal local workspace session summary: id, fileKey, surface, and optional sessionDir."),
    scriptExecutionSucceeded: booleanProperty("True when the Plugin API script finished successfully before queued capture post-processing."),
    captureProcessingSucceeded: booleanProperty("Present when $.capture queued work. False means the script succeeded but at least one local PNG capture failed."),
    retryGuidance: stringProperty("Explicit recovery guidance when capture post-processing failed after successful script execution."),
    diagnostics: arrayProperty("Script and wrapper diagnostics when warnings or failures are present."),
    repairPlan: jsonProperty("Agent-facing repair plan returned only when diagnostics or preflight blockers are actionable."),
    script: scriptMetadataProperty("Compact script metadata. Clean inputFile success returns only inputFile; preflight/failure keeps repair details."),
    outputFiles: outputFilesProperty(
      "Debug files written on demand for failures, diagnostics, inline omissions, or failure-only compiled script.",
      ["debugFile", "upstreamFile", "compiledScriptFile"],
    ),
    upstreamError: objectProperty("Normalized upstream failure details when execution failed."),
    captures: arrayProperty("Compact queued capture results in request order. Successful entries include requestId, nodeId, and local imageFile; failed entries include upstreamError. Image bytes are never returned."),
    upstream: upstreamEnvelopeProperty("File-script upstream output envelope with JSON result or text fallback. upstream.ok reports effective upstream success and consumed top-level ok fields are removed from upstream.result. Bridge-internal __figmaWorkspace metadata is removed from public script results."),
    inlineResultLimit: inlineResultLimitProperty("Inline payload omission metadata when upstream.result or upstream.text exceeds the byte limit."),
  }),
  figma_workspace_apply_asset_manifest: toolOutputSchema({
    session: objectProperty("Minimal local workspace session summary: id, fileKey, surface, and optional sessionDir."),
    assets: compactAssetResultsProperty("Compact per-asset upload/fill results. Successful submitUrl POSTs expose compact upload evidence without raw submit URLs."),
    diagnostics: arrayProperty("Manifest loading, upload, application, or validation diagnostics when present."),
    validation: objectProperty("Optional target validation result."),
    outputFiles: outputFilesProperty("Debug files written on demand for failures.", ["debugFile"]),
    failures: arrayProperty("Per-asset or validation failures."),
  }),
  figma_workspace_download_assets: toolOutputSchema({
    session: objectProperty("Minimal local workspace session summary: id, fileKey, surface, and optional sessionDir."),
    outputDir: stringProperty("Local directory containing per-target download folders."),
    targets: compactDownloadAssetResultsProperty("Compact per-target download results."),
    diagnostics: arrayProperty("Nonfatal optional upstream passthrough warnings when present."),
    failures: arrayProperty("Per-target download or upstream failures."),
    outputFiles: outputFilesProperty("Debug files written on demand for failures.", ["debugFile"]),
  }),
  figma_workspace_capture_node: toolOutputSchema({
    session: objectProperty("Minimal local workspace session summary: id, fileKey, surface, and optional sessionDir."),
    imageFile: stringProperty("Absolute local PNG screenshot path when capture succeeded."),
    nodeId: stringProperty("Captured Figma node id."),
    bytes: numberProperty("Saved PNG file size in bytes."),
    width: numberProperty("Saved PNG width in pixels."),
    height: numberProperty("Saved PNG height in pixels."),
    diagnostics: arrayProperty("Nonfatal optional upstream passthrough warnings when present."),
    upstreamError: objectProperty("Normalized upstream failure details when capture failed."),
  }),
  figma_workspace_run_task_plan: toolOutputSchema({
    session: objectProperty("Minimal local workspace session summary: id, fileKey, surface, and optional sessionDir."),
    stopped: booleanProperty("Whether execution stopped before remaining steps."),
    steps: arrayProperty("Compact per-step execution summaries with per-step outputReferences when a step produced files for later references."),
    outputFiles: outputFilesProperty("Files written for plan result output.", ["debugFile"]),
    failures: compactTaskPlanFailuresProperty("Compact failed task-plan step summaries."),
  }),
  figma_workspace_prepare_task: toolOutputSchema({
    task: objectProperty("Prepared task workspace and script file."),
    session: objectProperty("Minimal local workspace session summary: id, fileKey, surface, and optional sessionDir; task.workspace remains the full prepared workspace shape."),
    taskChange: taskChangeProperty("Previous/current task file pointers and whether the session active task changed."),
    next: stringArrayProperty("Suggested next actions."),
  }),
  figma_workspace_guidance: toolOutputSchema({
    route: objectProperty("Resolved task route: status (matched, ambiguous, fallback, or none), confidence, requested/effective surface, candidate task families, effective scopes, normalized English query, and reason."),
    cards: arrayProperty("At most the requested compact curated API cards, filtered to the resolved surface and route."),
    catalogSize: numberProperty("Total curated API card count when mode=catalog returns cards."),
    queryHints: stringArrayProperty("At most eight compact English docs/API lookup hints."),
    apiReferences: arrayProperty("At most eight Plugin API references. Each reference has displayExpression, lookupQuery, ownerHint when known, and symbolKind. lookupQuery is directly consumable by figma:api:search."),
    guardrails: stringArrayProperty("At most six task-specific guardrails."),
    helperProfiles: arrayProperty("At most three compact $ helper profiles relevant to the resolved route."),
    wrapperProfiles: arrayProperty("At most three compact first-class wrapper profiles filtered by the requested workflow."),
    workflowGraph: arrayProperty("Compact workflow graph summaries filtered by the requested workflow and resolved route."),
    referenceContext: arrayProperty("At most two compact routed reference snippets. Entries expose a stable namespaced document id, title, classification, taskFamily, surfaces, line range, match type, confidence, and capped snippet; never full corpus text."),
    nextActions: arrayProperty("At most six typed next actions. Each action has a public npm commandId such as figma:docs:search or figma:api:search, validated args, reason, and priority. Internal transport tool names and raw MCP names are never emitted."),
  }),
  figma_workspace_inspect: toolOutputSchema({
    session: objectProperty("Read-only local workspace session summary: id, fileKey, surface, and optional sessionDir."),
    diagnostics: arrayProperty("Inspection diagnostics when warnings or failures are present."),
    target: stringProperty("Inspected target selector or node id when returned by the inspect mode."),
    summary: jsonProperty("Compact inspected node or selection summary when returned by the inspect mode."),
    targetSummary: objectProperty("Compact target identity and bounds for mode=style."),
    mode: stringProperty("Inspect mode marker. Default inspect returns mode=inspect."),
    nodeCount: numberProperty("Inspected node count for style audits."),
    scannedNodeCount: numberProperty("Number of nodes scanned for style audits."),
    offset: numberProperty("Style audit batch offset when returned by upstream."),
    style: inspectStyleAuditProperty("Compact visual-token/style audit for mode=style."),
    truncated: objectProperty("Style audit omitted counts keyed by clipped category, returned only when inline style samples were clipped."),
    upstreamError: objectProperty("Normalized upstream failure details when inspection failed."),
  }),
  figma_workspace_get_metadata: toolOutputSchema({
    session: objectProperty("Minimal local workspace session summary: id, fileKey, surface, and optional sessionDir."),
    fileKey: stringProperty("Figma file key sent to official get_metadata."),
    nodeId: stringProperty("Optional Figma node id sent to official get_metadata."),
    metadata: objectProperty("Metadata conversion summary. metadata.json contains the compact converted node tree with supported lock/layout-state fields merged when it fits inline; oversized JSON is available from outputFiles.metadataFile."),
    diagnostics: arrayProperty("Nonfatal metadata enrichment and optional upstream passthrough warnings when present."),
    upstream: upstreamEnvelopeProperty("Compact upstream status envelope. Raw XML text is not returned inline by this wrapper."),
    upstreamError: objectProperty("Normalized upstream or XML parse failure details when metadata conversion failed."),
    primaryFix: stringProperty("Suggested primary repair when upstream execution failed."),
    outputFiles: outputFilesProperty(
      "Files written for metadata conversion when the converted JSON tree exceeds inlineResultLimit.",
      ["metadataFile"],
    ),
    inlineResultLimit: inlineResultLimitProperty("Inline payload omission metadata when metadata.json exceeds the byte limit."),
  }),
  figma_workspace_get_design_context: toolOutputSchema({
    session: objectProperty("Minimal local workspace session summary: id, fileKey, surface, and optional sessionDir."),
    fileKey: stringProperty("Figma file key sent to official get_design_context."),
    nodeId: stringProperty("Figma node id sent to official get_design_context."),
    diagnostics: arrayProperty("Nonfatal optional upstream passthrough warnings when present."),
    upstream: upstreamEnvelopeProperty("Upstream output envelope with JSON result or text fallback. upstream.ok reports effective upstream success. Raw official JSON top-level ok is consumed and removed from upstream.result; raw JSON without top-level ok remains as upstream.result."),
    guidanceRef: wrapperGuidanceRefProperty("Compact pointer to the guidance command for detailed wrapper follow-up guidance."),
    upstreamError: objectProperty("Normalized upstream failure details when execution failed."),
    primaryFix: stringProperty("Suggested primary repair when execution failed."),
    outputFiles: outputFilesProperty(
      "Debug files written on demand for failure or inline omissions, including minimal result envelope and upstream sidecar.",
      ["debugFile", "upstreamFile"],
    ),
    inlineResultLimit: inlineResultLimitProperty("Inline payload omission metadata when upstream.result or upstream.text exceeds the byte limit."),
  }),
  figma_workspace_get_motion_context: toolOutputSchema({
    session: objectProperty("Minimal local workspace session summary: id, fileKey, surface, and optional sessionDir."),
    fileKey: stringProperty("Figma file key sent to official get_motion_context."),
    nodeId: stringProperty("Figma node id sent to official get_motion_context."),
    diagnostics: arrayProperty("Nonfatal optional upstream passthrough warnings when present."),
    upstream: upstreamEnvelopeProperty("Upstream output envelope with JSON result or text fallback. upstream.ok reports effective upstream success. Raw official JSON top-level ok is consumed and removed from upstream.result; raw JSON without top-level ok remains as upstream.result."),
    guidanceRef: wrapperGuidanceRefProperty("Compact pointer to the guidance command for detailed wrapper follow-up guidance."),
    upstreamError: objectProperty("Normalized upstream failure details when execution failed."),
    primaryFix: stringProperty("Suggested primary repair when execution failed."),
    outputFiles: outputFilesProperty(
      "Debug files written on demand for failure or inline omissions, including minimal result envelope and upstream sidecar.",
      ["debugFile", "upstreamFile"],
    ),
    inlineResultLimit: inlineResultLimitProperty("Inline payload omission metadata when upstream.result or upstream.text exceeds the byte limit."),
  }),
  figma_workspace_search_design_system: toolOutputSchema({
    session: objectProperty("Minimal local workspace session summary: id, fileKey, surface, and optional sessionDir."),
    fileKey: stringProperty("Figma file key sent to official search_design_system."),
    query: stringProperty("Search query sent upstream."),
    diagnostics: arrayProperty("Nonfatal optional upstream passthrough warnings when present."),
    upstream: upstreamEnvelopeProperty("Upstream output envelope with JSON result or text fallback. upstream.ok reports effective upstream success. Raw official JSON top-level ok is consumed and removed from upstream.result; raw JSON without top-level ok remains as upstream.result."),
    upstreamError: objectProperty("Normalized upstream failure details when execution failed."),
    primaryFix: stringProperty("Suggested primary repair when execution failed."),
    outputFiles: outputFilesProperty(
      "Debug files written on demand for failure or inline omissions, including minimal result envelope and upstream sidecar.",
      ["debugFile", "upstreamFile"],
    ),
    inlineResultLimit: inlineResultLimitProperty("Inline payload omission metadata when upstream.result or upstream.text exceeds the byte limit."),
  }),
  figma_workspace_get_libraries: toolOutputSchema({
    session: objectProperty("Minimal local workspace session summary: id, fileKey, surface, and optional sessionDir."),
    fileKey: stringProperty("Figma file key sent to official get_libraries."),
    offset: numberProperty("Pagination offset sent upstream when supplied."),
    diagnostics: arrayProperty("Nonfatal optional upstream passthrough warnings when present."),
    upstream: upstreamEnvelopeProperty("Upstream output envelope with JSON result or text fallback. upstream.ok reports effective upstream success. Raw official JSON top-level ok is consumed and removed from upstream.result; raw JSON without top-level ok remains as upstream.result."),
    upstreamError: objectProperty("Normalized upstream failure details when execution failed."),
    primaryFix: stringProperty("Suggested primary repair when execution failed."),
    outputFiles: outputFilesProperty(
      "Debug files written on demand for failure or inline omissions, including minimal result envelope and upstream sidecar.",
      ["debugFile", "upstreamFile"],
    ),
    inlineResultLimit: inlineResultLimitProperty("Inline payload omission metadata when upstream.result or upstream.text exceeds the byte limit."),
  }),
  figma_workspace_get_variable_defs: toolOutputSchema({
    session: objectProperty("Minimal local workspace session summary: id, fileKey, surface, and optional sessionDir."),
    fileKey: stringProperty("Figma file key sent to official get_variable_defs."),
    nodeId: stringProperty("Figma node id sent to official get_variable_defs."),
    upstream: upstreamEnvelopeProperty("Upstream output envelope with JSON result or text fallback. upstream.ok reports effective upstream success. Raw official JSON top-level ok is consumed and removed from upstream.result; raw JSON without top-level ok remains as upstream.result."),
    upstreamError: objectProperty("Normalized upstream failure details when execution failed."),
    primaryFix: stringProperty("Suggested primary repair when execution failed."),
    outputFiles: outputFilesProperty(
      "Debug files written on demand for failure or inline omissions, including minimal result envelope and upstream sidecar.",
      ["debugFile", "upstreamFile"],
    ),
    inlineResultLimit: inlineResultLimitProperty("Inline payload omission metadata when upstream.result or upstream.text exceeds the byte limit."),
  }),
  figma_workspace_call_upstream_tool: toolOutputSchema({
    session: objectProperty("Minimal local workspace session summary: id, fileKey, surface, and optional sessionDir."),
    toolName: stringProperty("Upstream official Figma MCP tool name called."),
    upstream: upstreamEnvelopeProperty("Upstream output envelope with JSON result or text fallback. upstream.ok reports effective upstream success. Raw official JSON top-level ok is consumed and removed from upstream.result; raw JSON without top-level ok remains as upstream.result."),
    upstreamError: objectProperty("Normalized upstream failure details when execution failed."),
    primaryFix: stringProperty("Suggested primary repair when execution failed."),
    outputFiles: outputFilesProperty(
      "Debug files written on demand for failure or inline omissions, including minimal result envelope and upstream sidecar.",
      ["debugFile", "upstreamFile"],
    ),
    inlineResultLimit: inlineResultLimitProperty("Inline payload omission metadata when upstream.result or upstream.text exceeds the byte limit."),
  }),
  figma_workspace_lookup: toolOutputSchema({
    scope: enumProperty(FIGMA_WORKSPACE_DOCS_SCOPES, "Effective docs scope when kind=docs."),
    route: objectProperty("Automatic docs route result when kind=docs: status, confidence, requested/effective surface, candidate task families, effective scopes, normalized English query, and reason."),
    results: arrayProperty("Ranked compact results only. Documentation entries expose a stable public id (canonical:<record-id> or project:<topic>), title, classification, taskFamily, surfaces, line range, match type, confidence, and capped snippet. Plugin API entries expose their public symbol id, title, declaration kind, owner metadata, match type, confidence, and capped snippet. No result includes corpus text, hashes, absolute paths, or internal JSONL metadata."),
    diagnostics: arrayProperty("Lookup corpus diagnostics when local reference assets are unavailable."),
    nextActions: arrayProperty("Typed public follow-up actions with commandId, args, reason, and priority. commandId is an installed figma:* npm script id."),
    runtime: objectProperty("Runtime lookup corpus metadata when lookup assets are unavailable."),
  }),
  figma_workspace_docs: toolOutputSchema({
    mode: enumProperty(["list", "catalog", "read"], "Completed documentation operation mode."),
    topics: arrayProperty("Project-document summaries returned by mode=list. Each entry has a stable project:<topic> id, title, and description."),
    taskFamilies: arrayProperty("Task-family summaries returned by unfiltered mode=catalog."),
    records: arrayProperty("Canonical document metadata returned by filtered mode=catalog. Every record exposes canonical:<record-id>, title, summary, classification, taskFamily, and surfaces."),
    id: stringProperty("Selected stable namespaced id returned by mode=read: project:<topic> or canonical:<record-id>."),
    title: stringProperty("Selected canonical or project document title returned by mode=read."),
    summary: stringProperty("Selected canonical or project document summary returned by mode=read."),
    classification: enumProperty(FIGMA_WORKSPACE_DOCS_CLASSIFICATIONS, "Selected canonical document classification returned by mode=read."),
    taskFamily: enumProperty(FIGMA_WORKSPACE_TASK_FAMILIES, "Selected canonical task family returned by mode=read."),
    surfaces: stringArrayProperty("Selected canonical document supported surfaces returned by mode=read."),
    nonExecutable: booleanProperty("Whether the selected canonical document is a non-executable example template."),
    content: stringProperty("Complete selected Markdown document content returned by mode=read. Oversized typed CLI output uses its normal result sidecar without truncating the document."),
  }),
  figma_workspace_doctor: toolOutputSchema({
    runtime: objectProperty("Dynamic canonical docs corpus, Plugin API index, and TypeScript runtime status."),
    guidance: stringArrayProperty("Repair or reload guidance based on the runtime status."),
  }),
  figma_workspace_sessions: toolOutputSchema({
    sessions: arrayProperty("Compact summaries for all persisted sessions."),
    session: objectProperty("Selected persisted session detail with optional history."),
  }),
  figma_workspace_upstream_tools: toolOutputSchema({
    tools: arrayProperty("Compact live official Figma MCP tool directory."),
    name: stringProperty("Selected official upstream tool name."),
    description: stringProperty("Selected official upstream tool description."),
    inputSchema: jsonProperty("Selected official upstream tool inputSchema."),
    categories: stringArrayProperty("Stable directory category ordering."),
    upstreamError: objectProperty("Normalized upstream discovery failure."),
    primaryFix: stringProperty("Suggested primary repair when upstream discovery failed."),
    guidance: stringProperty("How to choose first-class wrappers or the upstream escape hatch."),
  }),
} satisfies Record<LocalWorkspaceToolName, Record<string, unknown>>;

function assertLocalWorkspaceToolDescriptions(tools: Record<string, unknown>[]): Record<string, unknown>[] {
  const descriptionNames = new Set<string>();
  const describedTools: Record<string, unknown>[] = [];
  for (const tool of tools) {
    if (typeof tool.name !== "string") {
      throw new Error("Figma Workspace operation description is missing a string name.");
    }
    descriptionNames.add(tool.name);
    if (!isLocalWorkspaceToolName(tool.name)) {
      throw new Error(`Figma Workspace operation description is not in the registry: ${tool.name}`);
    }
    describedTools.push({
      ...tool,
      outputSchema: LOCAL_WORKSPACE_TOOL_OUTPUT_SCHEMAS[tool.name],
    });
  }
  for (const name of LOCAL_WORKSPACE_TOOL_NAMES) {
    if (!descriptionNames.has(name)) {
      throw new Error(`Figma Workspace registry operation is missing a description: ${name}`);
    }
  }
  return describedTools;
}

type ObjectSchemaOptions = {
  required?: readonly string[];
  anyOf?: readonly Record<string, unknown>[];
};

function objectSchema(
  properties: Record<string, unknown>,
  optionsOrRequired: readonly string[] | ObjectSchemaOptions = [],
): Record<string, unknown> {
  const options: ObjectSchemaOptions = Array.isArray(optionsOrRequired)
    ? { required: optionsOrRequired as readonly string[] }
    : optionsOrRequired as ObjectSchemaOptions;
  return {
    type: "object",
    properties,
    required: [...(options.required ?? [])],
    ...(options.anyOf ? { anyOf: [...options.anyOf] } : {}),
    additionalProperties: false,
  };
}

function requiredBranch(...fields: string[]): Record<string, unknown> {
  return { required: fields };
}

function titleProperty(): Record<string, unknown> {
  return stringProperty("Optional display label only; validated as a string but not saved, defaulted, or used for task/file naming.");
}

function stringProperty(description: string): Record<string, unknown> {
  return { type: "string", description };
}

function nodeScopedTargetProperty(description: string): Record<string, unknown> {
  return {
    description,
    oneOf: [
      {
        type: "string",
        minLength: 1,
        pattern: "^(?!\\$)(?=.*\\S)",
      },
      {
        type: "object",
        properties: {
          fileKey: { ...stringProperty("Figma file key."), minLength: 1, pattern: ".*\\S.*" },
          nodeId: { ...stringProperty("Figma node id."), minLength: 1, pattern: ".*\\S.*" },
        },
        required: ["fileKey", "nodeId"],
        additionalProperties: false,
      },
    ],
  };
}

function inspectTargetProperty(description: string): Record<string, unknown> {
  return {
    type: "string",
    description,
    minLength: 1,
    anyOf: [
      { enum: ["$selection", "$currentPage"] },
      { pattern: "^(?!\\$)(?=.*\\S)" },
    ],
  };
}

function booleanProperty(description: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { type: "boolean", description, ...extra };
}

function numberProperty(description: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { type: "number", description, ...extra };
}

function objectProperty(description: string): Record<string, unknown> {
  return { type: "object", description, additionalProperties: true };
}

function jsonProperty(description: string): Record<string, unknown> {
  return { description };
}

function arrayProperty(description: string): Record<string, unknown> {
  return { type: "array", description, items: { type: "object", additionalProperties: true } };
}

function stringArrayProperty(description: string): Record<string, unknown> {
  return { type: "array", description, items: { type: "string" } };
}

function enumProperty(values: string[], description: string): Record<string, unknown> {
  return { type: "string", enum: values, description };
}

function inlineResultLimitInputProperty(description: string): Record<string, unknown> {
  return numberProperty(description, {
    default: DEFAULT_INLINE_RESULT_LIMIT_BYTES,
    minimum: 0,
    maximum: MAX_INLINE_RESULT_LIMIT_BYTES,
  });
}

function taskPlanStepProperty(description: string): Record<string, unknown> {
  return {
    type: "object",
    description,
    properties: {
      id: stringProperty("Optional stable step id used by output references and templates."),
      type: stringProperty("Task-plan step type, for example script-file, asset-manifest, download-assets, screenshot-capture, or upstream-tool."),
      args: objectProperty("Tool-specific step arguments. Put all step tool inputs here."),
    },
    additionalProperties: false,
  };
}

function downloadAssetTargetProperty(): Record<string, unknown> {
  return {
    type: "object",
    description: "One Figma target for official download_assets. Use target for a raw node id, node URL, or { fileKey, nodeId }.",
    properties: {
      target: nodeScopedTargetProperty("Required raw node id, node URL, or exact { fileKey, nodeId } target."),
      name: stringProperty("Optional display name used for the local target folder slug and result readability."),
      defaultFormat: enumProperty(["png", "jpg", "svg", "pdf"], "Optional official download_assets defaultFormat forwarded upstream."),
      defaultScale: numberProperty("Optional official download_assets defaultScale forwarded upstream. Must be from 0.01 to 4.", { minimum: 0.01, maximum: 4 }),
    },
    required: ["target"],
    additionalProperties: false,
  };
}

function filePointerProperty(description = "Local file pointer."): Record<string, unknown> {
  return {
    type: "object",
    description,
    properties: {
      path: stringProperty("Absolute local file path."),
      bytes: numberProperty("File size in bytes."),
      lineCount: numberProperty("Line count for text-like files; image and binary files use 0."),
    },
    required: ["path", "bytes", "lineCount"],
    additionalProperties: true,
  };
}

function outputFilesProperty(
  description: string,
  keys: readonly string[],
): Record<string, unknown> {
  return {
    type: "object",
    description,
    properties: Object.fromEntries(
      keys.map((key) => [key, filePointerProperty(outputFilePointerDescription(key))]),
    ),
    additionalProperties: true,
  };
}

function outputFilePointerDescription(key: string): string {
  switch (key) {
    case "debugFile":
      return "Primary local debug/result JSON file pointer.";
    case "upstreamFile":
      return "Upstream envelope sidecar file pointer.";
    case "metadataFile":
      return "Metadata JSON file pointer.";
    case "compiledScriptFile":
      return "Failure-only compiled script wrapper file pointer.";
    default:
      return "Local output file pointer.";
  }
}

function upstreamEnvelopeProperty(description: string): Record<string, unknown> {
  return {
    type: "object",
    description,
    properties: {
      kind: enumProperty(["json", "text", "unknown"], "Upstream output representation kind."),
      ok: booleanProperty("Effective upstream success: false for upstream call failures and false when a consumed shaped business result has top-level ok:false."),
      result: jsonProperty("Public parsed upstream JSON result when kind is json and the field is not omitted inline. Payloads containing bridge-internal __figmaWorkspace metadata are unwrapped to their business result; raw official JSON with top-level ok consumes and removes that ok, while raw JSON without top-level ok remains unchanged. When ok=false, result.source preserves failure provenance as call or business."),
      text: stringProperty("Upstream text output when kind is text and the field is not omitted inline."),
      upstreamError: objectProperty("Normalized upstream error when available."),
    },
    additionalProperties: true,
  };
}

function inlineResultLimitProperty(description: string): Record<string, unknown> {
  return {
    type: "object",
    description,
    properties: {
      limitBytes: numberProperty("Effective inline byte limit."),
      omitted: {
        type: "array",
        description: "Inline fields omitted because they exceeded the effective byte limit.",
        items: {
          type: "object",
          properties: {
            field: stringProperty("Omitted result field path, for example upstream.result."),
            bytes: numberProperty("Omitted field size in bytes."),
          },
          additionalProperties: true,
        },
      },
    },
    additionalProperties: true,
  };
}

function helperUsageProperty(description: string): Record<string, unknown> {
  return {
    type: "object",
    description,
    properties: {
      direct: stringArrayProperty("Helpers or $ properties directly referenced by the script."),
      transitive: stringArrayProperty("Additional helpers injected because referenced helpers depend on them."),
      runtimeBase: stringArrayProperty("Base $ runtime properties injected by the runner."),
      injected: stringArrayProperty("Final injected helper/property list."),
    },
    additionalProperties: true,
  };
}

function scriptMetadataProperty(description: string): Record<string, unknown> {
  return {
    type: "object",
    description,
    properties: {
      scriptPath: stringProperty("Absolute script path used by the runner."),
      inputFile: stringProperty("Workspace-relative input file name used by the runner."),
      expectedSurface: enumProperty(["design", "figjam", "slides"], "Expected Figma surface used for diagnostics and execution."),
      compiledScriptBytes: numberProperty("Compiled wrapper size in bytes."),
    },
    additionalProperties: true,
  };
}

function compactAssetResultsProperty(description: string): Record<string, unknown> {
  return {
    type: "array",
    description,
    items: {
      type: "object",
      properties: {
        ok: booleanProperty("Whether this asset operation succeeded."),
        path: stringProperty("Local asset path."),
        targetNodeId: stringProperty("Resolved target Figma node id."),
        name: stringProperty("Asset display name when available."),
        validation: objectProperty("Compact target validation result."),
        upstreamError: objectProperty("Compact per-asset upstream error."),
      },
      additionalProperties: true,
    },
  };
}

function compactDownloadAssetResultsProperty(description: string): Record<string, unknown> {
  return {
    type: "array",
    description,
    items: {
      type: "object",
      properties: {
        ok: booleanProperty("Whether this target download succeeded."),
        targetNodeId: stringProperty("Resolved Figma target node id."),
        name: stringProperty("Target display name when available."),
        outputDir: stringProperty("Per-target local output directory."),
        downloadedFiles: {
          type: "array",
          description: "Compact downloaded file pointers and per-file failures.",
          items: {
            type: "object",
            properties: {
              ok: booleanProperty("Whether this file download succeeded."),
              kind: enumProperty(["exported", "raw"], "Downloaded file kind."),
              path: stringProperty("Absolute local file path when saved."),
              bytes: numberProperty("File size in bytes when saved."),
              lineCount: numberProperty("Line count; downloaded binaries use 0."),
              sourceUrl: stringProperty("Original upstream asset URL downloaded into this file."),
              mimeType: stringProperty("Detected response MIME type when available."),
              format: stringProperty("File extension/format used for the saved file."),
              error: objectProperty("Per-file download error when saving failed."),
            },
            additionalProperties: true,
          },
        },
        upstreamError: objectProperty("Compact per-target upstream error."),
        downloadError: objectProperty("Compact per-target local download error."),
      },
      additionalProperties: true,
    },
  };
}

function compactTaskPlanFailuresProperty(description: string): Record<string, unknown> {
  return {
    type: "array",
    description,
    items: {
      type: "object",
      properties: {
        id: stringProperty("Task-plan step id."),
        index: numberProperty("Task-plan step index."),
        type: stringProperty("Normalized task-plan step type."),
        status: stringProperty("Failed step status."),
        error: objectProperty("Compact step error when available."),
      },
      additionalProperties: true,
    },
  };
}

function wrapperGuidanceRefProperty(description: string): Record<string, unknown> {
  return {
    type: "object",
    description,
    properties: {
      source: enumProperty(["guidance"], "CLI command that owns the full wrapper guidance profile."),
      query: stringProperty("Deterministic compact query to pass to the guidance CLI command for the full wrapper profile."),
      workflowIds: stringArrayProperty("Related wrapper workflow graph ids."),
    },
    additionalProperties: true,
  };
}

function inspectStyleAuditProperty(description: string): Record<string, unknown> {
  return {
    type: "object",
    description,
    properties: {
      topColors: arrayProperty("Top color samples."),
      textStyles: arrayProperty("Compact text style samples."),
      imageNodes: arrayProperty("Compact image node samples."),
      strokes: arrayProperty("Compact stroke samples."),
      effects: arrayProperty("Compact effect samples."),
    },
    additionalProperties: true,
  };
}

function taskChangeProperty(description: string): Record<string, unknown> {
  return {
    type: "object",
    description,
    properties: {
      previous: objectProperty("Previous active task/session file pointers before prepare-task."),
      current: objectProperty("Current active task/session file pointers after prepare-task."),
      changed: booleanProperty("Whether the session active task changed."),
    },
    additionalProperties: true,
  };
}

function toolOutputSchema(properties: Record<string, unknown>): Record<string, unknown> {
  return {
    type: "object",
    properties: {
      ok: booleanProperty("Whether the local Figma Workspace wrapper/tool completed successfully; upstream.ok reports effective upstream success after consuming public upstream result ok fields."),
      ...properties,
    },
    required: ["ok"],
    additionalProperties: true,
  };
}
