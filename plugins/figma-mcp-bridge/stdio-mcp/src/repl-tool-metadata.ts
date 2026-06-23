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
const MAX_INLINE_RESULT_LIMIT_BYTES = 30_000;

export function createReplToolDescriptions(
  options: ReplToolDescriptionOptions,
): Record<string, unknown>[] {
  const tools: Record<string, unknown>[] = [
    {
      name: "figma_repl_open",
      description:
        "Context helper for creating or updating a local Figma REPL session. Recommended call: { title, sessionId, file, surface }. Use prepare_task + run_script_file for the primary file workflow; use open for lightweight session context, handle import, or file binding.",
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
        connect: booleanProperty("Connect to upstream Figma MCP during open. Defaults to true.", { default: true }),
        refresh: booleanProperty("Advanced/debug only: refresh cached upstream tool list."),
        upstreamTool: stringProperty("Advanced upstream-routing debug override. Defaults to use_figma; ordinary agents should not set this."),
        upstreamArgument: stringProperty("Advanced upstream JavaScript argument-name debug override. Usually code; ordinary agents should not set this."),
        upstreamArguments: objectProperty("Advanced extra upstream arguments for routing debug, merged into every upstream eval call for this session; ordinary agents should not set this."),
        handles: objectProperty("Advanced bootstrap/import only: initial local handles, for example {\"$header\": \"12:34\"}."),
      }),
    },
    {
      name: "figma_repl_eval",
      description:
        "Small ephemeral JavaScript call for quick reads or tightly scoped updates. Recommended call: { title, sessionId, code, mode, surface }. Prefer run_script_file for repairable or multi-step work; eval injects only AST-referenced $ helpers and supports outputFile/upstreamFile for large results.",
      inputSchema: objectSchema({
        title: titleProperty(),
        sessionId: stringProperty("Local REPL session id. Defaults to 'default'."),
        code: stringProperty("JavaScript body executed inside an async function in the Figma Plugin API context. Use return to send structured output."),
        mode: enumProperty(["read", "write"], "Use read to reject likely mutations before dispatch. Defaults to write."),
        surface: enumProperty(["design", "figjam", "slides"], "Expected Figma surface for this call."),
        allowDangerousOperations: booleanProperty("Allow dynamic/destructive guarded patterns only; does not bypass API contract, surface, or read-mode diagnostics."),
        outputFile: stringProperty("Optional full result JSON file. Relative paths require an initialized workspace; omitted large results use an automatic eval-<timestamp>.result.json file."),
        inlineResultLimit: inlineResultLimitInputProperty("Payload-size control in bytes for inline upstream.payload/upstream.text. Defaults to 4 KB and is capped at 30 KB; complete payloads stay in outputFile."),
        upstreamTool: stringProperty("Advanced upstream-routing debug override for this call; ordinary agents should not set this."),
        upstreamArgument: stringProperty("Advanced upstream JavaScript argument-name debug override for this call; ordinary agents should not set this."),
        upstreamArguments: objectProperty("Advanced extra upstream arguments for routing/debug only; ordinary agents should not set this."),
        handleUpdates: objectProperty("Advanced handle-import escape hatch merged before running code; prefer returning handles or using $.remember in code."),
      }, ["code"]),
    },
    {
      name: "figma_repl_run_script_file",
      description:
        "Primary file-based JavaScript workflow for Figma REPL. Recommended workspace calls: dry-run with { title, sessionId, inputFile, dryRun:true, strict:true, surface }, then execute with { title, sessionId, inputFile, outputFile }. Use scriptPath, upstream overrides, split output files, and inlineResultLimit only for advanced/debug workflows. Read figma-repl://capabilities for disabled dynamic helper syntax.",
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
        upstreamTool: stringProperty("Advanced upstream-routing debug override; ordinary agents should not set this."),
        upstreamArgument: stringProperty("Advanced upstream JavaScript argument-name debug override; ordinary agents should not set this."),
        upstreamArguments: objectProperty("Advanced extra upstream arguments for routing/debug only; ordinary agents should not set this."),
        outputDir: stringProperty("Advanced absolute directory escape hatch. Defaults to result.json only; pass diagnosticsFile or summaryFile for split files."),
        outputFile: stringProperty("Recommended normal result file name inside the initialized file-context directory. Defaults to the input script basename plus .result.json."),
        diagnosticsFile: stringProperty("Advanced opt-in split diagnostics JSON file. Leave unset for normal agent workflows."),
        summaryFile: stringProperty("Advanced opt-in split Markdown summary file. Leave unset for normal agent workflows."),
        inlineResultLimit: inlineResultLimitInputProperty("Advanced payload-size control in bytes for inline upstream.payload/upstream.text only. Defaults to 4 KB and is capped at 30 KB; complete payloads stay in outputFile."),
      }),
    },
    {
      name: "figma_repl_apply_asset_manifest",
      description:
        "Workflow add-on for applying local generated assets to Figma target nodes. Recommended workspace call: { title, sessionId, manifestPath, outputFile? } after .figma.js creates target rectangles. Inline assets, custom upstream templates, and refresh are advanced/debug only.",
      inputSchema: objectSchema({
        title: titleProperty(),
        sessionId: stringProperty("Local REPL session id used for history. Defaults to 'default'."),
        manifestPath: stringProperty("Recommended manifest file path. Accepts an absolute path or a file name inside the initialized file-context workspace; may be an array of assets or an object with assets/toolName/arguments."),
        assets: {
          type: "array",
          description: "Advanced inline asset entries. Prefer manifestPath. Each entry uses { path, target }; target accepts a node id, node URL, local handle like $hero, or { handle: \"$hero\" }.",
          items: { type: "object", additionalProperties: true },
        },
        toolName: stringProperty("Advanced upstream-tool override. Leave unset so the REPL selects an advertised asset-like tool such as upload_assets and infers recognizable args."),
        arguments: objectProperty("Advanced upstream arguments template. Use {{path}}, {{target}}, {{name}}, {{metadata.foo}}, or {{asset}} placeholders only when adapting a custom upstream schema."),
        validateTargets: booleanProperty("Defaults true. When upstream eval is available, verify target nodes have IMAGE fills after upload.", { default: true }),
        refresh: booleanProperty("Advanced/debug only: refresh cached upstream tool list before dispatch."),
        outputFile: stringProperty("Recommended manifest result JSON file name inside the initialized file-context workspace."),
      }),
    },
    {
      name: "figma_repl_capture_node",
      description:
        "Capture one Figma node for final visual QA. Recommended call: { title, sessionId, target, outputFile? }. Image captures default to WebP; explicit .png/.jpg/.jpeg outputFile extensions are preserved. preview:true adds a WebP MCP image preview. metadataFile, custom upstream templates, and refresh are advanced/debug only.",
      inputSchema: objectSchema({
        title: titleProperty(),
        sessionId: stringProperty("Local REPL session id used for history. Defaults to 'default'."),
        target: {
          description: "Recommended target to capture. Accepts a Figma node id, node URL, local handle like $hero, or object like { handle: \"$hero\" }.",
        },
        outputFile: stringProperty("Optional local output path. Recommended extension for image captures is .webp; explicit .png, .jpg, and .jpeg extensions are preserved; extensionless or other extensions normalize to .webp. Text captures normalize to .txt. Omitted outputFile auto-generates a capture-<timestamp>.webp path for image captures."),
        preview: booleanProperty("Opt in to a WebP MCP image preview in the tool content. Defaults false. The structured result contains only compact preview metadata.", { default: false }),
        metadataFile: stringProperty("Advanced optional capture metadata JSON. Use only when separate metadata is explicitly needed."),
        toolName: stringProperty("Advanced upstream screenshot/capture tool override. Leave unset so the REPL selects an advertised screenshot-like tool and infers node id from recognizable schema fields."),
        arguments: objectProperty("Advanced upstream arguments template. Use {{target}} only when adapting a custom upstream schema."),
        refresh: booleanProperty("Advanced/debug only: refresh cached upstream tool list before dispatch."),
      }),
    },
    {
      name: "figma_repl_run_task_plan",
      description:
        "Workflow add-on for running a repeatable local JSON task plan. Recommended file-plan call: { title, sessionId, planPath, outputFile }. Use for scripted script/asset/capture/upstream sequences; inline steps are advanced only.",
      inputSchema: objectSchema({
        title: titleProperty(),
        sessionId: stringProperty("Default local REPL session id inherited by steps when omitted."),
        planPath: stringProperty("Recommended JSON plan path. Accepts an absolute path or a file name inside the initialized file-context workspace; may be an array of steps or an object with steps."),
        steps: {
          type: "array",
          description: "Advanced inline steps. Prefer planPath for repeatable workflows. Supported type values: script-file, asset-manifest/upload_assets, screenshot-capture, upstream-tool. Step arguments go under args.",
          items: taskPlanStepProperty("One task-plan step. Put tool-specific inputs under args."),
        },
        stopOnFailure: booleanProperty("Stop after the first failed step. Defaults true.", { default: true }),
        outputFile: stringProperty("Recommended plan result JSON file name inside the initialized file-context workspace."),
      }),
    },
    {
      name: "figma_repl_prepare_task",
      description:
        "Core workflow entrypoint for creating or reusing a task-specific .figma.js script and paired .result.json file. Recommended workspace call: { title, file, task, surface }. Follow with guidance/lookup, run_script_file dryRun, run_script_file execute, inspect, and capture.",
      inputSchema: objectSchema({
        title: titleProperty(),
        sessionId: stringProperty("Local REPL session id. If initialized, files are created under that session file-context workspace."),
        task: stringProperty("Recommended human task used to derive <taskSlug>.figma.js and <taskSlug>.result.json."),
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
        "Core read-side inspection tool for $selection, $currentPage, stored handles, validation, and compact style audits. Recommended calls: { title, sessionId, target } or { title, sessionId, mode:\"style\", target }. Use before mutation and after generated work; upstream overrides are debug-only.",
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
        upstreamTool: stringProperty("Advanced upstream-routing debug override for this call; ordinary agents should not set this."),
        upstreamArgument: stringProperty("Advanced upstream JavaScript argument-name debug override for this call; ordinary agents should not set this."),
        upstreamArguments: objectProperty("Advanced extra upstream arguments for routing/debug only; ordinary agents should not set this."),
      }),
    },
    {
      name: "figma_repl_call_upstream_tool",
      description:
        "Advanced escape hatch for proxying one official upstream Figma MCP tool call through figma_repl_mcp. Use only when a required official capability is not covered by prepare_task, run_script_file, inspect, capture, asset_manifest, or task_plan.",
      inputSchema: objectSchema({
        title: titleProperty(),
        sessionId: stringProperty("Optional local session id used only for history. Defaults to 'default'."),
        toolName: stringProperty("Official upstream Figma MCP tool name to call. Local figma_repl_* tools are rejected."),
        arguments: objectProperty("Arguments sent to the upstream official Figma MCP tool."),
        refresh: booleanProperty("Refresh cached upstream tool list before dispatch."),
        outputFile: stringProperty("Optional full result JSON file. Relative paths require an initialized workspace; omitted large results use an automatic upstream-<tool>-<timestamp>.result.json file."),
        inlineResultLimit: inlineResultLimitInputProperty("Payload-size control in bytes for inline upstream.payload/upstream.text. Defaults to 4 KB and is capped at 30 KB; complete payloads stay in outputFile."),
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
    session: objectProperty("Public local REPL session metadata."),
    diagnostics: arrayProperty("Session diagnostics."),
    upstreamTools: stringArrayProperty("Known upstream tool names."),
  }),
  figma_repl_eval: toolOutputSchema({
    session: objectProperty("Public local REPL session metadata."),
    upstreamTool: stringProperty("Upstream eval tool name used."),
    upstreamArgument: stringProperty("Upstream eval argument name used."),
    diagnostics: arrayProperty("Preflight diagnostics."),
    upstream: upstreamEnvelopeProperty("Upstream output envelope with JSON payload or text fallback."),
    upstreamError: objectProperty("Normalized upstream failure details when execution failed."),
    primaryFix: stringProperty("Suggested primary repair when execution failed."),
    outputFiles: outputFilesProperty(
      "Files written for full result and upstream sidecar when inline fields are omitted or outputFile is requested.",
      ["outputFile", "upstreamFile"],
    ),
    inlineResultLimit: inlineResultLimitProperty("Inline payload omission metadata when upstream.payload or upstream.text exceeds the byte limit."),
  }),
  figma_repl_run_script_file: toolOutputSchema({
    dryRun: booleanProperty("Whether the script was only compiled/diagnosed."),
    session: objectProperty("Public local REPL session metadata."),
    diagnostics: arrayProperty("Script and wrapper diagnostics."),
    script: scriptMetadataProperty("Compiled script metadata."),
    outputFiles: outputFilesProperty(
      "Files written for complete result, upstream sidecar, diagnostics, summary, or failure-only compiled script.",
      ["outputFile", "upstreamFile", "diagnosticsFile", "summaryFile", "compiledScriptFile"],
    ),
    upstreamError: objectProperty("Normalized upstream failure details when execution failed."),
    primaryFix: stringProperty("Suggested primary repair when execution failed."),
    upstream: upstreamEnvelopeProperty("File-script upstream output envelope with JSON payload or text fallback."),
    inlineResultLimit: inlineResultLimitProperty("Inline payload omission metadata when upstream.payload or upstream.text exceeds the byte limit."),
  }),
  figma_repl_apply_asset_manifest: toolOutputSchema({
    session: objectProperty("Public local REPL session metadata."),
    assets: compactAssetResultsProperty("Compact per-asset upload/fill results."),
    validation: objectProperty("Optional target validation result."),
    outputFiles: outputFilesProperty("Files written for result output.", ["outputFile"]),
    failures: arrayProperty("Per-asset or validation failures."),
  }),
  figma_repl_capture_node: toolOutputSchema({
    session: objectProperty("Public local REPL session metadata."),
    outputFile: stringProperty("Local output file path when capture succeeded."),
    plannedOutputFile: stringProperty("Local output file path requested when capture failed before writing."),
    nodeId: stringProperty("Captured Figma node id."),
    toolName: stringProperty("Upstream screenshot/capture tool name used."),
    kind: enumProperty(["image", "text"], "Saved output kind."),
    mimeType: enumProperty(["image/webp", "image/png", "image/jpeg", "text/plain"], "Detected output MIME type."),
    preview: capturePreviewProperty("Optional WebP MCP image preview metadata when preview:true is requested."),
    qa: objectProperty("Compact capture QA hints."),
    upstream: upstreamEnvelopeProperty("Upstream output envelope, compact inline and complete in outputFile when requested."),
    upstreamError: objectProperty("Normalized upstream failure details when capture failed."),
    outputFiles: outputFilesProperty("Files written for result output.", ["outputFile", "metadataFile"]),
  }),
  figma_repl_run_task_plan: toolOutputSchema({
    session: objectProperty("Public local REPL session metadata."),
    stopped: booleanProperty("Whether execution stopped before remaining steps."),
    stopOnFailure: booleanProperty("Whether the plan was configured to stop on first failure."),
    steps: arrayProperty("Compact per-step execution summaries."),
    outputReferences: objectProperty("Plan-level map of step id to output file pointers for later workflow references."),
    outputFiles: outputFilesProperty("Files written for plan result output.", ["outputFile"]),
    failures: arrayProperty("Failed task-plan steps."),
  }),
  figma_repl_prepare_task: toolOutputSchema({
    task: objectProperty("Prepared task workspace and script/result files."),
    session: objectProperty("Public local REPL session metadata."),
    taskChange: taskChangeProperty("Previous/current task file pointers and whether the session active task changed."),
    outputFiles: outputFilesProperty("Files written for the prepared pending result output.", ["outputFile"]),
    next: stringArrayProperty("Suggested next actions."),
  }),
  figma_repl_guidance: toolOutputSchema({
    mode: stringProperty("Guidance mode: guidance, plan, card, or catalog."),
    workflow: objectProperty("Preferred file workflow payload for plan mode."),
    steps: stringArrayProperty("Plan-mode workflow steps."),
    recommendedTools: stringArrayProperty("Plan-mode recommended tools."),
    suggestedCards: stringArrayProperty("Plan-mode suggested compact card ids."),
    cards: arrayProperty("Compact curated API cards."),
    recommendedCards: stringArrayProperty("Recommended curated card ids."),
    queryHints: stringArrayProperty("Suggested docs/API search hints."),
    apiSymbols: stringArrayProperty("Suggested exact API symbols."),
    avoid: stringArrayProperty("Common mistakes to avoid."),
    suggestions: objectProperty("Ranked task/card suggestions with compact context."),
  }),
  figma_repl_inspect: toolOutputSchema({
    session: objectProperty("Public local REPL session metadata."),
    diagnostics: arrayProperty("Read-mode diagnostics."),
    upstream: upstreamEnvelopeProperty("Upstream output envelope with JSON payload or text fallback."),
    upstreamError: objectProperty("Normalized upstream failure details when inspection failed."),
    primaryFix: stringProperty("Suggested primary repair when inspection failed."),
  }),
  figma_repl_call_upstream_tool: toolOutputSchema({
    session: objectProperty("Public local REPL session metadata."),
    toolName: stringProperty("Upstream official Figma MCP tool name called."),
    upstream: upstreamEnvelopeProperty("Upstream output envelope with JSON payload or text fallback."),
    upstreamError: objectProperty("Normalized upstream failure details when execution failed."),
    primaryFix: stringProperty("Suggested primary repair when execution failed."),
    outputFiles: outputFilesProperty(
      "Files written for full result and upstream sidecar when inline fields are omitted or outputFile is requested.",
      ["outputFile", "upstreamFile"],
    ),
    inlineResultLimit: inlineResultLimitProperty("Inline payload omission metadata when upstream.payload or upstream.text exceeds the byte limit."),
  }),
  figma_repl_lookup: toolOutputSchema({
    kind: stringProperty("Lookup kind: docs or api."),
    query: stringProperty("Normalized search query."),
    symbol: stringProperty("Normalized API symbol query for api lookup."),
    maxResults: numberProperty("Effective result cap."),
    maxSnippetLines: numberProperty("Effective snippet line cap."),
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
      type: stringProperty("Task-plan step type, for example script-file, asset-manifest, screenshot-capture, or upstream-tool."),
      args: objectProperty("Tool-specific step arguments. Put all step tool inputs here."),
    },
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
    case "outputFile":
      return "Primary local output file pointer.";
    case "upstreamFile":
      return "Upstream envelope sidecar file pointer.";
    case "metadataFile":
      return "Capture metadata JSON file pointer.";
    case "diagnosticsFile":
      return "Split diagnostics JSON file pointer.";
    case "summaryFile":
      return "Split summary Markdown file pointer.";
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
      ok: booleanProperty("Whether the upstream envelope represents a successful upstream result."),
      payload: jsonProperty("Parsed upstream JSON payload when kind is json and the field is not omitted inline."),
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
            field: stringProperty("Omitted result field path, for example upstream.payload."),
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
      inputFile: stringProperty("Workspace-relative input script file when available."),
      scriptPath: stringProperty("Absolute script path used by the runner."),
      bytes: numberProperty("Source script size in bytes."),
      injectedHelpers: stringArrayProperty("Final injected helper/property list."),
      helperUsage: helperUsageProperty("Structured helper usage report."),
    },
    additionalProperties: true,
  };
}

function capturePreviewProperty(description: string): Record<string, unknown> {
  return {
    type: "object",
    description,
    properties: {
      enabled: booleanProperty("Whether preview was requested."),
      kind: enumProperty(["mcp-image"], "Preview delivery kind when an image preview is returned."),
      mimeType: enumProperty(["image/webp"], "Preview MIME type."),
      width: numberProperty("Preview width in pixels."),
      height: numberProperty("Preview height in pixels."),
      bytes: numberProperty("Preview payload size in bytes."),
      source: enumProperty(["outputFile"], "Preview source."),
      omittedReason: enumProperty(["not-image", "generation-failed"], "Reason preview content was not returned."),
      error: stringProperty("Preview generation error message when omittedReason is generation-failed."),
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
        toolName: stringProperty("Upstream asset/upload tool used."),
        upload: objectProperty("Compact upload summary."),
        validation: objectProperty("Compact target validation result."),
        error: objectProperty("Compact per-asset error."),
        upstreamSummary: stringProperty("Compact upstream summary text."),
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
      ok: booleanProperty("Whether the local Figma REPL tool completed successfully."),
      ...properties,
    },
    required: ["ok"],
    additionalProperties: true,
  };
}
