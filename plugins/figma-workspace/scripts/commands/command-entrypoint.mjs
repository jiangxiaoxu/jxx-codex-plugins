#!/usr/bin/env node
// @ts-check

const DEFAULT_MAX_BUFFERED_OUTPUT_BYTES = 2 * 1024 * 1024;
const PUBLIC_EXIT_CODES = new Set([0, 1, 2, 130]);
const RUNTIME_MODULE_URL = new URL("../../cli-runtime/dist/cli/figma-command-runtime.js", import.meta.url).href;

function entrypointError(message, code = "EntrypointContractInvalid") {
  return Object.assign(new Error(message), {
    name: code,
    code,
    errorType: code,
  });
}

function canonicalError(error) {
  const explicitType = error && typeof error === "object"
    ? error.errorType ?? error.code
    : undefined;
  const namedType = error instanceof Error && error.name !== "Error" ? error.name : undefined;
  const type = String(explicitType ?? namedType ?? "UnknownFailure");
  const code = String(error && typeof error === "object" ? error.code ?? explicitType ?? type : type);
  const message = String(error instanceof Error ? error.message : error ?? "Unknown CLI failure.");
  return { type, code, message };
}

function markdownSafeScalar(value) {
  return String(value)
    .replaceAll("`", "\\`")
    .replace(/[\r\n]+/gu, " ");
}

function formatEntrypointFailure(commandName, argv, error) {
  const canonical = canonicalError(error);
  const request = argv.length === 0
    ? "Request: {}"
    : `Request: ${JSON.stringify({ arguments: argv })}`;
  return [
    `# ${markdownSafeScalar(commandName)}`,
    request,
    "Status: failed",
    "",
    "## Error",
    `Type: ${markdownSafeScalar(canonical.type)}`,
    `Code: ${markdownSafeScalar(canonical.code)}`,
    `Message: ${markdownSafeScalar(canonical.message)}`,
  ].join("\n");
}

function createOutputGuard(stdout, maxBufferedOutputBytes) {
  const originalWrite = stdout.write;
  const chunks = [];
  let bytes = 0;
  let exceeded = false;

  function guardedWrite(chunk, encoding, callback) {
    if (!exceeded) {
      const text = Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk);
      bytes += Buffer.byteLength(text, "utf8");
      if (bytes > maxBufferedOutputBytes) {
        exceeded = true;
        chunks.length = 0;
      } else {
        chunks.push(text);
      }
    }
    const completion = typeof encoding === "function" ? encoding : callback;
    if (typeof completion === "function") queueMicrotask(completion);
    return !exceeded;
  }

  stdout.write = guardedWrite;
  return {
    restore() {
      stdout.write = originalWrite;
    },
    flush() {
      if (exceeded) {
        throw entrypointError(
          `CLI output exceeded the ${maxBufferedOutputBytes}-byte terminal output limit.`,
          "EntrypointOutputLimitExceeded",
        );
      }
      if (chunks.length > 0) originalWrite.call(stdout, chunks.join(""));
    },
  };
}

async function loadRunner(descriptor) {
  let runtime;
  try {
    runtime = await import(descriptor.moduleUrl ?? RUNTIME_MODULE_URL);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw entrypointError(`CLI runtime import failed: ${detail}`, "EntrypointLoaderFailed");
  }

  if (descriptor.rootHelp === true) {
    if (typeof runtime.runFigmaCommandCli !== "function") {
      throw entrypointError(
        "CLI runtime did not export callable runFigmaCommandCli for root help.",
        "EntrypointLoaderContractInvalid",
      );
    }
    return () => runtime.runFigmaCommandCli(["--help"]);
  }

  if (typeof runtime.runFigmaCommand !== "function") {
    throw entrypointError(
      "CLI runtime did not export callable runFigmaCommand.",
      "EntrypointLoaderContractInvalid",
    );
  }
  return (argv) => runtime.runFigmaCommand(descriptor.fixedArgs[0], argv);
}

function validateDescriptor(descriptor) {
  if (descriptor === null || typeof descriptor !== "object") {
    throw entrypointError("CLI entrypoint descriptor must be an object.");
  }
  if (typeof descriptor.commandName !== "string" || !descriptor.commandName.trim()) {
    throw entrypointError("CLI entrypoint commandName must be a non-empty string.");
  }
  if (descriptor.rootHelp !== undefined && typeof descriptor.rootHelp !== "boolean") {
    throw entrypointError("CLI entrypoint rootHelp must be a boolean.");
  }
  if (descriptor.familyHelp !== undefined && typeof descriptor.familyHelp !== "boolean") {
    throw entrypointError("CLI entrypoint familyHelp must be a boolean.");
  }
  if (descriptor.rootHelp === true && descriptor.familyHelp === true) {
    throw entrypointError("CLI entrypoint cannot be both rootHelp and familyHelp.");
  }
  if (descriptor.rootHelp !== true
    && (!Array.isArray(descriptor.fixedArgs)
      || descriptor.fixedArgs.length !== 1
      || typeof descriptor.fixedArgs[0] !== "string"
      || !descriptor.fixedArgs[0].trim())) {
    throw entrypointError("CLI entrypoint fixedArgs must contain exactly one non-empty command string.");
  }
  if (descriptor.moduleUrl !== undefined && (typeof descriptor.moduleUrl !== "string" || !descriptor.moduleUrl.trim())) {
    throw entrypointError("CLI entrypoint moduleUrl must be a non-empty string when supplied.");
  }
  const maxBufferedOutputBytes = descriptor.maxBufferedOutputBytes ?? DEFAULT_MAX_BUFFERED_OUTPUT_BYTES;
  if (!Number.isSafeInteger(maxBufferedOutputBytes) || maxBufferedOutputBytes <= 0) {
    throw entrypointError("CLI entrypoint maxBufferedOutputBytes must be a positive safe integer.");
  }
  return maxBufferedOutputBytes;
}

/**
 * @param {{
 *   commandName: string,
 *   fixedArgs?: readonly [string],
 *   familyHelp?: boolean,
 *   rootHelp?: boolean,
 *   moduleUrl?: string,
 *   maxBufferedOutputBytes?: number,
 * }} descriptor
 */
export async function runFigmaCommandEntrypoint(descriptor) {
  const argv = process.argv.slice(2);
  const commandName = descriptor && typeof descriptor === "object" && typeof descriptor.commandName === "string"
    ? descriptor.commandName.trim() || "Figma CLI command"
    : "Figma CLI command";
  let outputGuard;
  let exitCode;
  try {
    const maxBufferedOutputBytes = validateDescriptor(descriptor);
    if ((descriptor.rootHelp === true || descriptor.familyHelp === true) && argv.length !== 0) {
      throw entrypointError(`${commandName} does not accept arguments.`, "EntrypointUsageError");
    }
    outputGuard = createOutputGuard(process.stdout, maxBufferedOutputBytes);
    const runner = await loadRunner(descriptor);
    const invocationArgs = descriptor.rootHelp === true || descriptor.familyHelp === true ? [] : argv;
    const result = await runner(invocationArgs);
    if (!PUBLIC_EXIT_CODES.has(result)) {
      throw entrypointError(`CLI runner returned unsupported exit code ${String(result)}.`, "EntrypointExitCodeInvalid");
    }
    outputGuard.restore();
    outputGuard.flush();
    outputGuard = undefined;
    exitCode = result;
  } catch (error) {
    outputGuard?.restore();
    exitCode = error && typeof error === "object" && error.code === "EntrypointUsageError" ? 2 : 1;
    process.stdout.write(`${formatEntrypointFailure(commandName, argv, error)}\n`);
  }
  process.exitCode = exitCode;
  return exitCode;
}
