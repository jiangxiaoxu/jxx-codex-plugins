import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export interface FigmaWorkspaceProjectDocSummary {
  topic: string;
  title: string;
  description: string;
}

export interface FigmaWorkspaceProjectDoc extends FigmaWorkspaceProjectDocSummary {
  sourceId: string;
  content: string;
}

export interface FigmaWorkspaceProjectDocSearchRecord {
  id: string;
  text: string;
}

export type FigmaWorkspaceProjectDocsRuntimeInfo =
  | { ok: true; root: string; topics: readonly string[] }
  | { ok: false; message: string; moduleDir: string; cwd: string; attemptedPaths: string[] };

interface FigmaWorkspaceProjectDocDefinition extends FigmaWorkspaceProjectDocSummary {
  fileName: string;
  sourceId: string;
}

const PROJECT_DOC_DEFINITIONS = [
  {
    topic: "overview",
    title: "Overview and capabilities",
    description: "Choose the CLI capability that matches a Figma workspace task.",
    fileName: "figma-workspace-overview.md",
    sourceId: "project:overview",
  },
  {
    topic: "workflow",
    title: "Workflow",
    description: "Run the primary .figma.ts workflow and its supporting commands.",
    fileName: "figma-workspace-workflow.md",
    sourceId: "project:workflow",
  },
  {
    topic: "guidance-and-lookup",
    title: "Guidance and lookup",
    description: "Use guidance cards and targeted project or upstream reference lookup.",
    fileName: "figma-workspace-guidance-and-lookup.md",
    sourceId: "project:guidance-and-lookup",
  },
  {
    topic: "safety",
    title: "Safety",
    description: "Apply file-editing, scripting, asset, and visual-QA guardrails.",
    fileName: "figma-workspace-safety.md",
    sourceId: "project:safety",
  },
  {
    topic: "diagnostics",
    title: "Diagnostics",
    description: "Interpret preflight, runtime, and lookup diagnostics and repair failures.",
    fileName: "figma-workspace-diagnostics.md",
    sourceId: "project:diagnostics",
  },
  {
    topic: "sessions",
    title: "Sessions",
    description: "Open, persist, select, and recover CLI workspace sessions.",
    fileName: "figma-workspace-sessions.md",
    sourceId: "project:sessions",
  },
  {
    topic: "upstream-tools",
    title: "Upstream tools",
    description: "Choose first-class wrappers or call uncovered official Figma capabilities.",
    fileName: "figma-workspace-upstream-tools.md",
    sourceId: "project:upstream-tools",
  },
] as const satisfies readonly FigmaWorkspaceProjectDocDefinition[];

export const FIGMA_WORKSPACE_PROJECT_DOC_TOPICS = PROJECT_DOC_DEFINITIONS.map(
  (definition) => definition.topic,
);

export const FIGMA_WORKSPACE_PROJECT_DOC_FILES = PROJECT_DOC_DEFINITIONS.map(
  (definition) => definition.fileName,
);

export function listFigmaWorkspaceProjectDocs(): readonly FigmaWorkspaceProjectDocSummary[] {
  return PROJECT_DOC_DEFINITIONS.map(({ topic, title, description }) => ({ topic, title, description }));
}

export function readFigmaWorkspaceProjectDoc(topic: string): FigmaWorkspaceProjectDoc {
  const normalizedTopic = topic.trim().toLowerCase();
  const definition = PROJECT_DOC_DEFINITIONS.find((candidate) => candidate.topic === normalizedTopic);
  if (!definition) {
    throw new Error(
      `Unknown Figma Workspace project doc topic "${topic}". Available topics: ${FIGMA_WORKSPACE_PROJECT_DOC_TOPICS.join(", ")}.`,
    );
  }
  const root = resolveProjectDocsRoot();
  return {
    topic: definition.topic,
    title: definition.title,
    description: definition.description,
    sourceId: definition.sourceId,
    content: readFileSync(resolve(root, definition.fileName), "utf8"),
  };
}

export function getFigmaWorkspaceProjectDocSearchRecords(): ReadonlyMap<string, FigmaWorkspaceProjectDocSearchRecord> {
  return new Map(PROJECT_DOC_DEFINITIONS.map((definition) => {
    const doc = readFigmaWorkspaceProjectDoc(definition.topic);
    return [definition.fileName, { id: doc.sourceId, text: doc.content }];
  }));
}

export function getFigmaWorkspaceProjectDocsRuntimeInfo(): FigmaWorkspaceProjectDocsRuntimeInfo {
  const moduleDir = dirname(fileURLToPath(import.meta.url));
  const cwd = safeProcessCwd(moduleDir);
  const attemptedPaths = projectDocsRootCandidates(moduleDir, cwd);
  try {
    return {
      ok: true,
      root: resolveProjectDocsRootFromCandidates(attemptedPaths),
      topics: FIGMA_WORKSPACE_PROJECT_DOC_TOPICS,
    };
  } catch (error) {
    return {
      ok: false,
      message: error instanceof Error ? error.message : String(error),
      moduleDir,
      cwd,
      attemptedPaths,
    };
  }
}

function resolveProjectDocsRoot(): string {
  const moduleDir = dirname(fileURLToPath(import.meta.url));
  const cwd = safeProcessCwd(moduleDir);
  return resolveProjectDocsRootFromCandidates(projectDocsRootCandidates(moduleDir, cwd));
}

function projectDocsRootCandidates(moduleDir: string, cwd: string): string[] {
  return [
    resolve(moduleDir, "../skills/figma-workspace/references"),
    resolve(moduleDir, "../../../skills/figma-workspace/references"),
    resolve(cwd, "skills/figma-workspace/references"),
    resolve(cwd, "plugins/figma-workspace/skills/figma-workspace/references"),
    resolve(cwd, "../skills/figma-workspace/references"),
  ];
}

function resolveProjectDocsRootFromCandidates(candidates: readonly string[]): string {
  for (const candidate of candidates) {
    try {
      for (const definition of PROJECT_DOC_DEFINITIONS) {
        readFileSync(resolve(candidate, definition.fileName), "utf8");
      }
      return candidate;
    } catch {
      // Try the next supported source or copied-dist layout.
    }
  }
  throw new Error(
    `Unable to locate Figma Workspace project docs. Attempted: ${candidates.join(", ")}.`,
  );
}

function safeProcessCwd(fallback: string): string {
  try {
    return typeof process !== "undefined" && typeof process.cwd === "function"
      ? process.cwd()
      : fallback;
  } catch {
    return fallback;
  }
}
