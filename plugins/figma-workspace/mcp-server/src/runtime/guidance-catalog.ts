export type FigmaWorkspaceApiCardSurface = "design" | "figjam" | "slides" | "any";

export interface FigmaWorkspaceApiCard {
  id: string;
  title: string;
  intents: string[];
  surface: FigmaWorkspaceApiCardSurface;
  helpers: string[];
  pluginApi: string[];
  apiSymbols: string[];
  queryHints: string[];
  avoid: string[];
  pitfalls: string[];
}

export interface FigmaWorkspaceWrapperLookupProfile {
  tool: string;
  upstreamTool: string;
  workflowIds: string[];
  intents: string[];
  docsQueries: string[];
  apiSymbols: string[];
  suggestedTools: string[];
  nextSteps: string[];
}

export interface FigmaWorkspaceWrapperWorkflow {
  id: string;
  title: string;
  intents: string[];
  tools: string[];
  sequence: string[];
  guardrails: string[];
}

export interface FigmaWorkspaceHelperCategory {
  id: string;
  title: string;
  helpers: string[];
  lookupHints: string[];
}

export interface FigmaWorkspaceHelperProfile {
  id: string;
  category: string;
  helpers: string[];
  useWhen: string[];
  avoidWhen: string[];
  allowedPatterns: string[];
  forbiddenPatterns: string[];
  apiSymbols: string[];
  lookupHints: string[];
  example?: string;
}

export const FIGMA_WORKSPACE_QUERY_SEARCH_ANCHORS = [
  "text/font",
  "auto layout",
  "variables/tokens",
  "styles",
  "components/variants",
  "instances/properties",
  "images/fills",
  "selection",
  "capture/QA",
  "implementation/parity",
  "Code Connect",
  "FigJam/Slides",
];

export const FIGMA_WORKSPACE_QUERY_OUTPUT_FIELDS = [
  "recommendedCards",
  "queryHints",
  "apiSymbols",
  "guardrails",
  "suggestions.referenceContext",
];

export const FIGMA_WORKSPACE_COMMON_TASK_LABELS = [
  "font-safe text edits",
  "auto-layout UI construction",
  "variable binding",
  "style application",
  "component variants",
  "instance properties",
  "generated image fills",
  "screenshot QA",
  "Figma-to-code implementation",
  "motion implementation",
  "design parity review",
  "Code Connect templates",
  "FigJam board work",
  "Slides deck work",
];

export const FIGMA_WORKSPACE_INTENT_EXAMPLE_QUERIES = [
  "create UI card with auto layout and text",
  "make component variants",
  "update color token",
  "implement selected Figma node in app code",
  "implement animation from Figma motion context",
  "review implementation against Figma screenshot",
  "create Code Connect template for component",
];

export const FIGMA_WORKSPACE_HELPER_HARD_RULES = [
  "Use static helper references only: $.text(...), $[\"text\"](...), or explicit destructuring such as const { text } = $.",
  "Do not use dynamic $[name], alias $, object rest destructuring, or local $ declarations; helper injection must be statically knowable.",
  "Native Figma Plugin API calls remain valid for advanced work when helpers are too narrow.",
  "$.imageAsset is only for small inline PNG/JPEG payloads; use asset manifest/upload flow for larger files.",
];

export const FIGMA_WORKSPACE_HELPER_CATEGORIES: FigmaWorkspaceHelperCategory[] = [
  { id: "selection", title: "Selection and inspection", helpers: ["$.find", "$.findAll", "$.select", "$.inspect"], lookupHints: ["selection helper", "find node scoped", "inspect cached handle"] },
  { id: "text", title: "Text", helpers: ["$.text"], lookupHints: ["text font helper", "loadFontAsync text"] },
  { id: "layout", title: "Layout and placement", helpers: ["$.create", "$.layout", "$.placeNode", "$.findFreeSlot"], lookupHints: ["auto layout helper", "place node free slot"] },
  { id: "assets", title: "Assets", helpers: ["$.imageAsset"], lookupHints: ["image fill helper", "asset manifest upload_assets"] },
  { id: "capture", title: "Capture and QA", helpers: ["$.screenshot"], lookupHints: ["screenshot helper", "capture node QA"] },
  { id: "repair", title: "Repair handles", helpers: ["$.checkpoint", "$.remember", "$.forget"], lookupHints: ["checkpoint handles", "remember forget handles"] },
  { id: "clone", title: "Clone and rebuild", helpers: ["$.cloneNodeTree", "$.replaceGeneratedFrame"], lookupHints: ["clone node tree", "replace generated frame"] },
];

export const FIGMA_WORKSPACE_HELPER_PROFILES: FigmaWorkspaceHelperProfile[] = [
  {
    id: "selection",
    category: "selection",
    helpers: ["$.find", "$.findAll", "$.select", "$.inspect"],
    useWhen: ["Find scoped nodes by name/type.", "Select or inspect cached handles during repair loops."],
    avoidWhen: ["Root-wide scans in large files.", "Direct selection mutation when $.select can validate targets."],
    allowedPatterns: ["await $.find({ name, type, within, as })", "await $[\"inspect\"](\"$hero\")", "const { find, select } = $"],
    forbiddenPatterns: ["$[helperName](...)", "const helper = $", "const { find, ...rest } = $", "const $ = {}"],
    apiSymbols: ["figma.currentPage.selection", "ChildrenMixin.findAll", "figma.getNodeByIdAsync"],
    lookupHints: ["find one scoped node", "select remembered handle", "inspect cached handle"],
    example: "const node = await $.find({ name: \"Hero\", type: \"FRAME\", as: \"$hero\" }); await $.select([node]);",
  },
  {
    id: "text",
    category: "text",
    helpers: ["$.text"],
    useWhen: ["Create or update text with helper-managed font loading.", "Remember text nodes for follow-up edits."],
    avoidWhen: ["Changing TextNode.characters manually before loading fonts.", "Guessing unavailable font family/style pairs."],
    allowedPatterns: ["await $.text({ parent, text, font, as })", "const { text } = $"],
    forbiddenPatterns: ["$[name](...)", "const helpers = $", "const { text, ...rest } = $", "const $ = {}"],
    apiSymbols: ["figma.createText", "figma.loadFontAsync", "TextNode.characters", "TextNode.fontName"],
    lookupHints: ["text font loadFontAsync", "create text node", "set characters safely"],
    example: "await $.text({ parent: \"$card\", text: \"Settings\", font: { family: \"Inter\", style: \"Bold\", size: 20 }, as: \"$title\" });",
  },
  {
    id: "layout",
    category: "layout",
    helpers: ["$.create", "$.layout", "$.placeNode", "$.findFreeSlot"],
    useWhen: ["Create common design nodes with size, layout, appearance, and handles.", "Place generated nodes in predictable non-overlapping slots."],
    avoidWhen: ["Applying auto layout to unsupported node types.", "Absolute placement for content that should be auto layout."],
    allowedPatterns: ["await $.create({ type, parent, size, layout, appearance, as })", "await $.layout(\"$frame\", { layoutMode: \"VERTICAL\" })", "await $.placeNode({ node, parent, placement: \"right\" })"],
    forbiddenPatterns: ["dynamic helper lookup", "local $ declarations"],
    apiSymbols: ["figma.createFrame", "figma.createRectangle", "AutoLayoutMixin.layoutMode", "SceneNode.resize"],
    lookupHints: ["auto layout frame", "create frame helper", "place node free slot"],
    example: "await $.create({ type: \"FRAME\", parent: \"$currentPage\", size: { width: 320, height: 180 }, layout: { layoutMode: \"VERTICAL\" }, as: \"$panel\" });",
  },
  {
    id: "assets",
    category: "assets",
    helpers: ["$.imageAsset"],
    useWhen: ["Apply a small inline PNG/JPEG base64 or byte array as an image fill.", "Create a quick image-fill rectangle during a compact script."],
    avoidWhen: ["Large local assets or generated files.", "Slides upload paths or payloads likely to exceed MCP limits."],
    allowedPatterns: ["await $.imageAsset({ base64, parent, size, position, as })", "create rectangles first, then figma_workspace_apply_asset_manifest for large files"],
    forbiddenPatterns: ["large base64 payloads in $.imageAsset", "using $.imageAsset instead of upload_assets for local files"],
    apiSymbols: ["figma.createImage", "Image.hash", "ImagePaint", "MinimalFillsMixin.fills"],
    lookupHints: ["image fill helper", "asset manifest upload_assets", "create image fill"],
    example: "await $.imageAsset({ base64, parent: \"$card\", size: { width: 160, height: 90 }, as: \"$preview\" });",
  },
  {
    id: "capture",
    category: "capture",
    helpers: ["$.screenshot"],
    useWhen: ["Capture opportunistic screenshot bytes from a script for a node that supports node.screenshot().", "Collect quick visual evidence inside a repairable script."],
    avoidWhen: ["Final visual QA that needs a local PNG path.", "Assuming inline MCP media can be visually inspected by the agent."],
    allowedPatterns: ["const bytes = await $.screenshot(\"$hero\", { format: \"PNG\" })", "const { screenshot } = $"],
    forbiddenPatterns: ["dynamic helper lookup", "using $.screenshot when figma_workspace_capture_node should write a PNG file"],
    apiSymbols: ["SceneNode.screenshot", "ExportSettingsImage", "figma_workspace_capture_node"],
    lookupHints: ["capture node screenshot", "write screenshot to imageFile", "visual QA warnings"],
    example: "const screenshotBytes = Array.from(await $.screenshot(\"$hero\", { format: \"PNG\" }));",
  },
  {
    id: "repair",
    category: "repair",
    helpers: ["$.checkpoint", "$.remember", "$.forget"],
    useWhen: ["Return compact node summaries and handles after meaningful milestones.", "Store or remove stable handles across reruns."],
    avoidWhen: ["Using a handle string as the checkpoint name.", "Returning huge node trees instead of bounded summaries."],
    allowedPatterns: ["await $.checkpoint(\"after-layout\", [\"$panel\"], { depth: 1 })", "await $.remember(\"$panel\", node)", "await $.forget(\"$old\")"],
    forbiddenPatterns: ["$.checkpoint(\"$panel\") as a target shortcut", "dynamic helper lookup"],
    apiSymbols: ["figma.currentPage", "BaseNode.id"],
    lookupHints: ["checkpoint handles", "remember node handle", "repairPlan handles"],
    example: "return await $.checkpoint(\"panel-ready\", [\"$panel\"], { depth: 1 });",
  },
  {
    id: "clone",
    category: "clone",
    helpers: ["$.cloneNodeTree", "$.replaceGeneratedFrame"],
    useWhen: ["Copy an existing node tree beside itself while preserving instance subtrees.", "Replace guarded generated frames by exact name during repair workflows."],
    avoidWhen: ["Rebuilding internal children of InstanceNode.", "Deleting arbitrary user-authored frames."],
    allowedPatterns: ["await $.cloneNodeTree({ source: \"$card\", placement: \"right\", as: \"$copy\" })", "await $.replaceGeneratedFrame({ name, replacement })"],
    forbiddenPatterns: ["raw remove() for generated-frame swaps", "$.replaceGeneratedFrame without guarded name"],
    apiSymbols: ["SceneNode.clone", "ChildrenMixin.appendChild", "BaseNodeMixin.remove"],
    lookupHints: ["clone node tree", "preserve instance subtree", "replace generated frame"],
    example: "const copy = await $.cloneNodeTree({ source: \"$card\", placement: \"right\", as: \"$cardCopy\" });",
  },
];

export const FIGMA_WORKSPACE_WRAPPER_LOOKUP_PROFILES: FigmaWorkspaceWrapperLookupProfile[] = [
  {
    tool: "figma_workspace_get_design_context",
    upstreamTool: "get_design_context",
    workflowIds: ["design-implementation-context"],
    intents: ["implementation", "design context", "handoff", "parity", "swiftui"],
    docsQueries: ["get design context implementation", "design parity review", "swiftui design context"],
    apiSymbols: ["get_design_context", "figma_workspace_get_design_context"],
    suggestedTools: ["figma_workspace_get_motion_context", "figma_workspace_capture_node", "figma_workspace_lookup"],
    nextSteps: [
      "Use upstream.result as official reference context, then adapt to project components and tokens.",
      "Capture the target node when visual QA or parity review needs evidence.",
    ],
  },
  {
    tool: "figma_workspace_get_motion_context",
    upstreamTool: "get_motion_context",
    workflowIds: ["motion-implementation"],
    intents: ["motion", "animation", "keyframes", "timeline"],
    docsQueries: ["motion context implementation", "motion keyframes gotchas", "recursive motion context"],
    apiSymbols: ["get_motion_context", "figma_workspace_get_motion_context"],
    suggestedTools: ["figma_workspace_get_design_context", "figma_workspace_export_video", "figma_workspace_lookup"],
    nextSteps: [
      "Pair motion data with design context for the same node before coding animation.",
      "Preserve upstream timing, easing, and transform-origin values as authoritative motion data.",
    ],
  },
  {
    tool: "figma_workspace_export_video",
    upstreamTool: "export_video",
    workflowIds: ["motion-implementation", "video-export"],
    intents: ["video", "export", "motion preview", "frame sampling", "poll"],
    docsQueries: ["export video jobId poll", "motion fallback video export"],
    apiSymbols: ["export_video", "figma_workspace_export_video"],
    suggestedTools: ["figma_workspace_get_motion_context", "figma_workspace_get_design_context"],
    nextSteps: [
      "Start an export with target only when frame sampling is worth the render cost.",
      "Poll an existing job with jobId instead of starting duplicate renders.",
    ],
  },
];

export const FIGMA_WORKSPACE_WRAPPER_WORKFLOW_GRAPH: FigmaWorkspaceWrapperWorkflow[] = [
  {
    id: "design-implementation-context",
    title: "Design implementation context",
    intents: ["implementation", "handoff", "parity", "swiftui"],
    tools: ["figma_workspace_get_design_context", "figma_workspace_capture_node", "figma_workspace_lookup"],
    sequence: [
      "Open or prepare a session with file context.",
      "Call figma_workspace_get_design_context for the target node.",
      "Capture the node when visual evidence is needed.",
      "Use lookup only for missing framework, API, or workflow details.",
    ],
    guardrails: ["Do not copy generated code verbatim without adapting it to the project.", "Do not derive bridge-owned fields from upstream.result."],
  },
  {
    id: "motion-implementation",
    title: "Motion implementation",
    intents: ["motion", "animation", "keyframes", "video"],
    tools: ["figma_workspace_get_design_context", "figma_workspace_get_motion_context", "figma_workspace_export_video"],
    sequence: [
      "Read design context for structure and assets.",
      "Read motion context for animated-node inventory and keyframes.",
      "Export or poll video only when frame sampling is needed.",
    ],
    guardrails: ["Preserve upstream motion values as authoritative.", "Poll with jobId instead of starting duplicate exports."],
  },
];

export const FIGMA_WORKSPACE_API_CARDS: FigmaWorkspaceApiCard[] = [
  {
    id: "nodes",
    title: "Create and update Design nodes",
    intents: ["create", "frame", "rectangle", "ui", "layout"],
    surface: "design",
    helpers: ["$.create", "$.checkpoint"],
    pluginApi: ["figma.createFrame", "figma.createRectangle", "resize", "appendChild"],
    apiSymbols: ["figma.createFrame", "figma.createRectangle", "SceneNode.resize", "ChildrenMixin.appendChild"],
    queryHints: ["create frame or rectangle", "resize node before layout", "append child to frame"],
    avoid: ["Root-wide construction without handles", "Changing layout-sensitive size after applying auto layout"],
    pitfalls: ["Set size before auto-layout if fixed dimensions matter.", "Remember handles with `as` for later repair."],
  },
  {
    id: "text.font",
    title: "Text and font-safe edits",
    intents: ["text", "font", "copy", "label", "typography"],
    surface: "design",
    helpers: ["$.text", "figma_workspace_lookup(kind=api)"],
    pluginApi: ["figma.createText", "figma.loadFontAsync", "TextNode.characters"],
    apiSymbols: ["figma.createText", "figma.loadFontAsync", "TextNode.characters", "TextNode.fontName"],
    queryHints: ["load font before changing text", "create text node", "set characters safely"],
    avoid: ["Changing TextNode.characters before loadFontAsync", "Guessing unavailable font style names"],
    pitfalls: ["Always load the target font before changing characters or fontName.", "Use text styles for reusable typography."],
  },
  {
    id: "layout.auto",
    title: "Auto layout",
    intents: ["layout", "spacing", "padding", "stack", "responsive"],
    surface: "design",
    helpers: ["$.layout", "$.create"],
    pluginApi: ["layoutMode", "itemSpacing", "paddingLeft", "primaryAxisSizingMode"],
    apiSymbols: ["AutoLayoutMixin.layoutMode", "AutoLayoutMixin.itemSpacing", "AutoLayoutMixin.paddingLeft", "AutoLayoutMixin.primaryAxisSizingMode"],
    queryHints: ["auto layout frame", "padding item spacing", "responsive stack"],
    avoid: ["Lowercase layout mode values", "Applying auto layout to unsupported node types"],
    pitfalls: ["Use valid uppercase layout modes.", "Apply layout to frames, components, or component sets only.", "Auto-layout parents can reposition or grow children; set child layoutPositioning to ABSOLUTE only under an auto-layout parent."],
  },
  {
    id: "variables.bind",
    title: "Variables and bindings",
    intents: ["variable", "variables", "bind", "binding", "token", "color", "theme", "mode"],
    surface: "design",
    helpers: ["figma_workspace_lookup(kind=api)", "figma_workspace_run_script_file"],
    pluginApi: ["figma.variables.createVariableCollection", "figma.variables.createVariable", "setValueForMode", "setBoundVariable"],
    apiSymbols: ["figma.variables.createVariableCollection", "figma.variables.createVariable", "Variable.setValueForMode", "VariablesAPI.setBoundVariableForPaint", "SceneNodeMixin.setBoundVariable"],
    queryHints: ["create variable collection", "bind color variable to fill", "set variable value for mode"],
    avoid: ["Binding raw values instead of Variable objects", "Assuming every node field is variable-bindable"],
    pitfalls: ["Variable APIs require Design files.", "Use native Plugin API calls in .figma.js for token creation and binding."],
  },
  {
    id: "styles.apply",
    title: "Create and apply styles",
    intents: ["style", "styles", "paint", "typography", "library", "apply style"],
    surface: "design",
    helpers: ["figma_workspace_lookup(kind=api)", "figma_workspace_run_script_file"],
    pluginApi: ["figma.createTextStyle", "figma.createPaintStyle", "TextNode.textStyleId", "fills"],
    apiSymbols: ["figma.createTextStyle", "figma.createPaintStyle", "TextNode.textStyleId", "TextNode.setTextStyleIdAsync", "MinimalFillsMixin.fills"],
    queryHints: ["create text style", "apply paint style", "set textStyleId"],
    avoid: ["Publishing assumptions for local styles", "Changing style font properties without loading fonts"],
    pitfalls: ["Style creation is local to the file until published.", "Load fonts before setting text style font names."],
  },
  {
    id: "components.variants",
    title: "Components and variants",
    intents: ["component", "components", "variant", "variants", "component set", "design system"],
    surface: "design",
    helpers: ["$.create", "figma_workspace_lookup(kind=api)"],
    pluginApi: ["figma.createComponent", "figma.combineAsVariants", "ComponentNode.createInstance"],
    apiSymbols: ["figma.createComponent", "figma.combineAsVariants", "ComponentNode.createInstance", "ComponentSetNode"],
    queryHints: ["create component", "combine as variants", "component set"],
    avoid: ["Combining non-component nodes as variants", "Creating instances before remembering the source component"],
    pitfalls: ["Variant combining requires component nodes.", "Use handles for source components before creating instances."],
  },
  {
    id: "implementation.figma-to-code",
    title: "Figma-to-code implementation workflow",
    intents: ["implement", "implementation", "handoff", "figma to code", "production code", "design context"],
    surface: "design",
    helpers: ["figma_workspace_get_design_context", "figma_workspace_capture_node", "figma_workspace_guidance", "figma_workspace_lookup(kind=docs)"],
    pluginApi: ["official get_design_context", "official get_screenshot"],
    apiSymbols: ["get_design_context", "get_screenshot", "figma_workspace_get_design_context", "figma_workspace_capture_node"],
    queryHints: ["get design context before implementation", "capture node screenshot before coding", "reuse project tokens and components"],
    avoid: ["Implementing from memory without design context and screenshot evidence", "Copying generated Tailwind/code output without adapting to project conventions"],
    pitfalls: ["Use first-class context wrappers before falling back to uncovered upstream tools.", "Treat upstream code output as a reference, then map to local components, tokens, a11y, and framework conventions.", "Record visible or technical deviations explicitly."],
  },
  {
    id: "implementation.motion",
    title: "Motion implementation workflow",
    intents: ["motion", "animation", "animate", "keyframe", "timeline", "export video"],
    surface: "design",
    helpers: ["figma_workspace_get_design_context", "figma_workspace_get_motion_context", "figma_workspace_export_video", "figma_workspace_capture_node"],
    pluginApi: ["official get_motion_context", "official get_design_context", "official export_video"],
    apiSymbols: ["get_motion_context", "get_design_context", "export_video", "figma_workspace_get_motion_context", "figma_workspace_export_video"],
    queryHints: ["pair motion context with design context by node id", "recursive motion context", "export video poll jobId"],
    avoid: ["Inferring animation from a static screenshot", "Dropping motion nodes that are plain elements in design context", "Claiming a local video file before upstream returns one"],
    pitfalls: ["Treat get_motion_context as authoritative for animated-node inventory, timing, easing, and keyframes.", "Use export_video only when frame sampling is worth the upstream render cost.", "Poll with jobId rather than starting duplicate renders."],
  },
  {
    id: "instances.properties",
    title: "Instance properties",
    intents: ["instance", "instances", "property", "properties", "component property", "set properties", "variant property"],
    surface: "design",
    helpers: ["figma_workspace_lookup(kind=api)", "figma_workspace_run_script_file"],
    pluginApi: ["InstanceNode.componentProperties", "InstanceNode.setProperties", "ComponentNode.componentPropertyDefinitions"],
    apiSymbols: ["InstanceNode.componentProperties", "InstanceNode.setProperties", "ComponentNode.componentPropertyDefinitions", "ComponentPropertiesMixin"],
    queryHints: ["set instance properties", "read component property definitions", "variant property values"],
    avoid: ["Using display labels instead of property keys with #uid suffixes", "Assuming setProperties throws when a key is wrong"],
    pitfalls: ["Read componentPropertyDefinitions before setProperties.", "TEXT, BOOLEAN, and INSTANCE_SWAP property names can include #uid suffixes."],
  },
  {
    id: "code.connect",
    title: "Code Connect component templates",
    intents: ["code connect", "codeconnect", "template", "mapping", "published component", "component mapping"],
    surface: "design",
    helpers: ["figma_workspace_call_upstream_tool(name=get_code_connect_map)", "figma_workspace_get_design_context", "figma_workspace_lookup(kind=docs)"],
    pluginApi: ["official get_code_connect_map", "official Code Connect suggestions", "component properties"],
    apiSymbols: ["get_code_connect_map", "get_design_context", "figma_workspace_get_design_context", "ComponentNode", "ComponentSetNode"],
    queryHints: ["confirm published component or component set", "read component property context", "map candidate code components"],
    avoid: ["Creating templates for unpublished or ambiguous component targets", "Choosing between multiple code candidates without documenting criteria"],
    pitfalls: ["Use upstream Code Connect suggestions through figma_workspace_call_upstream_tool before writing parserless templates.", "If the Figma target or code component choice is ambiguous, ask for confirmation before creating template files."],
  },
  {
    id: "images.fill",
    title: "Image fills and generated assets",
    intents: ["image", "images", "fill", "asset", "assets", "png", "jpeg", "upload", "generated"],
    surface: "design",
    helpers: ["$.imageAsset", "$.findFreeSlot", "$.placeNode", "$.replaceGeneratedFrame", "figma_workspace_apply_asset_manifest", "figma_workspace_run_task_plan"],
    pluginApi: ["figma.createImage", "Image.hash", "fills", "ImagePaint"],
    apiSymbols: ["figma.createImage", "figma.createImageAsync", "Image.hash", "ImagePaint", "MinimalFillsMixin.fills"],
    queryHints: ["create image fill", "upload local asset manifest", "official upload_assets", "set rectangle fills to image hash"],
    avoid: ["Embedding large base64 images in use_figma code payloads", "Using figma.createImage as a Slides upload path"],
    pitfalls: ["Use $.imageAsset for small inline images only.", "For large generated files, create target rectangles and use figma_workspace_apply_asset_manifest/upload_assets.", "Use $.replaceGeneratedFrame when swapping a generated frame for a repaired version."],
  },
  {
    id: "capture.qa",
    title: "Screenshot capture and visual QA",
    intents: ["capture", "screenshot", "qa", "visual", "review", "inspect image"],
    surface: "any",
    helpers: ["figma_workspace_capture_node", "$.screenshot", "figma_workspace_run_task_plan"],
    pluginApi: ["node.screenshot", "ExportSettingsImage"],
    apiSymbols: ["SceneNode.screenshot", "ExportSettingsImage", "figma.viewport"],
    queryHints: ["capture node screenshot", "write screenshot to imageFile", "visual QA warnings"],
    avoid: ["Treating opportunistic $.screenshot as final QA when no image payload is returned", "Relying only on inline MCP image payloads"],
    pitfalls: ["Prefer figma_workspace_capture_node for final QA files.", "Inspect the saved local image/result when layout correctness matters."],
  },
  {
    id: "review.design-parity",
    title: "Design parity review",
    intents: ["parity", "review", "regression", "visual review", "screenshot compare", "implementation review"],
    surface: "any",
    helpers: ["figma_workspace_capture_node", "figma_workspace_inspect(mode=style)", "figma_workspace_get_design_context"],
    pluginApi: ["official get_design_context", "node.screenshot", "style inspection"],
    apiSymbols: ["get_design_context", "figma_workspace_get_design_context", "figma_workspace_capture_node", "figma_workspace_inspect", "SceneNode.screenshot"],
    queryHints: ["compare implemented UI to Figma screenshot", "audit spacing typography tokens assets", "order visible regressions by severity"],
    avoid: ["Guessing parity without screenshot or design context evidence", "Prioritizing code style over visible regressions and interaction mismatches"],
    pitfalls: ["Request or capture missing visual/context evidence before judging parity.", "Call out token misuse, spacing drift, typography drift, and asset substitutions with severity."],
  },
  {
    id: "surface.figjam",
    title: "FigJam board APIs",
    intents: ["figjam", "board", "sticky", "connector", "shape with text", "brainstorm"],
    surface: "figjam",
    helpers: ["figma_workspace_open(surface=figjam)", "figma_workspace_lookup(kind=api)"],
    pluginApi: ["figma.createSticky", "figma.createConnector", "figma.createShapeWithText"],
    apiSymbols: ["figma.createSticky", "figma.createConnector", "figma.createShapeWithText", "StickyNode", "ConnectorNode"],
    queryHints: ["create sticky notes", "connect FigJam nodes", "surface figjam"],
    avoid: ["Running Design-only frame/component APIs in FigJam sessions", "Opening a FigJam board with surface design"],
    pitfalls: ["Open with surface='figjam'.", "FigJam creation APIs are surface-specific."],
  },
  {
    id: "surface.slides",
    title: "Slides deck APIs",
    intents: ["slides", "slide", "deck", "presentation", "speaker notes", "slide row"],
    surface: "slides",
    helpers: ["figma_workspace_open(surface=slides)", "figma_workspace_lookup(kind=api)", "figma_workspace_capture_node"],
    pluginApi: ["figma.createSlide", "figma.createSlideRow", "figma.getSlideGrid", "figma.setSlideGrid"],
    apiSymbols: ["figma.createSlide", "figma.createSlideRow", "figma.getSlideGrid", "figma.setSlideGrid", "SlideNode", "SlideRowNode"],
    queryHints: ["create slide", "organize slide grid", "surface slides"],
    avoid: ["Calling figma.createPage in Slides", "Using figma.createImage as a Slides upload entrypoint"],
    pitfalls: ["Slides use slide grid APIs instead of createPage.", "Use upload/capture tooling for images and visual review."],
  },
  {
    id: "selection",
    title: "Selection, query, and inspection",
    intents: ["find", "select", "inspect", "query", "validate"],
    surface: "any",
    helpers: ["$.find", "$.findAll", "$.select", "$.inspect", "figma_workspace_inspect(mode=validate)"],
    pluginApi: ["figma.currentPage.selection", "findAll", "getNodeByIdAsync"],
    apiSymbols: ["figma.currentPage.selection", "ChildrenMixin.findAll", "figma.getNodeByIdAsync"],
    queryHints: ["find one scoped node", "select remembered handle", "validate cached handles"],
    avoid: ["Root-wide figma.root.findAll scans", "Direct selection mutation in repairable scripts"],
    pitfalls: ["Avoid root-wide searches in large files.", "Use $.select instead of direct figma.currentPage.selection writes.", "Validate stale handles before mutation."],
  },
  {
    id: "clone",
    title: "Clone an existing node tree",
    intents: ["clone", "copy", "duplicate", "side by side", "preserve instance"],
    surface: "design",
    helpers: ["$.cloneNodeTree", "$.findFreeSlot", "$.placeNode", "$.replaceGeneratedFrame", "$.select", "$.checkpoint"],
    pluginApi: ["SceneNode.clone", "appendChild", "remove"],
    apiSymbols: ["SceneNode.clone", "ChildrenMixin.appendChild", "BaseNodeMixin.remove"],
    queryHints: ["clone node tree", "preserve instance subtree", "duplicate beside source", "replace generated frame"],
    avoid: ["Rebuilding internal children of an InstanceNode", "Losing handles for cloned roots"],
    pitfalls: ["Clone outer-to-inner when rebuilding children.", "Preserve instance subtrees whole; Figma does not allow rebuilding internal instance children."],
  },
  {
    id: "pages",
    title: "Page targeting",
    intents: ["page", "surface", "current page", "navigation"],
    surface: "any",
    helpers: ["targetPageId", "figma_workspace_open"],
    pluginApi: ["figma.setCurrentPageAsync", "PageNode"],
    apiSymbols: ["figma.setCurrentPageAsync", "PageNode", "figma.currentPage"],
    queryHints: ["switch current page once", "targetPageId", "page-scoped script"],
    avoid: ["Assigning figma.currentPage directly", "Multiple page switches in one transaction"],
    pitfalls: ["Do not assign `figma.currentPage` directly.", "Use one page switch per transaction."],
  },
];

export function searchApiCards(query: string, maxCards: number): FigmaWorkspaceApiCard[] {
  const tokens = tokenizeCatalogQuery(query);
  const lowerQuery = query.toLowerCase();
  return FIGMA_WORKSPACE_API_CARDS
    .map((card) => ({
      card,
      score: scoreApiCard(card, tokens, lowerQuery),
    }))
    .filter((entry) => entry.score > 0)
    .sort((left, right) => right.score - left.score || left.card.id.localeCompare(right.card.id))
    .slice(0, maxCards)
    .map((entry) => entry.card);
}

export function chooseApiCardsForIntent(intent: string, maxCards: number): FigmaWorkspaceApiCard[] {
  const cards = searchApiCards(intent, maxCards);
  return cards.length > 0 ? cards : FIGMA_WORKSPACE_API_CARDS.slice(0, maxCards);
}

export function findWrapperLookupProfile(tool: string): FigmaWorkspaceWrapperLookupProfile | undefined {
  return FIGMA_WORKSPACE_WRAPPER_LOOKUP_PROFILES.find((profile) => profile.tool === tool);
}

export function chooseWrapperLookupProfilesForIntent(
  intent: string | undefined,
  maxProfiles: number,
): FigmaWorkspaceWrapperLookupProfile[] {
  const query = intent?.trim();
  if (!query) {
    return FIGMA_WORKSPACE_WRAPPER_LOOKUP_PROFILES.slice(0, maxProfiles);
  }
  const tokens = tokenizeCatalogQuery(query);
  const lowerQuery = query.toLowerCase();
  const ranked = FIGMA_WORKSPACE_WRAPPER_LOOKUP_PROFILES
    .map((profile) => ({
      profile,
      score: scoreWrapperLookupProfile(profile, tokens, lowerQuery),
    }))
    .filter((entry) => entry.score > 0)
    .sort((left, right) => right.score - left.score || left.profile.tool.localeCompare(right.profile.tool))
    .slice(0, maxProfiles)
    .map((entry) => entry.profile);
  return ranked.length > 0 ? ranked : FIGMA_WORKSPACE_WRAPPER_LOOKUP_PROFILES.slice(0, maxProfiles);
}

export function chooseHelperProfilesForIntent(
  intent: string | undefined,
  maxProfiles: number,
): FigmaWorkspaceHelperProfile[] {
  const query = intent?.trim();
  if (!query) {
    return FIGMA_WORKSPACE_HELPER_PROFILES.slice(0, maxProfiles);
  }
  const tokens = tokenizeCatalogQuery(query);
  const lowerQuery = query.toLowerCase();
  const ranked = FIGMA_WORKSPACE_HELPER_PROFILES
    .map((profile) => ({
      profile,
      score: scoreHelperProfile(profile, tokens, lowerQuery),
    }))
    .filter((entry) => entry.score > 0)
    .sort((left, right) => right.score - left.score || left.profile.id.localeCompare(right.profile.id))
    .slice(0, maxProfiles)
    .map((entry) => entry.profile);
  return ranked.length > 0 ? ranked : FIGMA_WORKSPACE_HELPER_PROFILES.slice(0, maxProfiles);
}

export function selectWrapperWorkflowGraph(
  workflowIds: string[] | undefined,
  maxWorkflows: number,
): FigmaWorkspaceWrapperWorkflow[] {
  if (!workflowIds || workflowIds.length === 0) {
    return FIGMA_WORKSPACE_WRAPPER_WORKFLOW_GRAPH.slice(0, maxWorkflows);
  }
  const idSet = new Set(workflowIds);
  return FIGMA_WORKSPACE_WRAPPER_WORKFLOW_GRAPH
    .filter((workflow) => idSet.has(workflow.id))
    .slice(0, maxWorkflows);
}

export function uniqueStrings(values: string[], maxItems: number): string[] {
  const seen = new Set<string>();
  const results: string[] = [];
  for (const value of values) {
    const normalized = value.trim();
    if (!normalized || seen.has(normalized)) {
      continue;
    }
    seen.add(normalized);
    results.push(normalized);
    if (results.length >= maxItems) {
      break;
    }
  }
  return results;
}

function scoreApiCard(card: FigmaWorkspaceApiCard, tokens: string[], lowerQuery: string): number {
  const lowerId = card.id.toLowerCase();
  const haystack = [
    card.id,
    card.title,
    card.surface,
    ...card.intents,
    ...card.helpers,
    ...card.pluginApi,
    ...card.apiSymbols,
    ...card.queryHints,
    ...card.avoid,
    ...card.pitfalls,
  ].join(" ").toLowerCase();
  return (
    (lowerId === lowerQuery ? 120 : 0) +
    (lowerId.startsWith(`${lowerQuery}.`) ? 100 : 0) +
    (haystack.includes(lowerQuery) ? 50 : 0) +
    tokens.filter((token) => haystack.includes(token)).length * 10
  );
}

function scoreWrapperLookupProfile(
  profile: FigmaWorkspaceWrapperLookupProfile,
  tokens: string[],
  lowerQuery: string,
): number {
  const lowerTool = profile.tool.toLowerCase();
  const haystack = [
    profile.tool,
    profile.upstreamTool,
    ...profile.workflowIds,
    ...profile.intents,
    ...profile.docsQueries,
    ...profile.apiSymbols,
    ...profile.suggestedTools,
    ...profile.nextSteps,
  ].join(" ").toLowerCase();
  return (
    (lowerTool === lowerQuery ? 120 : 0) +
    (profile.upstreamTool.toLowerCase() === lowerQuery ? 110 : 0) +
    (haystack.includes(lowerQuery) ? 50 : 0) +
    tokens.filter((token) => haystack.includes(token)).length * 10
  );
}

function scoreHelperProfile(
  profile: FigmaWorkspaceHelperProfile,
  tokens: string[],
  lowerQuery: string,
): number {
  const lowerId = profile.id.toLowerCase();
  const haystack = [
    profile.id,
    profile.category,
    ...profile.helpers,
    ...profile.useWhen,
    ...profile.avoidWhen,
    ...profile.allowedPatterns,
    ...profile.forbiddenPatterns,
    ...profile.apiSymbols,
    ...profile.lookupHints,
    profile.example ?? "",
  ].join(" ").toLowerCase();
  return (
    (lowerId === lowerQuery ? 120 : 0) +
    (profile.helpers.some((helper) => helper.toLowerCase() === lowerQuery) ? 110 : 0) +
    (haystack.includes(lowerQuery) ? 50 : 0) +
    tokens.filter((token) => haystack.includes(token)).length * 10
  );
}

function tokenizeCatalogQuery(query: string): string[] {
  return query
    .toLowerCase()
    .split(/[^a-z0-9_$:.-]+/u)
    .map((token) => token.trim())
    .filter((token) => token.length >= 2);
}
