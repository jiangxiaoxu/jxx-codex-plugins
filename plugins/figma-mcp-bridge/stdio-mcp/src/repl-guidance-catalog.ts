export type FigmaReplApiCardSurface = "design" | "figjam" | "slides" | "any";

export interface FigmaReplApiCard {
  id: string;
  title: string;
  intents: string[];
  surface: FigmaReplApiCardSurface;
  helpers: string[];
  pluginApi: string[];
  apiSymbols: string[];
  queryHints: string[];
  avoid: string[];
  pitfalls: string[];
}

export const FIGMA_REPL_QUERY_SEARCH_ANCHORS = [
  "text/font",
  "auto layout",
  "variables/tokens",
  "styles",
  "components/variants",
  "instances/properties",
  "images/fills",
  "selection",
  "capture/QA",
  "FigJam/Slides",
];

export const FIGMA_REPL_QUERY_OUTPUT_FIELDS = [
  "recommendedCards",
  "queryHints",
  "apiSymbols",
  "avoid",
  "referenceContext",
];

export const FIGMA_REPL_COMMON_TASK_LABELS = [
  "font-safe text edits",
  "auto-layout UI construction",
  "variable binding",
  "style application",
  "component variants",
  "instance properties",
  "generated image fills",
  "screenshot QA",
  "FigJam board work",
  "Slides deck work",
];

export const FIGMA_REPL_INTENT_EXAMPLE_QUERIES = [
  "create UI card with auto layout and text",
  "make component variants",
  "update color token",
];

export const FIGMA_REPL_API_CARDS: FigmaReplApiCard[] = [
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
    helpers: ["$.text", "figma_repl_lookup(kind=api)"],
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
    pitfalls: ["Use valid uppercase layout modes.", "Apply layout to frames, components, or component sets only."],
  },
  {
    id: "variables.bind",
    title: "Variables and bindings",
    intents: ["variable", "variables", "bind", "binding", "token", "color", "theme", "mode"],
    surface: "design",
    helpers: ["figma_repl_lookup(kind=api)", "figma_repl_run_script_file"],
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
    helpers: ["figma_repl_lookup(kind=api)", "figma_repl_run_script_file"],
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
    helpers: ["$.create", "figma_repl_lookup(kind=api)"],
    pluginApi: ["figma.createComponent", "figma.combineAsVariants", "ComponentNode.createInstance"],
    apiSymbols: ["figma.createComponent", "figma.combineAsVariants", "ComponentNode.createInstance", "ComponentSetNode"],
    queryHints: ["create component", "combine as variants", "component set"],
    avoid: ["Combining non-component nodes as variants", "Creating instances before remembering the source component"],
    pitfalls: ["Variant combining requires component nodes.", "Use handles for source components before creating instances."],
  },
  {
    id: "instances.properties",
    title: "Instance properties",
    intents: ["instance", "instances", "property", "properties", "component property", "set properties", "variant property"],
    surface: "design",
    helpers: ["figma_repl_lookup(kind=api)", "figma_repl_run_script_file"],
    pluginApi: ["InstanceNode.componentProperties", "InstanceNode.setProperties", "ComponentNode.componentPropertyDefinitions"],
    apiSymbols: ["InstanceNode.componentProperties", "InstanceNode.setProperties", "ComponentNode.componentPropertyDefinitions", "ComponentPropertiesMixin"],
    queryHints: ["set instance properties", "read component property definitions", "variant property values"],
    avoid: ["Using display labels instead of property keys with #uid suffixes", "Assuming setProperties throws when a key is wrong"],
    pitfalls: ["Read componentPropertyDefinitions before setProperties.", "TEXT, BOOLEAN, and INSTANCE_SWAP property names can include #uid suffixes."],
  },
  {
    id: "images.fill",
    title: "Image fills and generated assets",
    intents: ["image", "images", "fill", "asset", "assets", "png", "jpeg", "upload", "generated"],
    surface: "design",
    helpers: ["$.imageAsset", "$.findFreeSlot", "$.placeNode", "$.replaceGeneratedFrame", "figma_repl_apply_asset_manifest", "figma_repl_run_task_plan"],
    pluginApi: ["figma.createImage", "Image.hash", "fills", "ImagePaint"],
    apiSymbols: ["figma.createImage", "figma.createImageAsync", "Image.hash", "ImagePaint", "MinimalFillsMixin.fills"],
    queryHints: ["create image fill", "upload local asset manifest", "official upload_assets", "set rectangle fills to image hash"],
    avoid: ["Embedding large base64 images in use_figma code payloads", "Using figma.createImage as a Slides upload path"],
    pitfalls: ["Use $.imageAsset for small inline images only.", "For large generated files, create target rectangles and use figma_repl_apply_asset_manifest/upload_assets.", "Use $.replaceGeneratedFrame when swapping a generated frame for a repaired version."],
  },
  {
    id: "capture.qa",
    title: "Screenshot capture and visual QA",
    intents: ["capture", "screenshot", "qa", "visual", "review", "inspect image"],
    surface: "any",
    helpers: ["figma_repl_capture_node", "$.screenshot", "figma_repl_run_task_plan"],
    pluginApi: ["node.screenshot", "ExportSettingsImage"],
    apiSymbols: ["SceneNode.screenshot", "ExportSettingsImage", "figma.viewport"],
    queryHints: ["capture node screenshot", "write screenshot to imageFile", "visual QA warnings"],
    avoid: ["Treating opportunistic $.screenshot as final QA when no image payload is returned", "Relying only on inline MCP image payloads"],
    pitfalls: ["Prefer figma_repl_capture_node for final QA files.", "Inspect the saved local image/result when layout correctness matters."],
  },
  {
    id: "surface.figjam",
    title: "FigJam board APIs",
    intents: ["figjam", "board", "sticky", "connector", "shape with text", "brainstorm"],
    surface: "figjam",
    helpers: ["figma_repl_open(surface=figjam)", "figma_repl_lookup(kind=api)"],
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
    helpers: ["figma_repl_open(surface=slides)", "figma_repl_lookup(kind=api)", "figma_repl_capture_node"],
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
    helpers: ["$.find", "$.findAll", "$.select", "$.inspect", "figma_repl_inspect(mode=validate)"],
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
    helpers: ["targetPageId", "figma_repl_open"],
    pluginApi: ["figma.setCurrentPageAsync", "PageNode"],
    apiSymbols: ["figma.setCurrentPageAsync", "PageNode", "figma.currentPage"],
    queryHints: ["switch current page once", "targetPageId", "page-scoped script"],
    avoid: ["Assigning figma.currentPage directly", "Multiple page switches in one transaction"],
    pitfalls: ["Do not assign `figma.currentPage` directly.", "Use one page switch per transaction."],
  },
];

export function searchApiCards(query: string, maxCards: number): FigmaReplApiCard[] {
  const tokens = tokenizeCatalogQuery(query);
  const lowerQuery = query.toLowerCase();
  return FIGMA_REPL_API_CARDS
    .map((card) => ({
      card,
      score: scoreApiCard(card, tokens, lowerQuery),
    }))
    .filter((entry) => entry.score > 0)
    .sort((left, right) => right.score - left.score || left.card.id.localeCompare(right.card.id))
    .slice(0, maxCards)
    .map((entry) => entry.card);
}

export function chooseApiCardsForIntent(intent: string, maxCards: number): FigmaReplApiCard[] {
  const cards = searchApiCards(intent, maxCards);
  return cards.length > 0 ? cards : FIGMA_REPL_API_CARDS.slice(0, maxCards);
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

function scoreApiCard(card: FigmaReplApiCard, tokens: string[], lowerQuery: string): number {
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

function tokenizeCatalogQuery(query: string): string[] {
  return query
    .toLowerCase()
    .split(/[^a-z0-9_$:.-]+/u)
    .map((token) => token.trim())
    .filter((token) => token.length >= 2);
}
