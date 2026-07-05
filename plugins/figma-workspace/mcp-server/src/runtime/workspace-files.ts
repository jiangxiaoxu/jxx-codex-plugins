import { mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, extname, isAbsolute, relative, resolve } from "node:path";
import type {
  FigmaWorkspaceRunScriptFileArguments,
  FigmaWorkspaceRunTaskPlanArguments,
  FigmaWorkspaceTaskPlanStep,
} from "../contract/tool-args.js";
import { asTaskPlanSteps } from "../contract/tool-args.js";

export const TASK_WORKSPACE_ROOT_ENV = "FIGMA_WORKSPACE_TASK_ROOT";
export const DEFAULT_WORKSPACE_DIR_NAME = "figma-workspace";

type CaptureImageMimeType = "image/png";

function readProcessEnv(name: string): string | undefined {
  return typeof process === "undefined" ? undefined : process.env?.[name];
}

function defaultTaskWorkspaceRoot(): string {
  return readProcessEnv(TASK_WORKSPACE_ROOT_ENV) ?? resolve(tmpdir(), "figma-workspace", "tasks");
}

export interface FigmaWorkspaceSessionWorkspace {
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
  compiledScriptFile?: string;
}

export interface FilePointerMetadata {
  path: string;
  bytes: number;
  lineCount: number;
}

export interface ScriptOutputFileMetadata {
  debugFile?: FilePointerMetadata;
  compiledScriptFile?: FilePointerMetadata;
}

export interface FigmaWorkspaceWorkspaceFileSession {
  workspace?: FigmaWorkspaceSessionWorkspace;
  fileKey?: string;
}

interface ParsedCaptureResult {
  text: string;
  json?: unknown;
}

export function createScriptOutputWriter(
  args: FigmaWorkspaceRunScriptFileArguments,
  session: FigmaWorkspaceWorkspaceFileSession | undefined,
): {
  files: ScriptOutputFilePaths;
  cleanupCompiledScriptFile(): Promise<void>;
  write(payload: {
    result: unknown;
    compiledScript?: string;
    writeResult?: boolean;
  }): Promise<ScriptOutputFileMetadata>;
} {
  const files = resolveScriptOutputFiles(args, session);
  return {
    files,
    async cleanupCompiledScriptFile() {
      if (files.compiledScriptFile) {
        await removeFileIfExists(files.compiledScriptFile);
      }
    },
    async write(payload) {
      const written: ScriptOutputFileMetadata = {};
      if (payload.writeResult && files.resultFile) {
        written.debugFile = await writeJsonFile(files.resultFile, payload.result);
      }
      if (payload.compiledScript && files.compiledScriptFile) {
        written.compiledScriptFile = await writeTextFile(
          files.compiledScriptFile,
          formatCompiledScriptFailureFile(payload.compiledScript, args, session),
        );
      }
      return written;
    },
  };
}

export function resolveScriptInputPath(
  args: FigmaWorkspaceRunScriptFileArguments,
  session: FigmaWorkspaceWorkspaceFileSession,
): string {
  const scriptPath = asOptionalString(args.scriptPath);
  if (scriptPath) {
    if (!isAbsolute(scriptPath)) {
      throw new Error('Tool argument "scriptPath" must be an absolute path. Use inputFile after figma_workspace_prepare_task for workspace-relative files.');
    }
    assertFigmaTypescriptScriptPath(scriptPath, "scriptPath");
    return scriptPath;
  }
  const inputFile = asOptionalString(args.inputFile);
  if (!inputFile) {
    throw new Error('Tool argument "scriptPath" or "inputFile" is required.');
  }
  if (!session.workspace) {
    throw new Error("inputFile requires an initialized file-context workspace. Call figma_workspace_prepare_task first.");
  }
  assertFigmaTypescriptScriptPath(inputFile, "inputFile");
  return resolveWorkspaceFile(session.workspace.sessionDir, inputFile, "inputFile");
}

function assertFigmaTypescriptScriptPath(path: string, argumentName: string): void {
  if (!path.endsWith(".figma.ts")) {
    throw new Error(`Tool argument "${argumentName}" must end with ".figma.ts".`);
  }
}

export function resolveRequiredWorkspaceAwareFile(
  value: unknown,
  session: FigmaWorkspaceWorkspaceFileSession,
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
  session: FigmaWorkspaceWorkspaceFileSession,
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
): Promise<{ path: string; bytes: number; lineCount: 0; width?: number; height?: number }> {
  const rawContent = asRecord(upstream).content;
  const content = Array.isArray(rawContent)
    ? rawContent.filter(isRecord)
    : [];
  const image = content.find((item) => item.type === "image" && typeof item.data === "string");
  if (image && typeof image.data === "string") {
    const buffer = Buffer.from(image.data, "base64");
    return writeCaptureImageOutputFile(outputFile, buffer, normalizeCaptureImageMimeType(image.mimeType));
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
    return writeCaptureImageOutputFile(
      outputFile,
      buffer,
      normalizeCaptureImageMimeType(response.headers.get("content-type")),
    );
  }
  throw new Error("Capture failed because upstream get_screenshot did not return an image/png payload or PNG image URL.");
}

export function captureImageOutputFilePath(outputFile: string): string {
  return resolveCaptureImageOutput(outputFile).path;
}

async function writeCaptureImageOutputFile(
  outputFile: string,
  buffer: Buffer,
  sourceMimeType?: CaptureImageMimeType,
): Promise<{ path: string; bytes: number; lineCount: 0; width?: number; height?: number }> {
  const output = resolveCaptureImageOutput(outputFile);
  await mkdir(dirname(output.path), { recursive: true });
  const inputMimeType = sourceMimeType ?? detectCaptureImageMimeType(buffer);
  if (inputMimeType !== "image/png") {
    throw new Error(
      `Capture image output currently supports official image/png screenshot payloads only; upstream returned ${inputMimeType ?? "unknown image data"}.`,
    );
  }
  const dimensions = readPngDimensions(buffer);
  await writeFile(output.path, buffer);
  return {
    path: output.path,
    bytes: buffer.byteLength,
    lineCount: 0,
    width: dimensions?.width,
    height: dimensions?.height,
  };
}

function normalizeCaptureImageMimeType(value: unknown): CaptureImageMimeType | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const mimeType = value.split(";")[0]?.trim().toLowerCase();
  if (mimeType === "image/png") {
    return mimeType;
  }
  return undefined;
}

function detectCaptureImageMimeType(buffer: Buffer): CaptureImageMimeType | undefined {
  if (isPngBuffer(buffer)) {
    return "image/png";
  }
  return undefined;
}

function readPngDimensions(buffer: Buffer): { width: number; height: number } | undefined {
  if (!isPngBuffer(buffer) || buffer.length < 24) {
    return undefined;
  }
  return {
    width: buffer.readUInt32BE(16),
    height: buffer.readUInt32BE(20),
  };
}

function isPngBuffer(buffer: Buffer): boolean {
  return buffer.length >= 8 &&
    buffer[0] === 0x89 &&
    buffer[1] === 0x50 &&
    buffer[2] === 0x4e &&
    buffer[3] === 0x47 &&
    buffer[4] === 0x0d &&
    buffer[5] === 0x0a &&
    buffer[6] === 0x1a &&
    buffer[7] === 0x0a;
}

function resolveCaptureImageOutput(path: string): { path: string; mimeType: CaptureImageMimeType } {
  const extension = extname(path).toLowerCase();
  if (extension === ".png") {
    return { path, mimeType: "image/png" };
  }
  return { path: withFileExtension(path, ".png"), mimeType: "image/png" };
}

function withFileExtension(path: string, extension: ".png" | ".txt"): string {
  const currentExtension = extname(path);
  if (!currentExtension) {
    return `${path}${extension}`;
  }
  return `${path.slice(0, -currentExtension.length)}${extension}`;
}

export async function loadTaskPlan(
  args: FigmaWorkspaceRunTaskPlanArguments,
  session: FigmaWorkspaceWorkspaceFileSession,
): Promise<{
  planPath?: string;
  steps: FigmaWorkspaceTaskPlanStep[];
}> {
  const planPath = resolveWorkspaceAwareFile(args.planPath, session, "planPath");
  const planValue = planPath
    ? JSON.parse(await readFile(planPath, "utf8"))
    : undefined;
  const planRecord = asRecord(planValue);
  const steps = Array.isArray(args.steps)
    ? asTaskPlanSteps(args.steps)
    : Array.isArray(planValue)
      ? asTaskPlanSteps(planValue, "plan")
      : Array.isArray(planRecord.steps)
        ? asTaskPlanSteps(planRecord.steps, "plan.steps")
        : undefined;
  if (!steps || steps.length === 0) {
    throw new Error('Tool argument "steps" or "planPath" with steps is required.');
  }
  return {
    planPath,
    steps,
  };
}

export function resolveTaskPlanResultFile(
  args: FigmaWorkspaceRunTaskPlanArguments,
  planPath: string | undefined,
  session: FigmaWorkspaceWorkspaceFileSession,
): string {
  if (planPath) {
    return planPath.replace(/\.json$/iu, ".result.json");
  }
  if (session.workspace) {
    return resolveWorkspaceFile(
      session.workspace.sessionDir,
      "task-plan.plan.result.json",
      "debugFile",
    );
  }
  const root = defaultTaskWorkspaceRoot();
  if (!isAbsolute(root)) {
    throw new Error(`Tool argument "taskRoot" and ${TASK_WORKSPACE_ROOT_ENV} must be absolute paths when provided.`);
  }
  return resolve(root, "task-plan-results", "task-plan", "task-plan.plan.result.json");
}

export function withTaskPlanDefaultFiles(
  stepArgs: Record<string, unknown>,
  type: string,
  id: string,
  session: FigmaWorkspaceWorkspaceFileSession,
): Record<string, unknown> {
  if (!session.workspace) {
    return stepArgs;
  }
  const stepSlug = slugifyTaskName(id || type || "step");
  const next = { ...stepArgs };
  if (type === "script-file") {
    return next;
  }
  if (type === "asset-manifest") {
    return next;
  }
  if (type === "download-assets") {
    if (!asOptionalString(next.outputDir)) {
      next.outputDir = `${stepSlug}.downloads`;
    }
    return next;
  }
  if (type === "screenshot-capture") {
    if (!asOptionalString(next.imageFile)) {
      next.imageFile = stepSlug;
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
  return files.resultFile ? defaultInlineResultLimit : undefined;
}

export async function writeJsonFile(path: string, value: unknown): Promise<FilePointerMetadata> {
  await mkdir(dirname(path), { recursive: true });
  const content = `${JSON.stringify(removeUndefined(value), null, 2)}\n`;
  await writeFile(path, content, "utf8");
  return textFileMetadata(path, content);
}

export function createSessionWorkspace(options: {
  cwd: string;
  dirName?: unknown;
  fileKey?: string;
  fileSlug: string;
  intentSlug: string;
}): FigmaWorkspaceSessionWorkspace {
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
  const script = `${options.intentSlug}.figma.ts`;
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

export async function ensureWorkspaceDirectories(workspace: FigmaWorkspaceSessionWorkspace): Promise<void> {
  await mkdir(workspace.sessionDir, { recursive: true });
}

export function resolvePreparedTaskWorkspace(options: {
  args: { workspaceDir?: unknown; taskRoot?: unknown };
  taskName: string;
  fileSlug: string;
  session?: FigmaWorkspaceWorkspaceFileSession;
}): FigmaWorkspaceSessionWorkspace {
  if (options.session?.workspace && !options.args.workspaceDir && !options.args.taskRoot) {
    return createWorkspaceFromFileDir({
      root: options.session.workspace.root,
      fileDir: resolve(options.session.workspace.root, normalizeFileContextDirectory(options.session.fileKey, options.fileSlug)),
      fileKey: options.session.fileKey,
      fileSlug: options.fileSlug,
      intentSlug: options.taskName,
    });
  }
  const explicitWorkspaceDir = asOptionalString(options.args.workspaceDir);
  if (explicitWorkspaceDir) {
    if (!isAbsolute(explicitWorkspaceDir)) {
      throw new Error('Tool argument "workspaceDir" must be an absolute path.');
    }
    return createWorkspaceFromSessionDir(explicitWorkspaceDir, options.taskName);
  }
  const workspaceDir = resolveTaskWorkspace({
    taskName: options.taskName,
    taskRoot: options.args.taskRoot,
    workspaceDir: undefined,
  });
  return createWorkspaceFromSessionDir(workspaceDir, options.taskName);
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

export function normalizeTaskScriptName(value: unknown, taskName: string): string {
  const scriptName = asOptionalString(value) ?? `${taskName}.figma.ts`;
  if (isAbsolute(scriptName) || scriptName.includes("/") || scriptName.includes("\\")) {
    throw new Error('Tool argument "fileName" must be a file name, not a path.');
  }
  assertFigmaTypescriptScriptPath(scriptName, "fileName");
  return scriptName;
}

export function resultFileNameForScript(scriptName: string): string {
  if (scriptName.endsWith(".figma.ts")) {
    return `${scriptName.slice(0, -".figma.ts".length)}.result.json`;
  }
  return `${slugifyTaskName(scriptName)}.result.json`;
}

export async function writeTaskFile(path: string, content: string, overwrite: boolean): Promise<FilePointerMetadata> {
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
  return textFileMetadata(path, content);
}

function resolveScriptOutputFiles(
  args: FigmaWorkspaceRunScriptFileArguments,
  session?: FigmaWorkspaceWorkspaceFileSession,
): ScriptOutputFilePaths {
  if (session?.workspace) {
    const sessionDir = session.workspace.sessionDir;
    const inputFile = asOptionalString(args.inputFile);
    const defaultResult = inputFile ? resultFileNameForScript(inputFile) : session.workspace.files.result;
    const resultFile = resolveWorkspaceOutputFile(undefined, sessionDir, defaultResult, "debugFile");
    return {
      resultFile,
      compiledScriptFile: compiledFilePathForResultFile(resultFile),
    };
  }
  return {};
}

function compiledFilePathForResultFile(resultFile: string): string {
  if (resultFile.endsWith(".result.json")) {
    return `${resultFile.slice(0, -".result.json".length)}.failure.compiled.txt`;
  }
  if (resultFile.endsWith(".json")) {
    return `${resultFile.slice(0, -".json".length)}.failure.compiled.txt`;
  }
  return `${resultFile}.failure.compiled.txt`;
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

async function writeTextFile(path: string, content: string): Promise<FilePointerMetadata> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, content, "utf8");
  return textFileMetadata(path, content);
}

async function removeFileIfExists(path: string): Promise<void> {
  try {
    await unlink(path);
  } catch (error) {
    if (isMissingFileError(error)) {
      return;
    }
    throw error;
  }
}

function formatCompiledScriptFailureFile(
  compiledScript: string,
  args: FigmaWorkspaceRunScriptFileArguments,
  session: FigmaWorkspaceWorkspaceFileSession | undefined,
): string {
  const source = compiledScriptSourceDescription(args, session);
  return [
    "// Generated by figma_workspace_run_script_file after upstream execution failure.",
    `// Source: ${source}`,
    "// This is the compiled payload sent to upstream Figma MCP for stack trace debugging.",
    "// It is deleted at the start of the next figma_workspace_run_script_file call with the same output context.",
    "",
    compiledScript,
  ].join("\n");
}

function compiledScriptSourceDescription(
  args: FigmaWorkspaceRunScriptFileArguments,
  session: FigmaWorkspaceWorkspaceFileSession | undefined,
): string {
  const inputFile = asOptionalString(args.inputFile);
  if (inputFile) {
    return session?.workspace ? `${session.workspace.fileContext}/${inputFile}` : inputFile;
  }
  return asOptionalString(args.scriptPath) ?? "unknown";
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}

export function isMissingFileError(error: unknown): boolean {
  if (isNodeError(error) && error.code === "ENOENT") {
    return true;
  }
  const message = error instanceof Error ? error.message : String(error);
  return /\bENOENT\b/.test(message);
}

function textFileMetadata(path: string, content: string): FilePointerMetadata {
  return {
    path,
    bytes: Buffer.byteLength(content, "utf8"),
    lineCount: countTextLines(content),
  };
}

function countTextLines(content: string): number {
  if (content.length === 0) {
    return 0;
  }
  const newlineCount = content.match(/\n/gu)?.length ?? 0;
  return content.endsWith("\n") ? newlineCount : newlineCount + 1;
}

function resolveTaskWorkspace(options: {
  taskName: string;
  taskRoot?: unknown;
  workspaceDir?: unknown;
}): string {
  const explicitWorkspace = asOptionalString(options.workspaceDir);
  if (explicitWorkspace) {
    if (!isAbsolute(explicitWorkspace)) {
      throw new Error('Tool argument "workspaceDir" must be an absolute path.');
    }
    return explicitWorkspace;
  }
  const explicitRoot = asOptionalString(options.taskRoot);
  const root = explicitRoot ?? defaultTaskWorkspaceRoot();
  if (!isAbsolute(root)) {
    throw new Error(`Tool argument "taskRoot" and ${TASK_WORKSPACE_ROOT_ENV} must be absolute paths when provided.`);
  }
  return resolve(root, options.taskName);
}

function createWorkspaceFromSessionDir(sessionDir: string, taskName: string): FigmaWorkspaceSessionWorkspace {
  return createWorkspaceFromFileDir({
    root: dirname(sessionDir),
    fileDir: sessionDir,
    fileSlug: slugifyTaskName(basename(sessionDir)),
    intentSlug: taskName,
  });
}

function createWorkspaceFromFileDir(options: {
  root: string;
  fileDir: string;
  fileKey?: string;
  fileSlug: string;
  intentSlug: string;
}): FigmaWorkspaceSessionWorkspace {
  const script = `${options.intentSlug}.figma.ts`;
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
      throw new Error('Derived Figma file key must be a simple file key.');
    }
    return fileKey;
  }
  return fileSlug;
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
