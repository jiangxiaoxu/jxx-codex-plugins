import type { FigmaWorkspacePublicCommandId } from "./public-command-registry.js";

export type FigmaWorkspaceApiCardSurface = "design" | "figjam" | "slides" | "any";
export type FigmaWorkspaceRequestedSurface = Exclude<FigmaWorkspaceApiCardSurface, "any">;

export interface FigmaWorkspacePluginApiReference {
  displayExpression: string;
  lookupQuery: string;
  ownerHint?: string;
  symbolKind: "plugin-api";
}

export interface FigmaWorkspaceApiCard {
  id: string;
  title: string;
  intents: string[];
  surface: FigmaWorkspaceApiCardSurface;
  helpers: string[];
  publicCommandIds: FigmaWorkspacePublicCommandId[];
  upstreamTools: string[];
  apiReferences: FigmaWorkspacePluginApiReference[];
  queryHints: string[];
  avoid: string[];
  pitfalls: string[];
}

export interface FigmaWorkspaceWrapperLookupProfile {
  commandId: FigmaWorkspacePublicCommandId;
  upstreamTool: string;
  workflowIds: string[];
  intents: string[];
  docsQueries: string[];
  apiReferences: FigmaWorkspacePluginApiReference[];
  suggestedCommandIds: FigmaWorkspacePublicCommandId[];
  suggestedUpstreamTools: string[];
  nextSteps: string[];
}

export interface FigmaWorkspaceWrapperWorkflow {
  id: string;
  title: string;
  intents: string[];
  commandIds: FigmaWorkspacePublicCommandId[];
  upstreamTools: string[];
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
  publicCommandIds: FigmaWorkspacePublicCommandId[];
  apiReferences: FigmaWorkspacePluginApiReference[];
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
  "apiReferences",
  "guardrails",
  "referenceContext",
  "nextActions",
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
  "The frozen `$` namespace exposes only `$.text` and `$.capture`.",
];

export const FIGMA_WORKSPACE_HELPER_CATEGORIES: FigmaWorkspaceHelperCategory[] = [
  { id: "text", title: "Text", helpers: ["$.text"], lookupHints: ["text font helper", "loadFontAsync text"] },
  { id: "capture", title: "Capture and QA", helpers: ["$.capture"], lookupHints: ["queued capture helper", "capture node QA"] },
];

export const FIGMA_WORKSPACE_HELPER_PROFILES: FigmaWorkspaceHelperProfile[] = [
  {
    id: "text",
    category: "text",
    helpers: ["$.text"],
    useWhen: ["Create or update text with helper-managed font loading."],
    avoidWhen: ["Changing TextNode.characters manually before loading fonts.", "Guessing unavailable font family/style pairs."],
    allowedPatterns: ["await $.text({ parent: frame, text: \"Settings\", font })", "await $.text({ target: textNode, text: \"Updated\" })"],
    forbiddenPatterns: ["Calling $.text with both target and parent."],
    publicCommandIds: ["figma:api:search", "figma:script:run"],
    apiReferences: [
      { displayExpression: "figma.createText()", lookupQuery: "PluginAPI.createText", ownerHint: "PluginAPI", symbolKind: "plugin-api" },
      { displayExpression: "figma.loadFontAsync()", lookupQuery: "PluginAPI.loadFontAsync", ownerHint: "PluginAPI", symbolKind: "plugin-api" },
      { displayExpression: "text.characters", lookupQuery: "TextNode.characters", ownerHint: "TextNode", symbolKind: "plugin-api" },
      { displayExpression: "text.fontName", lookupQuery: "TextNode.fontName", ownerHint: "TextNode", symbolKind: "plugin-api" },
    ],
    lookupHints: ["text font loadFontAsync", "create text node", "set characters safely"],
  },
  {
    id: "capture",
    category: "capture",
    helpers: ["$.capture"],
    useWhen: ["Queue one or more node captures during a script.", "Save local PNG evidence immediately after the script succeeds."],
    avoidWhen: ["The node id is already known and a standalone figma:capture call is simpler.", "Exporting bytes or strings for script-local data processing."],
    allowedPatterns: ["await $.capture(\"123:456\")", "await $.capture(frame, { maxDimension: 1600, imageFile: \"hero.png\" })"],
    forbiddenPatterns: ["Returning PNG bytes or base64 in the script result.", "Queueing more than 8 capture requests in one execution."],
    publicCommandIds: ["figma:capture"],
    apiReferences: [],
    lookupHints: ["queue capture after script", "write screenshot to imageFile", "visual QA warnings"],
    example: "const ticket = await $.capture(frame, { maxDimension: 1600 });",
  },
];

export const FIGMA_WORKSPACE_WRAPPER_LOOKUP_PROFILES: FigmaWorkspaceWrapperLookupProfile[] = [
  {
    commandId: "figma:design-context",
    upstreamTool: "get_design_context",
    workflowIds: ["design-implementation-context"],
    intents: ["implementation", "design context", "handoff", "parity", "swiftui"],
    docsQueries: ["get design context implementation", "design parity review", "swiftui design context"],
    apiReferences: [],
    suggestedCommandIds: ["figma:motion-context", "figma:capture", "figma:docs:search"],
    suggestedUpstreamTools: [],
    nextSteps: [
      "Use upstream.result as official reference context, then adapt to project components and tokens.",
      "Capture the target node when visual QA or parity review needs evidence.",
    ],
  },
  {
    commandId: "figma:motion-context",
    upstreamTool: "get_motion_context",
    workflowIds: ["motion-implementation"],
    intents: ["motion", "animation", "keyframes", "timeline"],
    docsQueries: ["motion context implementation", "motion keyframes gotchas", "recursive motion context"],
    apiReferences: [],
    suggestedCommandIds: ["figma:design-context", "figma:upstream:call", "figma:docs:search"],
    suggestedUpstreamTools: ["export_video"],
    nextSteps: [
      "Pair motion data with design context for the same node before coding animation.",
      "Preserve upstream timing, easing, and transform-origin values as authoritative motion data.",
    ],
  },
];

export const FIGMA_WORKSPACE_WRAPPER_WORKFLOW_GRAPH: FigmaWorkspaceWrapperWorkflow[] = [
  {
    id: "design-implementation-context",
    title: "Design implementation context",
    intents: ["implementation", "handoff", "parity", "swiftui"],
    commandIds: ["figma:design-context", "figma:capture", "figma:docs:search"],
    upstreamTools: ["get_design_context", "get_screenshot"],
    sequence: [
      "Open or prepare a session with file context.",
      "Run figma:design-context for the target node.",
      "Capture the node when visual evidence is needed.",
      "Use lookup only for missing framework, API, or workflow details.",
    ],
    guardrails: ["Do not copy generated code verbatim without adapting it to the project.", "Do not derive bridge-owned fields from upstream.result."],
  },
  {
    id: "motion-implementation",
    title: "Motion implementation",
    intents: ["motion", "animation", "keyframes", "video"],
    commandIds: ["figma:design-context", "figma:motion-context", "figma:upstream:call"],
    upstreamTools: ["get_design_context", "get_motion_context", "export_video"],
    sequence: [
      "Read design context for structure and assets.",
      "Read motion context for animated-node inventory and keyframes.",
      "Run figma:upstream:call with export_video only when frame sampling is needed.",
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
    helpers: [],
    publicCommandIds: ["figma:script:run", "figma:api:search"],
    upstreamTools: [],
    apiReferences: [
      { displayExpression: "figma.createFrame()", lookupQuery: "PluginAPI.createFrame", ownerHint: "PluginAPI", symbolKind: "plugin-api" },
      { displayExpression: "figma.createRectangle()", lookupQuery: "PluginAPI.createRectangle", ownerHint: "PluginAPI", symbolKind: "plugin-api" },
      { displayExpression: "node.resize()", lookupQuery: "SceneNode.resize", ownerHint: "SceneNode", symbolKind: "plugin-api" },
      { displayExpression: "parent.appendChild()", lookupQuery: "ChildrenMixin.appendChild", ownerHint: "ChildrenMixin", symbolKind: "plugin-api" },
    ],
    queryHints: ["create frame or rectangle", "resize node before layout", "append child to frame"],
    avoid: ["Changing layout-sensitive size after applying auto layout"],
    pitfalls: ["Set size before auto-layout if fixed dimensions matter."],
  },
  {
    id: "text.font",
    title: "Text and font-safe edits",
    intents: ["text", "font", "copy", "label", "typography"],
    surface: "design",
    helpers: ["$.text"],
    publicCommandIds: ["figma:api:search", "figma:script:run"],
    upstreamTools: [],
    apiReferences: [
      { displayExpression: "figma.createText()", lookupQuery: "PluginAPI.createText", ownerHint: "PluginAPI", symbolKind: "plugin-api" },
      { displayExpression: "figma.loadFontAsync()", lookupQuery: "PluginAPI.loadFontAsync", ownerHint: "PluginAPI", symbolKind: "plugin-api" },
      { displayExpression: "text.characters", lookupQuery: "TextNode.characters", ownerHint: "TextNode", symbolKind: "plugin-api" },
      { displayExpression: "text.fontName", lookupQuery: "TextNode.fontName", ownerHint: "TextNode", symbolKind: "plugin-api" },
    ],
    queryHints: ["load font before changing text", "create text node", "set characters safely"],
    avoid: ["Changing TextNode.characters before loadFontAsync", "Guessing unavailable font style names"],
    pitfalls: ["Always load the target font before changing characters or fontName.", "Use text styles for reusable typography."],
  },
  {
    id: "layout.auto",
    title: "Auto layout",
    intents: ["layout", "spacing", "padding", "stack", "responsive"],
    surface: "design",
    helpers: [],
    publicCommandIds: ["figma:api:search", "figma:script:run"],
    upstreamTools: [],
    apiReferences: [
      { displayExpression: "frame.layoutMode", lookupQuery: "AutoLayoutMixin.layoutMode", ownerHint: "AutoLayoutMixin", symbolKind: "plugin-api" },
      { displayExpression: "frame.itemSpacing", lookupQuery: "AutoLayoutMixin.itemSpacing", ownerHint: "AutoLayoutMixin", symbolKind: "plugin-api" },
      { displayExpression: "frame.paddingLeft", lookupQuery: "AutoLayoutMixin.paddingLeft", ownerHint: "AutoLayoutMixin", symbolKind: "plugin-api" },
      { displayExpression: "frame.primaryAxisSizingMode", lookupQuery: "AutoLayoutMixin.primaryAxisSizingMode", ownerHint: "AutoLayoutMixin", symbolKind: "plugin-api" },
    ],
    queryHints: ["auto layout frame", "padding item spacing", "responsive stack"],
    avoid: ["Lowercase layout mode values", "Applying auto layout to unsupported node types"],
    pitfalls: ["Use valid uppercase layout modes.", "Apply layout to frames, components, or component sets only.", "Auto-layout parents can reposition or grow children; set child layoutPositioning to ABSOLUTE only under an auto-layout parent."],
  },
  {
    id: "variables.bind",
    title: "Variables and bindings",
    intents: ["variable", "variables", "bind", "binding", "token", "color", "theme", "mode"],
    surface: "design",
    helpers: [],
    publicCommandIds: ["figma:api:search", "figma:script:run", "figma:variables"],
    upstreamTools: [],
    apiReferences: [
      { displayExpression: "figma.variables.createVariableCollection()", lookupQuery: "VariablesAPI.createVariableCollection", ownerHint: "VariablesAPI", symbolKind: "plugin-api" },
      { displayExpression: "figma.variables.createVariable()", lookupQuery: "VariablesAPI.createVariable", ownerHint: "VariablesAPI", symbolKind: "plugin-api" },
      { displayExpression: "variable.setValueForMode()", lookupQuery: "Variable.setValueForMode", ownerHint: "Variable", symbolKind: "plugin-api" },
      { displayExpression: "figma.variables.setBoundVariableForPaint()", lookupQuery: "VariablesAPI.setBoundVariableForPaint", ownerHint: "VariablesAPI", symbolKind: "plugin-api" },
      { displayExpression: "node.setBoundVariable()", lookupQuery: "SceneNodeMixin.setBoundVariable", ownerHint: "SceneNodeMixin", symbolKind: "plugin-api" },
    ],
    queryHints: ["create variable collection", "bind color variable to fill", "set variable value for mode"],
    avoid: ["Binding raw values instead of Variable objects", "Assuming every node field is variable-bindable"],
    pitfalls: ["Variable APIs require Design files.", "Use native Plugin API calls in .figma.ts for token creation and binding."],
  },
  {
    id: "styles.apply",
    title: "Create and apply styles",
    intents: ["style", "styles", "paint", "typography", "library", "apply style"],
    surface: "design",
    helpers: [],
    publicCommandIds: ["figma:api:search", "figma:script:run"],
    upstreamTools: [],
    apiReferences: [
      { displayExpression: "figma.createTextStyle()", lookupQuery: "PluginAPI.createTextStyle", ownerHint: "PluginAPI", symbolKind: "plugin-api" },
      { displayExpression: "figma.createPaintStyle()", lookupQuery: "PluginAPI.createPaintStyle", ownerHint: "PluginAPI", symbolKind: "plugin-api" },
      { displayExpression: "text.textStyleId", lookupQuery: "TextNode.textStyleId", ownerHint: "TextNode", symbolKind: "plugin-api" },
      { displayExpression: "text.setTextStyleIdAsync()", lookupQuery: "TextNode.setTextStyleIdAsync", ownerHint: "TextNode", symbolKind: "plugin-api" },
      { displayExpression: "node.fills", lookupQuery: "MinimalFillsMixin.fills", ownerHint: "MinimalFillsMixin", symbolKind: "plugin-api" },
    ],
    queryHints: ["create text style", "apply paint style", "set textStyleId"],
    avoid: ["Publishing assumptions for local styles", "Changing style font properties without loading fonts"],
    pitfalls: ["Style creation is local to the file until published.", "Load fonts before setting text style font names."],
  },
  {
    id: "components.variants",
    title: "Components and variants",
    intents: ["component", "components", "variant", "variants", "component set", "design system"],
    surface: "design",
    helpers: [],
    publicCommandIds: ["figma:api:search", "figma:script:run", "figma:design-system"],
    upstreamTools: [],
    apiReferences: [
      { displayExpression: "figma.createComponent()", lookupQuery: "PluginAPI.createComponent", ownerHint: "PluginAPI", symbolKind: "plugin-api" },
      { displayExpression: "figma.combineAsVariants()", lookupQuery: "PluginAPI.combineAsVariants", ownerHint: "PluginAPI", symbolKind: "plugin-api" },
      { displayExpression: "component.createInstance()", lookupQuery: "ComponentNode.createInstance", ownerHint: "ComponentNode", symbolKind: "plugin-api" },
      { displayExpression: "ComponentSetNode", lookupQuery: "ComponentSetNode", symbolKind: "plugin-api" },
    ],
    queryHints: ["create component", "combine as variants", "component set"],
    avoid: ["Combining non-component nodes as variants"],
    pitfalls: ["Variant combining requires component nodes."],
  },
  {
    id: "implementation.figma-to-code",
    title: "Figma-to-code implementation workflow",
    intents: ["implement", "implementation", "handoff", "figma to code", "production code", "design context"],
    surface: "design",
    helpers: [],
    publicCommandIds: ["figma:design-context", "figma:capture", "figma:guidance", "figma:docs:search"],
    upstreamTools: ["get_design_context", "get_screenshot"],
    apiReferences: [],
    queryHints: ["get design context before implementation", "capture node screenshot before coding", "reuse project tokens and components"],
    avoid: ["Implementing from memory without design context and screenshot evidence", "Copying generated Tailwind/code output without adapting to project conventions"],
    pitfalls: ["Prefer first-class context wrappers; use upstream escape hatches when raw upstream behavior or uncovered tools are needed.", "Treat upstream code output as a reference, then map to local components, tokens, a11y, and framework conventions.", "Record visible or technical deviations explicitly."],
  },
  {
    id: "implementation.motion",
    title: "Motion implementation workflow",
    intents: ["motion", "animation", "animate", "keyframe", "timeline", "export video"],
    surface: "design",
    helpers: [],
    publicCommandIds: ["figma:design-context", "figma:motion-context", "figma:upstream:call", "figma:capture"],
    upstreamTools: ["get_motion_context", "get_design_context", "export_video"],
    apiReferences: [],
    queryHints: ["pair motion context with design context by node id", "recursive motion context", "export video poll jobId"],
    avoid: ["Inferring animation from a static screenshot", "Dropping motion nodes that are plain elements in design context", "Claiming a local video file before upstream returns one"],
    pitfalls: ["Treat get_motion_context as authoritative for animated-node inventory, timing, easing, and keyframes.", "Run figma:upstream:call with export_video only when frame sampling is worth the upstream render cost.", "Poll with jobId rather than starting duplicate renders."],
  },
  {
    id: "instances.properties",
    title: "Instance properties",
    intents: ["instance", "instances", "property", "properties", "component property", "set properties", "variant property"],
    surface: "design",
    helpers: [],
    publicCommandIds: ["figma:api:search", "figma:script:run"],
    upstreamTools: [],
    apiReferences: [
      { displayExpression: "instance.componentProperties", lookupQuery: "InstanceNode.componentProperties", ownerHint: "InstanceNode", symbolKind: "plugin-api" },
      { displayExpression: "instance.setProperties()", lookupQuery: "InstanceNode.setProperties", ownerHint: "InstanceNode", symbolKind: "plugin-api" },
      { displayExpression: "component.componentPropertyDefinitions", lookupQuery: "ComponentNode.componentPropertyDefinitions", ownerHint: "ComponentNode", symbolKind: "plugin-api" },
      { displayExpression: "ComponentPropertiesMixin", lookupQuery: "ComponentPropertiesMixin", symbolKind: "plugin-api" },
    ],
    queryHints: ["set instance properties", "read component property definitions", "variant property values"],
    avoid: ["Using display labels instead of property keys with #uid suffixes", "Assuming setProperties throws when a key is wrong"],
    pitfalls: ["Read componentPropertyDefinitions before setProperties.", "TEXT, BOOLEAN, and INSTANCE_SWAP property names can include #uid suffixes."],
  },
  {
    id: "code.connect",
    title: "Code Connect component templates",
    intents: ["code connect", "codeconnect", "template", "mapping", "published component", "component mapping"],
    surface: "design",
    helpers: [],
    publicCommandIds: ["figma:upstream:call", "figma:design-context", "figma:docs:search"],
    upstreamTools: ["get_code_connect_map", "get_code_connect_suggestions", "get_design_context"],
    apiReferences: [
      { displayExpression: "ComponentNode", lookupQuery: "ComponentNode", symbolKind: "plugin-api" },
      { displayExpression: "ComponentSetNode", lookupQuery: "ComponentSetNode", symbolKind: "plugin-api" },
    ],
    queryHints: ["confirm published component or component set", "read component property context", "map candidate code components"],
    avoid: ["Creating templates for unpublished or ambiguous component targets", "Choosing between multiple code candidates without documenting criteria"],
    pitfalls: ["Use upstream Code Connect suggestions through figma:upstream:call before writing parserless templates.", "If the Figma target or code component choice is ambiguous, ask for confirmation before creating template files."],
  },
  {
    id: "images.fill",
    title: "Image fills and generated assets",
    intents: ["image", "images", "fill", "asset", "assets", "png", "jpeg", "upload", "generated"],
    surface: "design",
    helpers: [],
    publicCommandIds: ["figma:assets:apply", "figma:script:run", "figma:api:search"],
    upstreamTools: ["upload_assets"],
    apiReferences: [
      { displayExpression: "figma.createImage()", lookupQuery: "PluginAPI.createImage", ownerHint: "PluginAPI", symbolKind: "plugin-api" },
      { displayExpression: "figma.createImageAsync()", lookupQuery: "PluginAPI.createImageAsync", ownerHint: "PluginAPI", symbolKind: "plugin-api" },
      { displayExpression: "image.hash", lookupQuery: "Image.hash", ownerHint: "Image", symbolKind: "plugin-api" },
      { displayExpression: "ImagePaint", lookupQuery: "ImagePaint", symbolKind: "plugin-api" },
      { displayExpression: "node.fills", lookupQuery: "MinimalFillsMixin.fills", ownerHint: "MinimalFillsMixin", symbolKind: "plugin-api" },
    ],
    queryHints: ["create image fill", "upload local asset manifest", "official upload_assets", "set rectangle fills to image hash"],
    avoid: [],
    pitfalls: ["For local generated files, create target rectangles and use figma:assets:apply."],
  },
  {
    id: "capture.qa",
    title: "Screenshot capture and visual QA",
    intents: ["capture", "screenshot", "qa", "visual", "review", "inspect image"],
    surface: "any",
    helpers: ["$.capture"],
    publicCommandIds: ["figma:capture", "figma:script:run"],
    upstreamTools: ["get_screenshot"],
    apiReferences: [],
    queryHints: ["capture node screenshot", "write screenshot to imageFile", "visual QA warnings"],
    avoid: ["Returning image bytes or base64 through the script JSON result"],
    pitfalls: ["Use $.capture to queue a capture when the target is created or resolved inside the script; use figma:capture when the node id is already known.", "Inspect every saved local image when layout correctness matters."],
  },
  {
    id: "review.design-parity",
    title: "Design parity review",
    intents: ["parity", "review", "regression", "visual review", "screenshot compare", "implementation review"],
    surface: "any",
    helpers: [],
    publicCommandIds: ["figma:capture", "figma:inspect", "figma:design-context"],
    upstreamTools: ["get_design_context", "get_screenshot"],
    apiReferences: [
      { displayExpression: "node.exportAsync()", lookupQuery: "ExportMixin.exportAsync", ownerHint: "ExportMixin", symbolKind: "plugin-api" },
    ],
    queryHints: ["compare implemented UI to Figma screenshot", "audit spacing typography tokens assets", "order visible regressions by severity"],
    avoid: ["Guessing parity without screenshot or design context evidence", "Prioritizing code style over visible regressions and interaction mismatches"],
    pitfalls: ["Request or capture missing visual/context evidence before judging parity.", "Call out token misuse, spacing drift, typography drift, and asset substitutions with severity."],
  },
  {
    id: "surface.figjam",
    title: "FigJam board APIs",
    intents: ["figjam", "board", "sticky", "connector", "shape with text", "brainstorm"],
    surface: "figjam",
    helpers: [],
    publicCommandIds: ["figma:open", "figma:api:search"],
    upstreamTools: [],
    apiReferences: [
      { displayExpression: "figma.createSticky()", lookupQuery: "PluginAPI.createSticky", ownerHint: "PluginAPI", symbolKind: "plugin-api" },
      { displayExpression: "figma.createConnector()", lookupQuery: "PluginAPI.createConnector", ownerHint: "PluginAPI", symbolKind: "plugin-api" },
      { displayExpression: "figma.createShapeWithText()", lookupQuery: "PluginAPI.createShapeWithText", ownerHint: "PluginAPI", symbolKind: "plugin-api" },
      { displayExpression: "StickyNode", lookupQuery: "StickyNode", symbolKind: "plugin-api" },
      { displayExpression: "ConnectorNode", lookupQuery: "ConnectorNode", symbolKind: "plugin-api" },
    ],
    queryHints: ["create sticky notes", "connect FigJam nodes", "surface figjam"],
    avoid: ["Running Design-only frame/component APIs in FigJam sessions", "Opening a FigJam board with surface design"],
    pitfalls: ["Open with surface='figjam'.", "FigJam creation APIs are surface-specific."],
  },
  {
    id: "surface.slides",
    title: "Slides deck APIs",
    intents: ["slides", "slide", "deck", "presentation", "speaker notes", "slide row"],
    surface: "slides",
    helpers: [],
    publicCommandIds: ["figma:open", "figma:api:search", "figma:capture"],
    upstreamTools: [],
    apiReferences: [
      { displayExpression: "figma.createSlide()", lookupQuery: "PluginAPI.createSlide", ownerHint: "PluginAPI", symbolKind: "plugin-api" },
      { displayExpression: "figma.createSlideRow()", lookupQuery: "PluginAPI.createSlideRow", ownerHint: "PluginAPI", symbolKind: "plugin-api" },
      { displayExpression: "figma.getSlideGrid()", lookupQuery: "PluginAPI.getSlideGrid", ownerHint: "PluginAPI", symbolKind: "plugin-api" },
      { displayExpression: "figma.setSlideGrid()", lookupQuery: "PluginAPI.setSlideGrid", ownerHint: "PluginAPI", symbolKind: "plugin-api" },
      { displayExpression: "SlideNode", lookupQuery: "SlideNode", symbolKind: "plugin-api" },
      { displayExpression: "SlideRowNode", lookupQuery: "SlideRowNode", symbolKind: "plugin-api" },
    ],
    queryHints: ["create slide", "organize slide grid", "surface slides"],
    avoid: ["Calling figma.createPage in Slides"],
    pitfalls: ["Slides use slide grid APIs instead of createPage.", "Use upload/capture tooling for images and visual review."],
  },
  {
    id: "pages",
    title: "Page targeting",
    intents: ["page", "surface", "current page", "navigation"],
    surface: "any",
    helpers: [],
    publicCommandIds: ["figma:open", "figma:api:search"],
    upstreamTools: [],
    apiReferences: [
      { displayExpression: "figma.setCurrentPageAsync()", lookupQuery: "PluginAPI.setCurrentPageAsync", ownerHint: "PluginAPI", symbolKind: "plugin-api" },
      { displayExpression: "PageNode", lookupQuery: "PageNode", symbolKind: "plugin-api" },
      { displayExpression: "figma.currentPage", lookupQuery: "PluginAPI.currentPage", ownerHint: "PluginAPI", symbolKind: "plugin-api" },
    ],
    queryHints: ["switch current page", "page-scoped script"],
    avoid: ["Assigning figma.currentPage directly"],
    pitfalls: ["Use figma.setCurrentPageAsync() to switch pages."],
  },
];

export function isApiCardSurfaceCompatible(
  card: FigmaWorkspaceApiCard,
  requestedSurface: FigmaWorkspaceRequestedSurface,
): boolean {
  return card.surface === "any" || card.surface === requestedSurface;
}

export function filterApiCardsBySurface(
  cards: readonly FigmaWorkspaceApiCard[],
  requestedSurface: FigmaWorkspaceRequestedSurface,
): FigmaWorkspaceApiCard[] {
  return cards.filter((card) => isApiCardSurfaceCompatible(card, requestedSurface));
}

export function searchApiCards(
  query: string,
  maxCards: number,
  requestedSurface?: FigmaWorkspaceRequestedSurface,
): FigmaWorkspaceApiCard[] {
  const normalizedQuery = query.trim();
  if (!normalizedQuery) {
    return [];
  }
  const tokens = tokenizeCatalogQuery(normalizedQuery);
  const lowerQuery = normalizedQuery.toLowerCase();
  const candidates = requestedSurface
    ? filterApiCardsBySurface(FIGMA_WORKSPACE_API_CARDS, requestedSurface)
    : FIGMA_WORKSPACE_API_CARDS;
  return candidates
    .map((card) => ({
      card,
      score: scoreApiCard(card, tokens, lowerQuery),
    }))
    .filter((entry) => entry.score >= 20)
    .sort((left, right) => right.score - left.score || left.card.id.localeCompare(right.card.id))
    .slice(0, maxCards)
    .map((entry) => entry.card);
}

export function chooseApiCardsForIntent(
  intent: string,
  maxCards: number,
  requestedSurface?: FigmaWorkspaceRequestedSurface,
): FigmaWorkspaceApiCard[] {
  return searchApiCards(intent, maxCards, requestedSurface);
}

export function findWrapperLookupProfile(
  commandId: FigmaWorkspacePublicCommandId,
): FigmaWorkspaceWrapperLookupProfile | undefined {
  return FIGMA_WORKSPACE_WRAPPER_LOOKUP_PROFILES.find((profile) => profile.commandId === commandId);
}

export function chooseWrapperLookupProfilesForIntent(
  intent: string | undefined,
  maxProfiles: number,
): FigmaWorkspaceWrapperLookupProfile[] {
  const query = intent?.trim();
  if (!query) {
    return [];
  }
  const tokens = tokenizeCatalogQuery(query);
  const lowerQuery = query.toLowerCase();
  const ranked = FIGMA_WORKSPACE_WRAPPER_LOOKUP_PROFILES
    .map((profile) => ({
      profile,
      score: scoreWrapperLookupProfile(profile, tokens, lowerQuery),
    }))
    .filter((entry) => entry.score >= 20)
    .sort((left, right) => right.score - left.score || left.profile.commandId.localeCompare(right.profile.commandId))
    .slice(0, maxProfiles)
    .map((entry) => entry.profile);
  return ranked;
}

export function chooseHelperProfilesForIntent(
  intent: string | undefined,
  maxProfiles: number,
): FigmaWorkspaceHelperProfile[] {
  const query = intent?.trim();
  if (!query) {
    return [];
  }
  const tokens = tokenizeCatalogQuery(query);
  const lowerQuery = query.toLowerCase();
  const ranked = FIGMA_WORKSPACE_HELPER_PROFILES
    .map((profile) => ({
      profile,
      score: scoreHelperProfile(profile, tokens, lowerQuery),
    }))
    .filter((entry) => entry.score >= 20)
    .sort((left, right) => right.score - left.score || left.profile.id.localeCompare(right.profile.id))
    .slice(0, maxProfiles)
    .map((entry) => entry.profile);
  return ranked;
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
    ...card.publicCommandIds,
    ...card.upstreamTools,
    ...card.apiReferences.flatMap((reference) => [
      reference.displayExpression,
      reference.lookupQuery,
      reference.ownerHint ?? "",
    ]),
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
  const lowerTool = profile.commandId.toLowerCase();
  const haystack = [
    profile.commandId,
    profile.upstreamTool,
    ...profile.workflowIds,
    ...profile.intents,
    ...profile.docsQueries,
    ...profile.apiReferences.flatMap((reference) => [
      reference.displayExpression,
      reference.lookupQuery,
      reference.ownerHint ?? "",
    ]),
    ...profile.suggestedCommandIds,
    ...profile.suggestedUpstreamTools,
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
    ...profile.publicCommandIds,
    ...profile.apiReferences.flatMap((reference) => [
      reference.displayExpression,
      reference.lookupQuery,
      reference.ownerHint ?? "",
    ]),
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
