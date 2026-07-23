import { lstat, realpath } from "node:fs/promises";
import { dirname, extname, isAbsolute, relative, resolve } from "node:path";
import type { FigmaWorkspaceRunArguments } from "../contract/tool-args.js";
import {
  atomicWriteManagedBinaryFile,
  atomicWriteManagedTextFile,
  assertManagedFilePath,
  ensureManagedDirectory,
  removeManagedFile,
} from "./managed-files.js";

type CaptureImageMimeType = "image/png";

export interface FigmaWorkspaceInvocationWorkspace {
  root: string;
  outputDir: string;
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

export interface FigmaWorkspaceInvocationFileContext {
  cwd: string;
  outputRoot: string;
  workspace?: FigmaWorkspaceInvocationWorkspace;
}

interface ParsedCaptureResult {
  text: string;
  json?: unknown;
}

export function createRunOutputWriter(
  args: FigmaWorkspaceRunArguments,
  invocation: FigmaWorkspaceInvocationFileContext | undefined,
): {
  files: ScriptOutputFilePaths;
  cleanupCompiledScriptFile(): Promise<void>;
  write(payload: {
    result: unknown;
    compiledScript?: string;
    writeResult?: boolean;
  }): Promise<ScriptOutputFileMetadata>;
} {
  const files = resolveRunOutputFiles(invocation);
  return {
    files,
    async cleanupCompiledScriptFile() {
      if (files.compiledScriptFile) {
        await removeManagedFile({
          root: invocation?.workspace?.root ?? dirname(files.compiledScriptFile),
          path: files.compiledScriptFile,
          allowMissing: true,
        });
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
          formatCompiledScriptFailureFile(payload.compiledScript, args),
        );
      }
      return written;
    },
  };
}

export function resolveScriptInputPath(
  args: FigmaWorkspaceRunArguments,
): string {
  const scriptPath = asOptionalString(args.scriptPath);
  if (!scriptPath) {
    throw new Error('Tool argument "scriptPath" is required when figma:run does not receive stdin source.');
  }
  if (!isAbsolute(scriptPath)) {
    throw new Error('Tool argument "scriptPath" must be an absolute path. figma:run resolves --script from the caller cwd before dispatch.');
  }
  assertFigmaTypescriptScriptPath(scriptPath, "scriptPath");
  return scriptPath;
}

function assertFigmaTypescriptScriptPath(path: string, argumentName: string): void {
  if (!path.endsWith(".figma.ts")) {
    throw new Error(`Tool argument "${argumentName}" must end with ".figma.ts".`);
  }
}

export function resolveInvocationAwareFile(
  value: unknown,
  invocation: FigmaWorkspaceInvocationFileContext,
  argumentName: string,
): string | undefined {
  const raw = asOptionalString(value);
  if (!raw) {
    return undefined;
  }
  if (isAbsolute(raw)) {
    return resolve(raw);
  }
  return resolve(invocation.cwd, raw);
}

export async function assertInvocationManagedInputFile(
  path: string,
  invocation: FigmaWorkspaceInvocationFileContext,
): Promise<string> {
  const resolvedPath = resolve(path);
  const workspaceRoot = invocation.workspace?.root;
  if (!workspaceRoot || !isPathInside(resolve(workspaceRoot), resolvedPath)) {
    const metadata = await lstat(resolvedPath);
    if (metadata.isSymbolicLink()) {
      throw new Error(`Managed input file must not be a symlink or reparse target: ${resolvedPath}`);
    }
    const canonicalPath = await realpath(resolvedPath);
    if (resolve(canonicalPath) !== resolvedPath) {
      throw new Error(`Managed input file must not traverse a symlink, junction, or reparse target: ${resolvedPath}`);
    }
    return resolvedPath;
  }
  return assertManagedFilePath({ root: workspaceRoot, path: resolvedPath });
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
  const inputMimeType = sourceMimeType ?? detectCaptureImageMimeType(buffer);
  if (inputMimeType !== "image/png") {
    throw new Error(
      `Capture image output currently supports official image/png screenshot payloads only; upstream returned ${inputMimeType ?? "unknown image data"}.`,
    );
  }
  const dimensions = readPngDimensions(buffer);
  await atomicWriteManagedBinaryFile({
    root: dirname(output.path),
    path: output.path,
    overwrite: true,
  }, buffer);
  return {
    path: output.path,
    bytes: buffer.byteLength,
    lineCount: 0,
    width: dimensions?.width,
    height: dimensions?.height,
  };
}

function normalizeCaptureImageMimeType(value: unknown): CaptureImageMimeType | undefined {
  if (typeof value !== "string" || value.trim().length === 0) {
    return undefined;
  }
  const mimeType = value.split(";")[0]?.trim().toLowerCase();
  if (mimeType === "image/png") {
    return mimeType;
  }
  throw new Error(
    `Capture image output currently supports official image/png screenshot payloads only; upstream returned ${mimeType || "an invalid content type"}.`,
  );
}

function detectCaptureImageMimeType(buffer: Buffer): CaptureImageMimeType | undefined {
  if (isPngBuffer(buffer)) {
    return "image/png";
  }
  return undefined;
}

function readPngDimensions(buffer: Buffer): { width: number; height: number } {
  if (!isPngBuffer(buffer)) {
    throw new Error("Capture image payload is not a valid PNG: the PNG signature is missing or invalid.");
  }
  if (buffer.length < 33) {
    throw new Error("Capture image payload is not a valid PNG: the IHDR chunk is incomplete.");
  }
  if (buffer.readUInt32BE(8) !== 13 || buffer.subarray(12, 16).toString("ascii") !== "IHDR") {
    throw new Error("Capture image payload is not a valid PNG: the required IHDR chunk is missing or invalid.");
  }
  const width = buffer.readUInt32BE(16);
  const height = buffer.readUInt32BE(20);
  if (width === 0 || height === 0) {
    throw new Error("Capture image payload is not a valid PNG: IHDR width and height must be positive integers.");
  }
  return { width, height };
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

export async function writeJsonFile(path: string, value: unknown): Promise<FilePointerMetadata> {
  const content = `${JSON.stringify(removeUndefined(value), null, 2)}\n`;
  await atomicWriteManagedTextFile({ root: dirname(path), path, overwrite: true }, content);
  return textFileMetadata(path, content);
}

export function createInvocationWorkspace(options: {
  outputDir: string;
}): FigmaWorkspaceInvocationWorkspace {
  if (!isAbsolute(options.outputDir)) {
    throw new Error('Tool argument "outputDir" must be an absolute path.');
  }
  const outputDir = resolve(options.outputDir);
  return { root: outputDir, outputDir };
}

export async function ensureInvocationWorkspaceDirectory(
  workspace: FigmaWorkspaceInvocationWorkspace,
): Promise<void> {
  await ensureManagedDirectory({ root: workspace.root, directory: workspace.outputDir });
}

export function resolveWorkspaceFile(baseDir: string, fileName: string, argumentName: string): string {
  if (isAbsolute(fileName) || fileName.includes("..") || /^[A-Za-z]:/u.test(fileName) || fileName.startsWith("\\\\")) {
    throw new Error(`Tool argument "${argumentName}" must be a workspace-relative file name.`);
  }
  const resolved = resolve(baseDir, fileName);
  if (!isPathInside(baseDir, resolved)) {
    throw new Error(`Tool argument "${argumentName}" must stay inside the invocation output directory.`);
  }
  return resolved;
}

function resolveRunOutputFiles(
  invocation?: FigmaWorkspaceInvocationFileContext,
): ScriptOutputFilePaths {
  if (invocation?.workspace) {
    const resultFile = resolveWorkspaceFile(
      invocation.workspace.outputDir,
      "figma-run.result.json",
      "debugFile",
    );
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

async function writeTextFile(path: string, content: string): Promise<FilePointerMetadata> {
  await atomicWriteManagedTextFile({ root: dirname(path), path, overwrite: true }, content);
  return textFileMetadata(path, content);
}

function formatCompiledScriptFailureFile(
  compiledScript: string,
  args: FigmaWorkspaceRunArguments,
): string {
  const source = compiledScriptSourceDescription(args);
  return [
    "// Generated by figma:run after upstream execution failure.",
    `// Source: ${source}`,
    "// This is the compiled payload sent to upstream Figma MCP for stack trace debugging.",
    "// It is deleted at the start of the next figma:run command with the same output directory.",
    "",
    compiledScript,
  ].join("\n");
}

function compiledScriptSourceDescription(
  args: FigmaWorkspaceRunArguments,
): string {
  return asOptionalString(args.scriptPath) ?? "stdin";
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
