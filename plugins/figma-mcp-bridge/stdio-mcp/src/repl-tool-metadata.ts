import {
  LOCAL_REPL_TOOL_NAMES,
  isLocalReplToolName,
} from "./repl-tool-registry.js";

export type ReplToolDescriptionOptions = {
  taskWorkspaceRootEnv: string;
  defaultDocsSearchMaxResults: number;
  maxDocsSearchResults: number;
  defaultDocsSearchSnippetLines: number;
  maxDocsSearchSnippetLines: number;
};

export function createReplToolDescriptions(
  options: ReplToolDescriptionOptions,
): Record<string, unknown>[] {
  const tools: Record<string, unknown>[] = [
    {
      name: "figma_repl_capabilities",
      description:
        "Return the compact unified facade guide, file workflow, docs/API lookup workflow, safety policy, routing/delegation boundaries, and examples for figma-repl-mcp.",
      inputSchema: objectSchema({
        title: titleProperty(),
      }, ["title"]),
    },
    {
      name: "figma_repl_open",
      description:
        "Create or update a local Figma REPL session. Records fileKey/surface/page context, local handles, and upstream use_figma settings.",
      inputSchema: objectSchema({
        title: titleProperty(),
        sessionId: stringProperty("Stable local session id. Defaults to 'default'."),
        label: stringProperty("Human-readable session label."),
        fileUrl: stringProperty("Optional Figma file URL stored in local session metadata."),
        expectedSurface: enumProperty(["design", "figjam", "slides"], "Expected Figma surface; blocks mismatched Design/FigJam/Slides usage later."),
        currentPageId: stringProperty("Optional current Figma page id stored in local session metadata."),
        reset: booleanProperty("Reset local handles and history for this session before opening."),
        connect: booleanProperty("Connect to upstream Figma MCP during open. Defaults to true."),
        refresh: booleanProperty("Refresh cached upstream tool list."),
        upstreamTool: stringProperty("Override upstream eval tool name. Defaults to use_figma."),
        upstreamArgument: stringProperty("Override upstream JavaScript argument name. Usually code."),
        upstreamArguments: objectProperty("Extra arguments merged into every upstream eval call for this session."),
        handles: objectProperty("Initial local handles, for example {\"$header\": \"12:34\"}."),
      }, ["title"]),
    },
    {
      name: "figma_repl_eval",
      description:
        "Run one batched JavaScript transaction through upstream use_figma. Diagnostics block unsafe API-contract/read-mode/surface mistakes before dispatch.",
      inputSchema: objectSchema({
        title: titleProperty(),
        sessionId: stringProperty("Local REPL session id. Defaults to 'default'."),
        code: stringProperty("JavaScript body executed inside an async function in the Figma Plugin API context. Use return to send structured output."),
        mode: enumProperty(["read", "write"], "Use read to reject likely mutations before dispatch. Defaults to write."),
        expectedSurface: enumProperty(["design", "figjam", "slides"], "Expected Figma surface for this call."),
        returnMode: enumProperty(["auto", "json", "text", "raw"], "Controls how much parsed/text upstream output is returned."),
        allowDangerousOperations: booleanProperty("Allow dynamic/destructive guarded patterns only; does not bypass API contract, surface, or read-mode diagnostics."),
        upstreamTool: stringProperty("Override upstream eval tool name for this call."),
        upstreamArgument: stringProperty("Override upstream JavaScript argument name for this call."),
        upstreamArguments: objectProperty("Extra arguments sent to the upstream tool for this call."),
        handleUpdates: objectProperty("Local handle updates merged before running code."),
        includeRawUpstream: booleanProperty("Include raw upstream MCP result in the response."),
      }, ["title", "code"]),
    },
    {
      name: "figma_repl_run_script_file",
      description:
        "Primary file-based JavaScript workflow for Figma REPL. Reads an absolute scriptPath or a session-workspace inputFile, injects $ helpers, writes output files, and optionally executes through upstream use_figma.",
      inputSchema: objectSchema({
        title: titleProperty(),
        sessionId: stringProperty("Local REPL session id or task name. Defaults to 'default'."),
        scriptPath: stringProperty("Absolute path to a local JavaScript file. Prefer inputFile after figma_repl_init_workspace."),
        inputFile: stringProperty("File name inside the initialized file-context directory. Defaults are created by figma_repl_prepare_task."),
        helperProfile: enumProperty(["auto", "minimal", "asset", "clone", "full"], "Controls injected $ helper size. auto injects heavy $.imageAsset/$.cloneNodeTree only when the script source uses them."),
        dryRun: booleanProperty("Read, diagnose, inject helpers, and return compiledScript/script metadata without calling upstream Figma."),
        strict: booleanProperty("Promote warning diagnostics to fatal and reject before upstream execution."),
        expectedSurface: enumProperty(["design", "figjam", "slides"], "Expected Figma surface for this script."),
        targetPageId: stringProperty("Optional PAGE node id used for one setCurrentPageAsync call before the script body runs."),
        allowDangerousOperations: booleanProperty("Allow dynamic/destructive guarded patterns only after reviewing the exact file."),
        upstreamTool: stringProperty("Override upstream eval tool name for this call."),
        upstreamArgument: stringProperty("Override upstream JavaScript argument name for this call."),
        upstreamArguments: objectProperty("Extra arguments sent to the upstream tool for this call."),
        includeRawUpstream: booleanProperty("Include raw upstream MCP result in the response."),
        outputDir: stringProperty("Advanced absolute directory escape hatch for split result.json, diagnostics.json, and summary.md output files."),
        outputFile: stringProperty("File name inside the initialized file-context directory. Defaults to the input script basename plus .result.json."),
        resultFile: stringProperty("Advanced absolute file path, outputDir-relative JSON path, or file-context file name for full result output."),
        diagnosticsFile: stringProperty("Advanced optional absolute file path or outputDir-relative JSON path when diagnostics should be split out of the paired result file."),
        summaryFile: stringProperty("Advanced optional absolute file path or outputDir-relative Markdown path when a separate summary is needed."),
        inlineResultLimit: numberProperty("Non-negative byte cap for large inline result fields. Use the paired result file for full payloads."),
      }, ["title"]),
    },
    {
      name: "figma_repl_apply_asset_manifest",
      description:
        "Apply a local asset manifest to Figma target nodes through configurable upstream asset/upload tools. Use for large generated images after .figma.js creates target rectangles.",
      inputSchema: objectSchema({
        title: titleProperty(),
        sessionId: stringProperty("Local REPL session id used for history. Defaults to 'default'."),
        manifestPath: stringProperty("Path to a JSON manifest. Accepts an absolute path or a file name inside the initialized file-context workspace. It may be an array of assets or an object with assets/toolName/argumentsTemplate."),
        assets: {
          type: "array",
          description: "Inline asset entries: { path|filePath|localPath, targetNodeId|nodeId, name?, metadata?, toolName?, arguments? }.",
          items: { type: "object", additionalProperties: true },
        },
        toolName: stringProperty("Default upstream asset/upload/fill tool. If omitted, the REPL selects an advertised asset-like tool and infers args only from recognizable schema fields."),
        arguments: objectProperty("Default upstream arguments template. Use {{path}}, {{targetNodeId}}, {{name}}, {{metadata.foo}}, or {{asset}} placeholders."),
        argumentsTemplate: objectProperty("Alias for arguments. Prefer this when mirroring fake or upstream schemas explicitly."),
        validateTargets: booleanProperty("Defaults true. When upstream eval is available, verify target nodes have IMAGE fills after upload."),
        refresh: booleanProperty("Refresh cached upstream tool list before dispatch."),
        resultFile: stringProperty("Optional compact manifest result JSON. Accepts an absolute path or a file name inside the initialized file-context workspace."),
        outputFile: stringProperty("Alias for resultFile."),
        inlineResultLimit: numberProperty("Reserved for compatibility with compact-result workflows; manifest responses are already compact."),
      }, ["title"]),
    },
    {
      name: "figma_repl_capture_node",
      description:
        "Capture one Figma node through a configurable upstream screenshot tool and save image bytes, screenshot URL payloads, or text responses to a local outputFile for final visual QA.",
      inputSchema: objectSchema({
        title: titleProperty(),
        sessionId: stringProperty("Local REPL session id used for history. Defaults to 'default'."),
        nodeId: stringProperty("Figma node id to capture."),
        targetNodeId: stringProperty("Alias for nodeId."),
        outputFile: stringProperty("Local file path where the screenshot image, downloaded URL payload, or text response is written. Accepts an absolute path or a file name inside the initialized file-context workspace."),
        resultFile: stringProperty("Optional compact capture metadata JSON. Accepts an absolute path or a file name inside the initialized file-context workspace."),
        toolName: stringProperty("Upstream screenshot/capture tool. If omitted, the REPL selects an advertised screenshot-like tool and infers node id only from recognizable schema fields."),
        arguments: objectProperty("Upstream arguments template. Use {{nodeId}} or {{targetNodeId}} placeholders."),
        argumentsTemplate: objectProperty("Alias for arguments."),
        refresh: booleanProperty("Refresh cached upstream tool list before dispatch."),
        inlineResultLimit: numberProperty("Reserved for compatibility with compact-result workflows; capture responses return only file metadata."),
      }, ["title", "outputFile"]),
    },
    {
      name: "figma_repl_run_task_plan",
      description:
        "Run a sequential local JSON task plan: script-file dryRun/execute, asset manifest application, screenshot capture, and generic upstream tool calls. Stops on first failure by default.",
      inputSchema: objectSchema({
        title: titleProperty(),
        sessionId: stringProperty("Default local REPL session id inherited by steps when omitted."),
        planPath: stringProperty("JSON plan path. Accepts an absolute path or a file name inside the initialized file-context workspace. It may be an array of steps or an object with steps."),
        steps: {
          type: "array",
          description: "Inline steps. Supported type/tool values: script-file, asset-manifest, screenshot-capture, upstream-tool.",
          items: { type: "object", additionalProperties: true },
        },
        stopOnFailure: booleanProperty("Stop after the first failed step. Defaults true."),
        resultFile: stringProperty("JSON result file. Accepts an absolute path or a file name inside the initialized file-context workspace. Defaults to <planPath>.result.json for file plans; required for inline plans."),
        outputFile: stringProperty("Alias for resultFile."),
        inlineResultLimit: numberProperty("Reserved for compatibility with compact-result workflows; plan responses are compact per-step statuses."),
      }, ["title"]),
    },
    {
      name: "figma_repl_init_workspace",
      description:
        "Initialize a file-context workspace at <cwd>/<dirName>/<fileKey-or-fileSlug>. Input .figma.js files and paired .result.json outputs live in that same folder.",
      inputSchema: objectSchema({
        title: titleProperty(),
        sessionId: stringProperty("Local REPL session id. Also used as the intent source after intent/task/title."),
        intent: stringProperty("Human intent used to derive <intentSlug>.figma.js and <intentSlug>.result.json."),
        task: stringProperty("Alias for intent."),
        fileUrl: stringProperty("Figma file URL used to derive fileKey and surface/file context."),
        fileKey: stringProperty("Explicit Figma file key used as the file-context directory name."),
        fileSlug: stringProperty("File-context slug to use when no fileKey is available."),
        cwd: stringProperty("Absolute project directory where the figma-mcp workspace directory will be created."),
        dirName: stringProperty("Workspace directory name under cwd. Defaults to figma-mcp."),
        overwrite: booleanProperty("Reserved for compatibility; directories are created idempotently."),
      }, ["title", "cwd"]),
    },
    {
      name: "figma_repl_prepare_task",
      description:
        "Create or reuse an intent-specific .figma.js script and paired .result.json file in the file-context workspace.",
      inputSchema: objectSchema({
        title: titleProperty(),
        sessionId: stringProperty("Local REPL session id. If initialized, files are created under that session file-context workspace."),
        intent: stringProperty("Human intent used to derive <intentSlug>.figma.js and <intentSlug>.result.json."),
        task: stringProperty("Alias for intent."),
        fileUrl: stringProperty("Figma file URL used to derive fileKey/file context when preparing a workspace."),
        fileKey: stringProperty("Explicit Figma file key used as the file-context directory name."),
        fileSlug: stringProperty("File-context slug to use when no fileKey is available."),
        goal: stringProperty("Task goal copied into the generated .figma.js file and pending .result.json metadata."),
        taskSlug: stringProperty("Stable slug for the task directory. Defaults from taskName/title."),
        taskName: stringProperty("Human-readable task name used to derive a slug when taskSlug is omitted."),
        taskDir: stringProperty("Absolute task directory override. Preferred public name for workspaceDir."),
        fileName: stringProperty("File name ending in .figma.js. Preferred public name for scriptName."),
        taskRoot: stringProperty(`Absolute task root. Defaults to ${options.taskWorkspaceRootEnv}, then OS temp figma-repl-mcp/tasks.`),
        workspaceDir: stringProperty("Alias for taskDir. Absolute workspace directory override."),
        scriptName: stringProperty("Alias for fileName. File name ending in .figma.js. Defaults to <slug>.figma.js."),
        expectedSurface: enumProperty(["design", "figjam", "slides"], "Expected Figma surface persisted on the session and copied into generated guidance."),
        targetPageId: stringProperty("Optional target page id copied into generated guidance."),
        template: stringProperty("Template hint copied into the generated .figma.js comments. V1 templates are curated guidance only."),
        overwrite: booleanProperty("Overwrite existing script/result pair. Defaults false."),
      }, ["title"]),
    },
    {
      name: "figma_repl_plan_task",
      description:
        "Return compact planning guidance for the preferred .figma.js file workflow without reading or writing files.",
      inputSchema: objectSchema({
        title: titleProperty(),
        goal: stringProperty("Natural-language task goal. Preferred public name for task/intent."),
        surface: enumProperty(["design", "figjam", "slides"], "Expected Figma surface. Preferred public name for expectedSurface."),
        workflow: stringProperty("Preferred workflow. Defaults to script-file."),
        task: stringProperty("Short task description."),
        intent: stringProperty("Intent phrase used to suggest compact API cards."),
        expectedSurface: enumProperty(["design", "figjam", "slides"], "Expected Figma surface."),
      }, ["title"]),
    },
    {
      name: "figma_repl_guidance",
      description:
        "Combine natural-language intent routing with curated compact API card lookup before broader docs/API search.",
      inputSchema: objectSchema({
        title: titleProperty(),
        card: stringProperty("Card id or topic, for example text.font, layout.auto, components.variants, variables.bind, surface.slides."),
        query: stringProperty("Search query when card id is not known."),
        task: stringProperty("Natural-language task intent. Preferred public name for intent."),
        intent: stringProperty("Natural-language task intent, for example 'create a card with text and auto layout'."),
        surface: enumProperty(["design", "figjam", "slides"], "Expected Figma surface. Preferred public name for expectedSurface."),
        expectedSurface: enumProperty(["design", "figjam", "slides"], "Expected Figma surface."),
        maxCards: numberProperty("Maximum cards to return, capped at 8. Defaults to 4."),
      }, ["title"]),
    },
    {
      name: "figma_repl_inspect",
      description:
        "Inspect $selection, $currentPage, a stored handle, or a Figma node id through one read-mode use_figma call.",
      inputSchema: objectSchema({
        title: titleProperty(),
        sessionId: stringProperty("Local REPL session id. Defaults to 'default'."),
        target: stringProperty("$selection, $currentPage, a stored handle like $header, or a raw node id. Defaults to $selection."),
        depth: numberProperty("Child summary depth. Defaults to 2."),
        upstreamTool: stringProperty("Override upstream eval tool name for this call."),
        upstreamArgument: stringProperty("Override upstream JavaScript argument name for this call."),
        upstreamArguments: objectProperty("Extra arguments sent to the upstream tool for this call."),
      }, ["title"]),
    },
    {
      name: "figma_repl_cache_get",
      description:
        "Return local REPL sessions, handles, recent command history, fileKey/surface/page context, and last diagnostics without calling Figma.",
      inputSchema: objectSchema({
        title: titleProperty(),
        sessionId: stringProperty("Optional session id to return."),
        includeHistory: booleanProperty("Include command history. Defaults to true."),
        historyLimit: numberProperty("Maximum history entries to return."),
      }, ["title"]),
    },
    {
      name: "figma_repl_validate_handles",
      description:
        "Resolve cached handles or raw node ids through one read-mode upstream eval and report valid, missing, or stale handles.",
      inputSchema: objectSchema({
        title: titleProperty(),
        sessionId: stringProperty("Local REPL session id. Defaults to 'default'."),
        handles: {
          type: "array",
          description: "Optional handle names or raw node ids to validate. Defaults to all cached handles.",
          items: { type: "string" },
        },
        upstreamTool: stringProperty("Override upstream eval tool name for this call."),
        upstreamArgument: stringProperty("Override upstream JavaScript argument name for this call."),
        upstreamArguments: objectProperty("Extra arguments sent to the upstream tool for this call."),
      }, ["title"]),
    },
    {
      name: "figma_repl_list_upstream_tools",
      description:
        "List tools exposed by the upstream official Figma MCP server through the shared OAuth-backed remote client.",
      inputSchema: objectSchema({
        title: titleProperty(),
        refresh: booleanProperty("Refresh cached upstream tool list."),
      }, ["title"]),
    },
    {
      name: "figma_repl_call_upstream_tool",
      description:
        "Proxy one official upstream Figma MCP tool call through figma-repl-mcp so agents can stay on the unified REPL facade for capabilities not covered by the file workflow.",
      inputSchema: objectSchema({
        title: titleProperty(),
        sessionId: stringProperty("Optional local session id used only for history. Defaults to 'default'."),
        toolName: stringProperty("Official upstream Figma MCP tool name to call. Local figma_repl_* tools are rejected."),
        arguments: objectProperty("Arguments sent to the upstream official Figma MCP tool."),
        refresh: booleanProperty("Refresh cached upstream tool list before dispatch."),
        includeRawUpstream: booleanProperty("Include the raw upstream MCP result as raw."),
      }, ["title", "toolName", "arguments"]),
    },
    {
      name: "figma_repl_docs_search",
      description:
        "Search compact, capped snippets from the internal Figma corpus.",
      inputSchema: objectSchema({
        title: titleProperty(),
        query: stringProperty("Keyword query, for example 'component properties' or 'Slides lifecycle'."),
        maxResults: numberProperty(`Maximum results, capped at ${options.maxDocsSearchResults}. Defaults to ${options.defaultDocsSearchMaxResults}.`),
        maxSnippetLines: numberProperty(`Lines per snippet, capped at ${options.maxDocsSearchSnippetLines}. Defaults to ${options.defaultDocsSearchSnippetLines}.`),
      }, ["title", "query"]),
    },
    {
      name: "figma_repl_api_lookup",
      description:
        "Look up a targeted Figma Plugin API symbol in the local API index/reference/d.ts snippets without dumping the full declaration file.",
      inputSchema: objectSchema({
        title: titleProperty(),
        symbol: stringProperty("Figma Plugin API symbol or method name, for example createFrame, loadFontAsync, VariableCollection."),
        maxResults: numberProperty(`Maximum results, capped at ${options.maxDocsSearchResults}. Defaults to 5.`),
        maxSnippetLines: numberProperty(`Lines per snippet, capped at ${options.maxDocsSearchSnippetLines}. Defaults to 5.`),
      }, ["title", "symbol"]),
    },
  ];
  return assertLocalReplToolDescriptions(tools);
}

function assertLocalReplToolDescriptions(tools: Record<string, unknown>[]): Record<string, unknown>[] {
  const descriptionNames = new Set<string>();
  for (const tool of tools) {
    if (typeof tool.name !== "string") {
      throw new Error("Local figma-repl-mcp tool description is missing a string name.");
    }
    descriptionNames.add(tool.name);
    if (!isLocalReplToolName(tool.name)) {
      throw new Error(`Local figma-repl-mcp tool description is not in the registry: ${tool.name}`);
    }
  }
  for (const name of LOCAL_REPL_TOOL_NAMES) {
    if (!descriptionNames.has(name)) {
      throw new Error(`Local figma-repl-mcp registry tool is missing a description: ${name}`);
    }
  }
  return tools;
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

function enumProperty(values: string[], description: string): Record<string, unknown> {
  return { type: "string", enum: values, description };
}
