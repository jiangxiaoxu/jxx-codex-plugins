import { mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, relative, resolve } from "node:path";
import type { FigmaReplDiagnostic } from "./repl-script-runner.js";
import type {
  FigmaReplRunScriptFileArguments,
  FigmaReplRunTaskPlanArguments,
  FigmaReplTaskPlanStep,
} from "./repl-tool-args.js";

export const TASK_WORKSPACE_ROOT_ENV = "FIGMA_REPL_TASK_ROOT";
export const DEFAULT_WORKSPACE_DIR_NAME = "figma-mcp";

export interface FigmaReplSessionWorkspace {
  root: string;
  fileDir: string;
  fileContext: string;
  fileKey?: string;
  fileSlug: string;
  intentSlug: string;
  /**
   * Compatibility alias for the file-context directory.
   */
  sessionDir: string;
  scriptPath: string;
  resultFile: string;
  files: {
    script: string;
    result: string;
  };
}

export interface ScriptOutputFilePaths {
  resultFile?: string;
  diagnosticsFile?: string;
  summaryFile?: string;
}

export interface FigmaReplWorkspaceFileSession {
  workspace?: FigmaReplSessionWorkspace;
  fileKey?: string;
}

interface ParsedCaptureResult {
  text: string;
  json?: unknown;
}

export function createScriptOutputWriter(
  args: FigmaReplRunScriptFileArguments,
  session: FigmaReplWorkspaceFileSession | undefined,
  formatSummaryMarkdown: (summary: Record<string, unknown>) => string,
): {
  files: ScriptOutputFilePaths;
  write(payload: {
    result: unknown;
    diagnostics: FigmaReplDiagnostic[];
    summary: Record<string, unknown>;
  }): Promise<ScriptOutputFilePaths>;
} {
  const files = resolveScriptOutputFiles(args, session);
  return {
    files,
    async write(payload) {
      const written: ScriptOutputFilePaths = {};
      if (files.resultFile) {
        await writeJsonFile(files.resultFile, payload.result);
        written.resultFile = files.resultFile;
      }
      if (files.diagnosticsFile) {
        await writeJsonFile(files.diagnosticsFile, {
          diagnostics: payload.diagnostics,
          count: payload.diagnostics.length,
        });
        written.diagnosticsFile = files.diagnosticsFile;
      }
      if (files.summaryFile) {
        await writeMarkdownFile(files.summaryFile, formatSummaryMarkdown(payload.summary));
        written.summaryFile = files.summaryFile;
      }
      return written;
    },
  };
}

export function resolveScriptInputPath(
  args: FigmaReplRunScriptFileArguments,
  session: FigmaReplWorkspaceFileSession,
): string {
  const scriptPath = asOptionalString(args.scriptPath);
  if (scriptPath) {
    if (!isAbsolute(scriptPath)) {
      throw new Error('Tool argument "scriptPath" must be an absolute path. Use inputFile after figma_repl_init_workspace for workspace-relative files.');
    }
    return scriptPath;
  }
  const inputFile = asOptionalString(args.inputFile);
  if (!inputFile) {
    throw new Error('Tool argument "scriptPath" or "inputFile" is required.');
  }
  if (!session.workspace) {
    throw new Error("inputFile requires an initialized file-context workspace. Call figma_repl_init_workspace first.");
  }
  return resolveWorkspaceFile(session.workspace.sessionDir, inputFile, "inputFile");
}

export function resolveRequiredWorkspaceAwareFile(
  value: unknown,
  session: FigmaReplWorkspaceFileSession,
  argumentName: string,
): string {
  const resolved = resolveWorkspaceAwareFile(value, session, argumentName);
  if (!resolved) {
    throw new Error(`Tool argument "${argumentName}" is required.`);
  }
  return resolved;
}

export function resolveWorkspaceAwareFile(
  value: unknown,
  session: FigmaReplWorkspaceFileSession,
  argumentName: string,
): string | undefined {
  const raw = asOptionalString(value);
  if (!raw) {
    return undefined;
  }
  if (isAbsolute(raw)) {
    return raw;
  }
  if (!session.workspace) {
    throw new Error(
      `Tool argument "${argumentName}" must be an absolute path unless the session has an initialized file-context workspace.`,
    );
  }
  return resolveWorkspaceFile(session.workspace.sessionDir, raw, argumentName);
}

export async function writeCaptureOutputFile(
  outputFile: string,
  upstream: unknown,
  parsed: ParsedCaptureResult,
): Promise<{ kind: "image" | "text"; mimeType: string; bytes: number; width?: number; height?: number; sourceUrl?: string }> {
  const rawContent = asRecord(upstream).content;
  const content = Array.isArray(rawContent)
    ? rawContent.filter(isRecord)
    : [];
  const image = content.find((item) => item.type === "image" && typeof item.data === "string");
  await mkdir(dirname(outputFile), { recursive: true });
  if (image && typeof image.data === "string") {
    const buffer = Buffer.from(image.data, "base64");
    await writeFile(outputFile, buffer);
    const dimensions = imageDimensions(buffer, asOptionalString(image.mimeType) ?? "image/png");
    return {
      kind: "image",
      mimeType: asOptionalString(image.mimeType) ?? "image/png",
      bytes: buffer.byteLength,
      ...dimensions,
    };
  }
  const sourceUrl = extractCaptureImageUrl(upstream, parsed);
  if (sourceUrl) {
    const response = await fetch(sourceUrl);
    if (!response.ok) {
      throw new Error(
        `Unable to download captured node image from ${sourceUrl}: ${response.status} ${response.statusText}`,
      );
    }
    const buffer = Buffer.from(await response.arrayBuffer());
    await writeFile(outputFile, buffer);
    const mimeType = response.headers.get("content-type") ?? "image/png";
    const dimensions = imageDimensions(buffer, mimeType);
    return {
      kind: "image",
      mimeType,
      bytes: buffer.byteLength,
      ...dimensions,
      sourceUrl,
    };
  }
  const textItem = content.find((item) => item.type === "text" && typeof item.text === "string");
  const text = typeof textItem?.text === "string"
    ? textItem.text
    : parsed.text || JSON.stringify(removeUndefined(parsed.json ?? upstream), null, 2);
  await writeFile(outputFile, text, "utf8");
  return {
    kind: "text",
    mimeType: "text/plain",
    bytes: Buffer.byteLength(text, "utf8"),
  };
}

export async function loadTaskPlan(
  args: FigmaReplRunTaskPlanArguments,
  session: FigmaReplWorkspaceFileSession,
): Promise<{
  planPath?: string;
  steps: FigmaReplTaskPlanStep[];
}> {
  const planPath = resolveWorkspaceAwareFile(args.planPath, session, "planPath");
  const planValue = planPath
    ? JSON.parse(await readFile(planPath, "utf8"))
    : undefined;
  const planRecord = asRecord(planValue);
  const steps = Array.isArray(args.steps)
    ? args.steps
    : Array.isArray(planValue)
      ? planValue
      : Array.isArray(planRecord.steps)
        ? planRecord.steps
        : undefined;
  if (!steps || steps.length === 0) {
    throw new Error('Tool argument "steps" or "planPath" with steps is required.');
  }
  return {
    planPath,
    steps: steps.map((step) => asRecord(step) as FigmaReplTaskPlanStep),
  };
}

export function resolveTaskPlanResultFile(
  args: FigmaReplRunTaskPlanArguments,
  planPath: string | undefined,
  session: FigmaReplWorkspaceFileSession,
): string {
  const explicit = resolveWorkspaceAwareFile(args.resultFile ?? args.outputFile, session, "resultFile/outputFile");
  if (explicit) return explicit;
  if (planPath) {
    return planPath.replace(/\.json$/iu, ".result.json");
  }
  if (session.workspace) {
    return resolveWorkspaceFile(
      session.workspace.sessionDir,
      `${slugifyTaskName(args.title)}.plan.result.json`,
      "resultFile/outputFile",
    );
  }
  throw new Error('Tool argument "resultFile" or "outputFile" is required for inline task plans.');
}

export function withTaskPlanDefaultFiles(
  stepArgs: Record<string, unknown>,
  type: string,
  id: string,
  session: FigmaReplWorkspaceFileSession,
): Record<string, unknown> {
  if (!session.workspace) {
    return stepArgs;
  }
  const stepSlug = slugifyTaskName(id || type || "step");
  const next = { ...stepArgs };
  const hasResultFile = asOptionalString(next.resultFile ?? next.outputFile) !== undefined;
  if (type === "script-file") {
    if (!hasResultFile) {
      next.resultFile = `${stepSlug}.result.json`;
    }
    return next;
  }
  if (type === "asset-manifest") {
    if (!hasResultFile) {
      next.resultFile = `${stepSlug}.assets.result.json`;
    }
    return next;
  }
  if (type === "screenshot-capture") {
    if (!asOptionalString(next.outputFile)) {
      next.outputFile = `${stepSlug}.png`;
    }
    if (!asOptionalString(next.resultFile)) {
      next.resultFile = `${stepSlug}.capture.result.json`;
    }
    return next;
  }
  return next;
}

export function effectiveInlineResultLimit(
  value: unknown,
  files: ScriptOutputFilePaths,
  defaultInlineResultLimit: number,
): unknown {
  if (value !== undefined && value !== null) {
    return value;
  }
  return files.resultFile || files.diagnosticsFile || files.summaryFile
    ? defaultInlineResultLimit
    : undefined;
}

export async function writeJsonFile(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(removeUndefined(value), null, 2)}\n`, "utf8");
}

export function createSessionWorkspace(options: {
  cwd: string;
  dirName?: unknown;
  fileKey?: string;
  fileSlug: string;
  intentSlug: string;
}): FigmaReplSessionWorkspace {
  const dirName = asOptionalString(options.dirName) ?? DEFAULT_WORKSPACE_DIR_NAME;
  if (isAbsolute(dirName) || dirName.includes("/") || dirName.includes("\\") || dirName.includes("..")) {
    throw new Error('Tool argument "dirName" must be a simple directory name.');
  }
  const root = resolve(options.cwd, dirName);
  const fileContext = normalizeFileContextDirectory(options.fileKey, options.fileSlug);
  const fileDir = resolve(root, fileContext);
  if (!isPathInside(root, fileDir)) {
    throw new Error("Resolved file workspace must stay inside the workspace root.");
  }
  const script = `${options.intentSlug}.figma.js`;
  const result = `${options.intentSlug}.result.json`;
  return {
    root,
    fileDir,
    fileContext,
    fileKey: options.fileKey,
    fileSlug: options.fileSlug,
    intentSlug: options.intentSlug,
    sessionDir: fileDir,
    scriptPath: resolve(fileDir, script),
    resultFile: resolve(fileDir, result),
    files: {
      script,
      result,
    },
  };
}

export async function ensureWorkspaceDirectories(workspace: FigmaReplSessionWorkspace): Promise<void> {
  await mkdir(workspace.sessionDir, { recursive: true });
}

export function resolvePreparedTaskWorkspace(options: {
  args: { taskDir?: unknown; workspaceDir?: unknown; taskRoot?: unknown };
  taskSlug: string;
  fileSlug: string;
  session?: FigmaReplWorkspaceFileSession;
}): FigmaReplSessionWorkspace {
  if (options.session?.workspace && !options.args.taskDir && !options.args.workspaceDir && !options.args.taskRoot) {
    return createWorkspaceFromFileDir({
      root: options.session.workspace.root,
      fileDir: resolve(options.session.workspace.root, normalizeFileContextDirectory(options.session.fileKey, options.fileSlug)),
      fileKey: options.session.fileKey,
      fileSlug: options.fileSlug,
      intentSlug: options.taskSlug,
    });
  }
  const explicitWorkspaceDir = asOptionalString(options.args.taskDir ?? options.args.workspaceDir);
  if (explicitWorkspaceDir) {
    if (!isAbsolute(explicitWorkspaceDir)) {
      throw new Error('Tool argument "taskDir/workspaceDir" must be an absolute path.');
    }
    return createWorkspaceFromSessionDir(explicitWorkspaceDir, options.taskSlug);
  }
  const workspaceDir = resolveTaskWorkspace({
    taskSlug: options.taskSlug,
    taskRoot: options.args.taskRoot,
    workspaceDir: undefined,
  });
  return createWorkspaceFromSessionDir(workspaceDir, options.taskSlug);
}

export function resolveWorkspaceFile(baseDir: string, fileName: string, argumentName: string): string {
  if (isAbsolute(fileName) || fileName.includes("..") || /^[A-Za-z]:/u.test(fileName) || fileName.startsWith("\\\\")) {
    throw new Error(`Tool argument "${argumentName}" must be a workspace-relative file name.`);
  }
  const resolved = resolve(baseDir, fileName);
  if (!isPathInside(baseDir, resolved)) {
    throw new Error(`Tool argument "${argumentName}" must stay inside the file-context workspace.`);
  }
  return resolved;
}

export function normalizeTaskScriptName(value: unknown, taskSlug: string): string {
  const scriptName = asOptionalString(value) ?? `${taskSlug}.figma.js`;
  if (isAbsolute(scriptName) || scriptName.includes("/") || scriptName.includes("\\")) {
    throw new Error('Tool argument "fileName/scriptName" must be a file name, not a path.');
  }
  if (!scriptName.endsWith(".figma.js")) {
    throw new Error('Tool argument "fileName/scriptName" must end with ".figma.js".');
  }
  return scriptName;
}

export function resultFileNameForScript(scriptName: string): string {
  if (scriptName.endsWith(".figma.js")) {
    return `${scriptName.slice(0, -".figma.js".length)}.result.json`;
  }
  if (scriptName.endsWith(".js")) {
    return `${scriptName.slice(0, -".js".length)}.result.json`;
  }
  return `${slugifyTaskName(scriptName)}.result.json`;
}

export async function writeTaskFile(path: string, content: string, overwrite: boolean): Promise<void> {
  if (!overwrite) {
    try {
      await readFile(path, "utf8");
      throw new Error(`Refusing to overwrite existing file without overwrite=true: ${path}`);
    } catch (error) {
      if (error instanceof Error && error.message.startsWith("Refusing to overwrite")) {
        throw error;
      }
    }
  }
  await writeFile(path, content, "utf8");
}

function resolveScriptOutputFiles(
  args: FigmaReplRunScriptFileArguments,
  session?: FigmaReplWorkspaceFileSession,
): ScriptOutputFilePaths {
  const outputDir = asOptionalString(args.outputDir);
  if (outputDir && !isAbsolute(outputDir)) {
    throw new Error('Tool argument "outputDir" must be an absolute path.');
  }
  if (!outputDir && session?.workspace) {
    const sessionDir = session.workspace.sessionDir;
    const inputFile = asOptionalString(args.inputFile);
    const defaultResult = inputFile ? resultFileNameForScript(inputFile) : session.workspace.files.result;
    return {
      resultFile: resolveWorkspaceOutputFile(args.resultFile ?? args.outputFile, sessionDir, defaultResult, "resultFile/outputFile"),
      diagnosticsFile: args.diagnosticsFile ? resolveWorkspaceOutputFile(args.diagnosticsFile, sessionDir, "diagnostics.json", "diagnosticsFile") : undefined,
      summaryFile: args.summaryFile ? resolveWorkspaceOutputFile(args.summaryFile, sessionDir, "summary.md", "summaryFile") : undefined,
    };
  }
  const hasOutputDir = Boolean(outputDir);
  return {
    resultFile: resolveOptionalOutputFile(args.resultFile ?? args.outputFile, outputDir, hasOutputDir ? "result.json" : undefined, "resultFile/outputFile"),
    diagnosticsFile: resolveOptionalOutputFile(args.diagnosticsFile, outputDir, hasOutputDir ? "diagnostics.json" : undefined, "diagnosticsFile"),
    summaryFile: resolveOptionalOutputFile(args.summaryFile, outputDir, hasOutputDir ? "summary.md" : undefined, "summaryFile"),
  };
}

function resolveWorkspaceOutputFile(
  value: unknown,
  baseDir: string,
  fallbackName: string,
  argumentName: string,
): string {
  const raw = asOptionalString(value) ?? fallbackName;
  return isAbsolute(raw) ? raw : resolveWorkspaceFile(baseDir, raw, argumentName);
}

function resolveOptionalOutputFile(
  value: unknown,
  outputDir: string | undefined,
  fallbackName: string | undefined,
  name: string,
): string | undefined {
  const raw = asOptionalString(value) ?? fallbackName;
  if (!raw) {
    return undefined;
  }
  if (isAbsolute(raw)) {
    return raw;
  }
  if (!outputDir) {
    throw new Error(`Tool argument "${name}" must be absolute unless outputDir is provided.`);
  }
  const resolved = resolve(outputDir, raw);
  if (!isPathInside(outputDir, resolved)) {
    throw new Error(`Tool argument "${name}" must stay inside outputDir when relative.`);
  }
  return resolved;
}

async function writeMarkdownFile(path: string, value: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, value.endsWith("\n") ? value : `${value}\n`, "utf8");
}

function resolveTaskWorkspace(options: {
  taskSlug: string;
  taskRoot?: unknown;
  workspaceDir?: unknown;
}): string {
  const explicitWorkspace = asOptionalString(options.workspaceDir);
  if (explicitWorkspace) {
    if (!isAbsolute(explicitWorkspace)) {
      throw new Error('Tool argument "taskDir/workspaceDir" must be an absolute path.');
    }
    return explicitWorkspace;
  }
  const explicitRoot = asOptionalString(options.taskRoot);
  const root = explicitRoot ?? process.env[TASK_WORKSPACE_ROOT_ENV] ?? resolve(tmpdir(), "figma-repl-mcp", "tasks");
  if (!isAbsolute(root)) {
    throw new Error(`Tool argument "taskRoot" and ${TASK_WORKSPACE_ROOT_ENV} must be absolute paths when provided.`);
  }
  return resolve(root, options.taskSlug);
}

function createWorkspaceFromSessionDir(sessionDir: string, taskSlug: string): FigmaReplSessionWorkspace {
  return createWorkspaceFromFileDir({
    root: dirname(sessionDir),
    fileDir: sessionDir,
    fileSlug: slugifyTaskName(basename(sessionDir)),
    intentSlug: taskSlug,
  });
}

function createWorkspaceFromFileDir(options: {
  root: string;
  fileDir: string;
  fileKey?: string;
  fileSlug: string;
  intentSlug: string;
}): FigmaReplSessionWorkspace {
  const script = `${options.intentSlug}.figma.js`;
  const result = `${options.intentSlug}.result.json`;
  if (!isPathInside(options.root, options.fileDir)) {
    throw new Error("Resolved file workspace must stay inside the workspace root.");
  }
  return {
    root: options.root,
    fileDir: options.fileDir,
    fileContext: normalizeFileContextDirectory(options.fileKey, options.fileSlug),
    fileKey: options.fileKey,
    fileSlug: options.fileSlug,
    intentSlug: options.intentSlug,
    sessionDir: options.fileDir,
    scriptPath: resolve(options.fileDir, script),
    resultFile: resolve(options.fileDir, result),
    files: {
      script,
      result,
    },
  };
}

function normalizeFileContextDirectory(fileKey: string | undefined, fileSlug: string): string {
  if (fileKey) {
    if (isAbsolute(fileKey) || fileKey.includes("/") || fileKey.includes("\\") || fileKey.includes("..")) {
      throw new Error('Tool argument "fileKey" must be a simple Figma file key.');
    }
    return fileKey;
  }
  return fileSlug;
}

function imageDimensions(buffer: Buffer, mimeType: string): { width?: number; height?: number } {
  const lower = mimeType.toLowerCase();
  if ((lower.includes("png") || hasPngSignature(buffer)) && buffer.byteLength >= 24 && hasPngSignature(buffer)) {
    return {
      width: buffer.readUInt32BE(16),
      height: buffer.readUInt32BE(20),
    };
  }
  if ((lower.includes("jpeg") || lower.includes("jpg") || hasJpegSignature(buffer)) && hasJpegSignature(buffer)) {
    return jpegDimensions(buffer);
  }
  return {};
}

function hasPngSignature(buffer: Buffer): boolean {
  return buffer.byteLength >= 8 &&
    buffer[0] === 0x89 &&
    buffer[1] === 0x50 &&
    buffer[2] === 0x4e &&
    buffer[3] === 0x47 &&
    buffer[4] === 0x0d &&
    buffer[5] === 0x0a &&
    buffer[6] === 0x1a &&
    buffer[7] === 0x0a;
}

function hasJpegSignature(buffer: Buffer): boolean {
  return buffer.byteLength >= 2 && buffer[0] === 0xff && buffer[1] === 0xd8;
}

function jpegDimensions(buffer: Buffer): { width?: number; height?: number } {
  let offset = 2;
  while (offset + 9 < buffer.byteLength) {
    if (buffer[offset] !== 0xff) {
      offset += 1;
      continue;
    }
    const marker = buffer[offset + 1];
    const length = buffer.readUInt16BE(offset + 2);
    if (length < 2) return {};
    if (marker >= 0xc0 && marker <= 0xc3) {
      return {
        height: buffer.readUInt16BE(offset + 5),
        width: buffer.readUInt16BE(offset + 7),
      };
    }
    offset += 2 + length;
  }
  return {};
}

function extractCaptureImageUrl(
  upstream: unknown,
  parsed: ParsedCaptureResult,
): string | undefined {
  const rawContent = asRecord(upstream).content;
  const content = Array.isArray(rawContent)
    ? rawContent.filter(isRecord)
    : [];
  for (const item of content) {
    if (item.type === "image") {
      const imageUrl = firstHttpUrl([
        item.url,
        item.imageUrl,
        item.image_url,
        item.screenshotUrl,
        item.downloadUrl,
      ]);
      if (imageUrl) return imageUrl;
    }
  }
  const candidates: unknown[] = [parsed.json, upstream];
  for (const item of content) {
    const text = asOptionalString(item.text);
    if (!text) continue;
    const textUrl = firstHttpUrl([text]);
    if (textUrl) return textUrl;
    candidates.push(parseJsonLenient(text));
  }
  return findCaptureImageUrl(candidates);
}

function findCaptureImageUrl(values: unknown[]): string | undefined {
  for (const value of values) {
    const found = findCaptureImageUrlInValue(value, 0);
    if (found) return found;
  }
  return undefined;
}

function findCaptureImageUrlInValue(value: unknown, depth: number): string | undefined {
  if (depth > 6) {
    return undefined;
  }
  if (typeof value === "string") {
    return firstHttpUrl([value]);
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findCaptureImageUrlInValue(item, depth + 1);
      if (found) return found;
    }
    return undefined;
  }
  if (!isRecord(value)) {
    return undefined;
  }
  const priorityKeys = [
    "url",
    "imageUrl",
    "image_url",
    "screenshotUrl",
    "screenshot_url",
    "downloadUrl",
    "download_url",
    "src",
  ];
  const priorityUrl = firstHttpUrl(priorityKeys.map((key) => value[key]));
  if (priorityUrl) {
    return priorityUrl;
  }
  for (const item of Object.values(value)) {
    const found = findCaptureImageUrlInValue(item, depth + 1);
    if (found) return found;
  }
  return undefined;
}

function firstHttpUrl(values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value !== "string") continue;
    const trimmed = value.trim();
    if (!trimmed) continue;
    const direct = normalizeHttpUrl(trimmed);
    if (direct) return direct;
    const match = /https?:\/\/[^\s"'<>]+/u.exec(trimmed);
    const matched = match ? normalizeHttpUrl(match[0]) : undefined;
    if (matched) return matched;
  }
  return undefined;
}

function normalizeHttpUrl(value: string): string | undefined {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:"
      ? url.toString()
      : undefined;
  } catch {
    return undefined;
  }
}

function parseJsonLenient(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    const firstBrace = text.indexOf("{");
    const lastBrace = text.lastIndexOf("}");
    if (firstBrace >= 0 && lastBrace > firstBrace) {
      try {
        return JSON.parse(text.slice(firstBrace, lastBrace + 1));
      } catch {
        return undefined;
      }
    }
    return undefined;
  }
}

function slugifyTaskName(value: unknown): string {
  const source = typeof value === "string" ? value : "figma-task";
  const slug = source
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/gu, "-")
    .replace(/^-+|-+$/gu, "")
    .slice(0, 80);
  return slug || "figma-task";
}

function isPathInside(root: string, path: string): boolean {
  const rel = relative(root, path);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

function removeUndefined(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(removeUndefined);
  }
  if (!isRecord(value)) {
    return value;
  }
  return Object.fromEntries(
    Object.entries(value)
      .filter(([, item]) => item !== undefined)
      .map(([key, item]) => [key, removeUndefined(item)]),
  );
}

function asRecord(value: unknown): Record<string, unknown> {
  if (isRecord(value)) {
    return value;
  }
  return {};
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function asOptionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}
