#!/usr/bin/env node
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
  "plugins/node-repl/runtime/bin/node_repl.exe",
  "plugins/node-repl/runtime/README.md",
  "scripts/fetch-msstore.js",
  "scripts/package-runtime.js",
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

if (process.exitCode) {
  process.exit(process.exitCode);
}

console.log("Plugin validation passed.");
