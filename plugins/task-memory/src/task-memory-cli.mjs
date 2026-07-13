import {
  lstatSync,
  mkdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";

const COMMAND_NAMES = /** @type {const} */ (["init", "status"]);

/** @typedef {(typeof COMMAND_NAMES)[number]} CommandName */
/** @typedef {{ readonly write: (text: string) => unknown }} TextWriter */
/** @typedef {{ readonly stdout: TextWriter, readonly stderr: TextWriter }} CommandIo */
/** @typedef {{ readonly workspace: string, readonly taskId: string }} ParsedOptions */
/** @typedef {{ readonly purpose: string, readonly script: string }} CommandSpec */

/** @type {Readonly<Record<CommandName, CommandSpec>>} */
const COMMAND_SPECS = Object.freeze({
  init: {
    purpose: "Create resumable task state.",
    script: "task-memory:init",
  },
  status: {
    purpose: "Validate task state and print its canonical paths.",
    script: "task-memory:status",
  },
});

class UsageError extends Error {}

/** @param {unknown} error */
function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

/** @param {unknown} error @param {string} code */
function hasErrorCode(error, code) {
  return error instanceof Error && "code" in error && error.code === code;
}

/** @param {string} value */
function normalizeTaskId(value) {
  const token = value.trim().toLowerCase().replace(/[^a-z0-9]+/gu, "-").replace(/^-|-$/gu, "");
  if (token.length === 0) {
    throw new UsageError("--task-id must contain at least one ASCII letter or digit");
  }
  if (!token.startsWith("task-")) {
    throw new UsageError("--task-id must start with task-");
  }
  return token;
}

/** @param {string} workspaceValue */
function resolveWorkspace(workspaceValue) {
  if (!isAbsolute(workspaceValue)) {
    throw new UsageError(`--workspace must be an absolute path: ${workspaceValue}`);
  }
  let workspace;
  try {
    workspace = realpathSync.native(workspaceValue);
  } catch (error) {
    throw new Error(`workspace does not exist or cannot be resolved: ${resolve(workspaceValue)}: ${errorMessage(error)}`);
  }
  const metadata = lstatSync(workspace);
  if (!metadata.isDirectory()) {
    throw new Error(`workspace is not a directory: ${workspace}`);
  }
  return workspace;
}

/** @param {string} workspace @param {string} path @param {string} label */
function ensureWithinWorkspace(workspace, path, label) {
  const relativePath = relative(workspace, path);
  if (relativePath === "" || (!relativePath.startsWith("..") && !isAbsolute(relativePath))) {
    return;
  }
  throw new Error(`${label} escapes workspace: ${path}`);
}

/** @param {string} path */
function optionalMetadata(path) {
  try {
    return lstatSync(path);
  } catch (error) {
    if (hasErrorCode(error, "ENOENT")) {
      return undefined;
    }
    throw error;
  }
}

/** @param {string} workspace @param {string} path @param {string} label */
function validateDirectory(workspace, path, label) {
  ensureWithinWorkspace(workspace, path, label);
  const metadata = optionalMetadata(path);
  if (metadata === undefined) {
    throw new Error(`missing ${label}: ${path}`);
  }
  if (metadata.isSymbolicLink()) {
    throw new Error(`refusing ${label} that is a symlink, junction, or reparse point: ${path}`);
  }
  if (!metadata.isDirectory()) {
    throw new Error(`${label} is not a directory: ${path}`);
  }
}

/** @param {string} workspace @param {string} path @param {string} label */
function validateRegularFile(workspace, path, label) {
  ensureWithinWorkspace(workspace, path, label);
  const metadata = optionalMetadata(path);
  if (metadata === undefined) {
    throw new Error(`missing ${label}: ${path}`);
  }
  if (metadata.isSymbolicLink()) {
    throw new Error(`refusing ${label} symlink or reparse point: ${path}`);
  }
  if (!metadata.isFile()) {
    throw new Error(`${label} is not a regular file: ${path}`);
  }
  if (metadata.nlink !== 1) {
    throw new Error(`refusing hard-linked ${label}: ${path}`);
  }
}

/** @param {string} workspace */
function taskMemoryRootPath(workspace) {
  return join(workspace, "task-memory");
}

/** @param {string} workspace @param {string} taskId */
function taskDirectoryPath(workspace, taskId) {
  return join(taskMemoryRootPath(workspace), taskId);
}

/** @param {string} taskDirectory */
function taskStatePath(taskDirectory) {
  return join(taskDirectory, "task_state.md");
}

/** @param {string} taskDirectory */
function artifactsDirectoryPath(taskDirectory) {
  return join(taskDirectory, "artifacts");
}

/** @param {string} workspace @param {string} taskDirectory */
function validateTaskDirectory(workspace, taskDirectory) {
  const taskRoot = taskMemoryRootPath(workspace);
  const taskState = taskStatePath(taskDirectory);
  const artifactsDirectory = artifactsDirectoryPath(taskDirectory);
  validateDirectory(workspace, taskRoot, "task memory root");
  validateDirectory(workspace, taskDirectory, "task directory");
  validateRegularFile(workspace, taskState, "task_state.md");
  validateDirectory(workspace, artifactsDirectory, "artifacts directory");
  return { taskState, artifactsDirectory };
}

/** @param {string} workspace @param {string} taskId */
function resolveTaskDirectory(workspace, taskId) {
  const normalizedTaskId = normalizeTaskId(taskId);
  const taskDirectory = taskDirectoryPath(workspace, normalizedTaskId);
  if (optionalMetadata(taskDirectory) === undefined) {
    throw new Error(`task not found: ${normalizedTaskId}`);
  }
  const { taskState, artifactsDirectory } = validateTaskDirectory(workspace, taskDirectory);
  return { normalizedTaskId, taskState, artifactsDirectory };
}

function taskStateTemplate() {
  return `# Task State

## Goal

- Objective: TBD
- Success criteria: TBD

## State

- Phase: initialized

## Open

- Next: define the objective and first concrete action.
`;
}

/** @param {string} workspace @param {string} requestedTaskId */
function initializeTask(workspace, requestedTaskId) {
  const taskId = normalizeTaskId(requestedTaskId);
  const taskRoot = taskMemoryRootPath(workspace);
  try {
    mkdirSync(taskRoot);
  } catch (error) {
    if (!hasErrorCode(error, "EEXIST")) {
      throw error;
    }
  }
  validateDirectory(workspace, taskRoot, "task memory root");

  for (let sequence = 0; sequence < 1000; sequence += 1) {
    const actualTaskId = sequence === 0 ? taskId : `${taskId}-${String(sequence).padStart(3, "0")}`;
    const taskDirectory = taskDirectoryPath(workspace, actualTaskId);
    try {
      mkdirSync(taskDirectory);
    } catch (error) {
      if (hasErrorCode(error, "EEXIST")) {
        validateDirectory(workspace, taskDirectory, "existing task directory");
        continue;
      }
      throw error;
    }

    try {
      mkdirSync(artifactsDirectoryPath(taskDirectory));
      writeFileSync(taskStatePath(taskDirectory), taskStateTemplate(), { encoding: "utf8", flag: "wx" });
      validateTaskDirectory(workspace, taskDirectory);
      return actualTaskId;
    } catch (error) {
      rmSync(taskDirectory, { force: true, recursive: true });
      throw error;
    }
  }
  throw new Error(`could not allocate task memory folder for task id: ${taskId}`);
}

/** @param {CommandName} command */
function commandHelp(command) {
  const spec = COMMAND_SPECS[command];
  return `# ${spec.script} help

Purpose: ${spec.purpose}
Usage: npm --silent run ${spec.script} -- --workspace <absolute-path> --task-id <task-id>

Options:
  --workspace <path>    Required absolute workspace path.
  --task-id <task-id>   Required id beginning with task-.
  -h, --help            Show this help.

Exit Codes:
  0  Success.
  1  Runtime or file-system failure.
  2  Usage failure.
`;
}

/** @param {readonly string[]} arguments_ */
function parseOptions(arguments_) {
  if (arguments_.some((argument) => argument === "-h" || argument === "--help")) {
    return undefined;
  }
  const allowed = new Set(["--workspace", "--task-id"]);
  /** @type {Map<string, string>} */
  const values = new Map();
  for (let index = 0; index < arguments_.length; index += 1) {
    const option = arguments_[index];
    if (!allowed.has(option)) {
      throw new UsageError(`unknown option or positional argument: ${option}`);
    }
    if (values.has(option)) {
      throw new UsageError(`duplicate option: ${option}`);
    }
    const value = arguments_[index + 1];
    if (value === undefined || value.startsWith("--")) {
      throw new UsageError(`missing value for ${option}`);
    }
    values.set(option, value);
    index += 1;
  }
  for (const option of allowed) {
    if (!values.has(option)) {
      throw new UsageError(`missing required option: ${option}`);
    }
  }
  return {
    workspace: /** @type {string} */ (values.get("--workspace")),
    taskId: /** @type {string} */ (values.get("--task-id")),
  };
}

/** @param {CommandName} command @param {ParsedOptions} options */
function executeCommand(command, options) {
  const workspace = resolveWorkspace(options.workspace);
  if (command === "init") {
    return `task_id=${initializeTask(workspace, options.taskId)}`;
  }
  const { normalizedTaskId, taskState, artifactsDirectory } = resolveTaskDirectory(workspace, options.taskId);
  return [
    `task_id=${normalizedTaskId}`,
    `task_state=${taskState}`,
    `artifacts=${artifactsDirectory}`,
  ].join("\n");
}

/**
 * @param {CommandName} command
 * @param {readonly string[]} arguments_
 * @param {CommandIo} [io]
 */
export function runTaskMemoryCommand(command, arguments_, io = process) {
  const help = commandHelp(command);
  try {
    const options = parseOptions(arguments_);
    if (options === undefined) {
      io.stdout.write(help);
      return 0;
    }
    io.stdout.write(`${executeCommand(command, options)}\n`);
    return 0;
  } catch (error) {
    if (error instanceof UsageError) {
      io.stderr.write(`Error: ${error.message}\n\n${help}`);
      return 2;
    }
    io.stderr.write(`Error: ${errorMessage(error)}\n`);
    return 1;
  }
}

export const taskMemoryCommandNames = COMMAND_NAMES;
