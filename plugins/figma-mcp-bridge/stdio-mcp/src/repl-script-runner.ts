export type FigmaReplSurface = "design" | "figjam" | "slides";

export type FigmaReplDiagnosticSeverity = "fatal" | "warning";

export interface FigmaReplDiagnostic {
  code: string;
  severity: FigmaReplDiagnosticSeverity;
  message: string;
  suggestion: string;
  docsHint: string;
}

export interface FigmaReplFileDiagnostic extends FigmaReplDiagnostic {
  source: {
    scriptPath: string;
    line?: number;
    column?: number;
  };
}

export interface FigmaReplDiagnosticsOptions {
  allowDangerousOperations?: boolean;
  mode?: "read" | "write";
  generatedCode?: boolean;
  expectedSurface?: FigmaReplSurface;
  strict?: boolean;
}

export type FigmaReplHelperProfile = "auto" | "minimal" | "asset" | "clone" | "full";

export interface CompiledFigmaReplScriptFile {
  code: string;
  diagnostics: FigmaReplFileDiagnostic[];
  metadata: {
    scriptPath: string;
    sourceBytes: number;
    sourceLineCount: number;
    helperApiVersion: string;
    helperProfile: FigmaReplHelperProfile;
    helpersIncluded: string[];
    targetPageId?: string;
    expectedSurface?: FigmaReplSurface;
    diagnosticsCount: number;
  };
}

export function compileFigmaReplScriptFile(options: {
  scriptPath: string;
  source: string;
  targetPageId?: string;
  expectedSurface?: FigmaReplSurface;
  allowDangerousOperations?: boolean;
  strict?: boolean;
  helperProfile?: unknown;
}): CompiledFigmaReplScriptFile {
  const helperProfile = resolveFigmaReplHelperProfile(options.helperProfile, options.source);
  const diagnostics = toFileDiagnostics(
    options.scriptPath,
    options.source,
    diagnoseFigmaReplCode(options.source, {
      allowDangerousOperations: options.allowDangerousOperations,
      expectedSurface: options.expectedSurface,
      mode: "write",
      strict: options.strict,
    }),
  );
  const lines = [createFigmaReplScriptHelperBootstrap(helperProfile)];
  if (options.targetPageId) {
    lines.push(`{ const __targetPage = await getNodeById(${literal(options.targetPageId)}); if (__targetPage.type !== "PAGE") throw new Error("targetPageId must resolve to a PAGE node."); await figma.setCurrentPageAsync(__targetPage); }`);
  }
  lines.push(`// figma_repl_run_script_file source: ${options.scriptPath}`);
  lines.push(options.source);
  return {
    code: lines.join("\n"),
    diagnostics,
    metadata: {
      scriptPath: options.scriptPath,
      sourceBytes: Buffer.byteLength(options.source, "utf8"),
      sourceLineCount: countLines(options.source),
      helperApiVersion: "1",
      helperProfile: helperProfile.profile,
      helpersIncluded: helperProfile.helpersIncluded,
      targetPageId: options.targetPageId,
      expectedSurface: options.expectedSurface,
      diagnosticsCount: diagnostics.length,
    },
  };
}

function resolveFigmaReplHelperProfile(
  value: unknown,
  source: string,
): { profile: FigmaReplHelperProfile; includeImageAsset: boolean; includeCloneNodeTree: boolean; helpersIncluded: string[] } {
  const requested = asOptionalString(value) as FigmaReplHelperProfile | undefined;
  const profile: FigmaReplHelperProfile = requested && ["auto", "minimal", "asset", "clone", "full"].includes(requested)
    ? requested
    : "auto";
  const includeImageAsset = profile === "full" || profile === "asset" || (profile === "auto" && /\$\.imageAsset\b/u.test(source));
  const includeCloneNodeTree = profile === "full" || profile === "clone" || (profile === "auto" && /\$\.cloneNodeTree\b/u.test(source));
  return {
    profile,
    includeImageAsset,
    includeCloneNodeTree,
    helpersIncluded: [
      "$",
      "$.find",
      "$.findAll",
      "$.text",
      "$.layout",
      "$.create",
      "$.select",
      "$.inspect",
      "$.screenshot",
      "$.checkpoint",
      includeImageAsset ? "$.imageAsset" : undefined,
      includeCloneNodeTree ? "$.cloneNodeTree" : undefined,
    ].filter((item): item is string => item !== undefined),
  };
}

function createFigmaReplScriptHelperBootstrap(options: {
  includeImageAsset: boolean;
  includeCloneNodeTree: boolean;
}): string {
  let bootstrap = `const __figmaReplScriptCheckpoints = [];
$.handles = __figmaRepl.handles;
$.remember = remember;
$.forget = forget;
$.resolveId = resolveHandleId;
$.node = $;
$.select = async function select(targets = "$selection", options = {}) {
  const input = Array.isArray(targets) ? targets : [targets];
  const nodes = [];
  for (const target of input) {
    const resolved = target && typeof target === "object" && "type" in target ? target : await $(target);
    const list = Array.isArray(resolved) ? resolved : [resolved];
    for (const node of list) {
      if (!node || node.type === "DOCUMENT" || node.type === "PAGE") {
        throw new Error("$.select targets must resolve to selectable scene nodes.");
      }
      nodes.push(node);
    }
  }
  if (nodes.length === 0 && options.allowEmpty !== true) {
    throw new Error("$.select resolved no nodes; pass { allowEmpty: true } to intentionally clear selection.");
  }
  if (nodes.length === 0) {
    figma.currentPage.selection = [];
    return { selectedNodeIds: [], summaries: [] };
  }
  const targetPage = pageForNode(nodes[0]);
  if (!targetPage) {
    throw new Error("$.select target is not attached to a page.");
  }
  for (const node of nodes) {
    const page = pageForNode(node);
    if (!page || page.id !== targetPage.id) {
      throw new Error("$.select cannot select nodes from multiple pages at once.");
    }
  }
  if (figma.currentPage.id !== targetPage.id) {
    await figma.setCurrentPageAsync(targetPage);
  }
  figma.currentPage.selection = nodes;
  if (nodes.length > 0 && options.zoom !== false) figma.viewport.scrollAndZoomIntoView(nodes);
  return {
    selectedNodeIds: nodes.map((node) => node.id),
    summaries: nodes.map((node) => summarizeNode(node, options.depth || 0)),
  };
};
$.findAll = async function findAll(criteria = {}) {
  const input = typeof criteria === "string" ? { name: criteria } : (criteria || {});
  const root = input.within ? await $(input.within) : figma.currentPage;
  const matches = queryNodes(root, {
    name: input.name,
    type: input.type,
    includeInvisible: input.includeInvisible,
    limit: input.limit || 50,
  });
  if (input.as && matches[0]) remember(input.as, matches[0]);
  return matches;
};
$.find = async function find(criteria = {}) {
  const input = typeof criteria === "string" ? { name: criteria } : (criteria || {});
  const matches = await $.findAll({ ...input, limit: input.limit || 1 });
  const node = matches[0] || null;
  if (!node && input.required !== false) {
    throw new Error("No Figma node matched $.find criteria.");
  }
  if (node && input.as) remember(input.as, node);
  return node;
};
$.text = async function text(targetOrOptions, textValue, options = {}) {
  const input = targetOrOptions && typeof targetOrOptions === "object" && !Array.isArray(targetOrOptions)
    ? targetOrOptions
    : { target: targetOrOptions, text: textValue, ...options };
  let node;
  if (input.target) {
    node = await $(input.target);
    if (node.type !== "TEXT") throw new Error("$.text target must resolve to a TEXT node.");
  } else {
    node = figma.createText();
    if (input.parent) {
      const parent = await $(input.parent);
      parent.appendChild(node);
    } else {
      figma.currentPage.appendChild(node);
    }
  }
  const font = input.font || (input.fontFamily || input.fontStyle ? { family: input.fontFamily || "Inter", style: input.fontStyle || "Regular" } : undefined);
  if (font) {
    const fontName = fontFromHelperInput(font);
    await loadFont(fontName);
    node.fontName = fontName;
    if (font.size !== undefined) node.fontSize = readFiniteNumber(font.size, "font.size");
  } else {
    await loadNodeFont(node);
  }
  if (input.text !== undefined) node.characters = String(input.text);
  if (input.name !== undefined) node.name = String(input.name);
  if (input.appearance !== undefined) applyAppearance(node, input.appearance);
  if (input.position !== undefined) setNodePositionFromInput(node, input.position);
  if (input.size !== undefined) setNodeSizeFromInput(node, input.size);
  if (input.as) remember(input.as, node);
  return node;
};
$.layout = async function layout(target, layoutOptions = {}) {
  const node = await $(target);
  applyAutoLayout(node, layoutOptions);
  return node;
};
$.create = async function create(options = {}) {
  const type = String(options.type || "FRAME").toUpperCase();
  const node = createHelperNode(type);
  if (options.name !== undefined) node.name = String(options.name);
  if (type === "TEXT") {
    await applyTextHelper(node, { text: options.text || "", font: options.font, style: options.style });
    if (options.appearance !== undefined) applyAppearance(node, options.appearance);
  } else if (options.size !== undefined) {
    setNodeSizeFromInput(node, options.size);
  }
  if (options.layout !== undefined) applyAutoLayout(node, options.layout);
  if (options.appearance !== undefined && type !== "TEXT") applyAppearance(node, options.appearance);
  if (options.parent) {
    const parent = await $(options.parent);
    parent.appendChild(node);
  } else {
    figma.currentPage.appendChild(node);
  }
  if (options.as) remember(options.as, node);
  return node;
};
function __figmaReplDecodeBase64(input) {
  const source = String(input || "").replace(/^data:[^,]+,/u, "").replace(/\\s+/gu, "");
  if (!source) throw new Error("$.imageAsset requires a non-empty base64 string or bytes array.");
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  const clean = source.replace(/=+$/u, "");
  const bytes = [];
  let buffer = 0;
  let bits = 0;
  for (const char of clean) {
    const value = alphabet.indexOf(char);
    if (value < 0) throw new Error("$.imageAsset received invalid base64 data.");
    buffer = (buffer << 6) | value;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      bytes.push((buffer >> bits) & 0xff);
    }
  }
  return new Uint8Array(bytes);
}
$.imageAsset = async function imageAsset(options = {}) {
  const input = typeof options === "string" ? { base64: options } : (options || {});
  const bytes = input.bytes instanceof Uint8Array
    ? input.bytes
    : Array.isArray(input.bytes)
      ? new Uint8Array(input.bytes)
      : __figmaReplDecodeBase64(input.base64);
  const image = figma.createImage(bytes);
  const node = input.target ? await $(input.target) : figma.createRectangle();
  if (!("fills" in node)) throw new Error("$.imageAsset target must support fills.");
  if (!input.target) {
    if (input.parent) {
      const parent = await $(input.parent);
      parent.appendChild(node);
    } else {
      figma.currentPage.appendChild(node);
    }
  }
  if (input.name !== undefined) node.name = String(input.name);
  if (input.size !== undefined) {
    setNodeSizeFromInput(node, input.size);
  } else if (!input.target) {
    node.resize(160, 160);
  }
  if (input.position !== undefined) setNodePositionFromInput(node, input.position);
  const scaleMode = String(input.scaleMode || input.fit || "FILL").toUpperCase();
  if (!["FILL", "FIT", "CROP", "TILE"].includes(scaleMode)) {
    throw new Error("$.imageAsset scaleMode must be FILL, FIT, CROP, or TILE.");
  }
  const paint = { type: "IMAGE", scaleMode, imageHash: image.hash };
  if (input.opacity !== undefined) paint.opacity = readFiniteNumber(input.opacity, "opacity");
  node.fills = [paint];
  if (input.as) remember(input.as, node);
  return node;
};
$.inspect = async function inspect(target, depth = 1) {
  const node = await $(target);
  return summarizeNode(node, depth);
};
$.screenshot = async function screenshot(target, options = {}) {
  const node = await $(target);
  if (!node || typeof node.screenshot !== "function") {
    throw new Error("$.screenshot target does not support node.screenshot().");
  }
  return await node.screenshot(options);
};
$.cloneNodeTree = async function cloneNodeTree(targetOrOptions, maybeOptions = {}) {
  const looksLikeOptions = targetOrOptions && typeof targetOrOptions === "object" && !Array.isArray(targetOrOptions) && !("type" in targetOrOptions);
  const input = looksLikeOptions ? targetOrOptions : { source: targetOrOptions, ...maybeOptions };
  const sourceValue = input.source || input.target;
  const source = sourceValue && typeof sourceValue === "object" && "type" in sourceValue ? sourceValue : await $(sourceValue);
  if (!source || source.type === "DOCUMENT" || source.type === "PAGE") {
    throw new Error("$.cloneNodeTree source must resolve to a scene node.");
  }
  const parent = input.parent ? await $(input.parent) : source.parent;
  if (!parent || !("appendChild" in parent)) {
    throw new Error("$.cloneNodeTree requires a writable parent.");
  }
  const cloneLog = [];
  const fallbackWholeSubtrees = [];
  const preserveInstanceSubtrees = input.preserveInstanceSubtrees !== false;
  function getChildren(node) {
    return "children" in node ? Array.from(node.children) : [];
  }
  function cloneOuterToInner(sourceNode, depth = 0) {
    const clone = sourceNode.clone();
    clone.name = sourceNode.name;
    cloneLog.push({
      depth,
      sourceId: sourceNode.id,
      sourceName: sourceNode.name,
      sourceType: sourceNode.type,
      cloneId: clone.id,
    });
    if (preserveInstanceSubtrees && sourceNode.type === "INSTANCE") {
      fallbackWholeSubtrees.push({
        sourceId: sourceNode.id,
        sourceName: sourceNode.name,
        sourceType: sourceNode.type,
        cloneId: clone.id,
        reason: "Preserved instance subtree whole; Figma does not allow safe rebuild of internal instance children.",
      });
      return clone;
    }
    if ("children" in clone) {
      try {
        for (const child of Array.from(clone.children)) child.remove();
      } catch (error) {
        fallbackWholeSubtrees.push({
          sourceId: sourceNode.id,
          sourceName: sourceNode.name,
          sourceType: sourceNode.type,
          cloneId: clone.id,
          reason: error instanceof Error ? error.message : String(error),
        });
        return clone;
      }
    }
    if ("appendChild" in clone) {
      for (const sourceChild of getChildren(sourceNode)) {
        clone.appendChild(cloneOuterToInner(sourceChild, depth + 1));
      }
    }
    return clone;
  }
  const rootClone = cloneOuterToInner(source, 0);
  parent.appendChild(rootClone);
  if (input.name !== undefined) rootClone.name = String(input.name);
  if (input.position !== undefined) {
    setNodePositionFromInput(rootClone, input.position);
  } else if (input.offset !== undefined && "x" in rootClone && "y" in rootClone) {
    rootClone.x = source.x + readFiniteNumber(input.offset.x || 0, "offset.x");
    rootClone.y = source.y + readFiniteNumber(input.offset.y || 0, "offset.y");
  } else if (input.placement !== "none" && "x" in rootClone && "y" in rootClone) {
    const gap = input.gap === undefined ? 80 : readFiniteNumber(input.gap, "gap");
    const placement = input.placement || "right";
    if (placement === "left") {
      rootClone.x = source.x - rootClone.width - gap;
      rootClone.y = source.y;
    } else if (placement === "below") {
      rootClone.x = source.x;
      rootClone.y = source.y + source.height + gap;
    } else if (placement === "above") {
      rootClone.x = source.x;
      rootClone.y = source.y - rootClone.height - gap;
    } else {
      rootClone.x = source.x + source.width + gap;
      rootClone.y = source.y;
    }
  }
  if (input.as) remember(input.as, rootClone);
  const selection = input.select === false ? undefined : await $.select([rootClone], { zoom: input.zoom !== false, depth: 0 });
  return {
    source: summarizeNode(source, input.depth || 0),
    clone: summarizeNode(rootClone, input.depth || 0),
    copiedNodeCount: cloneLog.length,
    order: cloneLog,
    fallbackWholeSubtrees,
    selectedNodeIds: selection ? selection.selectedNodeIds : [],
    handle: input.as,
  };
};
$.checkpoint = async function checkpoint(name, targets = [], options = {}) {
  const list = Array.isArray(targets) ? targets : [targets];
  const summaries = [];
  for (const target of list) {
    const node = await $(target);
    summaries.push({ target, summary: summarizeNode(node, options.depth || 1) });
  }
  const checkpoint = {
    name: String(name || "checkpoint"),
    handles: { ...__figmaRepl.handles },
    summaries,
  };
  __figmaReplScriptCheckpoints.push(checkpoint);
  return checkpoint;
};
$.checkpoints = __figmaReplScriptCheckpoints;`;
  if (!options.includeImageAsset) {
    bootstrap = replaceHelperBootstrapBlock(
      bootstrap,
      "function __figmaReplDecodeBase64(input) {",
      "$.inspect = async function inspect",
      '$.imageAsset = async function imageAsset() { throw new Error("$.imageAsset helper was not injected. Use helperProfile: \\"asset\\" or \\"full\\", or keep helperProfile:auto and include $.imageAsset in the script source."); };\n',
    );
  }
  if (!options.includeCloneNodeTree) {
    bootstrap = replaceHelperBootstrapBlock(
      bootstrap,
      "$.cloneNodeTree = async function cloneNodeTree",
      "$.checkpoint = async function checkpoint",
      '$.cloneNodeTree = async function cloneNodeTree() { throw new Error("$.cloneNodeTree helper was not injected. Use helperProfile: \\"clone\\" or \\"full\\", or keep helperProfile:auto and include $.cloneNodeTree in the script source."); };\n',
    );
  }
  return bootstrap;
}

function replaceHelperBootstrapBlock(
  source: string,
  startMarker: string,
  endMarker: string,
  replacement: string,
): string {
  const start = source.indexOf(startMarker);
  const end = source.indexOf(endMarker);
  if (start < 0 || end < 0 || end <= start) {
    return source;
  }
  return `${source.slice(0, start)}${replacement}${source.slice(end)}`;
}

export function assertSafeFigmaReplCode(
  code: string,
  options: FigmaReplDiagnosticsOptions = {},
): void {
  throwIfFatalDiagnostics(diagnoseFigmaReplCode(code, options));
}

export function diagnoseFigmaReplCode(
  code: string,
  options: FigmaReplDiagnosticsOptions = {},
): FigmaReplDiagnostic[] {
  const diagnostics: FigmaReplDiagnostic[] = [];
  const add = (diagnostic: FigmaReplDiagnostic) => {
    diagnostics.push(options.strict && diagnostic.severity === "warning"
      ? { ...diagnostic, severity: "fatal" }
      : diagnostic);
  };
  const dangerousPatterns = options.generatedCode
    ? GENERATED_CODE_DANGEROUS_PATTERNS
    : RAW_CODE_DANGEROUS_PATTERNS;
  if (!options.allowDangerousOperations) {
    for (const pattern of dangerousPatterns) {
      if (pattern.re.test(code)) {
        add(createDiagnostic(pattern.code, "fatal", pattern.message, pattern.suggestion, pattern.docsHint));
      }
    }
  }
  for (const pattern of API_CONTRACT_PATTERNS) {
    if (pattern.re.test(code)) {
      add(createDiagnostic(pattern.code, "fatal", pattern.message, pattern.suggestion, pattern.docsHint));
    }
  }
  if ((code.match(/\bfigma\.setCurrentPageAsync\s*\(/gu) ?? []).length > 1) {
    add(createDiagnostic(
      "FIGMA_REPL_MULTIPLE_PAGE_SWITCH",
      "fatal",
      "Multiple figma.setCurrentPageAsync() calls in one transaction are error-prone.",
      "Use one targetPageId on figma_repl_run_script_file or split page changes into separate script files.",
      "figma-repl://safety#page-context",
    ));
  }
  if (!options.generatedCode && /\bfigma\.currentPage\.selection\b/u.test(code)) {
    add(createDiagnostic(
      "FIGMA_REPL_DIRECT_SELECTION_ACCESS",
      "warning",
      "Direct figma.currentPage.selection access is brittle in agent scripts.",
      "Use $.select([...]) for writes, $.inspect('$selection') for summaries, or resolve explicit node ids/handles.",
      "figma-repl://scripts#helpers",
    ));
  }
  if (options.mode === "read") {
    for (const pattern of READ_MODE_WRITE_PATTERNS) {
      if (pattern.re.test(code)) {
        add(createDiagnostic(pattern.code, "fatal", pattern.message, pattern.suggestion, pattern.docsHint));
      }
    }
  }
  if (TEXT_MUTATION_PATTERN.test(code) && !/\bfigma\.loadFontAsync\s*\(/u.test(code)) {
    add(createDiagnostic(
      "FIGMA_REPL_TEXT_MUTATION_NEEDS_FONT",
      "warning",
      "Text mutation usually requires figma.loadFontAsync() before changing characters or fontName.",
      "Use $.text, or await figma.loadFontAsync({ family, style }) before changing text.",
      "figma-repl://patterns#text",
    ));
  }
  for (const diagnostic of diagnoseInlineImageAssetSize(code)) {
    add(diagnostic);
  }
  if (CHECKPOINT_HANDLE_AS_NAME_PATTERN.test(code)) {
    add(createDiagnostic(
      "FIGMA_REPL_CHECKPOINT_HANDLE_AS_NAME",
      "warning",
      "$.checkpoint() appears to receive a handle as its first argument, but the first argument is the checkpoint name.",
      "Use $.checkpoint('meaningful-name', ['$handleOrNodeId'], { depth: 1 }).",
      "figma-repl://scripts#helpers",
    ));
  }
  for (const diagnostic of diagnoseSurfaceCode(code, options.expectedSurface)) {
    add(diagnostic);
  }
  return dedupeDiagnostics(diagnostics);
}

function diagnoseInlineImageAssetSize(code: string): FigmaReplDiagnostic[] {
  if (!code.includes("$.imageAsset")) {
    return [];
  }
  const diagnostics: FigmaReplDiagnostic[] = [];
  for (const match of code.matchAll(INLINE_IMAGE_ASSET_BASE64_PATTERN)) {
    const base64Length = String(match[2] || "").replace(/\s+/gu, "").length;
    if (base64Length > MAX_INLINE_IMAGE_ASSET_BASE64_CHARS) {
      diagnostics.push(createDiagnostic(
        "FIGMA_REPL_IMAGE_ASSET_INLINE_TOO_LARGE",
        "warning",
        `Inline $.imageAsset base64 is ${base64Length} characters and may exceed upstream MCP payload limits.`,
        "For large generated PNG/JPEG assets, create target rectangles in .figma.js and use the official upload_assets/upstream asset workflow to fill them.",
        "figma-repl://scripts#helpers",
      ));
      break;
    }
  }
  return diagnostics;
}

export function diagnoseWrappedScriptSize(
  scriptPath: string,
  wrappedScript: string,
  strict: boolean,
): FigmaReplFileDiagnostic[] {
  const byteLength = Buffer.byteLength(wrappedScript, "utf8");
  if (byteLength < UPSTREAM_EVAL_CODE_WARNING_BYTES) {
    return [];
  }
  const overLimit = byteLength > UPSTREAM_EVAL_CODE_LIMIT_BYTES;
  return [{
    code: "FIGMA_REPL_SCRIPT_PAYLOAD_TOO_LARGE",
    severity: overLimit || strict ? "fatal" : "warning",
    message: `Compiled Figma script payload is ${byteLength} bytes; upstream use_figma accepts at most about ${UPSTREAM_EVAL_CODE_LIMIT_BYTES} characters.`,
    suggestion: "Split the work into smaller .figma.js files, for example skeleton, asset targets, upload fills, and visual fixes.",
    docsHint: "figma-repl://scripts#file-workflow",
    source: { scriptPath },
  }];
}

export function throwIfFatalDiagnostics(diagnostics: FigmaReplDiagnostic[]): void {
  const fatal = diagnostics.filter((diagnostic) => diagnostic.severity === "fatal");
  if (fatal.length === 0) {
    return;
  }
  throw new Error(
    `Figma REPL diagnostics blocked execution: ${fatal.map((item) => item.code).join(", ")}. ${fatal[0]?.suggestion ?? ""}`,
  );
}

const RAW_CODE_DANGEROUS_PATTERNS = [
  {
    code: "FIGMA_REPL_DYNAMIC_EVAL",
    re: /\b(?:eval|Function)\s*\(/u,
    message: "Dynamic JavaScript evaluation is disabled by default.",
    suggestion: "Pass allowDangerousOperations=true only after reviewing the exact script.",
    docsHint: "figma-repl://safety#dynamic-code",
  },
  {
    code: "FIGMA_REPL_NETWORK_ACCESS",
    re: /\b(?:fetch|XMLHttpRequest|WebSocket)\b/u,
    message: "Network access from REPL code is disabled by default.",
    suggestion: "Fetch data outside Figma or pass allowDangerousOperations=true after review.",
    docsHint: "figma-repl://safety#network",
  },
  {
    code: "FIGMA_REPL_DYNAMIC_IMPORT",
    re: /\bimport\s*\(/u,
    message: "Dynamic import is disabled by default.",
    suggestion: "Inline the required logic or pass allowDangerousOperations=true after review.",
    docsHint: "figma-repl://safety#dynamic-code",
  },
  {
    code: "FIGMA_REPL_NODE_REMOVAL",
    re: /\.remove\s*\(/u,
    message: "Direct remove() is destructive and can break clone rebuilds, especially inside instance subtrees.",
    suggestion: "Use $.cloneNodeTree for copy/rebuild workflows; pass allowDangerousOperations=true only after reviewing exact cleanup semantics.",
    docsHint: "figma-repl://safety#destructive",
  },
  {
    code: "FIGMA_REPL_FIGMA_DELETE",
    re: /\bdelete\s+figma\./u,
    message: "Deleting properties on the figma object is not supported.",
    suggestion: "Use documented Plugin API calls only.",
    docsHint: "figma-repl://safety#api-contract",
  },
  {
    code: "FIGMA_REPL_DESTRUCTIVE_OPERATION",
    re: /\.(?:detachInstance|flatten)\s*\(/u,
    message: "Destructive Figma operation is disabled by default.",
    suggestion: "Pass allowDangerousOperations=true only after reviewing the exact effect.",
    docsHint: "figma-repl://safety#destructive",
  },
];

const GENERATED_CODE_DANGEROUS_PATTERNS = RAW_CODE_DANGEROUS_PATTERNS.filter(
  (pattern) => pattern.code !== "FIGMA_REPL_NODE_REMOVAL",
);

const READ_MODE_WRITE_PATTERNS = [
  {
    code: "FIGMA_REPL_READ_MODE_CREATE",
    re: /figma\.create[A-Z]/u,
    message: "read mode rejected node creation.",
    suggestion: "Use mode=write or figma_repl_run_script_file when mutation is intended.",
    docsHint: "figma-repl://safety#read-mode",
  },
  {
    code: "FIGMA_REPL_READ_MODE_APPEND",
    re: /\.(?:appendChild|insertChild)\s*\(/u,
    message: "read mode rejected child insertion.",
    suggestion: "Use mode=write or figma_repl_run_script_file when mutation is intended.",
    docsHint: "figma-repl://safety#read-mode",
  },
  {
    code: "FIGMA_REPL_READ_MODE_REMOVE",
    re: /\.remove\s*\(/u,
    message: "read mode rejected node removal.",
    suggestion: "Use mode=write with allowDangerousOperations only after review.",
    docsHint: "figma-repl://safety#read-mode",
  },
  {
    code: "FIGMA_REPL_READ_MODE_ASSIGNMENT",
    re: /\.(?:name|fills|strokes|characters|layoutMode|itemSpacing|paddingLeft|paddingRight|paddingTop|paddingBottom)\s*=/u,
    message: "read mode rejected a likely property assignment.",
    suggestion: "Use mode=write or a .figma.js script when mutation is intended.",
    docsHint: "figma-repl://safety#read-mode",
  },
  {
    code: "FIGMA_REPL_READ_MODE_RESIZE",
    re: /\.resize(?:WithoutConstraints)?\s*\(/u,
    message: "read mode rejected resize.",
    suggestion: "Use mode=write or a .figma.js script when mutation is intended.",
    docsHint: "figma-repl://safety#read-mode",
  },
];

const API_CONTRACT_PATTERNS = [
  {
    code: "FIGMA_REPL_CURRENT_PAGE_ASSIGNMENT",
    re: /\bfigma\.currentPage\s*=/u,
    message: "figma.currentPage is not assigned directly in the Plugin API.",
    suggestion: "Use await figma.setCurrentPageAsync(page) or figma_repl_run_script_file targetPageId.",
    docsHint: "figma-repl://safety#page-context",
  },
  {
    code: "FIGMA_REPL_ROOT_FIND_ALL",
    re: /\bfigma\.root\.findAll\s*\(/u,
    message: "figma.root.findAll() can scan the whole file and is not allowed through this layer.",
    suggestion: "Use $.find or $.findAll scoped to currentPage or a handle.",
    docsHint: "figma-repl://patterns#query",
  },
  {
    code: "FIGMA_REPL_PLUGIN_DATA",
    re: /\.(?:getPluginData|setPluginData|getSharedPluginData|setSharedPluginData)\s*\(/u,
    message: "Plugin data APIs are not a reliable agent-facing persistence layer for this REPL.",
    suggestion: "Use local handles/session metadata or a dedicated upstream workflow.",
    docsHint: "figma-repl://safety#facade-routing-delegation-boundaries",
  },
  {
    code: "FIGMA_REPL_IMAGE_CREATION",
    re: /\bfigma\.createImage(?:Async)?\s*\(/u,
    message: "Raw image creation is outside the supported script-file asset workflow.",
    suggestion: "Use $.imageAsset({ base64, parent, size, position, as }) in .figma.js, or route unusual asset uploads through an upstream official tool.",
    docsHint: "figma-repl://scripts#helpers",
  },
];

const TEXT_MUTATION_PATTERN = /(?:\.characters\s*=|\.fontName\s*=|figma\.createText\s*\()/u;
const MAX_INLINE_IMAGE_ASSET_BASE64_CHARS = 96 * 1024;
const INLINE_IMAGE_ASSET_BASE64_PATTERN = /\$\.imageAsset\s*\([\s\S]*?\bbase64\s*:\s*(["'`])([A-Za-z0-9+/=\s]+)\1/gu;
const CHECKPOINT_HANDLE_AS_NAME_PATTERN = /\$\.checkpoint\s*\(\s*(["'`])\$/u;
const UPSTREAM_EVAL_CODE_LIMIT_BYTES = 50_000;
const UPSTREAM_EVAL_CODE_WARNING_BYTES = 49_000;

function toFileDiagnostics(
  scriptPath: string,
  source: string,
  diagnostics: FigmaReplDiagnostic[],
): FigmaReplFileDiagnostic[] {
  return diagnostics.map((diagnostic) => ({
    ...diagnostic,
    source: {
      scriptPath,
      ...locateDiagnosticSource(source, diagnostic.code),
    },
  }));
}

function locateDiagnosticSource(
  source: string,
  code: string,
): { line?: number; column?: number } {
  const pattern = diagnosticPatternForCode(code);
  if (!pattern) {
    return {};
  }
  const match = pattern.exec(source);
  if (!match || match.index < 0) {
    return {};
  }
  return offsetToLineColumn(source, match.index);
}

function diagnosticPatternForCode(code: string): RegExp | undefined {
  const allPatterns = [
    ...RAW_CODE_DANGEROUS_PATTERNS,
    ...READ_MODE_WRITE_PATTERNS,
    ...API_CONTRACT_PATTERNS,
  ];
  const pattern = allPatterns.find((item) => item.code === code)?.re;
  if (pattern) {
    return new RegExp(pattern.source, pattern.flags.replace("g", ""));
  }
  if (code === "FIGMA_REPL_TEXT_MUTATION_NEEDS_FONT") {
    return new RegExp(TEXT_MUTATION_PATTERN.source, TEXT_MUTATION_PATTERN.flags.replace("g", ""));
  }
  if (code === "FIGMA_REPL_MULTIPLE_PAGE_SWITCH") {
    return /\bfigma\.setCurrentPageAsync\s*\(/u;
  }
  if (code === "FIGMA_REPL_DIRECT_SELECTION_ACCESS") {
    return /\bfigma\.currentPage\.selection\b/u;
  }
  if (code === "FIGMA_REPL_IMAGE_ASSET_INLINE_TOO_LARGE") {
    return /\$\.imageAsset\s*\(/u;
  }
  if (code === "FIGMA_REPL_CHECKPOINT_HANDLE_AS_NAME") {
    return /\$\.checkpoint\s*\(/u;
  }
  if (code === "FIGMA_REPL_SURFACE_FIGJAM_API_IN_DESIGN") {
    return /\bfigma\.create(?:Sticky|Connector|ShapeWithText|CodeBlock|Table)\s*\(/u;
  }
  if (code === "FIGMA_REPL_SURFACE_DESIGN_API_IN_FIGJAM") {
    return /\bfigma\.create(?:Frame|Component|ComponentSet|Instance)\s*\(/u;
  }
  if (code === "FIGMA_REPL_SURFACE_CANVAS_API_IN_SLIDES") {
    return /\bfigma\.create(?:Frame|Component|Sticky|Connector|ShapeWithText)\s*\(/u;
  }
  return undefined;
}

function offsetToLineColumn(source: string, offset: number): { line: number; column: number } {
  let line = 1;
  let column = 1;
  for (let index = 0; index < offset; index += 1) {
    if (source[index] === "\n") {
      line += 1;
      column = 1;
    } else {
      column += 1;
    }
  }
  return { line, column };
}

function countLines(source: string): number {
  if (source.length === 0) {
    return 0;
  }
  return source.split(/\r?\n/u).length;
}

function diagnoseSurfaceCode(
  code: string,
  expectedSurface: FigmaReplSurface | undefined,
): FigmaReplDiagnostic[] {
  if (!expectedSurface) {
    return [];
  }
  const diagnostics: FigmaReplDiagnostic[] = [];
  if (expectedSurface === "design" && /\bfigma\.create(?:Sticky|Connector|ShapeWithText|CodeBlock|Table)\s*\(/u.test(code)) {
    diagnostics.push(createDiagnostic(
      "FIGMA_REPL_SURFACE_FIGJAM_API_IN_DESIGN",
      "fatal",
      "FigJam creation APIs were used while the session expects a Design file.",
      "Use a FigJam-specific workflow or open the session with expectedSurface='figjam'.",
      "figma-repl://safety#surface",
    ));
  }
  if (expectedSurface === "figjam" && /\bfigma\.create(?:Frame|Component|ComponentSet|Instance)\s*\(/u.test(code)) {
    diagnostics.push(createDiagnostic(
      "FIGMA_REPL_SURFACE_DESIGN_API_IN_FIGJAM",
      "fatal",
      "Design canvas APIs were used while the session expects a FigJam board.",
      "Use FigJam-specific helpers for boards or open the session with expectedSurface='design'.",
      "figma-repl://safety#surface",
    ));
  }
  if (expectedSurface === "slides" && /\bfigma\.create(?:Frame|Component|Sticky|Connector|ShapeWithText)\s*\(/u.test(code)) {
    diagnostics.push(createDiagnostic(
      "FIGMA_REPL_SURFACE_CANVAS_API_IN_SLIDES",
      "fatal",
      "Canvas mutation APIs were used while the session expects Slides.",
      "Use the official Slides workflow rather than the REPL mutation layer.",
      "figma-repl://safety#surface",
    ));
  }
  return diagnostics;
}

export function diagnoseFigmaReplContext(options: {
  expectedSurface?: FigmaReplSurface;
  derivedSurface?: FigmaReplSurface;
  fileUrl?: string;
}): FigmaReplDiagnostic[] {
  if (
    options.expectedSurface &&
    options.derivedSurface &&
    options.expectedSurface !== options.derivedSurface
  ) {
    return [
      createDiagnostic(
        "FIGMA_REPL_SURFACE_MISMATCH",
        "fatal",
        `Open expected ${options.expectedSurface} but the Figma URL looks like ${options.derivedSurface}.`,
        "Check the file URL or expectedSurface before running mutations.",
        "figma-repl://safety#surface",
      ),
    ];
  }
  return [];
}

function createDiagnostic(
  code: string,
  severity: FigmaReplDiagnosticSeverity,
  message: string,
  suggestion: string,
  docsHint: string,
): FigmaReplDiagnostic {
  return { code, severity, message, suggestion, docsHint };
}

function dedupeDiagnostics(diagnostics: FigmaReplDiagnostic[]): FigmaReplDiagnostic[] {
  const seen = new Set<string>();
  const result: FigmaReplDiagnostic[] = [];
  for (const diagnostic of diagnostics) {
    const key = `${diagnostic.code}:${diagnostic.severity}`;
    if (!seen.has(key)) {
      seen.add(key);
      result.push(diagnostic);
    }
  }
  return result;
}

function asOptionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function literal(value: unknown): string {
  return JSON.stringify(value);
}
