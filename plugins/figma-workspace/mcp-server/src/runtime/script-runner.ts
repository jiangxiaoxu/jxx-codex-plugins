import { parse } from "acorn";
import { parse as parseBabel } from "@babel/parser";
import { createRequire } from "node:module";
import { existsSync, readFileSync } from "node:fs";
import { basename, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import * as ts from "typescript";

export type FigmaWorkspaceSurface = "design" | "figjam" | "slides";

export type FigmaWorkspaceDiagnosticSeverity = "fatal" | "warning";

export interface FigmaWorkspaceDiagnostic {
  code: string;
  severity: FigmaWorkspaceDiagnosticSeverity;
  message: string;
  suggestion: string;
  docsHint: string;
  location?: {
    line?: number;
    column?: number;
  };
}

export interface FigmaWorkspaceFileDiagnostic extends FigmaWorkspaceDiagnostic {
  source: {
    scriptPath: string;
    line?: number;
    column?: number;
    occurrences?: Array<{ line: number; column: number }>;
  };
}

export interface FigmaWorkspaceRepairOccurrence {
  scriptPath?: string;
  line?: number;
  column?: number;
  label?: string;
}

export interface FigmaWorkspaceRepairStep {
  code: string;
  severity: FigmaWorkspaceDiagnosticSeverity;
  message: string;
  suggestion: string;
  docsHint: string;
  occurrences: FigmaWorkspaceRepairOccurrence[];
}

export interface FigmaWorkspaceRepairPlan {
  status: "ok" | "parse_error" | "blocked" | "warning";
  summary: string;
  steps: FigmaWorkspaceRepairStep[];
}

export interface FigmaWorkspaceDiagnosticsOptions {
  allowDangerousOperations?: boolean;
  mode?: "read" | "write";
  generatedCode?: boolean;
  expectedSurface?: FigmaWorkspaceSurface;
  strict?: boolean;
}

export type FigmaWorkspaceScriptHelperName =
  | "select"
  | "text"
  | "findFreeSlot"
  | "placeNode"
  | "replaceGeneratedFrame"
  | "imageAsset"
  | "inspect"
  | "screenshot"
  | "cloneNodeTree"
  | "checkpoint";

export interface FigmaWorkspaceScriptHelperSelection {
  helperNames: Set<FigmaWorkspaceScriptHelperName>;
  baseProperties: Set<string>;
  injectedHelpers: string[];
  helperUsage: FigmaWorkspaceScriptHelperUsageReport;
}

export interface FigmaWorkspaceScriptHelperUsageReport {
  direct: string[];
  transitive: string[];
  runtimeBase: string[];
  injected: string[];
}

export interface CompiledFigmaWorkspaceScriptFile {
  code: string;
  diagnostics: FigmaWorkspaceFileDiagnostic[];
  metadata: {
    scriptPath: string;
    sourceBytes: number;
    sourceLineCount: number;
    helperApiVersion: string;
    injectedHelpers: string[];
    helperUsage: FigmaWorkspaceScriptHelperUsageReport;
    targetPageId?: string;
    expectedSurface?: FigmaWorkspaceSurface;
  };
}

const nodeRequire = createRequire(import.meta.url);
const runtimeDirname = dirname(fileURLToPath(import.meta.url));
const FIGMA_TYPESCRIPT_EXTENSION = ".figma.ts";
const TYPESCRIPT_WRAPPER_START = "// __FIGMA_WORKSPACE_TS_BODY_START__";
const TYPESCRIPT_WRAPPER_END = "// __FIGMA_WORKSPACE_TS_BODY_END__";
const TYPESCRIPT_WRAPPER_PREFIX = `async function __figmaWorkspaceTypescriptBody() {\n${TYPESCRIPT_WRAPPER_START}\n`;
const TYPESCRIPT_WRAPPER_SUFFIX = `\n${TYPESCRIPT_WRAPPER_END}\n}`;
const TYPESCRIPT_SOURCE_LINE_OFFSET = countLines(TYPESCRIPT_WRAPPER_PREFIX) - 1;
const TYPESCRIPT_WORKSPACE_HELPER_TYPES_PATH = "__figma_workspace_helpers.d.ts";
const FIGMA_WORKSPACE_HELPER_DECLARATIONS_PATH = resolve(runtimeDirname, "figma-workspace-helpers.d.ts");
const FIGMA_PLUGIN_TYPINGS_PATH = resolve(runtimeDirname, "figma-plugin-typings/index.d.ts");
const TYPESCRIPT_LIB_DIR = resolve(runtimeDirname, "typescript-lib");

export function compileFigmaWorkspaceScriptFile(options: {
  scriptPath: string;
  source: string;
  targetPageId?: string;
  expectedSurface?: FigmaWorkspaceSurface;
  allowDangerousOperations?: boolean;
  strict?: boolean;
}): CompiledFigmaWorkspaceScriptFile {
  const preparedSource = prepareFigmaWorkspaceScriptSource(options);
  const helperSelection = resolveFigmaWorkspaceScriptHelperSelection(preparedSource.source);
  const diagnosticOptions: FigmaWorkspaceDiagnosticsOptions = {
    allowDangerousOperations: options.allowDangerousOperations,
    expectedSurface: options.expectedSurface,
    mode: "write",
    strict: options.strict,
  };
  const runtimeDiagnostics = toFigmaWorkspaceFileDiagnostics(
    options.scriptPath,
    preparedSource.source,
    diagnoseFigmaWorkspaceCode(preparedSource.source, diagnosticOptions),
    diagnosticOptions,
  );
  const hasRuntimeParseError = runtimeDiagnostics.some((diagnostic) => diagnostic.code === "FIGMA_WORKSPACE_PARSE_ERROR");
  const diagnostics = hasRuntimeParseError
    ? runtimeDiagnostics
    : [...preparedSource.diagnostics, ...runtimeDiagnostics];
  const lines = [createFigmaWorkspaceScriptHelperBootstrap(helperSelection)];
  if (options.targetPageId) {
    lines.push(`{ const __targetPage = await getNodeById(${literal(options.targetPageId)}); if (__targetPage.type !== "PAGE") throw new Error("targetPageId must resolve to a PAGE node."); await figma.setCurrentPageAsync(__targetPage); }`);
  }
  lines.push(`// figma_workspace_run_script_file source: ${options.scriptPath}`);
  lines.push(preparedSource.source);
  return {
    code: lines.join("\n"),
    diagnostics,
    metadata: {
      scriptPath: options.scriptPath,
      sourceBytes: Buffer.byteLength(options.source, "utf8"),
      sourceLineCount: countLines(options.source),
      helperApiVersion: "1",
      injectedHelpers: helperSelection.injectedHelpers,
      helperUsage: helperSelection.helperUsage,
      targetPageId: options.targetPageId,
      expectedSurface: options.expectedSurface,
    },
  };
}

function prepareFigmaWorkspaceScriptSource(options: {
  scriptPath: string;
  source: string;
  strict?: boolean;
}): { source: string; diagnostics: FigmaWorkspaceFileDiagnostic[] } {
  if (!options.scriptPath.endsWith(FIGMA_TYPESCRIPT_EXTENSION)) {
    return { source: options.source, diagnostics: [] };
  }
  return compileFigmaWorkspaceTypescriptSource(options.scriptPath, options.source, Boolean(options.strict));
}

function compileFigmaWorkspaceTypescriptSource(
  scriptPath: string,
  source: string,
  strict: boolean,
): { source: string; diagnostics: FigmaWorkspaceFileDiagnostic[] } {
  const wrappedSource = `${TYPESCRIPT_WRAPPER_PREFIX}${source}${TYPESCRIPT_WRAPPER_SUFFIX}`;
  const compilerOptions = createFigmaWorkspaceTypescriptCompilerOptions(strict);
  const typescriptScriptPath = normalizeTypescriptFileName(scriptPath);
  const helperTypesPath = normalizeTypescriptFileName(`${scriptPath}.${TYPESCRIPT_WORKSPACE_HELPER_TYPES_PATH}`);
  const figmaTypingsPath = resolveFigmaPluginTypingsPath();
  const host = ts.createCompilerHost(compilerOptions, true);
  const originalReadFile = host.readFile.bind(host);
  const originalFileExists = host.fileExists.bind(host);
  host.readFile = (fileName) => {
    const normalizedFileName = normalizeTypescriptFileName(fileName);
    if (normalizedFileName === typescriptScriptPath) return wrappedSource;
    if (normalizedFileName === helperTypesPath) return readFigmaWorkspaceHelperDeclarations();
    const bundledLibPath = resolveBundledTypescriptLibPath(fileName);
    if (bundledLibPath) return readFileSync(bundledLibPath, "utf8");
    return originalReadFile(fileName);
  };
  host.fileExists = (fileName) => {
    const normalizedFileName = normalizeTypescriptFileName(fileName);
    return normalizedFileName === typescriptScriptPath ||
      normalizedFileName === helperTypesPath ||
      resolveBundledTypescriptLibPath(fileName) !== undefined ||
      originalFileExists(fileName);
  };
  const program = ts.createProgram({
    rootNames: [figmaTypingsPath, helperTypesPath, typescriptScriptPath],
    options: compilerOptions,
    host,
  });
  const sourceFile = program.getSourceFile(typescriptScriptPath);
  const syntacticDiagnostics = sourceFile ? program.getSyntacticDiagnostics(sourceFile) : [];
  const syntacticDiagnosticKeys = new Set(syntacticDiagnostics.map(typescriptDiagnosticIdentity));
  const preEmitDiagnostics = syntacticDiagnostics.length > 0
    ? syntacticDiagnostics
    : ts.getPreEmitDiagnostics(program);
  const diagnostics = preEmitDiagnostics
    .filter((diagnostic) => diagnostic.file === undefined || diagnostic.file === sourceFile)
    .map((diagnostic) => typescriptDiagnosticToFileDiagnostic(
      diagnostic,
      scriptPath,
      sourceFile,
      syntacticDiagnosticKeys.has(typescriptDiagnosticIdentity(diagnostic)),
    ));
  const transpiled = ts.transpileModule(wrappedSource, {
    fileName: scriptPath,
    compilerOptions,
    reportDiagnostics: false,
  });
  const transpiledBody = extractTypescriptTranspiledBody(transpiled.outputText);
  if (transpiledBody === undefined) {
    diagnostics.push({
      code: "FIGMA_WORKSPACE_TS_COMPILE_ERROR",
      severity: "fatal",
      message: "TypeScript preflight could not extract the compiled Figma script body.",
      suggestion: "Remove unusual top-level wrapper-like code and rerun the .figma.ts script.",
      docsHint: "figma_workspace_lookup kind=docs query=\"TypeScript Figma plugin typings\"",
      source: { scriptPath },
    });
  }
  return {
    source: transpiledBody ?? source,
    diagnostics,
  };
}

function createFigmaWorkspaceTypescriptCompilerOptions(strict: boolean): ts.CompilerOptions {
  return {
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Node10,
    lib: ["lib.es2022.d.ts", "lib.dom.d.ts"],
    strict: true,
    noImplicitAny: true,
    strictNullChecks: true,
    skipLibCheck: true,
    noEmitOnError: strict,
    isolatedModules: false,
    esModuleInterop: false,
    allowSyntheticDefaultImports: false,
    removeComments: false,
  };
}

function resolveFigmaPluginTypingsPath(): string {
  try {
    return nodeRequire.resolve("@figma/plugin-typings/index.d.ts");
  } catch {
    return FIGMA_PLUGIN_TYPINGS_PATH;
  }
}

function resolveBundledTypescriptLibPath(fileName: string): string | undefined {
  const file = basename(fileName);
  if (!/^lib\..*\.d\.ts$/u.test(file)) {
    return undefined;
  }
  const bundledPath = resolve(TYPESCRIPT_LIB_DIR, file);
  return existsSync(bundledPath) ? bundledPath : undefined;
}

function readFigmaWorkspaceHelperDeclarations(): string {
  return readFileSync(FIGMA_WORKSPACE_HELPER_DECLARATIONS_PATH, "utf8");
}

function normalizeTypescriptFileName(fileName: string): string {
  const normalized = fileName.replace(/\\/gu, "/");
  return ts.sys.useCaseSensitiveFileNames ? normalized : normalized.toLowerCase();
}

function typescriptDiagnosticToFileDiagnostic(
  diagnostic: ts.Diagnostic,
  scriptPath: string,
  sourceFile: ts.SourceFile | undefined,
  syntaxError: boolean,
): FigmaWorkspaceFileDiagnostic {
  const location = typescriptDiagnosticLocation(diagnostic, sourceFile);
  const message = ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n");
  return {
    code: syntaxError ? "FIGMA_WORKSPACE_PARSE_ERROR" : "FIGMA_WORKSPACE_TS_TYPE_ERROR",
    severity: "fatal",
    message: `${syntaxError ? "TypeScript syntax preflight failed" : "TypeScript preflight failed"}: ${message}`,
    suggestion: syntaxError
      ? "Fix all TypeScript syntax errors before running the Figma Workspace script; rerun afterward to get guardrail diagnostics."
      : "Fix the TypeScript error before running the Figma script. Use Figma Plugin API node types such as FrameNode, PageNode, or RectangleNode to model allowed methods.",
    docsHint: syntaxError
      ? "figma-workspace://guide#responseContract"
      : "figma_workspace_lookup kind=api symbol=ChildrenMixin.appendChild",
    source: {
      scriptPath,
      ...location,
    },
  };
}

function typescriptDiagnosticIdentity(diagnostic: ts.Diagnostic): string {
  const message = ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n");
  return `${diagnostic.code}:${diagnostic.start ?? ""}:${diagnostic.length ?? ""}:${message}`;
}

function typescriptDiagnosticLocation(
  diagnostic: ts.Diagnostic,
  sourceFile: ts.SourceFile | undefined,
): { line?: number; column?: number } {
  if (!sourceFile || diagnostic.file !== sourceFile || diagnostic.start === undefined) {
    return {};
  }
  const location = sourceFile.getLineAndCharacterOfPosition(diagnostic.start);
  const sourceLine = location.line + 1 - TYPESCRIPT_SOURCE_LINE_OFFSET;
  if (sourceLine < 1) {
    return {};
  }
  return {
    line: sourceLine,
    column: location.character + 1,
  };
}

function extractTypescriptTranspiledBody(outputText: string): string | undefined {
  const startMarkerIndex = outputText.indexOf(TYPESCRIPT_WRAPPER_START);
  const endMarkerIndex = outputText.indexOf(TYPESCRIPT_WRAPPER_END);
  if (startMarkerIndex < 0 || endMarkerIndex < 0 || endMarkerIndex <= startMarkerIndex) {
    return undefined;
  }
  const bodyStart = outputText.indexOf("\n", startMarkerIndex);
  if (bodyStart < 0 || bodyStart >= endMarkerIndex) {
    return undefined;
  }
  return outputText.slice(bodyStart + 1, endMarkerIndex).replace(/\n\s*$/u, "");
}

/**
 * @internal Internal helper-selection utility used by the workspace compiler.
 * This reports injected helper metadata; it is not an MCP caller configuration surface.
 */
export function resolveFigmaWorkspaceScriptHelperSelection(
  source: string,
): FigmaWorkspaceScriptHelperSelection {
  const usage = analyzeFigmaWorkspaceScriptHelperUsage(source);
  const directHelperNames = new Set(usage.helperNames);
  const directBaseProperties = new Set(usage.baseProperties);
  const helperNames = new Set(usage.helperNames);
  expandFigmaWorkspaceScriptHelperDependencies(helperNames);
  const baseProperties = new Set(usage.baseProperties);
  if (helperNames.size > 0) {
    for (const property of FIGMA_WORKSPACE_BASE_HELPER_PROPERTIES) baseProperties.add(property);
  }
  const injectedHelpers = [
    helperNames.size > 0 || baseProperties.size > 0 || usage.usesDollarFunction ? "$" : undefined,
    ...Array.from(baseProperties).sort().map((property) => `$.${property}`),
    ...FIGMA_WORKSPACE_SCRIPT_HELPERS.filter((helper) => helperNames.has(helper)).map((helper) => `$.${helper}`),
  ].filter((item): item is string => item !== undefined);
  const direct = [
    usage.usesDollarFunction ? "$" : undefined,
    ...Array.from(directBaseProperties).sort().map((property) => `$.${property}`),
    ...FIGMA_WORKSPACE_SCRIPT_HELPERS.filter((helper) => directHelperNames.has(helper)).map((helper) => `$.${helper}`),
  ].filter((item): item is string => item !== undefined);
  const transitive = FIGMA_WORKSPACE_SCRIPT_HELPERS
    .filter((helper) => helperNames.has(helper) && !directHelperNames.has(helper))
    .map((helper) => `$.${helper}`);
  const runtimeBase = Array.from(baseProperties).sort().map((property) => `$.${property}`);
  return {
    helperNames,
    baseProperties,
    injectedHelpers,
    helperUsage: {
      direct,
      transitive,
      runtimeBase,
      injected: injectedHelpers,
    },
  };
}

const FIGMA_WORKSPACE_SCRIPT_HELPERS: readonly FigmaWorkspaceScriptHelperName[] = [
  "select",
  "text",
  "findFreeSlot",
  "placeNode",
  "replaceGeneratedFrame",
  "imageAsset",
  "inspect",
  "screenshot",
  "cloneNodeTree",
  "checkpoint",
];

const FIGMA_WORKSPACE_SCRIPT_HELPER_SET = new Set<string>(FIGMA_WORKSPACE_SCRIPT_HELPERS);

const FIGMA_WORKSPACE_BASE_HELPER_PROPERTIES = new Set(["handles", "remember", "forget", "resolveId", "node"]);

interface FigmaWorkspaceScriptHelperUsage {
  helperNames: Set<FigmaWorkspaceScriptHelperName>;
  baseProperties: Set<string>;
  dynamicHelperAccess: boolean;
  usesDollarFunction: boolean;
}

function analyzeFigmaWorkspaceScriptHelperUsage(source: string): FigmaWorkspaceScriptHelperUsage {
  const parsed = parseFigmaWorkspaceCodeForDiagnostics(source);
  const helperNames = new Set<FigmaWorkspaceScriptHelperName>();
  const baseProperties = new Set<string>();
  let dynamicHelperAccess = false;
  let usesDollarFunction = false;
  if (!parsed.ast) {
    return { helperNames, baseProperties, dynamicHelperAccess: true, usesDollarFunction };
  }
  if (astContainsBindingIdentifier(parsed.ast, "$")) {
    return { helperNames, baseProperties, dynamicHelperAccess: true, usesDollarFunction };
  }
  const recordProperty = (property: string | undefined, dynamic = false) => {
    if (dynamic) {
      dynamicHelperAccess = true;
      return;
    }
    if (!property) return;
    if (property === "checkpoints") {
      helperNames.add("checkpoint");
      return;
    }
    if (FIGMA_WORKSPACE_SCRIPT_HELPER_SET.has(property)) {
      helperNames.add(property as FigmaWorkspaceScriptHelperName);
      return;
    }
    if (FIGMA_WORKSPACE_BASE_HELPER_PROPERTIES.has(property)) {
      baseProperties.add(property);
    }
  };
  visitAst(parsed.ast, (node) => {
    if ((node.type === "CallExpression" || node.type === "NewExpression") && getIdentifierName(node.callee) === "$") {
      usesDollarFunction = true;
    }
    if (node.type === "MemberExpression" && getIdentifierName(node.object) === "$") {
      recordProperty(readMemberPropertyName(node), node.computed === true && readMemberPropertyName(node) === undefined);
    }
    if (node.type === "VariableDeclarator" && getIdentifierName(node.init) === "$") {
      if (!isAstRecord(node.id) || node.id.type !== "ObjectPattern") {
        dynamicHelperAccess = true;
      } else {
        for (const property of Array.isArray(node.id.properties) ? node.id.properties : []) {
          if (!isAstRecord(property)) continue;
          if (property.type === "RestElement") {
            dynamicHelperAccess = true;
            continue;
          }
          recordProperty(readObjectPatternPropertyName(property));
        }
      }
    }
    if (node.type === "AssignmentExpression" && getIdentifierName(node.right) === "$") {
      dynamicHelperAccess = true;
    }
  });
  return { helperNames, baseProperties, dynamicHelperAccess, usesDollarFunction };
}

function expandFigmaWorkspaceScriptHelperDependencies(helperNames: Set<FigmaWorkspaceScriptHelperName>): void {
  let changed = true;
  while (changed) {
    changed = false;
    const add = (name: FigmaWorkspaceScriptHelperName) => {
      if (!helperNames.has(name)) {
        helperNames.add(name);
        changed = true;
      }
    };
    if (helperNames.has("placeNode")) add("findFreeSlot");
    if (helperNames.has("replaceGeneratedFrame")) {
      add("placeNode");
      add("findFreeSlot");
      add("select");
    }
    if (helperNames.has("cloneNodeTree")) add("select");
  }
}

function readObjectPatternPropertyName(property: AstRecord): string | undefined {
  const key = property.key;
  if (!isAstRecord(key)) return undefined;
  if (key.type === "Identifier" && typeof key.name === "string") return key.name;
  if (key.type === "Literal" && typeof key.value === "string") return key.value;
  return undefined;
}

function astContainsBindingIdentifier(ast: AstRecord, name: string): boolean {
  let found = false;
  visitAst(ast, (node) => {
    if (!found && findDeclaredBindingIdentifier(node, name)) {
      found = true;
    }
  });
  return found;
}

function findDeclaredBindingIdentifier(node: AstRecord, name: string): AstRecord | undefined {
  if (node.type === "VariableDeclarator") {
    return findBindingIdentifier(node.id, name);
  }
  if (node.type === "FunctionDeclaration" || node.type === "FunctionExpression") {
    return findBindingIdentifier(node.id, name) ?? findFirstBindingIdentifier(node.params, name);
  }
  if (node.type === "ArrowFunctionExpression") {
    return findFirstBindingIdentifier(node.params, name);
  }
  if (node.type === "ClassDeclaration" || node.type === "ClassExpression") {
    return findBindingIdentifier(node.id, name);
  }
  if (node.type === "CatchClause") {
    return findBindingIdentifier(node.param, name);
  }
  return undefined;
}

function findFirstBindingIdentifier(values: unknown, name: string): AstRecord | undefined {
  if (!Array.isArray(values)) {
    return undefined;
  }
  for (const value of values) {
    const found = findBindingIdentifier(value, name);
    if (found) return found;
  }
  return undefined;
}

function findBindingIdentifier(value: unknown, name: string): AstRecord | undefined {
  if (!isAstRecord(value)) {
    return undefined;
  }
  if (value.type === "Identifier") {
    return value.name === name ? value : undefined;
  }
  if (value.type === "RestElement") {
    return findBindingIdentifier(value.argument, name);
  }
  if (value.type === "AssignmentPattern") {
    return findBindingIdentifier(value.left, name);
  }
  if (value.type === "ArrayPattern") {
    return findFirstBindingIdentifier(value.elements, name);
  }
  if (value.type === "ObjectPattern" && Array.isArray(value.properties)) {
    for (const property of value.properties) {
      if (!isAstRecord(property)) continue;
      const found = property.type === "RestElement"
        ? findBindingIdentifier(property.argument, name)
        : findBindingIdentifier(property.value, name);
      if (found) return found;
    }
  }
  return undefined;
}

function createFigmaWorkspaceScriptHelperBootstrap(options: {
  helperNames: Set<FigmaWorkspaceScriptHelperName>;
  baseProperties: Set<string>;
}): string {
  if (options.helperNames.size === 0 && options.baseProperties.size === 0) {
    return "";
  }
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
function __figmaReplResolveSceneNodeForPlacement(value, name) {
  if (!value) throw new Error(name + " is required.");
  if (typeof value === "object" && "type" in value) return value;
  return $(value);
}
function __figmaReplCanPosition(node) {
  return node && "x" in node && "y" in node && "width" in node && "height" in node;
}
function __figmaReplReadSize(input, fallback) {
  const source = input && typeof input === "object" ? input : {};
  return {
    width: readFiniteNumber(source.width ?? fallback.width, "size.width"),
    height: readFiniteNumber(source.height ?? fallback.height, "size.height"),
  };
}
function __figmaReplBounds(node) {
  return { x: node.x, y: node.y, width: node.width, height: node.height };
}
function __figmaReplIntersects(a, b) {
  return a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y;
}
async function __figmaReplResolvePlacementParent(inputParent, node) {
  if (inputParent) return await __figmaReplResolveSceneNodeForPlacement(inputParent, "placement.parent");
  return node && node.parent ? node.parent : figma.currentPage;
}
async function __figmaReplFindFreeSlot(options = {}) {
  const input = options || {};
  const preferred = input.preferred || input.position || {};
  const parent = await __figmaReplResolvePlacementParent(input.parent);
  const size = __figmaReplReadSize(input.size, { width: 1, height: 1 });
  const gap = input.gap === undefined ? 40 : readFiniteNumber(input.gap, "gap");
  const direction = String(input.direction || "down");
  let x = readFiniteNumber(preferred.x ?? 0, "preferred.x");
  let y = readFiniteNumber(preferred.y ?? 0, "preferred.y");
  let shiftedSlots = 0;
  let collidedNodeIds = [];
  const children = "children" in parent ? Array.from(parent.children).filter((child) => child.visible !== false && __figmaReplCanPosition(child) && child !== input.exclude) : [];
  for (let attempt = 0; attempt < 500; attempt++) {
    const candidate = { x, y, width: size.width, height: size.height };
    const collisions = children.filter((child) => __figmaReplIntersects(candidate, __figmaReplBounds(child)));
    if (collisions.length === 0) {
      return { x, y, width: size.width, height: size.height, shiftedSlots, collidedNodeIds };
    }
    collidedNodeIds = collisions.map((child) => child.id);
    shiftedSlots += 1;
    if (direction === "right") x += size.width + gap;
    else if (direction === "left") x -= size.width + gap;
    else if (direction === "up") y -= size.height + gap;
    else y += size.height + gap;
  }
  throw new Error("$.findFreeSlot could not find a free slot after 500 attempts.");
}
$.findFreeSlot = __figmaReplFindFreeSlot;
$.placeNode = async function placeNode(target, options = {}) {
  const node = await __figmaReplResolveSceneNodeForPlacement(target, "$.placeNode target");
  if (!__figmaReplCanPosition(node)) {
    throw new Error("$.placeNode target must resolve to a positionable scene node.");
  }
  const input = options || {};
  const preferred = input.preferred || input.position || { x: node.x, y: node.y };
  let placement = { x: preferred.x, y: preferred.y, shiftedSlots: 0, collidedNodeIds: [] };
  if (input.avoidOverlap) {
    placement = await __figmaReplFindFreeSlot({ ...input, preferred, size: input.size || __figmaReplBounds(node), parent: input.parent, exclude: node });
  }
  node.x = readFiniteNumber(placement.x, "placement.x");
  node.y = readFiniteNumber(placement.y, "placement.y");
  if (input.as) remember(input.as, node);
  return placement;
};
$.replaceGeneratedFrame = async function replaceGeneratedFrame(options = {}) {
  const input = options || {};
  const name = String(input.name || "");
  if (!name) throw new Error("$.replaceGeneratedFrame requires an exact name.");
  const guardPrefixes = input.guardPrefix ? [String(input.guardPrefix)] : ["Variant ", "Codex Generated ", "Generated "];
  if (!guardPrefixes.some((prefix) => name.startsWith(prefix))) {
    throw new Error("$.replaceGeneratedFrame name must start with guardPrefix or one of: Variant , Codex Generated , Generated .");
  }
  const parent = input.parent
    ? await __figmaReplResolveSceneNodeForPlacement(input.parent, "$.replaceGeneratedFrame parent")
    : figma.currentPage;
  if (!parent || !("appendChild" in parent)) {
    throw new Error("$.replaceGeneratedFrame requires a writable parent.");
  }
  const children = "children" in parent ? Array.from(parent.children) : [];
  const existingFrames = children.filter((child) => child.type === "FRAME" && child.name === name);
  let frame = figma.createFrame();
  frame.name = name;
  if (input.size !== undefined) setNodeSizeFromInput(frame, input.size);
  if (input.position !== undefined) setNodePositionFromInput(frame, input.position);
  const firstExisting = existingFrames[0];
  const insertIndex = firstExisting ? children.indexOf(firstExisting) : -1;
  if (firstExisting && input.size === undefined) frame.resize(firstExisting.width, firstExisting.height);
  if (firstExisting && input.position === undefined) {
    frame.x = firstExisting.x;
    frame.y = firstExisting.y;
  }
  if (insertIndex >= 0 && "insertChild" in parent) parent.insertChild(insertIndex, frame);
  else parent.appendChild(frame);
  for (const existing of existingFrames) existing.remove();
  if (input.placement && input.placement.avoidOverlap) {
    await $.placeNode(frame, { ...input.placement, size: __figmaReplBounds(frame), exclude: frame });
  }
  if (input.as) remember(input.as, frame);
  const selection = input.select === false ? undefined : await $.select([frame], { zoom: input.zoom !== false, depth: 0 });
  return {
    replaced: existingFrames.map((node) => node.id),
    frame: summarizeNode(frame, input.depth || 0),
    selectedNodeIds: selection ? selection.selectedNodeIds : [],
    handle: input.as,
  };
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
  if (!options.baseProperties.has("handles")) {
    bootstrap = bootstrap.replace("$.handles = __figmaRepl.handles;\n", "");
  }
  if (!options.baseProperties.has("remember")) {
    bootstrap = bootstrap.replace("$.remember = remember;\n", "");
  }
  if (!options.baseProperties.has("forget")) {
    bootstrap = bootstrap.replace("$.forget = forget;\n", "");
  }
  if (!options.baseProperties.has("resolveId")) {
    bootstrap = bootstrap.replace("$.resolveId = resolveHandleId;\n", "");
  }
  if (!options.baseProperties.has("node")) {
    bootstrap = bootstrap.replace("$.node = $;\n", "");
  }
  if (!options.helperNames.has("select")) {
    bootstrap = replaceHelperBootstrapBlock(bootstrap, "$.select = async function select", "$.text = async function text", "");
  }
  if (!options.helperNames.has("text")) {
    bootstrap = replaceHelperBootstrapBlock(bootstrap, "$.text = async function text", "function __figmaReplResolveSceneNodeForPlacement", "");
  }
  if (!options.helperNames.has("findFreeSlot")) {
    bootstrap = replaceHelperBootstrapBlock(bootstrap, "function __figmaReplResolveSceneNodeForPlacement(value, name) {", "$.placeNode = async function placeNode", "");
  }
  if (!options.helperNames.has("placeNode")) {
    bootstrap = replaceHelperBootstrapBlock(bootstrap, "$.placeNode = async function placeNode", "$.replaceGeneratedFrame = async function replaceGeneratedFrame", "");
  }
  if (!options.helperNames.has("replaceGeneratedFrame")) {
    bootstrap = replaceHelperBootstrapBlock(bootstrap, "$.replaceGeneratedFrame = async function replaceGeneratedFrame", "function __figmaReplDecodeBase64(input) {", "");
  }
  if (!options.helperNames.has("imageAsset")) {
    bootstrap = replaceHelperBootstrapBlock(
      bootstrap,
      "function __figmaReplDecodeBase64(input) {",
      "$.inspect = async function inspect",
      "",
    );
  }
  if (!options.helperNames.has("inspect")) {
    bootstrap = replaceHelperBootstrapBlock(bootstrap, "$.inspect = async function inspect", "$.screenshot = async function screenshot", "");
  }
  if (!options.helperNames.has("screenshot")) {
    bootstrap = replaceHelperBootstrapBlock(bootstrap, "$.screenshot = async function screenshot", "$.cloneNodeTree = async function cloneNodeTree", "");
  }
  if (!options.helperNames.has("cloneNodeTree")) {
    bootstrap = replaceHelperBootstrapBlock(
      bootstrap,
      "$.cloneNodeTree = async function cloneNodeTree",
      "$.checkpoint = async function checkpoint",
      "",
    );
  }
  if (!options.helperNames.has("checkpoint")) {
    bootstrap = replaceHelperBootstrapBlock(bootstrap, "$.checkpoint = async function checkpoint", "$.checkpoints = __figmaReplScriptCheckpoints;", "");
    bootstrap = bootstrap.replace("const __figmaReplScriptCheckpoints = [];\n", "");
    bootstrap = bootstrap.replace("$.checkpoints = __figmaReplScriptCheckpoints;", "");
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

export function assertSafeFigmaWorkspaceCode(
  code: string,
  options: FigmaWorkspaceDiagnosticsOptions = {},
): void {
  throwIfFatalDiagnostics(diagnoseFigmaWorkspaceCode(code, options));
}

export function diagnoseFigmaWorkspaceCode(
  code: string,
  options: FigmaWorkspaceDiagnosticsOptions = {},
): FigmaWorkspaceDiagnostic[] {
  const diagnostics: FigmaWorkspaceDiagnostic[] = [];
  const add = (diagnostic: FigmaWorkspaceDiagnostic) => {
    diagnostics.push(options.strict && diagnostic.severity === "warning"
      ? { ...diagnostic, severity: "fatal" }
      : diagnostic);
  };
  const parsed = parseFigmaWorkspaceCodeForDiagnostics(code);
  if (!parsed.ast) {
    for (const diagnostic of parsed.diagnostics ?? []) {
      add(diagnostic);
    }
    return dedupeDiagnostics(diagnostics);
  }
  const analysis = analyzeFigmaWorkspaceAst(parsed.ast, options, code.length);
  if (!options.allowDangerousOperations) {
    for (const diagnostic of DANGEROUS_DIAGNOSTICS) {
      if (options.generatedCode && diagnostic.code === "FIGMA_WORKSPACE_NODE_REMOVAL") {
        continue;
      }
      if (analysis.codes.has(diagnostic.code)) {
        add(createDiagnostic(diagnostic.code, "fatal", diagnostic.message, diagnostic.suggestion, diagnostic.docsHint));
      }
    }
  }
  for (const diagnostic of API_CONTRACT_DIAGNOSTICS) {
    if (analysis.codes.has(diagnostic.code)) {
      add(createDiagnostic(diagnostic.code, "fatal", diagnostic.message, diagnostic.suggestion, diagnostic.docsHint));
    }
  }
  if (analysis.setCurrentPageAsyncCalls > 1) {
    add(createDiagnostic(
      "FIGMA_WORKSPACE_MULTIPLE_PAGE_SWITCH",
      "fatal",
      "Multiple figma.setCurrentPageAsync() calls in one transaction are error-prone.",
      "Use one targetPageId on figma_workspace_run_script_file or split page changes into separate script files.",
      "figma_workspace_lookup kind=api symbol=figma.setCurrentPageAsync",
    ));
  }
  if (!options.generatedCode && analysis.codes.has("FIGMA_WORKSPACE_DIRECT_SELECTION_ACCESS")) {
    add(createDiagnostic(
      "FIGMA_WORKSPACE_DIRECT_SELECTION_ACCESS",
      "warning",
      "Direct figma.currentPage.selection access is brittle in agent scripts.",
      "Use await $.select([...]) for selection writes, $.inspect('$selection') for summaries, or resolve explicit node ids/handles before mutation.",
      "figma-workspace://guide#scriptFileWorkflow",
    ));
  }
  if (options.mode === "read") {
    for (const diagnostic of READ_MODE_WRITE_DIAGNOSTICS) {
      if (analysis.codes.has(diagnostic.code)) {
        add(createDiagnostic(diagnostic.code, "fatal", diagnostic.message, diagnostic.suggestion, diagnostic.docsHint));
      }
    }
    if (analysis.codes.has("FIGMA_WORKSPACE_READ_MODE_ASSIGNMENT")) {
      add(createDiagnostic(
        "FIGMA_WORKSPACE_READ_MODE_ASSIGNMENT",
        "fatal",
        "read mode rejected a likely property assignment.",
        "Use mode=write or figma_workspace_run_script_file when mutation is intended.",
        "figma-workspace://guide#evalWorkflow",
      ));
    }
  }
  if (analysis.codes.has("FIGMA_WORKSPACE_TEXT_MUTATION_NEEDS_FONT")) {
    add(createDiagnostic(
      "FIGMA_WORKSPACE_TEXT_MUTATION_NEEDS_FONT",
      "warning",
      "Text mutation usually requires figma.loadFontAsync() before changing characters or fontName.",
      "Use $.text for helper-managed text creation, or await figma.loadFontAsync({ family, style }) for every font used before assigning characters or fontName.",
      "figma_workspace_lookup kind=api symbol=figma.loadFontAsync",
    ));
  }
  if (analysis.oversizedImageAssetBase64Length !== undefined) {
    add(createDiagnostic(
      "FIGMA_WORKSPACE_IMAGE_ASSET_INLINE_TOO_LARGE",
      "warning",
      `Inline $.imageAsset base64 is ${analysis.oversizedImageAssetBase64Length} characters and may exceed upstream MCP payload limits.`,
      "For large generated PNG/JPEG assets, create target rectangles in a .figma.ts script and use the official upload_assets/upstream asset workflow to fill them.",
      "figma-workspace://guide#assetWorkflow",
    ));
  }
  if (analysis.codes.has("FIGMA_WORKSPACE_CHECKPOINT_HANDLE_AS_NAME")) {
    add(createDiagnostic(
      "FIGMA_WORKSPACE_CHECKPOINT_HANDLE_AS_NAME",
      "warning",
      "$.checkpoint() appears to receive a handle as its first argument, but the first argument is the checkpoint name.",
      "Use $.checkpoint('meaningful-name', ['$handleOrNodeId'], { depth: 1 }).",
      "figma-workspace://guide#scriptFileWorkflow",
    ));
  }
  for (const diagnostic of diagnoseSurfaceCode(analysis, options.expectedSurface)) {
    add(diagnostic);
  }
  return dedupeDiagnostics(diagnostics);
}

export function diagnoseWrappedScriptSize(
  scriptPath: string,
  wrappedScript: string,
  strict: boolean,
): FigmaWorkspaceFileDiagnostic[] {
  const byteLength = Buffer.byteLength(wrappedScript, "utf8");
  if (byteLength < UPSTREAM_EVAL_CODE_WARNING_BYTES) {
    return [];
  }
  const overLimit = byteLength > UPSTREAM_EVAL_CODE_LIMIT_BYTES;
  return [{
    code: "FIGMA_WORKSPACE_SCRIPT_PAYLOAD_TOO_LARGE",
    severity: overLimit || strict ? "fatal" : "warning",
    message: `Compiled Figma script payload is ${byteLength} bytes; upstream use_figma accepts at most about ${UPSTREAM_EVAL_CODE_LIMIT_BYTES} characters.`,
    suggestion: "Split the work into smaller .figma.ts files, for example skeleton, asset targets, upload fills, and visual fixes.",
    docsHint: "figma-workspace://guide#scriptFileWorkflow",
    source: { scriptPath },
  }];
}

export function throwIfFatalDiagnostics(diagnostics: FigmaWorkspaceDiagnostic[]): void {
  const fatal = diagnostics.filter((diagnostic) => diagnostic.severity === "fatal");
  if (fatal.length === 0) {
    return;
  }
  throw new Error(
    `Figma Workspace diagnostics blocked execution: ${fatal.map((item) => item.code).join(", ")}. ${fatal[0]?.suggestion ?? ""}`,
  );
}

export function createFigmaWorkspaceRepairPlan(
  diagnostics: FigmaWorkspaceFileDiagnostic[] | undefined,
): FigmaWorkspaceRepairPlan {
  const items = diagnostics ?? [];
  const fatalCount = items.filter((diagnostic) => diagnostic.severity === "fatal").length;
  const warningCount = items.filter((diagnostic) => diagnostic.severity === "warning").length;
  const hasParseError = items.some((diagnostic) => diagnostic.code === "FIGMA_WORKSPACE_PARSE_ERROR");
  const status: FigmaWorkspaceRepairPlan["status"] = hasParseError
    ? "parse_error"
    : fatalCount > 0
      ? "blocked"
      : warningCount > 0
        ? "warning"
        : "ok";
  return {
    status,
    summary: repairPlanSummary(status, fatalCount, warningCount),
    steps: repairPlanSteps(items, hasParseError),
  };
}

function repairPlanSummary(
  status: FigmaWorkspaceRepairPlan["status"],
  fatalCount: number,
  warningCount: number,
): string {
  if (status === "parse_error") {
    return "Fix all TypeScript syntax errors first, then rerun to get full Figma Workspace guardrail diagnostics.";
  }
  if (status === "blocked") {
    return `Preflight blocked execution with ${fatalCount} fatal diagnostic${fatalCount === 1 ? "" : "s"}; apply all repair steps before rerunning.`;
  }
  if (status === "warning") {
    return `Preflight completed with ${warningCount} warning${warningCount === 1 ? "" : "s"}; review repair steps before relying on the result.`;
  }
  return "No preflight repairs are required.";
}

function repairPlanSteps(
  diagnostics: FigmaWorkspaceFileDiagnostic[],
  parseErrorOnly: boolean,
): FigmaWorkspaceRepairStep[] {
  if (parseErrorOnly) {
    return diagnostics
      .filter((diagnostic) => diagnostic.code === "FIGMA_WORKSPACE_PARSE_ERROR")
      .map((diagnostic) => repairPlanStepFromDiagnostic(diagnostic));
  }
  const steps = new Map<string, FigmaWorkspaceRepairStep>();
  for (const diagnostic of diagnostics) {
    const key = `${diagnostic.code}:${diagnostic.severity}:${diagnostic.suggestion}`;
    const existing = steps.get(key);
    if (existing) {
      existing.occurrences.push(...repairOccurrences(diagnostic));
      continue;
    }
    steps.set(key, repairPlanStepFromDiagnostic(diagnostic));
  }
  return Array.from(steps.values()).map((step) => ({
    ...step,
    occurrences: dedupeRepairOccurrences(step.occurrences),
  }));
}

function repairPlanStepFromDiagnostic(diagnostic: FigmaWorkspaceFileDiagnostic): FigmaWorkspaceRepairStep {
  return {
    code: diagnostic.code,
    severity: diagnostic.severity,
    message: diagnostic.message,
    suggestion: diagnostic.suggestion,
    docsHint: diagnostic.docsHint,
    occurrences: repairOccurrences(diagnostic),
  };
}

function repairOccurrences(diagnostic: FigmaWorkspaceFileDiagnostic): FigmaWorkspaceRepairOccurrence[] {
  if (diagnostic.source.occurrences && diagnostic.source.occurrences.length > 0) {
    return diagnostic.source.occurrences.map((occurrence) => removeUndefined({
      scriptPath: diagnostic.source.scriptPath,
      line: occurrence.line,
      column: occurrence.column,
      label: locationLabel(occurrence.line, occurrence.column),
    }) as FigmaWorkspaceRepairOccurrence);
  }
  const occurrence = removeUndefined({
    scriptPath: diagnostic.source.scriptPath,
    line: diagnostic.source.line,
    column: diagnostic.source.column,
    label: locationLabel(diagnostic.source.line, diagnostic.source.column),
  }) as FigmaWorkspaceRepairOccurrence;
  return Object.keys(occurrence).length > 0 ? [occurrence] : [];
}

function dedupeRepairOccurrences(
  occurrences: FigmaWorkspaceRepairOccurrence[],
): FigmaWorkspaceRepairOccurrence[] {
  const seen = new Set<string>();
  const result: FigmaWorkspaceRepairOccurrence[] = [];
  for (const occurrence of occurrences) {
    const key = `${occurrence.scriptPath ?? ""}:${occurrence.line ?? ""}:${occurrence.column ?? ""}`;
    if (!seen.has(key)) {
      seen.add(key);
      result.push(occurrence);
    }
  }
  return result;
}

function locationLabel(line: number | undefined, column: number | undefined): string | undefined {
  if (line === undefined) {
    return undefined;
  }
  return column === undefined ? String(line) : `${line}:${column}`;
}

const DANGEROUS_DIAGNOSTICS = [
  {
    code: "FIGMA_WORKSPACE_DYNAMIC_EVAL",
    message: "Dynamic code evaluation is disabled by default.",
    suggestion: "Pass allowDangerousOperations=true only after reviewing the exact script.",
    docsHint: "figma_workspace_lookup kind=docs query=\"dynamic code safety\"",
  },
  {
    code: "FIGMA_WORKSPACE_NETWORK_ACCESS",
    message: "Network access from workspace code is disabled by default.",
    suggestion: "Fetch data outside Figma or pass allowDangerousOperations=true after review.",
    docsHint: "figma_workspace_lookup kind=docs query=\"network access safety\"",
  },
  {
    code: "FIGMA_WORKSPACE_DYNAMIC_IMPORT",
    message: "Dynamic import is disabled by default.",
    suggestion: "Inline the required logic or pass allowDangerousOperations=true after review.",
    docsHint: "figma_workspace_lookup kind=docs query=\"dynamic import safety\"",
  },
  {
    code: "FIGMA_WORKSPACE_NODE_REMOVAL",
    message: "Direct remove() is destructive and can break clone rebuilds, especially inside instance subtrees.",
    suggestion: "Prefer $.replaceGeneratedFrame for guarded generated-frame replacement or $.cloneNodeTree for copy/rebuild workflows; use allowDangerousOperations=true only after reviewing every removal occurrence.",
    docsHint: "figma-workspace://guide#scriptFileWorkflow",
  },
  {
    code: "FIGMA_WORKSPACE_FIGMA_DELETE",
    message: "Deleting properties on the figma object is not supported.",
    suggestion: "Use documented Plugin API calls only.",
    docsHint: "figma_workspace_lookup kind=api symbol=PluginAPI",
  },
  {
    code: "FIGMA_WORKSPACE_DESTRUCTIVE_OPERATION",
    message: "Destructive Figma operation is disabled by default.",
    suggestion: "Pass allowDangerousOperations=true only after reviewing the exact effect.",
    docsHint: "figma-workspace://guide#scriptFileWorkflow",
  },
];

const READ_MODE_WRITE_DIAGNOSTICS = [
  {
    code: "FIGMA_WORKSPACE_READ_MODE_CREATE",
    message: "read mode rejected node creation.",
    suggestion: "Use mode=write or figma_workspace_run_script_file when mutation is intended.",
    docsHint: "figma-workspace://guide#evalWorkflow",
  },
  {
    code: "FIGMA_WORKSPACE_READ_MODE_APPEND",
    message: "read mode rejected child insertion.",
    suggestion: "Use mode=write or figma_workspace_run_script_file when mutation is intended.",
    docsHint: "figma-workspace://guide#evalWorkflow",
  },
  {
    code: "FIGMA_WORKSPACE_READ_MODE_REMOVE",
    message: "read mode rejected node removal.",
    suggestion: "Use mode=write with allowDangerousOperations only after review.",
    docsHint: "figma-workspace://guide#evalWorkflow",
  },
  {
    code: "FIGMA_WORKSPACE_READ_MODE_RESIZE",
    message: "read mode rejected resize.",
    suggestion: "Use mode=write or figma_workspace_run_script_file when mutation is intended.",
    docsHint: "figma-workspace://guide#evalWorkflow",
  },
];

const READ_MODE_ASSIGNMENT_PROPERTIES = new Set([
  "name",
  "fills",
  "strokes",
  "characters",
  "layoutMode",
  "itemSpacing",
  "paddingLeft",
  "paddingRight",
  "paddingTop",
  "paddingBottom",
]);

interface AstRecord {
  type?: unknown;
  [key: string]: unknown;
}

interface ParsedDiagnosticAst {
  ast?: AstRecord;
  diagnostics?: FigmaWorkspaceDiagnostic[];
}

interface FigmaWorkspaceAstAnalysis {
  codes: Set<string>;
  codeOffsets: Map<string, number[]>;
  setCurrentPageAsyncCalls: number;
  oversizedImageAssetBase64Length?: number;
}

const DIAGNOSTIC_PROBE_PREFIX = "async function __figmaReplDiagnosticsProbe() {\n";

function parseFigmaWorkspaceCodeForDiagnostics(code: string): ParsedDiagnosticAst {
  const wrappedCode = `${DIAGNOSTIC_PROBE_PREFIX}${code}\n}`;
  try {
    const ast = parse(wrappedCode, {
      ecmaVersion: "latest",
      sourceType: "script",
    });
    return isAstRecord(ast)
      ? { ast }
      : {
          diagnostics: [createDiagnostic(
            "FIGMA_WORKSPACE_PARSE_ERROR",
            "fatal",
            "Script could not be parsed.",
            "Fix script syntax before running the Figma Workspace script.",
            "figma-workspace://guide#responseContract",
          )],
        };
  } catch (error) {
    const recovered = parseFigmaWorkspaceCodeWithRecovery(wrappedCode, code);
    if (recovered.diagnostics.length > 0) {
      return { diagnostics: recovered.diagnostics };
    }
    return {
      diagnostics: [createDiagnostic(
        "FIGMA_WORKSPACE_PARSE_ERROR",
        "fatal",
        `Script could not be parsed.${formatErrorDetail(error)}`,
        "Fix script syntax before running the Figma Workspace script.",
        "figma-workspace://guide#responseContract",
      )],
    };
  }
}

function parseFigmaWorkspaceCodeWithRecovery(wrappedCode: string, source: string): { diagnostics: FigmaWorkspaceDiagnostic[] } {
  try {
    const parsed = parseBabel(wrappedCode, {
      sourceType: "script",
      errorRecovery: true,
      allowReturnOutsideFunction: false,
    });
    const errors = Array.isArray(parsed.errors) ? parsed.errors : [];
    return { diagnostics: errors.map((error) => createParseDiagnostic(error, source)) };
  } catch (error) {
    return { diagnostics: [createParseDiagnostic(error, source)] };
  }
}

function createParseDiagnostic(error: unknown, source: string): FigmaWorkspaceDiagnostic {
  const detail = formatErrorDetail(error);
  return {
    ...createDiagnostic(
    "FIGMA_WORKSPACE_PARSE_ERROR",
    "fatal",
    `Script could not be parsed.${detail}`,
    "Fix all script syntax errors before running the Figma Workspace script; rerun afterward to get guardrail diagnostics.",
    "figma-workspace://guide#responseContract",
    ),
    location: parseErrorLocation(error, source),
  };
}

function formatErrorDetail(error: unknown): string {
  return error instanceof Error && error.message ? ` ${error.message}` : "";
}

function parseErrorLocation(error: unknown, source: string): { line?: number; column?: number } | undefined {
  if (!isAstRecord(error)) {
    return undefined;
  }
  const loc = error.loc;
  if (!isAstRecord(loc)) {
    return undefined;
  }
  const rawLine = typeof loc.line === "number" ? loc.line : undefined;
  const rawColumn = typeof loc.column === "number" ? loc.column : undefined;
  if (rawLine === undefined) {
    return undefined;
  }
  const sourceLine = rawLine - 1;
  if (sourceLine < 1 || sourceLine > countLines(source)) {
    return undefined;
  }
  return {
    line: sourceLine,
    column: rawColumn === undefined ? undefined : rawColumn + 1,
  };
}

function analyzeFigmaWorkspaceAst(
  ast: AstRecord,
  options: FigmaWorkspaceDiagnosticsOptions,
  sourceLength: number,
): FigmaWorkspaceAstAnalysis {
  const codes = new Set<string>();
  const codeOffsets = new Map<string, number[]>();
  let setCurrentPageAsyncCalls = 0;
  let hasTextMutation = false;
  let firstTextMutationNode: unknown;
  let hasLoadFontAsyncCall = false;
  let oversizedImageAssetBase64Length: number | undefined;
  const recordCode = (code: string, node?: unknown) => {
    codes.add(code);
    const offset = astNodeSourceOffset(node, sourceLength);
    if (offset !== undefined) {
      const offsets = codeOffsets.get(code) ?? [];
      offsets.push(offset);
      codeOffsets.set(code, offsets);
    }
  };
  const recordTextMutation = (node: unknown) => {
    hasTextMutation = true;
    firstTextMutationNode ??= node;
  };
  visitAst(ast, (node) => {
    const dollarBinding = findDeclaredBindingIdentifier(node, "$");
    if (dollarBinding) {
      recordCode("FIGMA_WORKSPACE_DYNAMIC_HELPER_ACCESS", dollarBinding);
    }
    if (node.type === "CallExpression" || node.type === "NewExpression") {
      const callee = node.callee;
      const calleePath = getMemberPath(callee);
      const calleeName = calleePath?.at(-1) ?? getIdentifierName(callee);
      if (calleeName === "eval" || calleeName === "Function" || (node.type === "NewExpression" && calleeName === "Function")) {
        recordCode("FIGMA_WORKSPACE_DYNAMIC_EVAL", callee);
      }
      if (calleeName === "fetch" || calleeName === "XMLHttpRequest" || calleeName === "WebSocket") {
        recordCode("FIGMA_WORKSPACE_NETWORK_ACCESS", callee);
      }
      if (calleePath && pathEquals(calleePath, ["figma", "setCurrentPageAsync"])) {
        setCurrentPageAsyncCalls += 1;
        recordCode("FIGMA_WORKSPACE_MULTIPLE_PAGE_SWITCH", callee);
      }
      if (calleePath && pathEquals(calleePath, ["figma", "root", "findAll"])) {
        recordCode("FIGMA_WORKSPACE_ROOT_FIND_ALL", callee);
      }
      if (calleePath && pathEquals(calleePath, ["figma", "loadFontAsync"])) {
        hasLoadFontAsyncCall = true;
      }
      if (calleePath && pathEquals(calleePath, ["figma", "createText"])) {
        recordTextMutation(callee);
      }
      if (calleePath && pathEquals(calleePath, ["figma", "createImage"])) {
        recordCode("FIGMA_WORKSPACE_IMAGE_CREATION", callee);
      }
      if (calleePath && pathEquals(calleePath, ["figma", "createImageAsync"])) {
        recordCode("FIGMA_WORKSPACE_IMAGE_CREATION", callee);
      }
      if (calleePath?.[0] === "figma" && calleePath.length === 2 && isReadModeCreateMethod(calleePath[1])) {
        recordCode("FIGMA_WORKSPACE_READ_MODE_CREATE", callee);
      }
      if (calleeName === "appendChild" || calleeName === "insertChild") {
        recordCode("FIGMA_WORKSPACE_READ_MODE_APPEND", callee);
      }
      if (calleeName === "remove") {
        recordCode("FIGMA_WORKSPACE_NODE_REMOVAL", callee);
        recordCode("FIGMA_WORKSPACE_READ_MODE_REMOVE", callee);
      }
      if (calleeName === "resize" || calleeName === "resizeWithoutConstraints") {
        recordCode("FIGMA_WORKSPACE_READ_MODE_RESIZE", callee);
      }
      if (calleeName === "detachInstance" || calleeName === "flatten") {
        recordCode("FIGMA_WORKSPACE_DESTRUCTIVE_OPERATION", callee);
      }
      if (
        calleeName === "getPluginData" ||
        calleeName === "setPluginData" ||
        calleeName === "getSharedPluginData" ||
        calleeName === "setSharedPluginData"
      ) {
        recordCode("FIGMA_WORKSPACE_PLUGIN_DATA", callee);
      }
      if (calleePath && pathEquals(calleePath, ["$", "checkpoint"]) && isHandleString(readCallArgument(node, 0))) {
        recordCode("FIGMA_WORKSPACE_CHECKPOINT_HANDLE_AS_NAME", callee);
      }
      if (calleePath && pathEquals(calleePath, ["$", "imageAsset"])) {
        const base64 = readImageAssetBase64Argument(node);
        const base64Length = base64?.replace(/\s+/gu, "").length;
        if (
          base64Length !== undefined &&
          base64Length > MAX_INLINE_IMAGE_ASSET_BASE64_CHARS &&
          oversizedImageAssetBase64Length === undefined
        ) {
          oversizedImageAssetBase64Length = base64Length;
          recordCode("FIGMA_WORKSPACE_IMAGE_ASSET_INLINE_TOO_LARGE", callee);
        }
      }
      recordSurfaceCall(recordCode, calleePath, options.expectedSurface, callee);
    }
    if (node.type === "VariableDeclarator" && getIdentifierName(node.init) === "$") {
      if (!isAstRecord(node.id) || node.id.type !== "ObjectPattern") {
        recordCode("FIGMA_WORKSPACE_DYNAMIC_HELPER_ACCESS", node);
      } else {
        for (const property of Array.isArray(node.id.properties) ? node.id.properties : []) {
          if (isAstRecord(property) && property.type === "RestElement") {
            recordCode("FIGMA_WORKSPACE_DYNAMIC_HELPER_ACCESS", property);
          }
        }
      }
    }
    if (node.type === "AssignmentExpression" && getIdentifierName(node.right) === "$") {
      recordCode("FIGMA_WORKSPACE_DYNAMIC_HELPER_ACCESS", node);
    }
    if (node.type === "ImportExpression" || node.type === "Import") {
      recordCode("FIGMA_WORKSPACE_DYNAMIC_IMPORT", node);
    }
    if (node.type === "AssignmentExpression") {
      const leftPath = getMemberPath(node.left);
      if (leftPath && pathEquals(leftPath, ["figma", "currentPage"])) {
        recordCode("FIGMA_WORKSPACE_CURRENT_PAGE_ASSIGNMENT", node.left);
      }
      if (isReadModeMutableMember(node.left)) {
        recordCode("FIGMA_WORKSPACE_READ_MODE_ASSIGNMENT", node.left);
      }
      if (isTextMutationMember(node.left)) {
        recordTextMutation(node.left);
      }
    }
    if (node.type === "UpdateExpression" && isReadModeMutableMember(node.argument)) {
      recordCode("FIGMA_WORKSPACE_READ_MODE_ASSIGNMENT", node.argument);
    }
    if (node.type === "UnaryExpression" && node.operator === "delete") {
      const argumentPath = getMemberPath(node.argument);
      if (argumentPath?.[0] === "figma") {
        recordCode("FIGMA_WORKSPACE_FIGMA_DELETE", node);
      }
    }
    if (node.type === "MemberExpression") {
      const memberPath = getMemberPath(node);
      if (memberPath && pathEquals(memberPath, ["figma", "currentPage", "selection"])) {
        recordCode("FIGMA_WORKSPACE_DIRECT_SELECTION_ACCESS", node);
      }
      if (getIdentifierName(node.object) === "$" && node.computed === true && readMemberPropertyName(node) === undefined) {
        recordCode("FIGMA_WORKSPACE_DYNAMIC_HELPER_ACCESS", node);
      }
    }
  });
  if (hasTextMutation && !hasLoadFontAsyncCall) {
    recordCode("FIGMA_WORKSPACE_TEXT_MUTATION_NEEDS_FONT", firstTextMutationNode);
  }
  return { codes, codeOffsets, setCurrentPageAsyncCalls, oversizedImageAssetBase64Length };
}

function visitAst(value: unknown, visitor: (node: AstRecord) => void): void {
  if (Array.isArray(value)) {
    for (const item of value) {
      visitAst(item, visitor);
    }
    return;
  }
  if (!isAstRecord(value)) {
    return;
  }
  visitor(value);
  for (const [key, child] of Object.entries(value)) {
    if (key === "type" || key === "start" || key === "end" || key === "loc" || key === "range") {
      continue;
    }
    visitAst(child, visitor);
  }
}

function recordSurfaceCall(
  recordCode: (code: string, node?: unknown) => void,
  calleePath: string[] | undefined,
  expectedSurface: FigmaWorkspaceSurface | undefined,
  node?: unknown,
): void {
  if (!expectedSurface || !calleePath || calleePath[0] !== "figma" || calleePath.length !== 2) {
    return;
  }
  const method = calleePath[1];
  if (expectedSurface === "design" && FIGJAM_CREATION_METHODS.has(method)) {
    recordCode("FIGMA_WORKSPACE_SURFACE_FIGJAM_API_IN_DESIGN", node);
  }
  if (expectedSurface === "figjam" && DESIGN_CREATION_METHODS.has(method)) {
    recordCode("FIGMA_WORKSPACE_SURFACE_DESIGN_API_IN_FIGJAM", node);
  }
  if (expectedSurface === "slides" && SLIDES_BLOCKED_CREATION_METHODS.has(method)) {
    recordCode("FIGMA_WORKSPACE_SURFACE_CANVAS_API_IN_SLIDES", node);
  }
}

function isReadModeCreateMethod(name: string): boolean {
  const suffixStart = "create".length;
  const firstSuffix = name.at(suffixStart);
  return name.startsWith("create") && firstSuffix !== undefined && firstSuffix >= "A" && firstSuffix <= "Z";
}

function isTextMutationMember(value: unknown): boolean {
  const path = getMemberPath(value);
  const property = path?.at(-1);
  return property === "characters" || property === "fontName";
}

function readImageAssetBase64Argument(callExpression: AstRecord): string | undefined {
  const firstArgument = readCallArgument(callExpression, 0);
  const directBase64 = readStringLiteral(firstArgument);
  if (directBase64 !== undefined) {
    return directBase64;
  }
  if (!isAstRecord(firstArgument) || firstArgument.type !== "ObjectExpression") {
    return undefined;
  }
  return readStringLiteral(readObjectPropertyValue(firstArgument, "base64"));
}

function readCallArgument(callExpression: AstRecord, index: number): unknown {
  return Array.isArray(callExpression.arguments) ? callExpression.arguments[index] : undefined;
}

function readObjectPropertyValue(objectExpression: AstRecord, propertyName: string): unknown {
  if (!Array.isArray(objectExpression.properties)) {
    return undefined;
  }
  for (const property of objectExpression.properties) {
    if (!isAstRecord(property) || property.type !== "Property") {
      continue;
    }
    const key = readPropertyKeyName(property);
    if (key === propertyName) {
      return property.value;
    }
  }
  return undefined;
}

function readPropertyKeyName(property: AstRecord): string | undefined {
  const key = property.key;
  if (!isAstRecord(key)) {
    return undefined;
  }
  if (key.type === "Identifier" && typeof key.name === "string" && property.computed !== true) {
    return key.name;
  }
  if (key.type === "Literal" && typeof key.value === "string") {
    return key.value;
  }
  return undefined;
}

function readStringLiteral(value: unknown): string | undefined {
  if (!isAstRecord(value)) {
    return undefined;
  }
  if (value.type === "Literal" && typeof value.value === "string") {
    return value.value;
  }
  if (value.type === "TemplateLiteral" && Array.isArray(value.expressions) && value.expressions.length === 0) {
    const quasi = Array.isArray(value.quasis) ? value.quasis[0] : undefined;
    if (isAstRecord(quasi) && isAstRecord(quasi.value) && typeof quasi.value.cooked === "string") {
      return quasi.value.cooked;
    }
  }
  return undefined;
}

function isHandleString(value: unknown): boolean {
  return readStringLiteral(value)?.startsWith("$") === true;
}

function getMemberPath(value: unknown): string[] | undefined {
  if (!isAstRecord(value)) {
    return undefined;
  }
  if (value.type === "Identifier" && typeof value.name === "string") {
    return [value.name];
  }
  if (value.type !== "MemberExpression") {
    return undefined;
  }
  const objectPath = getMemberPath(value.object);
  const propertyName = readMemberPropertyName(value);
  return objectPath && propertyName ? [...objectPath, propertyName] : undefined;
}

function getIdentifierName(value: unknown): string | undefined {
  return isAstRecord(value) && value.type === "Identifier" && typeof value.name === "string"
    ? value.name
    : undefined;
}

function pathEquals(actual: string[], expected: string[]): boolean {
  return actual.length === expected.length && actual.every((part, index) => part === expected[index]);
}

function isReadModeMutableMember(value: unknown): boolean {
  if (!isAstRecord(value) || value.type !== "MemberExpression") {
    return false;
  }
  const property = readMemberPropertyName(value);
  return property !== undefined && READ_MODE_ASSIGNMENT_PROPERTIES.has(property);
}

function readMemberPropertyName(memberExpression: AstRecord): string | undefined {
  const property = memberExpression.property;
  if (!isAstRecord(property)) {
    return undefined;
  }
  if (property.type === "Identifier" && typeof property.name === "string" && memberExpression.computed !== true) {
    return property.name;
  }
  if (property.type === "Literal" && typeof property.value === "string") {
    return property.value;
  }
  return undefined;
}

function isAstRecord(value: unknown): value is AstRecord {
  return Boolean(value && typeof value === "object");
}

function astNodeSourceOffset(value: unknown, sourceLength: number): number | undefined {
  if (!isAstRecord(value) || typeof value.start !== "number") {
    return undefined;
  }
  const offset = value.start - DIAGNOSTIC_PROBE_PREFIX.length;
  return Number.isInteger(offset) && offset >= 0 && offset < sourceLength
    ? offset
    : undefined;
}

const API_CONTRACT_DIAGNOSTICS = [
  {
    code: "FIGMA_WORKSPACE_CURRENT_PAGE_ASSIGNMENT",
    message: "figma.currentPage is not assigned directly in the Plugin API.",
    suggestion: "Use await figma.setCurrentPageAsync(page) or figma_workspace_run_script_file targetPageId.",
    docsHint: "figma_workspace_lookup kind=api symbol=figma.setCurrentPageAsync",
  },
  {
    code: "FIGMA_WORKSPACE_ROOT_FIND_ALL",
    message: "figma.root.findAll() can scan the whole file and is not allowed through this layer.",
    suggestion: "Use scoped Plugin API queries such as figma.currentPage.findAll(...) or figma_workspace_inspect for known targets; avoid proving file-wide absence from one root scan.",
    docsHint: "figma_workspace_lookup kind=docs query=\"selection query findAll\"",
  },
  {
    code: "FIGMA_WORKSPACE_PLUGIN_DATA",
    message: "Plugin data APIs are not a reliable agent-facing persistence layer for this workspace.",
    suggestion: "Use local handles/session metadata or a dedicated upstream workflow.",
    docsHint: "figma-workspace://lookup-index#ownership",
  },
  {
    code: "FIGMA_WORKSPACE_IMAGE_CREATION",
    message: "Raw image creation is outside the supported script-file asset workflow.",
    suggestion: "For large/local generated assets, create target rectangles and use figma_workspace_apply_asset_manifest; use $.imageAsset only for small inline PNG/JPEG payloads.",
    docsHint: "figma-workspace://guide#assetWorkflow",
  },
  {
    code: "FIGMA_WORKSPACE_DYNAMIC_HELPER_ACCESS",
    message: "Dynamic $ helper access cannot be statically analyzed for on-demand helper injection.",
    suggestion: "Use a literal retained helper access such as $.text(...) or $[\"text\"](...); avoid $[name](...), object rest destructuring, aliasing $, or declaring a local $.",
    docsHint: "figma-workspace://guide#scriptFileWorkflow",
  },
];

const FIGJAM_CREATION_METHODS = new Set(["createSticky", "createConnector", "createShapeWithText", "createCodeBlock", "createTable"]);
const DESIGN_CREATION_METHODS = new Set(["createFrame", "createComponent", "createComponentSet", "createInstance"]);
const SLIDES_BLOCKED_CREATION_METHODS = new Set(["createFrame", "createComponent", "createSticky", "createConnector", "createShapeWithText"]);
const MAX_INLINE_IMAGE_ASSET_BASE64_CHARS = 96 * 1024;
const UPSTREAM_EVAL_CODE_LIMIT_BYTES = 50_000;
const UPSTREAM_EVAL_CODE_WARNING_BYTES = 49_000;
const DIAGNOSTIC_SOURCE_PATTERNS = [
  { code: "FIGMA_WORKSPACE_DYNAMIC_EVAL", re: /\b(?:eval|Function)\s*\(/u },
  { code: "FIGMA_WORKSPACE_NETWORK_ACCESS", re: /\b(?:fetch|XMLHttpRequest|WebSocket)\b/u },
  { code: "FIGMA_WORKSPACE_DYNAMIC_IMPORT", re: /\bimport\s*\(/u },
  { code: "FIGMA_WORKSPACE_NODE_REMOVAL", re: /\.remove\s*\(/u },
  { code: "FIGMA_WORKSPACE_FIGMA_DELETE", re: /\bdelete\s+figma\./u },
  { code: "FIGMA_WORKSPACE_DESTRUCTIVE_OPERATION", re: /\.(?:detachInstance|flatten)\s*\(/u },
  { code: "FIGMA_WORKSPACE_READ_MODE_CREATE", re: /figma\.create[A-Z]/u },
  { code: "FIGMA_WORKSPACE_READ_MODE_APPEND", re: /\.(?:appendChild|insertChild)\s*\(/u },
  { code: "FIGMA_WORKSPACE_READ_MODE_REMOVE", re: /\.remove\s*\(/u },
  { code: "FIGMA_WORKSPACE_READ_MODE_ASSIGNMENT", re: /\.(?:name|fills|strokes|characters|layoutMode|itemSpacing|paddingLeft|paddingRight|paddingTop|paddingBottom)\s*(?:=|\+\+|--)/u },
  { code: "FIGMA_WORKSPACE_READ_MODE_RESIZE", re: /\.resize(?:WithoutConstraints)?\s*\(/u },
  { code: "FIGMA_WORKSPACE_CURRENT_PAGE_ASSIGNMENT", re: /\bfigma\.currentPage\s*=/u },
  { code: "FIGMA_WORKSPACE_ROOT_FIND_ALL", re: /\bfigma\.root\.findAll\s*\(/u },
  { code: "FIGMA_WORKSPACE_PLUGIN_DATA", re: /\.(?:getPluginData|setPluginData|getSharedPluginData|setSharedPluginData)\s*\(/u },
  { code: "FIGMA_WORKSPACE_IMAGE_CREATION", re: /\bfigma\.createImage(?:Async)?\s*\(/u },
  { code: "FIGMA_WORKSPACE_TEXT_MUTATION_NEEDS_FONT", re: /(?:\.characters\s*=|\.fontName\s*=|figma\.createText\s*\()/u },
  { code: "FIGMA_WORKSPACE_MULTIPLE_PAGE_SWITCH", re: /\bfigma\.setCurrentPageAsync\s*\(/u },
  { code: "FIGMA_WORKSPACE_DIRECT_SELECTION_ACCESS", re: /\bfigma\.currentPage\.selection\b/u },
  { code: "FIGMA_WORKSPACE_IMAGE_ASSET_INLINE_TOO_LARGE", re: /\$\.imageAsset\s*\(/u },
  { code: "FIGMA_WORKSPACE_CHECKPOINT_HANDLE_AS_NAME", re: /\$\.checkpoint\s*\(/u },
  { code: "FIGMA_WORKSPACE_SURFACE_FIGJAM_API_IN_DESIGN", re: /\bfigma\.create(?:Sticky|Connector|ShapeWithText|CodeBlock|Table)\s*\(/u },
  { code: "FIGMA_WORKSPACE_SURFACE_DESIGN_API_IN_FIGJAM", re: /\bfigma\.create(?:Frame|Component|ComponentSet|Instance)\s*\(/u },
  { code: "FIGMA_WORKSPACE_SURFACE_CANVAS_API_IN_SLIDES", re: /\bfigma\.create(?:Frame|Component|Sticky|Connector|ShapeWithText)\s*\(/u },
];

export function toFigmaWorkspaceFileDiagnostics(
  scriptPath: string,
  source: string,
  diagnostics: FigmaWorkspaceDiagnostic[],
  options: FigmaWorkspaceDiagnosticsOptions,
): FigmaWorkspaceFileDiagnostic[] {
  const astSources = locateAstDiagnosticSources(source, diagnostics, options);
  const astSourceIndexes = new Map<string, number>();
  return diagnostics.map((diagnostic) => {
    const allAstSources = astSources.get(diagnostic.code);
    return {
      ...diagnostic,
      source: {
      scriptPath,
      ...(
        diagnostic.location ??
        nextAstDiagnosticSource(astSources, astSourceIndexes, diagnostic.code) ??
        locateDiagnosticSource(source, diagnostic.code)
      ),
        occurrences: allAstSources && allAstSources.length > 1 ? allAstSources : undefined,
      },
    };
  });
}

function nextAstDiagnosticSource(
  astSources: Map<string, Array<{ line: number; column: number }>>,
  astSourceIndexes: Map<string, number>,
  code: string,
): { line: number; column: number } | undefined {
  const sources = astSources.get(code);
  if (!sources || sources.length === 0) {
    return undefined;
  }
  const index = astSourceIndexes.get(code) ?? 0;
  astSourceIndexes.set(code, index + 1);
  return sources[Math.min(index, sources.length - 1)];
}

function locateAstDiagnosticSources(
  source: string,
  diagnostics: FigmaWorkspaceDiagnostic[],
  options: FigmaWorkspaceDiagnosticsOptions,
): Map<string, Array<{ line: number; column: number }>> {
  if (diagnostics.length === 0) {
    return new Map();
  }
  const parsed = parseFigmaWorkspaceCodeForDiagnostics(source);
  if (!parsed.ast) {
    return new Map();
  }
  const analysis = analyzeFigmaWorkspaceAst(parsed.ast, options, source.length);
  const located = new Map<string, Array<{ line: number; column: number }>>();
  for (const diagnostic of diagnostics) {
    const offsets = analysis.codeOffsets.get(diagnostic.code);
    if (offsets !== undefined) {
      located.set(diagnostic.code, offsets.map((offset) => offsetToLineColumn(source, offset)));
    }
  }
  return located;
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
  return DIAGNOSTIC_SOURCE_PATTERNS.find((item) => item.code === code)?.re;
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
  analysis: FigmaWorkspaceAstAnalysis,
  expectedSurface: FigmaWorkspaceSurface | undefined,
): FigmaWorkspaceDiagnostic[] {
  if (!expectedSurface) {
    return [];
  }
  const diagnostics: FigmaWorkspaceDiagnostic[] = [];
  if (analysis.codes.has("FIGMA_WORKSPACE_SURFACE_FIGJAM_API_IN_DESIGN")) {
    diagnostics.push(createDiagnostic(
      "FIGMA_WORKSPACE_SURFACE_FIGJAM_API_IN_DESIGN",
      "fatal",
      "FigJam creation APIs were used while the session expects a Design file.",
      "Use a FigJam-specific workflow or open the session with surface='figjam'.",
      "figma_workspace_lookup kind=docs query=\"FigJam surface APIs\"",
    ));
  }
  if (analysis.codes.has("FIGMA_WORKSPACE_SURFACE_DESIGN_API_IN_FIGJAM")) {
    diagnostics.push(createDiagnostic(
      "FIGMA_WORKSPACE_SURFACE_DESIGN_API_IN_FIGJAM",
      "fatal",
      "Design canvas APIs were used while the session expects a FigJam board.",
      "Use FigJam-specific helpers for boards or open the session with surface='design'.",
      "figma_workspace_lookup kind=docs query=\"FigJam Design surface APIs\"",
    ));
  }
  if (analysis.codes.has("FIGMA_WORKSPACE_SURFACE_CANVAS_API_IN_SLIDES")) {
    diagnostics.push(createDiagnostic(
      "FIGMA_WORKSPACE_SURFACE_CANVAS_API_IN_SLIDES",
      "fatal",
      "Canvas mutation APIs were used while the session expects Slides.",
      "Use the official Slides workflow rather than the workspace mutation layer.",
      "figma_workspace_lookup kind=docs query=\"Slides surface APIs\"",
    ));
  }
  return diagnostics;
}

export function diagnoseFigmaWorkspaceContext(options: {
  expectedSurface?: FigmaWorkspaceSurface;
  derivedSurface?: FigmaWorkspaceSurface;
  fileUrl?: string;
}): FigmaWorkspaceDiagnostic[] {
  if (
    options.expectedSurface &&
    options.derivedSurface &&
    options.expectedSurface !== options.derivedSurface
  ) {
    return [
      createDiagnostic(
        "FIGMA_WORKSPACE_SURFACE_MISMATCH",
        "fatal",
        `Open expected ${options.expectedSurface} but the Figma URL looks like ${options.derivedSurface}.`,
        "Check the file URL or surface before running mutations.",
        "figma_workspace_lookup kind=docs query=\"Figma surface routing\"",
      ),
    ];
  }
  return [];
}

function createDiagnostic(
  code: string,
  severity: FigmaWorkspaceDiagnosticSeverity,
  message: string,
  suggestion: string,
  docsHint: string,
): FigmaWorkspaceDiagnostic {
  return { code, severity, message, suggestion, docsHint };
}

function dedupeDiagnostics(diagnostics: FigmaWorkspaceDiagnostic[]): FigmaWorkspaceDiagnostic[] {
  const seen = new Set<string>();
  const result: FigmaWorkspaceDiagnostic[] = [];
  for (const diagnostic of diagnostics) {
    const key = diagnostic.code === "FIGMA_WORKSPACE_PARSE_ERROR"
      ? `${diagnostic.code}:${diagnostic.severity}:${diagnostic.message}:${diagnostic.location?.line ?? ""}:${diagnostic.location?.column ?? ""}`
      : `${diagnostic.code}:${diagnostic.severity}`;
    if (!seen.has(key)) {
      seen.add(key);
      result.push(diagnostic);
    }
  }
  return result;
}

function removeUndefined<T extends Record<string, unknown>>(record: T): Record<string, unknown> {
  return Object.fromEntries(Object.entries(record).filter(([, value]) => value !== undefined));
}

function literal(value: unknown): string {
  return JSON.stringify(value);
}
