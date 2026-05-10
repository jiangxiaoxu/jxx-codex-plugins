#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");

const repoRoot = path.resolve(__dirname, "..");
const pluginPath = path.join(repoRoot, "plugins", "node-repl", ".codex-plugin", "plugin.json");
const latestPath = path.join(repoRoot, "plugins", "node-repl", "runtime", "latest.json");

function getArg(args, name) {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] || "" : "";
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function writeJson(filePath, value) {
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

function pluginBaseVersion(version) {
  return String(version || "0.1.0").split("+")[0];
}

function bumpPatchVersion(version) {
  const baseVersion = pluginBaseVersion(version);
  const match = baseVersion.match(/^(\d+)\.(\d+)\.(\d+)$/);
  if (!match) {
    throw new Error(`Cannot bump plugin version: ${version}`);
  }

  const major = Number(match[1]);
  const minor = Number(match[2]);
  const patch = Number(match[3]);
  return `${major}.${minor}.${patch + 1}`;
}

function main() {
  const args = process.argv.slice(2);
  const manifestPath = path.resolve(
    getArg(args, "--manifest") || path.join(repoRoot, "dist", "node-repl-runtime-win32-x64.manifest.json"),
  );
  const dryRun = args.includes("--dry-run");
  const manifest = readJson(manifestPath);
  const codexVersion = manifest?.source?.packageVersion;
  if (!codexVersion) {
    throw new Error("Runtime manifest source.packageVersion is required.");
  }

  const plugin = readJson(pluginPath);
  const latest = readJson(latestPath);
  plugin.version = bumpPatchVersion(plugin.version);

  latest.releaseTag = manifest.releaseTag;
  latest.status = "published";
  latest.assetName = manifest.assetName;
  latest.manifestAssetName = manifest.manifestAssetName;
  latest.sha256 = manifest.sha256;
  latest.size = manifest.size;
  latest.files = manifest.files;
  latest.source = manifest.source;
  latest.updatedAt = manifest.createdAt;

  if (dryRun) {
    console.log(JSON.stringify({ plugin, latest }, null, 2));
    return;
  }

  writeJson(pluginPath, plugin);
  writeJson(latestPath, latest);
  console.log(`Updated plugin version to ${plugin.version}`);
  console.log(`Updated latest runtime metadata to ${latest.releaseTag}`);
}

main();
