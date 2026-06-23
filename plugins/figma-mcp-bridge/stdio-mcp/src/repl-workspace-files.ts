import { mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, extname, isAbsolute, relative, resolve } from "node:path";
import { deflateSync, inflateSync } from "node:zlib";
import type { FigmaReplDiagnostic } from "./repl-script-runner.js";
import type {
  FigmaReplRunScriptFileArguments,
  FigmaReplRunTaskPlanArguments,
  FigmaReplTaskPlanStep,
} from "./repl-tool-args.js";
import { asTaskPlanSteps } from "./repl-tool-args.js";

export const TASK_WORKSPACE_ROOT_ENV = "FIGMA_REPL_TASK_ROOT";
export const DEFAULT_WORKSPACE_DIR_NAME = "figma-mcp";
const PNG_SIGNATURE = Buffer.from("89504e470d0a1a0a", "hex");

type CaptureImageMimeType = "image/png";

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
  compiledScriptFile?: string;
}

export interface FilePointerMetadata {
  path: string;
  bytes: number;
  lineCount: number;
}

export interface ScriptOutputFileMetadata {
  outputFile?: FilePointerMetadata;
  diagnosticsFile?: FilePointerMetadata;
  summaryFile?: FilePointerMetadata;
  compiledScriptFile?: FilePointerMetadata;
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
  cleanupCompiledScriptFile(): Promise<void>;
  write(payload: {
    result: unknown;
    diagnostics: FigmaReplDiagnostic[];
    summary: Record<string, unknown>;
    compiledScript?: string;
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
      if (files.resultFile) {
        written.outputFile = await writeJsonFile(files.resultFile, payload.result);
      }
      if (files.diagnosticsFile) {
        written.diagnosticsFile = await writeJsonFile(files.diagnosticsFile, {
          diagnostics: payload.diagnostics,
          count: payload.diagnostics.length,
        });
      }
      if (files.summaryFile) {
        written.summaryFile = await writeMarkdownFile(files.summaryFile, formatSummaryMarkdown(payload.summary));
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
  args: FigmaReplRunScriptFileArguments,
  session: FigmaReplWorkspaceFileSession,
): string {
  const scriptPath = asOptionalString(args.scriptPath);
  if (scriptPath) {
    if (!isAbsolute(scriptPath)) {
      throw new Error('Tool argument "scriptPath" must be an absolute path. Use inputFile after figma_repl_prepare_task for workspace-relative files.');
    }
    return scriptPath;
  }
  const inputFile = asOptionalString(args.inputFile);
  if (!inputFile) {
    throw new Error('Tool argument "scriptPath" or "inputFile" is required.');
  }
  if (!session.workspace) {
    throw new Error("inputFile requires an initialized file-context workspace. Call figma_repl_prepare_task first.");
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
): Promise<{ path: string; kind: "image" | "text"; mimeType: string; bytes: number; lineCount: number; width?: number; height?: number; sourceUrl?: string }> {
  const rawContent = asRecord(upstream).content;
  const content = Array.isArray(rawContent)
    ? rawContent.filter(isRecord)
    : [];
  const image = content.find((item) => item.type === "image" && typeof item.data === "string");
  if (image && typeof image.data === "string") {
    const buffer = Buffer.from(image.data, "base64");
    return writeCaptureImageOutputFile(outputFile, buffer, undefined, normalizeCaptureImageMimeType(image.mimeType));
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
      sourceUrl,
      normalizeCaptureImageMimeType(response.headers.get("content-type")),
    );
  }
  const textItem = content.find((item) => item.type === "text" && typeof item.text === "string");
  const text = typeof textItem?.text === "string"
    ? textItem.text
    : parsed.text || JSON.stringify(removeUndefined(parsed.json ?? upstream), null, 2);
  const textOutputFile = captureTextOutputFilePath(outputFile);
  await mkdir(dirname(textOutputFile), { recursive: true });
  await writeFile(textOutputFile, text, "utf8");
  return {
    path: textOutputFile,
    kind: "text",
    mimeType: "text/plain",
    bytes: Buffer.byteLength(text, "utf8"),
    lineCount: countTextLines(text),
  };
}

export function captureImageOutputFilePath(outputFile: string): string {
  return resolveCaptureImageOutput(outputFile).path;
}

export function captureTextOutputFilePath(outputFile: string): string {
  return withFileExtension(outputFile, ".txt");
}

export async function createCaptureThumbnailImage(
  inputFile: string,
  maxSize: number,
): Promise<{
  path: string;
  data: Buffer;
  mimeType: "image/png";
  bytes: number;
  lineCount: 0;
  width: number;
  height: number;
  sourceWidth: number;
  sourceHeight: number;
}> {
  const input = await readFile(inputFile);
  const source = decodePngRgba(input);
  const safeMaxSize = Math.max(1, Math.floor(maxSize));
  const scale = Math.min(1, safeMaxSize / Math.max(source.width, source.height));
  const width = Math.max(1, Math.round(source.width * scale));
  const height = Math.max(1, Math.round(source.height * scale));
  const data = width === source.width && height === source.height
    ? input
    : encodePngRgba({
      width,
      height,
      data: resizeRgbaBilinear(source, width, height),
    });
  const path = captureThumbnailOutputFilePath(inputFile);
  await writeFile(path, data);
  return {
    path,
    data,
    mimeType: "image/png",
    bytes: data.byteLength,
    lineCount: 0,
    width,
    height,
    sourceWidth: source.width,
    sourceHeight: source.height,
  };
}

function captureThumbnailOutputFilePath(outputFile: string): string {
  const extension = extname(outputFile);
  return extension
    ? `${outputFile.slice(0, -extension.length)}.thumb.png`
    : `${outputFile}.thumb.png`;
}

function resizeRgbaBilinear(
  source: { width: number; height: number; data: Buffer },
  width: number,
  height: number,
): Buffer {
  const target = Buffer.alloc(width * height * 4);
  const xRatio = width > 1 ? (source.width - 1) / (width - 1) : 0;
  const yRatio = height > 1 ? (source.height - 1) / (height - 1) : 0;
  for (let y = 0; y < height; y += 1) {
    const sourceY = y * yRatio;
    const y0 = Math.floor(sourceY);
    const y1 = Math.min(source.height - 1, y0 + 1);
    const yWeight = sourceY - y0;
    for (let x = 0; x < width; x += 1) {
      const sourceX = x * xRatio;
      const x0 = Math.floor(sourceX);
      const x1 = Math.min(source.width - 1, x0 + 1);
      const xWeight = sourceX - x0;
      const targetIndex = (y * width + x) * 4;
      const topLeftIndex = (y0 * source.width + x0) * 4;
      const topRightIndex = (y0 * source.width + x1) * 4;
      const bottomLeftIndex = (y1 * source.width + x0) * 4;
      const bottomRightIndex = (y1 * source.width + x1) * 4;
      for (let channel = 0; channel < 4; channel += 1) {
        const top = lerp(
          source.data[topLeftIndex + channel],
          source.data[topRightIndex + channel],
          xWeight,
        );
        const bottom = lerp(
          source.data[bottomLeftIndex + channel],
          source.data[bottomRightIndex + channel],
          xWeight,
        );
        target[targetIndex + channel] = Math.round(lerp(top, bottom, yWeight));
      }
    }
  }
  return target;
}

function lerp(a: number, b: number, weight: number): number {
  return a + (b - a) * weight;
}

async function writeCaptureImageOutputFile(
  outputFile: string,
  buffer: Buffer,
  sourceUrl?: string,
  sourceMimeType?: CaptureImageMimeType,
): Promise<{ path: string; kind: "image"; mimeType: CaptureImageMimeType; bytes: number; lineCount: 0; width?: number; height?: number; sourceUrl?: string }> {
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
    kind: "image",
    mimeType: output.mimeType,
    bytes: buffer.byteLength,
    lineCount: 0,
    width: dimensions?.width,
    height: dimensions?.height,
    sourceUrl,
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

function decodePngRgba(buffer: Buffer): { width: number; height: number; data: Buffer } {
  if (!isPngBuffer(buffer)) {
    throw new Error("Capture thumbnail generation requires a PNG input file.");
  }
  let offset = PNG_SIGNATURE.length;
  let width = 0;
  let height = 0;
  let bitDepth = 0;
  let colorType = 0;
  let interlaceMethod = 0;
  const idatChunks: Buffer[] = [];
  while (offset + 12 <= buffer.length) {
    const length = buffer.readUInt32BE(offset);
    const type = buffer.toString("ascii", offset + 4, offset + 8);
    const dataStart = offset + 8;
    const dataEnd = dataStart + length;
    if (dataEnd + 4 > buffer.length) {
      throw new Error("PNG chunk exceeds input size.");
    }
    const chunkData = buffer.subarray(dataStart, dataEnd);
    if (type === "IHDR") {
      width = chunkData.readUInt32BE(0);
      height = chunkData.readUInt32BE(4);
      bitDepth = chunkData[8];
      colorType = chunkData[9];
      interlaceMethod = chunkData[12];
    } else if (type === "IDAT") {
      idatChunks.push(chunkData);
    } else if (type === "IEND") {
      break;
    }
    offset = dataEnd + 4;
  }
  if (!width || !height || idatChunks.length === 0) {
    throw new Error("PNG input is missing IHDR or IDAT data.");
  }
  if (bitDepth !== 8 || interlaceMethod !== 0) {
    throw new Error("Capture thumbnail generation supports only 8-bit non-interlaced PNG files.");
  }
  const bytesPerPixel = pngBytesPerPixel(colorType);
  const scanlineLength = width * bytesPerPixel;
  const inflated = inflateSync(Buffer.concat(idatChunks));
  const unfiltered = Buffer.alloc(scanlineLength * height);
  let inputOffset = 0;
  for (let y = 0; y < height; y += 1) {
    const filter = inflated[inputOffset];
    inputOffset += 1;
    const rowOffset = y * scanlineLength;
    const previousRowOffset = rowOffset - scanlineLength;
    for (let x = 0; x < scanlineLength; x += 1) {
      const raw = inflated[inputOffset + x];
      const left = x >= bytesPerPixel ? unfiltered[rowOffset + x - bytesPerPixel] : 0;
      const up = y > 0 ? unfiltered[previousRowOffset + x] : 0;
      const upLeft = y > 0 && x >= bytesPerPixel ? unfiltered[previousRowOffset + x - bytesPerPixel] : 0;
      unfiltered[rowOffset + x] = (raw + pngFilterPredictor(filter, left, up, upLeft)) & 0xff;
    }
    inputOffset += scanlineLength;
  }
  return {
    width,
    height,
    data: pngScanlinesToRgba(unfiltered, width, height, colorType, bytesPerPixel),
  };
}

function pngBytesPerPixel(colorType: number): number {
  switch (colorType) {
    case 0:
      return 1;
    case 2:
      return 3;
    case 4:
      return 2;
    case 6:
      return 4;
    default:
      throw new Error(`Unsupported PNG color type for capture thumbnail generation: ${colorType}.`);
  }
}

function pngFilterPredictor(filter: number, left: number, up: number, upLeft: number): number {
  switch (filter) {
    case 0:
      return 0;
    case 1:
      return left;
    case 2:
      return up;
    case 3:
      return Math.floor((left + up) / 2);
    case 4:
      return paethPredictor(left, up, upLeft);
    default:
      throw new Error(`Unsupported PNG filter type for capture thumbnail generation: ${filter}.`);
  }
}

function paethPredictor(left: number, up: number, upLeft: number): number {
  const estimate = left + up - upLeft;
  const leftDistance = Math.abs(estimate - left);
  const upDistance = Math.abs(estimate - up);
  const upLeftDistance = Math.abs(estimate - upLeft);
  if (leftDistance <= upDistance && leftDistance <= upLeftDistance) {
    return left;
  }
  return upDistance <= upLeftDistance ? up : upLeft;
}

function pngScanlinesToRgba(
  scanlines: Buffer,
  width: number,
  height: number,
  colorType: number,
  bytesPerPixel: number,
): Buffer {
  const rgba = Buffer.alloc(width * height * 4);
  for (let index = 0; index < width * height; index += 1) {
    const sourceIndex = index * bytesPerPixel;
    const targetIndex = index * 4;
    if (colorType === 0) {
      const value = scanlines[sourceIndex];
      rgba[targetIndex] = value;
      rgba[targetIndex + 1] = value;
      rgba[targetIndex + 2] = value;
      rgba[targetIndex + 3] = 255;
    } else if (colorType === 2) {
      rgba[targetIndex] = scanlines[sourceIndex];
      rgba[targetIndex + 1] = scanlines[sourceIndex + 1];
      rgba[targetIndex + 2] = scanlines[sourceIndex + 2];
      rgba[targetIndex + 3] = 255;
    } else if (colorType === 4) {
      const value = scanlines[sourceIndex];
      rgba[targetIndex] = value;
      rgba[targetIndex + 1] = value;
      rgba[targetIndex + 2] = value;
      rgba[targetIndex + 3] = scanlines[sourceIndex + 1];
    } else {
      rgba[targetIndex] = scanlines[sourceIndex];
      rgba[targetIndex + 1] = scanlines[sourceIndex + 1];
      rgba[targetIndex + 2] = scanlines[sourceIndex + 2];
      rgba[targetIndex + 3] = scanlines[sourceIndex + 3];
    }
  }
  return rgba;
}

function encodePngRgba(input: { width: number; height: number; data: Buffer }): Buffer {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(input.width, 0);
  ihdr.writeUInt32BE(input.height, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  const scanlineLength = input.width * 4;
  const scanlines = Buffer.alloc((scanlineLength + 1) * input.height);
  for (let y = 0; y < input.height; y += 1) {
    const targetOffset = y * (scanlineLength + 1);
    scanlines[targetOffset] = 0;
    input.data.copy(scanlines, targetOffset + 1, y * scanlineLength, (y + 1) * scanlineLength);
  }
  return Buffer.concat([
    PNG_SIGNATURE,
    pngChunk("IHDR", ihdr),
    pngChunk("IDAT", deflateSync(scanlines)),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

function pngChunk(type: string, data: Buffer): Buffer {
  const typeBytes = Buffer.from(type, "ascii");
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBytes, data])), 0);
  return Buffer.concat([length, typeBytes, data, crc]);
}

function crc32(buffer: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
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
  args: FigmaReplRunTaskPlanArguments,
  planPath: string | undefined,
  session: FigmaReplWorkspaceFileSession,
): string {
  const explicit = resolveWorkspaceAwareFile(args.outputFile, session, "outputFile");
  if (explicit) return explicit;
  if (planPath) {
    return planPath.replace(/\.json$/iu, ".result.json");
  }
  if (session.workspace) {
    return resolveWorkspaceFile(
      session.workspace.sessionDir,
      `${slugifyTaskName(args.title)}.plan.result.json`,
      "outputFile",
    );
  }
  throw new Error('Tool argument "outputFile" is required for inline task plans.');
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
  const hasOutputFile = asOptionalString(next.outputFile) !== undefined;
  if (type === "script-file") {
    if (!hasOutputFile) {
      next.outputFile = `${stepSlug}.result.json`;
    }
    return next;
  }
  if (type === "asset-manifest") {
    if (!hasOutputFile) {
      next.outputFile = `${stepSlug}.assets.result.json`;
    }
    return next;
  }
  if (type === "download-assets") {
    if (!hasOutputFile) {
      next.outputFile = `${stepSlug}.downloads.result.json`;
    }
    if (!asOptionalString(next.outputDir)) {
      next.outputDir = `${stepSlug}.downloads`;
    }
    return next;
  }
  if (type === "screenshot-capture") {
    if (!asOptionalString(next.outputFile)) {
      next.outputFile = stepSlug;
    }
    if (!asOptionalString(next.metadataFile)) {
      next.metadataFile = `${stepSlug}.capture.result.json`;
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
  args: { workspaceDir?: unknown; taskRoot?: unknown };
  taskSlug: string;
  fileSlug: string;
  session?: FigmaReplWorkspaceFileSession;
}): FigmaReplSessionWorkspace {
  if (options.session?.workspace && !options.args.workspaceDir && !options.args.taskRoot) {
    return createWorkspaceFromFileDir({
      root: options.session.workspace.root,
      fileDir: resolve(options.session.workspace.root, normalizeFileContextDirectory(options.session.fileKey, options.fileSlug)),
      fileKey: options.session.fileKey,
      fileSlug: options.fileSlug,
      intentSlug: options.taskSlug,
    });
  }
  const explicitWorkspaceDir = asOptionalString(options.args.workspaceDir);
  if (explicitWorkspaceDir) {
    if (!isAbsolute(explicitWorkspaceDir)) {
      throw new Error('Tool argument "workspaceDir" must be an absolute path.');
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
    throw new Error('Tool argument "fileName" must be a file name, not a path.');
  }
  if (!scriptName.endsWith(".figma.js")) {
    throw new Error('Tool argument "fileName" must end with ".figma.js".');
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
    const resultFile = resolveWorkspaceOutputFile(args.outputFile, sessionDir, defaultResult, "outputFile");
    return {
      resultFile,
      diagnosticsFile: args.diagnosticsFile ? resolveWorkspaceOutputFile(args.diagnosticsFile, sessionDir, "diagnostics.json", "diagnosticsFile") : undefined,
      summaryFile: args.summaryFile ? resolveWorkspaceOutputFile(args.summaryFile, sessionDir, "summary.md", "summaryFile") : undefined,
      compiledScriptFile: compiledFilePathForResultFile(resultFile),
    };
  }
  const hasOutputDir = Boolean(outputDir);
  const resultFile = resolveOptionalOutputFile(args.outputFile, outputDir, hasOutputDir ? "result.json" : undefined, "outputFile");
  return {
    resultFile,
    diagnosticsFile: resolveOptionalOutputFile(args.diagnosticsFile, outputDir, undefined, "diagnosticsFile"),
    summaryFile: resolveOptionalOutputFile(args.summaryFile, outputDir, undefined, "summaryFile"),
    compiledScriptFile: resultFile ? compiledFilePathForResultFile(resultFile) : undefined,
  };
}

function compiledFilePathForResultFile(resultFile: string): string {
  if (resultFile.endsWith(".result.json")) {
    return `${resultFile.slice(0, -".result.json".length)}.failure.compiled.js`;
  }
  if (resultFile.endsWith(".json")) {
    return `${resultFile.slice(0, -".json".length)}.failure.compiled.js`;
  }
  return `${resultFile}.failure.compiled.js`;
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

async function writeMarkdownFile(path: string, value: string): Promise<FilePointerMetadata> {
  await mkdir(dirname(path), { recursive: true });
  const content = value.endsWith("\n") ? value : `${value}\n`;
  await writeFile(path, content, "utf8");
  return textFileMetadata(path, content);
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
    if (isNodeError(error) && error.code === "ENOENT") {
      return;
    }
    throw error;
  }
}

function formatCompiledScriptFailureFile(
  compiledScript: string,
  args: FigmaReplRunScriptFileArguments,
  session: FigmaReplWorkspaceFileSession | undefined,
): string {
  const source = compiledScriptSourceDescription(args, session);
  return [
    "// Generated by figma_repl_run_script_file after upstream execution failure.",
    `// Source: ${source}`,
    "// This is the compiled wrapper sent to upstream Figma MCP for stack trace debugging.",
    "// It is deleted at the start of the next figma_repl_run_script_file call with the same output context.",
    "",
    compiledScript,
  ].join("\n");
}

function compiledScriptSourceDescription(
  args: FigmaReplRunScriptFileArguments,
  session: FigmaReplWorkspaceFileSession | undefined,
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
  taskSlug: string;
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
