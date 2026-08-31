import { lstat, readFile, realpath, stat } from "node:fs/promises";
import { dirname, isAbsolute, resolve } from "node:path";
import {
  runFigmaWorkspaceCli,
  type FigmaWorkspaceCliDependencies,
  type FigmaWorkspaceCliIo,
} from "./figma-workspace-cli.js";
import {
  CAPTURE_MAX_DIMENSION_MAX,
  CAPTURE_MAX_DIMENSION_MIN,
  DOCS_CATALOG_LIMIT_MAX,
  DOCS_CATALOG_LIMIT_MIN,
  INLINE_RESULT_LIMIT_MAX,
  INLINE_RESULT_LIMIT_MIN,
  INSPECT_DEPTH_MAX,
  INSPECT_DEPTH_MIN,
  LIBRARIES_OFFSET_MAX,
  LIBRARIES_OFFSET_MIN,
  LOOKUP_RESULTS_MAX,
  LOOKUP_RESULTS_MIN,
  LOOKUP_SNIPPET_LINES_MAX,
  LOOKUP_SNIPPET_LINES_MIN,
} from "../contract/tool-args.js";
import { isCompositeCapableFigmaNodeId, isFigmaFileKey, isSimpleFigmaNodeId } from "../contract/figma-target.js";

const EXIT_SUCCESS = 0;
const EXIT_USAGE = 2;
const MAX_INPUT_BYTES = 256 * 1024;

type CommandInput = Record<string, unknown>;
type RunWorkspaceCli = (argv: readonly string[], dependencies?: FigmaWorkspaceCliDependencies) => Promise<number>;

export interface FigmaCommandRuntimeDependencies {
  runCli?: RunWorkspaceCli;
  cwd?: FigmaWorkspaceCliIo["cwd"];
  env?: FigmaWorkspaceCliIo["env"];
  readFile?: FigmaWorkspaceCliIo["readFile"];
  readStdin?: FigmaWorkspaceCliIo["readStdin"];
  writeStdout?: (value: string) => void;
  writeStderr?: (value: string) => void;
}

export const FIGMA_TASK_FAMILIES = ["code-connect", "create-file", "design-to-code", "design-generation", "diagram", "library-generation", "motion-implementation", "swiftui", "figjam", "motion", "slides", "design-editing"] as const;

const PUBLIC_COMMANDS = [
  "docs:list", "docs:catalog", "docs:read", "docs:search", "api:read", "api:search",
  "doctor",
  "metadata", "inspect", "design-context", "motion-context", "variables", "design-system", "libraries",
  "run", "capture", "assets:apply", "assets:download",
  "code-connect:inspect", "code-connect:plan", "code-connect:apply", "code-connect:verify",
  "upstream:list", "upstream:read", "upstream:call",
] as const;

export type FigmaConcreteCommandName = typeof PUBLIC_COMMANDS[number];
export type FigmaCommandFamily = "docs" | "api" | "upstream" | "code-connect";
export type FigmaCommandName = FigmaConcreteCommandName | FigmaCommandFamily;

const FAMILY_COMMANDS: Record<FigmaCommandFamily, readonly FigmaConcreteCommandName[]> = {
  docs: ["docs:list", "docs:catalog", "docs:read", "docs:search"],
  api: ["api:read", "api:search"],
  upstream: ["upstream:list", "upstream:read", "upstream:call"],
  "code-connect": ["code-connect:inspect", "code-connect:plan", "code-connect:apply", "code-connect:verify"],
};

export async function runFigmaCommandCli(argv: readonly string[], dependencies: FigmaCommandRuntimeDependencies = {}): Promise<number> {
  if (argv.length === 0 || argv[0] === "--help" || argv[0] === "-h" || argv[0] === "help") {
    write(dependencies.writeStdout, false)(formatRootHelp());
    return EXIT_SUCCESS;
  }
  return runFigmaCommand(argv[0]!, argv.slice(1), dependencies);
}

export async function runFigmaCommand(
  commandName: string,
  argv: readonly string[],
  dependencies: FigmaCommandRuntimeDependencies = {},
): Promise<number> {
  const stdout = write(dependencies.writeStdout, false);
  const stderr = write(dependencies.writeStderr, true);
  if (isFamily(commandName)) {
    if (argv.length === 0 || argv.every(isHelp)) { stdout(formatFamilyHelp(commandName)); return EXIT_SUCCESS; }
    stderr(`Unknown figma:${commandName}:help argument: ${argv[0]}\n\n${formatFamilyHelp(commandName)}`); return EXIT_USAGE;
  }
  if (!isPublicCommand(commandName)) {
    stderr(`Unknown Figma command: ${commandName}\n\n${formatRootHelp()}`); return EXIT_USAGE;
  }
  if (argv.some(isHelp)) { stdout(formatCommandHelp(commandName)); return EXIT_SUCCESS; }
  try {
    const parsed = await parsePublicArguments(commandName, argv, dependencies);
    normalizeExplicitPaths(commandName, parsed.input, dependencies.cwd?.() ?? process.cwd());
    assertStrictFigmaReferences(commandName, parsed.input);
    return await invoke(parsed.internalCommand, parsed.input, dependencies, parsed.inlineResultLimit);
  } catch (error) {
    stderr(`${formatError(error)}\n\n${formatCommandHelp(commandName)}`);
    return EXIT_USAGE;
  }
}

interface ParsedPublicCommand {
  internalCommand: Parameters<typeof invoke>[0];
  input: CommandInput;
  inlineResultLimit?: number;
}

async function parsePublicArguments(
  command: FigmaConcreteCommandName,
  argv: readonly string[],
  dependencies: FigmaCommandRuntimeDependencies,
): Promise<ParsedPublicCommand> {
  if (command === "docs:list") return noArgs("docs", { mode: "list" }, argv);
  if (command === "doctor") return noArgs("doctor", {}, argv);
  if (command === "docs:catalog") {
    const { positionals, options } = parseTokens(argv, optionSet("task-family", "surface", "classification", "limit"));
    assertNoPositionals(positionals);
    return { internalCommand: "docs", input: clean({ mode: "catalog", taskFamily: options["task-family"], surface: options.surface, classification: options.classification, limit: clampableInteger(options.limit, "--limit") }) };
  }
  if (command === "docs:read") {
    const { positionals } = parseTokens(argv, optionSet()); requirePositionals(positionals, 1, "doc-id");
    return { internalCommand: "docs", input: { mode: "read", id: positionals[0] } };
  }
  if (command === "api:read") {
    const { positionals } = parseTokens(argv, optionSet()); requirePositionals(positionals, 1, "api-id");
    return { internalCommand: "lookup", input: { kind: "api", apiId: positionals[0] } };
  }
  if (command === "docs:search" || command === "api:search") {
    const names = command === "docs:search" ? optionSet("scope", "surface", "task-family", "limit", "snippet-lines") : optionSet("limit", "snippet-lines");
    const { positionals, options } = parseTokens(argv, names); requirePositionals(positionals, 1, command === "docs:search" ? "query" : "symbol");
    return { internalCommand: "lookup", input: clean({ kind: command === "docs:search" ? "docs" : "api", [command === "docs:search" ? "query" : "symbol"]: positionals[0], scope: options.scope, surface: options.surface, taskFamily: options["task-family"], maxResults: clampableInteger(options.limit, "--limit"), maxSnippetLines: clampableInteger(options["snippet-lines"], "--snippet-lines") }) };
  }
  if (command === "run") return parseRun(argv, dependencies);
  if (command === "capture") return parseCapture(argv);
  if (command.startsWith("code-connect:")) return parseCodeConnect(command as Extract<FigmaConcreteCommandName, `code-connect:${string}`>, argv, dependencies);
  if (command === "assets:apply" || command === "assets:download" || command === "upstream:call") return parseJsonLeaf(command, argv, dependencies);
  if (command === "upstream:list") {
    const { positionals, flags } = parseTokens(argv, optionSet(), flagSet("refresh")); assertNoPositionals(positionals);
    return { internalCommand: "upstream-tools", input: clean({ refresh: flags.has("refresh") ? true : undefined }) };
  }
  if (command === "upstream:read") {
    const { positionals, flags } = parseTokens(argv, optionSet(), flagSet("refresh")); requirePositionals(positionals, 1, "name");
    return { internalCommand: "upstream-tools", input: clean({ name: positionals[0], refresh: flags.has("refresh") ? true : undefined }) };
  }
  return parseReadLeaf(command as Exclude<FigmaConcreteCommandName, "docs:list" | "docs:catalog" | "docs:read" | "docs:search" | "api:read" | "api:search" | "doctor" | "run" | "capture" | "assets:apply" | "assets:download" | `code-connect:${string}` | "upstream:list" | "upstream:read" | "upstream:call">, argv);
}

async function parseCodeConnect(
  command: Extract<FigmaConcreteCommandName, `code-connect:${string}`>,
  argv: readonly string[],
  dependencies: FigmaCommandRuntimeDependencies,
): Promise<ParsedPublicCommand> {
  const common = optionSet("file", "surface", "output-dir", "max-inline-bytes");
  if (command === "code-connect:inspect") {
    const { positionals, options } = parseTokens(argv, common);
    assertNoPositionals(positionals);
    return codeConnectDirect("code-connect-inspect", requireCodeConnectFile(options, command), options);
  }
  if (command === "code-connect:plan") {
    const { positionals, options } = parseTokens(argv, optionSet("file", "surface", "input", "output-plan", "output-dir", "max-inline-bytes"));
    assertNoPositionals(positionals);
    if (!options.input) throw new Error("--input <manifest.json|-> is required.");
    const manifest = await readJsonObjectInput(options.input, dependencies, "--input");
    const outputPlanPath = options["output-plan"];
    return codeConnectDirect("code-connect-plan", {
      ...requireCodeConnectFile(options, command),
      manifest,
      outputPlanPath,
      ...(outputPlanPath && !options["output-dir"] ? { outputDir: dirname(resolve(dependencies.cwd?.() ?? process.cwd(), outputPlanPath)) } : {}),
    }, options);
  }
  if (command === "code-connect:apply") {
    const { positionals, options } = parseTokens(argv, optionSet("file", "surface", "plan", "confirm-plan", "output-dir", "max-inline-bytes"));
    assertNoPositionals(positionals);
    if (!options.plan) throw new Error("--plan <path> is required.");
    return codeConnectDirect("code-connect-apply", {
      ...requireCodeConnectFile(options, command),
      planPath: options.plan,
      confirmPlan: options["confirm-plan"],
    }, options);
  }
  const { positionals, options } = parseTokens(argv, optionSet("file", "surface", "plan", "output-dir", "max-inline-bytes"));
  assertNoPositionals(positionals);
  if (!options.plan) throw new Error("--plan <path> is required.");
  return codeConnectDirect("code-connect-verify", {
    ...requireCodeConnectFile(options, command),
    planPath: options.plan,
  }, options);
}

function requireCodeConnectFile(
  options: Record<string, string | undefined>,
  command: string,
): CommandInput {
  if (!options.file) throw new Error("--file <Design URL|fileKey> is required.");
  if (options.surface !== undefined && options.surface !== "design") throw new Error(`${command} supports only --surface design.`);
  if (isFigmaUrl(options.file)) {
    const kind = new URL(options.file).pathname.split("/").filter(Boolean)[0];
    if (kind !== "design" && kind !== "file") throw new Error(`${command} requires a Design URL.`);
  } else if (options.surface !== "design") {
    throw new Error(`${command} with a raw file key requires --surface design.`);
  }
  return clean({ file: options.file, surface: options.surface, outputDir: options["output-dir"] });
}

async function readJsonObjectInput(
  value: string,
  dependencies: FigmaCommandRuntimeDependencies,
  option: string,
): Promise<CommandInput> {
  const source = value === "-"
    ? await readRawStdin(dependencies, MAX_INPUT_BYTES)
    : await readBoundedText(
      (dependencies.readFile ?? defaultReadFile)(resolve(dependencies.cwd?.() ?? process.cwd(), value), MAX_INPUT_BYTES),
      MAX_INPUT_BYTES,
    );
  let parsed: unknown;
  try { parsed = JSON.parse(source); } catch (error) { throw new Error(`${option} must contain valid JSON: ${formatError(error)}`); }
  if (!isRecord(parsed)) throw new Error(`${option} JSON must be an object.`);
  return parsed;
}

async function parseRun(argv: readonly string[], dependencies: FigmaCommandRuntimeDependencies): Promise<ParsedPublicCommand> {
  const { positionals, options } = parseTokens(argv, optionSet("file", "surface", "script", "source", "target-page", "output-dir", "max-inline-bytes"));
  assertNoPositionals(positionals);
  const script = options.script;
  const sourceOption = options.source;
  if (!options.file) throw new Error("--file <url|key> is required.");
  if (!isFigmaUrl(options.file) && !options.surface) throw new Error("A raw file key requires --surface design|figjam|slides.");
  if (Boolean(script) === Boolean(sourceOption)) throw new Error("Exactly one of --script or --source - is required.");
  if (sourceOption !== undefined && sourceOption !== "-") throw new Error("--source accepts only '-' and reads TypeScript source from stdin.");
  let scriptPath: string | undefined;
  let source: string | undefined;
  if (script) {
    scriptPath = resolve(dependencies.cwd?.() ?? process.cwd(), script);
    await assertSafeScriptFile(scriptPath);
  } else {
    source = await readRawStdin(dependencies, MAX_INPUT_BYTES);
  }
  return direct("run", clean({ file: options.file, surface: options.surface, scriptPath, source, targetPageId: options["target-page"], outputDir: options["output-dir"] }), options);
}

function parseCapture(argv: readonly string[]): ParsedPublicCommand {
  const { positionals, options, flags } = parseTokens(argv, optionSet("file", "node", "target", "surface", "image-file", "output-dir", "max-dimension", "max-inline-bytes"), flagSet("contents-only"));
  assertNoPositionals(positionals);
  if (options.target && (options.file || options.node)) throw new Error("--target is mutually exclusive with --file/--node.");
  if (!options.target && (!options.file || !options.node)) throw new Error("Pass --target <node-url>, or both --file and --node.");
  return direct("capture-node", clean({ file: options.file, target: options.target ?? options.node, surface: options.surface, imageFile: options["image-file"], outputDir: options["output-dir"], maxDimension: integer(options["max-dimension"], "--max-dimension"), contentsOnly: flags.has("contents-only") ? true : undefined }), options);
}

async function parseJsonLeaf(command: "assets:apply" | "assets:download" | "upstream:call", argv: readonly string[], dependencies: FigmaCommandRuntimeDependencies): Promise<ParsedPublicCommand> {
  const { positionals, options } = parseTokens(argv, optionSet("input", "file", "surface", "output-dir", "max-inline-bytes")); assertNoPositionals(positionals);
  if (!options.input) throw new Error("--input <json-file|-> is required.");
  const source = options.input === "-"
    ? await readRawStdin(dependencies, MAX_INPUT_BYTES)
    : await readBoundedText(
      (dependencies.readFile ?? defaultReadFile)(resolve(dependencies.cwd?.() ?? process.cwd(), options.input), MAX_INPUT_BYTES),
      MAX_INPUT_BYTES,
    );
  let input: unknown; try { input=JSON.parse(source); } catch (error) { throw new Error(`--input must contain valid JSON: ${formatError(error)}`); }
  if (!isRecord(input)) throw new Error("--input JSON must be an object.");
  for (const [key, value] of Object.entries({ file: options.file, surface: options.surface, outputDir: options["output-dir"] })) if (value !== undefined) { if (input[key] !== undefined && input[key] !== value) throw new Error(`Conflicting ${key} in --input and CLI option.`); input[key]=value; }
  if (command === "assets:apply") {
    if (typeof input.file !== "string" || !input.file.trim()) throw new Error("figma:assets:apply requires --file <url|key> or a file field in --input JSON.");
    if (!isFigmaUrl(input.file) && typeof input.surface !== "string") throw new Error("figma:assets:apply with a raw file key requires --surface design|figjam|slides.");
  }
  return direct(command === "assets:apply" ? "apply-asset-manifest" : command === "assets:download" ? "download-assets" : "call-upstream-tool", input, options);
}

function parseReadLeaf(command: Exclude<FigmaConcreteCommandName, "docs:list" | "docs:catalog" | "docs:read" | "docs:search" | "api:read" | "api:search" | "doctor" | "run" | "capture" | "assets:apply" | "assets:download" | `code-connect:${string}` | "upstream:list" | "upstream:read" | "upstream:call">, argv: readonly string[]): ParsedPublicCommand {
  if (command === "design-system") {
    const { positionals, options, flags, repeats } = parseTokens(argv, optionSet("file", "surface", "output-dir", "max-inline-bytes"), flagSet("components", "no-components", "variables", "no-variables", "styles", "no-styles", "no-code-connect", "refresh"), repeatSet("library"));
    requirePositionals(positionals, 1, "query");
    return direct("search-design-system", clean({ file: options.file, surface: options.surface, outputDir: options["output-dir"], query: positionals[0], includeComponents: chooseBool(flags, "components", "no-components"), includeVariables: chooseBool(flags, "variables", "no-variables"), includeStyles: chooseBool(flags, "styles", "no-styles"), disableCodeConnect: flags.has("no-code-connect") ? true : undefined, includeLibraryKeys: repeats.library, refresh: flags.has("refresh") ? true : undefined }), options);
  }
  if (command === "libraries") {
    const { positionals, options, flags } = parseTokens(argv, optionSet("file", "surface", "output-dir", "offset", "max-inline-bytes"), flagSet("refresh")); assertNoPositionals(positionals);
    return direct("get-libraries", clean({ file: options.file, surface: options.surface, outputDir: options["output-dir"], offset: integer(options.offset, "--offset"), refresh: flags.has("refresh") ? true : undefined }), options);
  }
  const readOptions = command === "metadata"
    ? optionSet("file", "node", "target", "surface", "output-dir", "mode", "depth", "max-inline-bytes")
    : optionSet("file", "node", "target", "surface", "output-dir", "mode", "depth", "client-languages", "client-frameworks", "max-inline-bytes");
  const { positionals, options, flags } = parseTokens(argv, readOptions, flagSet("refresh", "force-code", "no-code-connect", "exclude-screenshot", "recursive"));
  assertNoPositionals(positionals);
  if (options.target && options.node) throw new Error("Use either --target or --node, not both.");
  const input = clean({ file: options.file, target: options.target ?? options.node, surface: options.surface, outputDir: options["output-dir"], mode: options.mode, depth: integer(options.depth, "--depth"), clientLanguages: options["client-languages"], clientFrameworks: options["client-frameworks"], refresh: flags.has("refresh") ? true : undefined, forceCode: flags.has("force-code") ? true : undefined, disableCodeConnect: flags.has("no-code-connect") ? true : undefined, excludeScreenshot: flags.has("exclude-screenshot") ? true : undefined, recursive: flags.has("recursive") ? true : undefined });
  if (command === "metadata") assertMetadataDesignSurface(input);
  const internal = { metadata: "get-metadata", inspect: "inspect", "design-context": "get-design-context", "motion-context": "get-motion-context", variables: "get-variable-defs" } as const;
  return direct(internal[command], input, options);
}

type InternalCommand = "run" | "apply-asset-manifest" | "download-assets" | "capture-node" | "inspect" | "get-metadata" | "get-design-context" | "get-motion-context" | "search-design-system" | "get-libraries" | "get-variable-defs" | "call-upstream-tool" | "code-connect-inspect" | "code-connect-plan" | "code-connect-apply" | "code-connect-verify" | "lookup" | "docs" | "doctor" | "upstream-tools";

async function invoke(internalCommand: InternalCommand, input: CommandInput, dependencies: FigmaCommandRuntimeDependencies, inlineResultLimit?: number): Promise<number> {
  const runCli = dependencies.runCli ?? runFigmaWorkspaceCli;
  return runCli([internalCommand, "--input", "-", ...(inlineResultLimit === undefined ? [] : ["--inline-result-limit", String(inlineResultLimit)])], {
    io: mappedIo(input, dependencies),
  });
}

function mappedIo(input: CommandInput, dependencies: FigmaCommandRuntimeDependencies): FigmaWorkspaceCliIo {
  return {
    cwd: dependencies.cwd ?? (() => process.cwd()), env: dependencies.env ?? ((name) => process.env[name]),
    readFile: dependencies.readFile ?? defaultReadFile,
    readStdin: async (maxBytes = MAX_INPUT_BYTES) => assertTextWithinLimit(JSON.stringify(input), maxBytes),
    writeStdout: write(dependencies.writeStdout, false), writeStderr: write(dependencies.writeStderr, true),
  };
}

interface ParsedTokens { positionals: string[]; options: Record<string, string | undefined>; flags: Set<string>; repeats: Record<string, string[]> }
function parseTokens(argv: readonly string[], optionNames: Set<string>, flagNames=new Set<string>(), repeatNames=new Set<string>()): ParsedTokens {
  const positionals:string[]=[]; const options:Record<string,string|undefined>={}; const flags=new Set<string>(); const repeats:Record<string,string[]>={};
  for(let i=0;i<argv.length;i+=1){const token=argv[i]!; if(!token.startsWith("--")){positionals.push(token);continue;} const name=token.slice(2); if(flagNames.has(name)){if(flags.has(name))throw new Error(`Option --${name} may be specified only once.`);flags.add(name);continue;} if(!optionNames.has(name)&&!repeatNames.has(name))throw new Error(`Unknown option: --${name}`); const value=argv[++i];if(!value||value.startsWith("--"))throw new Error(`Option --${name} requires a value.`);if(repeatNames.has(name)){(repeats[name]??=[]).push(value);continue;}if(options[name]!==undefined)throw new Error(`Option --${name} may be specified only once.`);options[name]=value;}
  return {positionals,options,flags,repeats};
}
function optionSet(...names:string[]):Set<string>{return new Set(names);} function flagSet(...names:string[]):Set<string>{return new Set(names);} function repeatSet(...names:string[]):Set<string>{return new Set(names);}
function direct(internalCommand:InternalCommand,input:CommandInput,options:Record<string,string|undefined>):ParsedPublicCommand{return{internalCommand,input,inlineResultLimit:integer(options["max-inline-bytes"],"--max-inline-bytes")};}
function codeConnectDirect(internalCommand: InternalCommand, input: CommandInput, options: Record<string, string | undefined>): ParsedPublicCommand {
  return direct(internalCommand, input, options);
}
function noArgs(internalCommand:InternalCommand,input:CommandInput,argv:readonly string[]):ParsedPublicCommand{if(argv.length)throw new Error("This command accepts no arguments.");return{internalCommand,input};}
function integer(value:string|undefined,label:string):number|undefined{if(value===undefined)return undefined;const parsed=parseSafeIntegerToken(value,label);if(parsed<0)throw new Error(`${label} must be a non-negative safe integer.`);return parsed;}
function clampableInteger(value:string|undefined,label:string):number|undefined{if(value===undefined)return undefined;return parseSafeIntegerToken(value,label,"must be a safe integer; out-of-range integers are clamped.");}
function parseSafeIntegerToken(value:string,label:string,errorSuffix="must be a safe integer."):number{if(!/^-?\d+$/u.test(value))throw new Error(`${label} ${errorSuffix}`);const parsed=Number(value);if(!Number.isSafeInteger(parsed))throw new Error(`${label} ${errorSuffix}`);return parsed;}
function requirePositionals(values:string[],count:number,label:string):void{if(values.length!==count)throw new Error(`Expected exactly one ${label}.`);} function assertNoPositionals(values:string[]):void{if(values.length)throw new Error(`Unexpected positional argument: ${values[0]}`);}
function chooseBool(flags:Set<string>,yes:string,no:string):boolean|undefined{if(flags.has(yes)&&flags.has(no))throw new Error(`--${yes} and --${no} are mutually exclusive.`);return flags.has(yes)?true:flags.has(no)?false:undefined;}
function clean(value:CommandInput):CommandInput{return Object.fromEntries(Object.entries(value).filter(([,item])=>item!==undefined));}
async function readRawStdin(dependencies:FigmaCommandRuntimeDependencies,maxBytes:number):Promise<string>{return readBoundedText((dependencies.readStdin??defaultReadStdin)(maxBytes),maxBytes);}
async function readBoundedText(source:Promise<string>,maxBytes:number):Promise<string>{return assertTextWithinLimit(await source,maxBytes);}
function assertTextWithinLimit(value:string,maxBytes:number):string{if(Buffer.byteLength(value,"utf8")>maxBytes)throw new Error(`Input exceeds ${maxBytes} bytes.`);return value;}
async function defaultReadFile(path:string,maxBytes=MAX_INPUT_BYTES):Promise<string>{const info=await stat(path);if(info.size>maxBytes)throw new Error(`Input exceeds ${maxBytes} bytes.`);return assertTextWithinLimit(await readFile(path,"utf8"),maxBytes);}
async function defaultReadStdin(maxBytes=MAX_INPUT_BYTES):Promise<string>{const chunks:Buffer[]=[];let bytes=0;for await(const chunk of process.stdin){const value=Buffer.from(chunk);bytes+=value.byteLength;if(bytes>maxBytes)throw new Error(`Input exceeds ${maxBytes} bytes.`);chunks.push(value);}return Buffer.concat(chunks).toString("utf8");}

function normalizeExplicitPaths(command: FigmaConcreteCommandName, input: CommandInput, cwd: string): void {
  for (const field of ["outputDir", "imageFile", "manifestPath", "outputPlanPath", "planPath"] as const) {
    if (typeof input[field] === "string" && input[field].trim()) input[field] = resolve(cwd, input[field]);
  }
  if (command !== "assets:apply" || !Array.isArray(input.assets)) return;
  input.assets = input.assets.map((value) => {
    if (!isRecord(value) || typeof value.path !== "string" || !value.path.trim()) return value;
    return { ...value, path: resolve(cwd, value.path) };
  });
}

function assertStrictFigmaReferences(command: FigmaConcreteCommandName, input: CommandInput): void {
  const allowCompositeNodeId = command === "metadata" || command === "design-context";
  assertFileReference(input.file, 'Tool argument "file"', allowCompositeNodeId);
  assertNodeTargetReference(input.target, 'Tool argument "target"', allowCompositeNodeId);
  for (const [collection, label] of [[input.assets, "assets"], [input.targets, "targets"]] as const) {
    if (!Array.isArray(collection)) continue;
    collection.forEach((entry, index) => {
      if (isRecord(entry)) assertNodeTargetReference(entry.target, `Tool argument "${label}[${index}].target"`);
    });
  }
  if (isRecord(input.arguments)) assertFileReference(input.arguments.fileKey, 'Tool argument "arguments.fileKey"');
}

function assertFileReference(value: unknown, label: string, allowCompositeNodeId = false): void {
  if (typeof value !== "string" || !value.trim()) return;
  const trimmed = value.trim();
  if (/^[a-z][a-z0-9+.-]*:\/\//iu.test(trimmed)) {
    parseStrictFigmaUrl(trimmed, label, false, allowCompositeNodeId);
    return;
  }
  if (!isFigmaFileKey(trimmed)) throw new Error(`${label} must be a valid Figma URL or an official Figma file key containing 22 to 128 alphanumeric characters.`);
}

function assertNodeTargetReference(value: unknown, label: string, allowCompositeNodeId = false): void {
  const nodeIdIsValid = allowCompositeNodeId ? isCompositeCapableFigmaNodeId : isSimpleFigmaNodeId;
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (/^[a-z][a-z0-9+.-]*:\/\//iu.test(trimmed)) parseStrictFigmaUrl(trimmed, label, true, allowCompositeNodeId);
    else if (trimmed && !nodeIdIsValid(trimmed)) throw new Error(`${label} must be an official Figma node id or node URL.`);
  }
  if (isRecord(value)) {
    assertFileReference(value.fileKey, `${label}.fileKey`, allowCompositeNodeId);
    if (typeof value.nodeId === "string" && !nodeIdIsValid(value.nodeId)) throw new Error(`${label}.nodeId must be an official Figma node id.`);
  }
}

function assertMetadataDesignSurface(input: CommandInput): void {
  if (input.surface !== undefined && input.surface !== "design") throw new Error("figma:metadata supports only --surface design.");
  const urls = [input.file, input.target].filter((value): value is string => typeof value === "string" && /^[a-z][a-z0-9+.-]*:\/\//iu.test(value));
  for (const value of urls) {
    const kind = new URL(value).pathname.split("/").filter(Boolean)[0];
    if (kind !== "design" && kind !== "file") throw new Error("figma:metadata requires a Design URL.");
  }
  if (input.surface === undefined && urls.length === 0) throw new Error("figma:metadata with a raw file key or node id requires --surface design.");
}

function parseStrictFigmaUrl(value: string, label: string, requireNode: boolean, allowCompositeNodeId = false): URL {
  let url: URL;
  try { url = new URL(value); } catch { throw new Error(`${label} must be a valid Figma URL.`); }
  if (url.protocol !== "https:" || (url.hostname !== "figma.com" && !url.hostname.endsWith(".figma.com"))) {
    throw new Error(`${label} must use an https://*.figma.com Figma URL.`);
  }
  const parts = url.pathname.split("/").filter(Boolean);
  if (!["design", "file", "figjam", "board", "slides"].includes(parts[0] ?? "") || !parts[1] || !isFigmaFileKey(parts[1])) {
    throw new Error(`${label} must include a valid Design, FigJam, or Slides file path and file key.`);
  }
  const nodeId = url.searchParams.get("node-id") ?? url.searchParams.get("node_id");
  const nodeIdIsValid = allowCompositeNodeId ? isCompositeCapableFigmaNodeId : isSimpleFigmaNodeId;
  if ((requireNode || nodeId !== null) && !nodeIdIsValid(nodeId ?? "")) {
    throw new Error(`${label} must include a node-id query parameter.`);
  }
  return url;
}

export async function assertSafeScriptFile(path: string): Promise<void> {
  if (!isAbsolute(path) || !path.endsWith(".figma.ts")) throw new Error("--script must resolve to a .figma.ts file.");
  const info = await lstat(path);
  if (!info.isFile() || info.isSymbolicLink()) throw new Error("--script must be a regular non-symlink .figma.ts file.");
  const resolvedRealPath = await realpath(path);
  if (resolve(resolvedRealPath) !== resolve(path)) throw new Error("--script must not traverse a symlink, junction, or reparse target.");
}

export function formatRootHelp(): string {
  return ["# Figma Workspace stateless CLI", "", "Each invocation is independent. Commands, or live upstream schemas, that require a Figma file or node must receive that target explicitly; no command inherits a selection, history, or local state.", "", "## Documentation", "", "  figma:docs:help  figma:docs:list  figma:docs:catalog  figma:docs:read  figma:docs:search  figma:api:help  figma:api:read  figma:api:search  figma:doctor", "", "## Read and execute", "", "  figma:metadata  figma:inspect  figma:design-context  figma:motion-context  figma:variables  figma:design-system  figma:libraries  figma:run", "", "## Code Connect", "", "  figma:code-connect:help  figma:code-connect:inspect  figma:code-connect:plan  figma:code-connect:apply  figma:code-connect:verify", "", "## Assets and fallback", "", "  figma:capture  figma:assets:apply  figma:assets:download  figma:upstream:help  figma:upstream:list  figma:upstream:read  figma:upstream:call", ""].join("\n");
}
export function formatFamilyHelp(family:FigmaCommandFamily):string{return[`# figma:${family}:help`,"",...FAMILY_COMMANDS[family].map((name)=>`  figma:${name}`),""].join("\n");}
export function formatCommandHelp(command:string):string{
  if(!isPublicCommand(command))return `# figma:${command}\n\nUnknown public leaf. Use figma:help for the complete stateless command inventory.\n`;
  const details=command==="run"?"\n--script resolves relative to cwd and must be a regular non-symlink .figma.ts file. --source accepts only '-' and reads TypeScript from stdin. Raw file keys require --surface. A direct returned use_figma script error reports executionOutcome: failed_atomic: Figma confirmed the script made no changes, so repair and retry safely. Status: failed during execution is reserved for an outcome_unknown response loss; Status: failed after execution is reserved for local post-processing failure after executionOutcome: succeeded.":command==="upstream:call"?"\nRead the exact live schema through figma:upstream:read before calling. Covered official tools remain callable here; their first-class figma:* commands add local validation and result handling. Calls within the response budget write a sanitized .upstream.json sidecar. An over-budget response returns a resource diagnostic without writing its payload. A direct use_figma script error is failed_atomic; any other dispatched error is outcome_unknown and requires read-back before retry.":command==="code-connect:apply"?"\nThis is the only Code Connect write command. It requires the exact planDigest from figma:code-connect:plan and blocks stale snapshots before dispatch. A post-dispatch error is outcome_unknown: run figma:code-connect:verify rather than replaying the write.":command==="code-connect:plan"?"\nValidates a simple-mapping manifest and writes an immutable plan artifact. Templates are rejected. The plan is unavailable when Figma cannot return mappings in a format safe for full readback.":command==="code-connect:verify"?"\nSafe to repeat. Reports matched, missing, mismatch, or unavailable for every planned mapping.":command==="doctor"?"\nRuns local corpus, Plugin API index, and TypeScript runtime diagnostics. No Figma target is required.":command==="docs:catalog"?"\nOut-of-range safe --limit integers are clamped to the nearest endpoint and reported in parameterAdjustments.":command==="docs:search"||command==="api:search"?"\nOut-of-range safe integer limits are clamped to the nearest endpoint and reported in parameterAdjustments. Search applies one 12000-byte UTF-8 budget across returned snippets and reports truncation in snippetBudget.":command==="design-system"?"\nEach <query> must express one search intent; do not combine alternatives or synonyms.":command==="assets:apply"?"\nManifest assets must be PNG, JPG/JPEG, GIF, or WebP raster files applied as fills to explicit targets. SVG input is rejected because official SVG uploads create editable vector node trees; use figma:run for that workflow.":command==="assets:download"?"\nDownloads the whole-node export, original raster source images, and returned vector-layer SVG assets. downloadedFiles.kind is exported, raw, or svg.":"";
  return `# figma:${command}\n\nUsage: ${PUBLIC_COMMAND_USAGE[command]}${details}\n`;
}

const PUBLIC_COMMAND_USAGE: Record<FigmaConcreteCommandName,string> = {
  "docs:list":"figma:docs:list",
  "docs:catalog":`figma:docs:catalog [--task-family <family>] [--surface design|figjam|slides] [--classification active|conditional|router|examples] [--limit <${DOCS_CATALOG_LIMIT_MIN}..${DOCS_CATALOG_LIMIT_MAX}>]`,
  "docs:read":"figma:docs:read <doc-id>",
  "docs:search":`figma:docs:search <query> [--scope auto|active|conditional|router|examples|all] [--surface design|figjam|slides] [--task-family <family>] [--limit <${LOOKUP_RESULTS_MIN}..${LOOKUP_RESULTS_MAX}>] [--snippet-lines <${LOOKUP_SNIPPET_LINES_MIN}..${LOOKUP_SNIPPET_LINES_MAX}>]`,
  "api:read":"figma:api:read <api-id>",
  "api:search":`figma:api:search <symbol> [--limit <${LOOKUP_RESULTS_MIN}..${LOOKUP_RESULTS_MAX}>] [--snippet-lines <${LOOKUP_SNIPPET_LINES_MIN}..${LOOKUP_SNIPPET_LINES_MAX}>]`,
  doctor:"figma:doctor",
  metadata:`figma:metadata (--target <Design-node-url> | --file <Design-url|key> [--node <node-id>]) [--surface design] [--refresh] [--output-dir <path>] [--max-inline-bytes <${INLINE_RESULT_LIMIT_MIN}..${INLINE_RESULT_LIMIT_MAX}>]`,
  inspect:`figma:inspect (--target <node-url> | --file <url|key> --node <node-id>) [--surface design|figjam|slides] [--mode inspect|style] [--depth <${INSPECT_DEPTH_MIN}..${INSPECT_DEPTH_MAX}>] [--output-dir <path>] [--max-inline-bytes <${INLINE_RESULT_LIMIT_MIN}..${INLINE_RESULT_LIMIT_MAX}>]`,
  "design-context":`figma:design-context (--target <node-url> | --file <url|key> --node <node-id>) [--surface design|figjam|slides] [--client-languages <list>] [--client-frameworks <list>] [--force-code] [--no-code-connect] [--exclude-screenshot] [--refresh] [--output-dir <path>] [--max-inline-bytes <${INLINE_RESULT_LIMIT_MIN}..${INLINE_RESULT_LIMIT_MAX}>]`,
  "motion-context":`figma:motion-context (--target <node-url> | --file <url|key> --node <node-id>) [--surface design|figjam|slides] [--client-languages <list>] [--client-frameworks <list>] [--recursive] [--refresh] [--output-dir <path>] [--max-inline-bytes <${INLINE_RESULT_LIMIT_MIN}..${INLINE_RESULT_LIMIT_MAX}>]`,
  variables:`figma:variables (--target <node-url> | --file <url|key> --node <node-id>) [--surface design|figjam|slides] [--refresh] [--output-dir <path>] [--max-inline-bytes <${INLINE_RESULT_LIMIT_MIN}..${INLINE_RESULT_LIMIT_MAX}>]`,
  "design-system":`figma:design-system <query> --file <url|key> [--surface design|figjam|slides] [--components|--no-components] [--variables|--no-variables] [--styles|--no-styles] [--no-code-connect] [--library <key>]... [--refresh] [--output-dir <path>] [--max-inline-bytes <${INLINE_RESULT_LIMIT_MIN}..${INLINE_RESULT_LIMIT_MAX}>]`,
  libraries:`figma:libraries --file <url|key> [--surface design|figjam|slides] [--offset <${LIBRARIES_OFFSET_MIN}..${LIBRARIES_OFFSET_MAX}>] [--refresh] [--output-dir <path>] [--max-inline-bytes <${INLINE_RESULT_LIMIT_MIN}..${INLINE_RESULT_LIMIT_MAX}>]`,
  run:`figma:run --file <url|key> (--script <path.figma.ts> | --source -) [--surface design|figjam|slides] [--target-page <node-id>] [--output-dir <path>] [--max-inline-bytes <${INLINE_RESULT_LIMIT_MIN}..${INLINE_RESULT_LIMIT_MAX}>]`,
  capture:`figma:capture (--target <node-url> | --file <url|key> --node <node-id>) [--surface design|figjam|slides] [--image-file <path>] [--output-dir <path>] [--max-dimension <${CAPTURE_MAX_DIMENSION_MIN}..${CAPTURE_MAX_DIMENSION_MAX}>] [--contents-only] [--max-inline-bytes <${INLINE_RESULT_LIMIT_MIN}..${INLINE_RESULT_LIMIT_MAX}>]`,
  "assets:apply":`figma:assets:apply --input <json-file|-> --file <url|key> [--surface design|figjam|slides] [--output-dir <path>] [--max-inline-bytes <${INLINE_RESULT_LIMIT_MIN}..${INLINE_RESULT_LIMIT_MAX}>]`,
  "assets:download":`figma:assets:download --input <json-file|-> [--file <url|key>] [--surface design|figjam|slides] [--output-dir <path>] [--max-inline-bytes <${INLINE_RESULT_LIMIT_MIN}..${INLINE_RESULT_LIMIT_MAX}>]`,
  "code-connect:inspect":`figma:code-connect:inspect --file <Design-url|key> [--surface design] [--output-dir <path>] [--max-inline-bytes <${INLINE_RESULT_LIMIT_MIN}..${INLINE_RESULT_LIMIT_MAX}>]`,
  "code-connect:plan":`figma:code-connect:plan --file <Design-url|key> --input <manifest.json|-> [--surface design] [--output-plan <path-inside-output-dir>] [--output-dir <path>] [--max-inline-bytes <${INLINE_RESULT_LIMIT_MIN}..${INLINE_RESULT_LIMIT_MAX}>]`,
  "code-connect:apply":`figma:code-connect:apply --file <Design-url|key> --plan <path> --confirm-plan <digest> [--surface design] [--output-dir <path>] [--max-inline-bytes <${INLINE_RESULT_LIMIT_MIN}..${INLINE_RESULT_LIMIT_MAX}>]`,
  "code-connect:verify":`figma:code-connect:verify --file <Design-url|key> --plan <path> [--surface design] [--output-dir <path>] [--max-inline-bytes <${INLINE_RESULT_LIMIT_MIN}..${INLINE_RESULT_LIMIT_MAX}>]`,
  "upstream:list":"figma:upstream:list [--refresh]",
  "upstream:read":"figma:upstream:read <name> [--refresh]",
  "upstream:call":`figma:upstream:call --input <json-file|-> [--file <url|key>] [--surface design|figjam|slides] [--output-dir <path>] [--max-inline-bytes <${INLINE_RESULT_LIMIT_MIN}..${INLINE_RESULT_LIMIT_MAX}>]`,
};

function isPublicCommand(value:string):value is FigmaConcreteCommandName{return(PUBLIC_COMMANDS as readonly string[]).includes(value);} function isFamily(value:string):value is FigmaCommandFamily{return value==="docs"||value==="api"||value==="upstream"||value==="code-connect";} function isHelp(value:string):boolean{return value==="--help"||value==="-h"||value==="help";}
function write(override:((value:string)=>void)|undefined,stderr:boolean):(value:string)=>void{return override??(stderr?process.stderr.write.bind(process.stderr):process.stdout.write.bind(process.stdout));}
function formatError(error:unknown):string{return error instanceof Error?error.message:String(error);} function isRecord(value:unknown):value is Record<string,unknown>{return Boolean(value)&&typeof value==="object"&&!Array.isArray(value);}
function isFigmaUrl(value:string):boolean{try{parseStrictFigmaUrl(value,'Tool argument "file"',false);return true;}catch{return false;}}
