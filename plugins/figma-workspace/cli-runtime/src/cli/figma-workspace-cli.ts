import { createHash, randomUUID } from "node:crypto";
import { mkdir, open, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import {
  FigmaWorkspaceToolArgumentError,
  type FigmaWorkspaceApplyAssetManifestArguments,
  type FigmaWorkspaceCallUpstreamToolArguments,
  type FigmaWorkspaceCaptureNodeArguments,
  type FigmaWorkspaceDocsArguments,
  type FigmaWorkspaceDoctorArguments,
  type FigmaWorkspaceDownloadAssetsArguments,
  type FigmaWorkspaceGetDesignContextArguments,
  type FigmaWorkspaceGetLibrariesArguments,
  type FigmaWorkspaceGetMetadataArguments,
  type FigmaWorkspaceGetMotionContextArguments,
  type FigmaWorkspaceGetVariableDefsArguments,
  type FigmaWorkspaceInspectArguments,
  type FigmaWorkspaceLookupArguments,
  type FigmaWorkspaceRunArguments,
  type FigmaWorkspaceSearchDesignSystemArguments,
  type FigmaWorkspaceUpstreamToolsArguments,
} from "../contract/tool-args.js";
import {
  createFigmaWorkspaceClient,
  type FigmaWorkspaceClient,
  type FigmaWorkspaceClientOptions,
} from "../runtime/workspace-client.js";
import { atomicWriteManagedTextFile, ensureManagedDirectory } from "../runtime/managed-files.js";

export const FIGMA_WORKSPACE_CLI_EXIT_SUCCESS = 0;
export const FIGMA_WORKSPACE_CLI_EXIT_EXECUTION_ERROR = 1;
export const FIGMA_WORKSPACE_CLI_EXIT_USAGE_ERROR = 2;
export const FIGMA_WORKSPACE_CLI_EXIT_INTERRUPT = 130;

const DEFAULT_INLINE_RESULT_LIMIT = 4_096;
const MAX_INLINE_RESULT_LIMIT = 10_000;
const MAX_INPUT_BYTES = 256 * 1024;
const LOCK_TIMEOUT_MS = 30_000;
const LOCK_RETRY_MS = 100;
const LOCK_STALE_MS = 30_000;
const LOCK_HEARTBEAT_MS = 5_000;

export const FIGMA_WORKSPACE_CLI_COMMANDS = [
  "run",
  "apply-asset-manifest",
  "download-assets",
  "capture-node",
  "inspect",
  "get-metadata",
  "get-design-context",
  "get-motion-context",
  "search-design-system",
  "get-libraries",
  "get-variable-defs",
  "call-upstream-tool",
  "lookup",
  "docs",
  "doctor",
  "upstream-tools",
] as const;

export type FigmaWorkspaceCliCommand = typeof FIGMA_WORKSPACE_CLI_COMMANDS[number];

export type FigmaWorkspaceCliArguments =
  | { kind: "help"; command?: FigmaWorkspaceCliCommand }
  | { kind: "command"; command: FigmaWorkspaceCliCommand; inputFile?: string; inlineResultLimit?: number };

export interface FigmaWorkspaceCliIo {
  cwd(): string;
  env(name: string): string | undefined;
  readFile(path: string, maxBytes?: number): Promise<string>;
  readStdin(maxBytes?: number): Promise<string>;
  writeStdout(value: string): void;
  writeStderr(value: string): void;
}

export interface FigmaWorkspaceCliDependencies {
  io?: FigmaWorkspaceCliIo;
  createClient?: (options: FigmaWorkspaceClientOptions) => FigmaWorkspaceClient;
  clientOptions?: FigmaWorkspaceClientOptions;
  lockOptions?: FigmaWorkspaceFileLockOptions;
}

export interface FigmaWorkspaceFileLockOptions {
  now?: () => number;
  wait?: (milliseconds: number) => Promise<void>;
  isProcessAlive?: (pid: number) => boolean;
  timeoutMs?: number;
  retryMs?: number;
  staleMs?: number;
  heartbeatMs?: number;
}

export class FigmaWorkspaceCliUsageError extends Error {
  override readonly name = "FigmaWorkspaceCliUsageError";
}

export function parseFigmaWorkspaceCliArguments(argv: readonly string[]): FigmaWorkspaceCliArguments {
  if (argv.length === 0 || argv[0] === "help" || argv[0] === "--help" || argv[0] === "-h") {
    if (argv.length > 1) throw new FigmaWorkspaceCliUsageError("Help does not accept additional arguments.");
    return { kind: "help" };
  }
  const command = argv[0];
  if (!isCommand(command)) throw new FigmaWorkspaceCliUsageError(`Unknown command: ${command}`);
  if (argv.slice(1).some((value) => value === "--help" || value === "-h")) return { kind: "help", command };
  let inputFile: string | undefined;
  let inlineResultLimit: number | undefined;
  for (let index = 1; index < argv.length; index += 1) {
    const option = argv[index];
    if (option === "-") {
      if (inputFile !== undefined) throw new FigmaWorkspaceCliUsageError("Command input may be specified only once.");
      inputFile = "-";
      continue;
    }
    if (option !== "--input" && option !== "--inline-result-limit") {
      throw new FigmaWorkspaceCliUsageError(`Unknown option: ${option}`);
    }
    const value = argv[++index];
    if (!value || value.startsWith("--")) throw new FigmaWorkspaceCliUsageError(`Option ${option} requires a value.`);
    if (option === "--input") {
      if (inputFile !== undefined) throw new FigmaWorkspaceCliUsageError("Command input may be specified only once.");
      inputFile = value;
    } else {
      if (inlineResultLimit !== undefined) throw new FigmaWorkspaceCliUsageError("Option --inline-result-limit may be specified only once.");
      inlineResultLimit = parseInlineLimit(value);
    }
  }
  if (inlineResultLimit !== undefined && isLocalOnlyCommand(command)) {
    throw new FigmaWorkspaceCliUsageError("Option --inline-result-limit is available only for commands that return remote Figma data.");
  }
  return { kind: "command", command, inputFile, inlineResultLimit };
}

export async function runFigmaWorkspaceCli(
  argv: readonly string[],
  dependencies: FigmaWorkspaceCliDependencies = {},
): Promise<number> {
  const io = dependencies.io ?? createProcessIo();
  let parsed: FigmaWorkspaceCliArguments;
  try {
    parsed = parseFigmaWorkspaceCliArguments(argv);
  } catch (error) {
    io.writeStderr(`${formatError(error)}\n\n${FIGMA_WORKSPACE_CLI_HELP}`);
    return FIGMA_WORKSPACE_CLI_EXIT_USAGE_ERROR;
  }
  if (parsed.kind === "help") {
    io.writeStdout(parsed.command ? createFigmaWorkspaceCommandHelp(parsed.command) : FIGMA_WORKSPACE_CLI_HELP);
    return FIGMA_WORKSPACE_CLI_EXIT_SUCCESS;
  }

  const invocationId = randomUUID();
  let client: FigmaWorkspaceClient | undefined;
  let releaseLock: (() => Promise<void>) | undefined;
  try {
    const input = await readCommandInput(parsed.inputFile, io);
    const remoteResult = !isLocalOnlyCommand(parsed.command);
    if (!remoteResult && input.inlineResultLimit !== undefined) {
      throw new FigmaWorkspaceCliUsageError("Option inlineResultLimit is available only for commands that return remote Figma data.");
    }
    const requestedInlineResultLimit = remoteResult
      ? normalizeInlineLimit(parsed.inlineResultLimit ?? input.inlineResultLimit)
      : undefined;
    if (requestedInlineResultLimit !== undefined) input.inlineResultLimit = requestedInlineResultLimit;
    const outputRoot = resolveInvocationOutputRoot(input.outputDir, invocationId, io.cwd());
    if (needsLocalOutput(parsed.command, input)) input.outputDir = outputRoot;
    validateFigmaReferencesBeforeLock(parsed.command, input);
    const fileKey = extractFileKey(input.file)
      ?? extractTargetFileKey(input.target)
      ?? extractUpstreamArgumentsFileKey(input);
    if (isMutationCommand(parsed.command, fileKey) && fileKey) {
      releaseLock = await acquireFigmaWorkspaceFileLock(fileKey, dependencies.lockOptions);
    }
    client = (dependencies.createClient ?? createFigmaWorkspaceClient)({
      ...dependencies.clientOptions,
      invocationId,
    });
    const result = await invokeFigmaWorkspaceCommand(client, parsed.command, input);
    const normalized = normalizeInvocationResult(result, invocationId, fileKey, input.surface, outputRoot);
    const originalPresentation = classifyFigmaWorkspaceCliResult(parsed.command, normalized);
    let rendered = normalized;
    let presentation = originalPresentation;
    if (remoteResult) {
      try {
        rendered = await persistOversizedResult(normalized, parsed.command, outputRoot, requestedInlineResultLimit!);
      } catch (error) {
        rendered = createResultPersistenceFailure(normalized, error);
        presentation = classifyFigmaWorkspaceCliResult(parsed.command, rendered);
      }
    }
    io.writeStdout(`${formatFigmaWorkspaceCommandMarkdown(parsed.command, rendered, input, presentation)}\n`);
    return presentation.exitCode;
  } catch (error) {
    io.writeStderr(`${formatError(error)}\n`);
    if (isInterrupt(error)) return FIGMA_WORKSPACE_CLI_EXIT_INTERRUPT;
    return error instanceof FigmaWorkspaceCliUsageError || error instanceof FigmaWorkspaceToolArgumentError
      ? FIGMA_WORKSPACE_CLI_EXIT_USAGE_ERROR
      : FIGMA_WORKSPACE_CLI_EXIT_EXECUTION_ERROR;
  } finally {
    if (client) {
      try { await client.close(); } catch { /* Preserve the operation outcome already reported by the command. */ }
    }
    if (releaseLock) {
      try { await releaseLock(); } catch { /* Ownership-safe release is best effort after process-local completion. */ }
    }
  }
}

export async function invokeFigmaWorkspaceCommand(
  client: FigmaWorkspaceClient,
  command: FigmaWorkspaceCliCommand,
  input: Record<string, unknown>,
): Promise<unknown> {
  switch (command) {
    case "run": return client.run(input as FigmaWorkspaceRunArguments);
    case "apply-asset-manifest": return client.applyAssetManifest(input as FigmaWorkspaceApplyAssetManifestArguments);
    case "download-assets": return client.downloadAssets(input as FigmaWorkspaceDownloadAssetsArguments);
    case "capture-node": return client.captureNode(input as FigmaWorkspaceCaptureNodeArguments);
    case "inspect": return client.inspect(input as FigmaWorkspaceInspectArguments);
    case "get-metadata": return client.getMetadata(input as FigmaWorkspaceGetMetadataArguments);
    case "get-design-context": return client.getDesignContext(input as FigmaWorkspaceGetDesignContextArguments);
    case "get-motion-context": return client.getMotionContext(input as FigmaWorkspaceGetMotionContextArguments);
    case "search-design-system": return client.searchDesignSystem(input as FigmaWorkspaceSearchDesignSystemArguments);
    case "get-libraries": return client.getLibraries(input as FigmaWorkspaceGetLibrariesArguments);
    case "get-variable-defs": return client.getVariableDefs(input as FigmaWorkspaceGetVariableDefsArguments);
    case "call-upstream-tool": return client.callUpstreamTool(input as FigmaWorkspaceCallUpstreamToolArguments);
    case "lookup": return client.lookup(input as FigmaWorkspaceLookupArguments);
    case "docs": return client.docs(input as FigmaWorkspaceDocsArguments);
    case "doctor": return client.doctor(input as FigmaWorkspaceDoctorArguments);
    case "upstream-tools": return client.upstreamTools(input as FigmaWorkspaceUpstreamToolsArguments);
  }
}

export interface FigmaWorkspaceCliResultPresentation {
  status: "succeeded" | "observed-unhealthy" | "failed" | "failed-after-execution";
  exitCode: 0 | 1;
  error?: { message: string; code?: string | number; details?: unknown };
  warnings: readonly unknown[];
}

export function classifyFigmaWorkspaceCliResult(
  command: FigmaWorkspaceCliCommand,
  result: unknown,
): FigmaWorkspaceCliResultPresentation {
  if (!isRecord(result)) return { status: "succeeded", exitCode: 0, warnings: [] };
  const warnings = Array.isArray(result.warnings) ? result.warnings : [];
  const executionOutcome = result.executionOutcome;
  const ok = result.ok !== false;
  if (command === "doctor" && !ok) return { status: "observed-unhealthy", exitCode: 0, warnings, error: normalizeError(result.upstreamError ?? result.error) };
  if ((executionOutcome === "succeeded" || executionOutcome === "outcome_unknown") && !ok) {
    return { status: "failed-after-execution", exitCode: 1, warnings, error: normalizeError(result.upstreamError ?? result.error) };
  }
  if (!ok) return { status: "failed", exitCode: 1, warnings, error: normalizeError(result.upstreamError ?? result.error) };
  return { status: warnings.length ? "observed-unhealthy" : "succeeded", exitCode: 0, warnings };
}

export function formatFigmaWorkspaceCommandMarkdown(
  command: FigmaWorkspaceCliCommand,
  result: unknown,
  _input: Record<string, unknown>,
  presentation = classifyFigmaWorkspaceCliResult(command, result),
): string {
  return [
    `# ${publicCommandName(command)}`,
    "",
    `Status: ${presentation.status.replaceAll("-", " ")}`,
    "",
    "```json",
    JSON.stringify(result, null, 2),
    "```",
  ].join("\n");
}

export const FIGMA_WORKSPACE_CLI_HELP = [
  "Stateless Figma Workspace internal runtime.",
  "",
  "Usage: figma-workspace <command> [--input <json-file|->]",
  "Remote result option: [--inline-result-limit <bytes>]",
  "",
  `Commands: ${FIGMA_WORKSPACE_CLI_COMMANDS.join(", ")}`,
  "",
  "Every remote command receives its complete Figma file/node target in this invocation. Persistent state and session files are not supported.",
  "",
].join("\n");

export function createFigmaWorkspaceCommandHelp(command: FigmaWorkspaceCliCommand): string {
  const inlineLimit = isLocalOnlyCommand(command) ? "" : " [--inline-result-limit <bytes>]";
  return `${publicCommandName(command)}\n\nUsage: figma-workspace ${command} [--input <json-file|->]${inlineLimit}\n`;
}

function isLocalOnlyCommand(command: FigmaWorkspaceCliCommand): boolean {
  return command === "docs" || command === "lookup" || command === "doctor";
}

export function getFigmaWorkspaceCommandInputSchema(_command: FigmaWorkspaceCliCommand): Record<string, unknown> {
  return { type: "object", additionalProperties: true };
}

export async function acquireFigmaWorkspaceFileLock(
  fileKey: string,
  options: FigmaWorkspaceFileLockOptions = {},
): Promise<() => Promise<void>> {
  const lockRoot = resolve(tmpdir(), "figma-workspace", "locks");
  await mkdir(lockRoot, { recursive: true });
  const lockPath = resolve(lockRoot, `${createHash("sha256").update(fileKey).digest("hex")}.lock`);
  assertInside(lockRoot, lockPath);
  const now = options.now ?? Date.now;
  const wait = options.wait ?? ((milliseconds: number) => new Promise<void>((resolveWait) => setTimeout(resolveWait, milliseconds)));
  const isProcessAlive = options.isProcessAlive ?? defaultIsProcessAlive;
  const deadline = now() + (options.timeoutMs ?? LOCK_TIMEOUT_MS);
  const token = randomUUID();
  const ownerPath = resolve(lockPath, "owner.json");
  let acquired = false;
  while (!acquired) {
    try {
      await mkdir(lockPath);
      acquired = true;
    } catch (error) {
      if (!hasCode(error, "EEXIST")) throw error;
      const stale = await isStaleLock(lockPath, now(), options.staleMs ?? LOCK_STALE_MS, isProcessAlive);
      if (stale && await claimStaleLock(lockPath, now(), options.staleMs ?? LOCK_STALE_MS, isProcessAlive)) {
        try { await rm(lockPath, { recursive: true, force: true }); } catch (removeError) { if (!hasCode(removeError, "ENOENT")) throw removeError; }
        continue;
      }
      if (now() >= deadline) throw Object.assign(new Error(`Timed out waiting for the Figma mutation lock for file ${fileKey}.`), { code: "FIGMA_WORKSPACE_LOCK_TIMEOUT" });
      await wait(options.retryMs ?? LOCK_RETRY_MS);
    }
  }
  try {
    await writeLockOwner(lockPath, ownerPath, { pid: process.pid, token, updatedAt: now() }, false);
  } catch (error) {
    await rm(lockPath, { recursive: true, force: true }).catch(() => undefined);
    throw error;
  }
  let heartbeatInFlight: Promise<void> | undefined;
  const heartbeat = setInterval(() => {
    if (heartbeatInFlight) return;
    heartbeatInFlight = refreshLockOwner(lockPath, ownerPath, token, now())
      .catch(() => undefined)
      .finally(() => { heartbeatInFlight = undefined; });
  }, options.heartbeatMs ?? LOCK_HEARTBEAT_MS);
  heartbeat.unref?.();
  return async () => {
    clearInterval(heartbeat);
    await heartbeatInFlight;
    try {
      const owner = JSON.parse(await readFile(ownerPath, "utf8")) as { token?: unknown };
      if (owner.token === token) await rm(lockPath, { recursive: true, force: true });
    } catch (error) {
      if (!hasCode(error, "ENOENT")) throw error;
    }
  };
}

async function isStaleLock(lockPath: string, now: number, staleMs: number, isProcessAlive: (pid: number) => boolean): Promise<boolean> {
  const ownerPath = resolve(lockPath, "owner.json");
  let lockMetadata;
  try {
    lockMetadata = await stat(lockPath);
  } catch (error) {
    if (hasCode(error, "ENOENT")) return false;
    throw error;
  }
  let source: string;
  let metadata;
  try {
    [source, metadata] = await Promise.all([readFile(ownerPath, "utf8"), stat(ownerPath)]);
  } catch (error) {
    if (hasCode(error, "ENOENT")) return now - Math.max(lockMetadata.birthtimeMs, lockMetadata.ctimeMs) > staleMs;
    throw error;
  }
  try {
    const owner = JSON.parse(source) as { pid?: unknown; updatedAt?: unknown };
    const updatedAt = Math.max(typeof owner.updatedAt === "number" ? owner.updatedAt : 0, metadata.mtimeMs);
    const pid = typeof owner.pid === "number" ? owner.pid : undefined;
    return now - updatedAt > staleMs && (pid === undefined || !isProcessAlive(pid));
  } catch {
    return now - metadata.mtimeMs > staleMs;
  }
}

async function claimStaleLock(
  lockPath: string,
  now: number,
  staleMs: number,
  isProcessAlive: (pid: number) => boolean,
): Promise<boolean> {
  const reclaimPath = resolve(lockPath, "reclaim");
  let handle;
  try {
    handle = await open(reclaimPath, "wx", 0o600);
  } catch (error) {
    if (hasCode(error, "EEXIST") || hasCode(error, "ENOENT")) return false;
    throw error;
  }
  try {
    if (!await isStaleLock(lockPath, now, staleMs, isProcessAlive)) {
      await handle.close();
      handle = undefined;
      await rm(reclaimPath, { force: true });
      return false;
    }
    return true;
  } finally {
    if (handle) await handle.close();
  }
}

async function refreshLockOwner(lockPath: string, ownerPath: string, token: string, now: number): Promise<void> {
  const owner = JSON.parse(await readFile(ownerPath, "utf8")) as { token?: unknown };
  if (owner.token !== token) throw Object.assign(new Error("Figma mutation lock ownership was lost."), { code: "FIGMA_WORKSPACE_LOCK_OWNERSHIP_LOST" });
  await writeLockOwner(lockPath, ownerPath, { pid: process.pid, token, updatedAt: now }, true);
}

async function writeLockOwner(
  lockPath: string,
  ownerPath: string,
  owner: { pid: number; token: string; updatedAt: number },
  overwrite: boolean,
): Promise<void> {
  await atomicWriteManagedTextFile({ root: lockPath, path: ownerPath, overwrite }, `${JSON.stringify(owner)}\n`);
}

async function persistOversizedResult(result: unknown, command: FigmaWorkspaceCliCommand, outputRoot: string, limit: number): Promise<unknown> {
  const serialized = `${JSON.stringify(result, null, 2)}\n`;
  if (Buffer.byteLength(serialized, "utf8") <= limit) return result;
  await ensureManagedDirectory({ root: outputRoot, directory: outputRoot });
  const resultPath = resolve(outputRoot, `${command.replace(/[^a-z0-9]+/giu, "-")}.result.json`);
  const written = await atomicWriteManagedTextFile({ root: outputRoot, path: resultPath, overwrite: true }, serialized);
  const existingOutputFiles = isRecord(result) && isRecord(result.outputFiles) ? result.outputFiles : {};
  return {
    ...selectRecoveryFacts(result),
    ok: isRecord(result) ? result.ok !== false : true,
    invocation: isRecord(result) ? result.invocation : undefined,
    outputFiles: {
      ...existingOutputFiles,
      cliResultFile: { path: written.path, bytes: written.bytes, lineCount: serialized.split("\n").length - 1 },
    },
  };
}

function createResultPersistenceFailure(result: unknown, error: unknown): Record<string, unknown> {
  return {
    ...selectRecoveryFacts(result),
    ok: false,
    invocation: isRecord(result) ? result.invocation : undefined,
    error: {
      code: "FIGMA_WORKSPACE_RESULT_PERSISTENCE_FAILED",
      message: `Remote execution completed, but the oversized CLI result could not be persisted: ${formatError(error)}`,
    },
  };
}

function selectRecoveryFacts(result: unknown): Record<string, unknown> {
  if (!isRecord(result)) return {};
  return Object.fromEntries([
    "phase",
    "executionOutcome",
    "retryGuidance",
    "postProcessing",
    "captureProcessingSucceeded",
    "outputFiles",
  ].flatMap((key) => result[key] === undefined ? [] : [[key, result[key]]]));
}

function normalizeInvocationResult(result: unknown, invocationId: string, fileKey: string | undefined, surface: unknown, outputRoot: string): unknown {
  if (!isRecord(result)) return result;
  const { session: _removedSession, ...rest } = result;
  return {
    ...rest,
    invocation: {
      invocationId,
      ...(fileKey ? { fileKey } : {}),
      ...(surface === "design" || surface === "figjam" || surface === "slides" ? { surface } : {}),
      outputRoot,
    },
  };
}

function resolveInvocationOutputRoot(value: unknown, invocationId: string, cwd: string): string {
  if (typeof value === "string" && value.trim()) return resolve(cwd, value);
  return resolve(tmpdir(), "figma-workspace", invocationId);
}

function needsLocalOutput(command: FigmaWorkspaceCliCommand, input: Record<string, unknown>): boolean {
  return ["run", "apply-asset-manifest", "download-assets", "capture-node"].includes(command)
    || typeof input.outputDir === "string";
}

function isMutationCommand(command: FigmaWorkspaceCliCommand, fileKey: string | undefined): boolean {
  if (command === "run" || command === "apply-asset-manifest") return true;
  return command === "call-upstream-tool" && fileKey !== undefined;
}

async function readCommandInput(path: string | undefined, io: FigmaWorkspaceCliIo): Promise<Record<string, unknown>> {
  if (!path) return {};
  const source = path === "-" ? await io.readStdin(MAX_INPUT_BYTES) : await io.readFile(resolve(io.cwd(), path), MAX_INPUT_BYTES);
  let parsed: unknown;
  try { parsed = JSON.parse(source); } catch (error) { throw new FigmaWorkspaceCliUsageError(`Command input must be valid JSON: ${formatError(error)}`); }
  if (!isRecord(parsed)) throw new FigmaWorkspaceCliUsageError("Command input JSON must be an object.");
  return parsed;
}

function createProcessIo(): FigmaWorkspaceCliIo {
  return {
    cwd: () => process.cwd(), env: (name) => process.env[name],
    async readFile(path, maxBytes = MAX_INPUT_BYTES) { const info=await stat(path); if (info.size>maxBytes) throw new FigmaWorkspaceCliUsageError(`Input exceeds ${maxBytes} bytes.`); return readFile(path, "utf8"); },
    async readStdin(maxBytes = MAX_INPUT_BYTES) { const chunks: Buffer[]=[]; let bytes=0; for await (const chunk of process.stdin) { const value=Buffer.from(chunk); bytes+=value.length; if(bytes>maxBytes) throw new FigmaWorkspaceCliUsageError(`Input exceeds ${maxBytes} bytes.`); chunks.push(value); } return Buffer.concat(chunks).toString("utf8"); },
    writeStdout: (value) => process.stdout.write(value), writeStderr: (value) => process.stderr.write(value),
  };
}

function normalizeInlineLimit(value: unknown): number {
  if (value === undefined) return DEFAULT_INLINE_RESULT_LIMIT;
  if (typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= MAX_INLINE_RESULT_LIMIT) return value;
  throw new FigmaWorkspaceCliUsageError(`inlineResultLimit must be an integer from 0 to ${MAX_INLINE_RESULT_LIMIT}.`);
}
function parseInlineLimit(value: string): number { const parsed=Number(value); if(!Number.isInteger(parsed)||parsed<0||parsed>MAX_INLINE_RESULT_LIMIT) throw new FigmaWorkspaceCliUsageError(`--inline-result-limit must be from 0 to ${MAX_INLINE_RESULT_LIMIT}.`); return parsed; }
function extractFileKey(value: unknown): string | undefined {
  if (typeof value !== "string" || !value.trim()) return undefined;
  try {
    const url = new URL(value);
    const parts = url.pathname.split("/").filter(Boolean);
    const validHost = url.protocol === "https:" && (url.hostname === "figma.com" || url.hostname.endsWith(".figma.com"));
    const validSurface = parts.length >= 2 && ["design", "file", "figjam", "board", "slides"].includes(parts[0]!);
    if (!validHost || !validSurface || !parts[1]) {
      throw new FigmaWorkspaceCliUsageError("Figma URLs must use https://*.figma.com/<design|file|figjam|board|slides>/<fileKey>.");
    }
    return parts[1];
  } catch (error) {
    if (error instanceof FigmaWorkspaceCliUsageError) throw error;
    return value;
  }
}
function extractTargetFileKey(value: unknown): string | undefined {
  if (isRecord(value) && typeof value.fileKey === "string") return extractFileKey(value.fileKey);
  if (typeof value !== "string") return undefined;
  try {
    return extractFileKey(new URL(value).toString());
  } catch (error) {
    if (error instanceof FigmaWorkspaceCliUsageError) throw error;
    return undefined;
  }
}
function extractUpstreamArgumentsFileKey(input: Record<string, unknown>): string | undefined {
  if (!isRecord(input.arguments)) return undefined;
  return extractFileKey(input.arguments.fileKey);
}
function validateFigmaReferencesBeforeLock(command: FigmaWorkspaceCliCommand, input: Record<string, unknown>): void {
  const explicitFileKey = extractFileKey(input.file);
  extractTargetFileKey(input.target);
  for (const collection of [input.assets, input.targets]) {
    if (!Array.isArray(collection)) continue;
    for (const entry of collection) {
      if (!isRecord(entry)) continue;
      const targetFileKey = extractTargetFileKey(entry.target);
      if (explicitFileKey && targetFileKey && explicitFileKey !== targetFileKey) {
        throw new FigmaWorkspaceCliUsageError(`Figma target file ${targetFileKey} conflicts with explicit file ${explicitFileKey}.`);
      }
    }
  }
  if (command === "apply-asset-manifest" && !explicitFileKey) {
    throw new FigmaWorkspaceCliUsageError("figma:assets:apply requires an explicit file target for mutation locking.");
  }
  extractUpstreamArgumentsFileKey(input);
}
function normalizeError(value: unknown): { message: string; code?: string | number; details?: unknown } | undefined { if(!isRecord(value)) return undefined; return { message: typeof value.message==="string"?value.message:"Figma command failed.", ...(typeof value.code==="string"||typeof value.code==="number"?{code:value.code}:{}), ...(value.details!==undefined?{details:value.details}:{}) }; }
function publicCommandName(command: FigmaWorkspaceCliCommand): string { return `figma:${command}`; }
function isCommand(value: string): value is FigmaWorkspaceCliCommand { return (FIGMA_WORKSPACE_CLI_COMMANDS as readonly string[]).includes(value); }
function formatError(error: unknown): string { return error instanceof Error ? error.message : String(error); }
function isInterrupt(error: unknown): boolean { return isRecord(error) && (error.code === "SIGINT" || error.code === 130); }
function hasCode(error: unknown, code: string): boolean { return isRecord(error) && error.code === code; }
function isRecord(value: unknown): value is Record<string, unknown> { return Boolean(value) && typeof value === "object" && !Array.isArray(value); }
function assertInside(root: string, target: string): void { const rel=relative(resolve(root), resolve(target)); if(rel.startsWith("..")||isAbsolute(rel)) throw new Error("Resolved lock path escaped the managed lock root."); }
function defaultIsProcessAlive(pid: number): boolean { try { process.kill(pid, 0); return true; } catch (error) { return !hasCode(error, "ESRCH"); } }

if (process.argv[1] && resolve(process.argv[1]) === resolve(new URL(import.meta.url).pathname.replace(/^\/(?:[A-Za-z]:)/u, (match) => match.slice(1)))) {
  process.exitCode = await runFigmaWorkspaceCli(process.argv.slice(2));
}
