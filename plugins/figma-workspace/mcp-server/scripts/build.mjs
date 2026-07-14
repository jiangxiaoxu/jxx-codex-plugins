import { createHash } from "node:crypto";
import { chmod, cp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const dist = resolve(root, "dist");

await rm(dist, { recursive: true, force: true });
await mkdir(dist, { recursive: true });

const sharedBuildOptions = {
  platform: "node",
  format: "esm",
  target: "node20",
};
const bundledEsmRequireBanner =
  [
    'import { createRequire as __figmaWorkspaceCreateRequire } from "node:module";',
    'import { fileURLToPath as __figmaWorkspaceFileURLToPath } from "node:url";',
    'import { dirname as __figmaWorkspacePathDirname } from "node:path";',
    "const require = __figmaWorkspaceCreateRequire(import.meta.url);",
    "const __filename = __figmaWorkspaceFileURLToPath(import.meta.url);",
    "const __dirname = __figmaWorkspacePathDirname(__filename);",
  ].join("\n");

const sharedRuntimeOutput = {
  entryPoint: resolve(root, "src/runtime/workspace-runtime.ts"),
  outfile: resolve(dist, "runtime/workspace-runtime.js"),
};
const typescriptCompilerRuntimeOutput = {
  entryPoint: resolve(root, "src/runtime/typescript-compiler-runtime.ts"),
  outfile: resolve(dist, "runtime/typescript-compiler-runtime.js"),
};
const commandRuntimeOutput = {
  entryPoint: resolve(root, "src/cli/figma-command-runtime.ts"),
  outfile: resolve(dist, "cli/figma-command-runtime.js"),
};
const publicWrappers = [
  {
    outfile: resolve(dist, "index.js"),
    source: [
      'export * from "./runtime/workspace-runtime.js";',
    ].join("\n"),
  },
  {
    outfile: resolve(dist, "workspace-client.js"),
    source: [
      'export * from "./runtime/workspace-runtime.js";',
    ].join("\n"),
  },
  {
    outfile: resolve(dist, "upstream/node-upstream-client.js"),
    source: [
      "export {",
      "  FIGMA_UPSTREAM_CONTRACT_SNAPSHOT_SCHEMA_VERSION,",
      "  NodeUpstreamRemoteMcpClient as RemoteMcpClient,",
      "  createFigmaUpstreamContractSnapshot,",
      "  createNodeUpstreamFigmaWorkspaceClient as createFigmaWorkspaceClient,",
      "  createNodeUpstreamRemoteMcpClient as createRemoteMcpClient,",
      "  diffFigmaUpstreamContractSnapshots,",
      "  formatFigmaUpstreamContractDrift,",
      "  formatFigmaUpstreamContractElapsedTime,",
      "  installNodeReplWebStreamGlobals,",
      "  isNodeUpstreamRemoteMcpOAuthError as isRemoteMcpOAuthError,",
      "  normalizeFigmaUpstreamContractSnapshot,",
      "  readFigmaUpstreamContractSnapshotFile,",
      "  writeFigmaUpstreamContractSnapshotFile,",
      '} from "../runtime/workspace-runtime.js";',
    ].join("\n"),
  },
  {
    outfile: resolve(dist, "cli/figma-workspace-cli.js"),
    executable: true,
    source: [
      "#!/usr/bin/env node",
      'import { runFigmaWorkspaceCli } from "../runtime/workspace-runtime.js";',
      "",
      "process.exitCode = await runFigmaWorkspaceCli(process.argv.slice(2));",
    ].join("\n"),
  },
];

await build({
  ...sharedBuildOptions,
  bundle: true,
  banner: { js: bundledEsmRequireBanner },
  entryPoints: [typescriptCompilerRuntimeOutput.entryPoint],
  outfile: typescriptCompilerRuntimeOutput.outfile,
});
await rewriteBuiltFile(typescriptCompilerRuntimeOutput.outfile);

await build({
  ...sharedBuildOptions,
  bundle: true,
  banner: { js: bundledEsmRequireBanner },
  entryPoints: [sharedRuntimeOutput.entryPoint],
  external: ["./typescript-compiler-runtime.js"],
  outfile: sharedRuntimeOutput.outfile,
});
await rewriteBuiltFile(sharedRuntimeOutput.outfile);

await build({
  ...sharedBuildOptions,
  bundle: true,
  banner: { js: bundledEsmRequireBanner },
  entryPoints: [commandRuntimeOutput.entryPoint],
  external: ["../runtime/workspace-runtime.js"],
  outfile: commandRuntimeOutput.outfile,
});
await rewriteBuiltFile(commandRuntimeOutput.outfile);

for (const output of publicWrappers) {
  await writeWrapper(output.outfile, output.source, output.executable === true);
}

await stageCanonicalCorpus();
await stageProjectDocs();
await stageHelperDeclarations();

function stripTrailingWhitespace(value) {
  return value.replace(/[ \t]+$/gm, "");
}

async function rewriteBuiltFile(file) {
  const source = await readFile(file, "utf8");
  await writeFile(file, stripTrailingWhitespace(source), "utf8");
}

async function writeWrapper(file, source, executable) {
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, `${stripTrailingWhitespace(source)}\n`, "utf8");
  if (executable) {
    await chmod(file, 0o755);
  }
}

async function stageCanonicalCorpus() {
  const source = resolve(root, "../skills/figma-workspace/references/canonical-corpus");
  const target = resolve(dist, "skills/figma-workspace/references/canonical-corpus");
  await rm(target, { recursive: true, force: true });
  await cp(source, target, { recursive: true });
}

async function stageProjectDocs() {
  const source = resolve(root, "../skills/figma-workspace/references");
  const target = resolve(dist, "skills/figma-workspace/references");
  const files = [
    "figma-workspace-overview.md",
    "figma-workspace-workflow.md",
    "figma-workspace-guidance-and-lookup.md",
    "figma-workspace-safety.md",
    "figma-workspace-diagnostics.md",
    "figma-workspace-sessions.md",
    "figma-workspace-upstream-tools.md",
  ];
  await mkdir(target, { recursive: true });
  await Promise.all(files.map((file) => cp(resolve(source, file), resolve(target, file))));
}

async function stageHelperDeclarations() {
  const source = resolve(root, "src/runtime/figma-workspace-helpers.d.ts");
  const figmaTypings = resolve(root, "node_modules/@figma/plugin-typings");
  const typescriptLib = resolve(root, "node_modules/@typescript/typescript6/node_modules/typescript/lib");
  await cp(source, resolve(dist, "runtime/figma-workspace-helpers.d.ts"));
  const stagedFigmaTypings = resolve(dist, "runtime/figma-plugin-typings");
  await stageFigmaPluginTypings(figmaTypings, stagedFigmaTypings);
  await stageFigmaPluginApiIndex(figmaTypings, resolve(dist, "runtime/figma-plugin-api-index"));
  await stageTypescriptLib(typescriptLib, resolve(dist, "runtime/typescript-lib"));
}

async function stageFigmaPluginTypings(sourceDir, targetDir) {
  await mkdir(targetDir, { recursive: true });
  await Promise.all(["index.d.ts", "plugin-api.d.ts"]
    .map((entry) => cp(resolve(sourceDir, entry), resolve(targetDir, entry))));
}

async function stageFigmaPluginApiIndex(sourceDir, targetDir) {
  const sourceFiles = ["index.d.ts", "plugin-api.d.ts"];
  const packageData = JSON.parse(await readFile(resolve(sourceDir, "package.json"), "utf8"));
  const sourceEntries = [];
  const records = [];
  for (const sourceFile of sourceFiles) {
    const sourceText = normalizeLineEndings(await readFile(resolve(sourceDir, sourceFile), "utf8"));
    sourceEntries.push({ file: sourceFile, sha256: sha256(sourceText) });
    records.push(...createPluginApiSymbolRecords(sourceFile, sourceText));
  }
  const indexText = `${records.map((record) => JSON.stringify(record)).join("\n")}\n`;
  const indexSha256 = sha256(indexText);
  const indexFile = `index-${indexSha256}.jsonl`;
  const manifest = {
    schemaVersion: 1,
    source: {
      package: "@figma/plugin-typings",
      version: packageData.version,
      files: sourceEntries,
    },
    index: { file: indexFile, recordCount: records.length, sha256: indexSha256 },
    integrity: {
      algorithm: "sha256",
      contentHashes: Object.fromEntries(records.map((record) => [record.id, record.contentSha256])),
    },
  };
  await rm(targetDir, { recursive: true, force: true });
  await mkdir(targetDir, { recursive: true });
  await writeFile(resolve(targetDir, indexFile), indexText, "utf8");
  await writeFile(resolve(targetDir, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
}

function createPluginApiSymbolRecords(sourceFile, sourceText) {
  const lines = sourceText.split("\n");
  const records = [];
  for (let index = 0; index < lines.length; index += 1) {
    const symbol = pluginApiSymbol(lines[index]);
    if (!symbol) continue;
    const start = pluginApiChunkStart(lines, index);
    const end = pluginApiChunkEnd(lines, index);
    const text = lines.slice(start, end).join("\n");
    const id = `@figma/plugin-typings/${sourceFile}:${index + 1}:${symbol}`;
    records.push({
      schemaVersion: 1,
      id,
      symbol,
      sourceFile,
      declarationLine: index + 1,
      lineStart: start + 1,
      lineEnd: end,
      contentSha256: sha256(text),
      text,
    });
  }
  return records;
}

function pluginApiSymbol(line) {
  const normalized = line.trim();
  const declaration = /^(?:export\s+)?(?:declare\s+)?(?:interface|type|class|enum|namespace|function|const|let|var)\s+([$A-Z_a-z][$\w]*)/u.exec(normalized);
  if (declaration) return declaration[1];
  const member = /^(?:readonly\s+)?([$A-Z_a-z][$\w]*)\??\s*(?:<[^>]*>)?\s*(?:\(|:)/u.exec(normalized);
  return member?.[1];
}

function pluginApiChunkStart(lines, symbolIndex) {
  let start = symbolIndex;
  for (let index = symbolIndex - 1; index >= Math.max(0, symbolIndex - 18); index -= 1) {
    const line = lines[index].trim();
    if (line === "" || line.startsWith("/**") || line.startsWith("*") || line.startsWith("*/")) {
      start = index;
      continue;
    }
    break;
  }
  return start;
}

function pluginApiChunkEnd(lines, symbolIndex) {
  let end = symbolIndex + 1;
  for (let index = symbolIndex + 1; index < Math.min(lines.length, symbolIndex + 12); index += 1) {
    if (index > symbolIndex + 1 && pluginApiSymbol(lines[index])) break;
    end = index + 1;
    if (lines[index].trim() === "") break;
  }
  return end;
}

function normalizeLineEndings(value) {
  return value.replace(/\r\n/gu, "\n");
}

function sha256(value) {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

async function stageTypescriptLib(sourceDir, targetDir) {
  await mkdir(targetDir, { recursive: true });
  const entries = await readdir(sourceDir);
  await Promise.all(entries
    .filter((entry) => /^lib\..*\.d\.ts$/u.test(entry))
    .map((entry) => cp(resolve(sourceDir, entry), resolve(targetDir, entry))));
}
