import { randomUUID } from "node:crypto";
import { link, mkdir, open, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, normalize, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type {
  FigmaWorkspaceApplyAssetManifestArguments,
  FigmaWorkspaceCallUpstreamToolArguments,
  FigmaWorkspaceCaptureNodeArguments,
  FigmaWorkspaceDownloadAssetsArguments,
  FigmaWorkspaceDocsArguments,
  FigmaWorkspaceDoctorArguments,
  FigmaWorkspaceEvalArguments,
  FigmaWorkspaceGetDesignContextArguments,
  FigmaWorkspaceGetLibrariesArguments,
  FigmaWorkspaceGetMetadataArguments,
  FigmaWorkspaceGetMotionContextArguments,
  FigmaWorkspaceGetVariableDefsArguments,
  FigmaWorkspaceGuidanceArguments,
  FigmaWorkspaceInspectArguments,
  FigmaWorkspaceLookupArguments,
  FigmaWorkspaceOpenArguments,
  FigmaWorkspacePrepareTaskArguments,
  FigmaWorkspaceRunScriptFileArguments,
  FigmaWorkspaceRunTaskPlanArguments,
  FigmaWorkspaceSearchDesignSystemArguments,
  FigmaWorkspaceSessionsArguments,
  FigmaWorkspaceUpstreamToolsArguments,
} from "../contract/tool-args.js";
import { createReplToolDescriptions } from "../contract/tool-metadata.js";
import {
  createFigmaWorkspaceClient,
  type FigmaWorkspaceClient,
  type FigmaWorkspaceClientOptions,
  type FigmaWorkspaceSession,
} from "../mcp/workspace-mcp-server.js";
import {
  DEFAULT_DOCS_SEARCH_MAX_RESULTS,
  DEFAULT_DOCS_SEARCH_SNIPPET_LINES,
  MAX_DOCS_SEARCH_RESULTS,
  MAX_DOCS_SEARCH_SNIPPET_LINES,
  MAX_LOOKUP_QUERY_LENGTH,
} from "../runtime/doc-search.js";
import { TASK_WORKSPACE_ROOT_ENV } from "../runtime/workspace-files.js";

export const FIGMA_WORKSPACE_CLI_EXIT_SUCCESS = 0;
export const FIGMA_WORKSPACE_CLI_EXIT_EXECUTION_ERROR = 1;
export const FIGMA_WORKSPACE_CLI_EXIT_USAGE_ERROR = 2;
export const FIGMA_WORKSPACE_CLI_EXIT_INTERRUPT = 130;
export const FIGMA_WORKSPACE_SESSION_FILE_ENV = "FIGMA_WORKSPACE_SESSION_FILE";
const FIGMA_WORKSPACE_SESSION_LOCK_TIMEOUT_MS = 30_000;
const FIGMA_WORKSPACE_SESSION_LOCK_STALE_MS = 10 * 60_000;
const FIGMA_WORKSPACE_SESSION_LOCK_RETRY_MS = 100;
const FIGMA_WORKSPACE_SESSION_LOCK_HEARTBEAT_MS = 5_000;
const FIGMA_WORKSPACE_CLI_DEFAULT_INLINE_RESULT_LIMIT_BYTES = 4_096;
const FIGMA_WORKSPACE_CLI_MAX_INLINE_RESULT_LIMIT_BYTES = 10_000;
const FIGMA_WORKSPACE_CLI_MAX_INPUT_VALUE_CHARS = 256;
const FIGMA_WORKSPACE_CLI_INPUT_PREFIX_CHARS = 120;

export const FIGMA_WORKSPACE_CLI_COMMANDS = [
  "open",
  "eval",
  "run-script-file",
  "apply-asset-manifest",
  "download-assets",
  "capture-node",
  "run-task-plan",
  "prepare-task",
  "guidance",
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
  "sessions",
  "upstream-tools",
] as const;

export type FigmaWorkspaceCliCommand = typeof FIGMA_WORKSPACE_CLI_COMMANDS[number];

export type FigmaWorkspaceCliArguments =
  | { kind: "help"; command?: FigmaWorkspaceCliCommand }
  | {
      kind: "command";
      command: FigmaWorkspaceCliCommand;
      inputFile?: string;
      sessionFile?: string;
      inlineResultLimit?: number;
    };

export interface FigmaWorkspaceCliIo {
  cwd(): string;
  env(name: string): string | undefined;
  readFile(path: string): Promise<string>;
  readStdin(): Promise<string>;
  writeStdout(value: string): void;
  writeStderr(value: string): void;
}

export interface FigmaWorkspaceCliDependencies {
  io?: FigmaWorkspaceCliIo;
  createClient?: (options: FigmaWorkspaceClientOptions) => FigmaWorkspaceClient;
  loadSessions?: (path: string) => Promise<FigmaWorkspaceSession[]>;
  saveSessions?: (path: string, sessions: readonly FigmaWorkspaceSession[]) => Promise<void>;
  clientOptions?: Omit<FigmaWorkspaceClientOptions, "initialSessions">;
  sessionLockOptions?: FigmaWorkspaceCliSessionLockOptions;
  atomicFileOperations?: FigmaWorkspaceCliAtomicFileOperations;
}

export interface FigmaWorkspaceCliAtomicFileOperations {
  writeFile(path: string, source: string, encoding: "utf8"): Promise<void>;
  rename(source: string, destination: string): Promise<void>;
  rm(path: string, options: { force: true }): Promise<void>;
}

export interface FigmaWorkspaceCliSessionLockOptions {
  now?: () => number;
  wait?: (milliseconds: number) => Promise<void>;
  setInterval?: typeof setInterval;
  clearInterval?: typeof clearInterval;
  isProcessAlive?: (pid: number) => boolean;
  heartbeatMs?: number;
  staleMs?: number;
  timeoutMs?: number;
  retryMs?: number;
  rename?: typeof rename;
}

export class FigmaWorkspaceCliUsageError extends Error {
  override readonly name = "FigmaWorkspaceCliUsageError";
}

export type FigmaWorkspaceCliPresentationStatus = "succeeded" | "observed-unhealthy" | "failed";

export interface FigmaWorkspaceCliPresentationError {
  readonly message: string;
  readonly code?: string | number;
  readonly details?: unknown;
}

export interface FigmaWorkspaceCliResultPresentation {
  readonly status: FigmaWorkspaceCliPresentationStatus;
  readonly exitCode:
    | typeof FIGMA_WORKSPACE_CLI_EXIT_SUCCESS
    | typeof FIGMA_WORKSPACE_CLI_EXIT_EXECUTION_ERROR;
  readonly error?: FigmaWorkspaceCliPresentationError;
  readonly warnings: readonly unknown[];
}

export function parseFigmaWorkspaceCliArguments(argv: readonly string[]): FigmaWorkspaceCliArguments {
  if (argv.length === 0 || argv[0] === "help" || argv[0] === "--help" || argv[0] === "-h") {
    if (argv.length > 1) {
      throw new FigmaWorkspaceCliUsageError("Help does not accept additional arguments.");
    }
    return { kind: "help" };
  }

  const command = argv[0];
  if (!isFigmaWorkspaceCliCommand(command)) {
    throw new FigmaWorkspaceCliUsageError(`Unknown command: ${command}`);
  }

  if (argv.slice(1).some((argument) => argument === "--help" || argument === "-h")) {
    return { kind: "help", command };
  }

  let inputFile: string | undefined;
  let sessionFile: string | undefined;
  let inlineResultLimit: number | undefined;
  for (let index = 1; index < argv.length; index += 1) {
    const option = argv[index];
    if (option !== "--input" && option !== "--session-file" && option !== "--inline-result-limit") {
      throw new FigmaWorkspaceCliUsageError(`Unknown option: ${option}`);
    }
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) {
      throw new FigmaWorkspaceCliUsageError(`Option ${option} requires a value.`);
    }
    index += 1;
    if (option === "--input") {
      if (inputFile !== undefined) {
        throw new FigmaWorkspaceCliUsageError("Option --input may be specified only once.");
      }
      inputFile = value;
    } else if (option === "--session-file") {
      if (sessionFile !== undefined) {
        throw new FigmaWorkspaceCliUsageError("Option --session-file may be specified only once.");
      }
      sessionFile = value;
    } else {
      if (inlineResultLimit !== undefined) {
        throw new FigmaWorkspaceCliUsageError("Option --inline-result-limit may be specified only once.");
      }
      inlineResultLimit = parseInlineResultLimit(value, "Option --inline-result-limit");
    }
  }

  return { kind: "command", command, inputFile, sessionFile, inlineResultLimit };
}

export async function runFigmaWorkspaceCli(
  argv: readonly string[],
  dependencies: FigmaWorkspaceCliDependencies = {},
): Promise<number> {
  const io = dependencies.io ?? createProcessCliIo();
  let parsed: FigmaWorkspaceCliArguments;
  try {
    parsed = parseFigmaWorkspaceCliArguments(argv);
  } catch (error) {
    io.writeStderr(`${formatCliError(error)}\n\n${FIGMA_WORKSPACE_CLI_HELP}`);
    return FIGMA_WORKSPACE_CLI_EXIT_USAGE_ERROR;
  }

  if (parsed.kind === "help") {
    io.writeStdout(parsed.command === undefined
      ? FIGMA_WORKSPACE_CLI_HELP
      : createFigmaWorkspaceCommandHelp(parsed.command));
    return FIGMA_WORKSPACE_CLI_EXIT_SUCCESS;
  }

  try {
    const sessionFile = resolveSessionFile(parsed.sessionFile, io);
    const input = await readCommandInput(parsed.inputFile, io);
    const commandInput = createCommandInvocationInput(parsed.command, input, parsed.inlineResultLimit);
    const inlineResultLimit = resolveInlineResultLimit(parsed.inlineResultLimit, input.inlineResultLimit);
    let result: unknown;
    let markdownResult: unknown;
    let transactionError: unknown;
    const releaseSessionLock = dependencies.loadSessions === undefined
      && dependencies.saveSessions === undefined
      ? await acquireFigmaWorkspaceSessionLock(sessionFile, dependencies.sessionLockOptions)
      : undefined;
    try {
      const sessions = await (dependencies.loadSessions ?? readFigmaWorkspaceSessions)(sessionFile);
      assertNoLegacySessionHandles(sessions);
      const client = (dependencies.createClient ?? createFigmaWorkspaceClient)({
        ...dependencies.clientOptions,
        initialSessions: sessions,
      });
      let commandError: unknown;
      try {
        result = await invokeFigmaWorkspaceCommand(client, parsed.command, commandInput);
      } catch (error) {
        commandError = error;
      }
      let saveError: unknown;
      try {
        if (dependencies.saveSessions === undefined) {
          await writeFigmaWorkspaceSessions(sessionFile, client.sessions.list(), dependencies.atomicFileOperations);
        } else {
          await dependencies.saveSessions(sessionFile, client.sessions.list());
        }
      } catch (error) {
        saveError = error;
      }
      let closeError: unknown;
      try {
        await client.close();
      } catch (error) {
        closeError = error;
      }
      transactionError = commandError ?? saveError ?? closeError;
    } catch (error) {
      transactionError = error;
    }
    const presentation = transactionError === undefined
      ? classifyFigmaWorkspaceCliResult(parsed.command, result)
      : undefined;
    if (transactionError === undefined) {
      try {
        markdownResult = await persistOversizedCliResult(
          parsed.command,
          result,
          commandInput,
          sessionFile,
          inlineResultLimit,
          dependencies.atomicFileOperations,
        );
      } catch (error) {
        transactionError = error;
      }
    }
    if (releaseSessionLock !== undefined) {
      try {
        await releaseSessionLock();
      } catch (error) {
        transactionError ??= error;
      }
    }
    if (transactionError !== undefined) {
      throw transactionError;
    }
    io.writeStdout(`${formatFigmaWorkspaceCommandMarkdown(parsed.command, markdownResult, commandInput, presentation)}\n`);
    return presentation?.exitCode ?? FIGMA_WORKSPACE_CLI_EXIT_SUCCESS;
  } catch (error) {
    io.writeStderr(`${formatCliError(error)}\n`);
    if (isCliInterruptError(error)) {
      return FIGMA_WORKSPACE_CLI_EXIT_INTERRUPT;
    }
    return error instanceof FigmaWorkspaceCliUsageError
      ? FIGMA_WORKSPACE_CLI_EXIT_USAGE_ERROR
      : FIGMA_WORKSPACE_CLI_EXIT_EXECUTION_ERROR;
  }
}

export async function readFigmaWorkspaceSessions(path: string): Promise<FigmaWorkspaceSession[]> {
  let source: string;
  try {
    source = await readFile(path, "utf8");
  } catch (error) {
    if (isMissingFileError(error)) {
      return [];
    }
    throw error;
  }
  let value: unknown;
  try {
    value = JSON.parse(source);
  } catch (error) {
    throw new FigmaWorkspaceCliUsageError(`Session file is not valid JSON: ${formatCliError(error)}`);
  }
  assertNoLegacySessionHandles(value);
  if (!Array.isArray(value) || !value.every(isFigmaWorkspaceSession)) {
    throw new FigmaWorkspaceCliUsageError("Session file must contain a FigmaWorkspaceSession array.");
  }
  return value;
}

export async function writeFigmaWorkspaceSessions(
  path: string,
  sessions: readonly FigmaWorkspaceSession[],
  operations?: FigmaWorkspaceCliAtomicFileOperations,
): Promise<void> {
  await writeAtomicTextFile(path, `${JSON.stringify(sessions, null, 2)}\n`, operations);
}

async function persistOversizedCliResult(
  command: FigmaWorkspaceCliCommand,
  result: unknown,
  input: Readonly<Record<string, unknown>>,
  sessionFile: string,
  inlineResultLimit: number,
  operations?: FigmaWorkspaceCliAtomicFileOperations,
): Promise<unknown> {
  const resultSource = `${JSON.stringify(result, jsonBigIntReplacer, 2) ?? "null"}\n`;
  const resultBytes = Buffer.byteLength(resultSource, "utf8");
  const markdownBytes = Buffer.byteLength(
    formatFigmaWorkspaceCommandMarkdown(command, result, input),
    "utf8",
  );
  if (inlineResultLimit !== 0 && markdownBytes <= inlineResultLimit) {
    return result;
  }
  const resultFile = resolve(
    dirname(sessionFile),
    "results",
    `${Date.now()}-${command}-${randomUUID()}.json`,
  );
  await writeAtomicTextFile(resultFile, resultSource, operations);
  const ok = isRecord(result) && typeof result.ok === "boolean" ? result.ok : true;
  return {
    ok,
    outputFiles: {
      cliResultFile: {
        path: resultFile,
        bytes: resultBytes,
        lineCount: countTextLines(resultSource),
      },
    },
    inlineResultLimit: {
      limitBytes: inlineResultLimit,
      omitted: [{ field: "result", bytes: markdownBytes }],
    },
  };
}

async function writeAtomicTextFile(
  path: string,
  source: string,
  operations: FigmaWorkspaceCliAtomicFileOperations = { writeFile, rename, rm },
): Promise<void> {
  const directory = dirname(path);
  const temporaryPath = resolve(directory, `.${randomUUID()}.tmp`);
  await mkdir(directory, { recursive: true });
  try {
    await operations.writeFile(temporaryPath, source, "utf8");
    await operations.rename(temporaryPath, path);
  } catch (error) {
    await operations.rm(temporaryPath, { force: true }).catch(() => undefined);
    throw error;
  }
}

async function acquireFigmaWorkspaceSessionLock(
  sessionFile: string,
  options: FigmaWorkspaceCliSessionLockOptions = {},
): Promise<() => Promise<void>> {
  const lockFile = `${sessionFile}.lock`;
  const now = options.now ?? Date.now;
  const wait = options.wait ?? ((milliseconds: number) => new Promise<void>((resolveDelay) => setTimeout(resolveDelay, milliseconds)));
  const scheduleInterval = options.setInterval ?? setInterval;
  const cancelInterval = options.clearInterval ?? clearInterval;
  const heartbeatMs = options.heartbeatMs ?? FIGMA_WORKSPACE_SESSION_LOCK_HEARTBEAT_MS;
  const staleMs = options.staleMs ?? FIGMA_WORKSPACE_SESSION_LOCK_STALE_MS;
  const timeoutMs = options.timeoutMs ?? FIGMA_WORKSPACE_SESSION_LOCK_TIMEOUT_MS;
  const retryMs = options.retryMs ?? FIGMA_WORKSPACE_SESSION_LOCK_RETRY_MS;
  const renameLock = options.rename ?? rename;
  await mkdir(dirname(lockFile), { recursive: true });
  const deadline = now() + timeoutMs;
  while (true) {
    try {
      const lockToken = randomUUID();
      const handle = await open(lockFile, "wx");
      try {
        await handle.writeFile(`${JSON.stringify({ token: lockToken, pid: process.pid, createdAt: new Date().toISOString() })}\n`, "utf8");
      } catch (error) {
        await handle.close().catch(() => undefined);
        await rm(lockFile, { force: true }).catch(() => undefined);
        throw error;
      }
      let heartbeatError: unknown;
      let heartbeatWrite = Promise.resolve();
      const heartbeatTimer = scheduleInterval(() => {
        heartbeatWrite = heartbeatWrite
          .then(async () => handle.utimes(new Date(), new Date()))
          .catch((error: unknown) => {
            heartbeatError ??= error;
          });
      }, heartbeatMs);
      heartbeatTimer.unref();
      return async () => {
        cancelInterval(heartbeatTimer);
        await heartbeatWrite;
        let closeError: unknown;
        try {
          await handle.close();
        } catch (error) {
          closeError = error;
        }
        const currentLock = await readFile(lockFile, "utf8").catch((error: unknown) => {
          if (hasErrorCode(error, "ENOENT")) {
            return undefined;
          }
          throw error;
        });
        if (currentLock !== undefined && currentLock.includes(`"token":"${lockToken}"`)) {
          await rm(lockFile, { force: true });
        }
        if (closeError !== undefined) {
          throw closeError;
        }
        if (heartbeatError !== undefined) {
          throw heartbeatError;
        }
      };
    } catch (error) {
      if (!hasErrorCode(error, "EEXIST")) {
        throw error;
      }
      const lockStat = await stat(lockFile).catch((statError: unknown) => {
        if (hasErrorCode(statError, "ENOENT")) {
          return undefined;
        }
        throw statError;
      });
      if (lockStat !== undefined && now() - lockStat.mtimeMs > staleMs) {
        const staleLockSource = await readFile(lockFile, "utf8").catch((readError: unknown) => {
          if (hasErrorCode(readError, "ENOENT")) {
            return undefined;
          }
          throw readError;
        });
        if (staleLockSource === undefined) {
          continue;
        }
        if (!isSessionLockOwnerActive(staleLockSource, options.isProcessAlive)) {
          const claimedLockFile = `${lockFile}.stale-${randomUUID()}`;
          try {
            await renameLock(lockFile, claimedLockFile);
          } catch (renameError) {
            if (hasErrorCode(renameError, "ENOENT")
              || hasErrorCode(renameError, "EEXIST")
              || hasErrorCode(renameError, "EACCES")
              || hasErrorCode(renameError, "EPERM")) {
              continue;
            }
            throw renameError;
          }
          const claimedLockSource = await readFile(claimedLockFile, "utf8");
          if (claimedLockSource === staleLockSource
            && !isSessionLockOwnerActive(claimedLockSource, options.isProcessAlive)) {
            await rm(claimedLockFile, { force: true });
          } else {
            try {
              await link(claimedLockFile, lockFile);
              await rm(claimedLockFile, { force: true });
            } catch (restoreError) {
              if (!hasErrorCode(restoreError, "EEXIST")
                && !hasErrorCode(restoreError, "EACCES")
                && !hasErrorCode(restoreError, "EPERM")) {
                throw restoreError;
              }
            }
          }
          continue;
        }
      }
      if (now() >= deadline) {
        throw new Error(`Timed out waiting for session lock: ${lockFile}`);
      }
      await wait(retryMs);
    }
  }
}

function isSessionLockOwnerActive(
  lockSource: string,
  processAlive: (pid: number) => boolean = isProcessAlive,
): boolean {
  let lockData: unknown;
  try {
    lockData = JSON.parse(lockSource);
  } catch {
    return false;
  }
  if (!isRecord(lockData) || typeof lockData.pid !== "number" || !Number.isInteger(lockData.pid) || lockData.pid <= 0) {
    return false;
  }
  return processAlive(lockData.pid);
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return hasErrorCode(error, "EPERM") || hasErrorCode(error, "EACCES");
  }
}

export function isFigmaWorkspaceCliDirectRun(
  importMetaUrl: string,
  argv: readonly string[] = process.argv,
): boolean {
  return argv[1] !== undefined && resolve(fileURLToPath(importMetaUrl)) === resolve(argv[1]);
}

export const FIGMA_WORKSPACE_CLI_HELP = [
  "# Figma Workspace CLI help",
  "",
  "## Usage",
  "- `figma-workspace <command> [--input <json-file|->] [--session-file <path>] [--inline-result-limit <bytes>]`",
  "",
  "## Commands",
  ...FIGMA_WORKSPACE_CLI_COMMANDS.map((command) => `- \`${command}\``),
  "",
  "## Input",
  "Input defaults to `{}`. Use `--input -` to read one JSON object from stdin.",
  "",
  "## Options",
  `- \`--session-file <absolute-path>\`: Required unless fully qualified absolute \`$${FIGMA_WORKSPACE_SESSION_FILE_ENV}\` is set. Anchors persisted session state and the sibling \`results/\` directory.`,
  "- `--inline-result-limit <bytes>`: Global Markdown inline-result byte limit from 0 to 10000. CLI option overrides input `inlineResultLimit`; 0 always writes the complete result to a file; default is 4096.",
  "",
  "## Session State",
  `Session state requires a fully qualified absolute \`--session-file\` path or fully qualified absolute \`$${FIGMA_WORKSPACE_SESSION_FILE_ENV}\`.`,
  "",
  "## Output",
  "Command results use Restricted Markdown. Failed typed results include `Status: failed`.",
  "",
].join("\n");

export function createFigmaWorkspaceCommandHelp(command: FigmaWorkspaceCliCommand): string {
  const toolName = toFigmaWorkspaceToolName(command);
  const metadata = FIGMA_WORKSPACE_CLI_TOOL_DESCRIPTIONS.get(toolName);
  if (metadata === undefined) {
    throw new Error(`Missing CLI metadata for command: ${command}`);
  }
  const schemaSource = JSON.stringify(createCliCommandInputSchema(metadata.inputSchema), null, 2);
  return [
    `# figma-workspace ${command} help`,
    "",
    "## Purpose",
    metadata.description,
    "",
    "## Usage",
    `- \`figma-workspace ${command} [--input <json-file|->] [--session-file <path>] [--inline-result-limit <bytes>]\``,
    "",
    "## CLI Options",
    `- \`--session-file <absolute-path>\`: Required unless fully qualified absolute \`$${FIGMA_WORKSPACE_SESSION_FILE_ENV}\` is set. Anchors persisted session state and the sibling \`results/\` directory.`,
    "- `--inline-result-limit <bytes>`: Global Markdown inline-result byte limit from 0 to 10000. Overrides input `inlineResultLimit`; 0 forces result-file output; default is 4096.",
    "",
    "## Input JSON Schema",
    ...markdownFencedBlock("json", schemaSource),
    "",
    "## Output",
    "Restricted Markdown with an `Input:` line and recursively expanded result fields. Failed typed results include `Status: failed`.",
    "",
  ].join("\n");
}

function createCliCommandInputSchema(inputSchema: Record<string, unknown>): Record<string, unknown> {
  const properties = isRecord(inputSchema.properties) ? inputSchema.properties : {};
  return {
    ...inputSchema,
    properties: {
      ...properties,
      inlineResultLimit: {
        type: "integer",
        minimum: 0,
        maximum: FIGMA_WORKSPACE_CLI_MAX_INLINE_RESULT_LIMIT_BYTES,
        default: FIGMA_WORKSPACE_CLI_DEFAULT_INLINE_RESULT_LIMIT_BYTES,
        description: "Global Restricted Markdown inline-result byte limit when --inline-result-limit is omitted. 0 always writes the complete result under the session results directory.",
      },
    },
  };
}

function createCommandInvocationInput(
  command: FigmaWorkspaceCliCommand,
  input: Readonly<Record<string, unknown>>,
  explicitInlineResultLimit: number | undefined,
): Record<string, unknown> {
  if (!commandSupportsInlineResultLimit(command)) {
    const { inlineResultLimit: _cliOnlyInlineResultLimit, ...commandInput } = input;
    return commandInput;
  }
  if (explicitInlineResultLimit === undefined) {
    return { ...input };
  }
  return { ...input, inlineResultLimit: explicitInlineResultLimit };
}

function commandSupportsInlineResultLimit(command: FigmaWorkspaceCliCommand): boolean {
  const metadata = FIGMA_WORKSPACE_CLI_TOOL_DESCRIPTIONS.get(toFigmaWorkspaceToolName(command));
  return metadata !== undefined
    && isRecord(metadata.inputSchema.properties)
    && Object.hasOwn(metadata.inputSchema.properties, "inlineResultLimit");
}

export function formatFigmaWorkspaceCommandMarkdown(
  command: FigmaWorkspaceCliCommand,
  result: unknown,
  input: Readonly<Record<string, unknown>> = {},
  presentation: FigmaWorkspaceCliResultPresentation = classifyFigmaWorkspaceCliResult(command, result),
): string {
  const lines = [`# figma-workspace ${command}`];
  lines.push(formatMarkdownInput(input));
  lines.push(`Status: ${presentation.status.replace("-", " ")}`);
  if (isRecord(result)) {
    const fields = Object.entries(result).filter(([key, value]) => key !== "ok" && value !== undefined);
    if (fields.length === 0) {
      lines.push("Result: none");
    } else {
      for (const [key, value] of fields) {
        pushRestrictedMarkdownValue(lines, markdownLabel(key), value, 2, 0);
      }
    }
  } else {
    pushRestrictedMarkdownValue(lines, "Result", result, 2, 0);
  }
  return stripAnsi(lines.join("\n"));
}

export function classifyFigmaWorkspaceCliResult(
  command: FigmaWorkspaceCliCommand,
  result: unknown,
): FigmaWorkspaceCliResultPresentation {
  const failed = isRecord(result) && result.ok === false;
  const status = failed
    ? command === "doctor" ? "observed-unhealthy" : "failed"
    : "succeeded";
  return {
    status,
    exitCode: status === "failed"
      ? FIGMA_WORKSPACE_CLI_EXIT_EXECUTION_ERROR
      : FIGMA_WORKSPACE_CLI_EXIT_SUCCESS,
    error: presentationError(result),
    warnings: presentationWarnings(result),
  };
}

function presentationError(result: unknown): FigmaWorkspaceCliPresentationError | undefined {
  if (!isRecord(result)) return undefined;
  const candidate = isRecord(result.error)
    ? result.error
    : isRecord(result.upstreamError)
      ? result.upstreamError
      : undefined;
  if (candidate === undefined || typeof candidate.message !== "string") return undefined;
  const code = typeof candidate.code === "string" || typeof candidate.code === "number"
    ? candidate.code
    : undefined;
  return {
    message: candidate.message,
    ...(code === undefined ? {} : { code }),
    ...(candidate.details === undefined ? {} : { details: candidate.details }),
  };
}

function presentationWarnings(result: unknown): readonly unknown[] {
  if (!isRecord(result)) return [];
  const warnings = Array.isArray(result.warnings) ? result.warnings : [];
  const diagnostics = Array.isArray(result.diagnostics)
    ? result.diagnostics.filter((diagnostic) => isRecord(diagnostic) && diagnostic.severity === "warning")
    : [];
  return [...warnings, ...diagnostics];
}

function formatMarkdownInput(input: Readonly<Record<string, unknown>>): string {
  const entries = Object.entries(input).filter(([, value]) => value !== undefined);
  if (entries.length === 0) {
    return "Input: none";
  }
  return `Input: ${entries.map(([key, value]) => `${sanitizeMarkdownLabel(key)}=${markdownInlineValue(value)}`).join(", ")}`;
}

function pushRestrictedMarkdownValue(
  lines: string[],
  label: string,
  value: unknown,
  level: number,
  depth: number,
): void {
  if (isMarkdownScalar(value)) {
    const scalar = markdownScalar(value);
    if (!scalar.includes("\n") && !scalar.includes("\r")) {
      lines.push(`${label}: ${scalar}`);
      return;
    }
    pushMarkdownHeading(lines, level, label);
    lines.push(...markdownFencedBlock("text", scalar));
    return;
  }
  if (depth >= 5 || (!Array.isArray(value) && !isRecord(value))) {
    pushMarkdownHeading(lines, level, label);
    pushMarkdownJsonFence(lines, value);
    return;
  }
  pushMarkdownHeading(lines, level, label);
  if (Array.isArray(value)) {
    if (value.length === 0) {
      lines.push("- none");
      return;
    }
    for (const [index, entry] of value.entries()) {
      if (isMarkdownScalar(entry)) {
        lines.push(`- ${markdownBulletText(entry)}`);
      } else {
        pushMarkdownHeading(lines, level + 1, markdownArrayEntryHeading(label, entry, index));
        pushAnonymousRestrictedMarkdownValue(lines, entry, level + 2, depth + 1);
      }
    }
    return;
  }
  const entries = Object.entries(value).filter(([, entry]) => entry !== undefined);
  if (entries.length === 0) {
    lines.push("- none");
    return;
  }
  for (const [key, entry] of entries) {
    pushRestrictedMarkdownValue(lines, markdownLabel(key), entry, level + 1, depth + 1);
  }
}

function pushAnonymousRestrictedMarkdownValue(
  lines: string[],
  value: unknown,
  level: number,
  depth: number,
): void {
  if (isRecord(value)) {
    for (const [key, entry] of Object.entries(value)) {
      if (entry !== undefined) {
        pushRestrictedMarkdownValue(lines, markdownLabel(key), entry, level, depth);
      }
    }
    return;
  }
  if (Array.isArray(value)) {
    pushRestrictedMarkdownValue(lines, "Items", value, level, depth);
    return;
  }
  pushMarkdownJsonFence(lines, value);
}

function pushMarkdownHeading(lines: string[], level: number, title: string): void {
  if (lines.at(-1) !== "") {
    lines.push("");
  }
  lines.push(`${"#".repeat(Math.min(Math.max(level, 1), 6))} ${sanitizeMarkdownLabel(title)}`);
}

function pushMarkdownJsonFence(lines: string[], value: unknown): void {
  lines.push(...markdownFencedBlock("json", stringifyMarkdownJson(value)));
}

function markdownFencedBlock(language: "json" | "text", content: string): string[] {
  let longestBacktickRun = 0;
  for (const match of content.matchAll(/`+/gu)) {
    longestBacktickRun = Math.max(longestBacktickRun, match[0].length);
  }
  const fence = "`".repeat(Math.max(3, longestBacktickRun + 1));
  return [`${fence}${language}`, content, fence];
}

function markdownArrayEntryHeading(label: string, value: unknown, index: number): string {
  if (isRecord(value)) {
    for (const key of ["id", "name", "title", "path", "code"]) {
      if (isMarkdownScalar(value[key]) && value[key] !== null) {
        return markdownScalar(value[key]);
      }
    }
  }
  return `${label} ${index + 1}`;
}

function markdownLabel(key: string): string {
  return sanitizeMarkdownLabel(key
    .replaceAll(/([a-z0-9])([A-Z])/gu, "$1 $2")
    .replaceAll(/[_-]+/gu, " ")
    .replace(/^./u, (character) => character.toUpperCase()));
}

function sanitizeMarkdownLabel(label: string): string {
  const sanitized = stripAnsi(label)
    .replaceAll(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]+/gu, " ")
    .replaceAll(/\s+/gu, " ")
    .trim();
  return sanitized === "" ? "Field" : sanitized;
}

function isMarkdownScalar(value: unknown): value is string | number | boolean | bigint | null {
  return value === null || ["string", "number", "boolean", "bigint"].includes(typeof value);
}

function markdownScalar(value: string | number | boolean | bigint | null): string {
  if (value === null) {
    return "null";
  }
  if (typeof value === "string") {
    const sanitized = stripAnsi(value);
    return sanitized === "" ? "\"\"" : sanitized;
  }
  return String(value);
}

function markdownInlineValue(value: unknown): string {
  if (isMarkdownScalar(value)) {
    const scalar = markdownBulletText(value);
    if ([...scalar].length <= FIGMA_WORKSPACE_CLI_MAX_INPUT_VALUE_CHARS) {
      return scalar;
    }
    const prefix = [...scalar].slice(0, FIGMA_WORKSPACE_CLI_INPUT_PREFIX_CHARS).join("");
    return `${prefix}... <${Buffer.byteLength(scalar, "utf8")} bytes>`;
  }
  const compactJson = JSON.stringify(value, (_key, entry: unknown) => {
    if (typeof entry === "string") {
      return stripAnsi(entry);
    }
    if (typeof entry === "bigint") {
      return String(entry);
    }
    return entry;
  }) ?? String(value);
  if ([...compactJson].length <= FIGMA_WORKSPACE_CLI_MAX_INPUT_VALUE_CHARS) {
    return compactJson;
  }
  const kind = Array.isArray(value) ? "array" : "object";
  return `<${kind} ${Buffer.byteLength(compactJson, "utf8")} bytes>`;
}

function markdownBulletText(value: string | number | boolean | bigint | null): string {
  return markdownScalar(value).replaceAll(/\r?\n/gu, " ").trim();
}

function stringifyMarkdownJson(value: unknown): string {
  const serialized = JSON.stringify(value, (_key, entry: unknown) => {
    if (typeof entry === "string") {
      return stripAnsi(entry);
    }
    if (typeof entry === "bigint") {
      return String(entry);
    }
    return entry;
  }, 2);
  return serialized ?? String(value);
}

function jsonBigIntReplacer(_key: string, value: unknown): unknown {
  return typeof value === "bigint" ? String(value) : value;
}

function countTextLines(source: string): number {
  return source === "" ? 0 : source.split(/\r?\n/gu).length - (source.endsWith("\n") ? 1 : 0);
}

function stripAnsi(value: string): string {
  return value
    .replaceAll(/\u001B\][^\u0007]*(?:\u0007|\u001B\\)/gu, "")
    .replaceAll(/\u009D[^\u0007\u009C]*(?:\u0007|\u009C)/gu, "")
    .replaceAll(/\u001B(?:\[[0-?]*[ -/]*[@-~]|[@-_])/gu, "")
    .replaceAll(/\u009B[0-?]*[ -/]*[@-~]/gu, "");
}

async function readCommandInput(
  inputFile: string | undefined,
  io: FigmaWorkspaceCliIo,
): Promise<Record<string, unknown>> {
  if (inputFile === undefined) {
    return {};
  }
  const source = inputFile === "-"
    ? await io.readStdin()
    : await io.readFile(resolve(io.cwd(), inputFile));
  try {
    const value: unknown = JSON.parse(source);
    if (!isRecord(value)) {
      throw new FigmaWorkspaceCliUsageError("Command input must be a JSON object.");
    }
    return value;
  } catch (error) {
    if (error instanceof FigmaWorkspaceCliUsageError) {
      throw error;
    }
    throw new FigmaWorkspaceCliUsageError(`Command input is not valid JSON: ${formatCliError(error)}`);
  }
}

export function isFullyQualifiedAbsolutePath(path: string): boolean {
  return isAbsolute(path) && normalize(path) === resolve(path);
}

function resolveSessionFile(explicitPath: string | undefined, io: FigmaWorkspaceCliIo): string {
  const configuredPath = explicitPath ?? io.env(FIGMA_WORKSPACE_SESSION_FILE_ENV);
  if (configuredPath === undefined || configuredPath.trim() === "") {
    throw new FigmaWorkspaceCliUsageError(
      `Option --session-file requires a fully qualified absolute path when $${FIGMA_WORKSPACE_SESSION_FILE_ENV} is unset.`,
    );
  }
  if (!isFullyQualifiedAbsolutePath(configuredPath)) {
    throw new FigmaWorkspaceCliUsageError("Session file path must be a fully qualified absolute path.");
  }
  return resolve(configuredPath);
}

function resolveInlineResultLimit(explicitLimit: number | undefined, inputLimit: unknown): number {
  if (explicitLimit !== undefined) {
    return explicitLimit;
  }
  if (inputLimit !== undefined) {
    return parseInlineResultLimit(inputLimit, "Command input inlineResultLimit");
  }
  return FIGMA_WORKSPACE_CLI_DEFAULT_INLINE_RESULT_LIMIT_BYTES;
}

function parseInlineResultLimit(value: unknown, label: string): number {
  const numericValue = typeof value === "string" && value.trim() !== "" ? Number(value) : value;
  if (typeof numericValue !== "number"
    || !Number.isInteger(numericValue)
    || numericValue < 0
    || numericValue > FIGMA_WORKSPACE_CLI_MAX_INLINE_RESULT_LIMIT_BYTES) {
    throw new FigmaWorkspaceCliUsageError(
      `${label} must be an integer from 0 to ${FIGMA_WORKSPACE_CLI_MAX_INLINE_RESULT_LIMIT_BYTES}.`,
    );
  }
  return numericValue;
}

async function invokeFigmaWorkspaceCommand(
  client: FigmaWorkspaceClient,
  command: FigmaWorkspaceCliCommand,
  input: Record<string, unknown>,
): Promise<unknown> {
  switch (command) {
    case "open": return client.open(input as FigmaWorkspaceOpenArguments);
    case "eval": return client.eval(input as unknown as FigmaWorkspaceEvalArguments);
    case "run-script-file": return client.runScriptFile(input as unknown as FigmaWorkspaceRunScriptFileArguments);
    case "apply-asset-manifest": return client.applyAssetManifest(input as unknown as FigmaWorkspaceApplyAssetManifestArguments);
    case "download-assets": return client.downloadAssets(input as unknown as FigmaWorkspaceDownloadAssetsArguments);
    case "capture-node": return client.captureNode(input as unknown as FigmaWorkspaceCaptureNodeArguments);
    case "run-task-plan": return client.runTaskPlan(input as unknown as FigmaWorkspaceRunTaskPlanArguments);
    case "prepare-task": return client.prepareTask(input as unknown as FigmaWorkspacePrepareTaskArguments);
    case "guidance": return client.guidance(input as FigmaWorkspaceGuidanceArguments);
    case "inspect": return client.inspect(input as FigmaWorkspaceInspectArguments);
    case "get-metadata": return client.getMetadata(input as unknown as FigmaWorkspaceGetMetadataArguments);
    case "get-design-context": return client.getDesignContext(input as unknown as FigmaWorkspaceGetDesignContextArguments);
    case "get-motion-context": return client.getMotionContext(input as unknown as FigmaWorkspaceGetMotionContextArguments);
    case "search-design-system": return client.searchDesignSystem(input as unknown as FigmaWorkspaceSearchDesignSystemArguments);
    case "get-libraries": return client.getLibraries(input as FigmaWorkspaceGetLibrariesArguments);
    case "get-variable-defs": return client.getVariableDefs(input as unknown as FigmaWorkspaceGetVariableDefsArguments);
    case "call-upstream-tool": return client.callUpstreamTool(input as unknown as FigmaWorkspaceCallUpstreamToolArguments);
    case "lookup": return client.lookup(input as unknown as FigmaWorkspaceLookupArguments);
    case "docs": return client.docs(input as FigmaWorkspaceDocsArguments);
    case "doctor": return client.doctor(input as FigmaWorkspaceDoctorArguments);
    case "sessions": return client.sessionsInfo(input as FigmaWorkspaceSessionsArguments);
    case "upstream-tools": return client.upstreamTools(input as FigmaWorkspaceUpstreamToolsArguments);
  }
}

function createProcessCliIo(): FigmaWorkspaceCliIo {
  return {
    cwd: () => process.cwd(),
    env: (name) => process.env[name],
    readFile: (path) => readFile(path, "utf8"),
    readStdin: async () => {
      const chunks: Buffer[] = [];
      for await (const chunk of process.stdin) {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      }
      return Buffer.concat(chunks).toString("utf8");
    },
    writeStdout: (value) => process.stdout.write(value),
    writeStderr: (value) => process.stderr.write(value),
  };
}

function isFigmaWorkspaceCliCommand(value: string): value is FigmaWorkspaceCliCommand {
  return (FIGMA_WORKSPACE_CLI_COMMANDS as readonly string[]).includes(value);
}

type FigmaWorkspaceCliToolDescription = {
  description: string;
  inputSchema: Record<string, unknown>;
};

const FIGMA_WORKSPACE_CLI_TOOL_DESCRIPTIONS = new Map<string, FigmaWorkspaceCliToolDescription>(
  createReplToolDescriptions({
    taskWorkspaceRootEnv: TASK_WORKSPACE_ROOT_ENV,
    defaultDocsSearchMaxResults: DEFAULT_DOCS_SEARCH_MAX_RESULTS,
    maxDocsSearchResults: MAX_DOCS_SEARCH_RESULTS,
    defaultDocsSearchSnippetLines: DEFAULT_DOCS_SEARCH_SNIPPET_LINES,
    maxDocsSearchSnippetLines: MAX_DOCS_SEARCH_SNIPPET_LINES,
    maxLookupQueryLength: MAX_LOOKUP_QUERY_LENGTH,
  }).map((metadata) => {
    if (typeof metadata.name !== "string"
      || typeof metadata.description !== "string"
      || !isRecord(metadata.inputSchema)) {
      throw new Error("Figma Workspace tool metadata is invalid for CLI help.");
    }
    return [metadata.name, {
      description: metadata.description,
      inputSchema: metadata.inputSchema,
    }];
  }),
);

function toFigmaWorkspaceToolName(command: FigmaWorkspaceCliCommand): string {
  return `figma_workspace_${command.replaceAll("-", "_")}`;
}

function isFigmaWorkspaceSession(value: unknown): value is FigmaWorkspaceSession {
  if (!isRecord(value)) {
    return false;
  }
  return typeof value.id === "string"
    && typeof value.slug === "string"
    && typeof value.createdAt === "string"
    && typeof value.updatedAt === "string"
    && isStringRecord(value.knownPages)
    && Array.isArray(value.lastDiagnostics)
    && Array.isArray(value.history)
    && value.history.every((entry) => isRecord(entry) && Array.isArray(entry.nodeIds));
}

function assertNoLegacySessionHandles(value: unknown): void {
  if (!Array.isArray(value)) {
    return;
  }
  const legacySession = value.find((session) => isRecord(session) && Object.hasOwn(session, "handles"));
  if (legacySession !== undefined) {
    throw new FigmaWorkspaceCliUsageError(
      "Session file contains the removed legacy handles field. Create and use a new state file.",
    );
  }
}

function isStringRecord(value: unknown): value is Record<string, string> {
  return isRecord(value) && Object.values(value).every((entry) => typeof entry === "string");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isMissingFileError(error: unknown): boolean {
  return hasErrorCode(error, "ENOENT");
}

function hasErrorCode(error: unknown, code: string): boolean {
  return isRecord(error) && error.code === code;
}

function isCliInterruptError(error: unknown): boolean {
  return isRecord(error)
    && (error.name === "AbortError" || error.code === "ABORT_ERR" || error.code === "ERR_CANCELED");
}

function formatCliError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

if (isFigmaWorkspaceCliDirectRun(import.meta.url)) {
  process.exitCode = await runFigmaWorkspaceCli(process.argv.slice(2));
}
