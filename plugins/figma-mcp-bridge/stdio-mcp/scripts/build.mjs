import { chmod, mkdir, readFile, rm, writeFile } from "node:fs/promises";
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
    entryPoint: resolve(root, "src/index.ts"),
    outfile: resolve(dist, "index.js"),
    bundle: true,
  },
  {
    entryPoint: resolve(root, "src/cli.ts"),
    outfile: resolve(dist, "cli.js"),
    bundle: true,
  },
  {
    entryPoint: resolve(root, "src/repl-server.ts"),
    outfile: resolve(dist, "repl-server.js"),
    bundle: true,
  },
  {
    entryPoint: resolve(root, "src/node-repl.ts"),
    outfile: resolve(dist, "node-repl.js"),
    bundle: true,
  },
  {
    entryPoint: resolve(root, "src/repl-cli.ts"),
    outfile: resolve(dist, "repl-cli.js"),
    bundle: true,
  },
  {
    entryPoint: resolve(root, "src/stdio-cli.ts"),
    outfile: resolve(dist, "stdio-cli.js"),
    bundle: false,
    executable: true,
  },
  {
    entryPoint: resolve(root, "src/repl-stdio-cli.ts"),
    outfile: resolve(dist, "repl-stdio-cli.js"),
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

function stripTrailingWhitespace(value) {
  return value.replace(/[ \t]+$/gm, "");
}
