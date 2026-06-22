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

export function createReplToolDescriptions(
  options: ReplToolDescriptionOptions,
): Record<string, unknown>[] {
  const tools: Record<string, unknown>[] = [
    {
      name: "figma_repl_open",
      description:
        "Create or update a local Figma REPL session. Recommended call: { title, sessionId, fileUrl, expectedSurface }. Records file/surface/page context and local handles; use upstream overrides only for routing debug.",
      inputSchema: objectSchema({
        title: titleProperty(),
        sessionId: stringProperty("Stable local session id. Defaults to 'default'."),
        label: stringProperty("Human-readable session label."),
        fileUrl: stringProperty("Optional Figma file URL stored in local session metadata."),
        expectedSurface: enumProperty(["design", "figjam", "slides"], "Expected Figma surface; blocks mismatched Design/FigJam/Slides usage later."),
        currentPageId: stringProperty("Optional current Figma page id stored in local session metadata."),
        reset: booleanProperty("Reset local handles and history for this session before opening."),
        connect: booleanProperty("Connect to upstream Figma MCP during open. Defaults to true."),
        refresh: booleanProperty("Advanced/debug only: refresh cached upstream tool list."),
        upstreamTool: stringProperty("Advanced upstream-routing debug override. Defaults to use_figma; ordinary agents should not set this."),
        upstreamArgument: stringProperty("Advanced upstream JavaScript argument-name debug override. Usually code; ordinary agents should not set this."),
        upstreamArguments: objectProperty("Advanced extra upstream arguments for routing debug, merged into every upstream eval call for this session; ordinary agents should not set this."),
        handles: objectProperty("Advanced bootstrap/import only: initial local handles, for example {\"$header\": \"12:34\"}."),
      }, ["title"]),
    },
    {
      name: "figma_repl_eval",
      description:
        "Run one batched JavaScript transaction through upstream use_figma. Recommended call: { title, sessionId, code, mode, expectedSurface }. The eval wrapper injects only AST-referenced $ helpers; read figma-repl://capabilities for disabled dynamic helper syntax and argument guidance.",
      inputSchema: objectSchema({
        title: titleProperty(),
        sessionId: stringProperty("Local REPL session id. Defaults to 'default'."),
        code: stringProperty("JavaScript body executed inside an async function in the Figma Plugin API context. Use return to send structured output."),
        mode: enumProperty(["read", "write"], "Use read to reject likely mutations before dispatch. Defaults to write."),
        expectedSurface: enumProperty(["design", "figjam", "slides"], "Expected Figma surface for this call."),
        allowDangerousOperations: booleanProperty("Allow dynamic/destructive guarded patterns only; does not bypass API contract, surface, or read-mode diagnostics."),
        upstreamTool: stringProperty("Advanced upstream-routing debug override for this call; ordinary agents should not set this."),
        upstreamArgument: stringProperty("Advanced upstream JavaScript argument-name debug override for this call; ordinary agents should not set this."),
        upstreamArguments: objectProperty("Advanced extra upstream arguments for routing/debug only; ordinary agents should not set this."),
        handleUpdates: objectProperty("Advanced handle-import escape hatch merged before running code; prefer returning handles or using $.remember in code."),
      }, ["title", "code"]),
    },
    {
      name: "figma_repl_run_script_file",
      description:
        "Primary file-based JavaScript workflow for Figma REPL. Recommended workspace calls: dry-run with { title, sessionId, inputFile, dryRun:true, strict:true, expectedSurface }, then execute with { title, sessionId, inputFile, outputFile }. Use scriptPath, upstream overrides, split output files, and inlineResultLimit only for advanced/debug workflows. Read figma-repl://capabilities for disabled dynamic helper syntax.",
      inputSchema: objectSchema({
        title: titleProperty(),
        sessionId: stringProperty("Local REPL session id or task name. Defaults to 'default'."),
        scriptPath: stringProperty("Advanced absolute-path escape hatch only. Prefer inputFile after figma_repl_prepare_task creates a file-context workspace."),
        inputFile: stringProperty("Recommended workspace script file name after figma_repl_prepare_task; preferred over scriptPath for agents."),
        dryRun: booleanProperty("Read, diagnose, inject helpers, and return script metadata without calling upstream Figma."),
        strict: booleanProperty("Promote warning diagnostics to fatal and reject before upstream execution."),
        expectedSurface: enumProperty(["design", "figjam", "slides"], "Expected Figma surface for this script."),
        targetPageId: stringProperty("Optional PAGE node id used for one setCurrentPageAsync call before the script body runs."),
        allowDangerousOperations: booleanProperty("Allow dynamic/destructive guarded patterns only after reviewing the exact file."),
        upstreamTool: stringProperty("Advanced upstream-routing debug override; ordinary agents should not set this."),
        upstreamArgument: stringProperty("Advanced upstream JavaScript argument-name debug override; ordinary agents should not set this."),
        upstreamArguments: objectProperty("Advanced extra upstream arguments for routing/debug only; ordinary agents should not set this."),
        outputDir: stringProperty("Advanced absolute directory escape hatch. Defaults to result.json only; pass diagnosticsFile or summaryFile for split files."),
        outputFile: stringProperty("Recommended normal result file name inside the initialized file-context directory. Defaults to the input script basename plus .result.json."),
        resultFile: stringProperty("Advanced output alias/escape hatch for absolute or outputDir-relative complete result output. Prefer outputFile in workspaces."),
        diagnosticsFile: stringProperty("Advanced opt-in split diagnostics JSON file. Leave unset for normal agent workflows."),
        summaryFile: stringProperty("Advanced opt-in split Markdown summary file. Leave unset for normal agent workflows."),
        inlineResultLimit: numberProperty("Advanced payload-size control for inline upstream.payload/upstream.text only; not a return-shape selector. Use resultFile/outputFile for complete payloads."),
      }, ["title"]),
    },
    {
      name: "figma_repl_apply_asset_manifest",
      description:
        "Apply local generated assets to Figma target nodes. Recommended workspace call: { title, sessionId, manifestPath, outputFile? } after .figma.js creates target rectangles. Inline assets, custom upstream templates, refresh, and resultFile are advanced/debug only.",
      inputSchema: objectSchema({
        title: titleProperty(),
        sessionId: stringProperty("Local REPL session id used for history. Defaults to 'default'."),
        manifestPath: stringProperty("Recommended manifest file path. Accepts an absolute path or a file name inside the initialized file-context workspace; may be an array of assets or an object with assets/toolName/argumentsTemplate."),
        assets: {
          type: "array",
          description: "Advanced inline asset entries. Prefer manifestPath. Compatibility aliases are accepted: path|filePath|localPath and targetNodeId|nodeId|target|targetHandle|targetId; target fields accept local handles like $hero.",
          items: { type: "object", additionalProperties: true },
        },
        toolName: stringProperty("Advanced upstream-tool override. Leave unset so the REPL selects an advertised asset-like tool such as upload_assets and infers recognizable args."),
        arguments: objectProperty("Advanced upstream arguments template. Use {{path}}, {{targetNodeId}}, {{name}}, {{metadata.foo}}, or {{asset}} placeholders only when adapting a custom upstream schema."),
        argumentsTemplate: objectProperty("Advanced alias for arguments. Use only when mirroring fake or upstream schemas explicitly."),
        validateTargets: booleanProperty("Defaults true. When upstream eval is available, verify target nodes have IMAGE fills after upload."),
        refresh: booleanProperty("Advanced/debug only: refresh cached upstream tool list before dispatch."),
        resultFile: stringProperty("Advanced output alias/escape hatch for manifest result JSON. Prefer outputFile in workspaces."),
        outputFile: stringProperty("Recommended manifest result JSON file name inside the initialized file-context workspace."),
      }, ["title"]),
    },
    {
      name: "figma_repl_capture_node",
      description:
        "Capture one Figma node for final visual QA. Recommended call: { title, sessionId, nodeId, outputFile }. targetNodeId/target/handle aliases, custom upstream templates, refresh, and resultFile are advanced/debug only.",
      inputSchema: objectSchema({
        title: titleProperty(),
        sessionId: stringProperty("Local REPL session id used for history. Defaults to 'default'."),
        nodeId: stringProperty("Recommended target to capture: Figma node id, node URL, or local handle like $hero."),
        targetNodeId: stringProperty("Compatibility alias for nodeId. Prefer nodeId for direct tool calls."),
        target: {
          description: "Advanced alias for handle-aware workflow plans. Prefer nodeId for direct tool calls; accepts a string or object like { handle: \"$hero\" }.",
        },
        handle: stringProperty("Compatibility alias for nodeId when passing a local handle like $hero. Prefer nodeId."),
        outputFile: stringProperty("Recommended local output file for screenshot image, downloaded URL payload, or text response. Accepts an absolute path or a file name inside the initialized file-context workspace."),
        resultFile: stringProperty("Advanced optional capture metadata JSON. Prefer outputFile unless separate metadata is explicitly needed."),
        toolName: stringProperty("Advanced upstream screenshot/capture tool override. Leave unset so the REPL selects an advertised screenshot-like tool and infers node id from recognizable schema fields."),
        arguments: objectProperty("Advanced upstream arguments template. Use {{nodeId}} or {{targetNodeId}} placeholders only when adapting a custom upstream schema."),
        argumentsTemplate: objectProperty("Advanced alias for arguments."),
        refresh: booleanProperty("Advanced/debug only: refresh cached upstream tool list before dispatch."),
      }, ["title", "outputFile"]),
    },
    {
      name: "figma_repl_run_task_plan",
      description:
        "Run a sequential local JSON task plan. Recommended file-plan call: { title, sessionId, planPath, outputFile }. Inline steps and resultFile are advanced/compat only. Later steps can reference prior outputs with templates like {{outputs.stepId.resultFile.path}}.",
      inputSchema: objectSchema({
        title: titleProperty(),
        sessionId: stringProperty("Default local REPL session id inherited by steps when omitted."),
        planPath: stringProperty("Recommended JSON plan path. Accepts an absolute path or a file name inside the initialized file-context workspace; may be an array of steps or an object with steps."),
        steps: {
          type: "array",
          description: "Advanced inline steps. Prefer planPath for repeatable workflows. Supported type/tool values: script-file, asset-manifest/upload_assets, screenshot-capture, upstream-tool.",
          items: { type: "object", additionalProperties: true },
        },
        stopOnFailure: booleanProperty("Stop after the first failed step. Defaults true."),
        resultFile: stringProperty("Advanced output alias/escape hatch for JSON result file. Prefer outputFile in workspaces; required only when using inline steps without a file plan."),
        outputFile: stringProperty("Recommended plan result JSON file name inside the initialized file-context workspace."),
      }, ["title"]),
    },
    {
      name: "figma_repl_prepare_task",
      description:
        "Create or reuse an intent-specific .figma.js script and paired .result.json file. Recommended workspace call: { title, cwd, fileUrl|fileKey, intent, expectedSurface }. Alias and override fields are compatibility/advanced only.",
      inputSchema: objectSchema({
        title: titleProperty(),
        sessionId: stringProperty("Local REPL session id. If initialized, files are created under that session file-context workspace."),
        intent: stringProperty("Recommended human intent used to derive <intentSlug>.figma.js and <intentSlug>.result.json."),
        task: stringProperty("Compatibility alias for intent. Prefer intent."),
        goal: stringProperty("Compatibility alias for intent when deriving script/result names. Prefer intent."),
        fileUrl: stringProperty("Recommended Figma file URL used to derive fileKey/file context when preparing a workspace."),
        fileKey: stringProperty("Recommended explicit Figma file key when fileUrl is not available; used as the file-context directory name."),
        fileSlug: stringProperty("Advanced file-context slug override to use when no fileKey is available."),
        cwd: stringProperty("Recommended absolute project directory where the figma-mcp workspace directory will be created."),
        dirName: stringProperty("Advanced workspace directory name under cwd. Defaults to figma-mcp."),
        taskSlug: stringProperty("Advanced stable slug override for the task directory. Defaults from taskName/title."),
        taskName: stringProperty("Advanced human-readable task name used to derive a slug when taskSlug is omitted."),
        taskDir: stringProperty("Advanced absolute task directory override. Preferred public name for workspaceDir."),
        fileName: stringProperty("Advanced script file-name override ending in .figma.js. Preferred public name for scriptName."),
        taskRoot: stringProperty(`Advanced absolute task root for temp task workspaces. Defaults to ${options.taskWorkspaceRootEnv}, then OS temp figma-repl-mcp/tasks.`),
        workspaceDir: stringProperty("Compatibility alias for taskDir. Prefer taskDir only when an absolute workspace override is needed."),
        scriptName: stringProperty("Compatibility alias for fileName. Prefer fileName only when overriding the generated script file name."),
        expectedSurface: enumProperty(["design", "figjam", "slides"], "Recommended expected Figma surface persisted on the session and copied into generated guidance."),
        targetPageId: stringProperty("Optional target page id copied into generated guidance."),
        template: stringProperty("Template hint copied into the generated .figma.js comments. V1 templates are curated guidance only."),
        overwrite: booleanProperty("Advanced destructive overwrite of an existing script/result pair. Defaults false."),
      }, ["title"]),
    },
    {
      name: "figma_repl_guidance",
      description:
        "Return compact guidance, file-workflow planning, curated API cards, or catalog metadata before broader lookup. Prefer task for natural-language intent; intent and goal are aliases.",
      inputSchema: objectSchema({
        title: titleProperty(),
        mode: enumProperty(["guidance", "plan", "card", "catalog"], "Guidance mode. Defaults from card/query/task fields."),
        card: stringProperty(`Card id or topic, for example text.font, layout.auto, components.variants, variables.bind, surface.slides. Hard limit ${options.maxLookupQueryLength} characters.`),
        query: stringProperty(`Search query when card id is not known. Hard limit ${options.maxLookupQueryLength} characters.`),
        task: stringProperty(`Natural-language task intent. Preferred public name for intent. Trimmed and capped to ${options.maxLookupQueryLength} characters for guidance lookup/ranking.`),
        intent: stringProperty(`Alias for task. Natural-language task intent. Trimmed and capped to ${options.maxLookupQueryLength} characters for guidance lookup/ranking.`),
        goal: stringProperty(`Alias for task in guidance or plan mode. Trimmed and capped to ${options.maxLookupQueryLength} characters for guidance lookup/ranking.`),
        surface: enumProperty(["design", "figjam", "slides"], "Expected Figma surface. Preferred public name for expectedSurface."),
        workflow: stringProperty("Preferred workflow for plan mode. Defaults to script-file."),
        expectedSurface: enumProperty(["design", "figjam", "slides"], "Expected Figma surface."),
        maxCards: numberProperty("Maximum cards to return, capped at 8. Defaults to 4."),
      }, ["title"]),
    },
    {
      name: "figma_repl_inspect",
      description:
        "Inspect $selection, $currentPage, a stored handle, or validate cached handles through one read-mode use_figma call. Recommended calls: { title, sessionId, target } or { title, sessionId, mode:\"validate\" }; upstream overrides are debug-only.",
      inputSchema: objectSchema({
        title: titleProperty(),
        sessionId: stringProperty("Local REPL session id. Defaults to 'default'."),
        mode: enumProperty(["inspect", "validate"], "Use inspect for target summaries or validate for cached handle status. Defaults to inspect."),
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
      }, ["title"]),
    },
    {
      name: "figma_repl_call_upstream_tool",
      description:
        "Explicit upstream escape hatch: proxy one official upstream Figma MCP tool call through figma_repl_mcp for capabilities not covered by the file workflow.",
      inputSchema: objectSchema({
        title: titleProperty(),
        sessionId: stringProperty("Optional local session id used only for history. Defaults to 'default'."),
        toolName: stringProperty("Official upstream Figma MCP tool name to call. Local figma_repl_* tools are rejected."),
        arguments: objectProperty("Arguments sent to the upstream official Figma MCP tool."),
        refresh: booleanProperty("Refresh cached upstream tool list before dispatch."),
      }, ["title", "toolName", "arguments"]),
    },
    {
      name: "figma_repl_lookup",
      description:
        "Look up compact docs snippets or targeted Figma Plugin API symbols from the internal corpus. For kind=docs use query; for kind=api use symbol.",
      inputSchema: objectSchema({
        title: titleProperty(),
        kind: enumProperty(["docs", "api"], "Lookup corpus. Use docs for workflow snippets or api for exact Plugin API symbols."),
        query: stringProperty(`Recommended for kind=docs keyword lookup, for example 'component properties' or 'Slides lifecycle'. Hard limit ${options.maxLookupQueryLength} characters.`),
        symbol: stringProperty(`Recommended for kind=api exact Plugin API lookup, for example createFrame, loadFontAsync, VariableCollection. Hard limit ${options.maxLookupQueryLength} characters.`),
        maxResults: numberProperty(`Result-size control only. Maximum results, capped at ${options.maxDocsSearchResults}. Defaults to docs=${options.defaultDocsSearchMaxResults}, api=5.`),
        maxSnippetLines: numberProperty(`Result-size control only. Lines per snippet, capped at ${options.maxDocsSearchSnippetLines}. Defaults to docs=${options.defaultDocsSearchSnippetLines}, api=5.`),
      }, ["title", "kind"]),
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
    upstream: objectProperty("Upstream output envelope with JSON payload or text fallback."),
    upstreamError: objectProperty("Normalized upstream failure details when execution failed."),
    primaryFix: stringProperty("Suggested primary repair when execution failed."),
  }),
  figma_repl_run_script_file: toolOutputSchema({
    dryRun: booleanProperty("Whether the script was only compiled/diagnosed."),
    session: objectProperty("Public local REPL session metadata."),
    diagnostics: arrayProperty("Script and wrapper diagnostics."),
    script: objectProperty("Compiled script metadata."),
    outputFiles: objectProperty("Files written for complete result, diagnostics, summary, or failure-only compiled script."),
    upstreamError: objectProperty("Normalized upstream failure details when execution failed."),
    primaryFix: stringProperty("Suggested primary repair when execution failed."),
    upstream: objectProperty("File-script upstream output envelope with JSON payload or text fallback."),
  }),
  figma_repl_apply_asset_manifest: toolOutputSchema({
    session: objectProperty("Public local REPL session metadata."),
    assets: arrayProperty("Compact per-asset upload/fill results."),
    validation: objectProperty("Optional target validation result."),
    outputFiles: objectProperty("Files written for result output."),
    failures: arrayProperty("Per-asset or validation failures."),
  }),
  figma_repl_capture_node: toolOutputSchema({
    session: objectProperty("Public local REPL session metadata."),
    outputFile: stringProperty("Local output file path when capture succeeded."),
    plannedOutputFile: stringProperty("Local output file path requested when capture failed before writing."),
    nodeId: stringProperty("Captured Figma node id."),
    toolName: stringProperty("Upstream screenshot/capture tool name used."),
    kind: stringProperty("Saved output kind."),
    mimeType: stringProperty("Detected output MIME type."),
    qa: objectProperty("Compact capture QA hints."),
    upstream: objectProperty("Upstream output envelope, compact inline and complete in resultFile when requested."),
    upstreamError: objectProperty("Normalized upstream failure details when capture failed."),
    outputFiles: objectProperty("Files written for result output."),
  }),
  figma_repl_run_task_plan: toolOutputSchema({
    session: objectProperty("Public local REPL session metadata."),
    stopped: booleanProperty("Whether execution stopped before remaining steps."),
    stopOnFailure: booleanProperty("Whether the plan was configured to stop on first failure."),
    steps: arrayProperty("Compact per-step execution summaries."),
    outputReferences: objectProperty("Plan-level map of step id to output file pointers for later workflow references."),
    outputFiles: objectProperty("Files written for plan result output."),
    failures: arrayProperty("Failed task-plan steps."),
  }),
  figma_repl_prepare_task: toolOutputSchema({
    task: objectProperty("Prepared task workspace and script/result files."),
    session: objectProperty("Public local REPL session metadata."),
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
    suggestions: objectProperty("Ranked intent/card suggestions with compact context."),
  }),
  figma_repl_inspect: toolOutputSchema({
    session: objectProperty("Public local REPL session metadata."),
    diagnostics: arrayProperty("Read-mode diagnostics."),
    upstream: objectProperty("Upstream output envelope with JSON payload or text fallback."),
    upstreamError: objectProperty("Normalized upstream failure details when inspection failed."),
    primaryFix: stringProperty("Suggested primary repair when inspection failed."),
  }),
  figma_repl_call_upstream_tool: toolOutputSchema({
    session: objectProperty("Public local REPL session metadata."),
    toolName: stringProperty("Upstream official Figma MCP tool name called."),
    upstream: objectProperty("Upstream output envelope with JSON payload or text fallback."),
    upstreamError: objectProperty("Normalized upstream failure details when execution failed."),
    primaryFix: stringProperty("Suggested primary repair when execution failed."),
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
  return stringProperty("Human-readable title used when presenting output to the user.");
}

function stringProperty(description: string): Record<string, unknown> {
  return { type: "string", description };
}

function booleanProperty(description: string): Record<string, unknown> {
  return { type: "boolean", description };
}

function numberProperty(description: string): Record<string, unknown> {
  return { type: "number", description };
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
