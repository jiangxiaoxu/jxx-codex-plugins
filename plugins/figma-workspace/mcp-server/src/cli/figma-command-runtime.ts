import { readFile } from "node:fs/promises";
import {
  runFigmaWorkspaceCli,
  type FigmaWorkspaceCliDependencies,
  type FigmaWorkspaceCliIo,
} from "../runtime/workspace-runtime.js";

const EXIT_SUCCESS = 0;
const EXIT_USAGE = 2;

type CommandInput = Record<string, unknown>;
type WriteOutput = (value: string) => void;
type RunWorkspaceCli = (
  argv: readonly string[],
  dependencies?: FigmaWorkspaceCliDependencies,
) => Promise<number>;

export interface FigmaCommandRuntimeDependencies {
  runCli?: RunWorkspaceCli;
  cwd?: FigmaWorkspaceCliIo["cwd"];
  env?: FigmaWorkspaceCliIo["env"];
  readFile?: FigmaWorkspaceCliIo["readFile"];
  writeStdout?: WriteOutput;
  writeStderr?: WriteOutput;
}

interface OptionBase<Key extends string, Type extends string> {
  readonly key: Key;
  readonly type: Type;
  readonly description: string;
}

interface ValueOptionBase<Key extends string, Type extends string> extends OptionBase<Key, Type> {
  readonly value: string;
}

type StringOption<Key extends string = string> = ValueOptionBase<Key, "string">;
type IntegerOption<Key extends string = string> = ValueOptionBase<Key, "integer"> & {
  readonly min?: number;
  readonly max?: number;
};
type BooleanOption<Key extends string = string> = OptionBase<Key, "boolean"> & {
  readonly mappedValue: boolean;
};
type EnumOption<Key extends string = string> = ValueOptionBase<Key, "enum"> & {
  readonly values: readonly string[];
};
type RepeatOption<Key extends string = string> = ValueOptionBase<Key, "repeat">;
type InputOption = StringOption | IntegerOption | BooleanOption | EnumOption | RepeatOption;

interface GlobalOption<Type extends "global" | "global-integer"> {
  readonly type: Type;
  readonly forwardFlag: "--session-file" | "--inline-result-limit";
  readonly value: string;
  readonly description: string;
  readonly min?: number;
  readonly max?: number;
}

type DirectOption = InputOption | GlobalOption<"global"> | GlobalOption<"global-integer">;
type DirectOptionMap = Readonly<Record<string, DirectOption>>;

interface PositionSpec<Key extends string = string> {
  readonly key: Key;
  readonly label: string;
  readonly required: boolean;
  readonly description: string;
}

interface DirectCommandSpec {
  readonly command: string;
  readonly purpose: string;
  readonly position?: PositionSpec;
  readonly fixedInput?: Readonly<CommandInput>;
  readonly options: Readonly<Record<`--${string}`, InputOption>>;
  readonly stateFile?: boolean;
  readonly sessionId?: boolean;
  readonly outputLimit?: boolean;
  readonly examples?: readonly string[];
}

interface JsonCommandSpec {
  readonly command: string;
  readonly purpose: string;
  readonly inputRequired: boolean;
}

const STATE_FILE_OPTION: GlobalOption<"global"> = {
  type: "global",
  forwardFlag: "--session-file",
  value: "<path>",
  description: "Path to the persisted workspace state file.",
};

const MAX_INLINE_BYTES_OPTION: GlobalOption<"global-integer"> = {
  type: "global-integer",
  forwardFlag: "--inline-result-limit",
  value: "<bytes>",
  description: "Maximum inline Markdown bytes from 0 to 10000; 0 forces a complete JSON sidecar.",
  min: 0,
  max: 10000,
};

function stringOption<Key extends string>(key: Key, value: string, description: string): StringOption<Key> {
  return { key, type: "string", value, description };
}

function integerOption<Key extends string>(
  key: Key,
  value: string,
  description: string,
  bounds: Readonly<Pick<IntegerOption<Key>, "min" | "max">> = {},
): IntegerOption<Key> {
  return { key, type: "integer", value, description, ...bounds };
}

function booleanOption<Key extends string>(
  key: Key,
  description: string,
  mappedValue = true,
): BooleanOption<Key> {
  return { key, type: "boolean", description, mappedValue };
}

function enumOption<Key extends string, Value extends string>(
  key: Key,
  values: readonly Value[],
  description: string,
): EnumOption<Key> & { readonly values: readonly Value[] } {
  return { key, type: "enum", value: `<${values.join("|")}>`, values, description };
}

function repeatOption<Key extends string>(key: Key, value: string, description: string): RepeatOption<Key> {
  return { key, type: "repeat", value, description };
}

function fileContextOptions() {
  return {
    "--file": stringOption("file", "<url-or-key>", "Explicit Figma file URL or key."),
    "--workspace": stringOption("workspaceDir", "<path>", "Absolute local workspace root."),
    "--refresh": booleanOption("refresh", "Refresh upstream data when supported."),
  } as const;
}

const SCRIPT_NAMES_BY_TRANSPORT_COMMAND = {
  "get-metadata": "metadata",
  "get-design-context": "design-context",
  "get-motion-context": "motion-context",
  "get-variable-defs": "variables",
} as const satisfies Readonly<Record<string, string>>;

function npmScriptForCommand(command: string): string {
  return hasOwn(SCRIPT_NAMES_BY_TRANSPORT_COMMAND, command)
    ? SCRIPT_NAMES_BY_TRANSPORT_COMMAND[command]
    : command;
}

function targetSpec(
  command: string,
  purpose: string,
  extraOptions: Readonly<Record<`--${string}`, InputOption>> = {},
): DirectCommandSpec {
  return {
    command,
    purpose,
    sessionId: true,
    stateFile: true,
    outputLimit: true,
    position: {
      key: "target",
      label: "target",
      required: false,
      description: "Node id, node URL, or $handle. A node-scoped --file URL can supply the target instead.",
    },
    options: { ...fileContextOptions(), ...extraOptions },
    examples: [`npm --silent run figma:${npmScriptForCommand(command)} -- '$hero' --session-id default`],
  };
}

export const FIGMA_DIRECT_COMMANDS = {
  guidance: {
    command: "guidance",
    purpose: "Get task-oriented workflow guidance from a direct keyword query.",
    position: { key: "query", label: "query", required: true, description: "Compact planning keywords." },
    options: {
      "--mode": enumOption("mode", ["guidance", "plan"], "Guidance mode. Use the JSON escape hatch for card or catalog mode."),
      "--surface": enumOption("surface", ["design", "figjam", "slides"], "Expected Figma surface."),
      "--workflow": stringOption("workflow", "<id>", "Optional workflow id."),
      "--card-limit": integerOption("maxCards", "<n>", "Maximum returned cards from 1 to 8.", { min: 1, max: 8 }),
    },
    outputLimit: true,
    examples: ['npm --silent run figma:guidance -- "text font loadFontAsync" --surface design'],
  },
  "docs:list": {
    command: "docs", purpose: "List canonical project Markdown topics.", options: {}, outputLimit: true,
    examples: ["npm --silent run figma:docs:list"],
  },
  "docs:read": {
    command: "docs", purpose: "Read one complete canonical project Markdown topic.",
    position: { key: "topic", label: "topic", required: true, description: "Topic returned by figma:docs:list." },
    options: {}, outputLimit: true, examples: ["npm --silent run figma:docs:read -- workflow"],
  },
  "docs:search": {
    command: "lookup", purpose: "Search project and upstream workflow documentation.", fixedInput: { kind: "docs" },
    position: { key: "query", label: "query", required: true, description: "Documentation search text." },
    options: {
      "--limit": integerOption("maxResults", "<n>", "Maximum returned snippets from 1 to 10.", { min: 1, max: 10 }),
      "--snippet-lines": integerOption("maxSnippetLines", "<n>", "Maximum lines per snippet from 1 to 8.", { min: 1, max: 8 }),
    },
    outputLimit: true, examples: ['npm --silent run figma:docs:search -- "session handles recovery" --limit 5'],
  },
  "api:search": {
    command: "lookup", purpose: "Search exact or near-exact Figma Plugin API symbol documentation.", fixedInput: { kind: "api" },
    position: { key: "symbol", label: "symbol", required: true, description: "Plugin API symbol or search text." },
    options: {
      "--limit": integerOption("maxResults", "<n>", "Maximum returned snippets from 1 to 10.", { min: 1, max: 10 }),
      "--snippet-lines": integerOption("maxSnippetLines", "<n>", "Maximum lines per snippet from 1 to 8.", { min: 1, max: 8 }),
    },
    outputLimit: true, examples: ["npm --silent run figma:api:search -- createFrame"],
  },
  doctor: {
    command: "doctor", purpose: "Inspect project-doc, lookup-corpus, and TypeScript runtime availability.",
    options: {}, outputLimit: true, examples: ["npm --silent run figma:doctor"],
  },
  "sessions:list": {
    command: "sessions", purpose: "List compact persisted session summaries.", options: {}, stateFile: true,
    outputLimit: true, examples: ['npm --silent run figma:sessions:list -- --state-file "C:\\work\\figma-state.json"'],
  },
  "sessions:read": {
    command: "sessions", purpose: "Read one persisted session with optional handles and history.",
    position: { key: "sessionId", label: "session-id", required: true, description: "Exact persisted session id." },
    options: {
      "--with-handles": booleanOption("includeHandles", "Include the full handle map."),
      "--with-history": booleanOption("includeHistory", "Include full history entries."),
    },
    stateFile: true, outputLimit: true, examples: ["npm --silent run figma:sessions:read -- default --with-handles"],
  },
  "upstream:list": {
    command: "upstream-tools", purpose: "List the live official Figma upstream tool directory.",
    options: { "--refresh": booleanOption("refresh", "Refresh upstream discovery before reading.") },
    outputLimit: true, examples: ["npm --silent run figma:upstream:list -- --refresh"],
  },
  "upstream:read": {
    command: "upstream-tools", purpose: "Read one live official upstream tool description and input schema.",
    position: { key: "name", label: "name", required: true, description: "Exact official upstream tool name." },
    options: { "--refresh": booleanOption("refresh", "Refresh upstream discovery before reading.") },
    outputLimit: true, examples: ["npm --silent run figma:upstream:read -- whoami --refresh"],
  },
  inspect: {
    command: "inspect", purpose: "Inspect or validate a target using direct positional syntax.",
    sessionId: true, stateFile: true, outputLimit: true,
    position: { key: "target", label: "target", required: false, description: "Node id, node URL, or $handle." },
    options: {
      "--mode": enumOption("mode", ["inspect", "validate", "style"], "Inspection mode."),
      "--depth": integerOption("depth", "<n>", "Positive traversal depth.", { min: 1 }),
      "--handle": repeatOption("handles", "<name>", "Handle name or node id to validate; repeat as needed."),
    },
    examples: ["npm --silent run figma:inspect -- '$hero' --mode validate --session-id default"],
  },
  metadata: targetSpec("get-metadata", "Read broad Figma metadata for an optional target."),
  "design-context": targetSpec("get-design-context", "Read official design implementation context.", {
    "--force-code": booleanOption("forceCode", "Force code generation when supported."),
    "--no-code-connect": booleanOption("disableCodeConnect", "Disable Code Connect context."),
    "--exclude-screenshot": booleanOption("excludeScreenshot", "Exclude screenshots from context."),
  }),
  "motion-context": targetSpec("get-motion-context", "Read official motion context.", {
    "--recursive": booleanOption("recursive", "Include recursive motion context."),
  }),
  variables: targetSpec("get-variable-defs", "Read variable definitions for a target."),
  "design-system": {
    command: "search-design-system", purpose: "Search official design-system components, variables, and styles.",
    sessionId: true, stateFile: true, outputLimit: true,
    position: { key: "query", label: "query", required: true, description: "Design-system search text." },
    options: {
      ...fileContextOptions(),
      "--components": booleanOption("includeComponents", "Include components."),
      "--no-components": booleanOption("includeComponents", "Exclude components.", false),
      "--variables": booleanOption("includeVariables", "Include variables."),
      "--no-variables": booleanOption("includeVariables", "Exclude variables.", false),
      "--styles": booleanOption("includeStyles", "Include styles."),
      "--no-styles": booleanOption("includeStyles", "Exclude styles.", false),
      "--no-code-connect": booleanOption("disableCodeConnect", "Disable Code Connect context."),
      "--library": repeatOption("includeLibraryKeys", "<key>", "Include one library key; repeat as needed."),
    },
    examples: ['npm --silent run figma:design-system -- "button primary" --components --variables'],
  },
  libraries: {
    command: "get-libraries", purpose: "List available Figma libraries.",
    sessionId: true, stateFile: true, outputLimit: true,
    options: { ...fileContextOptions(), "--offset": integerOption("offset", "<n>", "Non-negative pagination offset.", { min: 0 }) },
    examples: ["npm --silent run figma:libraries -- --session-id default"],
  },
} as const satisfies Readonly<Record<string, DirectCommandSpec>>;

export type FigmaDirectCommandName = keyof typeof FIGMA_DIRECT_COMMANDS;

export const FIGMA_JSON_COMMANDS = {
  open: { command: "open", purpose: "Create or reopen persisted Figma workspace context.", inputRequired: false },
  eval: { command: "eval", purpose: "Run a small native Plugin API transaction.", inputRequired: true },
  "script:run": { command: "run-script-file", purpose: "Preflight and execute a local .figma.ts file.", inputRequired: true },
  "assets:apply": { command: "apply-asset-manifest", purpose: "Apply a prepared local asset manifest.", inputRequired: true },
  "assets:download": { command: "download-assets", purpose: "Download official Figma assets to local files.", inputRequired: true },
  capture: { command: "capture-node", purpose: "Capture a Figma node to a local PNG file.", inputRequired: true },
  "task:run": { command: "run-task-plan", purpose: "Execute a prepared multi-step task plan.", inputRequired: true },
  "task:prepare": { command: "prepare-task", purpose: "Create a repairable local .figma.ts task workspace.", inputRequired: true },
  "upstream:call": { command: "call-upstream-tool", purpose: "Invoke one uncovered official upstream capability.", inputRequired: true },
} as const satisfies Readonly<Record<string, JsonCommandSpec>>;

export type FigmaJsonCommandName = keyof typeof FIGMA_JSON_COMMANDS;

export const FIGMA_COMMAND_FAMILIES = {
  docs: ["docs:list", "docs:read", "docs:search"],
  api: ["api:search"],
  sessions: ["sessions:list", "sessions:read"],
  upstream: ["upstream:list", "upstream:read", "upstream:call"],
} as const satisfies Readonly<Record<string, readonly (FigmaDirectCommandName | FigmaJsonCommandName)[]>>;

export type FigmaCommandFamily = keyof typeof FIGMA_COMMAND_FAMILIES;
export type FigmaCommandName = FigmaDirectCommandName | FigmaJsonCommandName | FigmaCommandFamily;

export async function runFigmaCommandCli(
  argv: readonly string[],
  dependencies: FigmaCommandRuntimeDependencies = {},
): Promise<number> {
  const commandName = argv[0];
  if (commandName === undefined || isHelpToken(commandName)) {
    writer(dependencies.writeStdout, process.stdout.write.bind(process.stdout))(formatRootHelp());
    return EXIT_SUCCESS;
  }
  return runFigmaCommand(commandName, argv.slice(1), dependencies);
}

export async function runFigmaCommand(
  commandName: string,
  argv: readonly string[],
  dependencies: FigmaCommandRuntimeDependencies = {},
): Promise<number> {
  const writeStdout = writer(dependencies.writeStdout, process.stdout.write.bind(process.stdout));
  const writeStderr = writer(dependencies.writeStderr, process.stderr.write.bind(process.stderr));

  if (isCommandFamily(commandName)) {
    if (argv.length === 0 || argv.some(isHelpFlag) || (argv.length === 1 && argv[0] === "help")) {
      writeStdout(formatFamilyHelp(commandName));
      return EXIT_SUCCESS;
    }
    writeStderr(`Unknown figma ${commandName} family argument: ${argv[0]}\n\n${formatFamilyHelp(commandName)}`);
    return EXIT_USAGE;
  }

  if (isDirectCommand(commandName)) {
    const spec: DirectCommandSpec = FIGMA_DIRECT_COMMANDS[commandName];
    if (argv.some(isHelpFlag)) {
      writeStdout(formatDirectHelp(commandName, spec));
      return EXIT_SUCCESS;
    }
    try {
      const parsed = parseDirectArguments(commandName, spec, argv);
      const runCli = dependencies.runCli ?? runFigmaWorkspaceCli;
      return await runCli(
        [spec.command, "--input", "-", ...parsed.globalArgs],
        { io: createMappedIo(parsed.input, dependencies) },
      );
    } catch (error) {
      writeStderr(`${formatError(error)}\n\n${formatDirectHelp(commandName, spec)}`);
      return EXIT_USAGE;
    }
  }

  if (isJsonCommand(commandName)) {
    const spec: JsonCommandSpec = FIGMA_JSON_COMMANDS[commandName];
    if (argv.some(isHelpFlag)) {
      writeStdout(formatJsonHelp(commandName, spec));
      return EXIT_SUCCESS;
    }
    try {
      const forwardedArgs = parseJsonArguments(commandName, spec, argv);
      return await (dependencies.runCli ?? runFigmaWorkspaceCli)([spec.command, ...forwardedArgs]);
    } catch (error) {
      writeStderr(`${formatError(error)}\n\n${formatJsonHelp(commandName, spec)}`);
      return EXIT_USAGE;
    }
  }

  writeStderr(`Unknown Figma command: ${commandName}\n\n${formatRootHelp()}`);
  return EXIT_USAGE;
}

export interface ParsedDirectArguments {
  readonly input: CommandInput;
  readonly globalArgs: readonly string[];
}

export function parseDirectArguments(
  commandName: string,
  spec: DirectCommandSpec,
  argv: readonly string[],
): ParsedDirectArguments {
  const input: CommandInput = { ...(spec.fixedInput ?? {}) };
  const globalArgs: string[] = [];
  const options = directOptions(spec);
  const seenKeys = new Set<string>();
  let positionalSeen = false;
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === undefined) continue;
    if (token.startsWith("-")) {
      const option = options[token];
      if (option === undefined) throw new Error(`Unknown option for figma ${commandName}: ${token}`);
      if (option.type === "boolean") {
        if (seenKeys.has(option.key)) throw new Error(`Duplicate option for figma ${commandName}: ${token}`);
        seenKeys.add(option.key);
        input[option.key] = option.mappedValue;
        continue;
      }
      const value = argv[index + 1];
      if (value === undefined || value.startsWith("--")) throw new Error(`Option ${token} requires ${option.value}.`);
      index += 1;
      if (option.type === "global" || option.type === "global-integer") {
        if (seenKeys.has(token)) throw new Error(`Duplicate option for figma ${commandName}: ${token}`);
        seenKeys.add(token);
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
    if (spec.position === undefined) throw new Error(`Unexpected argument for figma ${commandName}: ${token}`);
    if (positionalSeen) {
      throw new Error(`figma ${commandName} accepts one <${spec.position.label}> argument; quote multi-word values.`);
    }
    input[spec.position.key] = token;
    positionalSeen = true;
  }
  if (spec.position?.required === true && !positionalSeen) {
    throw new Error(`Missing required <${spec.position.label}> for figma ${commandName}.`);
  }
  return { input, globalArgs };
}

export function parseJsonArguments(
  commandName: string,
  spec: JsonCommandSpec,
  argv: readonly string[],
): readonly string[] {
  const options = {
    "--input": { type: "forward", forwardFlag: "--input", value: "<json-file|->" },
    "--state-file": STATE_FILE_OPTION,
    "--max-inline-bytes": MAX_INLINE_BYTES_OPTION,
  } as const;
  const forwardedArgs: string[] = [];
  const seen = new Set<string>();
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === undefined || !hasOwn(options, token)) throw new Error(`Unknown option for figma ${commandName}: ${token}`);
    const option = options[token];
    if (seen.has(token)) throw new Error(`Duplicate option for figma ${commandName}: ${token}`);
    const value = argv[index + 1];
    if (value === undefined || value.startsWith("--")) throw new Error(`Option ${token} requires ${option.value}.`);
    seen.add(token);
    const forwardedValue = option.type === "global-integer" ? String(parseIntegerOption(option, value, token)) : value;
    forwardedArgs.push(option.forwardFlag, forwardedValue);
    index += 1;
  }
  if (spec.inputRequired && !seen.has("--input")) throw new Error(`figma ${commandName} requires --input <json-file|->.`);
  return forwardedArgs;
}

function directOptions(spec: DirectCommandSpec): DirectOptionMap {
  return {
    ...(spec.stateFile === true ? { "--state-file": STATE_FILE_OPTION } : {}),
    ...(spec.sessionId === true
      ? { "--session-id": stringOption("sessionId", "<id>", "Logical workspace session id.") }
      : {}),
    ...(spec.outputLimit === true ? { "--max-inline-bytes": MAX_INLINE_BYTES_OPTION } : {}),
    ...spec.options,
  };
}

function assignOptionValue(input: CommandInput, option: InputOption, value: string, token: string): void {
  switch (option.type) {
    case "integer": input[option.key] = parseIntegerOption(option, value, token); return;
    case "enum":
      if (!option.values.some((candidate) => candidate === value)) {
        throw new Error(`Option ${token} must be one of: ${option.values.join(", ")}.`);
      }
      input[option.key] = value;
      return;
    case "repeat": {
      const current = input[option.key];
      if (current === undefined) input[option.key] = [value];
      else if (Array.isArray(current)) current.push(value);
      else throw new Error(`Option ${token} cannot be combined with a non-list value.`);
      return;
    }
    case "string": input[option.key] = value; return;
    case "boolean": input[option.key] = option.mappedValue;
  }
}

function parseIntegerOption(
  option: Readonly<{ min?: number; max?: number }>,
  value: string,
  token: string,
): number {
  if (!/^-?\d+$/u.test(value)) throw new Error(`Option ${token} requires an integer.`);
  const parsed = Number.parseInt(value, 10);
  if (!Number.isSafeInteger(parsed)) throw new Error(`Option ${token} requires a safe integer.`);
  if (option.min !== undefined && parsed < option.min) throw new Error(`Option ${token} must be at least ${option.min}.`);
  if (option.max !== undefined && parsed > option.max) throw new Error(`Option ${token} must be at most ${option.max}.`);
  return parsed;
}

function createMappedIo(input: CommandInput, dependencies: FigmaCommandRuntimeDependencies): FigmaWorkspaceCliIo {
  return {
    cwd: dependencies.cwd ?? (() => process.cwd()),
    env: dependencies.env ?? ((name) => process.env[name]),
    readFile: dependencies.readFile ?? ((path) => readFile(path, "utf8")),
    readStdin: async () => JSON.stringify(input),
    writeStdout: writer(dependencies.writeStdout, process.stdout.write.bind(process.stdout)),
    writeStderr: writer(dependencies.writeStderr, process.stderr.write.bind(process.stderr)),
  };
}

export function formatDirectHelp(commandName: string, spec: DirectCommandSpec): string {
  const usagePosition = spec.position === undefined
    ? ""
    : ` ${spec.position.required ? `<${spec.position.label}>` : `[${spec.position.label}]`}`;
  const lines = [
    `# figma ${commandName} help`, "", "## Purpose", spec.purpose, "", "## Usage",
    `- \`npm --silent run figma -- ${commandName}${usagePosition} [options]\``,
    `- \`npm --silent run figma:${commandName} --${usagePosition} [options]\``,
  ];
  if (spec.position !== undefined) {
    lines.push("", "## Arguments", `- \`<${spec.position.label}>\`: ${spec.position.description}`);
  }
  lines.push("", "## Options", "- `-h`, `--help`: Show this command help without running Figma.");
  for (const [flag, option] of Object.entries(directOptions(spec))) {
    const value = "value" in option ? ` ${option.value}` : "";
    lines.push(`- \`${flag}${value}\`: ${option.description}`);
  }
  lines.push("", "## Output", "Restricted Markdown on stdout. Follow `outputFiles.cliResultFile` for an oversized complete JSON result.");
  if (spec.examples !== undefined && spec.examples.length > 0) {
    lines.push("", "## Examples", ...spec.examples.map((example) => `- \`${example}\``));
  }
  return `${lines.join("\n")}\n`;
}

export function formatFamilyHelp(family: FigmaCommandFamily): string {
  const commands = FIGMA_COMMAND_FAMILIES[family];
  return [
    `# figma ${family} help`, "", "## Purpose", `Browse the figma ${family} command family.`, "", "## Commands",
    ...commands.map((commandName) => `- \`npm --silent run figma -- ${commandName} --help\``), "",
    "## NPM Scripts", ...commands.map((commandName) => `- \`npm --silent run figma:${commandName} -- --help\``), "",
    "## Help", "Use `-h` or `--help` on a concrete command before first use.", "",
  ].join("\n");
}

export function formatJsonHelp(commandName: string, spec: JsonCommandSpec): string {
  const inputUsage = spec.inputRequired ? " --input <json-file|->" : " [--input <json-file|->]";
  return [
    `# figma ${commandName} help`, "", "## Purpose", spec.purpose, "", "## Usage",
    `- \`npm --silent run figma -- ${commandName}${inputUsage} [options]\``,
    `- \`npm --silent run figma:${commandName} --${inputUsage} [options]\``, "", "## Options",
    "- `--input <json-file|->`: Read the command JSON object from a file or stdin.",
    "- `--state-file <path>`: Path to the persisted workspace state file.",
    "- `--max-inline-bytes <bytes>`: Maximum inline Markdown bytes from 0 to 10000; 0 forces a complete JSON sidecar.",
    "- `-h`, `--help`: Show this command help without running Figma.", "", "## JSON Schema",
    `Run \`npm --silent run figma:raw -- ${spec.command} --help\` only when the complete transport-level input schema is needed.`, "",
    "## Output", "Restricted Markdown on stdout. Follow `outputFiles.cliResultFile` for an oversized complete JSON result.", "",
  ].join("\n");
}

export function formatRootHelp(): string {
  return [
    "# Figma command CLI help", "", "## Usage",
    "- `npm --silent run figma -- <command> [arguments] [options]`", "", "## Command families",
    ...Object.keys(FIGMA_COMMAND_FAMILIES).map((family) => `- \`npm --silent run figma -- ${family} --help\``), "",
    "## Query and read commands", ...Object.keys(FIGMA_DIRECT_COMMANDS).map((command) => `- \`${command}\``), "",
    "## JSON commands", ...Object.keys(FIGMA_JSON_COMMANDS).map((command) => `- \`${command}\``), "",
    "## Transport schema escape hatch", "- `npm --silent run figma:raw -- <transport-command> --help`", "",
  ].join("\n");
}

function writer(candidate: WriteOutput | undefined, fallback: WriteOutput): WriteOutput {
  return candidate ?? fallback;
}

function hasOwn<ObjectType extends object>(value: ObjectType, key: PropertyKey): key is keyof ObjectType {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function isDirectCommand(value: string): value is FigmaDirectCommandName {
  return hasOwn(FIGMA_DIRECT_COMMANDS, value);
}

function isJsonCommand(value: string): value is FigmaJsonCommandName {
  return hasOwn(FIGMA_JSON_COMMANDS, value);
}

function isCommandFamily(value: string): value is FigmaCommandFamily {
  return hasOwn(FIGMA_COMMAND_FAMILIES, value);
}

function isHelpToken(token: string): boolean {
  return token === "-h" || token === "--help" || token === "help";
}

function isHelpFlag(token: string): boolean {
  return token === "-h" || token === "--help";
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
