import {
  compileFigmaWorkspaceTypescriptSource,
  getFigmaWorkspaceTypescriptRuntimeInfo,
  type FigmaWorkspaceTypescriptRuntimeInfo,
} from "./typescript-compiler-runtime.js";

export { getFigmaWorkspaceTypescriptRuntimeInfo };
export type { FigmaWorkspaceTypescriptRuntimeInfo };

export type FigmaWorkspaceSurface = "design" | "figjam" | "slides";

export type FigmaWorkspaceDiagnosticSeverity = "fatal" | "warning";

export interface FigmaWorkspaceDiagnostic {
  code: string;
  severity: FigmaWorkspaceDiagnosticSeverity;
  message: string;
  suggestion: string;
  docsHint: string;
  location?: {
    line?: number;
    column?: number;
  };
}

export interface FigmaWorkspaceFileDiagnostic extends FigmaWorkspaceDiagnostic {
  source: {
    scriptPath: string;
    line?: number;
    column?: number;
    occurrences?: Array<{ line: number; column: number }>;
  };
}

export interface FigmaWorkspaceRepairOccurrence {
  scriptPath?: string;
  line?: number;
  column?: number;
  label?: string;
}

export interface FigmaWorkspaceRepairStep {
  code: string;
  severity: FigmaWorkspaceDiagnosticSeverity;
  message: string;
  suggestion: string;
  docsHint: string;
  occurrences: FigmaWorkspaceRepairOccurrence[];
}

export interface FigmaWorkspaceRepairPlan {
  status: "ok" | "parse_error" | "blocked" | "warning";
  summary: string;
  steps: FigmaWorkspaceRepairStep[];
}

export interface CompiledFigmaWorkspaceScriptFile {
  code: string;
  diagnostics: FigmaWorkspaceFileDiagnostic[];
  metadata: {
    scriptPath: string;
    sourceBytes: number;
    sourceLineCount: number;
    targetPageId?: string;
    expectedSurface?: FigmaWorkspaceSurface;
  };
}

export interface CompiledFigmaWorkspaceEvalCode {
  code: string;
  diagnostics: FigmaWorkspaceFileDiagnostic[];
}

const FIGMA_TYPESCRIPT_EXTENSION = ".figma.ts";
const UPSTREAM_EVAL_CODE_LIMIT_BYTES = 50_000;

export function compileFigmaWorkspaceScriptFile(options: {
  scriptPath: string;
  source: string;
  targetPageId?: string;
  expectedSurface?: FigmaWorkspaceSurface;
  strict?: boolean;
}): CompiledFigmaWorkspaceScriptFile {
  const preparedSource = prepareFigmaWorkspaceScriptSource(options);
  const lines: string[] = [];
  if (options.targetPageId) {
    lines.push(createTargetPageBootstrap(options.targetPageId));
  }
  lines.push(`// run-script-file source: ${options.scriptPath}`);
  lines.push(preparedSource.source);
  return {
    code: lines.join("\n"),
    diagnostics: preparedSource.diagnostics,
    metadata: {
      scriptPath: options.scriptPath,
      sourceBytes: Buffer.byteLength(options.source, "utf8"),
      sourceLineCount: countLines(options.source),
      targetPageId: options.targetPageId,
      expectedSurface: options.expectedSurface,
    },
  };
}

export function compileFigmaWorkspaceEvalCode(options: {
  code: string;
}): CompiledFigmaWorkspaceEvalCode {
  const compiled = compileFigmaWorkspaceTypescriptSource(
    "__figma_workspace_inline_eval.figma.ts",
    options.code,
    true,
  );
  return {
    code: compiled.source,
    diagnostics: compiled.diagnostics.map((diagnostic) => ({
      ...diagnostic,
      source: {
        ...diagnostic.source,
        scriptPath: "<inline eval>",
      },
    })),
  };
}

function prepareFigmaWorkspaceScriptSource(options: {
  scriptPath: string;
  source: string;
  strict?: boolean;
}): { source: string; diagnostics: FigmaWorkspaceFileDiagnostic[] } {
  if (!options.scriptPath.endsWith(FIGMA_TYPESCRIPT_EXTENSION)) {
    return { source: options.source, diagnostics: [] };
  }
  return compileFigmaWorkspaceTypescriptSource(options.scriptPath, options.source, Boolean(options.strict));
}

function createTargetPageBootstrap(targetPageId: string): string {
  return `{ const __targetPage = typeof figma.getNodeByIdAsync === "function"
  ? await figma.getNodeByIdAsync(${literal(targetPageId)})
  : figma.getNodeById(${literal(targetPageId)});
if (!__targetPage || __targetPage.type !== "PAGE") throw new Error("targetPageId must resolve to a PAGE node.");
await figma.setCurrentPageAsync(__targetPage); }`;
}

export function diagnoseWrappedScriptSize(
  scriptPath: string,
  wrappedScript: string,
): FigmaWorkspaceFileDiagnostic[] {
  const byteLength = Buffer.byteLength(wrappedScript, "utf8");
  if (byteLength <= UPSTREAM_EVAL_CODE_LIMIT_BYTES) {
    return [];
  }
  return [{
    code: "FIGMA_WORKSPACE_SCRIPT_PAYLOAD_TOO_LARGE",
    severity: "fatal",
    message: `Compiled Figma script payload is ${byteLength} bytes; the maximum is ${UPSTREAM_EVAL_CODE_LIMIT_BYTES} UTF-8 bytes.`,
    suggestion: "Split the work into smaller .figma.ts files, for example skeleton, asset targets, upload fills, and visual fixes.",
    docsHint: "Figma Workspace CLI: run-script-file --help",
    source: { scriptPath },
  }];
}

export function createFigmaWorkspaceRepairPlan(
  diagnostics: FigmaWorkspaceFileDiagnostic[] | undefined,
): FigmaWorkspaceRepairPlan {
  const items = diagnostics ?? [];
  const fatalCount = items.filter((diagnostic) => diagnostic.severity === "fatal").length;
  const warningCount = items.filter((diagnostic) => diagnostic.severity === "warning").length;
  const hasParseError = items.some((diagnostic) => diagnostic.code === "FIGMA_WORKSPACE_PARSE_ERROR");
  const status: FigmaWorkspaceRepairPlan["status"] = hasParseError
    ? "parse_error"
    : fatalCount > 0
      ? "blocked"
      : warningCount > 0
        ? "warning"
        : "ok";
  return {
    status,
    summary: repairPlanSummary(status, fatalCount, warningCount),
    steps: repairPlanSteps(items, hasParseError),
  };
}

function repairPlanSummary(
  status: FigmaWorkspaceRepairPlan["status"],
  fatalCount: number,
  warningCount: number,
): string {
  if (status === "parse_error") {
    return "Fix all TypeScript syntax errors before rerunning the script.";
  }
  if (status === "blocked") {
    return `Preflight blocked execution with ${fatalCount} fatal diagnostic${fatalCount === 1 ? "" : "s"}; apply all repair steps before rerunning.`;
  }
  if (status === "warning") {
    return `Preflight completed with ${warningCount} warning${warningCount === 1 ? "" : "s"}; review repair steps before relying on the result.`;
  }
  return "No preflight repairs are required.";
}

function repairPlanSteps(
  diagnostics: FigmaWorkspaceFileDiagnostic[],
  parseErrorOnly: boolean,
): FigmaWorkspaceRepairStep[] {
  if (parseErrorOnly) {
    return diagnostics
      .filter((diagnostic) => diagnostic.code === "FIGMA_WORKSPACE_PARSE_ERROR")
      .map((diagnostic) => repairPlanStepFromDiagnostic(diagnostic));
  }
  const steps = new Map<string, FigmaWorkspaceRepairStep>();
  for (const diagnostic of diagnostics) {
    const key = `${diagnostic.code}:${diagnostic.severity}:${diagnostic.suggestion}`;
    const existing = steps.get(key);
    if (existing) {
      existing.occurrences.push(...repairOccurrences(diagnostic));
      continue;
    }
    steps.set(key, repairPlanStepFromDiagnostic(diagnostic));
  }
  return Array.from(steps.values()).map((step) => ({
    ...step,
    occurrences: dedupeRepairOccurrences(step.occurrences),
  }));
}

function repairPlanStepFromDiagnostic(diagnostic: FigmaWorkspaceFileDiagnostic): FigmaWorkspaceRepairStep {
  return {
    code: diagnostic.code,
    severity: diagnostic.severity,
    message: diagnostic.message,
    suggestion: diagnostic.suggestion,
    docsHint: diagnostic.docsHint,
    occurrences: repairOccurrences(diagnostic),
  };
}

function repairOccurrences(diagnostic: FigmaWorkspaceFileDiagnostic): FigmaWorkspaceRepairOccurrence[] {
  if (diagnostic.source.occurrences && diagnostic.source.occurrences.length > 0) {
    return diagnostic.source.occurrences.map((occurrence) => removeUndefined({
      scriptPath: diagnostic.source.scriptPath,
      line: occurrence.line,
      column: occurrence.column,
      label: locationLabel(occurrence.line, occurrence.column),
    }));
  }
  const occurrence = removeUndefined({
    scriptPath: diagnostic.source.scriptPath,
    line: diagnostic.source.line,
    column: diagnostic.source.column,
    label: locationLabel(diagnostic.source.line, diagnostic.source.column),
  });
  return Object.keys(occurrence).length > 0 ? [occurrence] : [];
}

function dedupeRepairOccurrences(
  occurrences: FigmaWorkspaceRepairOccurrence[],
): FigmaWorkspaceRepairOccurrence[] {
  const seen = new Set<string>();
  const result: FigmaWorkspaceRepairOccurrence[] = [];
  for (const occurrence of occurrences) {
    const key = `${occurrence.scriptPath ?? ""}:${occurrence.line ?? ""}:${occurrence.column ?? ""}`;
    if (!seen.has(key)) {
      seen.add(key);
      result.push(occurrence);
    }
  }
  return result;
}

function locationLabel(line: number | undefined, column: number | undefined): string | undefined {
  if (line === undefined) {
    return undefined;
  }
  return column === undefined ? String(line) : `${line}:${column}`;
}

function countLines(source: string): number {
  if (source.length === 0) {
    return 0;
  }
  return source.split(/\r?\n/u).length;
}

function removeUndefined(
  record: FigmaWorkspaceRepairOccurrence,
): FigmaWorkspaceRepairOccurrence {
  return Object.fromEntries(
    Object.entries(record).filter(([, value]) => value !== undefined),
  ) as FigmaWorkspaceRepairOccurrence;
}

function literal(value: unknown): string {
  return JSON.stringify(value);
}
