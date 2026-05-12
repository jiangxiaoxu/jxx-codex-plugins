import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { platform } from "node:os";
import { basename, delimiter, join } from "node:path";

const DEFAULT_READ_TIMEOUT_MS = 60000;
const DEFAULT_RAW_TIMEOUT_MS = 120000;
const DEFAULT_MAX_BYTES = 10 * 1024 * 1024;
const DEFAULT_QUEUE_HIGH_WATER = 200;
const DEFAULT_QUEUE_LOW_WATER = 50;
const DEFAULT_CANCEL_GRACE_MS = 500;
const DEFAULT_CANCEL_FORCE_MS = 500;
const STRUCTURED_FORBIDDEN_LONG = new Set([
  "--json",
  "--vimgrep",
  "--files",
  "--count",
  "--count-matches",
  "--files-with-matches",
  "--files-without-match",
  "--replace",
  "--only-matching"
]);
const STRUCTURED_FORBIDDEN_SHORT = new Set(["-l", "-L", "-c", "-o"]);

/**
 * Creates a ripgrep runtime for Node REPL usage.
 *
 * @param {{ globals?: object, rgPath?: string, defaultCwd?: string, readTimeoutMs?: number }} [options] Runtime options.
 * @returns {{ rg: RgRuntime }} Runtime API.
 */
export function setupRgRuntime(options = {}) {
  const runtime = new RgRuntime(options);
  if (options.globals) {
    options.globals.rg = runtime;
  }
  return { rg: runtime };
}

class RgRuntime {
  constructor(options) {
    this.rgCommand = resolveRgCommand(options.rgPath);
    this.defaultCwd = options.defaultCwd;
    this.readTimeoutMs = normalizeOptionalPositiveInteger(
      options.readTimeoutMs,
      "readTimeoutMs",
      DEFAULT_READ_TIMEOUT_MS
    );
    this.nextSessionId = 1;
    this.activeSessions = new Map();
  }

  search(pattern) {
    return new SearchBuilder(this, { pattern });
  }

  createSearch(options) {
    return new SearchBuilder(this, options).start();
  }

  files() {
    return new FilesBuilder(this, {});
  }

  createFiles(options = {}) {
    return new FilesBuilder(this, options).start();
  }

  async raw(args, options = {}) {
    const rgArgs = normalizeTokenArray(args, "args");
    const cwd = options.cwd ?? this.defaultCwd;
    const timeoutMs = normalizeOptionalPositiveInteger(options.timeoutMs, "timeoutMs", DEFAULT_RAW_TIMEOUT_MS);
    const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
    const command = this.rgCommand;
    return await runRaw(command, rgArgs, { cwd, timeoutMs, maxBytes });
  }

  sessions() {
    return Array.from(this.activeSessions.values()).map((session) => session.summary());
  }

  async cancelAll() {
    const sessions = Array.from(this.activeSessions.values());
    const results = await Promise.allSettled(sessions.map((session) => session.cancel()));
    return {
      cancelled: results.filter((result) => result.status === "fulfilled").length,
      failed: results.filter((result) => result.status === "rejected").length,
      sessions: results.map((result, index) => {
        const session = sessions[index];
        if (result.status === "fulfilled") {
          return { id: session.id, kind: session.kind, result: result.value };
        }
        return { id: session.id, kind: session.kind, error: String(result.reason?.message ?? result.reason) };
      })
    };
  }

  registerSession(session) {
    const id = `rg-${this.nextSessionId}`;
    this.nextSessionId += 1;
    this.activeSessions.set(id, session);
    return id;
  }

  unregisterSession(id) {
    this.activeSessions.delete(id);
  }
}

class BaseBuilder {
  constructor(runtime, options) {
    this.runtime = runtime;
    this.options = { ...options };
    this.readTimeoutMs = normalizeOptionalPositiveInteger(
      options.readTimeoutMs,
      "readTimeoutMs",
      runtime.readTimeoutMs
    );
    this.extraArgs = [];
  }

  cwd(path) {
    this.options.cwd = path;
    return this;
  }

  glob(pattern) {
    this.extraArgs.push("--glob", pattern);
    return this;
  }

  globs(patterns) {
    for (const pattern of normalizeTokenArray(patterns, "patterns")) {
      this.glob(pattern);
    }
    return this;
  }

  type(name) {
    this.extraArgs.push("--type", name);
    return this;
  }

  hidden() {
    this.extraArgs.push("--hidden");
    return this;
  }

  noIgnore() {
    this.extraArgs.push("--no-ignore");
    return this;
  }

  follow() {
    this.extraArgs.push("--follow");
    return this;
  }

  readTimeout(ms) {
    this.readTimeoutMs = normalizePositiveInteger(ms, "readTimeoutMs");
    return this;
  }

  arg(tokenOrTokens) {
    this.extraArgs.push(...normalizeTokenArray(tokenOrTokens, "tokenOrTokens"));
    return this;
  }

  args(tokens) {
    this.extraArgs.push(...normalizeTokenArray(tokens, "tokens"));
    return this;
  }

  buildCommonArgs() {
    validateStructuredArgs(this.extraArgs);
    return [...this.extraArgs];
  }

  buildSessionOptions() {
    return { readTimeoutMs: this.readTimeoutMs };
  }
}

class SearchBuilder extends BaseBuilder {
  constructor(runtime, options) {
    super(runtime, options);
    if (this.options.pattern === undefined) {
      throw new Error("rg.search requires a pattern.");
    }
    this.paths = [];
    this.applyObjectOptions(options);
  }

  applyObjectOptions(options) {
    if (options.path !== undefined) {
      this.path(options.path);
    }
    if (options.paths !== undefined) {
      for (const path of normalizeTokenArray(options.paths, "paths")) {
        this.path(path);
      }
    }
    applySharedObjectOptions(this, options);
    applyTokenOption(this.extraArgs, "--type-not", options.typeNot);
    applyBoolean(this.extraArgs, "-F", options.fixedStrings);
    applyBoolean(this.extraArgs, "--word-regexp", options.word);
    applyBoolean(this.extraArgs, "--ignore-case", options.ignoreCase);
    applyBoolean(this.extraArgs, "--case-sensitive", options.caseSensitive);
    applyBoolean(this.extraArgs, "--smart-case", options.smartCase);
    applyBoolean(this.extraArgs, "--multiline", options.multiline);
    applyNumberOption(this.extraArgs, "--context", options.context);
    applyNumberOption(this.extraArgs, "--before-context", options.beforeContext);
    applyNumberOption(this.extraArgs, "--after-context", options.afterContext);
    applyNumberOption(this.extraArgs, "--max-columns", options.maxColumns);
    applyTokenOption(this.extraArgs, "--encoding", options.encoding);
  }

  path(path) {
    this.paths.push(path);
    return this;
  }

  typeNot(name) {
    this.extraArgs.push("--type-not", name);
    return this;
  }

  fixedStrings() {
    this.extraArgs.push("-F");
    return this;
  }

  word() {
    this.extraArgs.push("--word-regexp");
    return this;
  }

  ignoreCase() {
    this.extraArgs.push("--ignore-case");
    return this;
  }

  caseSensitive() {
    this.extraArgs.push("--case-sensitive");
    return this;
  }

  smartCase() {
    this.extraArgs.push("--smart-case");
    return this;
  }

  multiline() {
    this.extraArgs.push("--multiline");
    return this;
  }

  context(n) {
    this.extraArgs.push("--context", String(n));
    return this;
  }

  beforeContext(n) {
    this.extraArgs.push("--before-context", String(n));
    return this;
  }

  afterContext(n) {
    this.extraArgs.push("--after-context", String(n));
    return this;
  }

  maxColumns(n) {
    this.extraArgs.push("--max-columns", String(n));
    return this;
  }

  encoding(name) {
    this.extraArgs.push("--encoding", name);
    return this;
  }

  start() {
    const args = ["--json", ...this.buildCommonArgs(), this.options.pattern, ...this.paths];
    return new SearchSession(this.runtime, args, this.options.cwd, this.buildSessionOptions());
  }
}

class FilesBuilder extends BaseBuilder {
  constructor(runtime, options) {
    super(runtime, options);
    this.applyObjectOptions(options);
  }

  applyObjectOptions(options) {
    applySharedObjectOptions(this, options);
  }

  start() {
    const args = ["--files", ...this.buildCommonArgs()];
    return new FileSession(this.runtime, args, this.options.cwd, this.buildSessionOptions());
  }
}

class BaseSession {
  constructor(runtime, args, cwd, kind, options = {}) {
    this.runtime = runtime;
    this.args = args;
    this.cwd = cwd ?? runtime.defaultCwd;
    this.kind = kind;
    this.readTimeoutMs = options.readTimeoutMs ?? runtime.readTimeoutMs;
    this.command = runtime.rgCommand;
    this.queue = [];
    this.waiters = [];
    this.doneWaiters = [];
    this.done = false;
    this.cancelled = false;
    this.forceFinished = false;
    this.error = undefined;
    this.exitCode = undefined;
    this.signal = undefined;
    this.stderr = "";
    this.stdoutBuffer = "";
    this.stderrBytes = 0;
    this.stdoutPaused = false;
    this.stats = {
      matches: 0,
      events: 0,
      files: 0,
      bytes: 0,
      startedAt: Date.now(),
      endedAt: undefined,
      exitCode: undefined,
      signal: undefined
    };
    this.child = spawnRg(this.command, this.args, this.cwd);
    this.id = this.runtime.registerSession(this);
    this.attach();
  }

  attach() {
    this.child.stdout.setEncoding("utf8");
    this.child.stderr.setEncoding("utf8");
    this.child.stdout.on("data", (chunk) => this.handleStdout(chunk));
    this.child.stderr.on("data", (chunk) => {
      this.stderrBytes += Buffer.byteLength(chunk);
      if (this.stderrBytes <= DEFAULT_MAX_BYTES) {
        this.stderr += chunk;
      }
    });
    this.child.on("error", (error) => {
      this.error = normalizeSpawnError(error, this.command);
      this.finish(undefined, undefined);
    });
    this.child.on("close", (exitCode, signal) => {
      this.flushStdout();
      this.finish(exitCode, signal);
    });
  }

  handleStdout(chunk) {
    this.stats.bytes += Buffer.byteLength(chunk);
    this.stdoutBuffer += chunk;
    this.drainStdoutBuffer(false);
  }

  drainStdoutBuffer(ignoreBackpressure) {
    let newlineIndex = this.stdoutBuffer.indexOf("\n");
    while (newlineIndex !== -1) {
      const line = this.stdoutBuffer.slice(0, newlineIndex).replace(/\r$/, "");
      this.stdoutBuffer = this.stdoutBuffer.slice(newlineIndex + 1);
      this.handleLine(line);
      if (!ignoreBackpressure && this.queue.length >= DEFAULT_QUEUE_HIGH_WATER && !this.done) {
        this.stdoutPaused = true;
        this.child.stdout.pause();
        break;
      }
      newlineIndex = this.stdoutBuffer.indexOf("\n");
    }
  }

  flushStdout() {
    this.drainStdoutBuffer(true);
    if (this.stdoutBuffer.length > 0) {
      this.handleLine(this.stdoutBuffer.replace(/\r$/, ""));
      this.stdoutBuffer = "";
    }
  }

  enqueue(item) {
    this.queue.push(item);
    this.resolveWaiters();
  }

  finish(exitCode, signal) {
    if (this.done) {
      return;
    }
    this.done = true;
    this.exitCode = exitCode;
    this.signal = signal;
    this.stats.endedAt = Date.now();
    this.stats.exitCode = exitCode;
    this.stats.signal = signal;
    this.runtime.unregisterSession(this.id);
    this.resolveWaiters();
    this.resolveDoneWaiters();
  }

  resolveWaiters() {
    const waiters = this.waiters.splice(0);
    for (const waiter of waiters) {
      waiter();
    }
  }

  resolveDoneWaiters() {
    const waiters = this.doneWaiters.splice(0);
    for (const waiter of waiters) {
      waiter();
    }
  }

  kill(signal) {
    if (this.child && !this.done) {
      return this.child.kill(signal);
    }
    return false;
  }

  resumeForShutdown() {
    if (this.stdoutPaused) {
      this.stdoutPaused = false;
      this.child.stdout.resume();
    }
    this.child.stderr.resume();
  }

  resumeStdoutIfNeeded() {
    if (this.stdoutPaused && this.queue.length <= DEFAULT_QUEUE_LOW_WATER && !this.done) {
      this.stdoutPaused = false;
      this.child.stdout.resume();
      this.drainStdoutBuffer(false);
    }
  }

  async waitForData(timeoutMs) {
    if (this.queue.length > 0 || this.done || this.error) {
      return true;
    }
    return await new Promise((resolve) => {
      let timer;
      const waiter = () => {
        clearTimeout(timer);
        resolve(true);
      };
      timer = setTimeout(() => {
        const index = this.waiters.indexOf(waiter);
        if (index !== -1) {
          this.waiters.splice(index, 1);
        }
        resolve(false);
      }, timeoutMs);
      this.waiters.push(waiter);
    });
  }

  async cancel(options = {}) {
    if (!this.done) {
      this.cancelled = true;
      this.resumeForShutdown();
      this.kill("SIGTERM");
      const closed = await waitUntilDoneOrTimeout(this, options.graceMs ?? DEFAULT_CANCEL_GRACE_MS);
      if (!closed && !this.done) {
        this.kill("SIGKILL");
        const forceClosed = await waitUntilDoneOrTimeout(this, options.forceMs ?? DEFAULT_CANCEL_FORCE_MS);
        if (!forceClosed && !this.done) {
          this.forceFinished = true;
          this.finish(undefined, "force-cancel-timeout");
        }
      }
    }
    return { cancelled: this.cancelled, forceFinished: this.forceFinished, stats: snapshotStats(this.stats) };
  }

  async *batches(input) {
    while (true) {
      const batch = await this.next(input);
      yield batch;
      if (batch.done) {
        break;
      }
    }
  }

  summary() {
    return {
      id: this.id,
      kind: this.kind,
      args: [...this.args],
      cwd: this.cwd,
      done: this.done,
      cancelled: this.cancelled,
      forceFinished: this.forceFinished,
      readTimeoutMs: this.readTimeoutMs,
      queueLength: this.queue.length,
      stdoutPaused: this.stdoutPaused,
      stats: snapshotStats(this.stats)
    };
  }
}

class SearchSession extends BaseSession {
  constructor(runtime, args, cwd, options) {
    super(runtime, args, cwd, "search", options);
  }

  handleLine(line) {
    if (line.length === 0) {
      return;
    }
    let event;
    try {
      event = JSON.parse(line);
    } catch (cause) {
      this.error = new Error(`Failed to parse rg JSON output: ${cause.message}`);
      this.kill("SIGTERM");
      return;
    }
    this.stats.events += 1;
    if (event.type === "begin") {
      this.stats.files += 1;
    }
    if (event.type === "match") {
      this.stats.matches += 1;
      this.enqueue(event);
    } else if (event.type === "context") {
      this.enqueue(event);
    }
  }

  async next(input) {
    const { limit: maxResults, timeoutMs } = normalizeNextOptions(input, "maxResults", this.readTimeoutMs);
    const deadline = Date.now() + timeoutMs;
    const matches = [];
    let matchCount = 0;
    let readTimedOut = false;
    while (matchCount < maxResults) {
      const remainingMs = deadline - Date.now();
      if (remainingMs <= 0) {
        readTimedOut = true;
        break;
      }
      const hasData = await this.waitForData(remainingMs);
      if (!hasData) {
        readTimedOut = true;
        break;
      }
      if (this.error) {
        throw this.error;
      }
      if (this.queue.length === 0) {
        break;
      }
      const event = this.queue.shift();
      matches.push(event);
      this.resumeStdoutIfNeeded();
      if (event.type === "match") {
        matchCount += 1;
      }
    }
    const truncated = matchCount >= maxResults && !this.done;
    return {
      matches,
      stats: snapshotStats(this.stats),
      done: this.done && this.queue.length === 0,
      truncated,
      readTimedOut,
      stopReason: stopReason(this, truncated, readTimedOut)
    };
  }
}

class FileSession extends BaseSession {
  constructor(runtime, args, cwd, options) {
    super(runtime, args, cwd, "files", options);
  }

  handleLine(line) {
    if (line.length === 0) {
      return;
    }
    this.stats.files += 1;
    this.enqueue(line);
  }

  async next(input) {
    const { limit: maxFiles, timeoutMs } = normalizeNextOptions(input, "maxFiles", this.readTimeoutMs);
    const deadline = Date.now() + timeoutMs;
    const files = [];
    let readTimedOut = false;
    while (files.length < maxFiles) {
      const remainingMs = deadline - Date.now();
      if (remainingMs <= 0) {
        readTimedOut = true;
        break;
      }
      const hasData = await this.waitForData(remainingMs);
      if (!hasData) {
        readTimedOut = true;
        break;
      }
      if (this.error) {
        throw this.error;
      }
      if (this.queue.length === 0) {
        break;
      }
      files.push(this.queue.shift());
      this.resumeStdoutIfNeeded();
    }
    const truncated = files.length >= maxFiles && !this.done;
    return {
      files,
      stats: snapshotStats(this.stats),
      done: this.done && this.queue.length === 0,
      truncated,
      readTimedOut,
      stopReason: stopReason(this, truncated, readTimedOut)
    };
  }
}

function applySharedObjectOptions(builder, options) {
  applyTokenOption(builder.extraArgs, "--glob", options.glob);
  if (options.globs !== undefined) {
    for (const pattern of normalizeTokenArray(options.globs, "globs")) {
      builder.extraArgs.push("--glob", pattern);
    }
  }
  applyTokenOption(builder.extraArgs, "--type", options.type);
  applyBoolean(builder.extraArgs, "--hidden", options.hidden);
  applyBoolean(builder.extraArgs, "--no-ignore", options.noIgnore);
  applyBoolean(builder.extraArgs, "--follow", options.follow);
  if (options.args !== undefined) {
    builder.extraArgs.push(...normalizeTokenArray(options.args, "args"));
  }
}

function applyBoolean(args, flag, value) {
  if (value === true) {
    args.push(flag);
  }
}

function applyNumberOption(args, flag, value) {
  if (value !== undefined) {
    args.push(flag, String(value));
  }
}

function applyTokenOption(args, flag, value) {
  if (value !== undefined) {
    args.push(flag, value);
  }
}

function normalizeTokenArray(value, name) {
  if (Array.isArray(value)) {
    return value.map((item) => assertToken(item, name));
  }
  return [assertToken(value, name)];
}

function assertToken(value, name) {
  if (typeof value !== "string" || value.length === 0) {
    throw new TypeError(`${name} must contain non-empty string tokens.`);
  }
  return value;
}

function normalizeLimit(input, name) {
  const value = typeof input === "object" && input !== null ? input[name] : input;
  const limit = value ?? 100;
  return normalizePositiveInteger(limit, name);
}

function normalizeNextOptions(input, limitName, defaultReadTimeoutMs) {
  const timeoutValue = typeof input === "object" && input !== null ? input.timeoutMs : undefined;
  return {
    limit: normalizeLimit(input, limitName),
    timeoutMs: normalizeOptionalPositiveInteger(timeoutValue, "timeoutMs", defaultReadTimeoutMs)
  };
}

function normalizeOptionalPositiveInteger(value, name, fallback) {
  if (value === undefined) {
    return fallback;
  }
  return normalizePositiveInteger(value, name);
}

function normalizePositiveInteger(value, name) {
  const limit = value;
  if (!Number.isInteger(limit) || limit <= 0) {
    throw new TypeError(`${name} must be a positive integer.`);
  }
  return limit;
}

function validateStructuredArgs(args) {
  for (let index = 0; index < args.length; index += 1) {
    const token = args[index];
    const longName = token.includes("=") ? token.slice(0, token.indexOf("=")) : token;
    if (STRUCTURED_FORBIDDEN_LONG.has(longName) || STRUCTURED_FORBIDDEN_SHORT.has(token)) {
      throw new Error(`rg structured mode forbids extra arg: ${token}`);
    }
  }
}

function resolveRgCommand(rgPath) {
  const isWindows = platform() === "win32";
  if (rgPath) {
    if (isWindows && basename(rgPath).toLowerCase() !== "rg.exe") {
      throw new Error(`Configured rgPath must point to rg.exe on Windows: ${rgPath}`);
    }
    if (!existsSync(rgPath)) {
      throw new Error(`Configured rgPath does not exist: ${rgPath}`);
    }
    return rgPath;
  }
  const pathValue = globalThis.process?.env?.PATH ?? globalThis.process?.env?.Path;
  const names = isWindows ? ["rg.exe"] : ["rg"];
  if (pathValue) {
    for (const directory of pathValue.split(delimiter)) {
      for (const name of names) {
        const candidate = join(directory, name);
        if (existsSync(candidate)) {
          return candidate;
        }
      }
    }
  }
  return isWindows ? "rg.exe" : "rg";
}

function spawnRg(command, args, cwd) {
  try {
    return spawn(command, args, {
      cwd,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"]
    });
  } catch (error) {
    throw normalizeSpawnError(error, command);
  }
}

function normalizeSpawnError(error, command) {
  if (error?.code === "ENOENT") {
    return new Error(`Unable to find rg executable: ${command}. Install ripgrep or pass rgPath to setupRgRuntime().`);
  }
  return error;
}

async function runRaw(command, args, options) {
  const child = spawnRg(command, args, options.cwd);
  let stdout = "";
  let stderr = "";
  let stdoutBytes = 0;
  let stderrBytes = 0;
  let truncated = false;
  let timedOut = false;
  let forceFinished = false;
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    const size = Buffer.byteLength(chunk);
    stdoutBytes += size;
    if (stdoutBytes <= options.maxBytes) {
      stdout += chunk;
    } else {
      truncated = true;
    }
  });
  child.stderr.on("data", (chunk) => {
    const size = Buffer.byteLength(chunk);
    stderrBytes += size;
    if (stderrBytes <= options.maxBytes) {
      stderr += chunk;
    } else {
      truncated = true;
    }
  });
  return await new Promise((resolve, reject) => {
    let settled = false;
    let timeout;
    let forceTimer;
    let finishTimer;
    const clearTimers = () => {
      clearTimeout(timeout);
      clearTimeout(forceTimer);
      clearTimeout(finishTimer);
    };
    const finish = (exitCode, signal) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimers();
      resolve({
        args,
        cwd: options.cwd,
        exitCode,
        signal,
        stdout,
        stderr,
        timedOut,
        truncated,
        forceFinished
      });
    };
    timeout = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      forceTimer = setTimeout(() => {
        child.kill("SIGKILL");
      }, DEFAULT_CANCEL_GRACE_MS);
      finishTimer = setTimeout(() => {
        forceFinished = true;
        finish(undefined, "force-timeout");
      }, DEFAULT_CANCEL_GRACE_MS + DEFAULT_CANCEL_FORCE_MS);
    }, options.timeoutMs);
    child.on("error", (error) => {
      if (settled) {
        return;
      }
      clearTimers();
      reject(normalizeSpawnError(error, command));
    });
    child.on("close", (exitCode, signal) => {
      finish(exitCode, signal);
    });
  });
}

function waitUntilDone(session) {
  if (session.done) {
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    session.doneWaiters.push(resolve);
  });
}

async function waitUntilDoneOrTimeout(session, timeoutMs) {
  if (session.done) {
    return true;
  }
  let timeout;
  const done = waitUntilDone(session).then(() => true);
  const timedOut = new Promise((resolve) => {
    timeout = setTimeout(() => resolve(false), timeoutMs);
  });
  const result = await Promise.race([done, timedOut]);
  clearTimeout(timeout);
  return result;
}

function snapshotStats(stats) {
  return { ...stats };
}

function stopReason(session, truncated, readTimedOut) {
  if (truncated) {
    return "maxResults";
  }
  if (readTimedOut) {
    return "readTimeout";
  }
  if (session.cancelled) {
    return "cancelled";
  }
  if (session.done) {
    return "done";
  }
  return undefined;
}
