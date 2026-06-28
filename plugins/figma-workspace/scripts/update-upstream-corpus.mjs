import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, resolve, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

const pluginRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const defaultUpstreamSkillRoot = resolve(
  homedir(),
  ".codex/plugins/cache/openai-curated-remote/figma/2.0.12/skills",
);
const outputDir = resolve(pluginRoot, "skills/figma-workspace-router/references/upstream-corpus");

const corpusEntries = [
  { id: "figma-use/SKILL.md", kind: "skill", format: "markdown" },
  { id: "figma-use/references/api-reference.md", kind: "reference", format: "markdown" },
  { id: "figma-use/references/common-patterns.md", kind: "reference", format: "markdown" },
  { id: "figma-use/references/component-patterns.md", kind: "reference", format: "markdown" },
  { id: "figma-use/references/effect-style-patterns.md", kind: "reference", format: "markdown" },
  { id: "figma-use/references/gotchas.md", kind: "reference", format: "markdown" },
  { id: "figma-use/references/plugin-api-patterns.md", kind: "reference", format: "markdown" },
  { id: "figma-use/references/text-style-patterns.md", kind: "reference", format: "markdown" },
  { id: "figma-use/references/validation-and-recovery.md", kind: "reference", format: "markdown" },
  { id: "figma-use/references/variable-patterns.md", kind: "reference", format: "markdown" },
  { id: "figma-use/references/working-with-design-systems/wwds.md", kind: "reference", format: "markdown" },
  { id: "figma-use/references/working-with-design-systems/wwds-components.md", kind: "reference", format: "markdown" },
  { id: "figma-use/references/working-with-design-systems/wwds-variables.md", kind: "reference", format: "markdown" },
  { id: "figma-use/references/plugin-api-standalone.index.md", kind: "api-index", format: "markdown" },
  { id: "figma-use/references/plugin-api-standalone.d.ts", kind: "api-declaration", format: "typescript" },
  { id: "figma-generate-library/SKILL.md", kind: "skill", format: "markdown" },
  { id: "figma-generate-library/references/component-creation.md", kind: "reference", format: "markdown" },
  { id: "figma-generate-library/references/discovery-phase.md", kind: "reference", format: "markdown" },
  { id: "figma-generate-library/references/token-creation.md", kind: "reference", format: "markdown" },
  { id: "figma-code-connect/SKILL.md", kind: "skill", format: "markdown" },
  { id: "figma-code-connect/references/api.md", kind: "reference", format: "markdown" },
  { id: "figma-use-figjam/SKILL.md", kind: "skill", format: "markdown" },
  { id: "figma-use-slides/SKILL.md", kind: "skill", format: "markdown" },
  { id: "figma-use-motion/SKILL.md", kind: "skill", format: "markdown" },
  { id: "figma-use-motion/references/motion-easing.md", kind: "reference", format: "markdown" },
  { id: "figma-use-motion/references/motion-patterns.md", kind: "reference", format: "markdown" },
  { id: "figma-implement-motion/SKILL.md", kind: "skill", format: "markdown" },
  { id: "figma-implement-motion/references/examples-and-anti-examples.md", kind: "reference", format: "markdown" },
  { id: "figma-implement-motion/references/framework-recommendations.md", kind: "reference", format: "markdown" },
  { id: "figma-implement-motion/references/gotchas.md", kind: "reference", format: "markdown" },
  { id: "figma-implement-motion/references/motion-lint-rules.md", kind: "reference", format: "markdown" },
  { id: "figma-implement-motion/references/svg-and-path-motion.md", kind: "reference", format: "markdown" },
  { id: "figma-implement-motion/references/unsupported-and-fallbacks.md", kind: "reference", format: "markdown" },
  { id: "figma-swiftui/SKILL.md", kind: "skill", format: "markdown" },
  { id: "figma-swiftui/references/design-to-code.md", kind: "reference", format: "markdown" },
  { id: "figma-swiftui/references/code-to-design.md", kind: "reference", format: "markdown" },
];

const upstreamSkillRoot = resolve(parseUpstreamSkillRootArg() ?? process.env.FIGMA_UPSTREAM_SKILLS_DIR ?? defaultUpstreamSkillRoot);

await mkdir(outputDir, { recursive: true });

const records = [];
for (const entry of corpusEntries) {
  const sourcePath = resolve(upstreamSkillRoot, entry.id);
  const text = await readFile(sourcePath, "utf8");
  const normalizedText = text.replace(/\r\n/g, "\n");
  records.push({
    schemaVersion: 1,
    id: entry.id,
    skill: entry.id.split("/")[0],
    kind: entry.kind,
    format: entry.format,
    sourcePath: toPosix(relative(upstreamSkillRoot, sourcePath)),
    lineCount: normalizedText.split("\n").length,
    text: normalizedText,
  });
}

const manifest = {
  schemaVersion: 1,
  generatedAt: new Date().toISOString(),
  upstream: {
    package: "openai-curated-remote/figma",
    version: "2.0.12",
    source: "local Codex plugin cache or --upstream-skill-root input",
  },
  corpus: {
    file: "corpus.jsonl",
    recordCount: records.length,
    contract: "Internal lookup corpus only; agents use figma_workspace_guidance and figma_workspace_lookup instead of reading upstream files directly.",
  },
  includedSkills: [...new Set(records.map((record) => record.skill))],
  outOfScopeSkills: [],
};

const jsonl = `${records.map((record) => JSON.stringify(record)).join("\n")}\n`;
await writeFile(resolve(outputDir, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
await writeFile(resolve(outputDir, "corpus.jsonl"), jsonl, "utf8");

console.log(`wrote ${records.length} upstream corpus records to ${outputDir}`);

function parseUpstreamSkillRootArg() {
  const index = process.argv.indexOf("--upstream-skill-root");
  if (index === -1) {
    return undefined;
  }
  const value = process.argv[index + 1];
  if (!value) {
    throw new Error("--upstream-skill-root requires a path value");
  }
  return value;
}

function toPosix(value) {
  return value.split(sep).join("/");
}
