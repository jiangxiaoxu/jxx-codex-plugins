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
const publicWrappers = [
  {
    outfile: resolve(dist, "mcp/index.js"),
    source: [
      'export * from "../runtime/workspace-runtime.js";',
    ].join("\n"),
  },
  {
    outfile: resolve(dist, "upstream/upstream-stdio-cli.js"),
    source: [
      "export {",
      "  isFigmaWorkspaceUpstreamDirectRun as isDirectRun,",
      "  runFigmaWorkspaceUpstreamStdioCli,",
      '} from "../runtime/workspace-runtime.js";',
    ].join("\n"),
  },
  {
    outfile: resolve(dist, "mcp/workspace-mcp-server.js"),
    source: [
      'export * from "../runtime/workspace-runtime.js";',
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
    outfile: resolve(dist, "mcp/workspace-mcp-cli.js"),
    source: [
      "export {",
      "  isFigmaWorkspaceMcpDirectRun as isDirectRun,",
      "  runFigmaWorkspaceMcpCli,",
      '} from "../runtime/workspace-runtime.js";',
    ].join("\n"),
  },
  {
    outfile: resolve(dist, "upstream/upstream-stdio-bin.js"),
    executable: true,
    source: [
      "#!/usr/bin/env node",
      "import {",
      "  isFigmaWorkspaceUpstreamDirectRun as isDirectRun,",
      "  runFigmaWorkspaceUpstreamStdioCli,",
      '} from "../runtime/workspace-runtime.js";',
      "",
      "if (isDirectRun(import.meta.url)) {",
      "  await runFigmaWorkspaceUpstreamStdioCli({",
      "    useBridgeOAuthCache: true,",
      "    openBrowser: false,",
      "  });",
      "}",
    ].join("\n"),
  },
  {
    outfile: resolve(dist, "mcp/workspace-mcp-stdio-bin.js"),
    executable: true,
    source: [
      "#!/usr/bin/env node",
      "import {",
      "  isFigmaWorkspaceMcpDirectRun as isDirectRun,",
      "  runFigmaWorkspaceMcpCli,",
      '} from "../runtime/workspace-runtime.js";',
      "",
      "if (isDirectRun(import.meta.url)) {",
      "  await runFigmaWorkspaceMcpCli({",
      "    useBridgeOAuthCache: true,",
      "    openBrowser: false,",
      "  });",
      "}",
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

for (const output of publicWrappers) {
  await writeWrapper(output.outfile, output.source, output.executable === true);
}

await stageUpstreamCorpus();
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

async function stageUpstreamCorpus() {
  const source = resolve(root, "../skills/figma-workspace/references/upstream-corpus");
  const target = resolve(dist, "skills/figma-workspace/references/upstream-corpus");
  await rm(target, { recursive: true, force: true });
  await cp(source, target, { recursive: true });
}

async function stageHelperDeclarations() {
  const source = resolve(root, "src/runtime/figma-workspace-helpers.d.ts");
  const figmaTypings = resolve(root, "node_modules/@figma/plugin-typings");
  const typescriptLib = resolve(root, "node_modules/@typescript/typescript6/node_modules/typescript/lib");
  await cp(source, resolve(dist, "runtime/figma-workspace-helpers.d.ts"));
  await stageFigmaPluginTypings(figmaTypings, resolve(dist, "runtime/figma-plugin-typings"));
  await stageTypescriptLib(typescriptLib, resolve(dist, "runtime/typescript-lib"));
}

async function stageFigmaPluginTypings(sourceDir, targetDir) {
  await mkdir(targetDir, { recursive: true });
  await Promise.all(["index.d.ts", "plugin-api.d.ts"]
    .map((entry) => cp(resolve(sourceDir, entry), resolve(targetDir, entry))));
}

async function stageTypescriptLib(sourceDir, targetDir) {
  await mkdir(targetDir, { recursive: true });
  const entries = await readdir(sourceDir);
  await Promise.all(entries
    .filter((entry) => /^lib\..*\.d\.ts$/u.test(entry))
    .map((entry) => cp(resolve(sourceDir, entry), resolve(targetDir, entry))));
}
