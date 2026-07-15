import { createRequire as __figmaWorkspaceCreateRequire } from "node:module";
import { fileURLToPath as __figmaWorkspaceFileURLToPath } from "node:url";
import { dirname as __figmaWorkspacePathDirname } from "node:path";
const require = __figmaWorkspaceCreateRequire(import.meta.url);
const __filename = __figmaWorkspaceFileURLToPath(import.meta.url);
const __dirname = __figmaWorkspacePathDirname(__filename);

// src/cli/figma-command-runtime.ts
import { readFile } from "node:fs/promises";
import {
  isFullyQualifiedAbsolutePath,
  runFigmaWorkspaceCli
} from "../runtime/workspace-runtime.js";
var EXIT_SUCCESS = 0;
var EXIT_USAGE = 2;
var UNSET_VALUE = { state: "unset" };
var STATE_FILE_OPTION = {
  type: "global",
  forwardFlag: "--session-file",
  value: "<path>",
  description: "Fully qualified absolute path to the persisted workspace state file and result-sidecar anchor.",
  omitted: { state: "required" },
  repeatable: false
};
var STATE_FILE_EXAMPLE = "--state-file C:/work/project/.figma-workspace/state.json";
var MAX_INLINE_BYTES_OPTION = {
  type: "global-integer",
  forwardFlag: "--inline-result-limit",
  value: "<bytes>",
  description: "Maximum inline Markdown bytes from 0 to 10000; 0 forces a complete JSON sidecar.",
  omitted: { state: "default", value: "4096" },
  repeatable: false,
  min: 0,
  max: 1e4
};
var JSON_MAX_INLINE_BYTES_OPTION = {
  ...MAX_INLINE_BYTES_OPTION,
  omitted: { state: "default", value: "input inlineResultLimit when present, otherwise 4096" }
};
var SESSION_ID_OPTION = {
  ...stringOption("sessionId", "<id>", "Logical workspace session id."),
  omitted: { state: "default", value: "the runtime default session" }
};
function stringOption(key, value, description) {
  return { key, type: "string", value, description, omitted: UNSET_VALUE, repeatable: false };
}
function integerOption(key, value, description, bounds = {}) {
  return { key, type: "integer", value, description, omitted: UNSET_VALUE, repeatable: false, ...bounds };
}
function booleanOption(key, description, mappedValue = true) {
  return { key, type: "boolean", description, mappedValue, omitted: UNSET_VALUE, repeatable: false };
}
function enumOption(key, values, description) {
  return {
    key,
    type: "enum",
    value: `<${values.join("|")}>`,
    values,
    description,
    omitted: UNSET_VALUE,
    repeatable: false
  };
}
function repeatOption(key, value, description) {
  return { key, type: "repeat", value, description, omitted: UNSET_VALUE, repeatable: true };
}
function fileContextOptions() {
  return {
    "--file": stringOption("file", "<url-or-key>", "Explicit Figma file URL or key."),
    "--workspace": stringOption("workspaceDir", "<path>", "Absolute local workspace root."),
    "--refresh": booleanOption("refresh", "Refresh upstream data when supported.")
  };
}
var FIGMA_TASK_FAMILIES = [
  "code-connect",
  "create-file",
  "design-to-code",
  "design-generation",
  "diagram",
  "library-generation",
  "motion-implementation",
  "swiftui",
  "figjam",
  "motion",
  "slides",
  "design-editing"
];
var FIGMA_GUIDANCE_WORKFLOWS = [
  "design-implementation-context",
  "motion-implementation"
];
var SCRIPT_NAMES_BY_TRANSPORT_COMMAND = {
  "get-metadata": "metadata",
  "get-design-context": "design-context",
  "get-motion-context": "motion-context",
  "get-variable-defs": "variables"
};
function npmScriptForCommand(command) {
  return hasOwn(SCRIPT_NAMES_BY_TRANSPORT_COMMAND, command) ? SCRIPT_NAMES_BY_TRANSPORT_COMMAND[command] : command;
}
function targetSpec(command, purpose, extraOptions = {}) {
  return {
    command,
    purpose,
    sessionId: true,
    outputLimit: true,
    position: {
      key: "target",
      label: "target",
      omitted: UNSET_VALUE,
      repeatable: false,
      description: "Node id, node URL, or $handle. A node-scoped --file URL can supply the target instead."
    },
    options: { ...fileContextOptions(), ...extraOptions },
    examples: [`npm --silent run figma:${npmScriptForCommand(command)} -- '$hero' --session-id default ${STATE_FILE_EXAMPLE}`]
  };
}
var FIGMA_DIRECT_COMMANDS = {
  guidance: {
    command: "guidance",
    purpose: "Get task-oriented workflow guidance from a direct keyword query.",
    position: { key: "query", label: "query", omitted: { state: "required" }, repeatable: false, description: "Compact planning keywords." },
    options: {
      "--mode": enumOption("mode", ["guidance", "plan"], "Guidance mode. Use the JSON escape hatch for card or catalog mode."),
      "--surface": enumOption("surface", ["design", "figjam", "slides"], "Expected Figma surface."),
      "--workflow": enumOption("workflow", FIGMA_GUIDANCE_WORKFLOWS, "Existing workflow id used to filter workflow and wrapper summaries."),
      "--card-limit": integerOption("maxCards", "<n>", "Maximum returned cards from 1 to 8.", { min: 1, max: 8 })
    },
    outputLimit: true,
    examples: [`npm --silent run figma:guidance -- "text font loadFontAsync" --surface design ${STATE_FILE_EXAMPLE}`]
  },
  "docs:list": {
    command: "docs",
    purpose: "List canonical project Markdown topics.",
    fixedInput: { mode: "list" },
    options: {},
    outputLimit: true,
    examples: [`npm --silent run figma:docs:list -- ${STATE_FILE_EXAMPLE}`]
  },
  "docs:catalog": {
    command: "docs",
    purpose: "Browse canonical task families or filtered canonical document records.",
    fixedInput: { mode: "catalog" },
    options: {
      "--task-family": enumOption("taskFamily", FIGMA_TASK_FAMILIES, "Canonical task family. Omit to list task-family summaries."),
      "--surface": enumOption("surface", ["design", "figjam", "slides"], "Required canonical document surface."),
      "--classification": enumOption("classification", ["active", "conditional", "router", "examples"], "Canonical document classification."),
      "--limit": integerOption("limit", "<n>", "Maximum returned catalog entries from 1 to 100.", { min: 1, max: 100 })
    },
    outputLimit: true,
    examples: [`npm --silent run figma:docs:catalog -- --task-family code-connect --surface design --limit 20 ${STATE_FILE_EXAMPLE}`]
  },
  "docs:read": {
    command: "docs",
    purpose: "Read one complete project or canonical Markdown document.",
    fixedInput: { mode: "read" },
    position: { key: "id", label: "doc-id", omitted: { state: "required" }, repeatable: false, description: "Stable project: or canonical: id returned by figma:docs:list or figma:docs:catalog." },
    options: {},
    outputLimit: true,
    examples: [`npm --silent run figma:docs:read -- project:workflow ${STATE_FILE_EXAMPLE}`]
  },
  "docs:search": {
    command: "lookup",
    purpose: "Search project and canonical workflow documentation with automatic task routing.",
    fixedInput: { kind: "docs", scope: "auto" },
    position: { key: "query", label: "query", omitted: { state: "required" }, repeatable: false, description: "Documentation search text." },
    options: {
      "--scope": {
        ...enumOption("scope", ["auto", "active", "conditional", "router", "examples", "all"], "Documentation lookup scope."),
        omitted: { state: "default", value: "auto" }
      },
      "--surface": enumOption("surface", ["design", "figjam", "slides"], "Required documentation surface."),
      "--task-family": enumOption("taskFamily", FIGMA_TASK_FAMILIES, "Required canonical task family."),
      "--limit": integerOption("maxResults", "<n>", "Maximum returned snippets from 1 to 10.", { min: 1, max: 10 }),
      "--snippet-lines": integerOption("maxSnippetLines", "<n>", "Maximum lines per snippet from 1 to 8.", { min: 1, max: 8 })
    },
    outputLimit: true,
    examples: [`npm --silent run figma:docs:search -- "session handles recovery" --limit 5 ${STATE_FILE_EXAMPLE}`]
  },
  "api:search": {
    command: "lookup",
    purpose: "Search exact or near-exact Figma Plugin API symbol documentation.",
    fixedInput: { kind: "api" },
    position: { key: "symbol", label: "symbol", omitted: { state: "required" }, repeatable: false, description: "Plugin API symbol or search text." },
    options: {
      "--limit": integerOption("maxResults", "<n>", "Maximum returned snippets from 1 to 10.", { min: 1, max: 10 }),
      "--snippet-lines": integerOption("maxSnippetLines", "<n>", "Maximum lines per snippet from 1 to 8.", { min: 1, max: 8 })
    },
    outputLimit: true,
    examples: [`npm --silent run figma:api:search -- createFrame ${STATE_FILE_EXAMPLE}`]
  },
  doctor: {
    command: "doctor",
    purpose: "Inspect canonical docs, generated Plugin API index, and TypeScript runtime availability.",
    options: {},
    outputLimit: true,
    examples: [`npm --silent run figma:doctor -- ${STATE_FILE_EXAMPLE}`]
  },
  "sessions:list": {
    command: "sessions",
    purpose: "List compact persisted session summaries.",
    options: {},
    outputLimit: true,
    examples: [`npm --silent run figma:sessions:list -- ${STATE_FILE_EXAMPLE}`]
  },
  "sessions:read": {
    command: "sessions",
    purpose: "Read one persisted session with optional handles and history.",
    position: { key: "sessionId", label: "session-id", omitted: { state: "required" }, repeatable: false, description: "Exact persisted session id." },
    options: {
      "--with-handles": booleanOption("includeHandles", "Include the full handle map."),
      "--with-history": booleanOption("includeHistory", "Include full history entries.")
    },
    outputLimit: true,
    examples: [`npm --silent run figma:sessions:read -- default --with-handles ${STATE_FILE_EXAMPLE}`]
  },
  "upstream:list": {
    command: "upstream-tools",
    purpose: "List the live official Figma upstream tool directory.",
    options: { "--refresh": booleanOption("refresh", "Refresh upstream discovery before reading.") },
    outputLimit: true,
    examples: [`npm --silent run figma:upstream:list -- --refresh ${STATE_FILE_EXAMPLE}`]
  },
  "upstream:read": {
    command: "upstream-tools",
    purpose: "Read one live official upstream tool description and input schema.",
    position: { key: "name", label: "name", omitted: { state: "required" }, repeatable: false, description: "Exact official upstream tool name." },
    options: { "--refresh": booleanOption("refresh", "Refresh upstream discovery before reading.") },
    outputLimit: true,
    examples: [`npm --silent run figma:upstream:read -- whoami --refresh ${STATE_FILE_EXAMPLE}`]
  },
  inspect: {
    command: "inspect",
    purpose: "Inspect or validate a target using direct positional syntax.",
    sessionId: true,
    outputLimit: true,
    position: { key: "target", label: "target", omitted: UNSET_VALUE, repeatable: false, description: "Node id, node URL, or $handle." },
    options: {
      "--mode": enumOption("mode", ["inspect", "validate", "style"], "Inspection mode."),
      "--depth": integerOption("depth", "<n>", "Positive traversal depth.", { min: 1 }),
      "--handle": repeatOption("handles", "<name>", "Handle name or node id to validate; repeat as needed.")
    },
    examples: [`npm --silent run figma:inspect -- '$hero' --mode validate --session-id default ${STATE_FILE_EXAMPLE}`]
  },
  metadata: targetSpec("get-metadata", "Read broad Figma metadata for an optional target."),
  "design-context": targetSpec("get-design-context", "Read official design implementation context.", {
    "--force-code": booleanOption("forceCode", "Force code generation when supported."),
    "--no-code-connect": booleanOption("disableCodeConnect", "Disable Code Connect context."),
    "--exclude-screenshot": booleanOption("excludeScreenshot", "Exclude screenshots from context.")
  }),
  "motion-context": targetSpec("get-motion-context", "Read official motion context.", {
    "--recursive": booleanOption("recursive", "Include recursive motion context.")
  }),
  variables: targetSpec("get-variable-defs", "Read variable definitions for a target."),
  "design-system": {
    command: "search-design-system",
    purpose: "Search official design-system components, variables, and styles.",
    sessionId: true,
    outputLimit: true,
    position: { key: "query", label: "query", omitted: { state: "required" }, repeatable: false, description: "Design-system search text." },
    options: {
      ...fileContextOptions(),
      "--components": booleanOption("includeComponents", "Include components."),
      "--no-components": booleanOption("includeComponents", "Exclude components.", false),
      "--variables": booleanOption("includeVariables", "Include variables."),
      "--no-variables": booleanOption("includeVariables", "Exclude variables.", false),
      "--styles": booleanOption("includeStyles", "Include styles."),
      "--no-styles": booleanOption("includeStyles", "Exclude styles.", false),
      "--no-code-connect": booleanOption("disableCodeConnect", "Disable Code Connect context."),
      "--library": repeatOption("includeLibraryKeys", "<key>", "Include one library key; repeat as needed.")
    },
    examples: [`npm --silent run figma:design-system -- "button primary" --components --variables ${STATE_FILE_EXAMPLE}`]
  },
  libraries: {
    command: "get-libraries",
    purpose: "List available Figma libraries.",
    sessionId: true,
    outputLimit: true,
    options: { ...fileContextOptions(), "--offset": integerOption("offset", "<n>", "Non-negative pagination offset.", { min: 0 }) },
    examples: [`npm --silent run figma:libraries -- --session-id default ${STATE_FILE_EXAMPLE}`]
  }
};
var FIGMA_JSON_COMMANDS = {
  open: { command: "open", purpose: "Create or reopen persisted Figma workspace context.", inputRequired: false },
  eval: { command: "eval", purpose: "Run a small native Plugin API transaction.", inputRequired: true },
  "script:run": { command: "run-script-file", purpose: "Preflight and execute a local .figma.ts file.", inputRequired: true },
  "assets:apply": { command: "apply-asset-manifest", purpose: "Apply a prepared local asset manifest.", inputRequired: true },
  "assets:download": { command: "download-assets", purpose: "Download official Figma assets to local files.", inputRequired: true },
  capture: { command: "capture-node", purpose: "Capture a Figma node to a local PNG file.", inputRequired: true },
  "task:run": { command: "run-task-plan", purpose: "Execute a prepared multi-step task plan.", inputRequired: true },
  "task:prepare": { command: "prepare-task", purpose: "Create a repairable local .figma.ts task workspace.", inputRequired: true },
  "upstream:call": { command: "call-upstream-tool", purpose: "Invoke one uncovered official upstream capability.", inputRequired: true }
};
var FIGMA_COMMAND_FAMILIES = {
  docs: ["docs:list", "docs:catalog", "docs:read", "docs:search"],
  api: ["api:search"],
  sessions: ["sessions:list", "sessions:read"],
  upstream: ["upstream:list", "upstream:read", "upstream:call"]
};
async function runFigmaCommandCli(argv, dependencies = {}) {
  const commandName = argv[0];
  if (commandName === void 0 || isHelpToken(commandName)) {
    writer(dependencies.writeStdout, process.stdout.write.bind(process.stdout))(formatRootHelp());
    return EXIT_SUCCESS;
  }
  return runFigmaCommand(commandName, argv.slice(1), dependencies);
}
async function runFigmaCommand(commandName, argv, dependencies = {}) {
  const writeStdout = writer(dependencies.writeStdout, process.stdout.write.bind(process.stdout));
  const writeStderr = writer(dependencies.writeStderr, process.stderr.write.bind(process.stderr));
  if (isCommandFamily(commandName)) {
    if (argv.length === 0 || argv.some(isHelpFlag) || argv.length === 1 && argv[0] === "help") {
      writeStdout(formatFamilyHelp(commandName));
      return EXIT_SUCCESS;
    }
    writeStderr(`Unknown figma ${commandName} family argument: ${argv[0]}

${formatFamilyHelp(commandName)}`);
    return EXIT_USAGE;
  }
  if (isDirectCommand(commandName)) {
    const spec = FIGMA_DIRECT_COMMANDS[commandName];
    if (hasDirectHelpFlag(argv)) {
      writeStdout(formatDirectHelp(commandName, spec));
      return EXIT_SUCCESS;
    }
    try {
      const parsed = parseDirectArguments(commandName, spec, argv);
      const runCli = dependencies.runCli ?? runFigmaWorkspaceCli;
      return await runCli(
        [spec.command, "--input", "-", ...parsed.globalArgs],
        { io: createMappedIo(parsed.input, dependencies) }
      );
    } catch (error) {
      writeStderr(`${formatError(error)}

${formatDirectHelp(commandName, spec)}`);
      return EXIT_USAGE;
    }
  }
  if (isJsonCommand(commandName)) {
    const spec = FIGMA_JSON_COMMANDS[commandName];
    if (argv.some(isHelpFlag)) {
      writeStdout(formatJsonHelp(commandName, spec));
      return EXIT_SUCCESS;
    }
    try {
      const forwardedArgs = parseJsonArguments(commandName, spec, argv);
      return await (dependencies.runCli ?? runFigmaWorkspaceCli)([spec.command, ...forwardedArgs]);
    } catch (error) {
      writeStderr(`${formatError(error)}

${formatJsonHelp(commandName, spec)}`);
      return EXIT_USAGE;
    }
  }
  writeStderr(`Unknown Figma command: ${commandName}

${formatRootHelp()}`);
  return EXIT_USAGE;
}
function parseDirectArguments(commandName, spec, argv) {
  const input = { ...spec.fixedInput ?? {} };
  const globalArgs = [];
  const options = directOptions(spec);
  const seenKeys = /* @__PURE__ */ new Set();
  let positionalSeen = false;
  let positionalOnly = false;
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === void 0) continue;
    if (!positionalOnly && token === "--") {
      positionalOnly = true;
      continue;
    }
    if (!positionalOnly && token.startsWith("-")) {
      const option = options[token];
      if (option === void 0) throw new Error(`Unknown option for figma ${commandName}: ${token}`);
      if (option.type === "boolean") {
        if (seenKeys.has(option.key)) throw new Error(`Duplicate option for figma ${commandName}: ${token}`);
        seenKeys.add(option.key);
        input[option.key] = option.mappedValue;
        continue;
      }
      const value = argv[index + 1];
      if (value === void 0 || value.startsWith("--")) throw new Error(`Option ${token} requires ${option.value}.`);
      index += 1;
      if (option.type === "global" || option.type === "global-integer") {
        if (seenKeys.has(token)) throw new Error(`Duplicate option for figma ${commandName}: ${token}`);
        seenKeys.add(token);
        if (token === "--state-file" && !isFullyQualifiedAbsolutePath(value)) {
          throw new Error("Option --state-file requires a fully qualified absolute path.");
        }
        const forwardedValue = option.type === "global-integer" ? String(parseIntegerOption(option, value, token)) : value;
        globalArgs.push(option.forwardFlag, forwardedValue);
        continue;
      }
      if (option.type !== "repeat" && seenKeys.has(option.key)) {
        throw new Error(`Duplicate option for figma ${commandName}: ${token}`);
      }
      seenKeys.add(option.key);
      assignOptionValue(input, option, value, token);
      continue;
    }
    if (spec.position === void 0) throw new Error(`Unexpected argument for figma ${commandName}: ${token}`);
    if (positionalSeen) {
      throw new Error(`figma ${commandName} accepts one <${spec.position.label}> argument; quote multi-word values.`);
    }
    input[spec.position.key] = token;
    positionalSeen = true;
  }
  if (spec.position?.omitted.state === "required" && !positionalSeen) {
    throw new Error(`Missing required <${spec.position.label}> for figma ${commandName}.`);
  }
  if (!seenKeys.has("--state-file")) {
    throw new Error(`figma ${commandName} requires --state-file <path>.`);
  }
  return { input, globalArgs };
}
function parseJsonArguments(commandName, spec, argv) {
  const options = jsonOptions(spec);
  const forwardedArgs = [];
  const seen = /* @__PURE__ */ new Set();
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === void 0 || !hasOwn(options, token)) throw new Error(`Unknown option for figma ${commandName}: ${token}`);
    const option = options[token];
    if (seen.has(token)) throw new Error(`Duplicate option for figma ${commandName}: ${token}`);
    const value = argv[index + 1];
    if (value === void 0 || value.startsWith("--")) throw new Error(`Option ${token} requires ${option.value}.`);
    if (token === "--state-file" && !isFullyQualifiedAbsolutePath(value)) {
      throw new Error("Option --state-file requires a fully qualified absolute path.");
    }
    seen.add(token);
    const forwardedValue = option.type === "global-integer" ? String(parseIntegerOption(option, value, token)) : value;
    forwardedArgs.push(option.forwardFlag, forwardedValue);
    index += 1;
  }
  if (spec.inputRequired && !seen.has("--input")) throw new Error(`figma ${commandName} requires --input <json-file|->.`);
  if (!seen.has("--state-file")) throw new Error(`figma ${commandName} requires --state-file <path>.`);
  return forwardedArgs;
}
function jsonOptions(spec) {
  return {
    "--input": {
      type: "forward",
      forwardFlag: "--input",
      value: "<json-file|->",
      description: "Read the command JSON object from a file or stdin.",
      omitted: spec.inputRequired ? { state: "required" } : UNSET_VALUE,
      repeatable: false
    },
    "--state-file": STATE_FILE_OPTION,
    "--max-inline-bytes": JSON_MAX_INLINE_BYTES_OPTION
  };
}
function directOptions(spec) {
  return {
    "--state-file": STATE_FILE_OPTION,
    ...spec.sessionId === true ? { "--session-id": SESSION_ID_OPTION } : {},
    ...spec.outputLimit === true ? { "--max-inline-bytes": MAX_INLINE_BYTES_OPTION } : {},
    ...spec.options
  };
}
function assignOptionValue(input, option, value, token) {
  switch (option.type) {
    case "integer":
      input[option.key] = parseIntegerOption(option, value, token);
      return;
    case "enum":
      if (!option.values.some((candidate) => candidate === value)) {
        throw new Error(`Option ${token} must be one of: ${option.values.join(", ")}.`);
      }
      input[option.key] = value;
      return;
    case "repeat": {
      const current = input[option.key];
      if (current === void 0) input[option.key] = [value];
      else if (Array.isArray(current)) current.push(value);
      else throw new Error(`Option ${token} cannot be combined with a non-list value.`);
      return;
    }
    case "string":
      input[option.key] = value;
      return;
    case "boolean":
      input[option.key] = option.mappedValue;
  }
}
function parseIntegerOption(option, value, token) {
  if (!/^-?\d+$/u.test(value)) throw new Error(`Option ${token} requires an integer.`);
  const parsed = Number.parseInt(value, 10);
  if (!Number.isSafeInteger(parsed)) throw new Error(`Option ${token} requires a safe integer.`);
  if (option.min !== void 0 && parsed < option.min) throw new Error(`Option ${token} must be at least ${option.min}.`);
  if (option.max !== void 0 && parsed > option.max) throw new Error(`Option ${token} must be at most ${option.max}.`);
  return parsed;
}
function createMappedIo(input, dependencies) {
  return {
    cwd: dependencies.cwd ?? (() => process.cwd()),
    env: dependencies.env ?? ((name) => process.env[name]),
    readFile: dependencies.readFile ?? ((path) => readFile(path, "utf8")),
    readStdin: async () => JSON.stringify(input),
    writeStdout: writer(dependencies.writeStdout, process.stdout.write.bind(process.stdout)),
    writeStderr: writer(dependencies.writeStderr, process.stderr.write.bind(process.stderr))
  };
}
function formatDirectHelp(commandName, spec) {
  const usagePosition = spec.position === void 0 ? "" : ` ${spec.position.omitted.state === "required" ? `<${spec.position.label}>` : `[${spec.position.label}]`}`;
  const lines = [
    `# figma ${commandName} help`,
    "",
    "## Purpose",
    spec.purpose,
    "",
    "## Usage",
    `- \`npm --silent run figma -- ${commandName}${usagePosition} [options]\``,
    `- \`npm --silent run figma:${commandName} --${usagePosition} [options]\``
  ];
  if (spec.position !== void 0) {
    lines.push(
      "",
      "## Arguments",
      `- \`<${spec.position.label}>\`: ${spec.position.description} ${formatOmittedValue(spec.position.omitted)} Repeatable: no.`
    );
  }
  lines.push("", "## Options", "- `-h`, `--help`: Show this command help without running Figma.");
  for (const [flag, option] of Object.entries(directOptions(spec))) {
    const value = "value" in option ? ` ${option.value}` : "";
    lines.push(`- \`${flag}${value}\`: ${option.description} ${formatOptionMetadata(option)}`);
  }
  lines.push("", "## Output", "Restricted Markdown on stdout. Follow `outputFiles.cliResultFile` for an oversized complete JSON result.");
  if (spec.examples !== void 0 && spec.examples.length > 0) {
    lines.push("", "## Examples", ...spec.examples.map((example) => `- \`${example}\``));
  }
  return `${lines.join("\n")}
`;
}
function formatFamilyHelp(family) {
  const commands = FIGMA_COMMAND_FAMILIES[family];
  return [
    `# figma ${family} help`,
    "",
    "## Purpose",
    `Browse the figma ${family} command family.`,
    "",
    "## Commands",
    ...commands.map((commandName) => `- \`npm --silent run figma -- ${commandName} --help\``),
    "",
    "## NPM Scripts",
    ...commands.map((commandName) => `- \`npm --silent run figma:${commandName} -- --help\``),
    "",
    "## Help",
    "Use `-h` or `--help` on a concrete command before first use.",
    ""
  ].join("\n");
}
function formatJsonHelp(commandName, spec) {
  const inputUsage = spec.inputRequired ? " --input <json-file|->" : " [--input <json-file|->]";
  const lines = [
    `# figma ${commandName} help`,
    "",
    "## Purpose",
    spec.purpose,
    "",
    "## Usage",
    `- \`npm --silent run figma -- ${commandName}${inputUsage} [options]\``,
    `- \`npm --silent run figma:${commandName} --${inputUsage} [options]\``,
    "",
    "## Options"
  ];
  for (const [flag, option] of Object.entries(jsonOptions(spec))) {
    lines.push(`- \`${flag} ${option.value}\`: ${option.description} ${formatOptionMetadata(option)}`);
  }
  lines.push(
    "- `-h`, `--help`: Show this command help without running Figma.",
    "",
    "## JSON Schema",
    `Run \`npm --silent run figma:raw -- ${spec.command} --help\` only when the complete transport-level input schema is needed.`,
    "",
    "## Output",
    "Restricted Markdown on stdout. Follow `outputFiles.cliResultFile` for an oversized complete JSON result.",
    ""
  );
  return lines.join("\n");
}
function formatOptionMetadata(option) {
  const metadata = [formatOmittedValue(option.omitted), `Repeatable: ${option.repeatable ? "yes" : "no"}.`];
  if (option.type === "integer" || option.type === "global-integer") {
    metadata.push(`Range: ${option.min ?? Number.MIN_SAFE_INTEGER} to ${option.max ?? Number.MAX_SAFE_INTEGER}.`);
  }
  if (option.type === "enum") metadata.push(`Allowed: ${option.values.join(", ")}.`);
  return metadata.join(" ");
}
function formatOmittedValue(omitted) {
  switch (omitted.state) {
    case "required":
      return "Required.";
    case "default":
      return `Default: ${omitted.value}.`;
    case "unset":
      return "Default: unset.";
  }
}
function formatRootHelp() {
  return [
    "# Figma command CLI help",
    "",
    "## Usage",
    "- `npm --silent run figma -- <command> [arguments] [options]`",
    "",
    "## Command families",
    ...Object.keys(FIGMA_COMMAND_FAMILIES).map((family) => `- \`npm --silent run figma -- ${family} --help\``),
    "",
    "## Query and read commands",
    ...Object.keys(FIGMA_DIRECT_COMMANDS).map((command) => `- \`${command}\``),
    "",
    "## JSON commands",
    ...Object.keys(FIGMA_JSON_COMMANDS).map((command) => `- \`${command}\``),
    "",
    "## Transport schema escape hatch",
    "- `npm --silent run figma:raw -- <transport-command> --help`",
    ""
  ].join("\n");
}
function writer(candidate, fallback) {
  return candidate ?? fallback;
}
function hasOwn(value, key) {
  return Object.prototype.hasOwnProperty.call(value, key);
}
function isDirectCommand(value) {
  return hasOwn(FIGMA_DIRECT_COMMANDS, value);
}
function isJsonCommand(value) {
  return hasOwn(FIGMA_JSON_COMMANDS, value);
}
function isCommandFamily(value) {
  return hasOwn(FIGMA_COMMAND_FAMILIES, value);
}
function isHelpToken(token) {
  return token === "-h" || token === "--help" || token === "help";
}
function isHelpFlag(token) {
  return token === "-h" || token === "--help";
}
function hasDirectHelpFlag(argv) {
  for (const token of argv) {
    if (token === "--") return false;
    if (isHelpFlag(token)) return true;
  }
  return false;
}
function formatError(error) {
  return error instanceof Error ? error.message : String(error);
}
export {
  FIGMA_COMMAND_FAMILIES,
  FIGMA_DIRECT_COMMANDS,
  FIGMA_GUIDANCE_WORKFLOWS,
  FIGMA_JSON_COMMANDS,
  FIGMA_TASK_FAMILIES,
  formatDirectHelp,
  formatFamilyHelp,
  formatJsonHelp,
  formatRootHelp,
  parseDirectArguments,
  parseJsonArguments,
  runFigmaCommand,
  runFigmaCommandCli
};
