#!/usr/bin/env node
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const repoRoot = path.resolve(__dirname, "..");

const requiredFiles = [
  ".agents/plugins/marketplace.json",
  "plugins/node-repl/.codex-plugin/plugin.json",
  "plugins/node-repl/.mcp.json",
  "plugins/node-repl/skills/node-repl/SKILL.md",
  "plugins/node-repl/runtime/node_repl_mcp.mjs",
  "plugins/node-repl/runtime/node-repl-mcp.cmd",
  "plugins/node-repl/runtime/bootstrap.mjs",
  "plugins/node-repl/runtime/README.md",
  "plugins/node-repl/runtime/latest.json",
  "scripts/fetch-msstore.js",
  "scripts/package-runtime.js",
  "scripts/check-runtime-update.js",
  "scripts/update-runtime-metadata.js",
];

function fail(message) {
  console.error(message);
  process.exitCode = 1;
}

function readJson(relativePath) {
  const fullPath = path.join(repoRoot, relativePath);
  try {
    return JSON.parse(fs.readFileSync(fullPath, "utf8"));
  } catch (error) {
    fail(`${relativePath} is not valid JSON: ${error.message}`);
    return null;
  }
}

for (const relativePath of requiredFiles) {
  const fullPath = path.join(repoRoot, relativePath);
  if (!fs.existsSync(fullPath) || !fs.statSync(fullPath).isFile()) {
    fail(`Missing required file: ${relativePath}`);
  }
}

const marketplace = readJson(".agents/plugins/marketplace.json");
if (!marketplace?.plugins?.some((plugin) => plugin.name === "node-repl")) {
  fail("Marketplace does not list node-repl.");
}

const plugin = readJson("plugins/node-repl/.codex-plugin/plugin.json");
if (plugin?.mcpServers !== "./.mcp.json") {
  fail("plugin.json mcpServers must be ./.mcp.json.");
}
if (plugin?.skills !== "./skills/") {
  fail("plugin.json skills must be ./skills/.");
}
if (!/^\d+\.\d+\.\d+$/.test(plugin?.version || "")) {
  fail("plugin.json version must be an independent SemVer patch version, for example 0.1.0.");
}

const mcp = readJson("plugins/node-repl/.mcp.json");
const server = mcp?.mcpServers?.node_repl;
if (!server) {
  fail(".mcp.json must register mcpServers.node_repl.");
} else {
  if (server.command !== "cmd.exe") {
    fail(".mcp.json node_repl.command must be cmd.exe.");
  }
  const expectedArgs = ["/d", "/s", "/c", "runtime\\node-repl-mcp.cmd"];
  if (JSON.stringify(server.args) !== JSON.stringify(expectedArgs)) {
    fail(".mcp.json node_repl.args must launch runtime\\node-repl-mcp.cmd.");
  }
  if (server.cwd !== ".") {
    fail(".mcp.json node_repl.cwd must be plugin root.");
  }
  const serialized = JSON.stringify(server);
  if (/^[A-Za-z]:\\/.test(server.command) || serialized.includes("\\Users\\")) {
    fail(".mcp.json must not hard-code user paths.");
  }
}

const latest = readJson("plugins/node-repl/runtime/latest.json");
for (const key of ["schemaVersion", "platform", "arch", "status", "repo", "assetName", "manifestAssetName", "source"]) {
  if (!(key in (latest ?? {}))) {
    fail(`latest.json missing stable key: ${key}`);
  }
}
if (latest?.status === "published") {
  for (const relativePath of ["bin/node_repl.exe"]) {
    const file = latest?.files?.[relativePath];
    if (!/^[a-f0-9]{64}$/.test(file?.sha256 || "")) {
      fail(`latest.json files.${relativePath}.sha256 is required when status is published.`);
    }
    if (!Number.isSafeInteger(file?.size) || file.size <= 0) {
      fail(`latest.json files.${relativePath}.size is required when status is published.`);
    }
  }
}

const forbiddenRuntimeDir = path.join(repoRoot, "plugins", "node-repl", "runtime", "bin");
if (fs.existsSync(forbiddenRuntimeDir)) {
  const exeFiles = fs
    .readdirSync(forbiddenRuntimeDir)
    .filter((name) => name.toLowerCase().endsWith(".exe"));
  if (exeFiles.length > 0) {
    fail(`Runtime exe files must not be present in repo: ${exeFiles.join(", ")}`);
  }
}

const gitResult = spawnSync("git", ["ls-files", "plugins/node-repl/runtime/bin/*.exe"], {
  cwd: repoRoot,
  encoding: "utf8",
  windowsHide: true,
});
if (gitResult.status === 0 && gitResult.stdout.trim()) {
  fail(`Runtime exe files are tracked by git:\n${gitResult.stdout.trim()}`);
}

if (process.exitCode) {
  process.exit(process.exitCode);
}

console.log("Plugin validation passed.");
