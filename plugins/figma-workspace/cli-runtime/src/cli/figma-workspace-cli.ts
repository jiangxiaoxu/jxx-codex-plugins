import { createHash, randomUUID } from "node:crypto";
import { mkdir, open, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import {
  FigmaWorkspaceToolArgumentError,
  INLINE_RESULT_LIMIT_MAX,
  INLINE_RESULT_LIMIT_MIN,
  type FigmaWorkspaceApplyAssetManifestArguments,
  type FigmaWorkspaceCallUpstreamToolArguments,
  type FigmaWorkspaceCodeConnectApplyArguments,
  type FigmaWorkspaceCodeConnectInspectArguments,
  type FigmaWorkspaceCodeConnectPlanArguments,
  type FigmaWorkspaceCodeConnectVerifyArguments,
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
import { writeFigmaWorkspaceResultFile } from "../runtime/workspace-files.js";

export const FIGMA_WORKSPACE_CLI_EXIT_SUCCESS = 0;
export const FIGMA_WORKSPACE_CLI_EXIT_EXECUTION_ERROR = 1;
export const FIGMA_WORKSPACE_CLI_EXIT_USAGE_ERROR = 2;
export const FIGMA_WORKSPACE_CLI_EXIT_INTERRUPT = 130;

const DEFAULT_INLINE_RESULT_LIMIT = 2_048;
const MAX_INPUT_BYTES = 256 * 1024;
const LOCK_TIMEOUT_MS = 30_000;
const LOCK_RETRY_MS = 100;
const LOCK_STALE_MS = 30_000;
const LOCK_HEARTBEAT_MS = 5_000;
const MAX_EXECUTION_ERROR_SUMMARY_CHARS = 600;

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
  "code-connect-inspect",
  "code-connect-plan",
  "code-connect-apply",
  "code-connect-verify",
  "lookup",
  "docs",
  "doctor",
  "upstream-tools",
] as const;

export type FigmaWorkspaceCliCommand = typeof FIGMA_WORKSPACE_CLI_COMMANDS[number];

export type FigmaWorkspaceCliArguments =
  | { kind: "help"; command?: FigmaWorkspaceCliCommand }
  | { kind: "command"; command: FigmaWorkspaceCliCommand; inputFile?: string; inlineResultLimit?: number; format?: "json" };

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
  let format: "json" | undefined;
  for (let index = 1; index < argv.length; index += 1) {
    const option = argv[index];
    if (option === "-") {
      if (inputFile !== undefined) throw new FigmaWorkspaceCliUsageError("Command input may be specified only once.");
      inputFile = "-";
      continue;
    }
    if (option !== "--input" && option !== "--inline-result-limit" && option !== "--format") {
      throw new FigmaWorkspaceCliUsageError(`Unknown option: ${option}`);
    }
    const value = argv[++index];
    if (!value || value.startsWith("--")) throw new FigmaWorkspaceCliUsageError(`Option ${option} requires a value.`);
    if (option === "--input") {
      if (inputFile !== undefined) throw new FigmaWorkspaceCliUsageError("Command input may be specified only once.");
      inputFile = value;
    } else if (option === "--inline-result-limit") {
      if (inlineResultLimit !== undefined) throw new FigmaWorkspaceCliUsageError("Option --inline-result-limit may be specified only once.");
      inlineResultLimit = parseInlineLimit(value);
    } else {
      if (format !== undefined) throw new FigmaWorkspaceCliUsageError("Option --format may be specified only once.");
      if (value !== "json") throw new FigmaWorkspaceCliUsageError("Option --format supports only json.");
      format = value;
    }
  }
  if (inlineResultLimit !== undefined && !supportsInlineResultSidecar(command)) {
    throw new FigmaWorkspaceCliUsageError("Option --inline-result-limit is not available for this command.");
  }
  return {
    kind: "command",
    command,
    inputFile,
    inlineResultLimit,
    ...(format === undefined ? {} : { format }),
  };
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
  let apiMode: "search" | "read" | undefined;
  try {
    const input = await readCommandInput(parsed.inputFile, io);
    apiMode = apiLookupMode(parsed.command, input);
    if (parsed.format !== undefined && !supportsApiJsonOutput(parsed.command, input)) {
      throw new FigmaWorkspaceCliUsageError("Option --format json is available only for API lookup input.");
    }
    const inlineResultSidecar = supportsInlineResultSidecar(parsed.command);
    if (!inlineResultSidecar && input.inlineResultLimit !== undefined) {
      throw new FigmaWorkspaceCliUsageError("Option inlineResultLimit is not available for this command.");
    }
    const requestedInlineResultLimit = inlineResultSidecar
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
    const normalized = apiMode === undefined
      ? normalizeInvocationResult(result, invocationId, fileKey, input.surface, outputRoot)
      : result;
    const originalPresentation = classifyFigmaWorkspaceCliResult(parsed.command, normalized);
    let rendered = normalized;
    let presentation = originalPresentation;
    if (inlineResultSidecar) {
      try {
        rendered = await persistOversizedResult(normalized, parsed.command, outputRoot, requestedInlineResultLimit!);
      } catch (error) {
        rendered = createResultPersistenceFailure(normalized, error);
        presentation = classifyFigmaWorkspaceCliResult(parsed.command, rendered);
      }
    }
    const output = parsed.format === "json"
      ? formatFigmaWorkspaceApiJson(rendered)
      : formatFigmaWorkspaceCommandMarkdown(parsed.command, rendered, input, presentation);
    io.writeStdout(`${output}\n`);
    return presentation.exitCode;
  } catch (error) {
    if (parsed.format === "json") io.writeStdout(`${formatFigmaWorkspaceApiJsonError(error, apiMode)}\n`);
    else io.writeStderr(`${formatError(error)}\n`);
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
    case "code-connect-inspect": return client.codeConnectInspect(input as FigmaWorkspaceCodeConnectInspectArguments);
    case "code-connect-plan": return client.codeConnectPlan(input as FigmaWorkspaceCodeConnectPlanArguments);
    case "code-connect-apply": return client.codeConnectApply(input as FigmaWorkspaceCodeConnectApplyArguments);
    case "code-connect-verify": return client.codeConnectVerify(input as FigmaWorkspaceCodeConnectVerifyArguments);
    case "lookup": return client.lookup(input as FigmaWorkspaceLookupArguments);
    case "docs": return client.docs(input as FigmaWorkspaceDocsArguments);
    case "doctor": return client.doctor(input as FigmaWorkspaceDoctorArguments);
    case "upstream-tools": return client.upstreamTools(input as FigmaWorkspaceUpstreamToolsArguments);
  }
}

export interface FigmaWorkspaceCliResultPresentation {
  status: "succeeded" | "observed-unhealthy" | "failed" | "failed-atomically" | "failed-during-execution" | "failed-after-execution";
  exitCode: 0 | 1;
  error?: { message: string; code?: string | number; details?: unknown };
  recoveryHint?: string;
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
  const { isUpstream: _isUpstream, ...presentationFailure } = presentationFailureForResult(result);
  const failure = { warnings, ...presentationFailure };
  if (command === "doctor" && !ok) return { status: "observed-unhealthy", exitCode: 0, ...failure };
  if (executionOutcome === "failed_atomic" && !ok) {
    return { status: "failed-atomically", exitCode: 1, ...failure };
  }
  if (executionOutcome === "outcome_unknown" && !ok) {
    return { status: "failed-during-execution", exitCode: 1, ...failure };
  }
  if (executionOutcome === "succeeded" && !ok) {
    return { status: "failed-after-execution", exitCode: 1, ...failure };
  }
  if (!ok) return { status: "failed", exitCode: 1, ...failure };
  return { status: warnings.length ? "observed-unhealthy" : "succeeded", exitCode: 0, warnings };
}

export function formatFigmaWorkspaceCommandMarkdown(
  command: FigmaWorkspaceCliCommand,
  result: unknown,
  input: Record<string, unknown>,
  presentation = classifyFigmaWorkspaceCliResult(command, result),
): string {
  if (isApiLookupInput(command, input)) {
    return formatFigmaWorkspaceApiHumanResult(result, input, presentation);
  }
  const resultFileSummary = formatResultFileSummary(result, presentation);
  return [
    `# ${publicCommandName(command)}`,
    "",
    `Status: ${presentation.status.replaceAll("-", " ")}`,
    "",
    ...formatExecutionFailureSummary(result, presentation),
    ...resultFileSummary,
    ...(resultFileSummary.length > 0 ? [] : [
      "```json",
      JSON.stringify(result, null, 2),
      "```",
    ]),
  ].join("\n");
}

export function formatFigmaWorkspaceApiJson(result: unknown): string {
  const payload = isRecord(result)
    ? (() => {
      const { invocation: _invocation, outputRoot: _outputRoot, ...rest } = result;
      return rest;
    })()
    : result ?? null;
  return JSON.stringify(payload, null, 2);
}

export function formatFigmaWorkspaceApiJsonError(
  error: unknown,
  mode?: "search" | "read",
): string {
  const value = isRecord(error) ? error : {};
  const code = typeof value.code === "string" || typeof value.code === "number"
    ? value.code
    : "FIGMA_WORKSPACE_API_LOOKUP_FAILED";
  const candidates = Array.isArray(value.candidates) && value.candidates.every((candidate) => typeof candidate === "string")
    ? value.candidates
    : undefined;
  return JSON.stringify({
    ok: false,
    ...(mode === undefined ? {} : { mode }),
    error: {
      code,
      message: formatError(error),
      ...(candidates === undefined ? {} : { candidates }),
    },
  }, null, 2);
}

function formatFigmaWorkspaceApiHumanResult(
  result: unknown,
  input: Record<string, unknown>,
  presentation: FigmaWorkspaceCliResultPresentation,
): string {
  const fallbackMode = input.mode === "read" ? "read" : "search";
  if (!isRecord(result)) {
    return `# Figma Plugin API ${fallbackMode}\n\nNo Plugin API result was returned.`;
  }
  const mode = result.mode === "read" ? "read" : "search";
  const selector = stringValue(result.selector) ?? stringValue(result.normalizedSelector) ?? stringValue(input.selector) ?? "Plugin API";
  if (result.ok === false) return formatFigmaWorkspaceApiHumanFailure(mode, selector, result, presentation);
  if (mode === "read") return formatFigmaWorkspaceApiRead(selector, result);
  return formatFigmaWorkspaceApiSearch(selector, result);
}

function formatFigmaWorkspaceApiSearch(selector: string, result: Record<string, unknown>): string {
  const results = Array.isArray(result.results) ? result.results.filter(isRecord) : [];
  const lines = [
    `# Figma Plugin API search: ${selector}`,
    "",
    results.length === 0 ? "No matching declarations found." : `${results.length} matching declaration${results.length === 1 ? "" : "s"}:`,
  ];
  for (const entry of results) {
    const entrySelector = stringValue(entry.selector) ?? selector;
    const declarationKind = stringValue(entry.declarationKind);
    const snippet = stringValue(entry.snippet);
    lines.push("", `## ${entrySelector}${declarationKind === undefined ? "" : ` (${declarationKind})`}`);
    if (snippet !== undefined) lines.push("", "```ts", snippet.trim(), "```");
    lines.push("", `Read: figma:api:read ${entrySelector}`);
  }
  lines.push(...formatApiLookupNotes(result));
  return lines.join("\n");
}

function formatFigmaWorkspaceApiRead(selector: string, result: Record<string, unknown>): string {
  const declarations = Array.isArray(result.declarations) ? result.declarations.filter(isRecord) : [];
  const lines = [`# Figma Plugin API: ${selector}`];
  if (declarations.length === 0) {
    lines.push("", "No declarations were returned.");
    return lines.join("\n");
  }
  for (const [index, declaration] of declarations.entries()) {
    const declarationSelector = stringValue(declaration.selector) ?? selector;
    const declarationKind = stringValue(declaration.declarationKind);
    const source = formatApiDeclarationSource(declaration.source);
    const content = stringValue(declaration.content);
    lines.push(
      "",
      ...(declarations.length > 1 ? [`## ${declarationSelector}${declarationKind === undefined ? "" : ` (${declarationKind})`}`] : []),
      ...(declarations.length === 1 && declarationKind !== undefined ? [`${declarationKind}`] : []),
      ...(source === undefined ? [] : [`Source: ${source}`]),
    );
    if (content !== undefined) lines.push("", "```ts", content.trim(), "```");
    else lines.push("", `Declaration ${index + 1} has no printable TypeScript content.`);
  }
  lines.push(...formatApiLookupNotes(result));
  return lines.join("\n");
}

function formatFigmaWorkspaceApiHumanFailure(
  mode: "search" | "read",
  selector: string,
  result: Record<string, unknown>,
  presentation: FigmaWorkspaceCliResultPresentation,
): string {
  const failure = presentation.error ?? firstApiDiagnostic(result);
  const lines = [
    `# Figma Plugin API ${mode}: ${selector}`,
    "",
    `Error: ${formatApiError(failure)}`,
  ];
  lines.push(...formatApiLookupNotes(result));
  return lines.join("\n");
}

function formatApiDeclarationSource(value: unknown): string | undefined {
  if (!isRecord(value)) return undefined;
  const packageName = stringValue(value.package);
  const version = stringValue(value.version);
  if (packageName === undefined) return undefined;
  return version === undefined ? packageName : `${packageName} ${version}`;
}

function formatApiLookupNotes(result: Record<string, unknown>): string[] {
  const notes: string[] = [];
  const adjustments = Array.isArray(result.parameterAdjustments) ? result.parameterAdjustments.filter(isRecord) : [];
  for (const adjustment of adjustments) {
    const parameter = stringValue(adjustment.option) ?? "Search parameter";
    const applied = adjustment.applied ?? adjustment.value;
    notes.push("", `Note: ${parameter} was adjusted${applied === undefined ? "." : ` to ${String(applied)}.`}`);
  }
  if (isRecord(result.snippetBudget) && result.snippetBudget.truncated === true) {
    notes.push("", "Note: Search snippets were shortened to stay within the output budget.");
  }
  return notes;
}

function firstApiDiagnostic(result: Record<string, unknown>): { message: string; code?: string | number } | undefined {
  const diagnostics = Array.isArray(result.diagnostics) ? result.diagnostics : [];
  for (const diagnostic of diagnostics) {
    if (!isRecord(diagnostic) || typeof diagnostic.message !== "string") continue;
    return {
      message: diagnostic.message,
      ...(typeof diagnostic.code === "string" || typeof diagnostic.code === "number" ? { code: diagnostic.code } : {}),
    };
  }
  return undefined;
}

function formatApiError(error: { message: string; code?: string | number } | undefined): string {
  if (!error) return "Plugin API lookup failed.";
  return error.code === undefined ? error.message : `${error.code}: ${error.message}`;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function formatExecutionFailureSummary(
  result: unknown,
  presentation: FigmaWorkspaceCliResultPresentation,
): string[] {
  if (!isRecord(result) || !presentation.error) {
    return [];
  }
  const atomicScriptFailure = result.executionOutcome === "failed_atomic";
  const error = presentation.error;
  const message = compactExecutionErrorSummary(error?.message ?? "Figma host returned an explicit execution error.");
  const code = error?.code === undefined ? undefined : String(error.code);
  return [
    atomicScriptFailure ? "## Remote execution error" : "## Error",
    "",
    "```text",
    code ? `${code}: ${message}` : message,
    "```",
    ...(presentation.recoveryHint ? ["", `Next step: ${compactExecutionErrorSummary(presentation.recoveryHint)}`] : []),
    ...(atomicScriptFailure ? ["", "Figma host confirmed this use_figma script failed atomically. No file changes were applied; repair the script and retry safely."] : []),
    "",
  ];
}

function formatResultFileSummary(
  result: unknown,
  presentation: FigmaWorkspaceCliResultPresentation,
): string[] {
  const resultFile = existingResultFilePointer(result);
  if (!resultFile) return [];
  const path = typeof resultFile.path === "string" && resultFile.path.trim() ? resultFile.path : undefined;
  if (!path) return [];
  return [
    `Result file: \`${path}\``,
    ...formatResultAttentionSummary(result, presentation),
    "",
  ];
}

function formatResultAttentionSummary(
  result: unknown,
  presentation: FigmaWorkspaceCliResultPresentation,
): string[] {
  if (!isRecord(result)) return [];
  const warningCount = typeof result.warningCount === "number" ? result.warningCount : 0;
  const diagnosticCount = typeof result.diagnosticCount === "number" ? result.diagnosticCount : 0;
  const attention: string[] = [];
  if ((warningCount > 0 || diagnosticCount > 0) && presentation.error === undefined) {
    attention.push("Attention: warnings or diagnostics are present; inspect the result file for details.");
  }
  if (result.hasMore === true) {
    attention.push("Attention: inspect page hasMore=true; continue with nextCursor from the result file.");
  }
  return attention.length === 0 ? [] : ["", ...attention];
}

export const FIGMA_WORKSPACE_CLI_HELP = [
  "Stateless Figma Workspace internal runtime.",
  "",
  "Usage: figma-workspace <command> [--input <json-file|->]",
  `Remote result option: [--inline-result-limit <${INLINE_RESULT_LIMIT_MIN}..${INLINE_RESULT_LIMIT_MAX}>]`,
  "",
  `Commands: ${FIGMA_WORKSPACE_CLI_COMMANDS.join(", ")}`,
  "",
  "Each command or live upstream schema that requires a Figma file or node receives that target in this invocation. Persistent state and session files are not supported.",
  "",
].join("\n");

export function createFigmaWorkspaceCommandHelp(command: FigmaWorkspaceCliCommand): string {
  const inlineLimit = supportsInlineResultSidecar(command) ? ` [--inline-result-limit <${INLINE_RESULT_LIMIT_MIN}..${INLINE_RESULT_LIMIT_MAX}>]` : "";
  return `${publicCommandName(command)}\n\nUsage: figma-workspace ${command} [--input <json-file|->]${inlineLimit}\n`;
}

function supportsInlineResultSidecar(command: FigmaWorkspaceCliCommand): boolean {
  return command !== "docs" && command !== "lookup" && command !== "doctor" && command !== "upstream-tools";
}

function supportsApiJsonOutput(command: FigmaWorkspaceCliCommand, input: Record<string, unknown>): boolean {
  return isApiLookupInput(command, input);
}

function isApiLookupInput(command: FigmaWorkspaceCliCommand, input: Record<string, unknown>): boolean {
  return command === "lookup"
    && input.kind === "api"
    && (input.mode === "search" || input.mode === "read");
}

function apiLookupMode(
  command: FigmaWorkspaceCliCommand,
  input: Record<string, unknown>,
): "search" | "read" | undefined {
  if (!isApiLookupInput(command, input)) return undefined;
  return input.mode === "read" ? "read" : "search";
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
  const existingResultFile = existingResultFilePointer(result);
  if (existingResultFile !== undefined) return createResultFileSummary(result, existingResultFile);
  await ensureManagedDirectory({ root: outputRoot, directory: outputRoot });
  const resultPath = resolve(outputRoot, `${command.replace(/[^a-z0-9]+/giu, "-")}.result.json`);
  const receipt = resultReceiptPayload(result);
  const written = await writeFigmaWorkspaceResultFile(resultPath, {
    tool: publicCommandName(command),
    invocation: receipt.invocation,
    result: receipt.result,
  });
  return createResultFileSummary(result, { ...written });
}

function resultReceiptPayload(result: unknown): {
  invocation: Record<string, unknown>;
  result: unknown;
} {
  if (!isRecord(result)) return { invocation: {}, result };
  const { invocation, ...businessResult } = result;
  return {
    invocation: isRecord(invocation) ? invocation : {},
    result: businessResult,
  };
}

function existingResultFilePointer(result: unknown): Record<string, unknown> | undefined {
  if (!isRecord(result) || !isRecord(result.outputFiles) || !isRecord(result.outputFiles.resultFile)) return undefined;
  return result.outputFiles.resultFile;
}

function createResultFileSummary(result: unknown, resultFile: Record<string, unknown>): Record<string, unknown> {
  const record = isRecord(result) ? result : undefined;
  const failure = record?.ok === false ? presentationFailureForResult(record) : {};
  const upstreamError = (record ? compactPresentationError(record.upstreamError) : undefined)
    ?? (failure.isUpstream ? compactPresentationError(failure.error) : undefined);
  return {
    ...selectRecoveryFacts(result),
    ...(Array.isArray(record?.warnings) && record.warnings.length > 0 ? { warningCount: record.warnings.length } : {}),
    ...(Array.isArray(record?.diagnostics) && record.diagnostics.length > 0 ? { diagnosticCount: record.diagnostics.length } : {}),
    ...(record?.hasMore === true ? { hasMore: true } : {}),
    error: upstreamError ? undefined : compactPresentationError(failure.error),
    recoveryHint: failure.recoveryHint,
    upstreamError,
    ok: record ? record.ok !== false : true,
    invocation: record?.invocation,
    outputFiles: {
      resultFile,
    },
  };
}

function createResultPersistenceFailure(result: unknown, error: unknown): Record<string, unknown> {
  const record = isRecord(result) ? result : undefined;
  const operationFailure = record?.ok === false ? presentationFailureForResult(record) : {};
  const upstreamError = (record ? compactPresentationError(record.upstreamError) : undefined)
    ?? (operationFailure.isUpstream ? compactPresentationError(operationFailure.error) : undefined);
  return {
    ...selectRecoveryFacts(result),
    ...(Array.isArray(record?.warnings) && record.warnings.length > 0 ? { warningCount: record.warnings.length } : {}),
    ...(Array.isArray(record?.diagnostics) && record.diagnostics.length > 0 ? { diagnosticCount: record.diagnostics.length } : {}),
    ...(record?.hasMore === true ? { hasMore: true } : {}),
    operationError: upstreamError ? undefined : compactPresentationError(operationFailure.error),
    operationRecoveryHint: operationFailure.recoveryHint,
    upstreamError,
    ok: false,
    invocation: record?.invocation,
    error: {
      code: "FIGMA_WORKSPACE_RESULT_PERSISTENCE_FAILED",
      message: `The oversized CLI result could not be persisted after the remote command returned: ${formatError(error)}`,
    },
  };
}

function selectRecoveryFacts(result: unknown): Record<string, unknown> {
  if (!isRecord(result)) return {};
  return Object.fromEntries([
    "phase",
    "executionOutcome",
    "retryGuidance",
    "primaryFix",
    "postProcessing",
    "captureProcessingSucceeded",
    "fileKey",
    "nodeId",
    "toolName",
    "planDigest",
    "outputDir",
    "imageFile",
    "planFile",
    "script",
    "inlineResultLimit",
  ].flatMap((key) => result[key] === undefined ? [] : [[key, result[key]]]));
}

function presentationFailureForResult(result: Record<string, unknown>): {
  error?: { message: string; code?: string | number; details?: unknown };
  recoveryHint?: string;
  isUpstream?: boolean;
} {
  const overallRecoveryHint = firstRecoveryHint(result);
  const upstreamError = normalizeError(result.upstreamError);
  if (upstreamError) return { error: upstreamError, recoveryHint: overallRecoveryHint, isUpstream: true };
  const direct = normalizeError(result.error);
  if (direct) return { error: direct, recoveryHint: overallRecoveryHint };
  const diagnostics = Array.isArray(result.diagnostics) ? result.diagnostics : [];
  for (const value of diagnostics) {
    if (!isRecord(value) || value.severity !== "fatal") continue;
    const diagnostic = normalizeFailureRecord(value);
    if (diagnostic) return { ...diagnostic, recoveryHint: firstRecoveryHint(value) ?? overallRecoveryHint };
  }
  for (const key of ["failures", "assets", "targets", "captures", "mappings"] as const) {
    for (const value of Array.isArray(result[key]) ? result[key] : []) {
      if (isRecord(value) && value.ok !== false && key !== "failures" && key !== "mappings") continue;
      const failure = normalizeFailureRecord(value);
      if (failure) return { ...failure, recoveryHint: overallRecoveryHint ?? firstRecoveryHint(value) };
    }
  }
  for (const key of ["application", "validation"] as const) {
    const value = result[key];
    if (isRecord(value) && value.ok === false) {
      const failure = normalizeFailureRecord(value);
      if (failure) return { ...failure, recoveryHint: overallRecoveryHint ?? firstRecoveryHint(value) };
    }
  }
  for (const value of diagnostics) {
    const diagnostic = normalizeFailureRecord(value);
    if (diagnostic) return { ...diagnostic, recoveryHint: firstRecoveryHint(value) ?? overallRecoveryHint };
  }
  return { recoveryHint: overallRecoveryHint };
}

function normalizeFailureRecord(value: unknown): {
  error: { message: string; code?: string | number; details?: unknown };
  isUpstream?: boolean;
} | undefined {
  if (!isRecord(value)) return undefined;
  for (const key of ["upstreamError", "downloadError", "error"] as const) {
    const nested = normalizeError(value[key]);
    if (nested) return { error: nested, ...(key === "upstreamError" ? { isUpstream: true } : {}) };
  }
  if (typeof value.message === "string" || typeof value.code === "string" || typeof value.code === "number") {
    const error = normalizeError(value);
    return error ? { error } : undefined;
  }
  if (typeof value.reason === "string" && value.reason.trim()) {
    return { error: { message: value.reason } };
  }
  return undefined;
}

function firstRecoveryHint(result: Record<string, unknown>): string | undefined {
  for (const value of [result.retryGuidance, result.primaryFix, result.suggestion]) {
    if (typeof value === "string" && value.trim()) return value;
  }
  return undefined;
}

function compactPresentationError(value: unknown): { message: string; code?: string | number } | undefined {
  const error = normalizeError(value);
  if (!error) return undefined;
  return {
    message: compactExecutionErrorSummary(error.message),
    ...(error.code === undefined ? {} : { code: error.code }),
  };
}

function compactExecutionErrorSummary(value: string): string {
  const normalized = value.replace(/\s+/gu, " ").trim();
  if (normalized.length <= MAX_EXECUTION_ERROR_SUMMARY_CHARS) return normalized;
  return `${normalized.slice(0, MAX_EXECUTION_ERROR_SUMMARY_CHARS - 3)}...`;
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
  return ["run", "apply-asset-manifest", "download-assets", "capture-node", "code-connect-plan"].includes(command)
    || typeof input.outputDir === "string";
}

function isMutationCommand(command: FigmaWorkspaceCliCommand, fileKey: string | undefined): boolean {
  if (command === "run" || command === "apply-asset-manifest" || command === "code-connect-apply") return true;
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
  if (typeof value === "number" && Number.isInteger(value) && value >= INLINE_RESULT_LIMIT_MIN && value <= INLINE_RESULT_LIMIT_MAX) return value;
  throw new FigmaWorkspaceCliUsageError(`inlineResultLimit must be an integer from ${INLINE_RESULT_LIMIT_MIN} to ${INLINE_RESULT_LIMIT_MAX}.`);
}
function parseInlineLimit(value: string): number { if(!/^\d+$/u.test(value))throw new FigmaWorkspaceCliUsageError(`--inline-result-limit must be an integer from ${INLINE_RESULT_LIMIT_MIN} to ${INLINE_RESULT_LIMIT_MAX}.`);const parsed=Number(value);if(!Number.isSafeInteger(parsed)||parsed<INLINE_RESULT_LIMIT_MIN||parsed>INLINE_RESULT_LIMIT_MAX)throw new FigmaWorkspaceCliUsageError(`--inline-result-limit must be an integer from ${INLINE_RESULT_LIMIT_MIN} to ${INLINE_RESULT_LIMIT_MAX}.`);return parsed; }
function extractFileKey(value: unknown): string | undefined {
  if (typeof value !== "string" || !value.trim()) return undefined;
  try {
    const url = new URL(value);
    const parts = url.pathname.split("/").filter(Boolean);
    const validHost = url.protocol === "https:" && (url.hostname === "figma.com" || url.hostname.endsWith(".figma.com"));
    const validSurface = parts.length >= 2 && ["design", "file", "figjam", "board", "slides"].includes(parts[0]!);
    const isBranchPath = parts[0] === "design" && parts[2] === "branch";
    const fileKey = isBranchPath ? parts[3] : parts[1];
    if (!validHost || !validSurface || !fileKey) {
      throw new FigmaWorkspaceCliUsageError("Figma URLs must use https://*.figma.com/<design|file|figjam|board|slides>/<fileKey>.");
    }
    return fileKey;
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
