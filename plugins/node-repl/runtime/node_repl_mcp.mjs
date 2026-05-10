#!/usr/bin/env node
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import { delimiter, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import os from "node:os";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const binDir = join(scriptDir, "bin");
const isWindows = process.platform === "win32";
const exeSuffix = isWindows ? ".exe" : "";

function isFile(path) {
  try {
    return existsSync(path) && statSync(path).isFile();
  } catch {
    return false;
  }
}

function splitPathList(value) {
  return (value ?? "")
    .split(delimiter)
    .map((item) => item.trim())
    .filter(Boolean);
}

function unique(items) {
  return Array.from(new Set(items.filter(Boolean)));
}

function findOnPath(command) {
  const pathEntries = splitPathList(process.env.PATH);
  const names =
    isWindows && !command.toLowerCase().endsWith(".exe")
      ? [command, `${command}.exe`, `${command}.cmd`, `${command}.bat`]
      : [command];

  for (const dir of pathEntries) {
    for (const name of names) {
      const candidate = join(dir, name);
      if (isFile(candidate)) {
        return candidate;
      }
    }
  }
  return null;
}

function firstExistingFile(candidates) {
  for (const candidate of candidates) {
    if (candidate && isFile(candidate)) {
      return candidate;
    }
  }
  return null;
}

function fileSha256(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function discoverBrowserClientHashes(codexHome) {
  const candidates = [
    join(
      codexHome,
      "plugins",
      "cache",
      "openai-bundled",
      "browser-use",
      "0.1.0-alpha2",
      "scripts",
      "browser-client.mjs",
    ),
    join(
      codexHome,
      ".tmp",
      "bundled-marketplaces",
      "openai-bundled",
      "plugins",
      "browser-use",
      "scripts",
      "browser-client.mjs",
    ),
  ];

  return unique(candidates.filter(isFile).map(fileSha256));
}

function requireFile(label, candidates) {
  const found = firstExistingFile(candidates);
  if (!found) {
    console.error(`${label} not found. Checked: ${candidates.filter(Boolean).join(", ")}`);
    process.exit(1);
  }
  return found;
}

const codexHome = process.env.CODEX_HOME?.trim() || join(os.homedir(), ".codex");
const nodeReplPath = requireFile("node_repl executable", [
  join(binDir, `node_repl${exeSuffix}`),
]);
const nodePath = process.execPath;

const codexCliPath = firstExistingFile([
  process.env.CODEX_CLI_PATH,
  join(binDir, `codex${exeSuffix}`),
  findOnPath(`codex${exeSuffix}`),
  findOnPath("codex"),
]);

const defaultModuleDirs = unique([
  join(scriptDir, "node_modules"),
  join(codexHome, "mcp", "node_repl", "node_modules"),
]).filter((path) => existsSync(path));

const nodeModuleDirs =
  process.env.NODE_REPL_NODE_MODULE_DIRS?.trim() || defaultModuleDirs.join(delimiter);

const trustedCodePaths = process.env.NODE_REPL_TRUSTED_CODE_PATHS?.trim() || codexHome;

const trustedBrowserClientSha256s =
  process.env.NODE_REPL_TRUSTED_BROWSER_CLIENT_SHA256S?.trim() ||
  discoverBrowserClientHashes(codexHome).join(",");

const env = {
  ...process.env,
  CODEX_HOME: codexHome,
  NODE_REPL_NODE_PATH: nodePath,
  NODE_REPL_NODE_MODULE_DIRS: nodeModuleDirs,
  NODE_REPL_TRUSTED_CODE_PATHS: trustedCodePaths,
  NODE_REPL_TRUSTED_BROWSER_CLIENT_SHA256S: trustedBrowserClientSha256s,
};

if (codexCliPath) {
  env.CODEX_CLI_PATH = codexCliPath;
}

const args = process.argv.slice(2);
if (process.env.NODE_REPL_DISABLE_SANDBOX === "1" && !args.includes("--disable-sandbox")) {
  args.unshift("--disable-sandbox");
}

const child = spawn(nodeReplPath, args, {
  env,
  stdio: ["inherit", "inherit", "inherit"],
  windowsHide: true,
});

child.on("error", (error) => {
  console.error(`failed to start node_repl MCP server: ${error.message}`);
  process.exit(1);
});

child.on("exit", (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }
  process.exit(code ?? 0);
});

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    if (!child.killed) {
      child.kill(signal);
    }
  });
}
