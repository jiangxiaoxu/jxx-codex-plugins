import { readdirSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { basename, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import * as ts from "@typescript/typescript6";

type FigmaWorkspaceTypescriptDiagnosticSeverity = "fatal" | "warning";

export interface FigmaWorkspaceTypescriptFileDiagnostic {
  code: string;
  severity: FigmaWorkspaceTypescriptDiagnosticSeverity;
  message: string;
  suggestion: string;
  docsHint: string;
  source: {
    scriptPath: string;
    line?: number;
    column?: number;
    occurrences?: Array<{ line: number; column: number }>;
  };
}

export interface FigmaWorkspaceTypescriptCompiledSource {
  source: string;
  diagnostics: FigmaWorkspaceTypescriptFileDiagnostic[];
}

const nodeRequire = createRequire(import.meta.url);
const runtimeDirname = dirname(fileURLToPath(import.meta.url));
const TYPESCRIPT_WRAPPER_START = "// __FIGMA_WORKSPACE_TS_BODY_START__";
const TYPESCRIPT_WRAPPER_END = "// __FIGMA_WORKSPACE_TS_BODY_END__";
const TYPESCRIPT_WRAPPER_PREFIX = `async function __figmaWorkspaceTypescriptBody() {\n${TYPESCRIPT_WRAPPER_START}\n`;
const TYPESCRIPT_WRAPPER_SUFFIX = `\n${TYPESCRIPT_WRAPPER_END}\n}`;
const TYPESCRIPT_SOURCE_LINE_OFFSET = countLines(TYPESCRIPT_WRAPPER_PREFIX) - 1;
const TYPESCRIPT_WORKSPACE_HELPER_TYPES_PATH = "__figma_workspace_helpers.d.ts";
const FIGMA_WORKSPACE_HELPER_DECLARATIONS_PATHS = runtimeAssetCandidates("figma-workspace-helpers.d.ts");
const FIGMA_PLUGIN_TYPINGS_PATHS = runtimeAssetCandidates("figma-plugin-typings/index.d.ts");
const TYPESCRIPT_LIB_DIRS = runtimeAssetCandidates("typescript-lib");
const typescriptRuntimeAssets = loadFigmaWorkspaceTypescriptRuntimeAssets();

interface FigmaWorkspaceTypescriptRuntimeAssets {
  ok: true;
  moduleDir: string;
  cwd: string;
  argv1?: string;
  packageVersion?: string;
  helperDeclarationsPath: string;
  figmaPluginTypingsPath: string;
  typescriptLibDir: string;
  helperDeclarations: string;
  figmaPluginTypings: string;
  typescriptLibs: Map<string, string>;
}

interface FigmaWorkspaceTypescriptRuntimeAssetFailure {
  ok: false;
  moduleDir: string;
  cwd: string;
  argv1?: string;
  packageVersion?: string;
  attemptedPaths: string[];
  message: string;
}

export type FigmaWorkspaceTypescriptRuntimeInfo =
  | {
    ok: true;
    moduleDir: string;
    cwd: string;
    argv1?: string;
    packageVersion?: string;
    helperDeclarationsPath: string;
    figmaPluginTypingsPath: string;
    typescriptLibDir: string;
    typescriptLibCount: number;
  }
  | FigmaWorkspaceTypescriptRuntimeAssetFailure;

export function getFigmaWorkspaceTypescriptRuntimeInfo(): FigmaWorkspaceTypescriptRuntimeInfo {
  if (!typescriptRuntimeAssets.ok) {
    return { ...typescriptRuntimeAssets };
  }
  return {
    ok: true,
    moduleDir: typescriptRuntimeAssets.moduleDir,
    cwd: typescriptRuntimeAssets.cwd,
    argv1: typescriptRuntimeAssets.argv1,
    packageVersion: typescriptRuntimeAssets.packageVersion,
    helperDeclarationsPath: typescriptRuntimeAssets.helperDeclarationsPath,
    figmaPluginTypingsPath: typescriptRuntimeAssets.figmaPluginTypingsPath,
    typescriptLibDir: typescriptRuntimeAssets.typescriptLibDir,
    typescriptLibCount: typescriptRuntimeAssets.typescriptLibs.size,
  };
}

export function compileFigmaWorkspaceTypescriptSource(
  scriptPath: string,
  source: string,
  extraDeclarations?: string,
): FigmaWorkspaceTypescriptCompiledSource {
  if (!typescriptRuntimeAssets.ok) {
    return {
      source,
      diagnostics: [typescriptRuntimeAssetFailureDiagnostic(scriptPath, typescriptRuntimeAssets)],
    };
  }
  const wrappedSource = `${TYPESCRIPT_WRAPPER_PREFIX}${source}${TYPESCRIPT_WRAPPER_SUFFIX}`;
  const compilerOptions = createFigmaWorkspaceTypescriptCompilerOptions();
  const typescriptScriptPath = normalizeTypescriptFileName(scriptPath);
  const helperTypesPath = normalizeTypescriptFileName(`${scriptPath}.${TYPESCRIPT_WORKSPACE_HELPER_TYPES_PATH}`);
  const figmaTypingsPath = typescriptRuntimeAssets.figmaPluginTypingsPath;
  const host = ts.createCompilerHost(compilerOptions, true);
  const originalReadFile = host.readFile.bind(host);
  const originalFileExists = host.fileExists.bind(host);
  host.readFile = (fileName) => {
    const normalizedFileName = normalizeTypescriptFileName(fileName);
    if (normalizedFileName === typescriptScriptPath) return wrappedSource;
    if (normalizedFileName === helperTypesPath) return [typescriptRuntimeAssets.helperDeclarations, extraDeclarations]
      .filter((item): item is string => typeof item === "string" && item.length > 0)
      .join("\n");
    const bundledLib = resolveBundledTypescriptLib(fileName);
    if (bundledLib !== undefined) return bundledLib;
    if (normalizedFileName === normalizeTypescriptFileName(figmaTypingsPath)) return typescriptRuntimeAssets.figmaPluginTypings;
    return originalReadFile(fileName);
  };
  host.fileExists = (fileName) => {
    const normalizedFileName = normalizeTypescriptFileName(fileName);
    return normalizedFileName === typescriptScriptPath ||
      normalizedFileName === helperTypesPath ||
      resolveBundledTypescriptLib(fileName) !== undefined ||
      normalizedFileName === normalizeTypescriptFileName(figmaTypingsPath) ||
      originalFileExists(fileName);
  };
  const program = ts.createProgram({
    rootNames: [figmaTypingsPath, helperTypesPath, typescriptScriptPath],
    options: compilerOptions,
    host,
  });
  const sourceFile = program.getSourceFile(typescriptScriptPath);
  const syntacticDiagnostics = sourceFile ? program.getSyntacticDiagnostics(sourceFile) : [];
  const syntacticDiagnosticKeys = new Set(syntacticDiagnostics.map(typescriptDiagnosticIdentity));
  const preEmitDiagnostics = syntacticDiagnostics.length > 0
    ? syntacticDiagnostics
    : ts.getPreEmitDiagnostics(program);
  const diagnostics = preEmitDiagnostics
    .filter((diagnostic) => diagnostic.file === undefined || diagnostic.file === sourceFile)
    .map((diagnostic) => typescriptDiagnosticToFileDiagnostic(
      diagnostic,
      scriptPath,
      sourceFile,
      syntacticDiagnosticKeys.has(typescriptDiagnosticIdentity(diagnostic)),
    ));
  const transpiled = ts.transpileModule(wrappedSource, {
    fileName: scriptPath,
    compilerOptions,
    reportDiagnostics: false,
  });
  const transpiledBody = extractTypescriptTranspiledBody(transpiled.outputText);
  if (transpiledBody === undefined) {
    diagnostics.push({
      code: "FIGMA_WORKSPACE_TS_COMPILE_ERROR",
      severity: "fatal",
      message: "TypeScript preflight could not extract the compiled Figma script body.",
      suggestion: "Remove unusual top-level wrapper-like code and rerun the .figma.ts script.",
      docsHint: "lookup kind=docs query=\"TypeScript Figma plugin typings\"",
      source: { scriptPath },
    });
  }
  return {
    source: transpiledBody ?? source,
    diagnostics,
  };
}

function createFigmaWorkspaceTypescriptCompilerOptions(): ts.CompilerOptions {
  return {
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    lib: ["lib.es2022.d.ts", "lib.dom.d.ts"],
    strict: true,
    noImplicitAny: true,
    strictNullChecks: true,
    skipLibCheck: true,
    noEmitOnError: true,
    isolatedModules: false,
    esModuleInterop: true,
    allowSyntheticDefaultImports: true,
    ignoreDeprecations: "6.0",
    removeComments: false,
  };
}

function resolveExternalFigmaPluginTypingsPath(): string | undefined {
  try {
    return nodeRequire.resolve("@figma/plugin-typings/index.d.ts");
  } catch {
    return undefined;
  }
}

function resolveBundledTypescriptLib(fileName: string): string | undefined {
  const file = basename(fileName);
  if (!/^lib\..*\.d\.ts$/u.test(file)) {
    return undefined;
  }
  return typescriptRuntimeAssets.ok ? typescriptRuntimeAssets.typescriptLibs.get(file) : undefined;
}

function loadFigmaWorkspaceTypescriptRuntimeAssets(): FigmaWorkspaceTypescriptRuntimeAssets | FigmaWorkspaceTypescriptRuntimeAssetFailure {
  const cwd = safeProcessCwd();
  const argv1 = safeProcessArgv1();
  const packageVersion = readNearestPackageVersion(runtimeDirname);
  const externalFigmaTypingsPath = resolveExternalFigmaPluginTypingsPath();
  const figmaPluginTypingsPaths = externalFigmaTypingsPath
    ? [externalFigmaTypingsPath, ...FIGMA_PLUGIN_TYPINGS_PATHS]
    : FIGMA_PLUGIN_TYPINGS_PATHS;
  const attemptedPaths = [
    ...FIGMA_WORKSPACE_HELPER_DECLARATIONS_PATHS,
    ...figmaPluginTypingsPaths,
    ...TYPESCRIPT_LIB_DIRS,
    ...packageJsonCandidates(runtimeDirname),
  ];
  try {
    const helperDeclarationsPath = resolveReadableFile(FIGMA_WORKSPACE_HELPER_DECLARATIONS_PATHS);
    const helperDeclarations = readFileSync(helperDeclarationsPath, "utf8");
    const figmaPluginTypingsPath = resolveReadableFile(figmaPluginTypingsPaths);
    const figmaPluginTypings = readFileSync(figmaPluginTypingsPath, "utf8");
    const typescriptLibDir = resolveReadableTypescriptLibDir(TYPESCRIPT_LIB_DIRS);
    const typescriptLibs = new Map<string, string>();
    for (const entry of readdirSync(typescriptLibDir, { withFileTypes: true })) {
      if (!entry.isFile() || !/^lib\..*\.d\.ts$/u.test(entry.name)) {
        continue;
      }
      typescriptLibs.set(entry.name, readFileSync(resolve(typescriptLibDir, entry.name), "utf8"));
    }
    if (typescriptLibs.size === 0) {
      throw new Error(`No bundled TypeScript lib declarations found in ${typescriptLibDir}.`);
    }
    return {
      ok: true,
      moduleDir: runtimeDirname,
      cwd,
      argv1,
      packageVersion,
      helperDeclarationsPath,
      figmaPluginTypingsPath,
      typescriptLibDir,
      helperDeclarations,
      figmaPluginTypings,
      typescriptLibs,
    };
  } catch (error) {
    return {
      ok: false,
      moduleDir: runtimeDirname,
      cwd,
      argv1,
      packageVersion,
      attemptedPaths,
      message: `Unable to preload Figma Workspace TypeScript runtime assets: ${errorMessage(error)}`,
    };
  }
}

function runtimeAssetCandidates(relativePath: string): string[] {
  return [
    resolve(runtimeDirname, relativePath),
    resolve(runtimeDirname, "../mcp", relativePath),
    resolve(runtimeDirname, "../upstream", relativePath),
  ];
}

function resolveReadableFile(candidates: string[]): string {
  for (const candidate of candidates) {
    try {
      readFileSync(candidate, "utf8");
      return candidate;
    } catch {
      // Try the next runtime layout.
    }
  }
  throw new Error(`No candidate file was readable: ${candidates.join(" | ")}`);
}

function resolveReadableTypescriptLibDir(candidates: string[]): string {
  for (const candidate of candidates) {
    try {
      const entries = readdirSync(candidate, { withFileTypes: true });
      if (entries.some((entry) => entry.isFile() && /^lib\..*\.d\.ts$/u.test(entry.name))) {
        return candidate;
      }
    } catch {
      // Try the next runtime layout.
    }
  }
  throw new Error(`No candidate TypeScript lib directory was readable: ${candidates.join(" | ")}`);
}

function typescriptRuntimeAssetFailureDiagnostic(
  scriptPath: string,
  failure: FigmaWorkspaceTypescriptRuntimeAssetFailure,
): FigmaWorkspaceTypescriptFileDiagnostic {
  return {
    code: "FIGMA_WORKSPACE_TS_RUNTIME_ASSETS_MISSING",
    severity: "fatal",
    message: [
      failure.message,
      `moduleDir=${failure.moduleDir}`,
      `cwd=${failure.cwd}`,
      `argv1=${failure.argv1 ?? "<unset>"}`,
      `packageVersion=${failure.packageVersion ?? "<unknown>"}`,
      `attemptedPaths=${failure.attemptedPaths.join(" | ")}`,
    ].join("; "),
    suggestion: "Rebuild the cli-runtime dist if bundled declaration files are missing, then rerun figma:script:run with the same --state-file.",
    docsHint: "Figma Workspace CLI: figma:script:run --help",
    source: { scriptPath },
  };
}

function readNearestPackageVersion(startDir: string): string | undefined {
  for (const candidate of packageJsonCandidates(startDir)) {
    try {
      const value: unknown = JSON.parse(readFileSync(candidate, "utf8"));
      if (isRecord(value) && typeof value.version === "string") {
        return value.version;
      }
    } catch {
      // Try the next package.json candidate.
    }
  }
  return undefined;
}

function packageJsonCandidates(startDir: string): string[] {
  return [
    resolve(startDir, "../package.json"),
    resolve(startDir, "../../package.json"),
    resolve(startDir, "../../../package.json"),
    resolve(startDir, "../../../../package.json"),
  ];
}

function safeProcessCwd(): string {
  try {
    return typeof process !== "undefined" && typeof process.cwd === "function"
      ? process.cwd()
      : runtimeDirname;
  } catch {
    return runtimeDirname;
  }
}

function safeProcessArgv1(): string | undefined {
  return typeof process !== "undefined" && Array.isArray(process.argv) ? process.argv[1] : undefined;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function normalizeTypescriptFileName(fileName: string): string {
  const normalized = fileName.replace(/\\/gu, "/");
  return ts.sys.useCaseSensitiveFileNames ? normalized : normalized.toLowerCase();
}

function typescriptDiagnosticToFileDiagnostic(
  diagnostic: ts.Diagnostic,
  scriptPath: string,
  sourceFile: ts.SourceFile | undefined,
  syntaxError: boolean,
): FigmaWorkspaceTypescriptFileDiagnostic {
  const location = typescriptDiagnosticLocation(diagnostic, sourceFile);
  const message = ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n");
  return {
    code: syntaxError ? "FIGMA_WORKSPACE_PARSE_ERROR" : "FIGMA_WORKSPACE_TS_TYPE_ERROR",
    severity: "fatal",
    message: `${syntaxError ? "TypeScript syntax preflight failed" : "TypeScript preflight failed"}: ${message}`,
    suggestion: syntaxError
      ? "Fix all TypeScript syntax errors before running the Figma Workspace script; rerun afterward to get guardrail diagnostics."
      : "Fix the TypeScript error before running the Figma script. Use Figma Plugin API node types such as FrameNode, PageNode, or RectangleNode to model allowed methods.",
    docsHint: syntaxError
      ? "Figma Workspace CLI: figma:script:run --help"
      : "lookup kind=api symbol=ChildrenMixin.appendChild",
    source: {
      scriptPath,
      ...location,
    },
  };
}

function typescriptDiagnosticIdentity(diagnostic: ts.Diagnostic): string {
  const message = ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n");
  return `${diagnostic.code}:${diagnostic.start ?? ""}:${diagnostic.length ?? ""}:${message}`;
}

function typescriptDiagnosticLocation(
  diagnostic: ts.Diagnostic,
  sourceFile: ts.SourceFile | undefined,
): { line?: number; column?: number } {
  if (!sourceFile || diagnostic.file !== sourceFile || diagnostic.start === undefined) {
    return {};
  }
  const location = sourceFile.getLineAndCharacterOfPosition(diagnostic.start);
  const sourceLine = location.line + 1 - TYPESCRIPT_SOURCE_LINE_OFFSET;
  if (sourceLine < 1) {
    return {};
  }
  return {
    line: sourceLine,
    column: location.character + 1,
  };
}

function extractTypescriptTranspiledBody(outputText: string): string | undefined {
  const startMarkerIndex = outputText.indexOf(TYPESCRIPT_WRAPPER_START);
  const endMarkerIndex = outputText.indexOf(TYPESCRIPT_WRAPPER_END);
  if (startMarkerIndex < 0 || endMarkerIndex < 0 || endMarkerIndex <= startMarkerIndex) {
    return undefined;
  }
  const bodyStart = outputText.indexOf("\n", startMarkerIndex);
  if (bodyStart < 0 || bodyStart >= endMarkerIndex) {
    return undefined;
  }
  return outputText.slice(bodyStart + 1, endMarkerIndex).replace(/\n\s*$/u, "");
}

function countLines(source: string): number {
  if (source.length === 0) {
    return 0;
  }
  return source.split(/\r?\n/u).length;
}
