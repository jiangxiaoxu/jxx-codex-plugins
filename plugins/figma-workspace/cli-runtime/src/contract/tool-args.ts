import type { FigmaWorkspaceSurface } from "../runtime/script-runner.js";
import { isCompositeCapableFigmaNodeId, isFigmaFileKey, isSimpleFigmaNodeId } from "./figma-target.js";
import {
  FIGMA_WORKSPACE_IMAGE_SCALE_MODES,
  FIGMA_WORKSPACE_IMAGE_SCALE_MODE_PATTERN,
  INLINE_RESULT_LIMIT_MAX,
  INLINE_RESULT_LIMIT_MIN,
  MAX_MANIFEST_ITEMS,
} from "./json-command-primitives.js";
import { assertValidFigmaJsonCommand, assertValidFigmaJsonSchema } from "./json-command-validator.js";
import { schemaCodeConnectPlanArguments } from "./json-command-contracts.js";
export {
  FIGMA_WORKSPACE_IMAGE_SCALE_MODES,
  FIGMA_WORKSPACE_IMAGE_SCALE_MODE_PATTERN,
  INLINE_RESULT_LIMIT_MAX,
  INLINE_RESULT_LIMIT_MIN,
  MAX_MANIFEST_ITEMS,
} from "./json-command-primitives.js";

export class FigmaWorkspaceToolArgumentError extends Error {
  override readonly name = "FigmaWorkspaceToolArgumentError";
}

export const LOOKUP_RESULTS_MIN = 1;
export const LOOKUP_RESULTS_MAX = 10;
export const LOOKUP_SNIPPET_LINES_MIN = 1;
export const LOOKUP_SNIPPET_LINES_MAX = 16;
export const DOCS_CATALOG_LIMIT_MIN = 1;
export const DOCS_CATALOG_LIMIT_MAX = 100;
export const CAPTURE_MAX_DIMENSION_MIN = 1;
export const CAPTURE_MAX_DIMENSION_MAX = 65_536;
export const INSPECT_DEPTH_MIN = 0;
export const INSPECT_DEPTH_MAX = Number.MAX_SAFE_INTEGER;
export const FIGMA_WORKSPACE_INSPECT_DETAIL_FIELDS = [
  "name",
  "visible",
  "x",
  "y",
  "width",
  "height",
  "locked",
  "layoutMode",
  "layoutPositioning",
  "characters",
] as const;
export type FigmaWorkspaceInspectField = (typeof FIGMA_WORKSPACE_INSPECT_DETAIL_FIELDS)[number];
export const DEFAULT_FIGMA_WORKSPACE_INSPECT_FIELDS: readonly FigmaWorkspaceInspectField[] = [
  ...FIGMA_WORKSPACE_INSPECT_DETAIL_FIELDS,
];
export const LIBRARIES_OFFSET_MIN = 0;
export const LIBRARIES_OFFSET_MAX = Number.MAX_SAFE_INTEGER;

export interface FigmaWorkspaceExplicitNodeTarget {
  fileKey: string;
  nodeId: string;
}

export type FigmaWorkspaceNodeTarget = string | FigmaWorkspaceExplicitNodeTarget;

interface InvocationArguments {
  [key: string]: unknown;
  title?: string;
  file?: string;
  surface?: FigmaWorkspaceSurface;
  outputDir?: string;
  inlineResultLimit?: number;
}

export interface FigmaWorkspaceRunArguments extends InvocationArguments {
  scriptPath?: string;
  source?: string;
  targetPageId?: string;
}

export interface FigmaWorkspaceAssetManifestAsset {
  [key: string]: unknown;
  path?: string;
  target?: FigmaWorkspaceNodeTarget;
  nodeUrl?: string;
  url?: string;
  scaleMode?: string;
  name?: string;
  metadata?: Record<string, unknown>;
}

export interface FigmaWorkspaceApplyAssetManifestArguments extends InvocationArguments {
  assets?: FigmaWorkspaceAssetManifestAsset[];
  validateTargets?: boolean;
}

export interface FigmaWorkspaceDownloadAssetsArguments extends InvocationArguments {
  target?: FigmaWorkspaceNodeTarget;
  defaultFormat?: "png" | "jpg" | "svg" | "pdf";
  defaultScale?: number;
}

export interface FigmaWorkspaceCaptureNodeArguments extends InvocationArguments {
  target?: FigmaWorkspaceNodeTarget;
  nodeId?: string;
  imageFile?: string;
  maxDimension?: number;
  contentsOnly?: boolean;
}

export interface FigmaWorkspaceCallUpstreamToolArguments extends InvocationArguments {
  toolName: string;
  arguments?: Record<string, unknown>;
  refresh?: boolean;
}

export interface FigmaWorkspaceGetMetadataArguments extends InvocationArguments {
  target?: FigmaWorkspaceNodeTarget;
  nodeId?: string;
  refresh?: boolean;
}

export interface FigmaWorkspaceGetDesignContextArguments extends InvocationArguments {
  target?: FigmaWorkspaceNodeTarget;
  nodeId?: string;
  refresh?: boolean;
  clientLanguages?: string;
  clientFrameworks?: string;
  forceCode?: boolean;
  disableCodeConnect?: boolean;
  excludeScreenshot?: boolean;
}

export interface FigmaWorkspaceGetMotionContextArguments extends InvocationArguments {
  target?: FigmaWorkspaceNodeTarget;
  nodeId?: string;
  recursive?: boolean;
  clientLanguages?: string;
  clientFrameworks?: string;
  refresh?: boolean;
}

export interface FigmaWorkspaceDesignSystemQuery {
  entity: "component" | "variable" | "style";
  query: string;
}

export interface FigmaWorkspaceSearchDesignSystemArguments extends InvocationArguments {
  queries: FigmaWorkspaceDesignSystemQuery[];
  disableCodeConnect?: boolean;
  includeLibraryKeys?: string[];
  refresh?: boolean;
}

export interface FigmaWorkspaceGetLibrariesArguments extends InvocationArguments {
  offset?: number;
  refresh?: boolean;
}

export interface FigmaWorkspaceGetVariableDefsArguments extends InvocationArguments {
  target?: FigmaWorkspaceNodeTarget;
  nodeId?: string;
  refresh?: boolean;
}

export type FigmaWorkspaceDocsLookupScope = "auto" | "active" | "conditional" | "router" | "examples" | "all";
export type FigmaWorkspaceTaskFamily =
  | "code-connect" | "create-file" | "design-to-code" | "design-generation"
  | "diagram" | "library-generation" | "motion-implementation" | "swiftui"
  | "figjam" | "motion" | "slides" | "design-editing";

export interface FigmaWorkspaceLookupArguments {
  [key: string]: unknown;
  title?: string;
  kind: "docs" | "api";
  mode?: "search" | "read";
  scope?: FigmaWorkspaceDocsLookupScope;
  surface?: FigmaWorkspaceSurface;
  taskFamily?: FigmaWorkspaceTaskFamily;
  query?: string;
  symbol?: string;
  selector?: string;
  maxResults?: number;
  maxSnippetLines?: number;
}

export type FigmaWorkspaceDocsArguments =
  | { [key: string]: unknown; mode: "list" }
  | { [key: string]: unknown; mode: "catalog"; taskFamily?: FigmaWorkspaceTaskFamily; surface?: FigmaWorkspaceSurface; classification?: "active" | "conditional" | "router" | "examples"; limit?: number }
  | { [key: string]: unknown; mode: "read"; id: string };

export interface FigmaWorkspaceInspectArguments extends InvocationArguments {
  mode?: "inspect" | "style";
  target?: FigmaWorkspaceNodeTarget;
  nodeId?: string;
  depth?: number;
  cursor?: string;
  fields?: FigmaWorkspaceInspectField[];
}

export interface FigmaWorkspaceUpstreamToolsArguments {
  [key: string]: unknown;
  name?: string;
  refresh?: boolean;
}

export interface FigmaWorkspaceCodeConnectInspectArguments extends InvocationArguments {}

export interface FigmaWorkspaceCodeConnectMapping {
  nodeId: string;
  componentName: string;
  source: string;
  label: string;
  conflictPolicy?: "fail" | "replace";
}

export interface FigmaWorkspaceCodeConnectManifest {
  schemaVersion: 1;
  scope: { nodeId: string };
  client?: { languages?: string; frameworks?: string };
  mappings: FigmaWorkspaceCodeConnectMapping[];
}

export interface FigmaWorkspaceCodeConnectPlanArguments extends InvocationArguments {
  manifest: FigmaWorkspaceCodeConnectManifest;
  outputPlanPath?: string;
}

export interface FigmaWorkspaceCodeConnectApplyArguments extends InvocationArguments {
  planPath: string;
  confirmPlan?: string;
}

export interface FigmaWorkspaceCodeConnectVerifyArguments extends InvocationArguments {
  planPath: string;
}

export interface FigmaWorkspaceDoctorArguments { [key: string]: unknown }

const SURFACES = ["design", "figjam", "slides"] as const;
const DOC_SCOPES = ["auto", "active", "conditional", "router", "examples", "all"] as const;
const TASK_FAMILIES = ["code-connect", "create-file", "design-to-code", "design-generation", "diagram", "library-generation", "motion-implementation", "swiftui", "figjam", "motion", "slides", "design-editing"] as const;

export function asRunArgs(value: unknown): FigmaWorkspaceRunArguments {
  const args = parse<FigmaWorkspaceRunArguments>(value);
  strings(args, ["title", "file", "outputDir", "scriptPath", "source", "targetPageId"]);
  invocation(args);
  allowed(args, ["title", "file", "surface", "outputDir", "inlineResultLimit", "scriptPath", "source", "targetPageId"]);
  if (Boolean(args.scriptPath) === Boolean(args.source)) {
    throw new FigmaWorkspaceToolArgumentError('Exactly one of "scriptPath" or "source" is required.');
  }
  requiredFile(args, "figma:run");
  return args;
}

export function asApplyAssetManifestArgs(value: unknown): FigmaWorkspaceApplyAssetManifestArguments {
  const args = parse<FigmaWorkspaceApplyAssetManifestArguments>(value);
  assertJsonContract("assets:apply", args);
  requiredFile(args, "figma:assets:apply");
  return args;
}

export function asDownloadAssetsArgs(value: unknown): FigmaWorkspaceDownloadAssetsArguments {
  const args = parse<FigmaWorkspaceDownloadAssetsArguments>(value);
  strings(args, ["title", "file", "outputDir"]);
  invocation(args);
  target(args.target, "target");
  enumeration(args, "defaultFormat", ["png", "jpg", "svg", "pdf"]);
  const scale = args.defaultScale;
  if (scale !== undefined && (typeof scale !== "number" || !Number.isFinite(scale) || scale < 0.01 || scale > 4)) {
    throw new FigmaWorkspaceToolArgumentError('Tool argument "defaultScale" must be from 0.01 to 4.');
  }
  allowed(args, ["title", "file", "surface", "outputDir", "inlineResultLimit", "target", "defaultFormat", "defaultScale"]);
  if (args.target === undefined) throw new FigmaWorkspaceToolArgumentError('figma:assets:download requires "target".');
  return args;
}

export function asCaptureNodeArgs(value: unknown): FigmaWorkspaceCaptureNodeArguments {
  const args = parse<FigmaWorkspaceCaptureNodeArguments>(value);
  strings(args, ["title", "file", "outputDir", "nodeId", "imageFile"]);
  invocation(args);
  target(args.target, "target");
  target(args.nodeId, "nodeId");
  integer(args, "maxDimension", CAPTURE_MAX_DIMENSION_MIN, CAPTURE_MAX_DIMENSION_MAX);
  booleans(args, ["contentsOnly"]);
  allowed(args, ["title", "file", "surface", "outputDir", "inlineResultLimit", "target", "nodeId", "imageFile", "maxDimension", "contentsOnly"]);
  normalizeNodeAlias(args);
  requireStableNodeTarget(args, "figma:capture");
  return args;
}

export function asInspectArgs(value: unknown): FigmaWorkspaceInspectArguments {
  const args = parse<FigmaWorkspaceInspectArguments>(value);
  strings(args, ["title", "file", "outputDir", "nodeId", "cursor"]);
  invocation(args);
  target(args.target, "target");
  target(args.nodeId, "nodeId");
  enumeration(args, "mode", ["inspect", "style"]);
  integer(args, "depth", INSPECT_DEPTH_MIN, INSPECT_DEPTH_MAX);
  allowed(args, ["title", "file", "surface", "outputDir", "inlineResultLimit", "mode", "target", "nodeId", "depth", "cursor", "fields"]);
  if (args.cursor !== undefined && !args.cursor.trim()) {
    throw new FigmaWorkspaceToolArgumentError('Tool argument "cursor" must be a non-empty string.');
  }
  if (args.fields !== undefined) {
    args.fields = normalizeFigmaWorkspaceInspectFields(args.fields);
  }
  if (args.mode === "style") {
    if (args.depth === 0) {
      throw new FigmaWorkspaceToolArgumentError('figma:inspect mode "style" requires depth from 1 to 9007199254740991.');
    }
    if (args.cursor !== undefined || args.fields !== undefined) {
      throw new FigmaWorkspaceToolArgumentError('figma:inspect mode "style" does not accept "cursor" or "fields".');
    }
  }
  normalizeNodeAlias(args);
  requireStableNodeTarget(args, "figma:inspect");
  return args;
}

export function normalizeFigmaWorkspaceInspectFields(value: unknown): FigmaWorkspaceInspectField[] {
  if (!Array.isArray(value) || value.length === 0 || value.some((field) => typeof field !== "string")) {
    throw new FigmaWorkspaceToolArgumentError('Tool argument "fields" must be a non-empty array of inspect field names.');
  }
  const fields = value as string[];
  const unknown = fields.filter((field) => !(FIGMA_WORKSPACE_INSPECT_DETAIL_FIELDS as readonly string[]).includes(field));
  if (unknown.length > 0) {
    throw new FigmaWorkspaceToolArgumentError(`Tool argument "fields" supports only: ${FIGMA_WORKSPACE_INSPECT_DETAIL_FIELDS.join(", ")}.`);
  }
  if (new Set(fields).size !== fields.length) {
    throw new FigmaWorkspaceToolArgumentError('Tool argument "fields" must not repeat a field.');
  }
  const selected = new Set(fields);
  return FIGMA_WORKSPACE_INSPECT_DETAIL_FIELDS.filter((field) => selected.has(field));
}

export function asCallUpstreamToolArgs(value: unknown): FigmaWorkspaceCallUpstreamToolArguments {
  const args = parse<FigmaWorkspaceCallUpstreamToolArguments>(value);
  assertJsonContract("upstream:call", args);
  if (!args.toolName?.trim()) throw new FigmaWorkspaceToolArgumentError('Tool argument "toolName" is required.');
  return args;
}

export function asGetMetadataArgs(value: unknown): FigmaWorkspaceGetMetadataArguments {
  const args = parse<FigmaWorkspaceGetMetadataArguments>(value);
  commonRead(args, [], true);
  allowed(args, ["title", "file", "surface", "outputDir", "inlineResultLimit", "target", "nodeId", "refresh"]);
  normalizeNodeAlias(args);
  requiredFileOrNodeUrl(args, "figma:metadata", true);
  requireMetadataDesignSurface(args);
  return args;
}

export function asGetDesignContextArgs(value: unknown): FigmaWorkspaceGetDesignContextArguments {
  const args = parse<FigmaWorkspaceGetDesignContextArguments>(value);
  commonRead(args, ["clientLanguages", "clientFrameworks"], true);
  booleans(args, ["forceCode", "disableCodeConnect", "excludeScreenshot"]);
  allowed(args, ["title", "file", "surface", "outputDir", "inlineResultLimit", "target", "nodeId", "refresh", "clientLanguages", "clientFrameworks", "forceCode", "disableCodeConnect", "excludeScreenshot"]);
  normalizeNodeAlias(args);
  requireStableNodeTarget(args, "figma:design-context", true);
  return args;
}

export function asGetMotionContextArgs(value: unknown): FigmaWorkspaceGetMotionContextArguments {
  const args = parse<FigmaWorkspaceGetMotionContextArguments>(value);
  commonRead(args, ["clientLanguages", "clientFrameworks"]);
  booleans(args, ["recursive"]);
  allowed(args, ["title", "file", "surface", "outputDir", "inlineResultLimit", "target", "nodeId", "refresh", "clientLanguages", "clientFrameworks", "recursive"]);
  normalizeNodeAlias(args);
  requireStableNodeTarget(args, "figma:motion-context");
  return args;
}

export function asGetVariableDefsArgs(value: unknown): FigmaWorkspaceGetVariableDefsArguments {
  const args = parse<FigmaWorkspaceGetVariableDefsArguments>(value);
  commonRead(args, []);
  allowed(args, ["title", "file", "surface", "outputDir", "inlineResultLimit", "target", "nodeId", "refresh"]);
  normalizeNodeAlias(args);
  requireStableNodeTarget(args, "figma:variables");
  return args;
}

export function asSearchDesignSystemArgs(value: unknown): FigmaWorkspaceSearchDesignSystemArguments {
  const args = parse<FigmaWorkspaceSearchDesignSystemArguments>(value);
  assertJsonContract("design-system", args);
  for (const query of args.queries) {
    query.query = query.query.trim();
    if (query.query.length === 0) {
      throw new FigmaWorkspaceToolArgumentError('Tool argument "queries[].query" must be a non-empty string.');
    }
  }
  requiredFile(args, "figma:design-system");
  return args;
}

export function asGetLibrariesArgs(value: unknown): FigmaWorkspaceGetLibrariesArguments {
  const args = parse<FigmaWorkspaceGetLibrariesArguments>(value);
  strings(args, ["title", "file", "outputDir"]);
  invocation(args);
  integer(args, "offset", LIBRARIES_OFFSET_MIN, LIBRARIES_OFFSET_MAX);
  booleans(args, ["refresh"]);
  allowed(args, ["title", "file", "surface", "outputDir", "inlineResultLimit", "offset", "refresh"]);
  requiredFile(args, "figma:libraries");
  return args;
}

export function asLookupArgs(value: unknown): FigmaWorkspaceLookupArguments {
  const args = parse<FigmaWorkspaceLookupArguments>(value);
  enumeration(args, "kind", ["docs", "api"]);
  enumeration(args, "mode", ["search", "read"]);
  enumeration(args, "scope", DOC_SCOPES);
  enumeration(args, "surface", SURFACES);
  enumeration(args, "taskFamily", TASK_FAMILIES);
  strings(args, ["title", "query", "symbol", "selector"]);
  clampableInteger(args, "maxResults");
  clampableInteger(args, "maxSnippetLines");
  allowed(args, ["title", "kind", "mode", "scope", "surface", "taskFamily", "query", "symbol", "selector", "maxResults", "maxSnippetLines"]);
  if (args.kind === "api") {
    if (args.mode === undefined) {
      throw new FigmaWorkspaceToolArgumentError('API lookup requires "mode" to be search or read.');
    }
    if (!args.selector?.trim()) {
      throw new FigmaWorkspaceToolArgumentError('API lookup requires a non-empty "selector".');
    }
    if (
      args.query !== undefined
      || args.symbol !== undefined
      || args.scope !== undefined
      || args.surface !== undefined
      || args.taskFamily !== undefined
    ) {
      throw new FigmaWorkspaceToolArgumentError('API lookup accepts only "mode", "selector", and search display limits.');
    }
    if (args.mode === "read" && (args.maxResults !== undefined || args.maxSnippetLines !== undefined)) {
      throw new FigmaWorkspaceToolArgumentError('API read does not accept search display limits.');
    }
    return args;
  }
  if (args.mode !== undefined || args.selector !== undefined) {
    throw new FigmaWorkspaceToolArgumentError('Docs lookup does not accept API "mode" or "selector".');
  }
  args.scope ??= "auto";
  return args;
}

export function asDocsArgs(value: unknown): FigmaWorkspaceDocsArguments {
  const args = parse<Record<string, unknown>>(value);
  enumeration(args, "mode", ["list", "catalog", "read"]);
  allowed(args, ["mode", "id", "taskFamily", "surface", "classification", "limit"]);
  if (args.mode === "list") return args as FigmaWorkspaceDocsArguments;
  if (args.mode === "catalog") {
    enumeration(args, "taskFamily", TASK_FAMILIES); enumeration(args, "surface", SURFACES);
    enumeration(args, "classification", ["active", "conditional", "router", "examples"]); clampableInteger(args, "limit");
    return args as FigmaWorkspaceDocsArguments;
  }
  if (args.mode === "read" && typeof args.id === "string" && args.id.trim()) return args as FigmaWorkspaceDocsArguments;
  throw new FigmaWorkspaceToolArgumentError('Tool argument "mode" must be list, catalog, or read with a non-empty id.');
}

export function asUpstreamToolsArgs(value: unknown): FigmaWorkspaceUpstreamToolsArguments {
  const args = parse<FigmaWorkspaceUpstreamToolsArguments>(value);
  strings(args, ["name"]); booleans(args, ["refresh"]); allowed(args, ["name", "refresh"]); return args;
}

export function asCodeConnectInspectArgs(value: unknown): FigmaWorkspaceCodeConnectInspectArguments {
  const args = parse<FigmaWorkspaceCodeConnectInspectArguments>(value);
  codeConnectInvocation(args, "figma:code-connect:inspect");
  allowed(args, ["title", "file", "surface", "outputDir", "inlineResultLimit"]);
  return args;
}

export function asCodeConnectPlanArgs(value: unknown): FigmaWorkspaceCodeConnectPlanArguments {
  const args = parse<FigmaWorkspaceCodeConnectPlanArguments>(value);
  assertJsonSchemaContract("code-connect:plan", schemaCodeConnectPlanArguments(), normalizeCodeConnectPlanArgumentsForSchema(args));
  validateCodeConnectManifest(args.manifest);
  requireCodeConnectDesignFile(args, "figma:code-connect:plan");
  return args;
}

export function asCodeConnectApplyArgs(value: unknown): FigmaWorkspaceCodeConnectApplyArguments {
  const args = parse<FigmaWorkspaceCodeConnectApplyArguments>(value);
  strings(args, ["title", "file", "outputDir", "planPath", "confirmPlan"]);
  invocation(args);
  allowed(args, ["title", "file", "surface", "outputDir", "inlineResultLimit", "planPath", "confirmPlan"]);
  requireCodeConnectDesignFile(args, "figma:code-connect:apply");
  if (!args.planPath?.trim()) throw new FigmaWorkspaceToolArgumentError('figma:code-connect:apply requires "planPath".');
  return args;
}

export function asCodeConnectVerifyArgs(value: unknown): FigmaWorkspaceCodeConnectVerifyArguments {
  const args = parse<FigmaWorkspaceCodeConnectVerifyArguments>(value);
  strings(args, ["title", "file", "outputDir", "planPath"]);
  invocation(args);
  allowed(args, ["title", "file", "surface", "outputDir", "inlineResultLimit", "planPath"]);
  requireCodeConnectDesignFile(args, "figma:code-connect:verify");
  if (!args.planPath?.trim()) throw new FigmaWorkspaceToolArgumentError('figma:code-connect:verify requires "planPath".');
  return args;
}

export function asDoctorArgs(value: unknown): FigmaWorkspaceDoctorArguments {
  const args = parse<FigmaWorkspaceDoctorArguments>(value); allowed(args, []); return args;
}

function commonRead<T extends InvocationArguments & { target?: FigmaWorkspaceNodeTarget; nodeId?: string; refresh?: boolean }>(args: T, extraStrings: readonly string[], allowCompositeNodeId = false): void {
  strings(args, ["title", "file", "outputDir", "nodeId", ...extraStrings]); invocation(args, allowCompositeNodeId); target(args.target, "target", allowCompositeNodeId); target(args.nodeId, "nodeId", allowCompositeNodeId); booleans(args, ["refresh"]);
}

function invocation(args: InvocationArguments, allowCompositeNodeId = false): void {
  enumeration(args, "surface", SURFACES); integer(args, "inlineResultLimit", INLINE_RESULT_LIMIT_MIN, INLINE_RESULT_LIMIT_MAX); fileReference(args.file, "file", allowCompositeNodeId);
}

function normalizeNodeAlias(args: { target?: FigmaWorkspaceNodeTarget; nodeId?: string }): void {
  if (args.nodeId !== undefined) {
    if (args.target !== undefined) throw new FigmaWorkspaceToolArgumentError('Use either "target" or "nodeId", not both.');
    args.target = args.nodeId;
    delete args.nodeId;
  }
}

function requiredFile(args: InvocationArguments, command: string): void {
  if (!args.file?.trim()) throw new FigmaWorkspaceToolArgumentError(`${command} requires "file".`);
}

function codeConnectInvocation(args: InvocationArguments, command: string): void {
  strings(args, ["title", "file", "outputDir"]);
  invocation(args);
  requireCodeConnectDesignFile(args, command);
}

function requireCodeConnectDesignFile(args: InvocationArguments, command: string): void {
  requiredFile(args, command);
  if (args.surface !== undefined && args.surface !== "design") {
    throw new FigmaWorkspaceToolArgumentError(`${command} supports only the Design surface.`);
  }
  if (typeof args.file === "string" && /^[a-z][a-z0-9+.-]*:\/\//iu.test(args.file)) {
    try {
      const kind = new URL(args.file).pathname.split("/").filter(Boolean)[0];
      if (kind !== "design" && kind !== "file") {
        throw new FigmaWorkspaceToolArgumentError(`${command} supports only Design file URLs.`);
      }
    } catch (error) {
      if (error instanceof FigmaWorkspaceToolArgumentError) throw error;
    }
  } else if (args.surface !== "design") {
    throw new FigmaWorkspaceToolArgumentError(`${command} with a raw file key requires "surface": "design".`);
  }
}

function requiredFileOrNodeUrl(args: InvocationArguments & { target?: FigmaWorkspaceNodeTarget }, command: string, allowCompositeNodeId = false): void {
  if (args.file?.trim()) return;
  if (typeof args.target === "string" && isFigmaNodeUrl(args.target, allowCompositeNodeId)) return;
  if (typeof args.target === "object") return;
  throw new FigmaWorkspaceToolArgumentError(`${command} requires "file" or a node URL/structured target.`);
}

function requireStableNodeTarget(args: InvocationArguments & { target?: FigmaWorkspaceNodeTarget }, command: string, allowCompositeNodeId = false): void {
  if (args.target === undefined && args.file && isFigmaNodeUrl(args.file, allowCompositeNodeId)) args.target = args.file;
  if (args.target === undefined) throw new FigmaWorkspaceToolArgumentError(`${command} requires a node target.`);
  if (typeof args.target === "string" && /^[a-z][a-z0-9+.-]*:\/\//iu.test(args.target) && !isFigmaNodeUrl(args.target, allowCompositeNodeId)) {
    throw new FigmaWorkspaceToolArgumentError(`${command} target must be a valid https://*.figma.com Design, FigJam, or Slides node URL.`);
  }
  if (typeof args.target === "string" && !isFigmaNodeUrl(args.target, allowCompositeNodeId) && !args.file?.trim()) {
    throw new FigmaWorkspaceToolArgumentError(`${command} requires "file" when the node target is a raw id.`);
  }
}

function requireMetadataDesignSurface(args: InvocationArguments & { target?: FigmaWorkspaceNodeTarget }): void {
  if (args.surface !== undefined && args.surface !== "design") {
    throw new FigmaWorkspaceToolArgumentError("figma:metadata supports only the Design surface.");
  }
  const urlValues = [args.file, typeof args.target === "string" ? args.target : undefined]
    .filter((value): value is string => typeof value === "string" && /^[a-z][a-z0-9+.-]*:\/\//iu.test(value));
  for (const value of urlValues) {
    try {
      const kind = new URL(value).pathname.split("/").filter(Boolean)[0];
      if (kind !== "design" && kind !== "file") {
        throw new FigmaWorkspaceToolArgumentError("figma:metadata supports only Design file URLs.");
      }
    } catch (error) {
      if (error instanceof FigmaWorkspaceToolArgumentError) throw error;
    }
  }
  if (args.surface === undefined && urlValues.length === 0) {
    throw new FigmaWorkspaceToolArgumentError('figma:metadata with a raw file key or structured target requires "surface": "design".');
  }
}

function isFigmaNodeUrl(value: string, allowCompositeNodeId = false): boolean {
  try {
    const url = new URL(value);
    const parts = url.pathname.split("/").filter(Boolean);
    return url.protocol === "https:"
      && (url.hostname === "figma.com" || url.hostname.endsWith(".figma.com"))
      && ["design", "file", "figjam", "board", "slides"].includes(parts[0] ?? "")
      && typeof parts[1] === "string"
      && isFigmaFileKey(parts[1])
      && nodeIdValidator(allowCompositeNodeId)(url.searchParams.get("node-id") ?? url.searchParams.get("node_id") ?? "");
  } catch { return false; }
}

function fileReference(value: string | undefined, name: string, allowCompositeNodeId = false): void {
  if (value === undefined) return;
  const trimmed = value.trim();
  if (!trimmed) return;
  if (/^[a-z][a-z0-9+.-]*:\/\//iu.test(trimmed)) {
    try {
      const url = new URL(trimmed);
      const parts = url.pathname.split("/").filter(Boolean);
      if (
        url.protocol === "https:"
        && (url.hostname === "figma.com" || url.hostname.endsWith(".figma.com"))
        && ["design", "file", "figjam", "board", "slides"].includes(parts[0] ?? "")
        && typeof parts[1] === "string"
        && isFigmaFileKey(parts[1])
      ) {
        const nodeId = url.searchParams.get("node-id") ?? url.searchParams.get("node_id");
        if (nodeId === null || nodeIdValidator(allowCompositeNodeId)(nodeId)) return;
      }
    } catch { /* handled below */ }
    throw new FigmaWorkspaceToolArgumentError(`Tool argument "${name}" must be an https://*.figma.com Design, FigJam, or Slides URL with an official Figma file key.`);
  }
  if (!isFigmaFileKey(trimmed)) {
    throw new FigmaWorkspaceToolArgumentError(`Tool argument "${name}" must be an official Figma file key containing 22 to 128 alphanumeric characters.`);
  }
}

export function validateAssets(value: unknown): void {
  if (value === undefined) return;
  assertJsonContract("assets:apply", { assets: value });
}

function validateCodeConnectManifest(value: unknown): asserts value is FigmaWorkspaceCodeConnectManifest {
  const manifest = parse<Record<string, unknown>>(value);
  const scope = parse<Record<string, unknown>>(manifest.scope);
  scope.nodeId = normalizeCodeConnectNodeId(scope.nodeId, "scope.nodeId");
  if (manifest.client !== undefined) {
    const client = parse<Record<string, unknown>>(manifest.client);
    if (client.languages !== undefined && (typeof client.languages !== "string" || !client.languages.trim())) throw new FigmaWorkspaceToolArgumentError('Tool argument "client.languages" must be non-empty when provided.');
    if (client.frameworks !== undefined && (typeof client.frameworks !== "string" || !client.frameworks.trim())) throw new FigmaWorkspaceToolArgumentError('Tool argument "client.frameworks" must be non-empty when provided.');
  }
  const seen = new Set<string>();
  const mappings = manifest.mappings as Array<Record<string, unknown>>;
  mappings.forEach((value, index) => {
    const mapping = parse<Record<string, unknown>>(value);
    mapping.nodeId = normalizeCodeConnectNodeId(mapping.nodeId, `mappings[${index}].nodeId`);
    for (const key of ["nodeId", "componentName", "source", "label"] as const) {
      if (typeof mapping[key] !== "string" || !mapping[key].trim()) {
        throw new FigmaWorkspaceToolArgumentError(`Tool argument "mappings[${index}].${key}" must be a non-empty string.`);
      }
    }
    mapping.componentName = (mapping.componentName as string).trim();
    mapping.source = (mapping.source as string).trim();
    mapping.label = (mapping.label as string).trim();
    const identity = `${mapping.nodeId}\u0000${mapping.label}`;
    if (seen.has(identity)) throw new FigmaWorkspaceToolArgumentError(`Code Connect manifest contains duplicate mapping identity for nodeId ${mapping.nodeId} and label ${mapping.label}.`);
    seen.add(identity);
  });
}

function normalizeCodeConnectPlanArgumentsForSchema(
  args: FigmaWorkspaceCodeConnectPlanArguments,
): Record<string, unknown> {
  return { ...args, manifest: normalizeCodeConnectManifestForSchema(args.manifest) };
}

function normalizeCodeConnectManifestForSchema(value: unknown): unknown {
  if (!isRecord(value)) return value;
  const normalized: Record<string, unknown> = { ...value };
  const scope = isRecord(value.scope) ? { ...value.scope } : undefined;
  if (scope && typeof scope.nodeId === "string") scope.nodeId = scope.nodeId.trim().replace(/-/gu, ":");
  if (scope) normalized.scope = scope;
  if (Array.isArray(value.mappings)) {
    normalized.mappings = value.mappings.map((entry) => {
      if (!isRecord(entry)) return entry;
      const mapping = { ...entry };
      if (typeof mapping.nodeId === "string") mapping.nodeId = mapping.nodeId.trim().replace(/-/gu, ":");
      return mapping;
    });
  }
  return normalized;
}

function normalizeCodeConnectNodeId(value: unknown, name: string): string {
  if (typeof value !== "string") throw new FigmaWorkspaceToolArgumentError(`Tool argument "${name}" must be a simple Figma node id.`);
  const normalized = value.trim().replace(/-/gu, ":");
  if (!isSimpleFigmaNodeId(normalized)) throw new FigmaWorkspaceToolArgumentError(`Tool argument "${name}" must be a simple Figma node id; Figma node URLs are not supported in Code Connect manifests.`);
  return normalized;
}

function target(value: unknown, name: string, allowCompositeNodeId = false): void {
  if (value === undefined) return;
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed || trimmed.startsWith("$")) throw new FigmaWorkspaceToolArgumentError(`Tool argument "${name}" must be a stable raw node id or Figma node URL.`);
    if (/^[a-z][a-z0-9+.-]*:\/\//iu.test(trimmed)) {
      if (!isFigmaNodeUrl(trimmed, allowCompositeNodeId)) throw new FigmaWorkspaceToolArgumentError(`Tool argument "${name}" must be a valid https://*.figma.com Design, FigJam, or Slides node URL.`);
      return;
    }
    if (!nodeIdValidator(allowCompositeNodeId)(trimmed)) throw new FigmaWorkspaceToolArgumentError(`Tool argument "${name}" must be an official Figma node id or Figma node URL.`);
    return;
  }
  if (!isRecord(value) || Object.keys(value).length !== 2 || typeof value.fileKey !== "string" || !isFigmaFileKey(value.fileKey) || typeof value.nodeId !== "string" || !nodeIdValidator(allowCompositeNodeId)(value.nodeId)) throw new FigmaWorkspaceToolArgumentError(`Tool argument "${name}" must be a raw node id, Figma node URL, or exact { fileKey, nodeId }.`);
}

function nodeIdValidator(allowCompositeNodeId: boolean): (value: string) => boolean {
  return allowCompositeNodeId ? isCompositeCapableFigmaNodeId : isSimpleFigmaNodeId;
}

function parse<T extends Record<string, unknown>>(value: unknown): T {
  if (value === undefined) return {} as T;
  if (!isRecord(value)) throw new FigmaWorkspaceToolArgumentError("Tool arguments must be an object.");
  return { ...value } as T;
}

function assertJsonContract(command: "design-system" | "assets:apply" | "upstream:call", value: unknown): void {
  try {
    assertValidFigmaJsonCommand(command, value);
  } catch (error) {
    let message = error instanceof Error ? error.message : String(error);
    if (command === "design-system" && message.includes("$.includeLibraryKeys[")) {
      message += ' includeLibraryKeys must be a string array.';
    }
    if (command === "assets:apply" && message.includes(`$.assets must NOT have more than ${MAX_MANIFEST_ITEMS} items`)) {
      message += ` Tool argument "assets" must be an array of 1 to ${MAX_MANIFEST_ITEMS} items.`;
    }
    throw new FigmaWorkspaceToolArgumentError(message);
  }
}

function assertJsonSchemaContract(command: string, schema: Record<string, unknown>, value: unknown): void {
  try {
    assertValidFigmaJsonSchema(command, schema, value);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new FigmaWorkspaceToolArgumentError(command === "code-connect:plan" ? `Code Connect manifest validation failed: ${message}` : message);
  }
}

function strings(record: Record<string, unknown>, keys: readonly string[]): void { for (const key of keys) if (record[key] !== undefined && typeof record[key] !== "string") throw new FigmaWorkspaceToolArgumentError(`Tool argument "${key}" must be a string.`); }
function booleans(record: Record<string, unknown>, keys: readonly string[]): void { for (const key of keys) if (record[key] !== undefined && typeof record[key] !== "boolean") throw new FigmaWorkspaceToolArgumentError(`Tool argument "${key}" must be a boolean.`); }
function integer(record: Record<string, unknown>, key: string, min: number, max: number): void { const value=record[key]; if (value !== undefined && (typeof value !== "number" || !Number.isInteger(value) || value < min || value > max)) throw new FigmaWorkspaceToolArgumentError(`Tool argument "${key}" must be an integer from ${min} to ${max}.`); }
function clampableInteger(record: Record<string, unknown>, key: string): void { const value=record[key]; if (value !== undefined && (typeof value !== "number" || !Number.isSafeInteger(value))) throw new FigmaWorkspaceToolArgumentError(`Tool argument "${key}" must be a safe integer; out-of-range integers are clamped.`); }
function enumeration(record: Record<string, unknown>, key: string, values: readonly string[]): void { const value=record[key]; if (value !== undefined && (typeof value !== "string" || !values.includes(value))) throw new FigmaWorkspaceToolArgumentError(`Tool argument "${key}" must be one of: ${values.join(", ")}.`); }
function record(recordValue: Record<string, unknown>, key: string): void { const value=recordValue[key]; if (value !== undefined && !isRecord(value)) throw new FigmaWorkspaceToolArgumentError(`Tool argument "${key}" must be an object.`); }
function stringArray(recordValue: Record<string, unknown>, key: string): void { const value=recordValue[key]; if (value !== undefined && (!Array.isArray(value) || value.some((item) => typeof item !== "string"))) throw new FigmaWorkspaceToolArgumentError(`Tool argument "${key}" must be a string array.`); }
function allowed(recordValue: Record<string, unknown>, fields: readonly string[], label="command input"): void { const set=new Set(fields); const extra=Object.keys(recordValue).filter((key)=>!set.has(key)); if (extra.length) throw new FigmaWorkspaceToolArgumentError(`Tool argument "${label}" does not allow unknown fields: ${extra.join(", ")}.`); }
function isRecord(value: unknown): value is Record<string, unknown> { return Boolean(value) && typeof value === "object" && !Array.isArray(value); }

export function withDefaultTitle<T extends Record<string, unknown>>(args: T, _title: string): T {
  if (!isRecord(args)) throw new FigmaWorkspaceToolArgumentError("Tool arguments must be an object.");
  if (args.title !== undefined && typeof args.title !== "string") throw new FigmaWorkspaceToolArgumentError('Tool argument "title" must be a string.');
  return args;
}
