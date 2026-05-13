import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { platform } from "node:os";
import { basename, delimiter, join } from "node:path";

const DEFAULT_READ_TIMEOUT_MS = 60000;
const DEFAULT_RAW_TIMEOUT_MS = 120000;
const DEFAULT_RAW_MAX_BYTES = 16 * 1024;
const DEFAULT_SEARCH_TEXT_MAX_BYTES = 12 * 1024;
const DEFAULT_DRAIN_TEXT_MAX_BYTES = 16 * 1024;
const DEFAULT_MAX_STDERR_BYTES = 1024;
const DEFAULT_STDERR_PREVIEW_LINES = 10;
const DEFAULT_QUEUE_HIGH_WATER = 200;
const DEFAULT_QUEUE_LOW_WATER = 50;
const DEFAULT_CANCEL_GRACE_MS = 50;
const DEFAULT_CANCEL_FORCE_MS = 50;
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

export class RgProcessError extends Error {
  /**
   * Creates an rg process failure error.
   *
   * @param {{ kind: string, args: string[], cwd?: string, exitCode?: number, signal?: string, stderr: string, stderrBytes: number, stderrTruncated: boolean }} details Process details.
   * @returns {RgProcessError} Process error instance.
   */
  constructor(details) {
    super(`rg ${details.kind} failed with exit code ${details.exitCode ?? "unknown"}.`);
    this.name = "RgProcessError";
    this.kind = details.kind;
    this.args = [...details.args];
    this.cwd = details.cwd;
    this.exitCode = details.exitCode;
    this.signal = details.signal;
    this.stderrPreview = formatStderrPreview(details.stderr);
    this.stderrBytes = details.stderrBytes;
    this.stderrTruncated = details.stderrTruncated;
    Object.defineProperty(this, "stderr", {
      value: details.stderr,
      enumerable: false
    });
  }
}

/**
 * Creates a ripgrep runtime for Node REPL usage.
 *
 * @param {{ globals?: object, rgPath?: string, defaultCwd?: string, readTimeoutMs?: number, write?: (text: string) => void }} [options] Runtime options.
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
    this.write = resolveWrite(options);
    this.nextSessionId = 1;
    this.activeSessions = new Map();
  }

  search(pattern) {
    return new SearchBuilder(this, { pattern });
  }

  files() {
    return new FilesBuilder(this, {});
  }

  raw(args, options = {}) {
    const rgArgs = normalizeTokenArray(args, "args");
    const cwd = options.cwd ?? this.defaultCwd;
    const timeoutMs = normalizeOptionalPositiveInteger(options.timeoutMs, "timeoutMs", DEFAULT_RAW_TIMEOUT_MS);
    const maxBytes = normalizeOptionalPositiveInteger(options.maxBytes, "maxBytes", DEFAULT_RAW_MAX_BYTES);
    const command = this.rgCommand;
    return runRaw(command, rgArgs, { cwd, timeoutMs, maxBytes });
  }

  async show(value) {
    if (arguments.length !== 1) {
      throw new TypeError("rg.show(value) expects exactly one argument.");
    }
    assertRuntimeWrite(this);
    const resolved = await value;
    writeRuntimeOutput(this, formatShowValue(resolved));
    return resolved;
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

  buildCommonArgs() {
    validateStructuredArgs(this.extraArgs);
    return [...this.extraArgs];
  }

  buildSessionOptions() {
    return {};
  }
}

class SearchBuilder extends BaseBuilder {
  constructor(runtime, options) {
    super(runtime, options);
    if (this.options.pattern === undefined) {
      throw new Error("rg.search requires a pattern.");
    }
    this.paths = [];
  }

  path(path) {
    this.paths.push(path);
    return this;
  }

  fixedStrings() {
    this.extraArgs.push("-F");
    return this;
  }

  ignoreCase() {
    this.extraArgs.push("--ignore-case");
    return this;
  }

  smartCase() {
    this.extraArgs.push("--smart-case");
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

  start() {
    const args = ["--json", ...this.buildCommonArgs(), this.options.pattern, ...this.paths];
    return new SearchSession(this.runtime, args, this.options.cwd, this.buildSessionOptions());
  }

  async next(count) {
    return await readOneShotBatch(this.start(), count);
  }

  async drain() {
    assertNoArguments(arguments, "SearchBuilder.drain()");
    return await readOneShotDrain(this.start());
  }

  async show() {
    assertNoArguments(arguments, "SearchBuilder.show()");
    assertRuntimeWrite(this.runtime);
    return await showOneShotDrain(this.start());
  }
}

class FilesBuilder extends BaseBuilder {
  start() {
    const args = ["--files", ...this.buildCommonArgs()];
    return new FileSession(this.runtime, args, this.options.cwd, this.buildSessionOptions());
  }

  async next(count) {
    return await readOneShotBatch(this.start(), count);
  }

  async drain() {
    assertNoArguments(arguments, "FilesBuilder.drain()");
    return await readOneShotDrain(this.start());
  }

  async show() {
    assertNoArguments(arguments, "FilesBuilder.show()");
    assertRuntimeWrite(this.runtime);
    return await showOneShotDrain(this.start());
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
      stderrBytes: 0,
      stderrTruncated: false,
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
      const size = Buffer.byteLength(chunk);
      this.stderrBytes += size;
      this.stats.stderrBytes = this.stderrBytes;
      this.stderr = keepTailUtf8(this.stderr + chunk, DEFAULT_MAX_STDERR_BYTES);
      if (this.stderrBytes > DEFAULT_MAX_STDERR_BYTES) {
        this.stats.stderrTruncated = true;
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
    if (exitCode > 1 && !this.error && !this.cancelled) {
      this.error = new RgProcessError({
        kind: this.kind,
        args: this.args,
        cwd: this.cwd,
        exitCode,
        signal,
        stderr: this.stderr,
        stderrBytes: this.stderrBytes,
        stderrTruncated: this.stats.stderrTruncated
      });
    }
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

  async cancel() {
    if (arguments.length > 0) {
      throw new TypeError("cancel() does not accept arguments.");
    }
    if (!this.done) {
      this.cancelled = true;
      this.resumeForShutdown();
      this.kill("SIGTERM");
      const closed = await waitUntilDoneOrTimeout(this, DEFAULT_CANCEL_GRACE_MS);
      if (!closed && !this.done) {
        this.kill("SIGKILL");
        const forceClosed = await waitUntilDoneOrTimeout(this, DEFAULT_CANCEL_FORCE_MS);
        if (!forceClosed && !this.done) {
          this.forceFinished = true;
          this.finish(undefined, "force-cancel-timeout");
        }
      }
    }
    return { cancelled: this.cancelled, forceFinished: this.forceFinished, stats: snapshotStats(this.stats) };
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
      stderrPreview: formatStderrPreview(this.stderr),
      stderrBytes: this.stderrBytes,
      stderrTruncated: this.stats.stderrTruncated,
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

  async next(count) {
    const batch = await this.readStructuredBatch(count, "SearchSession.next()", {
      maxTextBytes: DEFAULT_SEARCH_TEXT_MAX_BYTES
    });
    return {
      text: formatSearchText(batch.files),
      info: batch.stopReason
    };
  }

  async drain() {
    assertNoArguments(arguments, "SearchSession.drain()");
    const batch = await this.readStructuredBatch(Number.MAX_SAFE_INTEGER, "SearchSession.drain()", {
      maxTextBytes: DEFAULT_DRAIN_TEXT_MAX_BYTES
    });
    return {
      text: formatSearchText(batch.files),
      info: batch.stopReason
    };
  }

  async show() {
    assertNoArguments(arguments, "SearchSession.show()");
    assertRuntimeWrite(this.runtime);
    const batch = await this.drain();
    writeRuntimeOutput(this.runtime, formatShowValue(batch));
    return batch;
  }

  async readStructuredBatch(count, methodName, outputLimits = {}) {
    const maxBlocks = normalizeNextCount(count, methodName);
    const deadline = Date.now() + this.readTimeoutMs;
    const files = [];
    const filesByPath = new Map();
    let blockCount = 0;
    let readTimedOut = false;
    let maxBlocksHit = false;
    let maxTextBytesHit = false;
    let currentPath;
    let currentBlock;
    while (true) {
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
      const line = eventToSearchLine(event);
      const startsNewBlock =
        !currentBlock || currentPath !== line.path || line.lineNumber > currentBlock.endLine + 1;
      if (startsNewBlock && blockCount >= maxBlocks) {
        this.queue.unshift(event);
        maxBlocksHit = true;
        break;
      }
      const limitReason = searchOutputLimitReason(files, line, startsNewBlock, outputLimits);
      if (limitReason) {
        if (hasSearchLines(files)) {
          this.queue.unshift(event);
          if (limitReason === "maxTextBytes") {
            maxTextBytesHit = true;
          }
          break;
        }
        const truncatedLine = truncateSearchLineForOutputLimit(
          files,
          line,
          startsNewBlock,
          outputLimits,
          limitReason
        );
        if (truncatedLine) {
          line.text = truncatedLine.text;
          if (limitReason === "maxTextBytes") {
            maxTextBytesHit = true;
          }
        } else {
          this.queue.unshift(event);
          if (limitReason === "maxTextBytes") {
            maxTextBytesHit = true;
          }
          break;
        }
      }
      if (startsNewBlock) {
        currentPath = line.path;
        currentBlock = { startLine: line.lineNumber, endLine: line.lineNumber, lines: [], matches: [] };
        let file = filesByPath.get(line.path);
        if (!file) {
          file = { path: line.path, blocks: [] };
          filesByPath.set(line.path, file);
          files.push(file);
        }
        file.blocks.push(currentBlock);
        blockCount += 1;
      }
      appendSearchLine(currentBlock, line);
      if (maxTextBytesHit) {
        break;
      }
      this.resumeStdoutIfNeeded();
    }
    if (this.error && this.done && this.queue.length === 0) {
      throw this.error;
    }
    return {
      files,
      blockCount,
      stats: snapshotStats(this.stats),
      done: this.done && this.queue.length === 0,
      truncated: maxBlocksHit || maxTextBytesHit,
      readTimedOut,
      stopReason: stopReason(this, { maxBlocksHit, maxTextBytesHit, readTimedOut })
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

  async next(count) {
    const maxFiles = normalizeNextCount(count, "FileSession.next()");
    return await this.readFileBatch({ maxFiles });
  }

  async drain() {
    assertNoArguments(arguments, "FileSession.drain()");
    return await this.readFileBatch({ maxFilesBytes: DEFAULT_DRAIN_TEXT_MAX_BYTES });
  }

  async show() {
    assertNoArguments(arguments, "FileSession.show()");
    assertRuntimeWrite(this.runtime);
    const batch = await this.drain();
    writeRuntimeOutput(this.runtime, formatShowValue(batch));
    return batch;
  }

  async readFileBatch(limits) {
    const deadline = Date.now() + this.readTimeoutMs;
    const files = [];
    let readTimedOut = false;
    let maxFilesHit = false;
    let maxFilesBytesHit = false;
    while (true) {
      if (limits.maxFiles !== undefined && files.length >= limits.maxFiles) {
        maxFilesHit = !this.done || this.queue.length > 0;
        break;
      }
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
      const nextFile = this.queue.shift();
      if (
        limits.maxFilesBytes !== undefined &&
        utf8ByteLength(JSON.stringify([...files, nextFile])) > limits.maxFilesBytes
      ) {
        this.queue.unshift(nextFile);
        maxFilesBytesHit = true;
        break;
      }
      files.push(nextFile);
      this.resumeStdoutIfNeeded();
    }
    if (this.error && this.done && this.queue.length === 0) {
      throw this.error;
    }
    return {
      files,
      stats: snapshotStats(this.stats),
      done: this.done && this.queue.length === 0,
      truncated: maxFilesHit || maxFilesBytesHit,
      readTimedOut,
      stopReason: stopReason(this, { maxFilesHit, maxFilesBytesHit, readTimedOut })
    };
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

function normalizeNextCount(count, methodName) {
  if (typeof count === "object" && count !== null) {
    throw new TypeError(`${methodName} only accepts a positive integer count.`);
  }
  try {
    return normalizePositiveInteger(count, "count");
  } catch (cause) {
    throw new TypeError(`${methodName} only accepts a positive integer count.`, { cause });
  }
}

function assertNoArguments(args, methodName) {
  if (args.length > 0) {
    throw new TypeError(`${methodName} does not accept arguments.`);
  }
}

function eventToSearchLine(event) {
  const data = event.data ?? {};
  const submatches = event.type === "match" ? compactSubmatches(data.submatches ?? []) : undefined;
  return {
    path: data.path?.text ?? "",
    lineNumber: data.line_number,
    type: event.type,
    text: removeTrailingLineBreaks(data.lines?.text ?? ""),
    submatches
  };
}

function appendSearchLine(block, line) {
  block.startLine = Math.min(block.startLine, line.lineNumber);
  block.endLine = Math.max(block.endLine, line.lineNumber);
  const existingLine = block.lines.find((item) => item.lineNumber === line.lineNumber);
  if (existingLine) {
    existingLine.type = existingLine.type === "match" ? existingLine.type : line.type;
    existingLine.text = line.text;
  } else {
    block.lines.push({ lineNumber: line.lineNumber, type: line.type, text: line.text });
  }
  if (line.type === "match") {
    block.matches.push({ lineNumber: line.lineNumber, submatches: line.submatches });
  }
}

function searchOutputLimitReason(files, line, startsNewBlock, outputLimits) {
  const candidateFiles = cloneSearchFiles(files);
  appendSearchLineToFiles(candidateFiles, { ...line }, startsNewBlock);
  if (
    outputLimits.maxTextBytes !== undefined &&
    utf8ByteLength(formatSearchText(candidateFiles)) > outputLimits.maxTextBytes
  ) {
    return "maxTextBytes";
  }
  return undefined;
}

function truncateSearchLineForOutputLimit(files, line, startsNewBlock, outputLimits, limitReason) {
  const characters = Array.from(line.text);
  let low = 0;
  let high = characters.length;
  let bestText = "";
  while (low <= high) {
    const mid = Math.floor((low + high) / 2);
    const candidateLine = { ...line, text: characters.slice(0, mid).join("") };
    const candidateFiles = cloneSearchFiles(files);
    appendSearchLineToFiles(candidateFiles, candidateLine, startsNewBlock);
    const fits = utf8ByteLength(formatSearchText(candidateFiles)) <= outputLimits.maxTextBytes;
    if (fits) {
      bestText = candidateLine.text;
      low = mid + 1;
    } else {
      high = mid - 1;
    }
  }
  const candidateLine = { ...line, text: bestText };
  const candidateFiles = cloneSearchFiles(files);
  appendSearchLineToFiles(candidateFiles, candidateLine, startsNewBlock);
  const fits = utf8ByteLength(formatSearchText(candidateFiles)) <= outputLimits.maxTextBytes;
  return fits ? candidateLine : undefined;
}

function appendSearchLineToFiles(files, line, startsNewBlock) {
  let file = files.find((item) => item.path === line.path);
  if (!file) {
    file = { path: line.path, blocks: [] };
    files.push(file);
  }
  let block = startsNewBlock ? undefined : file.blocks[file.blocks.length - 1];
  if (!block) {
    block = { startLine: line.lineNumber, endLine: line.lineNumber, lines: [], matches: [] };
    file.blocks.push(block);
  }
  appendSearchLine(block, line);
}

function cloneSearchFiles(files) {
  return files.map((file) => ({
    path: file.path,
    blocks: file.blocks.map((block) => ({
      startLine: block.startLine,
      endLine: block.endLine,
      lines: block.lines.map((line) => ({ ...line })),
      matches: block.matches.map((match) => ({
        lineNumber: match.lineNumber,
        submatches: match.submatches.map((submatch) => ({ ...submatch }))
      }))
    }))
  }));
}

function hasSearchLines(files) {
  return files.some((file) => file.blocks.some((block) => block.lines.length > 0));
}

function compactSubmatches(submatches) {
  return submatches.map((submatch) => ({
    start: submatch.start,
    end: submatch.end,
    text: submatch.match?.text ?? ""
  }));
}

function removeTrailingLineBreaks(value) {
  return value.replace(/[\r\n]+$/u, "");
}

function utf8ByteLength(value) {
  return Buffer.byteLength(value, "utf8");
}

function formatSearchText(files) {
  const hasContextLines = files.some((file) =>
    file.blocks.some((block) => block.lines.some((line) => line.type === "context"))
  );
  return files
    .map((file) => {
      const lines = [file.path];
      for (let blockIndex = 0; blockIndex < file.blocks.length; blockIndex += 1) {
        if (hasContextLines && blockIndex > 0) {
          lines.push("--");
        }
        for (const line of file.blocks[blockIndex].lines) {
          const separator = line.type === "context" ? "-" : ":";
          lines.push(`${line.lineNumber}${separator}${line.text}`);
        }
      }
      return lines.join("\n");
    })
    .join("\n\n");
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

function keepTailUtf8(value, maxBytes) {
  const characters = Array.from(value);
  let bytes = 0;
  const output = [];
  for (let index = characters.length - 1; index >= 0; index -= 1) {
    const character = characters[index];
    const size = Buffer.byteLength(character);
    if (bytes + size > maxBytes) {
      break;
    }
    output.push(character);
    bytes += size;
  }
  return output.reverse().join("");
}

function formatStderrPreview(value) {
  const lines = value.split(/\r?\n/u);
  if (lines.length > 0 && lines[lines.length - 1] === "") {
    lines.pop();
  }
  return lines.slice(-DEFAULT_STDERR_PREVIEW_LINES).join("\n");
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

function isBatchDone(batch) {
  if (typeof batch.info === "string") {
    return batch.info === "done";
  }
  if (batch.info && typeof batch.info === "object") {
    return batch.info.done === true;
  }
  return batch.done === true;
}

async function readOneShotBatch(session, count) {
  try {
    const batch = await session.next(count);
    if (!isBatchDone(batch)) {
      await session.cancel();
    }
    return batch;
  } catch (error) {
    if (!session.done) {
      await session.cancel().catch(() => undefined);
    }
    throw error;
  }
}

async function readOneShotDrain(session) {
  try {
    const batch = await session.drain();
    if (!isBatchDone(batch)) {
      await session.cancel();
    }
    return batch;
  } catch (error) {
    if (!session.done) {
      await session.cancel().catch(() => undefined);
    }
    throw error;
  }
}

async function showOneShotDrain(session) {
  try {
    const batch = await session.show();
    if (!isBatchDone(batch)) {
      await session.cancel();
    }
    return batch;
  } catch (error) {
    if (!session.done) {
      await session.cancel().catch(() => undefined);
    }
    throw error;
  }
}

function resolveWrite(options) {
  if (typeof options.write === "function") {
    return options.write;
  }
  const write = options.globals?.nodeRepl?.write;
  if (typeof write === "function") {
    return write.bind(options.globals.nodeRepl);
  }
  return undefined;
}

function writeRuntimeOutput(runtime, text) {
  assertRuntimeWrite(runtime);
  runtime.write(text);
}

function assertRuntimeWrite(runtime) {
  if (typeof runtime.write !== "function") {
    throw new Error("rg.show requires setupRgRuntime({ globals: globalThis }) with nodeRepl.write available.");
  }
}

function formatShowValue(value) {
  if (value === undefined || value === null) {
    return "";
  }
  if (typeof value === "string") {
    return value;
  }
  if (typeof value.text === "string") {
    return value.text;
  }
  if (typeof value.stdout === "string") {
    return value.stdout;
  }
  if (Array.isArray(value.files)) {
    return value.files.join("\n");
  }
  return JSON.stringify(value, null, 2);
}

function stopReason(session, reasons) {
  if (reasons.maxTextBytesHit) {
    return "maxTextBytes";
  }
  if (reasons.maxBlocksHit) {
    return "maxBlocks";
  }
  if (reasons.maxFilesHit) {
    return "maxFiles";
  }
  if (reasons.maxFilesBytesHit) {
    return "maxFilesBytes";
  }
  if (reasons.readTimedOut) {
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
