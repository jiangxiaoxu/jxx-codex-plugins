import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const dist = resolve(root, "dist");

await mkdir(dist, { recursive: true });

await build({
  entryPoints: [resolve(root, "src/index.ts")],
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node20",
  outfile: resolve(dist, "index.js"),
});

const indexPath = resolve(dist, "index.js");
const indexSource = await readFile(indexPath, "utf8");
await writeFile(indexPath, stripTrailingWhitespace(indexSource), "utf8");

await writeFile(
  resolve(dist, "stdio-cli.js"),
  stripTrailingWhitespace([
    'import { isDirectRun, startFigmaStdioMcpServer } from "./index.js";',
    "",
    "if (isDirectRun(import.meta.url)) {",
    "  await startFigmaStdioMcpServer({",
    "    useBridgeOAuthCache: true,",
    "    openBrowser: false,",
    "  });",
    "}",
    "",
  ].join("\n")),
  "utf8",
);

function stripTrailingWhitespace(value) {
  return value.replace(/[ \t]+$/gm, "");
}
