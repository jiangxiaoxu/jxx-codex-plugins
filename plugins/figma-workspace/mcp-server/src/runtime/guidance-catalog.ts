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
  "Use static helper references only: $.text(...), $[\"text\"](...), or explicit destructuring such as const { text } = $.",
  "Do not use dynamic $[name], alias $, object rest destructuring, or local $ declarations; helper injection must be statically knowable.",
  "Native Figma Plugin API calls remain valid for advanced work when helpers are too narrow.",
  "$.imageAsset is only for small inline PNG/JPEG payloads; use asset manifest/upload flow for larger files.",
];

export const FIGMA_WORKSPACE_HELPER_CATEGORIES: FigmaWorkspaceHelperCategory[] = [
  { id: "selection", title: "Selection and inspection", helpers: ["$.select", "$.inspect"], lookupHints: ["selection helper", "inspect cached handle", "scoped Plugin API findAll"] },
  { id: "text", title: "Text", helpers: ["$.text"], lookupHints: ["text font helper", "loadFontAsync text"] },
  { id: "layout", title: "Placement", helpers: ["$.placeNode", "$.findFreeSlot"], lookupHints: ["place node free slot", "non-overlapping placement"] },
  { id: "assets", title: "Assets", helpers: ["$.imageAsset"], lookupHints: ["image fill helper", "asset manifest upload_assets"] },
  { id: "capture", title: "Capture and QA", helpers: ["$.screenshot"], lookupHints: ["screenshot helper", "capture node QA"] },
  { id: "repair", title: "Repair handles", helpers: ["$.checkpoint", "$.remember", "$.forget"], lookupHints: ["checkpoint handles", "remember forget handles"] },
  { id: "clone", title: "Clone and rebuild", helpers: ["$.cloneNodeTree", "$.replaceGeneratedFrame"], lookupHints: ["clone node tree", "replace generated frame"] },
];

export const FIGMA_WORKSPACE_HELPER_PROFILES: FigmaWorkspaceHelperProfile[] = [
  {
    id: "selection",
    category: "selection",
    helpers: ["$.select", "$.inspect"],
    useWhen: ["Select or inspect cached handles during repair loops.", "Validate known targets before mutation."],
    avoidWhen: ["Root-wide scans in large files.", "Direct selection mutation when $.select can validate targets."],
    allowedPatterns: ["await $.select([\"$hero\"])", "await $[\"inspect\"](\"$hero\")", "const { inspect, select } = $"],
    forbiddenPatterns: ["$[helperName](...)", "const helper = $", "const { select, ...rest } = $", "const $ = {}"],
    publicCommandIds: ["figma:inspect"],
    apiReferences: [
      { displayExpression: "figma.currentPage.selection", lookupQuery: "PluginAPI.currentPage", ownerHint: "PluginAPI", symbolKind: "plugin-api" },
      { displayExpression: "findAll", lookupQuery: "ChildrenMixin.findAll", ownerHint: "ChildrenMixin", symbolKind: "plugin-api" },
      { displayExpression: "figma.getNodeByIdAsync", lookupQuery: "PluginAPI.getNodeByIdAsync", ownerHint: "PluginAPI", symbolKind: "plugin-api" },
    ],
    lookupHints: ["scoped findAll", "select remembered handle", "inspect cached handle"],
    example: "const node = figma.currentPage.findAll((candidate) => candidate.name === \"Hero\")[0]; if (node) $.remember(\"$hero\", node); await $.select([\"$hero\"]);",
  },
  {
    id: "text",
    category: "text",
    helpers: ["$.text"],
    useWhen: ["Create or update text with helper-managed font loading.", "Remember text nodes for follow-up edits."],
    avoidWhen: ["Changing TextNode.characters manually before loading fonts.", "Guessing unavailable font family/style pairs."],
    allowedPatterns: ["await $.text({ parent, text, font, as })", "const { text } = $"],
    forbiddenPatterns: ["$[name](...)", "const helpers = $", "const { text, ...rest } = $", "const $ = {}"],
    publicCommandIds: ["figma:api:search", "figma:script:run"],
    apiReferences: [
      { displayExpression: "figma.createText()", lookupQuery: "PluginAPI.createText", ownerHint: "PluginAPI", symbolKind: "plugin-api" },
      { displayExpression: "figma.loadFontAsync()", lookupQuery: "PluginAPI.loadFontAsync", ownerHint: "PluginAPI", symbolKind: "plugin-api" },
      { displayExpression: "text.characters", lookupQuery: "TextNode.characters", ownerHint: "TextNode", symbolKind: "plugin-api" },
      { displayExpression: "text.fontName", lookupQuery: "TextNode.fontName", ownerHint: "TextNode", symbolKind: "plugin-api" },
    ],
    lookupHints: ["text font loadFontAsync", "create text node", "set characters safely"],
    example: "await $.text({ parent: \"$card\", text: \"Settings\", font: { family: \"Inter\", style: \"Bold\", size: 20 }, as: \"$title\" });",
  },
  {
    id: "layout",
    category: "layout",
    helpers: ["$.placeNode", "$.findFreeSlot"],
    useWhen: ["Place generated nodes in predictable non-overlapping slots.", "Move retained or native-created nodes without overlap."],
    avoidWhen: ["Using placement helpers as a substitute for native auto-layout modeling.", "Absolute placement for content that should be auto layout."],
    allowedPatterns: ["await $.findFreeSlot({ parent, size, preferred })", "await $.placeNode(\"$frame\", { preferred, avoidOverlap: true })"],
    forbiddenPatterns: ["dynamic helper lookup", "local $ declarations"],
    publicCommandIds: ["figma:api:search", "figma:script:run"],
    apiReferences: [
      { displayExpression: "figma.createFrame()", lookupQuery: "PluginAPI.createFrame", ownerHint: "PluginAPI", symbolKind: "plugin-api" },
      { displayExpression: "figma.createRectangle()", lookupQuery: "PluginAPI.createRectangle", ownerHint: "PluginAPI", symbolKind: "plugin-api" },
      { displayExpression: "frame.layoutMode", lookupQuery: "AutoLayoutMixin.layoutMode", ownerHint: "AutoLayoutMixin", symbolKind: "plugin-api" },
      { displayExpression: "node.resize()", lookupQuery: "SceneNode.resize", ownerHint: "SceneNode", symbolKind: "plugin-api" },
    ],
    lookupHints: ["auto layout Plugin API", "place node free slot"],
    example: "const frame = figma.createFrame(); frame.resize(320, 180); $.remember(\"$panel\", frame); await $.placeNode(\"$panel\", { avoidOverlap: true });",
  },
  {
    id: "assets",
    category: "assets",
    helpers: ["$.imageAsset"],
    useWhen: ["Apply a small inline PNG/JPEG base64 or byte array as an image fill.", "Create a quick image-fill rectangle during a compact script."],
    avoidWhen: ["Large local assets or generated files.", "Slides upload paths or payloads likely to exceed MCP limits."],
    allowedPatterns: ["await $.imageAsset({ base64, parent, size, position, as })", "create rectangles first, then use the apply-asset-manifest CLI command for large files"],
    forbiddenPatterns: ["large base64 payloads in $.imageAsset", "using $.imageAsset instead of upload_assets for local files"],
    publicCommandIds: ["figma:api:search", "figma:assets:apply"],
    apiReferences: [
      { displayExpression: "figma.createImage()", lookupQuery: "PluginAPI.createImage", ownerHint: "PluginAPI", symbolKind: "plugin-api" },
      { displayExpression: "image.hash", lookupQuery: "Image.hash", ownerHint: "Image", symbolKind: "plugin-api" },
      { displayExpression: "ImagePaint", lookupQuery: "ImagePaint", symbolKind: "plugin-api" },
      { displayExpression: "node.fills", lookupQuery: "MinimalFillsMixin.fills", ownerHint: "MinimalFillsMixin", symbolKind: "plugin-api" },
    ],
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
    forbiddenPatterns: ["dynamic helper lookup", "using $.screenshot when figma:capture should write a PNG file"],
    publicCommandIds: ["figma:capture"],
    apiReferences: [
      { displayExpression: "node.exportAsync()", lookupQuery: "ExportMixin.exportAsync", ownerHint: "ExportMixin", symbolKind: "plugin-api" },
      { displayExpression: "ExportSettingsImage", lookupQuery: "ExportSettingsImage", symbolKind: "plugin-api" },
    ],
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
    publicCommandIds: ["figma:inspect"],
    apiReferences: [
      { displayExpression: "figma.currentPage", lookupQuery: "PluginAPI.currentPage", ownerHint: "PluginAPI", symbolKind: "plugin-api" },
      { displayExpression: "node.id", lookupQuery: "BaseNodeMixin.id", ownerHint: "BaseNodeMixin", symbolKind: "plugin-api" },
    ],
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
    publicCommandIds: ["figma:script:run"],
    apiReferences: [
      { displayExpression: "node.clone()", lookupQuery: "SceneNode.clone", ownerHint: "SceneNode", symbolKind: "plugin-api" },
      { displayExpression: "parent.appendChild()", lookupQuery: "ChildrenMixin.appendChild", ownerHint: "ChildrenMixin", symbolKind: "plugin-api" },
      { displayExpression: "node.remove()", lookupQuery: "BaseNodeMixin.remove", ownerHint: "BaseNodeMixin", symbolKind: "plugin-api" },
    ],
    lookupHints: ["clone node tree", "preserve instance subtree", "replace generated frame"],
    example: "const copy = await $.cloneNodeTree({ source: \"$card\", placement: \"right\", as: \"$cardCopy\" });",
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
    helpers: ["$.checkpoint"],
    publicCommandIds: ["figma:script:run", "figma:api:search"],
    upstreamTools: [],
    apiReferences: [
      { displayExpression: "figma.createFrame()", lookupQuery: "PluginAPI.createFrame", ownerHint: "PluginAPI", symbolKind: "plugin-api" },
      { displayExpression: "figma.createRectangle()", lookupQuery: "PluginAPI.createRectangle", ownerHint: "PluginAPI", symbolKind: "plugin-api" },
      { displayExpression: "node.resize()", lookupQuery: "SceneNode.resize", ownerHint: "SceneNode", symbolKind: "plugin-api" },
      { displayExpression: "parent.appendChild()", lookupQuery: "ChildrenMixin.appendChild", ownerHint: "ChildrenMixin", symbolKind: "plugin-api" },
    ],
    queryHints: ["create frame or rectangle", "resize node before layout", "append child to frame"],
    avoid: ["Root-wide construction without handles", "Changing layout-sensitive size after applying auto layout"],
    pitfalls: ["Set size before auto-layout if fixed dimensions matter.", "Remember handles with `as` for later repair."],
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
    avoid: ["Combining non-component nodes as variants", "Creating instances before remembering the source component"],
    pitfalls: ["Variant combining requires component nodes.", "Use handles for source components before creating instances."],
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
    helpers: ["$.imageAsset", "$.findFreeSlot", "$.placeNode", "$.replaceGeneratedFrame"],
    publicCommandIds: ["figma:assets:apply", "figma:task:run", "figma:api:search"],
    upstreamTools: ["upload_assets"],
    apiReferences: [
      { displayExpression: "figma.createImage()", lookupQuery: "PluginAPI.createImage", ownerHint: "PluginAPI", symbolKind: "plugin-api" },
      { displayExpression: "figma.createImageAsync()", lookupQuery: "PluginAPI.createImageAsync", ownerHint: "PluginAPI", symbolKind: "plugin-api" },
      { displayExpression: "image.hash", lookupQuery: "Image.hash", ownerHint: "Image", symbolKind: "plugin-api" },
      { displayExpression: "ImagePaint", lookupQuery: "ImagePaint", symbolKind: "plugin-api" },
      { displayExpression: "node.fills", lookupQuery: "MinimalFillsMixin.fills", ownerHint: "MinimalFillsMixin", symbolKind: "plugin-api" },
    ],
    queryHints: ["create image fill", "upload local asset manifest", "official upload_assets", "set rectangle fills to image hash"],
    avoid: ["Embedding large base64 images in use_figma code payloads", "Using figma.createImage as a Slides upload path"],
    pitfalls: ["Use $.imageAsset for small inline images only.", "For large generated files, create target rectangles and use the apply-asset-manifest CLI command with upload_assets.", "Use $.replaceGeneratedFrame when swapping a generated frame for a repaired version."],
  },
  {
    id: "capture.qa",
    title: "Screenshot capture and visual QA",
    intents: ["capture", "screenshot", "qa", "visual", "review", "inspect image"],
    surface: "any",
    helpers: ["$.screenshot"],
    publicCommandIds: ["figma:capture", "figma:task:run"],
    upstreamTools: ["get_screenshot"],
    apiReferences: [
      { displayExpression: "node.exportAsync()", lookupQuery: "ExportMixin.exportAsync", ownerHint: "ExportMixin", symbolKind: "plugin-api" },
      { displayExpression: "ExportSettingsImage", lookupQuery: "ExportSettingsImage", symbolKind: "plugin-api" },
      { displayExpression: "figma.viewport", lookupQuery: "PluginAPI.viewport", ownerHint: "PluginAPI", symbolKind: "plugin-api" },
    ],
    queryHints: ["capture node screenshot", "write screenshot to imageFile", "visual QA warnings"],
    avoid: ["Treating opportunistic $.screenshot as final QA when no image payload is returned", "Relying only on inline MCP image payloads"],
    pitfalls: ["Prefer figma:capture for final QA files.", "Inspect the saved local image/result when layout correctness matters."],
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
    avoid: ["Calling figma.createPage in Slides", "Using figma.createImage as a Slides upload entrypoint"],
    pitfalls: ["Slides use slide grid APIs instead of createPage.", "Use upload/capture tooling for images and visual review."],
  },
  {
    id: "selection",
    title: "Selection, query, and inspection",
    intents: ["find", "select", "inspect", "query", "validate"],
    surface: "any",
    helpers: ["$.select", "$.inspect"],
    publicCommandIds: ["figma:inspect", "figma:api:search"],
    upstreamTools: [],
    apiReferences: [
      { displayExpression: "figma.currentPage.selection", lookupQuery: "PluginAPI.currentPage", ownerHint: "PluginAPI", symbolKind: "plugin-api" },
      { displayExpression: "findAll()", lookupQuery: "ChildrenMixin.findAll", ownerHint: "ChildrenMixin", symbolKind: "plugin-api" },
      { displayExpression: "figma.getNodeByIdAsync()", lookupQuery: "PluginAPI.getNodeByIdAsync", ownerHint: "PluginAPI", symbolKind: "plugin-api" },
    ],
    queryHints: ["scoped findAll", "select remembered handle", "validate cached handles"],
    avoid: ["Root-wide figma.root.findAll scans", "Direct selection mutation in repairable scripts"],
    pitfalls: ["Avoid root-wide searches in large files.", "Use native scoped queries or figma:inspect for discovery.", "Use $.select instead of direct figma.currentPage.selection writes.", "Validate stale handles before mutation."],
  },
  {
    id: "clone",
    title: "Clone an existing node tree",
    intents: ["clone", "copy", "duplicate", "side by side", "preserve instance"],
    surface: "design",
    helpers: ["$.cloneNodeTree", "$.findFreeSlot", "$.placeNode", "$.replaceGeneratedFrame", "$.select", "$.checkpoint"],
    publicCommandIds: ["figma:script:run", "figma:api:search"],
    upstreamTools: [],
    apiReferences: [
      { displayExpression: "node.clone()", lookupQuery: "SceneNode.clone", ownerHint: "SceneNode", symbolKind: "plugin-api" },
      { displayExpression: "parent.appendChild()", lookupQuery: "ChildrenMixin.appendChild", ownerHint: "ChildrenMixin", symbolKind: "plugin-api" },
      { displayExpression: "node.remove()", lookupQuery: "BaseNodeMixin.remove", ownerHint: "BaseNodeMixin", symbolKind: "plugin-api" },
    ],
    queryHints: ["clone node tree", "preserve instance subtree", "duplicate beside source", "replace generated frame"],
    avoid: ["Rebuilding internal children of an InstanceNode", "Losing handles for cloned roots"],
    pitfalls: ["Clone outer-to-inner when rebuilding children.", "Preserve instance subtrees whole; Figma does not allow rebuilding internal instance children."],
  },
  {
    id: "pages",
    title: "Page targeting",
    intents: ["page", "surface", "current page", "navigation"],
    surface: "any",
    helpers: ["targetPageId"],
    publicCommandIds: ["figma:open", "figma:api:search"],
    upstreamTools: [],
    apiReferences: [
      { displayExpression: "figma.setCurrentPageAsync()", lookupQuery: "PluginAPI.setCurrentPageAsync", ownerHint: "PluginAPI", symbolKind: "plugin-api" },
      { displayExpression: "PageNode", lookupQuery: "PageNode", symbolKind: "plugin-api" },
      { displayExpression: "figma.currentPage", lookupQuery: "PluginAPI.currentPage", ownerHint: "PluginAPI", symbolKind: "plugin-api" },
    ],
    queryHints: ["switch current page once", "targetPageId", "page-scoped script"],
    avoid: ["Assigning figma.currentPage directly", "Multiple page switches in one transaction"],
    pitfalls: ["Do not assign `figma.currentPage` directly.", "Use one page switch per transaction."],
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
