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

const outputs = [
  {
    entryPoint: resolve(root, "src/mcp/index.ts"),
    outfile: resolve(dist, "mcp/index.js"),
    bundle: true,
  },
  {
    entryPoint: resolve(root, "src/upstream/upstream-stdio-cli.ts"),
    outfile: resolve(dist, "upstream/upstream-stdio-cli.js"),
    bundle: true,
  },
  {
    entryPoint: resolve(root, "src/mcp/workspace-mcp-server.ts"),
    outfile: resolve(dist, "mcp/workspace-mcp-server.js"),
    bundle: true,
  },
  {
    entryPoint: resolve(root, "src/upstream/node-upstream-client.ts"),
    outfile: resolve(dist, "upstream/node-upstream-client.js"),
    bundle: true,
  },
  {
    entryPoint: resolve(root, "src/mcp/workspace-mcp-cli.ts"),
    outfile: resolve(dist, "mcp/workspace-mcp-cli.js"),
    bundle: true,
  },
  {
    entryPoint: resolve(root, "src/upstream/upstream-stdio-bin.ts"),
    outfile: resolve(dist, "upstream/upstream-stdio-bin.js"),
    bundle: false,
    executable: true,
  },
  {
    entryPoint: resolve(root, "src/mcp/workspace-mcp-stdio-bin.ts"),
    outfile: resolve(dist, "mcp/workspace-mcp-stdio-bin.js"),
    bundle: false,
    executable: true,
  },
];

for (const output of outputs) {
  await build({
    ...sharedBuildOptions,
    bundle: output.bundle,
    banner: output.bundle ? { js: bundledEsmRequireBanner } : undefined,
    entryPoints: [output.entryPoint],
    outfile: output.outfile,
  });
  const source = await readFile(output.outfile, "utf8");
  await writeFile(output.outfile, stripTrailingWhitespace(source), "utf8");
  if (output.executable) {
    await chmod(output.outfile, 0o755);
  }
}

await stageUpstreamCorpus();
await stageHelperDeclarations();

function stripTrailingWhitespace(value) {
  return value.replace(/[ \t]+$/gm, "");
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
  await cp(source, resolve(dist, "mcp/figma-workspace-helpers.d.ts"));
  await cp(source, resolve(dist, "upstream/figma-workspace-helpers.d.ts"));
  await stageFigmaPluginTypings(figmaTypings, resolve(dist, "mcp/figma-plugin-typings"));
  await stageFigmaPluginTypings(figmaTypings, resolve(dist, "upstream/figma-plugin-typings"));
  await stageTypescriptLib(typescriptLib, resolve(dist, "mcp/typescript-lib"));
  await stageTypescriptLib(typescriptLib, resolve(dist, "upstream/typescript-lib"));
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
