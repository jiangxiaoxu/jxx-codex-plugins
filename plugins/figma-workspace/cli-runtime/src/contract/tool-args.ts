import type { FigmaWorkspaceSurface } from "../runtime/script-runner.js";
import { isCompositeCapableFigmaNodeId, isFigmaFileKey, isSimpleFigmaNodeId } from "./figma-target.js";

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
export const INSPECT_DEPTH_MIN = 1;
export const INSPECT_DEPTH_MAX = Number.MAX_SAFE_INTEGER;
export const LIBRARIES_OFFSET_MIN = 0;
export const LIBRARIES_OFFSET_MAX = Number.MAX_SAFE_INTEGER;
export const INLINE_RESULT_LIMIT_MIN = 0;
export const INLINE_RESULT_LIMIT_MAX = 10_000;

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
  name?: string;
  metadata?: Record<string, unknown>;
}

export interface FigmaWorkspaceApplyAssetManifestArguments extends InvocationArguments {
  assets?: FigmaWorkspaceAssetManifestAsset[];
  manifestPath?: string;
  validateTargets?: boolean;
}

export interface FigmaWorkspaceDownloadAssetsTarget {
  [key: string]: unknown;
  target?: FigmaWorkspaceNodeTarget;
  name?: string;
  defaultFormat?: "png" | "jpg" | "svg" | "pdf";
  defaultScale?: number;
}

export interface FigmaWorkspaceDownloadAssetsArguments extends InvocationArguments {
  targets?: FigmaWorkspaceDownloadAssetsTarget[];
  manifestPath?: string;
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

export interface FigmaWorkspaceSearchDesignSystemArguments extends InvocationArguments {
  query: string;
  disableCodeConnect?: boolean;
  includeComponents?: boolean;
  includeVariables?: boolean;
  includeStyles?: boolean;
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
  scope?: FigmaWorkspaceDocsLookupScope;
  surface?: FigmaWorkspaceSurface;
  taskFamily?: FigmaWorkspaceTaskFamily;
  query?: string;
  symbol?: string;
  apiId?: string;
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
}

export interface FigmaWorkspaceUpstreamToolsArguments {
  [key: string]: unknown;
  name?: string;
  refresh?: boolean;
}

export interface FigmaWorkspaceDoctorArguments { [key: string]: unknown }

const SURFACES = ["design", "figjam", "slides"] as const;
const DOC_SCOPES = ["auto", "active", "conditional", "router", "examples", "all"] as const;
const TASK_FAMILIES = ["code-connect", "create-file", "design-to-code", "design-generation", "diagram", "library-generation", "motion-implementation", "swiftui", "figjam", "motion", "slides", "design-editing"] as const;
const MAX_MANIFEST_ITEMS = 64;

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
  strings(args, ["title", "file", "outputDir", "manifestPath"]);
  invocation(args);
  booleans(args, ["validateTargets"]);
  validateAssets(args.assets);
  allowed(args, ["title", "file", "surface", "outputDir", "inlineResultLimit", "assets", "manifestPath", "validateTargets"]);
  requiredFile(args, "figma:assets:apply");
  if (Boolean(args.assets) === Boolean(args.manifestPath)) throw new FigmaWorkspaceToolArgumentError('Exactly one of "assets" or "manifestPath" is required.');
  return args;
}

export function asDownloadAssetsArgs(value: unknown): FigmaWorkspaceDownloadAssetsArguments {
  const args = parse<FigmaWorkspaceDownloadAssetsArguments>(value);
  strings(args, ["title", "file", "outputDir", "manifestPath"]);
  invocation(args);
  validateDownloadTargets(args.targets);
  allowed(args, ["title", "file", "surface", "outputDir", "inlineResultLimit", "targets", "manifestPath"]);
  if (Boolean(args.targets) === Boolean(args.manifestPath)) throw new FigmaWorkspaceToolArgumentError('Exactly one of "targets" or "manifestPath" is required.');
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
  strings(args, ["title", "file", "outputDir", "nodeId"]);
  invocation(args);
  target(args.target, "target");
  target(args.nodeId, "nodeId");
  enumeration(args, "mode", ["inspect", "style"]);
  integer(args, "depth", INSPECT_DEPTH_MIN, INSPECT_DEPTH_MAX);
  allowed(args, ["title", "file", "surface", "outputDir", "inlineResultLimit", "mode", "target", "nodeId", "depth"]);
  normalizeNodeAlias(args);
  requireStableNodeTarget(args, "figma:inspect");
  return args;
}

export function asCallUpstreamToolArgs(value: unknown): FigmaWorkspaceCallUpstreamToolArguments {
  const args = parse<FigmaWorkspaceCallUpstreamToolArguments>(value);
  strings(args, ["title", "file", "outputDir", "toolName"]);
  invocation(args);
  record(args, "arguments");
  booleans(args, ["refresh"]);
  allowed(args, ["title", "file", "surface", "outputDir", "inlineResultLimit", "toolName", "arguments", "refresh"]);
  if (!args.toolName?.trim()) throw new FigmaWorkspaceToolArgumentError('Tool argument "toolName" is required.');
  return args;
}

export function asGetMetadataArgs(value: unknown): FigmaWorkspaceGetMetadataArguments {
  const args = parse<FigmaWorkspaceGetMetadataArguments>(value);
  commonRead(args, [], true);
  allowed(args, ["title", "file", "surface", "outputDir", "inlineResultLimit", "target", "nodeId", "refresh"]);
  normalizeNodeAlias(args);
  requiredFileOrNodeUrl(args, "figma:metadata", true);
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
  strings(args, ["title", "file", "outputDir", "query"]);
  invocation(args);
  booleans(args, ["disableCodeConnect", "includeComponents", "includeVariables", "includeStyles", "refresh"]);
  stringArray(args, "includeLibraryKeys");
  allowed(args, ["title", "file", "surface", "outputDir", "inlineResultLimit", "query", "disableCodeConnect", "includeComponents", "includeVariables", "includeStyles", "includeLibraryKeys", "refresh"]);
  requiredFile(args, "figma:design-system");
  if (!args.query?.trim()) throw new FigmaWorkspaceToolArgumentError('Tool argument "query" is required.');
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
  enumeration(args, "scope", DOC_SCOPES);
  enumeration(args, "surface", SURFACES);
  enumeration(args, "taskFamily", TASK_FAMILIES);
  strings(args, ["title", "query", "symbol", "apiId"]);
  clampableInteger(args, "maxResults");
  clampableInteger(args, "maxSnippetLines");
  allowed(args, ["title", "kind", "scope", "surface", "taskFamily", "query", "symbol", "apiId", "maxResults", "maxSnippetLines"]);
  if (args.apiId !== undefined) {
    if (
      args.kind !== "api"
      || args.query !== undefined
      || args.symbol !== undefined
      || args.scope !== undefined
      || args.surface !== undefined
      || args.taskFamily !== undefined
      || args.maxResults !== undefined
      || args.maxSnippetLines !== undefined
    ) {
      throw new FigmaWorkspaceToolArgumentError('Tool argument "apiId" is exclusive to an exact API read.');
    }
    return args;
  }
  if (args.kind === "docs") args.scope ??= "auto";
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

function validateAssets(value: unknown): void {
  if (value === undefined) return;
  if (!Array.isArray(value) || value.length > MAX_MANIFEST_ITEMS) throw new FigmaWorkspaceToolArgumentError(`Tool argument "assets" must be an array of at most ${MAX_MANIFEST_ITEMS} items.`);
  value.forEach((item, index) => { const asset = parse<Record<string, unknown>>(item); strings(asset, ["path", "name"]); target(asset.target, `assets[${index}].target`); record(asset, "metadata"); allowed(asset, ["path", "target", "name", "metadata"], `assets[${index}]`); });
}

function validateDownloadTargets(value: unknown): void {
  if (value === undefined) return;
  if (!Array.isArray(value) || value.length > MAX_MANIFEST_ITEMS) throw new FigmaWorkspaceToolArgumentError(`Tool argument "targets" must be an array of at most ${MAX_MANIFEST_ITEMS} items.`);
  value.forEach((item, index) => { const entry = parse<Record<string, unknown>>(item); strings(entry, ["name"]); target(entry.target, `targets[${index}].target`); enumeration(entry, "defaultFormat", ["png", "jpg", "svg", "pdf"]); const scale=entry.defaultScale; if (scale !== undefined && (typeof scale !== "number" || scale < 0.01 || scale > 4)) throw new FigmaWorkspaceToolArgumentError(`Tool argument "targets[${index}].defaultScale" must be from 0.01 to 4.`); allowed(entry, ["target", "name", "defaultFormat", "defaultScale"], `targets[${index}]`); });
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
