import {
  LOCAL_REPL_TOOL_NAMES,
  isLocalReplToolName,
  type LocalReplToolName,
} from "./repl-tool-registry.js";

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

export function createReplToolDescriptions(
  options: ReplToolDescriptionOptions,
): Record<string, unknown>[] {
  const tools: Record<string, unknown>[] = [
    {
      name: "figma_repl_open",
      description:
        "Context helper for creating or updating a local Figma REPL session. Recommended call: { title, sessionId, file, surface }. Use prepare_task + run_script_file for the primary file workflow; use open for lightweight session context, handle import, file binding, or upstream auth connection without tool discovery.",
      inputSchema: objectSchema({
        title: titleProperty(),
        sessionId: stringProperty("Stable local session id. Defaults to 'default'."),
        label: stringProperty("Human-readable session label."),
        file: stringProperty("Optional Figma file URL or raw file key stored in local session metadata. When present, open auto-binds a file-context workspace."),
        cwd: stringProperty("Optional absolute project directory for the auto-bound workspace. Defaults to the MCP server process cwd."),
        dirName: stringProperty("Optional workspace directory name under cwd. Defaults to figma-mcp."),
        surface: enumProperty(["design", "figjam", "slides"], "Expected Figma surface; blocks mismatched Design/FigJam/Slides usage later."),
        currentPageId: stringProperty("Optional current Figma page id stored in local session metadata."),
        reset: booleanProperty("Reset local handles and history for this session before opening."),
        connect: booleanProperty("Connect to upstream Figma MCP during open without listing tools. Defaults to true.", { default: true }),
        handles: objectProperty("Advanced bootstrap/import only: initial local handles, for example {\"$header\": \"12:34\"}."),
      }),
    },
    {
      name: "figma_repl_eval",
      description:
        "Small ephemeral JavaScript call for quick reads or tightly scoped updates only. Recommended call: { title, sessionId, code, mode, surface }. Use prepare_task + run_script_file for repairable scripts, multi-step work, and large structured results.",
      inputSchema: objectSchema({
        title: titleProperty(),
        sessionId: stringProperty("Local REPL session id. Defaults to 'default'."),
        code: stringProperty("JavaScript body executed inside an async function in the Figma Plugin API context. Use return to send structured output."),
        mode: enumProperty(["read", "write"], "Use read to reject likely mutations before dispatch. Defaults to write."),
        surface: enumProperty(["design", "figjam", "slides"], "Expected Figma surface for this call."),
        allowDangerousOperations: booleanProperty("Allow dynamic/destructive guarded patterns only; does not bypass API contract, surface, or read-mode diagnostics."),
        inlineResultLimit: inlineResultLimitInputProperty("Payload-size control in bytes for inline upstream.result/upstream.text. Defaults to 4 KB and is capped at 10 KB; 0 forces configurable inline fields to outputFiles only; complete upstream results stay in outputFiles.upstreamFile."),
        handleUpdates: objectProperty("Advanced handle-import escape hatch merged before running code; prefer returning handles or using $.remember in code."),
      }, ["code"]),
    },
    {
      name: "figma_repl_run_script_file",
      description:
        "Primary file-based JavaScript workflow for Figma REPL. Recommended workspace calls: dry-run with { title, sessionId, inputFile, dryRun:true, strict:true, surface }, then execute with { title, sessionId, inputFile }. Debug JSON files are generated on demand for failures, diagnostics, and inline omissions. Execution uses fixed upstream use_figma/code.",
      inputSchema: objectSchema({
        title: titleProperty(),
        sessionId: stringProperty("Local REPL session id or task name. Defaults to 'default'."),
        scriptPath: stringProperty("Advanced absolute-path escape hatch only. Prefer inputFile after figma_repl_prepare_task creates a file-context workspace."),
        inputFile: stringProperty("Recommended workspace script file name after figma_repl_prepare_task; preferred over scriptPath for agents."),
        dryRun: booleanProperty("Read, diagnose, inject helpers, and return script metadata without calling upstream Figma."),
        strict: booleanProperty("Promote warning diagnostics to fatal and reject before upstream execution."),
        surface: enumProperty(["design", "figjam", "slides"], "Expected Figma surface for this script."),
        targetPageId: stringProperty("Optional PAGE node id used for one setCurrentPageAsync call before the script body runs."),
        allowDangerousOperations: booleanProperty("Allow dynamic/destructive guarded patterns only after reviewing the exact file."),
        inlineResultLimit: inlineResultLimitInputProperty("Advanced payload-size control in bytes for inline upstream.result/upstream.text only. Defaults to 4 KB and is capped at 10 KB; 0 forces configurable inline fields to outputFiles only; complete upstream results stay in outputFiles.upstreamFile."),
      }),
    },
    {
      name: "figma_repl_apply_asset_manifest",
      description:
        "Workflow add-on for applying local generated assets to Figma target nodes through official upstream upload_assets. Recommended workspace call: { title, sessionId, manifestPath } after .figma.js creates target rectangles. Debug JSON files are generated on demand for failures. Use figma_repl_call_upstream_tool only for explicit uncovered upstream capabilities.",
      inputSchema: objectSchema({
        title: titleProperty(),
        sessionId: stringProperty("Local REPL session id used for history. Defaults to 'default'."),
        manifestPath: stringProperty("Recommended manifest file path. Accepts an absolute path or a file name inside the initialized file-context workspace; may be an array of assets or an object with assets."),
        assets: {
          type: "array",
          description: "Advanced inline asset entries. Prefer manifestPath. Each entry uses { path, target }; target accepts a node id, node URL, local handle like $hero, or { handle: \"$hero\" }.",
          items: { type: "object", additionalProperties: true },
        },
        validateTargets: booleanProperty("Defaults true. When upstream eval is available, verify target nodes have IMAGE fills after upload.", { default: true }),
      }),
    },
    {
      name: "figma_repl_download_assets",
      description:
        "Workflow add-on for official Figma asset downloads. Recommended call: { title, sessionId, targets:[{ target, name?, defaultFormat?, defaultScale? }], outputDir? }. Use manifestPath only for batch files shaped as { targets:[...] }; the tool always calls upstream download_assets, saves exported plus raw/source files locally, and writes debug JSON only on failure.",
      inputSchema: objectSchema({
        title: titleProperty(),
        sessionId: stringProperty("Local REPL session id used for fileKey, handles, workspace defaults, and history. Defaults to 'default'."),
        targets: {
          type: "array",
          description: "Recommended target list. Single-target calls still use targets: [{ target }]. Mutually exclusive with manifestPath.",
          items: downloadAssetTargetProperty(),
        },
        manifestPath: stringProperty("Optional batch manifest path. Accepts an absolute path or a file name inside the initialized file-context workspace. Manifest shape is exactly { targets: [...] }; assets aliases are rejected."),
        outputDir: stringProperty("Optional output directory. Relative paths require an initialized workspace. Defaults to <slug>.downloads in the workspace, or a temp download-results directory without a workspace."),
      }),
    },
    {
      name: "figma_repl_capture_node",
      description:
        "Capture one Figma node for final visual QA through official upstream get_screenshot. Recommended call: { target, sessionId?, imageFile? }. Captures are saved as PNG; extensionless or non-.png imageFile values normalize to .png. Results return the local PNG path in structuredContent.imageFile.",
      inputSchema: objectSchema({
        title: titleProperty(),
        sessionId: stringProperty("Local REPL session id used for file context and history. Defaults to 'default'."),
        target: {
          description: "Target node to capture. Accepts a Figma node id when the session has file context, node URL, local handle like $hero, { handle:\"$hero\" }, or { fileKey, nodeId }.",
        },
        imageFile: stringProperty("Optional local PNG output path. Extensionless or non-.png values normalize to .png. Omitted imageFile auto-generates capture-<timestamp>.png."),
      }, ["target"]),
    },
    {
      name: "figma_repl_run_task_plan",
      description:
        "Workflow add-on for running a repeatable local JSON task plan. Recommended file-plan call: { title, sessionId, planPath }. Steps use only { id?, type?, args? }; put tool-specific inputs inside args. The plan-level debug file is generated automatically.",
      inputSchema: objectSchema({
        title: titleProperty(),
        sessionId: stringProperty("Default local REPL session id inherited by steps when omitted."),
        planPath: stringProperty("Recommended JSON plan path. Accepts an absolute path or a file name inside the initialized file-context workspace; may be an array of steps or an object with steps."),
        steps: {
          type: "array",
          description: "Advanced inline steps. Prefer planPath for repeatable workflows. Supported type values: script-file, asset-manifest/upload_assets, download-assets/download_assets, screenshot-capture, upstream-tool. Step arguments go under args.",
          items: taskPlanStepProperty("One task-plan step. Put tool-specific inputs under args."),
        },
        stopOnFailure: booleanProperty("Stop after the first failed step. Defaults true.", { default: true }),
      }),
    },
    {
      name: "figma_repl_prepare_task",
      description:
        "Core workflow entrypoint for creating or reusing a task-specific .figma.js script. It does not create a pending result stub; debug JSON files are generated later on demand. Recommended workspace call: { title, file, task, surface }. Follow with guidance/lookup, run_script_file dryRun, run_script_file execute, inspect, and capture.",
      inputSchema: objectSchema({
        title: titleProperty(),
        sessionId: stringProperty("Local REPL session id. If initialized, files are created under that session file-context workspace."),
        task: stringProperty("Recommended human task used to derive <taskSlug>.figma.js."),
        file: stringProperty("Recommended Figma file URL or raw file key used to derive the file context when preparing a workspace."),
        fileSlug: stringProperty("Advanced file-context slug override to use when file cannot derive a key."),
        cwd: stringProperty("Optional absolute project directory where the figma-mcp workspace directory will be created. Defaults to the MCP server process cwd when file context is present."),
        dirName: stringProperty("Advanced workspace directory name under cwd. Defaults to figma-mcp."),
        taskSlug: stringProperty("Advanced stable slug override for the task files. Defaults from task/title."),
        fileName: stringProperty("Advanced script file-name override ending in .figma.js."),
        taskRoot: stringProperty(`Advanced absolute task root for temp task workspaces. Defaults to ${options.taskWorkspaceRootEnv}, then OS temp figma-repl-mcp/tasks.`),
        workspaceDir: stringProperty("Advanced absolute workspace directory override."),
        surface: enumProperty(["design", "figjam", "slides"], "Recommended expected Figma surface persisted on the session and copied into generated guidance."),
        targetPageId: stringProperty("Optional target page id copied into generated guidance."),
        template: stringProperty("Template hint copied into the generated .figma.js comments. V1 templates are curated guidance only."),
        overwrite: booleanProperty("Advanced destructive overwrite of an existing script/result pair. Defaults false."),
      }),
    },
    {
      name: "figma_repl_guidance",
      description:
        "Planning and routing helper for compact workflow guidance, curated API cards, or catalog metadata. Recommended call: { title, task, surface }. Use task for natural-language requests before writing .figma.js; pair with lookup only when exact docs/API snippets are needed.",
      inputSchema: objectSchema({
        title: titleProperty(),
        mode: enumProperty(["guidance", "plan", "card", "catalog"], "Guidance mode. Defaults from card/query/task fields."),
        card: stringProperty(`Card id or topic, for example text.font, layout.auto, components.variants, variables.bind, surface.slides. Hard limit ${options.maxLookupQueryLength} characters.`),
        query: stringProperty(`Search query when card id is not known. Hard limit ${options.maxLookupQueryLength} characters.`),
        task: stringProperty(`Natural-language task request. Trimmed and capped to ${options.maxLookupQueryLength} characters for guidance lookup/ranking.`),
        surface: enumProperty(["design", "figjam", "slides"], "Expected Figma surface."),
        workflow: stringProperty("Preferred workflow for plan mode. Defaults to script-file."),
        maxCards: numberProperty("Maximum cards to return, capped at 8. Defaults to 4."),
      }),
    },
    {
      name: "figma_repl_inspect",
      description:
        "Core read-side inspection tool for $selection, $currentPage, stored handles, validation, and compact style audits. Recommended calls: { title, sessionId, target } or { title, sessionId, mode:\"style\", target }. Uses fixed upstream use_figma execution.",
      inputSchema: objectSchema({
        title: titleProperty(),
        sessionId: stringProperty("Local REPL session id. Defaults to 'default'."),
        mode: enumProperty(["inspect", "validate", "style"], "Use inspect for target summaries, validate for cached handle status, or style for compact visual-token audits. Defaults to inspect."),
        target: stringProperty("$selection, $currentPage, a stored handle like $header, or a raw node id. Defaults to $selection."),
        depth: numberProperty("Child summary depth. Defaults to 2."),
        handles: {
          type: "array",
          description: "Optional handle names or raw node ids to validate. Defaults to all cached handles.",
          items: { type: "string" },
        },
      }),
    },
    {
      name: "figma_repl_get_metadata",
      description:
        "Metadata-first read tool for broad Figma layer-tree discovery. Calls official upstream get_metadata and converts returned XML into a compact JSON node tree. Small converted JSON trees are returned inline; oversized trees are written to outputFiles.metadataFile. Recommended call: { title, sessionId, file?, target? }. Use inspect/style afterward for fills, text, and visual tokens.",
      inputSchema: objectSchema({
        title: titleProperty(),
        sessionId: stringProperty("Local REPL session id used for file context, handles, workspace defaults, and history. Defaults to 'default'."),
        file: stringProperty("Optional Figma file URL or raw file key. A node-id in the URL is used as the target when target/nodeId is omitted."),
        cwd: stringProperty("Optional absolute project directory for auto-bound file workspace when file is supplied. Defaults to MCP server cwd."),
        dirName: stringProperty("Optional workspace directory name under cwd. Defaults to figma-mcp."),
        target: {
          description: "Optional metadata root. Accepts a raw node id, node URL, local handle like $hero, or { handle:\"$hero\" }. Dynamic selectors such as $selection are not resolved here.",
        },
        nodeId: stringProperty("Optional raw Figma node id. Prefer target for handles or node URLs."),
        clientLanguages: stringProperty("Optional official get_metadata clientLanguages hint. Defaults to unknown."),
        clientFrameworks: stringProperty("Optional official get_metadata clientFrameworks hint. Defaults to unknown."),
        refresh: booleanProperty("Refresh cached upstream tool list before dispatch."),
        inlineResultLimit: inlineResultLimitInputProperty("Payload-size control in bytes for converted metadata.json. Defaults to 4 KB and is capped at 10 KB; 0 forces metadata.json to outputFiles.metadataFile only."),
      }),
    },
    {
      name: "figma_repl_call_upstream_tool",
      description:
        "Explicit upstream-only escape hatch for one official Figma MCP tool call. Before calling, read figma-repl://upstream-tools and then figma-repl://upstream-tools/{name}. Do not use for use_figma, get_metadata, get_screenshot, upload_assets, or download_assets because dedicated wrappers cover them.",
      inputSchema: objectSchema({
        title: titleProperty(),
        sessionId: stringProperty("Optional local session id used only for history. Defaults to 'default'."),
        toolName: stringProperty("Official upstream Figma MCP tool name to call for an uncovered capability. Local figma_repl_* tools are rejected."),
        arguments: objectProperty("Arguments sent to the upstream official Figma MCP tool."),
        refresh: booleanProperty("Refresh cached upstream tool list before dispatch."),
        inlineResultLimit: inlineResultLimitInputProperty("Payload-size control in bytes for inline upstream.result/upstream.text. Defaults to 4 KB and is capped at 10 KB; 0 forces configurable inline fields to outputFiles only; complete upstream results stay in outputFiles.upstreamFile."),
      }, ["toolName", "arguments"]),
    },
    {
      name: "figma_repl_lookup",
      description:
        "Targeted lookup helper for compact docs snippets or exact Figma Plugin API symbols. For kind=docs use query; for kind=api use symbol. Use after guidance when exact API/docs context is still needed.",
      inputSchema: objectSchema({
        title: titleProperty(),
        kind: enumProperty(["docs", "api"], "Lookup corpus. Use docs for workflow snippets or api for exact Plugin API symbols."),
        query: stringProperty(`Recommended for kind=docs keyword lookup, for example 'component properties' or 'Slides lifecycle'. Hard limit ${options.maxLookupQueryLength} characters.`),
        symbol: stringProperty(`Recommended for kind=api exact Plugin API lookup, for example createFrame, loadFontAsync, VariableCollection. Hard limit ${options.maxLookupQueryLength} characters.`),
        maxResults: numberProperty(`Result-size control only. Maximum results, capped at ${options.maxDocsSearchResults}. Defaults to docs=${options.defaultDocsSearchMaxResults}, api=5.`),
        maxSnippetLines: numberProperty(`Result-size control only. Lines per snippet, capped at ${options.maxDocsSearchSnippetLines}. Defaults to docs=${options.defaultDocsSearchSnippetLines}, api=5.`),
      }, ["kind"]),
    },
  ];
  return assertLocalReplToolDescriptions(tools);
}

const LOCAL_REPL_TOOL_OUTPUT_SCHEMAS = {
  figma_repl_open: toolOutputSchema({
    session: objectProperty("Compact local REPL session metadata without history or full workspace state."),
    diagnostics: arrayProperty("Session diagnostics."),
  }),
  figma_repl_eval: toolOutputSchema({
    session: objectProperty("Compact local REPL session metadata without history or full workspace state."),
    diagnostics: arrayProperty("Preflight diagnostics."),
    upstream: upstreamEnvelopeProperty("Upstream output envelope with JSON result or text fallback. upstream.ok reports effective upstream success and consumed top-level ok fields are removed from upstream.result. Bridge-internal __figmaRepl metadata is removed from public eval results."),
    upstreamError: objectProperty("Normalized upstream failure details when execution failed."),
    primaryFix: stringProperty("Suggested primary repair when execution failed."),
    outputFiles: outputFilesProperty(
      "Debug files written on demand for failure or inline omissions, including minimal result envelope and upstream sidecar.",
      ["debugFile", "upstreamFile"],
    ),
    inlineResultLimit: inlineResultLimitProperty("Inline payload omission metadata when upstream.result or upstream.text exceeds the byte limit."),
  }),
  figma_repl_run_script_file: toolOutputSchema({
    dryRun: booleanProperty("Whether the script was only compiled/diagnosed."),
    session: objectProperty("Compact local REPL session metadata without history or full workspace state."),
    diagnostics: arrayProperty("Script and wrapper diagnostics."),
    script: scriptMetadataProperty("Compiled script metadata."),
    outputFiles: outputFilesProperty(
      "Debug files written on demand for failures, diagnostics, inline omissions, or failure-only compiled script.",
      ["debugFile", "upstreamFile", "compiledScriptFile"],
    ),
    upstreamError: objectProperty("Normalized upstream failure details when execution failed."),
    primaryFix: stringProperty("Suggested primary repair when execution failed."),
    upstream: upstreamEnvelopeProperty("File-script upstream output envelope with JSON result or text fallback. upstream.ok reports effective upstream success and consumed top-level ok fields are removed from upstream.result. Bridge-internal __figmaRepl metadata is removed from public script results."),
    inlineResultLimit: inlineResultLimitProperty("Inline payload omission metadata when upstream.result or upstream.text exceeds the byte limit."),
  }),
  figma_repl_apply_asset_manifest: toolOutputSchema({
    session: objectProperty("Compact local REPL session metadata without history or full workspace state."),
    assets: compactAssetResultsProperty("Compact per-asset upload/fill results."),
    validation: objectProperty("Optional target validation result."),
    outputFiles: outputFilesProperty("Debug files written on demand for failures.", ["debugFile"]),
    failures: arrayProperty("Per-asset or validation failures."),
  }),
  figma_repl_download_assets: toolOutputSchema({
    session: objectProperty("Compact local REPL session metadata without history or full workspace state."),
    outputDir: stringProperty("Local directory containing per-target download folders."),
    targets: compactDownloadAssetResultsProperty("Compact per-target download results."),
    failures: arrayProperty("Per-target download or upstream failures."),
    outputFiles: outputFilesProperty("Debug files written on demand for failures.", ["debugFile"]),
  }),
  figma_repl_capture_node: toolOutputSchema({
    session: objectProperty("Compact local REPL session metadata without history or full workspace state."),
    imageFile: stringProperty("Absolute local PNG screenshot path when capture succeeded."),
    nodeId: stringProperty("Captured Figma node id."),
    bytes: numberProperty("Saved PNG file size in bytes."),
    width: numberProperty("Saved PNG width in pixels."),
    height: numberProperty("Saved PNG height in pixels."),
    upstreamError: objectProperty("Normalized upstream failure details when capture failed."),
  }),
  figma_repl_run_task_plan: toolOutputSchema({
    session: objectProperty("Compact local REPL session metadata without history or full workspace state."),
    stopped: booleanProperty("Whether execution stopped before remaining steps."),
    steps: arrayProperty("Compact per-step execution summaries."),
    outputReferences: objectProperty("Plan-level map of step id to output file pointers for later workflow references."),
    outputFiles: outputFilesProperty("Files written for plan result output.", ["debugFile"]),
    failures: compactTaskPlanFailuresProperty("Compact failed task-plan step summaries."),
  }),
  figma_repl_prepare_task: toolOutputSchema({
    task: objectProperty("Prepared task workspace and script file."),
    session: objectProperty("Compact local REPL session metadata; task.workspace remains the full prepared workspace shape."),
    taskChange: taskChangeProperty("Previous/current task file pointers and whether the session active task changed."),
    next: stringArrayProperty("Suggested next actions."),
  }),
  figma_repl_guidance: toolOutputSchema({
    workflow: objectProperty("Preferred file workflow payload for plan mode."),
    steps: stringArrayProperty("Plan-mode workflow steps."),
    recommendedTools: stringArrayProperty("Plan-mode recommended tools."),
    suggestedCards: stringArrayProperty("Plan-mode suggested compact card ids."),
    cards: arrayProperty("Compact curated API cards."),
    catalogSize: numberProperty("Total curated API card count when returned."),
    guidance: stringProperty("Compact follow-up guidance text when returned."),
    recommendedCards: stringArrayProperty("Recommended curated card ids."),
    queryHints: stringArrayProperty("Suggested docs/API search hints."),
    apiSymbols: stringArrayProperty("Suggested exact API symbols."),
    avoid: stringArrayProperty("Common mistakes to avoid."),
    suggestions: guidanceSuggestionsProperty("Ranked task/card suggestions with compact context."),
  }),
  figma_repl_inspect: toolOutputSchema({
    session: objectProperty("Compact local REPL session metadata without history or full workspace state."),
    diagnostics: arrayProperty("Read-mode diagnostics."),
    target: stringProperty("Inspected target selector or node id when returned by the inspect mode."),
    summary: jsonProperty("Compact inspected node or selection summary when returned by the inspect mode."),
    handles: objectProperty("Known handle map returned by read-side inspection when available."),
    mode: stringProperty("Inspect mode marker when returned by the inspect mode."),
    nodeCount: numberProperty("Inspected node count for style audits."),
    style: inspectStyleAuditProperty("Compact visual-token/style audit for mode=style."),
    validations: inspectHandleValidationsProperty("Handle validation results for mode=validate."),
    validatedNodeIds: stringArrayProperty("Validated node ids for mode=validate."),
    upstreamError: objectProperty("Normalized upstream failure details when inspection failed."),
  }),
  figma_repl_get_metadata: toolOutputSchema({
    session: objectProperty("Compact local REPL session metadata without history or full workspace state."),
    fileKey: stringProperty("Figma file key sent to official get_metadata."),
    nodeId: stringProperty("Optional Figma node id sent to official get_metadata."),
    metadata: objectProperty("Metadata conversion summary. metadata.json contains the compact converted node tree when it fits inline; oversized JSON is available from outputFiles.metadataFile."),
    upstream: upstreamEnvelopeProperty("Compact upstream status envelope. Raw XML text is not returned inline by this wrapper."),
    upstreamError: objectProperty("Normalized upstream or XML parse failure details when metadata conversion failed."),
    primaryFix: stringProperty("Suggested primary repair when upstream execution failed."),
    outputFiles: outputFilesProperty(
      "Files written for metadata conversion when the converted JSON tree exceeds inlineResultLimit.",
      ["metadataFile"],
    ),
    inlineResultLimit: inlineResultLimitProperty("Inline payload omission metadata when metadata.json exceeds the byte limit."),
  }),
  figma_repl_call_upstream_tool: toolOutputSchema({
    session: objectProperty("Compact local REPL session metadata without history or full workspace state."),
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
  figma_repl_lookup: toolOutputSchema({
    results: arrayProperty("Ranked compact corpus snippets."),
    guidance: stringProperty("Compact follow-up guidance."),
  }),
} satisfies Record<LocalReplToolName, Record<string, unknown>>;

function assertLocalReplToolDescriptions(tools: Record<string, unknown>[]): Record<string, unknown>[] {
  const descriptionNames = new Set<string>();
  const describedTools: Record<string, unknown>[] = [];
  for (const tool of tools) {
    if (typeof tool.name !== "string") {
      throw new Error("Local figma_repl_mcp tool description is missing a string name.");
    }
    descriptionNames.add(tool.name);
    if (!isLocalReplToolName(tool.name)) {
      throw new Error(`Local figma_repl_mcp tool description is not in the registry: ${tool.name}`);
    }
    describedTools.push({
      ...tool,
      outputSchema: LOCAL_REPL_TOOL_OUTPUT_SCHEMAS[tool.name],
    });
  }
  for (const name of LOCAL_REPL_TOOL_NAMES) {
    if (!descriptionNames.has(name)) {
      throw new Error(`Local figma_repl_mcp registry tool is missing a description: ${name}`);
    }
  }
  return describedTools;
}

function objectSchema(
  properties: Record<string, unknown>,
  required: string[] = [],
): Record<string, unknown> {
  return {
    type: "object",
    properties,
    required,
    additionalProperties: false,
  };
}

function titleProperty(): Record<string, unknown> {
  return stringProperty("One concise sentence-style line for UI/log display.");
}

function stringProperty(description: string): Record<string, unknown> {
  return { type: "string", description };
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
    description: "One Figma target for official download_assets. Use target for node id, node URL, local handle, or { handle }.",
    properties: {
      target: jsonProperty("Required target. Accepts a node id, node URL, local handle like $hero, or object like { handle: \"$hero\" }."),
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
      result: jsonProperty("Public parsed upstream JSON result when kind is json and the field is not omitted inline. Payloads containing bridge-internal __figmaRepl metadata are unwrapped to their business result; raw official JSON with top-level ok consumes and removes that ok, while raw JSON without top-level ok remains unchanged. When ok=false, result.source preserves failure provenance as call or business."),
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
      limit: numberProperty("Effective inline byte limit."),
      limitBytes: numberProperty("Effective inline byte limit."),
      limitHuman: stringProperty("Human-readable inline byte limit, for example 4 KB."),
      omitted: {
        type: "array",
        description: "Inline fields omitted because they exceeded the effective byte limit.",
        items: {
          type: "object",
          properties: {
            field: stringProperty("Omitted result field path, for example upstream.result."),
            bytes: numberProperty("Omitted field size in bytes."),
            limit: numberProperty("Effective inline byte limit."),
            bytesHuman: stringProperty("Human-readable omitted field size."),
            limitHuman: stringProperty("Human-readable inline byte limit."),
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
        handle: stringProperty("Local handle associated with the target when available."),
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
        handle: stringProperty("Local handle associated with the target when available."),
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

function guidanceSuggestionsProperty(description: string): Record<string, unknown> {
  return {
    type: "object",
    description,
    properties: {
      recommendedCards: stringArrayProperty("Recommended curated API card ids."),
      queryHints: stringArrayProperty("Suggested docs/API search hints."),
      apiSymbols: stringArrayProperty("Suggested exact API symbols."),
      avoid: stringArrayProperty("Common mistakes to avoid."),
      referenceContext: {
        type: "array",
        description: "Compact ranked reference snippets used for suggestions.",
        items: {
          type: "object",
          properties: {
            sourceId: stringProperty("Opaque reference source id."),
            title: stringProperty("Reference result title."),
            snippet: stringProperty("Compact reference snippet."),
            matchType: stringProperty("Reference match type."),
          },
          additionalProperties: true,
        },
      },
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
      caps: objectProperty("Returned list caps."),
    },
    additionalProperties: true,
  };
}

function inspectHandleValidationsProperty(description: string): Record<string, unknown> {
  return {
    type: "array",
    description,
    items: {
      type: "object",
      properties: {
        handle: stringProperty("Requested handle or node id."),
        status: stringProperty("Validation status: valid, missing, or stale."),
        id: stringProperty("Resolved node id when valid."),
        type: stringProperty("Resolved node type when valid."),
        name: stringProperty("Resolved node name when valid."),
        error: stringProperty("Validation error text when stale."),
      },
      additionalProperties: true,
    },
  };
}

function taskChangeProperty(description: string): Record<string, unknown> {
  return {
    type: "object",
    description,
    properties: {
      previous: objectProperty("Previous active task/session file pointers before prepare_task."),
      current: objectProperty("Current active task/session file pointers after prepare_task."),
      changed: booleanProperty("Whether the session active task changed."),
    },
    additionalProperties: true,
  };
}

function toolOutputSchema(properties: Record<string, unknown>): Record<string, unknown> {
  return {
    type: "object",
    properties: {
      ok: booleanProperty("Whether the local Figma REPL wrapper/tool completed successfully; upstream.ok reports effective upstream success after consuming public upstream result ok fields."),
      ...properties,
    },
    required: ["ok"],
    additionalProperties: true,
  };
}
