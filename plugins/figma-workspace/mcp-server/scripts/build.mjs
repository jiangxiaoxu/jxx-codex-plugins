import { chmod, cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
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

function stripTrailingWhitespace(value) {
  return value.replace(/[ \t]+$/gm, "");
}

async function stageUpstreamCorpus() {
  const source = resolve(root, "../skills/figma-workspace/references/upstream-corpus");
  const target = resolve(dist, "skills/figma-workspace/references/upstream-corpus");
  await rm(target, { recursive: true, force: true });
  await cp(source, target, { recursive: true });
}
