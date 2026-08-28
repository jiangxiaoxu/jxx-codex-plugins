#!/usr/bin/env node

import { randomUUID } from "node:crypto";
import { spawn as spawnProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { lstat, readFile, realpath, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import {
  dirname,
  isAbsolute,
  join,
  normalize,
  posix,
  relative,
  resolve,
  win32,
} from "node:path";
import { fileURLToPath } from "node:url";

export const LIVE_TEST_CONFIG_RELATIVE_PATH = ".figma-workspace/live-test.json";
export const LIVE_TEST_CONFIG_SCHEMA_VERSION = 2;
export const LIVE_SMOKE_PLUGIN_DATA_NAMESPACE = "figma_workspace.live_smoke";
export const LIVE_SMOKE_PLUGIN_DATA_KEY = "run_id";
export const COMMAND_TOTAL_TIMEOUT_MS = 5 * 60 * 1_000;
export const COMMAND_IDLE_TIMEOUT_MS = 60 * 1_000;
export const COMMAND_TERMINATION_GRACE_MS = 5_000;
export const MAX_HYDRATED_UPSTREAM_SIDECAR_BYTES = 64 * 1024 * 1024;

const PLUGIN_ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));
const CONFIG_ALLOWED_KEYS = new Set([
  "schemaVersion",
  "designFileUrl",
  "outputDir",
  "allowMutationCleanup",
]);
const CONFIG_REQUIRED_KEYS = ["schemaVersion", "designFileUrl", "allowMutationCleanup"];
const SECRET_CONFIG_KEY_PATTERN = /(?:api[-_]?key|authorization|credential|oauth|password|secret|token)/iu;
const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

export class LiveSmokeUsageError extends Error {
  constructor(message, options) {
    super(message, options);
    this.name = "LiveSmokeUsageError";
  }
}

export class LiveSmokeCommandError extends Error {
  constructor(message, options = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = "LiveSmokeCommandError";
    this.command = options.command;
    this.execution = options.execution;
    this.evidence = options.evidence;
  }
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isNonEmptyString(value) {
  return typeof value === "string" && value.trim() !== "";
}

function formatPath(path) {
  return typeof path === "string" ? path : "<unknown path>";
}

export function isFullyQualifiedAbsolutePath(value) {
  if (!isNonEmptyString(value) || value.includes("\0")) {
    return false;
  }
  const pathImplementations = [
    { isAbsolute, normalize, resolve },
    { isAbsolute: win32.isAbsolute, normalize: win32.normalize, resolve: win32.resolve },
    { isAbsolute: posix.isAbsolute, normalize: posix.normalize, resolve: posix.resolve },
  ];
  return pathImplementations.some((implementation) => (
    implementation.isAbsolute(value)
      && implementation.normalize(value) === implementation.resolve(value)
  ));
}

export function isSafeRelativePngFileName(value) {
  return typeof value === "string"
    && /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}\.png$/u.test(value)
    && !value.includes("..")
    && !value.includes("/")
    && !value.includes("\\");
}

function isPathInside(root, candidate) {
  const relation = relative(root, candidate);
  return relation === "" || (!relation.startsWith("..") && !isAbsolute(relation));
}

function assertDesignFileUrl(value) {
  if (!isNonEmptyString(value)) {
    throw new LiveSmokeUsageError('Live test config field "designFileUrl" must be a non-empty Design URL.');
  }
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new LiveSmokeUsageError('Live test config field "designFileUrl" must be a valid https://*.figma.com/design/... URL.');
  }
  const isFigmaHost = url.hostname === "figma.com" || url.hostname.endsWith(".figma.com");
  const hasDesignFileKey = /^\/design\/[^/]+(?:\/|$)/u.test(url.pathname);
  const hasSecretQuery = [...url.searchParams.keys()].some((key) => SECRET_CONFIG_KEY_PATTERN.test(key));
  if (url.protocol !== "https:" || !isFigmaHost || !hasDesignFileKey || hasSecretQuery) {
    throw new LiveSmokeUsageError(
      'Live test config field "designFileUrl" must be a Design URL without OAuth tokens or secrets.',
    );
  }
  return url.toString();
}

function assertConfigAbsolutePath(value, field) {
  if (!isFullyQualifiedAbsolutePath(value)) {
    throw new LiveSmokeUsageError(
      `Live test config field "${field}" must be a normalized fully qualified absolute path.`,
    );
  }
  return resolve(value);
}

export function parseLiveTestConfig(value, options = {}) {
  const configPath = options.configPath ?? LIVE_TEST_CONFIG_RELATIVE_PATH;
  if (!isRecord(value)) {
    throw new LiveSmokeUsageError(`Live test config ${formatPath(configPath)} must be a JSON object.`);
  }
  const keys = Object.keys(value);
  const secretKeys = keys.filter((key) => SECRET_CONFIG_KEY_PATTERN.test(key));
  if (secretKeys.length > 0) {
    throw new LiveSmokeUsageError(
      `Live test config ${formatPath(configPath)} must not contain OAuth tokens or secrets: ${secretKeys.join(", ")}.`,
    );
  }
  const unknownKeys = keys.filter((key) => !CONFIG_ALLOWED_KEYS.has(key));
  if (unknownKeys.length > 0) {
    throw new LiveSmokeUsageError(
      `Live test config ${formatPath(configPath)} does not allow unknown field${unknownKeys.length === 1 ? "" : "s"}: ${unknownKeys.join(", ")}.`,
    );
  }
  const missingKeys = CONFIG_REQUIRED_KEYS.filter((key) => !Object.hasOwn(value, key));
  if (missingKeys.length > 0) {
    throw new LiveSmokeUsageError(
      `Live test config ${formatPath(configPath)} requires: ${missingKeys.join(", ")}.`,
    );
  }
  if (value.schemaVersion !== LIVE_TEST_CONFIG_SCHEMA_VERSION) {
    throw new LiveSmokeUsageError(
      `Live test config ${formatPath(configPath)} field "schemaVersion" must equal ${LIVE_TEST_CONFIG_SCHEMA_VERSION}.`,
    );
  }
  if (value.allowMutationCleanup !== true) {
    throw new LiveSmokeUsageError(
      'Live test config field "allowMutationCleanup" must be true because the smoke test creates and removes tagged nodes.',
    );
  }
  return Object.freeze({
    schemaVersion: LIVE_TEST_CONFIG_SCHEMA_VERSION,
    designFileUrl: assertDesignFileUrl(value.designFileUrl),
    outputDir: value.outputDir === undefined
      ? undefined
      : assertConfigAbsolutePath(value.outputDir, "outputDir"),
    allowMutationCleanup: true,
  });
}

export async function loadLiveTestConfig(options = {}) {
  const pluginRoot = options.pluginRoot ?? PLUGIN_ROOT;
  const configPath = resolve(pluginRoot, LIVE_TEST_CONFIG_RELATIVE_PATH);
  const read = options.readFile ?? readFile;
  let source;
  try {
    source = await read(configPath, "utf8");
  } catch (error) {
    throw new LiveSmokeUsageError(
      `Live test config is required at ${configPath}. Create it locally; it must remain Git ignored.`,
      { cause: error },
    );
  }
  let parsed;
  try {
    parsed = JSON.parse(String(source));
  } catch (error) {
    throw new LiveSmokeUsageError(`Live test config ${configPath} is not valid JSON.`, { cause: error });
  }
  return {
    configPath,
    config: parseLiveTestConfig(parsed, { configPath }),
  };
}

export function resolveOAuthCachePath(env = process.env) {
  if (isNonEmptyString(env.FIGMA_WORKSPACE_OAUTH_CACHE_PATH)) {
    return env.FIGMA_WORKSPACE_OAUTH_CACHE_PATH;
  }
  if (isNonEmptyString(env.CODEX_HOME)) {
    return resolve(env.CODEX_HOME, ".figma-workspace-oauth.json");
  }
  if (isNonEmptyString(env.USERPROFILE)) {
    return resolve(env.USERPROFILE, ".codex", ".figma-workspace-oauth.json");
  }
  return undefined;
}

export async function assertOAuthCacheFile(options = {}) {
  const cachePath = resolveOAuthCachePath(options.env ?? process.env);
  if (!cachePath) {
    throw new LiveSmokeUsageError(
      "Unable to resolve the Figma OAuth cache. Set FIGMA_WORKSPACE_OAUTH_CACHE_PATH, CODEX_HOME, or USERPROFILE.",
    );
  }
  const statFile = options.stat ?? stat;
  try {
    const details = await statFile(cachePath);
    if (!details.isFile()) {
      throw new Error("OAuth cache path is not a file.");
    }
  } catch (error) {
    throw new LiveSmokeUsageError(
      `Figma OAuth cache is not available at ${cachePath}. Run npm run login:figma-http first.`,
      { cause: error },
    );
  }
  return cachePath;
}

function stringifyCommandInput(input) {
  if (input === undefined) {
    return undefined;
  }
  if (typeof input === "string") {
    return input.endsWith("\n") ? input : `${input}\n`;
  }
  return `${JSON.stringify(input)}\n`;
}

function stopChild(child) {
  try {
    child.kill("SIGTERM");
  } catch {
    // The close/error event below remains the authoritative terminal signal.
  }
}

export async function executeChildProcess(options) {
  const spawn = options.spawn ?? spawnProcess;
  const command = options.command;
  const args = options.args ?? [];
  const input = stringifyCommandInput(options.input);
  const totalTimeoutMs = options.totalTimeoutMs ?? COMMAND_TOTAL_TIMEOUT_MS;
  const idleTimeoutMs = options.idleTimeoutMs ?? COMMAND_IDLE_TIMEOUT_MS;
  const terminationGraceMs = options.terminationGraceMs ?? COMMAND_TERMINATION_GRACE_MS;

  return new Promise((resolveExecution) => {
    const stdoutChunks = [];
    const stderrChunks = [];
    let child;
    let finished = false;
    let timeoutKind;
    let spawnError;
    let totalTimer;
    let idleTimer;
    let forceKillTimer;
    let forceResolveTimer;

    const clearTimers = () => {
      if (totalTimer !== undefined) clearTimeout(totalTimer);
      if (idleTimer !== undefined) clearTimeout(idleTimer);
      if (forceKillTimer !== undefined) clearTimeout(forceKillTimer);
      if (forceResolveTimer !== undefined) clearTimeout(forceResolveTimer);
    };
    const finish = (details = {}) => {
      if (finished) return;
      finished = true;
      clearTimers();
      resolveExecution({
        command,
        args: [...args],
        exitCode: details.exitCode ?? null,
        signal: details.signal ?? null,
        stdout: Buffer.concat(stdoutChunks).toString("utf8"),
        stderr: Buffer.concat(stderrChunks).toString("utf8"),
        timedOut: timeoutKind !== undefined,
        timeoutKind,
        spawnError,
        forceTerminated: details.forceTerminated === true,
      });
    };
    const resetIdleTimer = () => {
      if (idleTimer !== undefined) clearTimeout(idleTimer);
      idleTimer = setTimeout(() => {
        timeoutKind = "idle";
        stopChild(child);
        forceKillTimer = setTimeout(() => {
          try {
            child?.kill("SIGKILL");
          } catch {
            // The force-resolution fallback preserves collected output.
          }
        }, terminationGraceMs);
        forceResolveTimer = setTimeout(() => {
          finish({ forceTerminated: true });
        }, terminationGraceMs * 2);
      }, idleTimeoutMs);
    };
    const onOutput = (chunks) => (chunk) => {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
      resetIdleTimer();
    };
    try {
      child = spawn(command, args, {
        cwd: options.cwd,
        env: options.env,
        stdio: "pipe",
        windowsHide: true,
      });
    } catch (error) {
      spawnError = error;
      finish();
      return;
    }
    child.stdout?.on("data", onOutput(stdoutChunks));
    child.stderr?.on("data", onOutput(stderrChunks));
    child.on("error", (error) => {
      spawnError = error;
      finish();
    });
    child.on("close", (exitCode, signal) => finish({ exitCode, signal }));
    if (finished) return;
    totalTimer = setTimeout(() => {
      timeoutKind = "total";
      stopChild(child);
      forceKillTimer = setTimeout(() => {
        try {
          child.kill("SIGKILL");
        } catch {
          // The force-resolution fallback preserves collected output.
        }
      }, terminationGraceMs);
      forceResolveTimer = setTimeout(() => {
        finish({ forceTerminated: true });
      }, terminationGraceMs * 2);
    }, totalTimeoutMs);
    resetIdleTimer();
    if (child.stdin) {
      child.stdin.on?.("error", (error) => {
        if (!finished) {
          stderrChunks.push(Buffer.from(`stdin error: ${error.message}\n`, "utf8"));
        }
      });
      child.stdin.end(input);
    }
  });
}

function resolveWindowsNpmCliPath(env) {
  const candidates = [
    env.npm_execpath,
    resolve(dirname(process.execPath), "node_modules", "npm", "bin", "npm-cli.js"),
  ];
  return candidates.find((candidate) => (
    isNonEmptyString(candidate)
      && isAbsolute(candidate)
      && existsSync(candidate)
  ));
}

export function createNpmCommandExecutor(options = {}) {
  const npmCommand = options.npmCommand
    ?? (process.platform === "win32" ? "npm.cmd" : "npm");
  const cwd = options.cwd ?? PLUGIN_ROOT;
  const env = options.env ?? process.env;
  const npmCliPath = process.platform === "win32" && options.npmCommand === undefined
    ? resolveWindowsNpmCliPath(env)
    : undefined;
  if (process.platform === "win32" && options.npmCommand === undefined && npmCliPath === undefined) {
    throw new LiveSmokeUsageError(
      "Unable to locate npm-cli.js for the live smoke child process. Run npm run test:live so npm_execpath is available, or use a standard Node.js installation with node_modules/npm/bin/npm-cli.js.",
    );
  }
  return async (command) => executeChildProcess({
    spawn: options.spawn,
    command: npmCliPath === undefined ? npmCommand : process.execPath,
    args: npmCliPath === undefined
      ? ["--silent", "run", command.script, "--", ...command.args]
      : [npmCliPath, "--silent", "run", command.script, "--", ...command.args],
    input: command.input,
    cwd,
    env,
    totalTimeoutMs: command.totalTimeoutMs ?? COMMAND_TOTAL_TIMEOUT_MS,
    idleTimeoutMs: command.idleTimeoutMs ?? COMMAND_IDLE_TIMEOUT_MS,
    terminationGraceMs: options.terminationGraceMs,
  });
}

export function extractCliResultSidecarPath(stdout) {
  const marker = /^#{2,6} Cli Result File\s*$/mu.exec(stdout);
  if (!marker || marker.index === undefined) {
    throw new LiveSmokeCommandError("Command did not publish outputFiles.cliResultFile despite --max-inline-bytes 0.");
  }
  const section = stdout.slice(marker.index + marker[0].length);
  const pathMatch = /^Path:\s*(.+?)\s*$/mu.exec(section);
  if (!pathMatch?.[1]) {
    throw new LiveSmokeCommandError("Command result sidecar did not include its Path field.");
  }
  return pathMatch[1];
}

export function extractCliInlineResult(stdout) {
  const matches = [...String(stdout).matchAll(/```json[ \t]*\r?\n([\s\S]*?)\r?\n```/gu)];
  const source = matches.at(-1)?.[1];
  if (source === undefined) {
    throw new LiveSmokeCommandError("Command did not publish an inline JSON result.");
  }
  try {
    return JSON.parse(source);
  } catch (error) {
    throw new LiveSmokeCommandError("Command inline JSON result was not valid JSON.", { cause: error });
  }
}

function assertSafeArtifactPath(path, outputDir, description) {
  if (!isFullyQualifiedAbsolutePath(path)) {
    throw new LiveSmokeCommandError(`${description} path must be a normalized fully qualified absolute path.`);
  }
  const resolvedPath = resolve(path);
  const permittedRoot = outputDir === undefined
    ? resolve(tmpdir(), "figma-workspace")
    : resolve(outputDir);
  if (!isPathInside(permittedRoot, resolvedPath)) {
    throw new LiveSmokeCommandError(
      `${description} must remain inside ${permittedRoot}.`,
    );
  }
  return resolvedPath;
}

function assertSafeSidecarPath(sidecarPath, outputDir) {
  return assertSafeArtifactPath(sidecarPath, outputDir, "Command result sidecar");
}

async function readBoundedJsonArtifact(path, options, description = "CLI sidecar") {
  const safePath = assertSafeArtifactPath(path, options.outputDir, description);
  const permittedRoot = options.outputDir === undefined
    ? resolve(tmpdir(), "figma-workspace")
    : resolve(options.outputDir);
  const resolveRealPath = options.realpath ?? realpath;
  const [canonicalRoot, canonicalPath] = await Promise.all([
    resolveRealPath(permittedRoot),
    resolveRealPath(safePath),
  ]);
  if (!isPathInside(resolve(canonicalRoot), resolve(canonicalPath))) {
    throw new LiveSmokeCommandError(`${description} must remain inside its canonical output root.`);
  }
  const details = await (options.lstat ?? lstat)(safePath);
  if (
    !details.isFile()
    || details.isSymbolicLink?.()
    || !Number.isSafeInteger(details.size)
    || details.size < 0
    || details.size > MAX_HYDRATED_UPSTREAM_SIDECAR_BYTES
  ) {
    throw new LiveSmokeCommandError(`${description} must be a regular JSON file no larger than 64 MiB.`);
  }
  const source = await options.readFile(safePath, "utf8");
  const sourceBytes = Buffer.isBuffer(source)
    ? source.byteLength
    : Buffer.byteLength(String(source), "utf8");
  if (sourceBytes > MAX_HYDRATED_UPSTREAM_SIDECAR_BYTES) {
    throw new LiveSmokeCommandError(`${description} exceeded the 64 MiB limit while reading.`);
  }
  try {
    return { path: safePath, value: JSON.parse(String(source)) };
  } catch (error) {
    throw new LiveSmokeCommandError(`${description} is not valid JSON.`, { cause: error });
  }
}

async function hydrateOmittedUpstreamResult(result, options) {
  if (!isRecord(result) || !isRecord(result.upstream) || Object.hasOwn(result.upstream, "result")) {
    return result;
  }
  const outputFiles = isRecord(result.outputFiles) ? result.outputFiles : undefined;
  const upstreamFile = outputFiles !== undefined && isRecord(outputFiles.upstreamFile)
    ? outputFiles.upstreamFile
    : undefined;
  if (upstreamFile === undefined) {
    return result;
  }
  const path = upstreamFile.path;
  if (
    !isFullyQualifiedAbsolutePath(path)
    || !resolve(path).toLowerCase().endsWith(".upstream.json")
  ) {
    throw new LiveSmokeCommandError("CLI upstream sidecar path must be a normalized absolute .upstream.json file.");
  }
  const hydrated = (await readBoundedJsonArtifact(path, options, "CLI upstream sidecar")).value;
  if (
    !isRecord(hydrated)
    || hydrated.kind !== result.upstream.kind
    || hydrated.ok !== result.upstream.ok
    || !Object.hasOwn(hydrated, "result")
  ) {
    throw new LiveSmokeCommandError("CLI upstream sidecar did not match the command result envelope.");
  }
  return {
    ...result,
    upstream: {
      ...result.upstream,
      result: hydrated.result,
    },
  };
}

function describeExecutionFailure(step, execution) {
  if (execution.timedOut) {
    return `${step} exceeded its ${execution.timeoutKind} timeout; partial stdout and stderr were retained.`;
  }
  if (execution.spawnError) {
    return `${step} could not start: ${execution.spawnError.message}.`;
  }
  return `${step} did not produce a readable complete result sidecar (exit ${execution.exitCode ?? "unknown"}).`;
}

async function runFigmaSidecarCommand(options) {
  const execution = await options.executor({
    script: options.script,
    args: options.args,
    input: options.input,
    totalTimeoutMs: options.totalTimeoutMs ?? COMMAND_TOTAL_TIMEOUT_MS,
    idleTimeoutMs: options.idleTimeoutMs ?? COMMAND_IDLE_TIMEOUT_MS,
  });
  if (!isRecord(execution)) {
    throw new LiveSmokeCommandError(`${options.step} executor returned an invalid process result.`, {
      command: options.script,
      evidence: options.evidence,
    });
  }
  if (execution.timedOut || execution.spawnError) {
    throw new LiveSmokeCommandError(describeExecutionFailure(options.step, execution), {
      command: options.script,
      execution,
      evidence: options.evidence,
    });
  }
  let sidecarPath;
  let result;
  try {
    if (options.inlineResult === true) {
      result = extractCliInlineResult(String(execution.stdout ?? ""));
    } else {
      const stdout = String(execution.stdout ?? "");
      const hasMarker = /^#{2,6} Cli Result File\s*$/mu.test(stdout);
      const markerPath = hasMarker
        ? assertSafeSidecarPath(extractCliResultSidecarPath(stdout), options.outputDir)
        : undefined;
      const markerCandidate = markerPath === undefined
        ? undefined
        : await readBoundedJsonArtifact(markerPath, options, "Command result sidecar");
      const inlineResult = (() => {
        try {
          return extractCliInlineResult(stdout);
        } catch {
          return undefined;
        }
      })();
      const inlineCliResultPath = isRecord(inlineResult)
        && isRecord(inlineResult.outputFiles)
        && isRecord(inlineResult.outputFiles.cliResultFile)
        ? inlineResult.outputFiles.cliResultFile.path
        : undefined;
      let inlineCliResult;
      if (typeof inlineCliResultPath === "string" && inlineCliResultPath !== markerPath) {
        const preferredPath = assertSafeSidecarPath(inlineCliResultPath, options.outputDir);
        inlineCliResult = await readBoundedJsonArtifact(preferredPath, options, "CLI result sidecar");
      }
      const candidates = [
        ...(markerCandidate === undefined ? [] : [markerCandidate]),
        ...(inlineResult === undefined ? [] : [{ path: undefined, value: inlineResult }]),
        ...(inlineCliResult === undefined ? [] : [inlineCliResult]),
      ];
      const wrapper = candidates.find(({ value }) => isHydratableUpstreamWrapper(value));
      const completeCapture = options.script === "figma:capture"
        ? candidates.find(({ value }) => isRecord(value) && typeof value.imageFile === "string")
        : undefined;
      const selected = wrapper ?? completeCapture ?? candidates.find(({ value }) => isRecord(value));
      if (selected === undefined) throw new LiveSmokeCommandError("Command sidecar candidates did not contain a JSON object.");
      sidecarPath = selected.path;
      result = selected.value;
    }
  } catch (error) {
    throw new LiveSmokeCommandError(describeExecutionFailure(options.step, execution), {
      cause: error,
      command: options.script,
      execution,
      evidence: options.evidence,
    });
  }
  if (!isRecord(result)) {
    throw new LiveSmokeCommandError(`${options.step} sidecar must contain a JSON object.`, {
      command: options.script,
      execution,
      evidence: options.evidence,
    });
  }
  try {
    result = await hydrateOmittedUpstreamResult(result, options);
  } catch (error) {
    throw new LiveSmokeCommandError(`${options.step} could not safely hydrate its omitted upstream result.`, {
      cause: error,
      command: options.script,
      execution,
      evidence: options.evidence,
    });
  }
  return { execution, result, sidecarPath };
}

function isHydratableUpstreamWrapper(value) {
  return isRecord(value)
    && isRecord(value.upstream)
    && isRecord(value.outputFiles)
    && isRecord(value.outputFiles.upstreamFile)
    && typeof value.outputFiles.upstreamFile.path === "string";
}

function commonCommandArgs() {
  return ["--max-inline-bytes", "0"];
}

async function runDirectCommand(options) {
  const inlineResult = options.commandName === "upstream:list" || options.commandName === "upstream:read";
  return runFigmaSidecarCommand({
    ...options,
    script: `figma:${options.commandName}`,
    args: [
      ...(options.positionals ?? []),
      ...(options.options ?? []),
      ...(inlineResult ? [] : commonCommandArgs()),
    ],
    inlineResult,
  });
}

async function runScriptCommand(options) {
  const outputDirArgs = options.outputDir === undefined ? [] : ["--output-dir", options.outputDir];
  return runFigmaSidecarCommand({
    ...options,
    script: "figma:run",
    args: [
      "--file", options.designFileUrl,
      "--source", "-",
      "--surface", "design",
      ...outputDirArgs,
      ...commonCommandArgs(),
    ],
    input: options.source,
  });
}

function requireSuccessfulResult(command, invocation) {
  if (invocation.execution.exitCode !== 0 || invocation.result.ok !== true) {
    throw new LiveSmokeCommandError(`${command} failed. Inspect its retained sidecar before rerunning this live test.`, {
      command,
      execution: invocation.execution,
    });
  }
  return invocation.result;
}

function requireRecordField(record, field, command) {
  const value = record[field];
  if (!isRecord(value)) {
    throw new LiveSmokeCommandError(`${command} result is missing object field "${field}".`);
  }
  return value;
}

function requireUpstreamResult(record, command) {
  const upstream = requireRecordField(record, "upstream", command);
  if (upstream.ok !== true) {
    throw new LiveSmokeCommandError(`${command} did not report upstream.ok: true.`);
  }
  return requireRecordField(upstream, "result", command);
}

function requireExecutionOutcome(invocation, command) {
  const outcome = invocation.result.executionOutcome;
  if (outcome === "outcome_unknown") {
    if (!isNonEmptyString(invocation.result.retryGuidance)) {
      throw new LiveSmokeCommandError(`${command} returned outcome_unknown without retryGuidance.`);
    }
    return outcome;
  }
  if (outcome === "succeeded" && invocation.result.ok === true && invocation.execution.exitCode === 0) {
    return outcome;
  }
  throw new LiveSmokeCommandError(
    `${command} did not complete with executionOutcome: succeeded. Do not rerun a mutation without reconciling the retained result.`,
    { command, execution: invocation.execution },
  );
}

function liveCreationCode(tagNamespace, tagKey, runId) {
  return [
    `const tagNamespace = ${JSON.stringify(tagNamespace)};`,
    `const tagKey = ${JSON.stringify(tagKey)};`,
    `const runId = ${JSON.stringify(runId)};`,
    "const frame = figma.createFrame();",
    "frame.setSharedPluginData(tagNamespace, tagKey, runId);",
    "const text = figma.createText();",
    "text.setSharedPluginData(tagNamespace, tagKey, runId);",
    "frame.appendChild(text);",
    "frame.name = `Figma Workspace Live Smoke ${runId}`;",
    "frame.resize(360, 180);",
    "const font = text.fontName;",
    "if (font === figma.mixed) throw new Error('Live smoke text unexpectedly has mixed fonts.');",
    "await figma.loadFontAsync(font);",
    "text.characters = `Figma Workspace live smoke ${runId}`;",
    "text.x = 24;",
    "text.y = 24;",
    "return { tagNamespace, tagKey, runId, frameId: frame.id, textId: text.id, changedNodeIds: [frame.id, text.id] };",
  ].join("\n");
}

function liveReadbackCode(tagNamespace, tagKey, runId) {
  return [
    `const tagNamespace = ${JSON.stringify(tagNamespace)};`,
    `const tagKey = ${JSON.stringify(tagKey)};`,
    `const runId = ${JSON.stringify(runId)};`,
    "const matches = figma.currentPage.findAll((node) => node.getSharedPluginData(tagNamespace, tagKey) === runId);",
    "return {",
    "  tagNamespace,",
    "  tagKey,",
    "  runId,",
    "  matches: matches.map((node) => ({",
    "    id: node.id,",
    "    type: node.type,",
    "    parentId: node.parent?.id ?? null,",
    "    tag: node.getSharedPluginData(tagNamespace, tagKey),",
    "  })),",
    "  changedNodeIds: matches.map((node) => node.id),",
    "};",
  ].join("\n");
}

function liveCleanupCode(tagNamespace, tagKey, runId) {
  return [
    `const tagNamespace = ${JSON.stringify(tagNamespace)};`,
    `const tagKey = ${JSON.stringify(tagKey)};`,
    `const runId = ${JSON.stringify(runId)};`,
    "const matches = figma.currentPage.findAll((node) => node.getSharedPluginData(tagNamespace, tagKey) === runId);",
    "const untaggedNodes = figma.currentPage.findAll((node) => node.getSharedPluginData(tagNamespace, tagKey) !== runId);",
    "const depthOf = (node: SceneNode): number => {",
    "  let depth = 0;",
    "  let parent = node.parent;",
    "  while (parent) {",
    "    depth += 1;",
    "    parent = parent.parent;",
    "  }",
    "  return depth;",
    "};",
    "const isDescendantOf = (node: SceneNode, ancestorId: string): boolean => {",
    "  let parent = node.parent;",
    "  while (parent) {",
    "    if (parent.id === ancestorId) return true;",
    "    parent = parent.parent;",
    "  }",
    "  return false;",
    "};",
    "const ordered = [...matches].sort((left, right) => depthOf(right) - depthOf(left) || left.id.localeCompare(right.id));",
    "const matchedNodeIds = matches.map((node) => node.id);",
    "const removedNodeIds: string[] = [];",
    "const blockedNodeIds: string[] = [];",
    "for (const node of ordered) {",
    "  if (!node.removed && node.getSharedPluginData(tagNamespace, tagKey) === runId) {",
    "    if (untaggedNodes.some((candidate) => !candidate.removed && isDescendantOf(candidate, node.id))) {",
    "      blockedNodeIds.push(node.id);",
    "      continue;",
    "    }",
    "    removedNodeIds.push(node.id);",
    "    node.remove();",
    "  }",
    "}",
    "return { tagNamespace, tagKey, runId, matchedNodeIds, removedNodeIds, blockedNodeIds, changedNodeIds: removedNodeIds };",
  ].join("\n");
}

function normalizeReadback(result, command, tagNamespace, tagKey, runId) {
  const payload = requireUpstreamResult(result, command);
  if (
    payload.tagNamespace !== tagNamespace
    || payload.tagKey !== tagKey
    || payload.runId !== runId
    || !Array.isArray(payload.matches)
  ) {
    throw new LiveSmokeCommandError(`${command} returned an invalid live-smoke PluginData reconciliation payload.`);
  }
  const matches = payload.matches.map((entry) => {
    if (
      !isRecord(entry)
      || !isNonEmptyString(entry.id)
      || !isNonEmptyString(entry.type)
      || !Object.hasOwn(entry, "parentId")
      || (entry.parentId !== null && !isNonEmptyString(entry.parentId))
      || !isNonEmptyString(entry.tag)
    ) {
      throw new LiveSmokeCommandError(`${command} returned an invalid reconciled node.`);
    }
    return {
      id: entry.id,
      type: entry.type,
      parentId: entry.parentId,
      tag: entry.tag,
    };
  });
  return { payload, matches };
}

function describeReconciledNodes(matches) {
  if (matches.length === 0) return "none";
  return matches.map((node) => `${node.type}:${node.id}`).join(", ");
}

function requireCompleteTaggedStructure(readback, command, tagNamespace, tagKey, runId) {
  const unexpectedTag = readback.matches.find((node) => node.tag !== runId);
  const frames = readback.matches.filter((node) => node.type === "FRAME");
  const texts = readback.matches.filter((node) => node.type === "TEXT");
  const uniqueIds = new Set(readback.matches.map((node) => node.id));
  if (
    unexpectedTag
    || readback.matches.length !== 2
    || uniqueIds.size !== readback.matches.length
    || frames.length !== 1
    || texts.length !== 1
    || texts[0].parentId !== frames[0].id
  ) {
    throw new LiveSmokeCommandError(
      `${command} must reconcile exactly one ${tagNamespace}/${tagKey}-tagged FRAME and one ${tagNamespace}/${tagKey}-tagged TEXT with the TEXT parented by the FRAME; observed ${describeReconciledNodes(readback.matches)}. Do not rerun creation; the finally cleanup will remove only this exact shared PluginData tag.`,
    );
  }
  return { frame: frames[0], text: texts[0] };
}

function requireCreationChangedNodeIds(invocation, command, frame, text, tagNamespace, tagKey, runId) {
  const payload = requireUpstreamResult(invocation.result, command);
  if (
    payload.tagNamespace !== tagNamespace
    || payload.tagKey !== tagKey
    || payload.runId !== runId
    || !Array.isArray(payload.changedNodeIds)
  ) {
    throw new LiveSmokeCommandError(`${command} did not return its expected tagged changedNodeIds payload.`);
  }
  const changedNodeIds = new Set();
  for (const id of payload.changedNodeIds) {
    if (!isNonEmptyString(id)) {
      throw new LiveSmokeCommandError(`${command} returned an invalid changedNodeIds entry.`);
    }
    changedNodeIds.add(id);
  }
  const missing = [frame.id, text.id].filter((id) => !changedNodeIds.has(id));
  if (missing.length > 0) {
    throw new LiveSmokeCommandError(
      `${command} confirmed execution but upstream.result.changedNodeIds did not cover the reconciled nodes: ${missing.join(", ")}. Do not rerun creation; the finally cleanup will remove only this exact PluginData tag.`,
    );
  }
}

async function reconcileTaggedNodes(options) {
  const invocation = await runScriptCommand({
    ...options,
    step: options.step,
    source: liveReadbackCode(options.tagNamespace, options.tagKey, options.runId),
  });
  requireExecutionOutcome(invocation, `${options.step} figma:run`);
  return {
    invocation,
    ...normalizeReadback(
      invocation.result,
      `${options.step} figma:run`,
      options.tagNamespace,
      options.tagKey,
      options.runId,
    ),
  };
}

async function cleanupTaggedNodes(options) {
  const before = await reconcileTaggedNodes({ ...options, step: "cleanup preflight reconciliation" });
  if (before.matches.length === 0) {
    return { before, deleteInvocation: undefined, after: before };
  }

  let deleteInvocation;
  let deleteError;
  try {
    deleteInvocation = await runScriptCommand({
      ...options,
      step: "cleanup deletion",
      totalTimeoutMs: COMMAND_TOTAL_TIMEOUT_MS,
      source: liveCleanupCode(options.tagNamespace, options.tagKey, options.runId),
    });
    requireExecutionOutcome(deleteInvocation, "cleanup deletion figma:run");
  } catch (error) {
    deleteError = error;
  }

  let after;
  let afterError;
  try {
    after = await reconcileTaggedNodes({ ...options, step: "cleanup final reconciliation" });
  } catch (error) {
    afterError = error;
  }
  if (deleteError) {
    if (afterError) {
      throw new LiveSmokeCommandError(
        `Cleanup deletion did not produce a confirmed result and final reconciliation also failed: ${afterError.message}`,
        { cause: deleteError },
      );
    }
    if (after.matches.length === 0) {
      return { before, deleteInvocation, after, deletionOutcomeUnknown: true };
    }
    throw deleteError;
  }
  if (afterError) {
    throw afterError;
  }
  if (after.matches.length > 0) {
    throw new LiveSmokeCommandError(
      "Cleanup left nodes with this exact live-smoke PluginData tag. Reconcile them before another live smoke run.",
    );
  }
  return { before, deleteInvocation, after };
}

function formatEvidence(evidence) {
  return [
    `Config: ${evidence.configPath}`,
    `Design file: ${evidence.designFileUrl}`,
    ...(evidence.outputDir ? [`Output directory: ${evidence.outputDir}`] : []),
    ...(evidence.captureFile ? [`Capture: ${evidence.captureFile}`] : []),
  ].join("\n");
}

function formatPartialProcessOutput(execution) {
  if (!isRecord(execution)) return "";
  const parts = [];
  if (isNonEmptyString(execution.stdout)) {
    parts.push(`Partial stdout:\n${execution.stdout}`);
  }
  if (isNonEmptyString(execution.stderr)) {
    parts.push(`Partial stderr:\n${execution.stderr}`);
  }
  return parts.join("\n");
}

function asLiveSmokeError(error, evidence) {
  if (error instanceof LiveSmokeUsageError || error instanceof LiveSmokeCommandError) {
    if (error.evidence === undefined) error.evidence = evidence;
    return error;
  }
  return new LiveSmokeCommandError(error instanceof Error ? error.message : String(error), {
    cause: error,
    evidence,
  });
}

async function runPublicDoctor(options) {
  const execution = await options.executor({
    script: "figma:doctor",
    args: [],
    totalTimeoutMs: COMMAND_TOTAL_TIMEOUT_MS,
    idleTimeoutMs: COMMAND_IDLE_TIMEOUT_MS,
  });
  if (!isRecord(execution) || execution.timedOut || execution.spawnError || execution.exitCode !== 0) {
    throw new LiveSmokeCommandError(describeExecutionFailure("figma:doctor", execution ?? {}), {
      command: "figma:doctor",
      execution,
      evidence: options.evidence,
    });
  }
  return execution;
}

export async function runLiveSmokeTest(options = {}) {
  const loaded = options.config === undefined
    ? await loadLiveTestConfig({ pluginRoot: options.pluginRoot, readFile: options.readFile })
    : { configPath: options.configPath ?? resolve(options.pluginRoot ?? PLUGIN_ROOT, LIVE_TEST_CONFIG_RELATIVE_PATH), config: options.config };
  const config = parseLiveTestConfig(loaded.config, { configPath: loaded.configPath });
  const read = options.readFile ?? readFile;
  const executor = options.executor ?? createNpmCommandExecutor({
    cwd: options.pluginRoot ?? PLUGIN_ROOT,
    env: options.env,
    spawn: options.spawn,
  });
  const runId = options.runId ?? randomUUID();
  if (!/^[A-Za-z0-9-]{8,128}$/u.test(runId)) {
    throw new LiveSmokeUsageError("Live smoke runId must contain only ASCII letters, numbers, and hyphens.");
  }
  const captureFileName = `live-smoke-${runId}.png`;
  if (!isSafeRelativePngFileName(captureFileName)) {
    throw new LiveSmokeUsageError("Generated live-smoke capture filename is not safe.");
  }
  const evidence = {
    configPath: loaded.configPath,
    designFileUrl: config.designFileUrl,
    outputDir: config.outputDir,
    captureFile: undefined,
  };
  const commandOptions = {
    executor,
    readFile: read,
    stat: options.stat ?? stat,
    designFileUrl: config.designFileUrl,
    outputDir: config.outputDir,
    evidence,
    lstat: options.lstat ?? lstat,
    realpath: options.realpath ?? realpath,
  };
  let creationIssued = false;
  let workflowError;
  let summary;
  let oauthCachePath;
  try {
    oauthCachePath = await assertOAuthCacheFile({ env: options.env, stat: options.stat });

    await runPublicDoctor(commandOptions);

    const upstreamContract = await runDirectCommand({
      ...commandOptions,
      outputDir: undefined,
      step: "whoami upstream contract", commandName: "upstream:read", positionals: ["whoami"], options: ["--refresh"],
    });
    const upstreamContractResult = requireSuccessfulResult("figma:upstream:read whoami", upstreamContract);
    if (upstreamContractResult.name !== "whoami" || !isRecord(upstreamContractResult.inputSchema)) {
      throw new LiveSmokeCommandError("figma:upstream:read did not confirm the whoami contract.");
    }

    const metadata = await runDirectCommand({
      ...commandOptions,
      step: "read Design metadata",
      commandName: "metadata",
      options: [
        "--file", config.designFileUrl,
        ...(config.outputDir === undefined ? [] : ["--output-dir", config.outputDir]),
      ],
    });
    requireSuccessfulResult("figma:metadata", metadata);

    creationIssued = true;
    const creation = await runScriptCommand({
      ...commandOptions,
      step: "create tagged smoke nodes",
      source: liveCreationCode(LIVE_SMOKE_PLUGIN_DATA_NAMESPACE, LIVE_SMOKE_PLUGIN_DATA_KEY, runId),
    });
    const creationOutcome = requireExecutionOutcome(creation, "creation figma:run");

    const readback = await reconcileTaggedNodes({
      ...commandOptions,
      step: creationOutcome === "outcome_unknown" ? "creation unknown-outcome reconciliation" : "creation reconciliation",
      tagNamespace: LIVE_SMOKE_PLUGIN_DATA_NAMESPACE,
      tagKey: LIVE_SMOKE_PLUGIN_DATA_KEY,
      runId,
    });
    const { frame, text } = requireCompleteTaggedStructure(
      readback,
      creationOutcome === "outcome_unknown" ? "Creation outcome unknown reconciliation" : "Creation reconciliation",
      LIVE_SMOKE_PLUGIN_DATA_NAMESPACE,
      LIVE_SMOKE_PLUGIN_DATA_KEY,
      runId,
    );
    if (creationOutcome === "succeeded") {
      requireCreationChangedNodeIds(
        creation,
        "creation figma:run",
        frame,
        text,
        LIVE_SMOKE_PLUGIN_DATA_NAMESPACE,
        LIVE_SMOKE_PLUGIN_DATA_KEY,
        runId,
      );
    }

    const captureOutputArgs = config.outputDir === undefined ? [] : ["--output-dir", config.outputDir];
    const captureImageFile = config.outputDir === undefined
      ? undefined
      : join(config.outputDir, captureFileName);
    const capture = await runDirectCommand({
      ...commandOptions,
      step: "capture reconciled frame",
      commandName: "capture",
      options: [
        "--file", config.designFileUrl,
        "--node", frame.id,
        "--max-dimension", "1024",
        ...captureOutputArgs,
        ...(captureImageFile === undefined ? [] : ["--image-file", captureImageFile]),
      ],
    });
    const captureResult = requireSuccessfulResult("figma:capture", capture);
    evidence.captureFile = assertSafeArtifactPath(captureResult.imageFile, config.outputDir, "figma:capture imageFile");
    const image = await read(evidence.captureFile);
    const imageBytes = Buffer.isBuffer(image) ? image : Buffer.from(image);
    if (imageBytes.byteLength < PNG_SIGNATURE.byteLength || !imageBytes.subarray(0, PNG_SIGNATURE.byteLength).equals(PNG_SIGNATURE)) {
      throw new LiveSmokeCommandError("figma:capture output is not a PNG file.");
    }
    summary = {
      configPath: loaded.configPath,
      oauthCachePath,
      designFileUrl: config.designFileUrl,
      outputDir: config.outputDir,
      runId,
      creationOutcome,
      frameId: frame.id,
      textId: text.id,
      captureFile: evidence.captureFile,
      captureBytes: imageBytes.byteLength,
    };
  } catch (error) {
    workflowError = asLiveSmokeError(error, evidence);
  }

  let cleanup;
  let cleanupError;
  if (creationIssued) {
    try {
      cleanup = await cleanupTaggedNodes({
        ...commandOptions,
        tagNamespace: LIVE_SMOKE_PLUGIN_DATA_NAMESPACE,
        tagKey: LIVE_SMOKE_PLUGIN_DATA_KEY,
        runId,
      });
    } catch (error) {
      cleanupError = asLiveSmokeError(error, evidence);
    }
  }
  if (workflowError && cleanupError) {
    throw new LiveSmokeCommandError(
      `${workflowError.message}\nCleanup also failed: ${cleanupError.message}\n${formatEvidence(evidence)}`,
      { cause: workflowError, evidence },
    );
  }
  if (workflowError) {
    throw workflowError;
  }
  if (cleanupError) {
    throw cleanupError;
  }
  return { ...summary, cleanup };
}

export async function main(argv = process.argv.slice(2)) {
  if (argv.length > 0) {
    throw new LiveSmokeUsageError("npm run test:live does not accept arguments; it always reads .figma-workspace/live-test.json.");
  }
  const result = await runLiveSmokeTest();
  process.stdout.write([
    "Figma Workspace live smoke succeeded.",
    `Run ID: ${result.runId}`,
    `Capture: ${result.captureFile}`,
    `Design file: ${result.designFileUrl}`,
    ...(result.outputDir ? [`Output directory: ${result.outputDir}`] : []),
    "Cleanup: exact PluginData-tagged nodes reconciled and removed.",
    "",
  ].join("\n"));
  return result;
}

const entrypointPath = process.argv[1] === undefined ? undefined : resolve(process.argv[1]);
if (entrypointPath === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    const exitCode = error instanceof LiveSmokeUsageError ? 2 : 1;
    const evidence = error instanceof LiveSmokeCommandError ? error.evidence : undefined;
    const partialOutput = error instanceof LiveSmokeCommandError
      ? formatPartialProcessOutput(error.execution)
      : "";
    process.stderr.write([
      error.message,
      ...(evidence ? [formatEvidence(evidence)] : []),
      ...(partialOutput ? [partialOutput] : []),
      "",
    ].join("\n"));
    process.exitCode = exitCode;
  });
}
