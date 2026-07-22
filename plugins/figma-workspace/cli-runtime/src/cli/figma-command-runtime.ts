import { readFile } from "node:fs/promises";
import {
  isFullyQualifiedAbsolutePath,
  getFigmaWorkspaceCommandInputSchema,
  runFigmaWorkspaceCli,
  type FigmaWorkspaceCliCommand,
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
  readonly omitted: OmittedValue;
  readonly repeatable: boolean;
}

type OmittedValue =
  | { readonly state: "required" }
  | { readonly state: "default"; readonly value: string }
  | { readonly state: "unset" };

const UNSET_VALUE = { state: "unset" } as const satisfies OmittedValue;

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
  readonly omitted: OmittedValue;
  readonly repeatable: false;
  readonly min?: number;
  readonly max?: number;
}

type DirectOption = InputOption | GlobalOption<"global"> | GlobalOption<"global-integer">;
type DirectOptionMap = Readonly<Record<string, DirectOption>>;

interface ForwardOption {
  readonly type: "forward";
  readonly forwardFlag: "--input";
  readonly value: string;
  readonly description: string;
  readonly omitted: OmittedValue;
  readonly repeatable: false;
}

interface PositionSpec<Key extends string = string> {
  readonly key: Key;
  readonly label: string;
  readonly omitted: Extract<OmittedValue, { readonly state: "required" | "unset" }>;
  readonly repeatable: false;
  readonly description: string;
}

interface DirectCommandSpec {
  readonly command: string;
  readonly purpose: string;
  readonly position?: PositionSpec;
  readonly fixedInput?: Readonly<CommandInput>;
  readonly options: Readonly<Record<`--${string}`, InputOption>>;
  readonly sessionId?: boolean;
  readonly outputLimit?: boolean;
  readonly examples?: readonly string[];
}

interface JsonCommandSpec {
  readonly command: FigmaWorkspaceCliCommand;
  readonly purpose: string;
  readonly inputRequired: boolean;
}

const STATE_FILE_OPTION: GlobalOption<"global"> = {
  type: "global",
  forwardFlag: "--session-file",
  value: "<path>",
  description: "Fully qualified absolute path to the persisted workspace state file and result-sidecar anchor.",
  omitted: { state: "required" },
  repeatable: false,
};
const STATE_FILE_EXAMPLE = "--state-file C:/work/project/.figma-workspace/state.json";

const MAX_INLINE_BYTES_OPTION: GlobalOption<"global-integer"> = {
  type: "global-integer",
  forwardFlag: "--inline-result-limit",
  value: "<bytes>",
  description: "Maximum inline Markdown bytes from 0 to 10000; 0 forces a complete JSON sidecar.",
  omitted: { state: "default", value: "4096" },
  repeatable: false,
  min: 0,
  max: 10000,
};

const JSON_MAX_INLINE_BYTES_OPTION: GlobalOption<"global-integer"> = {
  ...MAX_INLINE_BYTES_OPTION,
  omitted: { state: "default", value: "input inlineResultLimit when present, otherwise 4096" },
};

const SESSION_ID_OPTION = {
  ...stringOption("sessionId", "<id>", "Logical workspace session id."),
  omitted: { state: "default", value: "the runtime default session" },
} as const satisfies StringOption<"sessionId">;

function stringOption<Key extends string>(key: Key, value: string, description: string): StringOption<Key> {
  return { key, type: "string", value, description, omitted: UNSET_VALUE, repeatable: false };
}

function integerOption<Key extends string>(
  key: Key,
  value: string,
  description: string,
  bounds: Readonly<Pick<IntegerOption<Key>, "min" | "max">> = {},
): IntegerOption<Key> {
  return { key, type: "integer", value, description, omitted: UNSET_VALUE, repeatable: false, ...bounds };
}

function booleanOption<Key extends string>(
  key: Key,
  description: string,
  mappedValue = true,
): BooleanOption<Key> {
  return { key, type: "boolean", description, mappedValue, omitted: UNSET_VALUE, repeatable: false };
}

function enumOption<Key extends string, Value extends string>(
  key: Key,
  values: readonly Value[],
  description: string,
): EnumOption<Key> & { readonly values: readonly Value[] } {
  return {
    key, type: "enum", value: `<${values.join("|")}>`, values, description,
    omitted: UNSET_VALUE, repeatable: false,
  };
}

function repeatOption<Key extends string>(key: Key, value: string, description: string): RepeatOption<Key> {
  return { key, type: "repeat", value, description, omitted: UNSET_VALUE, repeatable: true };
}

function fileContextOptions() {
  return {
    "--file": stringOption("file", "<url-or-key>", "Explicit Figma file URL or key."),
    "--workspace": stringOption("workspaceDir", "<path>", "Absolute local workspace root."),
    "--refresh": booleanOption("refresh", "Refresh upstream data when supported."),
  } as const;
}

export const FIGMA_TASK_FAMILIES = [
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
  "design-editing",
] as const;

export const FIGMA_GUIDANCE_WORKFLOWS = [
  "design-implementation-context",
  "motion-implementation",
] as const;

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
  requiresNodeFile = false,
): DirectCommandSpec {
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
      description: "Raw node id or node URL. A node-scoped --file URL can supply the target instead.",
    },
    options: {
      ...fileContextOptions(),
      ...(requiresNodeFile
        ? { "--file": stringOption("file", "<node-url>", "Figma node URL containing node-id; supplies the required target when the positional target is omitted.") }
        : {}),
      ...extraOptions,
    },
    examples: [`npm --silent run figma:${npmScriptForCommand(command)} -- '12:34' --session-id default ${STATE_FILE_EXAMPLE}`],
  };
}

export const FIGMA_DIRECT_COMMANDS = {
  guidance: {
    command: "guidance",
    purpose: "Get task-oriented workflow guidance from a direct keyword query.",
    position: { key: "query", label: "query", omitted: { state: "required" }, repeatable: false, description: "Compact planning keywords." },
    options: {
      "--surface": enumOption("surface", ["design", "figjam", "slides"], "Expected Figma surface."),
      "--workflow": enumOption("workflow", FIGMA_GUIDANCE_WORKFLOWS, "Existing workflow id used to filter workflow and wrapper summaries."),
      "--card-limit": integerOption("maxCards", "<n>", "Maximum returned cards from 1 to 8.", { min: 1, max: 8 }),
    },
    outputLimit: true,
    examples: [`npm --silent run figma:guidance -- "text font loadFontAsync" --surface design ${STATE_FILE_EXAMPLE}`],
  },
  "docs:list": {
    command: "docs", purpose: "List canonical project Markdown topics.", fixedInput: { mode: "list" }, options: {}, outputLimit: true,
    examples: [`npm --silent run figma:docs:list -- ${STATE_FILE_EXAMPLE}`],
  },
  "docs:catalog": {
    command: "docs", purpose: "Browse canonical task families or filtered canonical document records.", fixedInput: { mode: "catalog" },
    options: {
      "--task-family": enumOption("taskFamily", FIGMA_TASK_FAMILIES, "Canonical task family. Omit to list task-family summaries."),
      "--surface": enumOption("surface", ["design", "figjam", "slides"], "Required canonical document surface."),
      "--classification": enumOption("classification", ["active", "conditional", "router", "examples"], "Canonical document classification."),
      "--limit": integerOption("limit", "<n>", "Maximum returned catalog entries from 1 to 100.", { min: 1, max: 100 }),
    },
    outputLimit: true,
    examples: [`npm --silent run figma:docs:catalog -- --task-family code-connect --surface design --limit 20 ${STATE_FILE_EXAMPLE}`],
  },
  "docs:read": {
    command: "docs", purpose: "Read one complete project or canonical Markdown document.", fixedInput: { mode: "read" },
    position: { key: "id", label: "doc-id", omitted: { state: "required" }, repeatable: false, description: "Stable project: or canonical: id returned by figma:docs:list or figma:docs:catalog." },
    options: {}, outputLimit: true, examples: [`npm --silent run figma:docs:read -- project:workflow ${STATE_FILE_EXAMPLE}`],
  },
  "docs:search": {
    command: "lookup", purpose: "Search project and canonical workflow documentation with automatic task routing.", fixedInput: { kind: "docs", scope: "auto" },
    position: { key: "query", label: "query", omitted: { state: "required" }, repeatable: false, description: "Documentation search text." },
    options: {
      "--scope": {
        ...enumOption("scope", ["auto", "active", "conditional", "router", "examples", "all"], "Documentation lookup scope."),
        omitted: { state: "default", value: "auto" },
      },
      "--surface": enumOption("surface", ["design", "figjam", "slides"], "Required documentation surface."),
      "--task-family": enumOption("taskFamily", FIGMA_TASK_FAMILIES, "Required canonical task family."),
      "--limit": integerOption("maxResults", "<n>", "Maximum returned snippets from 1 to 10.", { min: 1, max: 10 }),
      "--snippet-lines": integerOption("maxSnippetLines", "<n>", "Maximum lines per snippet from 1 to 8.", { min: 1, max: 8 }),
    },
    outputLimit: true, examples: [`npm --silent run figma:docs:search -- "session recovery" --limit 5 ${STATE_FILE_EXAMPLE}`],
  },
  "api:search": {
    command: "lookup", purpose: "Search exact or near-exact Figma Plugin API symbol documentation.", fixedInput: { kind: "api" },
    position: { key: "symbol", label: "symbol", omitted: { state: "required" }, repeatable: false, description: "Plugin API symbol or search text." },
    options: {
      "--limit": integerOption("maxResults", "<n>", "Maximum returned snippets from 1 to 10.", { min: 1, max: 10 }),
      "--snippet-lines": integerOption("maxSnippetLines", "<n>", "Maximum lines per snippet from 1 to 8.", { min: 1, max: 8 }),
    },
    outputLimit: true, examples: [`npm --silent run figma:api:search -- createFrame ${STATE_FILE_EXAMPLE}`],
  },
  doctor: {
    command: "doctor", purpose: "Inspect canonical docs, generated Plugin API index, and TypeScript runtime availability.",
    options: {}, outputLimit: true, examples: [`npm --silent run figma:doctor -- ${STATE_FILE_EXAMPLE}`],
  },
  "sessions:list": {
    command: "sessions", purpose: "List compact persisted session summaries.", options: {},
    outputLimit: true, examples: [`npm --silent run figma:sessions:list -- ${STATE_FILE_EXAMPLE}`],
  },
  "sessions:read": {
    command: "sessions", purpose: "Read one persisted session with optional history.",
    position: { key: "sessionId", label: "session-id", omitted: { state: "required" }, repeatable: false, description: "Exact persisted session id." },
    options: {
      "--with-history": booleanOption("includeHistory", "Include full history entries."),
    },
    outputLimit: true, examples: [`npm --silent run figma:sessions:read -- default --with-history ${STATE_FILE_EXAMPLE}`],
  },
  "upstream:list": {
    command: "upstream-tools", purpose: "List the live official Figma upstream tool directory.",
    options: { "--refresh": booleanOption("refresh", "Refresh upstream discovery before reading.") },
    outputLimit: true, examples: [`npm --silent run figma:upstream:list -- --refresh ${STATE_FILE_EXAMPLE}`],
  },
  "upstream:read": {
    command: "upstream-tools", purpose: "Read one live official upstream tool description and input schema.",
    position: { key: "name", label: "name", omitted: { state: "required" }, repeatable: false, description: "Exact official upstream tool name." },
    options: { "--refresh": booleanOption("refresh", "Refresh upstream discovery before reading.") },
    outputLimit: true, examples: [`npm --silent run figma:upstream:read -- whoami --refresh ${STATE_FILE_EXAMPLE}`],
  },
  inspect: {
    command: "inspect", purpose: "Inspect a target or read a compact style audit using direct positional syntax.",
    sessionId: true, outputLimit: true,
    position: { key: "target", label: "target", omitted: UNSET_VALUE, repeatable: false, description: "Raw node id, node URL, $selection, or $currentPage." },
    options: {
      "--mode": enumOption("mode", ["inspect", "style"], "Inspection mode."),
      "--depth": integerOption("depth", "<n>", "Positive traversal depth.", { min: 1 }),
    },
    examples: [`npm --silent run figma:inspect -- '$selection' --mode inspect --session-id default ${STATE_FILE_EXAMPLE}`],
  },
  metadata: targetSpec("get-metadata", "Read broad Figma metadata for an optional target."),
  "design-context": targetSpec("get-design-context", "Read official design implementation context.", {
    "--force-code": booleanOption("forceCode", "Force code generation when supported."),
    "--no-code-connect": booleanOption("disableCodeConnect", "Disable Code Connect context."),
    "--exclude-screenshot": booleanOption("excludeScreenshot", "Exclude screenshots from context."),
  }, true),
  "motion-context": targetSpec("get-motion-context", "Read official motion context.", {
    "--recursive": booleanOption("recursive", "Include recursive motion context."),
  }, true),
  variables: targetSpec("get-variable-defs", "Read variable definitions for a target.", {}, true),
  "design-system": {
    command: "search-design-system", purpose: "Search official design-system components, variables, and styles.",
    sessionId: true, outputLimit: true,
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
      "--library": repeatOption("includeLibraryKeys", "<key>", "Include one library key; repeat as needed."),
    },
    examples: [`npm --silent run figma:design-system -- "button primary" --components --variables ${STATE_FILE_EXAMPLE}`],
  },
  libraries: {
    command: "get-libraries", purpose: "List available Figma libraries.",
    sessionId: true, outputLimit: true,
    options: { ...fileContextOptions(), "--offset": integerOption("offset", "<n>", "Non-negative pagination offset.", { min: 0 }) },
    examples: [`npm --silent run figma:libraries -- --session-id default ${STATE_FILE_EXAMPLE}`],
  },
} as const satisfies Readonly<Record<string, DirectCommandSpec>>;

export type FigmaDirectCommandName = keyof typeof FIGMA_DIRECT_COMMANDS;

const REQUIRED_NODE_SCOPED_DIRECT_COMMANDS = new Set<FigmaDirectCommandName>([
  "design-context",
  "motion-context",
  "variables",
]);

export const FIGMA_JSON_COMMANDS = {
  open: { command: "open", purpose: "Create or reopen persisted Figma workspace context.", inputRequired: false },
  eval: { command: "eval", purpose: "Run a small native Plugin API transaction with optional queued local captures.", inputRequired: true },
  "script:run": { command: "run-script-file", purpose: "Preflight and execute a local .figma.ts file with optional queued local captures.", inputRequired: true },
  "assets:apply": { command: "apply-asset-manifest", purpose: "Apply a prepared local asset manifest.", inputRequired: true },
  "assets:download": { command: "download-assets", purpose: "Download official Figma assets to local files.", inputRequired: true },
  capture: { command: "capture-node", purpose: "Capture a Figma node to a local PNG file.", inputRequired: true },
  "task:prepare": { command: "prepare-task", purpose: "Create a repairable local .figma.ts task workspace.", inputRequired: true },
  "upstream:call": { command: "call-upstream-tool", purpose: "Invoke one uncovered official upstream capability.", inputRequired: true },
} as const satisfies Readonly<Record<string, JsonCommandSpec>>;

export type FigmaJsonCommandName = keyof typeof FIGMA_JSON_COMMANDS;

export type FigmaConcreteCommandName = FigmaDirectCommandName | FigmaJsonCommandName;

interface FigmaRootHelpGroup {
  readonly title: string;
  readonly commands: readonly FigmaConcreteCommandName[];
}

export const FIGMA_ROOT_HELP_GROUPS = [
  {
    title: "Plan, documentation, and Plugin API lookup",
    commands: ["guidance", "docs:list", "docs:catalog", "docs:read", "docs:search", "api:search", "doctor"],
  },
  {
    title: "Open files and understand existing work",
    commands: ["open", "sessions:list", "sessions:read", "metadata", "inspect"],
  },
  {
    title: "Implementation context and design systems",
    commands: ["design-context", "motion-context", "variables", "design-system", "libraries"],
  },
  {
    title: "Implement, manage assets, and verify",
    commands: ["task:prepare", "script:run", "eval", "assets:apply", "assets:download", "capture"],
  },
  {
    title: "Official capability fallback",
    commands: ["upstream:list", "upstream:read", "upstream:call"],
  },
] as const satisfies readonly FigmaRootHelpGroup[];

export const FIGMA_COMMAND_FAMILIES = {
  docs: ["docs:list", "docs:catalog", "docs:read", "docs:search"],
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
    if (hasDirectHelpFlag(argv)) {
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
      const forwardedArgs = parseJsonArguments(
        commandName,
        spec,
        normalizeNpmForwardedJsonArguments(argv, dependencies.env ?? ((name) => process.env[name])),
      );
      return await (dependencies.runCli ?? runFigmaWorkspaceCli)([spec.command, ...forwardedArgs]);
    } catch (error) {
      writeStderr(`${formatError(error)}\n\n${formatJsonHelp(commandName, spec)}`);
      return EXIT_USAGE;
    }
  }

  writeStderr(`Unknown Figma command: ${commandName}\n\n${formatRootHelp()}`);
  return EXIT_USAGE;
}

function normalizeNpmForwardedJsonArguments(
  argv: readonly string[],
  env: FigmaWorkspaceCliIo["env"],
): readonly string[] {
  if (argv.some((token) => token.startsWith("--"))) return argv;

  const inputForwarded = env("npm_config_input") === "true";
  const stateFileForwarded = env("npm_config_state_file") === "true";
  const maxInlineBytesForwarded = env("npm_config_max_inline_bytes") === "true";
  if (!inputForwarded && !stateFileForwarded && !maxInlineBytesForwarded) return argv;

  const remaining = argv.map((value, index) => ({ value, index }));
  const takeAt = (index: number): string => {
    const [entry] = remaining.splice(index, 1);
    if (entry === undefined) throw new Error("npm removed a JSON command option without forwarding its value.");
    return entry.value;
  };
  const normalized: Array<{ index: number; option: string; value: string }> = [];

  if (inputForwarded) {
    const stdinIndex = remaining.findIndex(({ value }) => value === "-");
    const entry = remaining[stdinIndex >= 0 ? stdinIndex : 0];
    if (entry === undefined) throw new Error("npm removed --input without forwarding its value.");
    normalized.push({ index: entry.index, option: "--input", value: takeAt(stdinIndex >= 0 ? stdinIndex : 0) });
  }

  if (maxInlineBytesForwarded) {
    const integerIndex = remaining.findIndex(({ value }) => /^\d+$/u.test(value));
    const entry = remaining[integerIndex];
    if (entry === undefined) throw new Error("npm removed --max-inline-bytes without forwarding its value.");
    normalized.push({ index: entry.index, option: "--max-inline-bytes", value: takeAt(integerIndex) });
  }

  if (stateFileForwarded) {
    if (remaining.length === 0) throw new Error("npm removed --state-file without forwarding its value.");
    const entry = remaining[remaining.length - 1];
    if (entry === undefined) throw new Error("npm removed --state-file without forwarding its value.");
    normalized.push({ index: entry.index, option: "--state-file", value: takeAt(remaining.length - 1) });
  }

  if (remaining.length > 0) return argv;
  return normalized
    .sort((left, right) => left.index - right.index)
    .flatMap(({ option, value }) => [option, value]);
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
  let positionalOnly = false;
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === undefined) continue;
    if (!positionalOnly && token === "--") {
      positionalOnly = true;
      continue;
    }
    if (!positionalOnly && token.startsWith("-")) {
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
    if (spec.position === undefined) throw new Error(`Unexpected argument for figma ${commandName}: ${token}`);
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
  if (REQUIRED_NODE_SCOPED_DIRECT_COMMANDS.has(commandName as FigmaDirectCommandName)) {
    const file = typeof input.file === "string" ? input.file : undefined;
    const fileSuppliesNode = file !== undefined && isFigmaNodeUrl(file);
    if (positionalSeen === fileSuppliesNode) {
      throw new Error(
        `figma ${commandName} requires exactly one node target: pass <target>, or pass --file with a Figma URL containing node-id.`,
      );
    }
    if (file !== undefined && !fileSuppliesNode) {
      throw new Error(`Option --file for figma ${commandName} must be a Figma URL containing node-id when <target> is omitted.`);
    }
  }
  return { input, globalArgs };
}

function isFigmaNodeUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return (url.hostname === "figma.com" || url.hostname.endsWith(".figma.com"))
      && (url.protocol === "https:" || url.protocol === "http:")
      && (url.searchParams.get("node-id")?.trim() ?? "") !== "";
  } catch {
    return false;
  }
}

export function parseJsonArguments(
  commandName: string,
  spec: JsonCommandSpec,
  argv: readonly string[],
): readonly string[] {
  const options = jsonOptions(spec);
  const forwardedArgs: string[] = [];
  const seen = new Set<string>();
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === "-") {
      if (seen.has("--input")) throw new Error(`Duplicate input for figma ${commandName}.`);
      seen.add("--input");
      forwardedArgs.push("--input", "-");
      continue;
    }
    if (token === undefined || !hasOwn(options, token)) throw new Error(`Unknown option for figma ${commandName}: ${token}`);
    const option = options[token];
    if (seen.has(token)) throw new Error(`Duplicate option for figma ${commandName}: ${token}`);
    const value = argv[index + 1];
    if (value === undefined || value.startsWith("--")) throw new Error(`Option ${token} requires ${option.value}.`);
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

function jsonOptions(spec: JsonCommandSpec) {
  return {
    "--input": {
      type: "forward",
      forwardFlag: "--input",
      value: "<json-file|->",
      description: "Read the command JSON object from a file or stdin.",
      omitted: spec.inputRequired ? { state: "required" } : UNSET_VALUE,
      repeatable: false,
    } satisfies ForwardOption,
    "--state-file": STATE_FILE_OPTION,
    "--max-inline-bytes": JSON_MAX_INLINE_BYTES_OPTION,
  } as const;
}

function directOptions(spec: DirectCommandSpec): DirectOptionMap {
  return {
    "--state-file": STATE_FILE_OPTION,
    ...(spec.sessionId === true
      ? { "--session-id": SESSION_ID_OPTION }
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
    : ` ${spec.position.omitted.state === "required" ? `<${spec.position.label}>` : `[${spec.position.label}]`}`;
  const lines = [
    `# figma ${commandName} help`, "", "## Purpose", spec.purpose, "", "## Usage",
    `- \`npm --silent run figma -- ${commandName}${usagePosition} [options]\``,
    `- \`npm --silent run figma:${commandName} --${usagePosition} [options]\``,
  ];
  if (spec.position !== undefined) {
    lines.push(
      "", "## Arguments",
      `- \`<${spec.position.label}>\`: ${spec.position.description} ${formatOmittedValue(spec.position.omitted)} Repeatable: no.`,
    );
  }
  lines.push("", "## Options", "- `-h`, `--help`: Show this command help without running Figma.");
  for (const [flag, option] of Object.entries(directOptions(spec))) {
    const value = "value" in option ? ` ${option.value}` : "";
    lines.push(`- \`${flag}${value}\`: ${option.description} ${formatOptionMetadata(option)}`);
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
  const lines = [
    `# figma ${commandName} help`, "", "## Purpose", spec.purpose, "", "## Usage",
    `- \`npm --silent run figma -- ${commandName}${inputUsage} [options]\``,
    `- \`npm --silent run figma:${commandName} --${inputUsage} [options]\``, "", "## Options",
  ];
  for (const [flag, option] of Object.entries(jsonOptions(spec))) {
    lines.push(`- \`${flag} ${option.value}\`: ${option.description} ${formatOptionMetadata(option)}`);
  }
  lines.push(
    "- `-h`, `--help`: Show this command help without running Figma.", "", "## Input JSON Schema",
    "```json", JSON.stringify(publicJsonSchema(spec.command), null, 2), "```", "",
    "## Output", "Restricted Markdown on stdout. Follow `outputFiles.cliResultFile` for an oversized complete JSON result.", "",
  );
  return lines.join("\n");
}

const PUBLIC_SCHEMA_COMMAND_REPLACEMENTS: Readonly<Record<string, string>> = {
  figma_workspace_apply_asset_manifest: "figma:assets:apply",
  figma_workspace_call_upstream_tool: "figma:upstream:call",
  figma_workspace_capture_node: "figma:capture",
  figma_workspace_download_assets: "figma:assets:download",
  figma_workspace_eval: "figma:eval",
  figma_workspace_get_design_context: "figma:design-context",
  figma_workspace_get_libraries: "figma:libraries",
  figma_workspace_get_metadata: "figma:metadata",
  figma_workspace_get_motion_context: "figma:motion-context",
  figma_workspace_get_variable_defs: "figma:variables",
  figma_workspace_guidance: "figma:guidance",
  figma_workspace_inspect: "figma:inspect",
  figma_workspace_lookup: "figma:docs:search or figma:api:search",
  figma_workspace_open: "figma:open",
  figma_workspace_prepare_task: "figma:task:prepare",
  figma_workspace_run_script_file: "figma:script:run",
  figma_workspace_search_design_system: "figma:design-system",
  figma_workspace_sessions: "figma:sessions:list or figma:sessions:read",
  figma_workspace_upstream_tools: "figma:upstream:list or figma:upstream:read",
  "apply-asset-manifest": "figma:assets:apply",
  "call-upstream-tool": "figma:upstream:call",
  "capture-node": "figma:capture",
  "download-assets": "figma:assets:download",
  "prepare-task": "figma:task:prepare",
  "run-script-file": "figma:script:run",
  download_assets: "figma:assets:download",
  get_design_context: "figma:design-context",
  get_libraries: "figma:libraries",
  get_metadata: "figma:metadata",
  get_motion_context: "figma:motion-context",
  get_screenshot: "figma:capture",
  get_variable_defs: "figma:variables",
  search_design_system: "figma:design-system",
  upload_assets: "figma:assets:apply",
  use_figma: "native Plugin API execution",
};

function publicJsonSchema(command: FigmaWorkspaceCliCommand): unknown {
  return mapSchemaValue(
    getFigmaWorkspaceCommandInputSchema(command),
    sanitizePublicSchemaText,
  );
}

function mapSchemaValue(value: unknown, mapText: (value: string) => string): unknown {
  if (typeof value === "string") return mapText(value);
  if (Array.isArray(value)) return value.map((entry) => mapSchemaValue(entry, mapText));
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [key, mapSchemaValue(entry, mapText)]),
    );
  }
  return value;
}

function sanitizePublicSchemaText(value: string): string {
  let sanitized = value;
  for (const [internalName, commandId] of Object.entries(PUBLIC_SCHEMA_COMMAND_REPLACEMENTS)) {
    sanitized = sanitized.replaceAll(internalName, commandId);
  }
  return sanitized;
}

function formatOptionMetadata(option: DirectOption | ForwardOption): string {
  const metadata = [formatOmittedValue(option.omitted), `Repeatable: ${option.repeatable ? "yes" : "no"}.`];
  if (option.type === "integer" || option.type === "global-integer") {
    metadata.push(`Range: ${option.min ?? Number.MIN_SAFE_INTEGER} to ${option.max ?? Number.MAX_SAFE_INTEGER}.`);
  }
  if (option.type === "enum") metadata.push(`Allowed: ${option.values.join(", ")}.`);
  return metadata.join(" ");
}

function formatOmittedValue(omitted: OmittedValue): string {
  switch (omitted.state) {
    case "required": return "Required.";
    case "default": return `Default: ${omitted.value}.`;
    case "unset": return "Default: unset.";
  }
}

export function formatRootHelp(): string {
  const lines = [
    "# Figma command CLI help", "", "## Start here",
    "1. Run `npm --silent run figma:help` to open this agent-facing catalog.",
    "2. Select a concrete `figma:*` command below, then run its `--help` before first use.",
    "3. Use `npm --silent run figma -- <command> [arguments] [options]` when an umbrella invocation is more convenient.",
    "", "## Recommended order",
    "1. For non-trivial, generated, or unclear work, start with `figma:guidance`.",
    "2. Find workflow material with `figma:docs:catalog`, `figma:docs:search`, and `figma:docs:read`; find native Plugin API symbols with `figma:api:search`.",
    "3. Establish context with `figma:open`, use `figma:metadata` before targeted `figma:inspect`, then implement and verify with `figma:capture`.",
    "4. For an uncovered official capability, use `figma:upstream:list`, then `figma:upstream:read`, then `figma:upstream:call`.",
    "", "## Discovery entrypoints",
    "- Root: `npm --silent run figma:help` or `npm --silent run figma -- --help`.",
    "- Families: `npm --silent run figma:docs -- --help`, `npm --silent run figma:api -- --help`, `npm --silent run figma:sessions -- --help`, and `npm --silent run figma:upstream -- --help`.",
    "", "## Concrete commands",
  ];

  for (const group of FIGMA_ROOT_HELP_GROUPS) {
    lines.push("", `### ${group.title}`);
    for (const commandName of group.commands) {
      const spec = isDirectCommand(commandName)
        ? FIGMA_DIRECT_COMMANDS[commandName]
        : FIGMA_JSON_COMMANDS[commandName];
      lines.push(`- \`npm --silent run figma:${commandName} -- --help\`: ${spec.purpose}`);
    }
  }

  lines.push("");
  return lines.join("\n");
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

function hasDirectHelpFlag(argv: readonly string[]): boolean {
  for (const token of argv) {
    if (token === "--") return false;
    if (isHelpFlag(token)) return true;
  }
  return false;
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
