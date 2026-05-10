#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");

const repoRoot = path.resolve(__dirname, "..");
const latestPath = path.join(repoRoot, "plugins", "node-repl", "runtime", "latest.json");
const pluginPath = path.join(repoRoot, "plugins", "node-repl", ".codex-plugin", "plugin.json");

function getArg(args, name) {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] || "" : "";
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function appendGithubOutput(values) {
  const outputPath = process.env.GITHUB_OUTPUT;
  if (!outputPath) {
    return;
  }

  const lines = Object.entries(values).map(([key, value]) => `${key}=${value ?? ""}`);
  fs.appendFileSync(outputPath, `${lines.join("\n")}\n`);
}

function pluginBaseVersion(version) {
  return String(version || "0.1.0").split("+")[0];
}

function nextPatchVersion(version) {
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

function fileHash(value, relativePath) {
  return value?.files?.[relativePath]?.sha256 || "";
}

function hasMatchingRuntimeHashes(latest, manifest) {
  const runtimeFiles = ["bin/node_repl.exe"];
  return runtimeFiles.every((relativePath) => {
    const latestHash = fileHash(latest, relativePath);
    const manifestHash = fileHash(manifest, relativePath);
    return latestHash && manifestHash && latestHash === manifestHash;
  });
}

function main() {
  const args = process.argv.slice(2);
  const manifestPath = path.resolve(
    getArg(args, "--manifest") || path.join(repoRoot, "dist", "node-repl-runtime-win32-x64.manifest.json"),
  );
  const latest = readJson(latestPath);
  const plugin = readJson(pluginPath);
  const manifest = readJson(manifestPath);
  const packageVersion = manifest?.source?.packageVersion;
  if (!packageVersion) {
    throw new Error("Runtime manifest source.packageVersion is required.");
  }

  const currentVersion = latest?.source?.packageVersion || "";
  const samePackageVersion = currentVersion === packageVersion;
  const sameRuntimeHashes = hasMatchingRuntimeHashes(latest, manifest);
  const shouldRelease = !samePackageVersion && !sameRuntimeHashes;
  const releaseTag = manifest.releaseTag || `runtime-win32-x64-${packageVersion}`;
  const keepReleaseTag = shouldRelease ? releaseTag : latest.releaseTag || releaseTag;
  const pluginVersion = nextPatchVersion(plugin.version);
  const reason = samePackageVersion
    ? "package_version_unchanged"
    : sameRuntimeHashes
      ? "runtime_hash_unchanged"
      : "runtime_hash_changed";
  const output = {
    should_release: shouldRelease ? "true" : "false",
    package_version: packageVersion,
    current_package_version: currentVersion,
    release_tag: releaseTag,
    keep_release_tag: keepReleaseTag,
    next_plugin_version: pluginVersion,
    reason,
  };

  appendGithubOutput(output);
  console.log(JSON.stringify(output, null, 2));
}

try {
  main();
} catch (error) {
  console.error(error.message);
  process.exit(1);
}
